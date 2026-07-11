// CINDER — player entity
// An AABB (in cell coordinates) with pixel collision against the grid.
// The sim doesn't know the player exists; the player reads the grid for
// collision/hazards and only writes to it by trampling plants and shedding
// the occasional fire cell while burning.

'use strict';

const player = {
  x: 0, y: 0,          // top-left, float cell coords
  vx: 0, vy: 0,
  w: 3, h: 6,
  hp: 100, maxHp: 100,
  alive: false,
  grounded: false,
  inLiquid: false,
  burning: 0,          // frames of burn remaining
  hurtCd: 0,           // invulnerability frames after a creature hit
  facing: 1,
  fuel: 100,           // jetpack fuel — separate from mana on purpose
  maxFuel: 100,
  jetting: false,
};

// Solid for the player: static materials and powders. Liquids/gases/fire are
// passable (with consequences). Plants break underfoot instead of blocking.
function playerSolidAt(cx, cy) {
  if (cx < 0 || cx >= SIM_W || cy < 0 || cy >= SIM_H) return true;
  const i = idx(cx, cy);
  const id = grid[i];
  if (id === E.EMPTY) return false;
  if (id === E.PLANT) return false; // pass through; trampling is gradual now
  const t = TYPE[id];
  return t === T.STATIC || t === T.POWDER;
}

function playerCollides(px, py) {
  const x0 = Math.floor(px), x1 = Math.ceil(px + player.w) - 1;
  const y0 = Math.floor(py), y1 = Math.ceil(py + player.h) - 1;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (playerSolidAt(cx, cy)) return true;
    }
  }
  return false;
}

function spawnPlayer() {
  for (let attempt = 0; attempt < 300; attempt++) {
    const x = 8 + ((rand() * (SIM_W - 16)) | 0);
    let groundY = -1;
    for (let y = 2; y < SIM_H - 4; y++) {
      const id = grid[idx(x, y)];
      if (id !== E.EMPTY && TYPE[id] !== T.GAS) { groundY = y; break; }
    }
    if (groundY < player.h + 3) continue;
    const px = x - player.w / 2, py = groundY - player.h - 1;
    if (!playerCollides(px, py)) {
      player.x = px; player.y = py;
      player.vx = 0; player.vy = 0;
      player.hp = player.maxHp;
      player.alive = true;
      player.burning = 0;
      player.hurtCd = 0;
      player.fuel = player.maxFuel;
      return;
    }
  }
  // desperate fallback: dead center, carve a pocket
  paintCircle(SIM_W >> 1, SIM_H >> 1, 6, E.EMPTY);
  player.x = (SIM_W >> 1) - player.w / 2;
  player.y = (SIM_H >> 1) - player.h / 2;
  player.vx = 0; player.vy = 0;
  player.hp = player.maxHp;
  player.alive = true;
  player.burning = 0;
  player.hurtCd = 0;
  player.fuel = player.maxFuel;
}

function updatePlayer() {
  if (!player.alive) return;
  if (player.hurtCd > 0) player.hurtCd--;
  const k = input.keys;
  const left  = (k['arrowleft'] || k['a']) ? 1 : 0;
  const right = (k['arrowright'] || k['d']) ? 1 : 0;
  const up    = (k['arrowup'] || k['w'] || k[' ']) ? 1 : 0;

  // --- sample the cells we overlap: liquids, hazards, healing, vegetation
  const m = runState.mult;
  let dmg = 0, liquidCells = 0, touchedWater = false;
  const plantCells = [];
  const x0 = Math.floor(player.x), x1 = Math.ceil(player.x + player.w) - 1;
  const y0 = Math.floor(player.y), y1 = Math.ceil(player.y + player.h) - 1;
  for (let cy = y0; cy <= y1; cy++) {
    if (cy < 0 || cy >= SIM_H) continue;
    for (let cx = x0; cx <= x1; cx++) {
      if (cx < 0 || cx >= SIM_W) continue;
      const i = idx(cx, cy);
      const id = grid[i];
      if (TYPE[id] === T.LIQUID) liquidCells++;
      if (id === E.WATER) touchedWater = true;
      else if (id === E.PLANT) plantCells.push(i);
      else if (id === E.FIRE) { dmg += 0.25 * m.fireDmg; player.burning = Math.max(player.burning, 160 * m.burnTime); }
      else if (id === E.LAVA) { dmg += 1.1 * m.lavaDmg; player.burning = 240 * m.burnTime; }
      else if (id === E.ACID) dmg += 0.5 * m.acidDmg;
      else if (id === E.ELEC) dmg += 1.2;
      else if (id === E.EWATER) dmg += 0.7;
      const heal = runState.heals[id];
      if (heal) player.hp = Math.min(player.maxHp, player.hp + heal);
    }
  }
  const inPlants = plantCells.length > 0;
  // pushing through foliage slowly breaks it (Green Thumb makes it a snack)
  if (inPlants && rand() < 0.06) {
    const pick = plantCells[(rand() * plantCells.length) | 0];
    setCell(pick, E.EMPTY);
    if (runState.trampleHeal) player.hp = Math.min(player.maxHp, player.hp + runState.trampleHeal);
  }
  player.inLiquid = liquidCells >= 3;
  if (touchedWater) player.burning = 0;
  if (player.burning > 0) {
    player.burning--;
    dmg += 0.08 * m.fireDmg;
    // shed a lick of flame above the head now and then
    const hx = Math.round(player.x + player.w / 2), hy = y0 - 1;
    if (rand() < 0.12 && hy > 0 && grid[idx(hx, hy)] === E.EMPTY) {
      setCell(idx(hx, hy), E.FIRE);
    }
  }

  // --- controls + physics
  player.grounded = player.vy >= 0 && playerCollides(player.x, player.y + 0.2);
  player.jetting = false;
  const move = right - left;
  if (move) player.facing = move;
  player.vx = move * (player.inLiquid ? 0.45 : 0.75) * m.speed
            * (inPlants ? 0.55 : 1);        // foliage is thick
  if (player.inLiquid) {
    player.vy += 0.03;                      // gentle sink
    if (up) player.vy -= 0.09;              // swim
    player.vy = Math.max(-0.6, Math.min(0.6, player.vy));
  } else {
    player.vy += 0.12;                      // gravity
    if (player.vy > 1.8) player.vy = 1.8;
    if (inPlants && player.vy > 0.5) player.vy = 0.5; // vines catch your fall
    if (up && player.grounded) {
      player.vy = -1.45 * m.jump;           // jump off the ground...
    } else if (up && inPlants) {
      player.vy = -0.55;                    // ...climb vegetation, fuel-free
    } else if (up && !player.grounded && player.fuel > 0) {
      player.vy -= 0.28;                    // ...keep holding: jetpack
      if (player.vy < -1.1) player.vy = -1.1;
      player.fuel -= 0.7;
      player.jetting = true;
      playSfx('jet');
      // exhaust: a puff of smoke below the feet, into the actual sim
      const fx = Math.round(player.x + player.w / 2);
      const fy = y1 + 1;
      if (rand() < 0.2 && fy < SIM_H - 1 && grid[idx(fx, fy)] === E.EMPTY) {
        setCell(idx(fx, fy), E.SMOKE);
      }
    }
  }
  // refuel while standing or swimming (fast: ~1s from empty)
  if (player.grounded || player.inLiquid) {
    player.fuel = Math.min(player.maxFuel, player.fuel + 1.6);
  }

  // --- axis-separated movement in substeps (no tunneling)
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(player.vx), Math.abs(player.vy)) / 0.45));
  for (let s = 0; s < steps; s++) {
    if (player.vx !== 0) {
      const nx = player.x + player.vx / steps;
      if (!playerCollides(nx, player.y)) player.x = nx;
      else if (player.grounded && !playerCollides(nx, player.y - 1)) {
        player.x = nx; player.y -= 1;       // auto-step 1-cell ledges
      } else player.vx = 0;
    }
    if (player.vy !== 0) {
      const ny = player.y + player.vy / steps;
      if (!playerCollides(player.x, ny)) player.y = ny;
      else {
        if (player.vy > 0) player.grounded = true;
        player.vy = 0;
      }
    }
  }

  // unstick if the world filled our cells (falling sand, freezing water...)
  let tries = 0;
  while (playerCollides(player.x, player.y) && tries++ < 4) player.y -= 1;

  if (dmg > 0) {
    for (const hook of runState.onDamage) hook(dmg);
    if (dmg > 0.2 && simFrame % 25 === 0) playSfx('hurt');
  }
  player.hp -= dmg;
  if (player.hp <= 0) { player.hp = 0; player.alive = false; }
}

function drawPlayer() {
  const cw = displayCanvas.width / camera.w;
  const ch = displayCanvas.height / camera.h;
  const sx = (player.x - camera.x) * cw;
  const sy = (player.y - camera.y) * ch;
  const w = player.w * cw, h = player.h * ch;
  // body (flickers orange while burning)
  displayCtx.fillStyle = player.burning > 0 && (simFrame & 4) ? '#ff8c3c' : '#e8e0d0';
  displayCtx.fillRect(sx, sy, w, h);
  // eye, on the facing side
  displayCtx.fillStyle = '#1a1a22';
  const ex = sx + (player.facing > 0 ? w * 0.55 : w * 0.15);
  displayCtx.fillRect(ex, sy + h * 0.12, cw * 0.9, ch * 0.8);
  // jetpack flame
  if (player.jetting) {
    const flick = 1 + ((simFrame & 3) * 0.25);
    displayCtx.fillStyle = '#ffd75e';
    displayCtx.fillRect(sx + w * 0.25, sy + h, w * 0.5, ch * flick);
    displayCtx.fillStyle = 'rgba(255, 140, 60, 0.7)';
    displayCtx.fillRect(sx + w * 0.15, sy + h + ch * flick, w * 0.7, ch * 0.8);
  }
}

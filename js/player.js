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
  warmth: 60,          // body warmth 0-100: falls in the cold, rises by heat
  onIce: false,        // standing on ice — low traction
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

// True if the box at (px,py) overlaps immovable material (stone, ice, metal
// ...) — the wriggle-out-when-buried logic may push through loose powder but
// never through these.
function playerStaticBlocked(px, py) {
  const x0 = Math.floor(px), x1 = Math.ceil(px + player.w) - 1;
  const y0 = Math.floor(py), y1 = Math.ceil(py + player.h) - 1;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (cx < 0 || cx >= SIM_W || cy < 0 || cy >= SIM_H) return true;
      const id = grid[idx(cx, cy)];
      if (id !== E.EMPTY && id !== E.PLANT && TYPE[id] === T.STATIC) return true;
    }
  }
  return false;
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

// Equilibrium body-warmth for a given ambient temperature (shared by the
// per-frame drain and by spawn-site selection so they agree exactly).
function warmthTarget(ambient) {
  return 55 + (ambient - 15) * (ambient < 15 ? 1.5 : 0.6);
}

function placeSpawn(px, py) {
  player.x = px; player.y = py;
  player.vx = 0; player.vy = 0;
  player.hp = player.maxHp;
  player.alive = true;
  player.burning = 0;
  player.hurtCd = 0;
  player.fuel = player.maxFuel;
  player.warmth = 60;
}

function spawnPlayer() {
  // Prefer ground whose ambient keeps warmth in the comfortable band, so a
  // fresh spawn never immediately bleeds hp to cold or heat. If the whole
  // map is harsh, fall back to the most comfortable spot we found (never a
  // random freezing/scorching one).
  let best = null, bestScore = -Infinity;
  for (let attempt = 0; attempt < 400; attempt++) {
    const x = 8 + ((rand() * (SIM_W - 16)) | 0);
    let groundY = -1;
    for (let y = 2; y < SIM_H - 4; y++) {
      const id = grid[idx(x, y)];
      if (id !== E.EMPTY && TYPE[id] !== T.GAS) { groundY = y; break; }
    }
    if (groundY < player.h + 3) continue;
    const px = x - player.w / 2, py = groundY - player.h - 1;
    if (playerCollides(px, py)) continue;
    const t = warmthTarget(tempAt(x, Math.max(0, groundY - 1)));
    if (t >= 30 && t <= 85) { placeSpawn(px, py); return; } // comfortable: done
    const score = -Math.abs(t - 55); // else remember the coziest option
    if (score > bestScore) { bestScore = score; best = [px, py]; }
  }
  if (best) { placeSpawn(best[0], best[1]); return; }
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
  player.warmth = 60;
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
      else if (id === E.SMOKE) dmg += 0.015; // choking — mild, but adds up
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

  // --- body warmth (0-100, comfortable ~40-80): a remap of the ambient
  // temperature, not the raw reading — a temperate 15° cave sits at a cozy
  // 55, cold biomes pull you toward hypothermia, and only a near-furnace
  // heat pushes toward heatstroke (lava/fire already do direct damage). Cold
  // is the sensitive side (it's the seasons threat); wet doubles the chill.
  const ambient = tempAt(
    Math.max(0, Math.min(SIM_W - 1, Math.round(player.x + player.w / 2))),
    Math.max(0, Math.min(SIM_H - 1, Math.round(player.y + player.h / 2))));
  let target = warmthTarget(ambient);
  if (player.burning > 0) target = 110;                 // on fire = plenty warm
  else if (touchedWater && ambient < 20) target -= 15;  // wind-chill when wet
  target = Math.max(-5, Math.min(120, target));
  const rate = target < player.warmth ? (touchedWater ? 0.06 : 0.03) : 0.12;
  player.warmth = Math.max(-5, Math.min(110, player.warmth + (target - player.warmth) * rate));
  if (player.warmth < 20) dmg += (20 - player.warmth) * 0.004;      // hypothermia
  else if (player.warmth > 90) dmg += (player.warmth - 90) * 0.010; // heatstroke
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

  // ice underfoot is slippery: instead of snapping vx to the input, we ease
  // toward it (low traction) so momentum carries and stops become skids
  player.onIce = false;
  if (player.grounded) {
    const fy = Math.floor(player.y + player.h + 0.2);
    for (let cx = Math.floor(player.x); cx <= Math.ceil(player.x + player.w) - 1; cx++) {
      if (grid[idx(Math.max(0, Math.min(SIM_W - 1, cx)), Math.min(SIM_H - 1, fy))] === E.ICE) {
        player.onIce = true; break;
      }
    }
  }
  const targetVx = move * (player.inLiquid ? 0.45 : 0.75) * m.speed
                 * (inPlants ? 0.55 : 1);    // foliage is thick
  if (player.onIce && !player.inLiquid) {
    // grip 0.08 gliding, a touch more when actively braking/turning
    const grip = move === 0 ? 0.03 : 0.08;
    player.vx += (targetVx - player.vx) * grip;
    if (Math.abs(player.vx) < 0.02) player.vx = 0;
  } else {
    player.vx = targetVx;
  }
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

  // --- the world can fill our cells: falling powder, freezing pools, growth.
  // Loose grains get flicked out of the way (a seed landing on your head
  // must not catapult you); only genuine burial moves the player, and the
  // wriggle-up never pushes through solid rock — the old unconditional
  // shove-up launched players through ceilings when seed rain kept
  // re-triggering it.
  const bx0 = Math.floor(player.x), bx1 = Math.ceil(player.x + player.w) - 1;
  const by0 = Math.floor(player.y), by1 = Math.ceil(player.y + player.h) - 1;
  for (let cy = by0; cy <= by1; cy++) {
    for (let cx = bx0; cx <= bx1; cx++) {
      if (cx < 0 || cx >= SIM_W || cy < 0 || cy >= SIM_H) continue;
      const i = idx(cx, cy);
      if (TYPE[grid[i]] !== T.POWDER) continue;
      const near = cx - bx0 <= bx1 - cx ? bx0 - 1 : bx1 + 1;
      const far  = near === bx0 - 1 ? bx1 + 1 : bx0 - 1;
      for (const [tx, ty] of [[near, cy], [far, cy], [cx, by0 - 1]]) {
        if (tx < 0 || tx >= SIM_W || ty < 0 || ty >= SIM_H) continue;
        if (grid[idx(tx, ty)] === E.EMPTY) { swapCells(i, idx(tx, ty)); break; }
      }
    }
  }
  let tries = 0;
  while (playerCollides(player.x, player.y) && tries++ < 4 &&
         !playerStaticBlocked(player.x, player.y - 1)) {
    player.y -= 1;
  }

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
  // body: flickers orange while burning, blue-shivers when freezing, flushes
  // red when overheating
  let body = '#e8e0d0';
  if (player.burning > 0 && (simFrame & 4)) body = '#ff8c3c';
  else if (player.warmth < 20) body = (simFrame & 8) ? '#a9d6ff' : '#cfe6ff'; // shiver
  else if (player.warmth > 90) body = '#ffb0a0';
  displayCtx.fillStyle = body;
  // shivering jitter when freezing
  const jx = player.warmth < 20 ? (simFrame & 2 ? 0.5 : -0.5) : 0;
  displayCtx.fillRect(sx + jx, sy, w, h);
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

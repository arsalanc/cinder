// CINDER — creatures
// Grid-colliding critters that live inside the element sim: they burn,
// drown, corrode, and explode like everything else. Types are data; AI is
// shared (chase the player in sight range, wander otherwise).

'use strict';

const CREATURE_TYPES = {
  grub: {  // ground walker, the bread-and-butter threat
    w: 3, h: 2, hp: 18, speed: 0.35, fly: false, contactDmg: 7,
    color: '#c05868', sight: 55,
  },
  wisp: {  // fire-themed flyer; sheds embers, snuffed instantly by water
    w: 2, h: 2, hp: 10, speed: 0.55, fly: true, contactDmg: 6,
    color: '#ffa54a', sight: 75, diesInWater: true, trail: { el: E.FIRE, p: 0.02 },
    deathFire: 2,
  },
  bloat: { // slow drifting sack of gunpowder; do not melee it
    w: 4, h: 3, hp: 26, speed: 0.22, fly: true, contactDmg: 4,
    color: '#9a6fd0', sight: 60, explodeRadius: 7,
  },
  spitter: { // sluggish ground plant-thing that lobs acid globs
    w: 3, h: 3, hp: 14, speed: 0.15, fly: false, contactDmg: 5,
    color: '#7ec850', sight: 80,
    ranged: { cooldown: 110, speed: 1.6, dmg: 6 },
  },
  // --- biome signatures -----------------------------------------------------
  shaleback: { // Stone Caverns: armored tank — slow, heavy, shrugs off hits
    w: 4, h: 3, hp: 44, speed: 0.26, fly: false, contactDmg: 9,
    color: '#8a8378', sight: 60, armor: 0.5,
  },
  pouncer: {  // Overgrown Vault: leaping predator that pounces from range
    w: 3, h: 2, hp: 16, speed: 0.5, fly: false, contactDmg: 8,
    color: '#4f9e5a', sight: 100, leap: true,
  },
  frostling: { // Ice Caves: chilling flyer whose touch saps your warmth
    w: 3, h: 2, hp: 20, speed: 0.34, fly: true, contactDmg: 5,
    color: '#bfe4ff', sight: 82, chill: 16,
  },
  seeper: {   // Oil Caverns: fireproof crawler that lays flammable oil slicks
    w: 4, h: 2, hp: 30, speed: 0.2, fly: false, contactDmg: 5,
    color: '#6b5a3a', sight: 70, fireImmune: true, trail: { el: E.OIL, p: 0.11 },
  },
  magmite: {  // Volcanic Depths: a lava-walker that trails molten rock
    w: 4, h: 3, hp: 40, speed: 0.22, fly: false, contactDmg: 10,
    color: '#d2601c', sight: 72, fireImmune: true, trail: { el: E.LAVA, p: 0.04 },
  },
  voltbug: {  // Rusted Works: a charged mite that electrifies nearby puddles
    w: 3, h: 2, hp: 18, speed: 0.4, fly: true, contactDmg: 6,
    color: '#cfe08a', sight: 88, elecAura: true,
  },
  // --- bosses (guard the portal on depths 3 and 6) --------------------------
  magmaworm: { // tunnels straight through terrain toward you, trailing lava
    w: 6, h: 4, hp: 260, speed: 0.32, fly: true, burrow: true, contactDmg: 16,
    color: '#e2581a', sight: 400, lavaTrail: 0.07,
    fireImmune: true, waterDmg: 0.5, boss: true,
  },
  tempest: { // storm elemental: hurls arc globs, electrifies water around it
    w: 5, h: 5, hp: 220, speed: 0.42, fly: true, contactDmg: 12,
    color: '#9adcff', sight: 400, boss: true, elecAura: true,
    ranged: { cooldown: 85, speed: 2.0, dmg: 8, kind: 'elec' },
  },
};

// which creatures each biome spawns (weighted); this is the biome-flavor knob.
// Each biome leads with its signature enemy, backed by a few generalists.
const BIOME_SPAWNS = {
  'Stone Caverns':   [['grub', 4], ['shaleback', 3], ['wisp', 1], ['bloat', 1], ['spitter', 1]],
  'Overgrown Vault': [['pouncer', 4], ['spitter', 3], ['grub', 2], ['bloat', 1]],
  'Ice Caves':       [['frostling', 4], ['grub', 3], ['shaleback', 2], ['spitter', 1]], // no wisps: too wet
  'Oil Caverns':     [['seeper', 3], ['wisp', 3], ['bloat', 3], ['grub', 1]],
  'Volcanic Depths': [['magmite', 4], ['wisp', 4], ['bloat', 1]],
  'Rusted Works':    [['voltbug', 4], ['grub', 2], ['bloat', 2], ['shaleback', 1]],
};

const creatures = [];
const eProjectiles = []; // acid globs etc. fired by creatures

function clearCreatures() {
  creatures.length = 0;
  eProjectiles.length = 0;
}

function weightedPick(table) {
  let total = 0;
  for (const [, w] of table) total += w;
  let r = rand() * total;
  for (const [key, w] of table) {
    r -= w;
    if (r <= 0) return key;
  }
  return table[0][0];
}

function creatureSolidAt(cx, cy) {
  if (cx < 0 || cx >= SIM_W || cy < 0 || cy >= SIM_H) return true;
  const id = grid[idx(cx, cy)];
  if (id === E.EMPTY || id === E.PLANT) return false; // slip through plants
  const t = TYPE[id];
  return t === T.STATIC || t === T.POWDER;
}

function creatureCollides(c, px, py) {
  const x0 = Math.floor(px), x1 = Math.ceil(px + c.w) - 1;
  const y0 = Math.floor(py), y1 = Math.ceil(py + c.h) - 1;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (creatureSolidAt(cx, cy)) return true;
    }
  }
  return false;
}

function spawnCreatures(depth) {
  clearCreatures();
  const want = Math.min(14, 3 + depth * 2);
  for (let attempt = 0; attempt < 800 && creatures.length < want; attempt++) {
    const x = 6 + ((rand() * (SIM_W - 14)) | 0);
    const y = 10 + ((rand() * (SIM_H - 22)) | 0);
    let open = true;
    for (let dy = 0; dy < 4 && open; dy++) {
      for (let dx = 0; dx < 6 && open; dx++) {
        if (grid[idx(x + dx, y + dy)] !== E.EMPTY) open = false;
      }
    }
    if (!open) continue;
    const ddx = x - player.x, ddy = y - player.y;
    if (ddx * ddx + ddy * ddy < 45 * 45) continue; // not on top of the player
    // spawn what belongs in this biome
    const biomeName = BIOMES[worldBiomeMap[idx(x, y)]].name;
    const key = weightedPick(BIOME_SPAWNS[biomeName] || BIOME_SPAWNS['Stone Caverns']);
    const t = CREATURE_TYPES[key];
    creatures.push({
      key, x: x + 1, y: y + 1, vx: 0, vy: 0, w: t.w, h: t.h, hp: t.hp,
      dir: rand() < 0.5 ? -1 : 1, burning: 0, hurtFlash: 0, bob: rand() * 6.28,
      attackCd: 60,
    });
  }
}

function damageCreature(c, dmg) {
  const t = CREATURE_TYPES[c.key];
  c.hp -= dmg * (1 - (t.armor || 0)); // armored types (shaleback) shrug off hits
  c.hurtFlash = 8;
  playSfx('hit');
}

function killCreature(i) {
  const c = creatures[i];
  const t = CREATURE_TYPES[c.key];
  const cx = Math.round(c.x + c.w / 2), cy = Math.round(c.y + c.h / 2);
  creatures.splice(i, 1); // remove first: the blast must not re-hit it
  if (t.explodeRadius) {
    explode(cx, cy, (t.explodeRadius * explosionScale) | 0);
    playSfx('explosion');
  } else if (t.deathFire) {
    splash(cx, cy, t.deathFire, E.FIRE);
  } else {
    splash(cx, cy, 1, E.SMOKE);
  }
  wand.mana = Math.min(wand.maxMana, wand.mana + 10); // kill reward
  if (t.boss) {
    // slaying a guardian: big heal, full mana, and a death throe
    player.hp = Math.min(player.maxHp, player.hp + 30);
    wand.mana = wand.maxMana;
    if (t.lavaTrail) splash(cx, cy, 3, E.LAVA);
    if (t.elecAura) electrify(cx, cy, 6);
    playSfx('explosion');
  }
  if (typeof run !== 'undefined' && run.active) {
    run.kills++; // replays re-enact kills but never farm meta progression
    if (typeof replayPlay === 'undefined' || !replayPlay.active) meta.kills++;
  }
  playSfx('squish');
}

function updateCreatures() {
  for (let i = creatures.length - 1; i >= 0; i--) {
    const c = creatures[i];
    const t = CREATURE_TYPES[c.key];
    if (c.hurtFlash > 0) c.hurtFlash--;

    // --- environment: creatures obey the same elements the player does
    let dmg = 0;
    let touchedWater = false;
    const x0 = Math.floor(c.x), x1 = Math.ceil(c.x + c.w) - 1;
    const y0 = Math.floor(c.y), y1 = Math.ceil(c.y + c.h) - 1;
    for (let cy = y0; cy <= y1; cy++) {
      if (cy < 0 || cy >= SIM_H) continue;
      for (let cx = x0; cx <= x1; cx++) {
        if (cx < 0 || cx >= SIM_W) continue;
        const id = grid[idx(cx, cy)];
        if (id === E.WATER) {
          touchedWater = true;
          if (t.waterDmg) { // magma sizzles
            dmg += t.waterDmg;
            if (rand() < 0.15) setCell(idx(cx, cy), E.STEAM);
          }
        }
        else if (id === E.FIRE) { if (!t.fireImmune) { dmg += 0.4; c.burning = 120; } }
        else if (id === E.LAVA) { if (!t.fireImmune) { dmg += 0.9; c.burning = 180; } }
        else if (id === E.ACID) dmg += 0.35;
        else if (id === E.ELEC) { if (!t.elecAura) dmg += 1.2; }
        else if (id === E.EWATER) { if (!t.elecAura) dmg += 0.8; }
      }
    }
    if (touchedWater) {
      c.burning = 0;
      if (t.diesInWater) { c.hp = 0; }
    }
    if (c.burning > 0) {
      c.burning--;
      dmg += 0.06;
      const hx = Math.round(c.x + c.w / 2), hy = y0 - 1;
      if (rand() < 0.08 && hy > 0 && grid[idx(hx, hy)] === E.EMPTY) {
        setCell(idx(hx, hy), E.FIRE);
      }
    }
    c.hp -= dmg;
    if (c.hp <= 0) { killCreature(i); continue; }

    // --- AI: chase when the player is near, wander otherwise
    const pcx = player.x + player.w / 2, pcy = player.y + player.h / 2;
    const ccx = c.x + c.w / 2, ccy = c.y + c.h / 2;
    const dx = pcx - ccx, dy = pcy - ccy;
    const dist = Math.hypot(dx, dy) || 1;
    const chase = player.alive && dist < t.sight;

    // ranged types lob a glob instead of closing in (spitters: acid;
    // the tempest: arcing electricity)
    if (t.ranged) {
      c.attackCd--;
      if (chase && dist > 10 && c.attackCd <= 0) {
        c.attackCd = t.ranged.cooldown + (rand() * 40) | 0;
        eProjectiles.push({
          x: ccx, y: ccy - 1,
          vx: dx / dist * t.ranged.speed,
          vy: dy / dist * t.ranged.speed - 0.45, // loft the shot
          dmg: t.ranged.dmg,
          kind: t.ranged.kind || 'acid',
        });
        playSfx(t.ranged.kind === 'elec' ? 'arc' : 'spit');
      }
    }
    // storm aura: electrify nearby water
    if (t.elecAura) {
      for (let k = 0; k < 3; k++) {
        const ax = Math.round(ccx + rand() * 14 - 7);
        const ay = Math.round(ccy + rand() * 14 - 7);
        if (ax > 0 && ax < SIM_W - 1 && ay > 0 && ay < SIM_H - 1) {
          const j = idx(ax, ay);
          if (grid[j] === E.WATER) setCell(j, E.EWATER);
        }
      }
    }

    if (t.burrow) {
      // tunnel straight toward the player through anything but WALL
      if (dist > 3) {
        c.x += dx / dist * t.speed;
        c.y += dy / dist * t.speed;
      }
      const bx = Math.round(c.x + c.w / 2), by = Math.round(c.y + c.h / 2);
      digCircle(bx, by, 3);
      if (rand() < t.lavaTrail) {
        const lx = Math.max(1, Math.min(SIM_W - 2, bx - Math.sign(dx) * 4));
        const j = idx(lx, by);
        if (grid[j] === E.EMPTY) setCell(j, E.LAVA);
      }
      // contact damage, then next creature (no gravity/collision for a worm)
      if (player.alive && player.hurtCd <= 0 &&
          c.x < player.x + player.w && c.x + c.w > player.x &&
          c.y < player.y + player.h && c.y + c.h > player.y) {
        player.hp -= t.contactDmg;
        player.hurtCd = 45;
        playSfx('hurt');
        for (const hook of runState.onDamage) hook(t.contactDmg);
        if (player.hp <= 0) { player.hp = 0; player.alive = false; }
      }
      continue;
    }

    if (t.fly) {
      c.bob += 0.08;
      let tvx, tvy;
      if (chase) { tvx = dx / dist * t.speed; tvy = dy / dist * t.speed; }
      else {
        if (rand() < 0.015) c.dir = -c.dir;
        tvx = c.dir * t.speed * 0.5;
        tvy = Math.sin(c.bob) * 0.15;
      }
      c.vx += (tvx - c.vx) * 0.1;
      c.vy += (tvy - c.vy) * 0.1;
    } else {
      if (chase) c.dir = dx > 0 ? 1 : -1;
      else if (rand() < 0.008) c.dir = -c.dir;
      if (c.leapCd > 0) c.leapCd--;
      c.vy += 0.12;
      if (c.vy > 1.6) c.vy = 1.6;
      const grounded = creatureCollides(c, c.x, c.y + 0.2);
      if (grounded) {
        // leapers (pouncer) spring at the player; everything else walks
        if (t.leap && chase && (c.leapCd || 0) <= 0 && dist < t.sight) {
          c.vx = Math.sign(dx || c.dir) * t.speed * 3.5;
          c.vy = -1.25;
          c.leapCd = 80;
        } else {
          c.vx = c.dir * t.speed;
          if (creatureCollides(c, c.x + c.dir, c.y)) {
            if (!creatureCollides(c, c.x + c.dir, c.y - 2)) c.vy = -1.1; // hop
            else if (!chase) c.dir = -c.dir;                            // turn
          }
        }
      }
      // airborne (a hop or a leap): keep horizontal momentum, just fall
    }

    // element trails: wisps shed fire, seepers leak oil, magmites drip lava
    if (t.trail && rand() < t.trail.p) {
      const tx = Math.round(ccx), ty = y1;
      if (ty > 0 && ty < SIM_H && grid[idx(tx, ty)] === E.EMPTY) {
        setCell(idx(tx, ty), t.trail.el);
      }
    }

    // --- movement (substepped, axis-separated, like the player)
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(c.vx), Math.abs(c.vy)) / 0.45));
    for (let s = 0; s < steps; s++) {
      if (c.vx !== 0) {
        const nx = c.x + c.vx / steps;
        if (!creatureCollides(c, nx, c.y)) c.x = nx;
        else if (!creatureCollides(c, nx, c.y - 1)) { c.x = nx; c.y -= 1; }
        else c.vx = 0;
      }
      if (c.vy !== 0) {
        const ny = c.y + c.vy / steps;
        if (!creatureCollides(c, c.x, ny)) c.y = ny;
        else c.vy = 0;
      }
    }
    let tries = 0;
    while (creatureCollides(c, c.x, c.y) && tries++ < 3) c.y -= 1;

    // --- contact damage to the player (with invulnerability window)
    if (player.alive && player.hurtCd <= 0 &&
        c.x < player.x + player.w && c.x + c.w > player.x &&
        c.y < player.y + player.h && c.y + c.h > player.y) {
      player.hp -= t.contactDmg;
      player.hurtCd = 45;
      if (t.chill) player.warmth = Math.max(-5, player.warmth - t.chill); // frostling bite
      playSfx('hurt');
      for (const hook of runState.onDamage) hook(t.contactDmg);
      if (player.hp <= 0) { player.hp = 0; player.alive = false; }
    }
  }

  updateEnemyProjectiles();
}

function updateEnemyProjectiles() {
  for (let p = eProjectiles.length - 1; p >= 0; p--) {
    const ep = eProjectiles[p];
    ep.vy += 0.04;
    let dead = false;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(ep.vx), Math.abs(ep.vy))));
    for (let s = 0; s < steps && !dead; s++) {
      ep.x += ep.vx / steps;
      ep.y += ep.vy / steps;
      const cx = Math.round(ep.x), cy = Math.round(ep.y);
      if (cx < 1 || cx >= SIM_W - 1 || cy < 1 || cy >= SIM_H - 1) { dead = true; break; }
      // direct hit on the player
      if (player.alive &&
          ep.x >= player.x - 0.5 && ep.x <= player.x + player.w + 0.5 &&
          ep.y >= player.y - 0.5 && ep.y <= player.y + player.h + 0.5) {
        if (player.hurtCd <= 0) {
          player.hp -= ep.dmg * (ep.kind === 'elec' ? 1 : runState.mult.acidDmg);
          player.hurtCd = 45;
          playSfx('hurt');
          if (player.hp <= 0) { player.hp = 0; player.alive = false; }
        }
        if (ep.kind === 'elec') electrify(cx, cy, 2);
        else splash(cx, cy, 1, E.ACID);
        dead = true;
        break;
      }
      const id = grid[idx(cx, cy)];
      if (id !== E.EMPTY && id !== E.FIRE && TYPE[id] !== T.GAS) {
        // glob bursts into its element
        if (ep.kind === 'elec') electrify(cx, cy, 2);
        else splash(cx, cy, 1, E.ACID);
        dead = true;
      }
    }
    if (dead) eProjectiles.splice(p, 1);
  }
}

function drawCreatures() {
  if (creatures.length === 0 && eProjectiles.length === 0) return;
  const cw = displayCanvas.width / camera.w;
  const ch = displayCanvas.height / camera.h;
  for (const c of creatures) {
    const t = CREATURE_TYPES[c.key];
    const sx = (c.x - camera.x) * cw, sy = (c.y - camera.y) * ch;
    displayCtx.fillStyle =
      c.hurtFlash > 0 ? '#ffffff'
      : c.burning > 0 && (simFrame & 4) ? '#ff8c3c'
      : t.color;
    displayCtx.fillRect(sx, sy, c.w * cw, c.h * ch);
    // eye toward facing/player
    displayCtx.fillStyle = '#1a1a22';
    const ex = sx + (c.dir > 0 || c.key !== 'grub' ? c.w * 0.6 : c.w * 0.1) * cw;
    displayCtx.fillRect(ex, sy + 0.3 * ch, cw * 0.8, ch * 0.8);
  }
  // enemy acid globs
  displayCtx.fillStyle = '#a0e83c';
  for (const ep of eProjectiles) {
    displayCtx.fillRect((ep.x - camera.x - 0.5) * cw, (ep.y - camera.y - 0.5) * ch, cw, ch);
  }
}

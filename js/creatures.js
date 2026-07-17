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
  magmaworm: { // its molten shell deflects everything: bait its breach leap
    w: 6, h: 4, hp: 260, speed: 0.32, fly: true, burrow: true, contactDmg: 16,
    color: '#e2581a', sight: 400, lavaTrail: 0.07,
    fireImmune: true, armor: 1, boss: true, // quench it to crack the shell open
  },
  tempest: { // storm capacitor: charge → nova → falls SPENT; water shorts it
    w: 5, h: 5, hp: 240, speed: 0.42, fly: true, storm: true, contactDmg: 12,
    color: '#9adcff', sight: 400, boss: true, elecAura: true, armor: 0.7,
    fireImmune: true, // fire can't cling to a being of wind and rain
    ranged: { cooldown: 85, speed: 2.0, dmg: 8, kind: 'elec' },
  },
  overgrowth: { // fungal colossus: regenerates relentlessly — FIRE is the key
    w: 6, h: 5, hp: 250, speed: 0.22, fly: false, grove: true, contactDmg: 14,
    color: '#5aa03c', sight: 400, boss: true, armor: 0.7, regen: 0.06,
    ranged: { cooldown: 130, speed: 1.7, dmg: 7, kind: 'spore' },
  },
};

// 8×8 sprites for the regular roster, in the shared icon palette (spells.js).
// They stretch to each creature's body box in drawCreatures, and the bestiary
// renders them via gen-docs. Guardians keep their flat state-driven boxes —
// their colors ARE their telegraphs. Flash states (hurt/exposed/burning)
// still draw flat, so combat reads exactly as before.
const CREATURE_PX = {
  grub: [
    '........',
    '........',
    '..rr.rr.',
    '.rRRrRRr',
    'rRRRRRwD',
    'rRrRrRRr',
    '.rr.rr..',
    '........'],
  wisp: [
    '...oo...',
    '..oyyo..',
    '.oyywyo.',
    '.oywwyo.',
    '.oyywDo.',
    '..oyyo..',
    '.o.oo.o.',
    '..o..o..'],
  bloat: [
    '..pppp..',
    '.pPPPPp.',
    'pPPPPPPp',
    'pPPwDPPp',
    'pPPPPPPp',
    'pPpPPpPp',
    '.pPPPPp.',
    '..p..p..'],
  spitter: [
    '..gG....',
    '.gGGg...',
    'gGwDGg..',
    'gGGGGgG.',
    '.gGGgGG.',
    '..gg.gg.',
    '..hh.hh.',
    '.hhhhhh.'],
  shaleback: [
    '........',
    '..ssss..',
    '.smMMms.',
    'smMMMMms',
    'smmmmDms',
    'ssssssss',
    '.ss..ss.',
    '........'],
  pouncer: [
    '........',
    '.gg.....',
    'gGGg..g.',
    'gGDg.gG.',
    'gGGGgGG.',
    '.gGGGGg.',
    '.gg.gg..',
    '........'],
  frostling: [
    '.i....i.',
    '.iI..Ii.',
    '..iIIi..',
    '.iIWWIi.',
    'iIWDWWIi',
    '.iIWWIi.',
    '..iIIi..',
    '.i....i.'],
  seeper: [
    '........',
    '........',
    '..hhhh..',
    '.hhhhhh.',
    'hhhhhDhh',
    'hhhhhhhh',
    '.h.d..h.',
    '...d....'],
  magmite: [
    '........',
    '..drrd..',
    '.dRoRrd.',
    'drRRRoRd',
    'dRoRRRDd',
    'drRRoRrd',
    '.d.dd.d.',
    '........'],
  voltbug: [
    'w.......',
    '.w..GG..',
    '..wGGGG.',
    '.GGgDgG.',
    '..GGGGG.',
    '.G.gg.G.',
    'G..gg..G',
    '........'],
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

// Touch damage to the player — the one true contact path (every creature,
// boss phase, and breach goes through here so invuln frames, damage hooks,
// and the death recap can never drift apart).
function contactPlayer(c, dmg, label) {
  if (!player.alive || player.hurtCd > 0) return;
  if (c.x >= player.x + player.w || c.x + c.w <= player.x ||
      c.y >= player.y + player.h || c.y + c.h <= player.y) return;
  player.hp -= dmg;
  player.lastHurt = label;
  player.hurtCd = 45;
  const t = CREATURE_TYPES[c.key];
  if (t.chill) player.warmth = Math.max(-5, player.warmth - t.chill); // frostling bite
  playSfx('hurt');
  for (const hook of runState.onDamage) hook(dmg);
  if (player.hp <= 0) { player.hp = 0; player.alive = false; }
}

// Every creature enters the world through this factory so instance fields
// never drift between spawn sites (override anything via `extra`).
function makeCreature(key, x, y, extra) {
  const t = CREATURE_TYPES[key];
  return Object.assign({
    key, x, y, vx: 0, vy: 0, w: t.w, h: t.h, hp: t.hp, maxHp: t.hp,
    dir: rand() < 0.5 ? -1 : 1, burning: 0, hurtFlash: 0,
    bob: rand() * 6.28, attackCd: 60,
  }, extra || {});
}

function spawnCreatures(depth) {
  clearCreatures();
  // endless depths pack denser hordes
  const want = Math.min(depth > 6 ? 20 : 14, 3 + depth * 2);
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
    creatures.push(makeCreature(key, x + 1, y + 1));
  }
  // depth 4+: one ELITE — the biome's signature enemy, oversized and heavily
  // plated, fighting in the boss grammar (periodic vulnerability windows).
  // Depth 2 gets a LESSER elite: half the bulk, same window rhythm — the
  // gold-pulse language is learned before the worm demands it.
  if (depth >= 4) spawnElite(false);
  else if (depth === 2) spawnElite(true);
}

function spawnElite(lesser) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const x = 8 + ((rand() * (SIM_W - 20)) | 0);
    const y = 10 + ((rand() * (SIM_H - 26)) | 0);
    let open = true;
    for (let dy = 0; dy < 6 && open; dy++) {
      for (let dx = 0; dx < 8 && open; dx++) {
        if (grid[idx(x + dx, y + dy)] !== E.EMPTY) open = false;
      }
    }
    if (!open) continue;
    const ddx = x - player.x, ddy = y - player.y;
    if (ddx * ddx + ddy * ddy < 60 * 60) continue;
    const biomeName = BIOMES[worldBiomeMap[idx(x, y)]].name;
    const key = (BIOME_SPAWNS[biomeName] || BIOME_SPAWNS['Stone Caverns'])[0][0];
    const t = CREATURE_TYPES[key];
    const hp = t.hp * (lesser ? 1.5 : 3);
    creatures.push(makeCreature(key, x + 1, y + 1, {
      w: t.w + (lesser ? 1 : 2), h: t.h + 1, hp, maxHp: hp,
      elite: true, lesser: !!lesser, eliteCd: 200, exposedT: 0,
    }));
    return;
  }
}

// vulnerability-window length, stretched by Executioner
function exposeFor(frames) {
  return Math.round(frames * ((runState.mult && runState.mult.windowLen) || 1));
}

function damageCreature(c, dmg, pierce) {
  const t = CREATURE_TYPES[c.key];
  // boss set-piece beats (magma surge, storm squall, bloom) are invulnerable
  // — the fight is about surviving them, not DPSing through them
  if ((c.surgeT || 0) > 0 || (c.squallT || 0) > 0 || (c.bloomT || 0) > 0) {
    c.hurtFlash = 2;
    return;
  }
  // a vulnerable window takes full double damage (bypassing armor) — it's the
  // intended time to strike; otherwise armored types shrug hits off unless
  // the hit pierces (Iron Boots stomps crush through shell plating).
  // Elites wear heavy plating whatever their base type.
  const armor = c.elite ? Math.max(t.armor || 0, 0.6) : (t.armor || 0);
  c.hp -= c.exposedT > 0 ? dmg * 2 : dmg * (pierce ? 1 : 1 - armor);
  c.hurtFlash = 8;
  playSfx('hit');
}

// Mario beat: landing on an EXPOSED boss crunches it for a huge doubled hit
// and bounces you clear (contact is harmless during the window, so the daring
// play is safe — barely)
function bossStomp(c) {
  if (!player.alive || player.vy <= 0.5) return;
  if (player.x < c.x + c.w && player.x + player.w > c.x &&
      player.y + player.h > c.y && player.y + player.h < c.y + c.h + 1) {
    damageCreature(c, 22); // exposed window doubles it: a 44-point crunch
    player.vy = -1.7;
    player.hurtCd = Math.max(player.hurtCd, 30);
    playSfx('explosion');
  }
}

// thermal shock: soaking a furnace-hot boss flash-cools it — the shell (or
// storm) cracks and it sits EXPOSED, venting the water off as steam
function quenchBoss(c, frames) {
  c.exposedT = exposeFor(frames);
  c.airborne = false;
  c.breachTel = 0;
  const bx = Math.round(c.x + c.w / 2), by = Math.round(c.y + c.h / 2);
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      const x = bx + dx, y = by + dy;
      if (x > 0 && x < SIM_W - 1 && y > 0 && y < SIM_H - 1 &&
          grid[idx(x, y)] === E.WATER && rand() < 0.5) setCell(idx(x, y), E.STEAM);
    }
  }
  playSfx('hurt');
}

// coarse line-of-sight through the grid (blocked by solids, not liquids/gas)
function creatureLOS(x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(d / 2));
  for (let k = 1; k < n; k++) {
    if (creatureSolidAt(Math.round(x0 + (x1 - x0) * k / n),
                        Math.round(y0 + (y1 - y0) * k / n))) return false;
  }
  return true;
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
  if (c.elite) {
    // felling an elite: a real heal and a deep mana swig (lessers pay half)
    player.hp = Math.min(player.maxHp, player.hp + (c.lesser ? 8 : 15));
    wand.mana = Math.min(wand.maxMana, wand.mana + (c.lesser ? 15 : 30));
    splash(cx, cy, 2, E.SMOKE);
  }
  if (t.boss) {
    // slaying a guardian: big heal, full mana, and a death throe
    player.hp = Math.min(player.maxHp, player.hp + 30);
    wand.mana = wand.maxMana;
    if (t.lavaTrail) splash(cx, cy, 3, E.LAVA);
    if (t.elecAura) electrify(cx, cy, 6);
    if (t.grove) splash(cx, cy, 3, E.SEED); // it dies as it lived: seeding
    playSfx('explosion');
  }
  if (typeof run !== 'undefined' && run.active) {
    run.kills++; // replays re-enact kills but never farm meta progression
    if (typeof replayPlay === 'undefined' || !replayPlay.active) {
      meta.kills++;
      // trophy ledger: bosses and elites leave a permanent mark
      if (c.elite) meta.eliteKills++;
      if (c.key === 'magmaworm') meta.wormKills++;
      if (c.key === 'tempest') meta.tempestKills++;
      if (c.key === 'overgrowth') meta.groveKills++;
    }
  }
  playSfx('squish');
}

function updateWorm(c, t, dx, dy, dist) {

  // The Magma Worm: a molten shell deflects ALL direct damage (armor 1).
  // The fight is a quench cycle — survive its burrowing chase, watch for
  // the smoke-jet telegraph, then it BREACHES in a ballistic leap at you.
  // Land it in water (bait the arc over the reservoir, or soak it with a
  // spell) and thermal shock cracks the shell: it coils EXPOSED — 2×
  // damage, stompable. Land it on dry rock and you eat a lava slam
  // instead. Each phase break it dives deep (invulnerable) and erupts
  // magma geysers while boiling away part of the reservoir — quench
  // water gets scarcer as the fight escalates.
  const ratio = c.hp / (c.maxHp || t.hp);
  const phase = ratio > 0.66 ? 1 : ratio > 0.33 ? 2 : 3;
  if (c.surfaceCd === undefined) {
    c.surfaceCd = 220; c.exposedT = 0; c.breachTel = 0; c.airborne = false;
    c.slamT = 0; c.surgeT = 0; c.phaseDone = phase; c.geysers = [];
    c.reheatT = 0;
  }
  // quenching needs a HOT shell: after a window the shell is already
  // cooled, so water does nothing until it reheats — no chain-quenching
  // it in the pool forever
  if (c.reheatT > 0) c.reheatT--;
  const bx = Math.round(c.x + c.w / 2), by = Math.round(c.y + c.h / 2);
  const windowLen = phase === 3 ? 80 : phase === 2 ? 100 : 120;
  const cadence = phase === 3 ? 130 : phase === 2 ? 180 : 230;

  // --- phase break: MAGMA SURGE. It dives deep and erupts telegraphed
  // geysers across the arena; the reservoir partially boils away.
  if (phase > c.phaseDone && c.exposedT === 0 && !c.airborne) {
    c.phaseDone = phase;
    c.surgeT = 300; c.breachTel = 0; c.slamT = 0;
    c.geysers = [];
    for (let g = 0; g < 3 + phase; g++) {
      const gx = 16 + ((rand() * (SIM_W - 32)) | 0);
      let gy = SIM_H - 5; // walk up to the local surface
      while (gy > 8 && grid[idx(gx, gy - 1)] !== E.EMPTY &&
             grid[idx(gx, gy - 1)] !== E.WATER) gy--;
      c.geysers.push({ x: gx, y: gy });
    }
    playSfx('explosion');
  }
  if (c.surgeT > 0) {
    c.surgeT--;
    for (const g of c.geysers) {
      if (c.surgeT > 200) {
        // vent telegraph: smoke jets mark where the columns will rise
        if (rand() < 0.35 && grid[idx(g.x, g.y - 1)] === E.EMPTY) {
          setCell(idx(g.x, g.y - 1), E.SMOKE);
        }
      } else if (rand() < 0.55) {
        // eruption: a sputtering lava fountain (spawned high, rains down)
        const gx = Math.max(2, Math.min(SIM_W - 3, g.x + ((rand() * 3) | 0) - 1));
        const gy = g.y - 2 - ((rand() * (8 + phase * 3)) | 0);
        if (gy > 2 && grid[idx(gx, gy)] === E.EMPTY) setCell(idx(gx, gy), E.LAVA);
      }
    }
    // the heat boils the reservoir's edges — quench water gets scarce
    const px = 2 + ((rand() * (SIM_W - 4)) | 0);
    const py = 2 + ((rand() * (SIM_H - 4)) | 0);
    if (grid[idx(px, py)] === E.WATER && rand() < 0.5) setCell(idx(px, py), E.STEAM);
    if (c.surgeT === 0) c.surfaceCd = cadence;
    return; // dug in deep: no contact, no trail, invulnerable
  }

  if (c.exposedT > 0) {
    // --- EXPOSED: quenched and coiled. No attack, no lava, 2× damage —
    // and it can be stomped. It settles onto whatever is below it.
    c.exposedT--;
    c.vy = Math.min(0.8, (c.vy || 0) + 0.05);
    if (!creatureCollides(c, c.x, c.y + c.vy)) c.y += c.vy; else c.vy = 0;
    bossStomp(c);
    if (rand() < 0.2 && by > 1 && grid[idx(bx, by - 1)] === E.EMPTY) {
      setCell(idx(bx, by - 1), E.STEAM); // shell venting the quench off
    }
    if (c.exposedT === 0) { c.surfaceCd = cadence; c.reheatT = 280; }
    return;
  }

  if (c.airborne) {
    // --- BREACH: a ballistic leap. Contact hurts; where it lands decides
    // the round — water quenches it open, dry rock is a lava slam.
    c.vy += 0.07;
    c.x = Math.max(4, Math.min(SIM_W - 4 - c.w, c.x + c.vx));
    c.y = Math.max(6, c.y + c.vy);
    contactPlayer(c, t.contactDmg, 'crushed by the Magma Worm');
    if (c.vy < 0) {
      digCircle(bx, by, 3); // erupting up through whatever's in the way
    } else if (c.wet >= 3 && !(c.reheatT > 0)) {
      quenchBoss(c, windowLen); // splashdown — thermal shock
      return;
    } else if (c.y + c.h >= SIM_H - 5 ||
               creatureSolidAt(bx, Math.round(c.y + c.h))) {
      // dry SLAM: crater + lava burst, then it re-burrows
      digCircle(bx, by, 5);
      splash(bx, by, 2 + phase, E.LAVA);
      c.airborne = false;
      c.slamT = 25;
      c.surfaceCd = cadence;
      playSfx('explosion');
    }
    return;
  }

  if (c.breachTel > 0) {
    // --- telegraph: smoke jets crack the ground above it — move!
    c.breachTel--;
    for (let sy = by; sy > 3; sy--) {
      const j = idx(Math.max(1, Math.min(SIM_W - 2, bx + ((rand() * 5) | 0) - 2)), sy);
      if (grid[j] === E.EMPTY) { if (rand() < 0.6) setCell(j, E.SMOKE); break; }
    }
    if (c.breachTel === 0) {
      // LAUNCH at where you're standing (flight ≈ 65 frames)
      c.airborne = true;
      c.vx = Math.max(-1.6, Math.min(1.6, dx / 65));
      c.vy = -2.3;
      digCircle(bx, by, 4);
      playSfx('explosion');
    }
    return;
  }

  if (c.slamT > 0) { c.slamT--; return; } // dazed a beat after a dry slam

  // soaking it while it tunnels also cracks the shell (thermal shock) —
  // Water Jet is a tool to force the window, never a way to melt it down
  if (c.wet >= 8 && !(c.reheatT > 0)) { quenchBoss(c, windowLen); return; }

  // --- BURROWING chase (faster the weaker it gets)
  const spd = t.speed * (phase === 3 ? 1.45 : phase === 2 ? 1.15 : 1);
  let sx = dx / dist, sy = dy / dist;
  // a hot shell FEARS the quench: it dives under pools in its path
  // instead of swimming through them (bait the breach to get it wet)
  if (!(c.reheatT > 0)) {
    const fx = Math.round(bx + sx * 7), fy = Math.round(by + sy * 7);
    if (fx > 1 && fx < SIM_W - 1 && fy > 1 && fy < SIM_H - 1 &&
        (grid[idx(fx, fy)] === E.WATER || c.wet > 0)) {
      sy = 0.9; sx = Math.sign(sx || c.dir) * 0.45;
    }
  }
  if (dist > 3) { c.x += sx * spd; c.y = Math.min(SIM_H - 10, c.y + sy * spd); }
  digCircle(bx, by, 3);
  // lava trail — much heavier late, which heats the arena via the temp field
  const lavaP = t.lavaTrail * (phase === 3 ? 3.2 : phase === 2 ? 2.2 : 1);
  if (rand() < lavaP) {
    const lx = Math.max(1, Math.min(SIM_W - 2, bx - Math.sign(dx) * 4));
    const j = idx(lx, by);
    if (grid[j] === E.EMPTY) setCell(j, E.LAVA);
  }
  // radiant superheat in later phases (reliable, on top of the lava)
  if (phase >= 2) {
    const tj = (by >> 2) * TEMP_W + (bx >> 2);
    if (tj >= 0 && tj < temp.length) {
      temp[tj] = Math.min(150, temp[tj] + (phase === 3 ? 2.2 : 1.3));
    }
  }
  // contact damage (no gravity/collision for a worm)
  contactPlayer(c, t.contactDmg, 'crushed by the Magma Worm');
  // time to breach? only near the player, so the bait is playable
  if (--c.surfaceCd <= 0 && dist < 150) {
    c.breachTel = 50;
    playSfx('hurt');
  }
  return;
}

function updateTempest(c, t, ccx, ccy, pcx, pcy, dx, dy, dist, chase) {

  // The Tempest: a storm capacitor. It hovers with real steering — no
  // line of sight means it CLIMBS over cover instead of sulking behind
  // it — and only throws arc globs down a clear lane. Its cycle: hover →
  // CHARGE (locks in place, crackling: get behind a pillar) → NOVA
  // (bolts bracket you) → SPENT: it falls to the floor, dim, harmless,
  // 2× damage and stompable. Soaking it with fresh water short-circuits
  // it into the window early — but the splash arcs back, live. Phase
  // breaks it rides to the ceiling (invulnerable) and rains a squall:
  // more floor water for its aura to electrify, and more quench ammo.
  const ratio = c.hp / (c.maxHp || t.hp);
  const phase = ratio > 0.66 ? 1 : ratio > 0.33 ? 2 : 3;
  if (c.chargeCd === undefined) {
    c.chargeCd = 320; c.chargingT = 0; c.exposedT = 0;
    c.squallT = 0; c.phaseDone = phase;
  }
  const bx = Math.round(ccx), by = Math.round(ccy);

  // --- phase break: STORM SQUALL — retreat to the ceiling and flood the
  // arena with rain and stray bolts
  if (phase > c.phaseDone && c.exposedT === 0) {
    c.phaseDone = phase;
    c.squallT = 280; c.chargingT = 0;
    playSfx('arc');
  }
  if (c.squallT > 0) {
    c.squallT--;
    c.vx += ((SIM_W / 2 - ccx) * 0.004 - c.vx) * 0.1;
    c.vy += ((16 - ccy) * 0.02 - c.vy) * 0.1;
    if (!creatureCollides(c, c.x + c.vx, c.y)) c.x += c.vx;
    if (!creatureCollides(c, c.x, c.y + c.vy)) c.y = Math.max(6, c.y + c.vy);
    for (let k = 0; k < 3; k++) { // the squall itself: real water
      const j = idx(8 + ((rand() * (SIM_W - 16)) | 0), 6 + ((rand() * 4) | 0));
      if (grid[j] === E.EMPTY) setCell(j, E.WATER);
    }
    if (c.squallT % 50 === 0) {
      lightningStrikeAt(8 + ((rand() * (SIM_W - 16)) | 0), 6, false);
      playSfx('arc');
    }
    return; // storm-wreathed: invulnerable until the squall passes
  }

  if (c.exposedT > 0) {
    // --- SPENT: discharged, it drops out of the air. No aura, no globs,
    // 2× damage — and it can be stomped.
    c.exposedT--;
    c.vx *= 0.85;
    c.vy = Math.min(1.2, (c.vy || 0) + 0.1);
    if (!creatureCollides(c, c.x, c.y + c.vy)) c.y += c.vy; else c.vy = 0;
    bossStomp(c);
    if (c.exposedT === 0) c.chargeCd = 340 - phase * 40;
    return;
  }

  // short-circuit: fresh water on a charged storm forces the discharge —
  // but the very water you threw becomes live around it
  if (c.wet >= 4) {
    electrify(bx, by, 6);
    c.chargingT = 0;
    c.exposedT = exposeFor(150 - phase * 15);
    playSfx('arc');
    return;
  }

  if (c.chargingT > 0) {
    // --- CHARGE telegraph: locked in place, shedding crackle — get clear
    c.chargingT--;
    c.vx = 0; c.vy = 0;
    if (rand() < 0.4) {
      const ax = bx + ((rand() * 10) | 0) - 5, ay = by + ((rand() * 10) | 0) - 5;
      if (ax > 1 && ax < SIM_W - 1 && ay > 1 && ay < SIM_H - 1 &&
          grid[idx(ax, ay)] === E.EMPTY) {
        const j = idx(ax, ay);
        setCell(j, E.ELEC);
        life[j] = 2;
      }
    }
    if (c.chargingT === 0) {
      // NOVA: bolts bracket the player (pillars intercept — use cover),
      // then the storm falls spent
      for (let k = 0; k < 2 + phase; k++) {
        const sx = Math.max(6, Math.min(SIM_W - 6, Math.round(pcx + rand() * 56 - 28)));
        lightningStrikeAt(sx, 6, false);
      }
      electrify(bx, by, 8);
      playSfx('arc');
      c.exposedT = exposeFor(160 - phase * 20);
    }
    return;
  }

  // --- hover: climb whenever cover breaks the line to the player
  if (--c.chargeCd <= 0 && dist < 220) { c.chargingT = 65; return; }
  const los = creatureLOS(ccx, ccy, pcx, pcy);
  const headroom = !creatureCollides(c, c.x, c.y - 1.5);
  let tvx, tvy;
  if (chase && !los) {
    // blocked sight: climb over the cover — but if the ceiling stops the
    // climb (or it's dragged on too long), swoop down at you instead of
    // pinning itself against the roof
    c.noLosT = (c.noLosT || 0) + 1;
    if (headroom && c.noLosT < 140) {
      tvx = dx / dist * t.speed * 0.5;
      tvy = -t.speed; // rise until it can see you again
    } else {
      tvx = dx / dist * t.speed;
      tvy = Math.max(0.25, dy / dist * t.speed);
      if (c.noLosT > 280) c.noLosT = 0; // then try climbing again
    }
  } else if (chase) {
    c.noLosT = 0;
    tvx = dx / dist * t.speed;
    tvy = Math.max(-t.speed, Math.min(t.speed, (pcy - 22 - ccy) * 0.03));
  } else {
    c.bob += 0.08;
    if (rand() < 0.015) c.dir = -c.dir;
    tvx = c.dir * t.speed * 0.5;
    tvy = Math.sin(c.bob) * 0.15;
  }
  c.vx += (tvx - c.vx) * 0.1;
  c.vy += (tvy - c.vy) * 0.1;
  if (!creatureCollides(c, c.x + c.vx, c.y)) c.x += c.vx;
  else { // wall: climb if there's headroom, otherwise duck under
    c.vx = 0;
    c.vy = headroom ? Math.min(c.vy, -t.speed * 0.8)
                    : Math.max(c.vy, t.speed * 0.8);
  }
  if (!creatureCollides(c, c.x, c.y + c.vy)) c.y += c.vy;
  else c.vy = 0;
  // storm pressure: its charge bleeds into water well below its hover
  // height, so the puddles under the fight go live
  if (rand() < 0.6) {
    const ax = bx + ((rand() * 33) | 0) - 16, ay = by + ((rand() * 33) | 0) - 16;
    if (ax > 0 && ax < SIM_W - 1 && ay > 0 && ay < SIM_H - 1 &&
        grid[idx(ax, ay)] === E.WATER) setCell(idx(ax, ay), E.EWATER);
  }
  // arc globs — only down a clear lane (no more wasting shots into rock)
  c.attackCd--;
  if (chase && los && dist > 12 && c.attackCd <= 0) {
    c.attackCd = t.ranged.cooldown + ((rand() * 40) | 0);
    eProjectiles.push({
      x: ccx, y: ccy - 1,
      vx: dx / dist * t.ranged.speed,
      vy: dy / dist * t.ranged.speed - 0.45,
      dmg: t.ranged.dmg,
      kind: 'elec',
    });
    playSfx('arc');
  }
  // contact zap
  contactPlayer(c, t.contactDmg, 'zapped by the Tempest');
  return;
}

// The Overgrowth: a fungal colossus that REGENERATES relentlessly — plain
// damage loses to the regrowth, so FIRE is the key (completing the triangle:
// water quenches the worm, water shorts the tempest, fire dries the grove).
// Keep it burning to build SCORCH; at the threshold the dried husk cracks
// EXPOSED — 2× damage, stompable, no regen. Afterward fresh sap won't catch
// for a while (regrow), so you rebuild the burn. It creeps forward shedding
// plants and fungus (arena control your fire also clears), and mortars spore
// globs over cover. Phase breaks: BLOOM — rooted and invulnerable, it rains
// seeds and surges vines from the floor.
function updateGrove(c, t, dx, dy, dist, chase) {
  const ratio = c.hp / (c.maxHp || t.hp);
  const phase = ratio > 0.66 ? 1 : ratio > 0.33 ? 2 : 3;
  if (c.scorchT === undefined) {
    c.scorchT = 0; c.regrowT = 0; c.bloomT = 0; c.exposedT = 0;
    c.phaseDone = phase;
  }
  const bx = Math.round(c.x + c.w / 2), by = Math.round(c.y + c.h / 2);

  // the regrowth: heals through anything except burning and the open window
  if (c.burning === 0 && c.exposedT === 0) {
    c.hp = Math.min(c.maxHp || t.hp, c.hp + t.regen);
  }

  // --- phase break: BLOOM — rooted, invulnerable, raining life
  if (phase > c.phaseDone && c.exposedT === 0) {
    c.phaseDone = phase;
    c.bloomT = 280; c.scorchT = 0;
    playSfx('spit');
  }
  if (c.bloomT > 0) {
    c.bloomT--;
    for (let k = 0; k < 2; k++) { // spore rain: seeds drift from the sky band
      const j = idx(8 + ((rand() * (SIM_W - 16)) | 0), 6 + ((rand() * 4) | 0));
      if (grid[j] === E.EMPTY) setCell(j, E.SEED);
    }
    if (rand() < 0.4) { // vine surge: growth erupts from the floor
      const vx = 8 + ((rand() * (SIM_W - 16)) | 0);
      for (let vy = SIM_H - 5; vy > 8; vy--) {
        const j = idx(vx, vy);
        if (grid[j] === E.EMPTY) {
          if (creatureSolidAt(vx, vy + 1) || grid[j + SIM_W] === E.PLANT) {
            setCell(j, E.PLANT);
          }
          break;
        }
      }
    }
    return; // rooted deep: invulnerable until the bloom passes
  }

  if (c.exposedT > 0) {
    // --- SCORCHED: a dried husk. No attacks, no regen, 2× damage, stompable.
    c.exposedT--;
    bossStomp(c);
    if (rand() < 0.15 && by > 1 && grid[idx(bx, by - 2)] === E.EMPTY) {
      setCell(idx(bx, by - 2), E.SMOKE); // charred and smoking
    }
    if (c.exposedT === 0) c.regrowT = 240; // fresh sap won't catch for a while
    return;
  }

  if (c.regrowT > 0) c.regrowT--;
  // scorch: sustained burning dries the husk toward the window
  if (c.burning > 0 && !(c.regrowT > 0)) {
    c.scorchT++;
    if (c.scorchT >= 90) {
      c.scorchT = 0;
      c.burning = 0;
      c.exposedT = exposeFor(140 - phase * 20);
      splash(bx, by - 2, 2, E.SMOKE);
      playSfx('explosion');
      return;
    }
  } else if (c.scorchT > 0) {
    c.scorchT -= 0.5; // wet bark recovers if the fire dies
  }

  // --- creeping advance: a slow tank that walks at you and never retreats
  if (chase) c.dir = dx > 0 ? 1 : -1;
  c.vy = Math.min(1.4, c.vy + 0.1);
  if (creatureCollides(c, c.x, c.y + 0.2)) {
    const spd = t.speed * (phase === 3 ? 1.5 : phase === 2 ? 1.2 : 1);
    c.vx = c.dir * spd;
    if (creatureCollides(c, c.x + c.dir, c.y)) {
      if (!creatureCollides(c, c.x + c.dir, c.y - 2)) {
        c.vy = -1.2; // clamber a low step
      } else {
        // walled in: its roots PRY the stone apart — a slow chew that
        // guarantees it always reaches you (never stuck, never fast)
        c.vx = 0;
        c.chewT = (c.chewT || 0) + 1;
        if (c.chewT >= 14) {
          c.chewT = 0;
          const fx = Math.max(2, Math.min(SIM_W - 3,
            Math.round(c.dir > 0 ? c.x + c.w + 1 : c.x - 2)));
          const fy = Math.round(c.y + c.h / 2);
          digCircle(fx, fy, 2);
          // root residue marks the bored tunnel
          if (rand() < 0.4 && grid[idx(fx, fy + 2)] !== E.EMPTY &&
              grid[idx(fx, fy + 1)] === E.EMPTY) {
            setCell(idx(fx, fy + 1), E.PLANT);
          }
        }
      }
    }
  }
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

  // growth trail: it seeds the arena behind it (fire clears this too)
  if (rand() < 0.12) {
    const gx = Math.max(1, Math.min(SIM_W - 2, bx - c.dir * ((rand() * 4) | 0)));
    const gy = Math.round(c.y + c.h);
    if (gy > 0 && gy < SIM_H - 1 && grid[idx(gx, gy - 1)] === E.EMPTY &&
        creatureSolidAt(gx, gy)) {
      setCell(idx(gx, gy - 1), rand() < 0.8 ? E.PLANT : E.FUNGUS);
    }
  }

  // spore mortar: lobbed high, drops behind cover (no line of sight needed)
  c.attackCd--;
  if (chase && dist > 12 && c.attackCd <= 0) {
    c.attackCd = t.ranged.cooldown + ((rand() * 50) | 0) -
                 (phase === 3 ? 40 : phase === 2 ? 20 : 0);
    eProjectiles.push({
      x: c.x + c.w / 2, y: c.y - 1,
      vx: dx / dist * t.ranged.speed,
      vy: dy / dist * t.ranged.speed - 0.8, // mortar arc
      dmg: t.ranged.dmg,
      kind: 'spore',
    });
    playSfx('spit');
  }

  contactPlayer(c, t.contactDmg, 'strangled by the Overgrowth');
}

function updateCreatures() {
  for (let i = creatures.length - 1; i >= 0; i--) {
    const c = creatures[i];
    const t = CREATURE_TYPES[c.key];
    if (c.hurtFlash > 0) c.hurtFlash--;

    // elite rhythm: heavily plated most of the time, periodically EXPOSED
    // (pulsing gold, 2× damage) — the boss grammar, miniaturized. Unlike a
    // boss it keeps fighting through its window; the window is your opening,
    // not a truce.
    if (c.elite) {
      if (c.exposedT > 0) {
        if (--c.exposedT === 0) c.eliteCd = 200;
      } else if (--c.eliteCd <= 0) {
        c.exposedT = exposeFor(80);
        const ex = Math.round(c.x + c.w / 2), ey = Math.round(c.y) - 1;
        if (ey > 0 && grid[idx(ex, ey)] === E.EMPTY) setCell(idx(ex, ey), E.SMOKE);
        playSfx('hurt');
      }
    }

    // --- environment: creatures obey the same elements the player does
    let dmg = 0;
    let touchedWater = false, waterCells = 0;
    const x0 = Math.floor(c.x), x1 = Math.ceil(c.x + c.w) - 1;
    const y0 = Math.floor(c.y), y1 = Math.ceil(c.y + c.h) - 1;
    for (let cy = y0; cy <= y1; cy++) {
      if (cy < 0 || cy >= SIM_H) continue;
      for (let cx = x0; cx <= x1; cx++) {
        if (cx < 0 || cx >= SIM_W) continue;
        const id = grid[idx(cx, cy)];
        if (id === E.WATER) {
          touchedWater = true;
          waterCells++; // bosses read this as "how soaked am I" (quenching)
        }
        // green wood doesn't burn, it DRIES: fire deals no damage to the
        // unscorched grove — it only builds scorch. A scorched husk torches.
        else if (id === E.FIRE) {
          if (!t.fireImmune) {
            if (!t.grove || c.exposedT > 0) dmg += 0.4;
            c.burning = 120;
          }
        }
        else if (id === E.LAVA) { if (!t.fireImmune) { dmg += 0.9; c.burning = 180; } }
        else if (id === E.MOLTEN) { if (!t.fireImmune) { dmg += 1.0; c.burning = 180; } }
        else if (id === E.ACID) dmg += 0.35;
        else if (id === E.ELEC) { if (!t.elecAura) dmg += 1.2; }
        else if (id === E.EWATER) { if (!t.elecAura) dmg += 0.8; }
      }
    }
    // water sizzle is CAPPED per frame, so drowning the worm in the reservoir
    // (or spamming Water Jet) can't melt it — it's a steady weakness, not an
    // instant kill. Being well-soaked flushes it up into a vulnerable window.
    c.wet = waterCells;
    if (t.waterDmg && waterCells > 0) {
      dmg += Math.min(waterCells * t.waterDmg, 0.8);
      const sx = x0 + (rand() * (x1 - x0 + 1) | 0), sy = y0 + (rand() * (y1 - y0 + 1) | 0);
      if (grid[idx(sx, sy)] === E.WATER && rand() < 0.4) setCell(idx(sx, sy), E.STEAM);
    }
    if (touchedWater) {
      c.burning = 0;
      if (t.diesInWater) { c.hp = 0; }
    }
    if (c.burning > 0) {
      c.burning--;
      if (!t.grove || c.exposedT > 0) dmg += 0.06; // drying, not dying
      const hx = Math.round(c.x + c.w / 2), hy = y0 - 1;
      if (rand() < 0.08 && hy > 0 && grid[idx(hx, hy)] === E.EMPTY) {
        setCell(idx(hx, hy), E.FIRE);
      }
    }
    // bosses: shell/charge armor applies to the environment too — no chipping
    // a guardian to death with a hose of hazards; the windows ARE the fight
    if (t.boss && !(c.exposedT > 0)) dmg *= 1 - (t.armor || 0);
    c.hp -= dmg;
    if (c.hp <= 0) { killCreature(i); continue; }

    // --- AI: chase when the player is near, wander otherwise
    const pcx = player.x + player.w / 2, pcy = player.y + player.h / 2;
    const ccx = c.x + c.w / 2, ccy = c.y + c.h / 2;
    const dx = pcx - ccx, dy = pcy - ccy;
    const dist = Math.hypot(dx, dy) || 1;
    const chase = player.alive && dist < t.sight;

    // ranged types lob a glob instead of closing in (spitters: acid; the
    // guardians handle their own fire discipline in their state machines)
    if (t.ranged && !t.storm && !t.grove) {
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
    // storm aura: electrify nearby water (a SPENT storm has no charge left)
    if (t.elecAura && !(c.exposedT > 0)) {
      for (let k = 0; k < 3; k++) {
        const ax = Math.round(ccx + rand() * 14 - 7);
        const ay = Math.round(ccy + rand() * 14 - 7);
        if (ax > 0 && ax < SIM_W - 1 && ay > 0 && ay < SIM_H - 1) {
          const j = idx(ax, ay);
          if (grid[j] === E.WATER) setCell(j, E.EWATER);
        }
      }
    }

    // the guardians run their own state machines (extracted for sanity)
    if (t.burrow) { updateWorm(c, t, dx, dy, dist); continue; }
    if (t.storm) { updateTempest(c, t, ccx, ccy, pcx, pcy, dx, dy, dist, chase); continue; }
    if (t.grove) { updateGrove(c, t, dx, dy, dist, chase); continue; }

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
      // Iron Boots: landing on it crushes it (piercing armor) instead of it
      // hurting you — a bloat still detonates underfoot, so choose your prey
      if (runState.stomp && player.vy > 0.5 &&
          player.y + player.h < c.y + c.h * 0.7) {
        damageCreature(c, 18, true);
        player.vy = -1.4;
        player.hurtCd = Math.max(player.hurtCd, 20);
        if (c.hp <= 0) { killCreature(i); continue; }
      } else {
        const cd = c.elite && !c.lesser ? Math.round(t.contactDmg * 1.5) : t.contactDmg;
        contactPlayer(c, cd, 'slain by ' + (c.elite ? 'an elite ' : 'a ') + c.key);
      }
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
          player.lastHurt = ep.kind === 'elec' ? 'struck by an arc glob' : 'splashed by an acid glob';
          player.hurtCd = 45;
          playSfx('hurt');
          if (player.hp <= 0) { player.hp = 0; player.alive = false; }
        }
        if (ep.kind === 'elec') electrify(cx, cy, 2);
        else if (ep.kind === 'spore') splash(cx, cy, 1, E.SMOKE); // choking puff
        else splash(cx, cy, 1, E.ACID);
        dead = true;
        break;
      }
      const id = grid[idx(cx, cy)];
      if (id !== E.EMPTY && id !== E.FIRE && TYPE[id] !== T.GAS) {
        // glob bursts into its element
        if (ep.kind === 'elec') electrify(cx, cy, 2);
        else if (ep.kind === 'spore') {
          // the spore takes root where it lands
          if (cy > 1 && grid[idx(cx, cy - 1)] === E.EMPTY) {
            setCell(idx(cx, cy - 1), rand() < 0.6 ? E.PLANT : E.FUNGUS);
          }
          splash(cx, cy - 1, 1, E.SMOKE);
        }
        else splash(cx, cy, 1, E.ACID);
        dead = true;
      }
    }
    if (dead) eProjectiles.splice(p, 1);
  }
}

// lazily rasterized 8×8 canvases for CREATURE_PX (browser only)
const _creatureSprites = {};
function creatureSprite(key) {
  let cv = _creatureSprites[key];
  if (!cv) {
    cv = document.createElement('canvas');
    cv.width = 8; cv.height = 8;
    const g = cv.getContext('2d');
    const px = CREATURE_PX[key];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const ch2 = px[y][x];
        if (ch2 === '.') continue;
        g.fillStyle = ICON_COLORS[ch2] || '#fff';
        g.fillRect(x, y, 1, 1);
      }
    }
    _creatureSprites[key] = cv;
  }
  return cv;
}

// flash frames keep the sprite's SHAPE and swap only its color: a solid
// silhouette in the flash tint (cached per key+color)
const _creatureTints = {};
function creatureTint(key, color) {
  const id = key + color;
  let cv = _creatureTints[id];
  if (!cv) {
    cv = document.createElement('canvas');
    cv.width = 8; cv.height = 8;
    const g = cv.getContext('2d');
    g.drawImage(creatureSprite(key), 0, 0);
    g.globalCompositeOperation = 'source-in'; // paint only where pixels exist
    g.fillStyle = color;
    g.fillRect(0, 0, 8, 8);
    _creatureTints[id] = cv;
  }
  return cv;
}

function drawCreatures() {
  if (creatures.length === 0 && eProjectiles.length === 0) return;
  const cw = displayCanvas.width / camera.w;
  const ch = displayCanvas.height / camera.h;
  displayCtx.imageSmoothingEnabled = false; // sprites stay chunky when scaled
  for (const c of creatures) {
    const t = CREATURE_TYPES[c.key];
    const sx = (c.x - camera.x) * cw, sy = (c.y - camera.y) * ch;
    // combat states flash FLAT — the color language players already know
    const flash =
      c.hurtFlash > 0 ? '#ffffff'
      : c.exposedT > 0 ? (simFrame & 4 ? '#ffe0a0' : '#ffb84a') // vulnerable: pulsing pale
      : (c.chargingT || 0) > 0 && (simFrame & 2) ? '#ffffff'    // charging: strobing
      : (c.bloomT || 0) > 0 && (simFrame & 4) ? '#7ec850'       // blooming: verdant pulse
      : c.burning > 0 && (simFrame & 4) ? '#ff8c3c'
      : null;
    if (CREATURE_PX[c.key]) {
      // the roster wears its pixel art, flipped to face its direction;
      // flash frames tint the same silhouette so the shape never pops
      const spr = flash ? creatureTint(c.key, flash) : creatureSprite(c.key);
      if (c.dir < 0) {
        displayCtx.save();
        displayCtx.translate(sx + c.w * cw, sy);
        displayCtx.scale(-1, 1);
        displayCtx.drawImage(spr, 0, 0, c.w * cw, c.h * ch);
        displayCtx.restore();
      } else {
        displayCtx.drawImage(spr, sx, sy, c.w * cw, c.h * ch);
      }
      continue;
    }
    displayCtx.fillStyle = flash || t.color;
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

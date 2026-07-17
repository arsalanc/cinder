// Headless smoke test: batch 2 — elites, relic vaults, endless descent,
// Storm Caller / Insulated / Executioner.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'js');
const ctx = vm.createContext({ Math, console, Date });
for (const f of ['elements.js', 'sim.js', 'worldgen.js', 'input.js', 'player.js', 'spells.js', 'synergies.js', 'audio.js', 'creatures.js', 'weather.js', 'game.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}
const out = vm.runInContext(`
(function () {
  const results = [];
  function test(name, fn) {
    try { fn(); results.push('PASS ' + name); }
    catch (e) { results.push('FAIL ' + name + ': ' + (e.stack ? e.stack.split('\\n')[0] : e)); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg); }
  function count(id) { let c = 0; for (let i = 0; i < CELLS; i++) if (grid[i] === id) c++; return c; }
  function mod(name) { return MODIFIERS.find(m => m.name === name); }

  test('depth 4+ levels spawn exactly one elite; early depths none', () => {
    pendingRunSeed = 'elite-check';
    startRun();
    assert(!creatures.some(c => c.elite), 'depth 1 spawned an elite');
    run.depth = 4;
    beginLevel();
    const elites = creatures.filter(c => c.elite);
    assert(elites.length === 1, 'expected 1 elite at depth 4, got ' + elites.length);
    const e = elites[0];
    const base = CREATURE_TYPES[e.key];
    assert(e.hp === base.hp * 3 && e.w > base.w, 'elite not oversized/beefed');
  });

  test('elite rhythm: plated (0.6 armor floor) until its window opens (2x)', () => {
    startRun();
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    clearCreatures();
    player.x = 40; player.y = SIM_H - 12; player.alive = true; player.hp = 100; player.hurtCd = 0;
    const t = CREATURE_TYPES.pouncer; // base armor 0 — elites get the floor
    creatures.push({ key: 'pouncer', x: 200, y: SIM_H - 6 - t.h - 1, vx: 0, vy: 0,
      w: t.w + 2, h: t.h + 1, hp: t.hp * 3, maxHp: t.hp * 3, dir: 1, burning: 0,
      hurtFlash: 0, bob: 0, attackCd: 60, elite: true, eliteCd: 40, exposedT: 0 });
    const c = creatures[0];
    let hpBefore = c.hp;
    damageCreature(c, 10);
    assert(Math.abs((hpBefore - c.hp) - 4) < 0.01,
      'elite armor floor missing: took ' + (hpBefore - c.hp));
    // run until the window opens
    let opened = false;
    for (let k = 0; k < 80 && !opened; k++) { updateCreatures(); if (c.exposedT > 0) opened = true; }
    assert(opened, 'elite window never opened');
    hpBefore = c.hp;
    damageCreature(c, 10);
    assert(Math.abs((hpBefore - c.hp) - 20) < 0.01, 'no 2x in elite window');
    // window closes and the plating returns
    c.exposedT = 1;
    updateCreatures();
    assert(c.exposedT === 0 && c.eliteCd > 0, 'window did not close/rearm');
  });

  test('felling an elite heals and refunds mana', () => {
    startRun();
    clearCreatures();
    const t = CREATURE_TYPES.grub;
    creatures.push({ key: 'grub', x: 200, y: 100, vx: 0, vy: 0,
      w: t.w + 2, h: t.h + 1, hp: 0.5, maxHp: t.hp * 3, dir: 1, burning: 0,
      hurtFlash: 0, bob: 0, attackCd: 60, elite: true, eliteCd: 99, exposedT: 0 });
    player.hp = 50; player.maxHp = 100; player.alive = true;
    wand.mana = 10;
    creatures[0].hp = -1;
    updateCreatures();
    assert(player.hp >= 65, 'no elite heal: ' + player.hp);
    assert(wand.mana >= 45, 'no elite mana refund: ' + wand.mana);
  });

  test('a relic vault appears: glass shell, hazard fill, relic clear inside', () => {
    let found = false;
    for (let n = 0; n < 6 && !found; n++) {
      pendingRunSeed = 'vault-' + n;
      startRun();
      if (relic.present) found = true;
    }
    assert(found, 'no relic vault on any of 6 seeds');
    assert(grid[idx(relic.x, relic.y)] === E.EMPTY, 'relic cell not clear');
    // glass shell on the vault perimeter
    let glass = 0;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -4; dx <= 4; dx++)
        if (grid[idx(relic.x + dx, relic.y + dy)] === E.GLASS) glass++;
    assert(glass >= 20, 'vault shell missing: ' + glass + ' glass');
    // interior holds SOMETHING hazardous/liquid (not carved-out air)
    let interior = 0;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -3; dx <= 3; dx++)
        if (grid[idx(relic.x + dx, relic.y + dy)] !== E.EMPTY) interior++;
    assert(interior >= 20, 'vault interior empty: ' + interior);
  });

  test('grabbing the relic grants a bonus pick without leaving the level', () => {
    let attempts = 0;
    do { pendingRunSeed = 'vaultpick-' + attempts++; startRun(); }
    while (!relic.present && attempts < 8);
    assert(relic.present, 'no vault to test with');
    const depthBefore = run.depth, portalBefore = portal.x + portal.y * 1000;
    player.x = relic.x - player.w / 2;
    player.y = relic.y - player.h / 2;
    player.alive = true; player.hurtCd = 99999;
    updateGame();
    assert(relic.taken, 'relic not collected');
    assert(run.choosing && run.relicChoice, 'no bonus choice offered');
    const before = run.mods.length;
    chooseModifier(rollChoices(1, run.mods)[0]);
    assert(run.mods.length === before + 1, 'mod not applied');
    assert(run.depth === depthBefore, 'relic pick advanced the depth');
    assert(portal.x + portal.y * 1000 === portalBefore, 'level regenerated on relic pick');
    assert(!run.choosing && !run.relicChoice, 'choice state not cleared');
  });

  test('endless descent: bosses recur scaled, and depths past 6 keep going', () => {
    assert(isBossDepth(9) && isBossDepth(12) && !isBossDepth(7) && !isBossDepth(8),
      'endless boss cadence wrong');
    pendingRunSeed = 'endless-1';
    startRun();
    // the endless rotation covers all three guardians without repeats
    const trio = new Set([bossKeyFor(9), bossKeyFor(12), bossKeyFor(15)]);
    assert(trio.size === 3, 'endless rotation repeats: ' + [...trio]);
    run.endless = true;
    run.depth = 9;
    beginLevel();
    const b = creatures.find(c => CREATURE_TYPES[c.key].boss);
    assert(b && b.key === bossKeyFor(9), 'depth 9 guardian missing/mismatched');
    assert(b.maxHp > CREATURE_TYPES[b.key].hp, 'endless boss not scaled: ' + b.maxHp);
  });

  test('Storm Caller pins the weather and wards lightning away from you', () => {
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 4; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    seedSim(70);
    resetModifiers();
    mod('Storm Caller').apply();
    resetWeather();
    for (let k = 0; k < 5; k++) updateWeather();
    assert(weather.mode === 'storm', 'weather not pinned to storm: ' + weather.mode);
    // the ward: 40 bolts, none in the player's columns
    player.x = 160; player.y = SIM_H - 10; player.alive = true;
    for (let k = 0; k < 40; k++) lightningStrike();
    let nearMiss = 0;
    for (let y = 1; y < SIM_H - 4; y++)
      for (let x = 0; x < SIM_W; x++)
        if (grid[idx(x, y)] === E.ELEC && Math.abs(x - 161.5) < 13) nearMiss++;
    assert(nearMiss === 0, 'lightning struck inside the ward: ' + nearMiss + ' cells');
    resetModifiers();
    resetWeather();
  });

  test('Insulated shrugs off electrified water', () => {
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 4; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    function wade() { // ankle-deep live water: the mod's advertised use case
      for (let x = 140; x < 170; x++)
        for (let y = SIM_H - 6; y < SIM_H - 4; y++) setCell(idx(x, y), E.EWATER);
      player.x = 150; player.y = SIM_H - 4 - player.h; player.vx = 0; player.vy = 0;
      player.alive = true; player.hp = 100; player.warmth = 60; player.burning = 0;
      input.keys = {};
      for (let k = 0; k < 15; k++) updatePlayer();
      return 100 - player.hp;
    }
    resetModifiers();
    const baseLoss = wade();
    mod('Insulated').apply();
    const insLoss = wade();
    assert(baseLoss > 5, 'baseline EWATER harmless? lost ' + baseLoss.toFixed(1));
    assert(insLoss < baseLoss * 0.25,
      'Insulated too weak: ' + insLoss.toFixed(1) + ' vs ' + baseLoss.toFixed(1));
    resetModifiers();
  });

  test('boss and elite kills stamp the trophy ledger and unlock trophies', () => {
    pendingRunSeed = 'trophy-1';
    startRun();
    clearCreatures();
    meta.wormKills = 0; meta.tempestKills = 0; meta.eliteKills = 0;
    const w = CREATURE_TYPES.magmaworm, t = CREATURE_TYPES.tempest, g = CREATURE_TYPES.grub;
    player.x = 20; player.y = 20; player.alive = true; player.hp = 100; player.maxHp = 100;
    creatures.push({ key: 'magmaworm', x: 100, y: 100, vx: 0, vy: 0, w: w.w, h: w.h,
      hp: -1, dir: 1, burning: 0, hurtFlash: 0, bob: 0, attackCd: 60 });
    creatures.push({ key: 'tempest', x: 200, y: 100, vx: 0, vy: 0, w: t.w, h: t.h,
      hp: -1, dir: 1, burning: 0, hurtFlash: 0, bob: 0, attackCd: 60 });
    creatures.push({ key: 'grub', x: 260, y: 100, vx: 0, vy: 0, w: g.w + 2, h: g.h + 1,
      hp: -1, maxHp: g.hp * 3, dir: 1, burning: 0, hurtFlash: 0, bob: 0, attackCd: 60,
      elite: true, eliteCd: 99, exposedT: 0 });
    updateCreatures();
    assert(meta.wormKills === 1, 'worm kill not counted: ' + meta.wormKills);
    assert(meta.tempestKills === 1, 'tempest kill not counted: ' + meta.tempestKills);
    assert(meta.eliteKills === 1, 'elite kill not counted: ' + meta.eliteKills);
    assert(isUnlocked(MODIFIERS.find(m => m.name === 'Wormheart')), 'Wormheart locked');
    assert(isUnlocked(MODIFIERS.find(m => m.name === 'Stormcore')), 'Stormcore locked');
    const ex = MODIFIERS.find(m => m.name === 'Executioner');
    assert(!isUnlocked(ex), 'Executioner unlocked too early');
    meta.eliteKills = 5;
    assert(isUnlocked(ex), 'Executioner not unlocked at 5 elites');
  });

  test('Wormheart: burning warms you instead of harming you', () => {
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    seedSim(77);
    resetModifiers();
    function burnout(frames) {
      player.x = 150; player.y = SIM_H - 6 - player.h; player.vx = 0; player.vy = 0;
      player.alive = true; player.hp = 100; player.warmth = 40; player.burning = 400;
      input.keys = {};
      for (let k = 0; k < frames; k++) updatePlayer();
      return { hp: player.hp, warmth: player.warmth };
    }
    const base = burnout(150);
    assert(base.hp < 92, 'baseline burning barely hurt: ' + base.hp.toFixed(1));
    MODIFIERS.find(m => m.name === 'Wormheart').apply();
    const worm = burnout(150);
    assert(worm.hp > 99.9, 'Wormheart still burned: ' + worm.hp.toFixed(1));
    assert(worm.warmth > 60, 'Wormheart did not warm: ' + worm.warmth.toFixed(0));
    assert(worm.warmth < 90, 'Wormheart overheats: ' + worm.warmth.toFixed(0));
    resetModifiers();
  });

  test('Stormcore: Arc Bolt impacts call down a real bolt', () => {
    resetModifiers();
    function arcElec() {
      clearSim();
      for (let x = 0; x < SIM_W; x++)
        for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
      seedSim(78);
      SPELLS.arc.impact(150, SIM_H - 8, 0);
      return count(E.ELEC);
    }
    const base = arcElec();
    MODIFIERS.find(m => m.name === 'Stormcore').apply();
    const storm = arcElec();
    assert(base > 0, 'baseline arc produced nothing');
    assert(storm > base + 8, 'no lightning column: ' + base + ' -> ' + storm);
    resetModifiers();
  });

  test('Executioner stretches vulnerability windows by half', () => {
    resetModifiers();
    const c = { x: 100, y: 100, w: 6, h: 4, exposedT: 0 };
    quenchBoss(c, 100);
    assert(c.exposedT === 100, 'baseline window wrong: ' + c.exposedT);
    mod('Executioner').apply();
    c.exposedT = 0;
    quenchBoss(c, 100);
    assert(c.exposedT === 150, 'Executioner window wrong: ' + c.exposedT);
    resetModifiers();
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

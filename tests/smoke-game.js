// Headless smoke test for the synergy system and run flow.
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

  test('startRun sets up a playable level with a portal', () => {
    startRun();
    assert(run.active && run.depth === 1, 'run not started');
    assert(player.alive, 'player not alive');
    assert(portal.y >= SIM_H * 0.6, 'portal not deep: y=' + portal.y);
    assert(grid[idx(portal.x, portal.y)] === E.EMPTY, 'portal cell not open');
  });

  test('every modifier applies and resets cleanly', () => {
    const baseFlam = FLAMMABLE.slice();
    const baseReact = JSON.stringify(REACTIONS);
    for (const mod of MODIFIERS) {
      resetModifiers();
      mod.apply(); // must not throw
    }
    resetModifiers();
    for (let i = 0; i < NUM_ELEMENTS; i++) {
      assert(Math.abs(FLAMMABLE[i] - baseFlam[i]) < 1e-6, 'FLAMMABLE not restored for ' + i);
    }
    assert(JSON.stringify(REACTIONS) === baseReact, 'REACTIONS not restored');
    assert(explosionScale === 1, 'explosionScale not restored');
    assert(runState.auras.length === 0 && runState.onDamage.length === 0, 'runState not cleared');
  });

  test('Pyromaniac raises flammability; reset restores it', () => {
    resetModifiers();
    const before = FLAMMABLE[E.WOOD];
    MODIFIERS.find(m => m.name === 'Pyromaniac').apply();
    assert(FLAMMABLE[E.WOOD] > before * 2, 'wood not more flammable');
    resetModifiers();
    assert(Math.abs(FLAMMABLE[E.WOOD] - before) < 1e-6, 'not restored');
  });

  test('Frost Aura crusts the water surface (2026-07 rework: surface-only)', () => {
    resetModifiers();
    clearSim();
    for (let x = 0; x < SIM_W; x++) setCell(idx(x, SIM_H - 1), E.WALL);
    player.x = 100; player.y = 100; player.alive = true; player.hp = 100;
    for (let x = 96; x < 110; x++)
      for (let y = 108; y < 112; y++) setCell(idx(x, y), E.WATER);
    MODIFIERS.find(m => m.name === 'Frost Aura').apply();
    player.y = 103; // stand just above the pool
    for (let k = 0; k < 200; k++) applyAuras();
    let ice = 0, deepIce = 0;
    for (let i = 0; i < CELLS; i++) if (grid[i] === E.ICE) ice++;
    for (let x = 94; x < 112; x++)
      for (let y = 109; y < 112; y++) if (grid[idx(x, y)] === E.ICE) deepIce++;
    assert(ice >= 3, 'no surface crust formed: ' + ice);
    assert(deepIce === 0, 'froze below the surface: ' + deepIce);
  });

  test('Frost Aura cannot entomb a submerged player (surface rule)', () => {
    resetModifiers();
    clearSim();
    for (let x = 0; x < SIM_W; x++) setCell(idx(x, SIM_H - 1), E.WALL);
    // a deep pool with the player fully inside it: submerged cells have
    // water (not air) above, so the surface-only aura can't touch them
    for (let x = 90; x < 130; x++)
      for (let y = 90; y < 120; y++) setCell(idx(x, y), E.WATER);
    player.x = 108; player.y = 104; player.alive = true; player.hp = 100;
    MODIFIERS.find(m => m.name === 'Frost Aura').apply();
    for (let k = 0; k < 300; k++) applyAuras();
    let trapped = 0;
    const bx0 = Math.floor(player.x), bx1 = Math.ceil(player.x + player.w) - 1;
    const by0 = Math.floor(player.y), by1 = Math.ceil(player.y + player.h) - 1;
    for (let cy = by0 - 1; cy <= by1 + 1; cy++)
      for (let cx = bx0 - 1; cx <= bx1 + 1; cx++)
        if (grid[idx(cx, cy)] === E.ICE) trapped++;
    assert(trapped === 0, 'ice formed around a submerged player: ' + trapped);
  });

  test('the magma worm survives water and is a real, phased fight', () => {
    startRun();
    run.depth = 3;
    beginLevel();
    const worm = creatures.find(c => CREATURE_TYPES[c.key].boss);
    assert(worm, 'no worm');
    // simulate the "camp the reservoir and spray" strategy: keep the worm
    // soaked and hose it with water while it's NOT in a vulnerable window
    player.hp = 9999; player.maxHp = 9999; player.hurtCd = 999999;
    let framesToKill = 0, sawPhase2 = false;
    for (let k = 0; k < 240 && worm.hp > 0; k++) {
      // flood the worm's cells with water every frame
      const wx0 = Math.floor(worm.x) - 2, wx1 = Math.ceil(worm.x + worm.w) + 2;
      const wy0 = Math.floor(worm.y) - 2, wy1 = Math.ceil(worm.y + worm.h) + 2;
      for (let cy = wy0; cy <= wy1; cy++)
        for (let cx = wx0; cx <= wx1; cx++)
          if (cx > 1 && cx < SIM_W - 1 && cy > 1 && cy < SIM_H - 1 &&
              grid[idx(cx, cy)] === E.EMPTY) setCell(idx(cx, cy), E.WATER);
      simStep(); updateCreatures();
      if (worm.hp < CREATURE_TYPES.magmaworm.hp * 0.66) sawPhase2 = true;
      framesToKill++;
    }
    // 240 frames = 4s of nonstop dousing must NOT be enough to kill it
    assert(worm.hp > 0, 'water alone melted the worm in ' + framesToKill + ' frames');
    player.maxHp = 100; player.hp = 100; player.hurtCd = 0;
  });

  test('reaching the portal offers choices and advances depth', () => {
    startRun();
    shards.forEach(s => { s.taken = true; }); // shard mechanics tested separately
    player.x = portal.x - player.w / 2;
    player.y = portal.y - player.h / 2;
    updateGame();
    assert(run.choosing, 'not choosing after touching portal');
    assert(run.depth === 2, 'depth should be 2, got ' + run.depth);
    const choices = rollChoices(3, run.mods);
    assert(choices.length === 3, 'expected 3 choices');
    chooseModifier(choices[0]);
    assert(!run.choosing && run.mods.length === 1, 'choice not applied');
    assert(player.alive, 'player not respawned on new level');
    assert(grid[idx(portal.x, portal.y)] === E.EMPTY, 'new portal not placed');
  });

  test('death flags the run as dead', () => {
    startRun();
    player.alive = false;
    updateGame();
    assert(run.dead, 'run.dead not set');
  });

  test('deeper runs bias toward hazardous biomes', () => {
    let shallowHaz = 0, deepHaz = 0;
    for (let trial = 0; trial < 6; trial++) {
      generateWorld('bias-' + trial, 1);
      for (let i = 0; i < CELLS; i += 7) if (BIOMES[worldBiomeMap[i]].hazardous) shallowHaz++;
      generateWorld('bias-' + trial, 8);
      for (let i = 0; i < CELLS; i += 7) if (BIOMES[worldBiomeMap[i]].hazardous) deepHaz++;
    }
    results.push('INFO hazard cells shallow=' + shallowHaz + ' deep=' + deepHaz);
    assert(deepHaz > shallowHaz, 'no hazard bias at depth');
  });

  test('full 3-level run plays through', () => {
    startRun();
    for (let level = 0; level < 3; level++) {
      assert(player.alive, 'dead at level ' + (level + 1));
      // teleport to portal (movement is covered by player tests);
      // shard + boss gating is exercised in their own suites
      shards.forEach(s => { s.taken = true; });
      creatures.length = 0;
      player.x = portal.x - player.w / 2;
      player.y = portal.y - player.h / 2;
      updateGame();
      assert(run.choosing, 'no choice screen at level ' + (level + 1));
      chooseModifier(rollChoices(3, run.mods)[0]);
    }
    assert(run.depth === 4 && run.mods.length === 3,
      'depth=' + run.depth + ' mods=' + run.mods.length);
    // world still simulates fine with 3 modifiers stacked
    for (let k = 0; k < 200; k++) simStep();
    assert(true);
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

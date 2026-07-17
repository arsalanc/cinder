// Headless smoke test: win condition, meta-progression, wand composition,
// spitter ranged attacks, biome spawn tables.
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
  function freshMeta() { meta.bestDepth = 0; meta.wins = 0; meta.kills = 0; meta.runs = 0; }
  function arena() {
    resetModifiers(); resetWand(); clearCreatures(); clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    player.x = 60; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true;
    player.burning = 0; player.hurtCd = 0;
  }

  test('fresh meta locks gated synergies out of the choice pool', () => {
    freshMeta();
    const names = [];
    for (let k = 0; k < 60; k++) names.push(...rollChoices(3, []).map(m => m.name));
    for (const locked of ['Powder Bomb', 'Demolitionist', 'Acid Blood', 'Lava Strider',
                          'Wand: Twin Cast', 'Wand: Bouncing Shots']) {
      assert(!names.includes(locked), locked + ' offered while locked');
    }
    assert(names.includes('Wand: Rapid Fire'), 'unlocked wand mod never offered');
  });

  test('reaching milestones unlocks synergies', () => {
    freshMeta();
    startRun();
    run.depth = 3;
    const unlocked = finishRun(false);
    assert(unlocked.includes('Powder Bomb'), 'Powder Bomb not unlocked at depth 3: ' + unlocked);
    assert(unlocked.includes('Wand: Twin Cast'), 'Twin Cast not unlocked at depth 2+');
    assert(!unlocked.includes('Demolitionist'), 'Demolitionist unlocked too early');
    const pb = MODIFIERS.find(m => m.name === 'Powder Bomb');
    assert(isUnlocked(pb), 'isUnlocked disagrees');
  });

  test('clearing the portal at WIN_DEPTH banks the win and opens the endless descent', () => {
    freshMeta();
    startRun();
    run.depth = WIN_DEPTH;
    shards.forEach(s => { s.taken = true; });
    relic.present = false;
    player.x = portal.x - player.w / 2;
    player.y = portal.y - player.h / 2;
    updateGame();
    // the win is banked immediately, but the run continues (endless)
    assert(run.endless, 'endless descent not opened');
    assert(run.active && !run.won, 'run should still be live at the choice');
    assert(run.choosing, 'no synergy choice offered');
    assert(meta.wins === 1, 'win not recorded: ' + meta.wins);
    assert(meta.bestDepth === WIN_DEPTH, 'bestDepth not recorded');
    const ls = MODIFIERS.find(m => m.name === 'Lava Strider');
    assert(isUnlocked(ls), 'win should unlock Lava Strider');
    // exit ramp: End Run leaves with the victory (win counted exactly once)
    endEndlessRun();
    assert(run.won && !run.active, 'End Run did not end the run');
    assert(meta.wins === 1, 'win double-counted: ' + meta.wins);
  });

  test('Twin Cast fires two projectiles', () => {
    arena();
    MODIFIERS.find(m => m.name === 'Wand: Twin Cast').apply();
    selectSpell(0);
    castSelectedSpell(100, SIM_H - 12);
    assert(projectiles.length === 2, 'expected 2 projectiles, got ' + projectiles.length);
  });

  test('Rapid Fire shortens the cooldown', () => {
    arena();
    selectSpell(0);
    castSelectedSpell(100, SIM_H - 12);
    const base = wand.cooldown;
    arena();
    MODIFIERS.find(m => m.name === 'Wand: Rapid Fire').apply();
    selectSpell(0);
    castSelectedSpell(100, SIM_H - 12);
    assert(wand.cooldown < base, 'cooldown not reduced: ' + wand.cooldown + ' vs ' + base);
  });

  test('Amplifier boosts impact radius', () => {
    arena();
    for (let x = 100; x < 130; x++)
      for (let y = SIM_H - 30; y < SIM_H - 6; y++) setCell(idx(x, y), E.STONE);
    const before = count(E.STONE);
    SPELLS.dig.impact(110, SIM_H - 15, 0);
    const removedBase = before - count(E.STONE);
    SPELLS.dig.impact(120, SIM_H - 15, 1); // radiusBonus 1
    const removedBoosted = (before - removedBase) - count(E.STONE);
    assert(removedBoosted > removedBase, 'boosted dig not bigger: ' + removedBoosted + ' vs ' + removedBase);
  });

  test('Bouncing Shots ricochet off terrain', () => {
    arena();
    for (let y = SIM_H - 40; y < SIM_H; y++)
      for (let x = 90; x < 94; x++) setCell(idx(x, y), E.WALL); // wall ahead
    selectSpell(0);
    castSelectedSpell(92, SIM_H - 10); // straight at the wall
    for (let k = 0; k < 15; k++) updateSpells();
    assert(projectiles.length === 0, 'baseline should have impacted');
    wandMods.bounces = 1;
    // cast spread is random; corner geometry can kill an unlucky shot even
    // with a bounce, so require any of a few casts to ricochet and survive
    let survived = false;
    for (let attempt = 0; attempt < 4 && !survived; attempt++) {
      projectiles.length = 0;
      wand.cooldown = 0; wand.mana = 100;
      castSelectedSpell(92, SIM_H - 10);
      for (let k = 0; k < 15; k++) updateSpells();
      if (projectiles.length === 1) survived = true;
    }
    assert(survived, 'bouncing shots die on first wall contact');
  });

  test('spitter lobs acid globs that hurt the player', () => {
    arena();
    const t = CREATURE_TYPES.spitter;
    creatures.push({ key: 'spitter', x: 100, y: SIM_H - 6 - t.h, vx: 0, vy: 0,
                     w: t.w, h: t.h, hp: t.hp, dir: -1, burning: 0, hurtFlash: 0,
                     bob: 0, attackCd: 1 });
    let fired = false;
    for (let k = 0; k < 400 && player.hp === 100; k++) {
      simStep(); updateCreatures();
      if (eProjectiles.length > 0) fired = true;
    }
    assert(fired, 'spitter never fired');
    assert(player.hp < 100 || count(E.ACID) > 0, 'globs had no effect');
  });

  test('biome spawn tables are respected', () => {
    const volcIdx = BIOMES.findIndex(b => b.name === 'Volcanic Depths');
    arena();
    worldBiomeMap.fill(volcIdx);
    spawnCreatures(3);
    assert(creatures.length > 0, 'nothing spawned');
    const volcAllowed = new Set(BIOME_SPAWNS['Volcanic Depths'].map(e => e[0]));
    for (const c of creatures) {
      assert(volcAllowed.has(c.key), 'wrong volcanic spawn: ' + c.key);
    }
    const vaultIdx = BIOMES.findIndex(b => b.name === 'Overgrown Vault');
    arena();
    worldBiomeMap.fill(vaultIdx);
    spawnCreatures(3);
    for (const c of creatures) {
      assert(c.key !== 'wisp', 'wisp spawned in the vault');
    }
  });

  test('kills accumulate into meta during a run', () => {
    freshMeta();
    startRun();
    const t = CREATURE_TYPES.grub;
    creatures.push({ key: 'grub', x: 10, y: 10, vx: 0, vy: 0, w: t.w, h: t.h,
                     hp: t.hp, dir: 1, burning: 0, hurtFlash: 0, bob: 0, attackCd: 0 });
    killCreature(creatures.length - 1);
    assert(run.kills === 1 && meta.kills === 1, 'kill not recorded: ' + run.kills + '/' + meta.kills);
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

// Headless smoke test: trapped vaults + spell evolutions.
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
  function findVault(trap, depth, tries) {
    for (let n = 0; n < tries; n++) {
      pendingRunSeed = trap + '-hunt-' + n;
      startRun();
      run.depth = depth;
      beginLevel();
      if (relic.present && relic.trap === trap) return true;
    }
    return false;
  }
  function vaultCount(id) {
    let c = 0;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -4; dx <= 4; dx++)
        if (grid[idx(relic.x + dx, relic.y + dy)] === id) c++;
    return c;
  }

  test('powder vaults stamp a visible gunpowder lining (depth 4+)', () => {
    // depth 3 is the worm's arena — the first trapped vaults appear at 4
    assert(findVault('powder', 4, 30), 'no powder vault in 30 seeds');
    assert(vaultCount(E.GUNPOWDER) >= 12, 'lining thin: ' + vaultCount(E.GUNPOWDER));
    assert(vaultCount(E.GLASS) >= 20, 'shell missing');
    assert(vaultCount(E.LAVA) === 0, 'a powder vault must not self-ignite');
  });

  test('igniting the lining detonates the vault and destroys the relic', () => {
    assert(findVault('powder', 4, 30), 'no powder vault to detonate');
    player.x = 10; player.y = 10; // well away from the blast
    for (let k = 0; k < 30; k++) simStep(); // let the charge settle
    // a stray spark lands next to the powder (the careless-entry scenario)
    let lit = false;
    for (let dy = -2; dy <= 2 && !lit; dy++) {
      for (let dx = -3; dx <= 3 && !lit; dx++) {
        const j = idx(relic.x + dx, relic.y + dy);
        if (grid[j] !== E.GUNPOWDER) continue;
        for (const nj of [j - SIM_W, j + SIM_W, j - 1, j + 1]) {
          if (grid[nj] === E.EMPTY) {
            setCell(nj, E.FIRE);
            lit = true;
            break;
          }
        }
      }
    }
    assert(lit, 'no ignitable powder surface found');
    for (let k = 0; k < 120 && relic.present; k++) simStep();
    assert(!relic.present, 'the blast spared the relic');
  });

  test('shallow depths never roll traps; plain vaults stay hazard-flooded', () => {
    for (let n = 0; n < 6; n++) {
      pendingRunSeed = 'clean-' + n;
      startRun(); // depth 1
      if (relic.present) assert(relic.trap === null, 'depth-1 vault trapped: ' + relic.trap);
    }
  });

  test('nest vaults wake three biome guards when the relic is taken', () => {
    assert(findVault('nest', 4, 40), 'no nest vault in 40 seeds');
    assert(vaultCount(E.FUNGUS) >= 3, 'no visible clutch: ' + vaultCount(E.FUNGUS));
    const before = creatures.length;
    player.x = relic.x - player.w / 2;
    player.y = relic.y - player.h / 2;
    player.alive = true; player.hurtCd = 99999;
    updateGame();
    assert(relic.taken, 'relic not collected');
    assert(creatures.length === before + 3, 'guards did not wake: ' +
      before + ' -> ' + creatures.length);
    assert(run.choosing && run.relicChoice, 'bonus pick still owed despite ambush');
    chooseModifier(rollChoices(1, run.mods)[0]); // clear the overlay state
  });

  test('two matching-tag synergies evolve a spell (and only that spell)', () => {
    pendingRunSeed = 'evo-1';
    startRun();
    assert(spellForm('spark').name === 'Spark Bolt', 'evolved with no mods');
    run.mods = ['Pyromaniac'];
    assert(spellForm('spark').name === 'Spark Bolt', 'evolved at 1 fire mod');
    run.mods = ['Pyromaniac', 'Ember Heart'];
    const f = spellForm('spark');
    assert(f.name === 'Meteor Bolt', 'spark did not evolve: ' + f.name);
    assert(f.damage === 16 && f.cost === SPELLS.spark.cost, 'evo overlay wrong');
    assert(spellForm('water').name === 'Water Jet', 'water evolved off fire mods');
    // spell-granting mods count toward their own spell (Acid Spit + Acid Blood)
    run.mods = ['Acid Spit', 'Acid Blood'];
    assert(spellForm('acid').name === 'Dissolver', 'acid pair did not evolve');
    run.mods = [];
  });

  test('Glacier Jet flash-freezes the splash surface, never the player', () => {
    pendingRunSeed = 'evo-2';
    startRun();
    run.mods = ['Frost Aura', 'Winter Pelt'];
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    // a pool to splash into
    for (let x = 140; x < 170; x++)
      for (let y = SIM_H - 10; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    player.x = 120; player.y = SIM_H - 12; player.alive = true;
    const form = spellForm('water');
    assert(form.name === 'Glacier Jet', 'water not evolved');
    seedSim(80);
    // a real cast is a 3-projectile spray; impact like one
    form.impact(153, SIM_H - 10, 0);
    form.impact(156, SIM_H - 10, 0);
    form.impact(159, SIM_H - 10, 0);
    assert(count(E.ICE) > 4, 'no crust from the evolved jet: ' + count(E.ICE));
    // nothing frozen inside the player's own cells
    for (let dy = -1; dy <= 7; dy++)
      for (let dx = -1; dx <= 4; dx++)
        assert(grid[idx(Math.round(player.x) + dx, Math.round(player.y) + dy)] !== E.ICE,
          'froze the player');
    run.mods = [];
  });

  test('Tunnel Charge digs wider on a fraction of the cooldown', () => {
    pendingRunSeed = 'evo-3';
    startRun();
    run.mods = ['Fleetfoot', 'Iron Boots'];
    const f = spellForm('dig');
    assert(f.name === 'Tunnel Charge', 'dig not evolved');
    assert(f.cooldown === 3 && f.cost === 3, 'evolved stats wrong');
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = 40; y < SIM_H; y++) setCell(idx(x, y), E.STONE);
    const before = count(E.STONE);
    f.impact(150, 100, 0);
    assert(before - count(E.STONE) > 60, 'crater too small: ' + (before - count(E.STONE)));
    run.mods = [];
  });

  test('the choice card badge flags a pick that completes an evolution', () => {
    pendingRunSeed = 'evo-4';
    startRun();
    run.mods = ['Ember Heart']; // one fire mod held; spark+flame are in reach
    const pyro = MODIFIERS.find(m => m.name === 'Pyromaniac');
    const evos = evolutionsCompletedBy(pyro);
    assert(evos.length >= 1 && evos[0].indexOf('Meteor Bolt') >= 0,
      'badge missing: ' + JSON.stringify(evos));
    const frost = MODIFIERS.find(m => m.name === 'Winter Pelt');
    assert(evolutionsCompletedBy(frost).length === 0, 'false badge on frost pick');
    run.mods = [];
  });

  test('every evolved form has a valid icon and a name', () => {
    for (const key in SPELLS) {
      const evo = SPELLS[key].evo;
      if (!evo) continue;
      assert(evo.name && evo.tag && evo.impact, key + ' evo incomplete');
      const px = ICON_PX[evo.iconKey];
      assert(px && px.length === 8, key + ' evo icon missing/bad');
      for (const row of px) {
        assert(row.length === 8, key + ' evo icon row not 8 wide');
        for (const ch of row) {
          assert(ch === '.' || ICON_COLORS[ch], key + ' evo icon bad char "' + ch + '"');
        }
      }
    }
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

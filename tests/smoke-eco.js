// Headless smoke test: ecosystem cycles (seeds, ash, bugs, water cycle).
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
  function box() { // sealed terrarium walls
    clearSim();
    for (let x = 0; x < SIM_W; x++) { setCell(idx(x, 0), E.WALL); setCell(idx(x, SIM_H - 1), E.WALL); }
    for (let y = 0; y < SIM_H; y++) { setCell(idx(0, y), E.WALL); setCell(idx(SIM_W - 1, y), E.WALL); }
  }
  function run(n) { for (let k = 0; k < n; k++) simStep(); }

  test('seeds germinate on water into plants', () => {
    box();
    seedSim(11);
    for (let x = 100; x < 140; x++)
      for (let y = SIM_H - 10; y < SIM_H - 1; y++) setCell(idx(x, y), E.WATER);
    for (let x = 110; x < 130; x += 2) setCell(idx(x, SIM_H - 40), E.SEED);
    run(800);
    assert(count(E.PLANT) > 3, 'no germination: ' + count(E.PLANT));
  });

  test('lonely seeds rot to ash instead of piling up forever', () => {
    box();
    seedSim(12);
    for (let x = 50; x < 120; x += 2) setCell(idx(x, SIM_H - 3), E.SEED); // bone dry
    run(6000);
    assert(count(E.SEED) < 10, 'seeds immortal: ' + count(E.SEED));
  });

  test('ash + water fertilizes new plants', () => {
    box();
    seedSim(13);
    for (let x = 100; x < 130; x++) setCell(idx(x, SIM_H - 2), E.ASH);
    for (let x = 100; x < 130; x++)
      for (let y = SIM_H - 8; y < SIM_H - 2; y++) setCell(idx(x, y), E.WATER);
    run(2500);
    assert(count(E.PLANT) > 5, 'ash never fertilized: ' + count(E.PLANT));
  });

  test('bugs graze plants and starve back into ash', () => {
    box();
    seedSim(14);
    for (let x = 80; x < 160; x++)
      for (let y = SIM_H - 12; y < SIM_H - 1; y++) setCell(idx(x, y), E.PLANT);
    const plantsBefore = count(E.PLANT);
    for (let x = 90; x < 150; x += 10) setCell(idx(x, SIM_H - 14), E.BUG);
    run(1500);
    assert(count(E.PLANT) < plantsBefore, 'nothing grazed');
    // now starve them: remove all plants
    for (let i = 0; i < CELLS; i++) if (grid[i] === E.PLANT) setCell(i, E.EMPTY);
    run(1200);
    assert(count(E.BUG) === 0, 'bugs immortal without food: ' + count(E.BUG));
    assert(count(E.ASH) > 0, 'starved bugs left no nutrients');
  });

  test('bug population self-limits (no grey goo)', () => {
    box();
    seedSim(15);
    // a paradise: giant plant mass
    for (let x = 20; x < 300; x++)
      for (let y = SIM_H - 25; y < SIM_H - 1; y++) setCell(idx(x, y), E.PLANT);
    for (let x = 40; x < 280; x += 20) setCell(idx(x, SIM_H - 27), E.BUG);
    let peak = 0;
    for (let k = 0; k < 4000; k++) {
      simStep();
      if (k % 100 === 0) peak = Math.max(peak, count(E.BUG));
    }
    peak = Math.max(peak, count(E.BUG));
    results.push('INFO bug peak ' + peak);
    assert(peak < 1500, 'grey goo: ' + peak + ' bugs');
    assert(count(E.PLANT) > 200, 'bugs sterilized the world: ' + count(E.PLANT) + ' plants left');
  });

  test('burned forest regrows (fire -> ash+steam -> rain -> plants)', () => {
    box();
    seedSim(16);
    // stone floor, forest on it, pond beside it
    for (let x = 1; x < SIM_W - 1; x++)
      for (let y = SIM_H - 6; y < SIM_H - 1; y++) setCell(idx(x, y), E.STONE);
    for (let x = 60; x < 180; x++)
      for (let y = SIM_H - 26; y < SIM_H - 6; y++) setCell(idx(x, y), E.PLANT);
    for (let x = 200; x < 260; x++)
      for (let y = SIM_H - 14; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    // torch it
    for (let x = 60; x < 180; x += 8) setCell(idx(x, SIM_H - 27), E.FIRE);
    run(1500);
    const afterBurn = count(E.PLANT);
    results.push('INFO plants after burn: ' + afterBurn + ', ash: ' + count(E.ASH));
    run(6000);
    const regrown = count(E.PLANT);
    results.push('INFO plants after regrowth window: ' + regrown);
    assert(regrown > 30, 'no regrowth: ' + regrown);
    assert(count(E.FIRE) === 0, 'eternal flame');
  });

  test('sealed terrarium stays alive for 8000 steps', () => {
    box();
    seedSim(17);
    // shelves, pond, meadow, seeds, grazers
    for (let x = 40; x < 280; x++) setCell(idx(x, 150), E.STONE), setCell(idx(x, 151), E.STONE);
    for (let x = 80; x < 240; x++)
      for (let y = SIM_H - 12; y < SIM_H - 1; y++) setCell(idx(x, y), E.WATER);
    for (let x = 60; x < 260; x++)
      for (let y = 142; y < 150; y++) setCell(idx(x, y), E.PLANT);
    for (let x = 70; x < 250; x += 30) setCell(idx(x, 140), E.BUG);
    for (let x = 65; x < 255; x += 15) setCell(idx(x, 135), E.SEED);
    const interior = (SIM_W - 2) * (SIM_H - 2);
    let minPlants = Infinity, maxPlants = 0;
    for (let k = 0; k < 8000; k++) {
      simStep();
      if (k % 250 === 0) {
        const p = count(E.PLANT);
        minPlants = Math.min(minPlants, p);
        maxPlants = Math.max(maxPlants, p);
      }
    }
    const plants = count(E.PLANT);
    results.push('INFO terrarium end: plants=' + plants + ' bugs=' + count(E.BUG) +
      ' water=' + (count(E.WATER) + count(E.EWATER)) + ' ash=' + count(E.ASH) +
      ' seeds=' + count(E.SEED) + ' (plants ranged ' + minPlants + '-' + maxPlants + ')');
    assert(plants > 50, 'ecosystem collapsed: ' + plants + ' plants');
    assert(plants < interior * 0.6, 'plant grey goo: ' + plants);
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

// Headless smoke test: fungus/fish/moth fauna and worldgen set-pieces.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'js');
const ctx = vm.createContext({ Math, console, Date });
for (const f of ['elements.js', 'sim.js', 'worldgen.js']) {
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
  function run(n) { for (let k = 0; k < n; k++) simStep(); }
  function openFloor() {
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
  }
  // stone basin filled with water and kelp columns
  function aquarium() {
    openFloor();
    for (let y = SIM_H - 26; y < SIM_H - 6; y++) {
      for (let t = 0; t < 3; t++) { setCell(idx(80 + t, y), E.WALL); setCell(idx(237 - t, y), E.WALL); }
    }
    for (let x = 83; x < 235; x++)
      for (let y = SIM_H - 22; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    for (let x = 88; x < 230; x += 9)
      for (let v = 0; v < 5; v++) setCell(idx(x, SIM_H - 7 - v), E.PLANT);
  }

  test('fish swim, graze kelp, and the school persists', () => {
    aquarium(); seedSim(41);
    for (let x = 100; x < 220; x += 15) setCell(idx(x, SIM_H - 14), E.FISH);
    const before = count(E.FISH);
    run(3000);
    assert(count(E.FISH) > 0, 'school died out');
    // every live fish must still be in contact with water
    for (let i = 0; i < CELLS; i++) {
      if (grid[i] !== E.FISH) continue;
      const ok = grid[i - SIM_W] === E.WATER || grid[i + SIM_W] === E.WATER ||
                 grid[i - 1] === E.WATER || grid[i + 1] === E.WATER;
      assert(ok, 'fish out of water at ' + (i % SIM_W) + ',' + ((i / SIM_W) | 0));
    }
    results.push('INFO fish ' + before + ' -> ' + count(E.FISH));
  });

  test('well-fed fish breed', () => {
    aquarium(); seedSim(42);
    for (let x = 110; x < 200; x += 30) setCell(idx(x, SIM_H - 14), E.FISH);
    const before = count(E.FISH);
    let peak = before;
    for (let k = 0; k < 4000; k++) { simStep(); peak = Math.max(peak, count(E.FISH)); }
    assert(peak > before, 'no fish were born: peak ' + peak + ' from ' + before);
  });

  test('a beached fish suffocates to ash', () => {
    openFloor(); seedSim(43);
    setCell(idx(160, SIM_H - 7), E.FISH);
    run(120);
    assert(count(E.FISH) === 0, 'fish fine on dry land');
    assert(count(E.ASH) > 0, 'no remains');
  });

  test('electrified water kills fish', () => {
    aquarium(); seedSim(44);
    for (let x = 100; x < 220; x += 12) setCell(idx(x, SIM_H - 14), E.FISH);
    const before = count(E.FISH);
    // charge the whole pool hard (kelp thickets can insulate a pocket or
    // two — the school must collapse, not necessarily to zero)
    for (let x = 83; x < 235; x += 2) {
      const j = idx(x, SIM_H - 20);
      if (grid[j] === E.WATER) { setCell(j, E.EWATER); life[j] = 70; }
    }
    run(300);
    assert(count(E.FISH) < before * 0.5,
      'shock barely thinned the school: ' + count(E.FISH) + '/' + before);
  });

  test('moths sip nectar without destroying the meadow', () => {
    openFloor(); seedSim(45);
    for (let x = 80; x < 240; x++)
      for (let y = SIM_H - 10; y < SIM_H - 6; y++) setCell(idx(x, y), E.PLANT);
    const plants = count(E.PLANT);
    for (let x = 100; x < 220; x += 20) setCell(idx(x, SIM_H - 11), E.MOTH);
    run(2500);
    assert(count(E.MOTH) > 0, 'moths died out beside food');
    assert(count(E.PLANT) >= plants * 0.95, 'moths ate the meadow: ' + count(E.PLANT) + '/' + plants);
  });

  test('moths pollinate: seeds scatter from the meadow', () => {
    openFloor(); seedSim(46);
    for (let x = 80; x < 240; x++)
      for (let y = SIM_H - 10; y < SIM_H - 6; y++) setCell(idx(x, y), E.PLANT);
    for (let x = 95; x < 225; x += 12) setCell(idx(x, SIM_H - 11), E.MOTH);
    let seeds = 0;
    for (let k = 0; k < 2500; k++) { simStep(); seeds = Math.max(seeds, count(E.SEED)); }
    assert(seeds > 2, 'no pollination happened: peak seeds ' + seeds);
  });

  test('moths starve away from food', () => {
    openFloor(); seedSim(47);
    setCell(idx(160, 100), E.MOTH);
    run(1200);
    assert(count(E.MOTH) === 0, 'immortal moth');
  });

  test('fungus decomposes dead wood; grazers browse the fungus', () => {
    openFloor(); seedSim(48);
    for (let x = 120; x < 160; x++)
      for (let y = SIM_H - 9; y < SIM_H - 6; y++) setCell(idx(x, y), E.WOOD);
    setCell(idx(140, SIM_H - 10), E.FUNGUS);
    const woodBefore = count(E.WOOD);
    run(4000);
    assert(count(E.WOOD) < woodBefore, 'fungus never spread over the wood');
    const fungusGrown = count(E.FUNGUS);
    assert(fungusGrown > 3, 'no fungal mat: ' + fungusGrown);
    // grazers eat it back
    for (let x = 125; x < 155; x += 6) setCell(idx(x, SIM_H - 12), E.BUG);
    run(1500);
    assert(count(E.FUNGUS) < fungusGrown, 'bugs never grazed the fungus');
  });

  test('worldgen set-pieces: groves, kelp, fish, moths appear across seeds', () => {
    let fungus = 0, fish = 0, moths = 0;
    for (const s of ['fauna-1', 'fauna-2', 'fauna-3']) {
      generateWorld(s);
      fungus += count(E.FUNGUS); fish += count(E.FISH); moths += count(E.MOTH);
    }
    results.push('INFO across 3 seeds: fungus=' + fungus + ' fish=' + fish + ' moths=' + moths);
    assert(fungus > 10, 'no mushroom groves: ' + fungus);
    assert(fish > 0, 'no fish stocked: ' + fish);
    assert(moths > 0, 'no moths placed: ' + moths);
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

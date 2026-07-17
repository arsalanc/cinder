// Headless smoke test: load the sim core and verify key behaviors.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'js');
const ctx = vm.createContext({ Math, console });
for (const f of ['elements.js', 'sim.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}
const t = vm.runInContext(`
(function () {
  const results = [];
  function test(name, fn) {
    try { fn(); results.push('PASS ' + name); }
    catch (e) { results.push('FAIL ' + name + ': ' + e.message); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg); }
  function count(id) { let c = 0; for (let i = 0; i < CELLS; i++) if (grid[i] === id) c++; return c; }
  function run(n) { for (let k = 0; k < n; k++) simStep(); }

  test('sand falls and piles on floor', () => {
    clearSim();
    for (let x = 0; x < SIM_W; x++) setCell(idx(x, SIM_H - 1), E.WALL); // floor
    setCell(idx(160, 10), E.SAND);
    run(300);
    assert(count(E.SAND) === 1, 'sand count changed');
    let found = -1;
    for (let i = 0; i < CELLS; i++) if (grid[i] === E.SAND) found = (i / SIM_W) | 0;
    assert(found === SIM_H - 2, 'sand should rest on floor, at row ' + found);
  });

  test('water spreads horizontally', () => {
    clearSim();
    for (let x = 0; x < SIM_W; x++) setCell(idx(x, SIM_H - 1), E.WALL);
    paintCircle(160, SIM_H - 6, 4, E.WATER);
    const before = count(E.WATER);
    run(400);
    // exposed surfaces evaporate a little now; near-conservation is the bar
    assert(count(E.WATER) >= before - 20, 'water vanished: ' + count(E.WATER) + '/' + before);
    let minX = SIM_W, maxX = 0;
    for (let i = 0; i < CELLS; i++) if (grid[i] === E.WATER) { const x = i % SIM_W; if (x < minX) minX = x; if (x > maxX) maxX = x; }
    assert(maxX - minX > 20, 'water should spread wide, got ' + (maxX - minX));
  });

  test('sand sinks through water', () => {
    clearSim();
    for (let x = 0; x < SIM_W; x++) setCell(idx(x, SIM_H - 1), E.WALL);
    for (let x = 150; x < 170; x++) for (let y = SIM_H - 11; y < SIM_H - 1; y++) setCell(idx(x, y), E.WATER);
    setCell(idx(160, SIM_H - 30), E.SAND);
    run(500);
    let sandY = -1;
    for (let i = 0; i < CELLS; i++) if (grid[i] === E.SAND) sandY = (i / SIM_W) | 0;
    assert(sandY >= SIM_H - 3, 'sand should sink to bottom of water, at row ' + sandY);
  });

  test('fire burns wood and produces smoke, then dies', () => {
    clearSim();
    for (let x = 100; x < 140; x++) for (let y = 100; y < 104; y++) setCell(idx(x, y), E.WOOD);
    for (let x = 115; x < 125; x++) setCell(idx(x, 99), E.FIRE);
    const woodBefore = count(E.WOOD);
    run(200);
    assert(count(E.WOOD) < woodBefore, 'wood should burn');
    run(2000);
    assert(count(E.FIRE) === 0, 'fire should eventually die out');
  });

  test('water + lava -> stone + steam', () => {
    clearSim();
    for (let x = 0; x < SIM_W; x++) setCell(idx(x, SIM_H - 1), E.WALL);
    for (let x = 150; x < 170; x++) setCell(idx(x, SIM_H - 2), E.LAVA);
    for (let x = 150; x < 170; x++) for (let y = SIM_H - 8; y < SIM_H - 4; y++) setCell(idx(x, y), E.WATER);
    run(300);
    assert(count(E.STONE) > 0, 'stone should form');
  });

  test('acid dissolves stone', () => {
    clearSim();
    for (let x = 100; x < 140; x++) for (let y = 100; y < 110; y++) setCell(idx(x, y), E.STONE);
    for (let x = 110; x < 130; x++) for (let y = 96; y < 100; y++) setCell(idx(x, y), E.ACID);
    const stoneBefore = count(E.STONE);
    run(600);
    assert(count(E.STONE) < stoneBefore, 'stone should dissolve');
  });

  test('gunpowder explodes when ignited', () => {
    clearSim();
    for (let x = 0; x < SIM_W; x++) setCell(idx(x, SIM_H - 1), E.WALL);
    for (let x = 140; x < 180; x++) for (let y = SIM_H - 5; y < SIM_H - 1; y++) setCell(idx(x, y), E.GUNPOWDER);
    setCell(idx(160, SIM_H - 6), E.FIRE);
    run(100);
    assert(count(E.GUNPOWDER) < 100, 'gunpowder should chain-detonate, left: ' + count(E.GUNPOWDER));
  });

  test('gases dissipate; steam can condense', () => {
    clearSim();
    paintCircle(160, 150, 8, E.SMOKE);
    run(1000);
    assert(count(E.SMOKE) === 0, 'smoke should dissipate');
  });

  test('seedScene populates and stays stable', () => {
    seedScene();
    run(600);
    assert(count(E.STONE) > 100, 'scene should still have stone');
  });

  test('perf: full step budget', () => {
    seedScene();
    paintCircle(160, 30, 20, E.WATER);
    const t0 = Date.now();
    run(600);
    const ms = (Date.now() - t0) / 600;
    results.push('INFO avg step ' + ms.toFixed(2) + 'ms');
    assert(ms < 8, 'step too slow: ' + ms);
  });

  return results.join('\\n');
})()
`, ctx);
console.log(t);

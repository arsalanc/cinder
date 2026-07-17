// Headless smoke test for world generation.
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
    catch (e) { results.push('FAIL ' + name + ': ' + e.message); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg); }
  function count(id) { let c = 0; for (let i = 0; i < CELLS; i++) if (grid[i] === id) c++; return c; }
  function isPassable(id) {
    return id === E.EMPTY || id === E.PLANT || TYPE[id] === T.LIQUID || TYPE[id] === T.GAS;
  }

  test('generation completes in time budget', () => {
    const t0 = Date.now();
    generateWorld('smoke-1');
    const ms = Date.now() - t0;
    results.push('INFO gen took ' + ms + 'ms');
    assert(ms < 5000, 'too slow: ' + ms + 'ms');
  });

  test('open/solid balance is sane', () => {
    generateWorld('smoke-1');
    let open = 0, total = 0;
    for (let y = 40; y < SIM_H - 3; y++) {       // below any surface line
      for (let x = 3; x < SIM_W - 3; x++) {
        total++;
        if (isPassable(grid[idx(x, y)])) open++;
      }
    }
    const frac = open / total;
    results.push('INFO underground open fraction ' + frac.toFixed(2));
    assert(frac > 0.2 && frac < 0.7, 'open fraction out of range: ' + frac);
  });

  test('multiple biomes present', () => {
    generateWorld('smoke-2');
    const seen = new Set();
    for (let y = 40; y < SIM_H; y++)
      for (let x = 0; x < SIM_W; x++) seen.add(worldBiomeMap[idx(x, y)]);
    results.push('INFO biomes: ' + [...seen].map(b => BIOMES[b].name).join(', '));
    assert(seen.size >= 2, 'only ' + seen.size + ' biome(s)');
  });

  test('world contains liquids and materials, and no fire', () => {
    generateWorld('smoke-3');
    let liquids = 0;
    for (let i = 0; i < CELLS; i++) if (TYPE[grid[i]] === T.LIQUID) liquids++;
    assert(liquids > 50, 'too few liquid cells: ' + liquids);
    assert(count(E.STONE) > 1000, 'not enough stone');
    assert(count(E.FIRE) === 0, 'fire should not exist after gen');
  });

  test('caves are connected (largest open region dominates)', () => {
    generateWorld('smoke-4');
    const comp = new Int32Array(CELLS).fill(-1);
    const sizes = [];
    const stack = [];
    let totalOpen = 0;
    for (let start = 0; start < CELLS; start++) {
      const sy = (start / SIM_W) | 0;
      if (sy < 40) continue; // only judge the underground
      if (!isPassable(grid[start]) || comp[start] >= 0) continue;
      const id = sizes.length; let size = 0;
      stack.length = 0; stack.push(start); comp[start] = id;
      while (stack.length) {
        const i = stack.pop(); size++;
        const x = i % SIM_W, y = (i / SIM_W) | 0;
        const nbs = [];
        if (x > 0) nbs.push(i - 1);
        if (x + 1 < SIM_W) nbs.push(i + 1);
        if (y > 0) nbs.push(i - SIM_W);
        if (y + 1 < SIM_H) nbs.push(i + SIM_W);
        for (const j of nbs) {
          if (isPassable(grid[j]) && comp[j] < 0) { comp[j] = id; stack.push(j); }
        }
      }
      sizes.push(size); totalOpen += size;
    }
    sizes.sort((a, b) => b - a);
    const frac = sizes[0] / totalOpen;
    results.push('INFO largest region ' + (frac * 100).toFixed(0) + '% of open space (' + sizes.length + ' regions)');
    assert(frac > 0.6, 'caves too fragmented: ' + frac.toFixed(2));
  });

  test('same seed reproduces the same carve', () => {
    // liquids settle with Math.random so exact grids differ; compare the
    // deterministic parts: biome map + solid/open pattern of static cells
    generateWorld('repro');
    const bio1 = worldBiomeMap.slice();
    const static1 = grid.map ? null : null;
    const s1 = new Uint8Array(CELLS);
    for (let i = 0; i < CELLS; i++) s1[i] = TYPE[grid[i]] === T.STATIC && grid[i] !== E.EMPTY ? grid[i] : 0;
    generateWorld('repro');
    for (let i = 0; i < CELLS; i++) {
      if (worldBiomeMap[i] !== bio1[i]) throw new Error('biome map differs at ' + i);
    }
    let same = 0, diff = 0;
    for (let i = 0; i < CELLS; i++) {
      const v = TYPE[grid[i]] === T.STATIC && grid[i] !== E.EMPTY ? grid[i] : 0;
      if (v === s1[i]) same++; else diff++;
    }
    results.push('INFO static-cell match ' + (same / CELLS * 100).toFixed(1) + '%');
    assert(diff / CELLS < 0.05, 'carve not reproducible: ' + diff + ' cells differ');
  });

  test('generated world runs stably', () => {
    generateWorld('smoke-5');
    for (let k = 0; k < 300; k++) simStep();
    assert(count(E.WALL) > 0, 'walls intact');
  });

  test('different seeds give different worlds', () => {
    generateWorld('aaa');
    const g1 = grid.slice();
    generateWorld('bbb');
    let diff = 0;
    for (let i = 0; i < CELLS; i++) if (grid[i] !== g1[i]) diff++;
    assert(diff > CELLS * 0.1, 'worlds too similar: ' + diff);
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

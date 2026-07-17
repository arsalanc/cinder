// Headless smoke test: determinism of the seeded sim.
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
  function gridsEqual(a, b) {
    for (let i = 0; i < CELLS; i++) if (a[i] !== b[i]) return i;
    return -1;
  }

  test('same seed -> byte-identical world including settled liquids', () => {
    generateWorld('det-1', 3);
    const g1 = grid.slice(), s1 = shade.slice(), l1 = life.slice();
    generateWorld('det-1', 3);
    assert(gridsEqual(g1, grid) === -1, 'grid differs at ' + gridsEqual(g1, grid));
    assert(gridsEqual(s1, shade) === -1, 'shade differs');
    assert(gridsEqual(l1, life) === -1, 'life differs');
  });

  test('same seed -> identical evolution over 400 sim steps', () => {
    generateWorld('det-2', 2);
    for (let k = 0; k < 400; k++) simStep();
    const g1 = grid.slice();
    generateWorld('det-2', 2);
    for (let k = 0; k < 400; k++) simStep();
    const d = gridsEqual(g1, grid);
    assert(d === -1, 'evolution diverged at cell ' + d);
  });

  test('same seed -> identical spawn, portal, and creatures', () => {
    generateWorld('det-3', 4);
    spawnPlayer(); placePortal(); spawnCreatures(4);
    const a = { px: player.x, py: player.y, ox: portal.x, oy: portal.y,
                n: creatures.length,
                c: creatures.map(c => c.key + c.x + ',' + c.y).join('|') };
    generateWorld('det-3', 4);
    spawnPlayer(); placePortal(); spawnCreatures(4);
    assert(a.px === player.x && a.py === player.y, 'spawn differs');
    assert(a.ox === portal.x && a.oy === portal.y, 'portal differs');
    assert(a.n === creatures.length, 'creature count differs');
    assert(a.c === creatures.map(c => c.key + c.x + ',' + c.y).join('|'), 'creatures differ');
  });

  test('different seeds still diverge', () => {
    generateWorld('det-a', 2);
    const g1 = grid.slice();
    generateWorld('det-b', 2);
    let diff = 0;
    for (let i = 0; i < CELLS; i++) if (g1[i] !== grid[i]) diff++;
    assert(diff > CELLS * 0.1, 'worlds too similar: ' + diff);
  });

  test('explosions are deterministic too', () => {
    function boom() {
      generateWorld('det-4', 5);
      // ignite a gunpowder vein if present, else plant one
      let spot = -1;
      for (let i = 0; i < CELLS; i++) if (grid[i] === E.GUNPOWDER) { spot = i; break; }
      if (spot < 0) { spot = idx(160, 150); setCell(spot, E.GUNPOWDER); }
      if (spot >= SIM_W) setCell(spot - SIM_W, E.FIRE);
      for (let k = 0; k < 300; k++) simStep();
      return grid.slice();
    }
    const g1 = boom(), g2 = boom();
    const d = gridsEqual(g1, g2);
    assert(d === -1, 'explosion outcomes diverged at ' + d);
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

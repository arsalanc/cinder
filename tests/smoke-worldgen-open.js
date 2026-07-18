// Headless smoke test for the worldgen openness pass: per-seed openness
// variance, per-biome carve bias, and the grand-chamber set-piece.
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
  function isPassable(id) {
    return id === E.EMPTY || id === E.PLANT || TYPE[id] === T.LIQUID || TYPE[id] === T.GAS;
  }
  function undergroundOpenFrac() {
    let open = 0, total = 0;
    for (let y = 40; y < SIM_H - 3; y++)
      for (let x = 3; x < SIM_W - 3; x++) {
        total++;
        if (isPassable(grid[idx(x, y)])) open++;
      }
    return open / total;
  }

  test('openness genuinely varies across seeds', () => {
    let min = 1, max = 0, minO = 1, maxO = -1;
    for (let s = 0; s < 8; s++) {
      generateWorld('open-' + s);
      const f = undergroundOpenFrac();
      min = Math.min(min, f); max = Math.max(max, f);
      minO = Math.min(minO, worldInfo.openness);
      maxO = Math.max(maxO, worldInfo.openness);
    }
    results.push('INFO open fraction ' + min.toFixed(3) + '..' + max.toFixed(3) +
      ', openness roll ' + minO.toFixed(4) + '..' + maxO.toFixed(4));
    assert(maxO > minO, 'openness roll never varied');
    assert(max - min > 0.05, 'seeds too uniform: range ' + (max - min).toFixed(3));
    assert(max < 0.75, 'most open seed is swiss cheese: ' + max.toFixed(3));
    assert(min > 0.2, 'tightest seed is a landfill: ' + min.toFixed(3));
  });

  test('biome bias shows in the rock (volcanic opener than ice)', () => {
    // aggregate over several seeds — any single seed is too noisy
    const volc = BIOMES.findIndex(b => b.name === 'Volcanic Depths');
    const ice = BIOMES.findIndex(b => b.name === 'Ice Caves');
    let vOpen = 0, vTot = 0, iOpen = 0, iTot = 0;
    for (let s = 0; s < 6; s++) {
      generateWorld('bias-' + s);
      for (let y = 44; y < SIM_H - 3; y++) {
        for (let x = 3; x < SIM_W - 3; x++) {
          const i = idx(x, y);
          const b = worldBiomeMap[i];
          if (b === volc) { vTot++; if (isPassable(grid[i])) vOpen++; }
          else if (b === ice) { iTot++; if (isPassable(grid[i])) iOpen++; }
        }
      }
    }
    assert(vTot > 2000 && iTot > 2000, 'not enough biome cells sampled: ' + vTot + '/' + iTot);
    const vf = vOpen / vTot, iff = iOpen / iTot;
    results.push('INFO volcanic open ' + vf.toFixed(3) + ' vs ice ' + iff.toFixed(3));
    assert(vf > iff, 'volcanic (' + vf.toFixed(3) + ') not opener than ice (' + iff.toFixed(3) + ')');
  });

  test('grand chambers appear on a healthy share of seeds', () => {
    let found = 0, total = 12;
    for (let s = 0; s < total; s++) {
      generateWorld('chamber-' + s);
      if (worldInfo.chamber) found++;
    }
    results.push('INFO chambers on ' + found + '/' + total + ' seeds');
    assert(found >= 4, 'chambers too rare: ' + found + '/' + total);
    assert(found < total, 'chambers on every seed — roll is broken');
  });

  test('a grand chamber is carved open and holds its lake', () => {
    let ch = null, seed = '';
    for (let s = 0; s < 12 && !ch; s++) {
      seed = 'chamber-' + s;
      generateWorld(seed);
      ch = worldInfo.chamber;
    }
    assert(ch, 'no chamber found in 12 seeds');
    // the ellipse interior should be mostly passable after settling
    let open = 0, total = 0, liquid = 0;
    for (let dy = -ch.ry; dy <= ch.ry; dy++) {
      for (let dx = -ch.rx; dx <= ch.rx; dx++) {
        const e = (dx * dx) / (ch.rx * ch.rx) + (dy * dy) / (ch.ry * ch.ry);
        if (e > 1) continue;
        const x = ch.x + dx, y = ch.y + dy;
        if (x < 3 || x >= SIM_W - 3 || y < 3 || y >= SIM_H - 3) continue;
        const id = grid[idx(x, y)];
        if (TYPE[id] === T.LIQUID) liquid++;
        if (e > 0.7) continue; // judge openness by the core, lake by the whole
        total++;
        if (isPassable(id)) open++;
      }
    }
    results.push('INFO chamber ' + seed + ' interior ' + (open / total * 100).toFixed(0) +
      '% open, ' + liquid + ' liquid cells');
    assert(open / total > 0.6, 'chamber not open: ' + (open / total).toFixed(2));
    assert(liquid > 20, 'chamber lake missing: ' + liquid + ' liquid cells');
  });

  test('grand chamber joins the main cave system', () => {
    let ch = null;
    for (let s = 0; s < 12 && !ch; s++) {
      generateWorld('chamber-' + s);
      ch = worldInfo.chamber;
    }
    assert(ch, 'no chamber found');
    // flood fill from just above the chamber's center — its component should
    // be far bigger than the chamber itself (i.e. connected to the caves)
    const start = idx(ch.x, ch.y - ((ch.ry / 2) | 0));
    assert(isPassable(grid[start]), 'chamber center not passable');
    const seen = new Uint8Array(CELLS);
    const stack = [start];
    seen[start] = 1;
    let size = 0;
    while (stack.length) {
      const i = stack.pop(); size++;
      const x = i % SIM_W, y = (i / SIM_W) | 0;
      const nbs = [];
      if (x > 0) nbs.push(i - 1);
      if (x + 1 < SIM_W) nbs.push(i + 1);
      if (y > 0) nbs.push(i - SIM_W);
      if (y + 1 < SIM_H) nbs.push(i + SIM_W);
      for (const j of nbs) if (!seen[j] && isPassable(grid[j])) { seen[j] = 1; stack.push(j); }
    }
    const chamberArea = Math.PI * ch.rx * ch.ry;
    results.push('INFO chamber component ' + size + ' cells vs chamber area ~' + (chamberArea | 0));
    assert(size > chamberArea * 2, 'chamber sealed off: component ' + size);
  });

  test('same seed reproduces the same openness and chamber', () => {
    generateWorld('open-repro');
    const o1 = worldInfo.openness;
    const c1 = worldInfo.chamber ? JSON.stringify(worldInfo.chamber) : 'none';
    generateWorld('open-repro');
    assert(worldInfo.openness === o1, 'openness differs on regen');
    const c2 = worldInfo.chamber ? JSON.stringify(worldInfo.chamber) : 'none';
    assert(c1 === c2, 'chamber differs on regen: ' + c1 + ' vs ' + c2);
  });

  test('boss chambers reset worldInfo', () => {
    generateWorld('chamber-0'); // known to roll a chamber... or not; force state
    generateBossChamber('boss-open', 'magmaworm');
    assert(worldInfo.openness === 0, 'boss arena kept a stale openness');
    assert(worldInfo.chamber === null, 'boss arena kept a stale chamber');
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

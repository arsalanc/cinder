// Headless smoke test: temperature field, freeze/melt phase changes, cold snaps.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'js');
const ctx = vm.createContext({ Math, console, Date });
for (const f of ['elements.js', 'sim.js', 'worldgen.js', 'weather.js']) {
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
  function runW(n) { for (let k = 0; k < n; k++) { simStep(); updateWeather(); } }
  function openFloor() {
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
  }
  function setAmbient(t) { ambientTemp.fill(t); temp.fill(t); }

  test('lava heats the air around it well above ambient', () => {
    openFloor(); seedSim(31);
    for (let x = 100; x < 130; x++)
      for (let y = SIM_H - 10; y < SIM_H - 6; y++) setCell(idx(x, y), E.LAVA);
    run(300);
    assert(tempAt(115, SIM_H - 12) > 40,
      'air above lava still cool: ' + tempAt(115, SIM_H - 12).toFixed(1));
    assert(tempAt(20, 20) < 25, 'far corner should stay near ambient: ' + tempAt(20, 20).toFixed(1));
  });

  test('cold regions freeze pools from the surface down', () => {
    openFloor(); seedSim(32);
    setAmbient(-15);
    for (let x = 120; x < 180; x++)
      for (let y = SIM_H - 12; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    const waterBefore = count(E.WATER);
    run(2000);
    assert(count(E.ICE) > 100, 'pool never froze: ' + count(E.ICE) + ' ice');
    assert(count(E.WATER) < waterBefore * 0.6, 'most water should be ice by now');
  });

  test('radiant heat: ice melts near lava without touching it', () => {
    openFloor(); seedSim(33);
    // lava pit, stone lid, ice block sitting above the lid (never in contact)
    for (let x = 100; x < 130; x++) {
      for (let y = SIM_H - 10; y < SIM_H - 6; y++) setCell(idx(x, y), E.LAVA);
      setCell(idx(x, SIM_H - 11), E.WALL);
      setCell(idx(x, SIM_H - 12), E.WALL);
    }
    for (let x = 105; x < 125; x++)
      for (let y = SIM_H - 17; y < SIM_H - 13; y++) setCell(idx(x, y), E.ICE);
    const iceBefore = count(E.ICE);
    run(2500);
    assert(count(E.ICE) < iceBefore * 0.7,
      'ice never felt the heat: ' + count(E.ICE) + '/' + iceBefore);
    assert(count(E.WATER) + count(E.STEAM) > 0, 'melt produced nothing');
  });

  test('snow keeps forever in the cold, melts away in warmth', () => {
    openFloor(); seedSim(34);
    setAmbient(-10);
    for (let x = 100; x < 200; x++)
      for (let y = SIM_H - 9; y < SIM_H - 6; y++) setCell(idx(x, y), E.SNOW);
    const snowBefore = count(E.SNOW);
    run(2000);
    assert(count(E.SNOW) > snowBefore * 0.95, 'snow melted in the cold: ' + count(E.SNOW));
    setAmbient(35);
    run(3000);
    assert(count(E.SNOW) < snowBefore * 0.3, 'snow survived the heat: ' + count(E.SNOW));
  });

  test('lone lava drips skin over into stone in deep cold', () => {
    openFloor(); seedSim(35);
    setAmbient(-40);
    for (let x = 40; x < SIM_W - 40; x += 24) setCell(idx(x, SIM_H - 7), E.LAVA);
    const lavaBefore = count(E.LAVA);
    run(600);
    assert(count(E.STONE) > 2, 'no lava froze: ' + count(E.STONE) + ' stone of ' + lavaBefore);
  });

  test('rain in cold air becomes snow, never ice suspended in the sky', () => {
    openFloor(); seedSim(38);
    setAmbient(-15);
    // droplets scattered through open sky, falling
    for (let x = 30; x < 290; x += 7)
      for (let y = 20; y < 120; y += 25) setCell(idx(x, y), E.WATER);
    run(1500);
    // nothing static may hang mid-air: every ICE cell must be supported
    let floating = 0;
    for (let i = 0; i < CELLS - SIM_W; i++)
      if (grid[i] === E.ICE && grid[i + SIM_W] === E.EMPTY) floating++;
    assert(floating === 0, floating + ' ice cells hanging in the sky');
    // the precipitation itself must have survived as snow/water/ice somewhere
    assert(count(E.SNOW) + count(E.WATER) + count(E.ICE) > 100, 'droplets vanished');
  });

  test('cold snap: snow mode drags temperature below zero, rain turns to snow', () => {
    openFloor(); seedSim(36);
    assert(tempAt(160, 100) > 10, 'should start temperate');
    setWeather('snow', 999999);
    runW(1200);
    assert(tempAt(160, 100) < 0, 'cold snap never bit: ' + tempAt(160, 100).toFixed(1));
    assert(count(E.SNOW) > 20, 'no snowfall during the snap: ' + count(E.SNOW));
    setWeather('clear', 999999);
    run(1200);
    assert(tempAt(160, 100) > 5, 'map never thawed: ' + tempAt(160, 100).toFixed(1));
  });

  test('deep snowpack compacts into glacier ice at the bottom', () => {
    openFloor(); seedSim(37);
    setAmbient(-15);
    // a tall column of snow in a walled shaft so it can't spread out
    for (let y = SIM_H - 12; y < SIM_H; y++) { setCell(idx(150, y), E.WALL); setCell(idx(165, y), E.WALL); }
    for (let x = 151; x < 165; x++)
      for (let y = SIM_H - 40; y < SIM_H - 6; y++) setCell(idx(x, y), E.SNOW);
    run(4000);
    assert(count(E.ICE) > 10, 'snowpack never compacted to ice: ' + count(E.ICE));
    // a shallow dusting must NOT turn to ice (no deep column pressing down)
    openFloor(); seedSim(38);
    setAmbient(-15);
    for (let x = 100; x < 200; x++)
      for (let y = SIM_H - 8; y < SIM_H - 6; y++) setCell(idx(x, y), E.SNOW);
    run(3000);
    assert(count(E.ICE) === 0, 'shallow snow wrongly glaciated: ' + count(E.ICE));
  });

  test('worldgen writes biome ambients (ice caves freezing, volcanic hot)', () => {
    generateWorld('temp-seed-1');
    let ok = true;
    for (let ty = 0; ty < TEMP_H && ok; ty++)
      for (let tx = 0; tx < TEMP_W; tx++) {
        const b = BIOMES[worldBiomeMap[idx(tx * 4 + 2, ty * 4 + 2)]];
        if (ambientTemp[ty * TEMP_W + tx] !== b.temp) { ok = false; break; }
      }
    assert(ok, 'ambient map does not match biome temps');
    // across a few seeds, both temperature extremes should appear somewhere
    let sawCold = false, sawHot = false;
    for (const s of ['temp-seed-1', 'temp-seed-2', 'temp-seed-3']) {
      generateWorld(s);
      for (let i = 0; i < TEMP_CELLS; i++) {
        if (ambientTemp[i] < 0) sawCold = true;
        if (ambientTemp[i] > 40) sawHot = true;
      }
    }
    assert(sawCold, 'no freezing region in any seed');
    assert(sawHot, 'no hot region in any seed');
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

// Headless smoke test: weather, snow/metal/glass/hydrogen, predator bugs.
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
  function openFloor() { // open sky, solid floor
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
  }
  function runW(n) { for (let k = 0; k < n; k++) { simStep(); updateWeather(); } }
  function run(n) { for (let k = 0; k < n; k++) simStep(); }

  test('rain falls from the sky and pools', () => {
    openFloor(); seedSim(21);
    setWeather('rain', 999999);
    runW(900);
    setWeather('clear', 999999);
    assert(count(E.WATER) > 80, 'no rain pooled: ' + count(E.WATER));
  });

  test('snow falls, piles, and melts by a fire', () => {
    openFloor(); seedSim(22);
    setWeather('snow', 999999);
    runW(900);
    setWeather('clear', 999999);
    const snow = count(E.SNOW);
    assert(snow > 60, 'no snowpack: ' + snow);
    // torch a patch: nearby snow should melt to water
    for (let x = 100; x < 220; x += 4) setCell(idx(x, SIM_H - 7), E.FIRE);
    run(400);
    assert(count(E.SNOW) < snow, 'snow did not melt');
    assert(count(E.WATER) + count(E.STEAM) > 0, 'melt produced nothing');
  });

  test('storms strike lightning that reaches the ground', () => {
    openFloor(); seedSim(23);
    for (let x = 120; x < 200; x++)
      for (let y = SIM_H - 12; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    setWeather('storm', 999999);
    weather.boltCd = 1;
    let sparked = false, charged = false;
    for (let k = 0; k < 1500; k++) {
      simStep(); updateWeather();
      if (count(E.ELEC) > 0) sparked = true;
      if (count(E.EWATER) > 0) charged = true;
    }
    assert(sparked, 'no lightning');
    assert(charged, 'lightning never electrified the pool');
  });

  test('weather override: off is silent, forced rain never rolls away', () => {
    openFloor(); seedSim(29);
    setWeatherOverride('off');
    weather.timer = 1; // would roll immediately in auto mode
    runW(600);
    assert(count(E.WATER) === 0 && count(E.SNOW) === 0,
      'precipitation while off: water=' + count(E.WATER) + ' snow=' + count(E.SNOW));
    setWeatherOverride('rain');
    weather.timer = 1;
    runW(600);
    assert(weather.mode === 'rain', 'forced rain rolled to: ' + weather.mode);
    assert(count(E.WATER) > 50, 'forced rain not raining: ' + count(E.WATER));
    setWeatherOverride('auto');
    setWeather('clear', 999999);
  });

  test('exposed water slowly evaporates (steam appears)', () => {
    clearSim(); seedSim(24);
    for (let x = 0; x < SIM_W; x++) { setCell(idx(x, 0), E.WALL); setCell(idx(x, SIM_H - 1), E.WALL); }
    for (let x = 60; x < 260; x++)
      for (let y = SIM_H - 10; y < SIM_H - 1; y++) setCell(idx(x, y), E.WATER);
    let steamSeen = false;
    for (let k = 0; k < 6000 && !steamSeen; k++) {
      simStep();
      if (count(E.STEAM) > 0) steamSeen = true;
    }
    assert(steamSeen, 'water never evaporates');
  });

  test('lava fuses sand into glass, and acid cannot eat glass', () => {
    openFloor(); seedSim(25);
    for (let x = 100; x < 140; x++)
      for (let y = SIM_H - 10; y < SIM_H - 6; y++) setCell(idx(x, y), E.SAND);
    for (let x = 100; x < 140; x++)
      for (let y = SIM_H - 14; y < SIM_H - 10; y++) setCell(idx(x, y), E.LAVA);
    run(800);
    const glass = count(E.GLASS);
    assert(glass > 5, 'no glass formed: ' + glass);
    // acid bath: glass survives
    for (let x = 100; x < 140; x++)
      for (let y = SIM_H - 30; y < SIM_H - 22; y++) setCell(idx(x, y), E.ACID);
    run(1200);
    assert(count(E.GLASS) >= glass * 0.9, 'acid ate the glass');
  });

  test('electrolysis: heavily charged pools bubble hydrogen that burns', () => {
    openFloor(); seedSim(26);
    for (let x = 120; x < 180; x++)
      for (let y = SIM_H - 14; y < SIM_H - 6; y++) setCell(idx(x, y), E.EWATER);
    let h2 = 0;
    for (let k = 0; k < 400; k++) {
      simStep();
      h2 = Math.max(h2, count(E.HYDROGEN));
    }
    assert(h2 > 0, 'no hydrogen produced');
    // hydrogen pools at the sky ceiling in an open map — ignite it there
    const before = count(E.HYDROGEN);
    for (let x = 2; x < SIM_W - 2; x += 4)
      for (let y = 1; y < 6; y++)
        if (grid[idx(x, y)] === E.EMPTY) setCell(idx(x, y), E.FIRE);
    run(400);
    assert(count(E.HYDROGEN) < before, 'hydrogen never burned: ' + count(E.HYDROGEN) + '/' + before);
  });

  test('metal conducts sparks along its length into water', () => {
    openFloor(); seedSim(27);
    // wire from x=100 to x=140 on the floor; pool at the far end
    for (let x = 100; x <= 140; x++) setCell(idx(x, SIM_H - 7), E.METAL);
    for (let x = 141; x < 160; x++)
      for (let y = SIM_H - 10; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    // sparks at the near end
    let charged = false;
    for (let volley = 0; volley < 8 && !charged; volley++) {
      for (let k = 0; k < 4; k++) setCell(idx(98 + k, SIM_H - 8), E.ELEC);
      for (let k = 0; k < 120 && !charged; k++) {
        simStep();
        if (count(E.EWATER) > 0) charged = true;
      }
    }
    assert(charged, 'charge never traveled the wire to the pool');
  });

  test('hunters eat grazers: two-level food chain', () => {
    openFloor(); seedSim(28);
    // meadow with a healthy bug colony
    for (let x = 60; x < 260; x++)
      for (let y = SIM_H - 16; y < SIM_H - 6; y++) setCell(idx(x, y), E.PLANT);
    for (let x = 80; x < 240; x += 30) setCell(idx(x, SIM_H - 18), E.BUG); // few grazers: no overgrazing crash
    run(500);
    const bugsBefore = count(E.BUG);
    assert(bugsBefore > 3, 'no bug colony to test against: ' + bugsBefore);
    for (let x = 90; x < 230; x += 40) setCell(idx(x, SIM_H - 18), E.PRED);
    run(1200);
    results.push('INFO bugs ' + bugsBefore + ' -> ' + count(E.BUG) +
      ', hunters ' + count(E.PRED));
    assert(count(E.BUG) < bugsBefore, 'hunters never hunted');
    // starve check: without prey, hunters die out
    for (let i = 0; i < CELLS; i++) if (grid[i] === E.BUG || grid[i] === E.PLANT) setCell(i, E.EMPTY);
    run(2000);
    assert(count(E.PRED) === 0, 'immortal hunters: ' + count(E.PRED));
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

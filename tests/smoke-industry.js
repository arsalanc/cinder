// Headless smoke test: thermoelectric metal, corrosion, ruined-works set-pieces.
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

  test('hot metal sheds sparks; cold metal is inert', () => {
    openFloor(); seedSim(51);
    for (let x = 120; x < 160; x++) setCell(idx(x, SIM_H - 7), E.METAL);
    let sparked = false;
    for (let k = 0; k < 800 && !sparked; k++) { simStep(); if (count(E.ELEC) > 0) sparked = true; }
    assert(!sparked, 'metal sparked at temperate ambient');
    ambientTemp.fill(120); temp.fill(120);
    for (let k = 0; k < 800 && !sparked; k++) { simStep(); if (count(E.ELEC) > 0) sparked = true; }
    assert(sparked, 'hot metal never sparked');
  });

  test('geothermal generator: lava-dipped rod electrifies a distant pool', () => {
    openFloor(); seedSim(52);
    // metal rod along the floor: one end under the lava basin, the other
    // reaching a water pool ~20 cells away — heat conducts along the metal.
    // Two cells thick: since smelting exists, a 1-cell rod dipped in lava
    // erodes through before the far end charges (thicker electrode = built
    // to survive its own furnace)
    for (let x = 92; x < 132; x++) {
      setCell(idx(x, SIM_H - 7), E.METAL);
      setCell(idx(x, SIM_H - 8), E.METAL);
    }
    // walled lava basin sitting ON the rod (rod passes under the walls)
    for (let y = SIM_H - 14; y < SIM_H - 7; y++) {
      for (let t = 0; t < 2; t++) { setCell(idx(88 + t, y), E.WALL); setCell(idx(111 - t, y), E.WALL); }
    }
    for (let x = 90; x < 110; x++)
      for (let y = SIM_H - 12; y < SIM_H - 8; y++) setCell(idx(x, y), E.LAVA);
    // walled water pool at the rod's far end
    for (let y = SIM_H - 12; y < SIM_H - 7; y++) {
      setCell(idx(126, y), E.WALL); setCell(idx(145, y), E.WALL);
    }
    for (let x = 127; x < 145; x++)
      for (let y = SIM_H - 11; y < SIM_H - 8; y++) setCell(idx(x, y), E.WATER);
    let charged = false;
    for (let k = 0; k < 6000 && !charged; k++) {
      simStep();
      if (count(E.EWATER) > 0) charged = true;
    }
    assert(charged, 'the pool was never electrified by the generator');
  });

  test('acid corrodes metal into hydrogen, which can then burn', () => {
    openFloor(); seedSim(53);
    for (let x = 120; x < 160; x++)
      for (let y = SIM_H - 9; y < SIM_H - 6; y++) setCell(idx(x, y), E.METAL);
    for (let x = 125; x < 155; x++)
      for (let y = SIM_H - 13; y < SIM_H - 9; y++) setCell(idx(x, y), E.ACID);
    const metalBefore = count(E.METAL);
    let h2 = 0;
    for (let k = 0; k < 1500; k++) { simStep(); h2 = Math.max(h2, count(E.HYDROGEN)); }
    assert(count(E.METAL) < metalBefore, 'acid never corroded the metal');
    assert(h2 > 0, 'corrosion produced no hydrogen');
    // torch the ceiling gas
    const before = count(E.HYDROGEN);
    if (before > 0) {
      for (let x = 2; x < SIM_W - 2; x += 4)
        for (let y = 1; y < 6; y++)
          if (grid[idx(x, y)] === E.EMPTY) setCell(idx(x, y), E.FIRE);
      run(400);
      assert(count(E.HYDROGEN) < before, 'liberated hydrogen never burned');
    }
  });

  test('Rusted Works biome appears and stamps machinery', () => {
    const worksIdx = BIOMES.findIndex(b => b.name === 'Rusted Works');
    assert(worksIdx >= 0, 'Rusted Works biome missing');
    let seedsWithBiome = 0, seedsWithMachines = 0;
    for (let n = 0; n < 12; n++) {
      generateWorld('rusted-' + n, 5); // deep run: biases toward hazardous
      let hasBiome = false;
      for (let i = 0; i < CELLS; i++) if (worldBiomeMap[i] === worksIdx) { hasBiome = true; break; }
      if (!hasBiome) continue;
      seedsWithBiome++;
      // machine signatures: lava furnace, glass vat, or a dense gunpowder crate
      if (count(E.LAVA) > 0 || count(E.GLASS) > 0 || count(E.GUNPOWDER) > 60) seedsWithMachines++;
    }
    results.push('INFO rusted works in ' + seedsWithBiome + '/12 seeds, machines in ' + seedsWithMachines);
    assert(seedsWithBiome >= 6, 'biome too rare: ' + seedsWithBiome + '/12');
    assert(seedsWithMachines >= 4, 'machines rarely stamped: ' + seedsWithMachines);
  });

  test('a generator keeps its coolant basin lethally electrified', () => {
    openFloor(); seedSim(54);
    // carve a clear pocket on the floor and stamp a generator into it
    for (let x = 120; x < 180; x++)
      for (let y = SIM_H - 14; y < SIM_H - 6; y++)
        if (grid[idx(x, y)] !== E.WALL) setCell(idx(x, y), E.EMPTY);
    stampGenerator(150, SIM_H - 7);
    let charged = false;
    for (let k = 0; k < 1500 && !charged; k++) {
      simStep();
      if (count(E.EWATER) > 0) charged = true;
    }
    assert(charged, 'the generator never electrified its coolant basin');
  });

  test('smelting: a lava bath slowly melts immersed metal into molten', () => {
    openFloor(); seedSim(61);
    ambientTemp.fill(30); temp.fill(30);
    // walled crucible full of lava with a metal slab sunk in it
    for (let y = SIM_H - 18; y < SIM_H - 6; y++) { setCell(idx(118, y), E.WALL); setCell(idx(161, y), E.WALL); }
    for (let x = 119; x < 161; x++)
      for (let y = SIM_H - 16; y < SIM_H - 6; y++) setCell(idx(x, y), E.LAVA);
    for (let x = 130; x < 150; x++)
      for (let y = SIM_H - 12; y < SIM_H - 9; y++) setCell(idx(x, y), E.METAL);
    const metalBefore = count(E.METAL);
    let moltenSeen = 0;
    for (let k = 0; k < 3500; k++) {
      simStep();
      moltenSeen = Math.max(moltenSeen, count(E.MOLTEN));
    }
    assert(moltenSeen > 3, 'nothing melted: peak molten ' + moltenSeen);
    assert(count(E.METAL) < metalBefore - 5,
      'slab barely melted: ' + count(E.METAL) + '/' + metalBefore);
  });

  test('quenching: water flash-casts a molten pour into solid metal', () => {
    openFloor(); seedSim(62);
    // a thin pour in a stone trench, then flooded (a deep pool would crust
    // over and insulate its own interior — real foundry behavior)
    for (let y = SIM_H - 12; y < SIM_H - 6; y++) { setCell(idx(138, y), E.STONE); setCell(idx(172, y), E.STONE); }
    for (let x = 139; x < 172; x++) setCell(idx(x, SIM_H - 7), E.MOLTEN);
    for (let x = 139; x < 172; x++)
      for (let y = SIM_H - 13; y < SIM_H - 7; y++) setCell(idx(x, y), E.WATER);
    let steamSeen = false;
    for (let k = 0; k < 300; k++) { simStep(); if (count(E.STEAM) > 0) steamSeen = true; }
    assert(count(E.MOLTEN) < 5, 'quench too slow: ' + count(E.MOLTEN) + ' still molten');
    assert(count(E.METAL) > 20, 'no cast metal: ' + count(E.METAL));
    assert(steamSeen, 'quenching produced no steam');
  });

  test('a thin pour sets into solid metal in open air (casting)', () => {
    openFloor(); seedSim(63);
    // scattered droplets — no self-heating mass, so they cool and set
    for (let x = 60; x < 260; x += 12) setCell(idx(x, SIM_H - 7), E.MOLTEN);
    const dropped = count(E.MOLTEN);
    run(2000);
    assert(count(E.MOLTEN) === 0, 'molten never set: ' + count(E.MOLTEN) + ' left');
    assert(count(E.METAL) >= dropped - 2, 'castings vanished: ' + count(E.METAL) + '/' + dropped);
  });

  test('an always-running generator eventually melts its own housing', () => {
    openFloor(); seedSim(64);
    for (let x = 120; x < 180; x++)
      for (let y = SIM_H - 14; y < SIM_H - 6; y++)
        if (grid[idx(x, y)] !== E.WALL) setCell(idx(x, y), E.EMPTY);
    stampGenerator(150, SIM_H - 7);
    const metalBefore = count(E.METAL);
    let moltenSeen = 0;
    for (let k = 0; k < 6000; k++) {
      simStep();
      if ((k & 63) === 0) moltenSeen = Math.max(moltenSeen, count(E.MOLTEN));
    }
    assert(count(E.METAL) < metalBefore || moltenSeen > 0,
      'housing never degraded: ' + count(E.METAL) + '/' + metalBefore + ' molten peak ' + moltenSeen);
  });

  test('a generated Rusted Works level stays stable (no runaway fire)', () => {
    let seed = null;
    const worksIdx = BIOMES.findIndex(b => b.name === 'Rusted Works');
    for (let n = 0; n < 20 && seed === null; n++) {
      generateWorld('stable-' + n, 5);
      for (let i = 0; i < CELLS; i++) if (worldBiomeMap[i] === worksIdx) { seed = 'stable-' + n; break; }
    }
    assert(seed !== null, 'could not find a Rusted Works seed');
    generateWorld(seed, 5);
    run(600);
    // generator sparks and small oil flares are fine; a map-wide inferno is not
    assert(count(E.FIRE) < 80, 'world caught fire on its own: ' + count(E.FIRE));
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

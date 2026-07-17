// Headless smoke test: temperature x biology (seasons) + electricity closure.
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
  function run(n) { for (let k = 0; k < n; k++) simStep(); }
  function openFloor() {
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
  }
  function setAmbient(t) { ambientTemp.fill(t); temp.fill(t); }
  function meadow() {
    for (let x = 80; x < 240; x++)
      for (let y = SIM_H - 10; y < SIM_H - 6; y++) setCell(idx(x, y), E.PLANT);
  }

  test('a spark detonates gunpowder (electric tripwire)', () => {
    openFloor(); seedSim(61);
    for (let x = 140; x < 180; x++)
      for (let y = SIM_H - 10; y < SIM_H - 6; y++) setCell(idx(x, y), E.GUNPOWDER);
    const before = count(E.GUNPOWDER);
    setCell(idx(160, SIM_H - 11), E.ELEC);
    run(120);
    assert(count(E.GUNPOWDER) < before * 0.4,
      'spark never set it off: ' + count(E.GUNPOWDER) + '/' + before);
  });

  test('a spark flashes a hydrogen pocket', () => {
    openFloor(); seedSim(62);
    // sealed pocket at the ceiling
    for (let x = 100; x < 140; x++) { setCell(idx(x, 8), E.WALL); }
    for (let x = 100; x < 140; x++)
      for (let y = 9; y < 14; y++) setCell(idx(x, y), E.HYDROGEN);
    const before = count(E.HYDROGEN);
    setCell(idx(120, 14), E.ELEC);
    let burned = false;
    for (let k = 0; k < 300 && !burned; k++) {
      simStep();
      if (count(E.HYDROGEN) < before * 0.5) burned = true;
    }
    assert(burned, 'pocket never flashed: ' + count(E.HYDROGEN) + '/' + before);
  });

  test('burning hydrogen recombines into steam (water comes back)', () => {
    openFloor(); seedSim(63);
    for (let x = 100; x < 160; x++)
      for (let y = 20; y < 30; y++) setCell(idx(x, y), E.HYDROGEN);
    setCell(idx(130, 30), E.FIRE);
    let wet = 0;
    for (let k = 0; k < 600; k++) {
      simStep();
      wet = Math.max(wet, count(E.STEAM) + count(E.WATER));
    }
    assert(wet > 30, 'combustion returned no water: peak steam+water ' + wet);
  });

  test('frost kills the meadow, scattering seeds and ash', () => {
    openFloor(); seedSim(64);
    meadow();
    const plants = count(E.PLANT);
    setAmbient(-20);
    run(2500);
    assert(count(E.PLANT) < plants * 0.2, 'meadow shrugged off deep frost: ' + count(E.PLANT));
    assert(count(E.SEED) + count(E.ASH) > 30,
      'die-back left no seed bank: seeds=' + count(E.SEED) + ' ash=' + count(E.ASH));
  });

  test('spring bloom: thaw + meltwater regrow the dead meadow', () => {
    openFloor(); seedSim(65);
    meadow();
    setAmbient(-20);
    run(2500); // winter
    setAmbient(20); // thaw, with two waves of meltwater
    for (let x = 85; x < 235; x += 2) setCell(idx(x, SIM_H - 20), E.WATER);
    run(1250);
    for (let x = 86; x < 235; x += 2) setCell(idx(x, SIM_H - 20), E.WATER);
    run(1250);
    assert(count(E.PLANT) > 40, 'no regrowth after the thaw: ' + count(E.PLANT));
  });

  test('kelp survives frost while its pool stays liquid', () => {
    openFloor(); seedSim(66);
    // walled pond with kelp, plus an exposed meadow at the same temperature
    for (let y = SIM_H - 16; y < SIM_H - 6; y++) { setCell(idx(78, y), E.WALL); setCell(idx(131, y), E.WALL); }
    for (let x = 79; x < 131; x++)
      for (let y = SIM_H - 14; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    for (let x = 84; x < 128; x += 6)
      for (let v = 0; v < 4; v++) setCell(idx(x, SIM_H - 7 - v), E.PLANT);
    const kelp = count(E.PLANT);
    for (let x = 160; x < 240; x++)
      for (let y = SIM_H - 9; y < SIM_H - 6; y++) setCell(idx(x, y), E.PLANT);
    const total = count(E.PLANT);
    setAmbient(-8);
    run(1200);
    // exposed meadow dies; submerged kelp holds on while water is liquid
    const left = count(E.PLANT);
    results.push('INFO kelp=' + kelp + ' meadow=' + (total - kelp) + ' -> total left=' + left);
    assert(left < total * 0.75, 'frost killed nothing');
    assert(left > kelp * 0.5, 'kelp died while its pool was still liquid: ' + left);
  });

  test('cold torpor: bugs survive a chill dormant, deep cold kills them', () => {
    openFloor(); seedSim(67);
    meadow();
    for (let x = 100; x < 220; x += 15) setCell(idx(x, SIM_H - 11), E.BUG);
    const bugs = count(E.BUG);
    setAmbient(-8); // chilly but survivable
    run(400);
    assert(count(E.BUG) >= bugs * 0.7, 'mild chill massacred the bugs: ' + count(E.BUG));
    setAmbient(-30); // hard freeze
    run(1500);
    assert(count(E.BUG) === 0, 'bugs survived a hard freeze: ' + count(E.BUG));
  });

  test('heat cooks fauna', () => {
    openFloor(); seedSim(68);
    meadow();
    for (let x = 100; x < 220; x += 15) setCell(idx(x, SIM_H - 11), E.BUG);
    setAmbient(90);
    run(1200);
    assert(count(E.BUG) === 0, 'bugs strolled through an oven: ' + count(E.BUG));
  });

  test('fish stay alive (sluggish) in an ice-biome pool', () => {
    openFloor(); seedSim(69);
    for (let y = SIM_H - 18; y < SIM_H - 6; y++) { setCell(idx(98, y), E.WALL); setCell(idx(221, y), E.WALL); }
    for (let x = 99; x < 221; x++)
      for (let y = SIM_H - 15; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    for (let x = 104; x < 216; x += 8)
      for (let v = 0; v < 4; v++) setCell(idx(x, SIM_H - 7 - v), E.PLANT);
    for (let x = 110; x < 210; x += 25) setCell(idx(x, SIM_H - 11), E.FISH);
    const fish = count(E.FISH);
    setAmbient(-12); // ice caves
    run(1500);
    assert(count(E.FISH) > 0, 'ice-biome fish all died: 0/' + fish);
  });

  test('lightning on sand fuses a fulgurite (glass channel)', () => {
    openFloor(); seedSim(71);
    for (let x = 3; x < SIM_W - 3; x++)
      for (let y = SIM_H - 26; y < SIM_H - 6; y++) setCell(idx(x, y), E.SAND);
    for (let s = 0; s < 4; s++) lightningStrike();
    assert(count(E.GLASS) > 5, 'no fulgurite formed: ' + count(E.GLASS) + ' glass');
  });

  test('targeted lightning (sandbox tool) strikes where aimed', () => {
    openFloor(); seedSim(78);
    // pool on the left, sand bed on the right — hit each deliberately
    for (let x = 90; x < 120; x++)
      for (let y = SIM_H - 12; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    for (let x = 200; x < 240; x++)
      for (let y = SIM_H - 16; y < SIM_H - 6; y++) setCell(idx(x, y), E.SAND);
    lightningStrikeAt(105, SIM_H - 40, false);
    assert(count(E.EWATER) > 0, 'aimed bolt never charged the pool');
    lightningStrikeAt(220, SIM_H - 40, false);
    assert(count(E.GLASS) > 3, 'aimed bolt left no fulgurite: ' + count(E.GLASS));
    // a bolt aimed inside solid ground does nothing (no air to travel)
    const before = count(E.GLASS);
    lightningStrikeAt(220, SIM_H - 8, false);
    run(1);
    assert(count(E.GLASS) >= before, 'buried bolt misbehaved');
  });

  test('smoke chokes bugs trapped under it', () => {
    openFloor(); seedSim(72);
    // smoke must kill far faster than starvation (bug lifespan is 240-320)
    for (let x = 100; x < 220; x += 15) setCell(idx(x, SIM_H - 7), E.BUG);
    for (let k = 0; k < 200 && count(E.BUG) > 0; k++) {
      if (k % 2 === 0)
        for (let x = 82; x < 238; x++)
          for (let y = SIM_H - 10; y < SIM_H - 7; y++)
            if (grid[idx(x, y)] === E.EMPTY) setCell(idx(x, y), E.SMOKE);
      simStep();
    }
    assert(count(E.BUG) === 0, 'bugs breathed smoke for 200 frames: ' + count(E.BUG));
    // control: same floor, no smoke — starvation alone takes far longer
    openFloor(); seedSim(77);
    for (let x = 100; x < 220; x += 15) setCell(idx(x, SIM_H - 7), E.BUG);
    run(200);
    assert(count(E.BUG) > 0, 'control bugs died without smoke');
  });

  test('soaked gunpowder crumbles to inert ash', () => {
    openFloor(); seedSim(73);
    for (let x = 140; x < 170; x++)
      for (let y = SIM_H - 10; y < SIM_H - 6; y++) setCell(idx(x, y), E.GUNPOWDER);
    const before = count(E.GUNPOWDER);
    for (let x = 138; x < 172; x++)
      for (let y = SIM_H - 16; y < SIM_H - 10; y++) setCell(idx(x, y), E.WATER);
    run(1500);
    assert(count(E.GUNPOWDER) < before, 'water never ruined the powder');
    assert(count(E.ASH) > 5, 'no ruined-powder ash: ' + count(E.ASH));
  });

  test('like a moth to a flame', () => {
    openFloor(); seedSim(74);
    // a moth near a sustained flame dies to it; a control moth far away lives
    setCell(idx(105, SIM_H - 8), E.MOTH);
    setCell(idx(250, SIM_H - 8), E.MOTH); // control, no fire nearby
    for (let k = 0; k < 450; k++) {
      for (let y = SIM_H - 10; y < SIM_H - 6; y++) {
        setCell(idx(110, y), E.FIRE); life[idx(110, y)] = 50;
      }
      simStep();
    }
    let nearAlive = 0, farAlive = 0;
    for (let i = 0; i < CELLS; i++)
      if (grid[i] === E.MOTH) ((i % SIM_W) < 180 ? nearAlive++ : farAlive++);
    assert(nearAlive === 0, 'moth resisted the flame');
    assert(farAlive > 0, 'control moth died with no fire around');
  });

  test('moths sip glowing fungus in plantless caverns', () => {
    openFloor(); seedSim(75);
    for (let x = 140; x < 180; x += 5)
      for (let v = 0; v < 3; v++) setCell(idx(x, SIM_H - 7 - v), E.FUNGUS);
    for (let x = 150; x < 175; x += 8) setCell(idx(x, SIM_H - 11), E.MOTH);
    run(2500); // well past starvation lifespan without food
    assert(count(E.MOTH) > 0, 'moths starved beside a fungus grove');
  });

  test('granivory: bugs eat the seed bank', () => {
    openFloor(); seedSim(76);
    for (let x = 120; x < 200; x += 2) setCell(idx(x, SIM_H - 7), E.SEED);
    const seeds = count(E.SEED);
    for (let x = 125; x < 195; x += 10) setCell(idx(x, SIM_H - 8), E.BUG);
    run(800);
    assert(count(E.SEED) < seeds * 0.7, 'bugs ignored the seeds: ' + count(E.SEED) + '/' + seeds);
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

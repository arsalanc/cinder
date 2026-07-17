// Headless smoke test for the player entity.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'js');
const ctx = vm.createContext({ Math, console, Date });
// input.js is safe headless: browser APIs only inside initInput (not called)
for (const f of ['elements.js', 'sim.js', 'worldgen.js', 'input.js', 'player.js', 'spells.js', 'synergies.js', 'audio.js', 'creatures.js', 'weather.js', 'game.js']) {
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
  function run(n) { for (let k = 0; k < n; k++) { simStep(); updatePlayer(); } }
  function flatFloor() {
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
  }

  test('spawns alive on solid ground in a generated world', () => {
    generateWorld('player-1');
    spawnPlayer();
    assert(player.alive, 'not alive');
    run(120); // settle
    assert(player.alive, 'died on spawn (hp ' + player.hp.toFixed(0) + ')');
    assert(player.grounded || player.inLiquid, 'neither grounded nor swimming');
  });

  test('walks right on flat ground', () => {
    flatFloor();
    player.x = 50; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true; player.burning = 0;
    input.keys = { d: true };
    run(60);
    input.keys = {};
    assert(player.x > 70, 'barely moved: x=' + player.x.toFixed(1));
    assert(player.alive && player.grounded, 'should be alive and grounded');
  });

  test('jumps and lands', () => {
    flatFloor();
    player.x = 100; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true;
    const startY = player.y;
    input.keys = { w: true };
    run(12);
    const apexY = player.y;
    input.keys = {};
    run(80);
    assert(apexY < startY - 3, 'did not rise: ' + apexY.toFixed(1) + ' vs ' + startY.toFixed(1));
    assert(Math.abs(player.y - startY) < 1.5, 'did not land back: ' + player.y.toFixed(1));
  });

  test('walls block movement', () => {
    flatFloor();
    for (let y = SIM_H - 30; y < SIM_H; y++)
      for (let x = 120; x < 124; x++) setCell(idx(x, y), E.WALL);
    player.x = 110; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true;
    input.keys = { d: true };
    run(90);
    input.keys = {};
    assert(player.x + player.w <= 121, 'walked through wall: x=' + player.x.toFixed(1));
  });

  test('swims in water without drowning or sinking damage', () => {
    flatFloor();
    for (let x = 50; x < 120; x++)
      for (let y = SIM_H - 40; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    player.x = 80; player.y = SIM_H - 35; player.vx = 0; player.vy = 0;
    player.hp = 100; player.alive = true; player.burning = 0;
    run(120);
    assert(player.alive && player.hp > 99, 'water hurt the player: hp=' + player.hp.toFixed(0));
    assert(player.inLiquid, 'should report inLiquid');
    // swim up
    const yBefore = player.y;
    input.keys = { w: true };
    run(40);
    input.keys = {};
    assert(player.y < yBefore - 2, 'cannot swim upward');
  });

  test('lava burns and kills', () => {
    flatFloor();
    for (let x = 50; x < 120; x++)
      for (let y = SIM_H - 20; y < SIM_H - 6; y++) setCell(idx(x, y), E.LAVA);
    player.x = 80; player.y = SIM_H - 18; player.vx = 0; player.vy = 0;
    player.hp = 100; player.alive = true; player.burning = 0;
    run(150);
    assert(!player.alive, 'survived a lava bath: hp=' + player.hp.toFixed(0));
  });

  test('water extinguishes burning', () => {
    flatFloor();
    for (let x = 50; x < 120; x++)
      for (let y = SIM_H - 20; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    player.x = 80; player.y = SIM_H - 18; player.vx = 0; player.vy = 0;
    player.hp = 100; player.alive = true; player.burning = 200;
    run(5);
    assert(player.burning === 0, 'still burning in water');
    assert(player.hp > 95, 'took too much damage: ' + player.hp.toFixed(0));
  });

  test('jetpack: hold to fly, fuel drains, refuels on the ground', () => {
    flatFloor();
    const groundY = SIM_H - 6 - player.h;
    player.x = 100; player.y = groundY;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true;
    player.burning = 0; player.fuel = 100;
    input.keys = { w: true }; // jump, then keep thrusting
    run(80);
    input.keys = {};
    const height = groundY - player.y;
    assert(height > 15, 'not flying: rose only ' + height.toFixed(1) + ' cells');
    assert(player.fuel < 70, 'fuel not draining: ' + player.fuel.toFixed(0));
    run(150); // fall, land, refuel
    assert(player.grounded, 'did not land');
    assert(player.fuel > 95, 'fuel not recharging: ' + player.fuel.toFixed(0));
  });

  test('jetpack stops when fuel runs out (no infinite hover)', () => {
    flatFloor();
    player.x = 100; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true; player.fuel = 100;
    input.keys = { w: true };
    let emptied = false, fellAfterEmpty = false, lowestY = player.y;
    for (let k = 0; k < 500; k++) {
      simStep(); updatePlayer();
      lowestY = Math.min(lowestY, player.y);
      if (player.fuel <= 1) emptied = true;
      if (emptied && player.y > lowestY + 10) fellAfterEmpty = true;
    }
    input.keys = {};
    assert(emptied, 'fuel never emptied: ' + player.fuel.toFixed(0));
    assert(fellAfterEmpty, 'never fell after running dry (infinite hover?)');
  });

  test('unsticks when buried by falling sand', () => {
    flatFloor();
    player.x = 100; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true;
    // dump sand right on top
    for (let y = SIM_H - 40; y < SIM_H - 20; y++)
      for (let x = 99; x < 105; x++) setCell(idx(x, y), E.SAND);
    run(200);
    // player should have been pushed up on top of the pile, not entombed
    const feetY = Math.ceil(player.y + player.h);
    let buried = 0;
    const x0 = Math.floor(player.x), x1 = Math.ceil(player.x + player.w) - 1;
    for (let cy = Math.floor(player.y); cy < feetY; cy++)
      for (let cx = x0; cx <= x1; cx++)
        if (TYPE[grid[idx(cx, cy)]] === T.POWDER) buried++;
    assert(buried < 4, 'entombed in sand: ' + buried + ' cells overlap');
    assert(player.alive, 'died to sand');
  });

  test('seed rain on the head does not launch the player', () => {
    flatFloor();
    player.x = 100; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true;
    input.keys = {};
    const startY = player.y;
    let prevY = player.y;
    for (let k = 0; k < 300; k++) {
      // steady drizzle of seeds right onto the head (a small pile forming
      // underfoot is fine — a multi-cell-per-frame catapult is the bug)
      if (k % 15 === 0) {
        const hx = 100 + (k % 3);
        const hy = Math.floor(player.y) - 1;
        if (hy > 0 && grid[idx(hx, hy)] === E.EMPTY) setCell(idx(hx, hy), E.SEED);
      }
      simStep(); updatePlayer();
      assert(prevY - player.y <= 2.5,
        'catapulted at frame ' + k + ': rose ' + (prevY - player.y).toFixed(1) + ' in one frame');
      prevY = player.y;
    }
    assert(player.y > startY - 6, 'ended far too high: ' + player.y.toFixed(1) + ' from ' + startY);
    assert(player.alive, 'died to seed drizzle');
  });

  test('never clips up through a stone ceiling when cells fill', () => {
    flatFloor();
    player.x = 100; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true;
    input.keys = {};
    const ceilY = Math.floor(player.y) - 2;
    for (let x = 90; x < 112; x++)
      for (let y = ceilY - 2; y <= ceilY; y++) setCell(idx(x, y), E.STONE);
    // jam powder into the player's cells every frame — worst-case pressure
    for (let k = 0; k < 200; k++) {
      const i = idx(101, Math.floor(player.y) + 2);
      if (grid[i] === E.EMPTY) setCell(i, E.SAND);
      simStep(); updatePlayer();
      assert(Math.floor(player.y) > ceilY,
        'clipped into the ceiling at frame ' + k + ': y=' + player.y.toFixed(1));
    }
  });

  test('freezing air drains warmth and then hp (hypothermia)', () => {
    flatFloor();
    ambientTemp.fill(-30); temp.fill(-30);
    player.x = 100; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true;
    player.warmth = 60; player.burning = 0;
    input.keys = {};
    run(60); // grace: warmth eases down from 60 first
    assert(player.warmth < 45, 'warmth did not fall in the cold: ' + player.warmth.toFixed(1));
    run(500);
    assert(player.warmth < 20, 'never reached hypothermia: ' + player.warmth.toFixed(1));
    assert(player.hp < 100, 'cold never hurt the player: hp=' + player.hp.toFixed(1));
    assert(player.alive, 'died too fast to react');
  });

  test('a temperate cave leaves warmth and hp alone', () => {
    flatFloor();
    ambientTemp.fill(15); temp.fill(15);
    player.x = 100; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true;
    player.warmth = 60; player.burning = 0;
    input.keys = {};
    run(600);
    assert(player.hp > 99.5, 'temperate air hurt the player: hp=' + player.hp.toFixed(1));
    assert(player.warmth > 20 && player.warmth < 80, 'warmth drifted wrong: ' + player.warmth.toFixed(1));
  });

  test('warmth recovers when the air warms back up', () => {
    flatFloor();
    ambientTemp.fill(-20); temp.fill(-20);
    player.x = 100; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true;
    player.warmth = 15; player.burning = 0;
    input.keys = {};
    ambientTemp.fill(40); temp.fill(40);
    run(200);
    assert(player.warmth > 35, 'warmth never recovered: ' + player.warmth.toFixed(1));
  });

  test('spawn resets warmth to a survivable grace value', () => {
    generateWorld('cold-spawn');
    ambientTemp.fill(-40); temp.fill(-40);
    spawnPlayer();
    assert(player.warmth === 60, 'spawn warmth not reset: ' + player.warmth);
  });

  test('spawn prefers a temperature-safe spot when one exists', () => {
    // whole map freezing, but a temperate band in the middle third
    generateWorld('spawn-warmth');
    for (let i = 0; i < TEMP_CELLS; i++) ambientTemp[i] = temp[i] = -35;
    for (let ty = 0; ty < TEMP_H; ty++)
      for (let tx = (TEMP_W / 3) | 0; tx < (2 * TEMP_W / 3) | 0; tx++) {
        ambientTemp[ty * TEMP_W + tx] = temp[ty * TEMP_W + tx] = 16;
      }
    let warmSpawns = 0;
    for (let n = 0; n < 20; n++) {
      spawnPlayer();
      // let warmth settle toward the local equilibrium, then check no drain
      player.warmth = 60;
      for (let k = 0; k < 400; k++) { simStep(); updatePlayer(); }
      if (player.hp > 99.5) warmSpawns++;
    }
    assert(warmSpawns >= 18, 'spawns kept landing in the cold: ' + warmSpawns + '/20 safe');
  });

  test('ice is slippery: momentum carries after you stop steering', () => {
    // ice floor
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.ICE);
    player.x = 60; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true; player.burning = 0;
    input.keys = { d: true };
    run(80); // build up a glide
    assert(player.onIce, 'not detected as standing on ice');
    input.keys = {};
    const xRelease = player.x;
    run(30);
    const glide = player.x - xRelease;
    assert(glide > 3, 'no skid on ice: coasted only ' + glide.toFixed(1));

    // control: on stone, releasing stops you almost immediately
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.STONE);
    player.x = 60; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.alive = true;
    input.keys = { d: true };
    run(80);
    assert(!player.onIce, 'stone floor read as ice');
    input.keys = {};
    const xr2 = player.x;
    run(30);
    assert(player.x - xr2 < 1, 'stone had ice-like glide: ' + (player.x - xr2).toFixed(1));
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

// Headless smoke test: electricity, flamethrower, plant traversal rework.
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
  function arena() {
    resetModifiers(); resetWand(); clearCreatures(); clearSim();
    input.keys = {};
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    player.x = 60; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true;
    player.burning = 0; player.hurtCd = 0; player.fuel = 100;
  }
  function pool(x0, x1, y0, y1, id) {
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) setCell(idx(x, y), id || E.WATER);
  }

  test('electricity charges water, then the pool calms back down', () => {
    arena();
    pool(100, 140, SIM_H - 16, SIM_H - 6);
    const waterBefore = count(E.WATER) + count(E.EWATER);
    for (let x = 118; x < 122; x++) setCell(idx(x, SIM_H - 17), E.ELEC);
    for (let k = 0; k < 40; k++) simStep();
    assert(count(E.EWATER) > 15, 'pool not electrified: ' + count(E.EWATER));
    for (let k = 0; k < 500; k++) simStep();
    assert(count(E.EWATER) === 0, 'charge never dissipated: ' + count(E.EWATER));
    // electrolysis + evaporation take a small deliberate cut
    assert(count(E.WATER) > waterBefore * 0.8, 'pool drained too far: ' +
      count(E.WATER) + ' vs ' + waterBefore);
  });

  test('charge falls off with distance (big pools only partially electrify)', () => {
    arena();
    pool(20, 300, SIM_H - 14, SIM_H - 6); // huge lake
    setCell(idx(160, SIM_H - 15), E.ELEC);
    let peak = 0;
    for (let k = 0; k < 120; k++) { simStep(); peak = Math.max(peak, count(E.EWATER)); }
    const lake = 280 * 8;
    assert(peak > 0, 'no conduction at all');
    assert(peak < lake * 0.5, 'entire lake electrified (' + peak + '/' + lake + ') — no falloff');
  });

  test('live water shocks the player', () => {
    arena();
    pool(50, 90, SIM_H - 16, SIM_H - 6);
    player.x = 68; player.y = SIM_H - 14; // swimming in it
    // strike the water itself (a lone spark above a pool can drift away)
    for (let x = 74; x < 78; x++) setCell(idx(x, SIM_H - 16), E.ELEC);
    for (let k = 0; k < 80; k++) { simStep(); updatePlayer(); }
    assert(player.hp < 90, 'barely hurt: hp=' + player.hp.toFixed(0));
  });

  test('electricity ignites oil', () => {
    arena();
    pool(100, 130, SIM_H - 12, SIM_H - 6, E.OIL);
    for (let x = 110; x < 116; x++) setCell(idx(x, SIM_H - 13), E.ELEC);
    let burned = false;
    for (let k = 0; k < 200 && !burned; k++) {
      simStep();
      burned = count(E.FIRE) > 0;
    }
    assert(burned, 'oil never ignited');
  });

  test('flamethrower: short range, high close-up damage', () => {
    arena();
    wand.spells.push('flame');
    selectSpell(wand.spells.indexOf('flame'));
    castSelectedSpell(200, SIM_H - 10); // aim far away
    for (let k = 0; k < 30; k++) updateSpells();
    // range check: no fire beyond ~30 cells of the player
    let maxX = 0;
    for (let i = 0; i < CELLS; i++) if (grid[i] === E.FIRE) maxX = Math.max(maxX, i % SIM_W);
    assert(maxX > 0 && maxX < player.x + 30, 'flame reached x=' + maxX + ' (too far)');
    // damage check: a grub at point-blank dies much faster than vs spark
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    const t = CREATURE_TYPES.grub;
    creatures.push({ key: 'grub', x: 70, y: SIM_H - 6 - t.h, vx: 0, vy: 0,
                     w: t.w, h: t.h, hp: t.hp, dir: -1, burning: 0, hurtFlash: 0, bob: 0, attackCd: 0 });
    let frames = 0;
    while (creatures.length > 0 && frames++ < 120) {
      wand.cooldown = 0; wand.mana = 100;
      castSelectedSpell(71, SIM_H - 8);
      simStep(); updateSpells();
      for (let i = creatures.length - 1; i >= 0; i--) if (creatures[i].hp <= 0) killCreature(i);
    }
    assert(creatures.length === 0, 'grub survived ' + frames + ' frames of flamethrower');
    assert(frames < 60, 'flamethrower too weak: ' + frames + ' frames to kill');
  });

  test('arc bolt electrifies a pool from range', () => {
    arena();
    pool(120, 160, SIM_H - 16, SIM_H - 6);
    wand.spells.push('arc');
    selectSpell(wand.spells.indexOf('arc'));
    castSelectedSpell(140, SIM_H - 10);
    let charged = false;
    for (let k = 0; k < 90 && !charged; k++) {
      simStep(); updateSpells();
      charged = count(E.EWATER) > 5;
    }
    assert(charged, 'arc bolt never charged the pool');
  });

  test('plants: climbable vines, no jetpack fuel spent', () => {
    arena();
    // vine column the player stands inside
    for (let x = 59; x < 64; x++)
      for (let y = SIM_H - 50; y < SIM_H - 6; y++) setCell(idx(x, y), E.PLANT);
    const startY = player.y;
    input.keys = { w: true };
    for (let k = 0; k < 70; k++) { simStep(); updatePlayer(); }
    input.keys = {};
    assert(player.y < startY - 12, 'did not climb: rose ' + (startY - player.y).toFixed(1));
    assert(player.fuel > 95, 'climbing burned jetpack fuel: ' + player.fuel.toFixed(0));
  });

  test('plants: vines catch a falling player', () => {
    arena();
    for (let x = 90; x < 96; x++)
      for (let y = SIM_H - 60; y < SIM_H - 6; y++) setCell(idx(x, y), E.PLANT);
    player.x = 91; player.y = SIM_H - 80; player.vy = 0; // free-fall into vines
    let maxV = 0;
    for (let k = 0; k < 90; k++) {
      simStep(); updatePlayer();
      if (player.y > SIM_H - 58) maxV = Math.max(maxV, player.vy); // inside vines
    }
    assert(maxV <= 0.55, 'vines did not slow the fall: vy=' + maxV.toFixed(2));
    assert(player.alive, 'died in the vines');
  });

  test('plants: pushing through only gradually breaks them', () => {
    arena();
    for (let x = 80; x < 86; x++)
      for (let y = SIM_H - 20; y < SIM_H - 6; y++) setCell(idx(x, y), E.PLANT);
    const before = count(E.PLANT);
    input.keys = { d: true };
    for (let k = 0; k < 100; k++) { simStep(); updatePlayer(); }
    input.keys = {};
    assert(player.x > 88, 'stuck in the hedge: x=' + player.x.toFixed(1));
    // a single crossing only expects ~1 trample event — push back and forth
    // a few more times so "gradual but nonzero" is a stable assertion
    for (let pass = 0; pass < 5; pass++) {
      input.keys = pass % 2 ? { d: true } : { a: true };
      for (let k = 0; k < 100; k++) { simStep(); updatePlayer(); }
    }
    input.keys = {};
    const after = count(E.PLANT);
    assert(after > before * 0.6, 'hedge flattened: ' + after + '/' + before);
    assert(after < before, 'nothing trampled at all');
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

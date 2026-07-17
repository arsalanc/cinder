// Headless smoke test: boss levels at depths 3 and 6 (quench/capacitor cycles).
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
  function bossLevel(depth) {
    startRun();
    run.depth = depth;
    beginLevel();
    return creatures.find(c => CREATURE_TYPES[c.key].boss);
  }
  function pinPlayer(x, y) {
    player.x = x; player.y = y; player.vx = 0; player.vy = 0;
    player.alive = true; player.hp = 9999; player.maxHp = 9999; player.hurtCd = 999999;
  }
  function unpinPlayer() { player.maxHp = 100; player.hp = 100; player.hurtCd = 0; }
  function stoneWorld() {
    startRun();
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = 40; y < SIM_H; y++) setCell(idx(x, y), E.STONE);
    clearCreatures();
  }
  function pushWorm(x, y, extra) {
    const t = CREATURE_TYPES.magmaworm;
    const c = Object.assign({ key: 'magmaworm', x, y, vx: 0, vy: 0, w: t.w, h: t.h,
      hp: t.hp, dir: 1, burning: 0, hurtFlash: 0, bob: 0, attackCd: 0 }, extra || {});
    creatures.push(c);
    return c;
  }
  function pushTempest(x, y, extra) {
    const t = CREATURE_TYPES.tempest;
    const c = Object.assign({ key: 'tempest', x, y, vx: 0, vy: 0, w: t.w, h: t.h,
      hp: t.hp, dir: 1, burning: 0, hurtFlash: 0, bob: 0, attackCd: 5 }, extra || {});
    creatures.push(c);
    return c;
  }
  function pushGrove(x, y, extra) {
    const t = CREATURE_TYPES.overgrowth;
    const c = Object.assign({ key: 'overgrowth', x, y, vx: 0, vy: 0, w: t.w, h: t.h,
      hp: t.hp, maxHp: t.hp, dir: 1, burning: 0, hurtFlash: 0, bob: 0, attackCd: 60 },
      extra || {});
    creatures.push(c);
    return c;
  }
  // find a seed whose guardian assignment puts 'key' at 'depth', then build it
  function bossLevelWith(key, depth) {
    for (let n = 0; n < 60; n++) {
      pendingRunSeed = key + '-arena-' + n;
      startRun();
      run.depth = depth;
      if (bossKeyFor(depth) !== key) continue;
      beginLevel();
      return creatures.find(c => CREATURE_TYPES[c.key].boss);
    }
    return null;
  }

  test('guardians are seed-assigned: varied, stable, never twice per descent', () => {
    const seen = new Set();
    for (let n = 0; n < 30; n++) {
      pendingRunSeed = 'assign-' + n;
      startRun();
      const a = bossKeyFor(3), b = bossKeyFor(WIN_DEPTH);
      assert(GUARDIANS.includes(a) && GUARDIANS.includes(b), 'unknown guardian');
      assert(a !== b, 'same guardian twice in one descent (' + a + ')');
      assert(a === bossKeyFor(3), 'assignment not stable');
      seen.add(a); seen.add(b);
      // endless: 9/12/15 rotate through all three
      const trio = new Set([bossKeyFor(9), bossKeyFor(12), bossKeyFor(15)]);
      assert(trio.size === 3, 'endless rotation repeats: ' + [...trio]);
    }
    assert(seen.size === 3, 'not all guardians appear across seeds: ' + [...seen]);
  });

  test('each guardian spawns in its own arena', () => {
    for (const key of GUARDIANS) {
      const b = bossLevelWith(key, 3);
      assert(b && b.key === key, key + ' never spawned: ' + (b && b.key));
    }
  });

  test('portal stays dormant while the boss lives; opens when it dies', () => {
    const b = bossLevel(3);
    const depthBefore = run.depth;
    player.x = portal.x - player.w / 2;
    player.y = portal.y - player.h / 2;
    player.hurtCd = 9999; // ignore boss contact for this check
    updateGame();
    assert(!run.choosing && run.depth === depthBefore, 'portal fired with boss alive');
    assert(run.portalHint, 'no dormant hint');
    b.hp = -1;
    updateCreatures();
    assert(!creatures.some(c => CREATURE_TYPES[c.key].boss), 'boss undead');
    updateGame();
    assert(run.choosing, 'portal did not open after boss death');
  });

  test('magma worm tunnels through stone toward the player', () => {
    stoneWorld();
    pinPlayer(40, 30);
    const c = pushWorm(240, 120, { surfaceCd: 99999 }); // pure chase, no breach
    const stoneBefore = count(E.STONE);
    const d0 = Math.hypot(c.x - player.x, c.y - player.y);
    for (let k = 0; k < 300; k++) { simStep(); updateCreatures(); }
    const d1 = Math.hypot(c.x - player.x, c.y - player.y);
    assert(d1 < d0 - 40, 'worm did not approach: ' + d0.toFixed(0) + ' -> ' + d1.toFixed(0));
    assert(count(E.STONE) < stoneBefore - 100, 'worm did not carve terrain');
    assert(count(E.LAVA) > 0, 'no lava trail');
    unpinPlayer();
  });

  test('the molten shell deflects direct damage entirely', () => {
    stoneWorld();
    pinPlayer(40, 30);
    const c = pushWorm(240, 120, { surfaceCd: 99999 });
    updateCreatures(); // init boss state
    const hpBefore = c.hp;
    damageCreature(c, 50);
    damageCreature(c, 50);
    assert(c.hp === hpBefore, 'shelled worm took direct damage: ' + (hpBefore - c.hp));
    unpinPlayer();
  });

  test('soaking the burrowing worm quenches the shell open (thermal shock)', () => {
    stoneWorld();
    const c = pushWorm(150, 100, { surfaceCd: 99999 });
    // pin the player at its center so it holds position (dist < 3)
    pinPlayer(c.x + c.w / 2 - player.w / 2, c.y + c.h / 2 - player.h / 2);
    updateCreatures();
    // flood a deep pool around it — refloods faster than it digs
    for (let x = 130; x < 175; x++)
      for (let y = 85; y < 115; y++)
        if (grid[idx(x, y)] !== E.WALL) setCell(idx(x, y), E.WATER);
    let steamSeen = false;
    for (let k = 0; k < 200 && !(c.exposedT > 0); k++) {
      simStep(); updateCreatures();
      if (count(E.STEAM) > 0) steamSeen = true;
    }
    assert(c.exposedT > 0, 'soaked worm never cracked open');
    assert(steamSeen || count(E.STEAM) > 0, 'no quench steam');
    // the window: double damage, and no contact harm from the coiled worm
    const hpBefore = c.hp, playerHp = player.hp;
    damageCreature(c, 10);
    assert(Math.abs((hpBefore - c.hp) - 20) < 0.5, 'no 2x damage while exposed: ' + (hpBefore - c.hp));
    player.hurtCd = 0;
    for (let k = 0; k < 5; k++) updateCreatures();
    assert(player.hp === playerHp, 'exposed worm still dealt contact damage');
    unpinPlayer();
  });

  test('the worm telegraphs then BREACHES; a dry landing is a lava slam', () => {
    stoneWorld();
    pinPlayer(120, 34);
    // worm shallow underground nearby, breach imminent
    const c = pushWorm(150, 50, { surfaceCd: 5, exposedT: 0, breachTel: 0,
      airborne: false, slamT: 0, surgeT: 0, phaseDone: 1, geysers: [] });
    let sawTel = false, sawAir = false;
    for (let k = 0; k < 400 && !(c.slamT > 0 || c.exposedT > 0); k++) {
      simStep(); updateCreatures();
      if (c.breachTel > 0) sawTel = true;
      if (c.airborne) sawAir = true;
    }
    assert(sawTel, 'no smoke-jet telegraph before the breach');
    assert(sawAir, 'worm never went airborne');
    assert(c.slamT > 0 || c.surfaceCd > 0, 'breach never resolved');
    assert(c.exposedT === 0, 'a dry slam should not expose it');
    assert(count(E.LAVA) > 0, 'dry slam splashed no lava');
    unpinPlayer();
  });

  test('a breach that splashes down into water quenches it EXPOSED', () => {
    stoneWorld();
    // open a pit with a pool at the bottom
    for (let x = 130; x < 180; x++)
      for (let y = 40; y < 90; y++) setCell(idx(x, y), E.EMPTY);
    for (let x = 130; x < 180; x++)
      for (let y = 80; y < 90; y++) setCell(idx(x, y), E.WATER);
    pinPlayer(40, 30);
    const c = pushWorm(152, 50, { surfaceCd: 99999, exposedT: 0, breachTel: 0,
      airborne: true, vx: 0, vy: 1.2, slamT: 0, surgeT: 0, phaseDone: 1, geysers: [] });
    for (let k = 0; k < 120 && !(c.exposedT > 0); k++) { simStep(); updateCreatures(); }
    assert(c.exposedT > 0, 'splashdown did not quench the worm');
    assert(count(E.STEAM) > 0, 'no quench steam on splashdown');
    unpinPlayer();
  });

  test('stomping an exposed boss crunches it and bounces you off', () => {
    stoneWorld();
    for (let x = 100; x < 200; x++)
      for (let y = 30; y < 40; y++) setCell(idx(x, y), E.EMPTY);
    const c = pushWorm(150, 36, { surfaceCd: 99999, exposedT: 100, breachTel: 0,
      airborne: false, slamT: 0, surgeT: 0, phaseDone: 1, geysers: [] });
    pinPlayer(c.x + 1, c.y - player.h + 0.5); // feet just inside its back
    player.vy = 1.2; // falling onto it
    const hpBefore = c.hp;
    updateCreatures();
    assert(hpBefore - c.hp >= 40, 'stomp too weak: ' + (hpBefore - c.hp));
    assert(player.vy < 0, 'no bounce off the stomp');
    unpinPlayer();
  });

  test('phase break: magma surge erupts geysers and shrugs off all damage', () => {
    stoneWorld();
    pinPlayer(40, 30);
    const c = pushWorm(200, 100);
    updateCreatures();                 // init at phase 1
    c.hp = CREATURE_TYPES.magmaworm.hp * 0.5; // cross into phase 2
    updateCreatures();
    assert(c.surgeT > 0, 'phase break did not trigger a surge');
    const hpBefore = c.hp;
    damageCreature(c, 50);
    assert(c.hp === hpBefore, 'worm took damage during its surge');
    const lavaBefore = count(E.LAVA);
    for (let k = 0; k < 320 && c.surgeT > 0; k++) { simStep(); updateCreatures(); }
    assert(count(E.LAVA) > lavaBefore + 5, 'geysers never erupted lava');
    assert(c.surgeT === 0, 'surge never ended');
    unpinPlayer();
  });

  test('a weakened worm superheats the arena air', () => {
    stoneWorld();
    ambientTemp.fill(30); temp.fill(30);
    pinPlayer(150, 110);
    pushWorm(200, 110, { hp: CREATURE_TYPES.magmaworm.hp * 0.2, surfaceCd: 99999,
      exposedT: 0, breachTel: 0, airborne: false, slamT: 0, surgeT: 0,
      phaseDone: 3, geysers: [] });
    for (let k = 0; k < 400; k++) { simStep(); updateCreatures(); }
    let peak = 30;
    for (let i = 0; i < temp.length; i++) if (temp[i] > peak) peak = temp[i];
    assert(peak > 60, 'arena never heated: peak ' + peak.toFixed(0) + ' lava=' + count(E.LAVA));
    unpinPlayer();
  });

  test('tempest climbs over cover instead of sitting behind it', () => {
    startRun();
    clearSim();
    for (let x = 0; x < SIM_W; x++) setCell(idx(x, SIM_H - 1), E.WALL);
    // a tall pillar between the player and the tempest
    for (let y = SIM_H - 60; y < SIM_H - 1; y++)
      for (let x = 148; x < 152; x++) setCell(idx(x, y), E.STONE);
    clearCreatures();
    pinPlayer(60, SIM_H - 12);
    const c = pushTempest(200, SIM_H - 14, { chargeCd: 99999, chargingT: 0,
      exposedT: 0, squallT: 0, phaseDone: 1 });
    const y0 = c.y, x0 = c.x;
    for (let k = 0; k < 260; k++) { simStep(); updateCreatures(); }
    assert(c.y < y0 - 20, 'tempest never climbed: y ' + y0.toFixed(0) + ' -> ' + c.y.toFixed(0));
    assert(c.x < x0 - 10, 'tempest never advanced past the pillar: x ' + c.x.toFixed(0));
    unpinPlayer();
  });

  test('tempest cycle: charge crackles, nova strikes, then it falls SPENT', () => {
    startRun();
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    clearCreatures();
    pinPlayer(140, SIM_H - 12);
    const c = pushTempest(170, SIM_H - 40, { chargeCd: 10, chargingT: 0,
      exposedT: 0, squallT: 0, phaseDone: 1 });
    let sawCharge = false, sawElec = false;
    for (let k = 0; k < 300 && !(c.exposedT > 0); k++) {
      simStep(); updateCreatures();
      if (c.chargingT > 0) sawCharge = true;
      if (count(E.ELEC) > 0) sawElec = true;
    }
    assert(sawCharge, 'no charge telegraph');
    assert(sawElec, 'nova produced no electricity');
    assert(c.exposedT > 0, 'tempest never fell spent');
    // spent: it drops to the ground and takes double damage
    for (let k = 0; k < 80; k++) { simStep(); updateCreatures(); }
    assert(c.y > SIM_H - 20, 'spent tempest did not fall: y=' + c.y.toFixed(0));
    const hpBefore = c.hp;
    damageCreature(c, 10);
    assert(Math.abs((hpBefore - c.hp) - 20) < 0.5, 'no 2x damage while spent');
    unpinPlayer();
  });

  test('dousing the tempest short-circuits it (and the splash goes live)', () => {
    startRun();
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    clearCreatures();
    pinPlayer(60, SIM_H - 12);
    const c = pushTempest(170, SIM_H - 30, { chargeCd: 99999, chargingT: 0,
      exposedT: 0, squallT: 0, phaseDone: 1 });
    // splash fresh water straight onto it
    for (let x = 168; x < 177; x++)
      for (let y = SIM_H - 32; y < SIM_H - 25; y++)
        if (grid[idx(x, y)] === E.EMPTY) setCell(idx(x, y), E.WATER);
    for (let k = 0; k < 30 && !(c.exposedT > 0); k++) updateCreatures();
    assert(c.exposedT > 0, 'soaked tempest never shorted out');
    assert(count(E.EWATER) + count(E.ELEC) > 0, 'the short-circuit splash never went live');
    unpinPlayer();
  });

  test('phase break: storm squall rains real water and blocks damage', () => {
    startRun();
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    clearCreatures();
    pinPlayer(60, SIM_H - 12);
    const c = pushTempest(170, 40);
    updateCreatures();                 // init at phase 1
    c.hp = CREATURE_TYPES.tempest.hp * 0.5; // cross into phase 2
    updateCreatures();
    assert(c.squallT > 0, 'phase break did not trigger a squall');
    const hpBefore = c.hp;
    damageCreature(c, 50);
    assert(c.hp === hpBefore, 'tempest took damage during its squall');
    const waterBefore = count(E.WATER);
    for (let k = 0; k < 290 && c.squallT > 0; k++) { simStep(); updateCreatures(); }
    assert(count(E.WATER) > waterBefore + 40, 'squall rained no water: ' +
      waterBefore + ' -> ' + count(E.WATER));
    unpinPlayer();
  });

  test('tempest electrifies puddles below it and only fires with a clear lane', () => {
    startRun();
    clearSim();
    for (let x = 0; x < SIM_W; x++) setCell(idx(x, SIM_H - 1), E.WALL);
    clearCreatures();
    // a puddle under where the fight will hover
    for (let x = 45, y = SIM_H - 5; x < 95; x++)
      for (let yy = y; yy < SIM_H - 1; yy++) setCell(idx(x, yy), E.WATER);
    pinPlayer(70, SIM_H - 12);
    const c = pushTempest(120, SIM_H - 40, { chargeCd: 99999, chargingT: 0,
      exposedT: 0, squallT: 0, phaseDone: 1 });
    let charged = false, fired = false;
    for (let k = 0; k < 400; k++) {
      simStep(); updateCreatures();
      if (count(E.EWATER) > 3) charged = true;
      if (eProjectiles.length > 0) fired = true;
    }
    assert(charged, 'tempest never electrified the puddle');
    assert(fired, 'tempest never attacked');
    unpinPlayer();
  });

  test('environmental hazards cannot chip a shelled boss (fire on tempest)', () => {
    startRun();
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    clearCreatures();
    pinPlayer(60, SIM_H - 12);
    const c = pushTempest(170, SIM_H - 30, { chargeCd: 99999, chargingT: 0,
      exposedT: 0, squallT: 0, phaseDone: 1 });
    // engulf it in flame every frame
    for (let k = 0; k < 200; k++) {
      for (let x = 167; x < 178; x++)
        for (let y = SIM_H - 33; y < SIM_H - 24; y++)
          if (grid[idx(x, y)] === E.EMPTY) setCell(idx(x, y), E.FIRE);
      simStep(); updateCreatures();
    }
    assert(c.hp > CREATURE_TYPES.tempest.hp - 2,
      'fire chipped the tempest: ' + c.hp.toFixed(1) + '/' + CREATURE_TYPES.tempest.hp);
    assert(c.burning === 0, 'a storm elemental caught fire');
    unpinPlayer();
  });

  test('a quenched worm cannot be chain-quenched (the shell must reheat)', () => {
    stoneWorld();
    // a big pool it sits in for the whole exercise
    for (let x = 120; x < 190; x++)
      for (let y = 80; y < 110; y++) setCell(idx(x, y), E.WATER);
    pinPlayer(152, 84);
    const c = pushWorm(150, 95, { surfaceCd: 99999, exposedT: 0, breachTel: 0,
      airborne: false, slamT: 0, surgeT: 0, phaseDone: 1, geysers: [], reheatT: 0 });
    // first quench fires (hot shell, soaked)
    for (let k = 0; k < 60 && !(c.exposedT > 0); k++) { simStep(); updateCreatures(); }
    assert(c.exposedT > 0, 'first quench never happened');
    // run the window out while it stays soaked — it must NOT re-expose
    for (let k = 0; k < 200 && c.exposedT > 0; k++) { simStep(); updateCreatures(); }
    assert(c.exposedT === 0, 'window never ended');
    for (let k = 0; k < 120; k++) { simStep(); updateCreatures(); }
    assert(c.exposedT === 0, 'worm chain-quenched in the pool (no reheat gate)');
    assert(c.reheatT > 0, 'no reheat timer running');
    unpinPlayer();
  });

  test('a ceiling-pinned tempest swoops down instead of sticking to the roof', () => {
    startRun();
    clearSim();
    for (let x = 0; x < SIM_W; x++) {
      setCell(idx(x, SIM_H - 1), E.WALL);
      for (let y = 0; y < 20; y++) setCell(idx(x, y), E.WALL); // low roof
    }
    // an overhang shelf the player hides under — no line of sight from above
    for (let x = 40; x < 100; x++)
      for (let y = SIM_H - 30; y < SIM_H - 26; y++) setCell(idx(x, y), E.STONE);
    clearCreatures();
    pinPlayer(70, SIM_H - 12);
    const c = pushTempest(70, 28, { chargeCd: 99999, chargingT: 0,
      exposedT: 0, squallT: 0, phaseDone: 1 }); // starts jammed at the roof
    let lowest = c.y;
    for (let k = 0; k < 500; k++) {
      simStep(); updateCreatures();
      lowest = Math.max(lowest, c.y);
    }
    assert(lowest > 60, 'tempest stayed pinned at the roof: deepest y=' + lowest.toFixed(0));
    unpinPlayer();
  });

  test('the overgrowth regenerates through unburned chip damage', () => {
    stoneWorld();
    pinPlayer(40, 30);
    const c = pushGrove(200, 34, { hp: 200 });
    updateCreatures(); // init
    damageCreature(c, 10); // armored chip: 3 through the hide
    const after = c.hp;
    for (let k = 0; k < 200; k++) updateCreatures();
    assert(c.hp > after + 5, 'no regeneration: ' + after.toFixed(1) + ' -> ' + c.hp.toFixed(1));
    unpinPlayer();
  });

  test('sustained burning SCORCHES the overgrowth open (fire is the key)', () => {
    stoneWorld();
    for (let x = 150, y = 30; x < 260; x++)
      for (let yy = y; yy < 40; yy++) setCell(idx(x, yy), E.EMPTY);
    pinPlayer(160, 34);
    const c = pushGrove(200, 35);
    updateCreatures();
    let frames = 0;
    for (let k = 0; k < 600 && !(c.exposedT > 0); k++) {
      // keep flame on its body (the flamethrower scenario)
      for (let dx = 0; dx < 3; dx++) {
        const j = idx(Math.round(c.x) + dx * 2, Math.round(c.y) + 1);
        if (grid[j] === E.EMPTY) setCell(j, E.FIRE);
      }
      simStep(); updateCreatures();
      frames++;
    }
    assert(c.exposedT > 0, 'burning never scorched it open (' + frames + ' frames)');
    // the window: double damage, and no regen while it lasts
    const hpBefore = c.hp;
    damageCreature(c, 10);
    assert(Math.abs((hpBefore - c.hp) - 20) < 0.5, 'no 2x while scorched: ' + (hpBefore - c.hp));
    // fresh sap: right after the window closes, fire cannot immediately re-scorch
    c.exposedT = 1;
    updateCreatures();
    assert(c.regrowT > 0, 'no regrow guard after the window');
    c.burning = 200;
    for (let k = 0; k < 120; k++) updateCreatures();
    assert(c.exposedT === 0, 'chain-scorched through fresh sap');
    unpinPlayer();
  });

  test('phase break: BLOOM is invulnerable and rains new growth', () => {
    stoneWorld();
    pinPlayer(40, 30);
    const c = pushGrove(200, 34);
    updateCreatures(); // init at phase 1
    c.hp = CREATURE_TYPES.overgrowth.hp * 0.5; // cross into phase 2
    updateCreatures();
    assert(c.bloomT > 0, 'phase break did not bloom');
    const hpBefore = c.hp;
    damageCreature(c, 50);
    assert(c.hp === hpBefore, 'overgrowth took damage mid-bloom');
    const lifeBefore = count(E.SEED) + count(E.PLANT);
    for (let k = 0; k < 260 && c.bloomT > 0; k++) { simStep(); updateCreatures(); }
    assert(count(E.SEED) + count(E.PLANT) > lifeBefore + 10,
      'bloom rained nothing: ' + lifeBefore + ' -> ' + (count(E.SEED) + count(E.PLANT)));
    unpinPlayer();
  });

  test('the overgrowth mortars spore globs that take root', () => {
    stoneWorld();
    for (let x = 100; x < 260; x++)
      for (let y = 20; y < 40; y++) setCell(idx(x, y), E.EMPTY);
    pinPlayer(120, 34);
    const c = pushGrove(220, 35, { attackCd: 3 });
    let spore = false;
    for (let k = 0; k < 60 && !spore; k++) {
      updateCreatures();
      if (eProjectiles.some(ep => ep.kind === 'spore')) spore = true;
    }
    assert(spore, 'no spore mortar fired');
    // let the volley land: something green takes root somewhere
    for (let k = 0; k < 400; k++) { simStep(); updateCreatures(); }
    assert(count(E.PLANT) + count(E.FUNGUS) > 0, 'spores never took root');
    unpinPlayer();
  });

  test('slaying the overgrowth stamps the trophy and unlocks Heartseed', () => {
    stoneWorld();
    pinPlayer(40, 30);
    meta.groveKills = 0;
    const c = pushGrove(200, 34);
    c.hp = -1;
    updateCreatures();
    assert(meta.groveKills === 1, 'grove kill not counted');
    assert(isUnlocked(MODIFIERS.find(m => m.name === 'Heartseed')), 'Heartseed locked');
    resetModifiers();
    MODIFIERS.find(m => m.name === 'Heartseed').apply();
    assert(runState.plantStride && runState.trampleHeal > 0, 'Heartseed effects missing');
    resetModifiers();
    unpinPlayer();
  });

  test('the grove arena is a tinderbox: wood pillars and oil pockets', () => {
    const b = bossLevelWith('overgrowth', 3);
    assert(b, 'no overgrowth arena found');
    assert(count(E.WOOD) > 20, 'no wooden cover: ' + count(E.WOOD));
    assert(count(E.OIL) > 30, 'no oil pockets: ' + count(E.OIL));
  });

  test('boss depth is a contained chamber with a water reservoir', () => {
    bossLevelWith('magmaworm', 3);
    let borderOk = true;
    for (let x = 0; x < SIM_W && borderOk; x++) {
      if (grid[idx(x, 0)] !== E.WALL || grid[idx(x, SIM_H - 1)] !== E.WALL) borderOk = false;
    }
    assert(borderOk, 'arena is not walled in');
    assert(count(E.WATER) > 300, 'no reservoir: ' + count(E.WATER) + ' water');
    assert(player.alive, 'player not spawned');
    assert(player.y < bossArena.floorY && player.y > 30, 'player not on the arena floor: y=' + player.y.toFixed(0));
    const reach = reachableFrom(Math.round(player.x + player.w / 2), Math.round(player.y + player.h / 2));
    assert(reach[idx(portal.x, portal.y)], 'portal unreachable in the arena');
  });

  test('the tempest arena has metal-capped lightning-rod pillars', () => {
    bossLevelWith('tempest', WIN_DEPTH);
    assert(count(E.METAL) > 5, 'no lightning rods: ' + count(E.METAL) + ' metal');
    assert(count(E.WATER) > 80, 'no starting pools: ' + count(E.WATER));
  });

  test('a hot pool keeps the player cool (heatstroke refuge)', () => {
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    ambientTemp.fill(95); temp.fill(95); // furnace-hot arena
    player.x = 40; player.y = SIM_H - 6 - player.h; player.vx = 0; player.vy = 0;
    player.alive = true; player.hp = 100; player.warmth = 60; player.burning = 0;
    input.keys = {};
    for (let k = 0; k < 400; k++) { simStep(); updatePlayer(); }
    assert(player.warmth > 85, 'dry player did not overheat: ' + player.warmth.toFixed(0));
    const dryHp = player.hp;
    assert(dryHp < 100, 'no heatstroke damage while dry');
    for (let x = 100; x < 160; x++)
      for (let y = SIM_H - 12; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    player.x = 128; player.y = SIM_H - 12; player.hp = 100; player.warmth = 95;
    for (let k = 0; k < 200; k++) { simStep(); updatePlayer(); }
    assert(player.warmth < 60, 'water did not cool the player: ' + player.warmth.toFixed(0));
    assert(player.hp > 99, 'water refuge still took heatstroke: hp ' + player.hp.toFixed(0));
  });

  test('killing a boss heals and refills mana', () => {
    const b = bossLevel(3);
    player.hp = 40;
    wand.mana = 5;
    b.hp = -1;
    updateCreatures();
    assert(player.hp >= 70, 'no boss heal: ' + player.hp);
    assert(wand.mana === wand.maxMana, 'no mana refill');
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

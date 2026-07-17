// Headless smoke test: quality-of-the-loop batch — death recap, daily
// scoreboard, replay share strings, depth-2 lesser elite.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'js');
const ctx = vm.createContext({ Math, console, Date });
for (const f of ['elements.js', 'sim.js', 'worldgen.js', 'input.js', 'player.js', 'spells.js', 'synergies.js', 'audio.js', 'creatures.js', 'weather.js', 'game.js', 'replay.js']) {
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
  function floorWorld() {
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
  }

  test('the death recap names an environmental killer', () => {
    floorWorld();
    resetModifiers();
    ambientTemp.fill(15); temp.fill(15);
    player.x = 150; player.y = SIM_H - 12; player.vx = 0; player.vy = 0;
    player.alive = true; player.hp = 20; player.warmth = 60; player.burning = 0;
    player.lastHurt = '';
    input.keys = {};
    for (let x = 148; x < 156; x++)
      for (let y = SIM_H - 13; y < SIM_H - 6; y++) setCell(idx(x, y), E.ACID);
    for (let k = 0; k < 200 && player.alive; k++) updatePlayer();
    assert(!player.alive, 'acid bath survived');
    assert(player.lastHurt === 'dissolved by acid', 'wrong recap: "' + player.lastHurt + '"');
  });

  test('the death recap names a creature killer (elites called out)', () => {
    startRun();
    floorWorld();
    clearCreatures();
    player.x = 150; player.y = SIM_H - 6 - player.h; player.alive = true;
    player.hp = 5; player.hurtCd = 0; player.lastHurt = '';
    const t = CREATURE_TYPES.grub;
    creatures.push({ key: 'grub', x: 150, y: SIM_H - 6 - t.h, vx: 0, vy: 0,
      w: t.w, h: t.h, hp: t.hp, dir: 1, burning: 0, hurtFlash: 0, bob: 0, attackCd: 60 });
    updateCreatures();
    assert(!player.alive, 'grub contact did not finish a 5hp player');
    assert(player.lastHurt === 'slain by a grub', 'wrong recap: "' + player.lastHurt + '"');
    // and a respawn wipes the slate
    spawnPlayer();
    assert(player.lastHurt === '', 'recap not cleared on respawn');
  });

  test('daily runs record a local best (better attempts only)', () => {
    delete dailyBest['daily-2020-01-01'];
    pendingRunSeed = 'daily-2020-01-01';
    startRun();
    run.depth = 3; run.kills = 7;
    recordDaily();
    let b = dailyBest['daily-2020-01-01'];
    assert(b && b.depth === 3 && b.kills === 7, 'daily not recorded: ' + JSON.stringify(b));
    // a worse attempt must not overwrite
    run.depth = 2; run.kills = 20;
    recordDaily();
    b = dailyBest['daily-2020-01-01'];
    assert(b.depth === 3 && b.kills === 7, 'worse attempt overwrote: ' + JSON.stringify(b));
    // same depth, more kills: improves
    run.depth = 3; run.kills = 11;
    recordDaily();
    assert(dailyBest['daily-2020-01-01'].kills === 11, 'kill improvement lost');
    // non-daily seeds never record
    run.seed = 'abc123'; run.depth = 6;
    recordDaily();
    assert(dailyBest['daily-2020-01-01'].depth === 3, 'non-daily seed recorded');
  });

  test('replay share strings round-trip and reject garbage', () => {
    replayBeginRecording('share-me');
    input.keys = { d: true };
    for (let k = 0; k < 50; k++) recordFrame();
    replayNoteMod('Fleetfoot');
    replayRec.active = false;
    const str = JSON.stringify({ v: 1, seed: replayRec.seed,
      words: replayRec.words, counts: replayRec.counts, events: replayRec.events });
    const data = importReplayString(str);
    assert(data && data.seed === 'share-me', 'roundtrip failed');
    assert(data.words.length === replayRec.words.length, 'words mangled');
    assert(data.events.length === 1 && data.events[0].name === 'Fleetfoot', 'events lost');
    assert(importReplayString('not json') === null, 'garbage accepted');
    assert(importReplayString('{"v":2,"seed":"x"}') === null, 'wrong version accepted');
    assert(importReplayString('{"v":1,"seed":"x","words":[1],"counts":[1,2]}') === null,
      'mismatched RLE accepted');
  });

  test('replays record and restore the SELECTED SPELL (wand.sel round-trip)', () => {
    startRun();
    replayBeginRecording('sel-check');
    wand.sel = 2; // fighting with the third spell
    recordFrame();
    const word = replayRec.words[replayRec.words.length - 1];
    assert(((word >> 4) & 15) === 2, 'selection not packed: bits=' + ((word >> 4) & 15));
    replayRec.active = false;
    // playback restores it
    replayArm({ seed: 'sel-check', words: [word], counts: [1], events: [] });
    run.choosing = false; run.dead = false; run.won = false; run.active = true;
    wand.sel = 0; // viewer's wand starts elsewhere
    replayStep();
    assert(wand.sel === 2, 'playback did not restore selection: ' + wand.sel);
    stopReplay();
  });

  test('ending an endless daily records the depth actually cleared', () => {
    delete dailyBest['daily-2020-02-02'];
    pendingRunSeed = 'daily-2020-02-02';
    startRun();
    run.endless = true;
    run.depth = 8;  // overlay is up for depth 8 — depth 7 is what was cleared
    run.kills = 3;
    endEndlessRun();
    const b = dailyBest['daily-2020-02-02'];
    assert(b && b.depth === 7, 'End Run recorded wrong depth: ' + JSON.stringify(b));
    assert(b.won, 'endless daily not marked won');
  });

  test('sandbox builds save and load element-identically', () => {
    generateWorld('build-rt', 2);
    const snap = grid.slice();
    const ambSnap = Array.from(ambientTemp, v => Math.round(v));
    const str = saveBuildString();
    assert(str.length > 50, 'suspiciously tiny build string');
    clearSim();
    assert(loadBuildString(str), 'load failed');
    let diff = 0;
    for (let i = 0; i < CELLS; i++) if (grid[i] !== snap[i]) diff++;
    assert(diff === 0, diff + ' cells differ after round-trip');
    for (let i = 0; i < ambientTemp.length; i++) {
      assert(Math.abs(ambientTemp[i] - ambSnap[i]) <= 1,
        'ambient temp drifted at ' + i);
    }
    // garbage and wrong-shape strings are rejected without touching the grid
    assert(loadBuildString('not a build') === false, 'garbage accepted');
    assert(loadBuildString('{"v":2}') === false, 'wrong version accepted');
    assert(loadBuildString('{"v":1,"w":1,"h":1,"runs":[0,1]}') === false,
      'wrong dimensions accepted');
  });

  test('the first-run hello overlay never fires headless or mid-replay', () => {
    // headless: maybeShowHello must be a no-op (document undefined)
    meta.runs = 0;
    pendingRunSeed = 'hello-1';
    startRun(); // calls maybeShowHello internally
    assert(!run.choosing, 'hello overlay paused a headless run');
  });

  test('depth 2 spawns a LESSER elite: half bulk, same window rhythm', () => {
    pendingRunSeed = 'lesser-1';
    startRun();
    assert(!creatures.some(c => c.elite), 'depth 1 spawned an elite');
    run.depth = 2;
    beginLevel();
    const e = creatures.filter(c => c.elite);
    assert(e.length === 1, 'expected 1 lesser elite at depth 2, got ' + e.length);
    const c = e[0], base = CREATURE_TYPES[c.key];
    assert(c.lesser === true, 'not flagged lesser');
    assert(c.hp === base.hp * 1.5, 'lesser hp wrong: ' + c.hp);
    // same rhythm: the window still opens
    c.eliteCd = 5;
    let opened = false;
    for (let k = 0; k < 40 && !opened; k++) { updateCreatures(); if (c.exposedT > 0) opened = true; }
    assert(opened, 'lesser elite window never opened');
    // full elites at depth 4 are unchanged
    run.depth = 4;
    beginLevel();
    const f = creatures.find(cc => cc.elite);
    assert(f && !f.lesser && f.hp === CREATURE_TYPES[f.key].hp * 3, 'full elite regressed');
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

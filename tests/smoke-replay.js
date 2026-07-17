// Headless smoke test: deterministic run replays + seeded (daily) runs.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'js');
const ctx = vm.createContext({ Math, console, Date });
vm.runInContext('var playMode = true;', ctx); // main.js global, stubbed
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
  function checksum() { let h = 0; for (let i = 0; i < CELLS; i += 5) h = (h * 31 + grid[i]) | 0; return h; }
  // one fixed step, exactly as main.js runs it
  function stepOnce() {
    replayStep();
    applyInput();
    if (!run.choosing) {
      simStep(); updateWeather();
      updatePlayer(); updateCreatures(); updateSpells(); updateGame();
      recordFrame();
    }
  }
  function snap() {
    return player.x.toFixed(2) + ',' + player.y.toFixed(2) + ',' +
           player.hp.toFixed(1) + ',' + wand.mana.toFixed(1) + ',' + checksum();
  }

  test('seeded runs: pendingRunSeed drives the whole run (daily seeds)', () => {
    pendingRunSeed = 'daily-2026-07-12';
    startRun();
    assert(run.seed === 'daily-2026-07-12', 'seed not honored: ' + run.seed);
    const h1 = checksum();
    pendingRunSeed = 'daily-2026-07-12';
    startRun();
    assert(checksum() === h1, 'same daily seed gave a different world');
  });

  test('a recorded run replays exactly (inputs, casts, respawn event)', () => {
    pendingRunSeed = 'replay-e2e';
    startRun();
    player.hp = player.maxHp = 9999; // survive scripted chaos (mirrored below)
    const trace1 = [];
    for (let k = 0; k < 900; k++) {
      // scripted pilot: walk in bursts, hop, jet, cast spark volleys
      input.keys = { d: k % 120 < 70, a: k % 300 > 260, w: k % 90 < 25 };
      input.painting = k % 200 < 12;
      input.curX = Math.max(0, Math.min(SIM_W - 1, Math.round(player.x + 25)));
      input.curY = Math.max(0, Math.min(SIM_H - 1, Math.round(player.y - 4)));
      if (k === 450) { replayNoteRespawn(); spawnPlayer(); } // mimic the R key
      stepOnce();
      if (k % 30 === 29) trace1.push(snap());
    }
    const total = replayRec.counts.reduce((a, b) => a + b, 0);
    assert(total === 900, 'recorded ' + total + ' frames, expected 900');
    assert(replayRec.events.length === 1, 'respawn event not noted');
    const data = { seed: replayRec.seed, words: replayRec.words.slice(),
                   counts: replayRec.counts.slice(), events: replayRec.events.slice() };
    results.push('INFO recording: ' + data.words.length + ' RLE words for 900 frames');

    // --- playback
    const killsBefore = meta.kills, runsBefore = meta.runs;
    replayArm(data);
    pendingRunSeed = data.seed;
    startRun();
    player.hp = player.maxHp = 9999;
    assert(!replayRec.active, 'playback must not record over the replay');
    input.keys = {}; input.painting = false; input.curX = 0; input.curY = 0;
    const trace2 = [];
    for (let k = 0; k < 900; k++) {
      stepOnce();
      if (k % 30 === 29) trace2.push(snap());
    }
    for (let i = 0; i < trace1.length; i++) {
      assert(trace1[i] === trace2[i],
        'diverged at sample ' + i + ': ' + trace1[i] + ' vs ' + trace2[i]);
    }
    assert(meta.kills === killsBefore && meta.runs === runsBefore,
      'replay farmed meta progression');
    stopReplay();
  });

  test('playback stops cleanly when the recording runs out', () => {
    replayArm({ seed: 'stub', words: [0], counts: [3], events: [] });
    pendingRunSeed = 'stub';
    startRun();
    for (let k = 0; k < 6; k++) stepOnce();
    assert(!replayPlay.active, 'playback still active past the recording');
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

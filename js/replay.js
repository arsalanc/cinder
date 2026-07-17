// CINDER — deterministic run replays
// The whole sim is driven by one seeded PRNG, so a run is fully determined
// by its seed plus the player's inputs at each fixed step. We record a
// packed input word per executed sim step (run-length encoded — inputs are
// mostly static) plus sparse events (synergy picks by name, respawns), and
// play it back by overwriting the input state each step. Replays never touch
// meta-progression.
//
// Frame word layout: bit0 left · bit1 right · bit2 up · bit3 painting ·
// bits4-7 selected spell · bits8-16 curX · bits17-24 curY

'use strict';

const replayRec = {
  active: false, seed: '',
  words: [], counts: [],   // RLE pairs
  events: [],              // { f, t: 'mod'|'respawn', name? }
  total: 0,                // executed frames so far
};

const replayPlay = {
  active: false, seed: '',
  words: [], counts: [], events: [],
  wi: 0, left: 0,          // RLE cursor
  frame: 0, evIdx: 0,
};

function _packInputWord() {
  const k = input.keys;
  let w = 0;
  if (k['a'] || k['arrowleft']) w |= 1;
  if (k['d'] || k['arrowright']) w |= 2;
  if (k['w'] || k['arrowup'] || k[' ']) w |= 4;
  if (input.painting) w |= 8;
  w |= (wand.sel & 15) << 4;
  w |= Math.max(0, Math.min(511, input.curX | 0)) << 8;
  w |= Math.max(0, Math.min(255, input.curY | 0)) << 17;
  return w;
}

function replayBeginRecording(seed) {
  if (replayPlay.active) { replayRec.active = false; return; } // never record a replay
  replayRec.active = true;
  replayRec.seed = seed;
  replayRec.words = [];
  replayRec.counts = [];
  replayRec.events = [];
  replayRec.total = 0;
}

// Called once per *executed* sim step while a run is live
function recordFrame() {
  if (!replayRec.active) return;
  const w = _packInputWord();
  const n = replayRec.words.length;
  if (n > 0 && replayRec.words[n - 1] === w) replayRec.counts[n - 1]++;
  else { replayRec.words.push(w); replayRec.counts.push(1); }
  replayRec.total++;
}

function replayNoteMod(name) {
  if (replayRec.active) replayRec.events.push({ f: replayRec.total, t: 'mod', name });
}

function replayNoteRespawn() {
  if (replayRec.active) replayRec.events.push({ f: replayRec.total, t: 'respawn' });
}

function replayEndRecording() {
  if (!replayRec.active) return;
  replayRec.active = false;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('cinder-replay', JSON.stringify({
        v: 1, seed: replayRec.seed,
        words: replayRec.words, counts: replayRec.counts,
        events: replayRec.events,
      }));
    }
  } catch (e) { /* storage full / private mode: replay is session-only */ }
}

// Arm playback from a recording object ({seed, words, counts, events}).
// The caller then starts a run with pendingRunSeed = data.seed.
function replayArm(data) {
  replayPlay.active = true;
  replayPlay.seed = data.seed;
  replayPlay.words = data.words;
  replayPlay.counts = data.counts;
  replayPlay.events = data.events || [];
  replayPlay.wi = 0;
  replayPlay.left = data.counts.length ? data.counts[0] : 0;
  replayPlay.frame = 0;
  replayPlay.evIdx = 0;
}

function loadSavedReplay() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const data = JSON.parse(localStorage.getItem('cinder-replay') || 'null');
    return data && data.v === 1 && data.words ? data : null;
  } catch (e) { return null; }
}

function stopReplay() {
  replayPlay.active = false;
}

// --- share: a replay is just a small JSON blob — copy/paste to share a run --

function exportReplayString() {
  const data = loadSavedReplay();
  return data ? JSON.stringify(data) : null;
}

// Validates and stores a pasted replay; returns the data or null
function importReplayString(str) {
  try {
    const data = JSON.parse(str);
    if (!data || data.v !== 1 || typeof data.seed !== 'string' ||
        !Array.isArray(data.words) || !Array.isArray(data.counts) ||
        data.words.length !== data.counts.length) return null;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('cinder-replay', JSON.stringify({
          v: 1, seed: data.seed, words: data.words, counts: data.counts,
          events: data.events || [],
        }));
      }
    } catch (e) { /* storage full: playback still works this session */ }
    return data;
  } catch (e) { return null; }
}

// Called at the top of every fixed step (before applyInput / sim updates).
// Overwrites live input from the recording; auto-picks recorded synergies
// while the choice overlay is up (steps don't advance during choosing, so
// event frames line up exactly).
function replayStep() {
  if (!replayPlay.active) return;
  if (run.dead || run.won || !run.active) { stopReplay(); return; }

  const ev = replayPlay.events[replayPlay.evIdx];
  if (run.choosing) {
    if (ev && ev.t === 'mod' && ev.f === replayPlay.frame) {
      replayPlay.evIdx++;
      const mod = MODIFIERS.find(m => m.name === ev.name);
      if (mod) { chooseModifier(mod); return; }
    }
    stopReplay(); // recording has no pick for this overlay: bail out safely
    return;
  }
  if (ev && ev.t === 'respawn' && ev.f === replayPlay.frame) {
    replayPlay.evIdx++;
    spawnPlayer();
  }

  if (replayPlay.left <= 0) { stopReplay(); return; } // recording exhausted

  const w = replayPlay.words[replayPlay.wi];
  input.keys = { a: !!(w & 1), d: !!(w & 2), w: !!(w & 4) };
  input.painting = !!(w & 8);
  wand.sel = Math.min((w >> 4) & 15, wand.spells.length - 1);
  input.curX = (w >> 8) & 511;
  input.curY = (w >> 17) & 255;

  if (--replayPlay.left <= 0 && ++replayPlay.wi < replayPlay.counts.length) {
    replayPlay.left = replayPlay.counts[replayPlay.wi];
  }
  replayPlay.frame++;
}

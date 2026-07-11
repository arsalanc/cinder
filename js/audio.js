// CINDER — sound effects
// All procedural WebAudio (oscillators + filtered noise): zero asset files,
// so file:// keeps working. The context unlocks on the first user gesture
// (browser requirement). Headless-safe: playSfx no-ops without a window.

'use strict';

let audioCtx = null;
let audioMuted = false;
let masterGain = null;
let noiseBuf = null;
const _sfxLast = {};

// per-sound minimum interval (ms) so explosion chains don't stack 50 sounds
const SFX_THROTTLE = {
  explosion: 120, hit: 60, squish: 80, hurt: 150,
  zap: 40, spray: 45, dig: 60, lob: 80, spit: 60, jet: 110, flame: 70, arc: 90,
};

function initAudio() {
  if (audioCtx || typeof window === 'undefined') return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.25;
  masterGain.connect(audioCtx.destination);
  // shared 1s noise buffer
  noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
}

function toggleMute() {
  audioMuted = !audioMuted;
  return audioMuted;
}

function _env(dur, gain, delay = 0) {
  const g = audioCtx.createGain();
  const t = audioCtx.currentTime + delay;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  g.connect(masterGain);
  return g;
}

function _tone(type, f0, f1, dur, gain, delay = 0) {
  const o = audioCtx.createOscillator();
  const t = audioCtx.currentTime + delay;
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  o.connect(_env(dur, gain, delay));
  o.start(t);
  o.stop(t + dur);
}

function _noise(dur, freq, gain, type = 'lowpass', delay = 0) {
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = audioCtx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  src.connect(f);
  f.connect(_env(dur, gain, delay));
  const t = audioCtx.currentTime + delay;
  src.start(t, Math.random());
  src.stop(t + dur);
}

const SFX = {
  zap()       { _tone('square', 900, 150, 0.09, 0.5); },
  jet()       { _noise(0.14, 800, 0.12, 'bandpass'); },
  flame()     { _noise(0.1, 500, 0.2); },
  arc()       { _tone('square', 1600, 300, 0.08, 0.35); _noise(0.05, 3200, 0.15, 'highpass'); },
  spray()     { _noise(0.06, 1400, 0.25, 'bandpass'); },
  dig()       { _noise(0.12, 350, 0.7); },
  lob()       { _noise(0.16, 700, 0.3, 'bandpass'); },
  spit()      { _tone('sawtooth', 300, 90, 0.1, 0.4); },
  explosion() { _noise(0.45, 420, 1.2); _tone('sine', 75, 40, 0.4, 0.9); },
  hit()       { _tone('triangle', 420, 200, 0.06, 0.4); },
  squish()    { _noise(0.1, 260, 0.6); _tone('sine', 180, 60, 0.1, 0.3); },
  hurt()      { _tone('sawtooth', 220, 70, 0.18, 0.5); },
  death()     { _tone('sawtooth', 160, 35, 0.8, 0.6); _noise(0.6, 200, 0.4); },
  portal()    { _tone('sine', 660, 660, 0.2, 0.4); _tone('sine', 990, 990, 0.25, 0.4, 0.1); },
  shard()     { _tone('sine', 880, 1320, 0.12, 0.35); _tone('sine', 1320, 1760, 0.15, 0.25, 0.08); },
  pick()      { _tone('sine', 520, 780, 0.15, 0.35); },
};

function playSfx(name) {
  if (audioMuted || !audioCtx || typeof window === 'undefined') return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const now = Date.now();
  const throttle = SFX_THROTTLE[name] || 70;
  if (_sfxLast[name] && now - _sfxLast[name] < throttle) return;
  _sfxLast[name] = now;
  const fn = SFX[name];
  if (fn) fn();
}

// let the sim announce explosions without knowing about audio
if (typeof simHooks !== 'undefined') {
  simHooks.explosion = () => playSfx('explosion');
}

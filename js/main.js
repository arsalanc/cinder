// CINDER — bootstrap, UI, main loop

'use strict';

// Elements shown in the palette, in order (1-9 keyboard shortcuts follow this)
const PALETTE = [
  E.SAND, E.WATER, E.OIL, E.WOOD, E.PLANT, E.FIRE,
  E.ACID, E.LAVA, E.GUNPOWDER, E.ICE, E.ELEC,
  E.SEED, E.ASH, E.BUG, E.PRED, E.SNOW,
  E.METAL, E.GLASS, E.HYDROGEN, E.FUNGUS, E.FISH,
  E.MOTH, E.STONE, E.WALL, E.EMPTY,
];

let paused = false;
let playMode = false;
const isTouch = typeof matchMedia !== 'undefined' &&
  (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window);
let hudBrush, hudFps, hudCells, hudBiome, pauseBtn, seedInput;
let hpFill, hudStatus, manaFill, fuelFill;

function togglePlayMode() {
  playMode = !playMode;
  document.getElementById('panel-play').style.display = playMode ? 'flex' : 'none';
  document.getElementById('panel-create').style.display = playMode ? 'none' : 'flex';
  document.getElementById('tab-play').classList.toggle('active', playMode);
  document.getElementById('tab-create').classList.toggle('active', !playMode);
  document.getElementById('hotbar').style.display = playMode ? 'flex' : 'none';
  document.getElementById('touch').style.display = (playMode && isTouch) ? 'block' : 'none';
  if (playMode) {
    startRun();
    updateSpellHUD();
  } else {
    run.active = false;
    clearCreatures();
    hideOverlay();
    resetModifiers(); // sandbox gets pristine element behavior back
  }
}

function randomSeed() {
  return Math.random().toString(36).slice(2, 8);
}

function doGenerate() {
  let s = seedInput.value.trim();
  if (!s) s = randomSeed();
  seedInput.value = s;
  generateWorld(s);
  if (playMode) {
    spawnPlayer();
    if (run.active) {
      placePortal(); // manual regen mid-run still needs an exit
      spawnCreatures(run.depth); // ...and fresh creatures for the new layout
    }
  }
}

function togglePause() {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
}

function selectElement(id) {
  input.element = id;
  document.querySelectorAll('.palette button').forEach(btn => {
    btn.classList.toggle('selected', Number(btn.dataset.id) === id);
  });
  updateHUD();
}

function updateHUD() {
  const eff = effectiveBrush();
  hudBrush.textContent = input.brush + (eff !== input.brush ? ` → ${eff}` : '');
}

function updateZoomHUD() {
  const z = sandboxZoom;
  document.getElementById('zoom-label').textContent =
    (Number.isInteger(z) ? z : z.toFixed(1)) + '×';
  updateHUD(); // effective brush changes with zoom
}

function cssColor(id) {
  const c = DEFS[id].color;
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function buildPalette() {
  const box = document.getElementById('palette');
  PALETTE.forEach((id, n) => {
    const btn = document.createElement('button');
    btn.dataset.id = id;
    btn.title = DEFS[id].name + (n < 9 ? ` (${n + 1})` : '');
    btn.innerHTML = `<span class="swatch" style="background:${cssColor(id)}"></span>` +
                    `<span class="pname">${DEFS[id].name}</span>`;
    btn.addEventListener('click', () => selectElement(id));
    box.appendChild(btn);
  });
}

function main() {
  const canvas = document.getElementById('sim');
  canvas.width = SIM_W * 3;
  canvas.height = SIM_H * 3;

  hudBrush = document.getElementById('hud-brush');
  hudFps = document.getElementById('hud-fps');
  hudCells = document.getElementById('hud-cells');
  hudBiome = document.getElementById('hud-biome');
  pauseBtn = document.getElementById('btn-pause');
  seedInput = document.getElementById('seed');
  hpFill = document.getElementById('hp-fill');
  manaFill = document.getElementById('mana-fill');
  fuelFill = document.getElementById('fuel-fill');
  hudStatus = document.getElementById('hud-status');
  document.getElementById('tab-play').addEventListener('click', () => {
    if (!playMode) togglePlayMode();
  });
  document.getElementById('tab-create').addEventListener('click', () => {
    if (playMode) togglePlayMode();
  });
  document.getElementById('overlay-action').addEventListener('click', startRun);
  const soundBtn = document.getElementById('btn-sound');
  soundBtn.addEventListener('click', () => {
    soundBtn.textContent = toggleMute() ? 'Sound: Off' : 'Sound: On';
  });
  // browsers require a user gesture before audio can start
  window.addEventListener('pointerdown', initAudio, { once: true });
  window.addEventListener('keydown', initAudio, { once: true });

  if (isTouch) {
    // tighter camera so cells are readable on a small screen
    VIEW_W = 120; VIEW_H = 75;
    const bindTouch = (id, key) => {
      const el = document.getElementById(id);
      const set = v => e => { e.preventDefault(); input.keys[key] = v; };
      el.addEventListener('pointerdown', set(true));
      el.addEventListener('pointerup', set(false));
      el.addEventListener('pointercancel', set(false));
      el.addEventListener('pointerleave', set(false));
    };
    bindTouch('tleft', 'a');
    bindTouch('tright', 'd');
    bindTouch('tjump', 'w'); // hold = jetpack/climb/swim, same as W
  }

  buildPalette();
  initRenderer(canvas);
  initInput(canvas);
  selectElement(E.SAND);
  updateHUD();
  updateRunHUD(); // shows persistent meta stats even before a run
  doGenerate(); // start on a procedural world
  if (location.hash === '#play') togglePlayMode(); // dev hook: straight into a run
  if (location.hash === '#zoom') setSandboxZoom(4); // dev hook: zoomed sandbox view

  pauseBtn.addEventListener('click', togglePause);
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (playMode) togglePlayMode(); // leaving for sandbox ends the run
    clearSim();
  });
  document.getElementById('btn-reset').addEventListener('click', () => {
    if (playMode) togglePlayMode();
    seedScene();
  });
  document.getElementById('btn-gen').addEventListener('click', () => {
    seedInput.value = ''; // blank -> fresh random seed
    doGenerate();
  });
  document.getElementById('btn-zoom-in').addEventListener('click', () => setSandboxZoom(sandboxZoom * 1.5));
  document.getElementById('btn-zoom-out').addEventListener('click', () => setSandboxZoom(sandboxZoom / 1.5));
  seedInput.addEventListener('keydown', e => {
    e.stopPropagation(); // don't trigger sim shortcuts while typing a seed
    if (e.key === 'Enter') { doGenerate(); seedInput.blur(); }
  });

  let frames = 0;
  let lastFpsTime = performance.now();

  // Fixed timestep: the sim always runs at 60 steps/s regardless of the
  // display's refresh rate (a 144Hz monitor gets 144 renders but still 60
  // sim steps — otherwise the game speed follows the monitor).
  const SIM_DT = 1000 / 60;
  let simAccum = 0;
  let lastTime = performance.now();

  function loop(now) {
    simAccum += now - lastTime;
    lastTime = now;
    // returning from a background tab: don't fast-forward the backlog
    if (simAccum > 250) simAccum = 250;

    while (simAccum >= SIM_DT) {
      simAccum -= SIM_DT;
      applyInput();          // painting/casting tick at sim rate, even paused
      if (!paused && !run.choosing) {
        simStep();
        updateWeather();
        if (playMode) {
          updatePlayer();
          updateCreatures();
          updateSpells();
          updateGame();
        }
      }
    }
    updateCamera();
    const count = renderSim();
    if (playMode) drawPortal();
    if (playMode) drawCreatures();
    if (playMode) drawProjectiles();
    if (playMode && player.alive) drawPlayer();
    if (playMode) drawBossBar();
    if (playMode) {
      hpFill.style.width = (player.hp / player.maxHp * 100) + '%';
      manaFill.style.width = (wand.mana / wand.maxMana * 100) + '%';
      fuelFill.style.width = (player.fuel / player.maxFuel * 100) + '%';
      updateHotbar();
      hudStatus.textContent = !player.alive ? 'DEAD — R to respawn'
        : run.portalHint ? (bossAlive() ? 'dormant — slay the guardian' : 'dormant — collect ◆')
        : player.burning > 0 ? 'BURNING'
        : player.inLiquid ? 'swimming' : '';
    }

    frames++;
    if (now - lastFpsTime >= 500) {
      hudFps.textContent = Math.round(frames * 1000 / (now - lastFpsTime));
      hudCells.textContent = count;
      const tx = Math.max(0, Math.min(SIM_W - 1, input.curX | 0));
      const ty = Math.max(0, Math.min(SIM_H - 1, input.curY | 0));
      hudBiome.textContent = (biomeNameAt(input.curX, input.curY) || '–') +
        ' · ' + Math.round(tempAt(tx, ty)) + '°' +
        (weather.mode !== 'clear' ? ' · ' + weather.mode : '');
      frames = 0;
      lastFpsTime = now;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

window.addEventListener('DOMContentLoaded', main);

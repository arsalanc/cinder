// CINDER — bootstrap, UI, main loop

'use strict';

// Elements shown in the palette, in order (1-9 keyboard shortcuts follow this)
const PALETTE = [
  E.SAND, E.WATER, E.OIL, E.WOOD, E.PLANT, E.FIRE,
  E.ACID, E.LAVA, E.GUNPOWDER, E.ICE, E.ELEC, E.STONE, E.WALL,
];

let paused = false;
let playMode = false;
let hudBrush, hudFps, hudCells, hudBiome, pauseBtn, seedInput;
let hpRow, hpFill, hudStatus, manaFill, fuelFill;

function togglePlayMode() {
  playMode = !playMode;
  document.getElementById('btn-play').textContent = playMode ? 'Exit Run' : 'Start Run';
  hpRow.style.display = playMode ? 'flex' : 'none';
  document.getElementById('mana-row').style.display = playMode ? 'flex' : 'none';
  document.getElementById('fuel-row').style.display = playMode ? 'flex' : 'none';
  document.getElementById('hotbar').style.display = playMode ? 'flex' : 'none';
  document.getElementById('mods').style.display = playMode ? 'block' : 'none';
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
  hudBrush.textContent = input.brush;
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
    const key = n < 9 ? `${n + 1}` : '';
    btn.innerHTML = `<span class="swatch" style="background:${cssColor(id)}"></span>` +
                    `${DEFS[id].name}${key ? ` <kbd>${key}</kbd>` : ''}`;
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
  hpRow = document.getElementById('hp-row');
  hpFill = document.getElementById('hp-fill');
  manaFill = document.getElementById('mana-fill');
  fuelFill = document.getElementById('fuel-fill');
  hudStatus = document.getElementById('hud-status');
  document.getElementById('btn-play').addEventListener('click', togglePlayMode);
  document.getElementById('overlay-action').addEventListener('click', startRun);
  const soundBtn = document.getElementById('btn-sound');
  soundBtn.addEventListener('click', () => {
    soundBtn.textContent = toggleMute() ? 'Sound: Off' : 'Sound: On';
  });
  // browsers require a user gesture before audio can start
  window.addEventListener('pointerdown', initAudio, { once: true });
  window.addEventListener('keydown', initAudio, { once: true });

  buildPalette();
  initRenderer(canvas);
  initInput(canvas);
  selectElement(E.SAND);
  updateHUD();
  updateRunHUD(); // shows persistent meta stats even before a run
  doGenerate(); // start on a procedural world

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
  seedInput.addEventListener('keydown', e => {
    e.stopPropagation(); // don't trigger sim shortcuts while typing a seed
    if (e.key === 'Enter') { doGenerate(); seedInput.blur(); }
  });

  let frames = 0;
  let lastFpsTime = performance.now();

  function loop() {
    applyInput();          // painting works even while paused
    if (!paused && !run.choosing) {
      simStep();
      if (playMode) {
        updatePlayer();
        updateCreatures();
        updateSpells();
        updateGame();
      }
    }
    updateCamera();
    const count = renderSim();
    if (playMode) drawPortal();
    if (playMode) drawCreatures();
    if (playMode) drawProjectiles();
    if (playMode && player.alive) drawPlayer();
    if (playMode) {
      hpFill.style.width = (player.hp / player.maxHp * 100) + '%';
      manaFill.style.width = (wand.mana / wand.maxMana * 100) + '%';
      fuelFill.style.width = (player.fuel / player.maxFuel * 100) + '%';
      updateHotbar();
      hudStatus.textContent = !player.alive ? 'DEAD — R to respawn'
        : run.portalHint ? 'dormant — collect ◆'
        : player.burning > 0 ? 'BURNING'
        : player.inLiquid ? 'swimming' : '';
    }

    frames++;
    const now = performance.now();
    if (now - lastFpsTime >= 500) {
      hudFps.textContent = Math.round(frames * 1000 / (now - lastFpsTime));
      hudCells.textContent = count;
      hudBiome.textContent = biomeNameAt(input.curX, input.curY) || '–';
      frames = 0;
      lastFpsTime = now;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

window.addEventListener('DOMContentLoaded', main);

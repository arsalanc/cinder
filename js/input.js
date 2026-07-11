// CINDER — input layer
// Pointer painting (with line interpolation so fast strokes don't gap),
// brush size, element selection, keyboard shortcuts.

'use strict';

const input = {
  element: E.SAND,
  brush: 4,
  painting: false,
  erasing: false,
  lastX: -1,
  lastY: -1,
  curX: -1,
  curY: -1,
  keys: {},   // held-key state, read by the player each frame
};

function canvasToCell(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = (camera.x + (clientX - rect.left) / rect.width * camera.w) | 0;
  const y = (camera.y + (clientY - rect.top) / rect.height * camera.h) | 0;
  return [x, y];
}

// paint a line of circles between two points (Bresenham-ish stepping)
function paintStroke(x0, y0, x1, y1, id) {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + dx * s / steps);
    const y = Math.round(y0 + dy * s / steps);
    paintCircle(x, y, input.brush, id);
  }
}

function initInput(canvas) {
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('pointerdown', e => {
    if (playMode && e.button === 2) { cycleSpell(1); return; } // rmb: next spell
    canvas.setPointerCapture(e.pointerId);
    input.painting = true;
    input.erasing = e.button === 2;
    const [x, y] = canvasToCell(canvas, e.clientX, e.clientY);
    input.lastX = input.curX = x;
    input.lastY = input.curY = y;
  });

  canvas.addEventListener('pointermove', e => {
    const [x, y] = canvasToCell(canvas, e.clientX, e.clientY);
    input.curX = x;
    input.curY = y;
  });

  const stop = () => { input.painting = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (playMode) { cycleSpell(e.deltaY < 0 ? -1 : 1); return; }
    input.brush = Math.max(1, Math.min(24, input.brush + (e.deltaY < 0 ? 1 : -1)));
    updateHUD();
  }, { passive: false });

  window.addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    input.keys[key] = true;
    if (key === ' ' || key.startsWith('arrow')) e.preventDefault();

    if (e.key === ' ') { if (!playMode) togglePause(); } // in play mode space = jump
    else if (key === 'p') { togglePause(); }
    else if (key === 'c') { if (!playMode) clearSim(); } // sandbox-only
    else if (e.key === 'Enter') { if (!run.choosing) togglePlayMode(); }
    else if (key === 'm') { cameraFollow = !cameraFollow; }
    else if (key === 'r') {
      if (playMode) { if (player.alive) spawnPlayer(); else startRun(); }
    }
    else if (e.key === '[') { input.brush = Math.max(1, input.brush - 1); updateHUD(); }
    else if (e.key === ']') { input.brush = Math.min(24, input.brush + 1); updateHUD(); }
    else {
      const n = parseInt(e.key, 10);
      if (!isNaN(n)) {
        if (playMode) selectSpell(n - 1);
        else if (PALETTE[n - 1] !== undefined) selectElement(PALETTE[n - 1]);
      }
    }
  });
  window.addEventListener('keyup', e => {
    input.keys[e.key.toLowerCase()] = false;
  });
  window.addEventListener('blur', () => { input.keys = {}; });
}

// Called every frame from the main loop. In play mode the held mouse casts
// the wand (rate-limited by spell cooldown); free painting is sandbox-only.
function applyInput() {
  if (!input.painting) return;
  if (playMode) {
    if (run.active && !run.choosing && player.alive) {
      castSelectedSpell(input.curX, input.curY);
    }
    return;
  }
  const id = input.erasing ? E.EMPTY : input.element;
  paintStroke(input.lastX, input.lastY, input.curX, input.curY, id);
  input.lastX = input.curX;
  input.lastY = input.curY;
}

// CINDER — renderer
// Writes the grid into an ImageData buffer at sim resolution, then scales it
// up onto the display canvas with smoothing off for crisp pixels.

'use strict';

let displayCanvas, displayCtx, bufferCanvas, bufferCtx, imageData, pixels;

// Camera: the sub-rect of the sim (in cell coords) shown on the display
// canvas. Sandbox mode shows the whole grid; play mode follows the player
// with a zoomed window (M toggles back to the full map).
const camera = { x: 0, y: 0, w: SIM_W, h: SIM_H };
let cameraFollow = true;
let VIEW_W = 160, VIEW_H = 100; // main.js tightens this on touch devices

function updateCamera() {
  const follow = typeof playMode !== 'undefined' && playMode && cameraFollow && player.alive;
  const tw = follow ? VIEW_W : SIM_W;
  const th = follow ? VIEW_H : SIM_H;
  const tx = follow ? Math.max(0, Math.min(SIM_W - tw, player.x + player.w / 2 - tw / 2)) : 0;
  const ty = follow ? Math.max(0, Math.min(SIM_H - th, player.y + player.h / 2 - th / 2)) : 0;
  // smooth pan + zoom
  camera.w += (tw - camera.w) * 0.18;
  camera.h += (th - camera.h) * 0.18;
  camera.x += (tx - camera.x) * 0.18;
  camera.y += (ty - camera.y) * 0.18;
  // keep the (possibly mid-zoom) window inside the sim
  camera.x = Math.max(0, Math.min(SIM_W - camera.w, camera.x));
  camera.y = Math.max(0, Math.min(SIM_H - camera.h, camera.y));
}

function initRenderer(canvas) {
  displayCanvas = canvas;
  displayCtx = canvas.getContext('2d');
  displayCtx.imageSmoothingEnabled = false;

  bufferCanvas = document.createElement('canvas');
  bufferCanvas.width = SIM_W;
  bufferCanvas.height = SIM_H;
  bufferCtx = bufferCanvas.getContext('2d');
  imageData = bufferCtx.createImageData(SIM_W, SIM_H);
  pixels = imageData.data;
}

// fire color ramp: white-hot core -> orange -> deep red as life runs out
function fireColor(l, out) {
  if (l > 60)      { out[0] = 255; out[1] = 235; out[2] = 160; }
  else if (l > 30) { out[0] = 255; out[1] = 150 + (Math.random() * 60 | 0); out[2] = 30; }
  else             { out[0] = 210 + (Math.random() * 45 | 0); out[1] = 60 + (Math.random() * 60 | 0); out[2] = 10; }
}

const _rgb = [0, 0, 0];

function renderSim() {
  let count = 0;
  for (let i = 0, p = 0; i < CELLS; i++, p += 4) {
    const id = grid[i];
    const def = DEFS[id];
    let r, g, b;
    if (id === E.FIRE) {
      fireColor(life[i], _rgb);
      r = _rgb[0]; g = _rgb[1]; b = _rgb[2];
    } else if (id === E.ELEC) {
      // crackle: white-hot flicker
      const f = Math.random();
      r = 255; g = 240 + (f * 15) | 0; b = f < 0.35 ? 255 : 120;
    } else {
      // per-cell shade noise, centered around the base color
      const v = def.colorVar ? ((shade[i] / 255 - 0.5) * def.colorVar) | 0 : 0;
      r = def.color[0] + v;
      g = def.color[1] + v;
      b = def.color[2] + v;
      if (id === E.LAVA) {
        // lava pulses
        const pulse = Math.sin((simFrame + shade[i]) * 0.1) * 20;
        r += pulse; g += pulse * 0.4;
      } else if (id === E.EWATER) {
        // live water arcs and shimmers
        const pulse = Math.sin((simFrame + shade[i]) * 0.35) * 45;
        g += pulse; b += pulse * 0.6;
        if (Math.random() < 0.03) { r = 255; g = 255; b = 255; }
      } else if (id === E.FUNGUS) {
        // bioluminescent breathing glow
        const pulse = (Math.sin((simFrame + shade[i] * 4) * 0.03) + 1) * 18;
        r += pulse * 0.4; b += pulse;
      }
    }
    pixels[p]     = r < 0 ? 0 : r > 255 ? 255 : r;
    pixels[p + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    pixels[p + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    pixels[p + 3] = 255;
    if (id !== E.EMPTY) count++;
  }
  bufferCtx.putImageData(imageData, 0, 0);
  displayCtx.imageSmoothingEnabled = false;
  displayCtx.drawImage(bufferCanvas,
    camera.x, camera.y, camera.w, camera.h,
    0, 0, displayCanvas.width, displayCanvas.height);
  return count; // non-empty cell count, for the stats readout
}

// CINDER — simulation core
// Cell grid + per-frame update. Movement rules live here (switching on the
// element's archetype from elements.js); chemistry lives in the REACTIONS
// table. The sim knows nothing about rendering or input.

'use strict';

const SIM_W = 320;
const SIM_H = 200;
const CELLS = SIM_W * SIM_H;

// Seeded PRNG for everything that touches sim state (mulberry32). Rendering
// keeps Math.random; the sim, worldgen, player, spells, and creatures all
// draw from this stream so a seeded level evolves identically every time.
let _randState = 1;
function seedSim(seed) { _randState = (seed | 0) || 1; }
function rand() {
  _randState |= 0; _randState = (_randState + 0x6D2B79F5) | 0;
  let t = Math.imul(_randState ^ (_randState >>> 15), 1 | _randState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Optional hooks the game layer can attach to (e.g. explosion sound)
const simHooks = { explosion: null };

// Cell state (structure-of-arrays for speed)
const grid    = new Uint8Array(CELLS);   // element id
const shade   = new Uint8Array(CELLS);   // per-cell color noise, set on spawn
const life    = new Uint16Array(CELLS);  // countdown for fire/gases
const updated = new Uint8Array(CELLS);   // frame-parity flag (no double moves)

let simClock = 0;   // flips 0/1 each step
let simFrame = 0;

// --- temperature field ------------------------------------------------------
// A coarse grid (one cell per 4x4 sim cells) of degrees-C-ish values.
// Three drivers: biome ambient baselines (set by worldgen), heat/cold emitted
// by elements (fire, lava, ice, snow), and diffusion between cells. Phase
// changes read it: water freezes below 0, snow/ice melt when warm, lava skins
// to stone in deep cold, evaporation scales with warmth, and weather picks
// rain vs snow per column from the sky temperature.

const TEMP_W = SIM_W >> 2;
const TEMP_H = SIM_H >> 2;
const TEMP_CELLS = TEMP_W * TEMP_H;
const TEMP_DEFAULT = 15;

const temp        = new Float32Array(TEMP_CELLS).fill(TEMP_DEFAULT);
const ambientTemp = new Float32Array(TEMP_CELLS).fill(TEMP_DEFAULT);
const _tempPrev   = new Float32Array(TEMP_CELLS);
let ambientChill = 0; // global offset, driven by weather (cold snaps)

// per-element heat emission into the local temp cell, per temp update
const HEAT = new Float32Array(NUM_ELEMENTS);
HEAT[E.FIRE]  =  1.4;
HEAT[E.LAVA]  =  2.2;
HEAT[E.STEAM] =  0.25;
HEAT[E.ELEC]  =  0.3;
// cold emission is much gentler than heat: a solid ice block chills its own
// air toward freezing, but can't out-refrigerate a lava pool one cell over
HEAT[E.ICE]   = -0.15;
HEAT[E.SNOW]  = -0.1;

function tempAt(x, y) { return temp[(y >> 2) * TEMP_W + (x >> 2)]; }

// Runs every 4th sim step (deterministic — pure arithmetic, no rand).
function updateTemperature() {
  // 1. emission: hot/cold elements push their temp cell
  for (let y = 0; y < SIM_H; y++) {
    const row = y * SIM_W, trow = (y >> 2) * TEMP_W;
    for (let x = 0; x < SIM_W; x++) {
      const h = HEAT[grid[row + x]];
      if (h !== 0) temp[trow + (x >> 2)] += h;
    }
  }
  // 2. diffusion + relaxation toward the biome ambient (plus weather chill)
  _tempPrev.set(temp);
  for (let ty = 0; ty < TEMP_H; ty++) {
    const trow = ty * TEMP_W;
    for (let tx = 0; tx < TEMP_W; tx++) {
      const i = trow + tx;
      const s = _tempPrev[i];
      let sum = 0, n = 0;
      if (tx > 0)          { sum += _tempPrev[i - 1];      n++; }
      if (tx + 1 < TEMP_W) { sum += _tempPrev[i + 1];      n++; }
      if (ty > 0)          { sum += _tempPrev[i - TEMP_W]; n++; }
      if (ty + 1 < TEMP_H) { sum += _tempPrev[i + TEMP_W]; n++; }
      let t = s + (sum / n - s) * 0.15 + (ambientTemp[i] + ambientChill - s) * 0.04;
      if (t < -50) t = -50; else if (t > 150) t = 150;
      temp[i] = t;
    }
  }
}

// While true (during world generation), only movement runs — no reactions,
// ignition, or gas decay — so liquids/powders settle without side effects.
let worldSettling = false;

// Queue of pending explosions (so chains propagate without deep recursion)
const explosionQueue = [];
let explosionScale = 1; // run modifiers (Demolitionist) scale this

function idx(x, y) { return y * SIM_W + x; }

function setCell(i, id) {
  grid[i] = id;
  shade[i] = (rand() * 256) | 0;
  life[i] = LIFE_MAX[id]
    ? LIFE_MIN[id] + ((rand() * (LIFE_MAX[id] - LIFE_MIN[id])) | 0)
    : 0;
  updated[i] = simClock;
}

function swapCells(i, j) {
  const g = grid[i]; grid[i] = grid[j]; grid[j] = g;
  const s = shade[i]; shade[i] = shade[j]; shade[j] = s;
  const l = life[i]; life[i] = life[j]; life[j] = l;
  updated[i] = simClock;
  updated[j] = simClock;
}

// Can a mover with the given density push into cell j?
// (empty always; lighter liquids/gases get displaced)
function canDisplace(density, j) {
  const t = grid[j];
  if (t === E.EMPTY) return true;
  const tt = TYPE[t];
  return (tt === T.LIQUID || tt === T.GAS) && DENSITY[t] < density;
}

// --- movement archetypes -------------------------------------------------

function stepPowder(i, x, y, id) {
  // seeds that never find water eventually rot into ash
  if (id === E.SEED && rand() < 0.0004) { setCell(i, E.ASH); return; }
  // snow melts when the air is warm — and keeps forever in the cold
  if (id === E.SNOW && !worldSettling) {
    const ct = tempAt(x, y);
    if (ct > 0 && rand() < ct * 0.00003) { setCell(i, E.WATER); return; }
  }
  const d = DENSITY[id];
  if (y + 1 < SIM_H) {
    const below = i + SIM_W;
    if (canDisplace(d, below)) {
      // sink slower through liquids than through air
      if (grid[below] === E.EMPTY || rand() < 0.45) { swapCells(i, below); return; }
      return;
    }
    const dir = rand() < 0.5 ? 1 : -1;
    for (let k = 0; k < 2; k++) {
      const dx = k === 0 ? dir : -dir;
      const nx = x + dx;
      if (nx >= 0 && nx < SIM_W && canDisplace(d, below + dx)) {
        swapCells(i, below + dx);
        return;
      }
    }
  }
}

function stepLiquid(i, x, y, id) {
  // transient liquids: electrified water relaxes back to plain water
  if (life[i] > 0 && --life[i] === 0) {
    setCell(i, id === E.EWATER ? E.WATER : E.EMPTY);
    return;
  }
  if (id === E.WATER && !worldSettling && y > 0) {
    const ct = tempAt(x, y);
    // freeze from exposed surfaces downward in cold regions
    if (ct < 0) {
      const up = grid[i - SIM_W];
      if ((up === E.EMPTY || up === E.ICE || up === E.SNOW) &&
          rand() < Math.min(0.05, -ct * 0.002)) {
        // supported water freezes solid; a droplet falling through cold air
        // crystallizes into snow and keeps falling (no ice hanging in the sky)
        const inAir = y + 1 < SIM_H && grid[i + SIM_W] === E.EMPTY;
        setCell(i, inAir ? E.SNOW : E.ICE);
        return;
      }
    }
    // exposed surfaces evaporate, faster the warmer it is (~old flat rate at
    // temperate ambient; the steam mostly condenses back, closing the cycle)
    else if (grid[i - SIM_W] === E.EMPTY && rand() < ct * 0.00001) {
      setCell(i, E.STEAM);
      return;
    }
  }
  // lava exposed to deep cold skins over into stone
  if (id === E.LAVA && !worldSettling && tempAt(x, y) < 5 && rand() < 0.008) {
    setCell(i, E.STONE);
    return;
  }
  // live water conducts a DECAYING charge into neighboring water — each hop
  // loses charge, so a strike electrifies a radius and then dies out
  if (id === E.EWATER && life[i] > 8) {
    for (let n = 0; n < 4; n++) {
      let j = -1;
      if (n === 0 && y > 0) j = i - SIM_W;
      else if (n === 1 && y + 1 < SIM_H) j = i + SIM_W;
      else if (n === 2 && x > 0) j = i - 1;
      else if (n === 3 && x + 1 < SIM_W) j = i + 1;
      if (j >= 0 && grid[j] === E.WATER && rand() < 0.6) {
        setCell(j, E.EWATER);
        life[j] = life[i] - 6;
      }
    }
  }
  const d = DENSITY[id];
  if (y + 1 < SIM_H) {
    const below = i + SIM_W;
    if (canDisplace(d, below)) { swapCells(i, below); return; }
    const dir = rand() < 0.5 ? 1 : -1;
    for (let k = 0; k < 2; k++) {
      const dx = k === 0 ? dir : -dir;
      const nx = x + dx;
      if (nx >= 0 && nx < SIM_W && canDisplace(d, below + dx)) {
        swapCells(i, below + dx);
        return;
      }
    }
  }
  // spread horizontally toward the furthest reachable cell
  const disp = DISPERSION[id];
  const dir = rand() < 0.5 ? 1 : -1;
  let target = -1;
  for (let k = 1; k <= disp; k++) {
    const nx = x + dir * k;
    if (nx < 0 || nx >= SIM_W) break;
    const j = i + dir * k;
    if (grid[j] === E.EMPTY) { target = j; }
    else if (!canDisplace(d, j)) break;
    else { target = j; break; } // displace one lighter cell, stop
  }
  if (target >= 0) swapCells(i, target);
}

function stepGas(i, x, y, id) {
  // steam hitting cold air condenses immediately (fog over ice caves)
  if (id === E.STEAM && !worldSettling && tempAt(x, y) < 0 && rand() < 0.03) {
    setCell(i, E.WATER);
    return;
  }
  // lifetime
  if (life[i] > 0 && --life[i] === 0) {
    // steam mostly condenses back to water (a tight water cycle keeps
    // ecosystems from slowly draining dry); smoke just fades
    setCell(i, id === E.STEAM && rand() < 0.8 ? E.WATER : E.EMPTY);
    return;
  }
  if (id === E.ELEC) {
    // discharge into any adjacent water — a spark never drifts away from a
    // pool it touches (the reaction table alone gives it only a one-frame,
    // chance-of-a-pick window before the gas rises out of contact)
    for (let n = 0; n < 4; n++) {
      let j = -1;
      if (n === 0 && y > 0) j = i - SIM_W;
      else if (n === 1 && y + 1 < SIM_H) j = i + SIM_W;
      else if (n === 2 && x > 0) j = i - 1;
      else if (n === 3 && x + 1 < SIM_W) j = i + 1;
      if (j >= 0 && grid[j] === E.WATER) {
        setCell(j, E.EWATER);
        setCell(i, E.EMPTY);
        return;
      }
    }
  }
  // electric sparks skitter along metal surfaces (conduction): hop to an
  // open cell adjacent to a neighboring metal cell, recharging a little
  if (id === E.ELEC) {
    for (let n = 0; n < 4; n++) {
      let j = -1;
      if (n === 0 && y > 0) j = i - SIM_W;
      else if (n === 1 && y + 1 < SIM_H) j = i + SIM_W;
      else if (n === 2 && x > 0) j = i - 1;
      else if (n === 3 && x + 1 < SIM_W) j = i + 1;
      if (j < 0 || grid[j] !== E.METAL) continue;
      const jx = j % SIM_W, jy = (j / SIM_W) | 0;
      const hops = [];
      if (jy > 0) hops.push(j - SIM_W);
      if (jy + 1 < SIM_H) hops.push(j + SIM_W);
      if (jx > 0) hops.push(j - 1);
      if (jx + 1 < SIM_W) hops.push(j + 1);
      const m = hops[(rand() * hops.length) | 0];
      if (m !== i && grid[m] === E.EMPTY) {
        swapCells(i, m);
        life[m] = Math.min(30, life[m] + 4);
        return;
      }
    }
  }
  const d = DENSITY[id];
  const r = rand();
  if (y > 0 && r < 0.7) {
    const above = i - SIM_W;
    const dx = (rand() * 3 | 0) - 1; // -1, 0, 1: drift while rising
    const nx = x + dx;
    if (nx >= 0 && nx < SIM_W && canDisplace(d + 1, above + dx)) {
      swapCells(i, above + dx);
      return;
    }
    if (canDisplace(d + 1, above)) { swapCells(i, above); return; }
    // bubble up through liquids (steam out of a boiling lake,
    // hydrogen out of an electrolyzing pool)
    if (TYPE[grid[above]] === T.LIQUID && rand() < 0.4) {
      swapCells(i, above);
      return;
    }
  }
  // sideways wander
  const dir = rand() < 0.5 ? 1 : -1;
  const nx = x + dir;
  if (nx >= 0 && nx < SIM_W && grid[i + dir] === E.EMPTY && rand() < 0.4) {
    swapCells(i, i + dir);
  }
}

function stepFire(i, x, y, id) {
  if (life[i] > 0 && --life[i] === 0) {
    // fire leaves smoke, ash (falls and fertilizes), or nothing
    const r = rand();
    setCell(i, r < 0.25 ? E.SMOKE : r < 0.45 ? E.ASH : E.EMPTY);
    return;
  }
  const hasFuel = igniteNeighbors(i, x, y);
  // occasionally puff smoke into the cell above
  if (y > 0 && grid[i - SIM_W] === E.EMPTY && rand() < 0.03) {
    setCell(i - SIM_W, E.SMOKE);
  }
  // flicker upward — but cling to adjacent fuel instead of drifting off it
  if (!hasFuel && y > 0 && rand() < 0.35) {
    const dx = (rand() * 3 | 0) - 1;
    const nx = x + dx;
    if (nx >= 0 && nx < SIM_W && grid[i - SIM_W + dx] === E.EMPTY) {
      swapCells(i, i - SIM_W + dx);
    }
  }
}

// Cellular fauna: grazers (BUG) eat plants, hunters (PRED) eat grazers.
// Both breed when well-fed (crowding-limited so populations self-regulate)
// and starve back into ash — a two-level trophic chain over the nutrient
// loop: plants -> bugs -> hunters -> ash -> (with water) plants.
function stepBug(i, x, y, id) {
  if (life[i] === 0) { setCell(i, E.ASH); return; } // starved
  life[i]--;

  const hunter = id === E.PRED;
  const prey    = hunter ? E.BUG : E.PLANT;
  const eatGain = hunter ? 150 : 90;
  const breedAt = hunter ? 380 : 300;
  const crowdAt = hunter ? 1 : 2; // hunters are solitary
  const breedP  = hunter ? 0.012 : 0.02;

  const below = y + 1 < SIM_H ? i + SIM_W : -1;
  const above = y > 0 ? i - SIM_W : -1;
  const left  = x > 0 ? i - 1 : -1;
  const right = x + 1 < SIM_W ? i + 1 : -1;

  // feed: eating takes the turn
  for (const j of [below, left, right, above]) {
    if (j >= 0 && grid[j] === prey && rand() < 0.25) {
      setCell(j, E.EMPTY);
      life[i] = Math.min(700, life[i] + eatGain);
      return;
    }
  }

  // reproduce when well-fed, but never into a crowd
  if (life[i] > breedAt && rand() < breedP) {
    let neighbors = 0, empty = -1;
    for (const j of [below, above, left, right]) {
      if (j < 0) continue;
      if (grid[j] === id) neighbors++;
      else if (grid[j] === E.EMPTY) empty = j;
    }
    if (neighbors < crowdAt && empty >= 0) {
      setCell(empty, id);
      life[i] -= 180;
      return;
    }
  }

  // gravity; bugs sink in liquid and can drown
  if (below >= 0) {
    if (grid[below] === E.EMPTY) { swapCells(i, below); return; }
    if (TYPE[grid[below]] === T.LIQUID && rand() < 0.3) {
      swapCells(i, below);
      if (rand() < 0.012) setCell(below, E.ASH); // glub
      return;
    }
  }
  if (above >= 0 && TYPE[grid[above]] === T.LIQUID && rand() < 0.02) {
    setCell(i, E.ASH); // fully submerged
    return;
  }

  // wander, with the occasional clamber upward
  const side = rand() < 0.5 ? left : right;
  if (side >= 0 && grid[side] === E.EMPTY && rand() < 0.5) { swapCells(i, side); return; }
  if (above >= 0 && grid[above] === E.EMPTY && rand() < 0.08) swapCells(i, above);
}

// Fire and lava share this: try to ignite the 4 cardinal neighbors.
// Returns whether any flammable neighbor exists (fire uses it to cling).
function igniteNeighbors(i, x, y) {
  let hasFuel = false;
  for (let n = 0; n < 4; n++) {
    let j = -1;
    if (n === 0 && y > 0) j = i - SIM_W;
    else if (n === 1 && y + 1 < SIM_H) j = i + SIM_W;
    else if (n === 2 && x > 0) j = i - 1;
    else if (n === 3 && x + 1 < SIM_W) j = i + 1;
    if (j < 0) continue;
    const t = grid[j];
    const f = FLAMMABLE[t];
    if (f > 0) {
      hasFuel = true;
      if (rand() < f) {
        if (EXPLOSIVE[t]) {
          explosionQueue.push(j);
        } else {
          const burn = BURN_LIFE[t];
          setCell(j, E.FIRE);
          life[j] = burn;
        }
      }
    }
  }
  return hasFuel;
}

// --- reactions ------------------------------------------------------------

// Check the data-driven reaction table against two random cardinal neighbors.
function stepReactions(i, x, y, id) {
  for (let n = 0; n < 2; n++) {
    const pick = rand() * 4 | 0;
    let j = -1;
    if (pick === 0 && y > 0) j = i - SIM_W;
    else if (pick === 1 && y + 1 < SIM_H) j = i + SIM_W;
    else if (pick === 2 && x > 0) j = i - 1;
    else if (pick === 3 && x + 1 < SIM_W) j = i + 1;
    if (j < 0) continue;
    const other = grid[j];
    if (other === E.EMPTY && id !== E.EMPTY) continue;
    const r = REACTIONS[(id << 8) | other];
    if (r && rand() < r.p) {
      setCell(j, r.b2);
      // acid is consumed some of the time when it dissolves something
      if (id === E.ACID && r.b2 === E.EMPTY && rand() < 0.25) {
        setCell(i, E.EMPTY);
      } else {
        setCell(i, r.a2);
      }
      return true;
    }
  }
  return false;
}

// --- explosions -----------------------------------------------------------

function explode(cx, cy, radius) {
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= SIM_H) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= SIM_W) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const j = idx(x, y);
      const t = grid[j];
      if (t === E.WALL) continue;
      if (EXPLOSIVE[t]) { explosionQueue.push(j); continue; } // chain!
      if (d2 < r2 * 0.4) {
        setCell(j, rand() < 0.8 ? E.FIRE : E.SMOKE);
      } else if (rand() < 0.6) {
        setCell(j, rand() < 0.5 ? E.FIRE : E.SMOKE);
      }
    }
  }
}

function drainExplosions() {
  // queue-based so gunpowder chains propagate breadth-first, capped for safety
  let processed = 0;
  while (explosionQueue.length > 0 && processed < 200) {
    const j = explosionQueue.pop();
    if (!EXPLOSIVE[grid[j]]) continue; // already blown up by an overlap
    grid[j] = E.EMPTY;
    explode(j % SIM_W, (j / SIM_W) | 0, ((5 + rand() * 4) * explosionScale) | 0);
    if (simHooks.explosion) simHooks.explosion();
    processed++;
  }
  explosionQueue.length = 0;
}

// --- main step ------------------------------------------------------------

function simStep() {
  simClock ^= 1;
  simFrame++;
  if (!worldSettling && (simFrame & 3) === 0) updateTemperature();

  for (let y = SIM_H - 1; y >= 0; y--) {
    // alternate scan direction per row/frame to avoid directional bias
    const ltr = (y + simFrame) & 1;
    const row = y * SIM_W;
    for (let k = 0; k < SIM_W; k++) {
      const x = ltr ? k : SIM_W - 1 - k;
      const i = row + x;
      const id = grid[i];
      if (id === E.EMPTY) continue;
      if (updated[i] === simClock) continue;
      updated[i] = simClock;

      if (!worldSettling && stepReactions(i, x, y, id)) continue;

      switch (TYPE[id]) {
        case T.POWDER: stepPowder(i, x, y, id); break;
        case T.LIQUID:
          stepLiquid(i, x, y, id);
          if (id === E.LAVA && !worldSettling && rand() < 0.4) igniteNeighbors(i, x, y);
          break;
        case T.GAS:    stepGas(i, x, y, id); break;
        case T.FIRE:   stepFire(i, x, y, id); break;
        case T.BUG:    stepBug(i, x, y, id); break;
        case T.STATIC:
          // plants occasionally drop a seed into open air below
          if (id === E.PLANT && rand() < 0.00012 && y + 1 < SIM_H &&
              grid[i + SIM_W] === E.EMPTY) {
            setCell(i + SIM_W, E.SEED);
          } else if (id === E.ICE && !worldSettling) {
            // ice thaws in warm air (threshold above temperate ambient, so
            // sandbox ice keeps; hysteresis vs freezing-at-0 is deliberate)
            const ct = tempAt(x, y);
            if (ct > 20 && rand() < Math.min(0.05, (ct - 20) * 0.001)) {
              setCell(i, E.WATER);
            }
          }
          break;
      }
    }
  }

  drainExplosions();
}

// --- painting (used by input layer) ----------------------------------------

function paintCircle(cx, cy, radius, id) {
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= SIM_H) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= SIM_W) continue;
      if (dx * dx + dy * dy > r2) continue;
      const i = idx(x, y);
      // erasing overwrites anything; painting only fills empty space
      // (except at brush size 1, which force-places for precision work)
      if (id === E.EMPTY || grid[i] === E.EMPTY || radius <= 1) {
        setCell(i, id);
      }
    }
  }
}

function clearSim() {
  grid.fill(E.EMPTY);
  shade.fill(0); // so same-seed worlds are byte-identical, not just visually
  life.fill(0);
  temp.fill(TEMP_DEFAULT);
  ambientTemp.fill(TEMP_DEFAULT);
}

// A little starter scene so the first impression isn't a blank void
function seedScene() {
  clearSim();
  const floor = SIM_H - 8;
  // stone bowl
  for (let x = 20; x < SIM_W - 20; x++) {
    for (let y = floor; y < SIM_H - 4; y++) setCell(idx(x, y), E.STONE);
  }
  for (let y = floor - 40; y < floor; y++) {
    for (let t = 0; t < 4; t++) {
      setCell(idx(20 + t, y), E.STONE);
      setCell(idx(SIM_W - 21 - t, y), E.STONE);
    }
  }
  // wooden platform with plants
  for (let x = 90; x < 160; x++) {
    setCell(idx(x, 90), E.WOOD);
    setCell(idx(x, 91), E.WOOD);
  }
  for (let x = 100; x < 150; x += 3) {
    setCell(idx(x, 89), E.PLANT);
    setCell(idx(x, 88), E.PLANT);
  }
  // pools
  paintCircle(60, floor - 6, 12, E.WATER);
  paintCircle(250, floor - 6, 12, E.OIL);
  // sand pile
  paintCircle(160, 40, 10, E.SAND);
}

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
const _metalMask  = new Uint8Array(TEMP_CELLS); // cells containing metal
let ambientChill = 0; // global offset, driven by weather (cold snaps)

// per-element heat emission into the local temp cell, per temp update
const HEAT = new Float32Array(NUM_ELEMENTS);
HEAT[E.FIRE]   = 1.4;
HEAT[E.LAVA]   = 2.2;
HEAT[E.MOLTEN] = 2.2;
HEAT[E.STEAM]  = 0.25;
HEAT[E.ELEC]   = 0.3;
// cold emission is much gentler than heat: a solid ice block chills its own
// air toward freezing, but can't out-refrigerate a lava pool one cell over
HEAT[E.ICE]   = -0.15;
HEAT[E.SNOW]  = -0.1;

function tempAt(x, y) { return temp[(y >> 2) * TEMP_W + (x >> 2)]; }

// Runs every 4th sim step (deterministic — pure arithmetic, no rand).
function updateTemperature() {
  // 1. emission: hot/cold elements push their temp cell (the metal mask for
  //    heat conduction is rebuilt in the same sweep)
  _metalMask.fill(0);
  for (let y = 0; y < SIM_H; y++) {
    const row = y * SIM_W, trow = (y >> 2) * TEMP_W;
    for (let x = 0; x < SIM_W; x++) {
      const g = grid[row + x];
      const h = HEAT[g];
      if (h > 0) {
        temp[trow + (x >> 2)] += h;
        // liquid metal conducts like the solid — a half-melted rod still
        // carries its furnace heat (the melt pools where the rod was)
        if (g === E.MOLTEN) _metalMask[trow + (x >> 2)] = 1;
      } else if (h < 0) {
        // cold sources buffer their cell toward freezing but never chill it
        // below 0 — otherwise a frozen-over pool self-refrigerates in a
        // runaway (ice -> colder -> more ice) far below the biome ambient
        const j = trow + (x >> 2);
        if (temp[j] > 0) temp[j] = Math.max(0, temp[j] + h);
      } else if (g === E.METAL) {
        _metalMask[trow + (x >> 2)] = 1;
      }
    }
  }
  // 2. diffusion + relaxation toward the biome ambient (plus weather chill).
  //    Metal conducts: metal cells exchange heat strongly along connected
  //    metal and shed little to the air — a rod dipped in lava carries the
  //    heat out to its far end (which the thermoelectric rule turns to power)
  _tempPrev.set(temp);
  for (let ty = 0; ty < TEMP_H; ty++) {
    const trow = ty * TEMP_W;
    for (let tx = 0; tx < TEMP_W; tx++) {
      const i = trow + tx;
      const s = _tempPrev[i];
      const metal = _metalMask[i];
      let sum = 0, n = 0, msum = 0, mn = 0;
      if (tx > 0)          { sum += _tempPrev[i - 1];      n++; if (metal && _metalMask[i - 1])      { msum += _tempPrev[i - 1];      mn++; } }
      if (tx + 1 < TEMP_W) { sum += _tempPrev[i + 1];      n++; if (metal && _metalMask[i + 1])      { msum += _tempPrev[i + 1];      mn++; } }
      if (ty > 0)          { sum += _tempPrev[i - TEMP_W]; n++; if (metal && _metalMask[i - TEMP_W]) { msum += _tempPrev[i - TEMP_W]; mn++; } }
      if (ty + 1 < TEMP_H) { sum += _tempPrev[i + TEMP_W]; n++; if (metal && _metalMask[i + TEMP_W]) { msum += _tempPrev[i + TEMP_W]; mn++; } }
      let t = s + (sum / n - s) * 0.15 +
              (ambientTemp[i] + ambientChill - s) * (metal ? 0.01 : 0.04);
      if (mn > 0) t += (msum / mn - s) * 0.45;
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
    // buried snow compacts into glacier ice: if there's a deep column of
    // snow pressing down from above, the bottom of the pack crystallizes
    else if (ct < 0 && y > 4 && grid[i - SIM_W] === E.SNOW &&
             grid[i - 2 * SIM_W] === E.SNOW && grid[i - 3 * SIM_W] === E.SNOW &&
             grid[i - 4 * SIM_W] === E.SNOW && rand() < 0.004) {
      setCell(i, E.ICE);
      return;
    }
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
      if (up === E.EMPTY || up === E.ICE || up === E.SNOW) {
        // a frozen lid insulates: water under ice freezes an order of
        // magnitude slower, so deep ponds stay liquid (and habitable —
        // kelp and fish live on under the ice) for a long while
        const p = Math.min(0.05, -ct * 0.002) * (up === E.EMPTY ? 1 : 0.1);
        if (rand() < p) {
          // supported water freezes solid; a droplet falling through cold
          // air crystallizes into snow and keeps falling (no floating ice)
          const inAir = y + 1 < SIM_H && grid[i + SIM_W] === E.EMPTY;
          setCell(i, inAir ? E.SNOW : E.ICE);
          return;
        }
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
  // molten metal solidifies once it leaves the heat — back into real METAL
  // (higher threshold than lava: it stays liquid only while actively heated,
  // so a poured casting sets quickly and can't creep across the map)
  if (id === E.MOLTEN && !worldSettling && tempAt(x, y) < 45 && rand() < 0.02) {
    setCell(i, E.METAL);
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
    // sparks always discharge into what they touch — never drift away from
    // it (the reaction table alone gives only a one-frame, chance-of-a-pick
    // window before the gas rises out of contact): water electrifies,
    // explosives detonate (electric tripwires!), hydrogen flashes
    for (let n = 0; n < 4; n++) {
      let j = -1;
      if (n === 0 && y > 0) j = i - SIM_W;
      else if (n === 1 && y + 1 < SIM_H) j = i + SIM_W;
      else if (n === 2 && x > 0) j = i - 1;
      else if (n === 3 && x + 1 < SIM_W) j = i + 1;
      if (j < 0) continue;
      const t = grid[j];
      if (t === E.WATER) {
        setCell(j, E.EWATER);
        setCell(i, E.EMPTY);
        return;
      }
      if (EXPLOSIVE[t]) {
        explosionQueue.push(j);
        setCell(i, E.EMPTY);
        return;
      }
      if (t === E.HYDROGEN) {
        setCell(j, E.FIRE);
        life[j] = BURN_LIFE[E.HYDROGEN];
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

// Fauna feel the temperature field: cold sends them into torpor (they mostly
// skip turns — no feeding, no breeding — while life keeps ticking down),
// deep cold or cooking heat kills. Fish get a wider band: water buffers them,
// so an iced-over pool is sluggish but survivable. Returns true if the
// creature's turn is over.
function faunaClimate(i, x, y, aquatic) {
  const ct = tempAt(x, y);
  if (ct > 70 && rand() < 0.01) { setCell(i, E.ASH); return true; } // cooked
  if (ct < (aquatic ? -30 : -15) && rand() < 0.004) {
    setCell(i, E.ASH); // froze to death
    return true;
  }
  if (ct < (aquatic ? -10 : 0) && rand() < (aquatic ? 0.85 : 0.9)) {
    life[i]++; // metabolic shutdown: dormant turns don't age the creature,
    // so overwintering fauna can revive when the thaw comes. Torpid fish
    // settle to the pool bottom — the last place the freeze front reaches.
    if (aquatic && y + 1 < SIM_H && grid[i + SIM_W] === E.WATER) {
      swapCells(i, i + SIM_W);
    }
    return true;
  }
  return false;
}

// Cellular fauna: grazers (BUG) eat plants, hunters (PRED) eat grazers.
// Both breed when well-fed (crowding-limited so populations self-regulate)
// and starve back into ash — a two-level trophic chain over the nutrient
// loop: plants -> bugs -> hunters -> ash -> (with water) plants.
function stepBug(i, x, y, id) {
  if (life[i] === 0) { setCell(i, E.ASH); return; } // starved
  life[i]--;
  if (faunaClimate(i, x, y, false)) return;

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

  // smoke chokes: caught under the ceiling layer of a fire, life drains fast
  // — and a coughing fit takes the turn (no feeding or breeding mid-choke)
  if (above >= 0 && grid[above] === E.SMOKE) {
    if (rand() < 0.12) life[i] = life[i] > 30 ? life[i] - 30 : 0;
    if (rand() < 0.5) return;
  }

  // feed: eating takes the turn (grazers also browse fungus and seeds — the
  // decomposer route and the seed bank both feed back into the food web)
  for (const j of [below, left, right, above]) {
    if (j >= 0 &&
        (grid[j] === prey ||
         (!hunter && (grid[j] === E.FUNGUS || grid[j] === E.SEED))) &&
        rand() < 0.25) {
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

// Fish live in water: swim, graze underwater plants, breed when fed, and
// suffocate quickly on land (a stranded fish flops, then stills to ash).
function stepFish(i, x, y, id) {
  if (life[i] === 0) { setCell(i, E.ASH); return; }
  life[i]--;
  if (faunaClimate(i, x, y, true)) return;

  const below = y + 1 < SIM_H ? i + SIM_W : -1;
  const above = y > 0 ? i - SIM_W : -1;
  const left  = x > 0 ? i - 1 : -1;
  const right = x + 1 < SIM_W ? i + 1 : -1;
  const dirs = [below, above, left, right];

  let waterN = 0;
  for (const j of dirs) {
    if (j < 0) continue;
    // kelp counts as habitat — a fish deep in a plant thicket is still wet
    if (grid[j] === E.WATER || grid[j] === E.PLANT) waterN++;
    else if (grid[j] === E.EWATER && rand() < 0.2) { setCell(i, E.ASH); return; } // shocked
  }

  if (waterN === 0) {
    // beached: suffocate fast, flop toward lower ground
    life[i] = life[i] > 12 ? life[i] - 12 : 0;
    if (below >= 0 && grid[below] === E.EMPTY) { swapCells(i, below); return; }
    const side = rand() < 0.5 ? left : right;
    if (side >= 0 && grid[side] === E.EMPTY && rand() < 0.3) swapCells(i, side);
    return;
  }

  // graze kelp; the plant grew by drinking water, so eating returns water
  for (const j of dirs) {
    if (j >= 0 && grid[j] === E.PLANT && rand() < 0.2) {
      setCell(j, E.WATER);
      life[i] = Math.min(800, life[i] + 120);
      return;
    }
  }

  // breed into adjacent water when well-fed, crowd-limited
  if (life[i] > 500 && rand() < 0.008) {
    let neighbors = 0, spot = -1;
    for (const j of dirs) {
      if (j < 0) continue;
      if (grid[j] === E.FISH) neighbors++;
      else if (grid[j] === E.WATER) spot = j;
    }
    if (neighbors < 2 && spot >= 0) {
      setCell(spot, E.FISH);
      life[i] -= 200;
      return;
    }
  }

  // swim: drift through the pool, slight downward bias so schools don't
  // just collect along the surface
  if (rand() < 0.35) {
    const r = rand();
    const order = r < 0.4 ? [below, left, right, above]
                : r < 0.7 ? [left, right, below, above]
                :           [right, left, below, above];
    for (const j of order) {
      // fish push through kelp too (the swap makes the fronds sway)
      if (j >= 0 && (grid[j] === E.WATER || grid[j] === E.PLANT)) {
        swapCells(i, j);
        return;
      }
    }
  }
}

// Moths pollinate: they sip from plants without consuming them (nectar keeps
// them alive) and scatter seeds into the air nearby — meadows with moths
// spread. They linger on flowers, drown in liquid, and burn readily.
function stepMoth(i, x, y, id) {
  if (life[i] === 0) { setCell(i, E.ASH); return; }
  life[i]--;
  if (faunaClimate(i, x, y, false)) return;

  const below = y + 1 < SIM_H ? i + SIM_W : -1;
  const above = y > 0 ? i - SIM_W : -1;
  const left  = x > 0 ? i - 1 : -1;
  const right = x + 1 < SIM_W ? i + 1 : -1;
  const dirs = [below, above, left, right];

  if (above >= 0 && TYPE[grid[above]] === T.LIQUID && rand() < 0.15) {
    setCell(i, E.ASH); // submerged
    return;
  }
  // smoke chokes moths even faster than bugs (delicate little things)
  if (above >= 0 && grid[above] === E.SMOKE && rand() < 0.15) {
    life[i] = life[i] > 40 ? life[i] - 40 : 0;
  }

  // like a moth to a flame: scan short rays for visible fire and fly toward
  // it (through smoke, not through walls) — usually to its doom
  if (rand() < 0.6) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, -1], [0, 1]]) {
      for (let d = 2; d <= 5; d++) {
        const fx = x + dx * d, fy = y + dy * d;
        if (fx < 0 || fx >= SIM_W || fy < 0 || fy >= SIM_H) break;
        const g = grid[fy * SIM_W + fx];
        if (g === E.FIRE) {
          const j = (y + dy) * SIM_W + (x + dx);
          if (grid[j] === E.EMPTY) swapCells(i, j);
          return;
        }
        if (g !== E.EMPTY && g !== E.SMOKE) break; // sight blocked
      }
    }
  }

  let onFlower = false;
  for (const j of dirs) {
    if (j < 0) continue;
    const g = grid[j];
    if (g === E.PLANT || g === E.FUNGUS) {
      onFlower = true;
      if (rand() < 0.15) life[i] = Math.min(900, life[i] + 50);
      // pollination: carry seeds off meadows — or fungal spores off groves
      // (spores only take on supported cells: no fungus hanging in the sky)
      const spore = g === E.FUNGUS;
      if (rand() < (spore ? 0.002 : 0.004)) {
        for (const k of dirs) {
          if (k < 0 || grid[k] !== E.EMPTY) continue;
          if (spore) {
            const under = k + SIM_W;
            if (under >= CELLS || grid[under] === E.EMPTY ||
                TYPE[grid[under]] === T.GAS || TYPE[grid[under]] === T.LIQUID) continue;
            setCell(k, E.FUNGUS);
          } else {
            setCell(k, E.SEED);
          }
          break;
        }
      }
      break;
    }
  }

  // breed near food, solitary like hunters
  if (onFlower && life[i] > 600 && rand() < 0.01) {
    let neighbors = 0, spot = -1;
    for (const j of dirs) {
      if (j < 0) continue;
      if (grid[j] === E.MOTH) neighbors++;
      else if (grid[j] === E.EMPTY) spot = j;
    }
    if (neighbors < 1 && spot >= 0) {
      setCell(spot, E.MOTH);
      life[i] -= 250;
      return;
    }
  }

  // flutter: airborne random walk; linger when perched on a flower
  if (onFlower && rand() < 0.85) return;
  const nx = x + ((rand() * 3 | 0) - 1);
  const ny = y + ((rand() * 3 | 0) - 1);
  if (nx >= 0 && nx < SIM_W && ny >= 0 && ny < SIM_H) {
    const j = ny * SIM_W + nx;
    if (grid[j] === E.EMPTY && rand() < 0.6) swapCells(i, j);
  }
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
    if (r && (r.minTemp === undefined || tempAt(x, y) >= r.minTemp) &&
        rand() < r.p) {
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
  if (simHooks.explodeAt) simHooks.explodeAt(cx, cy, radius); // game-layer ears
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
          if ((id === E.LAVA || id === E.MOLTEN) && !worldSettling && rand() < 0.4) {
            igniteNeighbors(i, x, y);
          }
          break;
        case T.GAS:    stepGas(i, x, y, id); break;
        case T.FIRE:   stepFire(i, x, y, id); break;
        case T.BUG:
          if (id === E.FISH) stepFish(i, x, y, id);
          else if (id === E.MOTH) stepMoth(i, x, y, id);
          else stepBug(i, x, y, id);
          break;
        case T.STATIC:
          if (id === E.PLANT) {
            // frost kills exposed vegetation, scattering part of its seed
            // bank (with meltwater + ash this makes cold snaps into seasons:
            // die-back, then spring bloom). Touching liquid water spares it —
            // kelp lives until its pool actually freezes solid.
            if (!worldSettling && tempAt(x, y) < -5 && rand() < 0.003) {
              const wet = (y > 0 && grid[i - SIM_W] === E.WATER) ||
                          (y + 1 < SIM_H && grid[i + SIM_W] === E.WATER) ||
                          (x > 0 && grid[i - 1] === E.WATER) ||
                          (x + 1 < SIM_W && grid[i + 1] === E.WATER);
              if (!wet) { setCell(i, rand() < 0.15 ? E.SEED : E.ASH); break; }
            }
            // and occasionally drop a seed into open air below
            if (rand() < 0.00012 && y + 1 < SIM_H && grid[i + SIM_W] === E.EMPTY) {
              setCell(i + SIM_W, E.SEED);
            }
          } else if (id === E.ICE && !worldSettling) {
            // ice thaws in warm air (threshold above temperate ambient, so
            // sandbox ice keeps; hysteresis vs freezing-at-0 is deliberate)
            const ct = tempAt(x, y);
            if (ct > 20 && rand() < Math.min(0.05, (ct - 20) * 0.001)) {
              setCell(i, E.WATER);
            }
          } else if (id === E.METAL && !worldSettling) {
            // thermoelectric: hot metal sheds sparks — a rod dipped in lava
            // is a geothermal generator (cold metal is inert). Rate is tuned
            // so a running generator visibly zaps its basin every few seconds
            const ct = tempAt(x, y);
            if (ct > 60 && rand() < (ct - 60) * 0.0001) {
              const spots = [
                y > 0 ? i - SIM_W : -1,
                x > 0 ? i - 1 : -1,
                x + 1 < SIM_W ? i + 1 : -1,
                y + 1 < SIM_H ? i + SIM_W : -1,
              ];
              for (const j of spots) {
                if (j >= 0 && grid[j] === E.EMPTY) { setCell(j, E.ELEC); break; }
              }
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

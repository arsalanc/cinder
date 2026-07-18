// CINDER — procedural world generation
// Seeded caves + biome materials. Pipeline:
//   1. rough terrain surface line
//   2. Voronoi biome regions (jittered borders) assigned first, so the carve
//      can read them — each biome digs differently
//   3. seeded value-noise fBm carves caverns, biased by a per-seed openness
//      roll plus each biome's own `open` bias
//   4. drunkard-walk tunnels add vertical routes
//   5. most seeds carve one grand chamber — a vast vault with a biome lake
//   6. flood-fill connectivity pass tunnels stray pockets into the main cave
//   7. materials committed, liquid pools dropped in, then the sim itself runs
//      in "settle mode" (movement only, no fire/reactions) so pools rest
//   8. decoration pass: plants, surface grass, fauna, machinery
// Biomes are plain data (like REACTIONS) so roguelite modifiers can add or
// mutate them per-run.

'use strict';

// --- seeded randomness -----------------------------------------------------

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// seeded 2D value noise in [0,1]
function makeNoise2D(rng) {
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { p[i] = i; vals[i] = rng(); }
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return function (x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const X = xi & 255, Y = yi & 255;
    const a = vals[perm[perm[X] + Y]];
    const b = vals[perm[perm[X + 1] + Y]];
    const c = vals[perm[perm[X] + Y + 1]];
    const d = vals[perm[perm[X + 1] + Y + 1]];
    const ab = a + (b - a) * u;
    return ab + ((c + (d - c) * u) - ab) * v;
  };
}

function fbm(noise, x, y, octaves) {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x, y) * amp;
    norm += amp;
    x *= 2; y *= 2; amp *= 0.5;
  }
  return sum / norm;
}

// --- biomes -----------------------------------------------------------------
// depth: [min,max] fraction of the underground where this biome may appear
// (0 = just below the surface, 1 = bottom of the map)

// `open` biases the cave carve inside the biome: positive digs wider halls,
// negative pinches the tunnels. Volcanic depths yawn; ice caves squeeze.
const BIOMES = [
  { name: 'Stone Caverns',   base: E.STONE, vein: E.SAND,      veinAmount: 0.30, liquid: E.WATER, liquidAmount: 0.30, deco: E.PLANT, decoAmount: 0.05, fauna: 0.004, fungus: 0.006, temp: 12,  depth: [0, 1], open: 0 },
  { name: 'Overgrown Vault', base: E.STONE, vein: E.WOOD,      veinAmount: 0.35, liquid: E.WATER, liquidAmount: 0.40, deco: E.PLANT, decoAmount: 0.85,
    vineChance: 0.30, vineLen: 10, tuftChance: 0.35, tuftLen: 4, fauna: 0.02, fungus: 0.002, temp: 22, depth: [0, 0.6], open: 0.012 },
  { name: 'Ice Caves',       base: E.ICE,   vein: E.STONE,     veinAmount: 0.35, liquid: E.WATER, liquidAmount: 0.20, deco: 0,       decoAmount: 0,    temp: -12, depth: [0, 0.7], open: -0.012 },
  { name: 'Oil Caverns',     base: E.STONE, vein: E.GUNPOWDER, veinAmount: 0.20, liquid: E.OIL,   liquidAmount: 0.45, deco: 0,       decoAmount: 0,    fungus: 0.004, temp: 18,  depth: [0.3, 1],  hazardous: true, open: 0.008 },
  { name: 'Volcanic Depths', base: E.STONE, vein: E.SAND,      veinAmount: 0.15, liquid: E.LAVA,  liquidAmount: 0.35, deco: 0,       decoAmount: 0,    temp: 55,  depth: [0.55, 1], hazardous: true, open: 0.022 },
  // Rusted Works: a deep industrial ruin. Metal terrain (conductive — sparks
  // and lightning race through the walls) streaked with rust (sand veins),
  // seeped puddles, and abandoned machinery (`works`). Warm from old furnaces.
  { name: 'Rusted Works',    base: E.METAL, vein: E.SAND,      veinAmount: 0.25, liquid: E.WATER, liquidAmount: 0.25, deco: 0,       decoAmount: 0,    fungus: 0.003, temp: 28,  depth: [0.45, 1], hazardous: true, works: true },
];

const worldBiomeMap = new Uint8Array(CELLS);
let worldSeed = '';

// Per-generation facts other systems (and tests) can read: the seed's rolled
// openness bias and the grand chamber's bounds (null when the seed has none).
let worldInfo = { openness: 0, chamber: null };

// --- carving helpers --------------------------------------------------------

function clearDisk(solidArr, cx, cy, r) {
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 1 || y >= SIM_H - 3) continue;   // keep the bottom border intact
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      if (x < 3 || x >= SIM_W - 3) continue; // keep the side borders intact
      if (dx * dx + dy * dy <= r * r) solidArr[y * SIM_W + x] = 0;
    }
  }
}

function carveTunnel(solidArr, x0, y0, x1, y1, rng) {
  let x = x0, y = y0;
  const maxSteps = (Math.abs(x1 - x0) + Math.abs(y1 - y0)) * 3 + 20;
  for (let s = 0; s < maxSteps && (x !== x1 || y !== y1); s++) {
    clearDisk(solidArr, x, y, 2);
    // step toward the target with some wobble
    if (rng() < 0.75) x += Math.sign(x1 - x); else x += rng() < 0.5 ? -1 : 1;
    if (rng() < 0.75) y += Math.sign(y1 - y); else y += rng() < 0.5 ? -1 : 1;
    x = Math.max(4, Math.min(SIM_W - 5, x));
    y = Math.max(2, Math.min(SIM_H - 5, y));
  }
  clearDisk(solidArr, x, y, 2);
}

// Flood-fill open regions; tunnel every stray pocket into the largest one.
function connectCaverns(solidArr, rng) {
  const comp = new Int32Array(CELLS).fill(-1);
  const comps = []; // { size, rx, ry } — rep cell is the first visited
  const stack = [];
  for (let start = 0; start < CELLS; start++) {
    if (solidArr[start] || comp[start] >= 0) continue;
    const id = comps.length;
    const c = { size: 0, rx: start % SIM_W, ry: (start / SIM_W) | 0 };
    comps.push(c);
    stack.length = 0;
    stack.push(start);
    comp[start] = id;
    while (stack.length) {
      const i = stack.pop();
      c.size++;
      const x = i % SIM_W, y = (i / SIM_W) | 0;
      if (x > 0 && !solidArr[i - 1] && comp[i - 1] < 0) { comp[i - 1] = id; stack.push(i - 1); }
      if (x + 1 < SIM_W && !solidArr[i + 1] && comp[i + 1] < 0) { comp[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && !solidArr[i - SIM_W] && comp[i - SIM_W] < 0) { comp[i - SIM_W] = id; stack.push(i - SIM_W); }
      if (y + 1 < SIM_H && !solidArr[i + SIM_W] && comp[i + SIM_W] < 0) { comp[i + SIM_W] = id; stack.push(i + SIM_W); }
    }
  }
  let largest = 0;
  for (let k = 1; k < comps.length; k++) if (comps[k].size > comps[largest].size) largest = k;
  for (let k = 0; k < comps.length; k++) {
    if (k === largest || comps[k].size < 25) continue; // leave tiny air pockets sealed
    carveTunnel(solidArr, comps[k].rx, comps[k].ry, comps[largest].rx, comps[largest].ry, rng);
  }
}

// --- Rusted Works machinery (set-pieces) -----------------------------------
// Legible industrial ruins: each reads at a glance and behaves like what it
// looks like. Stamped onto a solid floor at (cx, fy) — the placement pass
// guarantees an 11-wide ledge with clear air, so these draw within cx±5.

// Generator: a molten-cored furnace wired by a metal rail to an open coolant
// basin. The furnace heat conducts down the rail (thermoelectric rule) and
// sheds sparks into the basin — the pool it "cools" stays lethally live.
function stampGenerator(cx, fy) {
  // furnace: a 5-wide metal box (x: cx-5..cx-1) around a 3x2 molten core
  for (let dy = 0; dy <= 4; dy++) {
    setCell(idx(cx - 5, fy - dy), E.METAL);     // left wall
    setCell(idx(cx - 1, fy - dy), E.METAL);     // right wall
  }
  for (let dx = -5; dx <= -1; dx++) {
    setCell(idx(cx + dx, fy - 4), E.METAL);     // roof
    setCell(idx(cx + dx, fy), E.METAL);         // hearth
  }
  for (let dx = -4; dx <= -2; dx++)             // molten core (3 wide x 2 tall)
    for (let dy = 1; dy <= 2; dy++) setCell(idx(cx + dx, fy - dy), E.LAVA);
  // conduit rail carrying the furnace heat out to the basin
  for (let x = cx; x <= cx + 2; x++) setCell(idx(x, fy), E.METAL);
  // open coolant basin (x: cx+3..cx+5): the live rail keeps it electrified
  setCell(idx(cx + 5, fy), E.METAL);
  setCell(idx(cx + 5, fy - 1), E.METAL);
  for (let dx = 3; dx <= 4; dx++)               // water, open air above it
    for (let dy = 0; dy <= 1; dy++) setCell(idx(cx + dx, fy - dy), E.WATER);
}

// Storage vat: a glass tub of oil — acid-proof shell, flammable contents.
function stampOilVat(cx, fy) {
  for (let dy = 0; dy <= 3; dy++) {
    setCell(idx(cx - 3, fy - dy), E.GLASS);
    setCell(idx(cx + 3, fy - dy), E.GLASS);
  }
  for (let dx = -3; dx <= 3; dx++) setCell(idx(cx + dx, fy), E.GLASS);
  for (let dx = -2; dx <= 2; dx++)
    for (let dy = 1; dy < 3; dy++) setCell(idx(cx + dx, fy - dy), E.OIL);
}

// Munitions crate: a wooden shell packed with gunpowder.
function stampCrate(cx, fy) {
  for (let dx = -2; dx <= 2; dx++)
    for (let dy = 0; dy < 3; dy++) {
      const shell = dx === -2 || dx === 2 || dy === 0 || dy === 2;
      setCell(idx(cx + dx, fy - dy), shell ? E.WOOD : E.GUNPOWDER);
    }
}

// --- generation -------------------------------------------------------------

// runDepth (roguelite level number, 1-based) skews biome selection toward
// hazardous biomes the deeper the run goes; 0 = neutral sandbox generation
function generateWorld(seedStr, runDepth = 0) {
  worldSeed = seedStr;
  const seed = hashSeed(seedStr);
  seedSim(seed ^ 0x5F356495); // sim PRNG too: settle phase + spawns reproduce
  const rng = mulberry32(seed);
  const caveNoise   = makeNoise2D(mulberry32(seed ^ 0x9E3779B9));
  const veinNoise   = makeNoise2D(mulberry32(seed ^ 0x85EBCA6B));
  const jitterNoise = makeNoise2D(mulberry32(seed ^ 0xC2B2AE35));
  const surfNoise   = makeNoise2D(mulberry32(seed ^ 0x27D4EB2F));

  // 1. terrain surface line
  const surf = new Int16Array(SIM_W);
  for (let x = 0; x < SIM_W; x++) {
    surf[x] = 20 + (fbm(surfNoise, x * 0.02, 0.5, 3) * 16) | 0;
  }

  // 2. biome regions first (jittered Voronoi over scattered seed sites), so
  //    the carve below can read each cell's biome
  const avgSurf = 28;
  const sites = [];
  while (sites.length < 12) {
    const sy = avgSurf + rng() * (SIM_H - avgSurf - 4);
    const depth = (sy - avgSurf) / (SIM_H - avgSurf);
    const valid = [];
    for (let b = 0; b < BIOMES.length; b++) {
      if (depth >= BIOMES[b].depth[0] && depth <= BIOMES[b].depth[1]) valid.push(b);
    }
    let pick = valid[(rng() * valid.length) | 0];
    if (runDepth > 1) {
      const bias = Math.min(0.6, (runDepth - 1) * 0.15);
      const hazards = valid.filter(b => BIOMES[b].hazardous);
      if (hazards.length && rng() < bias) pick = hazards[(rng() * hazards.length) | 0];
    }
    sites.push({ x: rng() * SIM_W, y: sy, b: pick });
  }
  for (let y = 0; y < SIM_H; y++) {
    for (let x = 0; x < SIM_W; x++) {
      const jx = x + (jitterNoise(x * 0.06, y * 0.06) - 0.5) * 40;
      const jy = y + (jitterNoise(x * 0.06 + 91, y * 0.06 + 57) - 0.5) * 40;
      let best = 0, bestD = Infinity;
      for (let s = 0; s < sites.length; s++) {
        const dx = jx - sites[s].x, dy = jy - sites[s].y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = s; }
      }
      worldBiomeMap[idx(x, y)] = sites[best].b;
    }
  }

  // 3. noise-carved caverns below the surface. Openness varies per seed —
  //    some seeds roll cathedral caverns, others tight warrens — and each
  //    biome adds its own bias on top (BIOMES[].open).
  const openness = -0.015 + rng() * 0.04;
  worldInfo = { openness, chamber: null };
  const solid = new Uint8Array(CELLS);
  for (let y = 0; y < SIM_H; y++) {
    for (let x = 0; x < SIM_W; x++) {
      if (y <= surf[x]) continue; // sky
      const depth = (y - surf[x]) / (SIM_H - surf[x]);
      if (y - surf[x] < 4) { solid[idx(x, y)] = 1; continue; } // ground crust
      const n = fbm(caveNoise, x * 0.04, y * 0.04, 4);
      const open = openness + (BIOMES[worldBiomeMap[idx(x, y)]].open || 0);
      // deeper = slightly more closed-in
      if (n > 0.52 + open - depth * 0.08) solid[idx(x, y)] = 1;
    }
  }

  // 4. a couple of winding tunnels from the surface toward the depths
  for (let t = 0; t < 3; t++) {
    const sx = 20 + (rng() * (SIM_W - 40)) | 0;
    carveTunnel(solid, sx, surf[sx] + 2,
                20 + (rng() * (SIM_W - 40)) | 0, SIM_H - 10, rng);
  }

  // 5. grand chamber: most seeds get one vast vault, carved before the
  //    connectivity pass so it always joins the cave system. Its floor takes
  //    a proper lake later — whatever the local biome bleeds.
  if (rng() < 0.65) {
    const grx = 18 + (rng() * 12 | 0);
    const gry = 10 + (rng() * 6 | 0);
    const gx = grx + 24 + (rng() * (SIM_W - 2 * (grx + 24))) | 0;
    const gy = 72 + (rng() * (SIM_H - 72 - gry - 12)) | 0;
    for (let dy = -gry; dy <= gry; dy++) {
      const y = gy + dy;
      if (y < 44 || y >= SIM_H - 6) continue;
      for (let dx = -grx; dx <= grx; dx++) {
        const x = gx + dx;
        if (x < 4 || x >= SIM_W - 4) continue;
        const e = (dx * dx) / (grx * grx) + (dy * dy) / (gry * gry);
        // noise-roughened ellipse edge so it reads as a cavern, not a stamp
        if (e <= 1 + (caveNoise(x * 0.15, y * 0.15) - 0.5) * 0.5) solid[idx(x, y)] = 0;
      }
    }
    // basin liner: a solid shell under the lower half so the chamber's lake
    // holds instead of draining into whatever caves run beneath. If it cuts
    // a tunnel, the connectivity pass below re-routes around it.
    for (let dy = 1; dy <= gry + 3; dy++) {
      const y = gy + dy;
      if (y < 44 || y >= SIM_H - 4) continue;
      for (let dx = -grx - 3; dx <= grx + 3; dx++) {
        const x = gx + dx;
        if (x < 4 || x >= SIM_W - 4) continue;
        const e = (dx * dx) / (grx * grx) + (dy * dy) / (gry * gry);
        if (e > 1 && e <= 1.6) solid[idx(x, y)] = 1;
      }
    }
    worldInfo.chamber = { x: gx, y: gy, rx: grx, ry: gry };
  }

  // 6. guarantee the cave system is one connected space
  connectCaverns(solid, rng);

  // 7. commit materials to the sim grid
  clearSim();
  for (let y = 0; y < SIM_H; y++) {
    for (let x = 0; x < SIM_W; x++) {
      const i = idx(x, y);
      if (y >= SIM_H - 3 || ((x < 3 || x >= SIM_W - 3) && y > surf[x])) {
        setCell(i, E.WALL);
        continue;
      }
      if (y <= surf[x] || !solid[i]) continue;
      const biome = BIOMES[worldBiomeMap[i]];
      const vn = fbm(veinNoise, x * 0.09, y * 0.09, 2);
      setCell(i, vn > 1 - biome.veinAmount * 0.55 ? biome.vein : biome.base);
    }
  }

  // 8. liquid pools on cavern floors
  for (let y = 4; y < SIM_H - 4; y++) {
    for (let x = 4; x < SIM_W - 4; x++) {
      const i = idx(x, y);
      if (y <= surf[x] || grid[i] !== E.EMPTY || grid[i + SIM_W] === E.EMPTY) continue;
      const biome = BIOMES[worldBiomeMap[i]];
      if (rng() < biome.liquidAmount * 0.09) {
        paintCircle(x, y - 1, 2 + (rng() * 4 | 0), biome.liquid);
      }
    }
  }
  //    the grand chamber floor takes a lake of the local biome's liquid
  if (worldInfo.chamber) {
    const ch = worldInfo.chamber;
    const liq = BIOMES[worldBiomeMap[idx(ch.x, ch.y)]].liquid;
    for (let dy = (ch.ry * 0.45) | 0; dy <= ch.ry; dy++) {
      const y = ch.y + dy;
      if (y >= SIM_H - 5) break;
      for (let dx = -ch.rx; dx <= ch.rx; dx++) {
        const x = ch.x + dx;
        if (x < 4 || x >= SIM_W - 4) continue;
        if ((dx * dx) / (ch.rx * ch.rx) + (dy * dy) / (ch.ry * ch.ry) > 1) continue;
        const i = idx(x, y);
        if (grid[i] === E.EMPTY) setCell(i, liq);
      }
    }
  }

  // 9. let liquids and loose powders settle (movement only — no fire/chemistry)
  worldSettling = true;
  for (let k = 0; k < 300; k++) simStep();
  worldSettling = false;

  // 10. decoration: vegetation coating on cave surfaces, plus (per biome)
  //    vines hanging from ceilings and grass tufts growing from floors
  const isGrowBase = id => id === E.STONE || id === E.ICE || id === E.WOOD;
  for (let y = 2; y < SIM_H - 4; y++) {
    for (let x = 4; x < SIM_W - 4; x++) {
      const i = idx(x, y);
      if (y <= surf[x] || grid[i] !== E.EMPTY) continue;
      const biome = BIOMES[worldBiomeMap[i]];
      if (!biome.deco && !biome.fauna) continue;
      const ceiling = isGrowBase(grid[i - SIM_W]);
      const floor = isGrowBase(grid[i + SIM_W]);
      const wall = isGrowBase(grid[i - 1]) || isGrowBase(grid[i + 1]);

      // ambient fauna: mostly grazers, the odd hunter to keep them honest
      if (biome.fauna && floor && rng() < biome.fauna) {
        setCell(i, rng() < 0.12 ? E.PRED : E.BUG);
        continue;
      }
      if (!biome.deco) continue;

      // vines trail down from ceilings
      if (ceiling && biome.vineChance && rng() < biome.vineChance) {
        const len = 2 + (rng() * biome.vineLen) | 0;
        for (let v = 0; v < len && y + v < SIM_H - 4; v++) {
          const j = idx(x, y + v);
          if (grid[j] !== E.EMPTY) break;
          setCell(j, biome.deco);
        }
      }
      // grass tufts reach up from floors
      if (floor && biome.tuftChance && rng() < biome.tuftChance) {
        const len = 1 + (rng() * biome.tuftLen) | 0;
        for (let v = 0; v < len && y - v > 1; v++) {
          const j = idx(x, y - v);
          if (grid[j] !== E.EMPTY) break;
          setCell(j, biome.deco);
        }
      }
      // moss coating on any remaining bare cave surface
      if (grid[i] === E.EMPTY && (ceiling || floor || wall) && rng() < biome.decoAmount) {
        setCell(i, biome.deco);
      }
    }
  }
  // surface grass
  for (let x = 3; x < SIM_W - 3; x++) {
    const below = idx(x, surf[x] + 1);
    if ((grid[below] === E.STONE || grid[below] === E.ICE) && rng() < 0.55) {
      setCell(idx(x, surf[x]), E.PLANT);
    }
  }

  // 11. set-pieces: life beyond the flora coating.
  //    Mushroom groves sprout from dark cavern floors (stalk + cap)
  for (let y = 4; y < SIM_H - 5; y++) {
    for (let x = 5; x < SIM_W - 5; x++) {
      const i = idx(x, y);
      if (y <= surf[x] || grid[i] !== E.EMPTY) continue;
      const biome = BIOMES[worldBiomeMap[i]];
      if (!biome.fungus || !isGrowBase(grid[i + SIM_W]) || rng() >= biome.fungus) continue;
      let top = y;
      const stalk = 1 + (rng() * 3 | 0);
      for (let v = 0; v < stalk && top > 2 && grid[idx(x, top)] === E.EMPTY; v++) {
        setCell(idx(x, top), E.FUNGUS);
        top--;
      }
      const cap = 1 + (rng() * 2 | 0);
      for (let dx = -cap; dx <= cap; dx++) {
        const j = idx(x + dx, top);
        if (grid[j] === E.EMPTY) setCell(j, E.FUNGUS);
      }
    }
  }
  //    Kelp beds reach up from pool floors; the bigger pools get fish
  let fishBudget = 14;
  for (let y = 6; y < SIM_H - 4; y++) {
    for (let x = 5; x < SIM_W - 5; x++) {
      const i = idx(x, y);
      if (grid[i] !== E.WATER) continue;
      const bed = grid[i + SIM_W];
      if ((bed === E.STONE || bed === E.SAND || bed === E.WALL) && rng() < 0.05) {
        const len = 1 + (rng() * 4 | 0);
        for (let v = 0; v < len && y - v > 2; v++) {
          const j = idx(x, y - v);
          if (grid[j] !== E.WATER) break;
          setCell(j, E.PLANT);
        }
        continue;
      }
      // fish need open water on all sides — only pools with real volume
      if (fishBudget > 0 &&
          grid[i - SIM_W] === E.WATER && grid[i + SIM_W] === E.WATER &&
          grid[i - 1] === E.WATER && grid[i + 1] === E.WATER && rng() < 0.02) {
        setCell(i, E.FISH);
        fishBudget--;
      }
    }
  }
  //    Moths flutter above vegetation
  let mothBudget = 10;
  for (let y = 4; y < SIM_H - 4 && mothBudget > 0; y++) {
    for (let x = 5; x < SIM_W - 5; x++) {
      const i = idx(x, y);
      if (grid[i] === E.EMPTY && grid[i + SIM_W] === E.PLANT && rng() < 0.005) {
        setCell(i, E.MOTH);
        if (--mothBudget === 0) break;
      }
    }
  }

  // 12. machinery: abandoned works, but only in the Rusted Works biome where
  //     they belong (generators wired to coolant basins, oil vats, munitions
  //     crates). Placed on any solid ledge with clear air; reachability is
  //     re-checked after generation, so a machine can't seal the level.
  let machinesLeft = 3;
  for (let attempt = 0; attempt < 300 && machinesLeft > 0; attempt++) {
    const rx = 14 + (rng() * (SIM_W - 28)) | 0;
    const ry = 6 + (rng() * (SIM_H - 40)) | 0;
    if (ry <= surf[rx] || grid[idx(rx, ry)] !== E.EMPTY) continue;
    if (!BIOMES[worldBiomeMap[idx(rx, ry)]].works) continue;
    // drop to the floor of the pocket
    let fy = ry;
    while (fy < SIM_H - 8 && grid[idx(rx, fy + 1)] === E.EMPTY) fy++;
    if (fy >= SIM_H - 8) continue;
    // want a mostly-solid ledge under a mostly-clear 11-wide pocket
    let ledge = 0, blocked = 0;
    for (let dx = -5; dx <= 5; dx++) {
      const below = grid[idx(rx + dx, fy + 1)];
      if (below !== E.EMPTY && TYPE[below] === T.STATIC) ledge++;
      for (let dy = 0; dy < 6; dy++) {
        if (grid[idx(rx + dx, fy - dy)] !== E.EMPTY) blocked++;
      }
    }
    if (ledge < 8 || blocked > 10) continue;

    const r = rng();
    if (r < 0.5) stampGenerator(rx, fy);
    else if (r < 0.8) stampOilVat(rx, fy);
    else stampCrate(rx, fy);
    machinesLeft--;
  }

  // 13. ambient temperature from the biome map (ice caves are freezing, the
  //     volcanic depths swelter) — the field starts at its equilibrium
  for (let ty = 0; ty < TEMP_H; ty++) {
    for (let tx = 0; tx < TEMP_W; tx++) {
      const b = BIOMES[worldBiomeMap[idx(tx * 4 + 2, ty * 4 + 2)]];
      ambientTemp[ty * TEMP_W + tx] = b.temp;
    }
  }
  temp.set(ambientTemp);
}

function biomeNameAt(x, y) {
  if (x < 0 || x >= SIM_W || y < 0 || y >= SIM_H) return '';
  return BIOMES[worldBiomeMap[idx(x, y)]].name;
}

// --- boss chambers ----------------------------------------------------------
// Boss depths get a purpose-built (but still seed-varied) arena instead of a
// random cave, so the fight's ingredients are guaranteed: a bounded room the
// boss can't tunnel out of, diggable interior, and — for the Magma Worm — a
// large water reservoir that is both its weakness and, once the arena
// superheats, the player's refuge. game.js reads `bossArena` for spawn/portal.
let bossArena = null;

function generateBossChamber(seedStr, boss) {
  worldSeed = seedStr;
  const seed = hashSeed(seedStr);
  seedSim(seed ^ 0x5F356495);
  const rng = mulberry32(seed);
  const noise = makeNoise2D(mulberry32(seed ^ 0x51ED2769));
  clearSim();
  worldInfo = { openness: 0, chamber: null };

  // the tempest is a flyer: give it headroom, taller cover, smaller pools.
  // The overgrowth's arena is a tinderbox: wooden cover, oil pockets.
  const storm = boss === 'tempest';
  const grove = boss === 'overgrowth';
  const CEIL = storm ? 15 : 24;
  const FLOOR = SIM_H - 24;

  // 1. solid rock everywhere, indestructible WALL on the border (contained)
  for (let y = 0; y < SIM_H; y++) {
    for (let x = 0; x < SIM_W; x++) {
      const border = x < 3 || x >= SIM_W - 3 || y < 3 || y >= SIM_H - 3;
      setCell(idx(x, y), border ? E.WALL : E.STONE);
    }
  }

  // 2. carve the open arena between ceiling and floor (organic top edge)
  for (let x = 6; x < SIM_W - 6; x++) {
    const top = CEIL + (noise(x * 0.05, 0.3) * 8 | 0);
    for (let y = top; y < FLOOR; y++) setCell(idx(x, y), E.EMPTY);
  }

  // 3. a central water reservoir sunk into the floor — kept clear of the
  //    left spawn shelf and the right portal shelf. The worm's arena gets a
  //    wide quench pool; the tempest's a modest one (its squalls add more).
  const rw = (storm ? 18 : grove ? 14 : 32) + (rng() * 8 | 0);
  const rcx = Math.max(rw + 28, Math.min(SIM_W - rw - 26, (SIM_W >> 1) + (rng() * 30 - 15 | 0)));
  for (let x = rcx - rw; x <= rcx + rw; x++) {
    if (x < 8 || x >= SIM_W - 8) continue;
    for (let y = FLOOR; y <= FLOOR + 7; y++) setCell(idx(x, y), E.WATER);
  }

  // 4. cover pillars (diggable rock) in the side thirds, clear of the pool.
  //    In the tempest arena they're taller (bolt shelter) and metal-capped —
  //    lightning rods that ground its nova out before it reaches you.
  const pillars = 3 + (rng() * 2 | 0);
  for (let p = 0; p < pillars; p++) {
    const px = 20 + (rng() * (SIM_W - 40) | 0);
    if (Math.abs(px - rcx) < rw + 8) continue;
    const ph = (storm ? 22 : 14) + (rng() * 22 | 0);
    const pw = 2 + (rng() * 2 | 0);
    for (let x = px; x < px + pw && x < SIM_W - 6; x++) {
      // grove arena: pillars are WOOD — cover that doubles as fuel
      for (let y = FLOOR - ph; y < FLOOR; y++) {
        setCell(idx(x, y), grove ? E.WOOD : E.STONE);
      }
      if (storm) {
        for (let d = 1; d <= 3; d++) setCell(idx(x, FLOOR - ph - d), E.METAL);
      }
      if (grove) setCell(idx(x, FLOOR - ph - 1), E.PLANT);
    }
  }

  // 5. ceiling stalactites for texture (the worm tunnels through them anyway)
  for (let x = 8; x < SIM_W - 8; x++) {
    if (noise(x * 0.12, 2.7) > 0.72) {
      const len = 2 + (noise(x * 0.3, 5.0) * 5 | 0);
      for (let d = 0; d < len; d++) setCell(idx(x, CEIL + d), E.STONE);
    }
  }

  // 5b. grove arena extras: two open OIL pockets sunk into the floor — big
  //     fire plays for whoever dares to light them
  if (grove) {
    for (let p = 0; p < 2; p++) {
      const ox = 30 + (rng() * (SIM_W - 60) | 0);
      if (Math.abs(ox - rcx) < rw + 14) continue; // clear of the pool
      for (let x = ox - 5; x <= ox + 5; x++) {
        for (let y = FLOOR; y <= FLOOR + 3; y++) setCell(idx(x, y), E.OIL);
      }
    }
  }

  // 6. ambient to match the guardian: warm-but-survivable for the worm (the
  //    fight cranks it hotter via lava); temperate storm air for the tempest;
  //    mild growing weather for the overgrowth
  worldBiomeMap.fill(Math.max(0, BIOMES.findIndex(
    b => b.name === (storm ? 'Rusted Works'
      : grove ? 'Overgrown Vault' : 'Volcanic Depths'))));
  ambientTemp.fill(storm ? 18 : grove ? 20 : 35);
  temp.set(ambientTemp);

  // 7. settle the reservoir (movement only — no chemistry)
  worldSettling = true;
  for (let k = 0; k < 120; k++) simStep();
  worldSettling = false;

  bossArena = { spawnX: 12, portalX: SIM_W - 14, floorY: FLOOR, reservoirX: rcx };
}

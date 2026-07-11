// CINDER — procedural world generation
// Seeded caves + biome materials. Pipeline:
//   1. seeded value-noise fBm carves caverns under a rough terrain surface
//   2. drunkard-walk tunnels add vertical routes
//   3. flood-fill connectivity pass tunnels stray pockets into the main cave
//   4. Voronoi biome regions (jittered borders) assign materials + veins
//   5. liquid pools are dropped in, then the sim itself runs in "settle mode"
//      (movement only, no fire/reactions) so pools rest naturally
//   6. decoration pass: plants, surface grass
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

const BIOMES = [
  { name: 'Stone Caverns',   base: E.STONE, vein: E.SAND,      veinAmount: 0.30, liquid: E.WATER, liquidAmount: 0.30, deco: E.PLANT, decoAmount: 0.05, fauna: 0.004, temp: 12,  depth: [0, 1] },
  { name: 'Overgrown Vault', base: E.STONE, vein: E.WOOD,      veinAmount: 0.35, liquid: E.WATER, liquidAmount: 0.40, deco: E.PLANT, decoAmount: 0.85,
    vineChance: 0.30, vineLen: 10, tuftChance: 0.35, tuftLen: 4, fauna: 0.02, temp: 22, depth: [0, 0.6] },
  { name: 'Ice Caves',       base: E.ICE,   vein: E.STONE,     veinAmount: 0.35, liquid: E.WATER, liquidAmount: 0.20, deco: 0,       decoAmount: 0,    temp: -12, depth: [0, 0.7] },
  { name: 'Oil Caverns',     base: E.STONE, vein: E.GUNPOWDER, veinAmount: 0.20, liquid: E.OIL,   liquidAmount: 0.45, deco: 0,       decoAmount: 0,    temp: 18,  depth: [0.3, 1],  hazardous: true },
  { name: 'Volcanic Depths', base: E.STONE, vein: E.SAND,      veinAmount: 0.15, liquid: E.LAVA,  liquidAmount: 0.35, deco: 0,       decoAmount: 0,    temp: 55,  depth: [0.55, 1], hazardous: true },
];

const worldBiomeMap = new Uint8Array(CELLS);
let worldSeed = '';

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

  // 1. terrain surface line, then noise-carved caverns below it
  const surf = new Int16Array(SIM_W);
  for (let x = 0; x < SIM_W; x++) {
    surf[x] = 20 + (fbm(surfNoise, x * 0.02, 0.5, 3) * 16) | 0;
  }
  const solid = new Uint8Array(CELLS);
  for (let y = 0; y < SIM_H; y++) {
    for (let x = 0; x < SIM_W; x++) {
      if (y <= surf[x]) continue; // sky
      const depth = (y - surf[x]) / (SIM_H - surf[x]);
      if (y - surf[x] < 4) { solid[idx(x, y)] = 1; continue; } // ground crust
      const n = fbm(caveNoise, x * 0.04, y * 0.04, 4);
      // deeper = slightly more closed-in
      if (n > 0.52 - depth * 0.08) solid[idx(x, y)] = 1;
    }
  }

  // 2. a couple of winding tunnels from the surface toward the depths
  for (let t = 0; t < 3; t++) {
    const sx = 20 + (rng() * (SIM_W - 40)) | 0;
    carveTunnel(solid, sx, surf[sx] + 2,
                20 + (rng() * (SIM_W - 40)) | 0, SIM_H - 10, rng);
  }

  // 3. guarantee the cave system is one connected space
  connectCaverns(solid, rng);

  // 4. biome regions: jittered Voronoi over scattered seed sites
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

  // 5. commit materials to the sim grid
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

  // 6. liquid pools on cavern floors
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

  // 7. let liquids and loose powders settle (movement only — no fire/chemistry)
  worldSettling = true;
  for (let k = 0; k < 300; k++) simStep();
  worldSettling = false;

  // 8. decoration: vegetation coating on cave surfaces, plus (per biome)
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

  // 9. ambient temperature from the biome map (ice caves are freezing, the
  //    volcanic depths swelter) — the field starts at its equilibrium
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

// CINDER — element definitions (data layer)
// Everything about an element lives here: how it moves, what it looks like,
// how it burns, and how it reacts with neighbors. The sim only reads this data,
// so a future roguelite layer can mutate/extend it per-run (new elements,
// modified reactions, buffed flammability, etc.) without touching sim code.

'use strict';

// Element IDs (fit in a Uint8Array cell)
const E = {
  EMPTY: 0,
  WALL: 1,       // indestructible boundary material
  STONE: 2,      // static, but acid can eat it
  SAND: 3,
  WATER: 4,
  OIL: 5,
  WOOD: 6,
  PLANT: 7,
  FIRE: 8,
  SMOKE: 9,
  STEAM: 10,
  ACID: 11,
  LAVA: 12,
  GUNPOWDER: 13,
  ICE: 14,
  ELEC: 15,    // transient electric spark
  EWATER: 16,  // electrified ("live") water — conducts, shocks, decays back
  SEED: 17,    // dropped by plants; floats on water, germinates near it
  ASH: 18,     // what fire leaves behind; fertilizes water into plants
  BUG: 19,     // cellular grazer: eats plants, breeds, starves back to ash
  SNOW: 20,    // cold precipitation; piles, melts near heat, dissolves in water
  METAL: 21,   // conducts electricity along its surface; corrodes in acid
  GLASS: 22,   // lava + sand; acid-proof, shatters in explosions
  HYDROGEN: 23, // electrolysis gas; rises, accumulates at ceilings, flash-burns
  PRED: 24,    // hunter: eats bugs — the second trophic level
};

// Movement archetypes
const T = {
  STATIC: 0,
  POWDER: 1,   // falls, piles up (sand)
  LIQUID: 2,   // falls, spreads horizontally
  GAS: 3,      // rises, wanders, dissipates
  FIRE: 4,     // special: flickers up, ignites, dies to smoke/ash
  BUG: 5,      // special: crawls, grazes plants, reproduces, starves
};

const DEFS = {
  [E.EMPTY]:     { name: 'Empty',     type: T.STATIC, color: [12, 12, 16],    colorVar: 0,  density: 0 },
  [E.WALL]:      { name: 'Wall',      type: T.STATIC, color: [90, 90, 100],   colorVar: 12, density: 100 },
  [E.STONE]:     { name: 'Stone',     type: T.STATIC, color: [125, 122, 118], colorVar: 18, density: 100, dissolvable: true },
  [E.SAND]:      { name: 'Sand',      type: T.POWDER, color: [222, 182, 110], colorVar: 24, density: 60,  dissolvable: true },
  [E.WATER]:     { name: 'Water',     type: T.LIQUID, color: [38, 116, 214],  colorVar: 14, density: 30,  dispersion: 5 },
  [E.OIL]:       { name: 'Oil',       type: T.LIQUID, color: [88, 66, 44],    colorVar: 10, density: 20,  dispersion: 3,
                   flammability: 0.25, burnLife: 140, dissolvable: true },
  [E.WOOD]:      { name: 'Wood',      type: T.STATIC, color: [128, 88, 50],   colorVar: 16, density: 100,
                   flammability: 0.015, burnLife: 420, dissolvable: true },
  [E.PLANT]:     { name: 'Plant',     type: T.STATIC, color: [58, 158, 68],   colorVar: 22, density: 100,
                   flammability: 0.12, burnLife: 90, dissolvable: true },
  [E.FIRE]:      { name: 'Fire',      type: T.FIRE,   color: [255, 140, 20],  colorVar: 0,  density: 1,
                   lifeMin: 30, lifeMax: 90 },
  [E.SMOKE]:     { name: 'Smoke',     type: T.GAS,    color: [66, 64, 70],    colorVar: 12, density: 1,
                   lifeMin: 60, lifeMax: 180 },
  [E.STEAM]:     { name: 'Steam',     type: T.GAS,    color: [196, 208, 220], colorVar: 16, density: 1,
                   lifeMin: 80, lifeMax: 200 },
  [E.ACID]:      { name: 'Acid',      type: T.LIQUID, color: [140, 228, 50],  colorVar: 26, density: 32,  dispersion: 4 },
  [E.LAVA]:      { name: 'Lava',      type: T.LIQUID, color: [226, 88, 16],   colorVar: 30, density: 40,  dispersion: 1 },
  [E.GUNPOWDER]: { name: 'Gunpowder', type: T.POWDER, color: [52, 50, 54],    colorVar: 14, density: 55,
                   flammability: 0.6, explosive: true, dissolvable: true },
  [E.ICE]:       { name: 'Ice',       type: T.STATIC, color: [158, 208, 238], colorVar: 12, density: 100, dissolvable: true },
  [E.ELEC]:      { name: 'Electric',  type: T.GAS,    color: [255, 250, 170], colorVar: 0,  density: 1,
                   lifeMin: 6, lifeMax: 16 },
  [E.EWATER]:    { name: 'Live Water', type: T.LIQUID, color: [70, 190, 255], colorVar: 14, density: 30, dispersion: 5,
                   lifeMin: 40, lifeMax: 70 },
  // density 25 < water's 30: seeds float and drift to new shores
  [E.SEED]:      { name: 'Seed',      type: T.POWDER, color: [196, 204, 116], colorVar: 20, density: 25,
                   flammability: 0.25, burnLife: 30, dissolvable: true },
  [E.ASH]:       { name: 'Ash',       type: T.POWDER, color: [108, 102, 96],  colorVar: 16, density: 40,
                   dissolvable: true },
  [E.BUG]:       { name: 'Bug',       type: T.BUG,    color: [128, 54, 42],   colorVar: 24, density: 45,
                   flammability: 0.3, burnLife: 40, lifeMin: 240, lifeMax: 320, dissolvable: true },
  [E.SNOW]:      { name: 'Snow',      type: T.POWDER, color: [236, 240, 248], colorVar: 10, density: 20,
                   dissolvable: true },
  [E.METAL]:     { name: 'Metal',     type: T.STATIC, color: [142, 148, 158], colorVar: 8,  density: 100,
                   dissolvable: true },
  [E.GLASS]:     { name: 'Glass',     type: T.STATIC, color: [186, 214, 222], colorVar: 6,  density: 100 }, // acid-proof
  [E.HYDROGEN]:  { name: 'Hydrogen',  type: T.GAS,    color: [196, 178, 214], colorVar: 8,  density: 1,
                   flammability: 0.9, burnLife: 8 }, // no lifetime: pockets persist until ignited
  [E.PRED]:      { name: 'Hunter',    type: T.BUG,    color: [152, 44, 74],   colorVar: 20, density: 45,
                   flammability: 0.3, burnLife: 40, lifeMin: 300, lifeMax: 400, dissolvable: true },
};

const NUM_ELEMENTS = 25;

// Flat typed lookups for the hot sim loop
const TYPE        = new Uint8Array(NUM_ELEMENTS);
const DENSITY     = new Uint8Array(NUM_ELEMENTS);
const DISPERSION  = new Uint8Array(NUM_ELEMENTS);
const FLAMMABLE   = new Float32Array(NUM_ELEMENTS); // ignition chance per exposure
const BURN_LIFE   = new Uint16Array(NUM_ELEMENTS);
const LIFE_MIN    = new Uint16Array(NUM_ELEMENTS);
const LIFE_MAX    = new Uint16Array(NUM_ELEMENTS);
const DISSOLVABLE = new Uint8Array(NUM_ELEMENTS);
const EXPLOSIVE   = new Uint8Array(NUM_ELEMENTS);

for (const id in DEFS) {
  const d = DEFS[id];
  TYPE[id]        = d.type;
  DENSITY[id]     = d.density || 0;
  DISPERSION[id]  = d.dispersion || 0;
  FLAMMABLE[id]   = d.flammability || 0;
  BURN_LIFE[id]   = d.burnLife || 60;
  LIFE_MIN[id]    = d.lifeMin || 0;
  LIFE_MAX[id]    = d.lifeMax || 0;
  DISSOLVABLE[id] = d.dissolvable ? 1 : 0;
  EXPLOSIVE[id]   = d.explosive ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Reactions: data-driven neighbor interactions.
// When cell A is next to cell B, with probability p: A -> a2, B -> b2.
// This table is THE hook for roguelite synergies later — run modifiers can
// add, remove, or reweight entries at runtime.
// ---------------------------------------------------------------------------
const REACTIONS = {};

function addReaction(a, b, a2, b2, p) {
  REACTIONS[(a << 8) | b] = { a2, b2, p };
}

// Water quenches fire (some of the water flashes to steam)
addReaction(E.FIRE, E.WATER, E.SMOKE, E.WATER, 0.9);
addReaction(E.WATER, E.FIRE, E.STEAM, E.SMOKE, 0.4);

// Lava + water -> stone + steam
addReaction(E.LAVA, E.WATER, E.STONE, E.STEAM, 0.8);
addReaction(E.WATER, E.LAVA, E.STEAM, E.STONE, 0.8);

// Lava slowly melts stone, sand (glassing skipped for now), and ice
addReaction(E.ICE, E.LAVA, E.WATER, E.LAVA, 0.5);
addReaction(E.ICE, E.FIRE, E.WATER, E.FIRE, 0.15);

// Ice slowly freezes adjacent water (creeping freeze)
addReaction(E.WATER, E.ICE, E.ICE, E.ICE, 0.002);

// Steam near ice condenses back to water
addReaction(E.STEAM, E.ICE, E.WATER, E.ICE, 0.1);

// Plants drink water to grow
addReaction(E.WATER, E.PLANT, E.PLANT, E.PLANT, 0.02);

// Acid dissolves things (consumes itself sometimes; handled with two entries)
for (const id in DEFS) {
  const n = Number(id);
  if (DISSOLVABLE[n]) {
    addReaction(E.ACID, n, E.ACID, E.EMPTY, 0.04);   // eats the material
  }
}
addReaction(E.ACID, E.WATER, E.WATER, E.WATER, 0.01); // water dilutes acid

// Electricity: sparks discharge into water (the charge wave itself is
// handled in stepLiquid so it decays with distance), and ignite oil
addReaction(E.WATER, E.ELEC, E.EWATER, E.EMPTY, 1.0);
addReaction(E.ELEC, E.WATER, E.EMPTY, E.EWATER, 1.0);
addReaction(E.OIL, E.ELEC, E.FIRE, E.EMPTY, 0.4);

// --- ecosystem cycles -------------------------------------------------------
// Seeds germinate on contact with water (consuming it: water becomes biomass)
addReaction(E.SEED, E.WATER, E.PLANT, E.EMPTY, 0.01);
addReaction(E.WATER, E.SEED, E.EMPTY, E.PLANT, 0.01);
// Ash fertilizes: burned forests + rain -> regrowth
addReaction(E.ASH, E.WATER, E.PLANT, E.EMPTY, 0.004);
addReaction(E.WATER, E.ASH, E.EMPTY, E.PLANT, 0.004);
// Burning vegetation releases its moisture as steam (fires seed rain)
addReaction(E.PLANT, E.FIRE, E.STEAM, E.FIRE, 0.04);

// Glassmaking: lava fuses sand
addReaction(E.SAND, E.LAVA, E.GLASS, E.LAVA, 0.08);
addReaction(E.LAVA, E.SAND, E.LAVA, E.GLASS, 0.08);

// Snow: melts near heat, flashes to steam on lava, dissolves in water
addReaction(E.SNOW, E.FIRE, E.WATER, E.FIRE, 0.5);
addReaction(E.SNOW, E.LAVA, E.STEAM, E.LAVA, 0.6);
addReaction(E.SNOW, E.WATER, E.WATER, E.WATER, 0.05);

// Electrolysis: heavily electrified water bubbles off a little hydrogen
// (kept slow — charging a pool shouldn't meaningfully drain it)
addReaction(E.EWATER, E.EWATER, E.HYDROGEN, E.EWATER, 0.0008);

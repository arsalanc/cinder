// CINDER — synergy system
// Run modifiers ("synergies") picked between levels. Each one mutates the
// live element data (FLAMMABLE, REACTIONS, ...) and/or the player-facing
// runState below. Baselines are snapshotted at load so resetModifiers()
// restores a pristine sim for a new run or for sandbox mode.

'use strict';

// Player-facing knobs modifiers can turn. The player reads these each frame.
const runState = {
  mult: null,        // damage/movement multipliers (set in resetModifiers)
  auras: [],         // { from, to, r, p, surface? } — cell transforms near player
  heals: {},         // element id -> hp per frame while touching it
  onDamage: [],      // callbacks fired when the player takes damage
  trampleHeal: 0,    // hp per plant broken by walking through it
  stomp: false,      // Iron Boots: landing on any enemy crushes it
  emitHeat: 0,       // Ember Heart: degrees/frame radiated into the temp field
  weatherLock: null, // Storm Caller: weather mode forced for the whole run
  lightningWard: false, // Storm Caller: sky bolts never strike near you
};

// pristine copies of everything modifiers may touch
const BASELINE = {
  flammable: FLAMMABLE.slice(),
  burnLife: BURN_LIFE.slice(),
  lifeMin: LIFE_MIN.slice(),
  lifeMax: LIFE_MAX.slice(),
  dispersion: DISPERSION.slice(),
  reactions: JSON.parse(JSON.stringify(REACTIONS)),
};

function resetModifiers() {
  FLAMMABLE.set(BASELINE.flammable);
  BURN_LIFE.set(BASELINE.burnLife);
  LIFE_MIN.set(BASELINE.lifeMin);
  LIFE_MAX.set(BASELINE.lifeMax);
  DISPERSION.set(BASELINE.dispersion);
  for (const k in REACTIONS) delete REACTIONS[k];
  const base = JSON.parse(JSON.stringify(BASELINE.reactions));
  for (const k in base) REACTIONS[k] = base[k];
  explosionScale = 1;
  runState.mult = { fireDmg: 1, lavaDmg: 1, acidDmg: 1, burnTime: 1, speed: 1,
                    jump: 1, manaRegen: 1, coldDmg: 1, heatDmg: 1,
                    elecDmg: 1, windowLen: 1 };
  runState.auras = [];
  runState.heals = {};
  runState.onDamage = [];
  runState.trampleHeal = 0;
  runState.stomp = false;
  runState.emitHeat = 0;
  runState.weatherLock = null;
  runState.lightningWard = false;
}

const MODIFIERS = [
  {
    name: 'Pyromaniac', tags: ['fire'],
    desc: 'The world is far more flammable and burns longer. Fire only tickles you.',
    apply() {
      for (let i = 0; i < NUM_ELEMENTS; i++) {
        FLAMMABLE[i] = Math.min(1, FLAMMABLE[i] * 2.5);
        if (FLAMMABLE[i] > 0) BURN_LIFE[i] = (BURN_LIFE[i] * 1.6) | 0;
      }
      runState.mult.fireDmg *= 0.4;
      runState.mult.burnTime *= 0.5;
    },
  },
  {
    name: 'Fireproof Hide', tags: ['fire', 'survival'],
    desc: 'Fire barely hurts, lava is survivable, and you stop burning almost immediately.',
    apply() {
      runState.mult.fireDmg *= 0.15;
      runState.mult.lavaDmg *= 0.35;
      runState.mult.burnTime *= 0.25;
    },
  },
  {
    name: 'Frost Aura', tags: ['frost'],
    desc: 'The surface of water near you freezes into a walkable crust. The depths stay liquid.',
    apply() {
      // surface-only: the pool below survives, so you can't accidentally
      // freeze away the reservoir a boss fight depends on
      runState.auras.push({ from: E.WATER, to: E.ICE, r: 5, p: 0.08, surface: true });
    },
  },
  {
    name: 'Lava Strider', tags: ['fire', 'survival'],
    desc: 'Lava you approach crusts into stone, and what does touch you burns less.',
    unlock: { stat: 'wins', at: 1, hint: 'Win a run' },
    apply() {
      runState.auras.push({ from: E.LAVA, to: E.STONE, r: 4, p: 0.25 });
      runState.mult.lavaDmg *= 0.6;
    },
  },
  {
    name: 'Steam Sprite', tags: ['fire', 'survival'],
    desc: 'Steam heals you and lingers far longer. Boil a lake, breathe it in.',
    apply() {
      runState.heals[E.STEAM] = 0.06;
      LIFE_MIN[E.STEAM] = (LIFE_MIN[E.STEAM] * 2.5) | 0;
      LIFE_MAX[E.STEAM] = (LIFE_MAX[E.STEAM] * 2.5) | 0;
    },
  },
  {
    name: 'Green Thumb', tags: ['nature', 'survival'],
    desc: 'Plants spread through water aggressively, and trampling them heals you.',
    apply() {
      addReaction(E.WATER, E.PLANT, E.PLANT, E.PLANT, 0.12);
      runState.trampleHeal = 0.4;
    },
  },
  {
    name: 'Acid Blood', tags: ['acid'],
    desc: 'Taking damage makes you leak acid, and acid corrodes you far less.',
    unlock: { stat: 'kills', at: 15, hint: 'Kill 15 creatures' },
    apply() {
      runState.mult.acidDmg *= 0.4;
      runState.onDamage.push(() => {
        if (rand() > 0.2) return;
        const fx = Math.round(player.x + rand() * player.w);
        const fy = Math.ceil(player.y + player.h);
        if (fx >= 0 && fx < SIM_W && fy < SIM_H && grid[idx(fx, fy)] === E.EMPTY) {
          setCell(idx(fx, fy), E.ACID);
        }
      });
    },
  },
  {
    name: 'Demolitionist', tags: ['blast'],
    desc: 'Explosions are much bigger. Gunpowder is your friend. Probably.',
    unlock: { stat: 'bestDepth', at: 4, hint: 'Reach depth 4' },
    apply() {
      explosionScale *= 1.7;
    },
  },
  {
    name: 'Fleetfoot', tags: ['mobility'],
    desc: 'Move faster and jump higher.',
    apply() {
      runState.mult.speed *= 1.3;
      runState.mult.jump *= 1.15;
    },
  },
  {
    name: 'Powder Bomb', tags: ['blast', 'wand'],
    desc: 'Your wand learns Powder Bomb: a lobbed charge with a devastating blast.',
    unlock: { stat: 'bestDepth', at: 3, hint: 'Reach depth 3' },
    apply() {
      grantSpell('bomb');
    },
  },
  {
    name: 'Acid Spit', tags: ['acid', 'wand'],
    desc: 'Your wand learns Acid Spit: melt terrain from a safe distance.',
    apply() {
      grantSpell('acid');
    },
  },
  {
    name: 'Flamethrower', tags: ['fire', 'wand'],
    desc: 'Your wand learns Flamethrower: point blank, everything burns. Including, possibly, you.',
    unlock: { stat: 'kills', at: 10, hint: 'Kill 10 creatures' },
    apply() {
      grantSpell('flame');
    },
  },
  {
    name: 'Arc Bolt', tags: ['storm', 'wand'],
    desc: 'Your wand learns Arc Bolt: electricity that turns pools into kill zones.',
    apply() {
      grantSpell('arc');
    },
  },
  {
    name: 'Overcharge', tags: ['wand'],
    desc: 'Mana regenerates 80% faster. Cast with abandon.',
    apply() {
      runState.mult.manaRegen *= 1.8;
    },
  },
  {
    name: 'Wand: Twin Cast', tags: ['wand'],
    desc: 'Every cast fires an extra projectile, at a slight cooldown cost.',
    unlock: { stat: 'bestDepth', at: 2, hint: 'Reach depth 2' },
    apply() {
      wandMods.extraCasts += 1;
      wandMods.cooldownMult *= 1.2;
    },
  },
  {
    name: 'Wand: Rapid Fire', tags: ['wand'],
    desc: 'Your wand cools down 45% faster.',
    apply() {
      wandMods.cooldownMult *= 0.55;
    },
  },
  {
    name: 'Wand: Amplifier', tags: ['wand'],
    desc: 'Projectiles hit 50% harder and burst with a bigger splash.',
    apply() {
      wandMods.damageMult *= 1.5;
      wandMods.radiusBonus += 1;
    },
  },
  {
    name: 'Wand: Bouncing Shots', tags: ['wand'],
    desc: 'Projectiles ricochet off terrain one more time before bursting.',
    unlock: { stat: 'kills', at: 25, hint: 'Kill 25 creatures' },
    apply() {
      wandMods.bounces += 1;
    },
  },
  {
    name: 'Storm Caller', tags: ['storm'],
    desc: 'The storm never ends — and its lightning never strikes near you.',
    unlock: { stat: 'bestDepth', at: 5, hint: 'Reach depth 5' },
    apply() {
      runState.weatherLock = 'storm';
      runState.lightningWard = true;
    },
  },
  {
    name: 'Insulated', tags: ['storm', 'survival'],
    desc: 'Electricity barely tickles you. Live water is your wading pool.',
    apply() {
      runState.mult.elecDmg *= 0.15;
    },
  },
  {
    name: 'Executioner', tags: ['wand'],
    desc: 'Vulnerability windows last half again as long. Make them count.',
    unlock: { stat: 'kills', at: 30, hint: 'Kill 30 creatures' },
    apply() {
      runState.mult.windowLen *= 1.5;
    },
  },
  {
    name: 'Iron Boots', tags: ['mobility', 'survival'],
    desc: 'Landing on any enemy crushes it, armor and all — then you bounce clear.',
    apply() {
      runState.stomp = true;
    },
  },
  {
    name: 'Winter Pelt', tags: ['frost', 'survival'],
    desc: 'Hypothermia cannot touch you. Heat, though, bites much harder.',
    apply() {
      runState.mult.coldDmg *= 0;
      runState.mult.heatDmg *= 1.6;
    },
  },
  {
    name: 'Furnace Heart', tags: ['fire', 'survival'],
    desc: 'Heatstroke cannot touch you. The cold, though, bites much harder.',
    apply() {
      runState.mult.heatDmg *= 0;
      runState.mult.coldDmg *= 1.6;
    },
  },
  {
    name: 'Ember Heart', tags: ['fire'],
    desc: 'You radiate furnace heat: never cold, ice and snow melt around you — but water simmers away near you.',
    unlock: { stat: 'kills', at: 20, hint: 'Kill 20 creatures' },
    apply() {
      runState.emitHeat = 2.0; // degrees/frame into the player's temp cells
    },
  },
  {
    name: 'Tunneler', tags: ['mobility'],
    desc: 'Stone, sand, and ice near you slowly crumble away. You are the shovel.',
    apply() {
      runState.auras.push({ from: E.STONE, to: E.EMPTY, r: 3, p: 0.03 });
      runState.auras.push({ from: E.SAND, to: E.EMPTY, r: 3, p: 0.03 });
      runState.auras.push({ from: E.ICE, to: E.EMPTY, r: 3, p: 0.03 });
    },
  },
];

resetModifiers(); // initialize runState.mult etc. at load

// n random modifiers: unlocked only, avoiding already-taken while possible.
// Rolls are TAG-WEIGHTED: mods sharing tags with what you've already taken
// show up more often, so runs drift into builds (fire run, wand run, ...)
// instead of staying uniform grab-bags.
function rollChoices(n, takenNames) {
  const available = MODIFIERS.filter(m =>
    typeof isUnlocked !== 'function' || isUnlocked(m));
  let pool = available.filter(m => !takenNames.includes(m.name));
  if (pool.length < n) pool = available.slice();
  const takenTags = {};
  for (const m of MODIFIERS) {
    if (!takenNames.includes(m.name)) continue;
    for (const tg of m.tags || []) takenTags[tg] = (takenTags[tg] || 0) + 1;
  }
  const weight = m => {
    let w = 1;
    for (const tg of m.tags || []) w += 1.5 * (takenTags[tg] || 0);
    return w;
  };
  const picks = [];
  while (picks.length < n && pool.length > 0) {
    let total = 0;
    for (const m of pool) total += weight(m);
    let r = rand() * total;
    let k = 0;
    while (k < pool.length - 1 && (r -= weight(pool[k])) > 0) k++;
    picks.push(pool.splice(k, 1)[0]);
  }
  return picks;
}

// cell transforms around the player (frost aura, tunneling, ...)
function applyAuras() {
  const cx = player.x + player.w / 2;
  const cy = player.y + player.h / 2;
  // never entomb the player: for auras that create solid cells (Frost Aura
  // freezing the water you're standing in), keep a body-shaped gap with a
  // 1-cell margin so you can always move out
  const bx0 = Math.floor(player.x) - 1, bx1 = Math.ceil(player.x + player.w);
  const by0 = Math.floor(player.y) - 1, by1 = Math.ceil(player.y + player.h);
  for (const a of runState.auras) {
    const solidTo = TYPE[a.to] === T.STATIC || TYPE[a.to] === T.POWDER;
    const r2 = a.r * a.r;
    for (let dy = -a.r; dy <= a.r; dy++) {
      const y = Math.round(cy + dy);
      if (y < 1 || y >= SIM_H - 1) continue;
      for (let dx = -a.r; dx <= a.r; dx++) {
        const x = Math.round(cx + dx);
        if (x < 1 || x >= SIM_W - 1) continue;
        if (dx * dx + dy * dy > r2 || rand() >= a.p) continue;
        if (solidTo && x >= bx0 && x <= bx1 && y >= by0 && y <= by1) continue;
        const i = idx(x, y);
        if (grid[i] !== a.from) continue;
        // surface auras only touch cells open to the air above (frost crust)
        if (a.surface && grid[idx(x, y - 1)] !== E.EMPTY) continue;
        setCell(i, a.to);
      }
    }
  }
}

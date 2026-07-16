// CINDER — wand & spells
// In play mode the mouse casts spells instead of painting. Spells cost mana
// (regenerating) and fire projectiles that paint elements into the sim on
// impact. Dig Blast is always in the starter loadout — combined with the
// portal reachability check in game.js, the player can never be soft-locked.

'use strict';

// impact(x, y, boost) — boost is wandMods.radiusBonus from composition mods.
// A spell's `evo` block is its EVOLVED form: once the run holds `need` (2)
// synergies carrying the evo's tag, spellForm() overlays these fields onto
// the base spell — new name, icon, and impact. (Arc Bolt has no tag evo:
// the Stormcore trophy is its evolution.)
const SPELLS = {
  spark: {
    name: 'Spark Bolt', color: '#ffb347', sfx: 'zap', damage: 10,
    cost: 10, cooldown: 12, speed: 2.6, gravity: 0.015, life: 90,
    impact(x, y, b = 0) { splash(x, y, 2 + b, E.FIRE); },
    evo: {
      tag: 'fire', name: 'Meteor Bolt', color: '#ff8c5c', iconKey: 'meteor',
      damage: 16, speed: 2.4, gravity: 0.03,
      impact(x, y, b = 0) {
        splash(x, y, 3 + b, E.FIRE);
        const j = idx(x, Math.max(1, y - 1));
        if (grid[j] === E.EMPTY) setCell(j, E.LAVA); // a molten core
      },
    },
  },
  water: {
    name: 'Water Jet', color: '#4aa3ff', sfx: 'spray', damage: 2,
    cost: 2, cooldown: 2, speed: 2.1, gravity: 0.05, life: 45,
    count: 3, spread: 0.22,
    impact(x, y, b = 0) { splash(x, y, 1 + b, E.WATER); },
    evo: {
      tag: 'frost', name: 'Glacier Jet', color: '#bfe4ff', iconKey: 'glacier',
      damage: 4,
      impact(x, y, b = 0) {
        splash(x, y, 1 + b, E.WATER);
        // flash-freeze the splash's surface (Frost Aura's rule, weaponized —
        // and like the aura, never inside the player)
        const bx0 = Math.floor(player.x) - 1, bx1 = Math.ceil(player.x + player.w);
        const by0 = Math.floor(player.y) - 1, by1 = Math.ceil(player.y + player.h);
        const r = 2 + b;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const cx = x + dx, cy = y + dy;
            if (cx < 1 || cx >= SIM_W - 1 || cy < 2 || cy >= SIM_H - 1) continue;
            if (cx >= bx0 && cx <= bx1 && cy >= by0 && cy <= by1) continue;
            const j = idx(cx, cy);
            if (grid[j] === E.WATER && grid[j - SIM_W] === E.EMPTY && rand() < 0.7) {
              setCell(j, E.ICE);
            }
          }
        }
      },
    },
  },
  dig: {
    name: 'Dig Blast', color: '#d8c9a8', sfx: 'dig', damage: 6,
    cost: 4, cooldown: 9, speed: 2.4, gravity: 0, life: 11, // life caps range
    impact(x, y, b = 0) { digCircle(x, y, 3 + b); },
    evo: {
      tag: 'mobility', name: 'Tunnel Charge', color: '#e8d9b8', iconKey: 'tunnel',
      cost: 3, cooldown: 3,
      impact(x, y, b = 0) { digCircle(x, y, 5 + b); },
    },
  },
  bomb: {
    name: 'Powder Bomb', color: '#ff6a4a', sfx: 'lob', damage: 18,
    cost: 28, cooldown: 50, speed: 2.0, gravity: 0.045, life: 240,
    impact(x, y, b = 0) { explode(x, y, ((7 + 2 * b) * explosionScale) | 0); playSfx('explosion'); },
    evo: {
      tag: 'blast', name: 'Powder Keg', color: '#ff4a2a', iconKey: 'keg',
      damage: 24,
      impact(x, y, b = 0) {
        explode(x, y, ((9 + 2 * b) * explosionScale) | 0);
        // scatter burning powder into the crater: secondary pops
        for (let k = 0; k < 12; k++) {
          const sx = x + ((rand() * 13) | 0) - 6, sy = y + ((rand() * 13) | 0) - 6;
          if (sx > 1 && sx < SIM_W - 1 && sy > 1 && sy < SIM_H - 1 &&
              grid[idx(sx, sy)] === E.EMPTY) setCell(idx(sx, sy), E.GUNPOWDER);
        }
        splash(x, y, 1, E.FIRE);
        playSfx('explosion');
      },
    },
  },
  acid: {
    name: 'Acid Spit', color: '#a0e83c', sfx: 'spit', damage: 9,
    cost: 9, cooldown: 12, speed: 2.2, gravity: 0.03, life: 90,
    impact(x, y, b = 0) { splash(x, y, 2 + b, E.ACID); },
    evo: {
      tag: 'acid', name: 'Dissolver', color: '#c8ff3c', iconKey: 'dissolver',
      damage: 13,
      impact(x, y, b = 0) {
        splash(x, y, 3 + b, E.ACID);
        for (let k = -1; k <= 1; k++) { // the reaction liberates hydrogen
          const j = idx(Math.max(1, Math.min(SIM_W - 2, x + k)), Math.max(1, y - 2));
          if (grid[j] === E.EMPTY) setCell(j, E.HYDROGEN);
        }
      },
    },
  },
  flame: { // Spark Bolt's opposite: a fraction of the range, ~5x the DPS,
           // heavy mana drain, and it fills the air with real fire
    name: 'Flamethrower', color: '#ff7a3c', sfx: 'flame', damage: 4,
    cost: 3, cooldown: 2, speed: 1.8, gravity: -0.005, life: 9, // life caps range (~14 cells)
    count: 2, spread: 0.3,
    impact(x, y, b = 0) { splash(x, y, 1 + b, E.FIRE); },
    evo: {
      tag: 'fire', name: "Dragon's Breath", color: '#ff5a1c', iconKey: 'dragon',
      damage: 5, life: 14, // longer tongue (~22 cells)
      impact(x, y, b = 0) {
        splash(x, y, 1 + b, E.FIRE);
        if (rand() < 0.12) { // it drips molten rock at the far end
          const j = idx(x, Math.min(SIM_H - 2, y + 1));
          if (grid[j] === E.EMPTY) setCell(j, E.LAVA);
        }
      },
    },
  },
  arc: {
    name: 'Arc Bolt', color: '#f0f4ff', sfx: 'arc', damage: 8,
    cost: 14, cooldown: 18, speed: 3.0, gravity: 0, life: 70,
    impact(x, y, b = 0) {
      // Stormcore trophy: the impact calls down the tempest's own bolt
      if (runState.arcLightning && typeof lightningStrikeAt === 'function') {
        lightningStrikeAt(x, Math.max(2, y - 18), false);
      }
      electrify(x, y, 2 + b);
    },
  },
};

// arc impact: charge water directly, spark into open air
function electrify(cx, cy, r) {
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 1 || y >= SIM_H - 1) continue;
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      if (x < 1 || x >= SIM_W - 1) continue;
      if (dx * dx + dy * dy > r * r) continue;
      const i = idx(x, y);
      if (grid[i] === E.WATER) setCell(i, E.EWATER);
      else if (grid[i] === E.EMPTY) setCell(i, E.ELEC);
    }
  }
}

// Wand composition modifiers (Noita-style): synergy picks stack these onto
// every cast for the rest of the run. Reset by resetWand.
const wandMods = {
  extraCasts: 0,   // additional projectiles per cast
  cooldownMult: 1, // rapid fire
  damageMult: 1,   // vs creatures
  radiusBonus: 0,  // bigger impact splashes/craters
  bounces: 0,      // projectiles ricochet off terrain
};

function resetWandMods() {
  wandMods.extraCasts = 0;
  wandMods.cooldownMult = 1;
  wandMods.damageMult = 1;
  wandMods.radiusBonus = 0;
  wandMods.bounces = 0;
}

const wand = {
  spells: [], // spell keys; set by resetWand
  sel: 0,
  mana: 100,
  maxMana: 100,
  cooldown: 0,
};

const projectiles = [];

function resetWand() {
  wand.spells = ['spark', 'water', 'dig']; // dig always present: no soft-locks
  wand.sel = 0;
  wand.mana = wand.maxMana;
  wand.cooldown = 0;
  wand.cooldownMax = 0;
  projectiles.length = 0;
  resetWandMods();
  updateSpellHUD();
}

function grantSpell(key) {
  if (!wand.spells.includes(key)) wand.spells.push(key);
  updateSpellHUD();
}

function currentSpell() { return SPELLS[wand.spells[wand.sel]]; }

function cycleSpell(dir) {
  wand.sel = (wand.sel + dir + wand.spells.length) % wand.spells.length;
  updateSpellHUD();
}

function selectSpell(i) {
  if (i >= 0 && i < wand.spells.length) { wand.sel = i; updateSpellHUD(); }
}

// paint an element into empty cells around an impact point
function splash(cx, cy, r, id) {
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 1 || y >= SIM_H - 1) continue;
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      if (x < 1 || x >= SIM_W - 1) continue;
      if (dx * dx + dy * dy > r * r) continue;
      const i = idx(x, y);
      if (grid[i] === E.EMPTY) setCell(i, id);
    }
  }
}

// excavate everything but indestructible WALL
function digCircle(cx, cy, r) {
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 1 || y >= SIM_H - 1) continue;
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      if (x < 1 || x >= SIM_W - 1) continue;
      if (dx * dx + dy * dy > r * r) continue;
      const i = idx(x, y);
      if (grid[i] !== E.WALL && grid[i] !== E.EMPTY) setCell(i, E.EMPTY);
    }
  }
}

// --- spell evolutions --------------------------------------------------------
// Count how many taken synergies carry a tag (the build's gravity)
function spellTagCount(tag) {
  if (typeof run === 'undefined' || !run.active) return 0;
  let n = 0;
  for (const name of run.mods) {
    const m = MODIFIERS.find(mm => mm.name === name);
    if (m && m.tags && m.tags.includes(tag)) n++;
  }
  return n;
}

// The live form of a spell: base, or base overlaid with its evo block once
// the run holds enough matching-tag synergies. Derived purely from run.mods,
// so replays evolve identically.
function spellForm(key) {
  const sp = SPELLS[key];
  if (!sp.evo) return sp;
  return spellTagCount(sp.evo.tag) >= (sp.evo.need || 2)
    ? Object.assign({}, sp, sp.evo) : sp;
}

// choice-overlay badge: which held spells would this pick evolve?
function evolutionsCompletedBy(mod) {
  if (typeof run === 'undefined' || !run.active || !mod.tags) return [];
  const out = [];
  for (const key of wand.spells) {
    const sp = SPELLS[key];
    if (!sp.evo || !mod.tags.includes(sp.evo.tag)) continue;
    if (spellTagCount(sp.evo.tag) === (sp.evo.need || 2) - 1) {
      out.push(sp.name + ' → ' + sp.evo.name);
    }
  }
  return out;
}

function castSelectedSpell(tx, ty) {
  if (wand.cooldown > 0) return;
  const key = wand.spells[wand.sel];
  const sp = spellForm(key);
  if (wand.mana < sp.cost) return;
  wand.mana -= sp.cost;
  const cd = Math.max(1, Math.round(sp.cooldown * wandMods.cooldownMult));
  wand.cooldown = cd;
  wand.cooldownMax = cd;
  playSfx(sp.sfx);
  const px = player.x + player.w / 2;
  const py = player.y + player.h / 3; // cast from chest height
  const base = Math.atan2(ty - py, tx - px);
  const count = (sp.count || 1) + wandMods.extraCasts;
  const spread = (sp.spread || 0.05) + (wandMods.extraCasts > 0 ? 0.08 : 0);
  for (let k = 0; k < count; k++) {
    const a = base + (rand() - 0.5) * 2 * spread;
    projectiles.push({
      x: px, y: py,
      vx: Math.cos(a) * sp.speed,
      vy: Math.sin(a) * sp.speed,
      key, life: sp.life,
      bounces: wandMods.bounces,
    });
  }
}

function projBlockedAt(cx, cy) {
  if (cx < 0 || cx >= SIM_W || cy < 0 || cy >= SIM_H) return true;
  const id = grid[idx(cx, cy)];
  return id !== E.EMPTY && id !== E.FIRE && TYPE[id] !== T.GAS;
}

function updateSpells() {
  if (wand.cooldown > 0) wand.cooldown--;
  // ~11 mana/s: a full pool takes ~9s to refill, so sustained casting runs
  // dry and Overcharge (×1.8) is a pick you can actually feel
  wand.mana = Math.min(wand.maxMana, wand.mana + 0.18 * runState.mult.manaRegen);

  for (let p = projectiles.length - 1; p >= 0; p--) {
    const pr = projectiles[p];
    const sp = spellForm(pr.key);
    pr.vy += sp.gravity;
    let hit = false;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(pr.vx), Math.abs(pr.vy))));
    for (let s = 0; s < steps && !hit; s++) {
      pr.x += pr.vx / steps;
      pr.y += pr.vy / steps;
      const cx = Math.round(pr.x), cy = Math.round(pr.y);
      if (cx < 1 || cx >= SIM_W - 1 || cy < 1 || cy >= SIM_H - 1) { hit = true; break; }
      // creatures intercept projectiles (no bounce off flesh)
      let ateByCreature = false;
      for (const c of creatures) {
        if (pr.x >= c.x - 0.5 && pr.x <= c.x + c.w + 0.5 &&
            pr.y >= c.y - 0.5 && pr.y <= c.y + c.h + 0.5) {
          damageCreature(c, (sp.damage || 5) * wandMods.damageMult);
          ateByCreature = true;
          break;
        }
      }
      if (ateByCreature) { hit = true; break; }
      const id = grid[idx(cx, cy)];
      if (id !== E.EMPTY && id !== E.FIRE && TYPE[id] !== T.GAS) {
        if (pr.bounces > 0) { // ricochet off terrain instead of impacting
          pr.bounces--;
          pr.x -= pr.vx / steps;
          pr.y -= pr.vy / steps;
          const blockedX = projBlockedAt(Math.round(pr.x + Math.sign(pr.vx)), Math.round(pr.y));
          const blockedY = projBlockedAt(Math.round(pr.x), Math.round(pr.y + Math.sign(pr.vy)));
          if (blockedX) pr.vx = -pr.vx * 0.8;
          if (blockedY || !blockedX) pr.vy = -pr.vy * 0.8;
          break; // resume flight next frame
        }
        hit = true;
      }
    }
    if (hit || --pr.life <= 0) {
      sp.impact(Math.round(pr.x), Math.round(pr.y), wandMods.radiusBonus);
      projectiles.splice(p, 1);
    }
  }
}

function drawProjectiles() {
  if (projectiles.length === 0) return;
  const cw = displayCanvas.width / camera.w;
  const ch = displayCanvas.height / camera.h;
  for (const pr of projectiles) {
    displayCtx.fillStyle = spellForm(pr.key).color;
    displayCtx.fillRect((pr.x - camera.x - 0.6) * cw, (pr.y - camera.y - 0.6) * ch,
                        1.2 * cw, 1.2 * ch);
  }
}

// --- hotbar UI: Noita-style icon slots over the canvas ----------------------

// 8x8 pixel-art icons; chars index into ICON_COLORS, '.' is transparent
const ICON_PX = {
  spark: [
    '........',
    '.y.ww.y.',
    '..wyyw..',
    '.wyooyw.',
    '.wyooyw.',
    '..wyyw..',
    '.y.ww.y.',
    '........'],
  water: [
    '....b...',
    '...bb...',
    '..bBBb..',
    '.bBBWBb.',
    '.bBBBBb.',
    '.bBBBBb.',
    '..bBBb..',
    '...bb...'],
  dig: [
    '......ss',
    '.....ss.',
    '....ss..',
    '.h.ss...',
    '.hhs....',
    '.hhh....',
    'hhh.....',
    'hh......'],
  bomb: [
    '.....y..',
    '....yh..',
    '...dd...',
    '..dDDd..',
    '.dDDDDd.',
    '.dDDDDd.',
    '..dDDd..',
    '...dd...'],
  acid: [
    'g...g..g',
    '.g...g..',
    '..gGGg..',
    '.gGGGGg.',
    '.gGWGGg.',
    '.gGGGGg.',
    '..gGGg..',
    '...gg...'],
  flame: [
    '....o...',
    '...oo...',
    '..oyo.o.',
    '.ooyyoo.',
    '.oyywyo.',
    '.yywwyy.',
    '.oywwyo.',
    '..oyyo..'],
  arc: [
    '....ww..',
    '...ww...',
    '..www...',
    '.wwww...',
    '...ww...',
    '..ww....',
    '.ww.....',
    '.w......'],
  // --- evolved forms ---------------------------------------------------------
  meteor: [
    '......oo',
    '.....oy.',
    '....oy..',
    '..rroo..',
    '.rRRRr..',
    '.rRyRr..',
    '.rRRRr..',
    '..rrr...'],
  glacier: [
    '...ii...',
    '..iIIi..',
    '..iIWi..',
    '.iIIWIi.',
    '.iIWIIi.',
    '..iIIi..',
    '..bBBb..',
    '.bBBBBb.'],
  tunnel: [
    '..ss....',
    '.sMMs...',
    'sMMMMs..',
    'sMmmMs..',
    '.sMMs.h.',
    '..ss.hh.',
    '....hh..',
    '...hh...'],
  keg: [
    '....y...',
    '.dddw...',
    'dDDDDd..',
    'dDrrDd..',
    'dDrrDd..',
    'dDDDDd..',
    'dDDDDd..',
    '.dddd...'],
  dissolver: [
    '..G..G..',
    '.G.GG.G.',
    '..gGGg..',
    '.gGGGGg.',
    'gGGWGGGg',
    'gGGGGGGg',
    '.gGGGGg.',
    '..gggg..'],
  dragon: [
    '.rr.....',
    'rRRr..o.',
    'rRoRoo..',
    '.Rooyoo.',
    '.Royyyo.',
    'rRoywyo.',
    'rRRoyo..',
    '.rr.o...'],
};

const ICON_COLORS = {
  y: '#ffd75e', w: '#fff6d8', o: '#ff8c3c',
  b: '#2e7fd6', B: '#4aa3ff', W: '#d8ecff',
  h: '#8a5a30', s: '#aab0b8',
  d: '#4a4a56', D: '#26262e',
  g: '#79c62e', G: '#a0e83c',
  r: '#e2583a', R: '#ff8c5c',           // ember reds
  i: '#bfe4ff', I: '#e8f6ff',           // frost
  m: '#8a94a0', M: '#c3ccd6',           // metal
  p: '#8a63d0', P: '#b48cff',           // arcane purple
  f: '#e8e0d0',                         // bone / fur
  c: '#7ee8e0',                         // shard cyan
};

// synergy card / collection sprites — same 8x8 language as the spell icons.
// Spell-granting mods reuse the spell's own glyph so the card and the hotbar
// slot it adds read as the same thing.
const MOD_ICONS = {
  'Pyromaniac': [
    '..o..o..',
    '.oo.oo..',
    '.oyooyo.',
    'ooyyoyo.',
    'oyywyyoo',
    'oyww.wyo',
    '.oyw.wy.',
    '..oo.o..'],
  'Fireproof Hide': [
    '.mmmmmm.',
    'mMwwwwMm',
    'mw.oo.wm',
    'mw.oo.wm',
    'mww..wwm',
    '.mw..wm.',
    '..mwwm..',
    '...mm...'],
  'Frost Aura': [
    '...I....',
    '.i.I.i..',
    '..iIi...',
    'IiIWIiI.',
    '..iIi...',
    '.i.I.i..',
    '...I....',
    '........'],
  'Lava Strider': [
    '..hh....',
    '..hh....',
    '..hhh...',
    '..hhhh..',
    '.hhhhh..',
    '.hhhhhh.',
    'oyooyoyo',
    'ryryyrry'],
  'Steam Sprite': [
    '..WW....',
    '.WWWW.W.',
    '..WW.WWW',
    '.W....W.',
    '.WWW....',
    'WWWWW.W.',
    '.WWW.WWW',
    '......W.'],
  'Green Thumb': [
    '...gG...',
    '.GG.g.G.',
    'GGG.gGG.',
    '.G..gG..',
    '....g...',
    '...gg...',
    'hhhhhhhh',
    'DhhDDhhD'],
  'Acid Blood': [
    '...G....',
    '...G....',
    '..GG....',
    '.GGGG...',
    'GGrGGG..',
    'GrrrGG..',
    '.GGGG...',
    '..GG....'],
  'Demolitionist': [
    '.....y..',
    '....yw..',
    '.rrrr...',
    'rRRRRr..',
    'rRwwRr..',
    'rRwwRr..',
    'rRRRRr..',
    '.rrrr...'],
  'Fleetfoot': [
    '..w.....',
    '.www....',
    'wwhh....',
    '.whhh...',
    '..hhhh..',
    '..hhhhh.',
    '..hhhhhh',
    '...sssss'],
  'Powder Bomb': null,  // filled from ICON_PX below
  'Acid Spit': null,
  'Flamethrower': null,
  'Arc Bolt': null,
  'Overcharge': [
    '...ww...',
    '...bb...',
    '..bBBb..',
    '.bBWBBb.',
    '.bBBBBb.',
    '.bBWWBb.',
    '..bBBb..',
    '...bb...'],
  'Wand: Twin Cast': [
    '......y.',
    '.....yw.',
    'y...yw..',
    '.y.yw...',
    '..yw.o..',
    '.yw.o...',
    'yw.o....',
    'w.o.....'],
  'Wand: Rapid Fire': [
    '........',
    'w..w..w.',
    '.w..w..w',
    '..w..w..',
    '..w..w..',
    '.w..w..w',
    'w..w..w.',
    '........'],
  'Wand: Amplifier': [
    '...yy...',
    '.y.yy.y.',
    '..yooy..',
    'yyowwoyy',
    'yyowwoyy',
    '..yooy..',
    '.y.yy.y.',
    '...yy...'],
  'Wand: Bouncing Shots': [
    'w.......',
    '.w......',
    '..w...w.',
    '...w.w.w',
    '....w...',
    '........',
    'ssssssss',
    'dddddddd'],
  'Tunneler': [
    '..ss....',
    '.s..s...',
    's....s..',
    '.....hs.',
    '....hh.s',
    '...hh...',
    '..hh....',
    '.hh.....'],
  'Storm Caller': [
    '.sss....',
    'ssssss..',
    'sssssss.',
    '.ssssss.',
    '....yy..',
    '...yy...',
    '..yyy...',
    '..y.....'],
  'Insulated': [
    '.mmmmmm.',
    'mM....Mm',
    'm..ww..m',
    'm.ww...m',
    'm..ww..m',
    'm.ww...m',
    '.m....m.',
    '..mmmm..'],
  'Executioner': [
    'yyyyyy..',
    '.ywwy...',
    '.ywwy...',
    '..yy....',
    '..yy....',
    '.y..y...',
    '.ywwy...',
    'yyyyyy..'],
  'Iron Boots': [
    '..mm....',
    '..mMm...',
    '..mMm...',
    '..mMmm..',
    '.mMMmmm.',
    '.mMMMMm.',
    'mmmmmmmm',
    'dddddddd'],
  'Winter Pelt': [
    'i..I..i.',
    '.ffff...',
    'fffffff.',
    'ffwffwf.',
    'fffffff.',
    '.fffff..',
    'I.fff..I',
    '...f.i..'],
  'Furnace Heart': [
    '.rr..rr.',
    'rRRrrRRr',
    'rRyyyyRr',
    'rRywwyRr',
    '.rRyyRr.',
    '..rRRr..',
    '...rr...',
    '........'],
  'Ember Heart': [
    '.oo..oo.',
    'oRRooRRo',
    'oRRRRRRo',
    'oRywwyRo',
    '.oRyyRo.',
    '..oRRo..',
    '...oo...',
    '........'],
};
MOD_ICONS['Powder Bomb'] = ICON_PX.bomb;
MOD_ICONS['Acid Spit'] = ICON_PX.acid;
MOD_ICONS['Flamethrower'] = ICON_PX.flame;
MOD_ICONS['Arc Bolt'] = ICON_PX.arc;
// boss trophies
MOD_ICONS['Wormheart'] = [
  '.rr..rr.',
  'rRRrrRRr',
  'rRoyyoRr',
  'rRyooyRr',
  '.rRyyRr.',
  '..rRRr..',
  '...rr...',
  '........'];
MOD_ICONS['Stormcore'] = [
  '.bb..bb.',
  'bBBbbBBb',
  'bBBywBBb',
  'bBByyBBb',
  '.bBywBb.',
  '..bByb..',
  '...bb...',
  '........'];

// collection trophy tiles (not modifiers — the guardians themselves)
const TROPHY_ICONS = {
  magmaworm: [
    '..rrr...',
    '.rRRRr..',
    'rRwRRRr.',
    'rRRRoRr.',
    '.rrRRRr.',
    '...rRRr.',
    '.rRRRr..',
    'rrrrr...'],
  tempest: [
    '..BBBB..',
    '.BWBBWB.',
    'BBBBBBBB',
    '.BBBBBB.',
    '..yy.B..',
    '..yyy...',
    '.yy.....',
    '.y......'],
  elite: [
    'y..yy..y',
    'yy.yy.yy',
    'yyyyyyyy',
    '.ywwwwy.',
    '.ywyywy.',
    '.yyyyyy.',
    '........',
    '........'],
};

function drawPixelIcon(cv, px) {
  const ctx2 = cv.getContext('2d');
  ctx2.clearRect(0, 0, cv.width, cv.height);
  if (!px) return;
  const s = cv.width / 8;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const ch = px[y][x];
      if (ch === '.') continue;
      ctx2.fillStyle = ICON_COLORS[ch] || '#fff';
      ctx2.fillRect(x * s, y * s, s, s);
    }
  }
}

function drawSpellIcon(cv, key) { drawPixelIcon(cv, ICON_PX[key]); }
function drawModIcon(cv, name) { drawPixelIcon(cv, MOD_ICONS[name]); }

// rebuild the hotbar slots (on loadout/selection change)
function updateSpellHUD() {
  if (typeof document === 'undefined') return;
  const bar = document.getElementById('hotbar');
  if (!bar) return;
  bar.innerHTML = '';
  wand.spells.forEach((key, i) => {
    const form = spellForm(key); // evolved spells show their evolved face
    const slot = document.createElement('div');
    slot.className = 'slot' + (i === wand.sel ? ' sel' : '');
    slot.title = form.name;
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 32;
    drawSpellIcon(cv, form.iconKey || key);
    slot.appendChild(cv);
    const k = document.createElement('span');
    k.className = 'key';
    k.textContent = i + 1;
    slot.appendChild(k);
    const cd = document.createElement('div');
    cd.className = 'cd';
    slot.appendChild(cd);
    slot.addEventListener('click', () => selectSpell(i));
    bar.appendChild(slot);
  });
}

// per-frame: cooldown sweep + mana dimming on the existing slots
function updateHotbar() {
  if (typeof document === 'undefined') return;
  const bar = document.getElementById('hotbar');
  if (!bar) return;
  const slots = bar.children;
  for (let i = 0; i < slots.length; i++) {
    const sp = spellForm(wand.spells[i]);
    slots[i].classList.toggle('sel', i === wand.sel);
    slots[i].classList.toggle('nomana', wand.mana < sp.cost);
    const cd = slots[i].lastElementChild;
    cd.style.height = (i === wand.sel && wand.cooldown > 0 && wand.cooldownMax > 0)
      ? Math.round(wand.cooldown / wand.cooldownMax * 100) + '%'
      : '0';
  }
}

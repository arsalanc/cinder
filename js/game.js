// CINDER — run flow (the roguelite layer)
// A run: descend each level to the portal -> pick 1 of 3 synergies -> next
// level generates deeper and more hazardous. Death ends the run.
// DOM access is guarded so this file also loads in headless tests.

'use strict';

const WIN_DEPTH = 6; // clear this level's portal and the run is won

const run = {
  active: false,
  depth: 0,
  seed: '',
  mods: [],       // names of taken modifiers
  choosing: false, // synergy pick overlay is up (sim pauses)
  relicChoice: false, // the current pick came from a relic (stay on level)
  dead: false,
  won: false,
  endless: false, // past WIN_DEPTH: the win is banked, the descent continues
  kills: 0,
  portalHint: false, // player is at the portal but shards remain
};

const portal = { x: 0, y: 0 };
// optional per-depth side objective: a buried, hazard-flooded glass vault;
// touching the relic inside grants an extra synergy pick
const relic = { x: 0, y: 0, present: false, taken: false, trap: null };

// a blast that reaches an untaken relic destroys it — a sprung powder trap
// costs you the prize (sim core reports every explosion through this hook)
simHooks.explodeAt = (cx, cy, r) => {
  if (!relic.present || relic.taken) return;
  const dx = relic.x - cx, dy = relic.y - cy;
  if (dx * dx + dy * dy <= (r + 1) * (r + 1)) {
    relic.present = false;
    playSfx('squish');
    updateRunHUD();
  }
};

// --- meta-progression: persists across sessions via localStorage ------------

function loadMeta() {
  const m = { bestDepth: 0, wins: 0, kills: 0, runs: 0,
              wormKills: 0, tempestKills: 0, groveKills: 0, eliteKills: 0 };
  try {
    if (typeof localStorage !== 'undefined') {
      Object.assign(m, JSON.parse(localStorage.getItem('cinder-meta') || '{}'));
    }
  } catch (e) { /* private mode / headless: session-only meta */ }
  return m;
}

function saveMeta() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('cinder-meta', JSON.stringify(meta));
    }
  } catch (e) { /* ignore */ }
}

const meta = loadMeta();

// A modifier with an `unlock` field is hidden until the meta stat reaches it
function isUnlocked(mod) {
  return !mod.unlock || (meta[mod.unlock.stat] || 0) >= mod.unlock.at;
}

// Record end-of-run stats; returns names of modifiers this run just unlocked
function finishRun(won) {
  // replays are re-enactments: they never touch meta-progression
  if (typeof replayPlay !== 'undefined' && replayPlay.active) return [];
  const before = new Set(MODIFIERS.filter(isUnlocked).map(m => m.name));
  meta.runs++;
  meta.bestDepth = Math.max(meta.bestDepth, run.depth);
  if (won) meta.wins++;
  saveMeta();
  return MODIFIERS.filter(isUnlocked).map(m => m.name).filter(n => !before.has(n));
}

// --- daily-run scoreboard: local bests per daily seed ------------------------

function loadDaily() {
  const d = {};
  try {
    if (typeof localStorage !== 'undefined') {
      Object.assign(d, JSON.parse(localStorage.getItem('cinder-daily') || '{}'));
    }
  } catch (e) { /* private mode / headless: session-only */ }
  return d;
}

const dailyBest = loadDaily();

// Called when a daily run ends (death or End Run); keeps the best attempt.
// `depth` lets End Run pass the depth actually CLEARED (run.depth has already
// been incremented for the next level by the time the overlay is up).
function recordDaily(depth) {
  if (!run.seed.startsWith('daily-')) return;
  if (typeof replayPlay !== 'undefined' && replayPlay.active) return;
  const entry = { depth: depth || run.depth, kills: run.kills, won: run.endless || run.won };
  const prev = dailyBest[run.seed];
  if (!prev || entry.depth > prev.depth ||
      (entry.depth === prev.depth && entry.kills > prev.kills)) {
    dailyBest[run.seed] = entry;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('cinder-daily', JSON.stringify(dailyBest));
    }
  } catch (e) { /* ignore */ }
  updateDailyHUD();
}

function updateDailyHUD() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('daily-best');
  if (!el) return;
  const d = new Date();
  const key = 'daily-' + d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
  const b = dailyBest[key];
  el.textContent = b
    ? 'Today’s best: D' + b.depth + (b.won ? ' ✔' : '') + ' · ' + b.kills + ' kills'
    : '';
}

// Replays and daily runs inject their seed here before calling startRun
let pendingRunSeed = null;

function startRun() {
  resetModifiers();
  resetWand();
  run.active = true;
  run.depth = 1;
  run.mods = [];
  run.choosing = false;
  run.relicChoice = false;
  run.dead = false;
  run.won = false;
  run.endless = false;
  run.kills = 0;
  relic.present = false;
  relic.taken = false;
  // Math.random on purpose: fresh entropy for each run; everything after
  // this seed is deterministic via the sim PRNG (which is why a seed plus
  // recorded inputs replays the entire run)
  run.seed = pendingRunSeed || Math.random().toString(36).slice(2, 8);
  pendingRunSeed = null;
  if (typeof replayBeginRecording === 'function') replayBeginRecording(run.seed);
  beginLevel();
  hideOverlay();
  maybeShowHello();
}

// --- first-run onboarding: one overlay, once, never during playback ---------
let helloShown = false;
function maybeShowHello() {
  if (typeof document === 'undefined') return;
  if (helloShown || meta.runs > 0) return;
  if (typeof replayPlay !== 'undefined' && replayPlay.active) return;
  helloShown = true;
  run.choosing = true; // pause the sim while they read
  const overlay = document.getElementById('overlay');
  document.getElementById('overlay-title').textContent = 'Welcome to the depths';
  document.getElementById('overlay-stats').innerHTML =
    'Collect the cyan <b>◆ shards</b> to wake the portal, then descend.<br>' +
    'The mouse casts spells — <b>Dig Blast</b> means no wall can trap you.<br>' +
    'The world is real: fire spreads, water flows, cold bites. Use it.<br>' +
    'When something big pulses <b>gold</b>, that is your moment — strike.';
  const cards = document.getElementById('overlay-cards');
  cards.innerHTML = '';
  cards.className = '';
  const btn = document.createElement('button');
  btn.className = 'card';
  btn.innerHTML = '<b>Descend</b><span>Depth 1 awaits.</span>';
  btn.addEventListener('click', () => {
    run.choosing = false;
    hideOverlay();
  });
  cards.appendChild(btn);
  document.getElementById('overlay-action').style.display = 'none';
  overlay.style.display = 'flex';
}

function isBossDepth(d) {
  // 3 and 6 on the way down; every 3rd depth of the endless descent (9, 12…)
  return d === 3 || d === WIN_DEPTH ||
         (d > WIN_DEPTH && (d - WIN_DEPTH) % 3 === 0);
}

// Which guardian holds each boss depth is decided by the RUN SEED (stable,
// replay-safe — no rand() stream involved): two different guardians on the
// way down, then the endless descent rotates through all three.
const GUARDIANS = ['magmaworm', 'tempest', 'overgrowth'];

function bossKeyFor(d) {
  const h = hashSeed(run.seed + '#guardians') >>> 0; // unsigned: modulo stays positive
  const first = h % 3;
  const second = (first + 1 + ((h >>> 4) % 2)) % 3; // one of the other two
  if (d === 3) return GUARDIANS[first];
  if (d === WIN_DEPTH) return GUARDIANS[second];
  const n = (d - WIN_DEPTH) / 3; // endless: full rotation, no repeats in a loop
  return GUARDIANS[(second + n) % 3];
}

function bossAlive() {
  return creatures.some(c => CREATURE_TYPES[c.key].boss);
}

function spawnBoss() {
  const key = bossKeyFor(run.depth);
  const t = CREATURE_TYPES[key];
  // endless guardians return tougher each loop
  const hp = Math.round(t.hp * (1 + Math.max(0, run.depth - WIN_DEPTH) * 0.06));
  // arena pocket beside the portal it guards
  const bx = Math.max(14, Math.min(SIM_W - 14, portal.x + (rand() < 0.5 ? -16 : 16)));
  const by = Math.max(14, portal.y - 6);
  digCircle(bx, by, 9);
  creatures.push(makeCreature(key, bx - t.w / 2, by - t.h / 2, {
    hp, maxHp: hp, dir: 1, bob: 0, attackCd: 90,
  }));
}

function beginLevel() {
  if (isBossDepth(run.depth)) {
    // a purpose-built arena: player on the left shelf, portal + boss on the
    // right, water reservoir between — the worm has to cross to reach you
    generateBossChamber(run.seed + '#' + run.depth, bossKeyFor(run.depth));
    placeSpawn(bossArena.spawnX - player.w / 2, bossArena.floorY - player.h - 1);
    portal.x = bossArena.portalX;
    portal.y = bossArena.floorY - 1;
    paintCircle(portal.x, portal.y - 1, 4, E.EMPTY);
    shards.length = 0;   // slay the guardian instead of gathering shards
    relic.present = false; // no side quests in a duel
    clearCreatures();    // a focused duel — no trash mobs cluttering the arena
    spawnBoss();
  } else {
    generateWorld(run.seed + '#' + run.depth, run.depth);
    spawnPlayer();
    const reach = reachableFrom(
      Math.round(player.x + player.w / 2),
      Math.round(player.y + player.h / 2));
    placePortal(reach);
    placeShards(reach);
    placeRelic();
    spawnCreatures(run.depth);
  }
  resetWeather();
  updateRunHUD();
}

// Flood-fill of cells the player could occupy or pass through (walking,
// falling, swimming — plus dig-assisted since powders/statics are excluded
// but Dig Blast handles those). Used to validate portal placement.
function reachableFrom(sx, sy) {
  const reach = new Uint8Array(CELLS);
  const passable = id =>
    id === E.EMPTY || id === E.PLANT || id === E.FIRE ||
    TYPE[id] === T.LIQUID || TYPE[id] === T.GAS;
  const start = idx(Math.max(0, Math.min(SIM_W - 1, sx)),
                    Math.max(0, Math.min(SIM_H - 1, sy)));
  if (!passable(grid[start])) return reach; // shouldn't happen; empty result
  const stack = [start];
  reach[start] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % SIM_W, y = (i / SIM_W) | 0;
    if (x > 0 && !reach[i - 1] && passable(grid[i - 1])) { reach[i - 1] = 1; stack.push(i - 1); }
    if (x + 1 < SIM_W && !reach[i + 1] && passable(grid[i + 1])) { reach[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && !reach[i - SIM_W] && passable(grid[i - SIM_W])) { reach[i - SIM_W] = 1; stack.push(i - SIM_W); }
    if (y + 1 < SIM_H && !reach[i + SIM_W] && passable(grid[i + SIM_W])) { reach[i + SIM_W] = 1; stack.push(i + SIM_W); }
  }
  return reach;
}

// The exit: an open pocket in the bottom third, with ground beneath it,
// verified reachable from the spawn point (spawnPlayer runs first).
function placePortal(reach) {
  if (!reach) {
    reach = reachableFrom(
      Math.round(player.x + player.w / 2),
      Math.round(player.y + player.h / 2));
  }

  for (let attempt = 0; attempt < 1500; attempt++) {
    const x = 10 + ((rand() * (SIM_W - 20)) | 0);
    const y = ((SIM_H * 0.68) + rand() * (SIM_H * 0.26)) | 0;
    const i = idx(x, y);
    if (grid[i] !== E.EMPTY || !reach[i]) continue;
    let ground = false;
    for (let d = 1; d <= 6 && y + d < SIM_H; d++) {
      const id = grid[i + d * SIM_W];
      if (id === E.EMPTY) continue;
      const t = TYPE[id];
      ground = t === T.STATIC || t === T.POWDER;
      break; // liquid/gas below -> not a portal spot
    }
    if (!ground) continue;
    portal.x = x;
    portal.y = y;
    paintCircle(x, y - 1, 4, E.EMPTY); // breathing room
    return;
  }

  // fallback (no reachable pocket found): carve a shaft from the spawn
  // straight down to a new pocket near the bottom, respecting WALL borders
  portal.x = Math.max(10, Math.min(SIM_W - 10, Math.round(player.x)));
  portal.y = SIM_H - 12;
  for (let y = Math.round(player.y); y <= portal.y; y++) {
    digCircle(portal.x, y, 2);
  }
  digCircle(portal.x, portal.y, 5);
}

// --- essence shards: the portal is dormant until all are collected --------
// This is what makes tunnel-rushing pointless: shards are scattered far
// apart in verified-reachable pockets, so the route through the level (and
// its biomes, liquids, and creatures) is the game. Dig remains a tool.

const shards = []; // { x, y, taken }

function shardsRemaining() {
  let n = 0;
  for (const s of shards) if (!s.taken) n++;
  return n;
}

function placeShards(reach) {
  shards.length = 0;
  const need = Math.min(4, 2 + (run.depth >> 1)); // D1:2, D2-3:3, D4+:4
  // progressively relax spacing if the cave layout is cramped
  const stages = [
    { shard: 60, spawn: 50, portal: 25 },
    { shard: 35, spawn: 35, portal: 15 },
    { shard: 14, spawn: 20, portal: 8 },
  ];
  const pcx = player.x + player.w / 2, pcy = player.y + player.h / 2;
  for (const min of stages) {
    for (let attempt = 0; attempt < 1500 && shards.length < need; attempt++) {
      const x = 8 + ((rand() * (SIM_W - 16)) | 0);
      const y = 40 + ((rand() * (SIM_H - 48)) | 0);
      const i = idx(x, y);
      if (grid[i] !== E.EMPTY || !reach[i]) continue;
      const ds = (x - pcx) * (x - pcx) + (y - pcy) * (y - pcy);
      if (ds < min.spawn * min.spawn) continue;
      const dp = (x - portal.x) * (x - portal.x) + (y - portal.y) * (y - portal.y);
      if (dp < min.portal * min.portal) continue;
      let crowded = false;
      for (const s of shards) {
        const d = (x - s.x) * (x - s.x) + (y - s.y) * (y - s.y);
        if (d < min.shard * min.shard) { crowded = true; break; }
      }
      if (crowded) continue;
      paintCircle(x, y, 2, E.EMPTY); // small pocket around the crystal
      shards.push({ x, y, taken: false });
    }
    if (shards.length >= need) break;
  }
  // pathological layout: whatever we placed is the requirement (never 0-lock)
}

// One optional RELIC per depth: a glass vault buried in solid ground and
// flooded with the local biome's hazard. Deliberately OFF the critical path
// (no reachability requirement — Dig Blast is the key); cracking it open and
// surviving the flood earns an extra synergy pick.
function placeRelic() {
  relic.present = false;
  relic.taken = false;
  relic.trap = null;
  const HAZARD = {
    'Ice Caves': E.ICE, 'Volcanic Depths': E.LAVA,
    'Oil Caverns': E.OIL, 'Rusted Works': E.ACID,
  };
  for (let attempt = 0; attempt < 600; attempt++) {
    const cx = 14 + ((rand() * (SIM_W - 28)) | 0);
    const cy = ((SIM_H * 0.45) + rand() * (SIM_H * 0.42)) | 0;
    // must be buried: the vault footprint should be nearly all solid rock
    let solid = 0, walled = false;
    for (let dy = -3; dy <= 3 && !walled; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const id = grid[idx(cx + dx, cy + dy)];
        if (id === E.WALL) { walled = true; break; }
        if (id !== E.EMPTY && TYPE[id] !== T.LIQUID && TYPE[id] !== T.GAS) solid++;
      }
    }
    if (walled || solid < 56) continue;
    const ddx = cx - player.x, ddy = cy - player.y;
    if (ddx * ddx + ddy * ddy < 70 * 70) continue;
    const dp = (cx - portal.x) * (cx - portal.x) + (cy - portal.y) * (cy - portal.y);
    if (dp < 25 * 25) continue;
    // trap roll — depths 1-2 stay clean while the mechanic teaches itself;
    // the glass shell makes every trap honest (you can SEE what's inside)
    relic.trap = null;
    if (run.depth >= 3) {
      const tr = rand();
      if (tr < 0.25) relic.trap = 'powder';
      else if (tr < 0.45 && run.depth >= 4) relic.trap = 'nest';
    }
    // stamp: glass shell, then an interior to match —
    //   plain:  flooded with the biome's hazard
    //   powder: a gunpowder lining (any spark chains; the blast can destroy
    //           the relic — flood it first: wet powder turns to ash)
    //   nest:   a dormant fungus clutch glowing through the glass; taking
    //           the relic wakes the guards
    const fill = HAZARD[BIOMES[worldBiomeMap[idx(cx, cy)]].name] || E.WATER;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const edge = Math.abs(dx) === 4 || Math.abs(dy) === 3;
        let id;
        if (edge) id = E.GLASS;
        else if (relic.trap === 'powder') {
          id = (Math.abs(dx) === 3 || Math.abs(dy) === 2) ? E.GUNPOWDER : E.EMPTY;
        } else if (relic.trap === 'nest') {
          id = (dy === 2 && rand() < 0.75) ? E.FUNGUS : E.EMPTY;
        } else id = fill;
        setCell(idx(cx + dx, cy + dy), id);
      }
    }
    setCell(idx(cx, cy), E.EMPTY); // the relic's own cell stays clear
    relic.x = cx;
    relic.y = cy;
    relic.present = true;
    return;
  }
  // cramped map: this depth simply has no vault (it's optional)
}

function updateGame() {
  if (!run.active) return;
  if (player.alive) {
    applyAuras();
    const pcx = player.x + player.w / 2;
    const pcy = player.y + player.h / 2;
    for (const s of shards) {
      if (s.taken) continue;
      const dx = pcx - s.x, dy = pcy - s.y;
      if (dx * dx + dy * dy < 16) {
        s.taken = true;
        playSfx('shard');
        updateRunHUD();
      }
    }
    if (relic.present && !relic.taken) {
      const rdx = pcx - relic.x, rdy = pcy - relic.y;
      if (rdx * rdx + rdy * rdy < 12) {
        relic.taken = true;
        playSfx('shard');
        if (relic.trap === 'nest') {
          // the clutch wakes: biome guards burst out around the vault
          const biomeName = BIOMES[worldBiomeMap[idx(relic.x, relic.y)]].name;
          for (let k = 0; k < 3; k++) {
            const key = weightedPick(BIOME_SPAWNS[biomeName] || BIOME_SPAWNS['Stone Caverns']);
            const t = CREATURE_TYPES[key];
            creatures.push(makeCreature(key, relic.x - 3 + k * 2, relic.y - t.h, {
              dir: (k & 1) ? 1 : -1, bob: 0, attackCd: 30,
            }));
          }
          playSfx('squish');
        }
        run.choosing = true;
        run.relicChoice = true; // bonus pick: stay on this level
        showChoiceOverlay(rollChoices(3, run.mods));
        updateRunHUD();
      }
    }
    const dx = pcx - portal.x;
    const dy = pcy - portal.y;
    const nearPortal = dx * dx + dy * dy < 30;
    const cleared = shardsRemaining() === 0 && !bossAlive();
    run.portalHint = nearPortal && !cleared;
    if (nearPortal && cleared) levelComplete();
  } else if (!run.dead) {
    run.dead = true;
    recordDaily();
    const unlocked = finishRun(false);
    if (typeof replayEndRecording === 'function') replayEndRecording();
    playSfx('death');
    showEndOverlay('You died at depth ' + run.depth +
      (player.lastHurt ? ' — ' + player.lastHurt : ''), unlocked);
  }
}

// the win is banked the moment the depth-6 portal opens; the run keeps going
function recordWin() {
  if (typeof replayPlay !== 'undefined' && replayPlay.active) return [];
  const before = new Set(MODIFIERS.filter(isUnlocked).map(m => m.name));
  meta.wins++;
  meta.bestDepth = Math.max(meta.bestDepth, run.depth);
  saveMeta();
  return MODIFIERS.filter(isUnlocked).map(m => m.name).filter(n => !before.has(n));
}

function levelComplete() {
  playSfx('portal');
  if (run.depth >= WIN_DEPTH && !run.endless) {
    // victory — but the depths keep going. Bank the win; descending through
    // the next pick is opting into the ENDLESS run (End Run exits any time).
    run.endless = true;
    recordWin();
  }
  run.depth++;
  run.choosing = true;
  showChoiceOverlay(rollChoices(3, run.mods));
}

// endless overlay's exit ramp: leave with the victory
function endEndlessRun() {
  run.active = false;
  run.won = true;
  run.choosing = false;
  recordDaily(run.depth - 1); // the depth actually cleared, not the next one
  const unlocked = finishRun(false); // the win itself was banked at depth 6
  if (typeof replayEndRecording === 'function') replayEndRecording();
  hideOverlay();
  showEndOverlay('You escaped the depths — victory at depth ' + (run.depth - 1) + '!',
    unlocked);
}

function chooseModifier(mod) {
  playSfx('pick');
  if (typeof replayNoteMod === 'function') replayNoteMod(mod.name);
  mod.apply();
  run.mods.push(mod.name);
  run.choosing = false;
  hideOverlay();
  if (run.relicChoice) run.relicChoice = false; // mid-level bonus: stay put
  else beginLevel();
  updateSpellHUD(); // a synergy may have granted a spell
}

// --- overlays / HUD (no-ops headless) ---------------------------------------

function hideOverlay() {
  if (typeof document === 'undefined') return;
  document.getElementById('overlay').style.display = 'none';
}

function showChoiceOverlay(choices) {
  if (typeof document === 'undefined') return;
  const overlay = document.getElementById('overlay');
  document.getElementById('overlay-title').textContent =
    run.relicChoice ? 'Relic recovered — choose a bonus synergy'
    : run.endless ? (run.depth === WIN_DEPTH + 1
        ? 'VICTORY — the depths continue. Descend?'
        : 'Depth ' + run.depth + ' — the endless descent')
    : 'Depth ' + run.depth + ' of ' + WIN_DEPTH + ' — choose a synergy';
  document.getElementById('overlay-stats').innerHTML = '';
  const cards = document.getElementById('overlay-cards');
  cards.innerHTML = '';
  cards.className = '';
  for (const mod of choices) {
    const btn = document.createElement('button');
    btn.className = 'card';
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 32;
    cv.className = 'mod-icon';
    drawModIcon(cv, mod.name);
    btn.appendChild(cv);
    const b = document.createElement('b');
    b.textContent = mod.name;
    const span = document.createElement('span');
    span.textContent = mod.desc;
    btn.appendChild(b);
    btn.appendChild(span);
    // this pick would complete a spell evolution: say so on the card
    const evos = evolutionsCompletedBy(mod);
    if (evos.length) {
      const ev = document.createElement('span');
      ev.className = 'evo-badge';
      ev.textContent = '⚡ ' + evos.join(' · ');
      btn.appendChild(ev);
    }
    btn.addEventListener('click', () => chooseModifier(mod));
    cards.appendChild(btn);
  }
  // endless descent: an exit ramp next to the picks (picking = descending)
  if (run.endless && !run.relicChoice) {
    const btn = document.createElement('button');
    btn.className = 'card';
    btn.innerHTML = '<b>End Run</b><span>Escape with the victory. Depth ' +
      (run.depth - 1) + ' stands.</span>';
    btn.addEventListener('click', endEndlessRun);
    cards.appendChild(btn);
  }
  document.getElementById('overlay-action').style.display = 'none';
  overlay.style.display = 'flex';
}

// The collection: every synergy as a sprite tile — earned ones in color,
// locked ones blacked out with their unlock condition
function showCollectionOverlay() {
  if (typeof document === 'undefined') return;
  const overlay = document.getElementById('overlay');
  const owned = MODIFIERS.filter(isUnlocked).length;
  document.getElementById('overlay-title').textContent =
    'Collection — ' + owned + ' / ' + MODIFIERS.length + ' synergies';
  document.getElementById('overlay-stats').innerHTML =
    'Best D' + meta.bestDepth + ' &middot; Wins ' + meta.wins +
    ' &middot; Kills ' + meta.kills + ' &middot; Runs ' + meta.runs;
  const cards = document.getElementById('overlay-cards');
  cards.innerHTML = '';
  cards.className = 'collection';
  // --- trophies: the guardians and the elite hunt ---------------------------
  const TROPHIES = [
    { name: 'Magma Worm', icon: 'magmaworm', stat: 'wormKills', hint: 'Slay the Magma Worm' },
    { name: 'Tempest', icon: 'tempest', stat: 'tempestKills', hint: 'Slay the Tempest' },
    { name: 'Overgrowth', icon: 'overgrowth', stat: 'groveKills', hint: 'Slay the Overgrowth' },
    { name: 'Elite Hunter', icon: 'elite', stat: 'eliteKills', hint: 'Fell an elite' },
  ];
  const label = txt => {
    const el = document.createElement('div');
    el.className = 'grid-label';
    el.textContent = txt;
    cards.appendChild(el);
  };
  label('TROPHIES');
  for (const tr of TROPHIES) {
    const n = meta[tr.stat] || 0;
    const tile = document.createElement('div');
    tile.className = 'tile trophy' + (n > 0 ? '' : ' locked');
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 32;
    drawPixelIcon(cv, TROPHY_ICONS[tr.icon]);
    tile.appendChild(cv);
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = n > 0 ? tr.name : '???';
    tile.appendChild(nm);
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = n > 0 ? '×' + n : tr.hint;
    tile.appendChild(sub);
    cards.appendChild(tile);
  }
  label('SYNERGIES');
  for (const mod of MODIFIERS) {
    const unlocked = isUnlocked(mod);
    const tile = document.createElement('div');
    tile.className = 'tile' + (unlocked ? '' : ' locked');
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 32;
    drawModIcon(cv, mod.name);
    tile.appendChild(cv);
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = unlocked ? mod.name : '???';
    tile.appendChild(nm);
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = unlocked ? '' : mod.unlock.hint;
    tile.appendChild(sub);
    if (unlocked) tile.title = mod.desc;
    cards.appendChild(tile);
  }
  const close = document.createElement('button');
  close.className = 'card close';
  close.textContent = 'Close';
  close.addEventListener('click', () => {
    hideOverlay();
    cards.className = '';
  });
  cards.appendChild(close);
  document.getElementById('overlay-action').style.display = 'none';
  overlay.style.display = 'flex';
}

function showEndOverlay(title, unlocked) {
  if (typeof document === 'undefined') return;
  const overlay = document.getElementById('overlay');
  document.getElementById('overlay-cards').className = '';
  document.getElementById('overlay-title').textContent = title;
  let html = 'Kills ' + run.kills +
    ' &middot; Best depth ' + meta.bestDepth +
    ' &middot; Wins ' + meta.wins;
  if (run.mods.length) html += '<br>' + run.mods.join(' · ');
  for (const name of unlocked) {
    html += '<br><b>New synergy unlocked: ' + name + '</b>';
  }
  document.getElementById('overlay-stats').innerHTML = html;
  document.getElementById('overlay-cards').innerHTML = '';
  document.getElementById('overlay-action').style.display = 'block';
  overlay.style.display = 'flex';
}

function updateRunHUD() {
  if (typeof document === 'undefined') return;
  document.getElementById('hud-depth').textContent = run.active
    ? 'D' + run.depth + (run.endless ? '/∞' : '/' + WIN_DEPTH) +
      (isBossDepth(run.depth) ? ' ☠'
        : shards.length ? ' ◆' + (shards.length - shardsRemaining()) + '/' + shards.length : '') +
      (relic.present && !relic.taken ? ' ✦' : '')
    : '';
  document.getElementById('mods').textContent =
    run.mods.length ? run.mods.join(' · ') : '';
  document.getElementById('meta').textContent =
    'Best D' + meta.bestDepth + ' · Wins ' + meta.wins + ' · Kills ' + meta.kills;
}

function drawBossBar() {
  if (!run.active) return;
  const b = creatures.find(c => CREATURE_TYPES[c.key].boss);
  if (!b) return;
  const t = CREATURE_TYPES[b.key];
  const w = displayCanvas.width * 0.4;
  const x = (displayCanvas.width - w) / 2;
  displayCtx.fillStyle = 'rgba(10, 10, 16, 0.7)';
  displayCtx.fillRect(x - 2, 8, w + 4, 12);
  // bar flashes gold while the boss is in a vulnerable window (hit it now)
  displayCtx.fillStyle = b.exposedT > 0 ? '#ffe08a' : '#d84a3a';
  displayCtx.fillRect(x, 10, w * Math.max(0, b.hp / (b.maxHp || t.hp)), 8);
  // phase thresholds so the rhythm is readable
  displayCtx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  displayCtx.fillRect(x + w * 0.34, 9, 1.5, 10);
  displayCtx.fillRect(x + w * 0.67, 9, 1.5, 10);
  // one-line state hint: the fight has rules, so the bar teaches them
  let hint = '';
  if ((b.surgeT || 0) > 0) hint = 'MAGMA SURGE — dodge the geysers';
  else if ((b.squallT || 0) > 0) hint = 'STORM SQUALL — take cover';
  else if ((b.bloomT || 0) > 0) hint = 'BLOOM — survive the overgrowth';
  else if (b.exposedT > 0) hint = 'EXPOSED — strike now (stomp it!)';
  else if ((b.chargingT || 0) > 0) hint = 'CHARGING — get behind cover';
  else if ((b.breachTel || 0) > 0) hint = 'IT\'S COMING UP — move!';
  else if (b.key === 'magmaworm') hint = 'molten shell — quench it in water';
  else if (b.key === 'tempest') hint = 'storm-charged — soak it to short it out';
  else if (b.key === 'overgrowth') {
    hint = b.burning > 0 ? 'IT\'S CATCHING — keep it burning!'
                         : 'regenerating — set it on fire';
  }
  if (hint) {
    displayCtx.font = '10px monospace';
    displayCtx.textAlign = 'center';
    displayCtx.fillStyle = b.exposedT > 0 ? '#ffe08a' : 'rgba(232, 230, 240, 0.75)';
    displayCtx.fillText(hint, displayCanvas.width / 2, 31);
    displayCtx.textAlign = 'left';
  }
}

function drawPortal() {
  if (!run.active) return;
  const cw = displayCanvas.width / camera.w;
  const ch = displayCanvas.height / camera.h;

  // uncollected shards: pulsing cyan crystals
  for (const s of shards) {
    if (s.taken) continue;
    const sx = (s.x - camera.x) * cw;
    const sy = (s.y - camera.y) * ch;
    const pulse = 0.6 + Math.sin(simFrame * 0.15 + s.x) * 0.4;
    displayCtx.fillStyle = 'rgba(110, 232, 224, ' + (0.3 * pulse).toFixed(2) + ')';
    displayCtx.fillRect(sx - 2 * cw, sy - 2 * ch, 4 * cw, 4 * ch);
    displayCtx.fillStyle = '#7ee8e0';
    displayCtx.fillRect(sx - 0.5 * cw, sy - 1.5 * ch, cw, 3 * ch);
    displayCtx.fillRect(sx - 1.5 * cw, sy - 0.5 * ch, 3 * cw, ch);
  }

  // the relic: a pulsing gold prize glinting through its vault glass
  if (relic.present && !relic.taken) {
    const rx = (relic.x - camera.x) * cw;
    const ry = (relic.y - camera.y) * ch;
    const pulse = 0.6 + Math.sin(simFrame * 0.12 + relic.x) * 0.4;
    displayCtx.fillStyle = 'rgba(255, 215, 94, ' + (0.35 * pulse).toFixed(2) + ')';
    displayCtx.fillRect(rx - 2 * cw, ry - 2 * ch, 4 * cw, 4 * ch);
    displayCtx.fillStyle = '#ffd75e';
    displayCtx.fillRect(rx - 0.5 * cw, ry - 1.5 * ch, cw, 3 * ch);
    displayCtx.fillRect(rx - 1.5 * cw, ry - 0.5 * ch, 3 * cw, ch);
  }

  const sx = (portal.x - camera.x) * cw;
  const sy = (portal.y - camera.y) * ch;
  if (shardsRemaining() > 0 || bossAlive()) {
    // dormant: dim, barely breathing
    displayCtx.fillStyle = 'rgba(110, 95, 140, 0.15)';
    displayCtx.fillRect(sx - 4 * cw, sy - 5 * ch, 8 * cw, 10 * ch);
    displayCtx.fillStyle = 'rgba(120, 105, 150, 0.5)';
    displayCtx.fillRect(sx - 1.5 * cw, sy - 3 * ch, 3 * cw, 6 * ch);
  } else {
    const pulse = 1 + Math.sin(simFrame * 0.1) * 0.3;
    displayCtx.fillStyle = 'rgba(150, 110, 255, 0.25)';
    displayCtx.fillRect(sx - 4 * cw * pulse, sy - 5 * ch * pulse, 8 * cw * pulse, 10 * ch * pulse);
    displayCtx.fillStyle = 'rgba(180, 140, 255, 0.9)';
    displayCtx.fillRect(sx - 1.5 * cw, sy - 3 * ch, 3 * cw, 6 * ch);
  }
}

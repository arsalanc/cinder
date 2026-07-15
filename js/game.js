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
  dead: false,
  won: false,
  kills: 0,
  portalHint: false, // player is at the portal but shards remain
};

const portal = { x: 0, y: 0 };

// --- meta-progression: persists across sessions via localStorage ------------

function loadMeta() {
  const m = { bestDepth: 0, wins: 0, kills: 0, runs: 0 };
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

// Replays and daily runs inject their seed here before calling startRun
let pendingRunSeed = null;

function startRun() {
  resetModifiers();
  resetWand();
  run.active = true;
  run.depth = 1;
  run.mods = [];
  run.choosing = false;
  run.dead = false;
  run.won = false;
  run.kills = 0;
  // Math.random on purpose: fresh entropy for each run; everything after
  // this seed is deterministic via the sim PRNG (which is why a seed plus
  // recorded inputs replays the entire run)
  run.seed = pendingRunSeed || Math.random().toString(36).slice(2, 8);
  pendingRunSeed = null;
  if (typeof replayBeginRecording === 'function') replayBeginRecording(run.seed);
  beginLevel();
  hideOverlay();
}

function isBossDepth(d) {
  return d === 3 || d === WIN_DEPTH;
}

function bossAlive() {
  return creatures.some(c => CREATURE_TYPES[c.key].boss);
}

function spawnBoss() {
  const key = run.depth >= WIN_DEPTH ? 'tempest' : 'magmaworm';
  const t = CREATURE_TYPES[key];
  // arena pocket beside the portal it guards
  const bx = Math.max(14, Math.min(SIM_W - 14, portal.x + (rand() < 0.5 ? -16 : 16)));
  const by = Math.max(14, portal.y - 6);
  digCircle(bx, by, 9);
  creatures.push({
    key, x: bx - t.w / 2, y: by - t.h / 2, vx: 0, vy: 0,
    w: t.w, h: t.h, hp: t.hp, dir: 1, burning: 0, hurtFlash: 0,
    bob: 0, attackCd: 90,
  });
}

function beginLevel() {
  if (isBossDepth(run.depth)) {
    // a purpose-built arena: player on the left shelf, portal + boss on the
    // right, water reservoir between — the worm has to cross to reach you
    generateBossChamber(run.seed + '#' + run.depth,
      run.depth >= WIN_DEPTH ? 'tempest' : 'magmaworm');
    placeSpawn(bossArena.spawnX - player.w / 2, bossArena.floorY - player.h - 1);
    portal.x = bossArena.portalX;
    portal.y = bossArena.floorY - 1;
    paintCircle(portal.x, portal.y - 1, 4, E.EMPTY);
    shards.length = 0;   // slay the guardian instead of gathering shards
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
    const dx = pcx - portal.x;
    const dy = pcy - portal.y;
    const nearPortal = dx * dx + dy * dy < 30;
    const cleared = shardsRemaining() === 0 && !bossAlive();
    run.portalHint = nearPortal && !cleared;
    if (nearPortal && cleared) levelComplete();
  } else if (!run.dead) {
    run.dead = true;
    const unlocked = finishRun(false);
    if (typeof replayEndRecording === 'function') replayEndRecording();
    playSfx('death');
    showEndOverlay('You died at depth ' + run.depth, unlocked);
  }
}

function levelComplete() {
  if (run.depth >= WIN_DEPTH) { // that was the last portal: victory
    run.won = true;
    run.active = false;
    const unlocked = finishRun(true);
    if (typeof replayEndRecording === 'function') replayEndRecording();
    playSfx('portal');
    showEndOverlay('You escaped the depths — victory!', unlocked);
    return;
  }
  run.depth++;
  run.choosing = true;
  playSfx('portal');
  showChoiceOverlay(rollChoices(3, run.mods));
}

function chooseModifier(mod) {
  playSfx('pick');
  if (typeof replayNoteMod === 'function') replayNoteMod(mod.name);
  mod.apply();
  run.mods.push(mod.name);
  run.choosing = false;
  hideOverlay();
  beginLevel();
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
    'Depth ' + run.depth + ' of ' + WIN_DEPTH + ' — choose a synergy';
  document.getElementById('overlay-stats').innerHTML = '';
  const cards = document.getElementById('overlay-cards');
  cards.innerHTML = '';
  for (const mod of choices) {
    const btn = document.createElement('button');
    btn.className = 'card';
    btn.innerHTML = '<b>' + mod.name + '</b><span>' + mod.desc + '</span>';
    btn.addEventListener('click', () => chooseModifier(mod));
    cards.appendChild(btn);
  }
  document.getElementById('overlay-action').style.display = 'none';
  overlay.style.display = 'flex';
}

function showEndOverlay(title, unlocked) {
  if (typeof document === 'undefined') return;
  const overlay = document.getElementById('overlay');
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
    ? 'D' + run.depth + '/' + WIN_DEPTH +
      (isBossDepth(run.depth) ? ' ☠'
        : shards.length ? ' ◆' + (shards.length - shardsRemaining()) + '/' + shards.length : '')
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
  displayCtx.fillRect(x, 10, w * Math.max(0, b.hp / t.hp), 8);
  // phase thresholds so the rhythm is readable
  displayCtx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  displayCtx.fillRect(x + w * 0.34, 9, 1.5, 10);
  displayCtx.fillRect(x + w * 0.67, 9, 1.5, 10);
  // one-line state hint: the fight has rules, so the bar teaches them
  let hint = '';
  if ((b.surgeT || 0) > 0) hint = 'MAGMA SURGE — dodge the geysers';
  else if ((b.squallT || 0) > 0) hint = 'STORM SQUALL — take cover';
  else if (b.exposedT > 0) hint = 'EXPOSED — strike now (stomp it!)';
  else if ((b.chargingT || 0) > 0) hint = 'CHARGING — get behind cover';
  else if ((b.breachTel || 0) > 0) hint = 'IT\'S COMING UP — move!';
  else if (b.key === 'magmaworm') hint = 'molten shell — quench it in water';
  else if (b.key === 'tempest') hint = 'storm-charged — soak it to short it out';
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

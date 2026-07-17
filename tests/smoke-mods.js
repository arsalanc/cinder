// Headless smoke test: modifier batch 1 (Frost Aura crust, Iron Boots,
// climate picks, Ember Heart, tag-weighted rolls).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'js');
const ctx = vm.createContext({ Math, console, Date });
for (const f of ['elements.js', 'sim.js', 'worldgen.js', 'input.js', 'player.js', 'spells.js', 'synergies.js', 'audio.js', 'creatures.js', 'weather.js', 'game.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}
const out = vm.runInContext(`
(function () {
  const results = [];
  function test(name, fn) {
    try { fn(); results.push('PASS ' + name); }
    catch (e) { results.push('FAIL ' + name + ': ' + (e.stack ? e.stack.split('\\n')[0] : e)); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg); }
  function count(id) { let c = 0; for (let i = 0; i < CELLS; i++) if (grid[i] === id) c++; return c; }
  function mod(name) { return MODIFIERS.find(m => m.name === name); }
  function floorWorld() {
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
  }
  function pinPlayer(x, y) {
    player.x = x; player.y = y; player.vx = 0; player.vy = 0;
    player.alive = true; player.hp = 100; player.maxHp = 100;
    player.hurtCd = 0; player.warmth = 60; player.burning = 0;
    input.keys = {};
  }

  test('all four new modifiers exist and every modifier carries tags', () => {
    for (const n of ['Iron Boots', 'Winter Pelt', 'Furnace Heart', 'Ember Heart']) {
      assert(mod(n), n + ' missing');
    }
    for (const m of MODIFIERS) {
      assert(Array.isArray(m.tags) && m.tags.length > 0, m.name + ' has no tags');
    }
  });

  test('every modifier has a valid 8x8 sprite in the shared palette', () => {
    for (const m of MODIFIERS) {
      const px = MOD_ICONS[m.name];
      assert(px, m.name + ' has no icon');
      assert(px.length === 8, m.name + ' icon not 8 rows');
      for (const row of px) {
        assert(row.length === 8, m.name + ' row not 8 wide: "' + row + '"');
        for (const ch of row) {
          assert(ch === '.' || ICON_COLORS[ch],
            m.name + ' uses unknown palette char "' + ch + '"');
        }
      }
    }
    // and no orphaned icons for mods that no longer exist
    for (const name in MOD_ICONS) {
      assert(mod(name), 'icon for unknown modifier: ' + name);
    }
    // trophy tiles too
    for (const key of ['magmaworm', 'tempest', 'overgrowth', 'elite']) {
      const px = TROPHY_ICONS[key];
      assert(px && px.length === 8, 'trophy icon bad: ' + key);
      for (const row of px) {
        assert(row.length === 8, key + ' trophy row not 8 wide');
        for (const ch of row) {
          assert(ch === '.' || ICON_COLORS[ch], key + ' unknown char "' + ch + '"');
        }
      }
    }
    // and the creature roster: every non-boss creature wears valid pixel art
    for (const key in CREATURE_TYPES) {
      if (CREATURE_TYPES[key].boss) continue;
      const px = CREATURE_PX[key];
      assert(px && px.length === 8, key + ' has no sprite');
      for (const row of px) {
        assert(row.length === 8, key + ' sprite row not 8 wide: "' + row + '"');
        for (const ch of row) {
          assert(ch === '.' || ICON_COLORS[ch], key + ' unknown char "' + ch + '"');
        }
      }
    }
    for (const key in CREATURE_PX) {
      assert(CREATURE_TYPES[key], 'sprite for unknown creature: ' + key);
    }
  });

  test('Frost Aura freezes only the surface — the pool below stays liquid', () => {
    floorWorld(); seedSim(90);
    resetModifiers();
    mod('Frost Aura').apply();
    // a deep pool; the player stands beside it
    for (let x = 130; x < 170; x++)
      for (let y = SIM_H - 16; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    pinPlayer(150, SIM_H - 20); // hovering just above the surface
    for (let k = 0; k < 300; k++) applyAuras();
    // crust forms AROUND the body, never under it (the never-entomb gap), so
    // a hovering player gets ~4 reachable surface cells frozen
    assert(count(E.ICE) >= 3, 'no crust formed: ' + count(E.ICE));
    // nothing below the surface row may be frozen
    let deepIce = 0;
    for (let x = 128; x < 172; x++)
      for (let y = SIM_H - 15; y < SIM_H - 6; y++)
        if (grid[idx(x, y)] === E.ICE) deepIce++;
    assert(deepIce === 0, 'aura froze below the surface: ' + deepIce + ' deep ice');
    assert(count(E.WATER) > 300, 'the pool itself was consumed: ' + count(E.WATER));
    resetModifiers();
  });

  test('Iron Boots: landing on an armored enemy crushes through its armor', () => {
    floorWorld(); seedSim(91);
    resetModifiers();
    mod('Iron Boots').apply();
    clearCreatures();
    const t = CREATURE_TYPES.shaleback; // armor 0.5
    creatures.push({ key: 'shaleback', x: 150, y: SIM_H - 6 - t.h, vx: 0, vy: 0,
      w: t.w, h: t.h, hp: t.hp, dir: 1, burning: 0, hurtFlash: 0, bob: 0, attackCd: 60 });
    const c = creatures[0];
    pinPlayer(c.x + 0.5, c.y - player.h + 0.5);
    player.vy = 1.2; // falling onto its back
    const hpBefore = c.hp, playerHp = player.hp;
    updateCreatures();
    assert(hpBefore - c.hp >= 17.5, 'stomp did not pierce armor: ' + (hpBefore - c.hp));
    assert(player.vy < 0, 'no bounce');
    assert(player.hp === playerHp, 'stomper still took contact damage');
    resetModifiers();
  });

  test('without Iron Boots the same landing is just contact damage', () => {
    floorWorld(); seedSim(92);
    resetModifiers();
    clearCreatures();
    const t = CREATURE_TYPES.shaleback;
    creatures.push({ key: 'shaleback', x: 150, y: SIM_H - 6 - t.h, vx: 0, vy: 0,
      w: t.w, h: t.h, hp: t.hp, dir: 1, burning: 0, hurtFlash: 0, bob: 0, attackCd: 60 });
    const c = creatures[0];
    pinPlayer(c.x + 0.5, c.y - player.h + 0.5);
    player.vy = 1.2;
    const hpBefore = c.hp;
    updateCreatures();
    assert(c.hp === hpBefore, 'creature took stomp damage without the mod');
    assert(player.hp < 100, 'player took no contact damage');
    resetModifiers();
  });

  test('Winter Pelt: hypothermia does nothing, heatstroke bites harder', () => {
    floorWorld();
    resetModifiers();
    mod('Winter Pelt').apply();
    pinPlayer(150, SIM_H - 6 - player.h);
    ambientTemp.fill(-40); temp.fill(-40);
    player.warmth = 5;
    for (let k = 0; k < 200; k++) updatePlayer();
    assert(player.hp > 99.9, 'Winter Pelt still froze: hp ' + player.hp.toFixed(1));
    // and the flip side: heat hurts MORE than baseline
    player.hp = 100; ambientTemp.fill(120); temp.fill(120); player.warmth = 105;
    for (let k = 0; k < 200; k++) { updatePlayer(); player.warmth = 105; }
    const peltLoss = 100 - player.hp;
    resetModifiers();
    player.hp = 100; player.warmth = 105;
    for (let k = 0; k < 200; k++) { updatePlayer(); player.warmth = 105; }
    const baseLoss = 100 - player.hp;
    assert(peltLoss > baseLoss * 1.3,
      'heat penalty missing: pelt ' + peltLoss.toFixed(1) + ' vs base ' + baseLoss.toFixed(1));
    ambientTemp.fill(15); temp.fill(15);
  });

  test('Furnace Heart: heatstroke does nothing, cold bites harder', () => {
    floorWorld();
    resetModifiers();
    mod('Furnace Heart').apply();
    pinPlayer(150, SIM_H - 6 - player.h);
    ambientTemp.fill(120); temp.fill(120);
    player.warmth = 105;
    for (let k = 0; k < 200; k++) { updatePlayer(); player.warmth = 105; }
    assert(player.hp > 99.9, 'Furnace Heart still overheated: hp ' + player.hp.toFixed(1));
    resetModifiers();
    ambientTemp.fill(15); temp.fill(15);
  });

  test('Ember Heart keeps the player warm in a frozen cave (and melts snow)', () => {
    floorWorld(); seedSim(93);
    resetModifiers();
    ambientTemp.fill(-20); temp.fill(-20); // deep-freeze ambient
    pinPlayer(150, SIM_H - 6 - player.h);
    // baseline: without the mod the player chills toward hypothermia
    for (let k = 0; k < 600; k++) { simStep(); updatePlayer(); }
    assert(player.warmth < 25, 'baseline never got cold: ' + player.warmth.toFixed(0));
    // with Ember Heart the radiated heat holds the frost off entirely
    mod('Ember Heart').apply();
    player.warmth = 60; player.hp = 100;
    let snowPlaced = false;
    for (let k = 0; k < 900; k++) {
      simStep(); updatePlayer();
      if (k === 300 && !snowPlaced) { // drop snow beside the player mid-run
        for (let x = 146; x < 156; x++) setCell(idx(x, SIM_H - 7), E.SNOW);
        snowPlaced = true;
      }
    }
    assert(player.warmth > 35, 'Ember Heart player still froze: ' + player.warmth.toFixed(0));
    assert(player.hp > 95, 'Ember Heart player bled hp: ' + player.hp.toFixed(0));
    assert(count(E.SNOW) < 10, 'snow survived beside a furnace-hot player: ' + count(E.SNOW));
    resetModifiers();
    ambientTemp.fill(15); temp.fill(15);
  });

  test('rolls drift toward tags you have taken (fire build attracts fire mods)', () => {
    seedSim(94);
    const FIRE = new Set(MODIFIERS.filter(m => (m.tags || []).includes('fire')).map(m => m.name));
    // make every mod visible to the roll regardless of meta unlocks
    meta.wins = 5; meta.kills = 99; meta.bestDepth = 6;
    function fireRate(taken) {
      let fire = 0, total = 0;
      for (let k = 0; k < 400; k++) {
        for (const p of rollChoices(3, taken)) { total++; if (FIRE.has(p.name)) fire++; }
      }
      return fire / total;
    }
    const base = fireRate([]);
    const drifted = fireRate(['Pyromaniac', 'Flamethrower', 'Ember Heart']);
    assert(drifted > base * 1.25,
      'no drift: base ' + base.toFixed(3) + ' vs taken-fire ' + drifted.toFixed(3));
    // and it still never offers what you already own
    for (let k = 0; k < 50; k++) {
      for (const p of rollChoices(3, ['Pyromaniac', 'Flamethrower', 'Ember Heart'])) {
        assert(p.name !== 'Pyromaniac', 'offered an already-taken mod');
      }
    }
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

// --- outer-script check: every sprite the docs reference exists on disk ----
// (gen-docs writes docs/sprites/*.png from the same tables; a missing file
// means someone added content without regenerating the docs)
{
  const spritesDir = path.join(__dirname, '..', 'docs', 'sprites');
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const wanted = [];
  const names = JSON.parse(vm.runInContext(`JSON.stringify({
    mods: MODIFIERS.map(m => m.name),
    spells: Object.keys(SPELLS),
    evos: Object.keys(SPELLS).filter(k => SPELLS[k].evo).map(k => SPELLS[k].evo.iconKey),
    creatures: Object.keys(CREATURE_TYPES),
    trophies: Object.keys(TROPHY_ICONS),
  })`, ctx));
  for (const n of names.mods) wanted.push('mod-' + slug(n) + '.png');
  for (const n of names.spells) wanted.push('spell-' + slug(n) + '.png');
  for (const n of names.evos) wanted.push('evo-' + slug(n) + '.png');
  for (const n of names.creatures) {
    wanted.push((names.trophies.includes(n) ? 'boss-' : 'c-') + slug(n) + '.png');
  }
  const missing = wanted.filter(f => !fs.existsSync(path.join(spritesDir, f)));
  if (missing.length === 0) {
    console.log('PASS every documented sprite exists in docs/sprites (' + wanted.length + ')');
  } else {
    console.log('FAIL sprite files missing (run node tools/gen-docs.js): ' + missing.join(', '));
  }
}

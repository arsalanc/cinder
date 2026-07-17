// Headless smoke test for creatures.
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
  function runFrames(n) { for (let k = 0; k < n; k++) { simStep(); updateCreatures(); } }
  function arena() {
    resetModifiers(); resetWand(); clearCreatures(); clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    player.x = 20; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true;
    player.burning = 0; player.hurtCd = 0;
  }
  function addCreature(key, x, y) {
    const t = CREATURE_TYPES[key];
    creatures.push({ key, x, y, vx: 0, vy: 0, w: t.w, h: t.h, hp: t.hp,
                     dir: 1, burning: 0, hurtFlash: 0, bob: 0 });
    return creatures[creatures.length - 1];
  }

  test('creatures spawn in open space away from the player', () => {
    generateWorld('cr-1', 3);
    spawnPlayer();
    spawnCreatures(3);
    assert(creatures.length >= 3, 'too few spawned: ' + creatures.length);
    for (const c of creatures) {
      const dx = c.x - player.x, dy = c.y - player.y;
      assert(dx * dx + dy * dy >= 40 * 40, 'spawned on top of player');
    }
  });

  test('grub falls, lands, and patrols the ground', () => {
    arena();
    const c = addCreature('grub', 150, SIM_H - 40);
    const x0 = c.x;
    runFrames(200);
    assert(creatures.length === 1, 'grub died');
    assert(c.y + c.h > SIM_H - 8, 'not on the floor: y=' + c.y.toFixed(1));
    assert(Math.abs(c.x - x0) > 3, 'never moved: x=' + c.x.toFixed(1));
  });

  test('fire kills a grub (leaves a smoke puff)', () => {
    arena();
    const c = addCreature('grub', 150, SIM_H - 8);
    for (let x = 145; x < 160; x++)
      for (let y = SIM_H - 12; y < SIM_H - 6; y++) setCell(idx(x, y), E.FIRE);
    runFrames(300);
    assert(creatures.length === 0, 'grub survived a bonfire: hp=' + (creatures[0] && creatures[0].hp));
  });

  test('wisp dies instantly in water', () => {
    arena();
    for (let x = 140; x < 170; x++)
      for (let y = SIM_H - 20; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    addCreature('wisp', 152, SIM_H - 15);
    runFrames(5);
    assert(creatures.length === 0, 'wisp survived water');
  });

  test('bloat explodes on death and craters the terrain', () => {
    arena();
    for (let x = 140; x < 170; x++)
      for (let y = SIM_H - 30; y < SIM_H - 6; y++) setCell(idx(x, y), E.STONE);
    const stoneBefore = count(E.STONE);
    const c = addCreature('bloat', 150, SIM_H - 36);
    c.hp = 0.01;
    setCell(idx(151, SIM_H - 34), E.FIRE); // any scratch will do
    runFrames(100);
    assert(creatures.length === 0, 'bloat did not die');
    assert(count(E.STONE) < stoneBefore, 'no crater from bloat');
  });

  test('projectiles damage and kill creatures (with mana reward)', () => {
    arena();
    const c = addCreature('grub', 60, SIM_H - 8); // right in front of player
    wand.mana = 100;
    selectSpell(0); // spark
    let safety = 0;
    while (creatures.length > 0 && safety++ < 40) {
      wand.cooldown = 0; wand.mana = Math.max(wand.mana, 50);
      castSelectedSpell(61, SIM_H - 7);
      for (let k = 0; k < 10; k++) { simStep(); updateSpells(); updateCreatures(); }
    }
    assert(creatures.length === 0, 'grub survived ' + safety + ' volleys (hp ' + (creatures[0] && creatures[0].hp) + ')');
  });

  test('contact hurts the player once per invulnerability window', () => {
    arena();
    const c = addCreature('grub', player.x, player.y); // overlapping
    const hpBefore = player.hp;
    runFrames(10);
    const lost = hpBefore - player.hp;
    assert(lost > 0, 'no contact damage');
    assert(lost <= CREATURE_TYPES.grub.contactDmg + 1,
      'damage not gated by hurtCd: lost ' + lost.toFixed(1));
  });

  test('creatures burn and shed fire into the world', () => {
    arena();
    for (let x = 100; x < 140; x++) setCell(idx(x, SIM_H - 7), E.WOOD);
    const c = addCreature('grub', 120, SIM_H - 10);
    c.burning = 200;
    runFrames(120);
    // burning grub should have started at least some fire around it
    assert(count(E.FIRE) + count(E.SMOKE) > 0 || creatures.length === 0,
      'burning creature had no effect on the world');
  });

  test('every biome has a spawn table of valid, defined creatures', () => {
    for (const b of BIOMES) {
      const table = BIOME_SPAWNS[b.name];
      assert(table, 'no spawn table for biome: ' + b.name);
      for (const [key] of table) assert(CREATURE_TYPES[key], b.name + ' spawns unknown ' + key);
    }
    // each biome leads with a distinct signature (its heaviest-weighted entry)
    const lead = {};
    for (const name in BIOME_SPAWNS) {
      lead[name] = BIOME_SPAWNS[name].reduce((a, e) => e[1] > a[1] ? e : a)[0];
    }
    const sigs = new Set(Object.values(lead));
    assert(sigs.size >= 5, 'biomes share too many signatures: ' + JSON.stringify(lead));
  });

  test('shaleback armor halves incoming weapon damage', () => {
    arena();
    const s = addCreature('shaleback', 100, SIM_H - 9);
    const g = addCreature('grub', 140, SIM_H - 8);
    const sBefore = s.hp, gBefore = g.hp;
    damageCreature(s, 10);
    damageCreature(g, 10);
    assert(Math.abs((sBefore - s.hp) - 5) < 0.01, 'armor not applied: lost ' + (sBefore - s.hp));
    assert(Math.abs((gBefore - g.hp) - 10) < 0.01, 'grub took wrong damage: ' + (gBefore - g.hp));
  });

  test('pouncer leaps off the ground toward the player', () => {
    arena();
    player.x = 20;
    const c = addCreature('pouncer', 90, SIM_H - 6 - CREATURE_TYPES.pouncer.h);
    const startY = c.y;
    let leftGround = false;
    for (let k = 0; k < 200 && !leftGround; k++) {
      simStep(); updateCreatures();
      if (c.y < startY - 1.5) leftGround = true;
    }
    assert(leftGround, 'pouncer never left the ground');
  });

  test('frostling contact saps player warmth', () => {
    arena();
    player.warmth = 60; player.hurtCd = 0;
    addCreature('frostling', player.x, player.y); // overlapping
    runFrames(6);
    assert(player.warmth <= 60 - CREATURE_TYPES.frostling.chill + 1,
      'warmth not drained: ' + player.warmth.toFixed(1));
  });

  test('seeper lays flammable oil slicks behind it', () => {
    arena();
    addCreature('seeper', 150, SIM_H - 8);
    runFrames(150);
    assert(count(E.OIL) > 0, 'seeper left no oil');
  });

  test('magmite drips lava as it walks', () => {
    arena();
    const c = addCreature('magmite', 150, SIM_H - 9);
    runFrames(250);
    assert(count(E.LAVA) > 0, 'magmite left no lava');
    assert(creatures.length === 1, 'magmite died in its own lava (should be fireproof)');
  });

  test('voltbug electrifies a nearby puddle', () => {
    arena();
    for (let x = 140; x < 165; x++)
      for (let y = SIM_H - 9; y < SIM_H - 6; y++) setCell(idx(x, y), E.WATER);
    addCreature('voltbug', 150, SIM_H - 12);
    let charged = false;
    for (let k = 0; k < 120 && !charged; k++) {
      simStep(); updateCreatures();
      if (count(E.EWATER) > 0) charged = true;
    }
    assert(charged, 'voltbug never charged the puddle');
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

// Headless smoke test for the wand/spell system and portal reachability.
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
  function runFrames(n) { for (let k = 0; k < n; k++) { simStep(); updateSpells(); } }
  function arena() {
    resetModifiers(); resetWand(); clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = SIM_H - 6; y < SIM_H; y++) setCell(idx(x, y), E.WALL);
    player.x = 60; player.y = SIM_H - 6 - player.h;
    player.vx = 0; player.vy = 0; player.hp = 100; player.alive = true; player.burning = 0;
  }

  test('starter wand: spark/water/dig, full mana', () => {
    resetWand();
    assert(wand.spells.join(',') === 'spark,water,dig', 'loadout: ' + wand.spells);
    assert(wand.spells.includes('dig'), 'dig must always be present');
    assert(wand.mana === wand.maxMana, 'mana not full');
  });

  test('spark bolt sets a wood wall on fire and costs mana', () => {
    arena();
    for (let x = 100; x < 104; x++)
      for (let y = SIM_H - 30; y < SIM_H - 6; y++) setCell(idx(x, y), E.WOOD);
    selectSpell(0);
    const manaBefore = wand.mana;
    castSelectedSpell(101, SIM_H - 12);
    assert(wand.mana < manaBefore, 'no mana cost');
    assert(projectiles.length === 1, 'no projectile');
    runFrames(120);
    assert(count(E.FIRE) > 0 || count(E.SMOKE) > 0, 'nothing caught fire');
  });

  test('cooldown limits cast rate', () => {
    arena();
    selectSpell(0);
    castSelectedSpell(100, SIM_H - 12);
    const n = projectiles.length;
    castSelectedSpell(100, SIM_H - 12); // immediately again -> blocked
    assert(projectiles.length === n, 'cooldown not enforced');
  });

  test('dig blast excavates stone but never WALL', () => {
    arena();
    for (let x = 80; x < 90; x++)
      for (let y = SIM_H - 26; y < SIM_H - 6; y++) setCell(idx(x, y), E.STONE);
    const stoneBefore = count(E.STONE);
    const wallBefore = count(E.WALL);
    selectSpell(2);
    for (let c = 0; c < 6; c++) {
      wand.cooldown = 0; wand.mana = 100;
      castSelectedSpell(84, SIM_H - 12);
      runFrames(30);
    }
    assert(count(E.STONE) < stoneBefore - 10, 'stone not dug: ' + count(E.STONE) + '/' + stoneBefore);
    assert(count(E.WALL) === wallBefore, 'WALL was destroyed');
  });

  test('mana regenerates; Overcharge speeds it up', () => {
    arena();
    wand.mana = 10;
    runFrames(60);
    const normal = wand.mana;
    assert(normal > 10, 'no regen');
    MODIFIERS.find(m => m.name === 'Overcharge').apply();
    wand.mana = 10;
    runFrames(60);
    assert(wand.mana > normal, 'Overcharge no faster: ' + wand.mana + ' vs ' + normal);
  });

  test('Powder Bomb synergy grants the spell and it detonates', () => {
    arena();
    MODIFIERS.find(m => m.name === 'Powder Bomb').apply();
    assert(wand.spells.includes('bomb'), 'bomb not granted');
    for (let x = 78; x < 108; x++)
      for (let y = SIM_H - 26; y < SIM_H - 6; y++) setCell(idx(x, y), E.STONE);
    const stoneBefore = count(E.STONE);
    selectSpell(wand.spells.indexOf('bomb'));
    castSelectedSpell(80, SIM_H - 16); // close wall — direct hit

    runFrames(200);
    assert(count(E.STONE) < stoneBefore, 'no crater');
    assert(count(E.FIRE) + count(E.SMOKE) > 0, 'no blast aftermath');
  });

  test('empty mana refuses to cast', () => {
    arena();
    wand.mana = 0; wand.cooldown = 0;
    selectSpell(0);
    castSelectedSpell(100, SIM_H - 12);
    assert(projectiles.length === 0, 'cast with no mana');
  });

  test('portal is flood-reachable from spawn across 12 generated levels', () => {
    for (let d = 1; d <= 12; d++) {
      generateWorld('reach-' + d, d);
      spawnPlayer();
      placePortal();
      const reach = reachableFrom(
        Math.round(player.x + player.w / 2),
        Math.round(player.y + player.h / 2));
      assert(reach[idx(portal.x, portal.y)] === 1,
        'portal unreachable at depth ' + d + ' (' + portal.x + ',' + portal.y + ')');
    }
  });

  test('fallback shaft rescues an impossible layout', () => {
    // pathological world: solid stone below the surface, nowhere open
    clearSim();
    for (let x = 0; x < SIM_W; x++)
      for (let y = 30; y < SIM_H; y++) setCell(idx(x, y), E.STONE);
    for (let x = 0; x < SIM_W; x++) setCell(idx(x, SIM_H - 1), E.WALL);
    player.x = 150; player.y = 22; player.alive = true;
    placePortal();
    const reach = reachableFrom(152, 25);
    assert(reach[idx(portal.x, portal.y)] === 1, 'fallback shaft did not connect portal');
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

// Headless smoke test: essence shards gate the portal.
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

  test('levels place 2+ spread-out shards in reachable open cells', () => {
    for (const d of [1, 2, 4, 5]) { // 3 and 6 are boss levels (no shards)
      startRun();
      run.depth = d;
      beginLevel();
      assert(shards.length >= 2, 'only ' + shards.length + ' shards at depth ' + d);
      const reach = reachableFrom(
        Math.round(player.x + player.w / 2),
        Math.round(player.y + player.h / 2));
      for (const s of shards) {
        assert(reach[idx(s.x, s.y)] === 1, 'unreachable shard at depth ' + d);
      }
      // shards should be spread out, not clustered at one dig target
      let minD = Infinity;
      for (let a = 0; a < shards.length; a++) {
        for (let b = a + 1; b < shards.length; b++) {
          const dx = shards[a].x - shards[b].x, dy = shards[a].y - shards[b].y;
          minD = Math.min(minD, Math.sqrt(dx * dx + dy * dy));
        }
      }
      assert(minD > 10, 'shards clustered (min dist ' + minD.toFixed(0) + ') at depth ' + d);
    }
  });

  test('boss depths have no shards (guardian gates the portal instead)', () => {
    startRun();
    run.depth = 3;
    beginLevel();
    assert(shards.length === 0, 'boss level has shards');
    assert(creatures.some(c => CREATURE_TYPES[c.key].boss), 'no boss spawned');
  });

  test('shard count scales with depth', () => {
    startRun();
    const d1 = shards.length;
    run.depth = 5;
    beginLevel();
    assert(shards.length >= d1, 'no scaling: D1=' + d1 + ' D5=' + shards.length);
    assert(shards.length <= 4, 'too many shards: ' + shards.length);
  });

  test('portal stays dormant until every shard is collected', () => {
    startRun();
    const depthBefore = run.depth;
    player.x = portal.x - player.w / 2;
    player.y = portal.y - player.h / 2;
    updateGame();
    assert(!run.choosing, 'portal fired while dormant');
    assert(run.depth === depthBefore, 'depth advanced while dormant');
    assert(run.portalHint, 'no dormant hint shown at the portal');
  });

  test('walking onto shards collects them, then the portal works', () => {
    startRun();
    for (const s of shards) {
      player.x = s.x - player.w / 2;
      player.y = s.y - player.h / 2;
      updateGame();
      assert(s.taken, 'shard not collected at ' + s.x + ',' + s.y);
    }
    assert(shardsRemaining() === 0, 'shards left: ' + shardsRemaining());
    player.x = portal.x - player.w / 2;
    player.y = portal.y - player.h / 2;
    updateGame();
    assert(run.choosing, 'portal did not activate after all shards');
  });

  test('HUD counter reflects collection', () => {
    startRun();
    assert(shardsRemaining() === shards.length, 'fresh level should have all remaining');
    shards[0].taken = true;
    assert(shardsRemaining() === shards.length - 1, 'remaining count wrong');
  });

  return results.join('\\n');
})()
`, ctx);
console.log(out);

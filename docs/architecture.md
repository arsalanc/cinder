# Architecture

How CINDER is built, for anyone working on the code. It's vanilla JS with no
build step and no dependencies — plain `<script>` tags sharing globals, so it
runs from `file://`. Load order matters (each file assumes the ones above it):
`elements → sim → worldgen → player → spells → synergies → audio → creatures
→ weather → game → replay → render → input → main`.

## File layout

| File | Role |
| --- | --- |
| `js/elements.js` | **Data layer.** Element definitions (movement archetype, density, flammability, colors) and the `REACTIONS` table. |
| `js/sim.js` | **Simulation core.** Cell grid (structure-of-arrays typed arrays), per-frame update, movement rules, reactions, explosions, the temperature field. Knows nothing about rendering or input. |
| `js/worldgen.js` | **Procedural generation.** Seeded PRNG + value noise, cave carving, connectivity pass, Voronoi biome regions, liquid pools, decoration, machinery set-pieces. |
| `js/player.js` | **Player entity.** AABB with pixel collision against the grid, swimming, jetpack, hazard damage, burning + body-warmth status. The sim never sees the player. |
| `js/spells.js` | **Wand & spells.** Mana, cooldowns, projectiles that paint elements on impact; wand-composition modifiers; spell **evolutions** (`spellForm`, memoized on the mod list); all 8×8 pixel icons (`ICON_PX` / `MOD_ICONS` / `TROPHY_ICONS`). Dig Blast is always in the loadout (anti-soft-lock). |
| `js/synergies.js` | **Synergy system.** Tagged run modifiers that mutate live element data and `runState`; tag-weighted rolls. Baseline snapshot for clean resets. |
| `js/creatures.js` | **Creatures.** Data-typed critters that live in the element sim; shared chase/wander AI with per-type behavior flags. All spawns go through `makeCreature`, all touch damage through `contactPlayer`. The two guardians are extracted state machines (`updateWorm`, `updateTempest`); elites reuse the vulnerability-window grammar. |
| `js/audio.js` | **Sound.** Fully procedural WebAudio (oscillators + filtered noise), no asset files. Throttled per-sound; mute button. |
| `js/weather.js` | **Weather.** Rain / cold snaps / storms; real lightning; a creative-mode override. |
| `js/game.js` | **Run flow.** Level/portal placement with reachability check, shards, relic vaults (traps included), boss depths + endless descent, overlays (choice / end / collection), death recap, daily scoreboard, meta-progression. |
| `js/replay.js` | **Replays.** Records packed input per sim step (+ synergy/respawn events); plays them back deterministically. Share strings (export/import) for the daily-seed loop. |
| `js/render.js` | ImageData renderer at sim resolution, scaled up with crisp pixels; camera (follow + sandbox zoom). |
| `js/input.js` | Pointer painting with stroke interpolation, brush, zoom/pan, the Lightning tool, keyboard shortcuts. |
| `js/main.js` | Bootstrap, palette/tabs UI, HUD, fixed-timestep main loop. |
| `tools/gen-docs.js` | Regenerates the [Elements](elements.md), [Bestiary](bestiary.md), [Biomes](biomes.md), and [Spells](spells.md) reference pages from the source tables. |

## Key design decisions

- **Data-driven everything.** Elements, reactions, biomes, creatures, spells,
  and synergies are plain tables. New content is usually one data entry, and
  the reference docs are generated straight from these tables (see below), so
  they never drift. Run modifiers hook the same tables at runtime.
- **Movement archetypes, not per-element code.** Each element declares a type
  (powder / liquid / gas / fire / static / fauna) plus parameters (density,
  dispersion, lifetime). The sim switches on the archetype.
- **Structure-of-arrays cell state.** `grid` (element id), `shade` (color
  noise), `life` (fire/gas/fauna countdown), `updated` (frame-parity flag so a
  cell never moves twice per frame). All `Uint8/16Array` — fast and GC-free.
- **Bottom-up scan, alternating row direction** avoids the classic left-drift
  bias of falling-sand sims. **Queue-based explosions** let gunpowder chains
  propagate without recursion.

## Determinism

Everything that touches sim state — movement, reactions, explosions, world
settle, spawns, portal/shard placement, creatures, spell spread, auras,
temperature — draws from **one seeded PRNG** (`rand()` / `seedSim()` in
sim.js, seeded by `generateWorld`). Same seed ⇒ byte-identical worlds and
identical evolution over time. Only rendering flicker and the fresh-run seed
use `Math.random`.

This is what makes **replays** work: a run is fully determined by its seed
plus the player's inputs, so `js/replay.js` records a packed input word per
sim step (RLE-compressed) and replays byte-for-byte. Keep it intact — if you
add sim randomness, route it through `rand()`, never `Math.random`.

## Temperature

A coarse field (`temp`, one cell per 4×4 sim cells, updated every 4th step)
drives climate. Biome ambients set the baseline; elements emit heat/cold into
it (metal conducts heat strongly along itself); it diffuses and relaxes back.
Phase changes and biology read it via `tempAt(x, y)`: freezing, melting,
evaporation, glacier compaction, seasonal plant die-back, fauna torpor, and
player body-warmth. Cold sources buffer toward 0° but never below (no
self-refrigerating runaway); surface ice insulates the water beneath it.

Reactions can carry an optional `minTemp` (growth stops in the cold). Body
warmth is a *remap* of ambient temperature, not the raw reading — a 15° cave
is comfortable, so never gate player comfort on raw `tempAt`.

## Fixed timestep

The sim runs at a locked 60 steps/second via an accumulator in `main.js`
(`SIM_DT`, 250 ms backlog cap for background tabs). A 144 Hz monitor gets 144
renders but still 60 sim steps — game speed no longer follows the refresh
rate. The camera is a pure render concern; the whole world simulates whether
or not it's on screen.

## Testing

Headless smoke tests load the JS into a Node `vm` context (browser APIs only
run inside init functions, which the tests never call) and assert on grid
state after N steps. The suites live in **`tests/`** — 22 files, 220+ tests —
covering the sim, worldgen, player, runs, spells, determinism, creatures,
bosses, elites, vaults, evolutions, temperature, seasons, industry, replays,
and more. `node tests/run.js` runs everything in parallel (~5 minutes);
`node tests/run.js boss evo` filters by name. The suite is the safety net for
a sim where one probability tweak can cascade — run it after any change to
sim, worldgen, player, or creatures.

The doc generator uses the same `vm`-load trick: `node tools/gen-docs.js`
snapshots the data tables (JSON drops the `impact`/`apply` methods for free)
and rewrites the four generated reference pages.

## Performance

Grid is 320×200 (64k cells) rendered at 3× — comfortably 60 fps. To scale up:
dirty-rect / chunk sleeping (skip settled regions), and moving the sim into a
Worker with a `SharedArrayBuffer` (needs a server; keep the `file://`
fallback).

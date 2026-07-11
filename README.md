# CINDER

A 2D falling-sand / element simulation sandbox (Powder Toy / Noita style),
built as the foundation for a future roguelite with element synergies and
procedural generation.

## Architecture

The layers are deliberately separated so a game can grow on top of the sim:

| File | Role |
|---|---|
| `js/elements.js` | **Data layer.** Element definitions (movement archetype, density, flammability, colors) and the `REACTIONS` table. |
| `js/sim.js` | **Simulation core.** Cell grid (structure-of-arrays typed arrays), per-frame update, movement rules, explosions. Knows nothing about rendering or input. |
| `js/worldgen.js` | **Procedural world generation.** Seeded PRNG + value noise, cave carving, connectivity pass, Voronoi biome regions, liquid pools, decoration. |
| `js/player.js` | **Player entity.** AABB with pixel collision against the grid, swimming, hazard damage, burning status. The sim never sees the player. |
| `js/synergies.js` | **Synergy system.** Run modifiers that mutate live element data and `runState` (damage multipliers, auras, heals, on-damage hooks). Baseline snapshot for clean resets. |
| `js/spells.js` | **Wand & spells.** Mana pool, cooldowns, projectiles that paint elements on impact. Dig Blast is always in the loadout (anti-soft-lock). |
| `js/creatures.js` | **Creatures.** Data-typed critters (walker/flyer/exploder) that burn, drown, corrode, and explode in the element sim. Shared chase/wander AI. |
| `js/audio.js` | **Sound.** Fully procedural WebAudio (oscillators + filtered noise), no asset files. Throttled per-sound; mute button. |
| `js/game.js` | **Run flow.** Level/portal placement with spawn-reachability check, creature spawning, depth progression, synergy choice + death overlays. |
| `js/render.js` | ImageData renderer at sim resolution, scaled up with crisp pixels. |
| `js/input.js` | Pointer painting with stroke interpolation, brush, shortcuts. |
| `js/main.js` | Bootstrap, palette UI, HUD, main loop. |

### Key design decisions

- **Data-driven reactions.** All chemistry (`water + lava → steam + stone`,
  `acid dissolves wood`, `plant grows from water`) lives in one table:
  `addReaction(a, b, a2, b2, probability)`. This is the hook for roguelite
  synergies — run modifiers can add, remove, or reweight reactions at runtime
  without touching sim code.
- **Movement archetypes, not per-element code.** Elements declare a type
  (powder / liquid / gas / fire / static) plus parameters (density,
  dispersion, lifetime). New elements are usually just a new data entry.
- **Structure-of-arrays cell state.** `grid` (element id), `shade` (color
  noise), `life` (fire/gas countdown), `updated` (frame-parity flag so cells
  never move twice per frame). All `Uint8/16Array` — fast and GC-free.
- **Bottom-up scan with alternating row direction** avoids the classic
  left-drift bias of falling-sand sims.
- **Queue-based explosions** so gunpowder chains propagate without recursion.

## Current elements (17)

Sand, Water, Oil, Wood, Plant, Fire, Smoke, Steam, Acid, Lava, Gunpowder,
Ice, Stone, Wall, Electric, Live Water, Empty. Notable interactions: water
quenches fire into steam, lava + water makes stone, acid eats almost
everything (and dilutes in water), plants drink water and spread, ice slowly
freezes water and melts near heat, gunpowder chain-explodes. **Electricity**
discharges into water as *Live Water* — a charge wave that conducts through
pools with distance falloff (each hop loses charge, so strikes electrify a
radius, not the ocean), shocks swimmers hard, ignites oil, then decays back
to plain water.

**Vegetation is traversal**: plants slow you, catch your falls, and are
climbable like vines (fuel-free); pushing through only gradually tramples
them.

## Ecosystems (20 elements)

Stability comes from **cycles with negative feedback**, not one-way
conversions — every terminal sink got a return path:

- **Nutrient loop**: fire leaves **Ash** (20%); ash + water fertilizes into
  new plants. Burned forests regrow.
- **Reproduction loop**: plants drop **Seeds** — lighter than water, so they
  float and drift to new shores; they germinate on contact with water and
  rot back to ash if they never find any (no immortal seed piles).
- **Grazing loop**: the **Bug** is a cellular grazer — eats plants, breeds
  when well-fed with a crowding limit (populations self-regulate; verified:
  a paradise of 6,700 plants peaked at ~200 bugs), starves back into ash,
  drowns, burns. Plants → bugs → ash → plants.
- **Water cycle**: steam condensation raised to 80% (it was the big leak),
  and burning vegetation releases steam — forest fires seed their own rain.

Verified headlessly: a sealed terrarium (pond + meadow + seeds + grazers)
runs 8,000 steps with plants oscillating in a healthy band, and a torched
forest doubles back past its post-burn population. Overgrown Vault and
Stone Caverns worldgen now seeds ambient bug fauna.

## World generation (step 1 — done)

`generateWorld(seed)` builds a level in ~0.5s:

1. Value-noise fBm carves caverns under a rough terrain surface line
   (deeper = more closed-in), plus a crust so the ground reads as ground.
2. Drunkard-walk tunnels add winding vertical routes.
3. A flood-fill connectivity pass tunnels every stray pocket (≥25 cells)
   into the main cave system — the level is always one traversable space.
4. Biome regions come from a jittered Voronoi over ~12 seeded sites, each
   assigned a biome valid for its depth. **Biomes are data** (`BIOMES` in
   `worldgen.js`): base material, vein material/amount, pool liquid/amount,
   decoration — the same modifier hook as `REACTIONS`.
5. Liquid pools are dropped on cavern floors, then the sim itself runs
   ~300 steps in *settle mode* (`worldSettling`: movement only, no
   fire/chemistry) so pools rest naturally.
6. Decoration: biome plants on cave surfaces, grass on the terrain line.

Current biomes: Stone Caverns (sand veins, water), Overgrown Vault (wood,
water, dense plants), Ice Caves (ice walls, stone veins), Oil Caverns
(oil pools, gunpowder veins — bring a torch), Volcanic Depths (lava).

Everything up to the settle step is seed-deterministic (mulberry32 +
seeded value noise); settling still uses `Math.random`, so exact liquid
positions vary — the determinism pass below fixes that.

## Player & camera (step 2 — done)

**Enter** (or the Play button) toggles play mode: the player spawns on the
surface and the camera zooms to a 160×100-cell window that follows them
(**M** toggles back to the full map — the whole world keeps simulating
either way; the camera is purely a render concern).

- A/D or arrows to move, W/Space/up to jump — or swim when submerged.
- **Jetpack** (Noita-style): keep holding jump while airborne to fly. Runs
  on its own fuel meter (JET bar) — ~2.4s of thrust, refuels in ~1s while
  grounded or swimming. Separate from mana on purpose: flying never costs
  you casts. The exhaust is real smoke cells in the sim.
- Collision is per-cell against the grid: statics and powders block,
  liquids are swimmable, plants trample underfoot, 1-cell ledges auto-step.
- Hazards read straight from the grid: fire and lava set you **burning**
  (damage over time, sheds real fire cells into the sim); acid corrodes;
  water extinguishes burning. Falling sand pushes you out instead of
  entombing you. R respawns, and painting/erasing still works in play mode.

## Runs & synergies (step 3 — done)

**Start Run** begins a roguelite run: descend to the pulsing purple portal in
the depths, and each level cleared offers a pick of 1-of-3 **synergies**
before generating the next, deeper level. Deeper levels skew toward hazardous
biomes (oil caverns, volcanic depths). Death ends the run (score = depth).

Synergies are data + an `apply()` that mutates the live sim tables and/or
`runState` (see `js/synergies.js`): Pyromaniac (world ×2.5 flammable, fire
resist), Fireproof Hide, Frost Aura (nearby water freezes — walk on lakes),
Lava Strider (lava crusts to stone near you), Steam Sprite (steam heals),
Green Thumb (plants spread fast, trampling heals), Acid Blood (leak acid when
hurt), Demolitionist (bigger explosions), Fleetfoot, Tunneler (rock crumbles
around you). `resetModifiers()` restores snapshotted baselines, so sandbox
mode and new runs always start pristine.

## Wand & spells (step 4 — done)

In play mode the mouse is a wand, not a god-tool: left-click casts toward
the cursor (hold to auto-cast), right-click / wheel / 1-5 switch spells.
Spells cost **mana** (regenerating, bar in the panel) and respect cooldowns.
Free painting and right-click erasing are sandbox-only now.

Starter loadout: **Spark Bolt** (arcing fire projectile), **Water Jet**
(spray of droplets), **Dig Blast** (short-range excavation — cannot break
WALL). Synergy picks can add **Powder Bomb** (lobbed, huge blast),
**Acid Spit**, and **Overcharge** (faster mana regen). Spells are data in
`SPELLS` (`js/spells.js`): cost/cooldown/speed/gravity/life + an `impact()`
that writes elements into the sim, so new spells are one entry each.

### Anti-soft-lock guarantees

Three layers keep the portal reachable:
1. World gen connects all open pockets (≥25 cells) into one cave system.
2. `placePortal` only accepts spots **flood-fill reachable from the actual
   spawn** (`reachableFrom` in game.js); a pathological layout falls back to
   carving a shaft from spawn to a bottom pocket.
3. Pits deeper than jump height can't trap you anyway: **Dig Blast is always
   in the loadout and mana regenerates**, so any wall of stone/sand/ice can
   be tunneled (only border WALL is indestructible). This is the same design
   answer Noita uses: a destructible world plus always-available excavation
   beats trying to prove platformer reachability geometrically.

## Determinism (step 5 — done)

Everything that touches sim state — cell movement, reactions, explosions,
world settle, spawns, portal placement, creatures, spell spread, auras —
draws from one seeded PRNG (`rand()`/`seedSim()` in sim.js, seeded by
`generateWorld`). Same seed ⇒ **byte-identical** worlds and identical
evolution over time (verified over 400 steps, including explosion outcomes).
Only rendering flicker and the fresh-run seed itself use `Math.random`.
Full input-replay support would only need recorded keystrokes now.

## Creatures (done)

Three data-defined types in `js/creatures.js`, spawned per level
(more with depth, never near spawn):
- **Grub** — ground patroller; chases and hops when it sees you.
- **Wisp** — fire-themed flyer; sheds embers as it moves (it will
  accidentally torch oil caverns), dies instantly in water.
- **Bloat** — slow drifting gunpowder sack; explodes on death. Shoot it
  from a distance. Never melee it. (Demolitionist scales its blast too.)

Creatures live *inside* the element sim: they burn (and shed fire while
burning), drown, corrode in acid, and get caught in explosions. Contact
damage has an invulnerability window; kills refund 10 mana.

## Sound (done)

`js/audio.js` synthesizes every effect with WebAudio (oscillator sweeps +
filtered noise) — no audio files, so file:// still works. Casts, impacts,
explosions (hooked from the sim via `simHooks`), hits, deaths, portal and
synergy chimes. Per-sound throttling keeps gunpowder chains from stacking
50 booms. Sound button in the panel toggles mute.

## Essence shards (done)

The portal starts **dormant**: each level scatters 2–4 pulsing cyan shards
(scaling with depth) in far-apart, verified-reachable pockets, and only
collecting them all wakes the portal. This is the anti-tunnel-rush design:
digging straight to the exit gains nothing — the route through biomes,
liquids, and creatures *is* the level. Dig Blast remains a traversal tool
and the reachability guarantee covers every shard. HUD shows ◆ collected;
standing at a dormant portal shows a hint.

## Win condition & meta-progression (done)

A run is won by clearing the portal on **depth 6** (`WIN_DEPTH` in game.js).
Persistent meta stats (best depth, wins, kills, runs — localStorage, with a
graceful session-only fallback) gate **locked synergies**: Twin Cast at
depth 2, Powder Bomb at depth 3, Demolitionist at depth 4, Acid Blood at 15
kills, Bouncing Shots at 25 kills, Lava Strider after a win. End-of-run
overlays show stats and freshly unlocked synergies; the sidebar shows
lifetime meta.

## Spell composition (done)

Noita-style wand modifiers stack for the run via synergy picks (`wandMods`
in spells.js): **Twin Cast** (+1 projectile), **Rapid Fire** (−45%
cooldown), **Amplifier** (+50% damage, bigger impact splash — affects dig
craters and bomb radius too), **Bouncing Shots** (terrain ricochets). They
compose multiplicatively — Twin + Rapid + Bounce turns Spark Bolt into a
ricocheting flamethrower.

## Biome creatures & the Spitter (done)

Spawns are biome-weighted (`BIOME_SPAWNS` in creatures.js): wisps swarm the
oil caverns and volcanic depths (yes, fire flyers over oil — on purpose),
spitters infest the overgrown vault, ice caves have no wisps (too wet).
The **Spitter** is the first ranged enemy: it lobs acid globs that burst
into real acid cells on impact — dodge and the terrain pays instead.

## Hotbar UI (done)

Spells show as Noita-style icon slots overlaid top-left on the canvas:
procedural 8×8 pixel-art icons (no image files), cooldown sweep on the
active slot, dimmed icons when mana is short, click or 1–5 to select.

## Roguelite roadmap

1. ~~**World gen**~~ — done (single-screen; chunked scrolling levels later).
2. ~~**Player entity**~~ — done.
3. ~~**Synergy system**~~ — done, with meta-unlock gating.
4. ~~**Wand & spells**~~ — done, with composition modifiers.
5. ~~**Determinism pass**~~ — done (input recording for replays still open).
6. ~~**Win condition + meta-progression**~~ — done.
7. ~~**Creatures**~~ — done, with biome spawn tables and a ranged type.

## Weather (done)

Ambient surface weather cycles between long clear spells and 15-30s events:
**rain** (water falls from the sky row — replenishes maps that lock water
into biomass), **cold snaps** (drag the whole map's temperature down: rain
turns to snow as the cold bites, pools freeze over, then it all thaws),
and **storms** (rain + real lightning: ELEC bolts that electrify pools and
torch trees). What falls is decided per column by the sky temperature — snow
over ice biomes even in plain rain. Exposed water surfaces also evaporate
(faster when warm), closing the map-scale water cycle. HUD shows the current
weather next to the biome.

## Temperature (done)

A coarse field (one cell per 4×4 sim cells, updated every 4th step) drives
climate: biome ambients set the baseline (Ice Caves −12°, Volcanic Depths
55°), elements emit into it (fire/lava heat, ice/snow chill gently), and it
diffuses + relaxes back. Phase changes read it:

- water **freezes** from exposed surfaces down below 0°
- snow keeps forever in the cold, melts in warmth; ice thaws above 20°
  (hysteresis vs freezing-at-0 is deliberate — sandbox ice keeps at 15°)
- **radiant heat**: lava melts ice without touching it
- lone lava drips **skin over into stone** in deep cold
- steam condenses instantly in freezing air; evaporation scales with warmth

The HUD shows the temperature under the cursor next to the biome name.

## Bosses (done)

Depths 3 and 6 are **guardian levels**: no shards — the portal opens when
the boss dies (HP bar top-center, +30 hp and full mana on the kill).
- **Magma Worm** (D3): tunnels through terrain straight at you, trails
  lava, immune to fire — but sizzles hard in water. Kite it through lakes.
- **Tempest** (D6): storm elemental that hurls arcing electric globs and
  electrifies water around itself. Don't fight it wet.

## Industry elements (done)

- **Metal**: conducts — sparks skitter along its surface and discharge into
  whatever's at the far end. Wire a lake. Corrodes in acid.
- **Glass**: lava fuses sand into it; acid-proof, blast-brittle.
- **Hydrogen**: electrolysis (sustained charge in water) bubbles it off; it
  rises, pools at ceilings, and flash-burns violently on any spark.
- **Snow** (weather) and **Hunter** (predator bug: eats grazers, solitary,
  starves to ash — the second trophic level; worldgen seeds a few).

### Open ideas
- Input recording for shareable deterministic replays; daily seed runs.
- Chunked scrolling worlds (bigger than one screen) with sim sleeping.
- Player heat/cold status effects (freezing water saps hp, heat haze).
- More biome set-pieces; fungus/fish/pollinator fauna; spell triggers.

## Performance notes

Grid is 320×200 (64k cells) rendered at 3× — comfortably 60fps. To scale up:
dirty-rect / chunk sleeping (skip settled regions), and moving the sim into a
Worker with a `SharedArrayBuffer` (requires a server; keep file:// fallback).

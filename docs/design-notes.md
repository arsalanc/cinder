# CINDER — Design Notes & Feature History

The running narrative of how CINDER was built, feature by feature, with the
design rationale and the bugs found along the way. For the tidy reference,
start at the [documentation index](index.md); for developer internals see
[Architecture](architecture.md). This page is the deep archive — the "why".

A 2D falling-sand / element simulation sandbox (Powder Toy / Noita style),
built as the foundation for a roguelite with element synergies and
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

Data-defined types in `js/creatures.js`, spawned per level (more with depth,
never near spawn). The generalists:
- **Grub** — ground patroller; chases and hops when it sees you.
- **Wisp** — fire-themed flyer; sheds embers as it moves (it will
  accidentally torch oil caverns), dies instantly in water.
- **Bloat** — slow drifting gunpowder sack; explodes on death. Shoot it
  from a distance. Never melee it. (Demolitionist scales its blast too.)
- **Spitter** — sluggish plant-thing that lobs arcing acid globs.

And a **signature enemy per biome**, each leaning on the element sim so the
place it lives in fights differently:
- **Shaleback** (Stone Caverns) — armored tank; shrugs off half of all
  weapon damage, so you route it into hazards instead of trading hits.
- **Pouncer** (Overgrown Vault) — springs off the ground and leaps at you
  from across the room.
- **Frostling** (Ice Caves) — chilling flyer whose touch *saps your warmth*,
  stacking with the biome's cold to tip you toward hypothermia.
- **Seeper** (Oil Caverns) — fireproof crawler that lays flammable oil
  slicks behind it; one stray spark turns its trail into a firebreak.
- **Magmite** (Volcanic Depths) — fireproof lava-walker that drips molten
  rock as it moves, salting the ground with hazards.
- **Voltbug** (Rusted Works) — charged mite that electrifies nearby
  puddles — lethal amid the generators' coolant basins.

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

Each biome leads with its signature (heaviest weight) backed by generalists.
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

## Roadmap — 2026-07 re-evaluation

The modifier table predated most of the systems now in the game
(temperature/warmth, electricity, molten, ecosystems, weather, stomping,
boss windows). Re-grounding the power-up pool and the run loop in them:

**Batch 1 (in progress):**
- ~~Frost Aura rework~~ — freeze only the *surface* of water into walkable
  crust; the pool below stays liquid. Fixes the collision with quench-based
  boss fights (the old aura could freeze your own reservoir).
- ~~Iron Boots~~ — the boss stomp becomes a run verb: stomp any enemy,
  piercing armor. Teaches the boss mechanic mid-run.
- ~~Winter Pelt / Furnace Heart~~ — the missing climate picks: immune to
  one temperature extreme, more vulnerable to the other.
- ~~Ember Heart~~ — radiate real heat into the temperature field: never
  cold, melt ice/snow as you walk — but nearby water simmers away.
- ~~Tag-weighted rolls~~ — mods carry tags (fire/frost/storm/wand/...);
  `rollChoices` weights toward tags already taken so builds snowball.

**Batch 2 (done):**
- ~~**Elites**~~ — depth 4+ levels spawn one oversized biome-signature enemy:
  0.6 armor floor, 3× hp, 1.5× contact, and a periodic EXPOSED window (2×,
  smoke-puff telegraph, pulsing gold) — the boss grammar, miniaturized.
  Unlike a boss it keeps fighting through its window. Kill: +15 hp, +30 mana.
- ~~**Relic vaults**~~ — one optional glass vault per non-boss depth, buried
  in solid rock and flooded with the biome's hazard (water / lava / oil /
  acid / solid ice). Deliberately off the critical path — Dig Blast is the
  key. Touching the relic grants an extra synergy pick on the spot (`✦` on
  the HUD). Cramped maps may simply lack one; it's optional.
- ~~**Endless descent**~~ — the win is banked the moment the depth-6 portal
  opens; the choice overlay doubles as the victory screen with an **End
  Run** exit ramp. Descend instead and the run goes endless: `D8/∞`, denser
  hordes (cap 20), guardians recurring every 3rd depth (9 worm, 12 tempest,
  alternating) with +6% hp per endless depth (`maxHp` per instance; phase
  ratios and the boss bar read it).
- ~~**Storm Caller / Insulated / Executioner**~~ — weather pinned to storm
  with an 18-column lightning ward (covers the bolt's radius-3 ground
  splash); ELEC/EWATER damage ×0.15 (wading, not submersion); vulnerability
  windows ×1.5 via the shared `exposeFor()` helper.

**UI/feedback batch (done):**
- **Hurt flash** — taking contact damage strobes the player sprite red
  (same visual language as the burning flash; keyed off the fresh end of
  the `hurtCd` invulnerability window).
- **Synergy sprites** — every modifier has an 8×8 pixel icon in the same
  hand-authored `ICON_PX` language as the spell hotbar (shared palette,
  `MOD_ICONS` in spells.js; spell-granting mods reuse their spell's glyph
  so card and hotbar slot read as the same thing). Choice cards at the end
  of each level now lead with the sprite.
- **Collection** — a button (and `#collection` dev hook) opens the unlock
  grid: every synergy as a sprite tile, earned ones in color with tooltip,
  locked ones blacked out showing only their unlock condition. A test
  guards that every modifier has a valid icon and no icons are orphaned.

**Trophies (done):**
- New meta stats `wormKills` / `tempestKills` / `eliteKills` (counted in
  `killCreature`, replay-guarded like everything else).
- **Wormheart** (first worm kill) — burning no longer harms you; it warms
  you toward cozy (capped at 80 warmth, so the trophy can never heatstroke
  you). Inversion, not mitigation — distinct from Fireproof Hide, feeds the
  fire build.
- **Stormcore** (first tempest kill) — Arc Bolt impacts call down a real
  `lightningStrikeAt` bolt: you take the boss's weapon.
- **Executioner re-gated** from 30 generic kills to **5 elite kills** — the
  elite hunt earns the window-stretcher.
- Collection gains a **TROPHIES row** above the synergies: guardian sprite
  tiles (gold-bordered once earned, kill count beneath, blacked out with
  the hunt condition until then). Both trophy mods are deliberately
  build-around sidegrades so re-killing bosses never becomes mandatory.

**Batch 3 (candidate ideas):**
- Daily-run scoreboard for endless depth reached; ghost replays.
- Elite affixes (a frost elite in the Oil Caverns, etc.) for cross-biome
  surprise; relic vault "curses" — some vaults are trapped (gunpowder core).
- Spell evolutions: a taken spell + matching tag mod upgrades the spell
  itself (Water Jet → Pressure Lance, Spark Bolt → Chain Arc).

**Known-good accidents to preserve:** Steam Sprite heals off boss-quench
steam; Demolitionist is deliberately useless against shelled bosses (the
windows are the fight).

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
  lava, immune to fire. Its molten shell deflects *all* direct damage —
  quench it (see the cycle below) to crack it open.
- **Tempest** (D6): storm elemental that hurls arcing electric globs and
  electrifies water around itself. Don't fight it wet.

## Boss arenas & phases (done)

Boss depths are now a **purpose-built chamber** (`generateBossChamber` in
worldgen.js) instead of a random cave — bounded by indestructible WALL so the
boss can't tunnel out, with diggable rock, cover pillars, and a guaranteed
water reservoir. Seed-varied but always containing the fight's ingredients.
Player spawns on the left shelf, portal + boss on the right, reservoir
between. `beginLevel` places all three explicitly and drops trash mobs for a
focused duel.

Both bosses now run a **cycle → forced interaction → punish window** loop
(Mario-boss structure), each rooted in the element sim. Shared beats: an
EXPOSED boss takes 2× damage, deals no contact damage, and can be
**stomped** — land on it for a 44-point crunch and a bounce clear. Phase
breaks (0.66/0.33 HP, pips on the bar) are invulnerable set-pieces, not DPS
races. The boss bar shows a one-line state hint so the rules teach
themselves.

**Magma Worm — the quench cycle** (armor 1: direct damage does *nothing*
while it's shelled; water deals no damage either — it's the key, not a DPS
tool):
- Burrowing chase with lava trail; later phases are faster, lay more lava,
  and radiate heat into the temperature field (heatstroke clock; the hot
  reservoir stays a warmth refuge).
- On a cadence it telegraphs (smoke jets crack the ground) then **BREACHES**
  in a ballistic leap at where you stand. Splashdown in water → **thermal
  shock quench**: steam burst, shell cracks, EXPOSED. Dry landing → crater +
  lava-splash slam, and the cycle repeats. Bait the arc over the reservoir.
- Soaking it heavily while it tunnels (wet ≥ 8) also quenches it — Water
  Jet forces the window but never melts it.
- **Reheat rule**: quenching needs a *hot* shell. After a window the shell
  is already cooled (`reheatT` ≈ 4.5s), so sitting in the pool can't
  chain-quench it — and while hot it *fears* the water, diving under pools
  in its path instead of swimming through them. Baiting the breach is the
  reliable quench.
- **Phase break: MAGMA SURGE** — it dives deep (invulnerable) and erupts
  telegraphed geysers (smoke vents, then lava fountains) while the reservoir
  partially boils away: quench ammo gets scarcer every phase.

**Tempest — the capacitor cycle** (armor 0.7 while charged):
- Real steering: no line of sight → it **climbs over cover** (no more
  sulking behind pillars) and only throws arc globs down a clear lane. Its
  charge bleeds into water well below its hover height — floor puddles go
  live under the fight.
- **CHARGE** (locks in place, strobing, crackling — get behind a pillar) →
  **NOVA** (2+phase lightning bolts bracket the player; the arena's
  metal-capped pillars are lightning rods that intercept) → **SPENT**: it
  falls out of the air, dim, aura off, harmless — 2× damage + stompable.
- Dousing it with fresh water **short-circuits** it into the window early,
  but the splash arcs back live (EWATER) around it.
- Fire-immune (a being of wind and rain), and boss armor applies to
  *environmental* damage too — no chipping a guardian to death with a
  flamethrower; the windows are the fight.
- If a climb is roofed out (or drags on), it **swoops down** at you instead
  of pinning itself against the ceiling.
- **Phase break: STORM SQUALL** — it rides to the ceiling (invulnerable)
  and rains real water plus stray bolts: more electrified floor *and* more
  quench ammo. Its arena variant: higher ceiling, taller metal-capped
  pillars, smaller starting pool (the squalls add more), temperate ambient.

The whole design is mechanics the player already knows — quenching
(molten+water), conduction, electrified water — no hidden boss rules.

## Molten metal — the casting loop (done)

Metal now completes its phase story (29 elements). **Molten** is a white-hot,
denser-than-lava liquid with a full fabrication loop:

- **Smelt**: sustained direct lava contact slowly melts metal (a deliberate
  crawl — a furnace takes real time, and a stray drip only pits a wall).
  Molten also melts adjacent metal at the same rate.
- **Pour**: it flows like a heavy liquid, emits furnace heat, ignites fuel,
  and burns like lava (fireproof creatures shrug it off).
- **Cast**: away from heat it solidifies back into *real conductive METAL*
  (threshold 45°, higher than lava→stone — pours set quickly and can't creep).
  **Quench** with water for an instant set (molten + water → metal + steam,
  mirroring lava + water → stone). You can literally pour a wire or a wall.
- Big pours self-heat and stay workable; thin castings set. Deep pools
  **crust over** when flooded — the shell insulates a still-molten interior,
  exactly like a real foundry.

**The run-mode hook**: an always-running generator eventually melts its own
housing (its lava heart eats the shell) — Rusted Works machinery decays into
hazards over time. Tuning that fell out: liquid metal counts as metal for
heat conduction (a half-melted rod still carries furnace heat through its own
melt pool), a 1-cell rod dipped in lava now erodes through — build thicker
electrodes — and thermoelectric output was raised so a live generator
visibly zaps its coolant basin every few seconds.

## Industry elements (done)

- **Metal**: conducts — sparks skitter along its surface and discharge into
  whatever's at the far end. Wire a lake. Corrodes in acid.
- **Glass**: lava fuses sand into it; acid-proof, blast-brittle.
- **Hydrogen**: electrolysis (sustained charge in water) bubbles it off; it
  rises, pools at ceilings, and flash-burns violently on any spark.
- **Snow** (weather) and **Hunter** (predator bug: eats grazers, solitary,
  starves to ash — the second trophic level; worldgen seeds a few).

## Cave life (done)

Three more species round out the underground ecosystem, each a distinct niche:

- **Fungus** (decomposer): glowing mushroom groves on dark cavern floors; it
  creeps slowly across dead wood, and grazer bugs browse it — dead matter
  re-enters the food web. Burns fast, dissolves in acid.
- **Fish** (aquatic grazer): schools in the bigger generated pools, grazing
  kelp beds that now grow from pool floors. Kelp counts as habitat (fish swim
  through it; eating a kelp cell returns the water it grew from). Beached
  fish suffocate to ash; electrified water shocks schools dead — though a
  dense kelp thicket can insulate a pocket of the pool.
- **Moth** (pollinator): flutters over meadows, sips nectar *without*
  consuming plants, lingers on flowers, and scatters seeds into the air —
  meadows with moths spread. Drowns, burns readily, starves away from food.

Worldgen stamps the set-pieces: mushroom groves (stalk + cap) in Stone/Oil
Caverns, kelp beds and fish in pools with real volume, moths above vegetation.

## Industry (done)

Metal and electricity are now native to the world, not just player tools:

- **Heat conduction**: metal carries heat along itself (strong metal-to-metal
  exchange in the temperature field, low loss to air). A rod dipped in lava
  gets hot at the far end.
- **Thermoelectric**: metal above 60° sheds ELEC sparks; cold metal is inert.
  Together: dip a rod in lava, run it to a pool, and you've built a geothermal
  generator — the pool electrifies at a distance. Verified end-to-end in tests.
- **Corrosion**: acid eating metal liberates hydrogen instead of nothing —
  acid pools near metal structures are slow-motion bombs.
- **Rusted Works biome** (deep, hazardous): rusted metal terrain (conductive —
  sparks and lightning race through the walls) streaked with rust-orange sand
  veins, warm from old furnaces (28°). It's the home of the machinery, so the
  set-pieces finally have a context that explains them:
  - **Generator**: a molten-cored metal furnace wired by a conduit rail to an
    open coolant basin. The furnace heat conducts down the rail and sheds
    sparks into the basin — the pool it "cools" stays lethally electrified.
    A live, humming environmental weapon, verified end-to-end in tests.
  - **Oil vat**: a glass tub of oil (acid-proof shell, flammable contents).
  - **Munitions crate**: a wooden shell packed with gunpowder.
  Machines only spawn in Rusted Works now (they used to litter Stone/Oil
  caverns with no context). Portal/shard reachability is re-checked after.

## Seasons — temperature × biology (done)

Life now feels the temperature field, which turns cold snaps into seasons:

- **Frost kills exposed plants** below −5°, scattering part of their seed
  bank (15% seeds, rest ash). Plants touching liquid water are spared — kelp
  lives on under the ice until its pool truly freezes solid.
- **Growth is temp-gated** (reactions carry an optional `minTemp`): no
  photosynthesis, germination, or ash-fertilizing below 5°. The seed bank
  literally waits out winter; thaw + meltwater = spring bloom.
- **Cold torpor**: fauna go dormant below 0° — no feeding or breeding, but
  metabolic shutdown means dormant turns don't age them, so they revive at
  the thaw. Deep cold (−15°, fish −30°) kills; heat above 70° cooks.
- **Fish overwinter**: torpid fish sink to the pool bottom — the last place
  the freeze front reaches — and surface ice insulates (water under a frozen
  lid freezes 10× slower), so iced-over ponds stay habitable a long time.
- **Electricity closure**: sparks detonate gunpowder (electric tripwires!)
  and flash hydrogen pockets — an over-electrolyzed pool can now ignite its
  own product. Burning hydrogen recombines into steam (2H₂+O₂→2H₂O), so
  electrolysis + combustion is a closed water loop.

Two physics fixes came out of this: ice no longer self-refrigerates (cold
sources buffer toward 0° but never chill below it — a frozen slab used to
drag −12° ambient down to −37° in a runaway), and surface ice insulates the
water below it.

## Replays & daily runs (done)

The whole sim runs off one seeded PRNG, so a run is fully determined by its
seed plus the player's inputs. `js/replay.js` records a packed input word
per sim step (RLE-compressed — a 15-second stretch is a few hundred ints)
plus sparse events (synergy picks by name, respawns), and plays it back by
overwriting the input state each step. Verified in tests: a 900-frame
scripted run replays with byte-identical world checksums.

- **▶ Replay** (Create panel): re-watch your last finished run. Replays
  auto-pick the recorded synergies and never touch meta-progression.
- **Daily Run**: everyone gets the same seed on the same (UTC) date —
  compare runs on equal footing.
- Found bug while building it: out-of-bounds cursor coords desynced replays;
  `canvasToCell` now clamps at the source.

## More interactions (done)

- **Smoke suffocates**: bugs and moths trapped under a smoke layer cough
  (can't feed mid-choke) and die fast; the player takes a mild sting. Every
  fire is now flame below + choking layer above.
- **Wet gunpowder** crumbles to inert ash — flood the crate before a fight.
- **Fulgurites**: lightning striking sand fuses a branching glass channel.
- **Moth to flame**: moths see fire along short sight-lines and fly into it.
- **Moths sip fungus** (survive in plantless caverns) and carry spores —
  fungus spreads by pollinator like meadows do.
- **Granivory**: bugs eat seeds, braking runaway meadow spread.

## Cold as a felt thing (done)

Temperature stops being scenery and becomes something the player and the
terrain physically live in:

- **Body warmth** (0-100): a remap of the local temperature — a temperate
  cave sits at a cozy ~55, cold biomes pull you toward hypothermia (hp bleeds
  below 20 warmth), and only a near-furnace heat pushes toward heatstroke
  (lava/fire already do direct damage, so cold is the sensitive side). Being
  wet doubles the chill; standing in fire banks warmth back up. Spawn grants
  a grace buffer so you never appear already dying in an ice cave, and spawn
  selection prefers ground whose ambient keeps you in the comfortable band
  (falling back to the coziest spot found, never a random freezing one). The
  HUD shows `cold` → `FREEZING`, and the player sprite shivers blue.
- **Slippery ice**: standing on ice is low-traction — momentum carries and
  stops become skids, so ice caves finally play differently underfoot
  instead of being a stone cave with a palette swap.
- **Glacier compaction**: a deep enough snow column crystallizes its bottom
  layer into ice, so snowpack becomes glacier on its own (closing the
  snow → ice → melt → water loop). A shallow dusting stays powder.

### Future directions

- Boiler / steam pressure: sealed metal over heat bursts when trapped steam
  has nowhere to go (needs a small per-pocket pressure count).
- Predators hunting torpid prey during cold snaps.
- Blast-resistant metal terrain (so Rusted Works forces acid/routing, not
  just dig-through); more machine types (crushers, conveyors, alarms).
- Spell triggers (Noita-style): spells that cast other spells on impact.
- More set-pieces: shrines, collapsed shafts, buried caches worth a detour.
- Replay sharing (export/import strings); replay scrubbing/speed controls.
- Chunked scrolling worlds (bigger than one screen) with sim sleeping.

Worth trying in sandbox today: oil already floats on water (density 20 vs
30), so burning slicks on pools work emergently.

## Performance notes

Grid is 320×200 (64k cells) rendered at 3× — comfortably 60fps. To scale up:
dirty-rect / chunk sleeping (skip settled regions), and moving the sim into a
Worker with a `SharedArrayBuffer` (requires a server; keep file:// fallback).

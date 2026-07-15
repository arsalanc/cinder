# CINDER Documentation

A 2D falling-sand element simulation that grew into a roguelite: a living
world of ~28 elements, stable ecosystems, weather, temperature, and a
procedurally generated descent with synergies, bosses, and replays.

**Play:** open `index.html` in a browser (no build step, works from
`file://`).

## Pages

| Page | What's in it |
| --- | --- |
| [Player Guide](player-guide.md) | Controls, how a run works, surviving the world, strategy. |
| [Elements & Reactions](elements.md) | Every element's properties and the full reaction table. *(generated)* |
| [Bestiary](bestiary.md) | Every creature — stats, biome, and behavior. *(generated)* |
| [Biomes](biomes.md) | Terrain, temperature, hazards, and signature enemies. *(generated)* |
| [Wand & Synergies](spells.md) | Spells and run modifiers. *(generated)* |
| [Architecture](architecture.md) | For developers: file layout, sim internals, determinism, testing. |
| [Design Notes & History](design-notes.md) | The deep "why" — feature-by-feature build log and rationale. |

## Generated reference

The four *(generated)* pages above are produced directly from the source
data tables (`js/elements.js`, `js/creatures.js`, `js/worldgen.js`,
`js/spells.js`, `js/synergies.js`) — so they can't drift out of date. After
changing any of those tables, regenerate them:

```
node tools/gen-docs.js
```

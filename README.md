# CINDER

A 2D falling-sand element simulation (Powder Toy / Noita style) that grew into
a roguelite. A living world of ~28 elements — with stable ecosystems, weather,
a temperature field, and industrial machinery — wrapped in a procedurally
generated descent with element synergies, biome-specific enemies, bosses, and
deterministic replays. Vanilla JS, no build step, runs from `file://`.

## Play

Open `index.html` in a browser. **Create** tab is the sandbox; **Play** (or
Enter) starts a run — descend to the portal on each level, pick a synergy,
reach depth 6 to win.

## Documentation

Full docs live in [`docs/`](docs/index.md):

- **[Player Guide](docs/player-guide.md)** — controls, runs, surviving the world.
- **[Elements & Reactions](docs/elements.md)** — every element and interaction. *(generated)*
- **[Bestiary](docs/bestiary.md)** — every creature and how it fights. *(generated)*
- **[Biomes](docs/biomes.md)** — terrain, temperature, hazards. *(generated)*
- **[Wand & Synergies](docs/spells.md)** — spells and run modifiers. *(generated)*
- **[Architecture](docs/architecture.md)** — for developers: internals, determinism, testing.
- **[Design Notes & History](docs/design-notes.md)** — the feature-by-feature build log.

## Developing

No dependencies. Edit the `js/` files and reload. The game is data-driven —
elements, reactions, biomes, creatures, spells, and synergies are plain tables
in `js/`. After changing any of them, regenerate the reference pages:

```
node tools/gen-docs.js
```

Headless smoke tests (Node `vm`, no browser) cover the sim, worldgen, player,
runs, determinism, creatures, temperature, replays, and more — run them after
any change to `sim.js`, `worldgen.js`, `player.js`, or `creatures.js`. See
[Architecture](docs/architecture.md) for the internals.

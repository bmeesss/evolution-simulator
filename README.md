# Evolution Simulator

A browser-based evolution simulator: a **deterministic** agent simulation running
on a fixed timestep inside a **Web Worker**, rendered with **Canvas 2D** — no
game engine, no backend, no simulation framework.

This repository currently contains **Phase 1: the deterministic foundation**.
The world, agents, needs, movement and the whole simulation loop are proven
reproducible from a seed; the evolution gameplay (reproduction, mutation,
natural selection, Utility AI, societies, …) is deliberately **not** built yet
and will be layered on top of this foundation (see the phase plan in
[ARCHITECTURE.md](ARCHITECTURE.md)).

## What you see

- A 64×64 tile world generated from a seed (terrain, food, water, temperature)
- 50 agents wandering, resting, getting hungry/thirsty/tired and unhealthy
- Statistics (population, average genome traits), a selected-agent inspector
  and an event feed
- A development overlay with tick rate, worker status, render FPS and
  simulation timing

**Agent visuals are genome-driven and deterministic:**

| Visual property | Genome trait | Meaning |
| --- | --- | --- |
| Circle size | `strength` | bigger circle = stronger agent |
| Circle hue | `intelligence` | blue = low, yellow = high |

Food is shown as a green tint on land tiles (denser green = more food).

## Run it locally

Requires Node.js 20.19+ (or 22.12+).

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

### Controls

| Control | Effect |
| --- | --- |
| **Start / Pause** | Runs / pauses the simulation (in the worker) |
| **Speed** | 1x (normal), 5x, 20x (accelerated — multiple ticks per frame) |
| **Seed + New World** | Re-initializes a deterministic world from a seed |
| **Random** | Picks a random seed and starts a new world |
| **Click an agent** | Inspect it (id, age, needs, health, full genome) |

The overlay in the top-left of the canvas shows worker status, current tick,
ticks/second, per-tick simulation time, ticks per update slice, agent count and
render FPS.

## Build

```bash
npm run build      # type-checks, then bundles to dist/
npm run preview    # serves the production build
```

## Tests

```bash
npm test           # full unit + integration test suite (Vitest, no browser needed)
npm run test:watch # watch mode
npm run typecheck  # strict TypeScript check only
```

The suite includes:

- **Determinism tests** — same seed + same tick count must produce identical
  state (world, agents, positions, needs, genome, RNG state), and
  save → load → continue must match an uninterrupted run
- RNG sequence/state tests, ECS store tests, world generation tests
- Worker engine tests (fixed timestep, pause/speed, message protocol) against
  the real worker entry module
- **Source hygiene tests** — fail if `Math.random` appears anywhere in `src/`,
  if simulation-core/persistence reference DOM APIs, or if main-thread code
  imports simulation logic at runtime (only `import type` and two pure leaf
  modules are allowed)
- A regression test for the stale agent-details guard (switching agents can
  never show the previous agent's data)

### Browser smoke test (optional, needs a local browser)

```bash
npx playwright install chromium   # one-time browser download
npm run test:e2e                  # boots the app in Chromium and verifies:
                                  # worker runs, canvas paints, determinism holds
```

## Determinism in one paragraph

Every random decision comes from a seeded sfc32 PRNG with independent streams
(tick dynamics, spawning) derived from the root seed; the world generator is a
pure hash function of `(seed, x, y)`. One simulation tick advances exactly
`hoursPerTick` in-game hours (configurable, default 0.25 = 96 ticks per
in-game day), independent of the render frame rate. The same seed run for the
same number of ticks always produces the same state — verified by tests and by
an in-worker self-check (`window.__evosim.verifyDeterminism()` in dev mode).

## Project layout

```
src/
  simulation-core/   # deterministic simulation: RNG, ECS, world, genetics, AI, events
  persistence/       # save-state serialization, snapshots, determinism checks
  workers/           # worker protocol, engine loop, worker entry & main-thread client
  rendering/         # Canvas 2D renderer (consumes snapshots only)
  ui/                # vanilla TS panels (stats, agent inspector, controls, overlay)
  main/              # app wiring & entry point
tests/               # Vitest suites (unit, integration, determinism, hygiene)
scripts/             # browser smoke test
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full architecture, message flow
and the developer guide for adding components, systems, AI actions, events and
UI panels.

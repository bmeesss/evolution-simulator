# Architecture

This document explains how the Evolution Simulator foundation is built, why it
is built this way, and where future systems belong. It is aimed at developers
(and AI agents) extending the project in later phases.

---

## 1. Layer overview

```
┌─────────────────────────────── main thread ───────────────────────────────┐
│  main/          app wiring, entry point, dev handle                       │
│  rendering/     Canvas 2D renderer (terrain layer + agents)               │
│  ui/            controls, stats, agent panel, event feed, debug overlay   │
│  workers/       SimulationWorkerClient (postMessage only)                 │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ WorkerMessage  (snapshots, replies — structured clones)
                │ SimulationCommand (init, set-running, set-speed, queries)
┌───────────────▼──────────────────────────────────────────────────────────┐
│                                  worker                                   │
│  workers/       simulation-worker.ts (entry) → WorkerEngine (loop)        │
│  persistence/   snapshots, save-state serialization, determinism check    │
│  simulation-core/                                                          │
│    rng/         seeded sfc32 PRNG + stream derivation                     │
│    ecs/         entity registry + SoA component stores (+ memory store)   │
│    world/       grid world + deterministic generation (hash noise)        │
│    genetics/    genome definition (normalized traits)                     │
│    ai/          Utility AI: intents, actions, utility curves,             │
│                 considerations, memory, perception                        │
│    events/      tick-stamped event log                                    │
│    simulation/  Simulation (fixed timestep), systems, config, time        │
└──────────────────────────────────────────────────────────────────────────┘
```

### Simulation/rendering separation (hard rule)

`src/simulation-core/` and `src/persistence/` have **zero** dependencies on
DOM, canvas, `window`, `document` or any rendering/UI API. They run unchanged
in a Web Worker, in Node (all unit tests) or any JS host. Rendering and UI are
**consumers of extracted snapshots** — they never hold simulation objects.

This is enforced three ways:

1. `tests/source-hygiene.test.ts` scans the sources for `Math.random` and for
   DOM references in simulation code.
2. `src/workers/protocol.ts` (imported by both threads) uses **type-only
   imports** so no simulation code leaks into the main bundle.
3. The production build is checked: `dist/assets/index-*.js` (main thread)
   contains no simulation symbols; everything simulation lives in the separate
   `simulation-worker-*.js` chunk.

Main-thread code may only import from simulation-core:
- **types** (`import type { ... }`), and
- **pure leaf helpers** with no simulation logic (e.g.
  `simulation-core/simulation/time.ts` formatting, `world/terrain.ts` constants,
  `rendering/agent-visuals.ts`).

## 2. Web Worker architecture

**Worker owns:** simulation ticks, world state, entities, RNG, events, future
AI systems. **Main thread owns:** canvas rendering, UI, user controls.

`workers/simulation-worker.ts` is a thin adapter (the only file touching
worker APIs): it binds `self.onmessage`, bridges `postMessage` and pumps
`engine.update()` on a 25 ms interval. All logic lives in `WorkerEngine`
(`workers/worker-engine.ts`), which is clock-injected (`now()`, `emit()`) and
therefore fully unit-testable in Node — `tests/worker-engine.test.ts` and
`tests/worker-entry.test.ts` (the latter drives the *real* entry module with
stubbed worker globals) cover the whole protocol.

State crosses the boundary only as **structured-clone messages** — mutable
simulation state is never shared with the UI.

## 3. Fixed timestep

- One simulation tick = `config.time.hoursPerTick` in-game hours (default
  0.25 → 96 ticks per in-game day). Not hardcoded; systems read `dtHours` from
  the tick context, tests run with other values.
- The worker accumulates elapsed real time × speed multiplier; each full
  `1000 / baseTicksPerSecond` runs exactly one `Simulation.step()`. Render
  frame rate has **no** influence on simulation logic.
- Speeds: 1x/5x/20x (UI) — at high speed many ticks run per worker update
  slice and per snapshot (`debug.lastSliceTickCount` shows how many).
- Backlog safety: elapsed time is clamped per slice (background-tab
  throttling) and the accumulator is capped at `maxTicksPerUpdateSlice` ticks
  so a slow host drops backlog instead of spiraling.
- Pause zeroes the accumulator — resuming never jumps time forward.

Determinism note: tick *count* is the only clock that matters for state.
Two machines may reach tick N at different wall-clock times; the state at
tick N is identical.

## 4. Deterministic RNG

`simulation-core/rng/rng.ts` implements **sfc32** with a serializable 4×uint32
state (`getState()`/`setState()`, plus `Rng.fromSeed`/`fromState`). API:
`next()`, `nextFloat()`, `nextInt()` (rejection-sampled, no modulo bias),
`rangeFloat()`, `rangeInt()`, `chance()`, `pick()`.

Streams: the Simulation derives independent child streams from the root seed
by label — `sim` (tick dynamics), `spawn` (entity creation) and `ai` (AI
decisions: tie-break noise, wander-target draws) — via
`deriveStreamSeed(seed, label)`. Changing how one stream consumes randomness
can never affect another stream's numbers. All stream states are part of the
save state.

The Utility AI consumes the `ai` stream in a fixed order per agent (six
tie-break jitter draws in `ActionKind` order, then wander-target draws only
when Wander wins), so AI RNG consumption never depends on which action won —
re-running the same state always consumes the same numbers.

World generation consumes **no stream at all**: its value noise hashes
`(seed, x, y)` directly (`rng/hash.ts` → `world/noise.ts`), so the world is a
pure function of the seed.

Cross-engine determinism relies only on IEEE-754 exact operations. The
movement system uses `sqrt(dx²+dy²)` instead of `Math.hypot` (whose extra
precision is implementation-defined). `Math.random` is banned everywhere in
`src/` (enforced by test); the only non-seeded randomness in the app is the
UI's "Random seed" button, which uses the platform CSPRNG — seed *choice* is
outside the simulation.

## 5. ECS structure

Practical ECS: `EntityRegistry` + one `ComponentStore` per component
(`ecs/component-store.ts`, `ecs/simulation-ecs.ts`).

- **Entity IDs**: monotonic uint32 integers, allocated in creation order,
  never reused (a destroyed agent's ID stays dead). `aliveIds` is a dense
  array in allocation order → **stable iteration order**.
- **ComponentStore (SoA)**: one typed array per field ("column"), dense slots
  `[0, count)` with `entityOf` (slot → entity) and `index` (entity → slot).
  Hot loops iterate columns directly — no objects, no lookups, no allocation.
  Capacity grows by amortized doubling.
- **Components**: `position` (x, y — tile units), `needs` (hunger, thirst,
  energy — 0..100), `age` (ageHours), `health` (0..100), `genome`
  (intelligence, strength, speed, fertility, socialTendency — normalized
  0..1), `intent` (kind + movement target — the AI seam), and `aiState`
  (the six Utility AI base scores, persisted for the debug view and the
  determinism tests without recomputing the AI).
- **Memory** is a dedicated variable-length store (`ai/memory/memory-store.ts`,
  exposed as `ecs.memory`): per-agent bounded capacity, a flat typed-array
  arena with a free-list, and eviction of the least-valued entry. It lives
  beside the ComponentStores on `SimulationEcs` and participates in
  serialization.
- **Planned components** (Social, Inventory) are documented in
  `ecs/components.ts` with the recommended storage approach. Fixed numeric
  columns drop straight into `ComponentStore`.

Systems (`simulation/systems/`) are plain functions
`(ctx: TickContext) => void`. The context (ecs, world, config, events, rng
streams, resource index, dtHours) is constructed **once** per simulation —
systems cause zero per-tick allocation. System order inside `Simulation.step()`
is part of the determinism contract:

```
selectIntents → moveAgents → interactWithResources → updateNeeds
  → updateDeaths → updateMemory → regenerateResources → updateAging → tick++
```

`ai/` owns *decisions*; systems own *consequences*. The Utility AI
(`ai/utility-ai.ts`) scores six candidate actions with bounded [0, 1]
utilities, applies deterministic tie-break noise + action hysteresis, and
writes the winning intent into the same `intent` store every other system
already reads.

## 6. World

`world/world.ts`: fixed grid, six parallel typed arrays indexed by
`y * width + x` — `terrain` (Uint8), `food` (Float32 0..1), `water`
(Float32 0..1), `temperature` (Float32 °C), plus `foodCap`/`waterCap`
(Float32, the per-tile regeneration targets). Generation
(`world/world-generator.ts`) is pure hash-noise fbm: elevation → terrain
bands (water/sand/grass/forest/mountain), moisture → water availability and
food per terrain type, latitude+altitude+noise → temperature. All tuning
constants are named at the top of the generator.

In Phase 2, `food`/`water` mutate: the resource system reduces them as agents
eat/drink (never below zero), and the regeneration system grows them back
toward their caps (linear `cap * regenRate * dtHours`, clamped at the cap —
no seasons or climate yet).

## 7. Message flow & snapshot design

Commands (main → worker), see `workers/protocol.ts`:
`init {seed}` · `set-running {bool}` · `set-speed {multiplier}` ·
`request-snapshot` · `get-agent {entityId, requestId?}` ·
`request-save {requestId?}` · `verify-determinism {ticks?, requestId?}`.

Messages (worker → main): `ready {seed, running, multiplier, world}` ·
`snapshot {snapshot, events[], debug}` · `agent-details` · `save` ·
`determinism-result` · `error`. Queries with a `requestId` get it echoed —
used by the dev handle and the browser smoke test.

Snapshots (`persistence/snapshots.ts`) are **compact and versioned**
(`SNAPSHOT_FORMAT_VERSION = 2`): per frame only tick/time/population/deaths/
averages/resources plus SoA typed arrays (ids, x, y, strength, intelligence,
intent kind) — a `formatVersion` field allows the format to evolve (delta
snapshots, binary payloads) without ambiguity. Full per-agent data is fetched
on demand via `get-agent` (which also returns the live AI utility table,
movement target and memory lists for the inspector), so per-frame cost stays
O(population) with small constants at 10 snapshots/second even for thousands
of agents. The worker rate-limits snapshots to `snapshotIntervalMs` (100 ms)
and always sends one on init/pause/resume/re-init.

## 8. Events

`simulation-core/events/events.ts`: bounded log; every event carries
`tick` + `timeHours` (+ optional `entityId`, `detail`). The worker drains
pending events into each snapshot (capped at 100 per snapshot; the remainder
follows). Types: `simulation_started`, `simulation_reinitialized`,
`simulation_paused`, `simulation_resumed`, `speed_changed`, `agent_spawned`,
`agent_ate`, `agent_drank`, `agent_died`, `agent_learned`,
`resource_depleted`. Event history is not persisted yet (deliberate — later
phase).

## 9. Persistence

`persistence/serialization.ts` defines the versioned save format
(`SAVE_FORMAT_VERSION = 2`) capturing everything needed to resume bit-for-bit:
seed, tick, config, RNG stream states (all three streams), world arrays
(including the food/water caps) and all component stores plus the memory
store. The version was bumped for Phase 2 because the schema gained the
`aiState` component store, the memory store and the third RNG stream. Round-
trip and continuation equality are enforced by tests and by
`runDeterminismCheck()` (`persistence/determinism-check.ts`), which the worker
exposes as the `verify-determinism` command and the dev handle as
`window.__evosim.verifyDeterminism()` (dev builds only — production code has
no global escape hatch).

The default configuration (`simulation/config.ts`) is module-level shared
state, so it is deep-frozen: accidental mutation of the default fails loudly,
and per-run tuning goes through `cloneConfig()` (which returns a normal
mutable copy).

## 10. Performance guidelines

Designed for hundreds to thousands of agents:

- SoA typed arrays + dense iteration in every hot loop; zero allocation per
  tick (the tick context and all stores are pre-allocated; growth is amortized
  doubling). The memory store keeps a flat arena with a free-list so
  learn/forget churn never grows it unbounded.
- **No O(n²) loops** — the AI builds a `ResourceIndex` (world-grid spatial
  lookup) **once per tick** in O(worldSize) and each agent then walks only the
  ~3×3 cells around its own cell (O(agents × localTiles)); it never scans
  every tile per agent. All index buffers are allocated once and reused each
  tick. The hot candidate loop uses squared distances (`distanceFactorSquared`)
  to avoid a per-candidate sqrt.
- Agents are never DOM elements; rendering is batched canvas circles over a
  pre-baked terrain layer (the world rasterizes once, not per frame).
- Worker-side per-tick time is measured (EMA) and surfaced in the debug
  overlay so regressions are visible early.

## 11. Phase 2 scope (what is deliberately NOT here yet)

Evolution itself is still absent: reproduction, pregnancy, children,
inheritance, mutation, natural selection, genealogy. Also deliberately out of
scope (now and likely forever for this project): neural networks, LLM
integration, NEAT; and the social/civilization ladder (tribes, culture,
language, technology, agriculture, economy, trade, warfare, cities,
civilization). The seams for evolution exist (genome store for inheritance,
event log, save format) — later phases should extend, not rewrite. Learning
stays a simple, deterministic associative update (bounded memory values +
intelligence-modulated rates), never a neural model.

---

## 12. Development conventions — where to add things

### Add a new component

1. Define its schema in `src/simulation-core/ecs/components.ts`
   (`const FooSchema = { bar: Float32Array };`) with a doc comment.
2. Instantiate the store in `SimulationEcs`
   (`readonly foo = new ComponentStore('foo', FooSchema, INITIAL_AGENT_CAPACITY)`)
   and add it to the fixed `stores` array (order matters for serialization —
   appending at the end is safe; inserting requires a save-format bump).
3. Attach it where agents are created (`simulation/systems/spawn.ts`) and
   detach it where they die (`simulation/systems/death-system.ts`).
4. Bump `SAVE_FORMAT_VERSION` in `persistence/serialization.ts` if you change
   existing stores; new stores only need the version bumped if old saves must
   load (a missing store currently throws — decide the migration policy).

### Add a new simulation system

1. Create `src/simulation-core/simulation/systems/foo-system.ts` as
   `export function updateFoo(ctx: TickContext): void`. Iterate dense store
   slots; map entities across stores via `store.index[entity]` (never assume
   two stores are index-aligned). No allocation, no magic numbers — read
   rates from `config`.
2. Add tunables to `SimulationConfig` in `simulation/config.ts` with defaults.
3. Call it from `Simulation.step()` at the right point in the order — the
   order is part of the determinism contract; document why your system runs
   where it does.
4. Extend the determinism tests if your system adds state.

### Add a new AI action

The Utility AI (`ai/utility-ai.ts`) scores the six `AgentIntent` actions with
bounded utilities (built from the curves in `ai/utility/curves.ts` via the
considerations in `ai/considerations/`). To add an action: (1) append a value
to `AgentIntent` in `simulation-core/ai/intents.ts` (renumbering requires a
save-format bump), (2) add its scoring + tie-break draw in the `selectIntents`
loop (keeping the six-actions-first invariant for RNG determinism), and (3)
implement its effects in the relevant system (movement/needs/resource). The
*selection* lives in `ai/`; the *effects* live in systems. Keep selection
deterministic: any randomness must come from `ctx.aiRng`.

### Add a new event

Add the type to `SimulationEventType` (`simulation-core/events/events.ts`),
record it via `sim.events.record('foo', { entityId?, detail? })` — the log
stamps tick/time automatically. Events flow to the UI through snapshots; add
a label in `ui/event-log-panel.ts` `describeEvent()` if needed.

### Add a new UI panel

1. Add the markup (with element ids) in `index.html`.
2. Create `src/ui/foo-panel.ts` — a small class that owns its DOM elements
   and exposes `update(...)`/`clear()`; query elements with
   `requireElement()` from `ui/dom.ts`. Panels must not import worker or
   simulation runtime code — they receive plain data.
3. Wire it in `src/main/app.ts` (construct the panel, feed it from
   `handleWorkerMessage`).
4. Add controls to the message flow only if new data is needed: extend
   `workers/protocol.ts` (types + constants), `WorkerEngine.dispatch()` and
   the snapshot builder — never send the whole simulation object.

### General rules

- Strict TypeScript, small modules, no hidden globals, no magic numbers.
- Comments explain **why**, not what.
- No new dependencies without strong justification; the simulation must stay
  dependency-free.
- Every change to simulation behavior must keep the determinism tests green —
  they are the project's contract.

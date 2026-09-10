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
by label — `sim` (tick dynamics), `spawn` (initial entity creation), `ai` (AI
decisions: tie-break noise, wander-target draws) and `repro` (reproduction:
child sex, crossover choice, mutation, child needs/position jitter) — via
`deriveStreamSeed(seed, label)`. Changing how one stream consumes randomness
can never affect another stream's numbers. All stream states are part of the
save state.

The Utility AI consumes the `ai` stream in a fixed order per agent (seven
tie-break jitter draws in `ActionKind` order, then wander-target draws only
when Wander wins), so AI RNG consumption never depends on which action won —
re-running the same state always consumes the same numbers. Reproduction
randomness lives entirely on `repro`, so adding/removing births never shifts
the `sim`/`spawn`/`ai` streams.

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
  0..1), `intent` (kind + movement target + targetEntity — the AI seam),
  `aiState` (the twelve Utility AI base scores — seven survival + five
  social — persisted for the debug view and the determinism tests without
  recomputing the AI), `lineage` (generation, parentA, parentB),
  `reproductive` (binary sex, fertility-scaled reproduction cooldown, cached
  eligibility flag), and `social` (loneliness, groupId, groupJoinTick,
  cooperation session target/progress, forage-bonus ticks, lastConflictTick).
- **Memory** is a dedicated variable-length store (`ai/memory/memory-store.ts`,
  exposed as `ecs.memory`): per-agent bounded capacity, a flat typed-array
  arena with a free-list, and eviction of the least-valued entry. It lives
  beside the ComponentStores on `SimulationEcs` and participates in
  serialization.
- **Relationships** (`social/relationship-store.ts`, exposed as
  `ecs.relationships`) use the same variable-length pattern for directed
  social memory: bounded per-agent capacity, flat arena with free-list,
  least-keep-value eviction. Social memory stays O(agents × capacity).
- **Planned components** (Social, Inventory) are documented in
  `ecs/components.ts` with the recommended storage approach. Fixed numeric
  columns drop straight into `ComponentStore`.

Systems (`simulation/systems/`) are plain functions
`(ctx: TickContext) => void`. The context (ecs, world, config, events, rng
streams, resource index, dtHours) is constructed **once** per simulation —
systems cause zero per-tick allocation. System order inside `Simulation.step()`
is part of the determinism contract:

```
selectIntents → moveAgents → interactWithResources → updateSocialInteractions
  → updateNeeds → updateDeaths → updateSocialState → updateMemory
  → regenerateResources → updateAging → updateMortality → updateReproduction
  → updateGroups → tick++
```

`updateReproduction` runs last-but-one so a child is born at age 0 and only
acts on the following tick; `updateMortality` adds age pressure after aging
advances the clock, and the existing death system (running earlier, after
needs) is what actually removes agents. Social interactions execute right
after resource interactions (so a failed forage can immediately color the
social pass); social maintenance runs after deaths so relationships of agents
that died this tick are already gone; group detection closes the tick
(no-op unless `tick % detectionIntervalTicks === 0`).

`ai/` owns *decisions*; systems own *consequences*. The Utility AI
(`ai/utility-ai.ts`) scores the twelve candidate actions (Rest, Wander,
SeekFood, SeekWater, Eat, Drink, SeekPartner, Socialize, Help, Cooperate,
Avoid, Confront) with bounded [0, 1] utilities, applies deterministic
tie-break noise + action hysteresis (twelve unconditional jitter draws per
agent per tick — AI RNG consumption never depends on which action wins), and
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
`get-group {groupId, requestId?}` · `request-save {requestId?}` ·
`verify-determinism {ticks?, requestId?}`.

Messages (worker → main): `ready {seed, running, multiplier, world}` ·
`snapshot {snapshot, events[], debug}` · `agent-details` · `group-details` ·
`save` · `determinism-result` · `error`. Queries with a `requestId` get it
echoed — used by the dev handle and the browser smoke test.

Snapshots (`persistence/snapshots.ts`) are **compact and versioned**
(`SNAPSHOT_FORMAT_VERSION = 4`): per frame only tick/time/population/births/
deaths/max-generation/averages/resources/trait-distributions plus SoA typed
arrays (ids, x, y, strength, intelligence, speed, intent kind, groupId,
cooperation target, conflict flash) and bounded social aggregates (group
count/sizes, active relationships, average score/trust, cooperation/conflict
counters, isolated agents) — a `formatVersion` field allows the format to
evolve (delta snapshots, binary payloads) without ambiguity. Full per-agent
data is fetched on demand via `get-agent` (which also returns the live
twelve-action AI utility table, movement target, memory lists, life stage,
sex, lineage, per-gene inheritance origins and the top remembered
relationships for the inspector), and per-group details via `get-group` —
the whole social graph is never sent per frame. Per-frame cost stays
O(population) with small constants at 10 snapshots/second even for thousands
of agents. The worker rate-limits snapshots to `snapshotIntervalMs` (100 ms)
and always sends one on init/pause/resume/re-init.

## 8. The social layer (Phase 4)

Phase 4 makes agents social. Everything below is **simulated state and
mechanism**; the *outcomes* (who knows whom, who cooperates, who fights,
whether groups exist at all) are emergent. There is no scripted tribe
creation anywhere in the codebase.

### Relationship model (`social/relationship-store.ts`)

Directed pairwise memory — "how A views B" is a separate fact from "how B
views A" — stored as a bounded variable-length store exactly like the
environmental memory (per-entity sparse index, flat arena, free-list):

- `score` in [−1, +1] (valence), `trust` in [0, 1] (expected reliability),
  `familiarity` in [0, 1] — three separate axes, as required,
- per-agent capacity (`social.memory.capacity`, default 16) with
  least-keep-value eviction (kin and strong bonds survive, weak strangers are
  forgotten first) — social memory is O(agents × capacity), **never O(n²)**,
- pruning: dead targets immediately, and weak + stale entries after
  `pruneAgeTicks`.

Social memory is deliberately separate from environmental memory
(`ai/memory/`): different content, different decay, different consumers.

### Social perception (`ai/social-targeting.ts`)

One bounded pass per agent per tick, split by what the actions need:

1. **Memory pass** over the agent's own relationship chain (≤ capacity):
   Confront and Avoid candidates are *by definition* remembered agents (the
   hostility gate requires a relationship), so they are evaluated directly
   from memory — never dependent on the spatial scan's candidate cap, i.e.
   reachable at any crowd density.
2. **Spatial pass** over the 3×3 index cells around the agent (capped at
   `social.perception.maxScan` candidates — the same anti-quadratic guard as
   the partner search): Socialize / Help / Cooperate targeting, which can
   involve strangers.

Results land in a reused module-level scratch (the established
`partnerScratch` pattern — zero per-tick allocation).

### The five social actions

Added to the Utility AI as first-class scored actions (twelve total): the AI
layer computes utilities; systems apply consequences.

| Action | Utility shape | Consequence (social system) |
| --- | --- | --- |
| Socialize | loneliness × social drive × safety × affinity of target | bonds + trust + familiarity both ways; loneliness relief |
| Help | drive × capacity × need of target × trust | energy cost to helper, health/energy to the needy; **reciprocity**: the helped side's trust rises fastest |
| Cooperate | drive × safety × forage need × partnership quality | a multi-tick session with per-tick energy cost; completion grants bonds + a time-limited cooperative-foraging bonus |
| Avoid | threat (proximity × hostility × distrust) × vulnerability | flee target away from the most feared remembered rival |
| Confront | gain × competition × grudge × edge × personality (see below) | strength-decided conflict: damage both ways, loser knocked back, relationship soured, pair cooldown |

`relationshipAffinity(score)` is asymmetric: positive bonds raise affinity
toward 1, but negative scores collapse it to 0 at −0.25 — an agent does not
socialize, help or cooperate with someone it blames, so grudges are not
silently repaired by incidental friendliness. Kinship (parent/child/sibling
from `lineage`, never "mates") biases socialize/help and dampens
confrontation; it is a bias, not hardcoded friendship.

### Competition, resentment and hostile attribution

The only source of negative relationships is real resource competition
(`resource-system.ts`): a forager whose patch is strained (less than a full
meal left, another eater present) or depleted (empty patch, someone nearby)
blames a nearby agent. Blame assignment is **hostile attribution** — prefer
the agent already blamed (deepest grudge first), then a co-forager of the
same tile, then the nearest bystander. This is what makes grudges
self-reinforcing: repeated contested contact deepens the *same* relationship
instead of spraying blame at rotating strangers. Penalties are rate-limited
per pair (`resentUntil`, a dedicated cooldown — friendly contact does not
immunize a pair against competition) and dampened for kin and existing
goodwill. The `resentment` event fires when blame first pushes a
relationship past the hostility gate.

Hostility heals slowly (`hostilityDecayPerHour`, a full grudge fades in
~3 in-game weeks) and never overshoots into goodwill: grudges decay, they
are not permanently locked, and renewed conflict always outpaces healing.

### Conflict utility (the formula)

```
confront = min(1, 2.4 · competition · grudge · edge · personality · kinDamp)
  competition = hungerUrgency × proximity      (the stake — linear)
  grudge      = sqrt(−score)                    (hostility ≥ minHostility gate)
  edge        = clamp01(0.5 + 0.5·(myStrength − theirStrength))
  personality = 0.75 + 0.25·(1 − socialTendency)  (moderate modifier)
  kinDamp     = 1 − 0.75 for kin
```

Interpretation: confrontation needs an **actual stake** (hunger over a
contested resource — a full stomach defuses) **and** sufficiently strong
hostility (the gate at −0.15 plus the sqrt keeps shallow annoyance inert).
Strength decides outcomes; the initiator only wins ties. Confronting costs
the winner health too, and pairs cooldown for a day after a fight. In the
default resource-rich world the chain never gets past shallow resentment;
under a real famine it produces sporadic, episodic conflict — both regimes
are covered by `tests/social-emergence.test.ts`.

### Groups (emergent communities, `simulation/systems/group-system.ts`)

Groups are **derived structures**: candidates come from clustering the
actual social graph (relationship score ≥ threshold **and** spatial
proximity — union-find over relationship-chain edges, never all-pairs),
reconciled with a persistent registry every `detectionIntervalTicks`
(default: one in-game day — never per tick):

- **identity persists**: a continuing community keeps its group id (small
  sequential integers from the serialized counter — deterministic, never
  UUIDs); a split spawns a child group carrying `parentId` + `generation+1`;
  a merge keeps the older identity;
- **hysteresis**: a brand-new community must be seen in two consecutive
  detection runs before it founds a group; membership leave-utility is
  deliberately higher than join-utility — no join/leave flapping;
- **membership is a utility decision** (`groupJoinUtility` /
  `groupLeaveUtility`): nobody is forced into a group, isolated agents stay
  isolated, and the spatial tether is generous (drift pressures only beyond
  2 × `maxMemberDistanceTiles`) because bonded agents routinely forage far
  apart and reconverge — momentary dispersal must not break a group;
- groups dissolve when empty or down to a lone survivor; territory (center,
  radius, food/water access) is informational only;
- cohesion is measured, not assumed: `0.5 · socialBond + 0.3 · spatial
  tightness + 0.2 · interaction density` from real member data.

### Serialization & determinism

`SAVE_FORMAT_VERSION = 4` adds the relationship store (including the
resentment cooldowns), the group registry (ids, membership, lineage
counters, pending signatures) and the social statistics counters. No RNG
stream was added — the social layer is fully deterministic arithmetic on
state. The per-field determinism contract covers social columns,
relationships, groups and social stats; save → restore → continue is
bit-identical to an uninterrupted run (enforced by tests and by
`runDeterminismCheck()`).

## 9. Events

`simulation-core/events/events.ts`: bounded log; every event carries
`tick` + `timeHours` (+ optional `entityId`, `detail`). The worker drains
pending events into each snapshot (capped at 100 per snapshot; the remainder
follows). Types: `simulation_started`, `simulation_reinitialized`,
`simulation_paused`, `simulation_resumed`, `speed_changed`, `agent_spawned`,
`agent_ate`, `agent_drank`, `agent_died`, `agent_learned`,
`resource_depleted`, `reproduction_attempted`, `reproduction_success`,
`birth`, `mutation`, `old_age_death`, plus the Phase 4 social types
(`social_interaction`, `relationship_changed`, `resentment`, `helped_agent`,
`cooperation_started`, `cooperation_completed`, `conflict`, `group_created`,
`group_joined`, `group_left`, `group_split`, `group_merged`) — all fired on
state transitions (band crossings, session completions, lifecycle changes),
never per tick. Event history is not persisted yet (deliberate — later
phase).

## 10. Persistence

`persistence/serialization.ts` defines the versioned save format
(`SAVE_FORMAT_VERSION = 4`) capturing everything needed to resume bit-for-bit:
seed, tick, config, RNG stream states (all four streams — sim, spawn, ai,
repro), world arrays (including the food/water caps) and all component stores
plus the memory store. The version was bumped for Phase 2 (`aiState` store,
memory store, third RNG stream), Phase 3 (reproduction, lineage + a fourth
RNG stream) and Phase 4 (the `social` component store, the relationship
store — including per-pair cooldowns and resentment timers — the group
registry and the social statistics counters; no new RNG stream: the social
layer is deterministic arithmetic on state). Round-trip and continuation equality are enforced by tests and by
`runDeterminismCheck()` (`persistence/determinism-check.ts`), which the worker
exposes as the `verify-determinism` command and the dev handle as
`window.__evosim.verifyDeterminism()` (dev builds only — production code has
no global escape hatch).

The default configuration (`simulation/config.ts`) is module-level shared
state, so it is deep-frozen: accidental mutation of the default fails loudly,
and per-run tuning goes through `cloneConfig()` (which returns a normal
mutable copy).

## 11. Performance guidelines

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
- **The social layer inherits the same rules**: social perception is one
  bounded spatial walk (maxScan cap) plus one bounded memory walk
  (relationship capacity); the social presence pass walks each agent's own
  relationship chain (O(pop × capacity)); relationship storage is hard-bounded
  by capacity with eviction; group detection is periodic (union-find over
  relationship-chain edges, never all pairs) and its scratch is rebuilt per
  run, never serialized. Measured on this repo's CI machine (see
  `tests/social-performance.test.ts`): ~2.6 ms/tick at 50 agents, ~49 ms/tick
  at 1000 agents on the default 64×64 world — near-linear growth, asserted by
  test.
- Agents are never DOM elements; rendering is batched canvas circles over a
  pre-baked terrain layer (the world rasterizes once, not per frame).
- Worker-side per-tick time is measured (EMA) and surfaced in the debug
  overlay so regressions are visible early.

## 12. Scope ladder (Phases 1–4 done — what stays out)

Phase 2 delivered the static world + autonomous agent survival loop (needs,
energy, health, learning, determinism). **Phase 3 added evolution**: binary-sex
sexual reproduction, inheritance (uniform crossover), per-gene mutation,
age-based life stages (child → adolescent → adult → elderly), gene energy
trade-offs, age-mortality pressure, genealogy (`lineage`) and a reproduction
cooldown/eligibility model. Natural selection emerges from survival and
reproduction; there is no scripted fitness function. See `reproduction-system.ts`,
`mortality-system.ts`, `life-stages.ts` and `genetics/genome.ts`.

**Phase 4 added the social layer** (see §8): relationships, trust and
familiarity, kin awareness, cooperation with real opportunity costs, emergent
conflict from competition, and derived social groups with persistent identity.
Social behavior affects evolution only *indirectly* — through survival and
reproduction, never through an explicit social fitness term.

**Designer scaffolding vs. emergence** — what is designed: the mechanics
(utility formulas, thresholds, capacities, cooldowns, the clustering
algorithm) and their tunables in `config.ts`. What is emergent: every social
outcome — who knows whom, whether cooperation happens, whether resentment
deepens into hostility, whether confrontations occur at all, whether groups
form, split, merge or dissolve, and who joins or leaves them. Nothing in the
codebase creates a group, a grudge or a fight directly; the peaceful default
world produces social life without a single confrontation, while a famine
produces the full scarcity → competition → resentment → hostility →
confrontation → conflict chain (both regimes are locked in by
`tests/social-emergence.test.ts`).

Still deliberately out of scope (now and likely forever for this project):
pregnancy/gestation, neural networks, LLM integration, NEAT; and the
civilization ladder (culture, memes, language, communication, technology,
agriculture, economy, trade, warfare, cities, civilization). Note that
"warfare" here means organized inter-group combat systems — Phase 4's
individual confrontations over contested resources are as far as conflict
goes. Learning stays a simple, deterministic associative update (bounded
memory values + intelligence-modulated rates), never a neural model.

---

## 13. Development conventions — where to add things

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

The Utility AI (`ai/utility-ai.ts`) scores the seven `AgentIntent` actions
with bounded utilities (built from the curves in `ai/utility/curves.ts` via the
considerations in `ai/considerations/`). To add an action: (1) append a value
to `AgentIntent` in `simulation-core/ai/intents.ts` (renumbering requires a
save-format bump), (2) add its scoring + tie-break draw in the `selectIntents`
loop (keeping the seven-actions-first invariant for RNG determinism), and (3)
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

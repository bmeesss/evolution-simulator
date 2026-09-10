# Evolution Simulator

A browser-based evolution simulator: a **deterministic** agent simulation running
on a fixed timestep inside a **Web Worker**, rendered with **Canvas 2D** — no
game engine, no backend, no simulation framework.

This repository currently contains **Phase 1 (the deterministic foundation),
Phase 2 (Utility AI, survival and individual learning), Phase 3 (Evolution:
reproduction, inheritance and natural selection), Phase 4 (Social evolution:
relationships, cooperation, competition and emergent groups) and Phase 5
(Culture & communication: cultural knowledge, teaching, proto-communication and
emergent group traditions)**. The world, agents, needs, movement, Utility AI
decisions, eating/drinking, memory, death, **sexual reproduction with genetic
inheritance and mutation**, the **social layer** and the **cultural layer** are
all proven reproducible from a seed. Natural selection emerges from survival
and breeding — there is no scripted fitness function — and social and cultural
behavior affect it only indirectly.

**Genes ≠ culture.** Genes travel only through reproduction; cultural knowledge
travels only through actual interactions (a child inherits its parents' genome,
never their knowledge). Nothing in the codebase copies culture globally: an item
moves because two agents met, and it can be lost again — by decay, by forgetting,
by the death of its holder, or simply because nobody teaches it.

Technology, agriculture, economy, warfare and cities are explicitly out of
scope; see the phase plan in [ARCHITECTURE.md](ARCHITECTURE.md).

## What you see

- A 64×64 tile world generated from a seed (terrain, food, water, temperature)
- 50 agents that **decide what to do each tick**: rest, wander/explore, seek
  food, seek water, eat, drink, **seek a partner** — or, since Phase 4,
  **socialize, help, cooperate, avoid or confront** — scored with bounded
  utility curves and deterministic tie-breaking
- Agents get hungry/thirsty/tired, spend energy while active, restore it while
  resting, take health damage when needs stay critical, and **die** when health
  runs out (or when old age takes its toll)
- **Reproduction**: adults in good health seek an opposite-sex, non-kin partner;
  a birth crosses over the parents' genomes and applies **per-gene mutation**.
  Children inherit genes (not memories), begin at age 0 and progress through
  child → adolescent → adult → elderly life stages. High fertility shortens the
  reproduction cooldown; intelligence/strength/fertility/speed carry a metabolic
  energy cost, so they are not free.
- Food/water are consumed and regrow toward their per-tile caps; agents
  **remember** resource locations (bounded per-agent memory that decays unless
  re-confirmed) and **learn faster / forget slower** with higher intelligence
- **Social life (Phase 4)**: agents build directed relationships (score,
  trust and familiarity are separate axes) through socializing, helping and
  cooperative foraging sessions; they recognize kin (parents/siblings) and
  mildly favor them. Social memory is bounded per agent — an agent remembers
  at most ~16 others, forgetting the weakest
- **Competition and conflict are emergent, never scripted**: a forager that
  finds its patch stripped blames a nearby competitor (preferring whoever it
  already blames — hostile attribution), grudges deepen under repeated
  competition, slowly heal with time, and only hunger plus a deep grudge plus
  a strength edge ever makes an agent *confront*. In the default rich world
  the chain never gets that far: agents socialize, cooperate and form groups
  without a single fight
- **Groups emerge** from the actual social graph (mutual bonds + proximity,
  detected once per in-game day): membership is each agent's own utility
  decision, groups keep a stable identity across splits and merges, and
  isolated agents stay isolated
- **Cultural knowledge (Phase 5)**: agents *discover* shareable knowledge by
  living (where food/water is, which foraging technique suits their terrain, how
  to treat others), *teach* it to someone they are close to (a costly action:
  time, energy, attention), and sometimes *pick it up by observation* while
  socializing or cooperating. Each agent holds at most ten items; knowledge is
  strengthened by successful use and by teaching, weakened by contradiction
  (a remembered patch that turns out empty), decays when unused, and is
  forgotten or lost with its holder. Transmissions can drift: a believed
  location can shift a tile or two, a technique/norm token can become a
  neighbouring variant — small, bounded variation, and only during a
  transmission event
- **Proto-communication (Phase 5)** — an intentionally primitive signalling
  system: 16 arbitrary tokens (`Signal_01`…`Signal_16`), five meaning categories
  (food, water, danger, follow, help), and **no grammar, no words, no semantics
  beyond repeated association**. To be explicit: this is *proto-communication
  scaffolding*, not human language — agents do not talk, describe or understand
  each other; they only form token↔situation associations by observing signals
  in a local context. An agent emits a token by acting
  (`SignalFood`, `SignalWater`, `SignalDanger`, `SignalFollow`) near others;
  only agents within hearing range perceive it, only if the emitter's situation
  makes the meaning observable (a "FOOD!" signal from an agent standing on bare
  grass teaches nothing), and a meaning is "known" only after the association
  crosses a threshold. Tokens therefore end up meaning different things in
  different places — local conventions emerge, they are not assigned. Emitting
  costs energy and starts a cooldown, so spam is never free and never useful
- **Small norms (Phase 5)** exist as cultural knowledge too (`HELP_OTHERS`,
  `SHARE_FOOD`, `AVOID_CONFLICT`), each learned from experience or teaching and
  each with an interpretable effect on the Utility AI (helping/sharing get more
  attractive, marginal confrontations get damped). They are knowledge items,
  not morality, religion or politics
- **Group culture is derived, never assigned**: the group inspector shows the
  knowledge the members actually hold (dominant items, traditions held by at
  least half the group, norms, signal conventions), plus a **cultural
  similarity** score in [0, 1] against the other groups. Two groups that never
  meet drift apart; the moment their members interact, knowledge crosses
- Statistics (population, births, deaths, max generation, needs, genome & trait
  averages, trait distributions, resource availability, social aggregates), a
  selected-agent inspector (life stage, generation, parents, sex, reproduction
  cooldown, full genome, per-gene inheritance origins, live seventeen-action
  Utility AI table, memory lists, cultural knowledge/signal associations/norms,
  group membership, top relationships with score/trust/familiarity), a
  **groups panel** (count, sizes, cohesion, key members — click a group to
  inspect its culture, traditions, signal conventions and similarity to other
  groups), a history graph, an event feed and a development overlay
- A development overlay with tick rate, worker status, render FPS and
  simulation timing

**Agent visuals are genome-driven and deterministic:**

| Visual property | Genome trait | Meaning |
| --- | --- | --- |
| Circle size | `strength` | bigger circle = stronger agent |
| Circle hue | `intelligence` | blue = low, yellow = high |
| Inner ring width | `speed` | wider inner ring = faster agent |
| Dimmed body | (intent) | currently resting |
| Green ring | (intent) | currently eating |
| Blue ring | (intent) | currently drinking |
| Pink ring | (intent) | currently seeking a partner |
| Amber dot | (intent) | currently wandering / exploring |
| Violet ring | (intent) | currently socializing |
| Teal ring | (intent) | currently helping |
| Orange dashed link | (intent) | active cooperation session (drawn between partners) |
| Red ring | (intent) | currently avoiding a feared rival |
| Red flash | (state) | recent conflict loser |
| Golden dashed ring + faint territory circle | (state) | group member (hue from a stable group color) |
| Small dot above the agent | (state) | emitted a signal this moment (hue = which token, never what it "means") |

The intent ring is drawn just outside the body; the speed ring just inside it, so
the two never overlap. Food is shown as a green tint on land tiles (denser green
= more food).

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
| **Click an agent** | Inspect it (id, age, needs, health, full genome, AI utilities, memory) |

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
  state (world, agents, positions, needs, genome, intent, AI utility scores,
  memory, RNG state), and save → load → continue must match an uninterrupted
  run
- RNG sequence/state tests, ECS store tests, world generation tests
- **Phase-2 system tests** — utility curves & considerations, intelligence-
  modulated learning, memory capacity/decay/eviction, needs & death dynamics,
  resource consumption & regeneration, and Utility AI integration
- **Phase-3 evolution tests** — life-stage mapping, genetic crossover &
  mutation determinism and bounds, reproduction eligibility gates (age, sex,
  cooldown, health, need, distance), generation/lineage inheritance, age
  mortality, fresh-memory children, and whole-run reproduction that neither
  explodes nor collapses; plus trait-distribution / evolution statistics and a
  partner-search performance regression (linear, not quadratic, in population)
- **Phase-4 social tests** — relationship store bounds/eviction/round-trip,
  kinship recognition and seeding, socialize/help/cooperate/confront mechanics
  (costs, reciprocity, cooldowns, knockback), resentment with hostile
  attribution and kin dampening, hostility decay (grudges fade, never lock),
  group formation/persistence/split/merge/cleanup with deterministic stable
  IDs, dead-agent social cleanup, confront utility calibration, the peaceful
  baseline vs. controlled-famine emergence contrast (scarcity → competition →
  resentment → hostility → confront → conflict, with zero conflict in the
  default world), social determinism (identical histories from identical
  seeds) and social performance regressions (near-linear per-tick cost from
  50 to 1000 agents, bounded relationship storage, periodic group detection)
- Worker engine tests (fixed timestep, pause/speed, message protocol) against
  the real worker entry module
- **Phase-5 culture tests** — cultural memory (add/reinforce-in-place,
  weaken/contradiction, decay/forget, hard capacity with weakest-eviction,
  round-trip, no dead carriers), transmission (only through actual Teach/
  imitation interactions, only inside reach, cost paid even on a failed roll,
  and a probability that genuinely depends on relationship affinity,
  familiarity, intelligence, social tendency and item strength — never on
  intelligence alone), variation (exact copies at full fidelity, bounded drift
  otherwise, technique variants inside the alphabet, no per-tick mutation,
  identical variants from the same seed), loss (decay, forgetting with a
  `knowledge_lost` event, death cleanup, capacity eviction), signals (emission
  cost/cooldown, hearing radius (no global broadcast), useless spam teaching
  nothing, association strengthening into a known meaning, bounded
  associations/meanings, different tokens for the same meaning in different
  places), divergence (isolated groups diverge, contact transfers knowledge and
  raises similarity, similarity stays in [0, 1]) and behaviour (beliefs steer
  choices, a remembered location never lures an agent away from food underfoot,
  techniques pay off on their home terrain, norms shift help/cooperate/confront
  utilities, teaching/signalling cost energy and attention)
- **Phase-5 emergence & determinism tests** — a 3000-tick default-world run that
  proves cultural diffusion happens through the interaction network (every
  transmitted item is verified to come from a source inside interaction reach
  at that very tick, and per-tick transfers never exceed the number of sharing
  interactions performed) and that signals emerge as local conventions (a
  meaning crosses the known threshold, no emission reaches more than a handful
  of listeners, several different tokens end up in use); plus same-seed
  cultural history equality (events, items, variants, associations), save/load
  continuation equality and culture performance bounds (near-linear cost from
  50 to 1000 agents, capped memory/associations, bounded events)
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

In environments where the Playwright Chromium download is blocked (e.g. some
sandboxes), the e2e test cannot run. The same guarantees are still covered by
the Node test suite: the worker engine is driven against a clock-injected host
(the real worker entry module), the UI modules transform cleanly, and the
production build is verified. Run `npm test` to exercise those instead.

## Determinism in one paragraph

Every random decision comes from a seeded sfc32 PRNG with independent streams
(tick dynamics, spawning, AI decisions, reproduction, **culture**) derived from
the root seed; the world generator is a pure hash function of `(seed, x, y)`. One simulation tick advances exactly
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

/**
 * Phase 5 — cultural emergence scenarios (default configuration).
 *
 * These are the integration tests that proves culture is EMERGENT rather than
 * scripted, using the DEFAULT world and the DEFAULT culture parameters — no
 * culture is assigned anywhere, and no tuned "culture drive" pushes items
 * around:
 *
 *   1. CULTURAL DIFFUSION — agents discover knowledge by living, teach it to
 *      neighbours they are close to, pick some of it up by observation, and it
 *      is lost again by decay. Every transmitted item is verified to have come
 *      from a source that was physically within interaction reach at that very
 *      tick, and each tick's transmitted entries are bounded by the number of
 *      social/teaching actions performed — the two properties that make this
 *      diffusion through the interaction network and not a global copy.
 *
 *   2. SIGNAL EMERGENCE — tokens are used, heard and associated into meanings.
 *      No signal ever reaches more than a handful of listeners (a broadcast
 *      would reach everyone), tokens stay inside the 16-token alphabet, and
 *      several DIFFERENT tokens end up in use, i.e. agents settle on
 *      conventions rather than being handed one.
 *
 * The run is long (3000 ticks at the default 50 agents), so it is executed
 * once and both tests assert against the recorded trace.
 */

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation-core/simulation/simulation';
import { DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { AgentIntent } from '../src/simulation-core/ai/intents';
import {
  KnowledgeOrigin,
  NO_SIGNAL_TOKEN,
  SIGNAL_TOKEN_COUNT,
  SIGNAL_MEANING_COUNT,
  SignalMeaning,
  signalMeaningName,
} from '../src/simulation-core/culture';

const TICKS = 3000;
const SEED = 11;

interface EmergenceTrace {
  readonly population: number;
  readonly minPopulation: number;
  readonly discoveries: number;
  readonly heldByTaught: number;
  readonly heldByImitation: number;
  readonly transmittedEntries: number;
  readonly maxTransmittedPerTick: number;
  readonly localityViolations: number;
  readonly fanOutViolations: number;
  readonly maxListenersPerEmission: number;
  readonly emittedEvents: number;
  readonly learnedEvents: number;
  readonly learnedMeaningNames: Set<string>;
  readonly tokensSeen: Set<number>;
  readonly distinctLearnedTokens: number;
  readonly maxAssociationsPerAgent: number;
  readonly maxKnowledgePerAgent: number;
  readonly knowledgeHolders: number;
  readonly signalHolders: number;
  readonly maxHeardBy: number;
  readonly maxSignalPerTick: number;
}

/** Run the default world once and verify diffusion/locality invariants live. */
function runEmergenceScenario(): EmergenceTrace {
  const sim = Simulation.create(SEED, DEFAULT_SIMULATION_CONFIG);
  const config = DEFAULT_SIMULATION_CONFIG;
  const reachSq = config.social.interaction.radiusTiles * config.social.interaction.radiusTiles;

  let transmittedEntries = 0;
  let maxTransmittedPerTick = 0;
  let localityViolations = 0;
  let fanOutViolations = 0;
  let maxListenersPerEmission = 0;
  let maxHeardBy = 0;
  let maxSignalPerTick = 0;
  let minPopulation = Number.POSITIVE_INFINITY;
  let emittedEvents = 0;
  let learnedEvents = 0;
  const learnedMeaningNames = new Set<string>();

  for (let i = 0; i < TICKS; i++) {
    sim.step();
    const tick = sim.tick - 1;
    const alive = sim.ecs.entities.aliveCount;
    minPopulation = Math.min(minPopulation, alive);

    // How many agents performed a knowledge-sharing interaction this tick?
    // Every transmission needs one such action, so this is the fan-out bound.
    let socialActions = 0;
    let signalsThisTick = 0;
    for (let k = 0; k < sim.ecs.intent.count; k++) {
      const kind = sim.ecs.intent.columns.kind[k];
      if (
        kind === AgentIntent.Teach ||
        kind === AgentIntent.Socialize ||
        kind === AgentIntent.Help ||
        kind === AgentIntent.Cooperate
      ) {
        socialActions++;
      }
      if (
        kind === AgentIntent.SignalDanger ||
        kind === AgentIntent.SignalFood ||
        kind === AgentIntent.SignalWater ||
        kind === AgentIntent.SignalFollow
      ) {
        signalsThisTick++;
      }
    }
    maxSignalPerTick = Math.max(maxSignalPerTick, signalsThisTick);

    let newTransmitted = 0;
    for (let k = 0; k < alive; k++) {
      const entity = sim.ecs.entities.aliveIds[k];
      const store = sim.ecs.culturalMemory;
      for (let e = store.headOf(entity); e !== -1; e = store.nextOf(e)) {
        if (store.entryLearnedTick(e) !== tick) continue;
        const origin = store.entryOrigin(e);
        if (origin !== KnowledgeOrigin.Taught && origin !== KnowledgeOrigin.Imitated) continue;
        newTransmitted++;
        // The source must exist, be another agent, and be within interaction
        // reach — this is what "culture spreads by contact" means concretely.
        const source = store.entrySource(e);
        if (source < 0 || source === entity || !sim.ecs.entities.isAlive(source)) {
          localityViolations++;
          continue;
        }
        const ownSlot = sim.ecs.position.index[entity];
        const sourceSlot = sim.ecs.position.index[source];
        if (ownSlot < 0 || sourceSlot < 0) {
          localityViolations++;
          continue;
        }
        const dx = sim.ecs.position.columns.x[ownSlot] - sim.ecs.position.columns.x[sourceSlot];
        const dy = sim.ecs.position.columns.y[ownSlot] - sim.ecs.position.columns.y[sourceSlot];
        if (dx * dx + dy * dy > reachSq) localityViolations++;
      }
    }
    transmittedEntries += newTransmitted;
    maxTransmittedPerTick = Math.max(maxTransmittedPerTick, newTransmitted);
    if (newTransmitted > socialActions) fanOutViolations++;

    // Signal events: a broadcast would show up as "heard by everyone".
    for (const event of sim.events.drain(100_000)) {
      if (event.type === 'signal_emitted') {
        emittedEvents++;
        const match = /heard by (\d+)/.exec(event.detail ?? '');
        if (match !== null) {
          const heard = Number(match[1]);
          maxHeardBy = Math.max(maxHeardBy, heard);
          maxListenersPerEmission = Math.max(maxListenersPerEmission, heard);
        }
      } else if (event.type === 'signal_learned') {
        learnedEvents++;
        const match = /^(Signal_(\d+)) means ([A-Z]+)/.exec(event.detail ?? '');
        if (match !== null) learnedMeaningNames.add(match[3]);
      }
    }
  }

  // Final state inspection.
  let heldByTaught = 0;
  let heldByImitation = 0;
  let knowledgeHolders = 0;
  let signalHolders = 0;
  let maxAssociationsPerAgent = 0;
  let maxKnowledgePerAgent = 0;
  const tokensInUse = new Set<number>();
  for (let k = 0; k < sim.ecs.entities.aliveCount; k++) {
    const entity = sim.ecs.entities.aliveIds[k];
    const knowledge = sim.ecs.culturalMemory.countFor(entity);
    maxKnowledgePerAgent = Math.max(maxKnowledgePerAgent, knowledge);
    if (knowledge > 0) knowledgeHolders++;
    for (let e = sim.ecs.culturalMemory.headOf(entity); e !== -1; e = sim.ecs.culturalMemory.nextOf(e)) {
      const origin = sim.ecs.culturalMemory.entryOrigin(e);
      if (origin === KnowledgeOrigin.Taught) heldByTaught++;
      if (origin === KnowledgeOrigin.Imitated) heldByImitation++;
    }
    const associations = sim.ecs.signals.countFor(entity);
    maxAssociationsPerAgent = Math.max(maxAssociationsPerAgent, associations);
    if (associations > 0) signalHolders++;
    for (let e = sim.ecs.signals.headOf(entity); e !== -1; e = sim.ecs.signals.nextOf(e)) {
      tokensInUse.add(sim.ecs.signals.entryToken(e));
    }
  }

  return {
    population: sim.ecs.entities.aliveCount,
    minPopulation,
    discoveries: sim.cultureStats.discoveries,
    heldByTaught,
    heldByImitation,
    transmittedEntries,
    maxTransmittedPerTick,
    localityViolations,
    fanOutViolations,
    maxListenersPerEmission,
    emittedEvents,
    learnedEvents,
    learnedMeaningNames,
    tokensSeen: tokensInUse,
    distinctLearnedTokens: learnedMeaningNames.size,
    maxAssociationsPerAgent,
    maxKnowledgePerAgent,
    knowledgeHolders,
    signalHolders,
    maxHeardBy,
    maxSignalPerTick,
  };
}

// Shared across both scenarios: one long run, two sets of assertions.
const trace = runEmergenceScenario();

describe('cultural diffusion emerges from interaction', () => {
  it('invents, transmits, and loses knowledge in the default world', () => {
    // The world stays alive: Phase 5 must not break the Phase 4 baseline.
    expect(trace.minPopulation).toBeGreaterThan(10);
    expect(trace.population).toBeGreaterThan(10);

    // Culture is invented by living (discovery), not seeded.
    expect(trace.discoveries).toBeGreaterThan(0);
    // ...and it moves between agents through actual interactions.
    expect(trace.heldByTaught + trace.heldByImitation).toBeGreaterThan(0);
    // Most held knowledge arrived socially rather than being self-discovered.
    expect(trace.heldByTaught + trace.heldByImitation).toBeGreaterThanOrEqual(trace.discoveries);
    expect(trace.transmittedEntries).toBeGreaterThan(0);
    expect(trace.knowledgeHolders).toBeGreaterThan(1);
  });

  it('never moves knowledge faster than agents can interact', () => {
    // Locality: every transmitted item came from a source within reach.
    expect(trace.localityViolations).toBe(0);
    // Fan-out: a tick cannot produce more transfers than there were sharing
    // interactions (a global copy would break this immediately).
    expect(trace.fanOutViolations).toBe(0);
    expect(trace.maxTransmittedPerTick).toBeLessThanOrEqual(trace.population);
    // Bounded per-agent memory, exactly like the individual memory store.
    expect(trace.maxKnowledgePerAgent).toBeLessThanOrEqual(DEFAULT_SIMULATION_CONFIG.culture.memory.capacity);
  });
});

describe('proto-communication emerges by association', () => {
  it('emits, hears and learns signals without any global broadcast', () => {
    expect(trace.maxSignalPerTick).toBeGreaterThan(0);
    expect(trace.emittedEvents).toBeGreaterThan(0);
    expect(trace.learnedEvents).toBeGreaterThan(0);
    expect(trace.signalHolders).toBeGreaterThan(1);
    // Nobody shouts to the whole world: the widest emission reached a handful.
    expect(trace.maxHeardBy).toBeGreaterThan(0);
    expect(trace.maxHeardBy).toBeLessThan(DEFAULT_SIMULATION_CONFIG.culture.signals.maxListenersPerEmission);
    expect(trace.maxHeardBy).toBeLessThan(trace.population);
  });

  it('settles on several tokens instead of one universally assigned meaning', () => {
    // More than one token is in use, and meanings are real (learned) ones.
    expect(trace.tokensSeen.size).toBeGreaterThan(1);
    expect(trace.distinctLearnedTokens).toBeGreaterThan(1);
    for (const token of trace.tokensSeen) {
      expect(token).toBeGreaterThanOrEqual(0);
      expect(token).toBeLessThan(SIGNAL_TOKEN_COUNT);
      expect(token).not.toBe(NO_SIGNAL_TOKEN);
    }
    for (const name of trace.learnedMeaningNames) {
      expect(name).toBe(SIGNAL_MEANING_NAMES_OF_INTEREST[name as keyof typeof SIGNAL_MEANING_NAMES_OF_INTEREST]);
    }
    expect(trace.learnedMeaningNames.size).toBeGreaterThanOrEqual(1);
    // Associations are bounded per agent, and no agent learned every meaning of
    // every token (the alphabet is much larger than one lifetime).
    expect(trace.maxAssociationsPerAgent).toBeLessThanOrEqual(
      DEFAULT_SIMULATION_CONFIG.culture.signals.maxAssociationsPerAgent,
    );
    expect(trace.maxAssociationsPerAgent).toBeLessThan(SIGNAL_TOKEN_COUNT * SIGNAL_MEANING_COUNT);
  });
});

/**
 * Meaning names the prototype vocabulary uses (see culture/signals.ts). Signal
 * meanings are five fixed categories; the *tokens* that carry them are what
 * agents negotiate.
 */
const SIGNAL_MEANING_NAMES_OF_INTEREST: Readonly<Record<string, string>> = {
  FOOD: signalMeaningName(SignalMeaning.Food),
  WATER: signalMeaningName(SignalMeaning.Water),
  DANGER: signalMeaningName(SignalMeaning.Danger),
  FOLLOW: signalMeaningName(SignalMeaning.Follow),
  HELP: signalMeaningName(SignalMeaning.Help),
};

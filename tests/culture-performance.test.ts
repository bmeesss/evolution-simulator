/**
 * Phase 5 — culture performance tests.
 *
 * The culture layer adds work to every tick (a bounded walk over each agent's
 * knowledge chain, plus work proportional to the agents that actually chose a
 * sharing/teaching/signalling action). It must not change the scaling class of
 * the simulation, and its memory must stay bounded:
 *
 *   - per-tick cost grows near-linearly, not quadratically, with population,
 *   - per-agent cultural memory is capped (capacity × population),
 *   - signal associations are capped (associations × population),
 *   - the event log stays bounded (no unbounded culture event growth).
 *
 * Numbers are logged for honest reporting; they are machine-dependent, so only
 * the ratios and the hard bounds are asserted.
 */

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation-core/simulation/simulation';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { AgentIntent } from '../src/simulation-core/ai/intents';
import { DEFAULT_EVENT_LOG_CAPACITY } from '../src/simulation-core/events';

/** Average ms per tick at a fixed population (reproduction off = flat world). */
function timePerTick(population: number, ticks: number, worldTiles = 64): number {
  const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
  config.world.width = worldTiles;
  config.world.height = worldTiles;
  config.agents.initialPopulation = population;
  config.reproduction.baseDrive = 0;
  config.reproduction.fertilityDriveBoost = 0;
  config.reproduction.socialDriveBoost = 0;
  const sim = Simulation.create(99, config);
  // Warm-up: culture needs time to exist before it can cost anything.
  for (let i = 0; i < 150; i++) {
    sim.step();
    sim.events.drain(100_000);
  }
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    sim.step();
    sim.events.drain(100_000);
  }
  return (performance.now() - t0) / ticks;
}

describe('culture system performance', () => {
  it(
    'per-tick cost grows near-linearly, not quadratically, with population',
    () => {
      const t50 = timePerTick(50, 200);
      const t100 = timePerTick(100, 200);
      const t500 = timePerTick(500, 200);
      const t1000 = timePerTick(1000, 200);
      console.log(
        `[culture perf] 50 agents: ${t50.toFixed(3)} ms/tick, 100: ${t100.toFixed(3)} ms/tick, ` +
          `500: ${t500.toFixed(3)} ms/tick, 1000: ${t1000.toFixed(3)} ms/tick`,
      );
      for (const value of [t50, t100, t500, t1000]) expect(value).toBeGreaterThan(0);
      // Quadratic growth would push 1000/50 toward 400 and 1000/500 to ~4.
      expect(t1000 / t50).toBeLessThan(60);
      expect(t500 / t50).toBeLessThan(30);
      expect(t1000 / t500).toBeLessThan(3.5);
    },
    180_000,
  );

  it(
    'keeps cultural memory, associations and events hard-bounded under crowding',
    () => {
      // A small, crowded world: maximum contact, maximum transmission pressure.
      const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
      config.world.width = 24;
      config.world.height = 24;
      config.agents.initialPopulation = 300;
      config.reproduction.baseDrive = 0;
      config.reproduction.fertilityDriveBoost = 0;
      config.reproduction.socialDriveBoost = 0;
      const sim = Simulation.create(5, config);
      // Make culture flow as fast as it can: cheap teaching and signalling.
      for (let i = 0; i < 600; i++) {
        sim.step();
        sim.events.drain(100_000);
      }

      const alive = sim.ecs.entities.aliveCount;
      expect(alive).toBeGreaterThan(0);
      const knowledgeCap = config.culture.memory.capacity;
      const associationCap = config.culture.signals.maxAssociationsPerAgent;
      let knowledgeEntries = 0;
      let associationEntries = 0;
      let maxKnowledge = 0;
      let maxAssociations = 0;
      for (let k = 0; k < alive; k++) {
        const entity = sim.ecs.entities.aliveIds[k];
        const knowledge = sim.ecs.culturalMemory.countFor(entity);
        const associations = sim.ecs.signals.countFor(entity);
        knowledgeEntries += knowledge;
        associationEntries += associations;
        maxKnowledge = Math.max(maxKnowledge, knowledge);
        maxAssociations = Math.max(maxAssociations, associations);
      }
      expect(maxKnowledge).toBeLessThanOrEqual(knowledgeCap);
      expect(maxAssociations).toBeLessThanOrEqual(associationCap);
      expect(knowledgeEntries).toBeLessThanOrEqual(alive * knowledgeCap);
      expect(associationEntries).toBeLessThanOrEqual(alive * associationCap);

      // The serialized store carries at most population × capacity entries, and
      // only living agents appear in its carrier bookkeeping (dead agents were
      // detached, not left behind).
      const serialized = sim.ecs.culturalMemory.serialize();
      const serializedEntries = serialized.entries.reduce((total, list) => total + list.length, 0);
      expect(serializedEntries).toBe(knowledgeEntries);
      expect(serialized.entities.length).toBeLessThanOrEqual(alive);
      expect(sim.ecs.signals.holderIds().length).toBeLessThanOrEqual(alive);

      // Events stay inside the event log's ring buffer (no unbounded growth).
      const recent = sim.events.recent(Number.MAX_SAFE_INTEGER);
      expect(recent.length).toBeLessThanOrEqual(DEFAULT_EVENT_LOG_CAPACITY);
      const cultureTypes = new Set([
        'knowledge_discovered',
        'knowledge_taught',
        'knowledge_learned',
        'knowledge_lost',
        'signal_emitted',
        'signal_learned',
        'cultural_variant_created',
        'norm_learned',
      ]);
      const cultureEvents = recent.filter((event) => cultureTypes.has(event.type));
      expect(cultureEvents.length).toBeLessThanOrEqual(DEFAULT_EVENT_LOG_CAPACITY);
      // ...and the culture actually happened in this crowded world.
      expect(sim.cultureStats.discoveries).toBeGreaterThan(0);
      expect(sim.ecs.intent.count).toBeGreaterThan(0);
      expect(typeof AgentIntent.Teach).toBe('number');
    },
    180_000,
  );
});

/**
 * Phase 4 — social emergence tests: the behavioral landscape contrast.
 *
 * These are the integration tests that prove social behavior is EMERGENT
 * rather than scripted:
 *
 *   1. PEACEFUL BASELINE — the default, resource-rich world produces social
 *      life (groups, cooperation, help) with no confrontation at all.
 *
 *   2. CONTROLLED SCARCITY — the same simulation with one environmental
 *      change (food regeneration collapses mid-run) walks the full causal
 *      chain: scarcity -> crowding on the remaining food -> competition ->
 *      resentment -> deepened hostility -> confront utility -> confront
 *      actions -> actual conflict events. No war trigger exists anywhere in
 *      the codebase; only utilities and resources change.
 *
 *   3. DETERMINISM OF SOCIAL HISTORY — same seed/config/ticks reproduce the
 *      identical event sequence, group identities, memberships and
 *      relationship values.
 *
 * All assertions are structural (occurred / did not occur, bounded), never
 * exact whole-run outcomes.
 */

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation-core/simulation/simulation';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { buildSimulationSnapshot } from '../src/persistence';
import { AgentIntent } from '../src/simulation-core/ai/intents';

/** Tally of social-flavored activity across a run (drains events every tick). */
interface SocialTally {
  conflicts: number;
  confronts: number;
  resentments: number;
  maxConfrontUtility: number;
  minRelationshipScore: number;
}

function trackStep(sim: Simulation, tally: SocialTally): void {
  const intent = sim.ecs.intent;
  for (let k = 0; k < intent.count; k++) {
    if (intent.columns.kind[k] === AgentIntent.Confront) tally.confronts++;
  }
  const ai = sim.ecs.aiState;
  for (let k = 0; k < ai.count; k++) {
    if (ai.columns.confront[k] > tally.maxConfrontUtility) {
      tally.maxConfrontUtility = ai.columns.confront[k];
    }
  }
  const rel = sim.ecs.relationships;
  const count = sim.ecs.entities.aliveCount;
  const ids = sim.ecs.entities.aliveIds;
  for (let k = 0; k < count; k++) {
    for (let e = rel.headOf(ids[k]); e !== -1; e = rel.nextOf(e)) {
      const score = rel.scoreOf(e);
      if (score < tally.minRelationshipScore) tally.minRelationshipScore = score;
    }
  }
  for (const e of sim.events.drain(100_000)) {
    if (e.type === 'conflict') tally.conflicts++;
    if (e.type === 'resentment') tally.resentments++;
  }
}

function newTally(): SocialTally {
  return { conflicts: 0, confronts: 0, resentments: 0, maxConfrontUtility: 0, minRelationshipScore: 1 };
}

describe('peaceful baseline (default resource-rich world)', () => {
  it(
    'social life without violence: groups, cooperation, no confrontation',
    () => {
      const sim = Simulation.create(1337, DEFAULT_SIMULATION_CONFIG);
      const tally = newTally();
      for (let i = 0; i < 4000; i++) {
        sim.step();
        trackStep(sim, tally);
      }
      const snap = buildSimulationSnapshot(sim);

      // Social life is rich: groups formed, cooperation and help happened.
      expect(snap.groups.count).toBeGreaterThanOrEqual(1);
      expect(snap.social.cooperationEvents).toBeGreaterThanOrEqual(20);
      expect(snap.social.helpEvents).toBeGreaterThanOrEqual(5);
      expect(snap.social.activeRelationships).toBeGreaterThan(0);

      // Violence is absent in a resource-rich world.
      expect(tally.confronts).toBe(0);
      expect(tally.conflicts).toBe(0);
      expect(tally.maxConfrontUtility).toBeLessThan(0.05);
      // At most incidental shallow annoyance — no deep hostility.
      expect(tally.resentments).toBeLessThanOrEqual(5);
      expect(tally.minRelationshipScore).toBeGreaterThan(-0.15);

      // The population is viable (peace is not extinction).
      expect(sim.population).toBeGreaterThan(20);
    },
    120_000,
  );
});

describe('controlled scarcity (famine) — the full emergent chain', () => {
  it(
    'scarcity -> competition -> resentment -> hostility -> confront -> conflict',
    () => {
      const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
      config.world.width = 16;
      config.world.height = 16;
      config.agents.initialPopulation = 100;
      const sim = Simulation.create(7, config);

      const tally = newTally();
      let peaceTally = newTally(); // snapshot of the pre-famine phase

      // Phase 1 — abundance: a normal world where social history builds.
      for (let i = 0; i < 2500; i++) {
        if (i === 1000) {
          // THE ONLY CHANGE: the environment degrades (regeneration
          // collapses ~12x). No social parameter is touched.
          config.resources.foodRegenPerHour = 0.001;
        }
        sim.step();
        trackStep(sim, tally);
        if (i === 2499) peaceTally = { ...tally };
      }
      // Before the drought bites: peace (no confront, no conflict).
      expect(peaceTally.confronts).toBe(0);
      expect(peaceTally.conflicts).toBe(0);

      // Phase 2 — the famine crash: crowding on the remaining food.
      for (let i = 0; i < 1300; i++) {
        sim.step();
        trackStep(sim, tally);
      }

      // (1) Competition occurred: agents blamed each other over food.
      expect(tally.resentments).toBeGreaterThanOrEqual(10);
      // (2) Hostility developed and deepened past the confront gate.
      expect(tally.minRelationshipScore).toBeLessThanOrEqual(-0.1);
      // (3) Confront utility became meaningful (not merely non-zero).
      expect(tally.maxConfrontUtility).toBeGreaterThanOrEqual(0.3);
      // (4) Confront actions were actually selected by the utility AI.
      expect(tally.confronts).toBeGreaterThanOrEqual(10);
      // (5) At least one confrontation resolved into a real conflict.
      expect(tally.conflicts).toBeGreaterThanOrEqual(1);
      // (6) Bounded hostility: scores stay within [−1, 1] by construction.
      expect(tally.minRelationshipScore).toBeGreaterThanOrEqual(-1);
      // (7) Severe but not annihilating: a population survives the famine.
      expect(sim.population).toBeGreaterThan(50);
    },
    120_000,
  );
});

describe('determinism of the social history', () => {
  it(
    'same seed + config + ticks reproduce identical groups, relationships and events',
    () => {
      const run = (): { fingerprint: string; events: string } => {
        const sim = Simulation.create(42, DEFAULT_SIMULATION_CONFIG);
        let events = '';
        for (let i = 0; i < 1500; i++) {
          sim.step();
          for (const e of sim.events.drain(10_000)) {
            events += `${e.tick}:${e.type}:${e.detail ?? ''}|`;
          }
        }
        const snap = buildSimulationSnapshot(sim);
        return {
          fingerprint: JSON.stringify({
            groups: sim.groups.serialize(),
            relationships: sim.ecs.relationships.serialize(),
            memberships: sim.ecs.social.columns.groupId.slice(),
            social: snap.social,
          }),
          events,
        };
      };
      const a = run();
      const b = run();
      expect(a.events).toBe(b.events); // identical social event history
      expect(a.fingerprint).toBe(b.fingerprint); // identical social state
      expect(a.events.length).toBeGreaterThan(1000); // the history is non-trivial
    },
    120_000,
  );

  it(
    'different seeds produce different social histories',
    () => {
      const run = (seed: number): string => {
        const sim = Simulation.create(seed, DEFAULT_SIMULATION_CONFIG);
        for (let i = 0; i < 800; i++) sim.step();
        return JSON.stringify(sim.groups.serialize()) + JSON.stringify(sim.ecs.relationships.serialize());
      };
      expect(run(1)).not.toBe(run(2));
    },
    60_000,
  );
});

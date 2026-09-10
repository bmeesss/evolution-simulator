/**
 * Phase 5 — determinism of cultural history.
 *
 * Two guarantees, both required of the culture layer:
 *   1. same seed + same config + same tick count -> the SAME cultural history,
 *      including which knowledge was discovered/taught/learned/lost, which
 *      variants appeared, which signals were emitted and what each agent
 *      associated them with;
 *   2. save -> load -> continue == one uninterrupted run, so a restored world
 *      keeps evolving exactly as it would have.
 *
 * The cultural RNG stream is separate from the pre-existing streams, and the
 * format version was bumped so old saves cannot be loaded with the new state.
 */

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation-core/simulation/simulation';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import {
  SAVE_FORMAT_VERSION,
  canonicalJson,
  deserializeSimulation,
  serializeSimulation,
} from '../src/persistence/serialization';
import { SNAPSHOT_FORMAT_VERSION } from '../src/persistence/snapshots';

const SEED = 4242;
const TICKS = 800;

/** Culture-flavoured events of one run, in order (the cultural "history"). */
function cultureHistory(seed: number, ticks: number): string[] {
  const sim = Simulation.create(seed, cloneConfig(DEFAULT_SIMULATION_CONFIG));
  const history: string[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.step();
    for (const event of sim.events.drain(100_000)) {
      if (event.type.startsWith('knowledge_') || event.type.startsWith('signal_') || event.type.startsWith('cultural_') || event.type === 'norm_learned') {
        history.push(`${event.tick}:${event.type}:${event.entityId ?? -1}:${event.detail ?? ''}`);
      }
    }
  }
  return history;
}

/** One agent's cultural memory + associations, as a comparable string. */
function culturalStateOf(sim: Simulation, entity: number): string {
  const parts: string[] = [];
  const store = sim.ecs.culturalMemory;
  for (let e = store.headOf(entity); e !== -1; e = store.nextOf(e)) {
    parts.push(
      `${store.entryType(e)},${store.entryTileX(e)},${store.entryTileY(e)},${store.entryVariant(e)},` +
        `${store.entryStrength(e).toFixed(6)},${store.entryOrigin(e)},${store.entryLearnedTick(e)},${store.entryReinforceCount(e)}`,
    );
  }
  const signals = sim.ecs.signals;
  for (let e = signals.headOf(entity); e !== -1; e = signals.nextOf(e)) {
    parts.push(
      `s${signals.entryToken(e)},${signals.entryMeaning(e)},${signals.entryStrength(e).toFixed(6)},${signals.entryExposures(e)}`,
    );
  }
  return parts.sort().join('|');
}

describe('cultural determinism', () => {
  it('produces the identical cultural history from the same seed', () => {
    const first = cultureHistory(SEED, TICKS);
    const second = cultureHistory(SEED, TICKS);
    expect(first).toEqual(second);
    // The scenario must actually produce culture, or this test proves nothing.
    expect(first.length).toBeGreaterThan(0);
    expect(first.some((line) => line.includes('knowledge_taught'))).toBe(true);
  }, 120_000);

  it('keeps the full cultural state identical across same-seed runs', () => {
    const runA = Simulation.create(SEED, cloneConfig(DEFAULT_SIMULATION_CONFIG));
    const runB = Simulation.create(SEED, cloneConfig(DEFAULT_SIMULATION_CONFIG));
    for (let i = 0; i < TICKS; i++) {
      runA.step();
      runB.step();
      runA.events.drain(100_000);
      runB.events.drain(100_000);
    }
    expect(canonicalJson(serializeSimulation(runA))).toBe(canonicalJson(serializeSimulation(runB)));
    expect(runA.cultureStats).toEqual(runB.cultureStats);

    const alive = runA.ecs.entities.aliveCount;
    expect(alive).toBeGreaterThan(0);
    for (let k = 0; k < alive; k++) {
      const entity = runA.ecs.entities.aliveIds[k];
      expect(culturalStateOf(runB, entity)).toBe(culturalStateOf(runA, entity));
    }
    // Not a degenerate "nobody knows anything" run.
    const holders = runA.ecs.culturalMemory.carrierIds().length;
    expect(holders).toBeGreaterThan(1);
  }, 120_000);

  it('marks the cultural state in a new save format version', () => {
    // The cultural stores and the `culture` RNG stream are part of the save, and
    // the snapshot gained the culture block: both versions moved to 5.
    expect(SAVE_FORMAT_VERSION).toBe(5);
    expect(SNAPSHOT_FORMAT_VERSION).toBe(5);
  });

  it('continues identically after save and load', () => {
    const straight = Simulation.create(SEED, cloneConfig(DEFAULT_SIMULATION_CONFIG));
    for (let i = 0; i < TICKS; i++) {
      straight.step();
      straight.events.drain(100_000);
    }

    const interrupted = Simulation.create(SEED, cloneConfig(DEFAULT_SIMULATION_CONFIG));
    const half = Math.floor(TICKS / 2);
    for (let i = 0; i < half; i++) {
      interrupted.step();
      interrupted.events.drain(100_000);
    }
    const saved = serializeSimulation(interrupted);
    // The save really carries the cultural state: knowledge, associations, the
    // culture counters and the dedicated RNG stream.
    expect(saved.rng.culture).toBeDefined();
    expect(saved.cultureStats).toBeDefined();

    const restored = deserializeSimulation(saved);
    for (let i = half; i < TICKS; i++) {
      restored.step();
      restored.events.drain(100_000);
    }

    expect(canonicalJson(serializeSimulation(restored))).toBe(canonicalJson(serializeSimulation(straight)));
    expect(restored.cultureStats).toEqual(straight.cultureStats);
    expect(restored.ecs.culturalMemory.serialize()).toEqual(straight.ecs.culturalMemory.serialize());
    expect(restored.ecs.signals.serialize()).toEqual(straight.ecs.signals.serialize());
  }, 120_000);

  it('evolves differently under a different seed', () => {
    const runA = Simulation.create(SEED, cloneConfig(DEFAULT_SIMULATION_CONFIG));
    const runB = Simulation.create(SEED + 1, cloneConfig(DEFAULT_SIMULATION_CONFIG));
    for (let i = 0; i < TICKS; i++) {
      runA.step();
      runB.step();
      runA.events.drain(100_000);
      runB.events.drain(100_000);
    }
    expect(canonicalJson(serializeSimulation(runA))).not.toBe(canonicalJson(serializeSimulation(runB)));
  }, 120_000);
});

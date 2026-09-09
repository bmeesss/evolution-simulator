/**
 * Save-state serialization.
 *
 * The save format captures EVERYTHING needed to resume a run bit-for-bit:
 * world tiles, all component stores, RNG stream states and the tick counter.
 * `deserializeSimulation(serializeSimulation(sim))` followed by the same tick
 * sequence must reproduce identical state — this is enforced by tests and by
 * the in-worker determinism self-check.
 *
 * Phase 1 keeps the format as plain JSON (number arrays). It is deliberately
 * versioned so later phases can compact it (binary payloads, chunking) without
 * ambiguity about what produced a given save.
 */

import { Simulation, World } from '../simulation-core';
import type { SimulationConfig } from '../simulation-core';
import type { RngState, SerializedEcs, SerializedWorld } from '../simulation-core';

/**
 * Save format version. Bumped for Phase 2 (2): the layout now includes the AI
 * RNG stream, the memory + aiState stores, the world's resource-cap arrays and
 * the new ai/memory/resources config sections. Version 1 saves are no longer
 * loadable (the new sections are required).
 */
export const SAVE_FORMAT_VERSION = 2;

export interface SimulationSaveState {
  readonly version: number;
  readonly seed: number;
  readonly tick: number;
  readonly config: SimulationConfig;
  readonly rng: { sim: RngState; spawn: RngState; ai: RngState };
  readonly world: SerializedWorld;
  readonly ecs: SerializedEcs;
}

export function serializeSimulation(sim: Simulation): SimulationSaveState {
  return {
    version: SAVE_FORMAT_VERSION,
    seed: sim.seed,
    tick: sim.tick,
    config: sim.config,
    rng: sim.getRngStates(),
    world: sim.world.serialize(),
    ecs: sim.ecs.serialize(),
  };
}

export function deserializeSimulation(save: SimulationSaveState): Simulation {
  if (save.version !== SAVE_FORMAT_VERSION) {
    throw new Error(`Unsupported save version ${save.version} (expected ${SAVE_FORMAT_VERSION})`);
  }
  if (!Number.isInteger(save.tick) || save.tick < 0) {
    throw new Error(`Invalid tick in save: ${save.tick}`);
  }
  return Simulation.restore({
    seed: save.seed,
    config: save.config,
    world: World.fromArrays(save.world),
    tickCount: save.tick,
    rngStates: save.rng,
    ecs: save.ecs,
  });
}

/**
 * Canonical JSON: like JSON.stringify but with object keys sorted everywhere.
 * WHY: object key order in JS is insertion-ordered and therefore run-dependent
 * when objects are built by different code paths — sorting removes that source
 * of false mismatches when comparing two serialized states for determinism.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

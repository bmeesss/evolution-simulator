/**
 * Automated determinism verification routine.
 *
 * Runs inside the worker (or in tests) and proves the two core guarantees:
 *   1. same seed + same number of ticks -> bit-identical state
 *   2. save -> load -> continue == one uninterrupted run
 *
 * It creates throwaway Simulation instances seeded from the same root seed, so
 * it never disturbs the live simulation's RNG streams.
 */

import { Simulation } from '../simulation-core';
import type { SimulationConfig } from '../simulation-core';
import { DEFAULT_SIMULATION_CONFIG } from '../simulation-core';
import { canonicalJson, deserializeSimulation, serializeSimulation } from './serialization';

export interface DeterminismCheckResult {
  readonly seed: number;
  readonly ticks: number;
  /** Two independent runs of `ticks` from the same seed produced identical state. */
  readonly sameSeedMatch: boolean;
  /** save@half-way + restore + continue === one straight run of `ticks`. */
  readonly restoreContinuationMatch: boolean;
}

function runTicks(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.step();
}

export function runDeterminismCheck(
  seed: number,
  ticks: number = 500,
  config: SimulationConfig = DEFAULT_SIMULATION_CONFIG,
): DeterminismCheckResult {
  // 1. Two independent runs from the same seed must match exactly.
  const runA = Simulation.create(seed, config);
  const runB = Simulation.create(seed, config);
  runTicks(runA, ticks);
  runTicks(runB, ticks);
  const sameSeedMatch = canonicalJson(serializeSimulation(runA)) === canonicalJson(serializeSimulation(runB));

  // 2. A run interrupted by save/load at the halfway point must match a
  //    straight run (world, entities, needs, genome, RNG state, tick).
  const straight = Simulation.create(seed, config);
  runTicks(straight, ticks);
  const interrupted = Simulation.create(seed, config);
  runTicks(interrupted, Math.floor(ticks / 2));
  const restored = deserializeSimulation(serializeSimulation(interrupted));
  runTicks(restored, ticks - Math.floor(ticks / 2));
  const restoreContinuationMatch =
    canonicalJson(serializeSimulation(straight)) === canonicalJson(serializeSimulation(restored));

  return { seed, ticks, sameSeedMatch, restoreContinuationMatch };
}

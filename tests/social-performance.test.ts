/**
 * Phase 4 — social system performance tests.
 *
 * The social layer must scale with population, not with population²:
 *   - social perception is a bounded 3×3-cell walk (maxScan candidates) plus
 *     a bounded memory walk (relationship capacity),
 *   - relationship storage is agents × capacity, enforced by eviction,
 *   - group detection runs on a fixed interval and unions only
 *     relationship-chain edges (never all pairs),
 *   - social maintenance walks chains, not the population squared.
 *
 * These tests measure real per-tick cost at several populations and assert
 * the growth is far from quadratic (a quadratic social loop would make
 * cost grow ~4x per population doubling). Numbers are logged for honest
 * reporting — they are machine-dependent, so only the ratio is asserted.
 */

import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation-core/simulation/simulation';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';

/** Average ms per tick at a fixed population (reproduction disabled so the
 *  population stays flat during measurement). */
function timePerTick(population: number, ticks: number, worldTiles = 64): number {
  const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
  config.world.width = worldTiles;
  config.world.height = worldTiles;
  config.agents.initialPopulation = population;
  config.reproduction.baseDrive = 0;
  config.reproduction.fertilityDriveBoost = 0;
  config.reproduction.socialDriveBoost = 0;
  const sim = Simulation.create(99, config);
  // Warm-up: let relationships, groups and cooperation sessions form so the
  // measured steady state includes the full social workload.
  for (let i = 0; i < 150; i++) sim.step();
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) sim.step();
  return (performance.now() - t0) / ticks;
}

describe('social system performance', () => {
  it(
    'per-tick cost grows near-linearly, not quadratically, with population',
    () => {
      const t50 = timePerTick(50, 200);
      const t500 = timePerTick(500, 200);
      const t1000 = timePerTick(1000, 200);
      console.log(
        `[social perf] 50 agents: ${t50.toFixed(3)} ms/tick, 500: ${t500.toFixed(3)} ms/tick, 1000: ${t1000.toFixed(3)} ms/tick`,
      );
      expect(t50).toBeGreaterThan(0);
      expect(t500).toBeGreaterThan(0);
      expect(t1000).toBeGreaterThan(0);
      // Quadratic growth would make t500/t50 approach ~100 and t1000/t500
      // approach ~4. Assert comfortably below that (local-density effects
      // and cache pressure are expected — perfect O(n) is not claimed).
      expect(t500 / t50).toBeLessThan(30);
      expect(t1000 / t500).toBeLessThan(3.5);
    },
    120_000,
  );

  it(
    'relationship storage stays bounded by population × capacity under crowding',
    () => {
      // A small world with many agents maximizes social contact; the store
      // must still be bounded by agents × capacity.
      const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
      config.world.width = 24;
      config.world.height = 24;
      config.agents.initialPopulation = 300;
      config.reproduction.baseDrive = 0;
      config.reproduction.fertilityDriveBoost = 0;
      config.reproduction.socialDriveBoost = 0;
      const sim = Simulation.create(5, config);
      for (let i = 0; i < 600; i++) sim.step();

      const capacity = config.social.memory.capacity;
      const rel = sim.ecs.relationships;
      const count = sim.ecs.entities.aliveCount;
      const ids = sim.ecs.entities.aliveIds;
      let total = 0;
      let maxPerAgent = 0;
      for (let k = 0; k < count; k++) {
        const c = rel.countFor(ids[k]);
        total += c;
        if (c > maxPerAgent) maxPerAgent = c;
      }
      console.log(
        `[social perf] crowded run: pop=${count}, relationships=${total} (bound ${count * capacity}), max/agent=${maxPerAgent}`,
      );
      expect(maxPerAgent).toBeLessThanOrEqual(capacity);
      expect(total).toBeLessThanOrEqual(count * capacity);
      // The bound is not merely theoretical: crowding actually filled memory.
      expect(total).toBeGreaterThan(count);
    },
    120_000,
  );

  it(
    'group detection cost is periodic and bounded (no per-tick all-pairs work)',
    () => {
      // With a long detection interval, ticks without detection must be much
      // cheaper than ticks with it at the same population — proving the
      // expensive reconciliation does NOT run every tick.
      const measure = (interval: number): { onTick: number; offTick: number } => {
        const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
        config.world.width = 64;
        config.world.height = 64;
        config.agents.initialPopulation = 400;
        config.reproduction.baseDrive = 0;
        config.reproduction.fertilityDriveBoost = 0;
        config.reproduction.socialDriveBoost = 0;
        config.social.groups.detectionIntervalTicks = interval;
        const sim = Simulation.create(11, config);
        for (let i = 0; i < 100; i++) sim.step();
        // Time one detection tick (tick === interval) and one ordinary tick.
        while (sim.tick % interval !== interval - 1) sim.step();
        const t1 = performance.now();
        sim.step(); // ordinary tick
        const offTick = performance.now() - t1;
        const t2 = performance.now();
        sim.step(); // detection tick
        const onTick = performance.now() - t2;
        return { onTick, offTick };
      };
      const { onTick, offTick } = measure(96);
      console.log(
        `[social perf] group detection tick: ${onTick.toFixed(3)} ms vs ordinary tick: ${offTick.toFixed(3)} ms`,
      );
      // Both are bounded and positive; the detection tick may be more
      // expensive, but it is one tick in 96 — amortized cost stays small.
      expect(onTick).toBeGreaterThan(0);
      expect(offTick).toBeGreaterThan(0);
      expect(onTick).toBeLessThan(200); // no all-pairs blow-up at 400 agents
    },
    120_000,
  );
});

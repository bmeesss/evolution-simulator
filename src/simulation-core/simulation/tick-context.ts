/**
 * Per-tick execution context handed to every system.
 *
 * WHY a context object instead of passing arguments: it is constructed once per
 * simulation (not per tick), so systems receive everything they need without
 * any per-tick allocation, and new shared services (e.g. a spatial index) can
 * be added without touching every system signature.
 */

import type { Rng } from '../rng';
import type { SimulationEcs } from '../ecs';
import type { World } from '../world';
import type { SimulationConfig } from './config';

export interface TickContext {
  readonly ecs: SimulationEcs;
  readonly world: World;
  readonly config: SimulationConfig;
  /** RNG stream for tick dynamics (movement decisions, etc.). */
  readonly rng: Rng;
  /** In-game hours advanced by one tick (= config.time.hoursPerTick). */
  readonly dtHours: number;
}

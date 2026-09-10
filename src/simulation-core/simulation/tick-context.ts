/**
 * Per-tick execution context handed to every system.
 *
 * WHY a context object instead of passing arguments: it is constructed once per
 * simulation (not per tick), so systems receive everything they need without
 * any per-tick allocation, and new shared services (e.g. the spatial index)
 * can be added without touching every system signature.
 *
 * `tick` is the ONLY mutable field: it is updated at the start of each step so
 * systems that stamp state (memory recency) or emit events use the tick being
 * processed. Everything else is fixed for the simulation's lifetime.
 */

import type { Rng } from '../rng';
import type { SimulationEcs } from '../ecs';
import type { World } from '../world';
import type { SimulationConfig } from './config';
import type { ResourceIndex, AgentIndex } from '../ai/perception';
import type { EventLog } from '../events';
import type { GroupRegistry, SocialStats } from '../social';
import type { CultureStats } from '../culture';

export interface TickContext {
  readonly ecs: SimulationEcs;
  readonly world: World;
  readonly config: SimulationConfig;
  readonly events: EventLog;
  /** RNG stream for non-AI tick dynamics (reserved; unused in phase 2). */
  readonly rng: Rng;
  /** Dedicated RNG stream for AI decisions (tie-breaks, explore targets). */
  readonly aiRng: Rng;
  /** Dedicated RNG stream for reproduction (sex, crossover, mutation, births). */
  readonly reproRng: Rng;
  /**
   * Dedicated RNG stream for the cultural layer (Phase 5): transmission rolls,
   * drift/variant offsets, signal invention and misperception. Keeping it
   * separate means culture never shifts the sim/spawn/ai/repro streams.
   */
  readonly cultureRng: Rng;
  /** World-grid spatial lookup rebuilt each tick (see ai/perception). */
  readonly resourceIndex: ResourceIndex;
  /** World-grid spatial lookup for agents rebuilt each tick (partner search). */
  readonly agentIndex: AgentIndex;
  /** World-grid spatial lookup for agents within social perception (Phase 4). */
  readonly socialIndex: AgentIndex;
  /** Emergent group registry — derived social communities (Phase 4). */
  readonly groups: GroupRegistry;
  /** Cumulative social counters (Phase 4). */
  readonly socialStats: SocialStats;
  /** Cumulative cultural counters (Phase 5). */
  readonly cultureStats: CultureStats;
  /** In-game hours advanced by one tick (= config.time.hoursPerTick). */
  readonly dtHours: number;
  /** Tick currently being processed (updated at the start of every step). */
  tick: number;
}

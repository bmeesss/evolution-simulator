/**
 * Simulation event log.
 *
 * Every event is stamped with the simulation tick (and in-game time) at which
 * it occurred. The log serves two consumers:
 *   1. the UI event feed — the worker drains pending events into snapshots
 *   2. future historical/analytics systems — the bounded `recent()` history
 *
 * Phase 1 keeps a small bounded ring; full history persistence is a later
 * phase. Events are rare (spawn/pause/...), so plain objects are fine here —
 * this is NOT a hot loop.
 */

import type { EntityId } from '../ecs';

export type SimulationEventType =
  | 'simulation_started'
  | 'simulation_reinitialized'
  | 'simulation_paused'
  | 'simulation_resumed'
  | 'speed_changed'
  | 'agent_spawned'
  | 'agent_ate'
  | 'agent_drank'
  | 'agent_died'
  | 'agent_learned'
  | 'resource_depleted'
  // Phase 3 — reproduction & evolution.
  | 'reproduction_attempted'
  | 'reproduction_success'
  | 'birth'
  | 'mutation'
  | 'old_age_death'
  // Phase 4 — social evolution. Relationship-change events fire on threshold
  // crossings (not every tick); resentment fires when blame first pushes a
  // relationship into genuine hostility; group events fire only on the
  // periodic detection runs.
  | 'social_interaction'
  | 'relationship_changed'
  | 'resentment'
  | 'helped_agent'
  | 'cooperation_started'
  | 'cooperation_completed'
  | 'conflict'
  | 'group_created'
  | 'group_joined'
  | 'group_left'
  | 'group_split'
  | 'group_merged'
  // Phase 5 — culture & proto-communication. All of these fire on genuine
  // transmission/loss events (never per tick): a discovery, a successful
  // teaching, an observed learning, a forgotten item, a signal that actually
  // reached a listener, a first-time meaning association, a drift variant and
  // a norm acquisition. Volume is bounded by the cooldowns and the slow decay
  // rates, never by event throttling.
  | 'knowledge_discovered'
  | 'knowledge_taught'
  | 'knowledge_learned'
  | 'knowledge_lost'
  | 'signal_emitted'
  | 'signal_learned'
  | 'cultural_variant_created'
  | 'norm_learned';

export interface SimulationEvent {
  readonly type: SimulationEventType;
  readonly tick: number;
  readonly timeHours: number;
  readonly entityId?: EntityId;
  /** Group the event refers to, when applicable (Phase 4 group events). */
  readonly groupId?: number;
  /** Short human-readable detail for the UI feed (structured payloads come later). */
  readonly detail?: string;
}

export interface EventTimeSource {
  readonly tick: number;
  readonly timeHours: number;
}

/** Default bounded capacity of the retained event history. */
export const DEFAULT_EVENT_LOG_CAPACITY = 500;

export class EventLog {
  private readonly capacity: number;
  private readonly entries: SimulationEvent[] = [];
  /** Index of the first entry not yet drained into a snapshot. */
  private drainIndex = 0;
  private readonly getTime: () => EventTimeSource;

  constructor(getTime: () => EventTimeSource, capacity: number = DEFAULT_EVENT_LOG_CAPACITY) {
    if (capacity < 1) throw new Error('EventLog: capacity must be >= 1');
    this.capacity = capacity;
    this.getTime = getTime;
  }

  /** Record an event, stamped with the current simulation tick/time. */
  record(
    type: SimulationEventType,
    extras: { entityId?: EntityId; groupId?: number; detail?: string } = {},
  ): void {
    const time = this.getTime();
    this.entries.push({ type, tick: time.tick, timeHours: time.timeHours, ...extras });
    if (this.entries.length > this.capacity) {
      const dropped = this.entries.length - this.capacity;
      this.entries.splice(0, dropped);
      this.drainIndex = Math.max(0, this.drainIndex - dropped);
    }
  }

  /** Take up to `max` events recorded since the last drain (for snapshots). */
  drain(max: number): SimulationEvent[] {
    const from = Math.min(this.drainIndex, this.entries.length);
    const out = this.entries.slice(from, from + max);
    this.drainIndex = from + out.length;
    return out;
  }

  /** Most recent events, oldest first (bounded history). */
  recent(count: number): SimulationEvent[] {
    const from = Math.max(0, this.entries.length - count);
    return this.entries.slice(from);
  }

  get length(): number {
    return this.entries.length;
  }
}

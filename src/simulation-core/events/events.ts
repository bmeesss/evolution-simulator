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
  | 'agent_spawned';

export interface SimulationEvent {
  readonly type: SimulationEventType;
  readonly tick: number;
  readonly timeHours: number;
  readonly entityId?: EntityId;
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
  record(type: SimulationEventType, extras: { entityId?: EntityId; detail?: string } = {}): void {
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

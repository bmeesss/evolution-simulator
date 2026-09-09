/**
 * MemoryStore — per-agent, bounded, variable-length memory of resource
 * locations.
 *
 * Memory does NOT fit the generic fixed-column ComponentStore (entries per
 * agent vary from 0 up to a configurable capacity), so it gets its own
 * dedicated store type — exactly the "arena/offset scheme" the ECS notes
 * recommend for variable-length data. It lives beside the ComponentStores on
 * SimulationEcs and participates in serialization.
 *
 * Storage model (all flat typed arrays, zero per-tick allocation once grown):
 *   - per-entity sparse index (grows with entity IDs): `head` (first entry)
 *     and `count` (number of entries) — indexed by entity id, -1/0 when empty.
 *   - an arena of entries: `resourceType`, `x`, `y`, `value`,
 *     `lastObservedTick`, plus `next` linking each agent's entries into a
 *     chain. Freed entries join a free-list (`freeHead` / `freeNext`) and are
 *     reused, so repeated learn/forget churn never grows the arena unbounded.
 *
 * Capacity is bounded per agent (config.memory.capacity): adding beyond it
 * evicts the entry the agent values least (deterministic: earliest chain link
 * breaks ties). Memory only grows while the population grows; it never leaks.
 *
 * Determinism: every mutation is a pure function of simulation state, and all
 * iteration follows fixed orders (entity id order via the registry, chain
 * order via insertion). No randomness lives here.
 */

import type { EntityId } from '../../ecs';

export const ResourceType = {
  Food: 0,
  Water: 1,
} as const;

export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

/** A single remembered location (plain-data shape used for serialization). */
export interface MemoryEntryData {
  readonly resourceType: ResourceType;
  readonly x: number;
  readonly y: number;
  readonly value: number; // remembered usefulness in [0, 1]
  readonly lastObservedTick: number;
}

export interface SerializedMemoryStore {
  /** Entity IDs with at least one entry, in deterministic order. */
  entities: number[];
  /** Entries per entity, parallel to `entities` (chain order). */
  entries: MemoryEntryData[][];
}

const MIN_ARENA_CAPACITY = 16;
const MIN_INDEX_CAPACITY = 64;

export class MemoryStore {
  readonly name = 'memory';
  private readonly capacityPerAgent: number;

  // Sparse per-entity index (entity id -> arena chain), grown on demand.
  private head: Int32Array;
  private count: Int32Array;

  // Arena columns, indexed by entry slot.
  private resourceType: Uint8Array;
  private x: Float32Array;
  private y: Float32Array;
  private value: Float32Array;
  private lastObservedTick: Uint32Array;
  /** entry slot -> next entry in the same agent's chain, or -1. */
  private next: Int32Array;

  // Free-list of reusable arena slots (stack).
  private freeHead: Int32Array;
  private freeCount = 0;
  /** High-water mark of arena slots ever handed out (live + freed). */
  private liveCount = 0;

  /** Entity IDs that currently hold >= 1 entry (serialization order). */
  private memoryEntities: number[] = [];

  constructor(capacityPerAgent: number) {
    if (capacityPerAgent < 1) {
      throw new Error('MemoryStore: capacityPerAgent must be >= 1');
    }
    this.capacityPerAgent = capacityPerAgent;
    this.head = new Int32Array(MIN_INDEX_CAPACITY).fill(-1);
    this.count = new Int32Array(MIN_INDEX_CAPACITY);
    this.resourceType = new Uint8Array(MIN_ARENA_CAPACITY);
    this.x = new Float32Array(MIN_ARENA_CAPACITY);
    this.y = new Float32Array(MIN_ARENA_CAPACITY);
    this.value = new Float32Array(MIN_ARENA_CAPACITY);
    this.lastObservedTick = new Uint32Array(MIN_ARENA_CAPACITY);
    this.next = new Int32Array(MIN_ARENA_CAPACITY);
    this.freeHead = new Int32Array(MIN_ARENA_CAPACITY);
  }

  /** Number of entries the agent currently remembers. */
  countFor(entity: EntityId): number {
    return entity >= 0 && entity < this.count.length ? this.count[entity] : 0;
  }

  has(entity: EntityId): boolean {
    return this.countFor(entity) > 0;
  }

  /** Raw chain head for an entity (for hot-loop iteration; -1 = empty). */
  headOf(entity: EntityId): number {
    return entity >= 0 && entity < this.head.length ? this.head[entity] : -1;
  }

  /** Entry -> next entry in the same agent's chain (-1 ends the chain). */
  nextOf(entry: number): number {
    return this.next[entry];
  }

  /** Read-only accessors for arena columns (hot loops iterate chains directly). */
  entryResourceType(entry: number): number {
    return this.resourceType[entry];
  }
  entryX(entry: number): number {
    return this.x[entry];
  }
  entryY(entry: number): number {
    return this.y[entry];
  }
  entryValue(entry: number): number {
    return this.value[entry];
  }
  entryLastObservedTick(entry: number): number {
    return this.lastObservedTick[entry];
  }

  /** Overwrite an entry's remembered value (used by the decay/forget pass). */
  setEntryValue(entry: number, nextValue: number): void {
    this.value[entry] = nextValue;
  }

  /** Arena slot of an entity's entry for (resourceType, x, y), or -1. */
  find(entity: EntityId, resourceType: ResourceType, x: number, y: number): number {
    for (let e = this.headOf(entity); e !== -1; e = this.next[e]) {
      if (this.resourceType[e] === resourceType && this.x[e] === x && this.y[e] === y) {
        return e;
      }
    }
    return -1;
  }

  /**
   * Record an observation: create or update a memory entry for the given
   * resource location. `nextValue` is the new remembered usefulness (already
   * shaped by the learning rules in `learning.ts` — this store only places and
   * bounds data). Returns whether a brand-new entry was created (callers use
   * that to emit `agent_learned`).
   */
  observe(
    entity: EntityId,
    resourceType: ResourceType,
    x: number,
    y: number,
    nextValue: number,
    tick: number,
  ): { created: boolean } {
    this.ensureIndexCapacity(entity);

    // Update an existing entry for the same resource type at the same tile.
    const existing = this.find(entity, resourceType, x, y);
    if (existing !== -1) {
      this.value[existing] = nextValue;
      this.lastObservedTick[existing] = tick;
      return { created: false };
    }

    // New entry: evict the least valuable one if at capacity.
    if (this.count[entity] >= this.capacityPerAgent) {
      this.evictLowest(entity);
    }

    const slot = this.allocateSlot();
    this.resourceType[slot] = resourceType;
    this.x[slot] = x;
    this.y[slot] = y;
    this.value[slot] = nextValue;
    this.lastObservedTick[slot] = tick;
    // Insert at the head (newest first); chain order is deterministic because
    // the sequence of operations is deterministic.
    this.next[slot] = this.head[entity];
    this.head[entity] = slot;
    if (this.count[entity] === 0) {
      this.memoryEntities.push(entity);
    }
    this.count[entity]++;
    return { created: true };
  }

  /**
   * Update an existing entry's value without creating one (used to punish a
   * remembered location that turned out to be depleted). Returns false when the
   * agent had no entry for that location.
   */
  updateExisting(
    entity: EntityId,
    resourceType: ResourceType,
    x: number,
    y: number,
    nextValue: number,
    tick: number,
  ): boolean {
    const existing = this.find(entity, resourceType, x, y);
    if (existing === -1) return false;
    this.value[existing] = nextValue;
    this.lastObservedTick[existing] = tick;
    return true;
  }

  /** Forget everything an entity remembers (called when an agent dies). */
  removeAll(entity: EntityId): void {
    if (!this.has(entity)) return;
    let e = this.head[entity];
    while (e !== -1) {
      const next = this.next[e];
      this.releaseSlot(e);
      e = next;
    }
    this.head[entity] = -1;
    this.count[entity] = 0;
    // Drop the entity from the serialization-order list (swap-remove).
    const idx = this.memoryEntities.indexOf(entity);
    if (idx >= 0) {
      const last = this.memoryEntities.length - 1;
      this.memoryEntities[idx] = this.memoryEntities[last];
      this.memoryEntities.pop();
    }
  }

  /** Delete a single entry (used by the forgetting/decay pass). */
  removeEntry(entity: EntityId, entry: number): void {
    // Unlink from the agent's chain.
    let prev = -1;
    for (let e = this.head[entity]; e !== -1; e = this.next[e]) {
      if (e === entry) {
        if (prev === -1) this.head[entity] = this.next[e];
        else this.next[prev] = this.next[e];
        break;
      }
      prev = e;
    }
    this.releaseSlot(entry);
    this.count[entity]--;
    if (this.count[entity] === 0) {
      this.head[entity] = -1;
      const idx = this.memoryEntities.indexOf(entity);
      if (idx >= 0) {
        const last = this.memoryEntities.length - 1;
        this.memoryEntities[idx] = this.memoryEntities[last];
        this.memoryEntities.pop();
      }
    }
  }

  /** Drop the least valuable entry of an entity (deterministic tie-break). */
  private evictLowest(entity: EntityId): void {
    let worst = this.head[entity];
    if (worst === -1) return;
    let e = this.next[worst];
    while (e !== -1) {
      // Strict `<` keeps the earliest link on ties -> deterministic eviction.
      if (this.value[e] < this.value[worst]) worst = e;
      e = this.next[e];
    }
    this.removeEntry(entity, worst);
  }

  private allocateSlot(): number {
    if (this.freeCount > 0) {
      return this.freeHead[--this.freeCount];
    }
    const slot = this.liveCount++;
    if (slot >= this.next.length) this.growArena();
    return slot;
  }

  private releaseSlot(slot: number): void {
    this.freeHead[this.freeCount++] = slot;
  }

  private growArena(): void {
    const capacity = Math.max(MIN_ARENA_CAPACITY, this.next.length * 2);
    const resourceType = new Uint8Array(capacity);
    resourceType.set(this.resourceType);
    this.resourceType = resourceType;
    const x = new Float32Array(capacity);
    x.set(this.x);
    this.x = x;
    const y = new Float32Array(capacity);
    y.set(this.y);
    this.y = y;
    const value = new Float32Array(capacity);
    value.set(this.value);
    this.value = value;
    const lastObservedTick = new Uint32Array(capacity);
    lastObservedTick.set(this.lastObservedTick);
    this.lastObservedTick = lastObservedTick;
    const next = new Int32Array(capacity);
    next.set(this.next);
    this.next = next;
    const freeHead = new Int32Array(capacity);
    freeHead.set(this.freeHead);
    this.freeHead = freeHead;
  }

  private ensureIndexCapacity(entity: EntityId): void {
    if (entity < this.head.length) return;
    let capacity = this.head.length;
    while (capacity <= entity) capacity *= 2;
    const head = new Int32Array(capacity).fill(-1);
    head.set(this.head);
    this.head = head;
    const count = new Int32Array(capacity);
    count.set(this.count);
    this.count = count;
  }

  serialize(): SerializedMemoryStore {
    const entities: number[] = [];
    const entries: MemoryEntryData[][] = [];
    for (const entity of this.memoryEntities) {
      if (this.count[entity] <= 0) continue;
      entities.push(entity);
      const list: MemoryEntryData[] = [];
      for (let e = this.head[entity]; e !== -1; e = this.next[e]) {
        list.push({
          resourceType: this.resourceType[e] as ResourceType,
          x: this.x[e],
          y: this.y[e],
          value: this.value[e],
          lastObservedTick: this.lastObservedTick[e],
        });
      }
      entries.push(list);
    }
    return { entities, entries };
  }

  restore(saved: SerializedMemoryStore): void {
    // Clear in place (cheap; keeps capacity for reuse). Pop from the tail so
    // removeAll's swap-remove never skips an entry while we drain the list.
    while (this.memoryEntities.length > 0) {
      this.removeAll(this.memoryEntities[this.memoryEntities.length - 1]);
    }
    this.memoryEntities = [];

    for (let i = 0; i < saved.entities.length; i++) {
      const entity = saved.entities[i];
      const list = saved.entries[i];
      // Insert in reverse so the head-first chain ends up in the same order
      // as `list` (observe() pushes to the head).
      for (let j = list.length - 1; j >= 0; j--) {
        const entry = list[j];
        this.observe(entity, entry.resourceType, entry.x, entry.y, entry.value, entry.lastObservedTick);
      }
    }
  }
}

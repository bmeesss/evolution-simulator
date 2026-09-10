/**
 * Per-agent cultural memory — a bounded, sparse, deterministic item store.
 *
 * WHY THIS REPRESENTATION (mirrors the Phase 1 MemoryStore and Phase 4
 * RelationshipStore on purpose, so the codebase has ONE bounded-store pattern):
 *
 *   - Each agent holds at most `capacity` items (default 10). With 1000 agents
 *     that is a hard ceiling of 10 000 items, so cultural memory can never grow
 *     with population × time — no unbounded object graph, no allocation storm.
 *   - Storage is a parallel-column arena (SoA) plus a per-entity head index
 *     with an explicit free list. No per-agent arrays, no per-entry objects, no
 *     Map/Set churn in the hot path: adding an item is a handful of typed-array
 *     writes.
 *   - Chain order is deterministic (newest first, restores replay in reverse),
 *     which matters because iteration order feeds RNG-consuming decisions.
 *   - Eviction is by least strength: when a new item would exceed capacity the
 *     weakest known item is dropped. That is cultural forgetting under
 *     pressure, not a hard failure.
 *
 * PERSONAL vs CULTURAL memory is a deliberate split. The `MemoryStore` records
 * what an agent personally experienced or was told about the environment
 * ("I ate here"); cultural memory records what is *shareable* ("this is the
 * food patch", "this is how we forage here") and carries the transmission
 * metadata (origin, source, reinforce count) that makes teaching, drift and
 * loss meaningful. Keeping them separate is why cultural knowledge can be
 * taught, drift into a variant and be forgotten without corrupting an agent's
 * own episodic experience.
 *
 * Lifecycle: an agent is BORN with an empty store (culture is never inherited
 * through reproduction — see reproduction-system.ts) and everything in it must
 * arrive through the agent's own discovery or through an actual interaction.
 */

import type { EntityId } from '../ecs';
import { clamp01 } from '../ai/utility';
import { knowledgeKey, sameKnowledge } from './knowledge';

/** One stored cultural item, as exposed to consumers (read-only snapshot view). */
export interface CulturalKnowledgeData {
  readonly type: number;
  /** Tile the knowledge refers to, or -1 for location-independent knowledge. */
  readonly tileX: number;
  readonly tileY: number;
  /** Technique/norm variant id; 0 for location items. */
  readonly variantId: number;
  /** Confidence in the item, [0, 1]: strengthened by use, eroded by decay. */
  readonly strength: number;
  /** How the agent came to hold it (KnowledgeOrigin). */
  readonly origin: number;
  /** Entity that transmitted it, or -1 when the agent found it itself. */
  readonly sourceEntity: number;
  readonly learnedTick: number;
  readonly lastReinforcedTick: number;
  /** Successful uses/teachings/reinforcements (capped at 65535). */
  readonly reinforceCount: number;
}

/** Serialized form (plain arrays; the save format's storage-independent shape). */
export interface SerializedCulturalMemoryStore {
  readonly entities: number[];
  readonly entries: CulturalKnowledgeData[][];
}

const DEFAULT_CAPACITY = 10;

export class CulturalMemoryStore {
  /** Store key inside a serialized ECS save (stable: part of the save format). */
  readonly name = 'culturalMemory';
  private capacity: number;
  /** Parallel columns (structure of arrays). */
  private type: Int32Array;
  private tileX: Int32Array;
  private tileY: Int32Array;
  private variantId: Int32Array;
  private strength: Float32Array;
  private origin: Uint8Array;
  private sourceEntity: Int32Array;
  private learnedTick: Uint32Array;
  private lastReinforcedTick: Uint32Array;
  private reinforceCount: Uint16Array;
  /** Next entry in an agent's chain (-1 = end). */
  private next: Int32Array;
  /** Entity id per slot (-1 = free). */
  private owner: Int32Array;

  /** Sparse per-entity index: head slot and item count. */
  private head: Int32Array;
  private count: Uint16Array;
  /** Entities that currently hold at least one item (in carrier order). */
  private readonly carriers: EntityId[] = [];
  private readonly carrierSlots = new Map<EntityId, number>();

  private freeHead = -1;
  private usedSlots = 0;

  constructor(capacityPerAgent: number = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacityPerAgent) || capacityPerAgent < 1) {
      throw new Error('CulturalMemoryStore: capacity must be >= 1');
    }
    this.capacity = capacityPerAgent;
    const initial = 64;
    this.type = new Int32Array(initial);
    this.tileX = new Int32Array(initial);
    this.tileY = new Int32Array(initial);
    this.variantId = new Int32Array(initial);
    this.strength = new Float32Array(initial);
    this.origin = new Uint8Array(initial);
    this.sourceEntity = new Int32Array(initial);
    this.learnedTick = new Uint32Array(initial);
    this.lastReinforcedTick = new Uint32Array(initial);
    this.reinforceCount = new Uint16Array(initial);
    // -1 = free / end-of-chain (see the head comment above).
    this.next = new Int32Array(initial).fill(-1);
    this.owner = new Int32Array(initial).fill(-1);
    // -1 = "no chain": every unallocated index must read as empty, otherwise
    // headOf() would hand out slot 0 as a phantom entry.
    this.head = new Int32Array(1).fill(-1);
    this.count = new Uint16Array(1);
  }

  // --- Read-only accessors -------------------------------------------------

  /** Number of items this agent holds. */
  countFor(entity: EntityId): number {
    return entity < this.count.length ? this.count[entity] : 0;
  }

  has(entity: EntityId): boolean {
    return this.countFor(entity) > 0;
  }

  /** First entry of an agent's chain, or -1 when empty. */
  headOf(entity: EntityId): number {
    return entity < this.head.length ? this.head[entity] : -1;
  }

  nextOf(entry: number): number {
    return this.next[entry];
  }

  entryType(entry: number): number {
    return this.type[entry];
  }

  entryTileX(entry: number): number {
    return this.tileX[entry];
  }

  entryTileY(entry: number): number {
    return this.tileY[entry];
  }

  entryVariant(entry: number): number {
    return this.variantId[entry];
  }

  entryStrength(entry: number): number {
    return this.strength[entry];
  }

  entryOrigin(entry: number): number {
    return this.origin[entry];
  }

  entrySource(entry: number): number {
    return this.sourceEntity[entry];
  }

  entryLearnedTick(entry: number): number {
    return this.learnedTick[entry];
  }

  entryLastReinforcedTick(entry: number): number {
    return this.lastReinforcedTick[entry];
  }

  entryReinforceCount(entry: number): number {
    return this.reinforceCount[entry];
  }

  /** Compact numeric identity of an entry (aggregation helper). */
  entryKey(entry: number): number {
    return knowledgeKey(this.type[entry], this.tileX[entry], this.tileY[entry], this.variantId[entry]);
  }

  /** Entities currently holding at least one item (deterministic carrier order). */
  carrierIds(): readonly EntityId[] {
    return this.carriers;
  }

  // --- Lookup ---------------------------------------------------------------

  /**
   * Entry index for an exact item, or -1. Chains are short (<= capacity) so a
   * linear walk is the right structure — no hashing needed.
   */
  find(entity: EntityId, type: number, tileX: number, tileY: number, variantId: number): number {
    for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
      if (
        sameKnowledge(
          this.type[entry],
          this.tileX[entry],
          this.tileY[entry],
          this.variantId[entry],
          type,
          tileX,
          tileY,
          variantId,
        )
      ) {
        return entry;
      }
    }
    return -1;
  }

  /** Strength of an exact item, or 0 when the agent does not hold it. */
  strengthOf(entity: EntityId, type: number, tileX: number, tileY: number, variantId: number): number {
    const entry = this.find(entity, type, tileX, tileY, variantId);
    return entry === -1 ? 0 : this.strength[entry];
  }

  /** Strongest item of a type; variant is -1 when the agent holds none. */
  bestOfType(entity: EntityId, type: number): { strength: number; variant: number; tileX: number; tileY: number } {
    let bestStrength = 0;
    let variant = -1;
    let tileX = -1;
    let tileY = -1;
    for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
      if (this.type[entry] !== type) continue;
      if (this.strength[entry] > bestStrength) {
        bestStrength = this.strength[entry];
        variant = this.variantId[entry];
        tileX = this.tileX[entry];
        tileY = this.tileY[entry];
      }
    }
    return { strength: bestStrength, variant, tileX, tileY };
  }

  /** Best strength across all items of a type (0 when none). */
  bestStrengthOfType(entity: EntityId, type: number): number {
    return this.bestOfType(entity, type).strength;
  }

  /** Total strength summed over every item — a cheap "how cultured is this agent". */
  totalStrength(entity: EntityId): number {
    let total = 0;
    for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) total += this.strength[entry];
    return total;
  }

  /** Number of entries of a given type (norms are looked up this way). */
  countOfType(entity: EntityId, type: number): number {
    let total = 0;
    for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
      if (this.type[entry] === type) total++;
    }
    return total;
  }

  // --- Mutation -------------------------------------------------------------

  /**
   * Add or refresh an item. Returns the arena slot and whether a new item was
   * created. An equal item (same type/location/variant) is refreshed in place —
   * re-learning something you already know does not consume a second slot; it
   * raises the stored strength to at least `strength` and bumps the reinforce
   * count (that is what makes repeated exposure strengthen knowledge).
   */
  learn(
    entity: EntityId,
    item: Omit<CulturalKnowledgeData, 'learnedTick' | 'lastReinforcedTick' | 'reinforceCount'>,
    tick: number,
  ): { entry: number; created: boolean } {
    this.ensureIndexCapacity(entity);
    const existing = this.find(entity, item.type, item.tileX, item.tileY, item.variantId);
    if (existing !== -1) {
      if (item.strength > this.strength[existing]) this.strength[existing] = clamp01(item.strength);
      this.lastReinforcedTick[existing] = tick;
      if (this.reinforceCount[existing] < 65535) this.reinforceCount[existing]++;
      return { entry: existing, created: false };
    }

    if (this.count[entity] >= this.capacity) {
      this.evictWeakest(entity);
    }
    const slot = this.allocateSlot();
    this.owner[slot] = entity;
    this.type[slot] = item.type;
    this.tileX[slot] = item.tileX;
    this.tileY[slot] = item.tileY;
    this.variantId[slot] = item.variantId;
    this.strength[slot] = clamp01(item.strength);
    this.origin[slot] = item.origin;
    this.sourceEntity[slot] = item.sourceEntity;
    this.learnedTick[slot] = tick;
    this.lastReinforcedTick[slot] = tick;
    this.reinforceCount[slot] = 0;
    // Newest first; chain order stays deterministic because the sequence of
    // operations is deterministic.
    this.next[slot] = this.head[entity];
    this.head[entity] = slot;
    if (this.count[entity] === 0) {
      // Register the carrier so removal can swap it out in O(1).
      this.carrierSlots.set(entity, this.carriers.length);
      this.carriers.push(entity);
    }
    this.count[entity]++;
    return { entry: slot, created: true };
  }

  /** Successful use/teaching: move strength toward 1 (rate comes from config). */
  reinforce(entry: number, rate: number, tick: number): void {
    const r = clamp01(rate);
    this.strength[entry] = Math.min(1, this.strength[entry] + r * (1 - this.strength[entry]));
    this.lastReinforcedTick[entry] = tick;
    if (this.reinforceCount[entry] < 65535) this.reinforceCount[entry]++;
  }

  /** Contradiction (a remembered resource that turned out empty): erode strength. */
  weaken(entry: number, rate: number): void {
    const r = clamp01(rate);
    this.strength[entry] = Math.max(0, this.strength[entry] * (1 - r));
  }

  /** Raw strength write, used by the per-tick decay pass. */
  setStrength(entry: number, value: number): void {
    this.strength[entry] = clamp01(value);
  }

  /** Variant drift: an item's variant shifts to a neighbouring variant. */
  setVariant(entity: EntityId, entry: number, variantId: number): void {
    this.variantId[entry] = variantId;
    const existing = this.find(entity, this.type[entry], this.tileX[entry], this.tileY[entry], variantId);
    // Merging onto an existing identical item would create a duplicate; drop
    // the old slot instead (the drift "collapsed" onto known knowledge).
    if (existing !== -1 && existing !== entry) this.removeEntry(entity, entry);
  }

  /** Forget a single item (decay hit zero, contradiction, eviction, cleanup). */
  removeEntry(entity: EntityId, entry: number): void {
    const owner = this.owner[entry];
    if (owner !== entity) return; // defensive: wrong owner, ignore
    // Unlink from the chain.
    const head = this.head[entity];
    if (head === entry) {
      this.head[entity] = this.next[entry];
    } else {
      let prev = head;
      while (prev !== -1 && this.next[prev] !== entry) prev = this.next[prev];
      if (prev !== -1) this.next[prev] = this.next[entry];
    }
    this.releaseSlot(entry);
    this.count[entity]--;
    if (this.count[entity] === 0) {
      const slot = this.carrierSlots.get(entity);
      if (slot !== undefined) {
        const last = this.carriers.pop() as EntityId;
        if (slot < this.carriers.length) {
          this.carriers[slot] = last;
          this.carrierSlots.set(last, slot);
        }
        this.carrierSlots.delete(entity);
      }
    }
  }

  /** Drop every item an agent holds (death, or a full cultural reset). */
  removeAll(entity: EntityId): void {
    let entry = this.headOf(entity);
    while (entry !== -1) {
      const next = this.next[entry];
      this.releaseSlot(entry);
      entry = next;
    }
    if (entity < this.head.length) {
      this.head[entity] = -1;
      this.count[entity] = 0;
    }
    const slot = this.carrierSlots.get(entity);
    if (slot !== undefined) {
      const last = this.carriers.pop() as EntityId;
      if (slot < this.carriers.length) {
        this.carriers[slot] = last;
        this.carrierSlots.set(last, slot);
      }
      this.carrierSlots.delete(entity);
    }
  }

  /**
   * Evict the agent's weakest item to make room (least strength; ties keep the
   * earliest-inserted item, i.e. the most recently learned of equal strength is
   * dropped — so a "fresher" memory never displaces an equally strong old one
   * unnecessarily). Deterministic by construction.
   */
  evictWeakest(entity: EntityId): void {
    let weakest = -1;
    let weakestStrength = Number.POSITIVE_INFINITY;
    for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
      if (this.strength[entry] < weakestStrength) {
        weakestStrength = this.strength[entry];
        weakest = entry;
      }
    }
    if (weakest !== -1) this.removeEntry(entity, weakest);
  }

  /**
   * Apply a decay rate to every item of every agent and forget anything that
   * fell below `forgetBelow`. Returns the number of items forgotten. Kept in
   * the store so the (bounded) walk happens in one place.
   */
  decayAll(decayPerEntry: (entity: EntityId, entry: number) => number, forgetBelow: number): number {
    let forgotten = 0;
    for (let c = this.carriers.length - 1; c >= 0; c--) {
      const entity = this.carriers[c];
      let entry = this.headOf(entity);
      while (entry !== -1) {
        const next = this.next[entry];
        const decayed = Math.max(0, this.strength[entry] - decayPerEntry(entity, entry));
        if (decayed <= forgetBelow) {
          this.removeEntry(entity, entry);
          forgotten++;
        } else {
          this.strength[entry] = decayed;
        }
        entry = next;
      }
    }
    return forgotten;
  }

  /** Highest strength item held by an agent (0 when empty). */
  maxStrength(entity: EntityId): number {
    let best = 0;
    for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
      if (this.strength[entry] > best) best = this.strength[entry];
    }
    return best;
  }

  // --- Serialization --------------------------------------------------------

  serialize(): SerializedCulturalMemoryStore {
    const entities: number[] = [];
    const entries: CulturalKnowledgeData[][] = [];
    // Deterministic order: the store's carrier list (ascending entity id).
    for (const entity of this.carriers) {
      const list: CulturalKnowledgeData[] = [];
      for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
        list.push({
          type: this.type[entry],
          tileX: this.tileX[entry],
          tileY: this.tileY[entry],
          variantId: this.variantId[entry],
          strength: this.strength[entry],
          origin: this.origin[entry],
          sourceEntity: this.sourceEntity[entry],
          learnedTick: this.learnedTick[entry],
          lastReinforcedTick: this.lastReinforcedTick[entry],
          reinforceCount: this.reinforceCount[entry],
        });
      }
      entities.push(entity);
      entries.push(list);
    }
    return { entities, entries };
  }

  restore(saved: SerializedCulturalMemoryStore): void {
    this.reset();
    for (let i = 0; i < saved.entities.length; i++) {
      const entity = saved.entities[i];
      const items = saved.entries[i] ?? [];
      // Replay in reverse so the chain order after restore matches the saved
      // order (serialize writes head-first; learn() prepends).
      for (let j = items.length - 1; j >= 0; j--) {
        const item = items[j];
        this.learn(
          entity,
          {
            type: item.type,
            tileX: item.tileX,
            tileY: item.tileY,
            variantId: item.variantId,
            strength: item.strength,
            origin: item.origin,
            sourceEntity: item.sourceEntity,
          },
          item.learnedTick,
        );
        const entry = this.find(entity, item.type, item.tileX, item.tileY, item.variantId);
        if (entry !== -1) {
          this.lastReinforcedTick[entry] = item.lastReinforcedTick;
          this.reinforceCount[entry] = item.reinforceCount;
        }
      }
    }
  }

  /** Wipe every entry (used by restore before replaying saved state). */
  reset(): void {
    this.freeHead = -1;
    this.usedSlots = 0;
    this.carriers.length = 0;
    this.carrierSlots.clear();
    this.head.fill(-1);
    this.count.fill(0);
    this.owner.fill(-1);
  }

  // --- Internals ------------------------------------------------------------

  private ensureIndexCapacity(entity: EntityId): void {
    if (entity < this.head.length) return;
    let capacity = Math.max(2, this.head.length);
    while (capacity <= entity) capacity *= 2;
    const head = new Int32Array(capacity).fill(-1);
    head.set(this.head);
    this.head = head;
    const count = new Uint16Array(capacity);
    count.set(this.count);
    this.count = count;
  }

  private allocateSlot(): number {
    if (this.freeHead !== -1) {
      const slot = this.freeHead;
      this.freeHead = this.next[slot];
      return slot;
    }
    if (this.usedSlots === this.owner.length) this.growArena();
    return this.usedSlots++;
  }

  private releaseSlot(slot: number): void {
    this.owner[slot] = -1;
    this.next[slot] = this.freeHead;
    this.freeHead = slot;
  }

  private growArena(): void {
    const capacity = this.owner.length * 2;
    const next = (array: Int32Array): Int32Array => {
      const grown = new Int32Array(capacity).fill(-1);
      grown.set(array);
      return grown;
    };
    this.type = next(this.type);
    this.tileX = next(this.tileX);
    this.tileY = next(this.tileY);
    this.variantId = next(this.variantId);
    this.next = next(this.next);
    this.sourceEntity = next(this.sourceEntity);
    const owner = new Int32Array(capacity).fill(-1);
    owner.set(this.owner);
    this.owner = owner;
    const strength = new Float32Array(capacity);
    strength.set(this.strength);
    this.strength = strength;
    const origin = new Uint8Array(capacity);
    origin.set(this.origin);
    this.origin = origin;
    const learnedTick = new Uint32Array(capacity);
    learnedTick.set(this.learnedTick);
    this.learnedTick = learnedTick;
    const lastReinforcedTick = new Uint32Array(capacity);
    lastReinforcedTick.set(this.lastReinforcedTick);
    this.lastReinforcedTick = lastReinforcedTick;
    const reinforceCount = new Uint16Array(capacity);
    reinforceCount.set(this.reinforceCount);
    this.reinforceCount = reinforceCount;
  }
}

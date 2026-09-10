/**
 * RelationshipStore — per-agent, bounded, sparse social memory (Phase 4).
 *
 * Agents must remember OTHER AGENTS (not resource locations — that is the
 * environmental memory in ai/memory). This store keeps, for every agent, a
 * small chain of directed relationships: how the agent views one specific
 * other agent. Directional on purpose: "B trusts A" is a different fact from
 * "A trusts B", and interactions update both directions with different
 * magnitudes (the core of reciprocity).
 *
 * Storage model (mirrors MemoryStore — the established pattern for bounded
 * variable-length per-agent data):
 *   - per-entity sparse index (`head`) grown with the entity-id space,
 *   - a flat arena of relationship entries with a free-list (`freeHead`),
 *     so churn (creating/forgetting relationships) never grows it unbounded,
 *   - chains linked through `next`, iterated in insertion order.
 *
 * Bounds (config.social.memory):
 *   - capacity per agent (adding beyond it evicts the least valuable entry),
 *   - pruning by the social maintenance system (weak + old + stale entries
 *     are dropped, relationships to dead entities are dropped).
 *
 * Bounded values:
 *   - score: −1 (hostile) … 0 (neutral) … +1 (strong positive)
 *   - trust: 0 … 1
 *   - familiarity: 0 … 1
 *
 * Determinism: no randomness lives here; every mutation is a pure function of
 * the (deterministic) call sequence. Eviction tie-breaks keep the earliest
 * chain entry.
 */

import type { EntityId } from '../ecs';

/** A single directed relationship, as serialized. */
export interface RelationshipData {
  readonly target: EntityId;
  /** Valence in [−1, 1]: hostile … neutral … strong positive. */
  readonly score: number;
  /** Trust in [0, 1]: expected reliability/goodwill of the target. */
  readonly trust: number;
  /** Familiarity in [0, 1]: how well the target is known. */
  readonly familiarity: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly lastInteractionTick: number;
  /** Direct kin (parent/child/sibling) — a bias, never a hard friendship. */
  readonly kin: boolean;
  /** Tick before which no new intense pair interaction (conflict/cooperation). */
  readonly pairCooldownUntil: number;
  /** Earliest tick the pair may resent each other again (competition guard). */
  readonly resentUntil: number;
}

export interface SerializedRelationshipStore {
  /** Entity IDs with at least one relationship, in deterministic order. */
  entities: number[];
  /** Entries per entity, parallel to `entities` (chain order). */
  entries: RelationshipData[][];
}

const MIN_ARENA_CAPACITY = 16;
const MIN_INDEX_CAPACITY = 64;

export class RelationshipStore {
  readonly name = 'relationships';
  private readonly capacityPerAgent: number;

  // Sparse per-entity index (entity id -> arena chain head, -1 = none).
  private head: Int32Array;
  private count: Int32Array;

  // Arena columns (indexed by entry slot).
  private target: Int32Array;
  private score: Float32Array;
  private trust: Float32Array;
  private familiarity: Float32Array;
  private positiveCount: Uint16Array;
  private negativeCount: Uint16Array;
  private lastInteractionTick: Uint32Array;
  private kin: Uint8Array;
  private pairCooldownUntil: Int32Array;
  private resentUntil: Uint32Array;
  private next: Int32Array;

  // Free-list of reusable arena slots (stack).
  private freeHead: Int32Array;
  private freeCount = 0;
  private liveCount = 0;

  /** Entity IDs currently holding >= 1 relationship (serialization order). */
  private socialEntities: number[] = [];

  constructor(capacityPerAgent: number) {
    if (capacityPerAgent < 1) {
      throw new Error('RelationshipStore: capacityPerAgent must be >= 1');
    }
    this.capacityPerAgent = capacityPerAgent;
    this.head = new Int32Array(MIN_INDEX_CAPACITY).fill(-1);
    this.count = new Int32Array(MIN_INDEX_CAPACITY);
    this.target = new Int32Array(MIN_ARENA_CAPACITY).fill(-1);
    this.score = new Float32Array(MIN_ARENA_CAPACITY);
    this.trust = new Float32Array(MIN_ARENA_CAPACITY);
    this.familiarity = new Float32Array(MIN_ARENA_CAPACITY);
    this.positiveCount = new Uint16Array(MIN_ARENA_CAPACITY);
    this.negativeCount = new Uint16Array(MIN_ARENA_CAPACITY);
    this.lastInteractionTick = new Uint32Array(MIN_ARENA_CAPACITY);
    this.kin = new Uint8Array(MIN_ARENA_CAPACITY);
    this.pairCooldownUntil = new Int32Array(MIN_ARENA_CAPACITY);
    this.resentUntil = new Uint32Array(MIN_ARENA_CAPACITY);
    this.next = new Int32Array(MIN_ARENA_CAPACITY).fill(-1);
    this.freeHead = new Int32Array(MIN_ARENA_CAPACITY).fill(-1);
  }

  /** Total number of stored (directed) relationships. */
  get totalEntries(): number {
    let total = 0;
    for (const entity of this.socialEntities) total += this.count[entity];
    return total;
  }

  /** Number of relationships an agent currently remembers. */
  countFor(entity: EntityId): number {
    return entity >= 0 && entity < this.count.length ? this.count[entity] : 0;
  }

  has(entity: EntityId): boolean {
    return this.countFor(entity) > 0;
  }

  /** Chain head for hot-loop iteration (-1 = no relationships). */
  headOf(entity: EntityId): number {
    return entity >= 0 && entity < this.head.length ? this.head[entity] : -1;
  }

  nextOf(entry: number): number {
    return this.next[entry];
  }

  // --- Column accessors (hot loops call these directly) ---------------------

  targetOf(entry: number): EntityId {
    return this.target[entry];
  }
  scoreOf(entry: number): number {
    return this.score[entry];
  }
  trustOf(entry: number): number {
    return this.trust[entry];
  }
  familiarityOf(entry: number): number {
    return this.familiarity[entry];
  }
  positiveCountOf(entry: number): number {
    return this.positiveCount[entry];
  }
  negativeCountOf(entry: number): number {
    return this.negativeCount[entry];
  }
  lastInteractionTickOf(entry: number): number {
    return this.lastInteractionTick[entry];
  }
  kinOf(entry: number): boolean {
    return this.kin[entry] === 1;
  }
  pairCooldownUntilOf(entry: number): number {
    return this.pairCooldownUntil[entry];
  }

  /** Competition-resentment cooldown: no second blame before this tick. */
  resentUntilOf(entry: number): number {
    return this.resentUntil[entry];
  }

  setResentUntil(entry: number, tick: number): void {
    this.resentUntil[entry] = tick;
  }

  setScore(entry: number, value: number): void {
    this.score[entry] = value < -1 ? -1 : value > 1 ? 1 : value;
  }
  setTrust(entry: number, value: number): void {
    this.trust[entry] = value < 0 ? 0 : value > 1 ? 1 : value;
  }
  setFamiliarity(entry: number, value: number): void {
    this.familiarity[entry] = value < 0 ? 0 : value > 1 ? 1 : value;
  }
  setKin(entry: number, value: boolean): void {
    this.kin[entry] = value ? 1 : 0;
  }
  setPairCooldownUntil(entry: number, tick: number): void {
    this.pairCooldownUntil[entry] = tick;
  }
  setLastInteractionTick(entry: number, tick: number): void {
    this.lastInteractionTick[entry] = tick;
  }
  incrementPositive(entry: number): void {
    if (this.positiveCount[entry] < 65535) this.positiveCount[entry]++;
  }
  incrementNegative(entry: number): void {
    if (this.negativeCount[entry] < 65535) this.negativeCount[entry]++;
  }

  /** Arena slot of agent `entity`'s relationship toward `target`, or -1. */
  find(entity: EntityId, target: EntityId): number {
    for (let e = this.headOf(entity); e !== -1; e = this.next[e]) {
      if (this.target[e] === target) return e;
    }
    return -1;
  }

  /**
   * Get (or create) agent `entity`'s relationship toward `target`. Creation
   * evicts the least-valued entry when the agent is at capacity. Returns the
   * arena slot plus whether a brand-new entry was created (used to emit
   * first-contact events).
   */
  getOrCreate(entity: EntityId, target: EntityId, tick: number, kin: boolean): { entry: number; created: boolean } {
    this.ensureIndexCapacity(entity);
    const existing = this.find(entity, target);
    if (existing !== -1) {
      return { entry: existing, created: false };
    }
    if (this.count[entity] >= this.capacityPerAgent) {
      this.evictLeastValued(entity);
    }
    const slot = this.allocateSlot();
    this.target[slot] = target;
    this.score[slot] = 0;
    this.trust[slot] = 0;
    this.familiarity[slot] = 0;
    this.positiveCount[slot] = 0;
    this.negativeCount[slot] = 0;
    this.lastInteractionTick[slot] = tick;
    this.kin[slot] = kin ? 1 : 0;
    this.pairCooldownUntil[slot] = 0;
    this.resentUntil[slot] = 0;
    // Insert at the head; chain order stays deterministic because the
    // sequence of operations is deterministic.
    this.next[slot] = this.head[entity];
    this.head[entity] = slot;
    if (this.count[entity] === 0) {
      this.socialEntities.push(entity);
    }
    this.count[entity]++;
    return { entry: slot, created: true };
  }

  /** Forget every relationship an entity holds (called when an agent dies). */
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
    const idx = this.socialEntities.indexOf(entity);
    if (idx >= 0) {
      const last = this.socialEntities.length - 1;
      this.socialEntities[idx] = this.socialEntities[last];
      this.socialEntities.pop();
    }
  }

  /** Delete a single entry (used by the pruning pass). */
  removeEntry(entity: EntityId, entry: number): void {
    let prev = -1;
    for (let e = this.headOf(entity); e !== -1; e = this.next[e]) {
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
      const idx = this.socialEntities.indexOf(entity);
      if (idx >= 0) {
        const last = this.socialEntities.length - 1;
        this.socialEntities[idx] = this.socialEntities[last];
        this.socialEntities.pop();
      }
    }
  }

  /**
   * Drop the least valuable entry of an entity. Keep-value: familiarity plus
   * half the |score| plus a kin bonus — kin and strong bonds survive, weak
   * strangers are forgotten first. Strict `<` keeps the earliest chain entry
   * on ties, so eviction is deterministic.
   */
  private evictLeastValued(entity: EntityId): void {
    let worst = this.head[entity];
    if (worst === -1) return;
    let worstValue = this.keepValue(worst);
    let e = this.next[worst];
    while (e !== -1) {
      const value = this.keepValue(e);
      if (value < worstValue) {
        worstValue = value;
        worst = e;
      }
      e = this.next[e];
    }
    this.removeEntry(entity, worst);
  }

  private keepValue(entry: number): number {
    const kinBonus = this.kin[entry] === 1 ? 0.25 : 0;
    return this.familiarity[entry] + 0.5 * (this.score[entry] < 0 ? -this.score[entry] : this.score[entry]) + kinBonus;
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
    const target = new Int32Array(capacity).fill(-1);
    target.set(this.target);
    this.target = target;
    const score = new Float32Array(capacity);
    score.set(this.score);
    this.score = score;
    const trust = new Float32Array(capacity);
    trust.set(this.trust);
    this.trust = trust;
    const familiarity = new Float32Array(capacity);
    familiarity.set(this.familiarity);
    this.familiarity = familiarity;
    const positiveCount = new Uint16Array(capacity);
    positiveCount.set(this.positiveCount);
    this.positiveCount = positiveCount;
    const negativeCount = new Uint16Array(capacity);
    negativeCount.set(this.negativeCount);
    this.negativeCount = negativeCount;
    const lastInteractionTick = new Uint32Array(capacity);
    lastInteractionTick.set(this.lastInteractionTick);
    this.lastInteractionTick = lastInteractionTick;
    const kin = new Uint8Array(capacity);
    kin.set(this.kin);
    this.kin = kin;
    const pairCooldownUntil = new Int32Array(capacity);
    pairCooldownUntil.set(this.pairCooldownUntil);
    this.pairCooldownUntil = pairCooldownUntil;
    const resentUntil = new Uint32Array(capacity);
    resentUntil.set(this.resentUntil);
    this.resentUntil = resentUntil;
    const next = new Int32Array(capacity).fill(-1);
    next.set(this.next);
    this.next = next;
    const freeHead = new Int32Array(capacity).fill(-1);
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

  serialize(): SerializedRelationshipStore {
    const entities: number[] = [];
    const entries: RelationshipData[][] = [];
    for (const entity of this.socialEntities) {
      if (this.count[entity] <= 0) continue;
      entities.push(entity);
      const list: RelationshipData[] = [];
      for (let e = this.head[entity]; e !== -1; e = this.next[e]) {
        list.push({
          target: this.target[e],
          score: this.score[e],
          trust: this.trust[e],
          familiarity: this.familiarity[e],
          positiveCount: this.positiveCount[e],
          negativeCount: this.negativeCount[e],
          lastInteractionTick: this.lastInteractionTick[e],
          kin: this.kin[e] === 1,
          pairCooldownUntil: this.pairCooldownUntil[e],
          resentUntil: this.resentUntil[e],
        });
      }
      entries.push(list);
    }
    return { entities, entries };
  }

  restore(saved: SerializedRelationshipStore): void {
    // Clear in place (keeps capacity for reuse).
    while (this.socialEntities.length > 0) {
      this.removeAll(this.socialEntities[this.socialEntities.length - 1]);
    }
    this.socialEntities = [];

    for (let i = 0; i < saved.entities.length; i++) {
      const entity = saved.entities[i];
      const list = saved.entries[i];
      // Insert in reverse so the head-first chain ends up in the same order as
      // `list` (getOrCreate pushes to the head).
      for (let j = list.length - 1; j >= 0; j--) {
        const entry = list[j];
        const { entry: slot } = this.getOrCreate(entity, entry.target, entry.lastInteractionTick, entry.kin);
        this.score[slot] = entry.score;
        this.trust[slot] = entry.trust;
        this.familiarity[slot] = entry.familiarity;
        this.positiveCount[slot] = entry.positiveCount;
        this.negativeCount[slot] = entry.negativeCount;
        this.lastInteractionTick[slot] = entry.lastInteractionTick;
        this.kin[slot] = entry.kin ? 1 : 0;
        this.pairCooldownUntil[slot] = entry.pairCooldownUntil;
        this.resentUntil[slot] = entry.resentUntil;
      }
    }
  }
}

/**
 * Per-agent signal associations — what an individual has LEARNED a token means.
 *
 * This store is the memory behind proto-communication. It holds at most
 * `capacityPerAgent` associations of the form `(token, meaning, strength)`,
 * where `strength` grows every time the agent observes that token in a context
 * its own senses can confirm (food where the emitter pointed, a threat it can
 * see, …) and decays when the token goes unused. A token may carry at most
 * `maxMeaningsPerToken` competing meanings, so a signal can be ambiguous for a
 * while but can never accumulate an unbounded cloud of readings.
 *
 * WHY THIS REPRESENTATION (same bounded-arena pattern as the other stores):
 *   - per-agent, per-token bounds make the total association count O(agents),
 *     never O(agents x tokens x tick);
 *   - `strength` is a plain float so "learned meaning" is measurable state (the
 *     UI can show `Signal_04 → FOOD 0.62`), not a string or a lookup table;
 *   - the structure is sparse: agents that never hear a signal cost nothing;
 *   - serialization is plain arrays, so a save/load continuation reproduces the
 *     exact same associations (determinism contract).
 *
 * There is deliberately NO dictionary here — no token has a built-in meaning,
 * and meanings are never generated, only associated.
 */

import type { EntityId } from '../ecs';
import { clamp01 } from '../ai/utility';
import { SIGNAL_MEANING_COUNT, SIGNAL_MEANING_UNKNOWN, SIGNAL_TOKEN_COUNT } from './signals';

/** One association as exposed to consumers (read-only view). */
export interface SignalAssociationData {
  readonly token: number;
  readonly meaning: number;
  readonly strength: number;
  /** How many times the agent observed this token in that context. */
  readonly exposures: number;
  readonly lastUpdateTick: number;
}

/** Serialized form (plain arrays). */
export interface SerializedSignalStore {
  readonly entities: number[];
  readonly entries: SignalAssociationData[][];
}

const DEFAULT_CAPACITY = 8;
const DEFAULT_MAX_MEANINGS_PER_TOKEN = 2;

export class SignalStore {
  /** Store key inside a serialized ECS save (stable: part of the save format). */
  readonly name = 'signalAssociations';
  private capacity: number;
  private maxMeaningsPerToken: number;

  private token: Uint8Array;
  private meaning: Int8Array;
  private strength: Float32Array;
  private exposures: Uint16Array;
  private lastUpdateTick: Uint32Array;
  private next: Int32Array;
  private owner: Int32Array;

  private head: Int32Array;
  private count: Uint16Array;
  private readonly holders: EntityId[] = [];
  private readonly holderSlots = new Map<EntityId, number>();

  private freeHead = -1;
  private usedSlots = 0;

  constructor(
    capacityPerAgent: number = DEFAULT_CAPACITY,
    maxMeaningsPerToken: number = DEFAULT_MAX_MEANINGS_PER_TOKEN,
  ) {
    if (!Number.isInteger(capacityPerAgent) || capacityPerAgent < 1) {
      throw new Error('SignalStore: capacity must be >= 1');
    }
    if (!Number.isInteger(maxMeaningsPerToken) || maxMeaningsPerToken < 1) {
      throw new Error('SignalStore: maxMeaningsPerToken must be >= 1');
    }
    this.capacity = capacityPerAgent;
    this.maxMeaningsPerToken = maxMeaningsPerToken;
    const initial = 64;
    this.token = new Uint8Array(initial);
    this.meaning = new Int8Array(initial);
    this.strength = new Float32Array(initial);
    this.exposures = new Uint16Array(initial);
    this.lastUpdateTick = new Uint32Array(initial);
    // -1 = free / end-of-chain (every unallocated index must read as empty).
    this.next = new Int32Array(initial).fill(-1);
    this.owner = new Int32Array(initial).fill(-1);
    this.head = new Int32Array(1).fill(-1);
    this.count = new Uint16Array(1);
  }

  // --- Read-only accessors -------------------------------------------------

  countFor(entity: EntityId): number {
    return entity < this.count.length ? this.count[entity] : 0;
  }

  has(entity: EntityId): boolean {
    return this.countFor(entity) > 0;
  }

  headOf(entity: EntityId): number {
    return entity < this.head.length ? this.head[entity] : -1;
  }

  nextOf(entry: number): number {
    return this.next[entry];
  }

  entryToken(entry: number): number {
    return this.token[entry];
  }

  entryMeaning(entry: number): number {
    return this.meaning[entry];
  }

  entryStrength(entry: number): number {
    return this.strength[entry];
  }

  entryExposures(entry: number): number {
    return this.exposures[entry];
  }

  entryLastUpdateTick(entry: number): number {
    return this.lastUpdateTick[entry];
  }

  /** Entities with at least one association (deterministic holder order). */
  holderIds(): readonly EntityId[] {
    return this.holders;
  }

  /** Number of meanings the agent associates with one token. */
  countForToken(entity: EntityId, token: number): number {
    let total = 0;
    for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
      if (this.token[entry] === token) total++;
    }
    return total;
  }

  // --- Lookup ---------------------------------------------------------------

  find(entity: EntityId, token: number, meaning: number): number {
    for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
      if (this.token[entry] === token && this.meaning[entry] === meaning) return entry;
    }
    return -1;
  }

  strengthOf(entity: EntityId, token: number, meaning: number): number {
    const entry = this.find(entity, token, meaning);
    return entry === -1 ? 0 : this.strength[entry];
  }

  /**
   * The meaning the agent currently reads into `token` (argmax strength) and
   * that strength. Returns meaning -1 / strength 0 when the token is unknown.
   * This is the agent's DECODE step — what it acts on — as opposed to the
   * association the simulation grounds in context at emission time.
   */
  dominantMeaning(entity: EntityId, token: number): { meaning: number; strength: number } {
    let bestMeaning = SIGNAL_MEANING_UNKNOWN;
    let bestStrength = 0;
    for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
      if (this.token[entry] !== token) continue;
      if (this.strength[entry] > bestStrength) {
        bestStrength = this.strength[entry];
        bestMeaning = this.meaning[entry];
      }
    }
    return { meaning: bestMeaning, strength: bestStrength };
  }

  /** The token the agent most strongly associates with `meaning` (ENCODE step). */
  bestTokenFor(entity: EntityId, meaning: number): { token: number; strength: number } {
    let bestToken = -1;
    let bestStrength = 0;
    for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
      if (this.meaning[entry] !== meaning) continue;
      if (this.strength[entry] > bestStrength) {
        bestStrength = this.strength[entry];
        bestToken = this.token[entry];
      }
    }
    return { token: bestToken, strength: bestStrength };
  }

  /** Sum of association strengths for one meaning (UI/debug summary). */
  totalStrengthForMeaning(entity: EntityId, meaning: number): number {
    let total = 0;
    for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
      if (this.meaning[entry] === meaning) total += this.strength[entry];
    }
    return total;
  }

  // --- Mutation -------------------------------------------------------------

  /**
   * Record one observation of `token` in a context that grounds `meaning`.
   * Returns the slot, whether it is a new association, and the strength the
   * association had BEFORE this observation (callers use that to fire
   * `signal_learned` only when a meaning crosses the "known" threshold, never
   * per exposure). `nextStrength` is computed by the caller (culture/learning).
   */
  observe(
    entity: EntityId,
    token: number,
    meaning: number,
    nextStrength: number,
    tick: number,
  ): { entry: number; created: boolean; previousStrength: number } {
    this.ensureIndexCapacity(entity);
    const existing = this.find(entity, token, meaning);
    if (existing !== -1) {
      const previousStrength = this.strength[existing];
      this.strength[existing] = clamp01(nextStrength);
      this.lastUpdateTick[existing] = tick;
      if (this.exposures[existing] < 65535) this.exposures[existing]++;
      return { entry: existing, created: false, previousStrength };
    }

    // Per-token bound: a token can carry at most `maxMeaningsPerToken`
    // competing meanings — "one signal, a few readings" — so a token can never
    // accumulate an unbounded meaning cloud.
    let tokenMeanings = 0;
    for (let e = this.headOf(entity); e !== -1; e = this.next[e]) {
      if (this.token[e] === token) tokenMeanings++;
    }
    if (tokenMeanings >= this.maxMeaningsPerToken) {
      this.evictWeakestOfToken(entity, token);
    }
    if (this.count[entity] >= this.capacity) {
      this.evictWeakest(entity);
    }

    const slot = this.allocateSlot();
    this.owner[slot] = entity;
    this.token[slot] = token;
    this.meaning[slot] = meaning;
    this.strength[slot] = clamp01(nextStrength);
    this.exposures[slot] = 1;
    this.lastUpdateTick[slot] = tick;
    this.next[slot] = this.head[entity];
    this.head[entity] = slot;
    if (this.count[entity] === 0) {
      // Register the holder so removal can swap it out in O(1).
      this.holderSlots.set(entity, this.holders.length);
      this.holders.push(entity);
    }
    this.count[entity]++;
    return { entry: slot, created: true, previousStrength: 0 };
  }

  /** Raw strength write (per-tick decay, competing-meaning suppression). */
  setStrength(entry: number, value: number): void {
    this.strength[entry] = clamp01(value);
  }

  removeEntry(entity: EntityId, entry: number): void {
    if (this.owner[entry] !== entity) return;
    const head = this.head[entity];
    if (head === entry) {
      this.head[entity] = this.next[entry];
    } else {
      let prev = head;
      while (prev !== -1 && this.next[prev] !== entry) prev = this.next[prev];
      if (prev !== -1) this.next[prev] = this.next[entry];
    }
    this.owner[entry] = -1;
    this.next[entry] = this.freeHead;
    this.freeHead = entry;
    this.count[entity]--;
    if (this.count[entity] === 0) this.removeHolder(entity);
  }

  removeAll(entity: EntityId): void {
    let entry = this.headOf(entity);
    while (entry !== -1) {
      const next = this.next[entry];
      this.owner[entry] = -1;
      this.next[entry] = this.freeHead;
      this.freeHead = entry;
      entry = next;
    }
    if (entity < this.head.length) {
      this.head[entity] = -1;
      this.count[entity] = 0;
    }
    this.removeHolder(entity);
  }

  /** Weakest association of a token (used to enforce the per-token bound). */
  evictWeakestOfToken(entity: EntityId, token: number): void {
    let weakest = -1;
    let weakestStrength = Number.POSITIVE_INFINITY;
    for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
      if (this.token[entry] !== token) continue;
      if (this.strength[entry] < weakestStrength) {
        weakestStrength = this.strength[entry];
        weakest = entry;
      }
    }
    if (weakest !== -1) this.removeEntry(entity, weakest);
  }

  /** Weakest association overall (used to enforce the per-agent bound). */
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

  // --- Serialization --------------------------------------------------------

  serialize(): SerializedSignalStore {
    const entities: number[] = [];
    const entries: SignalAssociationData[][] = [];
    for (const entity of this.holders) {
      const list: SignalAssociationData[] = [];
      for (let entry = this.headOf(entity); entry !== -1; entry = this.next[entry]) {
        list.push({
          token: this.token[entry],
          meaning: this.meaning[entry],
          strength: this.strength[entry],
          exposures: this.exposures[entry],
          lastUpdateTick: this.lastUpdateTick[entry],
        });
      }
      entities.push(entity);
      entries.push(list);
    }
    return { entities, entries };
  }

  restore(saved: SerializedSignalStore): void {
    this.reset();
    for (let i = 0; i < saved.entities.length; i++) {
      const entity = saved.entities[i];
      const associations = saved.entries[i] ?? [];
      for (let j = associations.length - 1; j >= 0; j--) {
        const association = associations[j];
        this.observe(
          entity,
          association.token,
          association.meaning,
          association.strength,
          association.lastUpdateTick,
        );
        const entry = this.find(entity, association.token, association.meaning);
        if (entry !== -1) this.exposures[entry] = association.exposures;
      }
    }
  }

  reset(): void {
    this.freeHead = -1;
    this.usedSlots = 0;
    this.holders.length = 0;
    this.holderSlots.clear();
    this.head.fill(-1);
    this.count.fill(0);
    this.owner.fill(-1);
  }

  // --- Internals ------------------------------------------------------------

  private removeHolder(entity: EntityId): void {
    const slot = this.holderSlots.get(entity);
    if (slot === undefined) return;
    const last = this.holders.pop() as EntityId;
    if (slot < this.holders.length) {
      this.holders[slot] = last;
      this.holderSlots.set(last, slot);
    }
    this.holderSlots.delete(entity);
  }

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

  private growArena(): void {
    const capacity = this.owner.length * 2;
    const token = new Uint8Array(capacity);
    token.set(this.token);
    this.token = token;
    const meaning = new Int8Array(capacity);
    meaning.set(this.meaning);
    this.meaning = meaning;
    const strength = new Float32Array(capacity);
    strength.set(this.strength);
    this.strength = strength;
    const exposures = new Uint16Array(capacity);
    exposures.set(this.exposures);
    this.exposures = exposures;
    const lastUpdateTick = new Uint32Array(capacity);
    lastUpdateTick.set(this.lastUpdateTick);
    this.lastUpdateTick = lastUpdateTick;
    const next = new Int32Array(capacity).fill(-1);
    next.set(this.next);
    this.next = next;
    const owner = new Int32Array(capacity).fill(-1);
    owner.set(this.owner);
    this.owner = owner;
  }
}

/** True when a token id is inside the fixed alphabet. */
export function isValidToken(token: number): boolean {
  return Number.isInteger(token) && token >= 0 && token < SIGNAL_TOKEN_COUNT;
}

/** True when a meaning id is one of the five definable contexts. */
export function isValidMeaning(meaning: number): boolean {
  return Number.isInteger(meaning) && meaning >= 0 && meaning < SIGNAL_MEANING_COUNT;
}

/**
 * Entity IDs and the entity registry.
 *
 * Design: IDs are small non-negative integers, allocated monotonically and
 * never reused. "Stable ID" means: an ID always refers to the same conceptual
 * entity for the lifetime of the simulation. Not reusing IDs keeps snapshots,
 * event logs and future AI memory unambiguous after entities are destroyed.
 *
 * Iteration order: `aliveIds` is a dense array in allocation order. Destroyed
 * entities are swap-removed, which is deterministic because the sequence of
 * operations is deterministic.
 */

export type EntityId = number;

/** Initial capacity of the registry's internal dense arrays. */
const INITIAL_ENTITY_CAPACITY = 256;

export interface SerializedEntityRegistry {
  nextEntityId: number;
  /** Alive entity IDs in dense iteration order. */
  alive: number[];
}

export class EntityRegistry {
  private nextEntityId = 0;
  private aliveFlags: Uint8Array;
  /** Dense list of alive entity IDs (allocation order). Rebound on growth. */
  aliveIds: Uint32Array;
  /** entity ID -> index into aliveIds, or -1. */
  private aliveIndex: Int32Array;

  aliveCount = 0;

  constructor(initialCapacity: number = INITIAL_ENTITY_CAPACITY) {
    this.aliveFlags = new Uint8Array(initialCapacity);
    this.aliveIds = new Uint32Array(initialCapacity);
    this.aliveIndex = new Int32Array(initialCapacity).fill(-1);
  }

  /** Allocate a new, never-before-used entity ID. */
  create(): EntityId {
    const id = this.nextEntityId;
    this.nextEntityId++;
    this.ensureCapacity(id);
    this.aliveFlags[id] = 1;
    if (this.aliveCount === this.aliveIds.length) this.growDense();
    this.aliveIds[this.aliveCount] = id;
    this.aliveIndex[id] = this.aliveCount;
    this.aliveCount++;
    return id;
  }

  /** Mark an entity as destroyed. The ID is never reused. */
  destroy(id: EntityId): void {
    if (!this.isAlive(id)) {
      throw new Error(`EntityRegistry.destroy: entity ${id} is not alive`);
    }
    const denseIndex = this.aliveIndex[id];
    const lastIndex = this.aliveCount - 1;
    const movedEntity = this.aliveIds[lastIndex];
    this.aliveIds[denseIndex] = movedEntity;
    this.aliveIndex[movedEntity] = denseIndex;
    this.aliveIndex[id] = -1;
    this.aliveFlags[id] = 0;
    this.aliveCount--;
  }

  isAlive(id: EntityId): boolean {
    return id >= 0 && id < this.aliveFlags.length && this.aliveFlags[id] === 1;
  }

  private ensureCapacity(id: number): void {
    if (id < this.aliveFlags.length) return;
    let newSize = this.aliveFlags.length;
    while (newSize <= id) newSize *= 2;
    const flags = new Uint8Array(newSize);
    flags.set(this.aliveFlags);
    this.aliveFlags = flags;
    const index = new Int32Array(newSize).fill(-1);
    index.set(this.aliveIndex);
    this.aliveIndex = index;
  }

  private growDense(): void {
    const newSize = Math.max(8, this.aliveIds.length * 2);
    const ids = new Uint32Array(newSize);
    ids.set(this.aliveIds);
    this.aliveIds = ids;
  }

  serialize(): SerializedEntityRegistry {
    return {
      nextEntityId: this.nextEntityId,
      alive: Array.from(this.aliveIds.subarray(0, this.aliveCount)),
    };
  }

  /** Replace the contents of this registry with a serialized one. */
  restore(saved: SerializedEntityRegistry): void {
    const capacity = Math.max(INITIAL_ENTITY_CAPACITY, saved.alive.length, saved.nextEntityId);
    this.nextEntityId = saved.nextEntityId;
    this.aliveFlags = new Uint8Array(capacity);
    this.aliveIds = new Uint32Array(Math.max(capacity, saved.alive.length));
    this.aliveIndex = new Int32Array(capacity).fill(-1);
    this.aliveCount = saved.alive.length;
    for (let i = 0; i < saved.alive.length; i++) {
      const id = saved.alive[i];
      if (id < 0 || id >= this.nextEntityId) {
        throw new Error(`EntityRegistry.restore: invalid entity id ${id}`);
      }
      this.aliveFlags[id] = 1;
      this.aliveIds[i] = id;
      this.aliveIndex[id] = i;
    }
  }
}

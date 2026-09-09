/**
 * Structure-of-Arrays component store.
 *
 * Each component type is one ComponentStore instance holding one typed array
 * per field ("column"). Entities that carry the component occupy a dense slot
 * [0, count); `entityOf` maps dense slot -> entity ID and `index` maps
 * entity ID -> dense slot (or -1).
 *
 * WHY SoA with typed arrays: simulation hot loops iterate dense columns
 * directly (cache friendly, zero allocation), and the whole store serializes
 * to compact JSON arrays for save/load. Capacity growth is amortized doubling,
 * so per-tick allocation is zero once the population settles.
 *
 * This is deliberately NOT a generic ECS framework — one small store class is
 * enough for this project's needs (see ARCHITECTURE.md for how to add
 * components).
 */

import type { EntityId } from './entity';

export type AnyTypedArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Uint16Array
  | Uint8Array;

/** Constructor signature shared by all supported typed arrays. */
export type TypedArrayConstructor = new (length: number) => AnyTypedArray;

/** Maps column names to typed array constructors, e.g. `{ x: Float64Array }`. */
export type ComponentSchema = Record<string, TypedArrayConstructor>;

/** Concrete column arrays for a schema. */
export type ComponentColumns<S extends ComponentSchema> = {
  [K in keyof S]: InstanceType<S[K]>;
};

/** Per-entity values accepted by `attach`, e.g. `{ x: 1.5, y: 2 }`. */
export type ComponentValues<S extends ComponentSchema> = {
  [K in keyof S]?: number;
};

export interface SerializedComponentStore {
  count: number;
  /** Entity ID for each dense slot. */
  entityOf: number[];
  /** Column data, dense slots only. */
  columns: Record<string, number[]>;
}

const MIN_CAPACITY = 8;

export class ComponentStore<S extends ComponentSchema> {
  readonly name: string;
  private readonly schema: S;

  /** Dense slot -> entity ID. Rebound when the store grows (amortized doubling). */
  entityOf: Uint32Array;
  /** Entity ID -> dense slot, or -1 when the entity does not carry this component. Rebound on growth. */
  index: Int32Array;
  /** Number of entities carrying this component. */
  count = 0;
  /** Column data, indexed by dense slot. Hot loops read these directly. */
  readonly columns: ComponentColumns<S>;

  constructor(name: string, schema: S, initialCapacity: number) {
    this.name = name;
    this.schema = schema;
    const capacity = Math.max(MIN_CAPACITY, initialCapacity);
    this.entityOf = new Uint32Array(capacity);
    this.index = new Int32Array(capacity).fill(-1);
    this.columns = {} as ComponentColumns<S>;
    for (const key of Object.keys(schema)) {
      (this.columns as Record<string, AnyTypedArray>)[key] = new schema[key](capacity);
    }
  }

  /** Attach the component to an entity (optionally setting column values). */
  attach(entity: EntityId, values: ComponentValues<S> = {}): number {
    if (entity < 0) {
      throw new Error(`ComponentStore(${this.name}).attach: invalid entity id ${entity}`);
    }
    if (this.has(entity)) {
      throw new Error(`ComponentStore(${this.name}).attach: entity ${entity} already attached`);
    }
    this.ensureIndexCapacity(entity);
    if (this.count === this.entityOf.length) this.grow();
    const slot = this.count;
    this.count++;
    this.entityOf[slot] = entity;
    this.index[entity] = slot;
    const looseValues = values as Record<string, number | undefined>;
    for (const key of Object.keys(this.schema)) {
      const column = (this.columns as Record<string, AnyTypedArray>)[key];
      column[slot] = looseValues[key] ?? 0;
    }
    return slot;
  }

  /** Detach the component (swap-remove). Throws if the entity does not carry it. */
  detach(entity: EntityId): void {
    const slot = entity >= 0 && entity < this.index.length ? this.index[entity] : -1;
    if (slot < 0) {
      throw new Error(`ComponentStore(${this.name}).detach: entity ${entity} not attached`);
    }
    const lastSlot = this.count - 1;
    if (slot !== lastSlot) {
      const movedEntity = this.entityOf[lastSlot];
      this.entityOf[slot] = movedEntity;
      for (const key of Object.keys(this.schema)) {
        const column = (this.columns as Record<string, AnyTypedArray>)[key];
        column[slot] = column[lastSlot];
      }
      this.index[movedEntity] = slot;
    }
    this.count--;
    this.index[entity] = -1;
  }

  has(entity: EntityId): boolean {
    return entity >= 0 && entity < this.index.length && this.index[entity] >= 0;
  }

  private ensureIndexCapacity(entity: number): void {
    if (entity < this.index.length) return;
    let newSize = this.index.length;
    while (newSize <= entity) newSize *= 2;
    const index = new Int32Array(newSize).fill(-1);
    index.set(this.index);
    this.index = index;
  }

  private grow(): void {
    const newCapacity = this.entityOf.length * 2;
    const entityOf = new Uint32Array(newCapacity);
    entityOf.set(this.entityOf);
    // entityOf is readonly for consumers but growing must rebind it.
    (this as { entityOf: Uint32Array }).entityOf = entityOf;
    for (const key of Object.keys(this.schema)) {
      const oldColumn = (this.columns as Record<string, AnyTypedArray>)[key];
      const newColumn = new this.schema[key](newCapacity);
      newColumn.set(oldColumn);
      (this.columns as Record<string, AnyTypedArray>)[key] = newColumn;
    }
  }

  serialize(): SerializedComponentStore {
    const columns: Record<string, number[]> = {};
    for (const key of Object.keys(this.schema)) {
      const column = (this.columns as Record<string, AnyTypedArray>)[key];
      columns[key] = Array.from(column.subarray(0, this.count));
    }
    return {
      count: this.count,
      entityOf: Array.from(this.entityOf.subarray(0, this.count)),
      columns,
    };
  }

  /** Replace this store's contents with serialized data. */
  restore(saved: SerializedComponentStore): void {
    const schemaKeys = Object.keys(this.schema);
    for (const key of schemaKeys) {
      if (saved.columns[key] === undefined) {
        throw new Error(`ComponentStore(${this.name}).restore: missing column '${key}'`);
      }
    }
    const capacity = Math.max(MIN_CAPACITY, saved.count, saved.entityOf.length);
    if (this.entityOf.length < capacity) {
      this.entityOf = new Uint32Array(capacity);
      for (const key of schemaKeys) {
        (this.columns as Record<string, AnyTypedArray>)[key] = new this.schema[key](capacity);
      }
    }
    this.count = saved.count;
    for (let i = 0; i < saved.count; i++) {
      this.entityOf[i] = saved.entityOf[i];
    }
    for (const key of schemaKeys) {
      const column = (this.columns as Record<string, AnyTypedArray>)[key];
      const values = saved.columns[key];
      if (values.length < saved.count) {
        throw new Error(`ComponentStore(${this.name}).restore: column '${key}' too short`);
      }
      for (let i = 0; i < saved.count; i++) {
        column[i] = values[i];
      }
    }
    // Rebuild the sparse index map.
    this.index.fill(-1);
    for (let i = 0; i < this.count; i++) {
      const entity = this.entityOf[i];
      if (entity >= this.index.length) this.ensureIndexCapacity(entity);
      if (this.index[entity] !== -1) {
        throw new Error(`ComponentStore(${this.name}).restore: duplicate entity ${entity}`);
      }
      this.index[entity] = i;
    }
  }
}

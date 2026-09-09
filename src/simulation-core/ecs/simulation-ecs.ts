/**
 * The simulation's ECS container: one entity registry plus one component store
 * per schema, plus the dedicated (variable-length) Memory store. It holds data
 * only — systems (in simulation/systems and ai/) own all behavior. Keep this
 * class free of gameplay logic so future components and stores can be added
 * without touching systems and vice versa.
 */

import { EntityRegistry } from './entity';
import type { EntityId } from './entity';
import { ComponentStore } from './component-store';
import type { SerializedComponentStore } from './component-store';
import {
  AgeSchema,
  AiStateSchema,
  GenomeSchema,
  HealthSchema,
  IntentSchema,
  NeedsSchema,
  PositionSchema,
} from './components';
import { MemoryStore } from '../ai/memory';
import type { SerializedMemoryStore } from '../ai/memory';

/** Initial capacity for agent stores (grows by doubling when exceeded). */
export const INITIAL_AGENT_CAPACITY = 128;

/** Default per-agent memory capacity (used before config is available). */
export const DEFAULT_MEMORY_CAPACITY = 8;

export interface SerializedEcs {
  entities: {
    nextEntityId: number;
    alive: number[];
  };
  /** Component stores by name, in a fixed order (deterministic serialization). */
  stores: Record<string, unknown>;
}

/** Structural type used to serialize/restore any fixed-column store generically. */
type AnyComponentStore = {
  name: string;
  serialize(): SerializedComponentStore;
  restore(s: SerializedComponentStore): void;
};

export class SimulationEcs {
  readonly entities = new EntityRegistry(INITIAL_AGENT_CAPACITY);

  readonly position = new ComponentStore('position', PositionSchema, INITIAL_AGENT_CAPACITY);
  readonly needs = new ComponentStore('needs', NeedsSchema, INITIAL_AGENT_CAPACITY);
  readonly age = new ComponentStore('age', AgeSchema, INITIAL_AGENT_CAPACITY);
  readonly health = new ComponentStore('health', HealthSchema, INITIAL_AGENT_CAPACITY);
  readonly genome = new ComponentStore('genome', GenomeSchema, INITIAL_AGENT_CAPACITY);
  readonly intent = new ComponentStore('intent', IntentSchema, INITIAL_AGENT_CAPACITY);
  readonly aiState = new ComponentStore('aiState', AiStateSchema, INITIAL_AGENT_CAPACITY);

  /** Variable-length-but-bounded per-agent memory (dedicated store, not SoA). */
  readonly memory: MemoryStore;

  constructor(memoryCapacity: number = DEFAULT_MEMORY_CAPACITY) {
    this.memory = new MemoryStore(memoryCapacity);
  }

  /**
   * Fixed store order — keeps serialization deterministic. Appending at the end
   * is safe for future stores; inserting requires a save-format bump.
   */
  private readonly componentStores: readonly AnyComponentStore[] = [
    this.position,
    this.needs,
    this.age,
    this.health,
    this.genome,
    this.intent,
    this.aiState,
  ];

  serialize(): SerializedEcs {
    const savedStores: Record<string, unknown> = {};
    for (const store of this.componentStores) {
      savedStores[store.name] = store.serialize();
    }
    savedStores[this.memory.name] = this.memory.serialize();
    return { entities: this.entities.serialize(), stores: savedStores };
  }

  restore(saved: SerializedEcs): void {
    this.entities.restore(saved.entities);
    for (const store of this.componentStores) {
      const savedStore = saved.stores[store.name];
      if (!savedStore) {
        throw new Error(`SimulationEcs.restore: missing store '${store.name}'`);
      }
      store.restore(savedStore as SerializedComponentStore);
    }
    const savedMemory = saved.stores[this.memory.name];
    if (!savedMemory) {
      throw new Error(`SimulationEcs.restore: missing store '${this.memory.name}'`);
    }
    this.memory.restore(savedMemory as SerializedMemoryStore);

    // Sanity check: every component store must reference only alive entities.
    for (const store of this.componentStores) {
      const savedStore = saved.stores[store.name] as SerializedComponentStore;
      for (let i = 0; i < savedStore.entityOf.length; i++) {
        const entity = savedStore.entityOf[i] as EntityId;
        if (!this.entities.isAlive(entity)) {
          throw new Error(`SimulationEcs.restore: store '${store.name}' references dead entity ${entity}`);
        }
      }
    }
    // Sanity check: memory may only belong to alive entities.
    const memorySave = savedMemory as SerializedMemoryStore;
    for (const entity of memorySave.entities) {
      if (!this.entities.isAlive(entity)) {
        throw new Error(`SimulationEcs.restore: memory store references dead entity ${entity}`);
      }
    }
  }
}

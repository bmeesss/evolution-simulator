/**
 * The simulation's ECS container: one entity registry plus one component store
 * per schema. It holds data only — systems (in simulation/systems and ai/) own
 * all behavior. Keep this class free of gameplay logic so future components
 * and stores can be added without touching systems and vice versa.
 */

import { EntityRegistry } from './entity';
import type { EntityId } from './entity';
import { ComponentStore } from './component-store';
import type { SerializedComponentStore } from './component-store';
import {
  AgeSchema,
  GenomeSchema,
  HealthSchema,
  IntentSchema,
  NeedsSchema,
  PositionSchema,
} from './components';

/** Initial capacity for agent stores (grows by doubling when exceeded). */
export const INITIAL_AGENT_CAPACITY = 128;

export interface SerializedEcs {
  entities: {
    nextEntityId: number;
    alive: number[];
  };
  /** Component stores by name, in a fixed order (deterministic serialization). */
  stores: Record<string, SerializedComponentStore>;
}

/** Structural type used to serialize/restore any store generically. */
type AnyStore = { name: string; serialize(): SerializedComponentStore; restore(s: SerializedComponentStore): void };

export class SimulationEcs {
  readonly entities = new EntityRegistry(INITIAL_AGENT_CAPACITY);

  readonly position = new ComponentStore('position', PositionSchema, INITIAL_AGENT_CAPACITY);
  readonly needs = new ComponentStore('needs', NeedsSchema, INITIAL_AGENT_CAPACITY);
  readonly age = new ComponentStore('age', AgeSchema, INITIAL_AGENT_CAPACITY);
  readonly health = new ComponentStore('health', HealthSchema, INITIAL_AGENT_CAPACITY);
  readonly genome = new ComponentStore('genome', GenomeSchema, INITIAL_AGENT_CAPACITY);
  readonly intent = new ComponentStore('intent', IntentSchema, INITIAL_AGENT_CAPACITY);

  /** Fixed store order — keeps serialization deterministic. */
  private readonly stores: readonly AnyStore[] = [
    this.position,
    this.needs,
    this.age,
    this.health,
    this.genome,
    this.intent,
  ];

  serialize(): SerializedEcs {
    const savedStores: Record<string, SerializedComponentStore> = {};
    for (const store of this.stores) {
      savedStores[store.name] = store.serialize();
    }
    return { entities: this.entities.serialize(), stores: savedStores };
  }

  restore(saved: SerializedEcs): void {
    this.entities.restore(saved.entities);
    for (const store of this.stores) {
      const savedStore = saved.stores[store.name];
      if (!savedStore) {
        throw new Error(`SimulationEcs.restore: missing store '${store.name}'`);
      }
      store.restore(savedStore);
    }
    // Sanity check: every store must reference only alive entities.
    for (const store of this.stores) {
      const savedStore = saved.stores[store.name];
      for (let i = 0; i < savedStore.entityOf.length; i++) {
        const entity = savedStore.entityOf[i] as EntityId;
        if (!this.entities.isAlive(entity)) {
          throw new Error(`SimulationEcs.restore: store '${store.name}' references dead entity ${entity}`);
        }
      }
    }
  }
}

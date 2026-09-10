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
  CultureStateSchema,
  GenomeSchema,
  HealthSchema,
  IntentSchema,
  LineageSchema,
  NeedsSchema,
  PositionSchema,
  ReproductiveSchema,
  SocialSchema,
} from './components';
import { MemoryStore } from '../ai/memory';
import type { SerializedMemoryStore } from '../ai/memory';
import { RelationshipStore } from '../social/relationship-store';
import type { SerializedRelationshipStore } from '../social/relationship-store';
import { CulturalMemoryStore } from '../culture/cultural-memory-store';
import type { SerializedCulturalMemoryStore } from '../culture/cultural-memory-store';
import { SignalStore } from '../culture/signal-store';
import type { SerializedSignalStore } from '../culture/signal-store';

/** Initial capacity for agent stores (grows by doubling when exceeded). */
export const INITIAL_AGENT_CAPACITY = 128;

/** Default per-agent memory capacity (used before config is available). */
export const DEFAULT_MEMORY_CAPACITY = 8;

/** Default per-agent relationship capacity (used before config is available). */
export const DEFAULT_RELATIONSHIP_CAPACITY = 16;

/** Default per-agent cultural knowledge capacity (used before config is available). */
export const DEFAULT_CULTURAL_CAPACITY = 10;

/** Default per-agent signal-association capacity (used before config is available). */
export const DEFAULT_SIGNAL_CAPACITY = 8;

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
  readonly lineage = new ComponentStore('lineage', LineageSchema, INITIAL_AGENT_CAPACITY);
  readonly reproductive = new ComponentStore('reproductive', ReproductiveSchema, INITIAL_AGENT_CAPACITY);
  readonly social = new ComponentStore('social', SocialSchema, INITIAL_AGENT_CAPACITY);
  readonly culture = new ComponentStore('culture', CultureStateSchema, INITIAL_AGENT_CAPACITY);

  /** Variable-length-but-bounded per-agent memory (dedicated store, not SoA). */
  readonly memory: MemoryStore;

  /** Sparse bounded per-agent social relationships (Phase 4, dedicated store). */
  readonly relationships: RelationshipStore;

  /** Bounded per-agent cultural knowledge items (Phase 5, dedicated store). */
  readonly culturalMemory: CulturalMemoryStore;

  /** Bounded per-agent signal-meaning associations (Phase 5, dedicated store). */
  readonly signals: SignalStore;

  constructor(
    memoryCapacity: number = DEFAULT_MEMORY_CAPACITY,
    relationshipCapacity: number = DEFAULT_RELATIONSHIP_CAPACITY,
    culturalCapacity: number = DEFAULT_CULTURAL_CAPACITY,
    signalCapacity: number = DEFAULT_SIGNAL_CAPACITY,
    maxMeaningsPerToken: number = 2,
  ) {
    this.memory = new MemoryStore(memoryCapacity);
    this.relationships = new RelationshipStore(relationshipCapacity);
    this.culturalMemory = new CulturalMemoryStore(culturalCapacity);
    this.signals = new SignalStore(signalCapacity, maxMeaningsPerToken);
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
    this.lineage,
    this.reproductive,
    this.social,
    this.culture,
  ];

  serialize(): SerializedEcs {
    const savedStores: Record<string, unknown> = {};
    for (const store of this.componentStores) {
      savedStores[store.name] = store.serialize();
    }
    savedStores[this.memory.name] = this.memory.serialize();
    savedStores[this.relationships.name] = this.relationships.serialize();
    savedStores[this.culturalMemory.name] = this.culturalMemory.serialize();
    savedStores[this.signals.name] = this.signals.serialize();
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
    const savedRelationships = saved.stores[this.relationships.name];
    if (!savedRelationships) {
      throw new Error(`SimulationEcs.restore: missing store '${this.relationships.name}'`);
    }
    this.relationships.restore(savedRelationships as SerializedRelationshipStore);
    const savedCulturalMemory = saved.stores[this.culturalMemory.name];
    if (!savedCulturalMemory) {
      throw new Error(`SimulationEcs.restore: missing store '${this.culturalMemory.name}'`);
    }
    this.culturalMemory.restore(savedCulturalMemory as SerializedCulturalMemoryStore);
    const savedSignals = saved.stores[this.signals.name];
    if (!savedSignals) {
      throw new Error(`SimulationEcs.restore: missing store '${this.signals.name}'`);
    }
    this.signals.restore(savedSignals as SerializedSignalStore);

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
    // Sanity check: relationships may only belong to alive entities.
    const relationshipSave = savedRelationships as SerializedRelationshipStore;
    for (const entity of relationshipSave.entities) {
      if (!this.entities.isAlive(entity)) {
        throw new Error(`SimulationEcs.restore: relationship store references dead entity ${entity}`);
      }
    }
    // Sanity check: cultural knowledge and signal associations are per-agent and
    // may only belong to alive entities too (dead agents leave no cultural trace).
    const culturalSave = savedCulturalMemory as SerializedCulturalMemoryStore;
    for (const entity of culturalSave.entities) {
      if (!this.entities.isAlive(entity)) {
        throw new Error(`SimulationEcs.restore: cultural memory references dead entity ${entity}`);
      }
    }
    const signalSave = savedSignals as SerializedSignalStore;
    for (const entity of signalSave.entities) {
      if (!this.entities.isAlive(entity)) {
        throw new Error(`SimulationEcs.restore: signal store references dead entity ${entity}`);
      }
    }
  }
}

export { EntityRegistry } from './entity';
export type { EntityId, SerializedEntityRegistry } from './entity';
export { ComponentStore } from './component-store';
export type {
  ComponentSchema,
  ComponentColumns,
  ComponentValues,
  SerializedComponentStore,
  AnyTypedArray,
  TypedArrayConstructor,
} from './component-store';
export {
  PositionSchema,
  NeedsSchema,
  AgeSchema,
  HealthSchema,
  GenomeSchema,
  IntentSchema,
} from './components';
export { SimulationEcs, INITIAL_AGENT_CAPACITY } from './simulation-ecs';
export type { SerializedEcs } from './simulation-ecs';

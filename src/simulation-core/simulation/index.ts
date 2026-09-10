export { Simulation } from './simulation';
export type { SimulationRngStreams } from './simulation';
export {
  DEFAULT_SIMULATION_CONFIG,
  cloneConfig,
  NEED_MIN,
  NEED_MAX,
} from './config';
export type {
  SimulationConfig,
  TimeConfig,
  MovementConfig,
  NeedsConfig,
  AgentsConfig,
  AiConfig,
  MemoryConfig,
  ResourcesConfig,
  LifeStageConfig,
  ReproductionConfig,
  MortalityConfig,
  MetabolismConfig,
  MutationConfig,
  SocialConfig,
} from './config';
export type { TickContext } from './tick-context';
export { formatTimeHours, HOURS_PER_DAY } from './time';
export { spawnInitialAgents } from './systems/spawn';
export { moveAgents } from './systems/movement-system';
export { updateNeeds } from './systems/needs-system';
export { interactWithResources } from './systems/resource-system';
export { updateSocialInteractions } from './systems/social-system';
export { updateSocialState } from './systems/social-maintenance';
export { updateGroups, groupJoinUtility, groupLeaveUtility } from './systems/group-system';
export type { GroupJoinFactors, GroupLeaveFactors } from './systems/group-system';
export { updateMemory } from './systems/memory-system';
export { regenerateResources } from './systems/regeneration-system';
export { updateDeaths } from './systems/death-system';
export { updateAging } from './systems/aging-system';
export { updateMortality, ageHealthDrainPerHour } from './systems/mortality-system';
export { updateReproduction } from './systems/reproduction-system';
export {
  LifeStage,
  LIFE_STAGE_NAMES,
  lifeStageForAge,
  lifeStageName,
  movementEfficiencyForStage,
  energyDrainMultiplierForStage,
  isReproductiveStage,
} from './life-stages';
export type { LifeStage as LifeStageType } from './life-stages';

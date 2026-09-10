/**
 * Simulation configuration.
 *
 * Every tunable number used by the simulation lives here — systems never embed
 * magic numbers. The config is plain JSON-serializable data so it can be
 * embedded in save files and compared in determinism tests.
 *
 * Fixed timestep: one simulation tick advances exactly `time.hoursPerTick`
 * in-game hours, independent of the render frame rate. The worker decides how
 * many ticks to run per real-time slice based on speed (see workers/).
 */

import type { WorldDimensions } from '../world';

// --- Needs scale -----------------------------------------------------------
/** Needs (hunger/thirst/energy/health) live on a 0..100 scale. */
export const NEED_MIN = 0;
export const NEED_MAX = 100;

export interface TimeConfig {
  /** In-game hours advanced by one simulation tick. */
  hoursPerTick: number;
  /** Ticks per real-time second at 1x speed (speed multipliers scale this). */
  baseTicksPerSecond: number;
  /**
   * Upper bound on ticks processed in a single worker update slice. Guards the
   * worker loop when the simulation cannot keep up with the requested speed.
   */
  maxTicksPerUpdateSlice: number;
  /** Minimum real-time interval between snapshots sent to the main thread. */
  snapshotIntervalMs: number;
}

export interface MovementConfig {
  /** Movement speed (tiles/hour) at genome speed 0. */
  baseSpeedTilesPerHour: number;
  /** Additional movement speed (tiles/hour) at genome speed 1. */
  speedRangeTilesPerHour: number;
  /** Wander targets are picked within this radius of the agent (tiles). */
  wanderTargetRadiusTiles: number;
  /** Distance at which a wander target counts as reached (tiles). */
  targetReachedDistanceTiles: number;
}

export interface NeedsConfig {
  hungerPerHour: number;
  thirstPerHour: number;
  /** Energy spent per hour while moving/active. */
  energyDrainPerHourActive: number;
  /** Energy regained per hour while resting. */
  energyRegenPerHourResting: number;
  /** Energy below this -> agent rests (hysteresis lower bound). */
  restEnergyThreshold: number;
  /** Energy above this -> resting agent wakes up (hysteresis upper bound). */
  wakeEnergyThreshold: number;
  /** At or above this hunger/thirst, health starts to deteriorate. */
  criticalNeedThreshold: number;
  /** Health lost per hour while any need is critical. */
  healthDrainPerHourCritical: number;
  /** Health regained per hour while all needs are comfortable. */
  healthRegenPerHourComfortable: number;
  /** Needs at or below this count as comfortable for regeneration. */
  comfortableNeedThreshold: number;
}

export interface AgentsConfig {
  /** Number of agents spawned when a simulation is created. */
  initialPopulation: number;
  spawn: {
    /** Attempts to find a land tile per spawned agent before giving up. */
    maxLandTileAttempts: number;
    /**
     * Starting age (lower bound) of the founding generation, in in-game hours.
     * The spec makes *children born during the run* start at age 0; the founding
     * generation is unconstrained and spawns as a mixed-age cohort of adults so a
     * fresh simulation can reproduce immediately and does not hit a synchronized
     * old-age cliff. Ages are drawn uniformly in
     * [initialAgeHours, initialAgeHours + initialAgeVariationHours).
     */
    initialAgeHours: number;
    /** Spread (in-game hours) of the founding generation's starting ages. */
    initialAgeVariationHours: number;
    initialHungerMax: number;
    initialThirstMax: number;
    initialEnergyMin: number;
    initialEnergyMax: number;
    initialHealth: number;
  };
}

export interface AiConfig {
  /** Radius (tiles) within which an agent can perceive resource tiles. */
  perceptionRadiusTiles: number;
  /**
   * Distance scale (tiles) for reachability scoring. A resource this far away
   * scores ~0; remembered locations beyond perception still compete within it.
   */
  travelHorizonTiles: number;
  /** Hunger below this produces no urge to eat (0..100). */
  seekFoodNeedThreshold: number;
  /** Thirst below this produces no urge to drink (0..100). */
  seekWaterNeedThreshold: number;
  /** Base utility of exploring when nothing else matters (0..1). */
  explorationDrive: number;
  /** Bonus added to the currently-selected action (prevents thrashing). */
  hysteresisBonus: number;
  /** Half-width of deterministic tie-break jitter added to each utility. */
  tieBreakNoise: number;
}

export interface MemoryConfig {
  /** Maximum remembered locations per agent. */
  capacity: number;
  /** Fraction a successful interaction moves a memory value toward 1. */
  baseLearningRate: number;
  /** Base forgetting rate per in-game hour (memory value decays toward 0). */
  baseDecayPerHour: number;
  /** Value a newly created memory starts at. */
  initialValue: number;
  /** Entries whose value falls below this are forgotten entirely. */
  forgetThreshold: number;
  /** Extra learning-rate multiplier at intelligence 1 (intel 0 adds nothing). */
  intelligenceLearningFactor: number;
  /** Fraction of base decay removed at intelligence 1 (better retention). */
  intelligenceRetentionFactor: number;
}

export interface ResourcesConfig {
  /** Food consumed per Eat action (fraction of the tile's [0,1] capacity). */
  eatAmount: number;
  /** Water consumed per Drink action (fraction of the tile's [0,1] capacity). */
  drinkAmount: number;
  /** Hunger points removed per Eat (0..100 scale). */
  hungerReliefPerEat: number;
  /** Thirst points removed per Drink (0..100 scale). */
  thirstReliefPerDrink: number;
  /** A tile with less food than this is treated as empty (also perception). */
  minFoodToEat: number;
  /** A tile with less water than this is treated as dry (also perception). */
  minWaterToDrink: number;
  /** Fraction of a tile's capacity regenerated per in-game hour. */
  foodRegenPerHour: number;
  /** Fraction of a tile's capacity regenerated per in-game hour. */
  waterRegenPerHour: number;
}

/**
 * Life stage thresholds (in in-game hours) and per-stage behavior modifiers.
 * Stages influence behavior through *multipliers*, never through hardcoded
 * per-stage branches scattered through the systems — each modifier is read from
 * config so the balance is tunable in one place.
 *
 *   child       [0, childMaxAgeHours)          — no reproduction, slower, costlier
 *   adolescent  [childMaxAgeHours, adolescentMaxAgeHours) — slower, no reproduction
 *   adult       [adolescentMaxAgeHours, adultMaxAgeHours) — normal reproduction/movement
 *   elderly     [adultMaxAgeHours, ∞)          — reduced movement, rising mortality
 */
export interface LifeStageConfig {
  childMaxAgeHours: number;
  adolescentMaxAgeHours: number;
  /** Age at which agents become elderly (past this point mortality rises). */
  adultMaxAgeHours: number;
  /** Movement speed multiplier while a child (slower to grow up, better than 0). */
  childMovementEfficiency: number;
  adolescentMovementEfficiency: number;
  adultMovementEfficiency: number;
  elderlyMovementEfficiency: number;
  /** Energy drain multiplier while active (costlier to be a growing child). */
  childEnergyDrainMultiplier: number;
  adolescentEnergyDrainMultiplier: number;
  adultEnergyDrainMultiplier: number;
  elderlyEnergyDrainMultiplier: number;
}

/**
 * Reproduction tuning. Reproduction is chosen by the Utility AI only when an
 * adult is not in an unsafe survival state; the AI's `reproductionUrgency`
 * drops to zero as hunger/thirst/fatigue rise, so agents never breed while
 * starving. All values are absolute/centralized for tunable natural selection.
 */
export interface ReproductionConfig {
  /** Radius (tiles) within which an agent searches for a partner. */
  partnerSeekRadiusTiles: number;
  /** Distance (tiles) at which a seeker and partner are "close enough" to breed. */
  partnerReachTiles: number;
  /** Minimum health (0..100) for either parent to breed. */
  minHealthToReproduce: number;
  /** Minimum energy (0..100) for the seeker to bother breeding. */
  minEnergyToReproduce: number;
  /** Hunger AND thirst must be below this (0..100) to breed (unsafe = blocked). */
  maxNeedToReproduce: number;
  /** Base cooldown after a successful reproduction (in-game hours). */
  cooldownHours: number;
  /** Fraction of the cooldown removed at fertility 1 (higher fertility -> shorter cooldown). */
  fertilityCooldownReduction: number;
  /** Base Utility-AI drive to seek a partner (0..1). */
  baseDrive: number;
  /** Utility-AI drive added at fertility 1 (eager breeders reproduce more). */
  fertilityDriveBoost: number;
  /** Utility-AI drive added at social-tendency 1 (social agents seek mates more). */
  socialDriveBoost: number;
  childInitialHungerMax: number;
  childInitialThirstMax: number;
  childInitialEnergyMin: number;
  childInitialEnergyMax: number;
  childInitialHealth: number;
}

/**
 * Age-related mortality. This is *gradually rising pressure*, not a hard
 * "age > X -> die" rule: past `life.adultMaxAgeHours`, health drains at a rate
 * that grows linearly with age, so elderly agents are increasingly at risk and
 * are removed by the existing death system.
 */
export interface MortalityConfig {
  /** Health lost per in-game hour right at the elderly threshold. */
  elderlyHealthDrainPerHour: number;
  /** Additional health drain per in-game hour of age past the threshold. */
  ageHealthDrainPerHourExtra: number;
}

/**
 * Gene trade-offs: each genome trait carries a metabolic energy cost so high
 * values are not free. The energy drain while active is multiplied by
 * `1 + Σ(trait * factor)` — documented in ARCHITECTURE.md §Trade-offs.
 */
export interface MetabolismConfig {
  intelligenceCostFactor: number;
  strengthCostFactor: number;
  fertilityCostFactor: number;
  speedCostFactor: number;
}

/** Mutation tuning (per-gene probability and additive magnitude in [0, 1]). */
export interface MutationConfig {
  /** Probability that a single gene mutates when a child is created. */
  perGeneProbability: number;
  /** Maximum magnitude of an additive mutation (delta is uniform in [-m, +m]). */
  magnitude: number;
}

/**
 * Social layer (Phase 4). Every tunable of the social simulation lives here:
 * bounded relationship memory, social perception, the five social actions
 * (Socialize / Help / Cooperate / Avoid / Confront), kinship biases and the
 * emergent group system. All values are absolute so the social behavior of a
 * run is fully reproducible from (seed, config).
 */
export interface SocialConfig {
  /** Bounded social memory: relationships remembered per agent. */
  memory: {
    /** Maximum relationships one agent keeps (hard bound, LRU-style eviction). */
    capacity: number;
    /** Familiarity lost per in-game hour without contact. */
    familiarityDecayPerHour: number;
    /**
     * Hostility (negative score) healed per in-game hour without renewed
     * conflict — grudges fade, they are never permanently locked. Conflict
     * damage far outpaces this, so actively contested pairs stay hostile.
     */
    hostilityDecayPerHour: number;
    /** Prune when familiarity is below this AND |score| below pruneScore. */
    pruneFamiliarity: number;
    /** Prune when |score| is below this AND familiarity below pruneFamiliarity. */
    pruneScore: number;
    /** …and only when the last interaction is older than this many ticks. */
    pruneAgeTicks: number;
  };
  /** Perceiving other agents (spatial-index backed, never O(n²)). */
  perception: {
    /** Radius (tiles) within which other agents are socially perceived. */
    radiusTiles: number;
    /** Radius (tiles) within which co-presence builds familiarity. */
    presenceRadiusTiles: number;
    /** Familiarity gained per tick of close co-presence. */
    familiarityPerTickNear: number;
    /** Upper bound on nearby candidates inspected per agent per pass. */
    maxScan: number;
  };
  /** Shared reach for social interactions (socialize/help/cooperate/confront). */
  interaction: {
    radiusTiles: number;
  };
  /** Loneliness: the social need that drives Socialize. */
  loneliness: {
    /** Loneliness gained per in-game hour (scaled by social tendency). */
    perHour: number;
    /** Below this loneliness there is no urge to socialize. */
    threshold: number;
    /** Loneliness removed per in-reach socialize tick (initiator). */
    reliefPerSocialize: number;
    /** Loneliness removed for the passive partner of a socialize tick. */
    reliefPerSocializePassive: number;
  };
  /** Socialize: spend time together to build bonds (cheap, common). */
  socialize: {
    /** Familiarity gained per interaction tick (both sides). */
    familiarityGain: number;
    /** Relationship score gained per interaction tick. */
    scoreGain: number;
    /** Trust gained per interaction tick. */
    trustGain: number;
    /** Affinity of a stranger (no relationship yet) — bootstraps first contact. */
    strangerOpenness: number;
  };
  /** Help: costly support of an agent in need (reciprocity driver). */
  help: {
    /** Target counts as "in need" below this health (0..100). */
    healthNeedBelow: number;
    /** …or below this energy (0..100). */
    energyNeedBelow: number;
    /** Energy the helper pays per completed help (opportunity cost). */
    energyCost: number;
    /** Health the helped agent recovers. */
    healthBenefit: number;
    /** Energy the helped agent recovers. */
    energyBenefit: number;
    /** Trust the helped agent gains toward the helper (reciprocity core). */
    trustGain: number;
    /** Relationship score the helped agent gains toward the helper. */
    scoreGainTarget: number;
    /** Relationship score the helper gains toward the helped. */
    scoreGainHelper: number;
    /** Helpers must keep at least this energy (0..100) to consider helping. */
    minHelperEnergy: number;
    /** Helpers must keep at least this health (0..100) to consider helping. */
    minHelperHealth: number;
  };
  /** Cooperate: forage together for a bounded session (repeated bonding). */
  cooperation: {
    /** Ticks of sustained proximity until a session completes. */
    durationTicks: number;
    /** Extra energy the cooperator pays per session tick (coordination cost). */
    energyCostPerTick: number;
    /** Relationship score gain on completion (both sides). */
    scoreGain: number;
    /** Trust gain on completion (both sides). */
    trustGain: number;
    /** Familiarity gain on completion (both sides). */
    familiarityGain: number;
    /** Cooperative-foraging efficiency bonus ticks granted to the cooperator. */
    forageBonusTicks: number;
    /** Hunger relief multiplier while the bonus is active (efficiency, not free food). */
    forageBonusFactor: number;
    /** Same bonus for the (passive) partner — smaller (they spent no energy). */
    partnerForageBonusTicks: number;
    /** No new session with the same partner until this many ticks passed. */
    cooldownTicks: number;
  };
  /** Confront: interpersonal conflict over contested resources. */
  conflict: {
    /** Health lost by the loser per confrontation. */
    damage: number;
    /** Health lost by the winner (fighting is never free). */
    damageToWinner: number;
    /** Relationship score damage (both directions). */
    scoreDamage: number;
    /** Trust damage (both directions). */
    trustDamage: number;
    /** Distance (tiles) the loser is pushed away. */
    knockbackTiles: number;
    /** No second confrontation with the same agent until this many ticks passed. */
    cooldownTicks: number;
    /** Minimum hostility (−score) before confronting is considered at all. */
    minHostility: number;
    /** Relationship score lost when blaming a nearby agent for a depleted food patch. */
    resentmentPerDepletion: number;
    /** Relationship score lost when sharing a strained patch (less than one meal left). */
    resentmentPerContest: number;
    /** Radius (tiles) within which a failed forager blames a presumed competitor. */
    resentmentRadiusTiles: number;
    /** Minimum ticks between resentment events for the same pair. */
    resentmentIntervalTicks: number;
  };
  /** Kinship: biases derived from lineage — never unconditional friendship. */
  kinship: {
    /** Starting score of a seeded parent↔child relationship. */
    baseScore: number;
    /** Starting trust of a seeded kin relationship. */
    baseTrust: number;
    /** Starting familiarity of a seeded kin relationship. */
    baseFamiliarity: number;
    /** Help utility multiplier for kin targets. */
    helpBias: number;
    /** Socialize utility multiplier for kin targets. */
    socializeBias: number;
    /** Confront utility is scaled DOWN by this for kin. */
    confrontDampening: number;
  };
  /** Emergent group detection & membership (derived communities). */
  groups: {
    /** Detection runs every N ticks (never per tick — clustering is periodic). */
    detectionIntervalTicks: number;
    /** Clusters smaller than this never become groups. */
    minSize: number;
    /** Relationship score required for a social-graph edge. */
    edgeScoreThreshold: number;
    /** Edges additionally require members to be within this distance (tiles). */
    maxMemberDistanceTiles: number;
    /** Join a candidate group when joinUtility >= this. */
    joinThreshold: number;
    /** Leave a group when leaveUtility >= this. */
    leaveThreshold: number;
    /** Crowding discomfort starts above this member count. */
    preferredSize: number;
    /** Territory radius cap (tiles) — informational home region. */
    maxTerritoryRadiusTiles: number;
    /** Registry bound: no new groups form beyond this many concurrent groups. */
    maxGroups: number;
  };
}

/**
 * Culture & communication (Phase 5). Every knob of the cultural layer lives
 * here: bounded cultural memory, transmission (deliberate teaching + passive
 * imitation), discovery (where a tradition comes from before anyone teaches
 * it), proto-communication (signal tokens and their learned associations) and
 * the bounded behavioural multipliers culture feeds back into the Utility AI.
 *
 * Nothing here assigns a culture to anyone: the configuration only sets
 * rates/limits, and every actual item, association and tradition emerges from
 * interaction.
 */
export interface CultureConfig {
  /** Bounded cultural memory: how much one individual can know. */
  memory: {
    /** Maximum cultural items per agent (hard bound; the weakest is evicted). */
    capacity: number;
    /** Strength a newly discovered/learned item starts at. */
    initialStrength: number;
    /** Fraction a successful use/teaching moves strength toward 1. */
    baseLearningRate: number;
    /** Base forgetting rate per in-game hour for unused knowledge. */
    baseDecayPerHour: number;
    /** Items whose strength falls below this are forgotten. */
    forgetThreshold: number;
    /** Strength at which an item counts as known (statistics/inspector). */
    knownThreshold: number;
    /** Contradictory experience (a known location that is empty) erodes by this. */
    contradictionRate: number;
    /** Extra learning-rate multiplier at intelligence 1. */
    intelligenceLearningFactor: number;
    /** Fraction of the decay removed at intelligence 1 (better retention). */
    intelligenceRetentionFactor: number;
  };
  /** Deliberate teaching and observation-driven imitation. */
  transmission: {
    /** Baseline chance that one Teach interaction transfers an item. */
    teachChance: number;
    /** Baseline chance that one social interaction transfers an item by imitation. */
    imitateChance: number;
    /** Probability that a transmission copies the item exactly (else a variant). */
    fidelity: number;
    /** Confidence a learner receives, as a fraction of the source's strength. */
    learnedStrengthFactor: number;
    /** Maximum tile offset a location variant may drift by. */
    locationJitterTiles: number;
    /** Energy the teacher pays per attempt (successful or not). */
    teachEnergyCost: number;
    /** A teacher must keep at least this energy / health. */
    minTeacherEnergy: number;
    minTeacherHealth: number;
    /** Ticks before the same agent teaches again (time is a real cost). */
    cooldownTicks: number;
    /** Influence weights of the transmission-chance formula (see culture/learning). */
    relationshipWeight: number;
    familiarityWeight: number;
    intelligenceBonus: number;
    socialTendencyWeight: number;
    strengthWeight: number;
  };
  /** Where cultural items come from before anyone teaches them. */
  discovery: {
    /** Chance per successful forage of forming a location item. */
    locationChancePerForage: number;
    /** Chance per successful forage of working out a technique variant. */
    techniqueChancePerForage: number;
    /** Chance per tick of the matching activity to internalize a norm. */
    normChancePerTick: number;
    /** Probability that a newly invented technique suits the local terrain. */
    habitatMatchChance: number;
    /** Discovery-chance intelligence factor: chance *= floor + intelligence. */
    intelligenceFloor: number;
    /**
     * Confront utility above which the agent genuinely wanted to fight. Choosing
     * not to is what makes a restraint norm credible (and discoverable).
     */
    avoidConflictUrgeThreshold: number;
  };
  /** Proto-communication: signal tokens with learned, local meanings. */
  signals: {
    /**
     * Radius (tiles) within which a signal can be heard. Must not exceed
     * `social.perception.radiusTiles`: the listener search reuses the social
     * spatial index, whose 3×3-cell walk is only guaranteed to cover that
     * radius (asserted by a config test).
     */
    hearingRadiusTiles: number;
    /** Upper bound on listeners examined per emission (anti-quadratic guard). */
    maxListenersPerEmission: number;
    /** Upper bound on signals one listener processes per tick (attention). */
    maxObservationsPerTick: number;
    /** Energy one emission costs (communication is never free). */
    emissionEnergyCost: number;
    /** Ticks before the same agent emits again (spam prevention). */
    emissionCooldownTicks: number;
    /** An emitter must keep at least this energy. */
    minEnergyToEmit: number;
    /** Association update rate per observation. */
    learningRate: number;
    /** Association decay per in-game hour. */
    baseDecayPerHour: number;
    /** Associations whose strength falls below this are forgotten. */
    forgetThreshold: number;
    /** Strength at which an association counts as knowing the meaning. */
    knownThreshold: number;
    /** How fast a token's competing meanings decay when one is observed. */
    competitionDecay: number;
    /** Probability that a listener misattributes a token to a neighbouring one. */
    misperceptionChance: number;
    /** Extra learning-rate multiplier at intelligence 1. */
    intelligenceLearningFactor: number;
    /** Fraction of the decay removed at intelligence 1. */
    intelligenceRetentionFactor: number;
    /** Maximum meanings tracked per token (per agent). */
    maxMeaningsPerToken: number;
    /** Maximum associations tracked per agent. */
    maxAssociationsPerAgent: number;
    /** Ticks of heightened wariness granted by hearing a DANGER signal it knows. */
    alertTicks: number;
    /**
     * How long (ticks) a recent conflict keeps counting as "danger here" when
     * an observer grounds the meaning of a danger signal. Long enough to be
     * visible to bystanders, short enough that old fights are not re-signalled.
     */
    dangerContextTicks: number;
    /** Base Utility-AI drives of the signalling/teaching actions. */
    drive: {
      teach: number;
      danger: number;
      food: number;
      water: number;
      follow: number;
    };
    /** Nearby agents that count as a full "someone is listening" audience. */
    audienceForFullUtility: number;
  };
  /** How cultural knowledge changes behaviour (all bounded multipliers). */
  behavior: {
    /** Help utility multiplier boost at HelpOthers strength 1. */
    normHelpBoost: number;
    /** Cooperate utility multiplier boost at ShareFood strength 1. */
    normShareBoost: number;
    /** Confront utility reduction at AvoidConflict strength 1 (marginal fights). */
    normAvoidDampening: number;
    /**
     * Confront utility at which the AVOID_CONFLICT norm stops damping: norms
     * restrain marginal fights, never desperate ones.
     */
    normAvoidSpan: number;
    /** Value equivalent of a believed resource location at knowledge strength 1. */
    knownLocationValue: number;
    /** Foraging-relief bonus at technique strength 1 on the technique's terrain. */
    techniqueEfficiencyBonus: number;
    /** Foraging-relief factor a technique gives on foreign terrain. */
    foreignHabitatFactor: number;
    /** Avoid utility multiplier boost while alerted by a danger signal. */
    alertBoost: number;
  };
  /** Derived cultural summaries and the similarity metric (reporting only). */
  summary: {
    /** Share of a group's members holding an item for it to be a "tradition". */
    traditionShare: number;
    /** Most widespread items listed per summary. */
    maxItems: number;
    /** Traditions listed per summary. */
    maxTraditions: number;
    /** Signal conventions listed per summary. */
    maxSignals: number;
    /** Weight of the knowledge term in cultural similarity. */
    knowledgeWeight: number;
    /** Weight of the signal term in cultural similarity. */
    signalWeight: number;
    /** Groups compared pairwise for the global similarity statistic. */
    maxSimilarityGroups: number;
    /** Cultural events listed in the group inspector. */
    maxReportedEvents: number;
  };
}

export interface SimulationConfig {
  time: TimeConfig;
  world: WorldDimensions;
  movement: MovementConfig;
  needs: NeedsConfig;
  agents: AgentsConfig;
  ai: AiConfig;
  memory: MemoryConfig;
  resources: ResourcesConfig;
  life: LifeStageConfig;
  reproduction: ReproductionConfig;
  mortality: MortalityConfig;
  metabolism: MetabolismConfig;
  mutation: MutationConfig;
  social: SocialConfig;
  culture: CultureConfig;
}

/**
 * Recursively freeze a plain-data object.
 * WHY: DEFAULT_SIMULATION_CONFIG is module-level shared state handed to every
 * Simulation — freezing it turns accidental mutation of the default (instead
 * of a cloneConfig copy) into a loud error instead of silent cross-simulation
 * corruption. Note: structuredClone of a frozen object yields a normal
 * mutable clone, so cloneConfig keeps working.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = deepFreeze({
  time: {
    // 15 in-game minutes per tick: 96 ticks per in-game day.
    hoursPerTick: 0.25,
    baseTicksPerSecond: 10,
    maxTicksPerUpdateSlice: 1000,
    snapshotIntervalMs: 100,
  },
  world: {
    width: 64,
    height: 64,
  },
  movement: {
    baseSpeedTilesPerHour: 0.8,
    speedRangeTilesPerHour: 2.4,
    wanderTargetRadiusTiles: 6,
    targetReachedDistanceTiles: 0.25,
  },
  needs: {
    hungerPerHour: 0.8,
    thirstPerHour: 1.1,
    energyDrainPerHourActive: 2.0,
    energyRegenPerHourResting: 5.0,
    restEnergyThreshold: 20,
    wakeEnergyThreshold: 85,
    criticalNeedThreshold: 85,
    healthDrainPerHourCritical: 2.5,
    healthRegenPerHourComfortable: 1.0,
    comfortableNeedThreshold: 50,
  },
  agents: {
    initialPopulation: 50,
    spawn: {
      maxLandTileAttempts: 16,
      // All founding agents are adults (>= adolescentMaxAgeHours) but with a wide,
      // deterministic spread of ages up to the elderly threshold, so they can
      // breed immediately and their deaths are staggered rather than synchronized.
      initialAgeHours: 48,
      initialAgeVariationHours: 672,
      initialHungerMax: 15,
      initialThirstMax: 15,
      initialEnergyMin: 60,
      initialEnergyMax: 100,
      initialHealth: 100,
    },
  },
  ai: {
    perceptionRadiusTiles: 8,
    travelHorizonTiles: 24,
    seekFoodNeedThreshold: 30,
    seekWaterNeedThreshold: 30,
    explorationDrive: 0.2,
    hysteresisBonus: 0.08,
    tieBreakNoise: 0.01,
  },
  memory: {
    capacity: 8,
    baseLearningRate: 0.35,
    baseDecayPerHour: 0.03,
    initialValue: 0.5,
    forgetThreshold: 0.05,
    intelligenceLearningFactor: 0.8,
    intelligenceRetentionFactor: 0.6,
  },
  resources: {
    eatAmount: 0.1,
    drinkAmount: 0.1,
    hungerReliefPerEat: 40,
    thirstReliefPerDrink: 40,
    minFoodToEat: 0.02,
    minWaterToDrink: 0.02,
    foodRegenPerHour: 0.05,
    waterRegenPerHour: 0.05,
  },
  life: {
    childMaxAgeHours: 24,
    adolescentMaxAgeHours: 48,
    adultMaxAgeHours: 720,
    childMovementEfficiency: 0.6,
    adolescentMovementEfficiency: 0.8,
    adultMovementEfficiency: 1,
    elderlyMovementEfficiency: 0.75,
    // Children are small and relatively under-active, so they burn a little
    // less energy per active hour than adults; the cost of being an adult is
    // the gene metabolic load (see metabolism) and the need to reproduce.
    childEnergyDrainMultiplier: 0.8,
    adolescentEnergyDrainMultiplier: 0.95,
    adultEnergyDrainMultiplier: 1,
    elderlyEnergyDrainMultiplier: 0.9,
  },
  reproduction: {
    // The search radius is deliberately modest so the AgentIndex 3x3-cell walk
    // stays local (O(agents × local density), never O(n²) — the cells would cover
    // the whole world if the radius were as large as the map). This makes mate
    // finding density-limited; social tendency raises how often agents seek mates.
    partnerSeekRadiusTiles: 8,
    partnerReachTiles: 1.5,
    minHealthToReproduce: 50,
    minEnergyToReproduce: 25,
    // Breeding is only considered when an adult is genuinely comfortable: hunger
    // AND thirst must both be comfortably below the critical band, so a hungry or
    // thirsty agent never spawns offspring while it should be seeking food/water.
    maxNeedToReproduce: 60,
    // Six in-game days of cooldown after a successful birth. Reproduction is a
    // deliberate, rare act (multiplied by how urgent survival needs are), so the
    // population grows slowly and the founding wave can be replaced rather than
    // exploding; fertility still shortens this for high-fertility agents.
    cooldownHours: 144,
    fertilityCooldownReduction: 0.5,
    baseDrive: 0.12,
    fertilityDriveBoost: 0.25,
    socialDriveBoost: 0.1,
    childInitialHungerMax: 10,
    childInitialThirstMax: 10,
    childInitialEnergyMin: 60,
    childInitialEnergyMax: 100,
    childInitialHealth: 100,
  },
  mortality: {
    elderlyHealthDrainPerHour: 0.3,
    ageHealthDrainPerHourExtra: 0.05,
  },
  metabolism: {
    intelligenceCostFactor: 0.15,
    strengthCostFactor: 0.1,
    fertilityCostFactor: 0.05,
    speedCostFactor: 0.06,
  },
  mutation: {
    perGeneProbability: 0.08,
    magnitude: 0.08,
  },
  culture: {
    memory: {
      // Ten items per agent: a handful of places plus a technique or two and a
      // norm is a believable "personal culture", and the bound keeps cultural
      // memory O(agents × capacity) forever.
      capacity: 10,
      initialStrength: 0.45,
      baseLearningRate: 0.25,
      // 0.8% per in-game hour: unused knowledge fades below the forget
      // threshold (0.06) in roughly ten in-game days — traditions survive by
      // being used and re-taught, never by sitting in a store forever.
      baseDecayPerHour: 0.008,
      forgetThreshold: 0.06,
      knownThreshold: 0.35,
      contradictionRate: 0.3,
      intelligenceLearningFactor: 0.5,
      intelligenceRetentionFactor: 0.5,
    },
    transmission: {
      // Deliberate teaching usually works; observation only occasionally does.
      teachChance: 0.3,
      imitateChance: 0.03,
      // 15% of successful transmissions produce a slightly altered variant —
      // that is cultural drift, and it is the only source of cultural variation
      // besides independent discovery.
      fidelity: 0.85,
      // A freshly taught item starts at 80% of the teacher's confidence: you
      // never quite believe something as firmly as the person who told you.
      learnedStrengthFactor: 0.8,
      locationJitterTiles: 2,
      teachEnergyCost: 3,
      minTeacherEnergy: 25,
      minTeacherHealth: 40,
      // Six in-game hours between teachings by the same agent.
      cooldownTicks: 24,
      // Formula weights (see culture/learning.ts): no single factor dominates.
      relationshipWeight: 0.5,
      familiarityWeight: 0.6,
      intelligenceBonus: 0.6,
      socialTendencyWeight: 0.4,
      strengthWeight: 0.5,
    },
    discovery: {
      locationChancePerForage: 0.01,
      techniqueChancePerForage: 0.003,
      normChancePerTick: 0.004,
      habitatMatchChance: 0.7,
      // Discovery scales with intelligence but never requires it: even a dull
      // agent occasionally notices where the food was.
      intelligenceFloor: 0.4,
      avoidConflictUrgeThreshold: 0.25,
    },
    signals: {
      hearingRadiusTiles: 6,
      maxListenersPerEmission: 24,
      maxObservationsPerTick: 3,
      emissionEnergyCost: 1.5,
      // Half an in-game day between emissions per agent: signalling is an
      // occasional act, not a broadcast loop.
      emissionCooldownTicks: 48,
      minEnergyToEmit: 25,
      learningRate: 0.22,
      baseDecayPerHour: 0.01,
      forgetThreshold: 0.05,
      knownThreshold: 0.4,
      competitionDecay: 0.15,
      misperceptionChance: 0.03,
      intelligenceLearningFactor: 0.6,
      intelligenceRetentionFactor: 0.4,
      maxMeaningsPerToken: 2,
      maxAssociationsPerAgent: 8,
      alertTicks: 24,
      dangerContextTicks: 48,
      // Baseline motivation for each Phase 5 action (teaching + the four
      // signals). These are utilities, not probabilities: they are multiplied
      // by context factors (readiness, audience, grounding) and then compete
      // with every other action exactly like the Phase 1–4 utilities do.
      drive: {
        teach: 1.2,
        danger: 0.55,
        food: 0.35,
        water: 0.35,
        follow: 0.25,
      },
      audienceForFullUtility: 2,
    },
    behavior: {
      normHelpBoost: 0.6,
      normShareBoost: 0.5,
      normAvoidDampening: 0.6,
      normAvoidSpan: 0.35,
      knownLocationValue: 0.7,
      techniqueEfficiencyBonus: 0.35,
      foreignHabitatFactor: 0.35,
      alertBoost: 0.5,
    },
    summary: {
      traditionShare: 0.5,
      maxItems: 4,
      maxTraditions: 3,
      maxSignals: 3,
      knowledgeWeight: 0.6,
      signalWeight: 0.4,
      maxSimilarityGroups: 24,
      maxReportedEvents: 8,
    },
  },
  social: {
    memory: {
      // 16 remembered others per agent: enough for a family + a band of
      // regular contacts, bounded so social memory can never grow with the
      // population (O(agents × capacity), never O(agents²)).
      capacity: 16,
      familiarityDecayPerHour: 0.01,
      // A full grudge (−1) heals to zero in ~500 in-game hours (~3 weeks):
      // grudges fade with time, but slowly — renewed competition always
      // outpaces healing, abandoned ones linger, none are permanent.
      hostilityDecayPerHour: 0.002,
      pruneFamiliarity: 0.05,
      pruneScore: 0.08,
      // ~4 in-game days without contact and without bonds -> forgotten.
      pruneAgeTicks: 384,
    },
    perception: {
      // Same scale as the resource/partner perception: a full day of close
      // co-presence (96 ticks) builds strong familiarity.
      radiusTiles: 8,
      presenceRadiusTiles: 3,
      familiarityPerTickNear: 0.006,
      maxScan: 32,
    },
    interaction: {
      radiusTiles: 1.5,
    },
    loneliness: {
      // ~50 in-game hours from fully content to fully lonely (scaled by
      // social tendency), so socializing is a regular but not constant drive.
      perHour: 2,
      threshold: 25,
      reliefPerSocialize: 22,
      reliefPerSocializePassive: 8,
    },
    socialize: {
      familiarityGain: 0.03,
      scoreGain: 0.01,
      trustGain: 0.004,
      strangerOpenness: 0.4,
    },
    help: {
      healthNeedBelow: 70,
      energyNeedBelow: 40,
      energyCost: 8,
      healthBenefit: 6,
      energyBenefit: 4,
      trustGain: 0.12,
      scoreGainTarget: 0.08,
      scoreGainHelper: 0.04,
      minHelperEnergy: 30,
      minHelperHealth: 40,
    },
    cooperation: {
      // Six in-game hours of foraging together completes a session.
      durationTicks: 24,
      energyCostPerTick: 0.6,
      scoreGain: 0.15,
      trustGain: 0.12,
      familiarityGain: 0.06,
      forageBonusTicks: 48,
      forageBonusFactor: 0.5,
      partnerForageBonusTicks: 24,
      cooldownTicks: 96,
    },
    conflict: {
      damage: 4,
      damageToWinner: 1.5,
      scoreDamage: 0.15,
      trustDamage: 0.2,
      knockbackTiles: 1.2,
      // One confrontation per pair per in-game day: de-escalation, no spirals.
      cooldownTicks: 96,
      minHostility: 0.15,
      // A forager that finds its patch stripped and a competitor present
      // blames that competitor strongly (one such event is as damaging as a
      // confrontation); sharing a strained patch is milder.
      resentmentPerDepletion: 0.15,
      resentmentPerContest: 0.08,
      resentmentRadiusTiles: 3,
      resentmentIntervalTicks: 16,
    },
    kinship: {
      baseScore: 0.4,
      baseTrust: 0.55,
      baseFamiliarity: 0.9,
      helpBias: 0.5,
      socializeBias: 0.25,
      confrontDampening: 0.75,
    },
    groups: {
      // Community detection once per in-game day — periodic, never per tick.
      detectionIntervalTicks: 96,
      minSize: 3,
      edgeScoreThreshold: 0.15,
      maxMemberDistanceTiles: 14,
      joinThreshold: 0.18,
      leaveThreshold: 0.6,
      preferredSize: 12,
      maxTerritoryRadiusTiles: 20,
      maxGroups: 64,
    },
  },
} satisfies SimulationConfig);

/** Deep-clone a config (configs are treated as immutable per simulation). */
export function cloneConfig(config: SimulationConfig): SimulationConfig {
  return structuredClone(config);
}

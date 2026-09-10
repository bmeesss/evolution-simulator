/**
 * Agent intents — the contract between the AI module and the simulation
 * systems.
 *
 * The `intent` component store holds the currently selected intent per agent.
 * The Utility AI (`utility-ai.ts`) *decides* what an agent wants and writes an
 * intent (+ target); the simulation systems *execute* the consequences:
 *   - movement-system moves agents with movement intents (Wander/SeekFood/
 *     SeekWater) toward their target
 *   - resource-system consumes food/water for Eat/Drink
 *   - needs-system regenerates energy only for Rest
 *
 * The numeric values are stored per tile in the `intent` store's Uint8 `kind`
 * column, so they must stay stable across save formats. Appending new values
 * at the end is safe; renumbering requires a save-format bump.
 *
 * Movement vs. non-movement intents: Eat/Drink/Rest are stationary (their
 * target is where the agent already stands); the movement system only acts on
 * kinds returned by `isMovementIntent`. SeekPartner is a movement intent: the
 * agent travels toward its chosen partner's position (targetEntity).
 */

export const AgentIntent = {
  /** Resting: no movement, energy regenerates. */
  Rest: 0,
  /** Wandering/exploring: move toward a target with no known resource there. */
  Wander: 1,
  /** Travel toward a food tile (target is the chosen tile). */
  SeekFood: 2,
  /** Travel toward a water tile (target is the chosen tile). */
  SeekWater: 3,
  /** Consume food at the agent's current tile (no movement). */
  Eat: 4,
  /** Drink water at the agent's current tile (no movement). */
  Drink: 5,
  /** Seek a nearby reproductively-eligible partner (targetEntity = partner). */
  SeekPartner: 6,
  /** Spend time with a nearby agent to build a bond (Phase 4 social). */
  Socialize: 7,
  /** Move to and support a nearby agent in need (costly, Phase 4 social). */
  Help: 8,
  /** Forage together with a bonded partner for a session (Phase 4 social). */
  Cooperate: 9,
  /** Flee from a nearby feared/hostile agent (targetEntity = threat). */
  Avoid: 10,
  /** Contest resources with a hostile nearby agent (Phase 4 conflict). */
  Confront: 11,
  /**
   * Deliberately teach a nearby agent something the teacher knows (Phase 5).
   * A movement intent: the teacher travels to the learner, then spends time
   * (energy + a cooldown) on the attempt. Transmission is probabilistic — see
   * culture/learning.ts.
   */
  Teach: 12,
  /** Warn nearby agents about a threat (Phase 5 proto-communication). */
  SignalDanger: 13,
  /** Announce food at the agent's location (Phase 5 proto-communication). */
  SignalFood: 14,
  /** Announce water at the agent's location (Phase 5 proto-communication). */
  SignalWater: 15,
  /** Invite nearby agents along toward a resource (Phase 5 proto-communication). */
  SignalFollow: 16,
} as const;

export type AgentIntent = (typeof AgentIntent)[keyof typeof AgentIntent];

/** Number of distinct intents (kept explicit so callers can pre-size buffers). */
export const INTENT_COUNT = 17;

const NAMES: readonly string[] = [
  'rest',
  'wander',
  'seek-food',
  'seek-water',
  'eat',
  'drink',
  'seek-partner',
  'socialize',
  'help',
  'cooperate',
  'avoid',
  'confront',
  'teach',
  'signal-danger',
  'signal-food',
  'signal-water',
  'signal-follow',
];

/** Human-readable name for an intent kind (used in the agent inspector UI). */
export function intentName(kind: number): string {
  return NAMES[kind] ?? 'unknown';
}

/**
 * True for intents the movement system should act on (travel toward target).
 * The social intents all travel (toward the target agent — or, for Avoid,
 * toward a computed flee position).
 */
export function isMovementIntent(kind: number): boolean {
  return (
    kind === AgentIntent.Wander ||
    kind === AgentIntent.SeekFood ||
    kind === AgentIntent.SeekWater ||
    kind === AgentIntent.SeekPartner ||
    kind === AgentIntent.Socialize ||
    kind === AgentIntent.Help ||
    kind === AgentIntent.Cooperate ||
    kind === AgentIntent.Avoid ||
    kind === AgentIntent.Confront ||
    kind === AgentIntent.Teach
  );
}

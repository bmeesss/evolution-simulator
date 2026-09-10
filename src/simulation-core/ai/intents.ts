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
} as const;

export type AgentIntent = (typeof AgentIntent)[keyof typeof AgentIntent];

/** Number of distinct intents (kept explicit so callers can pre-size buffers). */
export const INTENT_COUNT = 7;

const NAMES: readonly string[] = ['rest', 'wander', 'seek-food', 'seek-water', 'eat', 'drink', 'seek-partner'];

/** Human-readable name for an intent kind (used in the agent inspector UI). */
export function intentName(kind: number): string {
  return NAMES[kind] ?? 'unknown';
}

/** True for intents the movement system should act on (travel toward target). */
export function isMovementIntent(kind: number): boolean {
  return (
    kind === AgentIntent.Wander ||
    kind === AgentIntent.SeekFood ||
    kind === AgentIntent.SeekWater ||
    kind === AgentIntent.SeekPartner
  );
}

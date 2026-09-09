/**
 * Agent intents — the contract between the AI module and the simulation
 * systems.
 *
 * The `intent` component store holds the currently selected intent per agent.
 * An AI implementation (today: simple wander/rest rules; later: Utility AI)
 * writes intents; the movement and needs systems read them. This one small
 * store is the entire seam that lets the AI be replaced without touching any
 * other system.
 */

export const AgentIntent = {
  /** Resting: no movement, energy regenerates. */
  Rest: 0,
  /** Wandering: move toward the current target. */
  Wander: 1,
} as const;

export type AgentIntent = (typeof AgentIntent)[keyof typeof AgentIntent];

export function intentName(kind: number): 'rest' | 'wander' {
  return kind === AgentIntent.Rest ? 'rest' : 'wander';
}

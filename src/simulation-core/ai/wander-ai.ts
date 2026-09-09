/**
 * TEMPORARY phase-1 behavior: minimal wander/rest intent selection.
 *
 * This module is a placeholder that proves the simulation loop end-to-end. A
 * later phase replaces it with Utility AI: score candidate actions (drink, eat,
 * rest, socialize...) and write the winning action into the same `intent`
 * component store. No other system needs to change — that is the contract
 * documented in ai/intents.ts and ARCHITECTURE.md.
 *
 * Rule (deterministic, state-only — no randomness here):
 *   - wandering + energy < restThreshold  -> rest
 *   - resting  + energy > wakeThreshold   -> wander (target reset to own
 *     position, which makes the movement system pick a fresh target next tick)
 * The two thresholds create hysteresis so agents do not flicker between states.
 */

import { AgentIntent } from './intents';
import type { TickContext } from '../simulation/tick-context';

export function selectIntents(ctx: TickContext): void {
  const { ecs, config } = ctx;
  const intent = ecs.intent;
  const needs = ecs.needs;
  const position = ecs.position;
  const restThreshold = config.needs.restEnergyThreshold;
  const wakeThreshold = config.needs.wakeEnergyThreshold;

  for (let i = 0; i < intent.count; i++) {
    const kind = intent.columns.kind[i];
    if (kind !== AgentIntent.Wander && kind !== AgentIntent.Rest) continue;
    const entity = intent.entityOf[i];
    const needsSlot = needs.index[entity];
    if (needsSlot < 0) continue; // defensive: agent without needs keeps its intent

    const energy = needs.columns.energy[needsSlot];
    if (kind === AgentIntent.Wander && energy < restThreshold) {
      intent.columns.kind[i] = AgentIntent.Rest;
    } else if (kind === AgentIntent.Rest && energy > wakeThreshold) {
      intent.columns.kind[i] = AgentIntent.Wander;
      const positionSlot = position.index[entity];
      if (positionSlot >= 0) {
        // Setting the target to the current position forces an immediate
        // retarget in the movement system (target is trivially reached).
        intent.columns.targetX[i] = position.columns.x[positionSlot];
        intent.columns.targetY[i] = position.columns.y[positionSlot];
      }
    }
  }
}

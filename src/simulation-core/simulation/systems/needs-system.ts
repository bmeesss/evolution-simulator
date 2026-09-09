/**
 * Needs system: hunger, thirst, energy and health dynamics.
 *
 * Hunger and thirst rise over time; energy is spent while active (any
 * non-Rest intent) and restored while resting (Rest intent); health decays
 * while any need is critical and slowly recovers while all needs are
 * comfortable. Eating/drinking relief is applied by the resource system, which
 * runs before this system in the fixed order. The system iterates the dense
 * `needs` store directly (SoA hot path, zero allocation).
 */

import { NEED_MAX, NEED_MIN } from '../config';
import type { TickContext } from '../tick-context';
import { AgentIntent } from '../../ai';

export function updateNeeds(ctx: TickContext): void {
  const { ecs, config, dtHours } = ctx;
  const needs = ecs.needs;
  const intent = ecs.intent;
  const health = ecs.health;
  const needsConfig = config.needs;

  const hungerPerTick = needsConfig.hungerPerHour * dtHours;
  const thirstPerTick = needsConfig.thirstPerHour * dtHours;
  const energyDrainPerTick = needsConfig.energyDrainPerHourActive * dtHours;
  const energyRegenPerTick = needsConfig.energyRegenPerHourResting * dtHours;

  for (let i = 0; i < needs.count; i++) {
    const columns = needs.columns;
    columns.hunger[i] = Math.min(NEED_MAX, columns.hunger[i] + hungerPerTick);
    columns.thirst[i] = Math.min(NEED_MAX, columns.thirst[i] + thirstPerTick);

    // Energy flows depend on the agent's intent. An agent without an intent
    // component (none exist today) is treated as active.
    const entity = needs.entityOf[i];
    const intentSlot = intent.index[entity];
    const isResting = intentSlot >= 0 && intent.columns.kind[intentSlot] === AgentIntent.Rest;
    if (isResting) {
      columns.energy[i] = Math.min(NEED_MAX, columns.energy[i] + energyRegenPerTick);
    } else {
      columns.energy[i] = Math.max(NEED_MIN, columns.energy[i] - energyDrainPerTick);
    }

    // Health: decays when a need is critical, slowly recovers when comfortable.
    const healthSlot = health.index[entity];
    if (healthSlot < 0) continue;
    const isCritical =
      columns.hunger[i] >= needsConfig.criticalNeedThreshold ||
      columns.thirst[i] >= needsConfig.criticalNeedThreshold ||
      columns.energy[i] <= NEED_MIN;
    if (isCritical) {
      health.columns.current[healthSlot] = Math.max(
        NEED_MIN,
        health.columns.current[healthSlot] - needsConfig.healthDrainPerHourCritical * dtHours,
      );
    } else if (
      columns.hunger[i] <= needsConfig.comfortableNeedThreshold &&
      columns.thirst[i] <= needsConfig.comfortableNeedThreshold &&
      columns.energy[i] >= needsConfig.comfortableNeedThreshold
    ) {
      health.columns.current[healthSlot] = Math.min(
        NEED_MAX,
        health.columns.current[healthSlot] + needsConfig.healthRegenPerHourComfortable * dtHours,
      );
    }
  }
}

/**
 * Aging system: advances every agent's age by the tick's in-game hours.
 * Death from old age is deliberately NOT implemented in phase 1 (later phase).
 */

import type { TickContext } from '../tick-context';

export function updateAging(ctx: TickContext): void {
  const age = ctx.ecs.age;
  const dt = ctx.dtHours;
  const columns = age.columns;
  for (let i = 0; i < age.count; i++) {
    columns.ageHours[i] += dt;
  }
}

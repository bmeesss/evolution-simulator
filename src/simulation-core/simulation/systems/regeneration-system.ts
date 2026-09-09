/**
 * Resource regeneration: food and water slowly recover toward their per-tile
 * caps (the values the world was generated with).
 *
 * Deliberately simple for Phase 2 — a linear regrowth of a configurable
 * fraction of the cap per hour. Its purpose is only to stop a handful of
 * agents from permanently exhausting the map; seasons, climate and other
 * spatiotemporal variation are future phases. The formula uses only +, *, min
 * and Math.min, so it is fully deterministic.
 */

import type { TickContext } from '../tick-context';

export function regenerateResources(ctx: TickContext): void {
  const { world, config, dtHours } = ctx;
  const foodRegen = config.resources.foodRegenPerHour * dtHours;
  const waterRegen = config.resources.waterRegenPerHour * dtHours;

  for (let i = 0; i < world.size; i++) {
    const foodCap = world.foodCap[i];
    if (world.food[i] < foodCap) {
      world.food[i] = Math.min(foodCap, world.food[i] + foodCap * foodRegen);
    }
    const waterCap = world.waterCap[i];
    if (world.water[i] < waterCap) {
      world.water[i] = Math.min(waterCap, world.water[i] + waterCap * waterRegen);
    }
  }
}

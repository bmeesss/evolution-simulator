/**
 * Movement system: moves wandering agents toward their current target.
 *
 * Speed is derived from the genome `speed` trait. When a target is reached, a
 * new one is drawn from the tick RNG within the wander radius — RNG draws
 * happen only on retarget, in dense-slot order, which keeps the whole
 * simulation deterministic. Positions are clamped to the valid world range so
 * agents can never leave it.
 *
 * Note on determinism: we use sqrt(dx*dx + dy*dy) rather than Math.hypot —
 * hypot is allowed extra precision freedom per the ECMAScript spec, which
 * could differ between engines.
 */

import type { TickContext } from '../tick-context';
import { AgentIntent } from '../../ai';

/** Clamp to [min, max], reflecting values that fall outside an edge back inside. */
function mirrorClamp(value: number, min: number, max: number): number {
  if (value < min) value = min + (min - value);
  if (value > max) value = max - (value - max);
  return Math.min(max, Math.max(min, value));
}

export function moveAgents(ctx: TickContext): void {
  const { ecs, world, rng, config, dtHours } = ctx;
  const intent = ecs.intent;
  const position = ecs.position;
  const genome = ecs.genome;

  const maxX = world.width - 1;
  const maxY = world.height - 1;
  const reachDistance = config.movement.targetReachedDistanceTiles;
  const reachSquared = reachDistance * reachDistance;
  const wanderRadius = config.movement.wanderTargetRadiusTiles;

  for (let i = 0; i < intent.count; i++) {
    if (intent.columns.kind[i] !== AgentIntent.Wander) continue;
    const entity = intent.entityOf[i];
    const positionSlot = position.index[entity];
    const genomeSlot = genome.index[entity];
    if (positionSlot < 0) continue; // defensive: an agent must have a position to move

    let x = position.columns.x[positionSlot];
    let y = position.columns.y[positionSlot];

    if (intent.columns.targetX[i] === x && intent.columns.targetY[i] === y) {
      // Target trivially reached (also the wake-from-rest signal): pick a new one.
      const offsetX = (rng.nextFloat() * 2 - 1) * wanderRadius;
      const offsetY = (rng.nextFloat() * 2 - 1) * wanderRadius;
      intent.columns.targetX[i] = mirrorClamp(x + offsetX, 0, maxX);
      intent.columns.targetY[i] = mirrorClamp(y + offsetY, 0, maxY);
    }

    const targetX = intent.columns.targetX[i];
    const targetY = intent.columns.targetY[i];
    const dx = targetX - x;
    const dy = targetY - y;
    const distanceSquared = dx * dx + dy * dy;

    if (distanceSquared > reachSquared) {
      const genomeSpeed = genomeSlot >= 0 ? genome.columns.speed[genomeSlot] : 0;
      const speedTilesPerHour =
        config.movement.baseSpeedTilesPerHour + genomeSpeed * config.movement.speedRangeTilesPerHour;
      const maxStep = speedTilesPerHour * dtHours;
      const distance = Math.sqrt(distanceSquared);
      if (distance > maxStep) {
        x += (dx / distance) * maxStep;
        y += (dy / distance) * maxStep;
      } else {
        x = targetX;
        y = targetY;
      }
    } else {
      x = targetX;
      y = targetY;
    }

    // Final safety clamp: agents always stay inside the valid world.
    position.columns.x[positionSlot] = Math.min(maxX, Math.max(0, x));
    position.columns.y[positionSlot] = Math.min(maxY, Math.max(0, y));
  }
}

/**
 * Movement system: moves agents toward their intent target.
 *
 * The AI (selectIntents) already decided WHERE an agent wants to go and wrote
 * the target into the `intent` store; this system only executes that movement
 * for movement intents (Wander/SeekFood/SeekWater). Rest/Eat/Drink are
 * stationary and are skipped. Target picking (including wander targets) lives
 * entirely in the AI so all randomness stays on the `ai` RNG stream.
 *
 * Speed is derived from the genome `speed` trait. Positions are clamped to the
 * valid world range so agents can never leave it.
 *
 * Determinism note: we use sqrt(dx*dx + dy*dy) rather than Math.hypot — hypot
 * is allowed extra precision freedom per the ECMAScript spec, which could
 * differ between engines.
 */

import type { TickContext } from '../tick-context';
import { isMovementIntent } from '../../ai';

export function moveAgents(ctx: TickContext): void {
  const { ecs, world, config, dtHours } = ctx;
  const intent = ecs.intent;
  const position = ecs.position;
  const genome = ecs.genome;

  const maxX = world.width - 1;
  const maxY = world.height - 1;
  const reachDistance = config.movement.targetReachedDistanceTiles;
  const reachSquared = reachDistance * reachDistance;

  for (let i = 0; i < intent.count; i++) {
    if (!isMovementIntent(intent.columns.kind[i])) continue;
    const entity = intent.entityOf[i];
    const positionSlot = position.index[entity];
    const genomeSlot = genome.index[entity];
    if (positionSlot < 0) continue; // defensive: an agent must have a position to move

    let x = position.columns.x[positionSlot];
    let y = position.columns.y[positionSlot];

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

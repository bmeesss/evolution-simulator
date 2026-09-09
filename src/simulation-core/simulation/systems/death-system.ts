/**
 * Death system: removes agents whose health has reached zero.
 *
 * Health is damaged by the needs system (severe hunger/thirst/energy); this
 * system collects every agent with health <= 0 in one pass, then detaches all
 * of their components, frees their memory and destroys the entity. Collection
 * happens before any mutation so the swap-remove inside the stores/registry is
 * safe and order-independent of the iteration.
 *
 * Entity IDs stay monotonic and are never reused; the population simply
 * shrinks (no new population cap). Deaths emit `agent_died` with the current
 * tick stamp.
 */

import type { TickContext } from '../tick-context';
import { lifeStageForAge, LifeStage } from '../life-stages';

/** Returns the number of agents removed (used for the cumulative death count). */
export function updateDeaths(ctx: TickContext): number {
  const ecs = ctx.ecs;
  const health = ecs.health;

  // First pass: identify the dead (health store may not be mutated here).
  let dead: number[] | null = null;
  for (let i = 0; i < health.count; i++) {
    if (health.columns.current[i] > 0) continue;
    if (dead === null) dead = [];
    dead.push(health.entityOf[i]);
  }
  if (dead === null) return 0;

  for (const entity of dead) {
    // Tag old-age deaths distinctly (elderly agents removed by age pressure).
    const ageSlot = ecs.age.index[entity];
    const ageHours = ageSlot >= 0 ? ecs.age.columns.ageHours[ageSlot] : 0;
    const isElderly = lifeStageForAge(ageHours, ctx.config) === LifeStage.Elderly;

    ctx.events.record('agent_died', { entityId: entity, detail: 'health depleted' });
    if (isElderly) ctx.events.record('old_age_death', { entityId: entity });

    ecs.memory.removeAll(entity);
    ecs.position.detach(entity);
    ecs.needs.detach(entity);
    ecs.age.detach(entity);
    ecs.health.detach(entity);
    ecs.genome.detach(entity);
    ecs.intent.detach(entity);
    ecs.aiState.detach(entity);
    ecs.lineage.detach(entity);
    ecs.reproductive.detach(entity);
    ecs.entities.destroy(entity);
  }
  return dead.length;
}

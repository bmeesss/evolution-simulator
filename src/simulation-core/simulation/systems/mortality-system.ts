/**
 * Age-related mortality: gradually rising health pressure once an agent is
 * elderly.
 *
 * There is NO hard "age > X -> die" rule. Instead, past `config.life.adultMaxAgeHours`
 * health is drained at a rate that grows linearly with age:
 *
 *   drain(h) = elderlyHealthDrainPerHour + (h - adultMaxAgeHours) * ageHealthDrainPerHourExtra
 *
 * so an agent just past the threshold ages gently, and the risk accelerates the
 * older it grows. The health value is what the existing death system watches
 * (health <= 0 -> removed), so this system only *adds pressure* — it never
 * removes an agent itself. Elderly agents also move slower and breed less often
 * (reproduction gates on health), which is the real selection mechanism.
 *
 * Determinism: the drain is a pure function of age and config (no RNG), so it
 * is fully reproducible.
 */

import type { TickContext } from '../tick-context';

/** Health drained per in-game hour at a given age (0 when not yet elderly). */
export function ageHealthDrainPerHour(ageHours: number, config: TickContext['config']): number {
  const { adultMaxAgeHours } = config.life;
  if (ageHours <= adultMaxAgeHours) return 0;
  const pastThreshold = ageHours - adultMaxAgeHours;
  return config.mortality.elderlyHealthDrainPerHour + pastThreshold * config.mortality.ageHealthDrainPerHourExtra;
}

export function updateMortality(ctx: TickContext): void {
  const { ecs, config, dtHours } = ctx;
  const health = ecs.health;
  const age = ecs.age;

  for (let i = 0; i < health.count; i++) {
    const entity = health.entityOf[i];
    const ageSlot = age.index[entity];
    if (ageSlot < 0) continue;
    const drain = ageHealthDrainPerHour(age.columns.ageHours[ageSlot], config) * dtHours;
    if (drain > 0) {
      health.columns.current[i] = Math.max(0, health.columns.current[i] - drain);
    }
  }
}

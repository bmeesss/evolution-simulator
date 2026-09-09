/**
 * Memory system: applies forgetting to every agent's remembered locations and
 * prunes memories that have decayed below usefulness.
 *
 * The update is a uniform multiplicative decay (see ai/memory/learning.ts) —
 * each reinforcement pushes a value toward 1 and this pass pulls it back down,
 * so memories fade unless re-confirmed by experience. The decay rate is
 * intelligence-modulated (smarter agents retain longer), which is the first
 * place the genome's intelligence trait meaningfully shapes behavior.
 *
 * Determinism: iteration follows the entity registry's allocation order and
 * each agent's chain order; removal is deterministic (see MemoryStore).
 */

import type { TickContext } from '../tick-context';
import { effectiveDecayPerHour, decayValue } from '../../ai';

export function updateMemory(ctx: TickContext): void {
  const { ecs, config, dtHours } = ctx;
  const memory = ecs.memory;
  const genome = ecs.genome;
  const forgetThreshold = config.memory.forgetThreshold;
  const entities = ecs.entities;

  for (let k = 0; k < entities.aliveCount; k++) {
    const entity = entities.aliveIds[k];
    if (!memory.has(entity)) continue;

    const genomeSlot = genome.index[entity];
    const intelligence = genomeSlot >= 0 ? genome.columns.intelligence[genomeSlot] : 0;
    const decayPerTick = effectiveDecayPerHour(intelligence, config) * dtHours;

    let entry = memory.headOf(entity);
    while (entry !== -1) {
      const next = memory.nextOf(entry);
      const nextValue = decayValue(memory.entryValue(entry), decayPerTick);
      if (nextValue <= forgetThreshold) {
        memory.removeEntry(entity, entry);
      } else {
        memory.setEntryValue(entry, nextValue);
      }
      entry = next;
    }
  }
}

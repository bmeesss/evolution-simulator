/**
 * Reproduction system: turns a Utility-AI SeekPartner decision into a birth.
 *
 * Separation of concerns (see ARCHITECTURE.md §Phase 3):
 *   - Decision         : the AI (utility-ai.ts) chooses SeekPartner AND selects
 *                        the best nearby valid partner (via AgentIndex), writing
 *                        the partner id + position into the intent store.
 *   - Partner selection: done in the AI, not here.
 *   - Reproduction exec: this system. When a seeker is within reach of its
 *                        selected partner and both are still eligible, a child
 *                        is created, genes are crossed over + mutated, lineage
 *                        is assigned and events are emitted.
 *
 * Eligibility gates (hard, deterministic):
 *   - both parents at an adult/elderly life stage (no reproduction pre-adulthood)
 *   - health >= minHealthToReproduce
 *   - energy >= minEnergyToReproduce
 *   - hunger AND thirst below maxNeedToReproduce (never breed while starving)
 *   - opposite sexes (binary deterministic model)
 *   - both cooldowns expired (a successful birth sets a fertility-scaled cooldown
 *     on both parents, preventing reproduction spam)
 *
 * The child starts at age 0, gets fresh AI state and an empty (born) memory —
 * it inherits genes but NOT life experience. All randomness uses the `repro`
 * RNG stream (sex, crossover, mutation, position/needs jitter) so reproduction
 * never shifts the sim/ai/spawn streams.
 */

import type { TickContext } from '../tick-context';
import type { SimulationEcs } from '../../ecs';
import type { EntityId } from '../../ecs';
import { AgentIntent } from '../../ai';
import { crossoverGenomes, mutateGenome } from '../../genetics';
import type { GenomeValues } from '../../genetics';
import { lifeStageForAge, isReproductiveStage } from '../life-stages';
import type { SimulationConfig } from '../config';

/** Hard, deterministic "can this agent breed right now?" gate. */
function canReproduce(entity: EntityId, ecs: SimulationEcs, config: SimulationConfig): boolean {
  const reproSlot = ecs.reproductive.index[entity];
  const ageSlot = ecs.age.index[entity];
  const healthSlot = ecs.health.index[entity];
  const needsSlot = ecs.needs.index[entity];
  if (reproSlot < 0 || ageSlot < 0 || healthSlot < 0 || needsSlot < 0) return false;

  const stage = lifeStageForAge(ecs.age.columns.ageHours[ageSlot], config);
  if (!isReproductiveStage(stage)) return false;
  if (ecs.health.columns.current[healthSlot] < config.reproduction.minHealthToReproduce) return false;
  if (ecs.needs.columns.energy[needsSlot] < config.reproduction.minEnergyToReproduce) return false;
  if (
    ecs.needs.columns.hunger[needsSlot] >= config.reproduction.maxNeedToReproduce ||
    ecs.needs.columns.thirst[needsSlot] >= config.reproduction.maxNeedToReproduce
  ) {
    return false;
  }
  if (ecs.reproductive.columns.cooldownHours[reproSlot] > 0) return false;
  return true;
}

/** Fertility-scaled cooldown (higher fertility -> shorter cooldown -> more offspring). */
function cooldownFor(fertility: number, config: SimulationConfig): number {
  const reduction = config.reproduction.fertilityCooldownReduction * fertility;
  return Math.max(0, config.reproduction.cooldownHours * (1 - reduction));
}

function genomeFor(ecs: SimulationEcs, entity: EntityId): GenomeValues {
  const slot = ecs.genome.index[entity];
  const g = ecs.genome.columns;
  return {
    intelligence: g.intelligence[slot],
    strength: g.strength[slot],
    speed: g.speed[slot],
    fertility: g.fertility[slot],
    socialTendency: g.socialTendency[slot],
  };
}

/** Set the cached `eligible` flag for an agent from the current hard gates. */
function refreshEligibility(entity: EntityId, ecs: SimulationEcs, config: SimulationConfig): void {
  const slot = ecs.reproductive.index[entity];
  if (slot < 0) return;
  ecs.reproductive.columns.eligible[slot] = canReproduce(entity, ecs, config) ? 1 : 0;
}

/**
 * Create a child of parentA (the seeker) and parentB (the partner). The child
 * receives lineage (generation = max(parentGen)+1), a 50/50 binary sex, a
 * crossovered + mutated genome, fresh needs/health/position, an empty memory
 * and fresh AI state. Emits `birth` and any `mutation` events (one per gene
 * that actually changed). Returns the new entity id.
 */
function createChild(ctx: TickContext, parentA: EntityId, parentB: EntityId): EntityId {
  const { ecs, world, config, reproRng, events } = ctx;
  const repro = config.reproduction;

  const entity = ecs.entities.create();

  // Position near parent A (small deterministic jitter), clamped to the world.
  const parentASlot = ecs.position.index[parentA];
  const px = ecs.position.columns.x[parentASlot];
  const py = ecs.position.columns.y[parentASlot];
  const jitter = 0.5;
  let x = px + (reproRng.nextFloat() * 2 - 1) * jitter;
  let y = py + (reproRng.nextFloat() * 2 - 1) * jitter;
  x = Math.min(world.width - 1, Math.max(0, x));
  y = Math.min(world.height - 1, Math.max(0, y));
  ecs.position.attach(entity, { x, y });

  ecs.needs.attach(entity, {
    hunger: reproRng.rangeFloat(0, repro.childInitialHungerMax),
    thirst: reproRng.rangeFloat(0, repro.childInitialThirstMax),
    energy: reproRng.rangeFloat(repro.childInitialEnergyMin, repro.childInitialEnergyMax),
  });
  ecs.age.attach(entity, { ageHours: 0 });
  ecs.health.attach(entity, { current: repro.childInitialHealth });

  const parentAGenome = genomeFor(ecs, parentA);
  const parentBGenome = genomeFor(ecs, parentB);
  const crossed = crossoverGenomes(parentAGenome, parentBGenome, reproRng);
  const { genome, mutations } = mutateGenome(crossed, reproRng, config.mutation);
  ecs.genome.attach(entity, genome);

  const lin = ecs.lineage;
  const genA = lin.columns.generation[lin.index[parentA]];
  const genB = lin.columns.generation[lin.index[parentB]];
  const generation = Math.max(genA, genB) + 1;
  ecs.lineage.attach(entity, { generation, parentA, parentB });

  const sex = reproRng.nextInt(2); // deterministic binary sex
  ecs.reproductive.attach(entity, { sex, cooldownHours: 0, eligible: 0 });

  ecs.intent.attach(entity, { kind: AgentIntent.Wander, targetX: x, targetY: y, targetEntity: -1 });
  ecs.aiState.attach(entity);

  events.record('birth', {
    entityId: entity,
    detail: `generation=${generation} parentA=${parentA} parentB=${parentB}`,
  });
  for (const m of mutations) {
    const sign = m.delta >= 0 ? '+' : '';
    events.record('mutation', {
      entityId: entity,
      detail: `${m.gene}: ${m.before.toFixed(3)} -> ${m.after.toFixed(3)} (${sign}${m.delta.toFixed(3)})`,
    });
  }

  return entity;
}

/** Returns the number of children created this tick (each is one reproduction success). */
export function updateReproduction(ctx: TickContext): number {
  const { ecs, config, events } = ctx;
  const intent = ecs.intent;
  const position = ecs.position;
  const repro = config.reproduction;
  const reachSq = repro.partnerReachTiles * repro.partnerReachTiles;
  let births = 0;

  // Tick reproduction cooldowns down (by dtHours), floor at 0. Then refresh the
  // cached `eligible` flag for every agent so the inspector, the partner filter
  // and the determinism tests see this tick's eligibility. Runs before any
  // reproduction so a birth this tick can set a cooldown that the next tick (and
  // the next AI pass) observes.
  const dtHours = ctx.dtHours;
  const reproStore = ecs.reproductive;
  for (let i = 0; i < reproStore.count; i++) {
    if (reproStore.columns.cooldownHours[i] > 0) {
      reproStore.columns.cooldownHours[i] = Math.max(0, reproStore.columns.cooldownHours[i] - dtHours);
    }
  }
  for (let i = 0; i < reproStore.count; i++) {
    refreshEligibility(reproStore.entityOf[i], ecs, config);
  }

  for (let i = 0; i < intent.count; i++) {
    if (intent.columns.kind[i] !== AgentIntent.SeekPartner) continue;
    const seeker = intent.entityOf[i];
    const partner = intent.columns.targetEntity[i];
    if (partner < 0) continue;
    if (!ecs.entities.isAlive(partner)) continue; // stale target; AI re-targets next tick

    const seekerPosSlot = position.index[seeker];
    const partnerPosSlot = position.index[partner];
    if (seekerPosSlot < 0 || partnerPosSlot < 0) continue;
    const dx = position.columns.x[partnerPosSlot] - position.columns.x[seekerPosSlot];
    const dy = position.columns.y[partnerPosSlot] - position.columns.y[seekerPosSlot];
    const distSq = dx * dx + dy * dy;
    if (distSq > reachSq) continue; // still traveling

    const seekerReproSlot = ecs.reproductive.index[seeker];
    const partnerReproSlot = ecs.reproductive.index[partner];
    if (seekerReproSlot < 0 || partnerReproSlot < 0) continue;
    if (ecs.reproductive.columns.sex[seekerReproSlot] === ecs.reproductive.columns.sex[partnerReproSlot]) {
      continue; // same sex — not a valid pairing
    }

    events.record('reproduction_attempted', { entityId: seeker, detail: `partner=${partner}` });

    if (!canReproduce(seeker, ecs, config) || !canReproduce(partner, ecs, config)) {
      continue; // attempt failed (cooldown / health / needs / stage) — no child
    }

    const child = createChild(ctx, seeker, partner);

    // Fertility-scaled cooldown on BOTH parents -> prevents reproduction spam.
    const seekerGenome = genomeFor(ecs, seeker);
    const partnerGenome = genomeFor(ecs, partner);
    ecs.reproductive.columns.cooldownHours[seekerReproSlot] = cooldownFor(seekerGenome.fertility, config);
    ecs.reproductive.columns.cooldownHours[partnerReproSlot] = cooldownFor(partnerGenome.fertility, config);

    events.record('reproduction_success', {
      entityId: seeker,
      detail: `partner=${partner} child=${child}`,
    });
    births++;
  }

  return births;
}

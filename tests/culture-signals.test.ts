/**
 * Phase 5 — proto-communication tests.
 *
 * The signal layer is deliberately NOT language: 16 arbitrary tokens whose
 * meanings are learned by association. These tests pin the mechanics:
 *   - emitting costs energy and starts a cooldown (spam is not free),
 *   - only agents within hearing learn anything (no global broadcast),
 *   - a meaning is only learnable when the emitter's situation makes it
 *     observable, so meaningless spam teaches nothing,
 *   - repeated association strengthens and eventually crosses "known",
 *   - learned meanings stay inside the token alphabet and are per-agent
 *     (different agents/groups can settle on different tokens),
 *   - associations are bounded per agent and per token.
 */

import { describe, expect, it } from 'vitest';
import { AgentIntent } from '../src/simulation-core/ai';
import {
  SIGNAL_TOKEN_COUNT,
  SIGNAL_MEANING_COUNT,
  SignalMeaning,
  signalMeaningName,
  signalTokenName,
} from '../src/simulation-core/culture';
import { updateSignals } from '../src/simulation-core/simulation/systems/signal-system';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { makeContext, spawnAgent, type MiniContext } from './helpers';

/** Put a signal intent on an agent (spawnAgent attached a default intent). */
function setIntent(mini: MiniContext, entity: number, kind: number, targetX = 0, targetY = 0): void {
  const slot = mini.ecs.intent.index[entity];
  mini.ecs.intent.columns.kind[slot] = kind;
  mini.ecs.intent.columns.targetX[slot] = targetX;
  mini.ecs.intent.columns.targetY[slot] = targetY;
  mini.ecs.intent.columns.targetEntity[slot] = -1;
}

/** Make the tile under (x, y) hold food or water so a signal has a context. */
function makeFoodTile(mini: MiniContext, x: number, y: number): void {
  mini.world.food[mini.world.tileIndex(x, y)] = 1;
  mini.world.water[mini.world.tileIndex(x, y)] = 0;
}

describe('proto-communication (signals)', () => {
  it('emits a signal, pays energy and starts a cooldown', () => {
    const mini = makeContext(21, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    makeFoodTile(mini, 4, 4);
    const ctx = { ...mini.ctx, config, ecs: mini.ecs, socialIndex: mini.ctx.socialIndex };
    const emitter = spawnAgent(mini, 4.2, 4.2, { intelligence: 1 });
    const listener = spawnAgent(mini, 4.5, 4.5, { intelligence: 1 });
    mini.ctx.socialIndex.rebuild(mini.ecs);
    setIntent(mini, emitter, AgentIntent.SignalFood);

    const energyBefore = mini.ecs.needs.columns.energy[mini.ecs.needs.index[emitter]];
    updateSignals(ctx);

    expect(ctx.cultureStats.signalsEmitted).toBe(1);
    const energyAfter = mini.ecs.needs.columns.energy[mini.ecs.needs.index[emitter]];
    expect(energyBefore - energyAfter).toBeCloseTo(config.culture.signals.emissionEnergyCost, 5);
    expect(mini.ecs.culture.columns.signalCooldownTicks[mini.ecs.culture.index[emitter]]).toBe(
      config.culture.signals.emissionCooldownTicks,
    );
    // The listener heard it: the token it heard now has an association.
    expect(ctx.cultureStats.signalsHeard).toBe(1);
    const token = mini.ecs.culture.columns.lastSignalToken[mini.ecs.culture.index[emitter]];
    expect(token).toBeGreaterThanOrEqual(0);
    expect(token).toBeLessThan(SIGNAL_TOKEN_COUNT);
    expect(mini.ecs.signals.countFor(listener)).toBe(1);
    expect(mini.ecs.signals.strengthOf(listener, token, SignalMeaning.Food)).toBeGreaterThan(0);
  });

  it('refuses to emit when energy is too low or the cooldown is still running', () => {
    const mini = makeContext(22, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    makeFoodTile(mini, 5, 5);
    const ctx = { ...mini.ctx, config, ecs: mini.ecs, socialIndex: mini.ctx.socialIndex };
    const emitter = spawnAgent(mini, 5.2, 5.2, {
      intelligence: 1,
      energy: config.culture.signals.minEnergyToEmit - 1,
    });
    spawnAgent(mini, 5.6, 5.6);
    mini.ctx.socialIndex.rebuild(mini.ecs);
    setIntent(mini, emitter, AgentIntent.SignalFood);

    const energyBefore = mini.ecs.needs.columns.energy[mini.ecs.needs.index[emitter]];
    updateSignals(ctx);
    expect(ctx.cultureStats.signalsEmitted).toBe(0);
    expect(mini.ecs.needs.columns.energy[mini.ecs.needs.index[emitter]]).toBe(energyBefore);

    // With energy restored but a cooldown active, it still refuses.
    mini.ecs.needs.columns.energy[mini.ecs.needs.index[emitter]] = 100;
    mini.ecs.culture.columns.signalCooldownTicks[mini.ecs.culture.index[emitter]] =
      config.culture.signals.emissionCooldownTicks;
    updateSignals({ ...ctx, tick: 1 });
    expect(ctx.cultureStats.signalsEmitted).toBe(0);
  });

  it('is heard only inside the hearing radius (no global broadcast)', () => {
    const mini = makeContext(23, 48);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    makeFoodTile(mini, 4, 4);
    const ctx = { ...mini.ctx, config, ecs: mini.ecs, socialIndex: mini.ctx.socialIndex };
    const emitter = spawnAgent(mini, 4.2, 4.2, { intelligence: 1 });
    const near = spawnAgent(mini, 5.5, 4.2, { intelligence: 1 });
    const far = spawnAgent(mini, 40, 40, { intelligence: 1 });
    mini.ctx.socialIndex.rebuild(mini.ecs);
    setIntent(mini, emitter, AgentIntent.SignalFood);

    updateSignals(ctx);
    expect(ctx.cultureStats.signalsEmitted).toBe(1);
    expect(mini.ecs.signals.countFor(near)).toBe(1);
    // The agent on the far side of the world learns nothing at all.
    expect(mini.ecs.signals.countFor(far)).toBe(0);
    expect(ctx.cultureStats.signalsHeard).toBe(1);
  });

  it('teaches nothing when the emitter has no observable context (spam is useless)', () => {
    const mini = makeContext(24, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    const ctx = { ...mini.ctx, config, ecs: mini.ecs, socialIndex: mini.ctx.socialIndex };
    const emitter = spawnAgent(mini, 6.2, 6.2, { intelligence: 1 });
    const listener = spawnAgent(mini, 6.6, 6.2, { intelligence: 1 });
    mini.ctx.socialIndex.rebuild(mini.ecs);
    // Bare grass: no food, no water, no danger, no need — "FOOD!" is a lie.
    const tile = mini.world.tileIndex(6, 6);
    mini.world.food[tile] = 0;
    mini.world.water[tile] = 0;
    setIntent(mini, emitter, AgentIntent.SignalFood);

    updateSignals(ctx);
    expect(ctx.cultureStats.signalsEmitted).toBe(1); // the cost was still paid
    expect(ctx.cultureStats.signalsHeard).toBe(0);
    expect(mini.ecs.signals.countFor(listener)).toBe(0);
  });

  it('grows an association into a known meaning through repetition', () => {
    const mini = makeContext(25, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    // Cheap signalling so repetition is possible; learning rate untouched.
    config.culture.signals.emissionCooldownTicks = 0;
    makeFoodTile(mini, 7, 7);
    const ctx = { ...mini.ctx, config, ecs: mini.ecs, socialIndex: mini.ctx.socialIndex };
    const emitter = spawnAgent(mini, 7.2, 7.2, { intelligence: 1 });
    const listener = spawnAgent(mini, 7.6, 7.2, { intelligence: 1 });
    mini.ctx.socialIndex.rebuild(mini.ecs);
    // The emitter knows token 3 means FOOD, so it keeps using that token.
    mini.ecs.signals.observe(emitter, 3, SignalMeaning.Food, 0.9, 0);
    setIntent(mini, emitter, AgentIntent.SignalFood);

    let learnedAt = -1;
    for (let tick = 0; tick < 6; tick++) {
      updateSignals({ ...ctx, tick });
      if (mini.ecs.signals.strengthOf(listener, 3, SignalMeaning.Food) >= config.culture.signals.knownThreshold) {
        learnedAt = tick;
        break;
      }
    }
    expect(learnedAt).toBeGreaterThanOrEqual(0);
    expect(ctx.cultureStats.signalLearnings).toBe(1);
    // Repetition is what made it stick: the earlier hearing was below "known".
    expect(mini.ecs.signals.strengthOf(listener, 3, SignalMeaning.Food)).toBeGreaterThanOrEqual(
      config.culture.signals.knownThreshold,
    );
    expect(mini.ecs.signals.dominantMeaning(listener, 3).meaning).toBe(SignalMeaning.Food);
  });

  it('keeps a learned token inside the alphabet even with constant misperception', () => {
    const mini = makeContext(26, 24);
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    config.culture.signals.misperceptionChance = 1;
    config.culture.signals.emissionCooldownTicks = 0;
    makeFoodTile(mini, 8, 8);
    const ctx = { ...mini.ctx, config, ecs: mini.ecs, socialIndex: mini.ctx.socialIndex };
    const emitter = spawnAgent(mini, 8.2, 8.2, { intelligence: 1 });
    const listener = spawnAgent(mini, 8.6, 8.2, { intelligence: 1 });
    mini.ctx.socialIndex.rebuild(mini.ecs);
    mini.ecs.signals.observe(emitter, 5, SignalMeaning.Food, 0.9, 0);
    setIntent(mini, emitter, AgentIntent.SignalFood);

    for (let tick = 0; tick < 12; tick++) updateSignals({ ...ctx, tick });

    // Misperception only ever shifts to a *neighbouring* token: 4, 5 or 6.
    for (let e = mini.ecs.signals.headOf(listener); e !== -1; e = mini.ecs.signals.nextOf(e)) {
      const token = mini.ecs.signals.entryToken(e);
      expect(token).toBeGreaterThanOrEqual(4);
      expect(token).toBeLessThanOrEqual(6);
      expect(mini.ecs.signals.entryMeaning(e)).toBe(SignalMeaning.Food);
    }
    expect(mini.ecs.signals.countFor(listener)).toBeGreaterThan(0);
  });

  it('bounds associations per agent and meanings per token', () => {
    const mini = makeContext(27, 24);
    const store = mini.ecs.signals;
    const entity = spawnAgent(mini, 4, 4);
    const capacity = mini.config.culture.signals.maxAssociationsPerAgent;
    const perToken = mini.config.culture.signals.maxMeaningsPerToken;

    for (let i = 0; i < capacity + 8; i++) {
      store.observe(entity, i % SIGNAL_TOKEN_COUNT, i % SIGNAL_MEANING_COUNT, 0.5, i);
    }
    expect(store.countFor(entity)).toBe(capacity);

    // One token can only ever carry a couple of competing meanings.
    store.removeAll(entity);
    for (let meaning = 0; meaning < SIGNAL_MEANING_COUNT; meaning++) {
      store.observe(entity, 2, meaning, 0.5, meaning);
    }
    expect(store.countForToken(entity, 2)).toBe(perToken);
  });

  it('lets two agents settle on different tokens for the same meaning (local conventions)', () => {
    const mini = makeContext(28, 24);
    const store = mini.ecs.signals;
    const learnerA = spawnAgent(mini, 4, 4);
    const learnerB = spawnAgent(mini, 6, 6);

    store.observe(learnerA, 1, SignalMeaning.Water, 0.8, 0);
    store.observe(learnerB, 9, SignalMeaning.Water, 0.8, 0);

    expect(store.bestTokenFor(learnerA, SignalMeaning.Water).token).toBe(1);
    expect(store.bestTokenFor(learnerB, SignalMeaning.Water).token).toBe(9);
    expect(signalTokenName(1)).not.toBe(signalTokenName(9));
    expect(signalMeaningName(store.dominantMeaning(learnerA, 1).meaning)).toBe('WATER');
    expect(signalMeaningName(store.dominantMeaning(learnerB, 9).meaning)).toBe('WATER');
  });

  it('keeps the hearing radius inside the spatial index that supports it', () => {
    // The listener search walks the social index, which is only guaranteed to
    // see `social.perception.radiusTiles`; a larger hearing radius would
    // silently miss listeners (or tempt someone into an O(n) scan).
    expect(DEFAULT_SIMULATION_CONFIG.culture.signals.hearingRadiusTiles).toBeLessThanOrEqual(
      DEFAULT_SIMULATION_CONFIG.social.perception.radiusTiles,
    );
  });
});

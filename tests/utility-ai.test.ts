import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/simulation-core/simulation/simulation';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';
import { AgentIntent } from '../src/simulation-core/ai/intents';
import {
  clamp01,
  linear,
  inverseLinear,
  quadratic,
  inverseQuadratic,
  sigmoid,
  bell,
} from '../src/simulation-core/ai/utility';
import {
  hungerUrgency,
  thirstUrgency,
  fatigueUrgency,
  resourceQuality,
  distanceFactor,
  explorationUncertainty,
} from '../src/simulation-core/ai/considerations';
import {
  effectiveLearningRate,
  effectiveDecayPerHour,
  reinforceValue,
  punishValue,
  decayValue,
} from '../src/simulation-core/ai/memory';

describe('utility curves', () => {
  it('stay within [0, 1] across the input domain', () => {
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      for (const value of [
        linear(t),
        inverseLinear(t),
        quadratic(t),
        inverseQuadratic(t),
        sigmoid(t, 8, 0.5),
        bell(t, 0.5, 0.5),
      ]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('linear / quadratic / sigmoid / bell have their documented shapes', () => {
    expect(linear(0)).toBe(0);
    expect(linear(1)).toBe(1);
    expect(quadratic(0.5)).toBeCloseTo(0.25, 10);
    expect(inverseQuadratic(0.5)).toBeCloseTo(0.25, 10);
    expect(sigmoid(0.5, 8, 0.5)).toBeCloseTo(0.5, 10);
    expect(sigmoid(1, 8, 0.5)).toBeCloseTo(0.9, 10);
    expect(sigmoid(0, 8, 0.5)).toBeCloseTo(0.1, 10);
    expect(bell(0.5, 0.5, 0.5)).toBeCloseTo(1, 10);
    expect(bell(1, 0.5, 0.5)).toBeCloseTo(0, 10);
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
  });
});

describe('utility considerations', () => {
  const config = DEFAULT_SIMULATION_CONFIG;

  it('urgent needs increase the corresponding urgency (and mild needs do not)', () => {
    const mild = hungerUrgency(20, config);
    const moderate = hungerUrgency(60, config);
    const urgent = hungerUrgency(90, config);
    expect(mild).toBe(0); // below the seek threshold there is no urge to eat
    expect(moderate).toBeGreaterThan(0);
    expect(urgent).toBeGreaterThan(moderate);
    expect(urgent).toBeLessThanOrEqual(1);

    expect(thirstUrgency(90, config)).toBeGreaterThan(thirstUrgency(60, config));
  });

  it('fatigue grows as energy falls and vanishes when rested', () => {
    expect(fatigueUrgency(100, config)).toBe(0);
    expect(fatigueUrgency(10, config)).toBeGreaterThan(fatigueUrgency(60, config));
    expect(fatigueUrgency(10, config)).toBeLessThanOrEqual(1);
  });

  it('resource quality and reachability are bounded and monotonic', () => {
    expect(resourceQuality(1)).toBe(1);
    expect(resourceQuality(0)).toBe(0);
    expect(resourceQuality(0.9)).toBeGreaterThan(resourceQuality(0.4));
    expect(distanceFactor(0, 8)).toBe(1);
    expect(distanceFactor(8, 8)).toBe(0);
    expect(distanceFactor(2, 8)).toBeGreaterThan(distanceFactor(6, 8));
  });

  it('exploration uncertainty falls as memory coverage grows', () => {
    expect(explorationUncertainty(0)).toBe(1); // no memory -> fully uncertain
    expect(explorationUncertainty(1)).toBe(0); // perfect memory -> exploit
    expect(explorationUncertainty(0.5)).toBeCloseTo(0.5, 10);
  });
});

describe('intelligence-modulated learning', () => {
  it('keeps the intelligence effect moderate and within sane bounds', () => {
    const dumb = effectiveLearningRate(0, DEFAULT_SIMULATION_CONFIG);
    const smart = effectiveLearningRate(1, DEFAULT_SIMULATION_CONFIG);
    expect(smart).toBeGreaterThan(dumb);
    // Learning rate never leaves (0, 1] and intelligence 1 is not absurdly better.
    expect(smart).toBeLessThanOrEqual(1);
    expect(smart / dumb).toBeLessThan(3);

    const forgetDumb = effectiveDecayPerHour(0, DEFAULT_SIMULATION_CONFIG);
    const forgetSmart = effectiveDecayPerHour(1, DEFAULT_SIMULATION_CONFIG);
    expect(forgetSmart).toBeLessThan(forgetDumb); // smarter -> better retention
    expect(forgetSmart).toBeGreaterThanOrEqual(0);
  });

  it('reinforce/punish/decay move values toward their bounds', () => {
    expect(reinforceValue(0.5, 0.5)).toBeGreaterThan(0.5);
    expect(reinforceValue(0.5, 0.5)).toBeLessThanOrEqual(1);
    expect(punishValue(0.5, 0.5)).toBeLessThan(0.5);
    expect(punishValue(0.5, 0.5)).toBeGreaterThanOrEqual(0);
    expect(decayValue(0.8, 0.1)).toBeLessThan(0.8);
    expect(decayValue(0.01, 1)).toBe(0); // full decay floors at zero
  });
});

describe('utility AI integration', () => {
  it('writes bounded utility scores for every agent, every tick', () => {
    const sim = Simulation.create(1337, DEFAULT_SIMULATION_CONFIG);
    for (let i = 0; i < 300; i++) sim.step();
    const aiState = sim.ecs.aiState;
    expect(aiState.count).toBe(sim.population);
    for (let i = 0; i < aiState.count; i++) {
      for (const column of [
        // All twelve action columns: survival (7) + social (5, Phase 4).
        aiState.columns.rest,
        aiState.columns.wander,
        aiState.columns.seekFood,
        aiState.columns.seekWater,
        aiState.columns.eat,
        aiState.columns.drink,
        aiState.columns.seekPartner,
        aiState.columns.socialize,
        aiState.columns.help,
        aiState.columns.cooperate,
        aiState.columns.avoid,
        aiState.columns.confront,
      ]) {
        expect(column[i]).toBeGreaterThanOrEqual(0);
        expect(column[i]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('deterministic tie-breaking: identical seeds produce identical decisions', () => {
    const a = Simulation.create(4242, DEFAULT_SIMULATION_CONFIG);
    const b = Simulation.create(4242, DEFAULT_SIMULATION_CONFIG);
    for (let i = 0; i < 200; i++) {
      a.step();
      b.step();
    }
    expect(Array.from(a.ecs.intent.columns.kind.subarray(0, a.ecs.intent.count))).toEqual(
      Array.from(b.ecs.intent.columns.kind.subarray(0, b.ecs.intent.count)),
    );
    expect(a.getRngStates()).toEqual(b.getRngStates());
  });

  it('a starving agent with food in reach chooses food over resting/wandering', () => {
    const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
    // Make food plentiful and cheap to reach so SeekFood can win decisively.
    config.ai.seekFoodNeedThreshold = 20;
    config.needs.criticalNeedThreshold = 100;
    const sim = Simulation.create(777, config);
    // Crank hunger directly on every agent, then step and observe the AI.
    for (let i = 0; i < sim.ecs.needs.count; i++) sim.ecs.needs.columns.hunger[i] = 95;
    sim.step();
    const intent = sim.ecs.intent;
    let foodSeeking = 0;
    for (let i = 0; i < intent.count; i++) {
      const kind = intent.columns.kind[i];
      if (kind === AgentIntent.SeekFood || kind === AgentIntent.Eat) foodSeeking++;
    }
    expect(foodSeeking).toBeGreaterThan(0);
  });
});

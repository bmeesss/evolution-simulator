import { describe, expect, it } from 'vitest';
import { WorkerEngine } from '../src/workers/worker-engine';
import type { WorkerEngineHost } from '../src/workers/worker-engine';
import type { WorkerMessage } from '../src/workers/protocol';
import { cloneConfig, DEFAULT_SIMULATION_CONFIG } from '../src/simulation-core/simulation/config';

/**
 * The WorkerEngine is clock-injected, so these tests drive it exactly like the
 * real worker entry does — proving the fixed-timestep loop, pause/speed
 * semantics and the message protocol without a real Worker.
 */
class FakeHost implements WorkerEngineHost {
  clock = 0;
  readonly messages: WorkerMessage[] = [];

  now(): number {
    return this.clock;
  }

  emit(message: WorkerMessage): void {
    this.messages.push(message);
  }

  of<T extends WorkerMessage['type']>(type: T): Extract<WorkerMessage, { type: T }>[] {
    return this.messages.filter((message) => message.type === type) as Extract<
      WorkerMessage,
      { type: T }
    >[];
  }

  lastSnapshot(): Extract<WorkerMessage, { type: 'snapshot' }> {
    const snapshots = this.of('snapshot');
    return snapshots[snapshots.length - 1];
  }
}

const TEST_CONFIG = (() => {
  const config = cloneConfig(DEFAULT_SIMULATION_CONFIG);
  config.time.baseTicksPerSecond = 10; // 100 ms per tick at 1x
  config.world.width = 32;
  config.world.height = 32;
  return config;
})();

describe('WorkerEngine', () => {
  it('ignores updates and commands before init (and reports errors)', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.update(); // no simulation yet — must not throw
    engine.handleCommand({ type: 'request-snapshot' });
    expect(host.of('error')).toHaveLength(1);
  });

  it('init emits ready with the world and an initial snapshot', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: 1337 });

    const ready = host.of('ready');
    expect(ready).toHaveLength(1);
    expect(ready[0].seed).toBe(1337);
    expect(ready[0].running).toBe(true);
    expect(ready[0].multiplier).toBe(1);
    expect(ready[0].hoursPerTick).toBe(TEST_CONFIG.time.hoursPerTick);
    expect(ready[0].world.width).toBe(TEST_CONFIG.world.width);
    expect(ready[0].world.terrain).toHaveLength(TEST_CONFIG.world.width * TEST_CONFIG.world.height);

    const snapshot = host.lastSnapshot();
    expect(snapshot.snapshot.tick).toBe(0);
    expect(snapshot.snapshot.population).toBe(TEST_CONFIG.agents.initialPopulation);
    const eventTypes = snapshot.events.map((event) => event.type);
    expect(eventTypes).toContain('simulation_started');
    expect(eventTypes.filter((type) => type === 'agent_spawned')).toHaveLength(
      TEST_CONFIG.agents.initialPopulation,
    );
    expect(snapshot.debug.status).toBe('running');
  });

  it('rejects invalid seeds', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: -1 });
    engine.handleCommand({ type: 'init', seed: 1.5 });
    expect(host.of('error')).toHaveLength(2);
    expect(host.of('ready')).toHaveLength(0);
  });

  it('runs a fixed number of ticks per elapsed real time (10 tps at 1x)', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: 1 });

    host.clock = 1000;
    engine.update();
    expect(host.lastSnapshot().snapshot.tick).toBe(10);

    host.clock = 1050; // half a tick — must not run a tick
    engine.update();
    expect(host.lastSnapshot().snapshot.tick).toBe(10);

    host.clock = 1100; // another full tick since 1000
    engine.update();
    expect(host.lastSnapshot().snapshot.tick).toBe(11);
  });

  it('pause stops ticking and emits the paused event', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: 1 });

    host.clock = 1000;
    engine.update();
    const tickBeforePause = host.lastSnapshot().snapshot.tick;

    engine.handleCommand({ type: 'set-running', running: false });
    const pauseEvents = host.of('snapshot').at(-1)!.events;
    expect(pauseEvents.some((event) => event.type === 'simulation_paused')).toBe(true);

    host.clock = 60_000; // a minute of real time while paused
    engine.update();
    expect(host.lastSnapshot().snapshot.tick).toBe(tickBeforePause);
  });

  it('resume continues from the same state (no time jump)', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: 1 });
    host.clock = 1000;
    engine.update(); // tick 10

    engine.handleCommand({ type: 'set-running', running: false });
    host.clock = 5000;
    engine.update();
    engine.handleCommand({ type: 'set-running', running: true });
    expect(host.of('snapshot').at(-1)!.events.some((e) => e.type === 'simulation_resumed')).toBe(true);

    host.clock = 5100; // exactly one tick of new time since resume
    engine.update();
    expect(host.lastSnapshot().snapshot.tick).toBe(11);
  });

  it('accelerated speed multiplies ticks per real time (multiple per slice)', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: 1 });
    engine.handleCommand({ type: 'set-speed', multiplier: 5 });

    host.clock = 1000;
    engine.update();
    const snapshot = host.lastSnapshot();
    expect(snapshot.snapshot.tick).toBe(50); // 10 tps * 5x * 1s
    expect(snapshot.debug.lastSliceTickCount).toBe(50); // all in one slice
  });

  it('processes many ticks per update slice at very high speed (backlog guard)', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: 1 });
    engine.handleCommand({ type: 'set-speed', multiplier: 100 });

    host.clock = 10_000; // 10s * 100x * 10tps = 10,000 ticks requested...
    engine.update();
    const snapshot = host.lastSnapshot();
    // ...but the slice cap bounds it; the simulation must never wedge.
    expect(snapshot.snapshot.tick).toBeLessThanOrEqual(TEST_CONFIG.time.maxTicksPerUpdateSlice);
    expect(snapshot.snapshot.tick).toBeGreaterThan(0);
  });

  it('rejects invalid speed multipliers', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: 1 });
    engine.handleCommand({ type: 'set-speed', multiplier: 0 });
    engine.handleCommand({ type: 'set-speed', multiplier: -5 });
    engine.handleCommand({ type: 'set-speed', multiplier: Number.POSITIVE_INFINITY });
    expect(host.of('error')).toHaveLength(3);
  });

  it('answers get-agent with details (or null), echoing the requested entityId', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: 1 });

    engine.handleCommand({ type: 'get-agent', entityId: 0 });
    const replies = host.of('agent-details');
    expect(replies).toHaveLength(1);
    // The entityId echo is what lets the main thread drop stale replies.
    expect(replies[0].entityId).toBe(0);
    expect(replies[0].agent?.entityId).toBe(0);
    expect(replies[0].agent?.health).toBeGreaterThan(0);

    engine.handleCommand({ type: 'get-agent', entityId: 123_456 });
    const missing = host.of('agent-details')[1];
    expect(missing.agent).toBeNull();
    expect(missing.entityId).toBe(123_456);
  });

  it('answers request-save with a serializable save state', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: 1 });
    host.clock = 500;
    engine.update();

    engine.handleCommand({ type: 'request-save' });
    const saves = host.of('save');
    expect(saves).toHaveLength(1);
    expect(saves[0].save.tick).toBe(5);
    expect(saves[0].save.rng.sim).toBeDefined();
  });

  it('runs the determinism self-check inside the engine', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: 1 });
    host.clock = 200;
    engine.update();
    const tickBefore = host.lastSnapshot().snapshot.tick;

    engine.handleCommand({ type: 'verify-determinism', ticks: 200 });
    const results = host.of('determinism-result');
    expect(results).toHaveLength(1);
    expect(results[0].result.sameSeedMatch).toBe(true);
    expect(results[0].result.restoreContinuationMatch).toBe(true);
    // The check runs on throwaway instances — the live sim is untouched.
    expect(host.lastSnapshot().snapshot.tick).toBe(tickBefore);
  });

  it('re-initializing replaces the world and records it as an event', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: 1 });
    host.clock = 1000;
    engine.update();

    host.clock = 1100;
    engine.handleCommand({ type: 'init', seed: 2 });
    expect(host.of('ready')).toHaveLength(2);
    expect(host.of('ready')[1].seed).toBe(2);
    const snapshot = host.lastSnapshot();
    expect(snapshot.snapshot.tick).toBe(0);
    expect(snapshot.events.some((event) => event.type === 'simulation_reinitialized')).toBe(true);
  });

  it('reports unexpected command errors instead of throwing', () => {
    const host = new FakeHost();
    const engine = new WorkerEngine(host, TEST_CONFIG);
    engine.handleCommand({ type: 'init', seed: 1 });
    // Simulate a malformed payload bypassing the type system.
    engine.handleCommand({ type: 'set-speed', multiplier: Number.NaN });
    expect(host.of('error').length).toBeGreaterThan(0);
    // The engine keeps working afterwards.
    host.clock = 100;
    engine.update();
    expect(host.lastSnapshot().snapshot.tick).toBe(1);
  });
});

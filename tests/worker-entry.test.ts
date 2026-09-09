import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimulationCommand, WorkerMessage } from '../src/workers/protocol';

/**
 * Integration test for the REAL worker entry module (src/workers/simulation-worker.ts).
 *
 * The module's top-level code binds `self.onmessage`, bridges `postMessage`
 * and starts its polling interval — exactly what it does inside a real Web
 * Worker. We stub the worker globals (self/postMessage/setInterval/performance)
 * and then drive the module through the full message protocol, proving the
 * wiring that unit tests of WorkerEngine alone cannot reach.
 */

interface Harness {
  posted: WorkerMessage[];
  post(command: SimulationCommand): void;
  tickPoll(): void;
  setClock(ms: number): void;
}

let harness: Harness;

function installHarness(): Harness {
  const posted: WorkerMessage[] = [];
  let clockMs = 0;
  let pollCallback: (() => void) | null = null;

  vi.spyOn(globalThis, 'performance', 'get').mockReturnValue({ now: () => clockMs } as Performance);
  vi.stubGlobal('setInterval', (callback: () => void) => {
    pollCallback = callback;
    return 0 as unknown as ReturnType<typeof setInterval>;
  });
  vi.stubGlobal('self', {
    postMessage: (message: unknown) => {
      posted.push(message as WorkerMessage);
    },
    onmessage: null as ((event: { data: unknown }) => void) | null,
  });

  return {
    posted,
    post(command: SimulationCommand) {
      const onmessage = (globalThis as unknown as { self: { onmessage: ((e: { data: unknown }) => void) | null } }).self.onmessage;
      if (!onmessage) throw new Error('worker entry did not install self.onmessage');
      onmessage({ data: command });
    },
    tickPoll() {
      pollCallback?.();
    },
    setClock(ms: number) {
      clockMs = ms;
    },
  };
}

describe('simulation worker entry (real module, stubbed worker globals)', () => {
  beforeEach(async () => {
    vi.resetModules();
    harness = installHarness();
    // Import AFTER the stubs exist: the module's top-level code binds to them.
    await import('../src/workers/simulation-worker');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('installs a message handler and a poll interval', () => {
    expect((globalThis as unknown as { self: { onmessage: unknown } }).self.onmessage).toBeTypeOf('function');
  });

  it('flows the full protocol: init -> ready + snapshot, poll -> ticks, pause -> stop', () => {
    harness.post({ type: 'init', seed: 1337 });

    const ready = harness.posted.find((message) => message.type === 'ready');
    expect(ready).toBeDefined();
    if (ready?.type === 'ready') {
      expect(ready.seed).toBe(1337);
      expect(ready.world.width).toBe(64);
    }
    expect(harness.posted.some((message) => message.type === 'snapshot')).toBe(true);

    // Simulate 1 second of real time reaching the poll callback (10 tps at 1x).
    harness.setClock(1000);
    harness.tickPoll();
    const snapshots = harness.posted.filter((message) => message.type === 'snapshot');
    const last = snapshots[snapshots.length - 1];
    expect(last.type === 'snapshot' && last.snapshot.tick).toBe(10);

    // Pause, then let a lot of "time" pass — no further ticks.
    harness.post({ type: 'set-running', running: false });
    harness.setClock(60_000);
    harness.tickPoll();
    const after = harness.posted.filter((message) => message.type === 'snapshot');
    expect(after[after.length - 1].type === 'snapshot' && after[after.length - 1].snapshot.tick).toBe(10);
  });

  it('answers correlated queries (agent details, save, determinism check)', () => {
    harness.post({ type: 'init', seed: 42 });
    harness.post({ type: 'get-agent', entityId: 3, requestId: 101 });
    harness.post({ type: 'verify-determinism', ticks: 120, requestId: 102 });

    const details = harness.posted.find((message): message is Extract<WorkerMessage, { type: 'agent-details' }> => message.type === 'agent-details');
    expect(details?.requestId).toBe(101);
    expect(details?.entityId).toBe(3); // echoed for the main-thread stale guard
    expect(details?.agent?.entityId).toBe(3);

    const determinism = harness.posted.find(
      (message): message is Extract<WorkerMessage, { type: 'determinism-result' }> =>
        message.type === 'determinism-result',
    );
    expect(determinism?.requestId).toBe(102);
    expect(determinism?.result.sameSeedMatch).toBe(true);
    expect(determinism?.result.restoreContinuationMatch).toBe(true);
  });
});

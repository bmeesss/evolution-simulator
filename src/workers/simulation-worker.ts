/**
 * Web Worker entry point: owns the simulation.
 *
 * The main thread never touches simulation state directly — it sends commands
 * and receives structured-clone snapshots (see protocol.ts). This file is the
 * only place in the worker that touches worker APIs; all logic lives in
 * WorkerEngine, which is clock-injected and unit-testable in Node.
 */

import { DEFAULT_SIMULATION_CONFIG } from '../simulation-core';
import { WorkerEngine } from './worker-engine';
import { WORKER_POLL_INTERVAL_MS } from './protocol';
import type { SimulationCommand } from './protocol';

// Minimal structural typing of the dedicated worker scope. WHY: mixing the
// "webworker" and "DOM" libs in one TS project causes global conflicts, so the
// worker scope is described by exactly the surface we use.
const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

const engine = new WorkerEngine(
  { now: () => performance.now(), emit: (message) => scope.postMessage(message) },
  DEFAULT_SIMULATION_CONFIG,
);

scope.onmessage = (event) => {
  engine.handleCommand(event.data as SimulationCommand);
};

// Fixed-rate pump: the engine internally converts elapsed real time into
// simulation ticks (accumulator pattern), so poll jitter does not affect
// simulation timing beyond the tick granularity.
setInterval(() => engine.update(), WORKER_POLL_INTERVAL_MS);

/**
 * Main-thread client for the simulation worker.
 *
 * Wraps the Worker lifecycle and exposes typed helpers for every command.
 * Consumers subscribe via `onMessage`. The client deliberately keeps no
 * simulation state — everything arrives as messages.
 */

import type { SimulationCommand, WorkerMessage } from './protocol';

export class SimulationWorkerClient {
  private readonly worker: Worker;

  /** Called for every message from the worker (snapshots, replies, errors). */
  onMessage: (message: WorkerMessage) => void = () => {};

  constructor() {
    this.worker = new Worker(new URL('./simulation-worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      this.onMessage(event.data);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      this.onMessage({ type: 'error', message: `Worker crashed: ${event.message}` });
    };
  }

  send(command: SimulationCommand): void {
    this.worker.postMessage(command);
  }

  /** Initialize (or re-initialize) the simulation with a seed. */
  init(seed: number): void {
    this.send({ type: 'init', seed });
  }

  setRunning(running: boolean): void {
    this.send({ type: 'set-running', running });
  }

  setSpeed(multiplier: number): void {
    this.send({ type: 'set-speed', multiplier });
  }

  requestSnapshot(): void {
    this.send({ type: 'request-snapshot' });
  }

  getAgent(entityId: number, requestId?: number): void {
    this.send({ type: 'get-agent', entityId, requestId });
  }

  getGroup(groupId: number, requestId?: number): void {
    this.send({ type: 'get-group', groupId, requestId });
  }

  requestSave(requestId?: number): void {
    this.send({ type: 'request-save', requestId });
  }

  verifyDeterminism(seed?: number, ticks?: number, requestId?: number): void {
    this.send({ type: 'verify-determinism', seed, ticks, requestId });
  }

  dispose(): void {
    this.worker.terminate();
  }
}

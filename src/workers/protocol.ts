/**
 * Worker protocol: the message contract between the main thread and the
 * simulation worker.
 *
 * This module is TYPES AND CONSTANTS ONLY (type-only imports of DTOs) so that
 * importing it from main-thread code never pulls simulation runtime code into
 * the main bundle.
 *
 * Communication rules:
 *   - main -> worker: SimulationCommand (controls + queries)
 *   - worker -> main: WorkerMessage (state pushed at a bounded rate)
 *   - state crosses the boundary only as structured-clone snapshots — the
 *     worker never shares mutable simulation objects with the UI
 *
 * Queries that need a response carry an optional `requestId` which the worker
 * echoes back, letting callers correlate replies (used by the dev handle and
 * the e2e smoke test).
 */

import type { SimulationSaveState, DeterminismCheckResult, AgentDetails, SimulationSnapshot } from '../persistence';
import type { SimulationEvent } from '../simulation-core';

// --- Commands (main -> worker) ----------------------------------------------

export type SimulationCommand =
  | { type: 'init'; seed: number }
  | { type: 'set-running'; running: boolean }
  | { type: 'set-speed'; multiplier: number }
  | { type: 'request-snapshot'; requestId?: number }
  | { type: 'get-agent'; entityId: number; requestId?: number }
  | { type: 'request-save'; requestId?: number }
  | { type: 'verify-determinism'; seed?: number; ticks?: number; requestId?: number };

// --- Messages (worker -> main) -----------------------------------------------

export type WorkerStatus = 'boot' | 'running' | 'paused' | 'error';

/** Static world description, sent once per `init` (phase 1 worlds are static). */
export interface WorldInitPayload {
  readonly width: number;
  readonly height: number;
  readonly terrain: Uint8Array;
  readonly food: Float32Array;
  readonly water: Float32Array;
  readonly temperature: Float32Array;
}

export interface WorkerDebugStats {
  readonly status: WorkerStatus;
  readonly ticksPerSecond: number;
  readonly averageTickMs: number;
  readonly lastSliceTickCount: number;
}

export type WorkerMessage =
  | {
      type: 'ready';
      seed: number;
      running: boolean;
      multiplier: number;
      hoursPerTick: number;
      world: WorldInitPayload;
    }
  | { type: 'snapshot'; snapshot: SimulationSnapshot; events: SimulationEvent[]; debug: WorkerDebugStats }
  /** `entityId` echoes the requested id (the agent may no longer exist). */
  | { type: 'agent-details'; entityId: number; agent: AgentDetails | null; requestId?: number }
  | { type: 'save'; save: SimulationSaveState; requestId?: number }
  | { type: 'determinism-result'; result: DeterminismCheckResult; requestId?: number }
  | { type: 'error'; message: string };

// --- Shared constants --------------------------------------------------------

/** Speed multipliers offered by the UI (1x = normal, higher = accelerated). */
export const SPEED_MULTIPLIERS: readonly number[] = [1, 5, 20];

/** Upper bound accepted for set-speed (guards against nonsense requests). */
export const MAX_SPEED_MULTIPLIER = 100;

/** How often the worker entry calls engine.update() (worker loop polling). */
export const WORKER_POLL_INTERVAL_MS = 25;

/** Upper bound on events delivered per snapshot (rest follow in the next one). */
export const MAX_EVENTS_PER_SNAPSHOT = 100;

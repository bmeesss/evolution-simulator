/**
 * WorkerEngine: the simulation loop driver, kept free of any Worker API so it
 * can be unit-tested in Node with an injected clock.
 *
 * Fixed-timestep model:
 *   - real time accumulates into `accumulatorMs`, scaled by the speed multiplier
 *   - each full `1000 / baseTicksPerSecond` of accumulated time runs one
 *     `sim.step()` — the tick length NEVER depends on the render frame rate
 *   - at accelerated speeds many ticks run per update slice (and per snapshot),
 *     which is exactly what the UI needs: rendering shows the latest state
 *     while the simulation advances independently
 *
 * Backlog safety: if the simulation cannot keep up (slow host, huge speed
 * multiplier), the excess accumulator time is dropped instead of spiraling.
 */

import { Simulation, DEFAULT_SIMULATION_CONFIG } from '../simulation-core';
import type { SimulationConfig } from '../simulation-core';
import {
  buildAgentDetails,
  buildSimulationSnapshot,
  runDeterminismCheck,
  serializeSimulation,
} from '../persistence';
import {
  MAX_EVENTS_PER_SNAPSHOT,
  MAX_SPEED_MULTIPLIER,
} from './protocol';
import type {
  SimulationCommand,
  WorkerDebugStats,
  WorkerMessage,
  WorldInitPayload,
} from './protocol';

export interface WorkerEngineHost {
  /** Monotonic clock in milliseconds (performance.now in the real worker). */
  now(): number;
  /** Deliver a message to the main thread (postMessage in the real worker). */
  emit(message: WorkerMessage): void;
}

// Worker-scheduling constants (transport concerns, not simulation semantics).

/** Clamp for one update slice's elapsed time (background tabs throttle timers). */
const MAX_UPDATE_SLICE_MS = 1000;

/** Smoothing factor for the per-tick duration average shown in the debug overlay. */
const TICK_TIME_EMA_ALPHA = 0.15;

/** Length of the ticks-per-second measurement window. */
const TPS_WINDOW_MS = 1000;

/** Minimum window length before a provisional TPS reading is shown. */
const TPS_WINDOW_MIN_MS = 250;

export class WorkerEngine {
  private sim: Simulation | null = null;
  private running = false;
  private multiplier = 1;
  private accumulatorMs = 0;
  private lastTimeMs = 0;
  private averageTickMs = 0;
  private measuredTps = 0;
  private tpsWindowStartMs = -1;
  private tpsWindowTicks = 0;
  private lastSliceTickCount = 0;
  private lastSnapshotMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly host: WorkerEngineHost,
    private readonly config: SimulationConfig = DEFAULT_SIMULATION_CONFIG,
  ) {}

  /** Handle one command from the main thread. Errors are reported, never thrown. */
  handleCommand(command: SimulationCommand): void {
    try {
      this.dispatch(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.emit({ type: 'error', message });
    }
  }

  /**
   * Advance the simulation according to elapsed real time. Called periodically
   * by the worker entry (see WORKER_POLL_INTERVAL_MS).
   */
  update(nowMs: number = this.host.now()): void {
    const sim = this.sim;
    if (!sim) return;

    const elapsedMs = Math.max(0, nowMs - this.lastTimeMs);
    this.lastTimeMs = nowMs;
    if (!this.running) {
      this.accumulatorMs = 0;
      return;
    }

    this.accumulatorMs += Math.min(elapsedMs, MAX_UPDATE_SLICE_MS) * this.multiplier;
    const tickMs = 1000 / this.config.time.baseTicksPerSecond;
    const maxTicks = this.config.time.maxTicksPerUpdateSlice;

    let ticksRan = 0;
    while (this.accumulatorMs >= tickMs && ticksRan < maxTicks) {
      const tickStart = this.host.now();
      sim.step();
      const tickDurationMs = this.host.now() - tickStart;
      this.averageTickMs =
        this.averageTickMs <= 0
          ? tickDurationMs
          : this.averageTickMs * (1 - TICK_TIME_EMA_ALPHA) + tickDurationMs * TICK_TIME_EMA_ALPHA;
      this.accumulatorMs -= tickMs;
      ticksRan++;
    }

    // Cannot keep up: drop backlog rather than accumulate unbounded debt.
    const maxAccumulatorMs = tickMs * maxTicks;
    if (this.accumulatorMs > maxAccumulatorMs) this.accumulatorMs = maxAccumulatorMs;

    this.lastSliceTickCount = ticksRan;
    this.updateTps(nowMs, ticksRan);

    if (ticksRan > 0 && nowMs - this.lastSnapshotMs >= this.config.time.snapshotIntervalMs) {
      this.emitSnapshot(nowMs);
    }
  }

  private dispatch(command: SimulationCommand): void {
    switch (command.type) {
      case 'init':
        this.initialize(command.seed);
        return;
      case 'set-running':
        this.setRunning(command.running);
        return;
      case 'set-speed':
        this.setSpeed(command.multiplier);
        return;
      case 'request-snapshot': {
        if (!this.requireSim()) return;
        this.emitSnapshot();
        return;
      }
      case 'get-agent': {
        const sim = this.requireSim();
        if (!sim) return;
        this.host.emit({
          type: 'agent-details',
          entityId: command.entityId,
          agent: buildAgentDetails(sim, command.entityId),
          requestId: command.requestId,
        });
        return;
      }
      case 'request-save': {
        const sim = this.requireSim();
        if (!sim) return;
        this.host.emit({ type: 'save', save: serializeSimulation(sim), requestId: command.requestId });
        return;
      }
      case 'verify-determinism': {
        const seed = command.seed ?? this.sim?.seed;
        if (seed === undefined) {
          this.host.emit({ type: 'error', message: 'verify-determinism: no seed provided and no simulation initialized' });
          return;
        }
        const ticks = command.ticks ?? 500;
        this.host.emit({
          type: 'determinism-result',
          result: runDeterminismCheck(seed, ticks, this.config),
          requestId: command.requestId,
        });
        return;
      }
      default: {
        const unknown: never = command;
        throw new Error(`Unknown command: ${JSON.stringify(unknown)}`);
      }
    }
  }

  private initialize(seed: number): void {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new Error(`Invalid seed (expected uint32): ${seed}`);
    }
    const hadSimulation = this.sim !== null;
    const sim = Simulation.create(seed, this.config);
    this.sim = sim;
    // New worlds start running immediately at normal speed.
    this.running = true;
    this.multiplier = 1;
    this.accumulatorMs = 0;
    this.averageTickMs = 0;
    this.lastSliceTickCount = 0;
    const now = this.host.now();
    this.lastTimeMs = now;
    this.resetTpsWindow(now);
    if (hadSimulation) {
      sim.events.record('simulation_reinitialized', { detail: `seed=${seed}` });
    }
    this.host.emit({
      type: 'ready',
      seed,
      running: this.running,
      multiplier: this.multiplier,
      hoursPerTick: this.config.time.hoursPerTick,
      world: this.worldPayload(sim),
    });
    this.emitSnapshot(now);
  }

  private setRunning(running: boolean): void {
    const sim = this.requireSim();
    if (!sim) return;
    if (this.running === running) {
      this.emitSnapshot();
      return;
    }
    this.running = running;
    const now = this.host.now();
    this.accumulatorMs = 0;
    this.lastTimeMs = now;
    if (running) {
      this.resetTpsWindow(now);
      sim.events.record('simulation_resumed');
    } else {
      this.measuredTps = 0;
      this.lastSliceTickCount = 0;
      sim.events.record('simulation_paused');
    }
    this.emitSnapshot(now);
  }

  private setSpeed(multiplier: number): void {
    const sim = this.requireSim();
    if (!sim) return;
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > MAX_SPEED_MULTIPLIER) {
      throw new Error(`Invalid speed multiplier: ${multiplier}`);
    }
    if (this.multiplier === multiplier) return;
    this.multiplier = multiplier;
    sim.events.record('speed_changed', { detail: `${multiplier}x` });
    this.emitSnapshot();
  }

  private requireSim(): Simulation | null {
    if (!this.sim) {
      this.host.emit({ type: 'error', message: 'No simulation initialized (send "init" first)' });
    }
    return this.sim;
  }

  private worldPayload(sim: Simulation): WorldInitPayload {
    return {
      width: sim.world.width,
      height: sim.world.height,
      terrain: sim.world.terrain,
      food: sim.world.food,
      water: sim.world.water,
      temperature: sim.world.temperature,
    };
  }

  private emitSnapshot(nowMs: number = this.host.now()): void {
    const sim = this.sim;
    if (!sim) return;
    this.lastSnapshotMs = nowMs;
    const debug: WorkerDebugStats = {
      status: this.running ? 'running' : 'paused',
      ticksPerSecond: this.measuredTps,
      averageTickMs: this.averageTickMs,
      lastSliceTickCount: this.lastSliceTickCount,
    };
    this.host.emit({
      type: 'snapshot',
      snapshot: buildSimulationSnapshot(sim),
      events: sim.events.drain(MAX_EVENTS_PER_SNAPSHOT),
      debug,
    });
  }

  private updateTps(nowMs: number, ticksRan: number): void {
    if (this.tpsWindowStartMs < 0) this.tpsWindowStartMs = nowMs;
    this.tpsWindowTicks += ticksRan;
    const windowMs = nowMs - this.tpsWindowStartMs;
    if (windowMs >= TPS_WINDOW_MS) {
      this.measuredTps = (this.tpsWindowTicks * 1000) / windowMs;
      this.tpsWindowStartMs = nowMs;
      this.tpsWindowTicks = 0;
    } else if (this.measuredTps === 0 && windowMs >= TPS_WINDOW_MIN_MS) {
      // Provisional reading so the overlay is populated during the first second.
      this.measuredTps = (this.tpsWindowTicks * 1000) / windowMs;
    }
  }

  private resetTpsWindow(nowMs: number): void {
    this.tpsWindowStartMs = nowMs;
    this.tpsWindowTicks = 0;
    this.measuredTps = 0;
  }
}

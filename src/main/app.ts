/**
 * EvolutionApp: wires the worker client, renderer and UI panels together on
 * the main thread.
 *
 * Data flow (one direction — worker -> snapshots -> UI/rendering):
 *   worker messages -> latestSnapshot -> rAF render + panel updates
 *   UI controls     -> worker commands
 * The app never holds or imports simulation logic; it only routes messages.
 */

import { SimulationWorkerClient } from '../workers/worker-client';
import type { WorkerMessage, WorkerStatus, WorkerDebugStats } from '../workers/protocol';
import { WorldRenderer } from '../rendering/renderer';
import { agentRadiusTiles } from '../rendering/agent-visuals';
import { AgentSelection } from './agent-selection';
import { AgentPanel } from '../ui/agent-panel';
import { ControlsPanel } from '../ui/controls-panel';
import { DebugOverlay } from '../ui/debug-overlay';
import { EventLogPanel } from '../ui/event-log-panel';
import { StatsPanel } from '../ui/stats-panel';
import { HistoryGraph } from '../ui/history-graph';
import { TraitDistributionsPanel } from '../ui/trait-distributions';
import type { SimulationSaveState, DeterminismCheckResult, SimulationSnapshot } from '../persistence';
import type { EntityId } from '../simulation-core';

/** First-run seed (reproducible demo world; the UI offers random seeds). */
export const DEFAULT_SEED = 1337;

/** Extra click tolerance around small agents (in tile units). */
const MIN_PICK_RADIUS_TILES = 0.35;

/** Debug overlay refresh interval (keeps DOM churn low). */
const OVERLAY_UPDATE_INTERVAL_MS = 250;

/** Render FPS measurement window. */
const FPS_WINDOW_MS = 500;

export interface EvolutionDebugState {
  readonly tick: number;
  readonly workerStatus: WorkerStatus;
  readonly running: boolean;
  readonly population: number;
  readonly snapshotCount: number;
  readonly renderFps: number;
  readonly selectedEntityId: EntityId | null;
}

export interface EvolutionDebugHandle {
  status(): EvolutionDebugState;
  save(): Promise<SimulationSaveState>;
  verifyDeterminism(ticks?: number): Promise<DeterminismCheckResult>;
}

declare global {
  interface Window {
    __evosim?: EvolutionDebugHandle;
  }
}

export class EvolutionApp {
  private readonly worker = new SimulationWorkerClient();
  private readonly renderer: WorldRenderer;
  private readonly controls = new ControlsPanel({
    onToggleRunning: () => this.worker.setRunning(!this.isRunning),
    onSpeedChange: (multiplier) => this.worker.setSpeed(multiplier),
    onApplySeed: (seed) => this.worker.init(seed),
  });
  private readonly stats = new StatsPanel();
  private readonly historyGraph = new HistoryGraph();
  private readonly traitDistributions = new TraitDistributionsPanel();
  private readonly agentPanel = new AgentPanel();
  private readonly eventLog = new EventLogPanel();
  private readonly debugOverlay = new DebugOverlay();

  private latestSnapshot: SimulationSnapshot | null = null;
  /** Currently selected agent + stale-reply guard (see agent-selection.ts). */
  private readonly selection = new AgentSelection();
  private workerStatus: WorkerStatus = 'boot';
  private isRunning = false;
  private snapshotCount = 0;
  private lastDebugStats: WorkerDebugStats = {
    status: 'boot',
    ticksPerSecond: 0,
    averageTickMs: 0,
    lastSliceTickCount: 0,
  };

  private renderFps = 0;
  private frames = 0;
  private fpsWindowStartMs = 0;
  private lastOverlayUpdateMs = 0;

  private nextRequestId = 1;
  private readonly pendingReplies = new Map<number, (message: WorkerMessage) => void>();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WorldRenderer(canvas);
    this.worker.onMessage = (message) => this.handleWorkerMessage(message);

    canvas.addEventListener('click', (event) => {
      const rect = canvas.getBoundingClientRect();
      this.selectAgentAt(event.clientX - rect.left, event.clientY - rect.top);
    });

    requestAnimationFrame((nowMs) => {
      this.fpsWindowStartMs = nowMs;
      this.renderFrame(nowMs);
    });
  }

  /** Boot the initial simulation. */
  start(): void {
    this.controls.setSeed(DEFAULT_SEED);
    this.worker.init(DEFAULT_SEED);
  }

  // --- Worker message handling ---------------------------------------------

  private handleWorkerMessage(message: WorkerMessage): void {
    // Correlated replies (dev handle / e2e smoke test) resolve their promises.
    if ('requestId' in message && message.requestId !== undefined) {
      const resolver = this.pendingReplies.get(message.requestId);
      if (resolver) {
        this.pendingReplies.delete(message.requestId);
        resolver(message);
      }
    }

    switch (message.type) {
      case 'ready':
        this.handleReady(message.seed, message.running, message.multiplier);
        this.renderer.setWorld(message.world);
        break;
      case 'snapshot':
        this.handleSnapshot(message.snapshot);
        this.eventLog.addEvents(message.events);
        this.workerStatus = message.debug.status;
        this.lastDebugStats = message.debug;
        this.isRunning = message.debug.status === 'running';
        this.controls.setRunning(this.isRunning);
        break;
      case 'agent-details':
        // Drop stale replies: only a reply matching the current selection may
        // touch the panel (regression-tested in tests/agent-selection.test.ts).
        if (!message.requestId && this.selection.shouldApplyDetails(message.entityId)) {
          if (message.agent) {
            this.agentPanel.showAgent(message.agent);
          } else {
            this.agentPanel.showMissing(message.entityId);
          }
        }
        break;
      case 'determinism-result':
        if (!message.requestId) {
          console.info('[evosim] determinism self-check:', message.result);
        }
        break;
      case 'save':
        if (!message.requestId) {
          console.info('[evosim] save state captured', message.save);
        }
        break;
      case 'error':
        this.workerStatus = 'error';
        this.isRunning = false;
        this.controls.setRunning(false);
        console.error('[evosim] worker error:', message.message);
        break;
    }
  }

  private handleReady(seed: number, running: boolean, multiplier: number): void {
    this.latestSnapshot = null;
    this.selection.clear(); // replies from the previous world are stale
    this.snapshotCount = 0;
    this.isRunning = running;
    this.controls.setSeed(seed);
    this.controls.setRunning(running);
    this.controls.setSpeed(multiplier);
    this.stats.clear();
    this.historyGraph.clear();
    this.traitDistributions.clear();
    this.agentPanel.clear();
    this.eventLog.clear();
  }

  private handleSnapshot(snapshot: SimulationSnapshot): void {
    this.latestSnapshot = snapshot;
    this.snapshotCount++;
    this.stats.update(snapshot);
    this.historyGraph.push(snapshot);
    this.traitDistributions.update(snapshot);
    // Keep the selected-agent panel live (guarded against stale replies).
    const selected = this.selection.entityId;
    if (selected !== null) {
      this.worker.getAgent(selected);
    }
  }

  // --- Selection -------------------------------------------------------------

  private selectAgentAt(cssX: number, cssY: number): void {
    const snapshot = this.latestSnapshot;
    if (!snapshot) return;
    const point = this.renderer.screenToWorld(cssX, cssY);
    const agents = snapshot.agents;

    let bestId: number | null = null;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;
    for (let i = 0; i < agents.ids.length; i++) {
      const dx = agents.x[i] - point.x;
      const dy = agents.y[i] - point.y;
      const distanceSquared = dx * dx + dy * dy;
      const pickRadius = Math.max(MIN_PICK_RADIUS_TILES, agentRadiusTiles(agents.strength[i]));
      if (distanceSquared <= pickRadius * pickRadius && distanceSquared < bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
        bestId = agents.ids[i];
      }
    }

    if (bestId === null) {
      this.selection.clear();
      this.agentPanel.clear();
    } else {
      this.selection.select(bestId);
      this.worker.getAgent(bestId);
    }
  }

  // --- Render loop -----------------------------------------------------------

  private renderFrame = (nowMs: number): void => {
    this.renderer.render(this.latestSnapshot, this.selection.entityId);

    this.frames++;
    if (nowMs - this.fpsWindowStartMs >= FPS_WINDOW_MS) {
      this.renderFps = (this.frames * 1000) / (nowMs - this.fpsWindowStartMs);
      this.frames = 0;
      this.fpsWindowStartMs = nowMs;
    }

    if (nowMs - this.lastOverlayUpdateMs >= OVERLAY_UPDATE_INTERVAL_MS) {
      this.lastOverlayUpdateMs = nowMs;
      const snapshot = this.latestSnapshot;
      this.debugOverlay.update({
        workerStatus: this.workerStatus,
        tick: snapshot ? snapshot.tick : 0,
        agentCount: snapshot ? snapshot.population : 0,
        renderFps: this.renderFps,
        debug: this.lastDebugStats,
      });
    }

    requestAnimationFrame(this.renderFrame);
  };

  // --- Development handle ------------------------------------------------------

  /** Debug handle exposed on window in dev builds (see scripts/browser-smoke.mjs). */
  createDebugHandle(): EvolutionDebugHandle {
    return {
      status: (): EvolutionDebugState => ({
        tick: this.latestSnapshot ? this.latestSnapshot.tick : 0,
        workerStatus: this.workerStatus,
        running: this.isRunning,
        population: this.latestSnapshot ? this.latestSnapshot.population : 0,
        snapshotCount: this.snapshotCount,
        renderFps: this.renderFps,
        selectedEntityId: this.selection.entityId,
      }),
      save: async (): Promise<SimulationSaveState> => {
        const reply = await this.requestReply((requestId) => this.worker.requestSave(requestId));
        if (reply.type !== 'save') throw new Error(`Unexpected reply: ${reply.type}`);
        return reply.save;
      },
      verifyDeterminism: async (ticks?: number): Promise<DeterminismCheckResult> => {
        const reply = await this.requestReply((requestId) =>
          this.worker.verifyDeterminism(undefined, ticks, requestId),
        );
        if (reply.type !== 'determinism-result') throw new Error(`Unexpected reply: ${reply.type}`);
        return reply.result;
      },
    };
  }

  private requestReply(send: (requestId: number) => void): Promise<WorkerMessage> {
    const requestId = this.nextRequestId++;
    return new Promise<WorkerMessage>((resolve) => {
      this.pendingReplies.set(requestId, resolve);
      send(requestId);
    });
  }
}

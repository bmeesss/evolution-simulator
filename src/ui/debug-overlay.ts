/**
 * Debug/development overlay: worker health + performance counters.
 *
 * Render FPS is measured on the main thread; tick throughput and per-tick
 * simulation time come from worker debug stats. Intended for future
 * optimization work — keep it cheap (plain textContent updates).
 */

import { requireElement } from './dom';
import type { WorkerDebugStats, WorkerStatus } from '../workers/protocol';

export interface DebugOverlayState {
  readonly workerStatus: WorkerStatus;
  readonly tick: number;
  readonly agentCount: number;
  readonly renderFps: number;
  readonly debug: WorkerDebugStats;
}

const STATUS_COLORS: Readonly<Record<WorkerStatus, string>> = {
  boot: '#9aa4b2',
  running: '#5dd39e',
  paused: '#e0b050',
  error: '#e2606b',
};

export class DebugOverlay {
  private readonly root = requireElement<HTMLElement>('debug-overlay');

  update(state: DebugOverlayState): void {
    requireElement('dbg-status').textContent = state.workerStatus;
    (requireElement('dbg-status') as HTMLElement).style.color = STATUS_COLORS[state.workerStatus];
    requireElement('dbg-tick').textContent = String(state.tick);
    requireElement('dbg-tps').textContent = state.debug.ticksPerSecond.toFixed(1);
    requireElement('dbg-tick-ms').textContent = `${state.debug.averageTickMs.toFixed(3)} ms`;
    requireElement('dbg-slice').textContent = String(state.debug.lastSliceTickCount);
    requireElement('dbg-agents').textContent = String(state.agentCount);
    requireElement('dbg-fps').textContent = state.renderFps.toFixed(0);
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }
}

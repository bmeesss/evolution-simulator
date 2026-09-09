/**
 * Top control bar: Start/Pause, speed selection, seed input.
 *
 * Panels are dumb: they own DOM elements and fire callbacks; all wiring lives
 * in main/app.ts.
 */

import { requireElement } from './dom';
import { SPEED_MULTIPLIERS } from '../workers/protocol';

/** UI-level seed generation uses the platform CSPRNG — seed CHOICE is outside
 *  the simulation, whose own streams must stay deterministic. */
function randomUint32(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0];
}

export interface ControlsCallbacks {
  onToggleRunning(): void;
  onSpeedChange(multiplier: number): void;
  /** Called with a validated uint32 seed when the user starts a new world. */
  onApplySeed(seed: number): void;
}

export class ControlsPanel {
  private readonly toggleButton = requireElement<HTMLButtonElement>('btn-toggle-running');
  private readonly speedSelect = requireElement<HTMLSelectElement>('select-speed');
  private readonly seedInput = requireElement<HTMLInputElement>('input-seed');
  private readonly seedError = requireElement<HTMLElement>('seed-error');

  constructor(callbacks: ControlsCallbacks) {
    this.toggleButton.addEventListener('click', () => callbacks.onToggleRunning());
    this.speedSelect.addEventListener('change', () => {
      const multiplier = Number(this.speedSelect.value);
      if (Number.isFinite(multiplier) && multiplier > 0) {
        callbacks.onSpeedChange(multiplier);
      }
    });
    requireElement<HTMLButtonElement>('btn-apply-seed').addEventListener('click', () => {
      const seed = this.readSeed();
      if (seed !== null) callbacks.onApplySeed(seed);
    });
    requireElement<HTMLButtonElement>('btn-random-seed').addEventListener('click', () => {
      const seed = randomUint32();
      this.setSeed(seed);
      callbacks.onApplySeed(seed);
    });

    for (const multiplier of SPEED_MULTIPLIERS) {
      const option = document.createElement('option');
      option.value = String(multiplier);
      option.textContent = `${multiplier}x`;
      if (multiplier === 1) option.selected = true;
      this.speedSelect.appendChild(option);
    }
  }

  /** Reflect the worker's running state on the Start/Pause button. */
  setRunning(running: boolean): void {
    this.toggleButton.textContent = running ? 'Pause' : 'Start';
  }

  /** Sync the select after a re-init (the worker resets speed to 1x). */
  setSpeed(multiplier: number): void {
    this.speedSelect.value = String(multiplier);
  }

  setSeed(seed: number): void {
    this.seedInput.value = String(seed);
    this.seedError.textContent = '';
  }

  private readSeed(): number | null {
    const raw = this.seedInput.value.trim();
    const seed = Number(raw);
    if (raw === '' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      this.seedError.textContent = 'Seed must be an integer in [0, 4294967295]';
      return null;
    }
    this.seedError.textContent = '';
    return seed;
  }
}

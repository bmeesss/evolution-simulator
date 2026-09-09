/**
 * Main-thread entry point: bootstraps the app and the dev debug handle.
 */

import './styles.css';
import { requireElement } from '../ui/dom';
import { DEFAULT_SEED, EvolutionApp } from './app';

const canvas = requireElement<HTMLCanvasElement>('world-canvas');
const app = new EvolutionApp(canvas);
app.start();

// Development handle used by scripts/browser-smoke.mjs (and curious humans).
// Dev-only: production builds contain no global escape hatch.
if (import.meta.env.DEV) {
  window.__evosim = app.createDebugHandle();
  console.info(
    `[evosim] dev handle ready (window.__evosim) — initial seed ${DEFAULT_SEED}. ` +
      'Try __evosim.verifyDeterminism().',
  );
}

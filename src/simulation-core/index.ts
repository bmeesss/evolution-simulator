/**
 * simulation-core — the deterministic, platform-independent heart of the
 * evolution simulator.
 *
 * PURITY CONTRACT: nothing in this folder may import or reference DOM, canvas,
 * window, document or any rendering/UI API. Rendering and UI consume extracted
 * snapshots only. A source-hygiene test enforces this.
 */

export * from './rng';
export * from './ecs';
export * from './world';
export * from './genetics';
export * from './ai';
export * from './events';
export * from './simulation';

/**
 * Deterministic seed-derivation helpers.
 *
 * WHY: every random stream in the simulation must be reproducible from a single
 * integer seed, and independent streams (world generation vs. agent spawning vs.
 * tick dynamics) must not interfere with each other. Deriving each stream from
 * `(rootSeed, label)` means changes to one stream's consumption pattern can
 * never change the numbers produced by another stream.
 */

/** FNV-1a 32-bit hash of a string. Deterministic across platforms. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Derive an integer seed for a named stream (e.g. 'sim', 'spawn') from a root
 * seed. The mixing guarantees that nearby root seeds produce well-spread
 * stream seeds.
 */
export function deriveStreamSeed(rootSeed: number, label: string): number {
  let h = (rootSeed ^ fnv1a32(label)) >>> 0;
  // splitmix32 finalizer — cheap, high-quality avalanche.
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * Integer hash of 2D lattice coordinates -> [0, 1).
 *
 * WHY: used by the world generator's value noise so that world generation is a
 * pure function of (seed, x, y) and consumes no RNG stream state at all.
 */
export function hash2D(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae3d);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

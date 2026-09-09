/**
 * Deterministic seeded PRNG for all simulation randomness.
 *
 * WHY: the platform RNG is forbidden in simulation code so that a run is fully
 * reproducible from its seed — the determinism tests and future save/load rely
 * on it. The generator is sfc32: small, fast, well-tested statistically, and
 * its entire state is four uint32 words, which makes serialization trivial.
 *
 * IMPORTANT: cross-engine determinism relies only on IEEE-754 exact operations
 * (+, *, integer ops, division by exact powers of two). Avoid Math.hypot and
 * trig functions in random-dependent code paths.
 */

export interface RngState {
  /** Four sfc32 state words, stored as unsigned 32-bit integers. */
  readonly s0: number;
  readonly s1: number;
  readonly s2: number;
  readonly s3: number;
}

const UINT32_SCALE = 4294967296; // 2^32 — exact power of two, division is exact.

/** Number of warm-up rounds applied when seeding from a single integer. */
const SEED_WARMUP_ROUNDS = 8;

/**
 * splitmix32 — used only to expand a single integer seed into the four sfc32
 * state words with good bit dispersion.
 */
function splitmix32(seed: number): number {
  let x = seed | 0;
  x = (x + 0x9e3779b9) | 0;
  let t = x ^ (x >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t = t ^ (t >>> 15);
  t = Math.imul(t, 0x735a2d97);
  return (t ^ (t >>> 15)) | 0;
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  private constructor(state: RngState) {
    this.s0 = state.s0 >>> 0;
    this.s1 = state.s1 >>> 0;
    this.s2 = state.s2 >>> 0;
    this.s3 = state.s3 >>> 0;
  }

  /** Create a generator from a single integer seed. Same seed -> same stream. */
  static fromSeed(seed: number): Rng {
    const rng = new Rng({ s0: seed, s1: 0, s2: 0, s3: 0 });
    let x = seed | 0;
    rng.s0 = splitmix32(x);
    x = rng.s0;
    rng.s1 = splitmix32(x);
    x = rng.s1;
    rng.s2 = splitmix32(x);
    x = rng.s2;
    rng.s3 = splitmix32(x);
    // Warm up so that poor initial states cannot correlate early outputs.
    for (let i = 0; i < SEED_WARMUP_ROUNDS; i++) rng.next();
    return rng;
  }

  /** Restore a generator from a previously captured state (exact continuation). */
  static fromState(state: RngState): Rng {
    return new Rng(state);
  }

  /** Serializable snapshot of the current state. */
  getState(): RngState {
    return { s0: this.s0, s1: this.s1, s2: this.s2, s3: this.s3 };
  }

  /** Overwrite the current state (used when loading a save). */
  setState(state: RngState): void {
    this.s0 = state.s0 >>> 0;
    this.s1 = state.s1 >>> 0;
    this.s2 = state.s2 >>> 0;
    this.s3 = state.s3 >>> 0;
  }

  /** Next raw unsigned 32-bit integer. */
  next(): number {
    const s0 = this.s0;
    const s1 = this.s1;
    const s2 = this.s2;
    let s3 = this.s3;
    let t = (s0 + s1) | 0;
    this.s0 = (s1 ^ (s1 >>> 9)) >>> 0;
    this.s1 = (s2 + (s2 << 3)) >>> 0;
    this.s2 = ((s2 << 21) | (s2 >>> 11)) >>> 0;
    s3 = (s3 + 1) >>> 0;
    this.s3 = s3;
    t = (t + s3) | 0;
    this.s2 = (this.s2 + t) >>> 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  nextFloat(): number {
    return this.next() / UINT32_SCALE;
  }

  /** Uniform integer in [0, maxExclusive). Throws when maxExclusive < 1. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive < 1 || !Number.isSafeInteger(maxExclusive)) {
      throw new Error(`Rng.nextInt: maxExclusive must be an integer >= 1, got ${maxExclusive}`);
    }
    // Rejection sampling keeps the distribution uniform (no modulo bias).
    // Expected iterations < 2; the loop is deterministic anyway.
    const limit = Math.floor(UINT32_SCALE / maxExclusive) * maxExclusive;
    let value = this.next();
    while (value >= limit) {
      value = this.next();
    }
    return value % maxExclusive;
  }

  /** Uniform float in [min, max). */
  rangeFloat(min: number, max: number): number {
    return min + this.nextFloat() * (max - min);
  }

  /** Uniform integer in [minInclusive, maxExclusive). */
  rangeInt(minInclusive: number, maxExclusive: number): number {
    return minInclusive + this.nextInt(maxExclusive - minInclusive);
  }

  /** True with the given probability (0 = never, 1 = always). */
  chance(probability: number): boolean {
    return this.nextFloat() < probability;
  }

  /** Uniformly pick one item. The array must not be empty. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Rng.pick: items must not be empty');
    }
    return items[this.nextInt(items.length)];
  }
}

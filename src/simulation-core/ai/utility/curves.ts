/**
 * Utility curves — the building blocks every AI consideration is shaped with.
 *
 * All curves map an input `t` in [0, 1] to a bounded, predictable output in
 * [0, 1]. By composing these primitives the Utility AI expresses "how much
 * does this factor matter right now" without scattering ad-hoc math (or magic
 * constants) through the action code. Curve parameters that tune gameplay
 * live in `SimulationConfig.ai` / `SimulationConfig.needs`, never here.
 *
 * Determinism note: only IEEE-754-exact operations (+, -, *, /, comparisons).
 * No Math.hypot/trig/exp — those allow engine-dependent precision.
 *
 * Why each curve exists:
 *   - linear            — a neutral, "proportional to input" mapping. The
 *                         baseline for factors whose effect should grow evenly.
 *   - inverseLinear     — proportional to *lack* of input (e.g. energy is
 *                         high → need to rest is low).
 *   - quadratic         — punishes low values and saturates near 1: needs
 *                         become urgent late, mild early. Good for hunger/
 *                         thirst urgency and for preferring rich resources.
 *   - inverseQuadratic  — the mirror: a factor stays strong until it is almost
 *                         gone (e.g. reachability: a nearby tile is still
 *                         "close enough" until it gets genuinely far).
 *   - sigmoid           — a soft threshold: values below `center` count as
 *                         "not yet", values above it count as "yes". Used for
 *                         needs that should trigger around a specific level.
 *   - bell              — a peak around a preferred point (e.g. an ideal
 *                         distance); currently provided for completeness and
 *                         future use (temperature preference, crowding).
 */

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Identity mapping: output rises linearly with input. */
export function linear(t: number): number {
  return clamp01(t);
}

/** Decreasing linear: output is `1 - t` (mirror of `linear`). */
export function inverseLinear(t: number): number {
  return clamp01(1 - t);
}

/** Quadratic: `t * t`. Slow start, fast finish — "urgent only when it hurts". */
export function quadratic(t: number): number {
  const c = clamp01(t);
  return c * c;
}

/** Inverse quadratic: `(1 - t)^2`. Stays high, then drops fast at the end. */
export function inverseQuadratic(t: number): number {
  const c = 1 - clamp01(t);
  return c * c;
}

/**
 * Algebraic sigmoid over [0, 1] with `center` as the midpoint and `k` the
 * steepness. Output is in (0, 1) — a soft threshold that never quite reaches
 * the endpoints.
 *
 * WHY an algebraic form (0.5 + 0.5·s/(1+|s|), s = k·(t-center)) instead of the
 * logistic 1/(1+e^-x): Math.exp is an implementation-dependent approximation,
 * so it would break cross-engine determinism. This curve is built only from
 * +, -, *, / and Math.abs — all IEEE-754-exact — while keeping the same S
 * shape and asymptotes.
 */
export function sigmoid(t: number, k: number, center: number): number {
  const s = k * (t - center);
  const magnitude = s < 0 ? -s : s; // Math.abs without relying on Math.abs
  return 0.5 + (0.5 * s) / (1 + magnitude);
}

/**
 * Gaussian-style peak at `center` with standard deviation `width`. Equals 1 at
 * the center and falls toward 0 away from it. Implemented with squaring only
 * (deterministic), normalized so the shape is width-invariant.
 */
export function bell(t: number, center: number, width: number): number {
  if (width <= 0) return 0;
  const d = (t - center) / width;
  return Math.max(0, 1 - d * d); // quadratic falloff, 1 at peak, 0 at |d| >= 1
}

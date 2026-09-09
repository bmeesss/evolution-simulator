/**
 * Deterministic 2D value noise.
 *
 * WHY: the world must be a pure function of the seed. Hash-based lattice noise
 * consumes no RNG stream state, so world layout is independent of every other
 * random stream in the simulation (and can be recomputed tile-by-tile later,
 * e.g. for chunks or streaming).
 */

import { hash2D } from '../rng';

/** Smoothstep fade between lattice points (C1-continuous, cheap). */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Single-octave value noise in [0, 1) at continuous coordinates. */
export function valueNoise2D(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);

  const v00 = hash2D(seed, x0, y0);
  const v10 = hash2D(seed, x0 + 1, y0);
  const v01 = hash2D(seed, x0, y0 + 1);
  const v11 = hash2D(seed, x0 + 1, y0 + 1);

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Fractal Brownian motion: summed octaves of value noise, normalized to
 * [0, 1). Deterministic for a fixed seed and coordinates.
 */
export function fbm2D(
  seed: number,
  x: number,
  y: number,
  octaves: number,
  lacunarity: number,
  gain: number,
): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let totalAmplitude = 0;
  for (let octave = 0; octave < octaves; octave++) {
    sum += valueNoise2D(seed + octave * 0x9e3779b9, x * frequency, y * frequency) * amplitude;
    totalAmplitude += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / totalAmplitude;
}

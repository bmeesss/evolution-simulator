import { describe, expect, it } from 'vitest';
import { Rng } from '../src/simulation-core/rng';
import { deriveStreamSeed, fnv1a32, hash2D } from '../src/simulation-core/rng';

describe('Rng (sfc32)', () => {
  it('produces identical sequences for identical seeds', () => {
    const a = Rng.fromSeed(1337);
    const b = Rng.fromSeed(1337);
    for (let i = 0; i < 10_000; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = Rng.fromSeed(1);
    const b = Rng.fromSeed(2);
    const aValues = Array.from({ length: 100 }, () => a.next());
    const bValues = Array.from({ length: 100 }, () => b.next());
    expect(aValues).not.toEqual(bValues);
  });

  it('nextFloat returns values in [0, 1)', () => {
    const rng = Rng.fromSeed(42);
    for (let i = 0; i < 10_000; i++) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('has a sane mean over many draws', () => {
    const rng = Rng.fromSeed(7);
    let sum = 0;
    const draws = 100_000;
    for (let i = 0; i < draws; i++) sum += rng.nextFloat();
    const mean = sum / draws;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.01);
  });

  it('nextInt stays within bounds and covers the range', () => {
    const rng = Rng.fromSeed(99);
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i++) {
      const value = rng.nextInt(10);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10);
      expect(Number.isInteger(value)).toBe(true);
      seen.add(value);
    }
    expect(seen.size).toBe(10);
  });

  it('nextInt(1) is always 0 and rejects invalid bounds', () => {
    const rng = Rng.fromSeed(5);
    for (let i = 0; i < 100; i++) expect(rng.nextInt(1)).toBe(0);
    expect(() => rng.nextInt(0)).toThrow();
  });

  it('rangeInt/rangeFloat respect their bounds', () => {
    const rng = Rng.fromSeed(123);
    for (let i = 0; i < 1_000; i++) {
      const int = rng.rangeInt(3, 8);
      expect(int).toBeGreaterThanOrEqual(3);
      expect(int).toBeLessThan(8);
      const float = rng.rangeFloat(-2.5, 7.5);
      expect(float).toBeGreaterThanOrEqual(-2.5);
      expect(float).toBeLessThan(7.5);
    }
  });

  it('chance is exact at the extremes', () => {
    const never = Rng.fromSeed(1);
    const always = Rng.fromSeed(1);
    for (let i = 0; i < 1_000; i++) {
      expect(never.chance(0)).toBe(false);
      expect(always.chance(1)).toBe(true);
    }
  });

  it('pick is deterministic and throws on empty input', () => {
    const a = Rng.fromSeed(10);
    const b = Rng.fromSeed(10);
    const items = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < 100; i++) {
      expect(a.pick(items)).toBe(b.pick(items));
    }
    expect(() => a.pick([])).toThrow();
  });

  it('state round-trips exactly (save/load continuation)', () => {
    const original = Rng.fromSeed(2024);
    for (let i = 0; i < 500; i++) original.next();
    const state = original.getState();

    const restored = Rng.fromState(state);
    for (let i = 0; i < 500; i++) {
      expect(original.next()).toBe(restored.next());
    }
    // fromState must not warm up: capturing immediately after must be a no-op.
    const fresh = Rng.fromState(state);
    expect(fresh.getState()).toEqual(state);
  });
});

describe('seed derivation helpers', () => {
  it('derives stable, well-spread stream seeds', () => {
    expect(deriveStreamSeed(1337, 'sim')).toBe(deriveStreamSeed(1337, 'sim'));
    expect(deriveStreamSeed(1337, 'sim')).not.toBe(deriveStreamSeed(1337, 'spawn'));
    expect(deriveStreamSeed(1, 'sim')).not.toBe(deriveStreamSeed(2, 'sim'));
  });

  it('fnv1a32 is stable for the same input', () => {
    expect(fnv1a32('sim')).toBe(fnv1a32('sim'));
    expect(fnv1a32('sim')).not.toBe(fnv1a32('spawn'));
  });

  it('hash2D is stable and in [0, 1)', () => {
    for (let x = -50; x < 50; x += 7) {
      for (let y = -50; y < 50; y += 11) {
        const value = hash2D(12345, x, y);
        expect(value).toBe(hash2D(12345, x, y));
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });
});

/**
 * Cumulative cultural statistics (Phase 5).
 *
 * Only counters that are genuine simulation state live here — they keep
 * growing across save/load and are part of the determinism contract. Everything
 * else the UI shows (how many items are alive right now, cultural diversity,
 * signal conventions, group similarity) is derived on demand from the live
 * stores when a snapshot is built, exactly like the Phase 4 social aggregates.
 *
 * There is deliberately NO "cultural fitness" counter anywhere: a tradition
 * spreads because agents keep teaching it, not because the simulation scores
 * it. The counters below are descriptive history (how much transmission has
 * happened), never inputs to behaviour.
 */

export interface CultureStats {
  /** Items formed from an agent's own experience. */
  discoveries: number;
  /** Successful deliberate transmissions (Teach interactions). */
  taught: number;
  /** Successful observation-driven transmissions (imitation). */
  learned: number;
  /** Items forgotten because their strength decayed away (was confident before). */
  lost: number;
  /** Successful transmissions that produced a slightly altered variant. */
  variants: number;
  /** Norms acquired by any route (a `norm_learned` event was fired). */
  normsLearned: number;
  /** Signal emissions attempted (each cost energy and started a cooldown). */
  signalsEmitted: number;
  /** Emissions that at least one listener was close enough to hear. */
  signalsHeard: number;
  /** Associations that crossed the "meaning known" threshold for the first time. */
  signalLearnings: number;
}

export function createCultureStats(): CultureStats {
  return {
    discoveries: 0,
    taught: 0,
    learned: 0,
    lost: 0,
    variants: 0,
    normsLearned: 0,
    signalsEmitted: 0,
    signalsHeard: 0,
    signalLearnings: 0,
  };
}

export type SerializedCultureStats = CultureStats;

export function serializeCultureStats(stats: CultureStats): SerializedCultureStats {
  return { ...stats };
}

export function restoreCultureStats(saved: SerializedCultureStats): CultureStats {
  return { ...saved };
}

/**
 * Transmission events per 100 ticks — a rate the UI can show without the
 * simulation having to keep a sliding window (which would be extra state and
 * extra allocation). 0 until the first tick has been simulated.
 */
export function transmissionsPer100Ticks(stats: CultureStats, tick: number): number {
  if (tick <= 0) return 0;
  return ((stats.taught + stats.learned) * 100) / tick;
}

/** Cultural losses per 100 ticks (same derivation as the transmission rate). */
export function lossesPer100Ticks(stats: CultureStats, tick: number): number {
  if (tick <= 0) return 0;
  return (stats.lost * 100) / tick;
}

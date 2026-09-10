/**
 * Cumulative social statistics (Phase 4).
 *
 * Only counters that are genuine simulation state live here (they keep
 * growing across save/load). Everything else (active relationships, average
 * trust, group counts, isolated agents…) is derived on demand from live
 * stores when snapshots are built.
 */

export interface SocialStats {
  /** Completed cooperation sessions (cooperation_completed events). */
  cooperationEvents: number;
  /** Executed confrontations (conflict events). */
  conflictEvents: number;
  /** Executed help interactions (helped_agent events). */
  helpEvents: number;
  /** Social interactions that formed a new relationship (first contact). */
  socialInteractionEvents: number;
}

export function createSocialStats(): SocialStats {
  return { cooperationEvents: 0, conflictEvents: 0, helpEvents: 0, socialInteractionEvents: 0 };
}

export interface SerializedSocialStats extends SocialStats {}

export function serializeSocialStats(stats: SocialStats): SerializedSocialStats {
  return { ...stats };
}

export function restoreSocialStats(saved: SerializedSocialStats): SocialStats {
  return { ...saved };
}

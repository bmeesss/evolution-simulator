/**
 * Social layer (Phase 4): sparse relationships, kin awareness, emergent
 * groups and cumulative social statistics.
 *
 * Design principles (see ARCHITECTURE.md §Social layer):
 *   - social memory is SEPARATE from environmental memory (ai/memory),
 *   - relationship storage is sparse and strictly bounded per agent,
 *   - groups are derived structures — never created by a fixed proximity
 *     rule — and their identity persists across detection runs.
 */

export { RelationshipStore } from './relationship-store';
export type { RelationshipData, SerializedRelationshipStore } from './relationship-store';
export { KinshipType, kinshipBetween, areKin, seedKinRelationships } from './kinship';
export { GroupRegistry } from './group-registry';
export type { GroupRecord, SerializedGroupRecord, SerializedGroupRegistry } from './group-registry';
export {
  createSocialStats,
  serializeSocialStats,
  restoreSocialStats,
} from './social-stats';
export type { SocialStats, SerializedSocialStats } from './social-stats';

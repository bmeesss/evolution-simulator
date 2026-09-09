/**
 * Terrain types. Numeric values are stored per tile in the world's Uint8Array,
 * so they must stay stable across save formats.
 */

export const TerrainType = {
  Water: 0,
  Sand: 1,
  Grass: 2,
  Forest: 3,
  Mountain: 4,
} as const;

export type TerrainType = (typeof TerrainType)[keyof typeof TerrainType];

export const TERRAIN_TYPES: readonly TerrainType[] = Object.values(TerrainType);

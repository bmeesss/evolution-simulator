/**
 * Deterministic world generation.
 *
 * The world is a pure function of (seed, world config): terrain comes from
 * hash-lattice fbm noise (no RNG stream consumed), so the same seed always
 * produces the exact same world, independent of everything else that happens
 * in the simulation.
 *
 * All tuning values are named below — they are generation algorithm constants,
 * not runtime simulation config.
 */

import { deriveStreamSeed } from '../rng';
import { fbm2D } from './noise';
import { TerrainType } from './terrain';
import type { WorldDimensions } from './world';
import { World } from './world';

// --- Elevation -------------------------------------------------------------
/** Roughly one elevation feature every 9 tiles. */
const ELEVATION_FEATURE_SIZE_TILES = 9;
const ELEVATION_OCTAVES = 4;
const ELEVATION_LACUNARITY = 2;
const ELEVATION_GAIN = 0.5;
const SEA_LEVEL = 0.34;
const SAND_LEVEL = 0.4;
const FOREST_LEVEL = 0.62;
const MOUNTAIN_LEVEL = 0.78;

// --- Moisture --------------------------------------------------------------
/** Moisture features are broader than elevation ones. */
const MOISTURE_FEATURE_SIZE_TILES = 14;
const MOISTURE_OCTAVES = 3;

// --- Temperature -----------------------------------------------------------
const EQUATOR_TEMPERATURE_C = 27;
const POLAR_TEMPERATURE_DROP_C = 24;
/** Higher elevation (above sea level) is colder. */
const ALTITUDE_TEMPERATURE_DROP_C = 18;
const TEMPERATURE_NOISE_AMPLITUDE_C = 4;

// --- Food & water ----------------------------------------------------------
/** Food capacity per terrain type as (base, moistureWeight) — food in [0, 1]. */
const FOOD_BY_TERRAIN: Readonly<Record<number, { base: number; moistureWeight: number }>> = {
  [TerrainType.Sand]: { base: 0.05, moistureWeight: 0.15 },
  [TerrainType.Grass]: { base: 0.35, moistureWeight: 0.65 },
  [TerrainType.Forest]: { base: 0.25, moistureWeight: 0.55 },
  [TerrainType.Mountain]: { base: 0.05, moistureWeight: 0.2 },
};

function terrainForElevation(elevation: number): number {
  if (elevation < SEA_LEVEL) return TerrainType.Water;
  if (elevation < SAND_LEVEL) return TerrainType.Sand;
  if (elevation < FOREST_LEVEL) return TerrainType.Grass;
  if (elevation < MOUNTAIN_LEVEL) return TerrainType.Forest;
  return TerrainType.Mountain;
}

/**
 * Generate a world. `seed` is the simulation's root seed; noise sub-seeds are
 * derived from it by label so elevation/moisture/temperature are independent.
 */
export function createWorld(seed: number, dimensions: WorldDimensions): World {
  const { width, height } = dimensions;
  const terrain = new Uint8Array(width * height);
  const food = new Float32Array(width * height);
  const water = new Float32Array(width * height);
  const temperature = new Float32Array(width * height);

  const elevationSeed = deriveStreamSeed(seed, 'world:elevation');
  const moistureSeed = deriveStreamSeed(seed, 'world:moisture');
  const temperatureSeed = deriveStreamSeed(seed, 'world:temperature');

  const elevationScale = 1 / ELEVATION_FEATURE_SIZE_TILES;
  const moistureScale = 1 / MOISTURE_FEATURE_SIZE_TILES;

  for (let y = 0; y < height; y++) {
    // Latitude: 0 at the top/bottom edges, 1 at the equator row.
    const latitude = 1 - Math.abs(2 * y / (height - 1) - 1);
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const elevation = fbm2D(elevationSeed, x * elevationScale, y * elevationScale, ELEVATION_OCTAVES, ELEVATION_LACUNARITY, ELEVATION_GAIN);
      const moisture = fbm2D(moistureSeed, x * moistureScale, y * moistureScale, MOISTURE_OCTAVES, ELEVATION_LACUNARITY, ELEVATION_GAIN);
      const terrainType = terrainForElevation(elevation);
      terrain[index] = terrainType;

      const temperatureNoise = (fbm2D(temperatureSeed, x * elevationScale, y * elevationScale, 2, ELEVATION_LACUNARITY, ELEVATION_GAIN) - 0.5) * 2 * TEMPERATURE_NOISE_AMPLITUDE_C;
      const altitudeDrop = ((elevation - SEA_LEVEL) / (1 - SEA_LEVEL)) * ALTITUDE_TEMPERATURE_DROP_C;
      temperature[index] = EQUATOR_TEMPERATURE_C - POLAR_TEMPERATURE_DROP_C * (1 - latitude) - altitudeDrop + temperatureNoise;

      if (terrainType === TerrainType.Water) {
        water[index] = 1;
        food[index] = 0;
      } else {
        water[index] = moisture;
        const foodProfile = FOOD_BY_TERRAIN[terrainType];
        food[index] = foodProfile.base + foodProfile.moistureWeight * moisture;
      }
    }
  }

  return new World({ width, height, terrain, food, water, temperature });
}

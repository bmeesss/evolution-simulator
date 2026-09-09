/**
 * The tile world: a fixed-size grid where every tile carries terrain type,
 * food amount, fresh-water availability, temperature, and the regeneration
 * capacity for food and water.
 *
 * All arrays are indexed by `y * width + x`. Food/water are normalized to
 * [0, 1]; temperature is in degrees Celsius. `foodCap`/`waterCap` record the
 * per-tile maximum that food/water regenerate toward (phase 2: simple
 * deterministic regrowth — no seasons or climate yet). Food/water mutate as
 * agents consume them and regrow, which is why they live in typed arrays that
 * can be snapshotted and saved.
 */

/**
 * World size. Mutable fields on purpose: this doubles as the world section of
 * SimulationConfig, which tests and callers adjust before creating simulations.
 */
export interface WorldDimensions {
  width: number;
  height: number;
}

export interface WorldArrays extends WorldDimensions {
  readonly terrain: Uint8Array;
  readonly food: Float32Array;
  readonly water: Float32Array;
  readonly temperature: Float32Array;
  /** Per-tile maximum food (regeneration target), normalized [0, 1]. */
  readonly foodCap: Float32Array;
  /** Per-tile maximum water (regeneration target), normalized [0, 1]. */
  readonly waterCap: Float32Array;
}

export interface SerializedWorld {
  width: number;
  height: number;
  terrain: number[];
  food: number[];
  water: number[];
  temperature: number[];
  foodCap: number[];
  waterCap: number[];
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly terrain: Uint8Array;
  readonly food: Float32Array;
  readonly water: Float32Array;
  readonly temperature: Float32Array;
  readonly foodCap: Float32Array;
  readonly waterCap: Float32Array;

  constructor(arrays: WorldArrays) {
    const size = arrays.width * arrays.height;
    if (
      arrays.width < 1 ||
      arrays.height < 1 ||
      arrays.terrain.length !== size ||
      arrays.food.length !== size ||
      arrays.water.length !== size ||
      arrays.temperature.length !== size ||
      arrays.foodCap.length !== size ||
      arrays.waterCap.length !== size
    ) {
      throw new Error('World: array lengths do not match dimensions');
    }
    this.width = arrays.width;
    this.height = arrays.height;
    this.terrain = arrays.terrain;
    this.food = arrays.food;
    this.water = arrays.water;
    this.temperature = arrays.temperature;
    this.foodCap = arrays.foodCap;
    this.waterCap = arrays.waterCap;
  }

  get size(): number {
    return this.width * this.height;
  }

  /** Flat index of a tile. Callers must ensure 0 <= x < width, 0 <= y < height. */
  tileIndex(x: number, y: number): number {
    return y * this.width + x;
  }

  serialize(): SerializedWorld {
    return {
      width: this.width,
      height: this.height,
      terrain: Array.from(this.terrain),
      food: Array.from(this.food),
      water: Array.from(this.water),
      temperature: Array.from(this.temperature),
      foodCap: Array.from(this.foodCap),
      waterCap: Array.from(this.waterCap),
    };
  }

  static fromArrays(saved: SerializedWorld): World {
    return new World({
      width: saved.width,
      height: saved.height,
      terrain: Uint8Array.from(saved.terrain),
      food: Float32Array.from(saved.food),
      water: Float32Array.from(saved.water),
      temperature: Float32Array.from(saved.temperature),
      foodCap: Float32Array.from(saved.foodCap),
      waterCap: Float32Array.from(saved.waterCap),
    });
  }
}

/**
 * ResourceIndex — a world-grid spatial lookup for food and water.
 *
 * WHY: agents must find nearby resources every tick, and the naive approach
 * (every agent × every world tile, every tick) is O(population × worldSize) —
 * the exact quadratic cost Phase 2 must avoid. This index is rebuilt ONCE per
 * tick in O(worldSize), then each agent walks only the ~3×3 grid cells around
 * its own cell, which is O(agents × localTiles).
 *
 * Layout: the world is divided into square cells of `cellSize` tiles
 * (cellSize = perception radius, so any tile within perception lies in the
 * agent's own cell or an adjacent one). Each resource type keeps a linked list
 * of qualifying tile indices per cell (`head[cell]` → `next[tile]` → …). All
 * buffers are allocated once and reused every tick — the rebuild writes into
 * the same arrays, so there is zero per-tick allocation.
 *
 * The index stores ONLY data and small accessor helpers. The AI
 * (`utility-ai.ts`) walks the chains and scores candidates itself, so the hot
 * loop allocates nothing. `best` is a reused scratch the AI writes its query
 * result into (consume it before the next query).
 *
 * Determinism: the rebuild is fixed row-major order and chains grow by
 * prepending, so candidate iteration order is deterministic and independent
 * of population.
 */

import type { World } from '../../world';

export interface ResourceCandidate {
  tileIndex: number;
  x: number;
  y: number;
  /** Scored quality+reachability of this candidate (reused scratch field). */
  score: number;
}

export class ResourceIndex {
  private readonly width: number;
  private readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;

  /** cell -> first food tile index, or -1. */
  readonly foodHead: Int32Array;
  /** tile -> next food tile in the same cell's chain, or -1. */
  readonly foodNext: Int32Array;
  /** cell -> first water tile index, or -1. */
  readonly waterHead: Int32Array;
  /** tile -> next water tile in the same cell's chain, or -1. */
  readonly waterNext: Int32Array;

  /** Reused query-result scratch (do not retain across queries). */
  readonly best: ResourceCandidate = { tileIndex: -1, x: 0, y: 0, score: -1 };

  constructor(width: number, height: number, cellSize: number) {
    this.width = width;
    this.cellSize = Math.max(1, cellSize);
    this.cols = Math.max(1, Math.ceil(width / this.cellSize));
    this.rows = Math.max(1, Math.ceil(height / this.cellSize));
    const cellCount = this.cols * this.rows;
    const tileCount = width * height;
    this.foodHead = new Int32Array(cellCount).fill(-1);
    this.foodNext = new Int32Array(tileCount).fill(-1);
    this.waterHead = new Int32Array(cellCount).fill(-1);
    this.waterNext = new Int32Array(tileCount).fill(-1);
  }

  /** Cell column for a tile coordinate (clamped to the grid). */
  cellCol(x: number): number {
    const col = Math.floor(x / this.cellSize);
    return col < 0 ? 0 : col >= this.cols ? this.cols - 1 : col;
  }

  /** Cell row for a tile coordinate (clamped to the grid). */
  cellRow(y: number): number {
    const row = Math.floor(y / this.cellSize);
    return row < 0 ? 0 : row >= this.rows ? this.rows - 1 : row;
  }

  cellIndex(col: number, row: number): number {
    return row * this.cols + col;
  }

  /** Tile X from a flat tile index (world-width aware). */
  tileX(idx: number): number {
    return idx - Math.floor(idx / this.width) * this.width;
  }

  /** Tile Y from a flat tile index. */
  tileY(idx: number): number {
    return Math.floor(idx / this.width);
  }

  /**
   * Rebuild the food/water chains from the current world state. Called once per
   * tick, before any query. A tile qualifies for food when `food >= minFood`
   * (water terrain never has food, so no terrain check is needed); for water
   * when `water >= minWater`.
   */
  rebuild(world: World, minFood: number, minWater: number): void {
    this.foodHead.fill(-1);
    this.waterHead.fill(-1);
    const { width, height } = world;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const cell = this.cellIndex(this.cellCol(x), this.cellRow(y));
        if (world.food[idx] >= minFood) {
          this.foodNext[idx] = this.foodHead[cell];
          this.foodHead[cell] = idx;
        }
        if (world.water[idx] >= minWater) {
          this.waterNext[idx] = this.waterHead[cell];
          this.waterHead[cell] = idx;
        }
      }
    }
  }
}

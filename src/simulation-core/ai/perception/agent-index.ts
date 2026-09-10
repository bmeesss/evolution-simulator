/**
 * AgentIndex — a world-grid spatial lookup for agent entities.
 *
 * WHY: partners must be found without O(n²) pairwise scanning. This index is
 * rebuilt ONCE per tick in O(population), then each seeker walks only the ~3×3
 * grid cells around its own cell (cell size = partner-seek radius), i.e.
 * O(agents × localAgents). The resource index solves the same problem for
 * food/water; this one is the analogous structure for entities.
 *
 * Layout: the world is divided into square cells of `cellSize` tiles. Each cell
 * keeps a linked list of the entity ids currently occupying it
 * (`head[cell]` -> `next[entity]` -> ...). All buffers are pre-allocated and
 * reused each tick; `next` grows on demand with the entity-id space (entities
 * are never reused, so stale entries for dead ids are simply unreachable and
 * harmless).
 *
 * Determinism: the rebuild iterates the entity registry's dense alive list in
 * allocation order and prepends, so chains (and therefore candidate iteration
 * order) are deterministic and independent of population churn between the
 * rebuild and the queries.
 */

import type { SimulationEcs } from '../../ecs';
import type { EntityId } from '../../ecs';

const MIN_INDEX_CAPACITY = 64;
const MIN_CELLS = 1;

export class AgentIndex {
  private readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;

  /** cell -> first entity id in that cell's chain, or -1. */
  readonly head: Int32Array;
  /** entity id -> next entity id in the same cell's chain, or -1. */
  private next: Int32Array;

  constructor(width: number, height: number, cellSize: number) {
    this.cellSize = Math.max(1, cellSize);
    this.cols = Math.max(MIN_CELLS, Math.ceil(width / this.cellSize));
    this.rows = Math.max(MIN_CELLS, Math.ceil(height / this.cellSize));
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
    this.next = new Int32Array(MIN_INDEX_CAPACITY).fill(-1);
  }

  cellCol(x: number): number {
    const col = Math.floor(x / this.cellSize);
    return col < 0 ? 0 : col >= this.cols ? this.cols - 1 : col;
  }

  cellRow(y: number): number {
    const row = Math.floor(y / this.cellSize);
    return row < 0 ? 0 : row >= this.rows ? this.rows - 1 : row;
  }

  cellIndex(col: number, row: number): number {
    return row * this.cols + col;
  }

  headOf(cell: number): number {
    return cell >= 0 && cell < this.head.length ? this.head[cell] : -1;
  }

  nextOf(entity: EntityId): number {
    return entity >= 0 && entity < this.next.length ? this.next[entity] : -1;
  }

  /** Rebuild all chains from the live entity set. O(population), zero allocation. */
  rebuild(ecs: SimulationEcs): void {
    this.head.fill(-1);
    const position = ecs.position;
    for (let i = 0; i < ecs.entities.aliveCount; i++) {
      const entity = ecs.entities.aliveIds[i];
      const slot = position.index[entity];
      if (slot < 0) continue;
      const x = position.columns.x[slot];
      const y = position.columns.y[slot];
      this.ensureCapacity(entity);
      const cell = this.cellIndex(this.cellCol(x), this.cellRow(y));
      this.next[entity] = this.head[cell];
      this.head[cell] = entity;
    }
  }

  private ensureCapacity(entity: EntityId): void {
    if (entity < this.next.length) return;
    let capacity = this.next.length;
    while (capacity <= entity) capacity *= 2;
    const next = new Int32Array(capacity).fill(-1);
    next.set(this.next);
    this.next = next;
  }
}

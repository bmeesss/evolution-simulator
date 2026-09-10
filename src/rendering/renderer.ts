/**
 * Canvas 2D renderer for the world and its agents.
 *
 * Performance approach: the world (terrain + food tint) is static in phase 1,
 * so it is baked ONCE into an offscreen 1-pixel-per-tile canvas and blitted
 * scaled (smoothing disabled) every frame. Per frame, only agents are drawn —
 * no per-agent DOM, no world re-rasterization. This stays fast for thousands
 * of agents and leaves room for a dirty-terrain path later when food becomes
 * dynamic.
 */

import type { WorldInitPayload } from '../workers/protocol';
import type { AgentVisualSnapshot } from '../persistence';
import type { SimulationSnapshot } from '../persistence';
import { TerrainType } from '../simulation-core/world/terrain';
import {
  agentColor,
  agentRadiusTiles,
  intentIndicatorColor,
  speedRingWidthTiles,
  moveMarkerColor,
  isRestingIntent,
  RESTING_ALPHA,
  groupColor,
  conflictFlashColor,
  cooperationLinkColor,
  isSignalling,
  signalFlashRadiusTiles,
  signalTokenColor,
} from './agent-visuals';

// Terrain palette (RGB). Named per terrain type; food tints land tiles.
const TERRAIN_COLORS: Readonly<Record<number, readonly [number, number, number]>> = {
  [TerrainType.Water]: [43, 84, 122],
  [TerrainType.Sand]: [196, 175, 124],
  [TerrainType.Grass]: [88, 124, 63],
  [TerrainType.Forest]: [56, 94, 53],
  [TerrainType.Mountain]: [125, 125, 130],
};

/** Land tiles are lerped toward this color by their food amount. */
const FOOD_TINT: readonly [number, number, number] = [142, 200, 80];
/** How strongly food tints a tile (0 = invisible, 1 = full food color). */
const FOOD_TINT_STRENGTH = 0.45;

const SELECTION_RING_COLOR = '#ffffff';
const CANVAS_BACKGROUND = '#101418';

const AGENT_OUTLINE_COLOR = 'rgba(10, 12, 16, 0.55)';

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

export class WorldRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private terrainLayer: HTMLCanvasElement | null = null;
  private worldWidth = 0;
  private worldHeight = 0;
  /** Cached layout: tile size and offsets in CSS pixels (letterboxed). */
  private tileSize = 1;
  private offsetX = 0;
  private offsetY = 0;
  private cssWidth = 0;
  private cssHeight = 0;
  /** Per-snapshot entity-id -> index cache (rebuilt only on new snapshots). */
  private mapForAgents: AgentVisualSnapshot | null = null;
  private agentMap = new Map<number, number>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
  }

  /** Set (or replace) the static world; bakes the terrain layer. */
  setWorld(world: WorldInitPayload): void {
    this.worldWidth = world.width;
    this.worldHeight = world.height;
    this.terrainLayer = this.bakeTerrainLayer(world);
    // Force layout recomputation on the next render (dimensions may differ).
    this.cssWidth = 0;
    this.cssHeight = 0;
  }

  private bakeTerrainLayer(world: WorldInitPayload): HTMLCanvasElement {
    const layer = document.createElement('canvas');
    layer.width = world.width;
    layer.height = world.height;
    const layerCtx = layer.getContext('2d');
    if (!layerCtx) throw new Error('Offscreen canvas 2D context unavailable');
    const image = layerCtx.createImageData(world.width, world.height);
    const pixels = image.data;
    for (let i = 0; i < world.width * world.height; i++) {
      const base = TERRAIN_COLORS[world.terrain[i]] ?? TERRAIN_COLORS[TerrainType.Grass];
      let [r, g, b] = base;
      const food = world.food[i];
      if (world.terrain[i] !== TerrainType.Water && food > 0) {
        // Food indication: lerp the terrain color toward the food color.
        const t = Math.min(1, food) * FOOD_TINT_STRENGTH;
        r = r + (FOOD_TINT[0] - r) * t;
        g = g + (FOOD_TINT[1] - g) * t;
        b = b + (FOOD_TINT[2] - b) * t;
      }
      const pixel = i * 4;
      pixels[pixel] = r;
      pixels[pixel + 1] = g;
      pixels[pixel + 2] = b;
      pixels[pixel + 3] = 255;
    }
    layerCtx.putImageData(image, 0, 0);
    return layer;
  }

  /** Render one frame from the latest snapshot. */
  render(snapshot: SimulationSnapshot | null, selectedEntityId: number | null): void {
    const ctx = this.ctx;
    this.syncCanvasSize();
    const width = this.cssWidth;
    const height = this.cssHeight;
    if (width === 0 || height === 0) return;

    ctx.fillStyle = CANVAS_BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    if (!this.terrainLayer) return;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.terrainLayer,
      this.offsetX,
      this.offsetY,
      this.worldWidth * this.tileSize,
      this.worldHeight * this.tileSize,
    );

    if (!snapshot) return;
    this.drawGroupTerritories(snapshot);
    this.drawCooperationLinks(snapshot.agents);
    this.drawAgents(snapshot.agents, selectedEntityId);
  }

  /**
   * Approximate group territories: a faint filled circle + dashed outline at
   * each group's activity center. Informational (Phase 4 keeps territory
   * passive — no warfare), but it makes emergent communities visible at a
   * glance. Cheap: at most a couple dozen circles per frame.
   */
  private drawGroupTerritories(snapshot: SimulationSnapshot): void {
    const ctx = this.ctx;
    const tile = this.tileSize;
    for (const group of snapshot.groups.list) {
      if (group.radius <= 0 || group.memberCount < 2) continue;
      const color = groupColor(group.id);
      const x = this.offsetX + group.centerX * tile;
      const y = this.offsetY + group.centerY * tile;
      const radius = Math.max(tile, group.radius * tile);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.05;
      ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Cooperation bonds: a thin line from each cooperating agent to its session
   * partner. Each pair is drawn once (only from the lower entity id).
   */
  private drawCooperationLinks(agents: AgentVisualSnapshot): void {
    const ctx = this.ctx;
    const tile = this.tileSize;
    const map = this.agentIndexMap(agents);
    for (let i = 0; i < agents.ids.length; i++) {
      const target = agents.cooperationTarget[i];
      if (target < 0) continue;
      if (agents.ids[i] > target) continue; // draw each pair once
      const j = map.get(target);
      if (j === undefined) continue; // partner left/died since the snapshot
      const x1 = this.offsetX + agents.x[i] * tile;
      const y1 = this.offsetY + agents.y[i] * tile;
      const x2 = this.offsetX + agents.x[j] * tile;
      const y2 = this.offsetY + agents.y[j] * tile;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = cooperationLinkColor();
      ctx.stroke();
    }
  }

  /** entity id -> snapshot index, rebuilt only when the snapshot changes. */
  private agentIndexMap(agents: AgentVisualSnapshot): Map<number, number> {
    if (this.mapForAgents !== agents) {
      const map = new Map<number, number>();
      for (let i = 0; i < agents.ids.length; i++) map.set(agents.ids[i], i);
      this.mapForAgents = agents;
      this.agentMap = map;
    }
    return this.agentMap;
  }

  private drawAgents(agents: AgentVisualSnapshot, selectedEntityId: number | null): void {
    const ctx = this.ctx;
    const tile = this.tileSize;
    for (let i = 0; i < agents.ids.length; i++) {
      const x = this.offsetX + agents.x[i] * tile;
      const y = this.offsetY + agents.y[i] * tile;
      const radius = agentRadiusTiles(agents.strength[i]) * tile;
      if (x < -radius || y < -radius || x > this.cssWidth + radius || y > this.cssHeight + radius) {
        continue; // cheap culling; a full camera/viewport system can come later
      }
      const kind = agents.intentKind[i];

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = agentColor(agents.intelligence[i]);
      ctx.globalAlpha = isRestingIntent(kind) ? RESTING_ALPHA : 1;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = AGENT_OUTLINE_COLOR;
      ctx.stroke();

      // Speed ring: a thin inner ring whose width encodes the `speed` genome
      // (a wider ring = faster agent). Drawn just inside the body so it never
      // overlaps the intent indicator outside it.
      const speedWidth = speedRingWidthTiles(agents.speed[i]) * tile;
      if (speedWidth > 0) {
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, radius - speedWidth - 1), 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1, speedWidth);
        ctx.strokeStyle = AGENT_OUTLINE_COLOR;
        ctx.stroke();
      }

      // Intent ring for a concrete interaction (eat green / drink blue /
      // seek-partner pink / social teal / help light-green / cooperate violet /
      // avoid gray / confront red) drawn just outside the body.
      const ringColor = intentIndicatorColor(kind);
      if (ringColor !== null) {
        ctx.beginPath();
        ctx.arc(x, y, radius + Math.max(1, tile * 0.16), 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = ringColor;
        ctx.stroke();
      }

      // A small dot for an actively-wandering agent (exploring), so movement
      // intention is visible without cluttering the body.
      const moveColor = moveMarkerColor(kind);
      if (moveColor !== null) {
        ctx.beginPath();
        ctx.arc(x + radius + Math.max(1, tile * 0.16), y - radius - Math.max(1, tile * 0.16), Math.max(1, tile * 0.06), 0, Math.PI * 2);
        ctx.fillStyle = moveColor;
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Phase 4: group affiliation — a thin dashed outer ring in the group's
      // deterministic color.
      const groupId = agents.groupId[i];
      if (groupId >= 0) {
        ctx.beginPath();
        ctx.arc(x, y, radius + Math.max(2, tile * 0.34), 0, Math.PI * 2);
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = groupColor(groupId);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Phase 4: recent conflict — a soft red halo that fades with the
      // conflict-flash window.
      if (agents.conflictFlash[i] === 1) {
        const flash = conflictFlashColor();
        if (flash !== null) {
          ctx.beginPath();
          ctx.arc(x, y, radius + Math.max(3, tile * 0.5), 0, Math.PI * 2);
          ctx.fillStyle = flash;
          ctx.fill();
        }
      }

      // Phase 5: a signal flash — a small dot offset above the agent, coloured
      // by token. Shows proto-communication happening without implying any
      // permanent meaning (the inspector shows what the agent has learned).
      if (isSignalling(agents.signalToken[i], agents.signalRecent[i])) {
        ctx.beginPath();
        ctx.arc(x, y - radius - tile * 0.35, Math.max(2, tile * signalFlashRadiusTiles()), 0, Math.PI * 2);
        ctx.fillStyle = signalTokenColor(agents.signalToken[i]);
        ctx.fill();
      }

      if (agents.ids[i] === selectedEntityId) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 3, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = SELECTION_RING_COLOR;
        ctx.stroke();
      }
    }
  }

  /** Keep the canvas backing store in sync with its CSS size (DPR aware). */
  private syncCanvasSize(): void {
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cssWidth !== this.cssWidth || cssHeight !== this.cssHeight) {
      this.cssWidth = cssWidth;
      this.cssHeight = cssHeight;
      this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
      this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
      if (this.worldWidth > 0 && this.worldHeight > 0) {
        this.tileSize = Math.min(cssWidth / this.worldWidth, cssHeight / this.worldHeight);
        this.offsetX = (cssWidth - this.worldWidth * this.tileSize) / 2;
        this.offsetY = (cssHeight - this.worldHeight * this.tileSize) / 2;
      }
    }
    const dprNow = dpr;
    this.ctx.setTransform(dprNow, 0, 0, dprNow, 0, 0);
  }

  /** Convert canvas-relative CSS pixels to world tile coordinates. */
  screenToWorld(cssX: number, cssY: number): WorldPoint {
    return {
      x: (cssX - this.offsetX) / this.tileSize,
      y: (cssY - this.offsetY) / this.tileSize,
    };
  }
}

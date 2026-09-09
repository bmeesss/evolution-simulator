/**
 * History graph: a compact multi-line canvas chart of key simulation trends.
 *
 * Plots (normalized to [0, 1], each series scaled to its own documented range
 * so a single small chart stays readable):
 *   - population  (÷ initial population)
 *   - deaths      (÷ initial population)
 *   - avg health  (÷ 100)
 *   - food avail. (already 0..1)
 *   - water avail.(already 0..1)
 *
 * History is a bounded ring (last N points) kept on the main thread; this
 * module only consumes snapshots — it never touches simulation objects. The
 * canvas is re-drawn on demand, not every render frame.
 */

import { requireElement } from './dom';
import type { SimulationSnapshot } from '../persistence';

/** Number of data points retained per series. */
const MAX_POINTS = 400;

const SERIES = [
  { key: 'population', label: 'Population', color: '#e0b050', max: 1 },
  { key: 'deaths', label: 'Deaths', color: '#e2606b', max: 1 },
  { key: 'health', label: 'Avg health', color: '#5dd39e', max: 1 },
  { key: 'fertility', label: 'Avg fertility', color: '#c88be0', max: 1 },
  { key: 'social', label: 'Avg social', color: '#d99b6b', max: 1 },
  { key: 'food', label: 'Food avail.', color: '#8ecf50', max: 1 },
  { key: 'water', label: 'Water avail.', color: '#6ab7e0', max: 1 },
] as const;

type SeriesKey = (typeof SERIES)[number]['key'];

const BACKGROUND = '#101418';
const GRID = '#26303b';

export class HistoryGraph {
  private readonly canvas = requireElement<HTMLCanvasElement>('history-graph');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly series: Record<SeriesKey, number[]> = {
    population: [],
    deaths: [],
    health: [],
    fertility: [],
    social: [],
    food: [],
    water: [],
  };
  private initialPopulation = 1;

  constructor() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    const legend = requireElement<HTMLUListElement>('history-legend');
    for (const s of SERIES) {
      const item = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'history-swatch';
      swatch.style.backgroundColor = s.color;
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(s.label));
      legend.appendChild(item);
    }
  }

  /** Record one snapshot and repaint. */
  push(snapshot: SimulationSnapshot): void {
    this.initialPopulation = Math.max(1, snapshot.population + snapshot.deaths, this.initialPopulation);
    const values: Record<SeriesKey, number> = {
      population: Math.min(1, snapshot.population / this.initialPopulation),
      deaths: Math.min(1, snapshot.deaths / this.initialPopulation),
      health: Math.min(1, snapshot.averages.health / 100),
      fertility: Math.min(1, snapshot.averages.fertility),
      social: Math.min(1, snapshot.averages.socialTendency),
      food: Math.min(1, snapshot.resources.food),
      water: Math.min(1, snapshot.resources.water),
    };
    for (const s of SERIES) {
      const data = this.series[s.key];
      data.push(values[s.key]);
      if (data.length > MAX_POINTS) data.shift();
    }
    this.draw();
  }

  clear(): void {
    for (const s of SERIES) this.series[s.key] = [];
    this.initialPopulation = 1;
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);

    // Grid lines.
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const count = this.series.population.length;
    if (count < 2) return;

    for (const s of SERIES) {
      const data = this.series[s.key];
      if (data.length < 2) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = (i / (count - 1)) * width;
        const y = height - data[i] * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
}

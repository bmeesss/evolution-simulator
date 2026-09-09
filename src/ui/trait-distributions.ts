/**
 * Trait distributions panel: lightweight histograms of the current population's
 * genome traits. Each trait is drawn as a row of vertical bars (one per bin)
 * whose heights reflect the fraction of agents in that value band. This lets a
 * player see whether a trait's distribution shifts over generations without
 * hiding the underlying data — the bars are drawn straight from the snapshot's
 * per-bin counts, never smoothed or rescaled beyond normalizing to the max bin.
 */

import { requireElement } from './dom';
import type { SimulationSnapshot } from '../persistence';
import { TRAIT_DISTRIBUTION_BINS } from '../persistence';

/** Max number of bar-cells we render per trait (only a handful of traits). */
const TRAITS: ReadonlyArray<{ key: keyof SimulationSnapshot['distributions']; label: string }> = [
  { key: 'intelligence', label: 'Intelligence' },
  { key: 'strength', label: 'Strength' },
  { key: 'speed', label: 'Speed' },
  { key: 'fertility', label: 'Fertility' },
];

export class TraitDistributionsPanel {
  private readonly container = requireElement<HTMLElement>('trait-distributions');
  private cachedPopulation = -1;

  update(snapshot: SimulationSnapshot): void {
    // Redraw only when the population changed (histograms are counts, so this
    // avoids needless DOM churn every snapshot at a steady population).
    if (snapshot.population === this.cachedPopulation) return;
    this.cachedPopulation = snapshot.population;

    const rows = TRAITS.map((trait) => this.buildRow(trait.label, snapshot.distributions[trait.key]));
    this.container.replaceChildren(...rows);
  }

  clear(): void {
    this.cachedPopulation = -1;
    this.container.replaceChildren();
  }

  private buildRow(label: string, bins: readonly number[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'trait-row';

    const title = document.createElement('span');
    title.className = 'trait-label';
    title.textContent = label;
    row.appendChild(title);

    const chart = document.createElement('div');
    chart.className = 'trait-chart';
    const maxBin = Math.max(1, ...bins);
    for (let i = 0; i < TRAIT_DISTRIBUTION_BINS; i++) {
      const cell = document.createElement('span');
      cell.className = 'trait-bar';
      const fraction = bins[i] / maxBin;
      cell.style.height = `${Math.max(2, Math.round(fraction * 100))}%`;
      if (bins[i] === 0) cell.classList.add('empty');
      cell.title = `${((i + 0.5) / TRAIT_DISTRIBUTION_BINS).toFixed(2)} — ${bins[i]}`;
      chart.appendChild(cell);
    }
    row.appendChild(chart);
    return row;
  }
}

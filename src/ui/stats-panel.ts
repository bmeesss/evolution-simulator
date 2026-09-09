/**
 * Statistics panel: tick, in-game time, population and genome averages.
 * Consumes snapshot data only.
 */

import { requireElement } from './dom';
import { formatTimeHours } from '../simulation-core/simulation/time';
import type { SimulationSnapshot } from '../persistence';

/** Formatting precision for genome averages (traits are normalized 0..1). */
const AVERAGE_DECIMALS = 3;

export class StatsPanel {
  update(snapshot: SimulationSnapshot): void {
    requireElement('stat-tick').textContent = String(snapshot.tick);
    requireElement('stat-time').textContent = formatTimeHours(snapshot.timeHours);
    requireElement('stat-population').textContent = String(snapshot.population);
    requireElement('stat-avg-intelligence').textContent = snapshot.averages.intelligence.toFixed(AVERAGE_DECIMALS);
    requireElement('stat-avg-strength').textContent = snapshot.averages.strength.toFixed(AVERAGE_DECIMALS);
    requireElement('stat-avg-speed').textContent = snapshot.averages.speed.toFixed(AVERAGE_DECIMALS);
  }

  clear(): void {
    requireElement('stat-tick').textContent = '—';
    requireElement('stat-time').textContent = '—';
    requireElement('stat-population').textContent = '—';
    requireElement('stat-avg-intelligence').textContent = '—';
    requireElement('stat-avg-strength').textContent = '—';
    requireElement('stat-avg-speed').textContent = '—';
  }
}

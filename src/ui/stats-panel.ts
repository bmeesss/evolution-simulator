/**
 * Statistics panel: tick, in-game time, population, deaths, resource
 * availability and average needs/genome traits. Consumes snapshot data only.
 */

import { requireElement } from './dom';
import { formatTimeHours } from '../simulation-core/simulation/time';
import type { SimulationSnapshot } from '../persistence';

/** Formatting precision for genome averages (traits are normalized 0..1). */
const AVERAGE_DECIMALS = 3;
/** Formatting precision for needs averages (0..100 scale). */
const NEED_DECIMALS = 1;
/** Formatting precision for resource availability (0..1). */
const RESOURCE_DECIMALS = 2;

export class StatsPanel {
  update(snapshot: SimulationSnapshot): void {
    requireElement('stat-tick').textContent = String(snapshot.tick);
    requireElement('stat-time').textContent = formatTimeHours(snapshot.timeHours);
    requireElement('stat-population').textContent = String(snapshot.population);
    requireElement('stat-births').textContent = String(snapshot.births);
    requireElement('stat-deaths').textContent = String(snapshot.deaths);
    requireElement('stat-max-generation').textContent = String(snapshot.maxGeneration);
    requireElement('stat-avg-hunger').textContent = snapshot.averages.hunger.toFixed(NEED_DECIMALS);
    requireElement('stat-avg-thirst').textContent = snapshot.averages.thirst.toFixed(NEED_DECIMALS);
    requireElement('stat-avg-energy').textContent = snapshot.averages.energy.toFixed(NEED_DECIMALS);
    requireElement('stat-avg-health').textContent = snapshot.averages.health.toFixed(NEED_DECIMALS);
    requireElement('stat-avg-intelligence').textContent = snapshot.averages.intelligence.toFixed(AVERAGE_DECIMALS);
    requireElement('stat-avg-strength').textContent = snapshot.averages.strength.toFixed(AVERAGE_DECIMALS);
    requireElement('stat-avg-speed').textContent = snapshot.averages.speed.toFixed(AVERAGE_DECIMALS);
    requireElement('stat-avg-fertility').textContent = snapshot.averages.fertility.toFixed(AVERAGE_DECIMALS);
    requireElement('stat-avg-social-tendency').textContent = snapshot.averages.socialTendency.toFixed(AVERAGE_DECIMALS);
    requireElement('stat-food').textContent = snapshot.resources.food.toFixed(RESOURCE_DECIMALS);
    requireElement('stat-water').textContent = snapshot.resources.water.toFixed(RESOURCE_DECIMALS);
  }

  clear(): void {
    requireElement('stat-tick').textContent = '—';
    requireElement('stat-time').textContent = '—';
    requireElement('stat-population').textContent = '—';
    requireElement('stat-births').textContent = '—';
    requireElement('stat-deaths').textContent = '—';
    requireElement('stat-max-generation').textContent = '—';
    requireElement('stat-avg-hunger').textContent = '—';
    requireElement('stat-avg-thirst').textContent = '—';
    requireElement('stat-avg-energy').textContent = '—';
    requireElement('stat-avg-health').textContent = '—';
    requireElement('stat-avg-intelligence').textContent = '—';
    requireElement('stat-avg-strength').textContent = '—';
    requireElement('stat-avg-speed').textContent = '—';
    requireElement('stat-avg-fertility').textContent = '—';
    requireElement('stat-avg-social-tendency').textContent = '—';
    requireElement('stat-food').textContent = '—';
    requireElement('stat-water').textContent = '—';
  }
}

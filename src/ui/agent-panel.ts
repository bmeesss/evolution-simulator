/**
 * Selected-agent panel: full per-agent inspection data, requested on demand
 * from the worker (keeps per-frame snapshots small).
 */

import { requireElement } from './dom';
import type { AgentDetails } from '../persistence';
import { HOURS_PER_DAY } from '../simulation-core/simulation/time';

/** Formatting precision: needs are on a 0..100 scale, genome traits on 0..1. */
const NEED_DECIMALS = 1;
const GENOME_DECIMALS = 3;

function formatAge(hours: number): string {
  const days = Math.floor(hours / HOURS_PER_DAY);
  return `${hours.toFixed(NEED_DECIMALS)} h (day ${days + 1})`;
}

export class AgentPanel {
  private readonly title = requireElement('agent-panel-title');
  private readonly body = requireElement('agent-panel-body');

  showAgent(agent: AgentDetails): void {
    this.title.textContent = `Agent #${agent.entityId}`;
    this.setField('agent-x', agent.x.toFixed(2));
    this.setField('agent-y', agent.y.toFixed(2));
    this.setField('agent-intent', agent.intent);
    this.setField('agent-age', formatAge(agent.ageHours));
    this.setField('agent-health', agent.health.toFixed(NEED_DECIMALS));
    this.setField('agent-hunger', agent.hunger.toFixed(NEED_DECIMALS));
    this.setField('agent-thirst', agent.thirst.toFixed(NEED_DECIMALS));
    this.setField('agent-energy', agent.energy.toFixed(NEED_DECIMALS));
    this.setField('agent-intelligence', agent.intelligence.toFixed(GENOME_DECIMALS));
    this.setField('agent-strength', agent.strength.toFixed(GENOME_DECIMALS));
    this.setField('agent-speed', agent.speed.toFixed(GENOME_DECIMALS));
    this.setField('agent-fertility', agent.fertility.toFixed(GENOME_DECIMALS));
    this.setField('agent-social-tendency', agent.socialTendency.toFixed(GENOME_DECIMALS));
    this.body.classList.remove('hidden');
  }

  /** Shown when a selected entity no longer exists. */
  showMissing(entityId: number): void {
    this.title.textContent = `Agent #${entityId}`;
    this.body.classList.add('hidden');
    requireElement('agent-panel-missing').textContent = `Agent #${entityId} no longer exists.`;
  }

  clear(): void {
    this.title.textContent = 'No agent selected';
    this.body.classList.add('hidden');
    requireElement('agent-panel-missing').textContent = 'Click an agent to inspect it.';
  }

  private setField(id: string, value: string): void {
    requireElement(id).textContent = value;
  }
}

/**
 * Selected-agent panel: full per-agent inspection data, requested on demand
 * from the worker (keeps per-frame snapshots small). Shows needs, genome, the
 * current intent/target, remembered food & water locations, and — for AI
 * debugging — the per-action utility table.
 */

import { requireElement } from './dom';
import type { AgentDetails, AgentMemoryEntryDetails } from '../persistence';
import { HOURS_PER_DAY } from '../simulation-core/simulation/time';

/** Formatting precision: needs are on a 0..100 scale, genome traits on 0..1. */
const NEED_DECIMALS = 1;
const GENOME_DECIMALS = 3;

function formatAge(hours: number): string {
  const days = Math.floor(hours / HOURS_PER_DAY);
  return `${hours.toFixed(NEED_DECIMALS)} h (day ${days + 1})`;
}

function formatMemoryEntry(entry: AgentMemoryEntryDetails): string {
  return `(${entry.x}, ${entry.y}) · ${(entry.value * 100).toFixed(0)}% · t${entry.lastObservedTick}`;
}

export class AgentPanel {
  private readonly title = requireElement('agent-panel-title');
  private readonly body = requireElement('agent-panel-body');
  private readonly aiBlock = requireElement('agent-ai-block');
  private readonly aiTableBody = requireElement<HTMLTableSectionElement>('agent-ai-table').querySelector('tbody')!;
  private readonly memoryBlock = requireElement('agent-memory-block');
  private readonly memoryFood = requireElement<HTMLUListElement>('agent-memory-food');
  private readonly memoryWater = requireElement<HTMLUListElement>('agent-memory-water');

  showAgent(agent: AgentDetails): void {
    this.title.textContent = `Agent #${agent.entityId}`;
    this.setField('agent-x', agent.x.toFixed(2));
    this.setField('agent-y', agent.y.toFixed(2));
    this.setField('agent-intent', agent.intent);
    this.setField('agent-target-x', agent.targetX.toFixed(2));
    this.setField('agent-target-y', agent.targetY.toFixed(2));
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

    this.renderAiUtilities(agent);
    this.renderMemory(agent.memoryFood, this.memoryFood);
    this.renderMemory(agent.memoryWater, this.memoryWater);

    this.body.classList.remove('hidden');
    this.aiBlock.classList.remove('hidden');
    this.memoryBlock.classList.remove('hidden');
  }

  /** Shown when a selected entity no longer exists. */
  showMissing(entityId: number): void {
    this.title.textContent = `Agent #${entityId}`;
    this.body.classList.add('hidden');
    this.aiBlock.classList.add('hidden');
    this.memoryBlock.classList.add('hidden');
    requireElement('agent-panel-missing').textContent = `Agent #${entityId} no longer exists.`;
  }

  clear(): void {
    this.title.textContent = 'No agent selected';
    this.body.classList.add('hidden');
    this.aiBlock.classList.add('hidden');
    this.memoryBlock.classList.add('hidden');
    requireElement('agent-panel-missing').textContent = 'Click an agent to inspect it.';
  }

  private renderAiUtilities(agent: AgentDetails): void {
    this.aiTableBody.replaceChildren();
    for (const row of agent.aiUtilities) {
      const tr = document.createElement('tr');
      const actionCell = document.createElement('td');
      actionCell.textContent = row.action;
      const utilityCell = document.createElement('td');
      utilityCell.className = 'ai-utility';
      utilityCell.textContent = row.utility.toFixed(2);
      // A small inline bar makes relative magnitudes readable at a glance.
      const bar = document.createElement('div');
      bar.className = 'ai-utility-bar';
      bar.style.width = `${(row.utility * 100).toFixed(0)}%`;
      utilityCell.appendChild(bar);
      tr.appendChild(actionCell);
      tr.appendChild(utilityCell);
      this.aiTableBody.appendChild(tr);
    }
  }

  private renderMemory(entries: readonly AgentMemoryEntryDetails[], list: HTMLUListElement): void {
    list.replaceChildren();
    if (entries.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'none';
      list.appendChild(li);
      return;
    }
    for (const entry of entries) {
      const li = document.createElement('li');
      li.textContent = formatMemoryEntry(entry);
      list.appendChild(li);
    }
  }

  private setField(id: string, value: string): void {
    requireElement(id).textContent = value;
  }
}

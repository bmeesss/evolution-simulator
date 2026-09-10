/**
 * Selected-agent panel: full per-agent inspection data, requested on demand
 * from the worker (keeps per-frame snapshots small). Shows needs, genome, the
 * current intent/target, remembered food & water locations, the per-action
 * utility table (including the Phase 4 social actions and the Phase 5
 * teaching/signal actions), the agent's social life (group, loneliness,
 * cooperation state, top relationships) and its cultural life: what it knows,
 * where each item came from, which tokens it has learned to read and the
 * teach/signal cooldowns that gate further transmission.
 *
 * Note on terminology: the signal list shows LEARNED ASSOCIATIONS
 * ("Signal_04 → FOOD"), not a dictionary — this is proto-communication
 * scaffolding, and every meaning shown was acquired by this agent through
 * observation or teaching.
 */

import { requireElement } from './dom';
import type {
  AgentDetails,
  AgentKnowledgeDetails,
  AgentMemoryEntryDetails,
  AgentRelationshipDetails,
  AgentSignalDetails,
  GeneOrigin,
} from '../persistence';
import { HOURS_PER_DAY } from '../simulation-core/simulation/time';

/** Formatting precision: needs are on a 0..100 scale, genome traits on 0..1. */
const NEED_DECIMALS = 1;
const GENOME_DECIMALS = 3;
/** Formatting precision: relationship values (trust/familiarity 0..1, score −1..1). */
const SOCIAL_DECIMALS = 2;

function formatAge(hours: number): string {
  const days = Math.floor(hours / HOURS_PER_DAY);
  return `${hours.toFixed(NEED_DECIMALS)} h (day ${days + 1})`;
}

function formatMemoryEntry(entry: AgentMemoryEntryDetails): string {
  return `(${entry.x}, ${entry.y}) · ${(entry.value * 100).toFixed(0)}% · t${entry.lastObservedTick}`;
}

function formatKnowledge(entry: AgentKnowledgeDetails): string {
  const source = entry.sourceEntity >= 0 ? ` · from #${entry.sourceEntity}` : ' · own discovery';
  return `${entry.label} · ${entry.type} · ${(entry.strength * 100).toFixed(0)}% · ${entry.origin} · used ${entry.reinforceCount}×${source}`;
}

function formatSignal(entry: AgentSignalDetails): string {
  const known = entry.known ? 'known' : 'weak';
  return `${entry.token} → ${entry.meaning} · ${(entry.strength * 100).toFixed(0)}% (${known}) · seen ${entry.exposures}× · t${entry.lastUpdateTick}`;
}

function formatRelationship(entry: AgentRelationshipDetails): string {
  const score = `${entry.score >= 0 ? '+' : ''}${entry.score.toFixed(SOCIAL_DECIMALS)}`;
  const status = entry.alive ? '' : ' · deceased';
  return `#${entry.target} · rel ${score} · trust ${entry.trust.toFixed(SOCIAL_DECIMALS)} · fam ${entry.familiarity.toFixed(SOCIAL_DECIMALS)}${entry.kin ? ' · kin' : ''}${status}`;
}

export class AgentPanel {
  private readonly title = requireElement('agent-panel-title');
  private readonly body = requireElement('agent-panel-body');
  private readonly genomeBlock = requireElement('agent-genome-block');
  private readonly genomeOrigins = requireElement<HTMLUListElement>('agent-genome-origins');
  private readonly aiBlock = requireElement('agent-ai-block');
  private readonly aiTableBody = requireElement<HTMLTableSectionElement>('agent-ai-table').querySelector('tbody')!;
  private readonly memoryBlock = requireElement('agent-memory-block');
  private readonly memoryFood = requireElement<HTMLUListElement>('agent-memory-food');
  private readonly memoryWater = requireElement<HTMLUListElement>('agent-memory-water');
  private readonly socialBlock = requireElement('agent-social-block');
  private readonly relationships = requireElement<HTMLUListElement>('agent-relationships');
  private readonly cultureBlock = requireElement('agent-culture-block');
  private readonly cultureKnowledge = requireElement<HTMLUListElement>('agent-culture-knowledge');
  private readonly cultureSignals = requireElement<HTMLUListElement>('agent-culture-signals');
  private readonly cultureNorms = requireElement<HTMLUListElement>('agent-culture-norms');

  showAgent(agent: AgentDetails): void {
    this.title.textContent = `Agent #${agent.entityId}`;
    this.setField('agent-x', agent.x.toFixed(2));
    this.setField('agent-y', agent.y.toFixed(2));
    this.setField('agent-intent', agent.intent);
    this.setField('agent-target-x', agent.targetX.toFixed(2));
    this.setField('agent-target-y', agent.targetY.toFixed(2));
    this.setField('agent-age', formatAge(agent.ageHours));
    this.setField('agent-life-stage', agent.lifeStage);
    this.setField('agent-generation', String(agent.generation));
    this.setField('agent-parents', this.formatParents(agent));
    this.setField('agent-sex', agent.sex === 0 ? 'Female' : 'Male');
    this.setField('agent-health', agent.health.toFixed(NEED_DECIMALS));
    this.setField('agent-hunger', agent.hunger.toFixed(NEED_DECIMALS));
    this.setField('agent-thirst', agent.thirst.toFixed(NEED_DECIMALS));
    this.setField('agent-energy', agent.energy.toFixed(NEED_DECIMALS));
    this.setField('agent-reproduction', this.formatReproduction(agent));
    this.setField('agent-intelligence', agent.intelligence.toFixed(GENOME_DECIMALS));
    this.setField('agent-strength', agent.strength.toFixed(GENOME_DECIMALS));
    this.setField('agent-speed', agent.speed.toFixed(GENOME_DECIMALS));
    this.setField('agent-fertility', agent.fertility.toFixed(GENOME_DECIMALS));
    this.setField('agent-social-tendency', agent.socialTendency.toFixed(GENOME_DECIMALS));

    this.renderGenomeOrigins(agent);
    this.renderAiUtilities(agent);
    this.renderMemory(agent.memoryFood, this.memoryFood);
    this.renderMemory(agent.memoryWater, this.memoryWater);
    this.renderSocial(agent);
    this.renderCulture(agent);

    this.body.classList.remove('hidden');
    this.genomeBlock.classList.remove('hidden');
    this.aiBlock.classList.remove('hidden');
    this.memoryBlock.classList.remove('hidden');
    this.socialBlock.classList.remove('hidden');
    this.cultureBlock.classList.remove('hidden');
  }

  /** Shown when a selected entity no longer exists. */
  showMissing(entityId: number): void {
    this.title.textContent = `Agent #${entityId}`;
    this.body.classList.add('hidden');
    this.genomeBlock.classList.add('hidden');
    this.aiBlock.classList.add('hidden');
    this.memoryBlock.classList.add('hidden');
    this.socialBlock.classList.add('hidden');
    this.cultureBlock.classList.add('hidden');
    requireElement('agent-panel-missing').textContent = `Agent #${entityId} no longer exists.`;
  }

  clear(): void {
    this.title.textContent = 'No agent selected';
    this.body.classList.add('hidden');
    this.genomeBlock.classList.add('hidden');
    this.aiBlock.classList.add('hidden');
    this.memoryBlock.classList.add('hidden');
    this.socialBlock.classList.add('hidden');
    this.cultureBlock.classList.add('hidden');
    requireElement('agent-panel-missing').textContent = 'Click an agent to inspect it.';
  }

  private renderSocial(agent: AgentDetails): void {
    const group =
      agent.groupId >= 0
        ? `#${agent.groupId} · ${agent.groupMemberCount} members · cohesion ${agent.groupCohesion.toFixed(SOCIAL_DECIMALS)} · age ${agent.groupAgeTicks} ticks`
        : 'none (isolated)';
    this.setField('agent-group', group);
    this.setField('agent-loneliness', agent.loneliness.toFixed(NEED_DECIMALS));
    this.setField(
      'agent-cooperation',
      agent.cooperationPartner >= 0
        ? `with #${agent.cooperationPartner} (${agent.cooperationProgress}/${agent.cooperationDuration} ticks)`
        : 'none',
    );
    this.setField('agent-forage-bonus', agent.forageBonusActive ? 'active' : '—');

    this.relationships.replaceChildren();
    if (agent.relationships.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'knows no other agents yet';
      this.relationships.appendChild(li);
      return;
    }
    for (const relationship of agent.relationships) {
      const li = document.createElement('li');
      li.textContent = formatRelationship(relationship);
      this.relationships.appendChild(li);
    }
  }

  private renderCulture(agent: AgentDetails): void {
    this.setField('agent-culture-count', `${agent.knowledgeItemCount} items · ${agent.signalAssociationCount} signals`);
    this.setField('agent-culture-last-signal', agent.lastSignal);
    this.setField('agent-culture-alert', agent.alertTicks > 0 ? `${agent.alertTicks} ticks` : '—');
    this.setField(
      'agent-culture-cooldowns',
      `teach ${agent.teachCooldownTicks} · signal ${agent.signalCooldownTicks}`,
    );

    this.renderCultureList(
      this.cultureNorms,
      agent.normStrengths,
      (norm) => (norm.strength > 0 ? `${norm.norm} · ${(norm.strength * 100).toFixed(0)}%` : `${norm.norm} · not held`),
      'no norms held',
    );
    this.renderCultureList(this.cultureKnowledge, agent.culturalKnowledge, formatKnowledge, 'knows nothing yet');
    this.renderCultureList(this.cultureSignals, agent.signalAssociations, formatSignal, 'has not learned any signal meaning yet');
  }

  /** Render a bounded cultural list, falling back to a muted placeholder. */
  private renderCultureList<T>(
    list: HTMLUListElement,
    entries: readonly T[],
    format: (entry: T) => string,
    emptyText: string,
  ): void {
    list.replaceChildren();
    if (entries.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = emptyText;
      list.appendChild(li);
      return;
    }
    for (const entry of entries) {
      const li = document.createElement('li');
      li.textContent = format(entry);
      list.appendChild(li);
    }
  }

  private formatParents(agent: AgentDetails): string {
    if (agent.parentA < 0 || agent.parentB < 0) return 'Founding (generation 0)';
    return `#${agent.parentA} × #${agent.parentB}`;
  }

  private formatReproduction(agent: AgentDetails): string {
    if (agent.reproductionEligible) return 'Eligible';
    if (agent.reproductionCooldownHours > 0) return `Cooldown ${agent.reproductionCooldownHours.toFixed(1)}h`;
    return 'Not eligible';
  }

  private renderGenomeOrigins(agent: AgentDetails): void {
    this.genomeOrigins.replaceChildren();
    for (const origin of agent.genomeOrigins) {
      const li = document.createElement('li');
      const gene = document.createElement('span');
      gene.className = 'genome-gene';
      gene.textContent = origin.gene;
      const value = document.createElement('span');
      value.className = 'genome-value';
      value.textContent = origin.value.toFixed(GENOME_DECIMALS);
      const source = document.createElement('span');
      source.className = `genome-source genome-source-${origin.source}`;
      source.textContent = this.sourceLabel(origin);
      li.append(gene, value, source);
      this.genomeOrigins.appendChild(li);
    }
  }

  private sourceLabel(origin: GeneOrigin): string {
    switch (origin.source) {
      case 'founding':
        return 'founding';
      case 'a':
        return 'from A';
      case 'b':
        return 'from B';
      case 'mutation':
        return 'mutated';
    }
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

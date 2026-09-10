/**
 * Groups panel (Phase 4): summary of the emergent social communities plus an
 * expandable per-group inspection (members, territory, cohesion, average
 * traits, strongest internal bonds, recent group events).
 *
 * Consumes snapshot data only (aggregates + the bounded group list); detailed
 * inspection is fetched on demand from the worker via `get-group` — the full
 * social graph never crosses the boundary per frame. Selecting a group sends
 * a query; it never mutates simulation state.
 *
 * Phase 5 adds the cultural profile to the on-demand details: what the members
 * actually know (dominant knowledge, traditions), which signal tokens the group
 * has settled on and how similar its culture is to the other groups. Every
 * value is derived from member knowledge — nothing is assigned to a group.
 */

import { requireElement } from './dom';
import { groupColor } from '../rendering/agent-visuals';
import type { SimulationSnapshot, GroupDetails } from '../persistence';
import type { SimulationEvent } from '../simulation-core';

/** Formatting precision for cohesion/relationship values (0..1 or −1..1). */
const DECIMALS = 2;

/** Formatting precision for territory coordinates (tiles). */
const POSITION_DECIMALS = 1;

/** How many other groups the inspector lists similarity for (bounded). */
const MAX_GROUP_SIMILARITY_ROWS = 6;

function describeGroupEvent(event: SimulationEvent): string {
  const tick = `t ${event.tick}`;
  const detail = event.detail ?? '';
  return `${tick} · ${detail}`;
}

export class GroupPanel {
  private readonly list = requireElement<HTMLUListElement>('group-list');
  private readonly details = requireElement<HTMLElement>('group-details');
  private selectedGroupId: number | null = null;

  constructor(onSelect: (groupId: number) => void) {
    // Clicking a group row selects it for inspection — a read-only query.
    this.list.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const row = target?.closest('.group-row') as HTMLElement | null;
      if (!row || row.dataset.groupId === undefined) return;
      const groupId = Number(row.dataset.groupId);
      if (Number.isInteger(groupId) && groupId >= 0) {
        onSelect(groupId);
      }
    });
  }

  update(snapshot: SimulationSnapshot): void {
    this.renderSummary(snapshot);
    this.renderList(snapshot);
  }

  clear(): void {
    this.selectedGroupId = null;
    this.list.replaceChildren();
    this.details.replaceChildren();
    this.details.classList.add('hidden');
    this.renderClearedSummary();
  }

  /** Group selected (click): remember it and request full details. */
  selectGroup(groupId: number): void {
    this.selectedGroupId = groupId;
    this.highlightSelection();
  }

  /** Reply from the worker for the selected group (null = no longer exists). */
  showDetails(group: GroupDetails | null): void {
    if (this.selectedGroupId === null) return;
    this.details.classList.remove('hidden');
    if (!group) {
      this.details.replaceChildren();
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = `Group #${this.selectedGroupId} no longer exists.`;
      this.details.appendChild(p);
      return;
    }
    this.renderDetails(group);
  }

  private renderSummary(snapshot: SimulationSnapshot): void {
    const groups = snapshot.groups;
    const social = snapshot.social;
    const grouped = snapshot.population - groups.isolatedAgents;
    requireElement('group-count').textContent = String(groups.count);
    requireElement('group-grouped').textContent = `${grouped} / ${snapshot.population}`;
    requireElement('group-isolated').textContent = String(groups.isolatedAgents);
    requireElement('group-largest').textContent = groups.largestSize === 0 ? '—' : String(groups.largestSize);
    requireElement('group-smallest-stable').textContent =
      groups.smallestStableSize === 0 ? '—' : String(groups.smallestStableSize);
    requireElement('group-avg-size').textContent = groups.count === 0 ? '—' : groups.averageSize.toFixed(DECIMALS);
    requireElement('group-avg-cohesion').textContent =
      groups.count === 0 ? '—' : groups.averageCohesion.toFixed(DECIMALS);
    requireElement('group-relationships').textContent = String(social.activeRelationships);
    requireElement('group-avg-relationship').textContent = social.activeRelationships === 0
      ? '—'
      : (social.averageRelationshipScore >= 0 ? '+' : '') + social.averageRelationshipScore.toFixed(DECIMALS);
    requireElement('group-avg-trust').textContent =
      social.activeRelationships === 0 ? '—' : social.averageTrust.toFixed(DECIMALS);
    requireElement('group-cooperations').textContent = String(social.cooperationEvents);
    requireElement('group-conflicts').textContent = String(social.conflictEvents);
  }

  private renderClearedSummary(): void {
    for (const id of [
      'group-count',
      'group-grouped',
      'group-isolated',
      'group-largest',
      'group-smallest-stable',
      'group-avg-size',
      'group-avg-cohesion',
      'group-relationships',
      'group-avg-relationship',
      'group-avg-trust',
      'group-cooperations',
      'group-conflicts',
    ]) {
      requireElement(id).textContent = '—';
    }
  }

  private renderList(snapshot: SimulationSnapshot): void {
    this.list.replaceChildren();
    if (snapshot.groups.list.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No groups have formed yet — agents are still strangers.';
      this.list.appendChild(li);
      return;
    }
    for (const group of snapshot.groups.list) {
      const li = document.createElement('li');
      li.className = 'group-row';
      li.dataset.groupId = String(group.id);

      const swatch = document.createElement('span');
      swatch.className = 'group-swatch';
      swatch.style.backgroundColor = groupColor(group.id);

      const name = document.createElement('span');
      name.className = 'group-name';
      name.textContent = `Group #${group.id}`;

      const info = document.createElement('span');
      info.className = 'group-info';
      const ageDays = Math.floor((snapshot.tick - group.createdTick) / 96);
      info.textContent = `${group.memberCount} members · cohesion ${group.cohesion.toFixed(DECIMALS)} · day ${ageDays + 1}`;
      if (group.parentId >= 0) {
        info.textContent += ` · split from #${group.parentId}`;
      }
      if (group.cultureDominant !== 'none') {
        info.textContent += ` · knows ${group.cultureDominant} (${Math.round(group.cultureDominantShare * 100)}%)`;
      }

      const bar = document.createElement('div');
      bar.className = 'group-cohesion-bar';
      const fill = document.createElement('div');
      fill.className = 'group-cohesion-fill';
      fill.style.width = `${Math.round(group.cohesion * 100)}%`;
      fill.style.backgroundColor = groupColor(group.id);
      bar.appendChild(fill);

      li.append(swatch, name, info, bar);
      this.list.appendChild(li);
    }
    this.highlightSelection();
  }

  private highlightSelection(): void {
    for (const li of Array.from(this.list.children)) {
      const row = li as HTMLElement;
      const id = row.dataset.groupId !== undefined ? Number(row.dataset.groupId) : null;
      row.classList.toggle('selected', id !== null && id === this.selectedGroupId);
    }
  }

  private renderDetails(group: GroupDetails): void {
    this.details.replaceChildren();

    const title = document.createElement('h3');
    title.textContent = `Group #${group.id}`;
    this.details.appendChild(title);

    const stats = document.createElement('dl');
    stats.className = 'stats';
    const rows: Array<[string, string]> = [
      ['Members', String(group.memberCount)],
      ['Center', `${group.centerX.toFixed(POSITION_DECIMALS)}, ${group.centerY.toFixed(POSITION_DECIMALS)}`],
      ['Territory radius', `${group.radius.toFixed(POSITION_DECIMALS)} tiles`],
      ['Cohesion', group.cohesion.toFixed(DECIMALS)],
      ['Stable runs', String(group.stableRuns)],
      ['Origin', group.parentId >= 0 ? `split from #${group.parentId} (gen ${group.generation})` : 'spontaneous'],
      ['Food access', group.foodAccess.toFixed(DECIMALS)],
      ['Water access', group.waterAccess.toFixed(DECIMALS)],
      ['Avg intelligence', group.averageTraits.intelligence.toFixed(3)],
      ['Avg strength', group.averageTraits.strength.toFixed(3)],
      ['Avg speed', group.averageTraits.speed.toFixed(3)],
      ['Avg fertility', group.averageTraits.fertility.toFixed(3)],
      ['Avg social tendency', group.averageTraits.socialTendency.toFixed(3)],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      row.append(dt, dd);
      stats.appendChild(row);
    }
    this.details.appendChild(stats);

    if (group.topRelationships.length > 0) {
      const heading = document.createElement('h4');
      heading.textContent = 'Strongest bonds';
      const bonds = document.createElement('ul');
      bonds.className = 'memory-list';
      for (const pair of group.topRelationships) {
        const li = document.createElement('li');
        li.textContent = `#${pair.a} ↔ #${pair.b} · ${(pair.score >= 0 ? '+' : '') + pair.score.toFixed(2)} · trust ${pair.trust.toFixed(2)}${pair.kin ? ' · kin' : ''}`;
        bonds.appendChild(li);
      }
      this.details.append(heading, bonds);
    }

    // --- Phase 5: cultural profile (derived from member knowledge) ---------
    const cultureHeading = document.createElement('h4');
    cultureHeading.textContent = 'Culture';
    const cultureStats = document.createElement('dl');
    cultureStats.className = 'stats';
    const cultureRows: Array<[string, string]> = [
      ['Knowledge holders', `${group.culture.carriers} / ${group.memberCount}`],
      ['Distinct items', String(group.culture.distinctItems)],
      ['Avg strength', group.culture.averageStrength.toFixed(DECIMALS)],
      ['Diversity', group.culture.diversity.toFixed(DECIMALS)],
      ['Norm holders', String(group.culture.normCarriers)],
      ['Signal carriers', String(group.culture.signalCarriers)],
    ];
    for (const [label, value] of cultureRows) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      row.append(dt, dd);
      cultureStats.appendChild(row);
    }
    this.details.append(cultureHeading, cultureStats);

    if (group.culture.dominantKnowledge.length > 0) {
      const sub = document.createElement('h5');
      sub.textContent = 'Most widespread knowledge';
      const list = document.createElement('ul');
      list.className = 'memory-list';
      for (const item of group.culture.dominantKnowledge) {
        const li = document.createElement('li');
        li.textContent = `${item.label} · ${item.carriers} holders (${Math.round(item.share * 100)}%) · ${(item.averageStrength * 100).toFixed(0)}%`;
        list.appendChild(li);
      }
      this.details.append(sub, list);
    }

    if (group.culture.traditions.length > 0) {
      const sub = document.createElement('h5');
      sub.textContent = 'Traditions';
      const list = document.createElement('ul');
      list.className = 'memory-list';
      for (const item of group.culture.traditions) {
        const li = document.createElement('li');
        li.textContent = `${item.label} · held by ${Math.round(item.share * 100)}% of members`;
        list.appendChild(li);
      }
      this.details.append(sub, list);
    }

    if (group.culture.signals.length > 0) {
      const sub = document.createElement('h5');
      sub.textContent = 'Signal conventions';
      const list = document.createElement('ul');
      list.className = 'memory-list';
      for (const convention of group.culture.signals) {
        const li = document.createElement('li');
        li.textContent = `${convention.label} · ${convention.carriers} agents (${Math.round(convention.share * 100)}%) · ${(convention.strength * 100).toFixed(0)}%`;
        list.appendChild(li);
      }
      this.details.append(sub, list);
    }

    if (group.culturalSimilarity.length > 0) {
      const sub = document.createElement('h5');
      sub.textContent = 'Cultural similarity (0–1)';
      const list = document.createElement('ul');
      list.className = 'memory-list';
      for (const entry of group.culturalSimilarity.slice(0, MAX_GROUP_SIMILARITY_ROWS)) {
        const li = document.createElement('li');
        li.textContent = `Group #${entry.groupId} · ${entry.similarity.toFixed(DECIMALS)}`;
        list.appendChild(li);
      }
      this.details.append(sub, list);
    }

    if (group.recentEvents.length > 0) {
      const heading = document.createElement('h4');
      heading.textContent = 'Recent events';
      const events = document.createElement('ul');
      events.className = 'memory-list';
      for (const event of group.recentEvents) {
        const li = document.createElement('li');
        li.textContent = describeGroupEvent(event);
        events.appendChild(li);
      }
      this.details.append(heading, events);
    }
  }
}

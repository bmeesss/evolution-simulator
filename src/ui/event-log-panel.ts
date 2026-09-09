/**
 * Event log panel: shows the most recent simulation events (newest first).
 * Events arrive inside worker snapshots and always carry the tick number.
 */

import { requireElement } from './dom';
import type { SimulationEvent } from '../simulation-core';

/** Number of events kept visible in the feed. */
const VISIBLE_EVENTS = 8;

function describeEvent(event: SimulationEvent): string {
  const parts: string[] = [eventTitle(event.type)];
  if (event.entityId !== undefined) parts.push(`agent ${event.entityId}`);
  if (event.detail !== undefined) parts.push(event.detail);
  return parts.join(' · ');
}

const EVENT_LABELS: Record<string, string> = {
  reproduction_attempted: 'Reproduction attempted',
  reproduction_success: 'Reproduction success',
  birth: 'Birth',
  mutation: 'Mutation',
  old_age_death: 'Old-age death',
};

function eventTitle(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

export class EventLogPanel {
  private readonly list = requireElement<HTMLUListElement>('event-log-list');

  addEvents(events: readonly SimulationEvent[]): void {
    // Newest first: insert before existing children in arrival order.
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      const item = document.createElement('li');
      const tickLabel = document.createElement('span');
      tickLabel.className = 'event-tick';
      tickLabel.textContent = `t ${event.tick}`;
      item.appendChild(tickLabel);
      item.appendChild(document.createTextNode(` ${describeEvent(event)}`));
      this.list.insertBefore(item, this.list.firstChild);
    }
    while (this.list.childElementCount > VISIBLE_EVENTS) {
      this.list.removeChild(this.list.lastChild as ChildNode);
    }
  }

  clear(): void {
    this.list.replaceChildren();
  }
}

/**
 * Tracks the currently selected agent and decides whether an `agent-details`
 * worker reply is still relevant.
 *
 * WHY this exists: agent-details replies are asynchronous. By the time a reply
 * arrives, the user may have clicked a different agent (or empty space), and a
 * stale reply for the previous agent must never overwrite the panel showing
 * the newly selected agent. The worker echoes the requested `entityId` on
 * every reply (see workers/protocol.ts) so the main thread can drop stale
 * ones — this class owns that policy and is kept DOM-free so the regression
 * test can run without a browser.
 */

import type { EntityId } from '../simulation-core';

export class AgentSelection {
  private current: EntityId | null = null;

  /** The currently selected agent, or null when nothing is selected. */
  get entityId(): EntityId | null {
    return this.current;
  }

  select(entityId: EntityId): void {
    this.current = entityId;
  }

  clear(): void {
    this.current = null;
  }

  /**
   * True when an agent-details reply for `entityId` should update the panel.
   * A reply for any other entity (or after deselection) must be ignored.
   */
  shouldApplyDetails(entityId: EntityId): boolean {
    return this.current === entityId;
  }
}

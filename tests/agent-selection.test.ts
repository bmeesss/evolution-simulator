import { describe, expect, it } from 'vitest';
import { AgentSelection } from '../src/main/agent-selection';

/**
 * Regression tests for the stale agent-details guard.
 *
 * Scenario being protected against: the user selects agent A, a `get-agent`
 * request flies to the worker, the user then selects agent B — and A's reply
 * arrives after B's selection. The reply's `entityId` (echoed by the worker)
 * no longer matches the selection, so it must be dropped instead of
 * overwriting B's panel.
 */
describe('AgentSelection (stale agent-details guard)', () => {
  it('applies replies that match the current selection', () => {
    const selection = new AgentSelection();
    expect(selection.entityId).toBeNull();
    expect(selection.shouldApplyDetails(7)).toBe(false); // nothing selected

    selection.select(7);
    expect(selection.entityId).toBe(7);
    expect(selection.shouldApplyDetails(7)).toBe(true);
  });

  it('drops replies for a previously selected agent (regression)', () => {
    const selection = new AgentSelection();
    selection.select(7); // user selects agent 7 -> request sent
    selection.select(12); // user selects agent 12 before the reply arrives
    expect(selection.shouldApplyDetails(7)).toBe(false); // stale reply: dropped
    expect(selection.shouldApplyDetails(12)).toBe(true); // fresh reply: applied
  });

  it('drops all replies after deselection', () => {
    const selection = new AgentSelection();
    selection.select(7);
    selection.clear(); // user clicked empty space
    expect(selection.shouldApplyDetails(7)).toBe(false);
    expect(selection.entityId).toBeNull();
  });

  it('drops replies from a previous world after re-init (clear)', () => {
    const selection = new AgentSelection();
    selection.select(42);
    selection.clear(); // app clears the selection on every 'ready' message
    expect(selection.shouldApplyDetails(42)).toBe(false);
  });

  it('re-selecting the same agent later accepts its replies again', () => {
    const selection = new AgentSelection();
    selection.select(7);
    selection.clear();
    selection.select(7);
    expect(selection.shouldApplyDetails(7)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { EventLog } from '../src/simulation-core/events/events';

function makeLog(capacity?: number) {
  let tick = 0;
  let timeHours = 0;
  const log = new EventLog(() => ({ tick, timeHours }), capacity);
  return {
    log,
    advance(hours: number) {
      tick++;
      timeHours += hours;
    },
  };
}

describe('EventLog', () => {
  it('stamps events with the simulation tick and time', () => {
    const { log, advance } = makeLog();
    log.record('simulation_started', { detail: 'seed=1' });
    advance(0.25);
    log.record('agent_spawned', { entityId: 3 });
    const events = log.recent(10);
    expect(events[0].tick).toBe(0);
    expect(events[0].timeHours).toBe(0);
    expect(events[1].tick).toBe(1);
    expect(events[1].timeHours).toBe(0.25);
    expect(events[1].entityId).toBe(3);
  });

  it('drain returns only events since the last drain', () => {
    const { log } = makeLog();
    log.record('simulation_started');
    log.record('agent_spawned', { entityId: 0 });
    const first = log.drain(100);
    expect(first.map((e) => e.type)).toEqual(['simulation_started', 'agent_spawned']);
    expect(log.drain(100)).toEqual([]);
    log.record('simulation_paused');
    expect(log.drain(100).map((e) => e.type)).toEqual(['simulation_paused']);
  });

  it('drain caps per call and delivers the remainder next time', () => {
    const { log } = makeLog();
    for (let i = 0; i < 5; i++) log.record('agent_spawned', { entityId: i });
    expect(log.drain(2)).toHaveLength(2);
    expect(log.drain(2)).toHaveLength(2);
    expect(log.drain(2)).toHaveLength(1);
    expect(log.drain(2)).toHaveLength(0);
  });

  it('keeps a bounded history, dropping the oldest', () => {
    const { log } = makeLog(3);
    for (let i = 0; i < 5; i++) log.record('agent_spawned', { entityId: i });
    expect(log.length).toBe(3);
    expect(log.recent(3).map((e) => e.entityId)).toEqual([2, 3, 4]);
  });

  it('retains undelivered events when the history rolls over', () => {
    const { log } = makeLog(3);
    for (let i = 0; i < 4; i++) log.record('agent_spawned', { entityId: i });
    // 4 events recorded, oldest dropped -> 3 kept, none drained yet.
    const drained = log.drain(10);
    expect(drained.map((e) => e.entityId)).toEqual([1, 2, 3]);
    expect(log.drain(10)).toEqual([]);
  });
});

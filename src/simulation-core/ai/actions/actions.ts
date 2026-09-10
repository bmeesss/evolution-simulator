/**
 * Actions — the vocabulary of things an agent can decide to do.
 *
 * In Phase 2 the set of actions the AI considers is exactly the set of intents
 * the systems execute, so `ActionKind` aliases `AgentIntent` rather than
 * defining a parallel enum that could drift out of sync. This module adds the
 * *decision-side* metadata (count, display names) that the scoring loop and the
 * debug view need, while `intents.ts` remains the systems' contract.
 *
 * Action order is part of the determinism contract: the AI draws tie-break
 * noise in this exact order, and ties resolve to the earliest action.
 */

import { AgentIntent, INTENT_COUNT } from '../intents';

export const ActionKind = AgentIntent;

export type ActionKind = AgentIntent;

export const ACTION_COUNT = INTENT_COUNT;

/** Display names, aligned with `ActionKind` order (used by the AI debug view). */
export const ACTION_NAMES: readonly string[] = [
  'Rest',
  'Wander',
  'SeekFood',
  'SeekWater',
  'Eat',
  'Drink',
  'SeekPartner',
];

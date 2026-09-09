/**
 * In-game time helpers. Pure functions — safe to import on any thread.
 */

/** In-game hours per in-game day. */
export const HOURS_PER_DAY = 24;

/** Format hours as a compact "Day D · HHh" label for the UI. */
export function formatTimeHours(hours: number): string {
  const day = Math.floor(hours / HOURS_PER_DAY) + 1;
  const hour = Math.floor(hours % HOURS_PER_DAY);
  const hourLabel = hour < 10 ? `0${hour}` : `${hour}`;
  return `Day ${day} · ${hourLabel}:00`;
}

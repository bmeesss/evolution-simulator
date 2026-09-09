/**
 * Small DOM helpers for the UI layer. Fails fast on missing elements so typos
 * in index.html are caught at startup instead of silently rendering nothing.
 */

export function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element #${id}`);
  }
  return element as T;
}

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Architectural hygiene, enforced by tests:
 *
 * 1. No Math.random anywhere in src — the simulation must be deterministic,
 *    and even UI code avoids it (seed picking uses the CSPRNG).
 * 2. simulation-core and persistence stay free of DOM/window/document/canvas
 *    references — they must remain runnable in any JS host (worker, Node).
 * 3. Protocol/snapshot modules used by the main thread never import
 *    simulation-core at runtime — verified textually here (type-only imports
 *    must use `import type`), plus by inspecting the built bundle.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir: string, extension = '.ts'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full, extension));
    } else if (entry.endsWith(extension)) {
      out.push(full);
    }
  }
  return out;
}

function relative(file: string): string {
  return file.slice(repoRoot.length + 1);
}

describe('source hygiene', () => {
  it('contains no platform RNG usage anywhere in src', () => {
    const offenders: string[] = [];
    for (const file of listFiles(join(repoRoot, 'src'))) {
      const source = readFileSync(file, 'utf8');
      if (source.includes('Math.random')) {
        offenders.push(relative(file));
      }
    }
    expect(offenders, `platform RNG found in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('keeps simulation-core free of DOM / window / canvas references', () => {
    const offenders: string[] = [];
    // Dotted usage patterns (avoids flagging words inside comments).
    const forbidden = [
      'document.',
      'window.',
      'navigator.',
      'getElementById',
      'createElement',
      'querySelector',
      'getContext',
      'addEventListener',
      'requestAnimationFrame',
      'HTMLCanvasElement',
      'HTMLElement',
      'OffscreenCanvas',
    ];
    const pureDirs = ['src/simulation-core', 'src/persistence'];
    for (const dir of pureDirs) {
      for (const file of listFiles(join(repoRoot, dir))) {
        const source = readFileSync(file, 'utf8');
        for (const pattern of forbidden) {
          if (source.includes(pattern)) {
            offenders.push(`${relative(file)}: "${pattern}"`);
          }
        }
      }
    }
    expect(offenders, `DOM references in simulation code: ${offenders.join(', ')}`).toEqual([]);
  });

  it('keeps the worker protocol free of runtime simulation imports', () => {
    const source = readFileSync(join(repoRoot, 'src/workers/protocol.ts'), 'utf8');
    const runtimeImports = source
      .split('\n')
      .filter((line) => line.trim().startsWith('import'))
      .filter((line) => !line.trim().startsWith('import type'));
    expect(
      runtimeImports,
      'protocol.ts must use type-only imports so the main bundle stays free of simulation code',
    ).toEqual([]);
  });

  // The only simulation-core modules main-thread code may import at RUNTIME
  // (i.e. not as `import type`) are pure leaf helpers with no simulation logic.
  const MAIN_THREAD_RUNTIME_IMPORT_ALLOWLIST = new Set([
    'simulation-core/world/terrain', // terrain type constants
    'simulation-core/simulation/time', // pure time formatting helpers
    'simulation-core/ai/intents', // intent-kind constants (renderer state rings)
  ]);

  it('restricts main-thread runtime imports of simulation-core to pure leaf modules', () => {
    const mainThreadFiles = [
      ...listFiles(join(repoRoot, 'src/rendering')),
      ...listFiles(join(repoRoot, 'src/ui')),
      ...listFiles(join(repoRoot, 'src/main')),
      join(repoRoot, 'src/workers/protocol.ts'),
      join(repoRoot, 'src/workers/worker-client.ts'),
    ];
    const offenders: string[] = [];
    // Matches `import ... from 'x'` (type-only flagged) and side-effect `import 'x'`.
    const importPattern = /import\s+(type\s+)?[^;']*?(?:from\s*)?['"]([^'"]+)['"]/g;
    for (const file of mainThreadFiles) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(importPattern)) {
        const isTypeOnly = match[1] !== undefined;
        const specifier = match[2];
        if (!specifier.includes('simulation-core')) continue;
        if (isTypeOnly) continue; // types are erased at build time
        const normalized = specifier.slice(specifier.indexOf('simulation-core'));
        if (!MAIN_THREAD_RUNTIME_IMPORT_ALLOWLIST.has(normalized)) {
          offenders.push(`${relative(file)}: runtime import of '${specifier}'`);
        }
      }
    }
    expect(
      offenders,
      `main-thread code must not import simulation logic at runtime: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

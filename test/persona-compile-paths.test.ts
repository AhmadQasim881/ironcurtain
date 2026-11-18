/**
 * Every persona compile must take the one shared path, `runPersonaCompile`
 * (src/persona/persona-compile-service.ts): it alone holds the compile lock,
 * runs the broad-policy validator and writes the audit record. A module that
 * called `compilePersonaPolicy` itself would be a second, unvalidated compile
 * path (CFG-5: the CLI used to be one).
 *
 * So the only value import of compile-persona-policy.ts anywhere under src/,
 * static or dynamic, is the dynamic-import seam inside the compile service.
 * Type-only imports (its options type) are fine. The scan relies on the
 * codebase's Prettier format (statements end with `;`), so an import clause
 * is everything between `import`/`export` and `from`, across lines.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');
const SEAM = 'src/persona/compile-persona-policy.ts';

interface ImportEdge {
  readonly specifier: string;
  readonly kind: 'static' | 'dynamic' | 'type';
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Strips block and line comments (keeping `://` in URLs). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Whether an import/export clause (the text between the keyword and `from`) brings in only types. */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type\b/.test(trimmed)) return true;
  const named = /^\{([\s\S]*)\}$/.exec(trimmed);
  if (!named) return false;
  const specs = named[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return specs.length > 0 && specs.every((s) => /^type\s+(?!as\b)/.test(s));
}

const FROM_IMPORT = /\b(?:import|export)\b([^;'"`]*?)\bfrom\s*(['"])([^'"]+)\2/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const SIDE_EFFECT_IMPORT = /\bimport\s*(['"])([^'"]+)\1/g;

function importsOf(source: string): ImportEdge[] {
  const code = stripComments(source);
  const edges: ImportEdge[] = [];
  for (const m of code.matchAll(FROM_IMPORT)) {
    edges.push({ specifier: m[3], kind: isTypeOnlyClause(m[1]) ? 'type' : 'static' });
  }
  for (const m of code.matchAll(DYNAMIC_IMPORT)) edges.push({ specifier: m[2], kind: 'dynamic' });
  for (const m of code.matchAll(SIDE_EFFECT_IMPORT)) edges.push({ specifier: m[2], kind: 'static' });
  return edges;
}

/** The repo-relative `.ts` module a relative `.js` specifier names, if any. */
function targetOf(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const target = resolve(dirname(fromFile), specifier).replace(/\.js$/, '.ts');
  return relative(ROOT, target).split('\\').join('/');
}

describe('persona compiles have one path', () => {
  it('only persona-compile-service.ts reaches compile-persona-policy.ts, and only through a dynamic import', () => {
    const importers: string[] = [];
    for (const file of listTsFiles(SRC)) {
      for (const edge of importsOf(readFileSync(file, 'utf-8'))) {
        if (edge.kind === 'type' || targetOf(file, edge.specifier) !== SEAM) continue;
        importers.push(`${relative(ROOT, file).split('\\').join('/')} (${edge.kind})`);
      }
    }
    expect(importers).toEqual(['src/persona/persona-compile-service.ts (dynamic)']);
  });

  it('sees type-only, multi-line, re-exported and dynamic imports (the scan is not vacuous)', () => {
    const source = [
      "import type { A } from './compile-persona-policy.js';",
      "import { type B, type C } from './compile-persona-policy.js';",
      'import {',
      '  compilePersonaPolicy,',
      "} from './compile-persona-policy.js';",
      "export { compilePersonaPolicy as again } from './compile-persona-policy.js';",
      "// import { commented } from './compile-persona-policy.js';",
      "const m = await import('./compile-persona-policy.js');",
      "const url = 'https://example.com/import';",
    ].join('\n');
    expect(importsOf(source).map((e) => e.kind)).toEqual(['type', 'type', 'static', 'static', 'dynamic']);
    expect(targetOf(resolve(SRC, 'persona', 'probe.ts'), './compile-persona-policy.js')).toBe(SEAM);
  });
});

/**
 * Static guard for the working-directory .env injection (WP-02: CFG-1, SES-1,
 * WFC-4, DTL-2, BLD-1, GAP5-6, DINF-2).
 *
 * Every entry point used to start with `import 'dotenv/config'` (or
 * `await import('dotenv/config')` in its direct-run block), which copied every
 * key of `<cwd>/.env` into the trusted process. test/cli-env-isolation.test.ts
 * proves the CLI no longer does that; this test covers the other entry points
 * (src/index.ts, the pipeline commands, scripts/show-system-prompt.ts) and any
 * module added later, which a CLI run would not exercise:
 *
 * - no runtime module or script loads an env file implicitly: no
 *   `dotenv/config`, no other dotenv import, no `process.loadEnvFile()`;
 * - only src/config/trusted-env.ts imports dotenv, and only its pure `parse()`;
 * - every process entry point calls `bootstrapTrustedEnvForProcess()`.
 *
 * Full-line comments and comment blocks are dropped before matching, so doc
 * comments that describe the old `import 'dotenv/config'` do not count; help
 * strings such as `--import dotenv/config` never match because the patterns
 * require a quoted module specifier. Tests (test/, __tests__) may still load a
 * developer .env. A small deterministic scanner, like
 * test/pipeline-import-boundary.test.ts, rather than a parser dependency.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Trees holding code that runs outside the test runner. */
const SCANNED_DIRS = ['src', 'scripts', 'packages/memory-mcp-server/src'];

/** The one module allowed to import dotenv, and the only binding it may take. */
const DOTENV_OWNER = 'src/config/trusted-env.ts';

/** Files that run as a process and must load credentials through the trusted loader. */
const ENTRY_POINTS = [
  'src/cli.ts',
  'src/index.ts',
  'src/pipeline/annotate.ts',
  'src/pipeline/compile.ts',
  'src/pipeline/refresh-lists.ts',
  'scripts/show-system-prompt.ts',
];

const SOURCE_FILE = /\.[cm]?[jt]s$/;
const TEST_FILE = /(^|\/)__tests__\/|\.test\.[cm]?[jt]s$|\.d\.ts$/;

/** `import ... from 'dotenv...'` and `export ... from 'dotenv...'` (group 1: clause, group 2: specifier). */
const STATIC_FROM = /\b(?:import|export)\s+(?!\()([^;'"]*?)\s*\bfrom\s*['"](dotenv(?:\/[^'"]*)?)['"]/g;
/** `import 'dotenv/config'` (side-effect import). */
const SIDE_EFFECT = /\bimport\s*['"](dotenv(?:\/[^'"]*)?)['"]/g;
/** `import('dotenv/config')` and `require('dotenv')`. */
const DYNAMIC = /\b(import|require)\s*\(\s*['"](dotenv(?:\/[^'"]*)?)['"]/g;
/** `process.loadEnvFile()` (Node's built-in .env loader). */
const LOAD_ENV_FILE = /\.\s*loadEnvFile\s*\(/g;

/** Repo-relative paths of every non-test source file under `dir`. */
function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSources(full));
    } else if (SOURCE_FILE.test(entry)) {
      const rel = relative(ROOT, full);
      if (!TEST_FILE.test(rel)) out.push(rel);
    }
  }
  return out;
}

/** The file's code with full-line `//` comments and comment blocks blanked (line numbers kept). */
function codeOf(rel: string): string {
  const lines = readFileSync(resolve(ROOT, rel), 'utf-8').split('\n');
  let inBlock = false;
  return lines
    .map((line) => {
      const trimmed = line.trimStart();
      if (inBlock) {
        if (line.includes('*/')) inBlock = false;
        return '';
      }
      if (trimmed.startsWith('//')) return '';
      if (trimmed.startsWith('/*')) {
        inBlock = !trimmed.includes('*/', 2);
        return '';
      }
      return line;
    })
    .join('\n');
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

/** Names bound by an import clause: `default`, `*`, or the imported (not local) names. */
function bindingsOf(clause: string): string[] {
  const bindings: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  const outside = clause.replace(/\{[^}]*\}/, '').replace(/^type\s+/, '');
  if (/\*\s*as\s+\w+/.test(outside)) bindings.push('*');
  else if (/^[\w$]+/.test(outside.trim())) bindings.push('default');
  for (const part of braces?.[1].split(',') ?? []) {
    const name = part
      .trim()
      .split(/\s+as\s+/)[0]
      ?.trim();
    if (name) bindings.push(name);
  }
  return bindings;
}

interface DotenvUse {
  readonly at: string;
  readonly specifier: string;
  readonly bindings: readonly string[];
}

/** Every dotenv import and env-file loading call in a file. */
function dotenvUses(rel: string): DotenvUse[] {
  const code = codeOf(rel);
  const uses: DotenvUse[] = [];
  const at = (index: number) => `${rel}:${lineOf(code, index)}`;
  for (const match of code.matchAll(STATIC_FROM)) {
    const bindings = match[0].startsWith('export') ? ['re-export'] : bindingsOf(match[1]);
    uses.push({ at: at(match.index), specifier: match[2], bindings });
  }
  for (const match of code.matchAll(SIDE_EFFECT)) {
    uses.push({ at: at(match.index), specifier: match[1], bindings: ['side-effect'] });
  }
  for (const match of code.matchAll(DYNAMIC)) {
    uses.push({ at: at(match.index), specifier: match[2], bindings: [`${match[1]}()`] });
  }
  for (const match of code.matchAll(LOAD_ENV_FILE)) {
    uses.push({ at: at(match.index), specifier: '(node)', bindings: ['loadEnvFile()'] });
  }
  return uses;
}

const sources = SCANNED_DIRS.flatMap((dir) => listSources(resolve(ROOT, dir)));

describe('no implicit .env loading', () => {
  it('scans the runtime trees (sanity check)', () => {
    expect(sources.length).toBeGreaterThan(100);
    for (const entry of [...ENTRY_POINTS, DOTENV_OWNER]) expect(sources).toContain(entry);
  });

  it('the scanner sees the forms the entry points used to use', () => {
    // Guard the guard: the patterns must match what the audit found.
    const sample = [
      "import 'dotenv/config';",
      "  await import('dotenv/config');",
      "import * as dotenv from 'dotenv';",
      "import dotenv, { config } from 'dotenv';",
      "const d = require('dotenv');",
      'process.loadEnvFile();',
    ].join('\n');
    const found = [
      ...[...sample.matchAll(STATIC_FROM)].map((m) => bindingsOf(m[1]).join('+')),
      ...[...sample.matchAll(SIDE_EFFECT)].map((m) => m[1]),
      ...[...sample.matchAll(DYNAMIC)].map((m) => `${m[1]}(${m[2]})`),
      ...[...sample.matchAll(LOAD_ENV_FILE)].map(() => 'loadEnvFile'),
    ];
    expect(found).toEqual([
      '*',
      'default+config',
      'dotenv/config',
      'import(dotenv/config)',
      'require(dotenv)',
      'loadEnvFile',
    ]);
  });

  it('no runtime module or script imports dotenv (other than parse in the loader) or calls process.loadEnvFile()', () => {
    const offenders = sources
      .flatMap(dotenvUses)
      .filter(
        (use) =>
          !(
            use.at.startsWith(`${DOTENV_OWNER}:`) &&
            use.specifier === 'dotenv' &&
            use.bindings.length === 1 &&
            use.bindings[0] === 'parse'
          ),
      )
      .map((use) => `${use.at} ${use.bindings.join(',')} '${use.specifier}'`);
    expect(offenders).toEqual([]);
  });

  it('the trusted loader takes only dotenv.parse (pure: reads no file, sets no variable)', () => {
    expect(dotenvUses(DOTENV_OWNER).map(({ specifier, bindings }) => ({ specifier, bindings }))).toEqual([
      { specifier: 'dotenv', bindings: ['parse'] },
    ]);
  });

  it.each(ENTRY_POINTS)('%s loads credentials through bootstrapTrustedEnvForProcess()', (entry) => {
    expect(codeOf(entry)).toMatch(/\bbootstrapTrustedEnvForProcess\s*\(\s*\)/);
  });
});

/**
 * CONFIG.md is the reference for `~/.ironcurtain/config.json`. These checks
 * keep it complete and current against the schema the loader enforces
 * (`userConfigSchema` in src/config/user-config.ts):
 *
 * - Every setting the schema accepts, at any depth, is named in CONFIG.md:
 *   its full dotted path in a code span (`resourceBudget.maxSteps`, with a
 *   placeholder such as `<name>` for a record key), or its parent's path and
 *   its own key as code spans on one line (a field-table row for
 *   `...providerPreference` whose description lists `order`, `only` and
 *   `allowFallbacks`).
 * - Every field in the first column of a CONFIG.md table headed "Field" is a
 *   setting the schema accepts, so a renamed or removed key cannot linger.
 * - A "Default" cell that states a literal (`2`, `true`, `warn`, `[]`) is the
 *   value `loadUserConfig` applies when config.json does not set the field.
 * - The environment variables an operator sets are documented in a table
 *   headed "Variable", and every variable listed there is one the code uses.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { loadUserConfig, userConfigSchema } from '../src/config/user-config.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configDoc = readFileSync(join(projectRoot, 'CONFIG.md'), 'utf-8');

/** Path segment standing for any key of a record (CONFIG.md writes `<name>`, `<model>`, ...). */
const ANY_KEY = '<key>';

type KeyPath = readonly string[];

/** The schema a wrapper (optional, nullable, default, pipe, ...) describes. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodPrefault ||
      current instanceof z.ZodNonOptional ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodCatch
    ) {
      current = current.unwrap() as z.ZodType;
    } else if (current instanceof z.ZodPipe) {
      // `z.preprocess(fn, s)` pipes a transform into `s`; `s.transform(fn)`
      // pipes `s` into a transform. Either way the config file holds `s`.
      current = (current.in instanceof z.ZodTransform ? current.out : current.in) as z.ZodType;
    } else {
      return current;
    }
  }
}

/**
 * The keys below a schema node, each with the schemas it may hold: object
 * keys, the keys of an enum-keyed record, ANY_KEY for a record of objects,
 * and the keys of every union member. Empty for a leaf (a value, an array,
 * or a record of plain values such as `serverCredentials`).
 */
function childKeys(schema: z.ZodType): Map<string, z.ZodType[]> {
  const node = unwrap(schema);
  const keys = new Map<string, z.ZodType[]>();
  const add = (key: string, child: z.ZodType): void => {
    keys.set(key, [...(keys.get(key) ?? []), child]);
  };
  if (node instanceof z.ZodObject) {
    const shape = node.shape as Readonly<Record<string, z.ZodType>>;
    for (const [key, child] of Object.entries(shape)) add(key, child);
  } else if (node instanceof z.ZodRecord) {
    const keyType = unwrap(node.keyType as z.ZodType);
    const valueType = node.valueType as z.ZodType;
    if (keyType instanceof z.ZodEnum) {
      for (const key of keyType.options) add(String(key), valueType);
    } else if (childKeys(valueType).size > 0) {
      add(ANY_KEY, valueType);
    }
  } else if (node instanceof z.ZodUnion) {
    for (const option of node.options as readonly z.ZodType[]) {
      for (const [key, children] of childKeys(option)) for (const child of children) add(key, child);
    }
  }
  return keys;
}

/** Every setting path the schema accepts that has no settings below it. */
function leafPaths(schema: z.ZodType, prefix: KeyPath = []): KeyPath[] {
  const keys = childKeys(schema);
  if (keys.size === 0) return prefix.length === 0 ? [] : [prefix];
  const paths = new Map<string, KeyPath>();
  for (const [key, children] of keys) {
    for (const child of children) {
      for (const path of leafPaths(child, [...prefix, key])) paths.set(path.join('.'), path);
    }
  }
  return [...paths.values()];
}

/** Whether `path` (CONFIG.md spelling) names a node of the schema, leaf or not. */
function schemaHasPath(schema: z.ZodType, path: readonly string[]): boolean {
  if (path.length === 0) return true;
  const [head, ...rest] = path;
  const keys = childKeys(schema);
  const children = /^<[^<>\s]+>$/.test(head) ? keys.get(ANY_KEY) : keys.get(head);
  return (children ?? []).some((child) => schemaHasPath(child, rest));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex source matching a path as CONFIG.md writes it (any `<placeholder>` for ANY_KEY). */
function pathSource(path: KeyPath): string {
  return path.map((segment) => (segment === ANY_KEY ? '<[^<>\\s]+>' : escapeRegExp(segment))).join('\\.');
}

/** The lines of a markdown document outside fenced code blocks. */
function proseLines(markdown: string): string[] {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence === undefined) lines.push(line);
  }
  return lines;
}

/** The inline code spans of one line, trimmed. */
function codeSpans(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
}

/** The cells of a markdown table row, or undefined for a line that is not one. */
function tableCells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return undefined;
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/**
 * The first-column cells of every table whose header's first cell is
 * `header` (case-insensitive), for each data row.
 */
function firstColumn(lines: readonly string[], header: string): string[] {
  const cells: string[] = [];
  let inTable = false;
  for (let index = 0; index < lines.length; index++) {
    const row = tableCells(lines[index]);
    if (row === undefined) {
      inTable = false;
      continue;
    }
    const separator = tableCells(lines[index + 1] ?? '');
    if (!inTable && separator !== undefined && separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      inTable = row[0].replace(/`/g, '').toLowerCase() === header.toLowerCase();
      index++; // skip the separator row
      continue;
    }
    if (inTable) cells.push(row[0]);
  }
  return cells;
}

/**
 * The field and "Default" cell of every row of a table headed "Field" that
 * has a column headed "Default..." ("Default", "Default when enabled").
 */
function documentedDefaults(docLines: readonly string[]): { readonly field: string; readonly cell: string }[] {
  const rows: { field: string; cell: string }[] = [];
  /** undefined outside a table, -1 in a table without a Default column. */
  let defaultColumn: number | undefined;
  for (let index = 0; index < docLines.length; index++) {
    const row = tableCells(docLines[index]);
    if (row === undefined) {
      defaultColumn = undefined;
      continue;
    }
    const separator = tableCells(docLines[index + 1] ?? '');
    if (defaultColumn === undefined && separator !== undefined && separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const column = row.findIndex((cell) => /^default/i.test(cell));
      defaultColumn = row[0].toLowerCase() === 'field' && column > 0 ? column : -1;
      index++; // skip the separator row
      continue;
    }
    const field = /^`([^`]+)`$/.exec(row[0])?.[1];
    if (defaultColumn !== undefined && defaultColumn > 0 && field !== undefined) {
      rows.push({ field, cell: row[defaultColumn] ?? '' });
    }
  }
  return rows;
}

/** The literal a "Default" cell states in one code span (`2`, `true`, `null`, `[]`, `warn`), or undefined. */
function literalDefault(cell: string): { readonly value: unknown } | undefined {
  const code = /^`([^`]+)`$/.exec(cell)?.[1];
  if (code === undefined) return undefined;
  try {
    return { value: JSON.parse(code) as unknown };
  } catch {
    return { value: code };
  }
}

/** The value at a dotted path of a resolved config, or undefined. */
function valueAt(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Readonly<Record<string, unknown>>)[key];
  }
  return value;
}

const lines = proseLines(configDoc);
const spansByLine = lines.map(codeSpans);
const allSpans = spansByLine.flat();

/**
 * Whether CONFIG.md names `path`: its full path in a code span, or its
 * parent's full path and its own key as code spans on one line.
 */
function isDocumented(path: KeyPath): boolean {
  const full = new RegExp(`^${pathSource(path)}(?![\\w-])`);
  if (allSpans.some((span) => full.test(span))) return true;
  const key = path[path.length - 1];
  if (path.length < 2 || key === ANY_KEY) return false;
  const parent = new RegExp(`^${pathSource(path.slice(0, -1))}$`);
  return spansByLine.some((spans) => spans.some((span) => parent.test(span)) && spans.includes(key));
}

/** Every source file under src/, concatenated (to check that a documented variable is used). */
function sourceText(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|mts|mjs|js)$/.test(entry.name)) parts.push(readFileSync(path, 'utf-8'));
    }
  };
  walk(join(projectRoot, 'src'));
  return parts.join('\n');
}

/**
 * Environment variables an operator sets for IronCurtain itself (not for a
 * single MCP server or agent). Each must be listed in a "Variable" table.
 */
const OPERATOR_ENV_VARS = [
  'IRONCURTAIN_HOME',
  'IRONCURTAIN_ENV_FILE',
  'IRONCURTAIN_CONTAINER_RUNTIME',
  'IRONCURTAIN_DOCKER_AUTH',
  'IRONCURTAIN_SANDBOX_POLICY',
  'SANDBOX_POLICY',
  'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS',
  'IRONCURTAIN_WEB_UI_PORT',
  'ALLOWED_DIRECTORY',
  'AUDIT_LOG_PATH',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'ZAI_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'GOOGLE_API_BASE_URL',
] as const;

/**
 * The config `loadUserConfig` resolves for an IronCurtain home without a
 * config.json, with the operator variables above cleared (they override
 * keys, base URLs and the sandbox policy). Read-only: nothing is written.
 */
function resolvedDefaults(): unknown {
  const home = mkdtempSync(join(tmpdir(), 'ironcurtain-config-docs-'));
  const saved = new Map(OPERATOR_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of OPERATOR_ENV_VARS) delete process.env[name];
  process.env.IRONCURTAIN_HOME = home;
  try {
    return loadUserConfig({ readOnly: true });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

describe('CONFIG.md covers the config.json schema', () => {
  const leaves = leafPaths(userConfigSchema);

  it('finds the settings of the schema (sanity check of the walk)', () => {
    const names = leaves.map((path) => path.join('.'));
    expect(names).toContain('agentModelId');
    expect(names).toContain('resourceBudget.modelPricing.<key>.cacheWrite1hPerMillion');
    expect(names).toContain('modelProviders.profiles.<key>.providerPreference.allowFallbacks');
    expect(names).toContain('hostModelProfiles.contentAssessment');
    expect(names).toContain('dockerWorkload.resources.daemonShare');
    expect(names).toContain('serverCredentials');
    expect(names.length).toBeGreaterThan(100);
  });

  it('names every setting the schema accepts', () => {
    const missing = leaves.filter((path) => !isDocumented(path)).map((path) => path.join('.'));
    expect(missing, 'settings missing from CONFIG.md (name each in a code span)').toEqual([]);
  });

  it('lists only real settings in its field tables', () => {
    const fields = firstColumn(lines, 'Field').flatMap(codeSpans);
    expect(fields.length).toBeGreaterThan(50);
    const unknown = fields.filter((field) => !schemaHasPath(userConfigSchema, field.split('.')));
    expect(unknown, 'fields in CONFIG.md tables that config.json does not accept').toEqual([]);
  });

  it('states the defaults the loader applies', () => {
    const resolved = resolvedDefaults();
    const compared: string[] = [];
    const wrong: string[] = [];
    for (const { field, cell } of documentedDefaults(lines)) {
      if (field.includes('<')) continue; // an entry of a record (`modelPricing.<model>...`)
      const literal = literalDefault(cell);
      if (literal === undefined) continue; // prose such as `_(platform)_` or "Fresh enable: `packages`"
      const actual = valueAt(resolved, field.split('.'));
      // Unset fields the loader leaves absent mean "off" or "none" (capture.enabled, signal.*, hostModelProfiles.*).
      if (actual === undefined) continue;
      // An object default: `modelProviders.profiles` resolves with the implicit `native` profile.
      if (typeof literal.value === 'object' && literal.value !== null && !Array.isArray(literal.value)) continue;
      compared.push(field);
      if (JSON.stringify(actual) !== JSON.stringify(literal.value)) {
        wrong.push(`${field}: CONFIG.md says ${cell}, loadUserConfig applies ${JSON.stringify(actual)}`);
      }
    }
    expect(compared.length).toBeGreaterThan(50);
    expect(compared).toEqual(expect.arrayContaining(['packageInstall.quarantineDays', 'resourceBudget.maxSteps']));
    expect(wrong, 'CONFIG.md defaults that differ from the loaded defaults').toEqual([]);
  });

  it('documents the environment variables an operator sets', () => {
    const documented = new Set(firstColumn(lines, 'Variable').flatMap(codeSpans));
    const missing = OPERATOR_ENV_VARS.filter((name) => !documented.has(name));
    expect(missing, 'environment variables missing from the CONFIG.md variable tables').toEqual([]);
  });

  it('documents only environment variables the code uses', () => {
    const source = sourceText();
    const variables = firstColumn(lines, 'Variable').flatMap(codeSpans);
    expect(variables.length).toBeGreaterThanOrEqual(OPERATOR_ENV_VARS.length);
    const unused = variables.filter((name) => !source.includes(name));
    expect(unused, 'variables in CONFIG.md that no source file mentions').toEqual([]);
  });
});

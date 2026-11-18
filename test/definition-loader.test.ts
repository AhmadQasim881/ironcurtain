/**
 * Tests for `loadDefinition` in `src/workflow/definition-loader.ts`.
 *
 * Covers the three discriminated outcomes: ok (parse + validate succeed),
 * `kind: 'parse'` (file unreadable / malformed JSON-YAML), and
 * `kind: 'validate'` (parse succeeds but schema validation fails).
 *
 * The file can be one an imported or resumed run's checkpoint names, shipped
 * inside the imported directory (FU-07): a FIFO or device there must be refused
 * without blocking or reading it. Those cases run in a child process with a
 * hard timeout, because a blocking open would freeze this worker for good.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadDefinition } from '../src/workflow/definition-loader.js';
import { MAX_WORKFLOW_DEFINITION_BYTES } from '../src/workflow/discovery.js';
import { fifoSupported, makeFifo } from './helpers/fifo.js';

const loaderUrl = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'workflow', 'definition-loader.ts'),
).href;
const hasDevZero = process.platform !== 'win32' && existsSync('/dev/zero');

const MINIMAL_YAML = [
  'name: yaml-workflow',
  'description: yaml is fine too',
  'initial: done',
  'states:',
  '  done:',
  '    type: terminal',
  '    description: yaml terminal',
  '',
].join('\n');

interface ChildLoadResult {
  readonly ok: boolean;
  readonly kind?: string;
  readonly message?: string;
  readonly ms: number;
}

/**
 * Calls `loadDefinition` on each path in a separate Node process that is
 * killed after a hard timeout, so a blocking open fails the test instead of
 * hanging the worker. Put a FIFO first: a regressed (blocking) read then
 * stalls there and never reaches a device that it would read without end.
 */
function loadInChild(paths: readonly string[]): ChildLoadResult[] {
  const program = [
    `import { loadDefinition } from ${JSON.stringify(loaderUrl)};`,
    'const results = [];',
    'for (const path of JSON.parse(process.argv[1])) {',
    '  const started = Date.now();',
    '  const result = loadDefinition(path);',
    '  results.push({ ok: result.ok, kind: result.kind, message: result.message, ms: Date.now() - started });',
    '}',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n');
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', program, JSON.stringify(paths)],
    { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' },
  );
  expect(child.error, 'loadDefinition must return before the hard timeout').toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as ChildLoadResult[];
}

function writeJson(dir: string, filename: string, body: unknown): string {
  const filePath = resolve(dir, filename);
  writeFileSync(filePath, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf-8');
  return filePath;
}

describe('loadDefinition', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'def-loader-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ok with the validated definition for a well-formed file', () => {
    const path = writeJson(tmpDir, 'good.json', {
      name: 'tiny-workflow',
      description: 'A trivially-valid single-state workflow',
      initial: 'done',
      states: {
        done: {
          type: 'terminal',
          description: 'all good',
        },
      },
    });

    const result = loadDefinition(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrow
    expect(result.definition.name).toBe('tiny-workflow');
    expect(result.definition.initial).toBe('done');
  });

  it('returns ok for valid YAML', () => {
    const yamlPath = resolve(tmpDir, 'good.yaml');
    writeFileSync(
      yamlPath,
      [
        'name: yaml-workflow',
        'description: yaml is fine too',
        'initial: done',
        'states:',
        '  done:',
        '    type: terminal',
        '    description: yaml terminal',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = loadDefinition(yamlPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.name).toBe('yaml-workflow');
  });

  it('returns kind: parse when the file is missing', () => {
    const result = loadDefinition(resolve(tmpDir, 'nope.json'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('parse');
    expect(result.message).toMatch(/ENOENT|no such file/i);
  });

  it('returns kind: parse when JSON is malformed', () => {
    const path = writeJson(tmpDir, 'broken.json', '{ this is not json');

    const result = loadDefinition(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('parse');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('returns kind: validate with issues when schema validation fails', () => {
    // Missing `initial` and `states` -- both required by the schema.
    const path = writeJson(tmpDir, 'invalid.json', { name: 'bad', description: 'no states' });

    const result = loadDefinition(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('validate');
    // Message preserves the historical wording so callers (CLI, daemon)
    // can re-render it without modification.
    expect(result.message).toMatch(/^Workflow validation failed:/);
    expect(result.issues).toBeDefined();
    expect((result.issues ?? []).length).toBeGreaterThan(0);
  });

  it('returns kind: validate when the initial state is missing from states', () => {
    // Schema-shaped but semantically invalid: `initial: nope` references
    // a state not in `states`.
    const path = writeJson(tmpDir, 'dangling.json', {
      name: 'dangling',
      description: 'initial points nowhere',
      initial: 'nope',
      states: {
        done: {
          type: 'terminal',
          description: 'unreachable',
        },
      },
    });

    const result = loadDefinition(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('validate');
  });

  it('follows a symlinked manifest to a regular file', () => {
    const real = resolve(tmpDir, 'real.yaml');
    writeFileSync(real, MINIMAL_YAML);
    symlinkSync(real, resolve(tmpDir, 'linked.yaml'));

    const result = loadDefinition(resolve(tmpDir, 'linked.yaml'));
    expect(result.ok).toBe(true);
  });

  it('refuses an unsupported extension, a directory and an oversized file', () => {
    writeFileSync(resolve(tmpDir, 'workflow.txt'), MINIMAL_YAML);
    mkdirSync(resolve(tmpDir, 'dir.yaml'));
    const big = resolve(tmpDir, 'big.yaml');
    writeFileSync(big, MINIMAL_YAML);
    // Sparse: the size check refuses it before any byte is read.
    truncateSync(big, MAX_WORKFLOW_DEFINITION_BYTES + 1);

    expect(loadDefinition(resolve(tmpDir, 'workflow.txt'))).toMatchObject({
      ok: false,
      kind: 'parse',
      message: 'Unsupported workflow file extension: .txt',
    });
    expect(loadDefinition(resolve(tmpDir, 'dir.yaml'))).toMatchObject({
      ok: false,
      kind: 'parse',
      message: expect.stringContaining('not a regular file'),
    });
    expect(loadDefinition(big)).toMatchObject({
      ok: false,
      kind: 'parse',
      message: expect.stringContaining(`larger than ${MAX_WORKFLOW_DEFINITION_BYTES} bytes`),
    });
  });

  it.skipIf(!fifoSupported || !hasDevZero)(
    'refuses a FIFO, /dev/zero and links to them promptly, without blocking or reading them',
    () => {
      const fifo = resolve(tmpDir, 'def.yaml');
      makeFifo(fifo);
      symlinkSync(fifo, resolve(tmpDir, 'fifo-link.json'));
      symlinkSync('/dev/zero', resolve(tmpDir, 'zero.yaml'));

      const results = loadInChild([fifo, resolve(tmpDir, 'fifo-link.json'), '/dev/zero', resolve(tmpDir, 'zero.yaml')]);

      expect(results).toHaveLength(4);
      for (const result of results) {
        expect(result).toMatchObject({ ok: false, kind: 'parse' });
        expect(result.ms).toBeLessThan(2_000);
      }
      expect(results[0].message).toContain('not a regular file');
      expect(results[1].message).toContain('not a regular file');
      // No extension: refused before the device is ever opened.
      expect(results[2].message).toBe('Unsupported workflow file extension: ');
      expect(results[3].message).toContain('not a regular file');
    },
    40_000,
  );
});

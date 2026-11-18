/**
 * Unattended memory writers and the memory server's review quarantine (FU-05).
 *
 * For a cron job or a workflow state the host sets MEMORY_WRITER_SCOPE and
 * relies on the memory server to hold what the run writes for review. A
 * server from before the quarantine (the published 0.2.1, or a checkout
 * whose workspace package was not rebuilt) ignores the variable and files the
 * run's memories among those interactive sessions read. The host therefore
 * refuses to start one for an unattended writer, and the doctor reports it.
 * Interactive sessions are not affected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The probe resolves the installed package, which differs between machines
// (built workspace, stale checkout, npm release); the tests set its answer.
vi.mock('../src/memory/memory-server-exports.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/memory/memory-server-exports.js')>();
  return { ...actual, memoryServerHasReviewQuarantine: vi.fn(() => true) };
});

import { buildMemoryServerConfig, type MemoryWriter } from '../src/memory/memory-annotations.js';
import { memoryServerHasReviewQuarantine } from '../src/memory/memory-server-exports.js';
import { checkMemoryReviewQuarantine } from '../src/doctor/checks.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { testUserConfig } from './helpers/user-config.js';

const CRON: MemoryWriter = { kind: 'cron', sessionId: 'run-1', scope: 'job:x' };
const WORKFLOW: MemoryWriter = { kind: 'workflow', sessionId: 'state-1', scope: 'workflow:wf1' };
const INTERACTIVE: MemoryWriter = { kind: 'interactive', sessionId: 'session-1' };

const probe = vi.mocked(memoryServerHasReviewQuarantine);

describe('buildMemoryServerConfig with a memory server that predates the review quarantine', () => {
  beforeEach(() => {
    probe.mockReset();
    probe.mockReturnValue(false);
  });

  it('refuses a cron or workflow writer, saying how to update the server', () => {
    for (const writer of [CRON, WORKFLOW]) {
      expect(() => buildMemoryServerConfig({ dbPath: '/tmp/test.db', writer })).toThrow(
        /predates the review quarantine.*npm run build -w packages\/memory-mcp-server/,
      );
    }
    expect(() => buildMemoryServerConfig({ dbPath: '/tmp/test.db', writer: CRON })).toThrow('for this cron job');
    expect(() => buildMemoryServerConfig({ dbPath: '/tmp/test.db', writer: WORKFLOW })).toThrow('for this workflow');
  });

  it('still builds an interactive writer, and a server without a writer, without asking', () => {
    const env = buildMemoryServerConfig({ dbPath: '/tmp/test.db', writer: INTERACTIVE }).env;
    expect(env).toMatchObject({ MEMORY_WRITER_KIND: 'interactive', MEMORY_SESSION_ID: 'session-1' });
    expect(env?.MEMORY_WRITER_SCOPE).toBeUndefined();
    expect(buildMemoryServerConfig({ dbPath: '/tmp/test.db' }).env?.MEMORY_WRITER_KIND).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('buildMemoryServerConfig with a memory server that has the review quarantine', () => {
  beforeEach(() => {
    probe.mockReset();
    probe.mockReturnValue(true);
  });

  it('passes an unattended writer its review scope', () => {
    expect(buildMemoryServerConfig({ dbPath: '/tmp/test.db', writer: CRON }).env).toMatchObject({
      MEMORY_WRITER_KIND: 'cron',
      MEMORY_SESSION_ID: 'run-1',
      MEMORY_WRITER_SCOPE: 'job:x',
    });
    expect(buildMemoryServerConfig({ dbPath: '/tmp/test.db', writer: WORKFLOW }).env?.MEMORY_WRITER_SCOPE).toBe(
      'workflow:wf1',
    );
    expect(probe).toHaveBeenCalled();
  });
});

// The real probe, against stand-in installations of the package.
describe('memoryServerHasReviewQuarantine', () => {
  let root: string;
  let realProbe: typeof memoryServerHasReviewQuarantine;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ironcurtain-memory-exports-'));
    const actual = await vi.importActual<typeof import('../src/memory/memory-server-exports.js')>(
      '../src/memory/memory-server-exports.js',
    );
    realProbe = actual.memoryServerHasReviewQuarantine;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** An installed @provos/memory-mcp-server with these exports and files; returns a module URL beside it. */
  function install(exports: Record<string, string>, files: readonly string[]): URL {
    const pkg = join(root, 'node_modules', '@provos', 'memory-mcp-server');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@provos/memory-mcp-server', exports }));
    for (const file of files) {
      mkdirSync(dirname(join(pkg, file)), { recursive: true });
      writeFileSync(join(pkg, file), 'export {};\n');
    }
    return pathToFileURL(join(root, 'host.js'));
  }

  const CURRENT_EXPORTS = {
    '.': './dist/index.js',
    './prompts': './dist/prompts.js',
    './models': './dist/models/cli.js',
    './admin': './dist/admin.js',
  };

  it('is true for a package built with the quarantine', () => {
    expect(realProbe(install(CURRENT_EXPORTS, ['dist/index.js', 'dist/admin.js']))).toBe(true);
  });

  it('is false for a release from before it (0.2.1 exports no ./admin)', () => {
    const from = install({ '.': './dist/index.js', './prompts': './dist/prompts.js' }, ['dist/index.js']);
    expect(realProbe(from)).toBe(false);
  });

  it('is false for a checkout whose dist was built before it', () => {
    expect(realProbe(install(CURRENT_EXPORTS, ['dist/index.js', 'dist/prompts.js']))).toBe(false);
  });

  it('is false when the package is not installed', () => {
    expect(realProbe(pathToFileURL(join(root, 'host.js')))).toBe(false);
  });
});

describe('checkMemoryReviewQuarantine (doctor)', () => {
  function config(enabled: boolean): IronCurtainConfig {
    const userConfig = testUserConfig({
      memory: { enabled, autoSave: true, llmBaseUrl: undefined, llmApiKey: undefined, offlineModels: false },
    });
    return { userConfig } as unknown as IronCurtainConfig;
  }

  it('fails when the installed memory server predates the quarantine', () => {
    const result = checkMemoryReviewQuarantine(config(true), () => false);
    expect(result).toMatchObject({
      name: 'Memory review quarantine',
      status: 'fail',
      message: expect.stringContaining('cron jobs and workflows with memory refuse to start'),
    });
    expect(result.hint).toContain('npm run build -w packages/memory-mcp-server');
  });

  it('passes when it has the quarantine', () => {
    expect(checkMemoryReviewQuarantine(config(true), () => true)).toMatchObject({ status: 'ok' });
  });

  it('skips without asking when memory is disabled', () => {
    const ask = vi.fn(() => false);
    expect(checkMemoryReviewQuarantine(config(false), ask)).toMatchObject({ status: 'skip' });
    expect(ask).not.toHaveBeenCalled();
  });
});

/**
 * `ironcurtain annotate-tools --check` (WP-27): compares the effective tool
 * annotations with the live tools of the configured servers, without the
 * LLM, and exits 1 on drift. The configured servers are replaced by
 * test/fixtures/cwd-probe-server.mjs and the package annotations by a temp
 * file, so the check spawns one small stdio server. The annotations below
 * describe every tool the fixture lists.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MCPServerConfig } from '../src/config/types.js';
import type { StoredToolAnnotationsFile } from '../src/pipeline/types.js';

interface ConfigOverride {
  servers: Record<string, MCPServerConfig>;
  generatedDir: string;
  packageGeneratedDir: string;
}
const override: ConfigOverride = vi.hoisted(() => ({ servers: {}, generatedDir: '', packageGeneratedDir: '' }));
vi.mock('../src/pipeline/pipeline-shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline/pipeline-shared.js')>();
  return {
    ...actual,
    loadPipelineConfig: (...args: Parameters<typeof actual.loadPipelineConfig>) => ({
      ...actual.loadPipelineConfig(...args),
      mcpServers: override.servers,
      generatedDir: override.generatedDir,
      packageGeneratedDir: override.packageGeneratedDir,
    }),
  };
});

import { main as annotateMain } from '../src/pipeline/annotate.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE: MCPServerConfig = {
  command: process.execPath,
  args: [resolve(projectRoot, 'test/fixtures/cwd-probe-server.mjs')],
  sandbox: false,
};

function annotations(reportEnvArgs: Record<string, ['none']>): StoredToolAnnotationsFile {
  return {
    generatedAt: '',
    servers: {
      probe: {
        inputHash: 'h',
        source: 'package',
        tools: [
          {
            toolName: 'report_cwd',
            serverName: 'probe',
            comment: 'cwd',
            args: {},
            inputSchema: { type: 'object', properties: {} },
          },
          {
            toolName: 'report_env',
            serverName: 'probe',
            comment: 'env',
            args: reportEnvArgs,
            inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          },
          {
            toolName: 'report_env_all',
            serverName: 'probe',
            comment: 'whole env',
            args: {},
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    },
  };
}

describe('annotate-tools --check', () => {
  let root: string;
  let output: string[];
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ic-annotate-check-'));
    override.generatedDir = join(root, 'generated');
    override.packageGeneratedDir = join(root, 'package');
    mkdirSync(override.generatedDir);
    mkdirSync(override.packageGeneratedDir);
    override.servers = { probe: PROBE };
    // A throwaway allowed directory for the pipeline config (discovery itself
    // points the filesystem server at an empty directory of its own).
    vi.stubEnv('ALLOWED_DIRECTORY', join(root, 'sandbox'));
    vi.stubEnv('IRONCURTAIN_HOME', join(root, 'home'));
    output = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function writePackage(file: StoredToolAnnotationsFile): void {
    writeFileSync(join(override.packageGeneratedDir, 'tool-annotations.json'), JSON.stringify(file));
  }

  it('passes when the annotations describe the live tools', async () => {
    writePackage(annotations({ name: ['none'] }));
    await annotateMain(['--check']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(output.join('\n')).toContain('Tool annotations match the live servers.');
  }, 30_000);

  it('exits 1 and names the drifted arguments and the command when they do not', async () => {
    // Annotated for a release whose report_env argument was called `variable`.
    writePackage(annotations({ variable: ['none'] }));
    await annotateMain(['--check', '--server', 'probe']);
    expect(process.exitCode).toBe(1);
    const text = output.join('\n');
    expect(text).toContain('report_env (unannotated: name; removed: variable');
    expect(text).toContain('ironcurtain annotate-tools --server probe');
    expect(text).toContain('Tool annotations have drifted from the live servers.');
  }, 30_000);

  it('exits 1 when the requested server cannot be started', async () => {
    writePackage(annotations({ name: ['none'] }));
    override.servers = { probe: { command: join(root, 'missing-binary'), args: [], sandbox: false } };
    await annotateMain(['--check', '--server', 'probe']);
    expect(process.exitCode).toBe(1);
    expect(output.join('\n')).toContain("failed to connect to server 'probe'");
  }, 30_000);
});

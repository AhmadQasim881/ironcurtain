/**
 * `ironcurtain annotate-tools` end to end (WP-88), with the LLM faked and the
 * configured servers replaced by test/fixtures/cwd-probe-server.mjs (three
 * tools) under two names:
 *
 *  - PIP-21: with `--all`, a server that fails to annotate no longer discards
 *    the others' fresh annotations: they are written, the failed server is
 *    named, and the run exits 1;
 *  - GAP1-9: tools whose name, description and input schema are unchanged
 *    keep their previous annotations verbatim (only the new tool goes to the
 *    LLM, at temperature 0), and `--diff` prints the role changes.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3 } from '@ai-sdk/provider';

import type { MCPServerConfig } from '../src/config/types.js';
import type { StoredToolAnnotation, StoredToolAnnotationsFile } from '../src/pipeline/types.js';

interface Override {
  servers: Record<string, MCPServerConfig>;
  generatedDir: string;
  packageGeneratedDir: string;
  model: LanguageModelV3 | undefined;
}
const override: Override = vi.hoisted(() => ({
  servers: {},
  generatedDir: '',
  packageGeneratedDir: '',
  model: undefined,
}));
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
    createPipelineLlm: (generatedDir: string) => {
      if (!override.model) throw new Error('no fake model configured');
      return Promise.resolve({
        model: override.model,
        baseLlm: override.model,
        logContext: { stepName: '' },
        logPath: join(generatedDir, 'llm-interactions.jsonl'),
        cacheStrategy: { wrapSystemPrompt: (prompt: string) => prompt },
      });
    },
  };
});

import { main as annotateMain } from '../src/pipeline/annotate.js';
import { connectForToolDiscovery, disconnectAll } from '../src/pipeline/live-tools.js';
import { annotationPromptVersion, computeToolAnnotationKey } from '../src/pipeline/tool-annotator.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE: MCPServerConfig = {
  command: process.execPath,
  args: [resolve(projectRoot, 'test/fixtures/cwd-probe-server.mjs')],
  sandbox: false,
};

/** One recorded LLM call: the server and tools it was asked about, and its temperature. */
interface AnnotateCall {
  readonly server: string;
  readonly tools: string[];
  readonly temperature: number | undefined;
}

/** Annotates whatever tools the prompt lists; fails for the servers in `failFor`. */
function fakeAnnotator(failFor: ReadonlySet<string> = new Set()) {
  const calls: AnnotateCall[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      const server = /tool on the \\"([^"\\]+)\\" server/.exec(prompt)?.[1] ?? '?';
      const tools = [...prompt.matchAll(/Tool: ([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      calls.push({ server, tools, temperature: options.temperature });
      if (failFor.has(server)) throw new Error(`LLM unavailable for ${server}`);
      const annotations = tools.map((toolName) => ({
        toolName,
        comment: `LLM: ${toolName}`,
        args: toolName === 'report_env' ? { name: ['none'] } : {},
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ annotations }) }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        },
        warnings: [],
        request: {},
        response: { id: 'r', modelId: 'fake', timestamp: new Date(0) },
      };
    },
  });
  return { model, calls };
}

describe('annotate-tools', () => {
  let root: string;
  let output: string[];
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ic-annotate-update-'));
    override.generatedDir = join(root, 'generated');
    override.packageGeneratedDir = join(root, 'package');
    mkdirSync(override.generatedDir);
    mkdirSync(override.packageGeneratedDir);
    override.servers = { alpha: PROBE, beta: PROBE };
    override.model = undefined;
    vi.stubEnv('ALLOWED_DIRECTORY', join(root, 'sandbox'));
    vi.stubEnv('IRONCURTAIN_HOME', join(root, 'home'));
    output = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    savedExitCode = process.exitCode;
    // No shipped annotations for the probe servers: every server needs the LLM.
    writeFileSync(
      join(override.packageGeneratedDir, 'tool-annotations.json'),
      JSON.stringify({ generatedAt: '', servers: {} } satisfies StoredToolAnnotationsFile),
    );
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function overlay(): StoredToolAnnotationsFile {
    return JSON.parse(
      readFileSync(join(override.generatedDir, 'tool-annotations.json'), 'utf-8'),
    ) as StoredToolAnnotationsFile;
  }

  it('--all: a failure on the last server keeps the earlier servers’ new annotations and exits 1', async () => {
    const fake = fakeAnnotator(new Set(['beta']));
    override.model = fake.model;

    await annotateMain(['--all']);

    expect(process.exitCode).toBe(1);
    expect(fake.calls.map((c) => c.server)).toEqual(['alpha', 'beta']);
    const written = overlay();
    expect(Object.keys(written.servers)).toEqual(['alpha']);
    expect(written.servers.alpha.tools.map((t) => t.toolName)).toEqual(['report_cwd', 'report_env', 'report_env_all']);
    const text = output.join('\n');
    expect(text).toContain('Annotation failed for: beta');
    expect(text).toContain('LLM unavailable for beta');
    expect(text).toContain('calls that use them are denied');
    expect(text).not.toContain('Tool annotation successful!');

    // The retry annotates only the failed server: alpha is cached.
    const retry = fakeAnnotator();
    override.model = retry.model;
    process.exitCode = undefined;
    await annotateMain(['--all']);
    expect(process.exitCode).toBeUndefined();
    expect(output.join('\n')).toContain('Tool annotation successful!');
    expect(retry.calls.map((c) => c.server)).toEqual(['beta']);
    expect(Object.keys(overlay().servers).sort()).toEqual(['alpha', 'beta']);
  }, 30_000);

  it('re-annotates only the tool that is new, at temperature 0, and --diff prints the change', async () => {
    // Shipped, reviewed annotations made for two of the probe's three tools.
    const live = await connectForToolDiscovery('alpha', PROBE);
    const tools = live.tools;
    await disconnectAll([live]);
    const version = annotationPromptVersion('alpha');
    const reviewed: StoredToolAnnotation[] = tools
      .filter((t) => t.name !== 'report_env_all')
      .map((t): StoredToolAnnotation => ({
        toolName: t.name,
        serverName: 'alpha',
        comment: `reviewed: ${t.name}`,
        args: t.name === 'report_env' ? { name: ['none'] } : {},
        inputSchema: t.inputSchema,
        annotationKey: computeToolAnnotationKey(t, version),
      }));
    writeFileSync(
      join(override.packageGeneratedDir, 'tool-annotations.json'),
      JSON.stringify({
        generatedAt: '',
        servers: { alpha: { inputHash: 'annotated-for-an-older-release', source: 'package', tools: reviewed } },
      } satisfies StoredToolAnnotationsFile),
    );
    const fake = fakeAnnotator();
    override.model = fake.model;

    await annotateMain(['--server', 'alpha', '--diff']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(fake.calls).toEqual([{ server: 'alpha', tools: ['report_env_all'], temperature: 0 }]);
    const entry = overlay().servers.alpha;
    expect(entry.tools.slice(0, 2)).toEqual(reviewed);
    expect(entry.tools[2]).toMatchObject({ toolName: 'report_env_all', comment: 'LLM: report_env_all' });
    const text = output.join('\n');
    expect(text).toContain('alpha: 0 changed, 1 added, 0 removed, 2 unchanged');
    expect(text).toContain('  + report_env_all -- LLM: report_env_all');
    expect(text).toContain('1 tool(s) annotated by the LLM, 2 unchanged tool(s) kept');
    expect(existsSync(join(override.generatedDir, 'tool-annotations.json'))).toBe(true);
  }, 30_000);

  it('needs no model when every live tool keeps its annotation', async () => {
    // Reviewed annotations for all three tools, recorded for another tool list
    // (inputHash differs), so the server is annotated rather than adopted.
    const live = await connectForToolDiscovery('alpha', PROBE);
    const tools = live.tools;
    await disconnectAll([live]);
    const version = annotationPromptVersion('alpha');
    const reviewed: StoredToolAnnotation[] = tools.map((t): StoredToolAnnotation => ({
      toolName: t.name,
      serverName: 'alpha',
      comment: `reviewed: ${t.name}`,
      args: t.name === 'report_env' ? { name: ['none'] } : {},
      inputSchema: t.inputSchema,
      annotationKey: computeToolAnnotationKey(t, version),
    }));
    writeFileSync(
      join(override.packageGeneratedDir, 'tool-annotations.json'),
      JSON.stringify({
        generatedAt: '',
        servers: { alpha: { inputHash: 'annotated-with-a-tool-since-removed', source: 'package', tools: reviewed } },
      } satisfies StoredToolAnnotationsFile),
    );
    // No model configured: creating the LLM fails, as without credentials.
    override.model = undefined;

    await annotateMain(['--server', 'alpha']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(overlay().servers.alpha.tools).toEqual(reviewed);
    const text = output.join('\n');
    expect(text).toContain('0 tool(s) annotated by the LLM, 3 unchanged tool(s) kept');
    expect(text).not.toContain('LLM interaction log');
  }, 30_000);
});

/**
 * The pipeline side of the broad-policy checks, driven end to end with the
 * golden fake-LLM fixture (no network, no real LLM):
 *  - the `validateCompiled` hook receives the merged dynamic lists AND the
 *    stored tool annotations the run compiled against, so the persona
 *    validator can tell which tools and argument roles each rule reaches;
 *  - list resolution prints every added value for review;
 *  - a cached list value that today's rules refuse (an IP literal, a wildcard
 *    over a multi-tenant hosting suffix) does not survive a recompile.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LIST_TYPE_REGISTRY } from '../src/pipeline/dynamic-list-types.js';
import { PipelineRunner, type PipelineRunConfig } from '../src/pipeline/pipeline-runner.js';
import type {
  CompiledPolicyFile,
  DynamicListsFile,
  ServerCompiledPolicyFile,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';
import { createFakePipelineModels, createScriptedPipelineModels } from './fixtures/fake-pipeline-models.js';
import {
  GOLDEN_ALLOWED_DIR,
  GOLDEN_ANNOTATIONS,
  GOLDEN_CONSTITUTION,
  GOLDEN_RESPONSES,
} from './fixtures/golden-pipeline-fixture.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface HookCall {
  readonly policy: CompiledPolicyFile;
  readonly lists: DynamicListsFile | undefined;
  readonly annotations: StoredToolAnnotationsFile;
}

function makeRun(outputDir: string, calls: HookCall[]): { runner: PipelineRunner; config: PipelineRunConfig } {
  const logPath = resolve(outputDir, '..', 'llm-interactions.jsonl');
  const config: PipelineRunConfig = {
    constitutionInput: GOLDEN_CONSTITUTION,
    constitutionKind: 'constitution',
    outputDir,
    toolAnnotationsDir: outputDir,
    allowedDirectory: GOLDEN_ALLOWED_DIR,
    protectedPaths: [],
    preloadedStoredAnnotations: GOLDEN_ANNOTATIONS,
    includeHandwrittenScenarios: false,
    llmLogPath: logPath,
    validateCompiled: (policy, lists, annotations) => {
      calls.push({ policy, lists, annotations });
    },
  };
  return { runner: new PipelineRunner(createFakePipelineModels(GOLDEN_RESPONSES, logPath)), config };
}

function newOutputDir(): string {
  const workDir = mkdtempSync(resolve(tmpdir(), 'ic-broad-inputs-'));
  dirs.push(workDir);
  const outputDir = resolve(workDir, 'generated');
  mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

describe('pipeline inputs for the broad-policy validator', () => {
  it('passes the merged lists and the stored annotations to validateCompiled, and prints added values', async () => {
    const outputDir = newOutputDir();
    const calls: HookCall[] = [];
    const printed: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      printed.push(String(message));
    });

    const { runner, config } = makeRun(outputDir, calls);
    await runner.run(config);

    expect(calls).toHaveLength(1);
    expect(calls[0].annotations).toBe(GOLDEN_ANNOTATIONS);
    expect(calls[0].lists?.lists['trusted-news-sites'].values).toEqual([
      'nytimes.com',
      'bbc.com',
      'reuters.com',
      '*.nytimes.com',
      '*.bbc.com',
      '*.reuters.com',
    ]);
    expect(printed).toContain('  @trusted-news-sites: 6 value(s), 6 added, 0 removed');
    expect(printed).toContain('    + nytimes.com, bbc.com, reuters.com, *.nytimes.com, *.bbc.com, *.reuters.com');
  });

  it('drops a cached list value that the current rules refuse before validation and write', async () => {
    const outputDir = newOutputDir();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = makeRun(outputDir, []);
    await first.runner.run(first.config);

    // Simulate a list cached under older, looser rules.
    const cachedPath = resolve(outputDir, 'servers', 'fetch', 'dynamic-lists.json');
    const cached = JSON.parse(readFileSync(cachedPath, 'utf-8')) as DynamicListsFile;
    const stale = cached.lists['trusted-news-sites'];
    writeFileSync(
      cachedPath,
      JSON.stringify({
        ...cached,
        lists: {
          'trusted-news-sites': { ...stale, values: [...stale.values, '*.github.io', '169.254.169.254'] },
        },
      }),
    );

    const calls: HookCall[] = [];
    const second = makeRun(outputDir, calls);
    await second.runner.run(second.config);

    const expected = ['nytimes.com', 'bbc.com', 'reuters.com', '*.nytimes.com', '*.bbc.com', '*.reuters.com'];
    expect(calls[0].lists?.lists['trusted-news-sites'].values).toEqual(expected);
    const written = JSON.parse(readFileSync(resolve(outputDir, 'dynamic-lists.json'), 'utf-8')) as DynamicListsFile;
    expect(written.lists['trusted-news-sites'].values).toEqual(expected);
  });

  it('re-validates the lists of a fully cached server (rules tightened since it was verified)', async () => {
    const outputDir = newOutputDir();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const logPath = resolve(outputDir, '..', 'llm-interactions.jsonl');
    const responses = {
      ...GOLDEN_RESPONSES,
      listResolution: { values: ['nytimes.com', 'bbc.com', 'reuters.com', '*.github.io'] },
    };
    const serverPolicyPath = (dir: string): string => resolve(dir, 'servers', 'fetch', 'compiled-policy.json');

    // The compiler inputs hash of a current compile, as its verified commit records it.
    const probeDir = newOutputDir();
    const probe = makeRun(probeDir, []);
    await probe.runner.run(probe.config);
    const currentInputHash = (JSON.parse(readFileSync(serverPolicyPath(probeDir), 'utf-8')) as ServerCompiledPolicyFile)
      .inputHash;

    // First compile under looser rules: an older release accepted any hostname
    // pattern and had no policy lint, so the wildcard was resolved, verified and
    // cached. Simulated with a permissive validator and the broad-domains
    // opt-in; the opt-in also changes the compiler prompt, so the commit then
    // gets the inputs hash a current compile computes (rulesHash covers only
    // the rules and list definitions).
    const domains = LIST_TYPE_REGISTRY.get('domains') as { validate: (value: string) => boolean };
    const currentValidate = domains.validate;
    domains.validate = () => true;
    try {
      const first = makeRun(outputDir, []);
      await new PipelineRunner(createFakePipelineModels(responses, logPath)).run({
        ...first.config,
        allowBroadDomains: true,
      });
    } finally {
      domains.validate = currentValidate;
    }
    const commit = JSON.parse(readFileSync(serverPolicyPath(outputDir), 'utf-8')) as ServerCompiledPolicyFile;
    writeFileSync(serverPolicyPath(outputDir), JSON.stringify({ ...commit, inputHash: currentInputHash }));
    const cached = JSON.parse(
      readFileSync(resolve(outputDir, 'servers', 'fetch', 'dynamic-lists.json'), 'utf-8'),
    ) as DynamicListsFile;
    expect(cached.lists['trusted-news-sites'].values).toContain('*.github.io');

    // Reuse the rules without recompiling, but re-verify their scenarios:
    // removing a previously accepted value changes the served list and its
    // completeness, so the old scenario hash cannot remain a cache hit.
    const calls: HookCall[] = [];
    const second = makeRun(outputDir, calls);
    const reverify = createScriptedPipelineModels(
      {
        scenarios: [GOLDEN_RESPONSES.scenarios],
        judge: [GOLDEN_RESPONSES.judge],
      },
      logPath,
    );
    await new PipelineRunner(reverify.models).run(second.config);
    expect(reverify.calls.map((call) => call.phase)).toEqual(['scenarios', 'judge']);

    expect(calls[0].lists?.lists['trusted-news-sites'].values).not.toContain('*.github.io');
    const written = JSON.parse(readFileSync(resolve(outputDir, 'dynamic-lists.json'), 'utf-8')) as DynamicListsFile;
    expect(written.lists['trusted-news-sites'].values).not.toContain('*.github.io');
    expect(written.lists['trusted-news-sites'].values).toContain('nytimes.com');
    expect(written.lists['trusted-news-sites'].resolutionState).toBe('incomplete');
  });
});

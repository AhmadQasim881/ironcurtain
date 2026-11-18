/**
 * WP-88 / PIP-20: LLM output cut off at its output-token cap (finish reason
 * "length") is detected everywhere the pipeline parses a response. The
 * request is repeated once with a larger cap; when that is cut off too, the
 * call fails with a distinct "output truncated at N tokens" error instead of
 * the JSON or schema error the cut-off text would cause (which the runner
 * used to report as a plain SyntaxError after a pointless "fix the errors"
 * turn under the same cap).
 *
 * Covered: ConstitutionCompilerSession (compile, recompile, point-fix),
 * PolicyVerifierSession.judgeRound, data-backed list resolution, and the
 * runner's report of a server whose compile output never fits.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { ConstitutionCompilerSession } from '../src/pipeline/constitution-compiler.js';
import {
  DEFAULT_MAX_TOKENS,
  OUTPUT_TRUNCATED,
  TRUNCATION_RETRY_MAX_TOKENS,
} from '../src/pipeline/generate-with-repair.js';
import { resolveList } from '../src/pipeline/list-resolver.js';
import { PolicyVerifierSession } from '../src/pipeline/policy-verifier.js';
import { PipelineRunner, type PipelineRunConfig } from '../src/pipeline/pipeline-runner.js';
import type { ServerProgressReporter } from '../src/pipeline/pipeline-shared.js';
import type { FailedServer, RepairContext } from '../src/pipeline/types.js';
import { createScriptedPipelineModels, truncatedReply } from './fixtures/fake-pipeline-models.js';
import { CONSTITUTION, FS_ONLY, FS_TOOLS, GOOD_FS, SANDBOX } from './fixtures/two-server-pipeline-fixture.js';

// ---------------------------------------------------------------------------
// A model replaying text replies, each optionally cut off at the cap
// ---------------------------------------------------------------------------

interface Reply {
  readonly text: string;
  readonly truncated?: boolean;
}

interface RecordedCall {
  readonly maxOutputTokens: number | undefined;
  /** Number of user and assistant messages sent. */
  readonly messages: number;
  readonly lastUserText: string;
}

function textOfLastUser(options: LanguageModelV3CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i--) {
    const msg = options.prompt[i];
    if (msg.role === 'user') return msg.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
  return '';
}

function replayModel(replies: readonly Reply[]) {
  const calls: RecordedCall[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push({
        maxOutputTokens: options.maxOutputTokens,
        messages: options.prompt.filter((m) => m.role === 'user' || m.role === 'assistant').length,
        lastUserText: textOfLastUser(options),
      });
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      return {
        content: [{ type: 'text' as const, text: reply.text }],
        finishReason: reply.truncated
          ? { unified: 'length' as const, raw: 'max_tokens' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 50, text: undefined, reasoning: undefined },
        },
        warnings: [],
        request: {},
        response: { id: `r-${calls.length}`, modelId: 'test-model', timestamp: new Date(0) },
      };
    },
  });
  return { model, calls };
}

const caps = (calls: readonly RecordedCall[]): Array<number | undefined> => calls.map((c) => c.maxOutputTokens);

/** A rule set cut off in the middle, as a model stopped at its output cap returns it. */
const CUT_OFF_RULES = '{"rules": [{"name": "allow-fs-reads", "description": "Allow re';
const RULES = JSON.stringify({ rules: GOOD_FS.rules, listDefinitions: [] });

function compilerSession(model: MockLanguageModelV3): ConstitutionCompilerSession {
  return new ConstitutionCompilerSession({
    system: 'You are compiling a security policy (test).',
    model,
    annotations: FS_TOOLS,
    schemaOptions: { requireServer: true },
  });
}

const REPAIR_CONTEXT: RepairContext = { failedScenarios: [], judgeAnalysis: 'Tighten the rules.', attemptNumber: 1 };

// ---------------------------------------------------------------------------
// Constitution compiler session
// ---------------------------------------------------------------------------

describe('ConstitutionCompilerSession with truncated output', () => {
  it('repeats a cut-off compile with the larger cap and keeps the conversation consistent', async () => {
    const { model, calls } = replayModel([{ text: CUT_OFF_RULES, truncated: true }, { text: RULES }]);
    const session = compilerSession(model);

    const output = await session.compile();

    expect(output.rules.map((r) => r.name)).toEqual(['allow-fs-reads']);
    expect(caps(calls)).toEqual([DEFAULT_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS]);
    expect(calls[1].lastUserText).not.toContain('failed schema validation');
    expect(session.turnCount).toBe(1);
  });

  it('fails with the truncation error, not a JSON error, and leaves no dangling turn', async () => {
    const { model, calls } = replayModel([
      { text: CUT_OFF_RULES, truncated: true },
      { text: CUT_OFF_RULES, truncated: true },
      { text: RULES },
    ]);
    const session = compilerSession(model);

    const error = await session.compile().catch((err: unknown) => err);

    expect(error).toMatchObject({ code: OUTPUT_TRUNCATED, maxOutputTokens: TRUNCATION_RETRY_MAX_TOKENS });
    expect((error as Error).message).toContain(`output truncated at ${TRUNCATION_RETRY_MAX_TOKENS} tokens`);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(caps(calls)).toEqual([DEFAULT_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS]);
    expect(session.turnCount).toBe(0);

    // The failed turn was removed from the history: the next request sends only its own message.
    await session.compile();
    expect(calls[2].messages).toBe(1);
    expect(session.turnCount).toBe(1);
  });

  it('runs the schema repair turn at the larger cap once a response needed it', async () => {
    const { model, calls } = replayModel([
      { text: CUT_OFF_RULES, truncated: true },
      { text: '{"rules": "not an array"}' },
      { text: RULES },
    ]);

    const output = await compilerSession(model).compile();

    expect(output.rules).toHaveLength(1);
    expect(caps(calls)).toEqual([DEFAULT_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS]);
    expect(calls[2].lastUserText).toContain('failed schema validation');
  });

  it('a recompile turn is retried the same way', async () => {
    const { model, calls } = replayModel([{ text: RULES }, { text: CUT_OFF_RULES, truncated: true }, { text: RULES }]);
    const session = compilerSession(model);
    await session.compile();

    const output = await session.recompile(REPAIR_CONTEXT);

    expect(output.rules).toHaveLength(1);
    expect(caps(calls)).toEqual([DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS]);
    expect(session.turnCount).toBe(2);
  });

  // A rule set that needed the larger cap once is as long on every recompile:
  // starting each later turn at the default cap again would cut off (and pay
  // for) one response per repair round before the retry.
  it('starts the later turns of the session at the cap a response needed', async () => {
    const PATCH = JSON.stringify({
      reasoning: 'Keep the read rule.',
      operations: [{ op: 'update', ruleName: 'allow-fs-reads', rule: GOOD_FS.rules[0] }],
    });
    const { model, calls } = replayModel([
      { text: CUT_OFF_RULES, truncated: true },
      { text: RULES },
      { text: RULES },
      { text: PATCH },
    ]);
    const session = compilerSession(model);

    const { rules } = await session.compile();
    await session.recompile(REPAIR_CONTEXT);
    const patched = await session.repairPointFix(rules, REPAIR_CONTEXT);

    expect(patched.rules.map((r) => r.name)).toEqual(['allow-fs-reads']);
    expect(caps(calls)).toEqual([
      DEFAULT_MAX_TOKENS,
      TRUNCATION_RETRY_MAX_TOKENS,
      TRUNCATION_RETRY_MAX_TOKENS,
      TRUNCATION_RETRY_MAX_TOKENS,
    ]);
    expect(session.turnCount).toBe(3);
  });

  it('a later turn cut off at the raised cap fails without asking again under the same cap', async () => {
    const { model, calls } = replayModel([
      { text: CUT_OFF_RULES, truncated: true },
      { text: RULES },
      { text: CUT_OFF_RULES, truncated: true },
    ]);
    const session = compilerSession(model);
    await session.compile();

    await expect(session.recompile(REPAIR_CONTEXT)).rejects.toMatchObject({
      code: OUTPUT_TRUNCATED,
      maxOutputTokens: TRUNCATION_RETRY_MAX_TOKENS,
    });
    expect(caps(calls)).toEqual([DEFAULT_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS]);
    expect(session.turnCount).toBe(1);
  });

  it('a point-fix patch cut off at both caps fails instead of falling back to a longer full recompile', async () => {
    const { model, calls } = replayModel([
      { text: RULES },
      { text: '{"reasoning": "Fix", "operations": [{"op": "upd', truncated: true },
    ]);
    const session = compilerSession(model);
    const { rules } = await session.compile();

    const error = await session.repairPointFix(rules, REPAIR_CONTEXT).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: OUTPUT_TRUNCATED });
    expect(caps(calls)).toEqual([DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS]);
    // No "REPAIR INSTRUCTIONS" recompile was attempted.
    expect(calls.some((c) => c.lastUserText.includes('## REPAIR INSTRUCTIONS'))).toBe(false);
    expect(session.turnCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Verifier judge
// ---------------------------------------------------------------------------

describe('PolicyVerifierSession.judgeRound with truncated output', () => {
  const PASS = JSON.stringify({ analysis: 'ok', pass: true, failureAttributions: [], additionalScenarios: [] });

  function judge(model: MockLanguageModelV3): PolicyVerifierSession {
    return new PolicyVerifierSession({
      system: 'You are a security policy verifier (test).',
      model,
      serverNames: ['fs'],
      toolNames: ['read_file', 'delete_file'],
      storedAnnotations: FS_TOOLS,
    });
  }

  it('repeats a cut-off judgment with the larger cap', async () => {
    const { model, calls } = replayModel([{ text: '{"analysis": "Most rules lo', truncated: true }, { text: PASS }]);
    const session = judge(model);

    const verdict = await session.judgeRound([]);

    expect(verdict.pass).toBe(true);
    expect(caps(calls)).toEqual([DEFAULT_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS]);
    expect(session.turnCount).toBe(1);
  });

  it('starts later rounds at the cap a judgment needed', async () => {
    const { model, calls } = replayModel([
      { text: '{"analysis": "Most rules lo', truncated: true },
      { text: PASS },
      { text: PASS },
    ]);
    const session = judge(model);

    await session.judgeRound([]);
    await session.judgeRound([]);

    expect(caps(calls)).toEqual([DEFAULT_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS]);
    expect(session.turnCount).toBe(2);
  });

  it('fails with the truncation error when the larger cap is cut off too', async () => {
    const { model } = replayModel([{ text: '{"analysis": "Most rules lo', truncated: true }]);
    const session = judge(model);

    await expect(session.judgeRound([])).rejects.toMatchObject({
      code: OUTPUT_TRUNCATED,
      message: expect.stringContaining(`output truncated at ${TRUNCATION_RETRY_MAX_TOKENS} tokens`),
    });
    expect(session.turnCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Data-backed list resolution
// ---------------------------------------------------------------------------

describe('data-backed list resolution with truncated output', () => {
  const definition = {
    name: 'contacts',
    type: 'emails' as const,
    principle: 'People in my contacts',
    generationPrompt: 'List the email addresses of my contacts.',
    requiresMcp: true,
    mcpServerHint: 'mail',
  };
  const mcpConnection = {
    tools: [{ serverName: 'mail', name: 'list_contacts', inputSchema: { type: 'object' }, offered: true }],
    callTool: vi.fn(() => Promise.resolve({ content: [], isError: false })),
  };

  it('runs the tool-use exchange again with the larger cap when its final answer is cut off', async () => {
    const { model, calls } = replayModel([
      { text: '{"values": ["alice@example.com", "bo', truncated: true },
      { text: '{"values": ["alice@example.com", "bob@example.com"]}' },
    ]);

    const resolved = await resolveList(definition, { model, mcpConnection });

    expect(resolved.values).toEqual(['alice@example.com', 'bob@example.com']);
    expect(caps(calls)).toEqual([DEFAULT_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS]);
  });

  it('fails the list instead of keeping the values before the cut', async () => {
    const { model } = replayModel([{ text: '{"values": ["alice@example.com", "bo', truncated: true }]);

    await expect(resolveList(definition, { model, mcpConnection })).rejects.toMatchObject({ code: OUTPUT_TRUNCATED });
  });
});

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

describe('a server whose compile output never fits', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const noopReporter: ServerProgressReporter = {
    update: () => {},
    complete: () => {},
    warn: () => {},
    fail: () => {},
    done: () => {},
  };

  it('is reported as truncated, after one retry with the larger cap and no schema-repair turn', async () => {
    const workDir = mkdtempSync(resolve(tmpdir(), 'ic-wp88-trunc-'));
    dirs.push(workDir);
    const outputDir = resolve(workDir, 'generated');
    mkdirSync(outputDir, { recursive: true });
    const fake = createScriptedPipelineModels(
      { compile: [truncatedReply(CUT_OFF_RULES)] },
      resolve(workDir, 'l.jsonl'),
    );
    const config: PipelineRunConfig = {
      constitutionInput: CONSTITUTION,
      constitutionKind: 'constitution',
      outputDir,
      toolAnnotationsDir: outputDir,
      allowedDirectory: SANDBOX,
      protectedPaths: [],
      preloadedStoredAnnotations: FS_ONLY,
      includeHandwrittenScenarios: false,
      quiet: true,
      reporterFactory: () => noopReporter,
    };

    const error = await new PipelineRunner(fake.models).run(config).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'ALL_SERVERS_FAILED' });
    const [failure] = (error as { failedServers: FailedServer[] }).failedServers;
    expect(failure).toMatchObject({ serverName: 'fs', phase: 'compiling' });
    expect(failure.reason).toContain(`output truncated at ${TRUNCATION_RETRY_MAX_TOKENS} tokens`);
    expect(fake.calls.map((c) => [c.phase, c.maxOutputTokens])).toEqual([
      ['compile', DEFAULT_MAX_TOKENS],
      ['compile', TRUNCATION_RETRY_MAX_TOKENS],
    ]);
  });
});

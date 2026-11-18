/**
 * Session-runtime LLM interaction logging (`observability.llmInteractionLog`):
 * the agent's llm-interactions.jsonl and the auto-approver's
 * auto-approve-llm.jsonl. Covers the three modes, append-only session logs
 * (a resumed session extends its log), owner-only files, and redaction of
 * full-detail logs with the configured credentials.
 *
 * Full mode collects the host's credential stores, so HOME and the related
 * config locations point at a fresh temporary directory: the stores of
 * whoever runs the suite are never read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { wrapLanguageModel } from 'ai';
import type { LanguageModelV3, LanguageModelV3Prompt } from '@ai-sdk/provider';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionLlmLogMiddleware } from '../src/observability/session-llm-log.js';
import type { LlmFullLogEntry, LlmLogEntry } from '../src/observability/llm-logger.js';
import { wrapAutoApproveModel } from '../src/sandbox/index.js';
import type { LlmInteractionLogMode, ResolvedUserConfig } from '../src/config/user-config.js';
import type { IronCurtainConfig } from '../src/config/types.js';

const CONFIGURED_KEY = 'sk-ant-api03-' + 'Configured0123456789abcdefghij';
const PLANTED_GITHUB_TOKEN = 'ghp_' + 'Planted0123456789abcdefghijklmnopqrstu';

let tmpHome: string;
let logPath: string;

function userConfig(
  mode: LlmInteractionLogMode | undefined,
  overrides: Record<string, unknown> = {},
): ResolvedUserConfig {
  return {
    anthropicApiKey: CONFIGURED_KEY,
    auditRedaction: { enabled: true },
    ...(mode !== undefined ? { observability: { llmInteractionLog: mode } } : {}),
    ...overrides,
  } as unknown as ResolvedUserConfig;
}

function mockModel(text = 'ok'): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function prompt(text: string): LanguageModelV3Prompt {
  return [{ role: 'user', content: [{ type: 'text', text }] }];
}

async function callThrough(model: LanguageModelV3, text: string): Promise<void> {
  await model.doGenerate({ prompt: prompt(text) });
}

function logLines(): string[] {
  return readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
}

function entries(): LlmLogEntry[] {
  return logLines()
    .filter((line) => !line.startsWith('{"earlier"'))
    .map((line) => JSON.parse(line) as LlmLogEntry);
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'session-llm-log-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('IRONCURTAIN_HOME', join(tmpHome, '.ironcurtain'));
  vi.stubEnv('ANTHROPIC_CONFIG_DIR', join(tmpHome, 'anthropic'));
  vi.stubEnv('XDG_CONFIG_HOME', join(tmpHome, 'xdg'));
  vi.stubEnv('CODEX_HOME', join(tmpHome, 'codex'));
  logPath = join(tmpHome, 'sessions', 'abc', 'llm-interactions.jsonl');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('createSessionLlmLogMiddleware', () => {
  it("'off' installs no middleware and creates no file", () => {
    expect(createSessionLlmLogMiddleware(logPath, { stepName: 'agent' }, userConfig('off'))).toBeUndefined();
    expect(existsSync(logPath)).toBe(false);
  });

  it("defaults to 'metadata' when the configuration carries no observability block", async () => {
    const middleware = createSessionLlmLogMiddleware(logPath, { stepName: 'agent' }, userConfig(undefined));
    expect(middleware).toBeDefined();
    if (!middleware) return;
    await callThrough(wrapLanguageModel({ model: mockModel('ANSWER-CANARY'), middleware }), 'PROMPT-CANARY');

    expect(readFileSync(logPath, 'utf-8')).not.toMatch(/CANARY/);
    expect(entries()).toEqual([expect.objectContaining({ detail: 'metadata', stepName: 'agent', promptMessages: 1 })]);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it('appends to the log an earlier run of the session wrote (resume)', async () => {
    const first = createSessionLlmLogMiddleware(logPath, { stepName: 'agent' }, userConfig('metadata'));
    if (!first) throw new Error('expected a middleware');
    await callThrough(wrapLanguageModel({ model: mockModel(), middleware: first }), 'before');

    // The resumed session builds a fresh middleware for the same path.
    const second = createSessionLlmLogMiddleware(logPath, { stepName: 'agent' }, userConfig('metadata'));
    if (!second) throw new Error('expected a middleware');
    await callThrough(wrapLanguageModel({ model: mockModel(), middleware: second }), 'after');

    expect(entries()).toHaveLength(2);
  });

  it("'full' logs the conversation with configured credentials and key patterns masked", async () => {
    const middleware = createSessionLlmLogMiddleware(logPath, { stepName: 'agent' }, userConfig('full'), {
      deltaLogging: true,
    });
    if (!middleware) throw new Error('expected a middleware');
    const model = wrapLanguageModel({ model: mockModel(`echo ${CONFIGURED_KEY}`), middleware });
    await callThrough(model, `token ${PLANTED_GITHUB_TOKEN} and key ${CONFIGURED_KEY}`);

    const raw = readFileSync(logPath, 'utf-8');
    expect(raw).not.toContain(CONFIGURED_KEY);
    expect(raw).not.toContain(PLANTED_GITHUB_TOKEN);
    const [entry] = entries() as LlmFullLogEntry[];
    expect(entry.detail).toBe('full');
    expect(JSON.stringify(entry.prompt)).toContain('token ghp_...rstu and key ***REDACTED***');
    expect(entry.responseText).toBe('echo ***REDACTED***');
  });

  it("'full' with auditRedaction turned off keeps the text verbatim", async () => {
    const middleware = createSessionLlmLogMiddleware(
      logPath,
      { stepName: 'agent' },
      userConfig('full', { auditRedaction: { enabled: false } }),
    );
    if (!middleware) throw new Error('expected a middleware');
    await callThrough(wrapLanguageModel({ model: mockModel(), middleware }), `token ${PLANTED_GITHUB_TOKEN}`);
    expect(readFileSync(logPath, 'utf-8')).toContain(PLANTED_GITHUB_TOKEN);
  });
});

describe('wrapAutoApproveModel', () => {
  function sessionConfig(mode: LlmInteractionLogMode, autoApproveLlmLogPath: string | undefined): IronCurtainConfig {
    return { autoApproveLlmLogPath, userConfig: userConfig(mode) } as unknown as IronCurtainConfig;
  }

  it('returns the model unwrapped without a log path or when logging is off', () => {
    const model = mockModel();
    expect(wrapAutoApproveModel(model, sessionConfig('metadata', undefined))).toBe(model);
    expect(wrapAutoApproveModel(model, sessionConfig('off', logPath))).toBe(model);
    expect(existsSync(logPath)).toBe(false);
  });

  it('logs metadata to the session log without truncating what is already there', async () => {
    logPath = join(tmpHome, 'auto-approve-llm.jsonl');
    writeFileSync(logPath, '{"earlier":"entry from before the resume"}\n');

    const wrapped = wrapAutoApproveModel(mockModel('APPROVE-CANARY'), sessionConfig('metadata', logPath));
    await callThrough(wrapped, 'ESCALATION-CANARY');

    const lines = logLines();
    expect(lines[0]).toBe('{"earlier":"entry from before the resume"}');
    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toMatch(/CANARY/);
    expect(entries()).toEqual([expect.objectContaining({ detail: 'metadata', stepName: 'auto-approve' })]);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });
});

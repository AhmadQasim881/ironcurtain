/**
 * Agent-derived text reaches the operator's terminal from the workflow CLI
 * only as inert, visible characters (WP-52, WFC-12).
 *
 * The interactive gate prompt shows the run's last error and the previous
 * agent's output at the moment a human decides; `workflow inspect` prints
 * checkpoint errors, message-log text and workspace artifact names;
 * `run-state` prints the agent's status notes. Each used to write that text
 * raw, so an agent could erase a failing verdict (cursor movement, erase
 * line), set the clipboard (OSC 52) or reorder text (bidi overrides). Only
 * the CLI's own color codes may remain raw.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BG_YELLOW,
  BLACK,
  BLUE,
  BOLD,
  CYAN,
  DIM,
  GREEN,
  MAGENTA,
  RED,
  RESET,
  WHITE,
  YELLOW,
  printLifecycleEvent,
  printResumeInfo,
  promptGateInteractive,
} from '../../src/workflow/cli-support.js';
import { parseDefinitionFile } from '../../src/workflow/discovery.js';
import { formatAgentResult } from '../../src/workflow/run-state-command.js';
import type { WorkflowCheckpoint, WorkflowId, HumanGateRequest } from '../../src/workflow/types.js';
import { main as workflowMain } from '../../src/workflow/workflow-command.js';

const ESC = '\u001b';
const BEL = '\u0007';
const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'test-gate-smoke', 'workflow.yaml');

/** The CLI's own SGR color codes: the only escapes it may write raw. */
const OWN_CODES = [RESET, BOLD, DIM, GREEN, YELLOW, BLUE, MAGENTA, CYAN, RED, WHITE, BG_YELLOW, BLACK];

/** Hostile agent text: cursor-up + erase line, OSC 52 clipboard, 8-bit CSI, RLO, bare CR. */
const HOSTILE = `FAIL${ESC}[1A${ESC}[2KPASS ${ESC}]52;c;cm0gLXJmIH4K${BEL} \u009b2J ‮txt.exe\rover`;
const HOSTILE_ESCAPED = 'FAIL\\u001b[1A\\u001b[2KPASS \\u001b]52;c;cm0gLXJmIH4K\\u0007 \\u009b2J \\u202etxt.exe\\rover';

/** Fails if anything but the CLI's own color codes would act on a terminal. */
function expectInert(output: string): void {
  let rest = output;
  for (const code of OWN_CODES) rest = rest.split(code).join('');
  // eslint-disable-next-line no-control-regex
  expect(rest).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/u);
}

let stdout: string[];
let stderr: string[];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  stdout = [];
  stderr = [];
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

describe('interactive gate prompt', () => {
  it('shows the summary and the extracted ERROR line with visible escapes', async () => {
    const gate: HumanGateRequest = {
      gateId: 'wf-1-review-1-abc',
      workflowId: 'wf-1',
      stateName: `review${ESC}[8m`,
      acceptedEvents: ['APPROVE', 'ABORT'],
      presentedArtifacts: new Map([[`spec${ESC}]8;;https://example.invalid${BEL}`, '/tmp/spec']]),
      summary: `Waiting for human review at review (error: ${HOSTILE})`,
    };
    const question = vi.fn(async () => 'a');
    const rl = { question } as unknown as ReturnType<typeof createInterface>;

    const decision = await promptGateInteractive(gate, rl);

    expect(decision).toEqual({ gateId: 'wf-1-review-1-abc', type: 'APPROVE', resolvedBy: 'cli' });
    const out = stdout.join('');
    const err = stderr.join('');
    expect(err).toContain(`ERROR: ${HOSTILE_ESCAPED}`);
    expect(out).toContain(`(error: ${HOSTILE_ESCAPED})`);
    expect(out).toContain('HUMAN GATE: review\\u001b[8m');
    expect(out).toContain('Presented artifacts: spec\\u001b]8;;https://example.invalid\\u0007');
    expectInert(out);
    expectInert(err);
  });
});

describe('workflow lifecycle and resume output', () => {
  it('escapes a failure message and resume details', () => {
    printLifecycleEvent({ kind: 'failed', workflowId: 'wf-1' as WorkflowId, error: HOSTILE });

    const base = mkdtempSync(join(tmpdir(), 'ic-cli-render-'));
    try {
      const artifactDir = join(base, 'wf-1', 'workspace', '.workflow');
      mkdirSync(join(artifactDir, `notes${ESC}[2J`), { recursive: true });
      const checkpoint = {
        machineState: 'review',
        context: { lastError: HOSTILE, taskDescription: 'task' },
        timestamp: '2026-11-10T00:00:00.000Z',
        transitionHistory: [],
        definitionPath: FIXTURE_PATH,
      } as unknown as WorkflowCheckpoint;
      printResumeInfo(base, 'wf-1' as WorkflowId, checkpoint);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }

    expect(stderr.join('')).toContain(`WORKFLOW ERROR:${RESET} ${HOSTILE_ESCAPED}`);
    expect(stdout.join('')).toContain(`Error: ${HOSTILE_ESCAPED}`);
    expect(stdout.join('')).toContain('Artifacts present: notes\\u001b[2J');
    expectInert(stdout.join(''));
    expectInert(stderr.join(''));
  });
});

describe('workflow inspect', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ic-inspect-render-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('prints checkpoint errors, message-log text and artifact names with visible escapes', async () => {
    const runDir = join(base, 'wf-hostile');
    mkdirSync(join(runDir, 'workspace', '.workflow', `draft${ESC}[2J`), { recursive: true });
    writeFileSync(join(runDir, 'definition.json'), JSON.stringify(parseDefinitionFile(FIXTURE_PATH)));
    writeFileSync(
      join(runDir, 'checkpoint.json'),
      JSON.stringify({
        machineState: 'review',
        context: { lastError: HOSTILE, taskDescription: `Draft it\n${ESC}[2Jnow` },
        timestamp: '2026-11-10T00:00:00.000Z',
        transitionHistory: [],
        definitionPath: FIXTURE_PATH,
      }),
    );
    const entry = (fields: Record<string, unknown>): string =>
      JSON.stringify({ ts: '2026-11-10T00:00:01.000Z', workflowId: 'wf-hostile', state: 'produce', ...fields });
    writeFileSync(
      join(runDir, 'messages.jsonl'),
      [
        entry({ type: 'agent_received', role: 'writer', message: HOSTILE, verdict: 'approved', confidence: null }),
        entry({ type: 'agent_sent', role: `writer${ESC}[31m`, message: `line one\n${HOSTILE}` }),
        entry({ type: 'error', error: HOSTILE }),
        entry({ type: 'quota_exhausted', role: 'writer', rawMessage: HOSTILE }),
        entry({ type: 'transient_failure', role: 'writer', kind: 'network', rawMessage: HOSTILE }),
        entry({ type: 'state_transition', from: `produce${ESC}[2K`, event: 'review' }),
        entry({ type: 'gate_resolved', event: 'APPROVE', prompt: null, resolvedBy: `cli${ESC}]0;x${BEL}` }),
      ].join('\n') + '\n',
    );

    await workflowMain(['inspect', base]);

    const out = stdout.join('');
    expect(out).toContain(`Error: ${RED}${HOSTILE_ESCAPED}`);
    expect(out).toContain('Task: Draft it\\n\\u001b[2Jnow');
    expect(out).toContain('Artifacts: draft\\u001b[2J');
    expect(out).toContain(`[error]${RESET} ${HOSTILE_ESCAPED}`);
    expect(out).toContain('[sent/writer\\u001b[31m]');
    expect(out).toContain('line one FAIL\\u001b[1A');
    expect(out).toContain('produce\\u001b[2K -> review');
    expect(out).toContain('via cli\\u001b]0;x\\u0007');
    expectInert(out);
  });
});

describe('run-state result', () => {
  it('escapes the verdict, the notes (keeping their line breaks) and a parse error', () => {
    const response = [
      'Done.',
      '```',
      'agent_status:',
      '  completed: true',
      '  verdict: approved',
      '  confidence: high',
      '  escalation: null',
      '  test_count: null',
      // YAML double-quoted escapes: \e is ESC, \a is BEL.
      '  notes: "first \\e[2K line\\nsecond \\e]52;c;cm0gLXJmIH4K\\a"',
      '```',
    ].join('\n');

    const rendered = formatAgentResult(response);

    expect(rendered).toBe('verdict=approved\nnotes: first \\u001b[2K line\nsecond \\u001b]52;c;cm0gLXJmIH4K\\u0007');
    expect(formatAgentResult('no status block here')).toBe('(no agent_status block)');

    const malformed = formatAgentResult(['```', 'agent_status:', `  verdict: "${ESC}[2J`, '```'].join('\n'));
    expect(malformed).toMatch(/^\(malformed agent_status: /u);
    expectInert(malformed);
  });
});

/**
 * The cron run summary (last-run.md) is agent-written and untrusted:
 * retireRunSummary moves it aside before a run without opening or following
 * it, readRunSummary reads it bounded, without following a symlink or
 * opening a FIFO, and strips control characters, and formatRunNotification
 * renders the Signal notice with every untrusted part sanitized and the
 * agent-written summary quoted line by line, so it cannot pass for a banner.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatRunNotification,
  formatRunRefusal,
  MAX_RUN_NOTICE_CHARS,
  MAX_RUN_NOTICES,
  MAX_SUMMARY_BYTES,
  MAX_SUMMARY_CHARS,
  PREVIOUS_RUN_SUMMARY_FILE,
  readRunSummary,
  retireRunSummary,
  RunNoticeCollector,
  RUN_SUMMARY_FILE,
} from '../src/cron/run-summary.js';
import type { RunRecord } from '../src/cron/types.js';
import type { DiagnosticEvent } from '../src/session/types.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from './helpers/fifo.js';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const RLO = String.fromCodePoint(0x202e);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
/** How the summary shows an RLO character: a visible backslash-u escape. */
const VISIBLE_RLO = String.fromCharCode(92) + 'u202e';
/** Characters a Signal client may render as a line break or reorder text with. */
const INVISIBLE_OR_BREAKING = /[\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/u;
/** Introduces the agent-written summary in a completion notice. */
const SUMMARY_LABEL = "Summary written by the job's agent:";

let workspace: string;
let current: string;
let previous: string;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-run-summary-')));
  current = join(workspace, RUN_SUMMARY_FILE);
  previous = join(workspace, PREVIOUS_RUN_SUMMARY_FILE);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('retireRunSummary', () => {
  it('moves last-run.md to previous-run.md, replacing an older one', () => {
    writeFileSync(previous, 'two runs ago\n');
    writeFileSync(current, 'last run\n');

    retireRunSummary(workspace);
    expect(existsSync(current)).toBe(false);
    expect(readFileSync(previous, 'utf8')).toBe('last run\n');
  });

  it('keeps previous-run.md when the last run wrote no summary', () => {
    writeFileSync(previous, 'an earlier run\n');

    retireRunSummary(workspace);
    expect(readFileSync(previous, 'utf8')).toBe('an earlier run\n');
  });

  it('does nothing in a workspace that does not exist', () => {
    expect(() => retireRunSummary(join(workspace, 'missing'))).not.toThrow();
  });

  it('moves a symlink as a link, never touching its target', () => {
    const target = join(workspace, '..', `${workspace.split('/').pop() ?? 'x'}-target.txt`);
    writeFileSync(target, 'host file\n');
    try {
      symlinkSync(target, current);

      retireRunSummary(workspace);
      expect(lstatSync(previous).isSymbolicLink()).toBe(true);
      expect(readlinkSync(previous)).toBe(target);
      expect(readFileSync(target, 'utf8')).toBe('host file\n');
    } finally {
      rmSync(target, { force: true });
    }
  });

  it.skipIf(!fifoSupported)('moves a FIFO without opening it', () => {
    makeFifo(current);
    const unblocker = startFifoUnblocker(current, 5);
    const started = Date.now();
    try {
      retireRunSummary(workspace);
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(lstatSync(previous).isFIFO()).toBe(true);
    expect(existsSync(current)).toBe(false);
  });

  it('leaves a directory at last-run.md in place (it can never be read as a summary)', () => {
    mkdirSync(join(current, 'nested'), { recursive: true });

    retireRunSummary(workspace);
    expect(lstatSync(current).isDirectory()).toBe(true);
    expect(existsSync(previous)).toBe(false);
  });

  it('deletes the stale summary when previous-run.md is a directory', () => {
    mkdirSync(join(previous, 'nested'), { recursive: true });
    writeFileSync(current, 'stale\n');

    retireRunSummary(workspace);
    expect(existsSync(current)).toBe(false);
    expect(lstatSync(join(previous, 'nested')).isDirectory()).toBe(true);
  });
});

describe('readRunSummary', () => {
  it('returns null without a problem when no summary was written', () => {
    expect(readRunSummary(workspace)).toEqual({ summary: null });
  });

  it('returns the summary text', () => {
    writeFileSync(current, '# Run\n\n- Labeled 12 issues\n\tindented\n');
    expect(readRunSummary(workspace)).toEqual({ summary: '# Run\n\n- Labeled 12 issues\n\tindented\n' });
  });

  it('keeps an empty summary empty', () => {
    writeFileSync(current, '');
    expect(readRunSummary(workspace)).toEqual({ summary: '' });
  });

  it('never follows a symlink', () => {
    const secret = join(workspace, 'secret.txt');
    writeFileSync(secret, 'TOP-SECRET\n');
    symlinkSync(secret, current);

    expect(readRunSummary(workspace)).toEqual({ summary: null, problem: 'last-run.md was not read (SYMLINK)' });
  });

  it.skipIf(!fifoSupported)('never opens a FIFO', () => {
    makeFifo(current);
    const unblocker = startFifoUnblocker(current, 5);
    const started = Date.now();
    let result: ReturnType<typeof readRunSummary>;
    try {
      result = readRunSummary(workspace);
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result).toEqual({ summary: null, problem: 'last-run.md was not read (NOT_REGULAR_FILE)' });
  });

  it('refuses a directory', () => {
    mkdirSync(current);
    expect(readRunSummary(workspace)).toEqual({
      summary: null,
      problem: 'last-run.md was not read (NOT_REGULAR_FILE)',
    });
  });

  it('reads at most MAX_SUMMARY_BYTES of a huge file and marks the cut', () => {
    const marker = 'BEYOND-THE-READ-LIMIT';
    writeFileSync(current, 'a\n'.repeat(MAX_SUMMARY_BYTES / 2) + marker + 'b'.repeat(1024 * 1024));

    const { summary } = readRunSummary(workspace);
    expect(summary).not.toContain(marker);
    expect(Array.from(summary ?? '')).toHaveLength(MAX_SUMMARY_CHARS + 3);
    expect(summary?.endsWith('...')).toBe(true);
  });

  it('marks a summary cut by the byte limit even when it is short in characters', () => {
    // The bytes read are all control characters, removed by sanitizing: the
    // text is short, but the file held more than was read.
    writeFileSync(current, String.fromCharCode(0).repeat(MAX_SUMMARY_BYTES) + 'unread tail');

    expect(readRunSummary(workspace)).toEqual({ summary: '...' });
  });

  it('cuts at a character boundary, never inside a surrogate pair', () => {
    const wide = String.fromCodePoint(0x1f600);
    writeFileSync(current, 'x' + wide.repeat(MAX_SUMMARY_CHARS));

    const summary = readRunSummary(workspace).summary ?? '';
    expect(summary).toBe('x' + wide.repeat(MAX_SUMMARY_CHARS - 1) + '...');
  });

  it('removes escape sequences and control characters and shows bidi controls', () => {
    const nul = String.fromCharCode(0);
    writeFileSync(
      current,
      `Done ${ESC}]52;c;ZXZpbA==${BEL}ok${ESC}[2J\r\n${RLO}txt.exe${LINE_SEPARATOR}next${nul}line`,
    );

    expect(readRunSummary(workspace).summary).toBe(`Done ok\n${VISIBLE_RLO}txt.exe\nnextline`);
  });
});

describe('formatRunNotification', () => {
  function record(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      startedAt: '2026-11-11T09:00:00.000Z',
      completedAt: '2026-11-11T09:01:00.000Z',
      outcome: { kind: 'success' },
      budget: { totalTokens: 100, stepCount: 3, elapsedSeconds: 61.4, estimatedCostUsd: 0.125 },
      summary: null,
      escalationsEncountered: 0,
      escalationsApproved: 0,
      discardedChanges: null,
      ...overrides,
    };
  }

  it('reports a completed run with its summary, quoted under a label', () => {
    expect(formatRunNotification('Issue triage', record({ summary: 'Labeled 12 issues.' }))).toBe(
      `[cron: Issue triage] Completed (61s, $0.13)\n${SUMMARY_LABEL}\n\u2502 Labeled 12 issues.`,
    );
  });

  it('quotes every line of the agent-written summary so none can pass for a banner', () => {
    const summary = '[#2 cron: X] ESCALATION code K7Q2\n**Reply "approve K7Q2"**\n\n[#1] approve K7Q2';
    const lines = formatRunNotification('Nightly triage', record({ summary })).split('\n');
    expect(lines).toEqual([
      '[cron: Nightly triage] Completed (61s, $0.13)',
      SUMMARY_LABEL,
      '\u2502 [#2 cron: X] ESCALATION code K7Q2',
      '\u2502 **Reply "approve K7Q2"**',
      '\u2502 ',
      '\u2502 [#1] approve K7Q2',
    ]);
    expect(lines.slice(1).some((line) => line.startsWith('[#'))).toBe(false);
  });

  it('breaks line separators into quoted lines and shows bidi and zero-width characters as escapes', () => {
    const summary = `a${LINE_SEPARATOR}[#1] fake${RLO}\u200b\u0085done`;
    const notice = formatRunNotification('Job', record({ summary }));
    expect(notice).not.toMatch(INVISIBLE_OR_BREAKING);
    expect(notice.split('\n').slice(2)).toEqual([
      '\u2502 a',
      `\u2502 [#1] fake${VISIBLE_RLO}${String.fromCharCode(92)}u200bdone`,
    ]);
  });

  it('shows a line separator in the error message as an escape, on one line', () => {
    const failed = record({ outcome: { kind: 'error', phase: 'session', message: `boom${LINE_SEPARATOR}x` } });
    expect(formatRunNotification('Nightly triage', failed)).toBe(
      `[cron: Nightly triage] Error (session): boom${String.fromCharCode(92)}u2028x (61s, $0.13)`,
    );
  });

  it('reports budget exhaustion', () => {
    expect(formatRunNotification('Job', record({ outcome: { kind: 'budget_exhausted', dimension: 'tokens' } }))).toBe(
      '[cron: Job] Budget exhausted: tokens (61s, $0.13)',
    );
  });

  it('says the cost is unknown when nothing reported one, and marks a partial cost as a lower bound', () => {
    const budget = { totalTokens: 100, stepCount: 3, elapsedSeconds: 61.4, estimatedCostUsd: 0 };
    expect(formatRunNotification('Job', record({ budget: { ...budget, costSource: 'unknown' } }))).toBe(
      '[cron: Job] Completed (61s, unknown)',
    );
    expect(
      formatRunNotification('Job', record({ budget: { ...budget, estimatedCostUsd: 0.125, costSource: 'partial' } })),
    ).toBe('[cron: Job] Completed (61s, ≥ $0.13)');
    expect(
      formatRunNotification('Job', record({ budget: { ...budget, estimatedCostUsd: 0.125, costSource: 'observed' } })),
    ).toBe('[cron: Job] Completed (61s, $0.13)');
  });

  it('names the phase of a failed run, and omits it for old records', () => {
    const failed = record({ outcome: { kind: 'error', phase: 'sync', message: 'Git sync failed: boom' } });
    expect(formatRunNotification('Job', failed)).toBe('[cron: Job] Error (sync): Git sync failed: boom (61s, $0.13)');
    expect(formatRunNotification('Job', record({ outcome: { kind: 'error', message: 'old' } }))).toBe(
      '[cron: Job] Error: old (61s, $0.13)',
    );
  });

  it('renders control characters in the job name and error message as visible escapes', () => {
    const failed = record({ outcome: { kind: 'error', phase: 'session', message: `bad${ESC}[31mred\nline` } });
    const notice = formatRunNotification(`Job${BEL}`, failed);
    expect(notice).not.toContain(ESC);
    expect(notice).not.toContain(BEL);
    expect(notice.split('\n')).toHaveLength(1);
    expect(notice).toContain('[cron: Job' + String.fromCharCode(92) + 'u0007]');
  });

  it('caps a long error message and the summary', () => {
    const failed = record({
      outcome: { kind: 'error', phase: 'session', message: 'm'.repeat(5_000) },
      summary: `${'s'.repeat(1_000)}${ESC}`,
    });
    const [header, ...rest] = formatRunNotification('Job', failed).split('\n');
    expect(header.length).toBeLessThan(700);
    expect(header).toMatch(/\.\.\.\[\+\d+ chars\] \(61s, \$0\.13\)$/u);
    // 500 characters of summary at most, the cut marked with the omitted count.
    expect(rest).toEqual([SUMMARY_LABEL, `\u2502 ${'s'.repeat(484)}...[+516 chars]`]);
  });

  it("names the run's notices, IronCurtain's own text, before the agent's summary", () => {
    const notices = [
      '[policy] Warning: the compiled policy at /p may be stale:\n  - it records no provenance',
      '[host-files] Warning (session end): IronCurtain found setuid/setgid or root-owned files',
    ];
    expect(formatRunNotification('Triage', record({ notices, summary: 'Labeled 3 issues.' })).split('\n')).toEqual([
      '[cron: Triage] Completed (61s, $0.13)',
      'Notices:',
      '[policy] Warning: the compiled policy at /p may be stale:',
      '  - it records no provenance',
      '[host-files] Warning (session end): IronCurtain found setuid/setgid or root-owned files',
      SUMMARY_LABEL,
      '\u2502 Labeled 3 issues.',
    ]);
    // Without a summary, and bounded.
    const long = formatRunNotification('Triage', record({ notices: [`[policy] ${'x'.repeat(5_000)}${ESC}`] }));
    expect(long).not.toContain(ESC);
    expect(long.length).toBeLessThan(1_700);
    expect(long).toMatch(/\.\.\.\[\+\d+ chars\]$/u);
    // An empty list says nothing.
    expect(formatRunNotification('Triage', record({ notices: [] }))).toBe('[cron: Triage] Completed (61s, $0.13)');
  });
});

describe('RunNoticeCollector', () => {
  const hostFiles: DiagnosticEvent = {
    kind: 'host_privileged_files',
    when: 'after agent turn',
    stripped: 1,
    unstripped: 0,
    rootOwned: 0,
    unlisted: 0,
    paths: ['/w/planted'],
    incomplete: false,
    hint: 'Their setuid/setgid bits are removed.',
  };

  it("keeps the session's notices as display text, first lines flush left, and nothing else", () => {
    const collector = new RunNoticeCollector();
    expect(collector.collected()).toBeUndefined();

    collector.onDiagnostic({ kind: 'tool_call', toolName: 'filesystem.read_file', preview: 'allowed' });
    collector.onDiagnostic({ kind: 'mcp_server_unavailable', serverName: `gh${ESC}[2J`, reason: 'relay exited' });
    collector.onDiagnostic(hostFiles);

    const notices = collector.collected() ?? [];
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/^\[mcp\] Warning: MCP server "gh\\u001b\[2J" is unavailable/u);
    expect(notices[1].split('\n')).toEqual([
      expect.stringMatching(/^\[host-files\] Warning \(after agent turn\)/u) as unknown,
      '  /w/planted',
      '  Their setuid/setgid bits are removed.',
    ]);
  });

  it(`keeps at most ${MAX_RUN_NOTICES} notices, each bounded, and counts the rest`, () => {
    const collector = new RunNoticeCollector();
    for (let index = 0; index < MAX_RUN_NOTICES + 3; index++) {
      collector.onDiagnostic({ kind: 'policy_stale', message: `${index} ${'x'.repeat(MAX_RUN_NOTICE_CHARS)}` });
    }
    const notices = collector.collected() ?? [];
    expect(notices).toHaveLength(MAX_RUN_NOTICES + 1);
    expect(notices.at(-1)).toBe('3 further notice(s) not kept');
    expect(Math.max(...notices.map((notice) => notice.length))).toBeLessThanOrEqual(MAX_RUN_NOTICE_CHARS);
  });
});

describe('formatRunRefusal', () => {
  it('names the job and the reason the run was refused', () => {
    expect(formatRunRefusal('Nightly', 'Job "nightly" has no compiled policy.')).toBe(
      '[cron: Nightly] Not run: Job "nightly" has no compiled policy.',
    );
  });

  it('renders control characters in the job name and reason as visible escapes, on one line', () => {
    const notice = formatRunRefusal(`Job${BEL}`, `stale${ESC}[2J\nforged: Completed`);
    expect(notice).not.toContain(ESC);
    expect(notice).not.toContain(BEL);
    expect(notice.split('\n')).toHaveLength(1);
    expect(notice).toContain('[cron: Job' + String.fromCharCode(92) + 'u0007] Not run: stale');
  });
});

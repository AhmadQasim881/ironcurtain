/**
 * `ironcurtain audit report`: totals, escalation outcomes, latency and slices
 * computed from a fixture audit log, plus the streaming reader's bounds and
 * the command's source discovery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAuditReport, classifyEscalation, formatAuditReport, NO_PERSONA } from '../src/audit/audit-report.js';
import { readJsonlValues, emptyJsonlReadStats } from '../src/audit/jsonl-reader.js';
import { parseSince, runAuditCommand } from '../src/audit/audit-command.js';

const FIXTURE = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/audit-report/audit.jsonl');
const FIXED_NOW = () => new Date('2026-02-01T00:00:00.000Z');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ironcurtain-audit-report-'));
  process.env.IRONCURTAIN_HOME = home;
});

afterEach(() => {
  delete process.env.IRONCURTAIN_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function capture(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runAuditCommand(args, {
    write: (text) => {
      out += text;
    },
    writeError: (text) => {
      err += text;
    },
    now: () => FIXED_NOW().getTime(),
  });
  return { code, out, err };
}

describe('audit report on the fixture log', () => {
  it('report totals match the fixture log', async () => {
    const report = await buildAuditReport([{ path: FIXTURE, label: 'fixture' }], { now: FIXED_NOW });

    // 14 calls with an outcome; the write-ahead record of f1 never got one,
    // and r1's interim roots-race record is not a second call.
    expect(report.totals).toEqual({
      records: 23,
      calls: 14,
      inFlight: 1,
      retries: 1,
      skippedBeforeSince: 0,
      malformedLines: 1,
      oversizedLines: 0,
      invalidRecords: 1,
      firstTimestamp: '2026-01-01T00:00:01.000Z',
      lastTimestamp: '2026-01-01T00:00:15.000Z',
    });
    expect(report.outcomes).toEqual({ success: 6, denied: 7, error: 1 });
    expect(report.decisions).toEqual({ allow: 3, deny: 3, escalate: 8 });
    expect(report.escalations).toEqual({
      total: 8,
      humanApproved: 2,
      humanDenied: 1,
      autoApproved: 1,
      whitelistApproved: 1,
      timedOut: 1,
      cancelled: 1,
      unanswered: 1,
    });
    // Durations of the seven dispatched outcomes: 10..70 ms (the retry's interim 5 ms is not a call).
    expect(report.latencyMs).toEqual({ samples: 7, p50: 40, p95: 70, p99: 70, max: 70 });
  });

  it('groups decisions by rule, tools, denials and personas', async () => {
    const report = await buildAuditReport([{ path: FIXTURE, label: 'fixture' }], { now: FIXED_NOW });

    const rule = report.rules.find((r) => r.rule === 'escalate-write-outside-permitted-areas');
    expect(rule).toMatchObject({ calls: 8, escalate: 8, allow: 0, deny: 0, success: 4, denied: 4, error: 0 });
    expect(report.rules[0].rule).toBe('escalate-write-outside-permitted-areas');
    expect(report.rules.find((r) => r.rule === 'structural-protected-path')).toMatchObject({ calls: 2, deny: 2 });
    expect(report.rules.find((r) => r.rule === 'allow-read-in-sandbox')).toMatchObject({ calls: 2, allow: 2 });

    expect(report.tools[0]).toMatchObject({ server: 'filesystem', tool: 'write_file', calls: 9, escalated: 8 });
    expect(report.tools.find((t) => t.tool === 'git_status')).toMatchObject({ calls: 1, error: 1 });

    expect(report.denials[0]).toEqual({
      rule: 'structural-protected-path',
      reason: 'Access to a protected path is forbidden',
      count: 2,
    });
    expect(report.denials.reduce((sum, d) => sum + d.count, 0)).toBe(7);

    expect(report.personas.map((p) => [p.persona, p.calls])).toEqual([
      [NO_PERSONA, 12],
      ['coder', 1],
      ['reviewer', 1],
    ]);
    const coder = report.personas.find((p) => p.persona === 'coder');
    expect(coder?.escalations).toMatchObject({ total: 1, autoApproved: 1 });
    const reviewer = report.personas.find((p) => p.persona === 'reviewer');
    expect(reviewer?.escalations).toMatchObject({ total: 1, cancelled: 1 });
  });

  it('applies --since to records and attributes un-stamped records to the source persona', async () => {
    const report = await buildAuditReport([{ path: FIXTURE, label: 'session', defaultPersona: 'analyst' }], {
      since: Date.parse('2026-01-01T00:00:10.000Z'),
      now: FIXED_NOW,
    });
    // e5 (10s) .. r1 (14s) remain: e5, e6, e7, x1, r1 = 5 calls; f1 (15s) in flight.
    expect(report.totals.calls).toBe(5);
    expect(report.totals.inFlight).toBe(1);
    expect(report.totals.skippedBeforeSince).toBe(14);
    expect(report.since).toBe('2026-01-01T00:00:10.000Z');
    expect(report.personas.map((p) => [p.persona, p.calls])).toEqual([
      ['analyst', 4],
      ['reviewer', 1],
    ]);
  });

  it('escapes agent-chosen text in the text report', async () => {
    const report = await buildAuditReport([{ path: FIXTURE, label: 'fixture' }], { now: FIXED_NOW });
    const text = formatAuditReport(report);
    expect(text).not.toContain('\u001b');
    expect(text).toContain('evil\\u001b[2J/x');
    expect(text).toContain('Escalations: 8 (human approved 2, human denied 1, auto-approved 1, whitelist 1');
    expect(text).toContain('p50 40 ms, p95 70 ms, p99 70 ms, max 70 ms');
  });

  it('escapes record timestamps, which only had to satisfy Date.parse', async () => {
    const path = join(home, 'crafted.jsonl');
    const timestamp = 'Tue Mar 01 2026 (\u001b[2J\u001b]0;owned\u0007)';
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
    const entry = {
      timestamp,
      requestId: 'c1',
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: {},
      policyDecision: { status: 'allow', rule: 'r', reason: 'x' },
      result: { status: 'success' },
      durationMs: 1,
    };
    writeFileSync(path, `${JSON.stringify(entry)}\n`);
    const report = await buildAuditReport([{ path, label: 'crafted' }], { now: FIXED_NOW });
    expect(report.totals.firstTimestamp).toBe(timestamp);
    const text = formatAuditReport(report);
    expect(text).toContain('period Tue Mar 01 2026');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
  });

  it('classifies escalation outcomes from the audit fields', () => {
    const decision = (reason: string) => ({ status: 'deny' as const, rule: 'r', reason });
    expect(classifyEscalation({ policyDecision: decision('x') })).toBeUndefined();
    expect(classifyEscalation({ escalationResult: 'approved', policyDecision: decision('x') })).toBe('humanApproved');
    expect(
      classifyEscalation({ escalationResult: 'approved', autoApproved: true, policyDecision: decision('x') }),
    ).toBe('autoApproved');
    expect(
      classifyEscalation({ escalationResult: 'approved', whitelistApproved: true, policyDecision: decision('x') }),
    ).toBe('whitelistApproved');
    expect(
      classifyEscalation({
        escalationResult: 'denied',
        policyDecision: decision('Denied by human during escalation'),
      }),
    ).toBe('humanDenied');
    expect(classifyEscalation({ escalationResult: 'denied', policyDecision: decision('Escalation wait failed') })).toBe(
      'unanswered',
    );
    expect(classifyEscalation({ escalationResult: 'timed-out', policyDecision: decision('x') })).toBe('timedOut');
    expect(classifyEscalation({ escalationResult: 'cancelled', policyDecision: decision('x') })).toBe('cancelled');
  });
});

describe('streaming JSONL reader', () => {
  it('skips lines over the limit without buffering them and keeps reading', async () => {
    const path = join(home, 'big.jsonl');
    const huge = JSON.stringify({ blob: 'x'.repeat(200_000) });
    writeFileSync(path, `{"a":1}\n${huge}\n{"b":2}\nnot json\n{"c":3}`);
    const stats = emptyJsonlReadStats();
    const values: unknown[] = [];
    for await (const value of readJsonlValues(path, stats, 1024)) values.push(value);
    expect(values).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(stats).toEqual({ lines: 5, malformed: 1, oversized: 1 });
  });

  it('refuses a symlink and a FIFO instead of following or blocking on them', async () => {
    const target = join(home, 'target.jsonl');
    writeFileSync(target, '{"a":1}\n');
    const link = join(home, 'link.jsonl');
    symlinkSync(target, link);
    await expect(readJsonlValues(link).next()).rejects.toMatchObject({ code: 'NOT_REGULAR_FILE' });

    const fifo = join(home, 'fifo.jsonl');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo on this platform
    }
    await expect(readJsonlValues(fifo).next()).rejects.toMatchObject({ code: 'NOT_REGULAR_FILE' });
  });

  it('reports a missing file with a NOT_FOUND code', async () => {
    await expect(readJsonlValues(join(home, 'nope.jsonl')).next()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ironcurtain audit report command', () => {
  function writeSession(id: string, persona: string | undefined, lines: object[], workflowRunId?: string): string {
    const dir = join(home, 'sessions', id);
    mkdirSync(dir, { recursive: true });
    if (persona !== undefined || workflowRunId !== undefined) {
      writeFileSync(
        join(dir, 'session-metadata.json'),
        JSON.stringify({
          createdAt: '2026-01-01',
          ...(persona !== undefined ? { persona } : {}),
          ...(workflowRunId !== undefined ? { workflowRunId } : {}),
        }),
      );
    }
    const path = join(dir, 'audit.jsonl');
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return path;
  }

  function outcome(requestId: string, status: 'success' | 'denied', persona?: string): object {
    return {
      timestamp: '2026-01-05T10:00:00.000Z',
      requestId,
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: {},
      policyDecision: { status: status === 'success' ? 'allow' : 'deny', rule: 'r', reason: 'x' },
      result: status === 'success' ? { status } : { status, error: 'x' },
      durationMs: 3,
      ...(persona !== undefined ? { persona } : {}),
    };
  }

  it('prints the fixture report as JSON for --file', async () => {
    const { code, out } = await capture(['report', '--file', FIXTURE, '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(out) as { totals: { calls: number }; escalations: { total: number } };
    expect(report.totals.calls).toBe(14);
    expect(report.escalations.total).toBe(8);
  });

  it('escapes terminal-sensitive JSON text while retaining the recorded values', async () => {
    const persona = 'review\u0085\u202e\u034f';
    const path = writeSession('neutral', persona, [outcome('neutral', 'denied', persona)]);
    const original = readFileSync(path, 'utf8');
    const { code, out } = await capture(['report', '--file', path, '--json']);
    expect(code).toBe(0);
    expect(out).not.toMatch(/\u0085|\u202e|\u034f/u);
    expect((JSON.parse(out) as { personas: { persona: string }[] }).personas[0].persona).toBe(persona);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('discovers every session and workflow bundle log, with session personas', async () => {
    writeSession('s-one', 'coder', [outcome('1', 'success'), outcome('2', 'denied')]);
    writeSession('s-two', undefined, [outcome('3', 'success')]);
    const bundleDir = join(home, 'workflow-runs', 'wf-1', 'containers', 'bundle-a');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'audit.jsonl'), JSON.stringify(outcome('4', 'success', 'planner')) + '\n');

    const { code, out } = await capture(['report', '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      sources: { label: string }[];
      totals: { calls: number };
      personas: { persona: string; calls: number }[];
    };
    expect(report.sources.map((s) => s.label)).toEqual([
      'session s-one',
      'session s-two',
      'workflow wf-1 bundle bundle-a',
    ]);
    expect(report.totals.calls).toBe(4);
    expect(report.personas.map((p) => [p.persona, p.calls])).toEqual([
      [NO_PERSONA, 1],
      ['coder', 2],
      ['planner', 1],
    ]);
  });

  it('limits the report to one session or one workflow', async () => {
    writeSession('s-one', 'coder', [outcome('1', 'success')]);
    writeSession('s-two', undefined, [outcome('2', 'success'), outcome('3', 'success')]);
    const session = JSON.parse((await capture(['report', '--session', 's-two', '--json'])).out) as {
      totals: { calls: number };
    };
    expect(session.totals.calls).toBe(2);

    const missing = await capture(['report', '--workflow', 'nope']);
    expect(missing.code).toBe(1);
  });

  it('includes the states of a workflow that ran as sessions of their own', async () => {
    // A builtin workflow (or a Docker one without sharedContainer) audits each
    // state in its own session log; the session metadata names the run.
    writeSession('s-state-1', 'coder', [outcome('1', 'success'), outcome('2', 'denied')], 'wf-solo');
    writeSession('s-state-2', undefined, [outcome('3', 'success')], 'wf-solo');
    writeSession('s-other', undefined, [outcome('4', 'success')], 'wf-other');
    writeSession('s-plain', undefined, [outcome('5', 'success')]);
    const bundleDir = join(home, 'workflow-runs', 'wf-solo', 'containers', 'bundle-a');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'audit.jsonl'), JSON.stringify(outcome('6', 'success', 'planner')) + '\n');

    const { code, out } = await capture(['report', '--workflow', 'wf-solo', '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      sources: { label: string }[];
      totals: { calls: number };
      personas: { persona: string; calls: number }[];
    };
    expect(report.sources.map((s) => s.label)).toEqual([
      'workflow wf-solo bundle bundle-a',
      'workflow wf-solo session s-state-1',
      'workflow wf-solo session s-state-2',
    ]);
    expect(report.totals.calls).toBe(4);
    expect(report.personas.map((p) => [p.persona, p.calls])).toEqual([
      [NO_PERSONA, 1],
      ['coder', 2],
      ['planner', 1],
    ]);

    // The default report lists each of those sessions once.
    const all = JSON.parse((await capture(['report', '--json'])).out) as { sources: { label: string }[] };
    expect(all.sources.map((s) => s.label)).toEqual([
      'session s-other',
      'session s-plain',
      'session s-state-1',
      'session s-state-2',
      'workflow wf-solo bundle bundle-a',
    ]);
  });

  it('skips logs last written before --since', async () => {
    const old = writeSession('s-old', undefined, [outcome('1', 'success')]);
    const past = new Date('2025-01-01T00:00:00Z');
    utimesSync(old, past, past);
    writeSession('s-new', undefined, [outcome('2', 'success')]);
    const report = JSON.parse((await capture(['report', '--since', '2026-01-01', '--json'])).out) as {
      sources: { label: string }[];
    };
    expect(report.sources.map((s) => s.label)).toEqual(['session s-new']);
  });

  it('reports usage errors with exit status 2', async () => {
    expect((await capture(['report', '--session', 'a', '--workflow', 'b'])).code).toBe(2);
    expect((await capture(['report', '--since', 'yesterday'])).code).toBe(2);
    expect((await capture(['report', '--session', '../escape'])).code).toBe(2);
    expect((await capture(['nonsense'])).code).toBe(2);
    expect((await capture([])).code).toBe(2);
    expect((await capture(['--help'])).code).toBe(0);
  });

  it('parses --since as an ISO time, epoch ms or a duration', () => {
    const now = Date.parse('2026-02-01T00:00:00.000Z');
    expect(parseSince('2026-01-31', now)).toBe(Date.parse('2026-01-31'));
    expect(parseSince('2026-01-31T12:00:00Z', now)).toBe(Date.parse('2026-01-31T12:00:00Z'));
    expect(parseSince('1700000000000', now)).toBe(1700000000000);
    expect(parseSince('24h', now)).toBe(now - 86_400_000);
    expect(parseSince('7d', now)).toBe(now - 7 * 86_400_000);
    expect(parseSince('30m', now)).toBe(now - 1_800_000);
    expect(() => parseSince('2026-13-45', now)).toThrow();
  });
});

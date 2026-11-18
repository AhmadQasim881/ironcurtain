/**
 * The npm audit gate (BLD-9): scripts/check-npm-audit.ts against the reviewed
 * allowlist in .github/npm-audit-allowlist.json. CI runs it against the live
 * advisory database; these tests feed it `npm audit --json` reports built
 * here, so they never touch the network and never depend on today's date.
 *
 * The gate passes with the committed allowlist, fails on a new high or
 * critical advisory, on an expired acceptance and on a severity raised since
 * the review, and fails closed on a report or allowlist it cannot read.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWLIST_PATH,
  AuditInputError,
  MAX_ACCEPTANCE_DAYS,
  evaluateAudit,
  main,
  parseAllowlist,
  parseAuditReport,
  type Allowlist,
  type MainIo,
  type Severity,
} from '../scripts/check-npm-audit.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMMITTED_ALLOWLIST: unknown = JSON.parse(readFileSync(join(ROOT, ALLOWLIST_PATH), 'utf-8'));

interface ViaAdvisory {
  source: number;
  name: string;
  dependency: string;
  title: string;
  url: string;
  severity: Severity;
  cwe: string[];
  cvss: { score: number; vectorString: string | null };
  range: string;
}

let nextSource = 1_300_000;

function advisory(name: string, id: string, severity: Severity, title = `${name} issue`): ViaAdvisory {
  return {
    source: nextSource++,
    name,
    dependency: name,
    title,
    url: `https://github.com/advisories/${id}`,
    severity,
    cwe: [],
    cvss: { score: 0, vectorString: null },
    range: '<99.0.0',
  };
}

/** An auditReportVersion 2 report, the shape `npm audit --json` prints. */
function report(advisories: ViaAdvisory[], effects: Record<string, string[]> = {}): unknown {
  const vulnerabilities: Record<string, unknown> = {};
  for (const via of advisories) {
    const existing = vulnerabilities[via.name] as { via: unknown[] } | undefined;
    if (existing) existing.via.push(via);
    else {
      vulnerabilities[via.name] = {
        name: via.name,
        severity: via.severity,
        isDirect: false,
        via: [via],
        effects: [],
        range: via.range,
        nodes: [`node_modules/${via.name}`],
        fixAvailable: true,
      };
    }
  }
  // Packages affected only through a vulnerable dependency name it in `via`.
  for (const [name, through] of Object.entries(effects)) {
    vulnerabilities[name] = {
      name,
      severity: 'high',
      isDirect: true,
      via: through,
      effects: [],
      range: '*',
      nodes: [`node_modules/${name}`],
      fixAvailable: false,
    };
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: {}, dependencies: {} } };
}

/** One advisory for every acceptance in the committed allowlist, at its reviewed severity. */
function reportForAllowlist(allowlist: Allowlist): ViaAdvisory[] {
  return allowlist.entries.flatMap((entry) =>
    Object.entries(entry.advisories).map(([id, severity]) => advisory(entry.package, id, severity)),
  );
}

describe('the committed allowlist', () => {
  const allowlist = parseAllowlist(COMMITTED_ALLOWLIST);

  it('is valid: reasons, dates within the acceptance window, no duplicates', () => {
    expect(allowlist.entries.length).toBeGreaterThan(0);
    for (const entry of allowlist.entries) {
      const days = (Date.parse(entry.expires) - Date.parse(entry.reviewed)) / 86_400_000;
      expect(days, entry.package).toBeGreaterThanOrEqual(0);
      expect(days, entry.package).toBeLessThanOrEqual(MAX_ACCEPTANCE_DAYS);
    }
  });

  it('passes the gate on the day of each review', () => {
    for (const entry of allowlist.entries) {
      const advisories = parseAuditReport(report(reportForAllowlist({ entries: [entry] })));
      const verdict = evaluateAudit(advisories, allowlist, { level: 'high', today: entry.reviewed });
      expect(verdict.problems, entry.package).toEqual([]);
      expect(verdict.covered.length, entry.package).toBe(advisories.length);
    }
  });

  it('covers the zod advisory whichever package pulls in a zod copy', () => {
    const zod = allowlist.entries.find((entry) => entry.package === 'zod');
    expect(zod).toBeDefined();
    const advisories = parseAuditReport(
      report(reportForAllowlist({ entries: zod === undefined ? [] : [zod] }), {
        '@anthropic-ai/sandbox-runtime': ['zod'],
        '@utcp/sdk': ['zod'],
      }),
    );
    const verdict = evaluateAudit(advisories, allowlist, { level: 'high', today: zod?.reviewed ?? '' });
    expect(verdict.problems).toEqual([]);
  });

  it('accepts only high and critical advisories: lower ones never fail the gate', () => {
    for (const entry of allowlist.entries) {
      for (const severity of Object.values(entry.advisories)) {
        expect(['high', 'critical'], entry.package).toContain(severity);
      }
    }
  });
});

describe('evaluateAudit', () => {
  const today = '2026-11-14';
  const allowlist: Allowlist = parseAllowlist({
    entries: [
      {
        package: 'undici',
        advisories: { 'GHSA-xjj6-f33q-929c': 'high' },
        reason: 'Reachable only as a denial of service of the fetch server; fixed in range.',
        reviewed: '2026-11-14',
        expires: '2026-12-14',
      },
    ],
  });
  const accepted = advisory('undici', 'GHSA-xjj6-f33q-929c', 'high');

  it('passes when every high advisory is accepted', () => {
    const verdict = evaluateAudit(parseAuditReport(report([accepted])), allowlist, { level: 'high', today });
    expect(verdict.problems).toEqual([]);
    expect(verdict.covered.map((c) => c.advisory.id)).toEqual(['GHSA-xjj6-f33q-929c']);
  });

  it('fails on a new high or critical advisory, in an accepted package or another one', () => {
    const verdict = evaluateAudit(
      parseAuditReport(
        report([
          accepted,
          advisory('undici', 'GHSA-aaaa-bbbb-cccc', 'high', 'new undici issue'),
          advisory('left-pad', 'GHSA-dddd-eeee-ffff', 'critical'),
        ]),
      ),
      allowlist,
      { level: 'high', today },
    );
    expect(verdict.problems.map((p) => [p.kind, p.advisory.package, p.advisory.id])).toEqual([
      ['uncovered', 'undici', 'GHSA-aaaa-bbbb-cccc'],
      ['uncovered', 'left-pad', 'GHSA-dddd-eeee-ffff'],
    ]);
    expect(verdict.problems[0].message).toContain('new undici issue');
  });

  it('does not let an acceptance cover the same advisory in another package', () => {
    const verdict = evaluateAudit(
      parseAuditReport(report([advisory('jsdom', 'GHSA-xjj6-f33q-929c', 'high')])),
      allowlist,
      { level: 'high', today },
    );
    expect(verdict.problems.map((p) => p.kind)).toEqual(['uncovered']);
  });

  it('lists moderate and lower advisories without failing', () => {
    const verdict = evaluateAudit(
      parseAuditReport(
        report([advisory('qs', 'GHSA-6pq8-jhm2-2vcw', 'moderate'), advisory('x', 'GHSA-gggg-hhhh-jjjj', 'low')]),
      ),
      allowlist,
      { level: 'high', today },
    );
    expect(verdict.problems).toEqual([]);
    expect(verdict.below.map((a) => a.package)).toEqual(['qs', 'x']);
  });

  it('fails once the acceptance has expired, not on its last day', () => {
    const report1 = parseAuditReport(report([accepted]));
    expect(evaluateAudit(report1, allowlist, { level: 'high', today: '2026-12-14' }).problems).toEqual([]);
    const expired = evaluateAudit(report1, allowlist, { level: 'high', today: '2026-12-15' });
    expect(expired.problems.map((p) => p.kind)).toEqual(['expired']);
    expect(expired.problems[0].message).toContain('expired on 2026-12-14');
  });

  it('fails when the severity was raised after the review', () => {
    const raised = advisory('undici', 'GHSA-xjj6-f33q-929c', 'critical');
    const verdict = evaluateAudit(parseAuditReport(report([raised])), allowlist, { level: 'high', today });
    expect(verdict.problems.map((p) => p.kind)).toEqual(['severity-raised']);
  });

  it('fails on a high advisory without a GHSA id, which no entry can name', () => {
    const odd = { ...advisory('odd', 'GHSA-kkkk-mmmm-nnnn', 'high'), url: 'https://example.test/advisory/1' };
    const verdict = evaluateAudit(parseAuditReport(report([odd])), allowlist, { level: 'high', today });
    expect(verdict.problems.map((p) => p.kind)).toEqual(['no-ghsa-id']);
  });

  it('reports acceptances whose advisory is gone as stale without failing', () => {
    const verdict = evaluateAudit(parseAuditReport(report([])), allowlist, { level: 'high', today });
    expect(verdict.problems).toEqual([]);
    expect(verdict.stale.map((s) => s.id)).toEqual(['GHSA-xjj6-f33q-929c']);
  });

  it('honours a stricter level', () => {
    const verdict = evaluateAudit(
      parseAuditReport(report([advisory('qs', 'GHSA-6pq8-jhm2-2vcw', 'moderate')])),
      allowlist,
      { level: 'moderate', today },
    );
    expect(verdict.problems.map((p) => p.kind)).toEqual(['uncovered']);
  });
});

describe('parseAuditReport', () => {
  it('fails closed on an npm error, an unknown version or a malformed entry', () => {
    expect(() => parseAuditReport({ error: { code: 'ENOTFOUND', summary: 'request to registry failed' } })).toThrow(
      /npm audit failed: request to registry failed/,
    );
    expect(() => parseAuditReport({ auditReportVersion: 1, advisories: {} })).toThrow(AuditInputError);
    expect(() => parseAuditReport({ auditReportVersion: 2 })).toThrow(/no vulnerabilities map/);
    expect(() =>
      parseAuditReport({
        auditReportVersion: 2,
        vulnerabilities: { x: { via: [{ source: 1, url: 'u', severity: 'bad' }] } },
      }),
    ).toThrow(/unknown severity/);
    expect(() => parseAuditReport('[]')).toThrow(AuditInputError);
  });

  it('keeps one advisory per npm advisory number and skips parent-package effects', () => {
    const via = advisory('undici', 'GHSA-xjj6-f33q-929c', 'high');
    const parsed = parseAuditReport(
      report([via, { ...via }, { ...via, source: via.source + 1, range: '<7.30.1' }], { jsdom: ['undici'] }),
    );
    expect(parsed.map((a) => [a.package, a.id, a.range])).toEqual([
      ['undici', 'GHSA-xjj6-f33q-929c', '<99.0.0'],
      ['undici', 'GHSA-xjj6-f33q-929c', '<7.30.1'],
    ]);
  });
});

describe('parseAllowlist', () => {
  const valid = {
    package: 'undici',
    advisories: { 'GHSA-xjj6-f33q-929c': 'high' },
    reason: 'Reachable only as a denial of service of the fetch server; fixed in range.',
    reviewed: '2026-11-14',
    expires: '2026-12-14',
  };

  it.each([
    ['a missing reason', { ...valid, reason: 'ok' }, /reason must say why/],
    ['a bad date', { ...valid, expires: '2026-02-31' }, /expires must be a YYYY-MM-DD date/],
    ['an expiry before the review', { ...valid, expires: '2026-11-01' }, /expires before it was reviewed/],
    ['an acceptance longer than the window', { ...valid, expires: '2027-11-14' }, /more than 180 days/],
    ['a non-GHSA id', { ...valid, advisories: { 'CVE-2026-1': 'high' } }, /is not a GHSA id/],
    ['an unknown severity', { ...valid, advisories: { 'GHSA-xjj6-f33q-929c': 'severe' } }, /unknown severity/],
    ['no advisories', { ...valid, advisories: {} }, /at least one GHSA id/],
    ['an unknown field', { ...valid, note: 'x' }, /unknown fields: note/],
  ])('rejects %s', (_label, entry, pattern) => {
    expect(() => parseAllowlist({ entries: [entry] })).toThrow(pattern);
  });

  it('rejects an advisory accepted twice in the same package, and a file without entries', () => {
    expect(() => parseAllowlist({ entries: [valid, valid] })).toThrow(/accepted twice/);
    expect(() => parseAllowlist({ advisories: [] })).toThrow(/"entries" array/);
  });
});

describe('main', () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'npm-audit-gate-'));
    out = [];
    err = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function io(overrides: Partial<MainIo> = {}): MainIo {
    return {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      runAudit: () => {
        throw new Error('npm audit must not run in this test');
      },
      githubActions: false,
      now: () => new Date('2026-11-14T12:00:00Z'),
      ...overrides,
    };
  }

  function writeReport(advisories: ViaAdvisory[]): string {
    const path = join(dir, 'audit.json');
    writeFileSync(path, JSON.stringify(report(advisories)));
    return path;
  }

  it('passes the committed allowlist against the advisories it accepts', () => {
    const path = writeReport(reportForAllowlist(parseAllowlist(COMMITTED_ALLOWLIST)));
    expect(main(['--report', path], io())).toBe(0);
    expect(out[0]).toMatch(/0 not;/);
  });

  it('fails on a new high advisory, with a GitHub annotation in Actions', () => {
    const accepted = reportForAllowlist(parseAllowlist(COMMITTED_ALLOWLIST));
    const path = writeReport([...accepted, advisory('left-pad', 'GHSA-dddd-eeee-ffff', 'high', 'left-pad overflow')]);
    expect(main(['--report', path], io({ githubActions: true }))).toBe(1);
    expect(out).toContainEqual(
      expect.stringMatching(/^::error::high left-pad GHSA-dddd-eeee-ffff \(left-pad overflow\)/),
    );
  });

  it('runs npm audit itself without --report, at the requested level', () => {
    const levels: string[] = [];
    const runAudit = (_root: string, level: Severity): string => {
      levels.push(level);
      return JSON.stringify(report([advisory('left-pad', 'GHSA-dddd-eeee-ffff', 'critical')]));
    };
    expect(main(['--allowlist', join(ROOT, ALLOWLIST_PATH), '--level', 'critical'], io({ runAudit }))).toBe(1);
    expect(levels).toEqual(['critical']);
  });

  it('fails closed when npm audit could not produce a report or the allowlist is invalid', () => {
    expect(main([], io({ runAudit: () => '{"error":{"summary":"getaddrinfo ENOTFOUND"}}' }))).toBe(1);
    expect(err.join('\n')).toContain('npm audit failed: getaddrinfo ENOTFOUND');

    const allowlist = join(dir, 'allowlist.json');
    writeFileSync(allowlist, '{"entries": [{}]}');
    expect(main(['--allowlist', allowlist, '--report', writeReport([])], io())).toBe(1);
    expect(err.join('\n')).toContain('invalid allowlist');
  });

  it('uses the injected clock for expiry and exits 2 on usage errors', () => {
    const accepted = reportForAllowlist(parseAllowlist(COMMITTED_ALLOWLIST));
    const path = writeReport(accepted);
    expect(main(['--report', path], io({ now: () => new Date('2027-06-01T00:00:00Z') }))).toBe(1);
    expect(out.some((line) => line.includes('expired on'))).toBe(true);
    expect(main(['--level', 'severe'], io())).toBe(2);
    expect(main(['--bogus'], io())).toBe(2);
  });
});

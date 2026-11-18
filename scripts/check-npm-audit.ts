/**
 * npm audit gate for the production dependency tree (BLD-9).
 *
 * Runs `npm audit --omit=dev --audit-level=high --json` in the repository (or
 * reads a saved report with --report) and fails when an advisory at or above
 * the threshold (default high: high and critical) is not covered by a current
 * entry of the reviewed allowlist, .github/npm-audit-allowlist.json.
 *
 * An allowlist entry names one package, the advisories it accepts in that
 * package (GHSA id -> the severity they were reviewed at), why they are
 * accepted, when they were reviewed and when the acceptance expires. An entry
 * covers an advisory only:
 *   - in the package it names (the same GHSA in another package is new),
 *   - at the reviewed severity or lower (a raised severity needs a new review),
 *   - until its `expires` date (UTC) has passed, at most 180 days after
 *     `reviewed`: an expired acceptance fails the gate, so allowlisted
 *     advisories with a fix get merged rather than accepted forever.
 * Entries that match no advisory any more (the fix was merged) are reported
 * as stale, without failing: the Dependabot pull request that fixes an
 * advisory cannot edit this file, and failing it would block the fix.
 *
 * The gate fails closed: a report it cannot read (npm audit could not reach
 * the registry, an unknown report version) fails, and so does an advisory
 * without a GHSA id, which no entry can name.
 *
 * Moderate and lower advisories are listed but never fail the gate.
 *
 * CLI: tsx scripts/check-npm-audit.ts [--report <file>] [--allowlist <file>]
 *        [--level low|moderate|high|critical] [--today YYYY-MM-DD]
 * Exits 0 when every advisory at or above the level is covered, 1 when one
 * is not or the report or allowlist is unusable, and 2 on a usage error.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Repository-relative path of the reviewed allowlist. */
export const ALLOWLIST_PATH = '.github/npm-audit-allowlist.json';

/** The longest an acceptance may last before it must be reviewed again. */
export const MAX_ACCEPTANCE_DAYS = 180;

const GHSA_ID = /^GHSA(-[0-9a-z]{4}){3}$/u;
const GHSA_URL = /^https:\/\/github\.com\/advisories\/(GHSA(?:-[0-9a-z]{4}){3})$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MIN_REASON_LENGTH = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One advisory of the report, as npm attributes it to a package. */
export interface Advisory {
  /** The GHSA id from the advisory URL; undefined when the URL has none. */
  readonly id: string | undefined;
  /** npm's advisory number: one GHSA can appear under several (one per affected version range). */
  readonly source: string;
  /** The vulnerable package. */
  readonly package: string;
  readonly severity: Severity;
  readonly title: string;
  readonly url: string;
  /** The vulnerable version range. */
  readonly range: string;
}

export interface AllowlistEntry {
  readonly package: string;
  /** GHSA id -> the severity it was reviewed at. */
  readonly advisories: Readonly<Record<string, Severity>>;
  readonly reason: string;
  /** YYYY-MM-DD. */
  readonly reviewed: string;
  /** YYYY-MM-DD; the entry covers nothing after this day (UTC). */
  readonly expires: string;
}

export interface Allowlist {
  readonly entries: readonly AllowlistEntry[];
}

export type ProblemKind = 'uncovered' | 'expired' | 'severity-raised' | 'no-ghsa-id';

export interface AuditProblem {
  readonly kind: ProblemKind;
  readonly advisory: Advisory;
  readonly entry?: AllowlistEntry;
  readonly message: string;
}

export interface CoveredAdvisory {
  readonly advisory: Advisory;
  readonly entry: AllowlistEntry;
}

export interface StaleAcceptance {
  readonly entry: AllowlistEntry;
  readonly id: string;
}

export interface AuditVerdict {
  /** Advisories at or above the threshold that the allowlist does not cover. */
  readonly problems: readonly AuditProblem[];
  /** Advisories at or above the threshold covered by a current entry. */
  readonly covered: readonly CoveredAdvisory[];
  /** Advisories below the threshold (informational). */
  readonly below: readonly Advisory[];
  /** Accepted advisories that the report no longer contains. */
  readonly stale: readonly StaleAcceptance[];
}

/** The report or allowlist cannot be used; the gate fails closed. */
export class AuditInputError extends Error {
  readonly code = 'AUDIT_INPUT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'AuditInputError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/**
 * The advisories in an `npm audit --json` report (auditReportVersion 2), one
 * per npm advisory number. Entries of `via` that are package names (a package
 * affected only through a vulnerable dependency) carry no advisory of their
 * own and are skipped: the advisory is listed under the package it affects.
 */
export function parseAuditReport(json: unknown): Advisory[] {
  if (!isRecord(json)) throw new AuditInputError('the npm audit report is not a JSON object');
  if (json.error !== undefined) {
    const error = isRecord(json.error) ? json.error : {};
    const summary = typeof error.summary === 'string' && error.summary !== '' ? error.summary : 'unknown error';
    throw new AuditInputError(`npm audit failed: ${summary}`);
  }
  if (json.auditReportVersion !== 2) {
    throw new AuditInputError(`unsupported npm audit report version: ${String(json.auditReportVersion)}`);
  }
  if (!isRecord(json.vulnerabilities)) throw new AuditInputError('the npm audit report has no vulnerabilities map');

  const advisories = new Map<string, Advisory>();
  for (const [name, vulnerability] of Object.entries(json.vulnerabilities)) {
    if (!isRecord(vulnerability) || !Array.isArray(vulnerability.via)) {
      throw new AuditInputError(`malformed npm audit entry for ${name}`);
    }
    for (const via of vulnerability.via) {
      if (typeof via === 'string') continue;
      if (!isRecord(via)) throw new AuditInputError(`malformed advisory under ${name}`);
      const { source, url, severity } = via;
      if ((typeof source !== 'number' && typeof source !== 'string') || typeof url !== 'string') {
        throw new AuditInputError(`advisory under ${name} has no source or url`);
      }
      if (!isSeverity(severity)) throw new AuditInputError(`advisory ${url} has unknown severity ${String(severity)}`);
      const pkg = typeof via.name === 'string' ? via.name : name;
      const key = `${String(source)}\u0000${pkg}`;
      if (advisories.has(key)) continue;
      advisories.set(key, {
        id: GHSA_URL.exec(url)?.[1],
        source: String(source),
        package: pkg,
        severity,
        title: typeof via.title === 'string' ? via.title : '',
        url,
        range: typeof via.range === 'string' ? via.range : '',
      });
    }
  }
  return [...advisories.values()];
}

function parseDate(value: string): number | undefined {
  if (!ISO_DATE.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  // Rejects dates such as 2026-02-31, which Date.parse would roll over.
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value) ? time : undefined;
}

/** Validates the allowlist file; every problem is reported at once. */
export function parseAllowlist(json: unknown): Allowlist {
  if (!isRecord(json) || !Array.isArray(json.entries)) {
    throw new AuditInputError('the allowlist must be an object with an "entries" array');
  }
  const problems: string[] = [];
  const entries: AllowlistEntry[] = [];
  const seen = new Set<string>();
  json.entries.forEach((raw: unknown, index: number) => {
    const at = `entries[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const { package: pkg, advisories, reason, reviewed, expires } = raw;
    const unknownKeys = Object.keys(raw).filter(
      (key) => !['package', 'advisories', 'reason', 'reviewed', 'expires'].includes(key),
    );
    if (unknownKeys.length > 0) problems.push(`${at} has unknown fields: ${unknownKeys.join(', ')}`);
    if (typeof pkg !== 'string' || pkg === '') problems.push(`${at}.package must be a package name`);
    if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LENGTH) {
      problems.push(
        `${at}.reason must say why the advisories cannot be exploited (at least ${MIN_REASON_LENGTH} characters)`,
      );
    }
    const reviewedAt = typeof reviewed === 'string' ? parseDate(reviewed) : undefined;
    const expiresAt = typeof expires === 'string' ? parseDate(expires) : undefined;
    if (reviewedAt === undefined) problems.push(`${at}.reviewed must be a YYYY-MM-DD date`);
    if (expiresAt === undefined) problems.push(`${at}.expires must be a YYYY-MM-DD date`);
    if (reviewedAt !== undefined && expiresAt !== undefined) {
      if (expiresAt < reviewedAt) problems.push(`${at} expires before it was reviewed`);
      if (expiresAt - reviewedAt > MAX_ACCEPTANCE_DAYS * DAY_MS) {
        problems.push(`${at} expires more than ${MAX_ACCEPTANCE_DAYS} days after its review`);
      }
    }
    if (!isRecord(advisories) || Object.keys(advisories).length === 0) {
      problems.push(`${at}.advisories must map at least one GHSA id to a severity`);
    } else {
      for (const [id, severity] of Object.entries(advisories)) {
        if (!GHSA_ID.test(id)) problems.push(`${at}.advisories: ${id} is not a GHSA id`);
        if (!isSeverity(severity)) problems.push(`${at}.advisories.${id}: unknown severity ${String(severity)}`);
        const key = `${String(pkg)}\u0000${id}`;
        if (seen.has(key)) problems.push(`${at}: ${id} in ${String(pkg)} is accepted twice`);
        seen.add(key);
      }
    }
    if (problems.length === 0) {
      entries.push({
        package: pkg as string,
        advisories: advisories as Record<string, Severity>,
        reason: reason as string,
        reviewed: reviewed as string,
        expires: expires as string,
      });
    }
  });
  if (problems.length > 0) throw new AuditInputError(`invalid allowlist:\n  ${problems.join('\n  ')}`);
  return { entries };
}

export interface EvaluateOptions {
  /** Advisories at or above this severity fail the gate unless covered. */
  readonly level: Severity;
  /** YYYY-MM-DD (UTC): entries expired before this day cover nothing. */
  readonly today: string;
}

/** Checks the report's advisories against the allowlist. */
export function evaluateAudit(
  advisories: readonly Advisory[],
  allowlist: Allowlist,
  options: EvaluateOptions,
): AuditVerdict {
  const today = parseDate(options.today);
  if (today === undefined) throw new AuditInputError(`--today must be a YYYY-MM-DD date: ${options.today}`);
  const threshold = severityRank(options.level);

  const byKey = new Map<string, AllowlistEntry>();
  for (const entry of allowlist.entries) {
    for (const id of Object.keys(entry.advisories)) byKey.set(`${entry.package}\u0000${id}`, entry);
  }

  const problems: AuditProblem[] = [];
  const covered: CoveredAdvisory[] = [];
  const below: Advisory[] = [];
  const used = new Set<string>();
  for (const advisory of advisories) {
    const key = advisory.id === undefined ? undefined : `${advisory.package}\u0000${advisory.id}`;
    if (key !== undefined && byKey.has(key)) used.add(key);
    if (severityRank(advisory.severity) < threshold) {
      below.push(advisory);
      continue;
    }
    const label = `${advisory.severity} ${advisory.package} ${advisory.id ?? advisory.url} (${advisory.title})`;
    if (advisory.id === undefined || key === undefined) {
      problems.push({
        kind: 'no-ghsa-id',
        advisory,
        message: `${label}: no GHSA id, so no allowlist entry can accept it`,
      });
      continue;
    }
    const entry = byKey.get(key);
    if (entry === undefined) {
      problems.push({ kind: 'uncovered', advisory, message: `${label}: not in ${ALLOWLIST_PATH}` });
      continue;
    }
    const reviewedSeverity = entry.advisories[advisory.id];
    if (severityRank(advisory.severity) > severityRank(reviewedSeverity)) {
      problems.push({
        kind: 'severity-raised',
        advisory,
        entry,
        message: `${label}: raised from ${reviewedSeverity} since its review on ${entry.reviewed}; review it again`,
      });
      continue;
    }
    // parseAllowlist validated the date.
    if ((parseDate(entry.expires) ?? 0) < today) {
      problems.push({
        kind: 'expired',
        advisory,
        entry,
        message: `${label}: its acceptance expired on ${entry.expires}; merge the fix or review it again`,
      });
      continue;
    }
    covered.push({ advisory, entry });
  }

  const stale: StaleAcceptance[] = [];
  for (const entry of allowlist.entries) {
    for (const id of Object.keys(entry.advisories)) {
      if (!used.has(`${entry.package}\u0000${id}`)) stale.push({ entry, id });
    }
  }
  return { problems, covered, below, stale };
}

/** What the gate prints; GitHub Actions annotations when running there. */
export function formatVerdict(verdict: AuditVerdict, options: EvaluateOptions, githubActions = false): string[] {
  const lines: string[] = [];
  const total = verdict.problems.length + verdict.covered.length;
  lines.push(
    `npm audit (production dependencies): ${total} advisories at or above ${options.level}, ` +
      `${verdict.covered.length} accepted by ${ALLOWLIST_PATH}, ${verdict.problems.length} not; ` +
      `${verdict.below.length} below ${options.level}.`,
  );
  for (const { advisory, entry } of verdict.covered) {
    lines.push(`  accepted  ${advisory.severity} ${advisory.package} ${advisory.id ?? ''} until ${entry.expires}`);
  }
  for (const advisory of verdict.below) {
    lines.push(`  below     ${advisory.severity} ${advisory.package} ${advisory.id ?? advisory.url}`);
  }
  for (const { entry, id } of verdict.stale) {
    const message = `${ALLOWLIST_PATH}: ${id} in ${entry.package} is no longer reported; remove it from the allowlist`;
    lines.push(githubActions ? `::warning::${message}` : `  stale     ${message}`);
  }
  for (const problem of verdict.problems) {
    lines.push(githubActions ? `::error::${problem.message}` : `  FAIL      ${problem.message}`);
  }
  if (verdict.problems.length > 0) {
    lines.push(
      `Each failing advisory needs its fix merged, or a reviewed entry in ${ALLOWLIST_PATH} saying why it ` +
        'cannot be exploited here (see docs/designs/dependency-hygiene.md).',
    );
  }
  return lines;
}

/** Runs npm audit in `root` and returns its JSON output. */
export type RunAudit = (root: string, level: Severity) => string;

const runNpmAudit: RunAudit = (root, level) => {
  // npm exits 1 when it finds advisories at or above --audit-level: that is
  // a report, not a failure. Only unusable output fails (in parseAuditReport).
  const result = spawnSync('npm', ['audit', '--omit=dev', `--audit-level=${level}`, '--json'], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw new AuditInputError(`could not run npm audit: ${result.error.message}`);
  if (result.stdout.trim() === '') {
    throw new AuditInputError(`npm audit printed no report: ${result.stderr.trim().slice(0, 500)}`);
  }
  return result.stdout;
};

function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new AuditInputError(
      `cannot read the ${what} ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseJson(text, `the ${what} ${path}`);
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AuditInputError(`${what} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface MainIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly runAudit: RunAudit;
  readonly githubActions: boolean;
  readonly now: () => Date;
}

const defaultIo: MainIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  runAudit: runNpmAudit,
  githubActions: process.env.GITHUB_ACTIONS === 'true',
  now: () => new Date(),
};

export function main(argv: string[], io: MainIo = defaultIo): number {
  let values: { report?: string; allowlist?: string; level?: string; today?: string; root?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        report: { type: 'string' },
        allowlist: { type: 'string' },
        level: { type: 'string' },
        today: { type: 'string' },
        root: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const level = values.level ?? 'high';
  if (!isSeverity(level)) {
    io.err(`--level must be one of ${SEVERITIES.join(', ')}`);
    return 2;
  }
  const root = resolve(values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const options: EvaluateOptions = { level, today: values.today ?? io.now().toISOString().slice(0, 10) };

  try {
    const allowlist = parseAllowlist(readJson(resolve(values.allowlist ?? join(root, ALLOWLIST_PATH)), 'allowlist'));
    const report =
      values.report === undefined
        ? parseJson(io.runAudit(root, level), 'the npm audit output')
        : readJson(resolve(values.report), 'npm audit report');
    const verdict = evaluateAudit(parseAuditReport(report), allowlist, options);
    for (const line of formatVerdict(verdict, options, io.githubActions)) io.out(line);
    return verdict.problems.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof AuditInputError)) throw error;
    io.err(io.githubActions ? `::error::${error.message.replace(/\n/gu, ' ')}` : `npm audit gate: ${error.message}`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}

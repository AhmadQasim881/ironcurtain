/**
 * Tool-call audit log analysis (`ironcurtain audit report`).
 *
 * Streams one or more `audit.jsonl` files (sessions, workflow bundles, or an
 * explicit file) and summarizes the policy decisions they record: calls by
 * outcome, decisions as first evaluated, decisions by rule, the most-used
 * tools, the most frequent denials with their reasons, how escalations were
 * settled (human, auto-approver, whitelist, timeout, cancellation), latency
 * percentiles of dispatched calls, and per-persona slices.
 *
 * One call, one count. The pipeline appends a write-ahead `dispatching`
 * record before a call acts and an outcome record after it (plus an interim
 * `error` record before a roots-race retry); the report counts each call
 * once, by its outcome record, and reports write-ahead records that never
 * got an outcome as "in flight" (the process died, or the log broke, while
 * the call ran).
 *
 * The report is read-only and deterministic for a given set of logs. Every
 * string it shows from a log (tool names, rules, denial reasons, personas,
 * timestamps) is escaped for the terminal by the formatter; the CLI's JSON
 * output uses Unicode escapes and decodes to the original values.
 */

import {
  AUDIT_STATUS_DISPATCHING,
  HUMAN_DENIAL_REASON,
  ROOTS_RACE_RETRY_ERROR_PREFIX,
  type AuditEntry,
} from '../types/audit.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { emptyJsonlReadStats, readJsonlValues, type JsonlReadStats } from './jsonl-reader.js';

/** One audit log to read. */
export interface AuditLogSource {
  readonly path: string;
  /** What the log belongs to, e.g. `session 1a2b…` or `workflow wf-1 bundle 3c4d…`. */
  readonly label: string;
  /**
   * Persona for records that carry none. Single-session audit entries are not
   * stamped with a persona; the session's metadata names it.
   */
  readonly defaultPersona?: string;
}

export interface AuditReportOptions {
  /** Only records at or after this time (epoch ms). */
  readonly since?: number;
  /** Clock seam for `generatedAt`. */
  readonly now?: () => Date;
}

/** How an escalated call was settled. */
export type EscalationOutcome =
  | 'humanApproved'
  | 'humanDenied'
  | 'autoApproved'
  | 'whitelistApproved'
  | 'timedOut'
  | 'cancelled'
  /** Denied without anyone deciding: no escalation handler, or the wait failed. */
  | 'unanswered';

export type EscalationCounts = Record<EscalationOutcome, number> & { total: number };

export interface OutcomeCounts {
  success: number;
  denied: number;
  error: number;
}

export interface DecisionCounts {
  allow: number;
  deny: number;
  escalate: number;
}

export interface AuditReportSource {
  readonly path: string;
  readonly label: string;
  readonly records: number;
  readonly calls: number;
  readonly inFlight: number;
  readonly malformedLines: number;
  readonly oversizedLines: number;
  /** Valid JSON lines that are not audit records. */
  readonly invalidRecords: number;
  /** Set when the file could not be read at all. */
  readonly error?: string;
}

export interface RuleRow extends DecisionCounts, OutcomeCounts {
  readonly rule: string;
  calls: number;
}

export interface ToolRow extends OutcomeCounts {
  readonly server: string;
  readonly tool: string;
  calls: number;
  escalated: number;
}

export interface DenialRow {
  readonly rule: string;
  readonly reason: string;
  count: number;
}

export interface PersonaRow extends OutcomeCounts {
  readonly persona: string;
  calls: number;
  escalations: EscalationCounts;
}

export interface LatencySummary {
  /** Dispatched calls (success or error outcome) with a duration. */
  readonly samples: number;
  readonly p50?: number;
  readonly p95?: number;
  readonly p99?: number;
  readonly max?: number;
  /** True when more samples were seen than kept (percentiles cover the first ones). */
  readonly truncated?: boolean;
}

export interface AuditReport {
  readonly generatedAt: string;
  readonly since?: string;
  readonly sources: readonly AuditReportSource[];
  readonly totals: {
    /** Audit records read (write-ahead records included). */
    readonly records: number;
    /** Calls with an outcome record. */
    readonly calls: number;
    /** Write-ahead records without an outcome record. */
    readonly inFlight: number;
    /** Interim records written before a roots-race retry. */
    readonly retries: number;
    /** Records skipped by `since`. */
    readonly skippedBeforeSince: number;
    readonly malformedLines: number;
    readonly oversizedLines: number;
    readonly invalidRecords: number;
    readonly firstTimestamp?: string;
    readonly lastTimestamp?: string;
  };
  readonly outcomes: OutcomeCounts;
  /** Decisions as the policy first evaluated each call. */
  readonly decisions: DecisionCounts;
  readonly escalations: EscalationCounts;
  readonly latencyMs: LatencySummary;
  readonly rules: readonly RuleRow[];
  readonly tools: readonly ToolRow[];
  readonly denials: readonly DenialRow[];
  readonly personas: readonly PersonaRow[];
  /** Grouping tables that hit their size cap (overflow counted under `(other)`). */
  readonly truncatedGroups: readonly string[];
}

/** Distinct keys kept per grouping table; the rest are counted under {@link OTHER}. */
const MAX_GROUP_KEYS = 5_000;
/** Duration samples kept for the percentiles. */
const MAX_LATENCY_SAMPLES = 2_000_000;
/** Denial reasons longer than this are cut before grouping. */
const MAX_REASON_CHARS = 300;
const OTHER = '(other)';
/** Persona slice for records with no persona (single sessions without one). */
export const NO_PERSONA = '(none)';

/** An audit record as far as the report relies on it. */
type ReportRecord = Pick<
  AuditEntry,
  | 'timestamp'
  | 'requestId'
  | 'serverName'
  | 'toolName'
  | 'policyDecision'
  | 'escalationResult'
  | 'result'
  | 'durationMs'
  | 'autoApproved'
  | 'whitelistApproved'
  | 'persona'
>;

const DECISION_STATUSES: ReadonlySet<string> = new Set(['allow', 'deny', 'escalate']);
const RESULT_STATUSES: ReadonlySet<string> = new Set(['success', 'denied', 'error', AUDIT_STATUS_DISPATCHING]);
const ESCALATION_RESULTS: ReadonlySet<string> = new Set(['approved', 'denied', 'timed-out', 'cancelled']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Shape check for one parsed line; anything else counts as an invalid record. */
export function asReportRecord(value: unknown): ReportRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (!isNonEmptyString(r.timestamp) || !isNonEmptyString(r.requestId)) return undefined;
  if (typeof r.serverName !== 'string' || typeof r.toolName !== 'string') return undefined;
  const decision = r.policyDecision as Record<string, unknown> | null | undefined;
  if (typeof decision !== 'object' || decision === null) return undefined;
  if (typeof decision.status !== 'string' || !DECISION_STATUSES.has(decision.status)) return undefined;
  if (typeof decision.rule !== 'string' || typeof decision.reason !== 'string') return undefined;
  const result = r.result as Record<string, unknown> | null | undefined;
  if (typeof result !== 'object' || result === null) return undefined;
  if (typeof result.status !== 'string' || !RESULT_STATUSES.has(result.status)) return undefined;
  if (result.error !== undefined && typeof result.error !== 'string') return undefined;
  if (r.escalationResult !== undefined && !ESCALATION_RESULTS.has(r.escalationResult as string)) return undefined;
  if (r.persona !== undefined && typeof r.persona !== 'string') return undefined;
  return value as ReportRecord;
}

/** How an escalated call was settled, or undefined for a call that did not escalate. */
export function classifyEscalation(
  record: Pick<ReportRecord, 'escalationResult' | 'autoApproved' | 'whitelistApproved' | 'policyDecision'>,
): EscalationOutcome | undefined {
  switch (record.escalationResult) {
    case undefined:
      return undefined;
    case 'approved':
      if (record.whitelistApproved === true) return 'whitelistApproved';
      if (record.autoApproved === true) return 'autoApproved';
      return 'humanApproved';
    case 'timed-out':
      return 'timedOut';
    case 'cancelled':
      return 'cancelled';
    case 'denied':
      return record.policyDecision.reason === HUMAN_DENIAL_REASON ? 'humanDenied' : 'unanswered';
  }
}

function emptyEscalations(): EscalationCounts {
  return {
    total: 0,
    humanApproved: 0,
    humanDenied: 0,
    autoApproved: 0,
    whitelistApproved: 0,
    timedOut: 0,
    cancelled: 0,
    unanswered: 0,
  };
}

/** Nearest-rank percentile of sorted samples. */
function percentile(sorted: Float64Array, p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** Unambiguous grouping key for two strings (they may contain any character). */
function encodePair(a: string, b: string): string {
  return JSON.stringify([a, b]);
}

function decodePair(key: string): [string, string] {
  const [a, b] = JSON.parse(key) as [string, string];
  return [a, b];
}

/** A size-capped grouping table whose overflow lands in one `(other)` row. */
class GroupTable<T> {
  private readonly rows = new Map<string, T>();
  overflowed = false;

  constructor(
    private readonly create: (key: string) => T,
    private readonly otherKey: string,
  ) {}

  get(key: string): T {
    const existing = this.rows.get(key);
    if (existing !== undefined) return existing;
    if (this.rows.size >= MAX_GROUP_KEYS) {
      this.overflowed = true;
      const other = this.rows.get(this.otherKey);
      if (other !== undefined) return other;
      const row = this.create(this.otherKey);
      this.rows.set(this.otherKey, row);
      return row;
    }
    const row = this.create(key);
    this.rows.set(key, row);
    return row;
  }

  values(): T[] {
    return [...this.rows.values()];
  }
}

/** Accumulates records into an {@link AuditReport}. */
export class AuditReportBuilder {
  private readonly since: number | undefined;
  private readonly sources: AuditReportSource[] = [];
  private records = 0;
  private calls = 0;
  private inFlight = 0;
  private retries = 0;
  private skippedBeforeSince = 0;
  private malformedLines = 0;
  private oversizedLines = 0;
  private invalidRecords = 0;
  private firstTimestamp: string | undefined;
  private firstTime = Number.POSITIVE_INFINITY;
  private lastTimestamp: string | undefined;
  private lastTime = Number.NEGATIVE_INFINITY;
  private readonly outcomes: OutcomeCounts = { success: 0, denied: 0, error: 0 };
  private readonly decisions: DecisionCounts = { allow: 0, deny: 0, escalate: 0 };
  private readonly escalations = emptyEscalations();
  private latency = new Float64Array(1024);
  private latencyCount = 0;
  private latencyTruncated = false;
  private readonly rules = new GroupTable<RuleRow>(
    (rule) => ({ rule, calls: 0, allow: 0, deny: 0, escalate: 0, success: 0, denied: 0, error: 0 }),
    OTHER,
  );
  private readonly tools = new GroupTable<ToolRow>((key) => {
    const [server, tool] = key === OTHER ? [OTHER, OTHER] : decodePair(key);
    return { server, tool, calls: 0, escalated: 0, success: 0, denied: 0, error: 0 };
  }, OTHER);
  private readonly denials = new GroupTable<DenialRow>((key) => {
    const [rule, reason] = key === OTHER ? [OTHER, OTHER] : decodePair(key);
    return { rule, reason, count: 0 };
  }, OTHER);
  private readonly personas = new GroupTable<PersonaRow>(
    (persona) => ({ persona, calls: 0, success: 0, denied: 0, error: 0, escalations: emptyEscalations() }),
    OTHER,
  );

  constructor(options: Pick<AuditReportOptions, 'since'> = {}) {
    this.since = options.since;
  }

  /** Reads one audit log into the report. A file that cannot be read is listed with its error. */
  async addSource(source: AuditLogSource): Promise<void> {
    const stats: JsonlReadStats = emptyJsonlReadStats();
    let records = 0;
    let calls = 0;
    let invalid = 0;
    // Write-ahead records still waiting for their outcome, by requestId.
    const dispatched = new Set<string>();
    let error: string | undefined;
    try {
      for await (const value of readJsonlValues(source.path, stats)) {
        const record = asReportRecord(value);
        if (record === undefined) {
          invalid += 1;
          continue;
        }
        const time = Date.parse(record.timestamp);
        if (this.since !== undefined && !(time >= this.since)) {
          this.skippedBeforeSince += 1;
          continue;
        }
        records += 1;
        this.noteTimestamp(record.timestamp, time);
        if (record.result.status === AUDIT_STATUS_DISPATCHING) {
          dispatched.add(record.requestId);
          continue;
        }
        if (record.result.status === 'error' && record.result.error?.startsWith(ROOTS_RACE_RETRY_ERROR_PREFIX)) {
          // Interim record: the retried call's outcome follows.
          this.retries += 1;
          dispatched.add(record.requestId);
          continue;
        }
        dispatched.delete(record.requestId);
        calls += 1;
        this.addCall(record, source.defaultPersona);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    this.records += records;
    this.calls += calls;
    this.inFlight += dispatched.size;
    this.malformedLines += stats.malformed;
    this.oversizedLines += stats.oversized;
    this.invalidRecords += invalid;
    this.sources.push({
      path: source.path,
      label: source.label,
      records,
      calls,
      inFlight: dispatched.size,
      malformedLines: stats.malformed,
      oversizedLines: stats.oversized,
      invalidRecords: invalid,
      ...(error !== undefined ? { error } : {}),
    });
  }

  private noteTimestamp(timestamp: string, time: number): void {
    if (Number.isNaN(time)) return;
    if (time < this.firstTime) {
      this.firstTime = time;
      this.firstTimestamp = timestamp;
    }
    if (time > this.lastTime) {
      this.lastTime = time;
      this.lastTimestamp = timestamp;
    }
  }

  private addCall(record: ReportRecord, defaultPersona: string | undefined): void {
    const status = record.result.status as keyof OutcomeCounts;
    const escalation = classifyEscalation(record);
    // A call that escalated keeps `escalationResult`; its policyDecision then
    // holds the settled decision, so the escalation is what was evaluated.
    const evaluated: keyof DecisionCounts = escalation !== undefined ? 'escalate' : record.policyDecision.status;

    this.outcomes[status] += 1;
    this.decisions[evaluated] += 1;
    if (escalation !== undefined) {
      this.escalations.total += 1;
      this.escalations[escalation] += 1;
    }

    const rule = this.rules.get(record.policyDecision.rule || '(none)');
    rule.calls += 1;
    rule[evaluated] += 1;
    rule[status] += 1;

    const tool = this.tools.get(encodePair(record.serverName, record.toolName));
    tool.calls += 1;
    tool[status] += 1;
    if (escalation !== undefined) tool.escalated += 1;

    if (status === 'denied') {
      const reason = (record.result.error ?? record.policyDecision.reason).slice(0, MAX_REASON_CHARS);
      this.denials.get(encodePair(record.policyDecision.rule || '(none)', reason)).count += 1;
    }

    const persona = this.personas.get(record.persona ?? defaultPersona ?? NO_PERSONA);
    persona.calls += 1;
    persona[status] += 1;
    if (escalation !== undefined) {
      persona.escalations.total += 1;
      persona.escalations[escalation] += 1;
    }

    if ((status === 'success' || status === 'error') && Number.isFinite(record.durationMs) && record.durationMs >= 0) {
      this.addLatency(record.durationMs);
    }
  }

  private addLatency(ms: number): void {
    if (this.latencyCount >= MAX_LATENCY_SAMPLES) {
      this.latencyTruncated = true;
      return;
    }
    if (this.latencyCount === this.latency.length) {
      const grown = new Float64Array(Math.min(this.latency.length * 2, MAX_LATENCY_SAMPLES));
      grown.set(this.latency);
      this.latency = grown;
    }
    this.latency[this.latencyCount] = ms;
    this.latencyCount += 1;
  }

  private latencySummary(): LatencySummary {
    if (this.latencyCount === 0) return { samples: 0 };
    const sorted = this.latency.slice(0, this.latencyCount).sort();
    return {
      samples: this.latencyCount,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1],
      ...(this.latencyTruncated ? { truncated: true } : {}),
    };
  }

  build(options: Pick<AuditReportOptions, 'now'> = {}): AuditReport {
    const truncatedGroups: string[] = [];
    if (this.rules.overflowed) truncatedGroups.push('rules');
    if (this.tools.overflowed) truncatedGroups.push('tools');
    if (this.denials.overflowed) truncatedGroups.push('denials');
    if (this.personas.overflowed) truncatedGroups.push('personas');
    const byCallsThen = <T extends { calls: number }>(key: (row: T) => string) => {
      return (a: T, b: T): number => b.calls - a.calls || key(a).localeCompare(key(b));
    };
    return {
      generatedAt: (options.now?.() ?? new Date()).toISOString(),
      ...(this.since !== undefined ? { since: new Date(this.since).toISOString() } : {}),
      sources: this.sources,
      totals: {
        records: this.records,
        calls: this.calls,
        inFlight: this.inFlight,
        retries: this.retries,
        skippedBeforeSince: this.skippedBeforeSince,
        malformedLines: this.malformedLines,
        oversizedLines: this.oversizedLines,
        invalidRecords: this.invalidRecords,
        ...(this.firstTimestamp !== undefined ? { firstTimestamp: this.firstTimestamp } : {}),
        ...(this.lastTimestamp !== undefined ? { lastTimestamp: this.lastTimestamp } : {}),
      },
      outcomes: { ...this.outcomes },
      decisions: { ...this.decisions },
      escalations: { ...this.escalations },
      latencyMs: this.latencySummary(),
      rules: this.rules.values().sort(byCallsThen((row) => row.rule)),
      tools: this.tools.values().sort(byCallsThen((row) => `${row.server}/${row.tool}`)),
      denials: this.denials
        .values()
        .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule) || a.reason.localeCompare(b.reason)),
      personas: this.personas.values().sort((a, b) => a.persona.localeCompare(b.persona)),
      truncatedGroups,
    };
  }
}

/** Reads `sources` in order and returns the report. */
export async function buildAuditReport(
  sources: readonly AuditLogSource[],
  options: AuditReportOptions = {},
): Promise<AuditReport> {
  const builder = new AuditReportBuilder(options);
  for (const source of sources) await builder.addSource(source);
  return builder.build(options);
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

export interface FormatAuditReportOptions {
  /** Rows shown per table (default 15). */
  readonly top?: number;
}

/** Escapes agent-influenced text for the terminal and caps its width. */
function show(value: string, maxLength = 80): string {
  return toDisplayText(value, { maxLength });
}

function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

/** Renders rows as aligned columns; numeric columns are right-aligned. */
function table(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string[] {
  const cells = rows.map((row) => row.map((cell) => String(cell)));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i].length)));
  const numeric = headers.map((_h, i) => rows.length > 0 && rows.every((row) => typeof row[i] === 'number'));
  const render = (row: readonly string[]): string =>
    '  ' +
    row
      .map((cell, i) => (numeric[i] ? padStart(cell, widths[i]) : padEnd(cell, widths[i])))
      .join('  ')
      .trimEnd();
  return [render(headers), ...cells.map(render)];
}

function formatMs(value: number | undefined): string {
  return value === undefined ? '-' : `${Math.round(value)} ms`;
}

/** The human-readable report. */
export function formatAuditReport(report: AuditReport, options: FormatAuditReportOptions = {}): string {
  const top = options.top ?? 15;
  const lines: string[] = [];
  const { totals } = report;
  lines.push('IronCurtain audit report');
  // The period comes from the records' own timestamps, which only had to
  // satisfy Date.parse (that accepts legacy forms with free-text comments).
  lines.push(
    `Logs: ${report.sources.length}` +
      (report.since !== undefined ? `   since ${report.since}` : '') +
      (totals.firstTimestamp !== undefined && totals.lastTimestamp !== undefined
        ? `   period ${show(totals.firstTimestamp, 40)} .. ${show(totals.lastTimestamp, 40)}`
        : ''),
  );
  for (const source of report.sources) {
    if (source.error !== undefined) lines.push(`  ! ${show(source.label)}: ${show(source.error, 200)}`);
  }
  const skipped = totals.malformedLines + totals.oversizedLines + totals.invalidRecords;
  lines.push('');
  lines.push(
    `Calls: ${totals.calls} (success ${report.outcomes.success}, denied ${report.outcomes.denied}, ` +
      `error ${report.outcomes.error})` +
      (totals.inFlight > 0 ? `; ${totals.inFlight} in flight with no outcome` : '') +
      (skipped > 0 ? `; ${skipped} unreadable line(s) skipped` : ''),
  );
  lines.push(
    `Decisions as evaluated: allow ${report.decisions.allow}, deny ${report.decisions.deny}, ` +
      `escalate ${report.decisions.escalate}`,
  );
  const e = report.escalations;
  lines.push(
    `Escalations: ${e.total} (human approved ${e.humanApproved}, human denied ${e.humanDenied}, ` +
      `auto-approved ${e.autoApproved}, whitelist ${e.whitelistApproved}, timed out ${e.timedOut}, ` +
      `cancelled ${e.cancelled}, unanswered ${e.unanswered})`,
  );
  const l = report.latencyMs;
  lines.push(
    l.samples === 0
      ? 'Latency: no dispatched calls'
      : `Latency of dispatched calls (n=${l.samples}${l.truncated === true ? ', truncated' : ''}): ` +
          `p50 ${formatMs(l.p50)}, p95 ${formatMs(l.p95)}, p99 ${formatMs(l.p99)}, max ${formatMs(l.max)}`,
  );

  if (report.rules.length > 0) {
    lines.push('', 'Decisions by rule');
    lines.push(
      ...table(
        ['RULE', 'CALLS', 'ALLOW', 'DENY', 'ESCALATE', 'SUCCESS', 'DENIED', 'ERROR'],
        report.rules
          .slice(0, top)
          .map((r) => [show(r.rule, 60), r.calls, r.allow, r.deny, r.escalate, r.success, r.denied, r.error]),
      ),
    );
  }
  if (report.tools.length > 0) {
    lines.push('', 'Top tools');
    lines.push(
      ...table(
        ['TOOL', 'CALLS', 'SUCCESS', 'DENIED', 'ERROR', 'ESCALATED'],
        report.tools
          .slice(0, top)
          .map((t) => [show(`${t.server}/${t.tool}`, 60), t.calls, t.success, t.denied, t.error, t.escalated]),
      ),
    );
  }
  if (report.denials.length > 0) {
    lines.push('', 'Top denials');
    lines.push(
      ...table(
        ['COUNT', 'RULE', 'REASON'],
        report.denials.slice(0, top).map((d) => [d.count, show(d.rule, 40), show(d.reason, 100)]),
      ),
    );
  }
  if (report.personas.length > 1 || (report.personas.length === 1 && report.personas[0].persona !== NO_PERSONA)) {
    lines.push('', 'By persona');
    lines.push(
      ...table(
        ['PERSONA', 'CALLS', 'SUCCESS', 'DENIED', 'ERROR', 'ESCALATED', 'HUMAN-OK', 'HUMAN-NO', 'AUTO', 'WHITELIST'],
        report.personas.map((p) => [
          show(p.persona, 40),
          p.calls,
          p.success,
          p.denied,
          p.error,
          p.escalations.total,
          p.escalations.humanApproved,
          p.escalations.humanDenied,
          p.escalations.autoApproved,
          p.escalations.whitelistApproved,
        ]),
      ),
    );
  }
  if (report.truncatedGroups.length > 0) {
    lines.push(
      '',
      `Note: too many distinct values in ${report.truncatedGroups.join(', ')}; the rest are under ${OTHER}.`,
    );
  }
  return lines.join('\n') + '\n';
}

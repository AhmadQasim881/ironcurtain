import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { formatHelp, type CommandSpec } from '../cli-help.js';
import { getLlmStatisticsDatabasePath, getLlmStatisticsIdentityKeyPath } from '../config/paths.js';
import { toDisplayText, toTerminalSafeJsonText } from '../terminal/display-sanitize.js';
import { loadStatisticsLabelProtector, rotateLlmStatisticsIdentityKey } from './identity-protector.js';
import type {
  LlmDeleteBeforeOptions,
  LlmDeleteBeforeResult,
  LlmMetricsReadRepository,
  LlmMetricsRepository,
  LlmStatisticsDimension,
} from './persistence/repository.js';
import { compactLlmMetricsDatabase, type LlmMetricsCompactionResult } from './persistence/maintenance.js';
import { openSqliteLlmMetricsReader, SqliteLlmMetricsRepository } from './persistence/sqlite-repository.js';
import { BOUNDED_STATISTICS_DELETE_OPTIONS } from './persistence/delete-policy.js';
import { isStatisticsLimitError, MAX_STATISTICS_RANGE_DAYS } from './query-contract.js';
import { LlmStatisticsQueryService, type MetricSummary, type LlmStatisticsMeasure } from './query-service.js';
import { createStatisticsLabelResolver, type StatisticsLabelCandidatesSource } from './statistics-labels.js';

const MAX_DELETE_PASSES = 10_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
/**
 * Waits after a busy maintenance lease, doubling from 200 ms to 5 s (about
 * 21 s in all). Leases are short (BOUNDED_STATISTICS_DELETE_OPTIONS) and one
 * left by a crashed process expires within its 5 s duration, so a lease that
 * stays busy that long belongs to a live process doing its own deletion.
 */
const BUSY_RETRY_DELAYS_MS: readonly number[] = [200, 400, 800, 1_600, 3_200, 5_000, 5_000, 5_000];
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SUMMARY_DAYS = 30;
const SUMMARY_TOP_GROUPS = 10;
const LABEL_DISPLAY_LENGTH = 60;

type StatisticsManagementRepository = Pick<LlmMetricsRepository, 'deleteBefore' | 'close'>;
type StatisticsSummaryRepository = LlmMetricsReadRepository & { close(): Promise<void> };

export interface StatisticsCommandDependencies {
  readonly databasePath?: string;
  /** Directory of the identity key; defaults to the database's directory. */
  readonly statisticsDirectory?: string;
  /** Existence check for the database and identity-key files. */
  readonly databaseExists?: (path: string) => boolean;
  readonly openRepository?: (path: string) => Promise<StatisticsManagementRepository>;
  /** Read-only handle for `summary`; never starts a writer. */
  readonly openReader?: (path: string) => StatisticsSummaryRepository;
  readonly rotateIdentityKey?: (statisticsDirectory: string) => void;
  readonly compactDatabase?: (path: string) => LlmMetricsCompactionResult;
  readonly labelCandidates?: StatisticsLabelCandidatesSource;
  readonly now?: () => number;
  readonly write?: (message: string) => void;
  /** Warnings; standard error by default. */
  readonly writeError?: (message: string) => void;
  /** Busy-lease backoff test seam. */
  readonly sleep?: (delayMs: number) => Promise<void>;
}

const STATISTICS_COMMAND_SPEC: CommandSpec = {
  name: 'ironcurtain statistics',
  description: 'View and manage locally persisted LLM statistics',
  usage: [
    'ironcurtain statistics summary [--days <n>] [--json]',
    'ironcurtain statistics delete --before <ISO-date-or-epoch-ms>',
    'ironcurtain statistics delete --all',
    'ironcurtain statistics reset',
  ],
  subcommands: [
    { name: 'summary', description: 'Show usage, speed and breakdowns for a recent window' },
    { name: 'delete', description: 'Delete rows before a cutoff, or all rows' },
    { name: 'reset', description: 'Delete all rows, rotate the identity key and compact the database' },
  ],
  options: [
    {
      flag: 'days',
      placeholder: '<n>',
      description: `summary: window in days (1-${MAX_STATISTICS_RANGE_DAYS}, default 30)`,
    },
    { flag: 'json', description: 'summary: print machine-readable JSON' },
    {
      flag: 'before',
      placeholder: '<time>',
      description: 'delete: before epoch-ms, YYYY-MM-DD, or an ISO timestamp with timezone',
    },
    { flag: 'all', description: 'delete: all rows present at command start' },
    { flag: 'help', short: 'h', description: 'Show this help' },
  ],
};

function usage(): string {
  return (
    `${formatHelp(STATISTICS_COMMAND_SPEC)}\n\n` +
    'Deletion is chunked and uses a start-of-command snapshot; newer rows are preserved.\n' +
    '`delete` performs logical SQLite row deletion, not secure erasure of free pages, WAL files, snapshots, or backups,\n' +
    'and keeps the statistics identity key.\n' +
    '`reset` deletes every row, then replaces the identity key (pseudonymized personas, profiles and routes recorded\n' +
    'afterwards cannot be linked to earlier ones), then rebuilds the database file and truncates its WAL.\n' +
    'Running IronCurtain processes switch to the new key within seconds; stop them first for a clean reset.\n'
  );
}

function hasValidCalendarDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.slice(0, 10).split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseCutoff(value: string): number {
  const isEpochMilliseconds = /^\d+$/.test(value);
  const isUnambiguousIso = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
    value,
  );
  let numeric = Number.NaN;
  if (isEpochMilliseconds) numeric = Number(value);
  else if (isUnambiguousIso && hasValidCalendarDate(value)) numeric = Date.parse(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > MAX_DATE_MS) {
    throw new Error(`Invalid statistics cutoff: ${value}`);
  }
  return numeric;
}

function parseDays(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SUMMARY_DAYS;
  const days = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_STATISTICS_RANGE_DAYS) {
    throw new Error(`--days must be a whole number from 1 to ${MAX_STATISTICS_RANGE_DAYS}`);
  }
  return days;
}

async function yieldToWriters(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function sleepFor(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Deletes through one snapshot in bounded passes. Another process holding the
 * maintenance lease (its retention prune, or its own deletion) makes a pass
 * `busy`; the pass is retried with backoff, keeping the snapshot, and the
 * budget starts over after every pass that made progress. A result that is
 * still `busy` when the budget runs out is returned for the caller to fail on.
 */
async function deleteSnapshot(
  repository: StatisticsManagementRepository,
  cutoffMs: number,
  sleep: (delayMs: number) => Promise<void>,
): Promise<{ readonly result: LlmDeleteBeforeResult; readonly deletedCount: number }> {
  let snapshotMaxSequence: number | undefined;
  let deletedCount = 0;
  let busyRetries = 0;
  let latest: LlmDeleteBeforeResult | undefined;
  for (let pass = 0; pass < MAX_DELETE_PASSES; pass++) {
    const options: LlmDeleteBeforeOptions = {
      ...BOUNDED_STATISTICS_DELETE_OPTIONS,
      ...(snapshotMaxSequence === undefined ? {} : { snapshotMaxSequence }),
    };
    latest = await repository.deleteBefore(cutoffMs, options);
    deletedCount += latest.deletedCount;
    snapshotMaxSequence ??= latest.snapshotMaxSequence ?? undefined;
    if (latest.status === 'busy') {
      if (busyRetries >= BUSY_RETRY_DELAYS_MS.length) return { result: latest, deletedCount };
      const delayMs = BUSY_RETRY_DELAYS_MS[busyRetries];
      busyRetries++;
      await sleep(delayMs);
      continue;
    }
    busyRetries = 0;
    if (latest.status === 'complete') return { result: latest, deletedCount };
    await yieldToWriters();
  }
  if (latest === undefined) throw new Error('Statistics deletion did not start');
  return { result: latest, deletedCount };
}

function defaultOpenRepository(path: string): Promise<StatisticsManagementRepository> {
  return SqliteLlmMetricsRepository.open({ databasePath: path });
}

async function runDelete(
  values: { readonly all?: boolean; readonly before?: string },
  dependencies: StatisticsCommandDependencies,
  write: (message: string) => void,
): Promise<void> {
  if (values.all === true && values.before !== undefined) {
    throw new Error('Choose either --before or --all, not both');
  }
  if (values.all !== true && values.before === undefined) {
    throw new Error('statistics delete requires --before <time> or --all');
  }

  const now = dependencies.now ?? Date.now;
  const cutoffMs = values.all === true ? Math.min(MAX_DATE_MS, now() + 1) : parseCutoff(values.before ?? '');
  const databasePath = dependencies.databasePath ?? getLlmStatisticsDatabasePath();
  const databaseExists = dependencies.databaseExists ?? existsSync;
  if (!databaseExists(databasePath)) {
    write('No statistics database exists; nothing was deleted.\n');
    return;
  }

  const writeError = dependencies.writeError ?? ((message: string) => process.stderr.write(message));
  const repository = await (dependencies.openRepository ?? defaultOpenRepository)(databasePath);
  try {
    const deletion = await deleteSnapshot(repository, cutoffMs, dependencies.sleep ?? sleepFor);
    write(`Deleted ${deletion.deletedCount} statistics exchange(s) before ${new Date(cutoffMs).toISOString()}.\n`);
    if (deletion.result.status === 'busy') {
      // A privacy deletion must not report success while rows remain.
      writeError(
        'Another process still holds the statistics maintenance lease; matching rows may remain. Retry later.\n',
      );
      throw new Error('Statistics deletion did not complete: the maintenance lease stayed busy');
    }
    if (deletion.result.status === 'partial') {
      throw new Error('Statistics deletion reached its bounded pass limit before completing');
    }
  } finally {
    await repository.close();
  }
}

/**
 * Full reset, in the order the design requires: rows first, then the key
 * (so no row survives that the old key could relabel), then compaction. Any
 * incomplete step stops the reset before the next one.
 *
 * The deletion cutoff is the latest representable time, not "now": the
 * start-of-command snapshot already preserves rows written during the reset,
 * and a row stamped in the future (a clock that was ahead when it was
 * recorded) is still a row from before the reset. A busy maintenance lease is
 * retried with the same backoff as `delete`; one that stays busy stops the
 * reset before the key is rotated.
 */
async function runReset(dependencies: StatisticsCommandDependencies, write: (message: string) => void): Promise<void> {
  const databasePath = dependencies.databasePath ?? getLlmStatisticsDatabasePath();
  const statisticsDirectory = dependencies.statisticsDirectory ?? dirname(databasePath);
  const databaseExists = dependencies.databaseExists ?? existsSync;
  const hasDatabase = databaseExists(databasePath);

  if (hasDatabase) {
    const repository = await (dependencies.openRepository ?? defaultOpenRepository)(databasePath);
    try {
      const deletion = await deleteSnapshot(repository, MAX_DATE_MS, dependencies.sleep ?? sleepFor);
      if (deletion.result.status !== 'complete') {
        throw new Error(
          `Statistics reset stopped after deleting ${deletion.deletedCount} exchange(s): ` +
            (deletion.result.status === 'busy'
              ? 'another IronCurtain process holds the statistics maintenance lease. '
              : 'deletion reached its bounded pass limit. ') +
            'The identity key was not rotated; run the reset again.',
        );
      }
      write(`Deleted ${deletion.deletedCount} statistics exchange(s).\n`);
    } finally {
      await repository.close();
    }
  } else {
    write('No statistics database exists; no exchanges were deleted.\n');
  }

  if (databaseExists(getLlmStatisticsIdentityKeyPath(statisticsDirectory))) {
    (dependencies.rotateIdentityKey ?? rotateLlmStatisticsIdentityKey)(statisticsDirectory);
    write('Rotated the statistics identity key.\n');
  } else {
    write('No statistics identity key exists; the next statistics writer creates a fresh one.\n');
  }

  if (hasDatabase) {
    const compaction = (dependencies.compactDatabase ?? compactLlmMetricsDatabase)(databasePath);
    write(
      compaction.walTruncated
        ? 'Compacted the statistics database and truncated its write-ahead log.\n'
        : 'Compacted the statistics database; another process still reads it, so its write-ahead log is ' +
            'truncated at that process’s next checkpoint.\n',
    );
  }
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

const OVERALL_MEASURES: readonly LlmStatisticsMeasure[] = [
  'requestCount',
  'errorCount',
  'refusalCount',
  'inputTokens',
  'outputTokens',
  'thinkingTokens',
  'totalTokens',
  'costUsd',
  'effectiveOutputTokensPerSecond',
];
const GROUP_MEASURES: readonly LlmStatisticsMeasure[] = ['requestCount', 'totalTokens', 'costUsd'];

const BREAKDOWNS: readonly {
  readonly key: string;
  readonly title: string;
  readonly groupBy: readonly LlmStatisticsDimension[];
}[] = [
  { key: 'providerModel', title: 'By provider and routed model', groupBy: ['logicalProvider', 'forwardedModel'] },
  { key: 'persona', title: 'By persona', groupBy: ['personaId'] },
  { key: 'agent', title: 'By agent', groupBy: ['agent'] },
  { key: 'providerProfile', title: 'By provider profile', groupBy: ['providerProfile'] },
  { key: 'workflowRun', title: 'By workflow run', groupBy: ['workflowRunId'] },
];

const integerFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const decimalFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const costFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

function tokens(value: number | null): string {
  return value === null ? 'not reported' : value >= 10_000 ? compactFormat.format(value) : integerFormat.format(value);
}

/**
 * A cost sum (gateway-reported, else list-price, per exchange): `unknown`
 * rather than $0.00 when no exchange has a known cost, and a lower bound
 * (`≥ $1.23`) when only some do, because the others' cost is not counted.
 */
function costText(summary: MetricSummary): string {
  if (summary.value === null) return 'unknown';
  const amount = costFormat.format(summary.value);
  return summary.sampleCount < summary.eligibleCount ? `≥ ${amount}` : amount;
}

function find(summaries: readonly MetricSummary[], measure: LlmStatisticsMeasure): MetricSummary | undefined {
  return summaries.find((summary) => summary.measure === measure);
}

function display(value: string): string {
  return toDisplayText(value, { maxLength: LABEL_DISPLAY_LENGTH });
}

function groupLabel(summary: MetricSummary, groupBy: readonly LlmStatisticsDimension[]): string {
  return groupBy
    .map((dimension) => {
      const label = summary.labels?.[dimension];
      if (label !== undefined) return display(label);
      const value = summary.dimensions[dimension] as string | boolean | null | undefined;
      return value === null || value === undefined ? '(none)' : display(String(value));
    })
    .join(' · ');
}

function line(label: string, value: string, note = ''): string {
  return `  ${label.padEnd(18)} ${value.padStart(14)}${note === '' ? '' : `  ${note}`}\n`;
}

function formatOverall(summaries: readonly MetricSummary[]): string {
  let text = '';
  const requests = find(summaries, 'requestCount');
  const exchanges = requests?.value ?? 0;
  text += line('Exchanges', integerFormat.format(exchanges));
  const errors = find(summaries, 'errorCount');
  if (errors?.value !== null && errors?.value !== undefined) {
    const share = exchanges === 0 ? '' : `${decimalFormat.format((errors.value / exchanges) * 100)}%`;
    text += line('Errors', integerFormat.format(errors.value), share);
  }
  const refusals = find(summaries, 'refusalCount');
  if (refusals !== undefined) {
    text += line(
      'API refusals',
      integerFormat.format(refusals.value ?? 0),
      `of ${integerFormat.format(refusals.sampleCount)} exchanges reporting`,
    );
  }
  for (const [measure, label] of [
    ['inputTokens', 'Input tokens'],
    ['outputTokens', 'Output tokens'],
    ['thinkingTokens', 'Thinking tokens'],
    ['totalTokens', 'Total tokens'],
  ] as const) {
    const summary = find(summaries, measure);
    if (summary === undefined) continue;
    const note =
      summary.lowerBoundCount > 0
        ? `lower bound: ${integerFormat.format(summary.lowerBoundCount)} exchange(s) measured only in part`
        : summary.sampleCount < summary.eligibleCount
          ? `${integerFormat.format(summary.sampleCount)} of ${integerFormat.format(summary.eligibleCount)} exchanges report it`
          : '';
    text += line(label, tokens(summary.value), note);
  }
  const cost = find(summaries, 'costUsd');
  if (cost !== undefined) {
    text += line(
      'Cost',
      costText(cost),
      `${integerFormat.format(cost.sampleCount)} of ${integerFormat.format(cost.eligibleCount)} exchanges priced ` +
        '(gateway-reported or list price)',
    );
  }
  const speed = find(summaries, 'effectiveOutputTokensPerSecond');
  if (speed !== undefined) {
    text += line(
      'Effective speed',
      speed.median === null ? 'not measured' : `${decimalFormat.format(speed.median)} tok/s`,
      speed.median === null || speed.lowerQuartile === null || speed.upperQuartile === null
        ? ''
        : `median; middle 50% ${decimalFormat.format(speed.lowerQuartile)}-${decimalFormat.format(
            speed.upperQuartile,
          )}, ${integerFormat.format(speed.sampleCount)} exchanges`,
    );
  }
  return text;
}

function formatBreakdown(summaries: readonly MetricSummary[], groupBy: readonly LlmStatisticsDimension[]): string {
  const rows = new Map<string, MetricSummary[]>();
  for (const summary of summaries) {
    const key = JSON.stringify(groupBy.map((dimension) => summary.dimensions[dimension] ?? null));
    const row = rows.get(key) ?? [];
    row.push(summary);
    rows.set(key, row);
  }
  if (rows.size === 0) return '  (no exchanges)\n';
  let text = '';
  for (const row of rows.values()) {
    const anchor = row[0] as MetricSummary | undefined;
    if (anchor === undefined) continue;
    const requests = find(row, 'requestCount')?.value ?? 0;
    const total = find(row, 'totalTokens')?.value ?? null;
    const cost = find(row, 'costUsd');
    text +=
      `  ${groupLabel(anchor, groupBy).padEnd(44)} ${integerFormat.format(requests).padStart(9)} exchanges` +
      `  ${tokens(total).padStart(12)} tokens${cost === undefined || cost.value === null ? '' : `  ${costText(cost)}`}\n`;
  }
  return text;
}

async function runSummary(
  values: { readonly days?: string; readonly json?: boolean },
  dependencies: StatisticsCommandDependencies,
  write: (message: string) => void,
): Promise<void> {
  const days = parseDays(values.days);
  const databasePath = dependencies.databasePath ?? getLlmStatisticsDatabasePath();
  const statisticsDirectory = dependencies.statisticsDirectory ?? dirname(databasePath);
  const databaseExists = dependencies.databaseExists ?? existsSync;
  if (!databaseExists(databasePath)) {
    write('No statistics database exists yet.\n');
    return;
  }
  const now = (dependencies.now ?? Date.now)();
  const range = { fromMs: Math.max(0, now - days * DAY_MS), toMs: now };
  const protector = loadStatisticsLabelProtector(statisticsDirectory);
  const repository = (dependencies.openReader ?? ((path) => openSqliteLlmMetricsReader({ databasePath: path })))(
    databasePath,
  );
  try {
    const service = new LlmStatisticsQueryService(repository, {
      labels:
        protector === undefined ? undefined : createStatisticsLabelResolver(protector, dependencies.labelCandidates),
    });
    const overall = await service.summarize({ ...range, measures: OVERALL_MEASURES });
    const breakdowns: Record<string, readonly MetricSummary[]> = {};
    for (const breakdown of BREAKDOWNS) {
      breakdowns[breakdown.key] = await service.summarize({
        ...range,
        measures: GROUP_MEASURES,
        groupBy: breakdown.groupBy,
        topGroups: SUMMARY_TOP_GROUPS,
      });
    }
    if (values.json === true) {
      write(`${toTerminalSafeJsonText(JSON.stringify({ ...range, days, overall, breakdowns }, null, 2))}\n`);
      return;
    }
    let text =
      `LLM statistics, last ${days} day(s): ${new Date(range.fromMs).toISOString()} to ` +
      `${new Date(range.toMs).toISOString()}\n` +
      'Observed proxy traffic, not provider billing.\n\n';
    text += formatOverall(overall);
    for (const breakdown of BREAKDOWNS) {
      text += `\n${breakdown.title} (top ${SUMMARY_TOP_GROUPS} by exchanges)\n`;
      text += formatBreakdown(breakdowns[breakdown.key] ?? [], breakdown.groupBy);
    }
    write(text);
  } catch (error) {
    if (isStatisticsLimitError(error)) {
      throw new Error(`${error.message}. Try a smaller --days value.`, { cause: error });
    }
    throw error;
  } finally {
    await repository.close();
  }
}

/** Local, explicit management surface. It is never called by normal startup. */
export async function runStatisticsCommand(
  args: readonly string[],
  dependencies: StatisticsCommandDependencies = {},
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      all: { type: 'boolean' },
      before: { type: 'string' },
      days: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });
  const write = dependencies.write ?? ((message: string) => process.stdout.write(message));
  if (values.help) {
    write(usage());
    return;
  }
  const [subcommand, ...extra] = positionals;
  if (extra.length > 0) throw new Error(usage().trimEnd());
  const deleteOnly = values.all !== undefined || values.before !== undefined;
  const summaryOnly = values.days !== undefined || values.json !== undefined;
  switch (subcommand) {
    case 'summary':
      if (deleteOnly) throw new Error('--before and --all apply only to statistics delete');
      return runSummary(values, dependencies, write);
    case 'delete':
      if (summaryOnly) throw new Error('--days and --json apply only to statistics summary');
      return runDelete(values, dependencies, write);
    case 'reset':
      if (deleteOnly || summaryOnly) throw new Error('statistics reset takes no options');
      return runReset(dependencies, write);
    default:
      throw new Error(usage().trimEnd());
  }
}

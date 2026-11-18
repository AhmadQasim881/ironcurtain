/**
 * Text for a prune report: the `ironcurtain prune` listing, and the one-line
 * summary the daemon logs after an automatic prune.
 *
 * Every id, path and reason goes through `toDisplayText` before it reaches a
 * terminal or a log line: directory names and recorded workspace paths are
 * data, not text this module trusts.
 */

import type { ResolvedRetentionConfig } from '../config/user-config.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { formatBytes } from './disk-usage.js';
import { PRUNE_CATEGORIES, type PruneCategory, type PruneItem, type PruneReport } from './prune.js';

/** Items listed per category; the rest are counted. */
const MAX_LISTED_ITEMS = 20;

const CATEGORY_NAMES: Record<PruneCategory, { readonly title: string; readonly unit: string; readonly units: string }> =
  {
    sessions: { title: 'Sessions', unit: 'session', units: 'sessions' },
    workflowRuns: { title: 'Workflow runs', unit: 'workflow run', units: 'workflow runs' },
    jobRuns: { title: 'Job run records', unit: 'run record', units: 'run records' },
    dependencyCaches: { title: 'Dependency caches', unit: 'dependency cache', units: 'dependency caches' },
  };

function plural(count: number, unit: string, units: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? unit : units}`;
}

/** How many things an item stands for: its record count, else one. */
function itemCount(item: PruneItem): number {
  return item.count ?? 1;
}

function days(value: number | null): string {
  return value === null ? 'no limit' : `${value} day${value === 1 ? '' : 's'}`;
}

/** The limit a category is pruned by, for its heading. */
function limitDescription(category: PruneCategory, retention: ResolvedRetentionConfig): string {
  switch (category) {
    case 'sessions':
    case 'workflowRuns': {
      const limits = retention[category];
      const age = limits.maxAgeDays === null ? 'no age limit' : `inactive for more than ${days(limits.maxAgeDays)}`;
      return limits.maxBytes === null ? age : `${age}; size limit ${formatBytes(limits.maxBytes)}`;
    }
    case 'jobRuns':
      return retention.jobRuns.maxRecords === null
        ? 'no limit'
        : `the newest ${retention.jobRuns.maxRecords.toLocaleString('en-US')} per job are kept`;
    case 'dependencyCaches':
      return retention.dependencyCaches.maxUnusedDays === null
        ? 'no limit'
        : `unused for more than ${days(retention.dependencyCaches.maxUnusedDays)}`;
  }
}

function itemLine(item: PruneItem): string {
  const what =
    item.category === 'jobRuns'
      ? `${toDisplayText(item.id)}: ${plural(itemCount(item), 'record', 'records')}, ${toDisplayText(item.reason)}`
      : `${toDisplayText(item.id)}: ${toDisplayText(item.reason)}`;
  return `    ${what} (${formatBytes(item.bytes)})`;
}

/** The `ironcurtain prune` listing, one line per element. */
export function formatPruneReport(report: PruneReport, retention: ResolvedRetentionConfig): string[] {
  const lines: string[] = [];
  const verb = report.dryRun ? 'Would remove' : 'Removed';
  if (report.dryRun) lines.push('Dry run: nothing is removed.', '');

  for (const category of PRUNE_CATEGORIES) {
    const names = CATEGORY_NAMES[category];
    const removed = report.removed.filter((item) => item.category === category);
    const kept = report.kept.filter((item) => item.category === category);
    const failed = report.failed.filter((failure) => failure.item.category === category);
    lines.push(`${names.title} (${limitDescription(category, retention)})`);
    if (removed.length === 0 && kept.length === 0 && failed.length === 0) {
      lines.push('  Nothing to remove.');
      continue;
    }
    if (removed.length > 0) {
      const count = removed.reduce((sum, item) => sum + itemCount(item), 0);
      const bytes = removed.reduce((sum, item) => sum + item.bytes, 0);
      lines.push(`  ${verb} ${plural(count, names.unit, names.units)} (${formatBytes(bytes)}):`);
      for (const item of removed.slice(0, MAX_LISTED_ITEMS)) lines.push(itemLine(item));
      if (removed.length > MAX_LISTED_ITEMS) lines.push(`    ... and ${removed.length - MAX_LISTED_ITEMS} more`);
    }
    if (kept.length > 0) {
      lines.push(`  Kept ${kept.length} past the limit:`);
      for (const item of kept.slice(0, MAX_LISTED_ITEMS)) {
        lines.push(`    ${toDisplayText(item.id)}: ${toDisplayText(item.reason)}`);
      }
      if (kept.length > MAX_LISTED_ITEMS) lines.push(`    ... and ${kept.length - MAX_LISTED_ITEMS} more`);
    }
    if (failed.length > 0) {
      lines.push(`  Could not remove ${failed.length}:`);
      for (const failure of failed.slice(0, MAX_LISTED_ITEMS)) {
        lines.push(`    ${toDisplayText(failure.item.id)}: ${toDisplayText(failure.error)}`);
      }
      if (failed.length > MAX_LISTED_ITEMS) lines.push(`    ... and ${failed.length - MAX_LISTED_ITEMS} more`);
    }
  }

  if (report.notes.length > 0) {
    lines.push('', 'Notes:');
    for (const note of report.notes) lines.push(`  ${toDisplayText(note)}`);
  }

  const freed = report.removed.reduce((sum, item) => sum + item.bytes, 0);
  lines.push('');
  if (report.aborted) lines.push('The prune was stopped before it finished.');
  if (report.dryRun) {
    lines.push(
      report.removed.length === 0
        ? 'Nothing would be removed.'
        : `Would free ${formatBytes(freed)}. Run \`ironcurtain prune\` without --dry-run to remove it.`,
    );
  } else {
    lines.push(report.removed.length === 0 ? 'Nothing was removed.' : `Freed ${formatBytes(freed)}.`);
  }
  return lines;
}

/** One line for the daemon log: what an automatic prune removed. */
export function summarizePruneReport(report: PruneReport): string {
  const parts: string[] = [];
  for (const category of PRUNE_CATEGORIES) {
    const count = report.removed
      .filter((item) => item.category === category)
      .reduce((sum, item) => sum + itemCount(item), 0);
    if (count > 0) parts.push(plural(count, CATEGORY_NAMES[category].unit, CATEGORY_NAMES[category].units));
  }
  const freed = report.removed.reduce((sum, item) => sum + item.bytes, 0);
  const removed = parts.length === 0 ? 'nothing' : `${parts.join(', ')} (${formatBytes(freed)})`;
  const extras: string[] = [];
  if (report.kept.length > 0) extras.push(`kept ${report.kept.length} past their limit`);
  if (report.failed.length > 0) extras.push(`${report.failed.length} could not be removed`);
  if (report.aborted) extras.push('stopped early');
  const notes = report.notes.length > 0 ? ` Notes: ${report.notes.join(' ')}` : '';
  return toDisplayText(`Prune removed ${removed}${extras.length > 0 ? `; ${extras.join(', ')}` : ''}.${notes}`);
}

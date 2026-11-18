/**
 * `ironcurtain doctor` disk usage: what the IronCurtain home holds per
 * category (sessions, workflow runs, dependency caches, logs, job run
 * records), what `ironcurtain prune` would free under the configured
 * `retention`, and whether the filesystem of the home is running out of space.
 *
 * Read-only: trees are walked with lstat, and the prune is a dry run, which
 * takes no lock and changes nothing.
 */

import { readdirSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import {
  getIronCurtainHome,
  getJobRunsDir,
  getJobsDir,
  getLogsDir,
  getSessionsDir,
  getWorkflowRunsDir,
} from '../config/paths.js';
import type { IronCurtainConfig } from '../config/types.js';
import { RETENTION_CONFIG_DEFAULTS } from '../config/user-config.js';
import { LATEST_RUN_POINTER_FILE } from '../cron/job-store.js';
import { legacyWorkflowDepsRoot, workflowDependencyBasesRoot } from '../docker/workflow-dependency-cache.js';
import { formatBytes, measureTree, type TreeUsage } from '../maintenance/disk-usage.js';
import { runPrune, type PruneReport } from '../maintenance/prune.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { JOB_ID_PATTERN } from '../types/slug.js';
import { errorMessage } from '../utils/error-message.js';
import type { CheckResult } from './checks.js';

/** Below this much free space on the home's filesystem the check warns. */
const LOW_FREE_BYTES = 2 * 1024 * 1024 * 1024;
/** ... or below this share of the filesystem. */
const LOW_FREE_RATIO = 0.05;
/** Entries walked per category at most, so doctor stays quick on a very large home. */
const DOCTOR_WALK_BUDGET = 500_000;

/** Test seams. */
export interface DiskUsageCheckDeps {
  /** Free and total bytes of the filesystem holding `path`. */
  readonly freeSpace?: (path: string) => Promise<{ readonly free: number; readonly total: number } | undefined>;
  /** The dry-run prune (defaults to {@link runPrune} with `dryRun: true`). */
  readonly dryRunPrune?: () => Promise<PruneReport>;
}

async function defaultFreeSpace(path: string): Promise<{ free: number; total: number } | undefined> {
  try {
    const stats = await statfs(path);
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
  } catch {
    return undefined;
  }
}

/** Run record files of every job (`jobs/<id>/runs/*.json`, the pointer left out). */
function countRunRecords(): number {
  let count = 0;
  let jobs: string[];
  try {
    jobs = readdirSync(getJobsDir());
  } catch {
    return 0;
  }
  for (const job of jobs) {
    if (!JOB_ID_PATTERN.test(job)) continue;
    try {
      count += readdirSync(getJobRunsDir(job)).filter(
        (name) => name.endsWith('.json') && name !== LATEST_RUN_POINTER_FILE,
      ).length;
    } catch {
      // No runs yet.
    }
  }
  return count;
}

function entriesOf(path: string): number {
  try {
    return readdirSync(path).filter((name) => !name.startsWith('.')).length;
  } catch {
    return 0;
  }
}

function sizeText(usage: TreeUsage): string {
  return `${usage.partial ? 'at least ' : ''}${formatBytes(usage.bytes)}`;
}

/** Disk usage of the IronCurtain home and what retention would free. */
export async function checkDiskUsage(config: IronCurtainConfig, deps: DiskUsageCheckDeps = {}): Promise<CheckResult> {
  const name = 'Disk usage';
  const home = getIronCurtainHome();
  const retention = config.userConfig.retention ?? RETENTION_CONFIG_DEFAULTS;
  const categories: { readonly label: string; readonly path: string; readonly counted: boolean }[] = [
    { label: 'sessions', path: getSessionsDir(), counted: true },
    { label: 'workflow runs', path: getWorkflowRunsDir(), counted: true },
    { label: 'dependency caches', path: workflowDependencyBasesRoot(home), counted: true },
    { label: 'legacy dependency caches', path: legacyWorkflowDepsRoot(home), counted: false },
    { label: 'logs', path: getLogsDir(), counted: false },
  ];

  const parts: string[] = [];
  let total = 0;
  for (const category of categories) {
    const usage = await measureTree(category.path, { entryBudget: DOCTOR_WALK_BUDGET });
    if (usage.entries === 0) continue;
    total += usage.bytes;
    const count = category.counted ? ` (${entriesOf(category.path)})` : '';
    parts.push(`${category.label} ${sizeText(usage)}${count}`);
  }
  const records = countRunRecords();
  if (records > 0) parts.push(`${records.toLocaleString('en-US')} job run records`);
  const usageText = parts.length === 0 ? 'nothing stored yet' : parts.join(', ');

  let reclaimable = 0;
  let pruneProblem: string | undefined;
  try {
    const report = await (deps.dryRunPrune ?? (() => runPrune({ retention, dryRun: true })))();
    reclaimable = report.removed.reduce((sum, item) => sum + item.bytes, 0);
  } catch (error) {
    pruneProblem = `the retention dry run failed: ${toDisplayText(errorMessage(error))}`;
  }

  const space = await (deps.freeSpace ?? defaultFreeSpace)(home);
  const low =
    space !== undefined &&
    (space.free < LOW_FREE_BYTES || (space.total > 0 && space.free / space.total < LOW_FREE_RATIO));
  const freeText = space === undefined ? '' : `; ${formatBytes(space.free)} free on its filesystem`;

  const hints: string[] = [];
  if (reclaimable > 0) {
    hints.push(
      `\`ironcurtain prune\` would free ${formatBytes(reclaimable)} under the retention settings ` +
        '(`ironcurtain prune --dry-run` lists it)',
    );
    if (!retention.autoPrune) hints.push('set retention.autoPrune in config.json to have the daemon prune daily');
  }
  if (pruneProblem !== undefined) hints.push(pruneProblem);

  return {
    name,
    status: low ? 'warn' : 'ok',
    message: `${formatBytes(total)} in ${toDisplayText(home)}: ${usageText}${freeText}`,
    ...(hints.length > 0 ? { hint: hints.join('; ') } : {}),
  };
}

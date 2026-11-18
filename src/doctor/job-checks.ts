/**
 * `ironcurtain doctor` check of the cron job definitions on disk.
 *
 * A job whose job.json is invalid (torn by a crash, hand-edited, an `id`
 * that does not name its directory) is not scheduled by the daemon. This
 * check names each one with its reason, so a job that silently stopped
 * running is found here too, not only in `daemon list-jobs`.
 */

import { scanJobs, type JobScan } from '../cron/job-store.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import type { CheckResult } from './checks.js';

const CHECK_NAME = 'Cron jobs';

/** Longest reason shown per invalid job (the store already bounds it). */
const MAX_REASON_DISPLAY_LENGTH = 160;

/**
 * Warns about every job directory whose job.json is invalid; ok otherwise.
 * `scan` is a test seam.
 */
export function checkJobDefinitions(scan: () => JobScan = scanJobs): CheckResult {
  let result: JobScan;
  try {
    result = scan();
  } catch (err) {
    return {
      name: CHECK_NAME,
      status: 'warn',
      message: `could not read the jobs directory: ${toDisplayText(err instanceof Error ? err.message : String(err))}`,
    };
  }

  const { jobs, invalid } = result;
  if (invalid.length === 0) {
    return {
      name: CHECK_NAME,
      status: 'ok',
      message: jobs.length === 0 ? 'no jobs configured' : `${jobs.length} job definition(s) valid`,
    };
  }

  // Job ids are validated directory names; reasons can quote the file.
  const listed = invalid
    .map((entry) => `${entry.jobId}: INVALID: ${toDisplayText(entry.reason, { maxLength: MAX_REASON_DISPLAY_LENGTH })}`)
    .join('; ');
  return {
    name: CHECK_NAME,
    status: 'warn',
    message: `${invalid.length} job.json file(s) invalid, so those jobs are not scheduled: ${listed}`,
    hint: 'Fix the file, or remove the job: ironcurtain daemon remove-job <id>',
  };
}

/**
 * `ironcurtain prune [--dry-run] [--json]`: applies the `retention` policy of
 * config.json to the IronCurtain home (see `src/maintenance/prune.ts`).
 *
 * The config is read without being created or backfilled. Output goes to
 * stdout through process.stdout.write (the logger may hijack console.*).
 * Exit status: 0 when everything due went, 1 when something could not be
 * removed or another prune is running, 2 for a usage error.
 */

import { parseArgs } from 'node:util';
import { checkHelp, type CommandSpec } from '../cli-help.js';
import { loadUserConfig, RETENTION_CONFIG_DEFAULTS, type ResolvedRetentionConfig } from '../config/user-config.js';
import { toDisplayText, toTerminalSafeJsonText } from '../terminal/display-sanitize.js';
import { errorMessage } from '../utils/error-message.js';
import { PRUNE_BUSY, runPrune, type PruneOptions, type PruneReport } from './prune.js';
import { formatPruneReport } from './prune-format.js';

export const PRUNE_HELP: CommandSpec = {
  name: 'ironcurtain prune',
  description:
    'Remove old sessions, workflow runs, job run records and unused dependency caches, as `retention` in ' +
    'config.json says (sessions and runs inactive for 30 days, the newest 200 records per job, caches unused ' +
    'for 14 days by default). Live sessions and runs, and workspaces still in use, are never removed. ' +
    'Set retention.autoPrune to have the daemon prune daily.',
  usage: ['ironcurtain prune [--dry-run] [--json]'],
  options: [
    { flag: 'dry-run', description: 'List what would be removed and why, without removing anything' },
    { flag: 'json', description: 'Print the report as JSON' },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: ['ironcurtain prune --dry-run   # See what retention would remove', 'ironcurtain prune'],
};

export interface PruneCommandDeps {
  /** Writes report text (default: stdout). */
  readonly write?: (text: string) => void;
  /** Writes errors (default: stderr). */
  readonly writeError?: (text: string) => void;
  /** Retention to apply (default: the config's). */
  readonly retention?: ResolvedRetentionConfig;
  /** Overrides for the prune itself (tests). */
  readonly pruneOptions?: Partial<PruneOptions>;
}

/** Runs the command; resolves with the exit status. */
export async function runPruneCommand(argv: readonly string[], deps: PruneCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const writeError = deps.writeError ?? ((text: string) => process.stderr.write(text));

  let values: { 'dry-run'?: boolean; json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    writeError(`${toDisplayText(errorMessage(error))}\nRun \`ironcurtain prune --help\` for usage.\n`);
    return 2;
  }
  if (checkHelp({ help: values.help === true }, PRUNE_HELP)) return 0;

  let retention: ResolvedRetentionConfig;
  try {
    retention = deps.retention ?? loadUserConfig({ readOnly: true }).retention ?? RETENTION_CONFIG_DEFAULTS;
  } catch (error) {
    writeError(`Cannot read the configuration: ${toDisplayText(errorMessage(error))}\n`);
    return 1;
  }

  let report: PruneReport;
  try {
    report = await runPrune({ ...deps.pruneOptions, retention, dryRun: values['dry-run'] === true });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === PRUNE_BUSY) {
      writeError(`${toDisplayText(errorMessage(error))}; try again once it has finished.\n`);
    } else {
      writeError(`Prune failed: ${toDisplayText(errorMessage(error))}\n`);
    }
    return 1;
  }

  if (values.json === true) {
    write(`${toTerminalSafeJsonText(JSON.stringify(report, null, 2))}\n`);
  } else {
    write(`${formatPruneReport(report, retention).join('\n')}\n`);
  }
  return report.failed.length > 0 ? 1 : 0;
}

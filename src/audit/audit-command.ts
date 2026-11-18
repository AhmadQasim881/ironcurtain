/**
 * `ironcurtain audit` — read-only analysis of what IronCurtain recorded.
 *
 *   audit report     summarize tool-call audit logs (`audit-report.ts`)
 *   audit verify     check the persona policy-mutation hash chain
 *   audit proposals  list constitution amendments proposed from repeated
 *                    human approvals (`amendment-proposals.ts`)
 *
 * Nothing here changes policy or logs. Proposals are applied only through the
 * customize-policy flows, which show each one as a diff and need an explicit
 * accept.
 */

import { readdirSync, statSync, type Dirent } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatHelp, type CommandSpec } from '../cli-help.js';
import {
  getIronCurtainHome,
  getSessionAuditLogPath,
  getSessionsDir,
  getWorkflowContainersDir,
  getWorkflowRunsDir,
} from '../config/paths.js';
import { loadSessionMetadata } from '../session/session-metadata.js';
import { toDisplayText, toTerminalSafeJsonText } from '../terminal/display-sanitize.js';
import { verifyPolicyMutationLog, type PolicyMutationVerifyResult } from '../persona/policy-mutation-audit.js';
import {
  GLOBAL_APPROVAL_SCOPE,
  describeApprovalScope,
  jobApprovalScope,
  personaApprovalScope,
  type ApprovalScope,
} from './approval-history.js';
import { DEFAULT_PROPOSAL_THRESHOLD, loadAmendmentProposals, type DerivedProposals } from './amendment-proposals.js';
import { buildAuditReport, formatAuditReport, type AuditLogSource } from './audit-report.js';

/** Exit status for a usage error (bad flags), as other subcommands use. */
const EXIT_USAGE = 2;

export const auditCommandSpec: CommandSpec = {
  name: 'ironcurtain audit',
  description: 'Analyze audit logs, verify the policy-mutation log, review learned amendments',
  usage: [
    'ironcurtain audit report [--session <id> | --workflow <id> | --file <path>] [--since <time>] [--json]',
    'ironcurtain audit verify [--json]',
    'ironcurtain audit proposals [--global | --persona <name> | --job <id>] [--threshold <n>] [--json]',
  ],
  subcommands: [
    { name: 'report', description: 'Summarize tool-call audit logs (all sessions and workflow runs by default)' },
    { name: 'verify', description: 'Check the policy-mutation log hash chain for edits, removals and truncation' },
    { name: 'proposals', description: 'List constitution amendments proposed from repeated human approvals' },
  ],
  options: [
    { flag: 'session', placeholder: '<id>', description: 'report: only this session' },
    { flag: 'workflow', placeholder: '<id>', description: 'report: only this workflow run' },
    { flag: 'file', placeholder: '<path>', description: 'report: only this audit.jsonl file' },
    {
      flag: 'since',
      placeholder: '<time>',
      description: 'report: only records since an ISO date/time, epoch ms, or a duration like 24h or 7d',
    },
    { flag: 'top', placeholder: '<n>', description: 'report: rows per table (default 15)' },
    { flag: 'global', description: 'proposals: only the global policy' },
    { flag: 'persona', placeholder: '<name>', description: 'proposals: only this persona' },
    { flag: 'job', placeholder: '<id>', description: 'proposals: only this cron job' },
    {
      flag: 'threshold',
      placeholder: '<n>',
      description: `proposals: human approvals needed (default ${DEFAULT_PROPOSAL_THRESHOLD})`,
    },
    { flag: 'json', description: 'Print machine-readable JSON' },
    { flag: 'help', short: 'h', description: 'Show this help' },
  ],
  examples: [
    'ironcurtain audit report --since 7d',
    'ironcurtain audit report --workflow <id> --json',
    'ironcurtain audit verify',
    'ironcurtain audit proposals',
  ],
};

/** Raised for bad flags; the command prints it with the usage and exits 2. */
class AuditUsageError extends Error {
  readonly code = 'AUDIT_USAGE';
}

export interface AuditCommandDependencies {
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
  readonly now?: () => number;
}

const DURATION = /^(\d{1,6})([mhd])$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** Parses `--since`: an ISO date or timestamp, epoch milliseconds, or `<n>m|h|d` ago. */
export function parseSince(value: string, now: number): number {
  const duration = DURATION.exec(value);
  if (duration) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2] as 'm' | 'h' | 'd'];
    return now - Number(duration[1]) * unit;
  }
  if (/^\d{1,16}$/.test(value)) return Number(value);
  if (ISO_DATE.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new AuditUsageError(`Invalid --since value: ${toDisplayText(value, { maxLength: 80 })}`);
}

function parsePositiveInt(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,6}$/.test(value) || Number(value) < 1) {
    throw new AuditUsageError(`--${flag} must be a positive integer`);
  }
  return Number(value);
}

function listDirectories(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  // Dirent types come from the directory itself: a symlinked entry is not a directory here.
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** True when the file was modified at or after `since` (or `since` is unset). */
function touchedSince(path: string, since: number | undefined): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && (since === undefined || stats.mtimeMs >= since);
  } catch {
    return false;
  }
}

function sessionSource(sessionId: string, label = `session ${sessionId}`): AuditLogSource {
  const persona = loadSessionMetadata(sessionId)?.persona;
  return {
    path: getSessionAuditLogPath(sessionId),
    label,
    ...(typeof persona === 'string' ? { defaultPersona: persona } : {}),
  };
}

/** The audit logs of a workflow run's shared-container bundles (one per bundle). */
function workflowBundleSources(workflowId: string, since: number | undefined): AuditLogSource[] {
  const containersDir = getWorkflowContainersDir(workflowId);
  return listDirectories(containersDir)
    .map((bundle) => ({
      path: resolve(containersDir, bundle, 'audit.jsonl'),
      label: `workflow ${workflowId} bundle ${bundle}`,
    }))
    .filter((source) => touchedSince(source.path, since));
}

/**
 * Every audit log of one workflow run: its bundles' logs, plus the logs of the
 * states that ran as sessions of their own (builtin workflows, Docker
 * workflows without `sharedContainer`), which live under `sessions/` and name
 * the run in their metadata.
 */
function workflowSources(workflowId: string, since: number | undefined): AuditLogSource[] {
  const sources = workflowBundleSources(workflowId, since);
  for (const sessionId of listDirectories(getSessionsDir())) {
    try {
      if (loadSessionMetadata(sessionId)?.workflowRunId !== workflowId) continue;
      const source = sessionSource(sessionId, `workflow ${workflowId} session ${sessionId}`);
      if (touchedSince(source.path, since)) sources.push(source);
    } catch {
      // not a session directory name
    }
  }
  return sources;
}

/** Every session and workflow-bundle audit log under the IronCurtain home. */
function discoverSources(since: number | undefined): AuditLogSource[] {
  const sources: AuditLogSource[] = [];
  for (const sessionId of listDirectories(getSessionsDir())) {
    let source: AuditLogSource;
    try {
      source = sessionSource(sessionId);
    } catch {
      continue; // not a session directory name
    }
    if (touchedSince(source.path, since)) sources.push(source);
  }
  // A workflow state that ran as its own session was found above.
  for (const workflowId of listDirectories(getWorkflowRunsDir())) {
    try {
      sources.push(...workflowBundleSources(workflowId, since));
    } catch {
      // not a workflow run directory name
    }
  }
  return sources;
}

type ReportValues = {
  session?: string;
  workflow?: string;
  file?: string;
  since?: string;
  top?: string;
  json?: boolean;
};

async function runReport(values: ReportValues, deps: Required<AuditCommandDependencies>): Promise<number> {
  const scopes = [values.session, values.workflow, values.file].filter((v) => v !== undefined);
  if (scopes.length > 1) throw new AuditUsageError('Choose at most one of --session, --workflow and --file');
  const since = values.since !== undefined ? parseSince(values.since, deps.now()) : undefined;
  const top = parsePositiveInt('top', values.top, 15);

  let sources: AuditLogSource[];
  let explicit = true;
  try {
    if (values.session !== undefined) sources = [sessionSource(values.session)];
    else if (values.workflow !== undefined) sources = workflowSources(values.workflow, undefined);
    else if (values.file !== undefined) sources = [{ path: resolve(values.file), label: `file ${values.file}` }];
    else {
      sources = discoverSources(since);
      explicit = false;
    }
  } catch (err) {
    throw new AuditUsageError(err instanceof Error ? err.message : String(err));
  }

  if (sources.length === 0) {
    if (explicit) {
      deps.writeError(`No audit logs found for workflow ${toDisplayText(values.workflow ?? '')}.\n`);
      return 1;
    }
    deps.write(
      values.json === true
        ? `${toTerminalSafeJsonText(JSON.stringify({ sources: [] }, null, 2))}\n`
        : `No audit logs found under ${toDisplayText(getIronCurtainHome())}.\n`,
    );
    return 0;
  }

  const report = await buildAuditReport(sources, since !== undefined ? { since } : {});
  deps.write(
    values.json === true
      ? `${toTerminalSafeJsonText(JSON.stringify(report, null, 2))}\n`
      : formatAuditReport(report, { top }),
  );
  // A log the user named that could not be read is an error; one found while
  // scanning (a session still being created, say) is only listed.
  return explicit && report.sources.some((source) => source.error !== undefined) ? 1 : 0;
}

function formatVerify(result: PolicyMutationVerifyResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(
      result.records === 0
        ? 'Policy-mutation log: no chain records yet.'
        : `Policy-mutation log OK: ${result.records} record(s), seq ${result.firstSeq} to ${result.lastSeq}, ` +
            'every record hashes and links correctly and the chain head matches.',
    );
  } else if (result.problem !== undefined) {
    const where =
      result.problem.file +
      (result.problem.line !== undefined ? ` line ${result.problem.line}` : '') +
      (result.problem.seq !== undefined ? ` (seq ${result.problem.seq})` : '');
    lines.push(`Policy-mutation log FAILED verification at ${where}: ${result.problem.reason}.`);
    lines.push(`${result.records} record(s) before it verified.`);
  }
  for (const note of result.notes) lines.push(`Note: ${note}`);
  lines.push(
    'The chain is keyless: it reveals edits, removals and truncation, but a local user who can write ' +
      '~/.ironcurtain can rebuild a consistent chain.',
  );
  return lines.join('\n') + '\n';
}

function runVerify(values: { json?: boolean }, deps: Required<AuditCommandDependencies>): number {
  const result = verifyPolicyMutationLog();
  deps.write(
    values.json === true ? `${toTerminalSafeJsonText(JSON.stringify(result, null, 2))}\n` : formatVerify(result),
  );
  return result.ok ? 0 : 1;
}

function reviewHint(scope: ApprovalScope): string {
  if (scope === GLOBAL_APPROVAL_SCOPE) return 'ironcurtain customize-policy';
  const [kind, name] = scope.split(':');
  return kind === 'persona'
    ? `ironcurtain persona edit ${name}  (choose "Customize constitution interactively")`
    : `ironcurtain daemon edit-job ${name}  (choose "Customize constitution interactively")`;
}

function formatProposals(derived: DerivedProposals, threshold: number): string {
  const lines: string[] = [];
  if (derived.proposals.length === 0) {
    lines.push(`No pending amendments (a pattern needs ${threshold} human approvals).`);
  }
  for (const [index, p] of derived.proposals.entries()) {
    lines.push(
      `${index + 1}. ${describeApprovalScope(p.scope)}: approved ${p.approvals} times, last on ${p.lastSeen.slice(0, 10)}`,
    );
    lines.push(`   Pattern:  ${toDisplayText(p.description, { maxLength: 200 })}`);
    lines.push(`   Proposed: ${toDisplayText(p.amendment, { maxLength: 400 })}`);
    lines.push(`   Review:   ${reviewHint(p.scope)}`);
  }
  if (derived.withheld.length > 0) {
    lines.push('', 'Approved often, but not proposed:');
    for (const w of derived.withheld) {
      const why =
        w.reason === 'too-broad'
          ? 'its directory is the filesystem root or contains your home directory'
          : 'a value cannot be quoted safely in a policy statement';
      lines.push(
        `- ${describeApprovalScope(w.scope)}: ${toDisplayText(w.description, { maxLength: 200 })} (${w.approvals} times; ${why})`,
      );
    }
  }
  lines.push('', 'Accepting a proposal adds it to the constitution; recompile the policy for it to take effect.');
  return lines.join('\n') + '\n';
}

type ProposalValues = { global?: boolean; persona?: string; job?: string; threshold?: string; json?: boolean };

function runProposals(values: ProposalValues, deps: Required<AuditCommandDependencies>): number {
  const chosen = [values.global === true, values.persona !== undefined, values.job !== undefined].filter(Boolean);
  if (chosen.length > 1) throw new AuditUsageError('Choose at most one of --global, --persona and --job');
  let scope: ApprovalScope | undefined;
  if (values.global === true) scope = GLOBAL_APPROVAL_SCOPE;
  if (values.persona !== undefined) {
    scope = personaApprovalScope(values.persona);
    if (scope === undefined) throw new AuditUsageError('Invalid persona name');
  }
  if (values.job !== undefined) {
    scope = jobApprovalScope(values.job);
    if (scope === undefined) throw new AuditUsageError('Invalid job id');
  }
  const threshold = parsePositiveInt('threshold', values.threshold, DEFAULT_PROPOSAL_THRESHOLD);
  const derived = loadAmendmentProposals({ threshold, ...(scope !== undefined ? { scope } : {}) });
  deps.write(
    values.json === true
      ? `${toTerminalSafeJsonText(JSON.stringify(derived, null, 2))}\n`
      : formatProposals(derived, threshold),
  );
  return 0;
}

/**
 * Runs `ironcurtain audit <subcommand>` and returns the exit status: 0 on
 * success, 1 when verification fails or a requested log cannot be read, 2 for
 * a usage error.
 */
export async function runAuditCommand(
  args: readonly string[],
  dependencies: AuditCommandDependencies = {},
): Promise<number> {
  const deps: Required<AuditCommandDependencies> = {
    write: dependencies.write ?? ((text) => process.stdout.write(text)),
    writeError: dependencies.writeError ?? ((text) => process.stderr.write(text)),
    now: dependencies.now ?? Date.now,
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        session: { type: 'string' },
        workflow: { type: 'string' },
        file: { type: 'string' },
        since: { type: 'string' },
        top: { type: 'string' },
        global: { type: 'boolean' },
        persona: { type: 'string' },
        job: { type: 'string' },
        threshold: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    deps.writeError(`${err instanceof Error ? err.message : String(err)}\n\n${formatHelp(auditCommandSpec)}\n`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    deps.write(`${formatHelp(auditCommandSpec)}\n`);
    return 0;
  }
  const subcommand = positionals.length > 0 ? positionals[0] : undefined;
  const extra = positionals.slice(1);
  try {
    if (extra.length > 0) throw new AuditUsageError(`Unexpected argument: ${toDisplayText(extra[0])}`);
    switch (subcommand) {
      case 'report':
        return await runReport(values, deps);
      case 'verify':
        return runVerify(values, deps);
      case 'proposals':
        return runProposals(values, deps);
      default:
        throw new AuditUsageError(
          subcommand === undefined ? 'Missing subcommand' : `Unknown subcommand: ${toDisplayText(subcommand)}`,
        );
    }
  } catch (err) {
    if (err instanceof AuditUsageError) {
      deps.writeError(`${err.message}\n\n${formatHelp(auditCommandSpec)}\n`);
      return EXIT_USAGE;
    }
    throw err;
  }
}

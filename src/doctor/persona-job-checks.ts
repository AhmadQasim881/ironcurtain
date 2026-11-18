/**
 * `ironcurtain doctor` checks of personas and cron jobs: definitions that
 * sessions and the daemon refuse or silently skip, and compiled policies
 * that are missing, stale, invalid or broader than the persona allows.
 *
 * Personas (`~/.ironcurtain/personas/<name>/`):
 *   - the directory name is a valid persona name;
 *   - persona.json parses and passes the check `loadPersona` applies (its
 *     schema, and a `name` equal to the directory's), `servers` names only
 *     configured servers, and its `agentModelId` and `resourceBudget`, when
 *     set, are valid (sessions refuse the persona otherwise, see
 *     persona-overrides.ts);
 *   - the compiled policy exists and was compiled from the current
 *     constitution.md (`getPersonaPolicyState`, which `resolvePersona`
 *     enforces), passes its schema, and its provenance matches this
 *     IronCurtain and the tool annotations in effect;
 *   - a policy that grants broad access (broad wildcard domains or lists,
 *     paths outside the persona's workspace, allow rules with unconstrained
 *     resource arguments) has the persona's explicit `allowBroadPolicy`:
 *     judged exactly as `resolvePersona` judges it
 *     (`inspectCompiledPolicyBreadth`), which refuses such a policy without
 *     the opt-in.
 *
 * Jobs (`~/.ironcurtain/jobs/<id>/`):
 *   - the directory name is a valid job id, and job.json is valid as the job
 *     store reads it (`readJob`, the schema the daemon and the job commands
 *     apply, `id` equal to the directory name); the daemon does not schedule
 *     any other job;
 *   - the policy the job runs under, its own or its persona's, exists and is
 *     current (`checkJobPolicy`, which the daemon applies before every run),
 *     and the provenance of a job's own policy matches.
 *
 * Read-only and offline. Never throws: a damaged file is a finding.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { loadPersonaPolicyArtifacts } from '../config/index.js';
import { getJobGeneratedDir, getJobsDir } from '../config/paths.js';
import type { IronCurtainConfig } from '../config/types.js';
import { checkJobPolicy } from '../cron/job-policy.js';
import { readJob } from '../cron/job-store.js';
import { createJobId } from '../cron/types.js';
import { describeBroadAccess, hasBroadAccess, type BroadPolicyFindings } from '../persona/broad-policy-validator.js';
import { checkPersonaDefinition } from '../persona/persona-definition.js';
import { inspectCompiledPolicyBreadth } from '../persona/policy-breadth-check.js';
import { parsePersonaAgentModelId, parsePersonaResourceBudget } from '../persona/persona-overrides.js';
import {
  getPersonaDefinitionPath,
  getPersonaGeneratedDir,
  getPersonaPolicyState,
  getPersonaWorkspaceDir,
  getPersonasDir,
} from '../persona/resolve.js';
import type { PersonaName } from '../persona/types.js';
import type { StoredToolAnnotationsFile } from '../pipeline/types.js';
import { assessPolicyProvenance, describePolicyStaleReason } from '../policy-artifacts/provenance.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { SLUG_PATTERN } from '../types/slug.js';
import { isPlainObject } from '../utils/is-plain-object.js';
import type { CheckResult } from './checks.js';

/** At most this many personas or jobs with problems are listed in a message. */
const MAX_LISTED = 4;

/** One persona's or job's problems. */
export interface ScopedFinding {
  readonly subject: string;
  readonly problems: readonly string[];
  /** Why the compiled policy needs recompiling (missing, stale, invalid, stale provenance), if it does. */
  readonly policyProblem?: string;
}

function quote(value: string): string {
  return toDisplayText(JSON.stringify(value), { maxLength: 80 });
}

function errorText(err: unknown): string {
  return toDisplayText(err instanceof Error ? err.message : String(err), { maxLength: 200 });
}

/** Directory entries of `dir` that are directories and not hidden; [] when it does not exist. */
function listDirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Reads and parses a JSON file; a string problem when that fails. */
function readJson(path: string, label: string): { readonly value: unknown } | { readonly problem: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { problem: code === 'ENOENT' ? `${label} is missing` : `${label} cannot be read (${code ?? 'error'})` };
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { problem: `${label} is not valid JSON` };
  }
}

/**
 * Problems of a persona.json value: exactly what `loadPersona` refuses
 * (`checkPersonaDefinition`, persona-definition.ts: the schema, and a `name`
 * other than the directory's) and what sessions refuse of the persona's
 * `agentModelId` and `resourceBudget` (persona-overrides.ts), so a persona
 * reported usable here is one sessions load and start, plus servers the
 * configuration does not have (which sessions only warn about).
 * `directoryName` is a valid persona name.
 */
export function lintPersonaDefinition(
  raw: unknown,
  directoryName: string,
  knownServers: ReadonlySet<string>,
): string[] {
  if (!isPlainObject(raw)) return ['persona.json is not a JSON object'];
  const check = checkPersonaDefinition(raw, directoryName as PersonaName);
  const issues = check.ok ? [] : check.problems.map((problem) => `persona.json ${problem}`);
  const servers = raw.servers;
  if (Array.isArray(servers) && servers.every((server): server is string => typeof server === 'string')) {
    const unknown = servers.filter((server) => !knownServers.has(server) && server !== 'filesystem');
    if (unknown.length > 0) issues.push(`servers names unconfigured server(s) ${unknown.map(quote).join(', ')}`);
  }
  // Judged exactly as sessions judge them (`readPersonaOverrides`), which
  // refuse the persona when either is malformed (the schema check above
  // leaves their values to that check).
  if (raw.agentModelId !== undefined) {
    const model = parsePersonaAgentModelId(raw.agentModelId);
    if (!model.ok) {
      issues.push(
        `agentModelId is invalid (${toDisplayText(model.problem, { maxLength: 200 })}), so sessions refuse it`,
      );
    }
  }
  if (raw.resourceBudget !== undefined) {
    const budget = parsePersonaResourceBudget(raw.resourceBudget);
    if (!budget.ok) {
      issues.push(
        `resourceBudget is invalid (${toDisplayText(budget.problem, { maxLength: 200 })}), so sessions refuse it`,
      );
    }
  }
  return issues.map((issue) => toDisplayText(issue, { maxLength: 600 }));
}

/**
 * The provenance problem of the compiled policy in `policyDir` (schema
 * errors included), or undefined when it matches this IronCurtain and the
 * annotations. Only called for a policy that exists.
 */
function policyArtifactProblem(
  policyDir: string,
  annotations: StoredToolAnnotationsFile | undefined,
): { readonly problem?: string; readonly policy?: ReturnType<typeof loadPersonaPolicyArtifacts> } {
  let loaded: ReturnType<typeof loadPersonaPolicyArtifacts>;
  try {
    loaded = loadPersonaPolicyArtifacts(policyDir);
  } catch (err) {
    return { problem: `its compiled policy is invalid: ${errorText(err)}` };
  }
  try {
    const assessment = assessPolicyProvenance(loaded.compiledPolicy, annotations);
    if (assessment.staleReasons.length === 0) return { policy: loaded };
    const [first, ...rest] = assessment.staleReasons;
    const more = rest.length > 0 ? ` (and ${rest.length} more reason${rest.length === 1 ? '' : 's'})` : '';
    return { problem: `its compiled policy is stale: ${describePolicyStaleReason(first)}${more}`, policy: loaded };
  } catch (err) {
    return { problem: `its compiled policy is malformed: ${errorText(err)}` };
  }
}

/**
 * Why sessions refuse `name`'s compiled policy for its breadth, or undefined
 * when it needs no broad-policy opt-in. Judged exactly as `resolvePersona`
 * judges it (`inspectCompiledPolicyBreadth`: the artifacts on disk with their
 * resolved lists and the tool annotations in effect, `hasBroadAccess`), so a
 * persona reported usable here is one sessions start. Only asked for a persona
 * without the opt-in; a breadth that cannot be judged fails closed there too.
 */
function unauthorizedBreadth(name: PersonaName): string | undefined {
  let findings: BroadPolicyFindings;
  try {
    findings = inspectCompiledPolicyBreadth(getPersonaGeneratedDir(name), getPersonaWorkspaceDir(name));
  } catch (err) {
    return `its policy's breadth cannot be checked, so sessions refuse it: ${errorText(err)}`;
  }
  if (!hasBroadAccess(findings)) return undefined;
  const access = toDisplayText(describeBroadAccess(findings).join('; '), { maxLength: 300 });
  return (
    `its policy grants broad access (${access}) but the persona has not opted in, so sessions refuse it ` +
    `(narrow its constitution and run: ironcurtain persona compile ${name}, or allow it: ` +
    `ironcurtain persona compile ${name} --allow-broad)`
  );
}

/** Every persona's problems; personas without any are listed with none. */
export function findPersonaProblems(
  config: IronCurtainConfig,
  annotations: StoredToolAnnotationsFile | undefined,
): ScopedFinding[] {
  const knownServers = new Set(Object.keys(config.mcpServers));
  return listDirectories(getPersonasDir()).map((directoryName) => {
    const subject = `persona ${quote(directoryName)}`;
    if (!SLUG_PATTERN.test(directoryName)) {
      return { subject, problems: ['its name is not a valid persona name, so it cannot be used'] };
    }
    const name = directoryName as PersonaName;
    const problems: string[] = [];
    let allowBroadPolicy = false;
    const definition = readJson(getPersonaDefinitionPath(name), 'persona.json');
    if ('problem' in definition) {
      problems.push(definition.problem);
    } else {
      problems.push(...lintPersonaDefinition(definition.value, directoryName, knownServers));
      allowBroadPolicy = isPlainObject(definition.value) && definition.value.allowBroadPolicy === true;
    }

    let policyProblem: string | undefined;
    const state = getPersonaPolicyState(name);
    const recompile = `ironcurtain persona compile ${directoryName}`;
    if (state.kind === 'missing') {
      policyProblem = `no compiled policy (run: ${recompile})`;
    } else if (state.kind === 'stale') {
      policyProblem = `stale compiled policy: ${toDisplayText(state.detail)} (run: ${recompile})`;
    } else {
      const artifact = policyArtifactProblem(getPersonaGeneratedDir(name), annotations);
      if (artifact.problem !== undefined) policyProblem = `${artifact.problem} (run: ${recompile})`;
      if (artifact.policy !== undefined && !allowBroadPolicy) {
        const refusal = unauthorizedBreadth(name);
        if (refusal !== undefined) problems.push(refusal);
      }
    }
    if (policyProblem !== undefined) problems.push(policyProblem);
    return { subject, problems, ...(policyProblem === undefined ? {} : { policyProblem }) };
  });
}

/** Every job's problems; jobs without any are listed with none. */
export function findJobProblems(annotations: StoredToolAnnotationsFile | undefined): ScopedFinding[] {
  return listDirectories(getJobsDir()).map((directoryName) => {
    const subject = `job ${quote(directoryName)}`;
    if (!SLUG_PATTERN.test(directoryName)) {
      return { subject, problems: ['its name is not a valid job id; the daemon skips it'] };
    }
    // Read and validated by the job store, exactly as the daemon and the job
    // commands read it, so this line and `Cron jobs` never disagree.
    const read = readJob(createJobId(directoryName));
    if (read.kind === 'missing') {
      return { subject, problems: ['job.json is missing; the daemon skips this job'] };
    }
    if (read.kind === 'invalid') {
      const reason = toDisplayText(read.error.reason, { maxLength: 160 });
      return { subject, problems: [`job.json is invalid (${reason}); the daemon does not schedule this job`] };
    }
    const job = read.job;
    const disabled = job.enabled ? '' : ' (job disabled)';
    let policyProblem: string | undefined;
    const policy = checkJobPolicy(job);
    if (!policy.ok) {
      policyProblem = `${toDisplayText(policy.message)}${disabled}`;
    } else if (job.persona === undefined) {
      const artifact = policyArtifactProblem(getJobGeneratedDir(job.id), annotations);
      if (artifact.problem !== undefined) {
        policyProblem = `${artifact.problem} (run: ironcurtain daemon recompile-job ${directoryName})${disabled}`;
      }
    }
    return policyProblem === undefined
      ? { subject, problems: [] }
      : { subject, problems: [policyProblem], policyProblem };
  });
}

/** One summary line for a list of findings. */
function summarize(name: string, noun: string, findings: readonly ScopedFinding[]): CheckResult {
  if (findings.length === 0) return { name, status: 'ok', message: 'none' };
  const withProblems = findings.filter((finding) => finding.problems.length > 0);
  const count = `${findings.length} ${noun}${findings.length === 1 ? '' : 's'}`;
  if (withProblems.length === 0) return { name, status: 'ok', message: `${count}, all usable and current` };
  const shown = withProblems
    .slice(0, MAX_LISTED)
    .map((finding) => `${finding.subject}: ${finding.problems.join('; ')}`)
    .join(' | ');
  const more = withProblems.length > MAX_LISTED ? ` | and ${withProblems.length - MAX_LISTED} more` : '';
  return {
    name,
    status: 'warn',
    message: `${withProblems.length} of ${count} need${withProblems.length === 1 ? 's' : ''} attention: ${shown}${more}`,
  };
}

/** The Personas line of doctor's Configuration section. */
export function checkPersonas(
  config: IronCurtainConfig,
  annotations: StoredToolAnnotationsFile | undefined,
): CheckResult {
  try {
    return summarize('Personas', 'persona', findPersonaProblems(config, annotations));
  } catch (err) {
    return { name: 'Personas', status: 'warn', message: `could not be checked: ${errorText(err)}` };
  }
}

/** The Jobs line of doctor's Configuration section. */
export function checkJobs(annotations: StoredToolAnnotationsFile | undefined): CheckResult {
  try {
    return summarize('Jobs', 'job', findJobProblems(annotations));
  } catch (err) {
    return { name: 'Jobs', status: 'warn', message: `could not be checked: ${errorText(err)}` };
  }
}

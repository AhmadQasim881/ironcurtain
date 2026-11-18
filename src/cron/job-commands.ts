/**
 * CLI subcommands for cron job management.
 *
 * These commands work without a running daemon -- they read/write
 * job files directly from ~/.ironcurtain/jobs/. When a daemon is
 * running, daemon-command.ts forwards commands via the control socket
 * instead of calling these functions directly; `add-job` and `edit-job`
 * write the files here and then ask the daemon to reload the job.
 *
 * Run summaries (the agent's last-run.md), outcome messages and generated
 * constitutions are agent- or model-written, so they are printed through
 * toDisplayText: control and invisible format characters show as escapes.
 */

import { mkdirSync } from 'node:fs';
import chalk from 'chalk';
import {
  readJob,
  scanJobs,
  saveJob,
  saveEditedJob,
  updateJob,
  deleteJob,
  loadLatestRun,
  loadRecentRuns,
  countConsecutiveFailures,
  budgetOverridesSchema,
  findJobDefinitionProblem,
  type InvalidJobEntry,
} from './job-store.js';
import {
  CRON_BUDGET_DEFAULTS,
  createJobId,
  isInvalidJobError,
  isJobNotFoundError,
  type JobBudgetOverrides,
  type JobDefinition,
  type JobId,
  type RunOutcome,
  type RunRecord,
} from './types.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import type { SessionMode } from '../session/types.js';
import { validateWorkspacePath } from '../session/workspace-validation.js';
import { openEditorForMultiline } from '../utils/editor.js';
import { loadConfig } from '../config/index.js';
import { getJobWorkspaceDir, getJobRepoMirrorDir } from '../config/paths.js';
import { loadPersona } from '../persona/resolve.js';
import { findPersonaOverridesProblem } from '../persona/persona-overrides.js';
import { createPersonaName } from '../persona/types.js';
import type { PersonaListDto } from '../web-ui/web-ui-types.js';
import type { CompiledPolicyFile } from '../pipeline/types.js';
import { compileTaskPolicy, type TaskPolicyJob } from './compile-task-policy.js';
import { checkJobPolicy, getJobPolicyState, revokeJobPolicy, type JobPolicyCheck } from './job-policy.js';
import { describeFailedServers, failedServerNames, PARTIAL_COMPILE_EXIT_CODE } from './partial-compile.js';
import { parseCronExpression, getNextFireTime } from './cron-scheduler.js';
import { formatRelativeTime, describeCronExpression, formatFailureStreak } from './format-utils.js';
import { formatCostUsd } from '../session/cost-display.js';
import { MAX_RUN_NOTICE_CHARS } from './run-summary.js';
import { syncGitRepo, validateGitUri } from './git-sync.js';
import { generateConstitution } from './constitution-generator.js';
import { runJobConstitutionCustomizer } from './job-customizer.js';
import { jobApprovalScope } from '../audit/approval-history.js';

/** Generates a unique default JobDefinition with empty task fields. */
function generateDefaultJob(): JobDefinition {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    id: createJobId(`job-${suffix}`),
    name: '',
    schedule: '0 9 * * *',
    taskDescription: '',
    taskConstitution: '',
    gitRepo: undefined,
    notifyOnEscalation: true,
    notifyOnCompletion: true,
    enabled: true,
  };
}

const TASK_DESCRIPTION_INSTRUCTIONS =
  'Enter the task description — what the agent should do each run.\n' +
  'This is sent to the agent as its work prompt.\n' +
  'Lines starting with # are ignored.';

const TASK_CONSTITUTION_INSTRUCTIONS =
  'Enter the task constitution — what the agent is and is not permitted to do.\n' +
  'This is the policy compilation input; be specific about allowed operations.\n' +
  'Lines starting with # are ignored.';

/** The optional job fields the review loop sets and clears. */
type OptionalJobField = 'workspace' | 'persona' | 'budgetOverrides';

/**
 * `job` with the optional field `key` set to `value`, or without the field
 * when `value` is undefined: a cleared field is left out of job.json.
 */
function withOptionalField(job: JobDefinition, key: 'workspace' | 'persona', value: string | undefined): JobDefinition;
function withOptionalField(
  job: JobDefinition,
  key: 'budgetOverrides',
  value: JobDefinition['budgetOverrides'],
): JobDefinition;
function withOptionalField(
  job: JobDefinition,
  key: OptionalJobField,
  value: JobDefinition[OptionalJobField],
): JobDefinition {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Destructure to omit the optional property.
  const { [key]: _omit, ...rest } = job;
  return value === undefined ? rest : { ...rest, [key]: value };
}

/** One per-job budget limit, as the review loop asks for it. */
interface BudgetField {
  readonly key: keyof JobBudgetOverrides;
  /** Prompt label. */
  readonly label: string;
  /** Label in the one-line summary. */
  readonly short: string;
  /** Whether the limit is a whole number (only picks the hint; the schema decides). */
  readonly integer: boolean;
  readonly format: (value: number) => string;
}

const BUDGET_FIELDS: readonly BudgetField[] = [
  { key: 'maxTotalTokens', label: 'Max total tokens', short: 'tokens', integer: true, format: (v) => String(v) },
  { key: 'maxSteps', label: 'Max agent steps', short: 'steps', integer: true, format: (v) => String(v) },
  {
    key: 'maxSessionSeconds',
    label: 'Session timeout in seconds',
    short: 'timeout',
    integer: false,
    format: (v) => `${v}s`,
  },
  { key: 'maxEstimatedCostUsd', label: 'Cost cap in USD', short: 'cost', integer: false, format: (v) => `$${v}` },
];

/** A number as typed, or as String() prints one (`1e+21`, `1e-7`): no sign, hex, spaces or Infinity. */
const DECIMAL_NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/** What a budget prompt's input means: a limit, `null` for no limit, or undefined for the default. */
type BudgetInput =
  { readonly ok: true; readonly value: number | null | undefined } | { readonly ok: false; readonly message: string };

/**
 * Parses one budget limit as typed in the review loop: empty keeps the
 * default (the field is left out), `none` removes the limit (`null`), and a
 * number must pass the field's schema in job-store.ts, so the loop never
 * saves a limit job.json would be refused for when it is read back.
 */
function parseBudgetInput(field: BudgetField, raw: string | undefined): BudgetInput {
  const input = (raw ?? '').trim();
  if (input === '') return { ok: true, value: undefined };
  if (input.toLowerCase() === 'none') return { ok: true, value: null };
  const value = DECIMAL_NUMBER.test(input) ? Number(input) : Number.NaN;
  if (budgetOverridesSchema.shape[field.key].safeParse(value).success) return { ok: true, value };
  const expected = field.integer ? `a whole number from 1 to ${Number.MAX_SAFE_INTEGER}` : 'a number greater than 0';
  return { ok: false, message: `${field.label}: enter ${expected}, "none" for no limit, or nothing for the default` };
}

/** A budget limit as its prompt starts out: empty for the default, `none` for no limit. */
function budgetInputText(value: number | null | undefined): string {
  if (value === undefined) return '';
  return value === null ? 'none' : String(value);
}

/** "tokens 1000000, steps no limit", or "defaults" when the job overrides no limit. */
function describeBudgetOverrides(overrides: Partial<JobBudgetOverrides> | undefined): string {
  const parts = BUDGET_FIELDS.flatMap((field) => {
    const value = overrides?.[field.key];
    if (value === undefined) return [];
    return [`${field.short} ${value === null ? 'no limit' : field.format(value)}`];
  });
  return parts.length > 0 ? parts.join(', ') : 'defaults';
}

/**
 * The budget prompt for `field`. An empty answer leaves the limit to the
 * persona's `resourceBudget` (for a persona job), else to the cron default.
 */
function budgetPromptMessage(field: BudgetField, hasPersona: boolean): string {
  const fallback = CRON_BUDGET_DEFAULTS[field.key];
  const cronDefault = fallback === null ? 'no limit' : field.format(fallback);
  const defaultText = hasPersona ? `the persona's limit, else ${cronDefault}` : cronDefault;
  return `${field.label} (empty for the default: ${defaultText}; "none" for no limit)`;
}

/** What the workspace prompt's input means: a custom workspace, or undefined for the default one. */
type WorkspaceInput =
  { readonly ok: true; readonly workspace: string | undefined } | { readonly ok: false; readonly message: string };

/**
 * Parses a custom workspace as typed in the review loop: empty means the
 * job's default workspace, anything else must pass validateWorkspacePath()
 * against `protectedPaths` (the check the daemon makes before every run) and
 * is kept in the canonical form it returns, so the directory the policy is
 * compiled against is the one the runs use.
 */
function parseWorkspaceInput(raw: string | undefined, protectedPaths: readonly string[]): WorkspaceInput {
  const input = (raw ?? '').trim();
  if (input === '') return { ok: true, workspace: undefined };
  try {
    return { ok: true, workspace: validateWorkspacePath(input, protectedPaths) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The select value for "no persona" (never a persona name: those are slugs). */
const NO_PERSONA = '';

/** Why `name` cannot be a job's persona (no such persona, an invalid persona.json), or undefined. */
function findPersonaProblem(name: string): string | undefined {
  try {
    loadPersona(createPersonaName(name));
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** A persona's description and, when it cannot run a job as it is (see checkJobCanRun), why. */
function personaHint(persona: PersonaListDto): string {
  const parts: string[] = [];
  if (persona.description.trim()) parts.push(toDisplayText(persona.description, { maxLength: 60 }));
  if (!persona.compiled) parts.push('no compiled policy');
  else if (persona.stale !== undefined) parts.push('policy stale');
  if (findPersonaOverridesProblem(persona.name) !== undefined) parts.push('invalid agent model or limits');
  return parts.join(' — ');
}

/**
 * Whether the daemon would start a run of `job` as it is now, by the checks
 * it makes before every run: the policy the job runs under (checkJobPolicy)
 * and, for a persona job, the persona's agent model and resource limits
 * (findPersonaOverridesProblem), for which it refuses the run just the same.
 */
function checkJobCanRun(job: JobDefinition): JobPolicyCheck {
  const check = checkJobPolicy(job);
  if (!check.ok || job.persona === undefined) return check;
  const problem = findPersonaOverridesProblem(job.persona);
  return problem === undefined ? check : { ok: false, problem: 'missing', message: problem };
}

/**
 * Interactive review-and-edit loop shared by add-job and edit-job.
 *
 * Shows a summary of all fields and lets the user edit any of them
 * before confirming. Confirm is blocked until the task description is set,
 * and the task constitution too unless the job runs under a persona's
 * policy, and while the job would read back from job.json as invalid. Each
 * step validates what it sets: a custom workspace as the daemon checks it
 * before a run, a persona by loading it, budget limits with the job store's
 * schema. In add mode the ID is editable; in edit mode it is fixed.
 */
async function runJobReviewLoop(initial: JobDefinition, isNew: boolean): Promise<JobDefinition> {
  const { text, confirm, select, note, isCancel, cancel, log, spinner } = await import('@clack/prompts');

  let job = initial;
  let hasOfferedGeneration = false;

  /**
   * Runs constitution generation and presents accept/refine/discard options.
   * Returns the accepted or refined constitution, or undefined if discarded.
   *
   * The generator explores a throwaway clone of the job's repository, never
   * the job's own workspace, so nothing is created under the job's directory
   * before the job is saved: the ID can still change, or the wizard be
   * cancelled. Cancelling the spinner stops a clone still in progress: in a
   * terminal clack exits the process on Ctrl-C or Escape, and the
   * generator's exit hook kills the clone and deletes it; a SIGINT or
   * SIGTERM the spinner catches instead reaches the generator through
   * onCancel.
   */
  async function runGenerateAndReview(): Promise<string | undefined> {
    const cancelGeneration = new AbortController();
    const genSpinner = spinner({ onCancel: () => cancelGeneration.abort() });
    genSpinner.start('Generating constitution...');
    try {
      const result = await generateConstitution({
        taskDescription: job.taskDescription,
        gitRepo: job.gitRepo,
        signal: cancelGeneration.signal,
        onProgress: (msg) => {
          genSpinner.message(toDisplayText(msg));
        },
      });
      genSpinner.stop('Constitution generated.');
      // Model output (shaped by repository content it read): shown with
      // control characters as visible escapes.
      note(toDisplayText(result.constitution, { multiline: true }), 'Generated Constitution');
      if (result.reasoning) {
        log.info(toDisplayText(result.reasoning, { multiline: true }));
      }

      const genAction = await select({
        message: 'What would you like to do with the generated constitution?',
        options: [
          { value: 'accept' as const, label: 'Accept as-is' },
          { value: 'refine' as const, label: 'Refine interactively' },
          { value: 'discard' as const, label: 'Discard' },
        ],
      });
      if (isCancel(genAction)) {
        cancel('Cancelled.');
        process.exit(0);
      }

      if (genAction === 'accept') {
        return result.constitution;
      } else if (genAction === 'refine') {
        return (await runJobConstitutionCustomizer(result.constitution, job.taskDescription)) ?? undefined;
      }
      return undefined; // discard
    } catch (err) {
      genSpinner.stop('Generation failed.');
      log.error(`Constitution generation failed: ${displayMessage(err)}`);
      return undefined;
    }
  }

  /**
   * Notes how the repository of a job with a custom workspace is synced:
   * as the daemon syncs it before every run (git-sync.ts, not a managed
   * workspace), which refuses a first sync into a directory with files in it.
   */
  function noteCustomWorkspaceSync(): void {
    if (job.workspace !== undefined && job.gitRepo !== undefined) {
      log.info(
        'The git repository is synced into the custom workspace before every run; ' +
          'it must be empty when it is first synced.',
      );
    }
  }

  for (;;) {
    const gitRepoDisplay = job.gitRepo ?? '(none)';
    // A persona job runs under the persona's policy: its own constitution is
    // neither compiled nor used, so it is not required.
    const persona = job.persona;
    const constitutionRequired = persona === undefined;
    const descIsEmpty = !job.taskDescription.trim();
    const constIsEmpty = !job.taskConstitution.trim();
    const anyEmpty = descIsEmpty || (constitutionRequired && constIsEmpty);

    function fieldPreview(text: string, emptyNote: string): string {
      if (!text.trim()) return `  (${emptyNote})`;
      const lines = text.split('\n');
      return [
        // The constitution may be model-generated: escape control characters.
        ...lines.slice(0, 3).map((l) => `  ${toDisplayText(l)}`),
        ...(lines.length > 3 ? [`  … (${lines.length - 3} more lines)`] : []),
      ].join('\n');
    }

    const notifyParts = [job.notifyOnEscalation ? 'escalation' : '', job.notifyOnCompletion ? 'completion' : ''].filter(
      Boolean,
    );
    const notifyStr = notifyParts.length ? notifyParts.join(', ') : 'none';

    const memoryStr = job.memory?.enabled === false ? 'off' : 'on (default)';

    // A hand-edited job.json can hold any text here: escape it.
    const workspaceStr = job.workspace === undefined ? 'default' : toDisplayText(job.workspace);
    const personaStr = persona === undefined ? '(none)' : toDisplayText(persona);
    const budgetStr = describeBudgetOverrides(job.budgetOverrides);

    const scheduleDesc = describeCronExpression(job.schedule);

    note(
      [
        `ID:        ${job.id}`,
        `Name:      ${job.name || '(not set)'}`,
        `Schedule:  ${job.schedule}  (${scheduleDesc})`,
        `Git repo:  ${gitRepoDisplay}`,
        `Workspace: ${job.workspace === undefined ? `default (${getJobWorkspaceDir(job.id)})` : workspaceStr}`,
        `Persona:   ${personaStr}`,
        `Budget:    ${budgetStr}`,
        `Notify:    ${notifyStr}`,
        `Memory:    ${memoryStr}`,
        ``,
        `Task description:`,
        fieldPreview(job.taskDescription, 'not set — required'),
        ``,
        constitutionRequired
          ? `Task constitution:`
          : `Task constitution (not used: the job runs under its persona's policy):`,
        // The confirmation authorizes this whole policy, so show every line.
        constIsEmpty
          ? `  (${constitutionRequired ? 'not set — required' : 'not set — not needed'})`
          : toDisplayText(job.taskConstitution, { multiline: true })
              .split('\n')
              .map((line) => `  ${line}`)
              .join('\n'),
      ].join('\n'),
      isNew ? 'New job' : 'Edit job',
    );

    const confirmLabel = isNew ? 'Confirm — create this job' : 'Save changes';
    let constitutionMarker = '';
    if (!constitutionRequired) constitutionMarker = '  (not used with a persona)';
    else if (constIsEmpty) constitutionMarker = '  ← required';
    const action = await select({
      message: 'Confirm or edit a field',
      options: [
        { value: 'confirm', label: anyEmpty ? `${confirmLabel}  (required fields missing)` : confirmLabel },
        ...(isNew ? [{ value: 'id', label: `Edit ID               ${job.id}` }] : []),
        { value: 'name', label: `Edit name             ${job.name || '(not set)'}` },
        { value: 'schedule', label: `Edit schedule         ${job.schedule}` },
        { value: 'gitRepo', label: `Edit git repo         ${gitRepoDisplay}` },
        { value: 'workspace', label: `Edit workspace        ${workspaceStr}` },
        { value: 'taskDescription', label: `Edit task description${descIsEmpty ? '  ← required' : ''}` },
        { value: 'persona', label: `Edit persona          ${personaStr}` },
        { value: 'taskConstitution', label: `Edit task constitution${constitutionMarker}` },
        {
          value: 'generateConstitution',
          label: `Generate constitution from task${descIsEmpty ? '  (set task first)' : ''}`,
        },
        {
          value: 'customizeConstitution',
          label: `Customize constitution interactively${constIsEmpty ? '  (set constitution first)' : ''}`,
        },
        { value: 'budget', label: `Edit budget overrides ${budgetStr}` },
        { value: 'notify', label: `Edit notify           ${notifyStr}` },
        { value: 'memory', label: `Edit memory          ${memoryStr}` },
      ],
    });
    if (isCancel(action)) {
      cancel('Cancelled.');
      process.exit(0);
    }

    if (action === 'confirm') {
      if (anyEmpty) {
        log.warn(
          constitutionRequired
            ? 'Task description and constitution are both required. Please set them before confirming.'
            : 'The task description is required. Please set it before confirming.',
        );
        continue;
      }
      // An invalid job.json also occupies the id (remove-job cleans it up).
      if (isNew && readJob(job.id).kind !== 'missing') {
        log.error(`Job "${job.id}" already exists. Please edit the ID.`);
        continue;
      }
      // Never save a definition the job store would refuse when it reads it back.
      const problem = findJobDefinitionProblem(job);
      if (problem !== undefined) {
        log.error(`The job cannot be saved: ${toDisplayText(problem)}`);
        continue;
      }
      break;
    }

    switch (action) {
      case 'id': {
        const inp = await text({
          message: 'Job ID (slug)',
          initialValue: job.id,
          validate: (v) => {
            if (!v) return 'Required';
            try {
              createJobId(v);
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          },
        });
        if (isCancel(inp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        job = { ...job, id: createJobId(inp) };
        break;
      }
      case 'name': {
        const inp = await text({ message: 'Display name', initialValue: job.name });
        if (isCancel(inp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        job = { ...job, name: inp };
        break;
      }
      case 'schedule': {
        const inp = await text({
          message: 'Schedule (cron expression)',
          initialValue: job.schedule,
          validate: (v) => {
            if (!v) return 'Required';
            try {
              parseCronExpression(v);
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          },
        });
        if (isCancel(inp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        job = { ...job, schedule: inp };
        break;
      }
      case 'gitRepo': {
        const inp = await text({
          message: 'Git repository URI (optional, leave empty to skip)',
          placeholder: 'git@github.com:org/repo.git',
          initialValue: job.gitRepo ?? '',
          validate: (v) => {
            if (!v) return; // empty is valid (skip)
            try {
              validateGitUri(v);
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          },
        });
        if (isCancel(inp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        job = { ...job, gitRepo: inp || undefined };
        noteCustomWorkspaceSync();
        break;
      }
      case 'taskDescription': {
        log.step('Opening editor — save and close to continue');
        const newDesc = openEditorForMultiline(TASK_DESCRIPTION_INSTRUCTIONS, job.taskDescription);
        if (newDesc) {
          job = { ...job, taskDescription: newDesc };
        } else {
          log.warn('Editor was empty — keeping existing task description.');
        }

        // Proactively offer auto-generation for new jobs when the user has
        // just entered a task description and constitution is still empty
        // (and needed: a persona job runs under the persona's policy).
        if (
          isNew &&
          !hasOfferedGeneration &&
          job.persona === undefined &&
          job.taskDescription.trim() &&
          !job.taskConstitution.trim()
        ) {
          hasOfferedGeneration = true;
          const shouldGenerate = await confirm({
            message: 'Generate a constitution automatically from the task description?',
            initialValue: true,
          });
          if (isCancel(shouldGenerate)) {
            cancel('Cancelled.');
            process.exit(0);
          }
          if (shouldGenerate) {
            const constitution = await runGenerateAndReview();
            if (constitution) {
              job = { ...job, taskConstitution: constitution };
            }
          }
        }
        break;
      }
      case 'taskConstitution': {
        log.step('Opening editor — save and close to continue');
        const initialConstitution = job.taskConstitution || 'The agent is allowed ';
        const newConst = openEditorForMultiline(TASK_CONSTITUTION_INSTRUCTIONS, initialConstitution);
        if (newConst) {
          job = { ...job, taskConstitution: newConst };
        } else {
          log.warn('Editor was empty — keeping existing task constitution.');
        }
        break;
      }
      case 'generateConstitution': {
        if (descIsEmpty) {
          log.warn('Set the task description first.');
          break;
        }
        const constitution = await runGenerateAndReview();
        if (constitution) {
          job = { ...job, taskConstitution: constitution };
        }
        break;
      }
      case 'customizeConstitution': {
        if (!job.taskConstitution.trim()) {
          log.warn('Set or generate a constitution first.');
          break;
        }
        const refined = await runJobConstitutionCustomizer(
          job.taskConstitution,
          job.taskDescription,
          isNew ? undefined : jobApprovalScope(job.id),
        );
        if (refined) {
          job = { ...job, taskConstitution: refined };
        }
        break;
      }
      case 'notify': {
        const esc = await confirm({
          message: 'Notify on escalation via Signal?',
          initialValue: job.notifyOnEscalation,
        });
        if (isCancel(esc)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        const comp = await confirm({
          message: 'Notify on completion via Signal?',
          initialValue: job.notifyOnCompletion,
        });
        if (isCancel(comp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        job = { ...job, notifyOnEscalation: esc, notifyOnCompletion: comp };
        break;
      }
      case 'memory': {
        const currentEnabled = job.memory?.enabled !== false;
        const enabled = await confirm({
          message: 'Enable persistent memory for this job?',
          initialValue: currentEnabled,
        });
        if (isCancel(enabled)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        // Destructure-omit `memory` so we can either re-attach it (off case)
        // or drop it entirely (on case). Avoids `memory: undefined` in spread.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Destructure to omit the optional property.
        const { memory: _omit, ...rest } = job;
        job = !enabled ? { ...rest, memory: { enabled: false } } : rest;
        break;
      }
      case 'workspace': {
        // The protected paths the daemon checks a custom workspace against before every run.
        let protectedPaths: readonly string[];
        try {
          protectedPaths = loadConfig().protectedPaths;
        } catch (err) {
          log.error(`Workspace not changed: the configuration cannot be loaded (${displayMessage(err)})`);
          break;
        }
        const inp = await text({
          message: "Workspace directory (leave empty for the job's default workspace)",
          placeholder: getJobWorkspaceDir(job.id),
          initialValue: job.workspace ?? '',
          validate: (v) => {
            const parsed = parseWorkspaceInput(v, protectedPaths);
            return parsed.ok ? undefined : toDisplayText(parsed.message);
          },
        });
        if (isCancel(inp)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        const parsed = parseWorkspaceInput(inp, protectedPaths);
        if (!parsed.ok) {
          log.error(`Workspace not changed: ${toDisplayText(parsed.message)}`);
          break;
        }
        // The directory job.json already names, spelled another way (a
        // hand-edited `~/...`): not a change, so it does not recompile.
        const current = job.workspace === undefined ? undefined : parseWorkspaceInput(job.workspace, protectedPaths);
        if (current?.ok === true && current.workspace === parsed.workspace) break;
        job = withOptionalField(job, 'workspace', parsed.workspace);
        noteCustomWorkspaceSync();
        break;
      }
      case 'persona': {
        const { listPersonas } = await import('../persona/persona-service.js');
        const personas = listPersonas();
        const current = job.persona;
        const choice = await select({
          message:
            personas.length > 0
              ? 'Persona (the job runs under its compiled policy instead of one compiled from the task constitution)'
              : 'Persona (none exists yet; create one with: ironcurtain persona create <name>)',
          options: [
            { value: NO_PERSONA, label: 'None — compile a policy from the task constitution' },
            ...personas.map((p) => ({ value: p.name, label: p.name, hint: personaHint(p) })),
          ],
          initialValue: current !== undefined && personas.some((p) => p.name === current) ? current : NO_PERSONA,
        });
        if (isCancel(choice)) {
          cancel('Cancelled.');
          process.exit(0);
        }
        if (choice === NO_PERSONA) {
          job = withOptionalField(job, 'persona', undefined);
          break;
        }
        const problem = findPersonaProblem(choice);
        if (problem !== undefined) {
          log.error(`Persona not changed: ${toDisplayText(problem)}`);
          break;
        }
        job = withOptionalField(job, 'persona', choice);
        break;
      }
      case 'budget': {
        const overrides: { -readonly [K in keyof JobBudgetOverrides]?: JobBudgetOverrides[K] } = {};
        let refused = false;
        for (const field of BUDGET_FIELDS) {
          const inp = await text({
            message: budgetPromptMessage(field, job.persona !== undefined),
            initialValue: budgetInputText(job.budgetOverrides?.[field.key]),
            validate: (v) => {
              const parsed = parseBudgetInput(field, v);
              return parsed.ok ? undefined : parsed.message;
            },
          });
          if (isCancel(inp)) {
            cancel('Cancelled.');
            process.exit(0);
          }
          const parsed = parseBudgetInput(field, inp);
          if (!parsed.ok) {
            log.error(`Budget overrides not changed: ${parsed.message}`);
            refused = true;
            break;
          }
          if (parsed.value !== undefined) overrides[field.key] = parsed.value;
        }
        if (!refused) {
          job = withOptionalField(job, 'budgetOverrides', Object.keys(overrides).length > 0 ? overrides : undefined);
        }
        break;
      }
    }
  }

  return job;
}

/**
 * "job.json is invalid" for an invalid job, with how to recover. The reason
 * can quote the file, so it is escaped.
 */
function invalidJobMessage(jobId: string, reason: string): string {
  return (
    `Job "${jobId}" cannot be used: its job.json is invalid (${toDisplayText(reason)}). ` +
    `Fix the file, or remove the job with: ironcurtain daemon remove-job ${jobId}`
  );
}

/**
 * Loads a job by ID string, exiting with an error if it does not exist or
 * its job.json is invalid (saying which).
 */
function loadJobOrExit(jobIdStr: string): JobDefinition {
  const jobId = createJobId(jobIdStr);
  const result = readJob(jobId);
  if (result.kind === 'missing') {
    console.error(`Job not found: ${jobIdStr}`);
    process.exit(1);
  }
  if (result.kind === 'invalid') {
    console.error(invalidJobMessage(jobId, result.error.reason));
    process.exit(1);
  }
  return result.job;
}

/** Exits with the message of a job-store error (not found, invalid) a command cannot recover from. */
function exitOnJobStoreError(err: unknown): never {
  if (isInvalidJobError(err)) {
    console.error(invalidJobMessage(err.jobId, err.reason));
  } else if (isJobNotFoundError(err)) {
    console.error(err.message);
  } else {
    throw err;
  }
  process.exit(1);
}

/** "next: in 3h", or a marker for a schedule that never fires or does not parse. */
function nextRunLabel(schedule: string): string {
  try {
    const nextRun = getNextFireTime(parseCronExpression(schedule), new Date());
    return nextRun ? `next: ${formatRelativeTime(nextRun)}` : chalk.red('never runs');
  } catch {
    return chalk.red('invalid schedule');
  }
}

function formatRunOutcome(outcome: RunOutcome, verbose = true): string {
  if (outcome.kind === 'success') return chalk.green('success');
  if (outcome.kind === 'budget_exhausted') {
    return verbose
      ? chalk.yellow(`budget exhausted: ${toDisplayText(outcome.dimension)}`)
      : chalk.yellow('budget exhausted');
  }
  // Error messages can carry agent- or remote-influenced text (git, model,
  // tool errors). The phase is escaped too: run records are read back unvalidated.
  const label = outcome.phase === undefined ? 'error' : `error (${toDisplayText(outcome.phase)})`;
  return verbose ? chalk.red(`${label}: ${toDisplayText(outcome.message)}`) : chalk.red(label);
}

/** The first non-empty line of an agent-written run summary, escaped and cut to `maxLength`. */
function summaryLine(summary: string, maxLength: number): string {
  const firstLine = summary.split('\n').find((line) => line.trim()) ?? '';
  return toDisplayText(firstLine, { maxLength });
}

/**
 * The notices of a run's session (`RunRecord.notices`: a stale compiled
 * policy, setuid or root-owned files the agent left in its host mounts, ...)
 * as display lines, each indented by `indent`. Nobody watched the run, so
 * this is where the user reads them. Read back from disk, they are made
 * display-safe again.
 */
function runNoticeLines(notices: readonly string[] | undefined, indent: string): string[] {
  return (notices ?? []).flatMap((notice) =>
    toDisplayText(notice, { multiline: true, maxLength: MAX_RUN_NOTICE_CHARS })
      .split('\n')
      .map((line) => `${indent}${line}`),
  );
}

/**
 * Clones a git repo into the job's workspace (its custom one, or the
 * default), through the job's daemon-owned mirror, with interactive retry on
 * failure. A custom workspace is synced as the daemon syncs it before every
 * run (not managed: it must be empty the first time, and is never created).
 * Returns the final URI cloned, or undefined if the user skipped.
 */
async function cloneWithRetry(
  job: Pick<JobDefinition, 'id' | 'workspace'>,
  uri: string,
  workspace: string,
): Promise<string | undefined> {
  const { text, isCancel, log } = await import('@clack/prompts');
  let currentUri = uri;
  for (;;) {
    console.error('Cloning repository (this can take a few minutes for a large repository)...');
    const result = await syncGitRepo({
      uri: currentUri,
      workspaceDir: workspace,
      mirrorDir: getJobRepoMirrorDir(job.id),
      managedWorkspace: job.workspace === undefined,
    });
    if (result.ok) return currentUri;
    log.error(
      `Git clone ${result.kind === 'sync_timeout' ? 'timed out' : 'failed'}: ${toDisplayText(result.message, { multiline: true })}`,
    );
    const retryInput = await text({
      message: 'Enter a corrected repository URI, or leave empty to skip cloning',
      placeholder: currentUri,
    });
    if (isCancel(retryInput) || !retryInput) return undefined;
    currentUri = retryInput;
  }
}

/**
 * Compiles a job's task policy into its `generated/` directory, against the
 * job's run workspace (see compileTaskPolicy), and resolves with the policy
 * written (its `failedServers` are reported). Injectable for tests.
 */
export type CompileJobPolicy = (job: TaskPolicyJob) => Promise<Pick<CompiledPolicyFile, 'failedServers'>>;

/**
 * What {@link saveNewJobWithPolicy} did: saved the job with its chosen
 * `enabled` state (`ok`), or saved it disabled because it cannot run
 * (`missing` / `stale`, as {@link checkJobPolicy}) or because its policy was
 * written without some servers (`partial`: they failed to compile and have
 * no rules).
 */
export type NewJobPolicyResult =
  JobPolicyCheck | { readonly ok: false; readonly problem: 'partial'; readonly failedServers: readonly string[] };

/**
 * Persists a newly created job so that it can never be scheduled without the
 * policy it runs under: one compiled from its constitution, or, for a job
 * with a persona, the persona's compiled policy.
 *
 * The job is saved DISABLED first (so the definition the user just entered
 * survives a failed compile), its task policy is compiled, the job is
 * checked as the daemon checks it before every run (checkJobCanRun: the
 * policy, and a persona job's agent model and resource limits), and only
 * then is the job saved with its chosen `enabled` state. A compile that
 * fails, or that is interrupted (Ctrl-C, a crash), leaves the job saved but
 * disabled, never an enabled job without a policy. A compile that wrote the
 * policy without some servers (they failed and have no rules, so the job's
 * calls to their tools would be denied) leaves it disabled too: `enable-job`
 * runs it under that policy, after `recompile-job` if the failure was
 * transient. A persona job compiles nothing: its own task policy would never
 * be used, and the persona's policy is compiled with `ironcurtain persona
 * compile`.
 */
export async function saveNewJobWithPolicy(
  job: JobDefinition,
  compile: CompileJobPolicy = compileTaskPolicy,
): Promise<NewJobPolicyResult> {
  await saveJob({ ...job, enabled: false });
  let failedServers: readonly string[] = [];
  if (job.persona === undefined) {
    try {
      failedServers = failedServerNames(await compile(job));
    } catch (err) {
      return { ok: false, problem: 'missing', message: err instanceof Error ? err.message : String(err) };
    }
  }
  const check = checkJobCanRun(job);
  if (!check.ok) return check;
  if (failedServers.length > 0) return { ok: false, problem: 'partial', failedServers };
  await saveJob(job);
  return check;
}

/** Creates a new scheduled job interactively. */
export async function runAddJobWizard(): Promise<void> {
  const { intro, outro } = await import('@clack/prompts');
  intro('Add a new scheduled job');

  let job = await runJobReviewLoop(generateDefaultJob(), true);

  // A custom workspace is the canonical path the review loop validated; it
  // already exists. Only the default workspace is created here.
  const workspace = job.workspace ?? getJobWorkspaceDir(job.id);
  if (job.workspace === undefined) mkdirSync(workspace, { recursive: true });

  if (job.gitRepo) {
    const finalUri = await cloneWithRetry(job, job.gitRepo, workspace);
    job = { ...job, gitRepo: finalUri };
  }

  console.error('');
  const persona = job.persona;
  console.error(
    persona === undefined
      ? 'Compiling task policy...'
      : `Checking persona "${toDisplayText(persona)}" (the job runs under its policy)...`,
  );
  const result = await saveNewJobWithPolicy(job);
  if (!result.ok && result.problem === 'partial') {
    // Saved disabled, like a failed compile (and not sent to the daemon): the
    // policy is in place, but without those servers' tools.
    console.error(chalk.yellow(describeFailedServers(result.failedServers)));
    console.error(
      chalk.yellow(
        `Job "${job.id}" was saved but is disabled. Compile it again with: ` +
          `ironcurtain daemon recompile-job ${job.id}, then run: ironcurtain daemon enable-job ${job.id} ` +
          '(enable-job alone runs it under the policy as it is).',
      ),
    );
    process.exit(PARTIAL_COMPILE_EXIT_CODE);
  }
  if (!result.ok) {
    const reason = toDisplayText(result.message, { multiline: true });
    // Saved disabled, so a running daemon does not schedule it either: there
    // is no policy to run it under. recompile-job compiles it (and reloads it
    // in a running daemon); enable-job then schedules it. A persona job needs
    // the persona fixed instead (its policy compiled, or its agent model or
    // limits corrected: the message names the command).
    if (persona === undefined) {
      console.error(chalk.red(`Policy compilation failed: ${reason}`));
      console.error(
        chalk.yellow(
          `Job "${job.id}" was saved but is disabled. Fix the issue, then run: ` +
            `ironcurtain daemon recompile-job ${job.id} and ironcurtain daemon enable-job ${job.id}`,
        ),
      );
    } else {
      console.error(chalk.red(`Persona "${toDisplayText(persona)}" cannot run the job: ${reason}`));
      console.error(
        chalk.yellow(
          `Job "${job.id}" was saved but is disabled. Fix the persona, then run: ` +
            `ironcurtain daemon enable-job ${job.id}`,
        ),
      );
    }
    process.exit(1);
  }

  // The review loop only accepts schedules that parse, and every one that
  // parses fires within the search horizon.
  const nextRun = getNextFireTime(parseCronExpression(job.schedule), new Date())?.toLocaleString() ?? 'never';

  // A running daemon loads jobs only at startup: without this, a job added
  // while it runs would never fire until the next restart.
  const reload = await reloadJobInDaemon(job.id);
  switch (reload.kind) {
    case 'reloaded':
      outro(`Job "${job.id}" created and scheduled by the running daemon. Next run: ${nextRun}`);
      break;
    case 'no-daemon':
      outro(
        `Job "${job.id}" created. Next run: ${nextRun} once the daemon is running (start it with: ironcurtain daemon).`,
      );
      break;
    case 'refused':
      console.error(chalk.yellow(`The running daemon did not schedule the job: ${toDisplayText(reload.error)}`));
      outro(
        `Job "${job.id}" saved but NOT scheduled. Fix the issue, then run: ironcurtain daemon enable-job ${job.id}`,
      );
      process.exitCode = 1;
      break;
    case 'unconfirmed':
      console.error(chalk.yellow(`Could not confirm that the running daemon scheduled the job: ${reload.reason}.`));
      outro(
        `Job "${job.id}" saved. Check it with: ironcurtain daemon list-jobs (NOT SCHEDULED means it will not ` +
          `fire until you run: ironcurtain daemon enable-job ${job.id})`,
      );
      process.exitCode = 1;
      break;
  }
}

/** Outcome of asking a running daemon to reload a job from disk. */
type DaemonReload =
  | { readonly kind: 'reloaded' }
  /** No daemon is running; it reads the job from disk when it starts. */
  | { readonly kind: 'no-daemon' }
  /** The daemon answered with an error. */
  | { readonly kind: 'refused'; readonly error: string }
  /** A daemon took the request but no valid answer came back: it may or may not have reloaded the job. */
  | { readonly kind: 'unconfirmed'; readonly reason: string };

/**
 * Asks a running daemon to reload a job from disk (`reload-job`), which
 * (re)schedules it if enabled — also when the daemon has never seen it. Single
 * round-trip, no pre-check (sendControlRequest never rejects).
 */
async function reloadJobInDaemon(jobId: JobId): Promise<DaemonReload> {
  const { sendControlRequest } = await import('../daemon/control-socket.js');
  const result = await sendControlRequest({ command: 'reload-job', jobId });
  switch (result.kind) {
    case 'unreachable':
      return { kind: 'no-daemon' };
    case 'failed':
      return { kind: 'unconfirmed', reason: result.reason };
    case 'response':
      return result.response.ok ? { kind: 'reloaded' } : { kind: 'refused', error: result.response.error };
  }
}

/** An error's message, safe to print on a terminal. */
function displayMessage(err: unknown): string {
  return toDisplayText(err instanceof Error ? err.message : String(err), { multiline: true });
}

/**
 * Why an edited job's task policy must be recompiled, or undefined when its
 * current policy can be kept. The policy is compiled from the constitution
 * against the job's workspace (see compileTaskPolicy), so a change to either
 * recompiles it (a workspace change also revokes the old policy first, see
 * runEditJobWizard). A job with a persona runs under the persona's policy,
 * which checkJobCanRun checks after the save as the daemon does before every
 * run: its own task policy would never be used, so it is not compiled.
 */
function jobRecompileReason(job: JobDefinition, original: JobDefinition): string | undefined {
  if (job.persona !== undefined) return undefined;
  if (job.taskConstitution !== original.taskConstitution) return 'Constitution changed';
  if (job.workspace !== original.workspace) return 'Workspace changed';
  const state = getJobPolicyState(job);
  if (state.kind === 'missing') return 'No compiled policy';
  if (state.kind === 'stale') return 'Compiled policy is stale';
  return undefined;
}

/**
 * Edits an existing job interactively. Recompiles the task policy of a job
 * without a persona when its constitution or workspace changed or the
 * current policy is missing or stale. A changed workspace first revokes the
 * job's own policy (persona or not), so no policy compiled for the old
 * workspace runs the job: not after a failed or interrupted recompile, and
 * not once a persona is removed later. Exit status 1 when the recompile
 * failed, 2 when it wrote the policy without some servers (they failed to
 * compile and have no rules).
 */
export async function runEditJobWizard(jobIdStr: string): Promise<void> {
  const { intro, outro } = await import('@clack/prompts');
  const existing = loadJobOrExit(jobIdStr);

  intro(`Edit job "${existing.name || existing.id}"`);

  const edited = await runJobReviewLoop(existing, false);

  // Save first so changes aren't lost if recompilation fails. A failed
  // compile cannot pair the new constitution with the old policy: the daemon
  // refuses to run a job whose policy does not match its saved constitution.
  // Only the fields edited here are applied, onto job.json as it is now: a
  // change made meanwhile (a disable-job while the editor was open) stays.
  let job: JobDefinition;
  try {
    job = await saveEditedJob(existing, edited);
  } catch (err) {
    console.error(chalk.red('Your changes were not saved.'));
    exitOnJobStoreError(err);
  }

  let compileFailed = false;
  // The job's own policy was compiled against the workspace it had, but the
  // run-time check compares only the constitution hash, which still matches:
  // left in place, a recompile that fails or is interrupted would leave the
  // job running in the new workspace under it. Revoked first, the job has no
  // policy (and is refused) until a recompile succeeds. Also for a persona
  // job, whose own policy is unused until its persona is removed.
  if (job.workspace !== existing.workspace) {
    try {
      revokeJobPolicy(job.id);
    } catch (err) {
      compileFailed = true;
      console.error(
        chalk.red(`The policy compiled for the old workspace could not be revoked: ${displayMessage(err)}`),
      );
    }
  }
  // A policy written without some servers still runs the job (their tools
  // are denied): reported, and the command exits 2.
  let failedServers: readonly string[] = [];
  const recompileReason = jobRecompileReason(job, existing);
  if (recompileReason) {
    console.error(`${recompileReason} — recompiling policy...`);
    try {
      failedServers = failedServerNames(await compileTaskPolicy(job));
    } catch (err) {
      compileFailed = true;
      console.error(chalk.red(`Policy compilation failed: ${displayMessage(err)}`));
    }
    if (failedServers.length > 0) console.error(chalk.yellow(describeFailedServers(failedServers)));
  }

  // Notify a running daemon even after a failed compile, so it schedules the
  // definition now on disk (and refuses to run it until it has a matching
  // policy) rather than an older in-memory snapshot.
  const reload = await reloadJobInDaemon(job.id);
  if (reload.kind === 'reloaded') {
    console.error('Daemon notified — job reloaded.');
  } else if (reload.kind === 'refused') {
    console.error(chalk.yellow(`Daemon reload failed: ${toDisplayText(reload.error)}`));
  } else if (reload.kind === 'unconfirmed') {
    console.error(
      chalk.yellow(
        `Could not confirm the daemon reloaded the job (${reload.reason}). ` +
          'Restart the daemon if the change does not take effect.',
      ),
    );
  }
  // 'no-daemon': no daemon is running; it picks the change up when it starts.

  const check = checkJobCanRun(job);
  if (!check.ok) {
    console.error(chalk.yellow(`Job "${job.id}" was saved, but it will not run: ${toDisplayText(check.message)}`));
  }
  if (compileFailed) {
    process.exit(1);
  }
  if (failedServers.length > 0) process.exitCode = PARTIAL_COMPILE_EXIT_CODE;

  // A job left disabled by an interrupted or failed add-job stays disabled.
  outro(
    job.enabled
      ? `Job "${job.id}" updated.`
      : `Job "${job.id}" updated. It is disabled; enable it with: ironcurtain daemon enable-job ${job.id}`,
  );
}

/** Shared display data for a single job entry. */
interface JobDisplayEntry {
  job: JobDefinition;
  nextRunStr: string;
  lastRun: RunRecord | undefined;
  /** Runs in a row that ended in an error (undefined when an older daemon did not report it). */
  consecutiveFailures: number | undefined;
  statusLabels: string[];
}

/**
 * Prints the job directories whose job.json is invalid: `INVALID: <reason>`
 * (escaped: the reason can quote the file). They are not scheduled.
 */
function printInvalidJobEntries(invalid: readonly InvalidJobEntry[]): void {
  for (const entry of invalid) {
    console.error(`  ${chalk.bold(entry.jobId.padEnd(20))} ${chalk.red(`INVALID: ${toDisplayText(entry.reason)}`)}`);
    console.error(`  ${' '.repeat(20)}${toDisplayText(entry.path)} -- not scheduled; fix it, or remove the job`);
  }
}

/** Formats and prints a single job entry. */
function printJobEntry(entry: JobDisplayEntry): void {
  const statusLabel = entry.statusLabels.length > 0 ? ` ${entry.statusLabels.join(' ')}` : '';
  const cronDesc = describeCronExpression(entry.job.schedule);

  let lastRunStr = '';
  if (entry.lastRun) {
    const lastRunDate = new Date(entry.lastRun.startedAt);
    const lastRunRelative = formatRelativeTime(lastRunDate);
    lastRunStr = `Last run: ${lastRunRelative} -- ${formatRunOutcome(entry.lastRun.outcome)}`;
    if (entry.consecutiveFailures !== undefined && entry.consecutiveFailures > 0) {
      lastRunStr += chalk.red(` [${formatFailureStreak(entry.consecutiveFailures)}]`);
    }
    if (entry.lastRun.summary) {
      lastRunStr += `\n${' '.repeat(20)}${summaryLine(entry.lastRun.summary, 60)}`;
    }
  }

  console.error(
    `  ${chalk.bold(entry.job.id.padEnd(20))} ${toDisplayText(entry.job.name).padEnd(30)} ${cronDesc.padEnd(25)} ${entry.nextRunStr}${statusLabel}`,
  );
  if (lastRunStr) {
    console.error(`  ${' '.repeat(20)}${lastRunStr}`);
  }
}

export function runListJobs(): void {
  const { jobs, invalid } = scanJobs();

  if (jobs.length === 0 && invalid.length === 0) {
    console.error('No jobs configured. Use "ironcurtain daemon add-job" to create one.');
    return;
  }

  console.error('Jobs:');
  for (const job of jobs) {
    const nextRunStr = job.enabled ? nextRunLabel(job.schedule) : '';

    const statusLabels = job.enabled ? [] : [chalk.yellow('DISABLED')];
    const policyLabel = policyStatusLabel(job);
    if (policyLabel) statusLabels.push(policyLabel);
    printJobEntry({
      job,
      nextRunStr,
      lastRun: loadLatestRun(job.id),
      consecutiveFailures: countConsecutiveFailures(job.id),
      statusLabels,
    });
  }
  printInvalidJobEntries(invalid);
}

/**
 * List label for a job that the daemon will refuse to run because its
 * policy is missing or stale, or undefined when the policy is usable.
 */
function policyStatusLabel(job: JobDefinition): string | undefined {
  const check = checkJobPolicy(job);
  if (check.ok) return undefined;
  return chalk.red(check.problem === 'stale' ? 'POLICY STALE' : 'NO POLICY');
}

/** Daemon job list entry received over the control socket. */
export interface DaemonJobListEntry {
  job: JobDefinition;
  nextRun: string | null;
  lastRun: RunRecord | undefined;
  isRunning: boolean;
  /** Waiting for a run slot (`cron.maxConcurrentRuns`); absent from older daemons. */
  isQueued?: boolean;
  /** Absent in replies from daemons that predate failure streaks. */
  consecutiveFailures?: number;
}

/**
 * Formats job list data received from the daemon control socket.
 * Used when list-jobs is forwarded to a running daemon, which provides
 * live running status and next-run times from the scheduler. Job
 * directories whose job.json is invalid (which the daemon does not list)
 * are read from disk and printed as `INVALID`, unless `invalid` is given.
 */
export function formatDaemonJobList(
  jobs: DaemonJobListEntry[],
  invalid: readonly InvalidJobEntry[] = scanJobs().invalid,
): void {
  if (jobs.length === 0 && invalid.length === 0) {
    console.error('No jobs configured. Use "ironcurtain daemon add-job" to create one.');
    return;
  }

  console.error('Jobs (from running daemon):');
  for (const entry of jobs) {
    const statusLabels: string[] = [];
    if (!entry.job.enabled) statusLabels.push(chalk.yellow('DISABLED'));
    // Enabled but absent from the daemon's scheduler: its schedule failed to
    // load at startup, or it was saved while the daemon ran and never reloaded
    // (a reload the daemon refused or never answered, or a job.json written
    // by hand). It will not fire, which a blank next-run column used to hide.
    if (entry.job.enabled && !entry.nextRun) statusLabels.push(chalk.red('NOT SCHEDULED'));
    if (entry.isRunning) statusLabels.push(chalk.cyan('RUNNING'));
    if (entry.isQueued === true) statusLabels.push(chalk.cyan('QUEUED'));
    const policyLabel = policyStatusLabel(entry.job);
    if (policyLabel) statusLabels.push(policyLabel);

    printJobEntry({
      job: entry.job,
      nextRunStr: entry.nextRun ? `next: ${formatRelativeTime(new Date(entry.nextRun))}` : '',
      lastRun: entry.lastRun,
      consecutiveFailures: entry.consecutiveFailures,
      statusLabels,
    });
  }
  printInvalidJobEntries(invalid);
}

/**
 * Manually triggers a job run in this process (no daemon is running), in
 * `mode`: the session mode `ironcurtain daemon` already resolved and printed,
 * `--agent` included, never resolved a second time here. That command also
 * printed preflight's host-model warnings, which a headless run shows
 * nowhere else.
 */
export async function runJobCommand(jobIdStr: string, mode: SessionMode): Promise<void> {
  const job = loadJobOrExit(jobIdStr);

  console.error(`Running job "${toDisplayText(job.name)}"...`);
  const { IronCurtainDaemon } = await import('../daemon/ironcurtain-daemon.js');
  const daemon = new IronCurtainDaemon({ mode, noSignal: true });
  const record = await daemon.runJobNow(job.id);

  console.error(`  Outcome: ${formatRunOutcome(record.outcome)}`);
  console.error(`  Duration: ${record.budget.elapsedSeconds.toFixed(0)}s`);
  console.error(`  Cost: ${formatCostUsd(record.budget.estimatedCostUsd, record.budget.costSource)}`);
  if (record.summary) {
    console.error(`  Summary: ${summaryLine(record.summary, 100)}`);
  }
  // What the session reported meanwhile (it had no terminal of its own).
  const notices = runNoticeLines(record.notices, '    ');
  if (notices.length > 0) {
    console.error('  Notices:');
    for (const line of notices) console.error(line);
  }

  // Clean up daemon resources (scheduler, logger file handles) and exit.
  // Without this, lingering handles keep the Node.js event loop alive.
  await daemon.shutdown();
  process.exit(record.outcome.kind === 'success' ? 0 : 1);
}

/**
 * The id of a job that exists, valid or not (an invalid job.json can still be
 * removed: that is how it is cleaned up), exiting with "Job not found"
 * otherwise. Returns the definition too when it is valid.
 */
function existingJobOrExit(jobIdStr: string): { readonly jobId: JobId; readonly job: JobDefinition | undefined } {
  const jobId = createJobId(jobIdStr);
  const result = readJob(jobId);
  if (result.kind === 'missing') {
    console.error(`Job not found: ${jobIdStr}`);
    process.exit(1);
  }
  return { jobId, job: result.kind === 'ok' ? result.job : undefined };
}

/**
 * Asks the user to confirm removing a job: deletion takes its workspace, run
 * history and policy and cannot be undone. Exits with "Job not found" when the
 * job does not exist; a job whose job.json is invalid can be removed. Returns
 * false (after printing "Cancelled.") when the user declines or cancels.
 *
 * `daemon remove-job` calls this before anything is deleted, whichever process
 * then deletes the job: the running daemon or {@link runRemoveJob}.
 */
export async function confirmJobRemoval(jobIdStr: string): Promise<boolean> {
  const { jobId, job } = existingJobOrExit(jobIdStr);
  const { confirm, isCancel } = await import('@clack/prompts');
  const displayName = job ? toDisplayText(job.name || job.id) : `${jobId} (invalid job.json)`;
  const shouldDelete = await confirm({
    message: `Remove "${displayName}"? This deletes the workspace, run history, and policy.`,
  });
  if (isCancel(shouldDelete) || !shouldDelete) {
    console.error('Cancelled.');
    return false;
  }
  return true;
}

/** Removes a job (also one whose job.json is invalid). Prompts for confirmation unless force is true. */
export async function runRemoveJob(jobIdStr: string, force = false): Promise<void> {
  const { jobId } = existingJobOrExit(jobIdStr);

  if (!force && !(await confirmJobRemoval(jobIdStr))) return;

  deleteJob(jobId);
  console.error(`Job "${jobIdStr}" removed.`);
}

/**
 * Sets a job's enabled state with a locked load-modify-save, so a change
 * made meanwhile by another command is not overwritten.
 */
async function runSetJobEnabled(jobIdStr: string, enabled: boolean): Promise<void> {
  const jobId = createJobId(jobIdStr);
  try {
    await updateJob(jobId, (job) => ({ ...job, enabled }));
  } catch (err) {
    exitOnJobStoreError(err);
  }
  console.error(`Job "${jobIdStr}" ${enabled ? 'enabled' : 'disabled'}.`);
}

/** Disables a job. */
export const runDisableJob = (jobIdStr: string): Promise<void> => runSetJobEnabled(jobIdStr, false);

/** Enables a job. */
export const runEnableJob = (jobIdStr: string): Promise<void> => runSetJobEnabled(jobIdStr, true);

/**
 * Re-runs policy compilation for a job (`recompile-job` when no daemon is
 * running). Exit status 2 when the policy was written without some servers:
 * they failed to compile and have no rules, so the job's calls to their
 * tools are denied until a compile succeeds.
 */
export async function runRecompileJob(jobIdStr: string): Promise<void> {
  const job = loadJobOrExit(jobIdStr);

  console.error(`Recompiling policy for job "${jobIdStr}"...`);
  const failedServers = failedServerNames(await compileTaskPolicy(job));
  const check = checkJobPolicy(job);
  if (!check.ok) {
    console.error(chalk.red(`Job "${jobIdStr}" still cannot run: ${toDisplayText(check.message)}`));
    process.exit(1);
  }
  let done = 'Done.';
  if (failedServers.length > 0) {
    console.error(chalk.yellow(describeFailedServers(failedServers)));
    process.exitCode = PARTIAL_COMPILE_EXIT_CODE;
    done = 'Done, with failed servers.';
  }
  console.error(
    job.enabled ? done : `${done} The job is disabled; enable it with: ironcurtain daemon enable-job ${job.id}`,
  );
}

/** Shows recent run logs for a job. */
export function runShowLogs(jobIdStr: string, limit: number): void {
  const job = loadJobOrExit(jobIdStr);

  const runs = loadRecentRuns(job.id, limit);
  if (runs.length === 0) {
    console.error(`No run history for job "${jobIdStr}".`);
    return;
  }

  console.error(`Recent runs for "${toDisplayText(job.name)}" (last ${runs.length}):`);
  console.error('');
  for (const run of runs) {
    const runDate = new Date(run.startedAt);
    const runRelative = formatRelativeTime(runDate);
    console.error(
      `  ${runRelative}  ${formatRunOutcome(run.outcome, false)}  ${run.budget.elapsedSeconds.toFixed(0)}s  ${formatCostUsd(run.budget.estimatedCostUsd, run.budget.costSource)}`,
    );
    if (run.summary) {
      console.error(`    ${summaryLine(run.summary, 80)}`);
    }
    // One line per notice of the run (a stale policy, host-mount findings, ...).
    for (const notice of run.notices ?? []) {
      console.error(`    notice: ${summaryLine(notice, 100)}`);
    }
  }
}

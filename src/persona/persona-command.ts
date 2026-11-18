/**
 * CLI entry point for `ironcurtain persona` subcommands.
 *
 * Subcommands: create, list, compile, edit, set, clone, rename, delete, show,
 * trash (list, restore, purge).
 *
 * Follows the same patterns as job-commands.ts for interactive flows
 * and cli-help.ts for help formatting.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { checkHelp, parseArgsStrict, printHelp, type CommandSpec } from '../cli-help.js';
import { loadConfig } from '../config/index.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { openEditor, openEditorForMultiline } from '../utils/editor.js';
import { createPersonaName, type PersonaDefinition, type PersonaName, type PersonaResourceBudget } from './types.js';
import {
  getPersonaDir,
  getPersonaConstitutionPath,
  getPersonaGeneratedDir,
  getPersonaPolicyState,
  getPersonaWorkspaceDir,
  loadPersona,
} from './resolve.js';
import {
  clonePersona,
  createPersona,
  deletePersona,
  getPersonaTrashRetentionDays,
  listInvalidPersonas,
  listPersonas,
  listPersonaTrashEntries,
  purgePersonaTrash,
  renamePersona,
  restorePersona,
  REVOKED_POLICY_FILENAME,
  setPersonaBroadPolicyOptIn,
  setPersonaConstitution,
  setPersonaMemory,
  setPersonaOverrides,
  selectPersonaTrashForPurge,
  sweepPersonaTrash,
  validatePersonaServers,
  type PersonaTrashPurgeSelection,
} from './persona-service.js';
import type { PersonaTrashEntryDto } from '../web-ui/web-ui-types.js';
import {
  acquirePersonaCompileLock,
  PersonaCompileError,
  runPersonaCompile,
  type PersonaCompileLock,
  type PersonaCompileOutcome,
} from './persona-compile-service.js';
import { BroadPolicyRejectedError, describeBroadAccess, hasBroadAccess } from './broad-policy-validator.js';
import { inspectCompiledPolicyBreadth } from './policy-breadth-check.js';
import { personaApprovalScope } from '../audit/approval-history.js';
import {
  isPersonaOverridesError,
  parsePersonaResourceBudget,
  readPersonaOverrides,
  type PersonaOverrides,
} from './persona-overrides.js';
import { isPlainObject } from '../utils/is-plain-object.js';

// ---------------------------------------------------------------------------
// Help specs
// ---------------------------------------------------------------------------

/** `persona compile` exit status when the policy was written but some servers failed (as `compile-policy`). */
const PARTIAL_COMPILE_EXIT_CODE = 2;

const personaSpec: CommandSpec = {
  name: 'ironcurtain persona',
  description: 'Manage personas (named policy profiles)',
  usage: ['ironcurtain persona <action> [options]'],
  subcommands: [
    { name: 'create <name>', description: 'Create a new persona interactively' },
    { name: 'list', description: 'List all personas, and persona directories that cannot be loaded' },
    {
      name: 'compile <name> [--allow-broad]',
      description:
        "Compile a persona's constitution into policy. A result with broad access (wildcard domains or " +
        'lists, out-of-workspace paths, unconstrained allow rules) is refused and not written unless the ' +
        'persona opted in; --allow-broad sets that opt-in. Exit status 2: written, but some servers failed',
    },
    { name: 'edit <name>', description: "Edit a persona's constitution, memory or broad-policy opt-in" },
    { name: 'set <name> [options]', description: "Set a persona's agent model and resource limits" },
    {
      name: 'clone <source> <name> [--description <text>]',
      description:
        "Create a persona from another one's constitution, description, servers, memory setting, agent model, " +
        'resource limits and skills. Its compiled policy, workspace, memories and broad-policy opt-in are not ' +
        'copied: compile the clone',
    },
    {
      name: 'rename <name> <new-name>',
      description:
        'Rename a persona; its workspace, memories and skills move with it. Its compiled policy is moved ' +
        'aside (it names the old workspace path): compile it again',
    },
    { name: 'delete <name>', description: 'Delete a persona permanently (with confirmation)' },
    { name: 'show <name>', description: 'Show persona metadata and constitution' },
    {
      name: 'trash list',
      description: 'List soft-deleted personas (web UI deletes, and personas a forced restore replaced)',
    },
    {
      name: 'trash restore <entry|name> [--as <name>] [--force]',
      description:
        'Restore a soft-deleted persona (a name restores its newest entry). A persona with the same name is ' +
        'never overwritten: --force moves it to the trash first, --as restores under another name',
    },
    {
      name: 'trash purge <entry|name>... | --expired | --all [--yes]',
      description:
        'Permanently delete trash entries, workspace and memory included (a name: all its entries). ' +
        '--expired: the entries older than personas.trashRetentionDays (default 30)',
    },
  ],
  examples: [
    'ironcurtain persona create exec-assistant',
    'ironcurtain persona list',
    'ironcurtain persona compile coder',
    'ironcurtain persona compile researcher --allow-broad',
    'ironcurtain persona edit exec-assistant',
    'ironcurtain persona set triage --model anthropic:claude-haiku-4-5 --max-cost 1',
    'ironcurtain persona clone coder coder-strict',
    'ironcurtain persona rename helper exec-assistant',
    'ironcurtain persona show coder',
    'ironcurtain persona delete old-persona',
    'ironcurtain persona trash restore old-persona',
    'ironcurtain persona trash purge --expired',
  ],
};

/**
 * `persona set` limit flags and the resourceBudget field each one sets.
 * `integer` limits reject fractions, like config.json's own schema.
 */
const LIMIT_FLAGS = [
  { flag: 'max-tokens', field: 'maxTotalTokens', integer: true },
  { flag: 'max-steps', field: 'maxSteps', integer: true },
  { flag: 'max-session-seconds', field: 'maxSessionSeconds', integer: false },
  { flag: 'max-cost', field: 'maxEstimatedCostUsd', integer: false },
  { flag: 'warn-threshold', field: 'warnThresholdPercent', integer: false },
] as const satisfies readonly {
  flag: string;
  field: keyof PersonaResourceBudget;
  integer: boolean;
}[];

const personaSetSpec: CommandSpec = {
  name: 'ironcurtain persona set',
  description:
    "Set a persona's agent model and resource limits. They apply to the persona's sessions everywhere " +
    '(start, mux, Signal, web UI, cron jobs, workflow states) unless a higher layer sets its own: ' +
    "--model on the command line or a workflow's model for the model; a workflow's resourceBudget or " +
    "a cron job's budgetOverrides for each limit.",
  usage: ['ironcurtain persona set <name> [options]'],
  options: [
    { flag: 'model', description: 'Agent model, e.g. anthropic:claude-haiku-4-5', placeholder: '<id>' },
    { flag: 'clear-model', description: 'Remove the agent model (the global one applies)' },
    { flag: 'max-tokens', description: 'Token limit per session', placeholder: '<n|none|inherit>' },
    { flag: 'max-steps', description: 'Agent step limit per session', placeholder: '<n|none|inherit>' },
    {
      flag: 'max-session-seconds',
      description: 'Wall-clock limit per turn, in seconds',
      placeholder: '<n|none|inherit>',
    },
    { flag: 'max-cost', description: 'Estimated cost limit in USD', placeholder: '<usd|none|inherit>' },
    { flag: 'warn-threshold', description: 'Warn at this percentage of a limit (1-99)', placeholder: '<n|inherit>' },
    { flag: 'clear-limits', description: 'Remove all resource limits (every limit inherits)' },
  ],
  examples: [
    'ironcurtain persona set triage --model anthropic:claude-haiku-4-5',
    'ironcurtain persona set triage --max-cost 1 --max-steps 50',
    'ironcurtain persona set research --max-tokens none --max-cost 20',
    'ironcurtain persona set triage --clear-model --max-cost inherit',
  ],
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Brands a persona name and loads its definition, exiting with an error when
 * the name is invalid, the persona does not exist, or its persona.json cannot
 * be used (the loader's reasons are printed: for a copied persona directory,
 * that its persona.json names another persona).
 */
function loadPersonaOrExit(nameStr: string): { readonly name: PersonaName; readonly persona: PersonaDefinition } {
  try {
    const name = createPersonaName(nameStr);
    return { name, persona: loadPersona(name) };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    console.error(
      chalk.red(code === 'PERSONA_NOT_FOUND' ? `Persona not found: ${displayMessage(nameStr)}` : displayError(err)),
    );
    process.exit(1);
  }
}

/** Display-safe text of an error, keeping the line structure of multi-line messages. */
function displayError(err: unknown): string {
  return displayLines(err instanceof Error ? err.message : String(err));
}

/** Display-safe text that may span several lines (a loader's list of problems). */
function displayLines(text: string): string {
  return toDisplayText(text, { multiline: true, maxLength: 4000 });
}

/**
 * Runs a persona-service operation for a CLI command, printing its error
 * (display-safe) and exiting 1 when it throws.
 */
async function runOrExit<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    console.error(chalk.red(displayError(err)));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers for create & edit flows
// ---------------------------------------------------------------------------

/**
 * Generates a constitution via LLM, then presents accept/refine/discard.
 * Returns the final constitution text, or undefined if discarded/cancelled.
 */
async function generateAndReviewConstitution(
  description: string,
  workspacePath: string,
  servers: readonly string[] | undefined,
  p: typeof import('@clack/prompts'),
): Promise<string | undefined> {
  const genSpinner = p.spinner();
  genSpinner.start('Generating constitution...');
  try {
    const { generateConstitution } = await import('../cron/constitution-generator.js');
    const result = await generateConstitution({
      taskDescription: description,
      workspacePath,
      context: 'persona',
      onProgress: (msg) => genSpinner.message(toDisplayText(msg)),
    });
    genSpinner.stop('Constitution generated.');
    p.note(toDisplayText(result.constitution, { multiline: true }), 'Generated Constitution');
    if (result.reasoning) {
      p.log.info(toDisplayText(result.reasoning, { multiline: true }));
    }

    const action = await p.select({
      message: 'What would you like to do with the generated constitution?',
      options: [
        { value: 'accept' as const, label: 'Accept as-is' },
        { value: 'refine' as const, label: 'Customize interactively' },
        { value: 'discard' as const, label: 'Discard' },
      ],
    });
    if (p.isCancel(action) || action === 'discard') return undefined;

    if (action === 'refine') {
      const { runPersonaConstitutionCustomizer } = await import('./persona-customizer.js');
      return (await runPersonaConstitutionCustomizer(result.constitution, description, servers)) ?? undefined;
    }
    return result.constitution;
  } catch (err) {
    genSpinner.stop('Generation failed.');
    p.log.error(
      `Constitution generation failed: ${toDisplayText(err instanceof Error ? err.message : String(err), { multiline: true })}`,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Compiling (always through the shared compile path)
// ---------------------------------------------------------------------------

/** How one CLI compile attempt ended. */
type CliCompileResult =
  | { readonly kind: 'written'; readonly outcome: PersonaCompileOutcome }
  /** Refused by the broad-policy validator; nothing written. `access` lists what needed the opt-in. */
  | { readonly kind: 'too-broad'; readonly access: readonly string[] }
  | { readonly kind: 'in-progress'; readonly operationId?: string }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Compiles through `runPersonaCompile`, the path web-UI compiles take too:
 * the persona's compile lock (a daemon compile of the same persona refuses
 * this one, and vice versa), the broad-policy validator and the audit record.
 * The CLI is the local, trusted user, so dynamic lists may use live MCP.
 *
 * With `allowBroad` the persona's broad-policy opt-in is set first, under the
 * lock, so it changes only when this compile actually runs; `onOptIn` is told.
 */
async function compileFromCli(
  name: PersonaName,
  opts: { readonly allowBroad?: boolean; readonly onOptIn?: (message: string) => void } = {},
): Promise<CliCompileResult> {
  let lock: PersonaCompileLock | undefined;
  try {
    lock = acquirePersonaCompileLock(name, randomUUID());
    if (opts.allowBroad === true) {
      setPersonaBroadPolicyOptIn(name, true, 'cli');
      opts.onOptIn?.(`Broad policies are now allowed for persona "${name}".`);
    }
    return { kind: 'written', outcome: await runPersonaCompile(name, 'cli', { lock, allowMcpLists: true }) };
  } catch (err) {
    if (err instanceof BroadPolicyRejectedError) {
      return { kind: 'too-broad', access: err.data ? describeBroadAccess(err.data) : [err.message] };
    }
    if (err instanceof PersonaCompileError && err.code === 'COMPILE_IN_PROGRESS') {
      return { kind: 'in-progress', ...holderOf(err) };
    }
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
  } finally {
    lock?.release();
  }
}

/** The holder's operation id carried by a COMPILE_IN_PROGRESS error. */
function holderOf(err: PersonaCompileError): { operationId?: string } {
  const holder = (err.data as { operationId?: unknown } | undefined)?.operationId;
  return typeof holder === 'string' ? { operationId: holder } : {};
}

/** Display-safe text of a compile failure or other free-form message. */
function displayMessage(message: string): string {
  return toDisplayText(message, { maxLength: 2000 });
}

function tooBroadMessage(name: PersonaName): string {
  return (
    `The compiled policy for persona "${name}" grants broad access, and the persona has not opted in ` +
    'to broad policies, so it was not written:'
  );
}

function allowBroadHint(name: PersonaName): string {
  return (
    `To allow it, run: ironcurtain persona compile ${name} --allow-broad ` +
    "(sets the persona's broad-policy opt-in). Or narrow its constitution and compile again."
  );
}

function inProgressMessage(name: PersonaName, operationId: string | undefined): string {
  return (
    `A compile for persona "${name}" is already running` +
    (operationId ? ` (operation ${displayMessage(operationId)})` : '') +
    ", in this or another process (for example the daemon's web UI). Try again when it has finished."
  );
}

/** Warnings about a written policy: servers without rules, broad access allowed by the opt-in. */
function writtenWarnings(outcome: PersonaCompileOutcome): string[] {
  const warnings: string[] = [];
  const failed = outcome.policy.failedServers ?? [];
  if (failed.length > 0) {
    warnings.push(
      `${failed.length} server(s) failed to compile and have no rules, so their tools are denied until a ` +
        `compile succeeds: ${failed.map((f) => displayMessage(f.serverName)).join(', ')}.`,
    );
  }
  if (hasBroadAccess(outcome.findings)) {
    warnings.push(
      "This policy grants broad access, allowed by the persona's broad-policy opt-in: " +
        `${describeBroadAccess(outcome.findings).join('; ')}.`,
    );
  }
  return warnings;
}

/**
 * Runs policy compilation with a spinner (create and edit flows). A result
 * too broad for the persona is shown, and compiled again only if the user
 * explicitly allows broad policies for it (the per-server results are cached,
 * so the second run normally makes no model calls). Returns whether a policy
 * was written.
 */
async function compileWithSpinner(name: PersonaName, p: typeof import('@clack/prompts')): Promise<boolean> {
  let result = await compileWithOneSpinner(name, p);
  if (result.kind === 'too-broad') {
    p.log.warn([tooBroadMessage(name), ...result.access.map((a) => `  - ${a}`)].join('\n'));
    const allow = await p.confirm({
      message: `Allow broad policies for persona "${name}" and compile again?`,
      initialValue: false,
    });
    if (p.isCancel(allow) || !allow) {
      p.log.info(allowBroadHint(name));
      return false;
    }
    result = await compileWithOneSpinner(name, p, true);
  }

  switch (result.kind) {
    case 'written':
      for (const warning of writtenWarnings(result.outcome)) p.log.warn(warning);
      return true;
    case 'too-broad':
      // Only when the opt-in was revoked between the two runs.
      p.log.error([tooBroadMessage(name), ...result.access.map((a) => `  - ${a}`)].join('\n'));
      return false;
    case 'in-progress':
      p.log.error(inProgressMessage(name, result.operationId));
      return false;
    case 'failed':
      p.log.error(`Compilation failed: ${displayMessage(result.message)}`);
      return false;
  }
}

async function compileWithOneSpinner(
  name: PersonaName,
  p: typeof import('@clack/prompts'),
  allowBroad = false,
): Promise<CliCompileResult> {
  const compileSpinner = p.spinner();
  compileSpinner.start('Compiling policy...');
  const result = await compileFromCli(name, { allowBroad, onOptIn: (message) => compileSpinner.message(message) });
  const stopText: Record<CliCompileResult['kind'], string> = {
    written: 'Policy compiled.',
    'too-broad': 'Policy too broad: not written.',
    'in-progress': 'Another compile is running.',
    failed: 'Compilation failed.',
  };
  compileSpinner.stop(stopText[result.kind]);
  return result;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runCreate(nameStr: string, args: string[]): Promise<void> {
  const { values: createValues } = parseArgsStrict(
    {
      args,
      options: {
        description: { type: 'string' },
        servers: { type: 'string' },
        'no-generate': { type: 'boolean' },
      },
      allowPositionals: true,
    },
    'ironcurtain persona create',
  );

  const name = createPersonaName(nameStr);
  const personaDir = getPersonaDir(name);

  if (existsSync(personaDir)) {
    console.error(chalk.red(`Persona "${name}" already exists.`));
    process.exit(1);
  }

  const p = await import('@clack/prompts');
  p.intro(`Create persona "${name}"`);

  // 1. Description
  let description: string;
  if (createValues.description) {
    description = createValues.description as string;
    p.log.info(`Description: ${description}`);
  } else {
    const descInput = await p.text({
      message: "Describe this persona's purpose",
      placeholder: 'e.g., Email triage, calendar management, and document review',
    });
    if (p.isCancel(descInput)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    description = descInput.trim();
  }

  // 2. Server allowlist
  let servers: string[] | undefined;
  if (createValues.servers) {
    servers = (createValues.servers as string)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Refused before any prompt or generation: createPersona would refuse it
    // anyway, after the constitution was written.
    try {
      validatePersonaServers(servers);
    } catch (err) {
      p.cancel(displayError(err));
      process.exit(1);
    }
    p.log.info(`Servers: ${servers.join(', ')}`);
  } else {
    const config = loadConfig();
    const serverNames = Object.keys(config.mcpServers);
    if (serverNames.length > 1) {
      const selected = await p.multiselect({
        message: 'Select MCP servers for this persona (filesystem is always included)',
        options: serverNames.map((s) => ({
          value: s,
          label: s === 'filesystem' ? `${s} (always included)` : s,
          hint: config.mcpServers[s].description,
        })),
        initialValues: serverNames,
      });
      if (p.isCancel(selected)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      // Only set servers if not all selected (undefined = all servers)
      if (selected.length < serverNames.length) {
        servers = selected;
      }
    }
  }

  // 3. Memory opt-in (between Server allowlist and persona.json write)
  const enableMemory = await p.confirm({
    message: 'Enable persistent memory for this persona?',
    initialValue: true,
  });
  if (p.isCancel(enableMemory)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  // 4. Constitution authoring. The persona workspace path is only used as a
  // string in the generator prompt; the actual directory tree is created by the
  // service after all inputs are gathered.
  let constitution: string | undefined;
  const workspaceDir = getPersonaWorkspaceDir(name);
  const noGenerate = createValues['no-generate'] as boolean | undefined;

  if (!noGenerate) {
    const shouldGenerate = await p.confirm({
      message: 'Generate a constitution automatically from the description?',
      initialValue: true,
    });
    if (p.isCancel(shouldGenerate)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }

    if (shouldGenerate) {
      constitution = await generateAndReviewConstitution(description, workspaceDir, servers, p);
      // undefined: falls through to editor below
    }
  }

  // 5. Fallback: open $EDITOR
  if (!constitution) {
    p.log.step('Opening editor for constitution...');
    const instructions =
      'Enter the persona constitution -- guiding principles for what the agent\n' +
      'is and is not permitted to do.\n' +
      'Lines starting with # are ignored.';
    constitution = openEditorForMultiline(instructions);
  }

  // Create the whole persona tree atomically (persona.json + constitution.md +
  // generated/ + workspace/). The service owns all fs effects.
  await runOrExit(() =>
    createPersona(
      {
        name,
        description,
        servers,
        memoryEnabled: enableMemory,
        constitution: constitution ?? '',
      },
      'cli',
    ),
  );

  if (!constitution) {
    p.log.warn('No constitution provided. You can add one later with: ironcurtain persona edit ' + name);
    p.outro(`Persona "${name}" created (no constitution -- compilation skipped).`);
    return;
  }

  // 6. Compile.
  const compiled = await compileWithSpinner(name, p);
  if (!compiled) {
    p.log.warn(`Persona "${name}" was created. Fix the issue then run: ironcurtain persona compile ${name}`);
    process.exit(1);
  }

  p.outro(`Persona "${name}" created and compiled.`);
}

function runList(): void {
  const personas = listPersonas();
  const invalid = listInvalidPersonas();

  if (personas.length === 0 && invalid.length === 0) {
    console.error('No personas configured. Use "ironcurtain persona create <name>" to create one.');
    return;
  }

  for (const { name, description, compiled, stale } of personas) {
    // A stale policy no longer matches the persona's constitution; sessions
    // refuse it until it is recompiled.
    const statusColor = !compiled
      ? chalk.yellow('not compiled')
      : stale
        ? chalk.red('stale (recompile)')
        : chalk.green('compiled');
    console.error(`  ${chalk.bold(name.padEnd(24))} ${description.slice(0, 50).padEnd(52)} ${statusColor}`);
  }

  // Directories with a persona name whose persona.json is missing or invalid
  // (typically a persona directory copied by hand): sessions, compiles and
  // edits refuse them, so they are reported rather than silently skipped.
  if (invalid.length > 0) {
    if (personas.length > 0) console.error('');
    console.error(chalk.red('Persona directories that cannot be used:'));
    for (const { name, reason } of invalid) {
      console.error(`  ${chalk.bold(name)}`);
      for (const line of displayLines(reason).split('\n')) console.error(chalk.red(`    ${line}`));
    }
  }
}

/**
 * `persona compile <name> [--allow-broad]`. Exit status: 0 written; 1 nothing
 * written (refused as too broad, another compile running, or failed); 2
 * written, but some servers failed and have no rules. Outcome statuses are
 * set on `process.exitCode`, so the pipeline's summary still reaches a piped
 * stderr.
 */
async function runCompile(args: string[]): Promise<void> {
  const { values, positionals } = parseArgsStrict(
    {
      args,
      options: { 'allow-broad': { type: 'boolean' } },
      allowPositionals: true,
    },
    'ironcurtain persona compile',
  );
  const nameStr = positionals[0];
  if (!nameStr || positionals.length > 1) {
    console.error(chalk.red('Usage: ironcurtain persona compile <name> [--allow-broad]'));
    process.exit(1);
  }
  // A persona whose persona.json cannot be used (for example a hand-copied
  // directory that still names its original) is refused with the reasons
  // before anything is compiled.
  const { name } = loadPersonaOrExit(nameStr);
  const constitutionPath = getPersonaConstitutionPath(name);

  if (!existsSync(constitutionPath)) {
    console.error(chalk.red(`Persona "${name}" not found or has no constitution.md.`));
    process.exit(1);
  }

  const constitution = readFileSync(constitutionPath, 'utf-8').trim();
  if (!constitution) {
    console.error(chalk.red(`Persona "${name}" has an empty constitution. Edit it first.`));
    process.exit(1);
  }

  console.error(`Compiling policy for persona "${name}"...`);
  // --allow-broad sets the persona's opt-in, but only once this compile holds
  // the lock: refused while another compile runs, it changes nothing.
  const result = await compileFromCli(name, {
    allowBroad: values['allow-broad'] === true,
    onOptIn: (message) => console.error(message),
  });
  switch (result.kind) {
    case 'written': {
      const warnings = writtenWarnings(result.outcome);
      for (const warning of warnings) console.error(chalk.yellow(warning));
      const partial = (result.outcome.policy.failedServers?.length ?? 0) > 0;
      console.error(partial ? chalk.yellow('Done, with failed servers.') : chalk.green('Done.'));
      if (partial) process.exitCode = PARTIAL_COMPILE_EXIT_CODE;
      return;
    }
    case 'too-broad':
      console.error(chalk.red(tooBroadMessage(name)));
      for (const access of result.access) console.error(chalk.red(`  - ${access}`));
      console.error(allowBroadHint(name));
      process.exitCode = 1;
      return;
    case 'in-progress':
      console.error(chalk.red(inProgressMessage(name, result.operationId)));
      process.exitCode = 1;
      return;
    case 'failed':
      console.error(chalk.red(`Compilation failed: ${displayMessage(result.message)}`));
      process.exitCode = 1;
      return;
  }
}

async function runEdit(nameStr: string): Promise<void> {
  // Every edit below writes to the persona named by its DIRECTORY (`name`),
  // never by the name stored in persona.json; a persona.json naming another
  // persona is refused here, before anything is written.
  const { name, persona } = loadPersonaOrExit(nameStr);
  const constitutionPath = getPersonaConstitutionPath(name);

  // Ensure constitution file exists
  if (!existsSync(constitutionPath)) {
    writeFileSync(constitutionPath, '', 'utf-8');
  }

  const p = await import('@clack/prompts');
  p.intro(`Edit persona "${name}"`);

  const editAction = await p.select({
    message: 'How would you like to edit the persona?',
    options: [
      { value: 'customize' as const, label: 'Customize constitution interactively (LLM-assisted)' },
      { value: 'editor' as const, label: 'Edit constitution in $EDITOR' },
      { value: 'generate' as const, label: 'Generate new constitution from description' },
      { value: 'memory' as const, label: 'Toggle persistent memory' },
      { value: 'broad' as const, label: 'Toggle broad-policy opt-in' },
    ],
  });

  if (p.isCancel(editAction)) {
    p.cancel('Cancelled.');
    return;
  }

  if (editAction === 'broad') {
    await editBroadPolicyOptIn(name, persona, p);
    return;
  }

  if (editAction === 'memory') {
    const currentEnabled = persona.memory?.enabled ?? true;
    const newEnabled = await p.confirm({
      message: 'Enable persistent memory for this persona?',
      initialValue: currentEnabled,
    });
    if (p.isCancel(newEnabled)) {
      p.cancel('Cancelled.');
      return;
    }
    if (newEnabled === currentEnabled) {
      p.outro('No change.');
      return;
    }
    setPersonaMemory(name, newEnabled, 'cli');
    p.outro(`Memory ${newEnabled ? 'enabled' : 'disabled'} for persona "${name}".`);
    return;
  }

  let constitutionChanged: boolean;

  if (editAction === 'customize') {
    constitutionChanged = await editViaCustomizer(name, persona, constitutionPath);
  } else if (editAction === 'editor') {
    constitutionChanged = editViaEditor(name, constitutionPath);
  } else {
    constitutionChanged = await editViaGeneration(name, persona, p);
  }

  if (!constitutionChanged) {
    p.outro('No changes made.');
    return;
  }

  await offerCompilation(name, p);
}

/**
 * Sets or clears the persona's broad-policy opt-in. Clearing it revokes a
 * compiled policy that needed it (persona-service.ts moves it aside), which
 * is reported here.
 */
async function editBroadPolicyOptIn(
  name: PersonaName,
  persona: PersonaDefinition,
  p: typeof import('@clack/prompts'),
): Promise<void> {
  const current = persona.allowBroadPolicy === true;
  const next = await p.confirm({
    message:
      'Allow broad policies for this persona (wildcard domains or lists, out-of-workspace paths, ' +
      'allow rules with unconstrained arguments)?',
    initialValue: current,
  });
  if (p.isCancel(next)) {
    p.cancel('Cancelled.');
    return;
  }
  if (next === current) {
    p.outro('No change.');
    return;
  }

  const hadPolicy = getPersonaPolicyState(name).kind !== 'missing';
  let hasPolicy: boolean;
  try {
    hasPolicy = setPersonaBroadPolicyOptIn(name, next, 'cli').hasPolicy;
  } catch (err) {
    if (err instanceof PersonaCompileError && err.code === 'COMPILE_IN_PROGRESS') {
      p.log.error(inProgressMessage(name, holderOf(err).operationId));
      p.outro('No change.');
      return;
    }
    throw err;
  }
  if (hadPolicy && !hasPolicy) {
    p.log.warn(
      `The compiled policy granted broad access, so it was moved aside to generated/${REVOKED_POLICY_FILENAME}. ` +
        `Sessions refuse persona "${name}" until you narrow its constitution and run: ` +
        `ironcurtain persona compile ${name}`,
    );
  }
  p.outro(`Broad policies ${next ? 'allowed' : 'no longer allowed'} for persona "${name}".`);
}

/**
 * Runs the LLM-assisted interactive customizer on the current constitution.
 * `name` is the persona's directory name: the write and the approval scope
 * use it, never `persona.name`.
 */
async function editViaCustomizer(
  name: PersonaName,
  persona: PersonaDefinition,
  constitutionPath: string,
): Promise<boolean> {
  const currentConstitution = readFileSync(constitutionPath, 'utf-8');
  const { runPersonaConstitutionCustomizer } = await import('./persona-customizer.js');
  const refined = await runPersonaConstitutionCustomizer(
    currentConstitution,
    persona.description,
    persona.servers,
    personaApprovalScope(name),
  );
  if (refined) {
    setPersonaConstitution(name, refined, 'cli');
    return true;
  }
  return false;
}

/** Opens $EDITOR on the constitution file and returns whether it changed. */
function editViaEditor(name: PersonaName, constitutionPath: string): boolean {
  console.error('Opening constitution in editor...');
  const changed = openEditor(constitutionPath);
  if (changed) {
    // The editor wrote the file in place; persist it through the service so the
    // write is atomic and stale-detection runs. Strip exactly one trailing
    // newline (the service re-adds it) to keep the file content byte-identical.
    const text = readFileSync(constitutionPath, 'utf-8');
    setPersonaConstitution(name, text.endsWith('\n') ? text.slice(0, -1) : text, 'cli');
  }
  return changed;
}

/** Generates a fresh constitution from the persona description (written to the directory `name`). */
async function editViaGeneration(
  name: PersonaName,
  persona: PersonaDefinition,
  p: typeof import('@clack/prompts'),
): Promise<boolean> {
  const constitution = await generateAndReviewConstitution(
    persona.description,
    getPersonaWorkspaceDir(name),
    persona.servers,
    p,
  );
  if (!constitution) return false;
  setPersonaConstitution(name, constitution, 'cli');
  return true;
}

/** Offers to compile the persona policy after a constitution change. */
async function offerCompilation(name: PersonaName, p: typeof import('@clack/prompts')): Promise<void> {
  const shouldCompile = await p.confirm({
    message: 'Compile policy now?',
    initialValue: true,
  });

  if (p.isCancel(shouldCompile) || !shouldCompile) {
    p.outro(
      `Constitution updated. The compiled policy is now stale, so sessions refuse persona "${name}" ` +
        `until you run: ironcurtain persona compile ${name}`,
    );
    return;
  }

  const compiled = await compileWithSpinner(name, p);
  if (compiled) {
    p.outro(`Persona "${name}" updated and compiled.`);
  } else {
    p.outro(`Constitution saved. Fix the issue then run: ironcurtain persona compile ${name}`);
  }
}

async function runDelete(nameStr: string): Promise<void> {
  // Only the name is checked: a persona whose persona.json is invalid can
  // still be deleted.
  const name = await runOrExit(() => createPersonaName(nameStr));
  const personaDir = getPersonaDir(name);

  if (!existsSync(personaDir)) {
    console.error(chalk.red(`Persona "${name}" not found.`));
    process.exit(1);
  }

  const p = await import('@clack/prompts');
  const confirmed = await p.confirm({
    message: `Delete persona "${name}" and all its data?`,
    initialValue: false,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    console.error('Cancelled.');
    return;
  }

  // CLI keeps its current contract: a confirmed `persona delete` permanently
  // removes the persona ("...and all its data?"). The soft-delete/trash path is
  // the WS default; the CLI passes force:true to preserve behavior. Refused
  // (COMPILE_IN_PROGRESS) while the persona is being compiled.
  await runOrExit(() => deletePersona(name, 'cli', { force: true }));
  console.error(chalk.green(`Persona "${name}" deleted.`));
}

/**
 * Parses one `persona set` limit flag: a number, `none` (null: the limit is
 * disabled for the persona's sessions) or `inherit` (undefined: the persona
 * sets no value, the layer below applies). Range checks are the service's.
 */
function parseLimitFlag(flag: string, raw: string, integer: boolean): number | null | undefined {
  const value = raw.trim().toLowerCase();
  if (value === 'inherit') return undefined;
  if (value === 'none' && flag !== 'warn-threshold') return null;
  const parsed = Number(value);
  if (value === '' || !Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    const expected = integer ? 'a whole number' : 'a number';
    const alternatives = flag === 'warn-threshold' ? '"inherit"' : '"none" or "inherit"';
    console.error(chalk.red(`--${flag} must be ${expected}, ${alternatives}.`));
    process.exit(1);
  }
  return parsed;
}

/** One line per override, for `persona show` and `persona set`. */
function formatPersonaOverrides(nameStr: string, persona: PersonaDefinition): string[] {
  let overrides: PersonaOverrides;
  try {
    overrides = readPersonaOverrides(nameStr, persona);
  } catch (err) {
    return [chalk.red(err instanceof Error ? err.message : String(err))];
  }
  const model = overrides.agentModelId ?? 'global default';
  const limits = Object.entries(overrides.resourceBudget ?? {})
    .map(([field, limit]) => `${field}=${limit === null ? 'none' : String(limit)}`)
    .join(', ');
  return [`Agent model: ${model}`, `Resource limits: ${limits === '' ? 'inherited' : `${limits} (others inherited)`}`];
}

function runSet(args: string[]): void {
  const { values, positionals } = parseArgsStrict(
    {
      args,
      options: {
        help: { type: 'boolean', short: 'h' },
        model: { type: 'string' },
        'clear-model': { type: 'boolean' },
        'clear-limits': { type: 'boolean' },
        ...Object.fromEntries(LIMIT_FLAGS.map(({ flag }) => [flag, { type: 'string' as const }])),
      },
      allowPositionals: true,
    },
    personaSetSpec.name,
  );
  if (checkHelp(values, personaSetSpec)) return;

  const nameStr = positionals[0];
  if (!nameStr || positionals.length > 1) {
    console.error(chalk.red('Usage: ironcurtain persona set <name> [options]'));
    process.exit(1);
  }
  // `name` is the directory name; persona.json is refused unless it agrees.
  const { name, persona } = loadPersonaOrExit(nameStr);

  const model = values.model as string | undefined;
  if (model !== undefined && values['clear-model'] === true) {
    console.error(chalk.red('Pass either --model or --clear-model, not both.'));
    process.exit(1);
  }

  // Start from the stored limits (or none) and apply each flag given.
  let budget: Record<string, unknown> | null | undefined;
  const stored = (persona as { resourceBudget?: unknown }).resourceBudget;
  const base: Record<string, unknown> = values['clear-limits'] === true || !isPlainObject(stored) ? {} : { ...stored };
  let budgetChanged = values['clear-limits'] === true;
  for (const { flag, field, integer } of LIMIT_FLAGS) {
    const raw = values[flag] as string | undefined;
    if (raw === undefined) continue;
    const limit = parseLimitFlag(flag, raw, integer);
    if (limit === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- field comes from the fixed LIMIT_FLAGS table
      delete base[field];
    } else {
      base[field] = limit;
    }
    budgetChanged = true;
  }
  if (budgetChanged) budget = Object.keys(base).length > 0 ? base : null;

  if (model === undefined && values['clear-model'] !== true && !budgetChanged) {
    console.error(chalk.red('Nothing to change. Pass --model, --clear-model, a limit flag or --clear-limits.'));
    console.error(`Run \`${personaSetSpec.name} --help\` for usage.`);
    process.exit(1);
  }

  let updated: PersonaDefinition;
  try {
    updated = setPersonaOverrides(
      name,
      {
        ...(model !== undefined ? { agentModelId: model } : {}),
        ...(values['clear-model'] === true ? { agentModelId: null } : {}),
        ...(budget !== undefined ? { resourceBudget: budget } : {}),
      },
      'cli',
    );
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    // Flags change the stored limits; malformed stored limits need replacing.
    if (
      isPersonaOverridesError(err) &&
      values['clear-limits'] !== true &&
      stored !== undefined &&
      !parsePersonaResourceBudget(stored).ok
    ) {
      console.error('The stored resource limits are invalid; add --clear-limits to replace them.');
    }
    process.exit(1);
  }
  console.error(chalk.green(`Persona "${name}" updated.`));
  for (const line of formatPersonaOverrides(name, updated)) console.error(line);
}

function runShow(nameStr: string): void {
  // `name` is the directory name; persona.json is refused unless it agrees.
  const { name, persona } = loadPersonaOrExit(nameStr);

  console.error(chalk.bold(`Persona: ${name}`));
  console.error(`Description: ${toDisplayText(persona.description)}`);
  console.error(`Created: ${persona.createdAt}`);
  if (persona.servers) {
    console.error(`Servers: ${persona.servers.map((server) => toDisplayText(server)).join(', ')}`);
  } else {
    console.error('Servers: all (no filter)');
  }
  for (const line of formatPersonaOverrides(name, persona)) console.error(line);

  const policy = getPersonaPolicyState(name);
  const policyStatus =
    policy.kind === 'missing'
      ? chalk.yellow('not compiled')
      : policy.kind === 'stale'
        ? chalk.red(`stale: ${policy.detail}. Recompile with: ironcurtain persona compile ${name}`)
        : chalk.green('compiled');
  console.error(`Policy: ${policyStatus}`);
  console.error(`Broad policies: ${persona.allowBroadPolicy === true ? 'allowed (opt-in)' : 'not allowed'}`);
  if (policy.kind !== 'missing') showPolicyBreadth(name, persona);

  const constitutionPath = getPersonaConstitutionPath(name);
  if (existsSync(constitutionPath)) {
    const constitution = readFileSync(constitutionPath, 'utf-8');
    if (constitution.trim()) {
      console.error('');
      console.error(chalk.bold('Constitution:'));
      console.error(toDisplayText(constitution, { multiline: true }));
    } else {
      console.error('\nConstitution: (empty)');
    }
  } else {
    console.error('\nConstitution: (not created)');
  }
}

/**
 * Reports broad access in the compiled policy, judged as sessions judge it
 * (see `resolvePersona`): allowed by the opt-in, or refused without it.
 */
function showPolicyBreadth(name: PersonaName, persona: PersonaDefinition): void {
  let access: string[];
  try {
    access = describeBroadAccess(
      inspectCompiledPolicyBreadth(getPersonaGeneratedDir(name), getPersonaWorkspaceDir(name)),
    );
  } catch (err) {
    console.error(
      chalk.red(`Broad access: cannot be checked: ${displayMessage(err instanceof Error ? err.message : String(err))}`),
    );
    return;
  }
  if (access.length === 0) return;
  if (persona.allowBroadPolicy === true) {
    console.error(chalk.yellow(`Broad access (allowed by the opt-in): ${access.join('; ')}`));
  } else {
    console.error(
      chalk.red(
        `Broad access without the opt-in: ${access.join('; ')}. Sessions refuse this policy; narrow the ` +
          `constitution and recompile, or run: ironcurtain persona compile ${name} --allow-broad`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Lifecycle: clone, rename, trash
// ---------------------------------------------------------------------------

/** How to make a persona usable again after its compiled policy went away or never existed. */
function compileHint(name: PersonaName, constitution: string): string {
  return constitution.trim()
    ? `It has no compiled policy, so sessions refuse it until you run: ironcurtain persona compile ${name}`
    : `Its constitution is empty: add one with \`ironcurtain persona edit ${name}\`, then compile it.`;
}

/** `persona clone <source> <name> [--description <text>]`. */
async function runClone(args: string[]): Promise<void> {
  const { values, positionals } = parseArgsStrict(
    { args, options: { description: { type: 'string' } }, allowPositionals: true },
    'ironcurtain persona clone',
  );
  const [sourceStr, targetStr] = positionals;
  if (!sourceStr || !targetStr || positionals.length > 2) {
    console.error(chalk.red('Usage: ironcurtain persona clone <source> <name> [--description <text>]'));
    process.exit(1);
  }
  const { name: source } = loadPersonaOrExit(sourceStr);
  const description = typeof values.description === 'string' ? values.description : undefined;
  const detail = await runOrExit(() =>
    clonePersona(source, targetStr, 'cli', description !== undefined ? { description } : {}),
  );
  console.error(chalk.green(`Persona "${detail.name}" created as a copy of "${source}".`));
  console.error(
    'Copied: constitution, description, servers, memory setting, agent model, resource limits and skills. ' +
      'Not copied: the compiled policy, workspace, memories and broad-policy opt-in.',
  );
  console.error(compileHint(createPersonaName(detail.name), detail.constitution));
}

/** `persona rename <name> <new-name>`. */
async function runRename(args: string[]): Promise<void> {
  const { positionals } = parseArgsStrict({ args, options: {}, allowPositionals: true }, 'ironcurtain persona rename');
  const [nameStr, newNameStr] = positionals;
  if (!nameStr || !newNameStr || positionals.length > 2) {
    console.error(chalk.red('Usage: ironcurtain persona rename <name> <new-name>'));
    process.exit(1);
  }
  const { name } = loadPersonaOrExit(nameStr);
  const { detail, policyMovedAside } = await runOrExit(() => renamePersona(name, newNameStr, 'cli'));
  const newName = createPersonaName(detail.name);
  console.error(chalk.green(`Persona "${name}" renamed to "${newName}".`));
  if (policyMovedAside) {
    console.error(
      chalk.yellow(
        `Its compiled policy named the old workspace path, so it was moved aside to ` +
          `generated/${REVOKED_POLICY_FILENAME}.`,
      ),
    );
  }
  if (!detail.hasPolicy) console.error(compileHint(newName, detail.constitution));
  console.error(
    `Cron jobs, workflows and running sessions that name "${name}" do not follow the rename: ` +
      `point them at "${newName}".`,
  );
}

/** One trash entry, as `persona trash list` and the purge confirmation print it. */
function printTrashEntry(entry: PersonaTrashEntryDto, now: number): void {
  const expiry =
    entry.expiresAt === undefined
      ? 'kept until purged'
      : Date.parse(entry.expiresAt) <= now
        ? `expired ${entry.expiresAt}`
        : `purged after ${entry.expiresAt}`;
  console.error(`  ${chalk.bold(entry.id)}`);
  console.error(`    persona "${entry.name}", deleted ${entry.deletedAt}, ${expiry}`);
  if (entry.problem !== undefined) {
    console.error(chalk.red('    cannot be restored:'));
    for (const line of displayLines(entry.problem).split('\n')) console.error(chalk.red(`      ${line}`));
  } else if (entry.description) {
    console.error(`    ${displayMessage(entry.description)}`);
  }
}

function runTrashList(args: string[]): void {
  parseArgsStrict({ args, options: {}, allowPositionals: false }, 'ironcurtain persona trash list');
  const entries = listPersonaTrashEntries();
  if (entries.length === 0) {
    console.error('The persona trash is empty.');
    return;
  }
  const now = Date.now();
  for (const entry of entries) printTrashEntry(entry, now);
}

/** `persona trash restore <entry|name> [--as <name>] [--force]`. */
async function runTrashRestore(args: string[]): Promise<void> {
  const { values, positionals } = parseArgsStrict(
    { args, options: { as: { type: 'string' }, force: { type: 'boolean' } }, allowPositionals: true },
    'ironcurtain persona trash restore',
  );
  if (positionals.length !== 1) {
    console.error(chalk.red('Usage: ironcurtain persona trash restore <entry|name> [--as <name>] [--force]'));
    process.exit(1);
  }
  const as = typeof values.as === 'string' ? values.as : undefined;
  const result = await runOrExit(() =>
    restorePersona(positionals[0], 'cli', {
      ...(as !== undefined ? { as } : {}),
      ...(values.force === true ? { force: true } : {}),
    }),
  );
  const name = createPersonaName(result.detail.name);
  console.error(chalk.green(`Persona "${name}" restored from the trash (${result.restored}).`));
  if (result.replaced !== undefined) {
    console.error(
      chalk.yellow(
        `The persona "${name}" it replaced was moved to the trash as ${result.replaced} ` +
          `(restore it with: ironcurtain persona trash restore ${result.replaced} --as <name>).`,
      ),
    );
    // A persona went into the trash: the retention sweep runs, as after a
    // soft delete.
    await sweepPersonaTrash('cli');
  }
  if (result.policyMovedAside) {
    console.error(
      chalk.yellow(
        `It was restored under another name, so its compiled policy (made for the old workspace path) was ` +
          `moved aside to generated/${REVOKED_POLICY_FILENAME}.`,
      ),
    );
  }
  if (!result.detail.hasPolicy) {
    console.error(compileHint(name, result.detail.constitution));
  } else if (result.detail.stale !== undefined) {
    console.error(`Its compiled policy is stale. Recompile it with: ironcurtain persona compile ${name}`);
  }
}

/** `persona trash purge <entry|name>... | --expired | --all [--yes]`. */
async function runTrashPurge(args: string[]): Promise<void> {
  const usage = 'Usage: ironcurtain persona trash purge <entry|name>... | --expired | --all [--yes]';
  const { values, positionals } = parseArgsStrict(
    {
      args,
      options: { expired: { type: 'boolean' }, all: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } },
      allowPositionals: true,
    },
    'ironcurtain persona trash purge',
  );
  const expired = values.expired === true;
  const all = values.all === true;
  if ([positionals.length > 0, expired, all].filter(Boolean).length !== 1) {
    console.error(chalk.red(`${usage} (exactly one of: entries, --expired, --all)`));
    process.exit(1);
  }
  const selection: PersonaTrashPurgeSelection = all
    ? { kind: 'all' }
    : expired
      ? { kind: 'expired' }
      : { kind: 'entries', refs: positionals };

  const selected = await runOrExit(() => selectPersonaTrashForPurge(selection));
  if (selected.length === 0) {
    console.error(
      expired && getPersonaTrashRetentionDays() === null
        ? 'Nothing to purge: personas.trashRetentionDays is null, so trash entries never expire.'
        : 'Nothing to purge.',
    );
    return;
  }

  if (values.yes !== true) {
    const entries = listPersonaTrashEntries().filter((entry) => selected.some((s) => s.id === entry.id));
    const now = Date.now();
    for (const entry of entries) printTrashEntry(entry, now);
    const p = await import('@clack/prompts');
    const count = selected.length === 1 ? '1 trash entry' : `${selected.length} trash entries`;
    const confirmed = await p.confirm({
      message: `Permanently delete ${count}, workspace and memory included?`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      console.error('Cancelled.');
      return;
    }
  }

  const result = await runOrExit(() =>
    purgePersonaTrash(selection, 'cli', { only: selected.map((entry) => entry.id) }),
  );
  for (const id of result.purged) console.error(chalk.green(`Purged ${id}.`));
  for (const { id, reason } of result.failed) {
    console.error(chalk.red(`Could not purge ${id}: ${displayMessage(reason)}`));
  }
  if (result.failed.length > 0) process.exitCode = 1;
}

/** `persona trash <list|restore|purge> ...`. */
async function runTrash(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  switch (action) {
    case 'list':
      runTrashList(rest);
      return;
    case 'restore':
      await runTrashRestore(rest);
      return;
    case 'purge':
      await runTrashPurge(rest);
      return;
    default:
      console.error(
        chalk.red(
          action
            ? `Unknown persona trash action: ${displayMessage(action)}`
            : 'Usage: ironcurtain persona trash <list|restore|purge>',
        ),
      );
      printHelp(personaSpec);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });

  const action = positionals[0];

  if (!action || action === 'help' || (values.help && !action)) {
    printHelp(personaSpec);
    return;
  }

  // `set` parses its own flags (and its own --help) strictly.
  if (action === 'set') {
    runSet(args.slice(args.indexOf(action) + 1));
    return;
  }

  if (checkHelp(values as { help?: boolean }, personaSpec)) return;

  switch (action) {
    case 'create': {
      const name = positionals[1];
      if (!name) {
        console.error(chalk.red('Usage: ironcurtain persona create <name>'));
        process.exit(1);
      }
      await runCreate(name, args.slice(2));
      break;
    }
    case 'list': {
      runList();
      break;
    }
    case 'compile': {
      // Flags may come before or after the name; runCompile parses strictly.
      await runCompile(args.slice(1));
      break;
    }
    case 'edit': {
      const name = positionals[1];
      if (!name) {
        console.error(chalk.red('Usage: ironcurtain persona edit <name>'));
        process.exit(1);
      }
      await runEdit(name);
      break;
    }
    case 'clone': {
      // Flags may come before or after the names; runClone parses strictly.
      await runClone(args.slice(1));
      break;
    }
    case 'rename': {
      await runRename(args.slice(1));
      break;
    }
    case 'trash': {
      await runTrash(args.slice(1));
      break;
    }
    case 'delete': {
      const name = positionals[1];
      if (!name) {
        console.error(chalk.red('Usage: ironcurtain persona delete <name>'));
        process.exit(1);
      }
      await runDelete(name);
      break;
    }
    case 'show': {
      const name = positionals[1];
      if (!name) {
        console.error(chalk.red('Usage: ironcurtain persona show <name>'));
        process.exit(1);
      }
      runShow(name);
      break;
    }
    default: {
      console.error(chalk.red(`Unknown persona action: ${action}`));
      printHelp(personaSpec);
      process.exit(1);
    }
  }
}

/**
 * `ironcurtain workflow run-state` — runs a single workflow agent state once
 * against a pre-staged artifact directory. Reuses the start-time staging and
 * session-factory seams; deliberately skips the orchestrator, journal,
 * checkpoint, and transition machinery.
 */

import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';
import { loadConfig } from '../config/index.js';
import { readUntrustedRegularFileBelow, UntrustedFileError } from '../hardened-fs.js';
import { validateWorkspacePath } from '../session/workspace-validation.js';
import { formatHelp, type CommandSpec } from '../cli-help.js';
import { type LintMode } from './lint-integration.js';
import { createInitialContext } from './machine-builder.js';
import { resolveWorkflowPath, getWorkflowPackageDir } from './discovery.js';
import { buildAgentCommand } from './prompt-builder.js';
import { parseAgentStatus, AgentStatusParseError } from './status-parser.js';
import { parseArtifactRef } from './validate.js';
import { WORKFLOW_AGENT_TURN, stageWorkflowSkillsAtStart } from './orchestrator.js';
import { checkedModelOverride, parseArgsStrict, runCliPreflightLint } from './cli-shared.js';
import type { AgentStateDefinition, WorkflowContext, WorkflowDefinition, WorkflowStateDefinition } from './types.js';
import { WORKFLOW_ARTIFACT_DIR, resolveWorkflowSkillsOptions } from './types.js';
import { resolveWorkflowResourceBudget, workflowSessionBudgetOptions } from './resource-budget.js';
import { prepareWritableOutputDirs } from './artifacts.js';
import { readOnlyWorkspaceForState } from './workspace-access.js';
import { copyWorkflowResourceDirectory } from './staged-directories.js';

import {
  createWorkflowSessionFactory,
  displayBlock,
  displayLine,
  writeStderr,
  writeStdout,
  BOLD,
  CYAN,
  DIM,
  GREEN,
  RED,
  RESET,
  YELLOW,
} from './cli-support.js';
import {
  captureContainerLogs,
  captureConversationLogs,
  resolveCapturePaths,
  type RunStateCapturePaths,
} from './run-state-debug-capture.js';
import { bundleIdFromSessionId, createAgentConversationId } from '../session/types.js';
import type { Session, SessionMode } from '../session/types.js';
import { resolveStateDockerAgent, toAgentId } from './agent-harness.js';

function printCaptureLocations(target: 'stdout' | 'stderr', paths: RunStateCapturePaths): void {
  const write = target === 'stdout' ? writeStdout : writeStderr;
  write(`${DIM}Container logs: ${paths.containerLogsPath}${RESET}`);
  write(`${DIM}Conversation logs: ${paths.claudeLogsDir}${RESET}`);
}

// ---------------------------------------------------------------------------
// Help spec
// ---------------------------------------------------------------------------

export const runStateSpec: CommandSpec = {
  name: 'ironcurtain workflow run-state',
  description: 'Run a single workflow agent state once against pre-staged artifacts',
  usage: ['ironcurtain workflow run-state <name-or-path> <state> --artifacts <dir> [options]'],
  options: [
    { flag: 'artifacts', description: 'Directory containing pre-staged artifact subdirs', placeholder: '<dir>' },
    {
      flag: 'workspace',
      description: 'Source tree to stage alongside .workflow/ (excludes top-level .workflow/ from the copy)',
      placeholder: '<dir>',
    },
    { flag: 'directive', description: 'Inline scoping directive from a synthetic prior agent', placeholder: '<text>' },
    { flag: 'directive-file', description: 'File containing the scoping directive', placeholder: '<path>' },
    {
      flag: 'output',
      description: 'Output dir for staged workspace (default: ~/.ironcurtain/debug-runs/...)',
      placeholder: '<dir>',
    },
    { flag: 'mode', description: 'Override settings.mode (builtin or docker)', placeholder: '<mode>' },
    {
      flag: 'task',
      description: 'Inline task description (overrides artifacts/task/description.md)',
      placeholder: '<text>',
    },
    { flag: 'task-file', description: 'File containing task description', placeholder: '<path>' },
    { flag: 'model', description: 'Override the agent model', placeholder: '<model-id>' },
    { flag: 'no-lint', description: 'Skip pre-flight linting' },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: [
    'ironcurtain workflow run-state design-and-code review --artifacts ~/src/calendar/.workflow',
    'ironcurtain workflow run-state design-and-code review --workspace ~/src/calendar --artifacts ~/src/calendar/.workflow',
    'ironcurtain workflow run-state design-and-code review --artifacts ~/src/calendar/.workflow --directive "check the date parser tests"',
    'ironcurtain workflow run-state design-and-code review --artifacts ~/src/calendar/.workflow --mode builtin',
  ],
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  readonly definitionRef: string;
  readonly stateId: string;
  readonly artifactsDir: string;
  readonly workspaceSrc: string | undefined;
  readonly directive: string | undefined;
  readonly outputDir: string | undefined;
  readonly mode: 'builtin' | 'docker' | undefined;
  readonly taskDescription: string | undefined;
  readonly modelOverride: string | undefined;
  readonly noLint: boolean;
}

function parseRunStateArgs(args: string[]): ParsedArgs | 'help' {
  const { values, positionals } = parseArgsStrict({
    args,
    options: {
      artifacts: { type: 'string' },
      workspace: { type: 'string' },
      directive: { type: 'string' },
      'directive-file': { type: 'string' },
      output: { type: 'string' },
      mode: { type: 'string' },
      task: { type: 'string' },
      'task-file': { type: 'string' },
      model: { type: 'string' },
      'no-lint': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) return 'help';

  const definitionRef = positionals[0];
  const stateId = positionals[1];
  if (!definitionRef || !stateId) {
    writeStderr(`${RED}Usage: ironcurtain workflow run-state <name-or-path> <state> --artifacts <dir>${RESET}`);
    process.exit(2);
  }

  const artifactsDir = values.artifacts as string | undefined;
  if (!artifactsDir) {
    writeStderr(`${RED}--artifacts <dir> is required${RESET}`);
    process.exit(2);
  }

  if (values.directive != null && values['directive-file'] != null) {
    writeStderr(`${RED}--directive and --directive-file are mutually exclusive${RESET}`);
    process.exit(2);
  }
  if (values.task != null && values['task-file'] != null) {
    writeStderr(`${RED}--task and --task-file are mutually exclusive${RESET}`);
    process.exit(2);
  }

  let directive: string | undefined;
  if (values.directive != null) {
    directive = values.directive as string;
  } else if (values['directive-file'] != null) {
    const path = resolve(values['directive-file'] as string);
    directive = readFileWithMessage(path, 'directive file');
  }

  let taskDescription: string | undefined;
  if (values.task != null) {
    taskDescription = values.task as string;
  } else if (values['task-file'] != null) {
    const path = resolve(values['task-file'] as string);
    taskDescription = readFileWithMessage(path, 'task file');
  }

  const modeRaw = values.mode as string | undefined;
  let mode: 'builtin' | 'docker' | undefined;
  if (modeRaw != null) {
    if (modeRaw !== 'builtin' && modeRaw !== 'docker') {
      writeStderr(`${RED}--mode must be "builtin" or "docker" (got "${modeRaw}")${RESET}`);
      process.exit(2);
    }
    mode = modeRaw;
  }

  const workspaceRaw = values.workspace as string | undefined;
  let workspaceSrc: string | undefined;
  if (workspaceRaw != null) {
    // The source tree is copied wholesale into the agent's staged workspace,
    // so it must pass the same checks as a workspace the agent would get
    // directly (`--workspace ~` would otherwise copy every credential store).
    try {
      workspaceSrc = validateWorkspacePath(workspaceRaw, loadConfig().protectedPaths);
    } catch (err) {
      writeStderr(`${RED}Invalid --workspace: ${err instanceof Error ? err.message : String(err)}${RESET}`);
      process.exit(2);
    }
  }

  return {
    definitionRef,
    stateId,
    artifactsDir: resolve(artifactsDir),
    workspaceSrc,
    directive,
    outputDir: values.output != null ? resolve(values.output as string) : undefined,
    mode,
    taskDescription,
    modelOverride: checkedModelOverride(values.model, 2),
    noLint: values['no-lint'] === true,
  };
}

function readFileWithMessage(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    writeStderr(`${RED}${label} not found: ${path}${RESET}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Workflow + state resolution
// ---------------------------------------------------------------------------

interface ResolvedAgentState {
  readonly definition: WorkflowDefinition;
  readonly definitionPath: string;
  readonly stateConfig: AgentStateDefinition;
}

function resolveAgentState(parsed: ParsedArgs): ResolvedAgentState {
  const definitionPath = resolveWorkflowPath(parsed.definitionRef);
  if (!definitionPath) {
    writeStderr(`${RED}Workflow not found: ${parsed.definitionRef}${RESET}`);
    writeStderr(`${DIM}Looked in bundled and user workflow directories.${RESET}`);
    process.exit(2);
  }

  const lintMode: LintMode = parsed.noLint ? 'off' : 'warn';
  const definition = runCliPreflightLint(definitionPath, lintMode);

  if (!Object.prototype.hasOwnProperty.call(definition.states, parsed.stateId)) {
    const agentStates = Object.entries(definition.states)
      .filter(([, s]) => s.type === 'agent')
      .map(([id]) => id);
    writeStderr(`${RED}Unknown state: "${parsed.stateId}"${RESET}`);
    writeStderr(`${DIM}Available agent states: ${agentStates.join(', ')}${RESET}`);
    process.exit(2);
  }
  const stateConfig: WorkflowStateDefinition = definition.states[parsed.stateId];
  if (stateConfig.type !== 'agent') {
    writeStderr(
      `${RED}state "${parsed.stateId}" is type "${stateConfig.type}"; only agent states are runnable${RESET}`,
    );
    process.exit(2);
  }

  return { definition, definitionPath, stateConfig };
}

// ---------------------------------------------------------------------------
// Workspace + artifact staging
// ---------------------------------------------------------------------------

function defaultOutputDir(workflowName: string, stateId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve(getIronCurtainHome(), 'debug-runs', `${workflowName}-${stateId}-${ts}`);
}

interface StagedWorkspace {
  readonly outputDir: string;
  readonly workspacePath: string;
  readonly artifactDir: string;
}

function assertDirectory(path: string, flag: string): void {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    writeStderr(`${RED}${flag} is not a directory: ${path}${RESET}`);
    process.exit(2);
  }
  if (!stat.isDirectory()) {
    writeStderr(`${RED}${flag} is not a directory: ${path}${RESET}`);
    process.exit(2);
  }
}

/**
 * Stages the agent's workspace under {@link outputDir}/workspace, copying every
 * subdirectory of {@link artifactsSrc} whose name matches one of the state's
 * declared inputs. Required inputs (no `?`) missing on disk produce a
 * structured exit-2 error listing each missing input and the path it was
 * looked up at; optional inputs are silently skipped.
 *
 * If {@link workspaceSrc} is provided, its contents are copied first into the
 * staged workspace, EXCLUDING any top-level `.workflow/` directory (which
 * would conflict with the artifact staging step that runs after). Artifact
 * staging always wins on conflict.
 *
 * The source dirs are never mutated — only read.
 */
function stageWorkspace(
  outputDir: string,
  artifactsSrc: string,
  inputs: readonly string[],
  workspaceSrc: string | undefined,
): StagedWorkspace {
  assertDirectory(artifactsSrc, '--artifacts');
  const artifactsRoot = realpathSync(artifactsSrc);
  if (workspaceSrc != null) assertDirectory(workspaceSrc, '--workspace');
  let existingEntries: string[] = [];
  try {
    existingEntries = readdirSync(outputDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') {
      writeStderr(`${RED}--output exists but is not a directory: ${outputDir}${RESET}`);
      process.exit(2);
    }
    if (code !== 'ENOENT') {
      writeStderr(
        `${RED}Cannot read --output dir ${outputDir}: ${err instanceof Error ? err.message : String(err)}${RESET}`,
      );
      process.exit(2);
    }
  }
  if (existingEntries.length > 0) {
    writeStderr(`${RED}Output dir already exists and is not empty: ${outputDir}${RESET}`);
    writeStderr(`${DIM}Choose a different --output, or remove the existing directory.${RESET}`);
    process.exit(2);
  }
  const workspacePath = resolve(outputDir, 'workspace');
  const artifactDir = resolve(workspacePath, WORKFLOW_ARTIFACT_DIR);
  mkdirSync(artifactDir, { recursive: true });

  if (workspaceSrc != null) {
    const skip = resolve(workspaceSrc, WORKFLOW_ARTIFACT_DIR);
    cpSync(workspaceSrc, workspacePath, { recursive: true, filter: (src) => resolve(src) !== skip });
  }

  const missing: string[] = [];
  const selectedInputs = new Set<string>();
  for (const inputRef of inputs) {
    const { name, isOptional } = parseArtifactRef(inputRef);
    const srcPath = resolve(artifactsRoot, name);
    let srcStat;
    try {
      srcStat = lstatSync(srcPath);
    } catch {
      if (!isOptional) missing.push(`${name} (looked up at ${srcPath})`);
      continue;
    }
    if (!srcStat.isDirectory()) {
      if (isOptional) {
        writeStderr(`${YELLOW}Warning: optional input ${srcPath} is not a directory; skipping.${RESET}`);
        continue;
      }
      writeStderr(`${RED}Required input ${name} at ${srcPath} is not a directory${RESET}`);
      process.exit(2);
    }
    selectedInputs.add(name);
  }

  if (missing.length > 0) {
    writeStderr(`${RED}Missing required inputs:${RESET}`);
    for (const m of missing) writeStderr(`  ${RED}- ${m}${RESET}`);
    process.exit(2);
  }
  try {
    copyWorkflowResourceDirectory(artifactsRoot, workspacePath, WORKFLOW_ARTIFACT_DIR, {
      rootDirectories: selectedInputs,
    });
  } catch (err) {
    throw new Error(
      `Cannot safely stage workflow inputs: ${displayLine(err instanceof Error ? err.message : String(err))}`,
      { cause: err },
    );
  }

  return { outputDir, workspacePath, artifactDir };
}

// ---------------------------------------------------------------------------
// Task description resolution
// ---------------------------------------------------------------------------

/** Largest `task/description.md` taken from `--artifacts`. */
const MAX_TASK_DESCRIPTION_BYTES = 1024 * 1024;

/**
 * The task: `--task`/`--task-file`, else `<artifacts>/task/description.md`.
 * `--artifacts` is usually a run's `.workflow`, which the agent wrote, so that
 * file is read only as a regular file inside it: never through a symlink (a
 * planted link would make a host file, a key say, the agent's task), never by
 * a blocking open (a FIFO would hang the CLI), and never past the size cap.
 */
function resolveTaskDescription(parsed: ParsedArgs): string {
  if (parsed.taskDescription != null) return parsed.taskDescription.trim();

  const candidate = resolve(parsed.artifactsDir, 'task', 'description.md');
  try {
    return readUntrustedRegularFileBelow(parsed.artifactsDir, 'task/description.md', {
      maxBytes: MAX_TASK_DESCRIPTION_BYTES,
    })
      .bytes.toString('utf8')
      .trim();
  } catch (err) {
    const refused = err instanceof UntrustedFileError && err.code !== 'NOT_FOUND';
    writeStderr(
      refused
        ? `${YELLOW}Warning: not reading ${displayLine(candidate)}: not a regular file inside --artifacts, or over ${MAX_TASK_DESCRIPTION_BYTES} bytes; using placeholder.${RESET}`
        : `${YELLOW}Warning: no task description found (tried ${displayLine(candidate)}); using placeholder.${RESET}`,
    );
    return '(no task description provided)';
  }
}

// ---------------------------------------------------------------------------
// Context synthesis
// ---------------------------------------------------------------------------

function buildContext(
  definition: WorkflowDefinition,
  taskDescription: string,
  stateId: string,
  directive: string | undefined,
): WorkflowContext {
  return {
    ...createInitialContext(definition),
    taskDescription,
    round: 1,
    maxRounds: 1,
    previousAgentOutput: directive ?? null,
    previousStateName: directive != null ? 'debug' : null,
    visitCounts: { [stateId]: 1 },
  };
}

// ---------------------------------------------------------------------------
// Mode + session creation
// ---------------------------------------------------------------------------

/**
 * Session mode for the one state run-state executes: `--mode` beats
 * `settings.mode`, and a Docker run uses the state's own harness
 * (`dockerAgent`), else the workflow's — the same resolution the
 * orchestrator applies (agent-harness.ts).
 */
export function resolveRunStateMode(
  definition: WorkflowDefinition,
  stateConfig: AgentStateDefinition,
  override: 'builtin' | 'docker' | undefined,
): SessionMode {
  const settings = definition.settings ?? {};
  const effective = override ?? settings.mode ?? 'docker';
  if (effective === 'builtin') return { kind: 'builtin' };
  return { kind: 'docker', agent: toAgentId(resolveStateDockerAgent(stateConfig, settings)) };
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

/**
 * The result block printed after the state ran: the verdict and notes from the
 * agent's `agent_status` block, or why there is none. All of it is
 * agent-written (the parse error quotes the response), so control and
 * invisible format characters are shown as visible escapes; the notes keep
 * their line breaks.
 */
export function formatAgentResult(responseText: string): string {
  try {
    const parsedStatus = parseAgentStatus(responseText);
    if (!parsedStatus) return '(no agent_status block)';
    const verdict = `verdict=${displayLine(parsedStatus.verdict)}`;
    return parsedStatus.notes ? `${verdict}\nnotes: ${displayBlock(parsedStatus.notes)}` : verdict;
  } catch (err) {
    if (err instanceof AgentStatusParseError) {
      return `(malformed agent_status: ${displayBlock(err.message)})`;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runRunState(args: string[]): Promise<void> {
  const parsed = parseRunStateArgs(args);
  if (parsed === 'help') {
    process.stderr.write(formatHelp(runStateSpec) + '\n');
    return;
  }

  const { definition, definitionPath, stateConfig } = resolveAgentState(parsed);

  const outputDir = parsed.outputDir ?? defaultOutputDir(definition.name, parsed.stateId);
  const staged = stageWorkspace(outputDir, parsed.artifactsDir, stateConfig.inputs, parsed.workspaceSrc);

  const workflowSkillsDir = stageWorkflowSkillsAtStart(getWorkflowPackageDir(definitionPath), outputDir);

  const taskDescription = resolveTaskDescription(parsed);
  const context = buildContext(definition, taskDescription, parsed.stateId, parsed.directive);
  const command = buildAgentCommand(parsed.stateId, stateConfig, context, definition);

  const mode = resolveRunStateMode(definition, stateConfig, parsed.mode);
  const settings = definition.settings ?? {};
  const effectiveModel = stateConfig.model ?? settings.model;

  const sessionFactory = createWorkflowSessionFactory(parsed.modelOverride);

  // A read-only state runs read-only here too, as the orchestrator runs it.
  const readOnlyWorkspace = readOnlyWorkspaceForState(stateConfig);
  if (readOnlyWorkspace) {
    for (const warning of prepareWritableOutputDirs(staged.workspacePath, readOnlyWorkspace.writablePaths)) {
      writeStderr(`${YELLOW}Warning: ${displayLine(warning)}${RESET}`);
    }
  }

  writeStdout(`${BOLD}${CYAN}Running state "${parsed.stateId}" from ${definition.name}${RESET}`);
  writeStdout(`${DIM}Workspace: ${staged.workspacePath}${RESET}`);
  writeStdout(`${DIM}Mode: ${mode.kind === 'docker' ? `docker (${mode.agent})` : mode.kind}${RESET}`);
  if (parsed.directive)
    writeStdout(`${DIM}Directive: ${parsed.directive.length} bytes from synthetic "debug" agent${RESET}`);
  writeStdout('');

  let session: Session;
  try {
    session = await sessionFactory({
      persona: stateConfig.persona,
      mode,
      agentConversationId: createAgentConversationId(),
      workspacePath: staged.workspacePath,
      ...(definition.settings?.systemPrompt ? { systemPromptAugmentation: definition.settings.systemPrompt } : {}),
      ...(effectiveModel != null ? { agentModelOverride: effectiveModel } : {}),
      // The workflow's own limits over the persona's, the inherited ones below.
      ...workflowSessionBudgetOptions(resolveWorkflowResourceBudget(settings)),
      workflow: {
        stateId: parsed.stateId,
        personaId: stateConfig.persona,
        ...resolveWorkflowSkillsOptions(stateConfig.skills, workflowSkillsDir),
        ...(readOnlyWorkspace ? { readOnlyWorkspace } : {}),
      },
    });
  } catch (err) {
    writeStderr(
      `${RED}Session creation failed: ${displayBlock(err instanceof Error ? err.message : String(err))}${RESET}`,
    );
    process.exit(1);
  }

  // bundleIdFromSessionId carries the standalone-mode invariant
  // (workflow-session-identity §2.1) — see helper in session/types.
  const capturePaths =
    mode.kind === 'docker' ? resolveCapturePaths(bundleIdFromSessionId(session.getInfo().id), outputDir) : undefined;

  let responseText = '';
  let invocationFailed = false;
  let invocationError: unknown;
  try {
    // A workflow prompt (here with the debug directive) is system-generated,
    // never trusted user context for the auto-approver.
    responseText = await session.sendMessage(command, WORKFLOW_AGENT_TURN);
  } catch (err) {
    invocationFailed = true;
    invocationError = err;
  } finally {
    if (capturePaths) await captureContainerLogs(session, capturePaths);
    await session
      .close()
      .catch((err: unknown) =>
        writeStderr(
          `[run-state] session.close() failed: ${displayBlock(err instanceof Error ? err.message : String(err))}`,
        ),
      );
    if (capturePaths) captureConversationLogs(capturePaths);
  }

  if (invocationFailed) {
    writeStderr(
      `${RED}Agent invocation failed: ${displayBlock(invocationError instanceof Error ? invocationError.message : String(invocationError))}${RESET}`,
    );
    if (capturePaths) printCaptureLocations('stderr', capturePaths);
    process.exit(1);
  }

  // Sidecar — agent response can be megabytes; stderr is inconvenient to recover from CI logs.
  const outputFile = resolve(outputDir, 'agent-output.md');
  writeFileSync(outputFile, responseText, 'utf-8');

  writeStdout('');
  writeStdout(`${BOLD}${GREEN}Result${RESET}`);
  writeStdout(formatAgentResult(responseText));
  writeStdout('');
  writeStdout(`${DIM}Workspace: ${staged.workspacePath}${RESET}`);
  writeStdout(`${DIM}Agent output: ${outputFile}${RESET}`);
  if (capturePaths) printCaptureLocations('stdout', capturePaths);
}

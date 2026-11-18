/**
 * Shared CLI helpers for the workflow system.
 *
 * Extracted from examples/workflow-real-spike.ts so both the CLI
 * command and the spike script can reuse the same logic.
 *
 * Output convention: all functions use process.stdout.write() and
 * process.stderr.write() — never console.log/warn/error. After
 * logger.setup() hijacks console.*, those writes are redirected
 * to the session log file and never reach the terminal.
 *
 * Agent-derived text (gate summaries with the last error or agent output,
 * error messages, artifact and file names from the agent-writable workspace)
 * goes through {@link displayLine} / {@link displayBlock}: control and
 * invisible format characters are shown as visible escapes, so an agent
 * cannot rewrite the screen a human decides on, set the clipboard (OSC 52)
 * or disguise links. The ANSI colors below are the only escapes written raw.
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config/index.js';
import { readUntrustedRegularFileBelow } from '../hardened-fs.js';
import { createSession } from '../session/index.js';
import { withAgentModelId } from '../session/model-budget-precedence.js';
import type { Session, SessionOptions } from '../session/types.js';
import {
  GLOBAL_PERSONA,
  isSafeWorkflowId,
  WORKFLOW_ARTIFACT_DIR,
  type WorkflowId,
  type WorkflowCheckpoint,
  type WorkflowContext,
  type HumanGateEvent,
  type HumanGateRequest,
  type HumanGateEventType,
} from './types.js';
import type { WorkflowOrchestrator, WorkflowLifecycleEvent, WorkflowTabHandle } from './orchestrator.js';
import type { WorkflowToolCallEscalation, WorkflowToolCallEscalationDecision } from './types.js';
import {
  ARTIFACT_LISTING_MAX_ENTRIES,
  listArtifactOutputNames,
  resolveArtifactOutputDir,
  walkTreeNoFollow,
  type ArtifactOutputListing,
} from './artifacts.js';
import { FileCheckpointStore, isCheckpointResumable } from './checkpoint.js';
import { findResumableCheckpoints } from './checkpoint-selection.js';
import { isGateResolutionError } from './errors.js';
import { toDisplayText } from '../terminal/display-sanitize.js';

// Re-export for backward compatibility — the canonical location is now
// `./checkpoint.js`, but external callers (e.g. `workflow-manager.ts`,
// the test suite) historically imported it from here.
export { isCheckpointResumable };

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const BLUE = '\x1b[34m';
export const MAGENTA = '\x1b[35m';
export const CYAN = '\x1b[36m';
export const RED = '\x1b[31m';
export const WHITE = '\x1b[37m';
export const BG_YELLOW = '\x1b[43m';
export const BLACK = '\x1b[30m';

// ---------------------------------------------------------------------------
// Safe output primitives
// ---------------------------------------------------------------------------

export function writeStdout(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

export function writeStderr(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/**
 * Untrusted text for a one-line slot: every control and invisible format
 * character (line feeds included) is a visible escape. With `maxLength`, a
 * longer text is cut and the cut is marked.
 */
export function displayLine(value: string, maxLength?: number): string {
  return toDisplayText(value, maxLength === undefined ? {} : { maxLength });
}

/**
 * Untrusted multi-line text: line feeds and tabs are kept, every other control
 * and invisible format character is a visible escape, and nothing is cut.
 */
export function displayBlock(value: string): string {
  return toDisplayText(value, { multiline: true });
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

/**
 * Creates a session factory that reads current config and routes model
 * selection through:
 *
 *   `--model` CLI flag  >  per-call `agentModelOverride` (the state's `model`,
 *   else the workflow's `settings.model`)  >  the state persona's
 *   `agentModelId`  >  user config
 *
 * Resolution happens per call so per-state `SessionOptions.agentModelOverride`
 * values are honored on each invocation. This factory applies the first two;
 * `buildSessionConfig` applies the persona's and the global model when
 * neither is set (see session/model-budget-precedence.ts).
 *
 * Persona `"global"` (GLOBAL_PERSONA) is stripped to undefined (uses global
 * policy); any other value passes through for per-persona policy/memory.
 *
 * Workflow sessions never auto-approve escalations: the auto-approver
 * matches an escalated call against "the user's message", which in a
 * workflow is the orchestrator's prompt carrying prior agents' output, not
 * a human's intent. Escalations go to the workflow's human route instead
 * (`WorkflowOrchestrator.resolveToolCallEscalation`).
 */
export function createWorkflowSessionFactory(modelOverride?: string): (opts: SessionOptions) => Promise<Session> {
  return async (opts: SessionOptions): Promise<Session> => {
    const baseConfig = loadConfig();
    const persona = opts.persona;
    const personaStripped = persona === GLOBAL_PERSONA ? undefined : persona;

    // Only rebuild the config when a model override is actually in play.
    // The common case (no per-state and no --model) passes the base config
    // through unchanged.
    const override = modelOverride ?? opts.agentModelOverride;
    const effectiveOpts: SessionOptions = override
      ? {
          ...opts,
          config: withAgentModelId(baseConfig, override),
          agentModelOverride: override,
          persona: personaStripped,
          disableAutoApprove: true,
        }
      : { ...opts, config: baseConfig, persona: personaStripped, disableAutoApprove: true };

    try {
      // Narrow the options union for the typed overloads: the orchestrator
      // supplies `agentConversationId` for every Docker invocation (see
      // `executeAgentState` in orchestrator.ts), so the Docker branch is
      // safe. Builtin mode ignores the field whether set or not.
      if (effectiveOpts.mode?.kind === 'docker') {
        if (!effectiveOpts.agentConversationId) {
          throw new Error('workflow orchestrator must supply agentConversationId for docker sessions');
        }
        return await createSession({
          ...effectiveOpts,
          mode: effectiveOpts.mode,
          agentConversationId: effectiveOpts.agentConversationId,
        });
      }
      return await createSession({ ...effectiveOpts, mode: effectiveOpts.mode });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr(
        `${RED}${BOLD}[session-factory] Failed to create session for "${displayLine(persona ?? 'unknown')}":${RESET}`,
      );
      writeStderr(`${RED}  ${displayBlock(msg)}${RESET}`);
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Console tab handle
// ---------------------------------------------------------------------------

/** Creates a WorkflowTabHandle that writes to stdout. */
export function createConsoleTab(label: string): WorkflowTabHandle {
  return {
    write(text: string): void {
      writeStdout(`${DIM}[${displayLine(label)}]${RESET} ${displayBlock(text)}`);
    },
    setLabel(newLabel: string): void {
      writeStdout(`${DIM}[tab] label: ${displayLine(newLabel)}${RESET}`);
    },
    close(): void {
      writeStdout(`${DIM}[tab] ${displayLine(label)} closed${RESET}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Gate handling
// ---------------------------------------------------------------------------

export interface GateHandler {
  raiseGate: (gate: HumanGateRequest) => void;
  dismissGate: (workflowId: string, gateId: string) => void;
  waitForGate: () => Promise<HumanGateRequest>;
}

/** Creates a gate promise queue for interactive gate handling. */
export function createGateHandler(): GateHandler {
  const gatePromises: Array<{ resolve: (gate: HumanGateRequest) => void }> = [];
  let pendingGate: HumanGateRequest | undefined;

  function raiseGate(gate: HumanGateRequest): void {
    pendingGate = gate;
    const waiter = gatePromises.shift();
    if (waiter) waiter.resolve(gate);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function dismissGate(_workflowId: string, _gateId: string): void {
    pendingGate = undefined;
  }

  async function waitForGate(): Promise<HumanGateRequest> {
    if (pendingGate) return pendingGate;
    return new Promise<HumanGateRequest>((resolve) => {
      gatePromises.push({ resolve });
    });
  }

  return { raiseGate, dismissGate, waitForGate };
}

// ---------------------------------------------------------------------------
// Interactive gate prompt
// ---------------------------------------------------------------------------

/**
 * Prompts the user to resolve a human gate via readline. The returned
 * decision is bound to the gate that was shown (`gate.gateId`) and declares
 * the interactive CLI as its channel. Aborting `signal` withdraws the prompt
 * (the gate stopped waiting: decided elsewhere, released after its idle
 * timeout, or the run was stopped), and the result is then undefined.
 *
 * The summary embeds the run's last error and the previous agent's output,
 * and is shown at the moment a human decides, so it (and the ERROR line taken
 * from it) is printed with every control character as a visible escape: an
 * agent cannot erase a failing verdict or overwrite the options below it.
 */
export async function promptGateInteractive(
  gate: HumanGateRequest,
  rl: ReturnType<typeof createInterface>,
  signal?: AbortSignal,
): Promise<HumanGateEvent | undefined> {
  const bar = '='.repeat(50);
  const presented = [...gate.presentedArtifacts.keys()].map((name) => displayLine(name)).join(', ') || 'none';

  writeStdout('');
  writeStdout(`${BOLD}${YELLOW}${bar}${RESET}`);
  writeStdout(`${BOLD}${BG_YELLOW}${BLACK} HUMAN GATE: ${displayLine(gate.stateName)} ${RESET}`);

  if (gate.summary.includes('(error:')) {
    // [\s\S]: a line break (or CR) in the error must not suppress this line.
    const errorMatch = /\(error: ([\s\S]+)\)$/u.exec(gate.summary);
    if (errorMatch) {
      writeStderr(`${RED}${BOLD}ERROR: ${displayBlock(errorMatch[1])}${RESET}`);
    }
  }
  writeStdout(`${DIM}${displayBlock(gate.summary)}${RESET}`);
  writeStdout(`${DIM}Presented artifacts: ${presented}${RESET}`);
  writeStdout('');
  writeStdout(`${WHITE}Options:${RESET}`);

  const eventMap = new Map<string, HumanGateEventType>();
  for (const evt of gate.acceptedEvents) {
    switch (evt) {
      case 'APPROVE':
        writeStdout(`  ${GREEN}[a]${RESET} APPROVE`);
        eventMap.set('a', 'APPROVE');
        break;
      case 'FORCE_REVISION':
        writeStdout(`  ${YELLOW}[f]${RESET} FORCE_REVISION`);
        eventMap.set('f', 'FORCE_REVISION');
        break;
      case 'REPLAN':
        writeStdout(`  ${MAGENTA}[r]${RESET} REPLAN`);
        eventMap.set('r', 'REPLAN');
        break;
      case 'ABORT':
        writeStdout(`  ${RED}[x]${RESET} ABORT`);
        eventMap.set('x', 'ABORT');
        break;
    }
  }

  writeStdout('');
  const validKeys = [...eventMap.keys()].join('/');

  for (;;) {
    let answer: string;
    try {
      answer = await rl.question(`${BOLD}Your choice (${validKeys}): ${RESET}`, signal ? { signal } : {});
    } catch (err) {
      if (signal?.aborted) return undefined;
      throw err;
    }
    const key = answer.trim().toLowerCase();
    const eventType = eventMap.get(key);
    if (!eventType) {
      writeStdout(`${RED}Invalid choice. Please enter one of: ${validKeys}${RESET}`);
      continue;
    }

    if (eventType === 'FORCE_REVISION' || eventType === 'REPLAN') {
      const feedback = await promptRequiredFeedback(rl, eventType, signal);
      if (feedback === undefined) return undefined;
      return { gateId: gate.gateId, type: eventType, prompt: feedback, resolvedBy: 'cli' };
    }

    return { gateId: gate.gateId, type: eventType, resolvedBy: 'cli' };
  }
}

/**
 * FORCE_REVISION and REPLAN route the workflow back to an earlier state
 * and the next agent's prompt references the feedback directly, so empty
 * feedback would produce an incoherent re-entry prompt. When stdin is
 * closed (piped invocation, EOF) we abort instead of spinning.
 */
async function promptRequiredFeedback(
  rl: ReturnType<typeof createInterface>,
  eventType: 'FORCE_REVISION' | 'REPLAN',
  signal?: AbortSignal,
): Promise<string | undefined> {
  for (;;) {
    if (process.stdin.readableEnded) {
      throw new Error(`Feedback is required for ${eventType} but stdin was closed before a response was provided.`);
    }
    let answer: string;
    try {
      answer = await rl.question(`${CYAN}Feedback: ${RESET}`, signal ? { signal } : {});
    } catch (err) {
      if (signal?.aborted) return undefined;
      throw err;
    }
    const trimmed = answer.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    writeStdout(`${RED}Feedback is required for ${eventType}. Please enter a non-empty response.${RESET}`);
  }
}

// ---------------------------------------------------------------------------
// Interactive tool-call escalation prompt
// ---------------------------------------------------------------------------

/**
 * Prompts the operator to approve or deny a tool call that policy escalated
 * inside a workflow agent state. The terminal counterpart of the daemon's
 * `workflow escalation` command: the agent is blocked inside the call until
 * the decision lands or the escalation timeout expires.
 *
 * Every field shown comes from the agent's call (or quotes it), so all of it
 * goes through `toDisplayText` before reaching the terminal. Returns
 * `undefined` when `signal` aborts first (the escalation stopped being
 * pending: it expired, or was resolved through another route).
 */
export async function promptEscalationInteractive(
  escalation: WorkflowToolCallEscalation,
  rl: ReturnType<typeof createInterface>,
  signal?: AbortSignal,
): Promise<WorkflowToolCallEscalationDecision | undefined> {
  const bar = '='.repeat(50);
  const persona = escalation.persona ? ` (persona: ${toDisplayText(escalation.persona)})` : '';
  writeStdout('');
  writeStdout(`${BOLD}${YELLOW}${bar}${RESET}`);
  writeStdout(`${BOLD}${BG_YELLOW}${BLACK} ESCALATION: human approval required ${RESET}`);
  writeStdout(`${DIM}State:     ${toDisplayText(escalation.stateId)}${persona}${RESET}`);
  writeStdout(`  Tool:      ${toDisplayText(`${escalation.serverName}/${escalation.toolName}`)}`);
  writeStdout(
    `  Arguments: ${toDisplayText(JSON.stringify(escalation.arguments, null, 2), { multiline: true, maxLength: 4000 })}`,
  );
  if (escalation.context) {
    for (const [key, value] of Object.entries(escalation.context)) {
      writeStdout(`  ${toDisplayText(key)}: ${toDisplayText(value, { maxLength: 500 })}`);
    }
  }
  writeStdout(`  Reason:    ${toDisplayText(escalation.reason, { maxLength: 1000 })}`);
  // A human-only call (e.g. opening a passthrough domain) is approved once
  // and never whitelisted; the pipeline offers it no candidates anyway.
  const humanOnly = escalation.humanOnly === true;
  if (humanOnly) writeStdout(`  ${BOLD}Human decision required: approved once, never whitelisted.${RESET}`);
  const candidates = humanOnly ? [] : (escalation.whitelistCandidates ?? []);
  if (candidates.length > 0) {
    writeStdout('');
    writeStdout(`${WHITE}Whitelist matching calls (until the persona changes or the session ends):${RESET}`);
    candidates.forEach((candidate, index) => {
      writeStdout(`  ${GREEN}[${index + 1}]${RESET} ${toDisplayText(candidate.description, { maxLength: 300 })}`);
    });
  }
  writeStdout(`${BOLD}${YELLOW}${bar}${RESET}`);

  const choices = candidates.length > 0 ? `, or 1-${candidates.length} to approve and whitelist` : '';
  for (;;) {
    let answer: string;
    try {
      answer = await rl.question(`${BOLD}Approve? (y/N${choices}): ${RESET}`, signal ? { signal } : {});
    } catch (err) {
      if (signal?.aborted) return undefined;
      throw err;
    }
    const key = answer.trim().toLowerCase();
    if (key === 'y' || key === 'yes') return { decision: 'approved' };
    if (key === '' || key === 'n' || key === 'no') return { decision: 'denied' };
    const selection = Number(key);
    if (Number.isInteger(selection) && selection >= 1 && selection <= candidates.length) {
      return { decision: 'approved', whitelistSelection: selection - 1 };
    }
    writeStdout(`${RED}Invalid choice.${RESET}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle event printer
// ---------------------------------------------------------------------------

/** Prints a workflow lifecycle event to stdout/stderr. */
export function printLifecycleEvent(event: WorkflowLifecycleEvent): void {
  switch (event.kind) {
    case 'state_entered':
      writeStdout(`${BLUE}>>>${RESET} ${BOLD}State:${RESET} ${CYAN}${displayLine(event.state)}${RESET}`);
      break;
    case 'gate_raised':
      writeStdout(`${YELLOW}>>>${RESET} ${BOLD}Gate raised:${RESET} ${displayLine(event.gate.stateName)}`);
      break;
    case 'gate_dismissed':
      writeStdout(`${GREEN}[gate dismissed]${RESET} ${displayLine(event.gateId)}`);
      break;
    case 'tool_call_escalation_raised':
      writeStdout(
        `${YELLOW}>>>${RESET} ${BOLD}Escalation:${RESET} ${toDisplayText(`${event.escalation.serverName}/${event.escalation.toolName}`)} ${DIM}(${toDisplayText(event.escalation.reason, { maxLength: 200 })})${RESET}`,
      );
      break;
    case 'tool_call_escalation_resolved':
      writeStdout(`${GREEN}[escalation ${displayLine(event.outcome)}]${RESET} ${displayLine(event.escalationId)}`);
      break;
    case 'completed':
      writeStdout(`${GREEN}${BOLD}Workflow completed!${RESET}`);
      break;
    case 'failed': {
      const errorBar = '-'.repeat(50);
      writeStderr(`${RED}${errorBar}${RESET}`);
      writeStderr(`${RED}${BOLD}WORKFLOW ERROR:${RESET} ${displayBlock(event.error)}`);
      writeStderr(`${RED}${errorBar}${RESET}`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Summary printer
// ---------------------------------------------------------------------------

/** Prints end-of-workflow summary with phase, artifacts, and artifact dir. */
export function printSummary(orchestrator: WorkflowOrchestrator, workflowId: WorkflowId, artifactDir: string): void {
  const status = orchestrator.getStatus(workflowId);
  const bar = '='.repeat(50);
  writeStdout('');
  writeStdout(`${BOLD}${bar}${RESET}`);
  writeStdout(`${BOLD}WORKFLOW SUMMARY${RESET}`);
  writeStdout(bar);

  if (!status) {
    writeStdout(`${RED}No status available${RESET}`);
    return;
  }

  writeStdout(`Phase: ${BOLD}${status.phase}${RESET}`);
  if (status.phase === 'completed') {
    writeStdout(`Final artifacts: ${displayNames(Object.keys(status.result.finalArtifacts)) || 'none'}`);
  } else if (status.phase === 'aborted') {
    writeStdout(`Reason: ${displayBlock(status.reason)}`);
  } else if (status.phase === 'failed') {
    writeStdout(`Error: ${displayBlock(status.error)}`);
  }

  writeStdout(`Artifact directory: ${displayLine(artifactDir)}`);
  const contents = listArtifactOutputNames(artifactDir);
  if (contents.kind !== 'missing') writeStdout(`Contents: ${describeArtifactListing(contents, '(empty)')}`);
  writeStdout(bar);
}

/** Comma-joined names (artifact or file names, often agent-chosen), each escaped. */
function displayNames(names: readonly string[]): string {
  return names.map((name) => displayLine(name)).join(', ');
}

/**
 * One display line for the artifact outputs under a workspace's `.workflow`.
 * The agent controls that tree (it can make `.workflow` a file, a FIFO or a
 * symlink, and fill it with entries), so it is listed with the bounded,
 * no-follow {@link listArtifactOutputNames}, which never throws.
 */
function describeArtifactListing(listing: ArtifactOutputListing, none: string): string {
  if (listing.kind === 'missing') return none;
  if (listing.kind === 'not_directory') return '(not a directory)';
  const names = displayNames(listing.names) || none;
  return listing.truncated ? `${names} (listing truncated)` : names;
}

// ---------------------------------------------------------------------------
// Resume helpers
// ---------------------------------------------------------------------------

/** Prints checkpoint details before resume. */
export function printResumeInfo(baseDir: string, workflowId: WorkflowId, checkpoint: WorkflowCheckpoint): void {
  const workspacePath = checkpoint.workspacePath ?? resolve(baseDir, workflowId, 'workspace');
  const artifacts = describeArtifactListing(
    listArtifactOutputNames(resolve(workspacePath, WORKFLOW_ARTIFACT_DIR)),
    'none',
  );
  const errorInfo = checkpoint.context.lastError ?? 'none';

  writeStdout(`${BOLD}${CYAN}Resuming workflow from:${RESET} ${displayLine(baseDir)}`);
  writeStdout(`${DIM}Workflow ID: ${displayLine(workflowId)}${RESET}`);
  writeStdout(`${DIM}Last state: ${displayLine(String(checkpoint.machineState))}${RESET}`);
  writeStdout(`${DIM}Error: ${displayBlock(errorInfo)}${RESET}`);
  writeStdout(`${DIM}Checkpointed at: ${displayLine(checkpoint.timestamp)}${RESET}`);
  writeStdout(`${DIM}Artifacts present: ${artifacts}${RESET}`);
  writeStdout('');
}

/**
 * Picks the most-recent resumable workflow from a checkpoint store.
 *
 * Delegates enumeration + filtering + sorting to
 * {@link findResumableCheckpoints} (single source of truth shared with the
 * daemon). Adds the CLI-specific banner that lists every candidate when
 * more than one is present.
 *
 * Exits with code 1 if no resumable workflows are found.
 */
export function selectResumableWorkflow(
  checkpointStore: FileCheckpointStore,
  baseDir: string,
): { workflowId: WorkflowId; checkpoint: WorkflowCheckpoint } {
  let candidates;
  try {
    candidates = findResumableCheckpoints(baseDir, checkpointStore);
  } catch (err) {
    writeStderr(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`);
    process.exit(1);
  }

  if (candidates.length === 0) {
    writeStderr(`${RED}No resumable workflows found in this directory.${RESET}`);
    writeStderr(`${DIM}Expected checkpoint files at: <baseDir>/<workflowId>/checkpoint.json${RESET}`);
    process.exit(1);
  }

  if (candidates.length === 1) {
    return { workflowId: candidates[0].workflowId, checkpoint: candidates[0].checkpoint };
  }

  writeStdout(`${YELLOW}Found ${candidates.length} resumable workflows. Using most recent:${RESET}`);
  for (const { workflowId, checkpoint } of candidates) {
    const marker = workflowId === candidates[0].workflowId ? `${GREEN}>>` : `${DIM}  `;
    writeStdout(
      `${marker} ${displayLine(workflowId)} — state: ${displayLine(String(checkpoint.machineState))}, saved: ${displayLine(checkpoint.timestamp)}${RESET}`,
    );
  }
  writeStdout('');

  return { workflowId: candidates[0].workflowId, checkpoint: candidates[0].checkpoint };
}

/** Placeholder task of a synthesized checkpoint whose run left no task file to trust. */
const UNKNOWN_SYNTHESIZED_TASK = 'Unknown task (synthesized checkpoint)';

/** Largest task file a synthesized checkpoint takes its task description from. */
const MAX_SYNTHESIZED_TASK_BYTES = 1024 * 1024;

/**
 * The task description a run left in `<root>/<artifactDirName>/task/*.md` (the
 * first `.md` file by name), or `undefined` when there is none to trust.
 *
 * The tree is agent-writable and the text becomes the resumed agent's task, so
 * nothing in it is followed: the `task` directory must be a real directory
 * inside `root` (see {@link resolveArtifactOutputDir}), only regular files are
 * listed (a bounded listing that skips symlinks, FIFOs and devices without
 * opening them), and the chosen file is read no-follow, non-blocking and
 * bounded below `root`. A planted symlink therefore never makes a host file
 * (a key, say) the agent's task, and a FIFO never hangs the CLI.
 */
function readSynthesizedTaskDescription(root: string, artifactDirName: string): string | undefined {
  const taskDir = resolveArtifactOutputDir(root, resolve(root, artifactDirName), 'task');
  if (taskDir.kind !== 'ok') return undefined;
  const names: string[] = [];
  walkTreeNoFollow(
    taskDir.dir,
    { maxEntries: ARTIFACT_LISTING_MAX_ENTRIES, maxDepth: 0 },
    {
      file: (fullPath) => {
        const name = basename(fullPath);
        if (name.endsWith('.md')) names.push(name);
        return false;
      },
      enterDirectory: () => false,
    },
  );
  const first = names.sort().at(0);
  if (first === undefined) return undefined;
  try {
    const { bytes } = readUntrustedRegularFileBelow(root, `${artifactDirName}/task/${first}`, {
      maxBytes: MAX_SYNTHESIZED_TASK_BYTES,
    });
    return bytes.toString('utf8').trim();
  } catch {
    // Swapped for a link or special file after the listing, or oversized.
    return undefined;
  }
}

/**
 * Synthesizes a checkpoint for a workflow that ran before checkpointing.
 * Discovers the workflow ID from the directory structure, reads the task
 * from the task artifact, builds minimal context, and writes a checkpoint.
 *
 * The run's `.workflow` tree (or the older `artifacts`) is agent-writable:
 * the task file is read only through {@link readSynthesizedTaskDescription},
 * and the artifacts are the real directories a bounded, no-follow listing
 * finds, so an agent-planted file, FIFO or symlink there can neither crash
 * the CLI nor stand in for an artifact.
 */
export function synthesizeCheckpoint(
  baseDir: string,
  stateName: string,
  definitionPath: string,
  checkpointStore: FileCheckpointStore,
): { workflowId: WorkflowId; checkpoint: WorkflowCheckpoint } {
  // Only names a run could have: anything else can never be checkpointed.
  const entries = readdirSync(baseDir).filter((e) => {
    if (!isSafeWorkflowId(e)) return false;
    const full = resolve(baseDir, e);
    return existsSync(resolve(full, 'workspace', WORKFLOW_ARTIFACT_DIR)) || existsSync(resolve(full, 'artifacts'));
  });
  if (entries.length === 0) {
    writeStderr(`${RED}No workflow directory found in ${baseDir}${RESET}`);
    process.exit(1);
  }
  const workflowId = entries[0] as WorkflowId;

  const runDir = resolve(baseDir, workflowId);
  const workspacePath = resolve(runDir, 'workspace');
  const hasWorkspace = existsSync(resolve(workspacePath, WORKFLOW_ARTIFACT_DIR));
  // The pre-workspace layout kept the artifacts in `<run>/artifacts`.
  const artifactRoot = hasWorkspace ? workspacePath : runDir;
  const artifactDirName = hasWorkspace ? WORKFLOW_ARTIFACT_DIR : 'artifacts';
  const artifactDir = resolve(artifactRoot, artifactDirName);

  const taskDescription = readSynthesizedTaskDescription(artifactRoot, artifactDirName) ?? UNKNOWN_SYNTHESIZED_TASK;

  const artifacts: Record<string, string> = {};
  const listing = listArtifactOutputNames(artifactDir);
  if (listing.kind === 'ok') {
    for (const name of listing.names) artifacts[name] = resolve(artifactDir, name);
  }

  const context: WorkflowContext = {
    taskDescription,
    artifacts,
    round: 0,
    maxRounds: 3,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    totalTokens: 0,
    lastError: null,
    agentConversationsByState: {},
    previousAgentOutput: null,
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: {},
  };

  // The pre-workspace layout (`<run>/artifacts`) records no workspace, so
  // resume creates the default one; a recorded workspace must exist.
  const checkpoint: WorkflowCheckpoint = {
    machineState: stateName,
    context,
    timestamp: new Date().toISOString(),
    transitionHistory: [],
    definitionPath,
    runDir,
    ...(hasWorkspace ? { workspacePath } : {}),
  };

  checkpointStore.save(workflowId, checkpoint);

  writeStdout(
    `${YELLOW}Synthesized checkpoint at state "${displayLine(stateName)}" for workflow ${displayLine(workflowId)}${RESET}`,
  );
  writeStdout(`${DIM}Artifacts found: ${displayNames(Object.keys(artifacts))}${RESET}`);
  writeStdout(`${DIM}Task: ${displayLine(taskDescription, 80)}${RESET}`);
  writeStdout('');

  return { workflowId, checkpoint };
}

// ---------------------------------------------------------------------------
// Event loop
// ---------------------------------------------------------------------------

/** How often an open escalation prompt checks that its escalation is still pending. */
const ESCALATION_PROMPT_POLL_MS = 250;

/**
 * Polls orchestrator status and dispatches gate and tool-call escalation
 * prompts. Exits when the workflow reaches a terminal phase or the signal
 * is aborted.
 */
export async function runEventLoop(
  orchestrator: WorkflowOrchestrator,
  workflowId: WorkflowId,
  rl: ReturnType<typeof createInterface>,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    if (signal?.aborted) break;

    const status = orchestrator.getStatus(workflowId);
    if (!status) break;
    if (status.phase === 'completed' || status.phase === 'failed' || status.phase === 'aborted') break;

    if (status.phase === 'waiting_human') {
      const gate = status.gate;
      // The prompt is withdrawn once this raise stops waiting: decided
      // elsewhere (the web UI, an agent-driven caller), released after its
      // idle timeout, or the run was stopped. The loop then re-reads the
      // status and shows what is pending now, or exits.
      const stillWaiting = new AbortController();
      const waitingCheck = setInterval(() => {
        const current = orchestrator.getStatus(workflowId);
        if (current?.phase !== 'waiting_human' || current.gate.gateId !== gate.gateId || signal?.aborted) {
          stillWaiting.abort();
        }
      }, ESCALATION_PROMPT_POLL_MS);
      let event: HumanGateEvent | undefined;
      try {
        event = await promptGateInteractive(gate, rl, stillWaiting.signal);
      } finally {
        clearInterval(waitingCheck);
      }
      if (event === undefined) {
        writeStdout(`${DIM}Gate ${displayLine(gate.stateName)} is no longer waiting for this decision.${RESET}`);
        continue;
      }
      try {
        orchestrator.resolveGate(workflowId, event);
      } catch (err) {
        // The gate changed while the prompt was open (another decider acted,
        // or the run moved on). Nothing was applied; loop back to re-read the
        // status and show whatever is pending now.
        if (!isGateResolutionError(err)) throw err;
        writeStderr(`${YELLOW}Decision not applied (${err.code}): ${displayBlock(err.message)}${RESET}`);
      }
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }

    // A tool call blocked on human approval: prompt on the terminal. The
    // prompt is withdrawn as soon as the escalation stops being pending
    // (it timed out, the turn ended, or it was answered elsewhere), so the
    // operator never answers a call the agent was already told was denied.
    const escalation = orchestrator.listToolCallEscalations(workflowId).at(0);
    if (escalation) {
      const stillPending = new AbortController();
      const pendingCheck = setInterval(() => {
        const pending = orchestrator
          .listToolCallEscalations(workflowId)
          .some((candidate) => candidate.escalationId === escalation.escalationId);
        if (!pending || signal?.aborted) stillPending.abort();
      }, ESCALATION_PROMPT_POLL_MS);
      let decision: WorkflowToolCallEscalationDecision | undefined;
      try {
        decision = await promptEscalationInteractive(escalation, rl, stillPending.signal);
      } finally {
        clearInterval(pendingCheck);
      }
      if (
        decision === undefined ||
        !orchestrator.resolveToolCallEscalation(workflowId, escalation.escalationId, decision)
      ) {
        writeStdout(`${DIM}Escalation ${escalation.escalationId} is no longer pending (expired or resolved).${RESET}`);
      }
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }

    await new Promise((r) => setTimeout(r, 200));
  }
}

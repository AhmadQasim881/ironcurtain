import type {
  AgentStateDefinition,
  AgentTransitionDefinition,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowStateDefinition,
} from './types.js';
import { WORKFLOW_ARTIFACT_DIR } from './types.js';
import { applyLaneTemplate } from './lane-template.js';
import {
  MINIMAL_STATUS_INSTRUCTIONS,
  buildCommitToolInstructions,
  buildConditionalStatusInstructions,
  type WorkflowCommitPrompt,
} from './status-parser.js';
import { WORKFLOW_COMMIT_CALLABLE } from '../trusted-process/workflow-commit-tool.js';
import { parseArtifactRef } from './validate.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Per-invocation facts that change the prompt but are not part of the workflow context. */
export interface AgentPromptOptions {
  /**
   * The invocation re-runs a state that was interrupted: `resume()` restored
   * a checkpoint written when the state was entered and replays the state
   * from its start (at-least-once execution). Prepends {@link RESUME_NOTICE}.
   */
  readonly resumeReplay?: boolean;
  /**
   * Selects the status protocol the closing instructions describe: a
   * `workflow.commit` call for this invocation when set (the agent's
   * coordinator offers the tool), the YAML `agent_status` block otherwise.
   * Every prompt of one invocation carries the same id.
   */
  readonly commit?: WorkflowCommitPrompt;
}

/**
 * Prompt section for an agent state that the orchestrator re-runs after a
 * resume. Checkpoints are written on state entry, so a run stopped mid-state
 * resumes by executing that state again from the beginning; the earlier
 * attempt may already have changed the workspace or the outside world, and
 * the new conversation usually cannot see it. Static text: nothing from the
 * run is interpolated.
 */
export const RESUME_NOTICE =
  '## Resumed after an interruption\n\n' +
  'This workflow was resumed from a checkpoint taken when this step started, so the step is running again from ' +
  'the beginning. An earlier attempt may already have done some or all of this work before it was interrupted, ' +
  'and your conversation history may not show it.\n\n' +
  'Before you change anything:\n' +
  '- Inspect the workspace and the expected output directories for work an earlier attempt already did. Keep what ' +
  'is sound and finish what is missing instead of starting over.\n' +
  '- Do not repeat actions outside the workspace that an earlier attempt may already have taken: pushing commits ' +
  'or branches, opening or commenting on pull requests or issues, sending emails or messages, or any other ' +
  'external change. First check whether the action already happened (for example, whether the branch is already ' +
  'pushed or the comment already exists) and only do what is still missing.';

/**
 * Assembles the command string sent to an agent session.
 *
 * Two modes:
 * - **First visit**: Full prompt with workflow context, previous agent
 *   output, artifact path references, role instructions, expected outputs,
 *   and status format. Used when entering a state for the first time.
 * - **Re-visit**: Abbreviated prompt with only what's new: previous agent
 *   output, round number, human feedback, and status format. The agent
 *   already has role instructions and task context via --continue.
 *
 * Either mode starts with {@link RESUME_NOTICE} when `options.resumeReplay`
 * is set.
 *
 * No file I/O is performed. The agent reads artifact content itself
 * using its filesystem tools.
 *
 * `options.commit` selects the status protocol the closing instructions
 * describe: a `workflow.commit` call for the given invocation when set (the
 * agent's coordinator offers the tool), the YAML `agent_status` block
 * otherwise.
 */
export function buildAgentCommand(
  stateId: string,
  stateConfig: AgentStateDefinition,
  context: WorkflowContext,
  definition: WorkflowDefinition,
  options: AgentPromptOptions = {},
): string {
  const isReVisit = stateConfig.freshSession === false && (context.visitCounts[stateId] ?? 0) > 1;
  if (isReVisit) {
    return buildReVisitPrompt(stateId, stateConfig, context, definition, options);
  }
  return buildFirstVisitPrompt(stateId, stateConfig, context, definition, options);
}

export interface AgentReplacementContext {
  readonly incompleteOutputExcerpts: readonly string[];
}

/** Builds a full first-visit prompt for a fresh replacement conversation (same status protocol as the original). */
export function buildAgentReplacementCommand(
  stateId: string,
  stateConfig: AgentStateDefinition,
  context: WorkflowContext,
  definition: WorkflowDefinition,
  recovery: AgentReplacementContext,
  options: AgentPromptOptions = {},
): string {
  return buildFirstVisitPrompt(stateId, stateConfig, context, definition, options, recovery);
}

// ---------------------------------------------------------------------------
// First-visit prompt
// ---------------------------------------------------------------------------

/**
 * Full prompt for the first time an agent state is entered.
 *
 * Layout:
 *   1. Resume notice (only when the state is replayed after a resume)
 *   2. Human feedback (if any)
 *   3. Workflow Context (task as quoted text)
 *   4. Previous agent output
 *   5. Input artifacts
 *   6. Your Role
 *   7. Expected outputs
 *   8. Read-only workspace (only for `workspaceAccess: read-only` states)
 *   9. Handoff clause
 *  10. Status block instructions
 *
 * The resume notice comes first so the agent checks what an interrupted
 * attempt already did before it acts on anything below. Human feedback
 * follows so FORCE_REVISION feedback takes precedence over previous
 * output. Role is near the end for recency bias.
 */
function buildFirstVisitPrompt(
  stateId: string,
  stateConfig: AgentStateDefinition,
  context: WorkflowContext,
  definition: WorkflowDefinition,
  options: AgentPromptOptions,
  recovery?: AgentReplacementContext,
): string {
  const sections: string[] = [];
  const isSameStateReEntry = context.previousStateName !== null && context.previousStateName === stateId;

  appendResumeNotice(sections, options);
  appendHumanFeedback(sections, context.humanPrompt, isSameStateReEntry);

  sections.push(
    '## Workflow Context\n\n' +
      'You are one agent in a multi-agent workflow. The overall workflow goal is:\n\n' +
      `> ${context.taskDescription}\n\n` +
      'Your specific role and instructions follow below. Focus on YOUR assigned responsibilities, not the overall goal.',
  );

  appendPreviousOutput(sections, context, isSameStateReEntry, 'Output from');

  appendInputArtifacts(sections, stateConfig.inputs);

  sections.push(`## Your Role\n\n${applyLaneTemplate(stateConfig.prompt, context)}`);

  appendExpectedOutputs(sections, stateConfig.outputs);

  appendReadOnlyWorkspace(sections, stateConfig, definition);

  const handoff = buildHandoffClause(stateConfig.transitions, definition);
  if (handoff) {
    sections.push(handoff);
  }

  if (recovery) {
    const excerpts = recovery.incompleteOutputExcerpts
      .map((excerpt, index) => `### Prior incomplete turn ${index + 1}\n\n${excerpt}`)
      .join('\n\n');
    sections.push(
      '## Recovery handoff\n\n' +
        'A previous executor made progress but did not commit a valid routing status. Independently inspect and finish the state, then choose the correct verdict. Do not assume the prior executor had finished. Inspect the durable workspace and expected output directories directly for any files it produced.' +
        (excerpts ? `\n\nBounded excerpts from its incomplete output:\n\n${excerpts}` : ''),
    );
  }

  sections.push(buildStatusInstructions(stateConfig.transitions, options.commit));

  return sections.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Shared section helpers
// ---------------------------------------------------------------------------

/** Appends {@link RESUME_NOTICE} when the invocation replays an interrupted state. */
function appendResumeNotice(sections: string[], options: AgentPromptOptions): void {
  if (options.resumeReplay === true) sections.push(RESUME_NOTICE);
}

/**
 * Appends the human-feedback section. Same-state re-entry uses a
 * self-revision framing so the agent recognizes the feedback as directed
 * at its own prior output rather than a new task.
 */
function appendHumanFeedback(sections: string[], humanPrompt: string | null, isSameStateReEntry: boolean): void {
  if (!humanPrompt) return;
  const heading = isSameStateReEntry
    ? '## Human Feedback — revise your previous work\n\n' +
      'You are being asked to revise your previous work based on this feedback:\n\n'
    : '## Human Feedback\n\n';
  sections.push(heading + humanPrompt);
}

/**
 * Appends the previous-output section. Same-state re-entry uses the
 * "Your Previous Output" self-revision framing. Cross-state routing uses
 * the "Scoping from the previous agent" framing with separate Directive
 * and Notes subsections; see `buildScopingSection`.
 */
function appendPreviousOutput(
  sections: string[],
  context: WorkflowContext,
  isSameStateReEntry: boolean,
  crossStateHeading: 'Output from' | 'New Input from',
): void {
  if (!context.previousStateName) return;

  if (isSameStateReEntry) {
    if (!context.previousAgentOutput) return;
    sections.push(
      `## Your Previous Output\n\n` +
        `This is your own prior output. Revise it to address the human feedback above.\n\n` +
        context.previousAgentOutput,
    );
    return;
  }

  const scoping = buildScopingSection(context, crossStateHeading);
  if (scoping) sections.push(scoping);
}

/**
 * Builds the cross-state "Scoping from the previous agent" section, rendering
 * the directive body and the `notes` summary as labeled sub-sections.
 * Returns `null` when both are empty so the caller omits the whole block.
 */
function buildScopingSection(
  context: WorkflowContext,
  crossStateHeading: 'Output from' | 'New Input from',
): string | null {
  const trimmedBody = context.previousAgentOutput?.trim() ?? '';
  const trimmedNotes = context.previousAgentNotes?.trim() ?? '';
  if (!trimmedBody && !trimmedNotes) return null;

  const header =
    `## ${crossStateHeading} ${context.previousStateName}\n\n` +
    `The ${context.previousStateName} state produced the following output. ` +
    `Treat this as the authoritative scoping for what to do this round — ` +
    `if it is missing or vague, STOP and report back rather than improvising.`;

  const parts: string[] = [header];
  if (trimmedBody) {
    parts.push(`### Directive\n\n${trimmedBody}`);
  }
  if (trimmedNotes) {
    parts.push(`### Notes\n\n${trimmedNotes}`);
  }
  return parts.join('\n\n');
}

/** Appends a single `## Inputs` section listing declared inputs as bullets. */
function appendInputArtifacts(sections: string[], inputs: readonly string[]): void {
  if (inputs.length === 0) return;

  const parsed = inputs.map((ref) => parseArtifactRef(ref));
  const hasOptional = parsed.some((p) => p.isOptional);

  const preamble = hasOptional
    ? `Read these from \`${WORKFLOW_ARTIFACT_DIR}/<name>/\` in your workspace. Optional inputs (marked optional) may be absent — skip them if so.`
    : `Read these from \`${WORKFLOW_ARTIFACT_DIR}/<name>/\` in your workspace.`;

  const bullets = parsed
    .map(({ name, isOptional }) => `- \`${name}\` (${isOptional ? 'optional' : 'required'})`)
    .join('\n');

  sections.push(`## Inputs\n\n${preamble}\n\n${bullets}`);
}

/** Appends expected outputs section if there are any outputs. */
function appendExpectedOutputs(sections: string[], outputs: readonly string[]): void {
  if (outputs.length > 0) {
    const outputList = outputs.map((o) => `- \`${WORKFLOW_ARTIFACT_DIR}/${o}/\``).join('\n');
    sections.push(`## Expected Outputs\n\nCreate the following artifact directories in your workspace:\n${outputList}`);
  }
}

/** True when the workflow's agent states run in Docker (the default mode). */
function runsInDocker(definition: WorkflowDefinition): boolean {
  return (definition.settings?.mode ?? 'docker') === 'docker';
}

/**
 * How a read-only Docker state writes its outputs: its own tools cannot write
 * the read-only `/workspace` mount, the filesystem MCP tool can (in its output
 * directories only).
 */
const READ_ONLY_DOCKER_WRITE_INSTRUCTIONS =
  'The workspace is mounted read-only, so your own file-writing and editing tools fail there. Write each output ' +
  'file with the `filesystem.write_file` tool through `execute_code`, using its `/workspace/...` path, for example ' +
  "`filesystem.write_file({ path: '/workspace/.workflow/<output>/<file>.md', content })`.";

/**
 * Appends the read-only workspace section for a `workspaceAccess: read-only`
 * state (see `AgentStateDefinition.workspaceAccess`): what it may change, and
 * in Docker mode how to write its outputs.
 */
function appendReadOnlyWorkspace(
  sections: string[],
  stateConfig: AgentStateDefinition,
  definition: WorkflowDefinition,
): void {
  if (stateConfig.workspaceAccess !== 'read-only') return;
  const writable =
    stateConfig.outputs.length > 0
      ? `except inside your expected output directories:\n${stateConfig.outputs
          .map((o) => `- \`${WORKFLOW_ARTIFACT_DIR}/${o}/\``)
          .join('\n')}`
      : 'anywhere: this step has no output directories.';
  const body =
    'This step runs with a read-only workspace. You may read every file, but every attempt to create, change or ' +
    `delete a file is refused ${writable}\n\n` +
    (runsInDocker(definition) ? `${READ_ONLY_DOCKER_WRITE_INSTRUCTIONS}\n\n` : '') +
    // "git commits", not a bare "commit": the closing instructions may ask
    // the state to commit its result with `workflow.commit`, which writes
    // nothing into the workspace and stays required.
    'Do not try to build, test, format or install anything, or make git commits: each would write into the ' +
    'workspace. Report what you find in your outputs instead.';
  sections.push(`## Read-only workspace\n\n${body}`);
}

// ---------------------------------------------------------------------------
// Re-visit prompt (same-state re-invocation)
// ---------------------------------------------------------------------------

/**
 * Abbreviated prompt for re-entering a previously visited state.
 * The agent already has role instructions and task context in its
 * conversation history via --continue, so only new information is sent:
 * the resume notice (on a replay after resume), human feedback, previous
 * output, round number, and status instructions.
 */
function buildReVisitPrompt(
  stateId: string,
  stateConfig: AgentStateDefinition,
  context: WorkflowContext,
  definition: WorkflowDefinition,
  options: AgentPromptOptions,
): string {
  const sections: string[] = [];
  const isSameStateReEntry = context.previousStateName !== null && context.previousStateName === stateId;

  appendResumeNotice(sections, options);
  appendHumanFeedback(sections, context.humanPrompt, isSameStateReEntry);
  appendPreviousOutput(sections, context, isSameStateReEntry, 'New Input from');

  const stateRound = context.visitCounts[stateId] ?? 1;
  sections.push(
    `## Round\n\nThis is round ${stateRound} ` +
      `of ${context.maxRounds}. ` +
      `Please address the feedback above and update your outputs.`,
  );

  // The conversation already explains the read-only workspace; repeat it in
  // one line so a long revision loop cannot lose it.
  if (stateConfig.workspaceAccess === 'read-only') {
    sections.push(
      '## Read-only workspace\n\nYour workspace is still read-only: change files only inside your expected output ' +
        `directories${runsInDocker(definition) ? ', with `filesystem.write_file` through `execute_code`' : ''}.`,
    );
  }

  // A re-visit is a new invocation: the instructions carry its own id, never
  // the id of the visit whose conversation is being continued.
  sections.push(buildStatusInstructions(stateConfig.transitions, options.commit));

  return sections.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Status instruction selection
// ---------------------------------------------------------------------------

/** Human-readable labels for named guard conditions. */
export const GUARD_LABELS: Record<string, string> = {
  isRoundLimitReached: 'round limit reached',
  isStalled: 'stall detected',
  isPassed: 'all checks passed',
};

/**
 * Selects the appropriate status block instructions for a state's transitions.
 *
 * - With `commit`: the `workflow.commit` call for that invocation (the
 *   commit-tool protocol), with the same verdict guidance.
 * - Unconditional transitions (no `when`, no `guard`) get minimal instructions.
 * - Conditional transitions get instructions with extracted verdict values.
 */
export function buildStatusInstructions(
  transitions: readonly AgentTransitionDefinition[],
  commit?: WorkflowCommitPrompt,
): string {
  if (commit) {
    return buildCommitToolInstructions(transitions, GUARD_LABELS, commit);
  }
  const hasConditional = transitions.some((t) => t.when != null || t.guard != null);
  if (!hasConditional) {
    return MINIMAL_STATUS_INSTRUCTIONS;
  }
  return buildConditionalStatusInstructions(transitions, GUARD_LABELS);
}

// ---------------------------------------------------------------------------
// Handoff clause
// ---------------------------------------------------------------------------

/**
 * Builds the "What happens with your output" section for first-visit prompts.
 * Returns `undefined` when there are no transitions to describe.
 */
export function buildHandoffClause(
  transitions: readonly AgentTransitionDefinition[],
  definition: WorkflowDefinition,
): string | undefined {
  if (transitions.length === 0) return undefined;

  const lines = transitions.map((t) => {
    const condition = formatTransitionCondition(t);
    const desc = (definition.states[t.to] as WorkflowStateDefinition | undefined)?.description ?? t.to;
    return `- ${condition} \u2192 ${t.to} (${desc})`;
  });

  return (
    '## What happens with your output\n\n' +
    'The next step depends on the transition conditions below:\n' +
    lines.join('\n')
  );
}

/** Formats the condition portion of a transition line. */
function formatTransitionCondition(transition: AgentTransitionDefinition): string {
  if (transition.when) {
    const pairs = Object.entries(transition.when).map(([k, v]) => `${k}=${String(v)}`);
    return pairs.join(', ');
  }
  if (transition.guard) {
    const label = GUARD_LABELS[transition.guard] ?? transition.guard;
    return label;
  }
  return '(default)';
}

// ---------------------------------------------------------------------------
// Artifact re-prompt
// ---------------------------------------------------------------------------

/**
 * Builds a re-prompt for missing artifacts. Uses relative paths only
 * (no host-absolute paths, since Docker agents see /workspace).
 *
 * @param missing - artifact names that were not created
 * @param transitions - optional state transitions; when provided, status
 *   instructions include the correct verdict values for conditional routing
 * @param commit - set when the agent commits through `workflow.commit`:
 *   a state that has `committed` is told its verdict stands; one that has
 *   not gets the commit instructions instead of the YAML block's
 * @param readOnly - set for a `workspaceAccess: read-only` state (see
 *   {@link artifactRepromptReadOnly}): the re-prompt repeats how such a
 *   state writes its outputs
 */
export function buildArtifactReprompt(
  missing: readonly string[],
  transitions?: readonly AgentTransitionDefinition[],
  commit?: WorkflowCommitPrompt & { readonly committed: boolean },
  readOnly?: { readonly docker: boolean },
): string {
  const paths = missing.map((name) => `  - \`${WORKFLOW_ARTIFACT_DIR}/${name}/\``);
  const statusInstructions = commit?.committed
    ? `This state has already committed its verdict, which stands: do not call \`${WORKFLOW_COMMIT_CALLABLE}\` again.`
    : commit
      ? buildStatusInstructions(transitions ?? [], commit)
      : transitions
        ? buildStatusInstructions(transitions)
        : MINIMAL_STATUS_INSTRUCTIONS;
  // A read-only state that missed its outputs most likely tried its own
  // tools on the read-only mount: say again how to write them.
  const readOnlyNote =
    readOnly === undefined
      ? ''
      : readOnly.docker
        ? `Your workspace is read-only. ${READ_ONLY_DOCKER_WRITE_INSTRUCTIONS}\n\n`
        : 'Your workspace is read-only except for these output directories.\n\n';
  return (
    'The following required output artifacts were not created in your workspace:\n' +
    paths.join('\n') +
    '\n\nPlease create them now. Each artifact should be a ' +
    'directory containing at least one file.\n\n' +
    readOnlyNote +
    statusInstructions
  );
}

/**
 * The read-only context {@link buildArtifactReprompt} needs for a state, or
 * `undefined` for a read-write state.
 */
export function artifactRepromptReadOnly(
  stateConfig: AgentStateDefinition,
  definition: WorkflowDefinition,
): { readonly docker: boolean } | undefined {
  return stateConfig.workspaceAccess === 'read-only' ? { docker: runsInDocker(definition) } : undefined;
}

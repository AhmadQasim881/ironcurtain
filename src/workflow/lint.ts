/**
 * Workflow semantic linter. Receives a `WorkflowDefinition` that has
 * already passed `validateDefinition()` and returns `Diagnostic`s for
 * higher-level smells (cross-cutting or requiring external context)
 * that structural validation deliberately leaves alone.
 *
 * See `docs/designs/workflow-semantic-linter-v2.md` for each check's
 * rationale.
 */
import { resolve } from 'node:path';
import type {
  WorkflowDefinition,
  WorkflowStateDefinition,
  AgentStateDefinition,
  AgentTransitionDefinition,
  HumanGateTransitionDefinition,
} from './types.js';
import { GLOBAL_PERSONA, DEFAULT_CONTAINER_SCOPE } from './types.js';
import type { DockerAgent } from '../config/user-config.js';
import { parseModelId, type ProviderId } from '../config/model-id.js';
import { resolveStateDockerAgent } from './agent-harness.js';
import {
  collectTransitionTargets,
  findReachableStates,
  isExecutableState,
  iterateSkillRefIssues,
  parseArtifactRef,
  runsCommandsOnHost,
  usesSharedContainer,
  usesVerdictEdges,
} from './validate.js';
import { FAN_OUT_LANES_WARNING_THRESHOLD, resolveFanOutWorkers } from './lane-template.js';
import { getWorkflowPackageDir } from './discovery.js';
import { ACTIONABLE_DISCOVERY_REASONS, discoverSkillsWithErrors } from '../skills/discovery.js';
import type { ResolvedSkill, SkillDiscoveryError } from '../skills/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Diagnostic codes.
 *
 * WF008 occupies the slot previously used for a raw-YAML check that
 * `maxVisits` is only declared on agent states. That check now throws
 * `WorkflowValidationError` before lint runs, so it never emits a WF code;
 * the slot is reclaimed here for the visit-cap transition-ordering rule.
 * WF009 is retired for the same reason (state-ID regex is a validation
 * error) and must not be reused.
 *
 * WF005 (parallelKey + worktree needs gitRepoPath) is retired: the
 * `parallelKey` schema field was removed as unused, so the trigger
 * condition can no longer fire. Must not be reused.
 *
 * WF010 covers two related concerns under a single code:
 *   1. State-scoped: an agent state's `skills:` entry is invalid or
 *      doesn't match any discoverable skill in the package.
 *   2. Package-scoped: a `SKILL.md` under the workflow package's
 *      `skills/` tree is malformed, unreadable, or missing required
 *      frontmatter fields. These are surfaced even when no state
 *      references the broken skill, so authors get fast feedback on a
 *      typo in frontmatter rather than discovering it via a "skill not
 *      found" message at runtime.
 *
 * Both concerns are skipped cleanly when the lint caller did not
 * supply a `workflowFilePath` (the package dir is the only place skill
 * manifests can live).
 *
 * WF013 (fan-out maxRounds budget) and WF014 (fan-out child-bounds) are
 * sibling fan-out checks split apart so each carries one concern. WF014
 * previously flagged non-barrier fan-out joins; that is now a parse-time
 * rejection (`FanOutDefinition.join` is the literal `'barrier'`), so the
 * lint became unreachable and the number was reclaimed for child-bounds.
 *
 * WF015 flags every deterministic state that runs commands on the host.
 * Validation already refuses such a state unless it sets `host: true`, so
 * the lint only ever sees acknowledged ones; it keeps the risk in front of
 * the author at every `workflow lint` and pre-flight.
 *
 * WF016–WF018 flag definition fields that validate but do nothing, so an
 * author does not rely on behaviour that never happens:
 *   - WF016: a visit cap that is never checked (`maxVisits` without an
 *     `isStateVisitLimitReached` transition on the same state, or the
 *     reverse, or `maxVisits` on a fan-out parent).
 *   - WF017: legacy fields kept only so existing manifests still load
 *     (`settings.gitRepoPath`, agent `worktree`, terminal `cleanup`).
 *   - WF018: lane scheduling metadata (`schedule`, `schedule.resources`)
 *     for the evaluation-slot pool, which is not implemented yet.
 *
 * WF019 flags a fan-out state wider than `FAN_OUT_LANES_WARNING_THRESHOLD`
 * lanes. Validation caps lanes at `MAX_FAN_OUT_LANES`; below that cap the
 * width is legal but likely oversubscribes the container (shared mode) or
 * queues on the agent concurrency cap (otherwise).
 *
 * WF020 flags an agent state whose effective model names a provider its
 * agent harness (`dockerAgent`) does not call natively. An unknown harness
 * name is a validation error, not a lint, so it has no code here.
 */
export type DiagnosticCode =
  | 'WF001'
  | 'WF002'
  | 'WF003'
  | 'WF004'
  | 'WF006'
  | 'WF007'
  | 'WF008'
  | 'WF010'
  | 'WF011'
  | 'WF012'
  | 'WF013'
  | 'WF014'
  | 'WF015'
  | 'WF016'
  | 'WF017'
  | 'WF018'
  | 'WF019'
  | 'WF020';
export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly stateId?: string;
  readonly hint?: string;
}

/**
 * Injected facts the linter cannot derive from the definition alone.
 *
 * Kept minimal: methods/fields are added only when a new check
 * genuinely needs external context.
 */
export interface LintContext {
  /** Returns true iff the named persona is installed locally. */
  personaExists(name: string): boolean;
  /**
   * Absolute path to the workflow file being linted, when known. Used
   * by checks that resolve co-packaged resources off the manifest's
   * directory (currently WF010 — skill references). Lint callers that
   * do not have a path on hand (e.g., synthesized definitions in tests)
   * may omit this; rules that need it skip cleanly when absent.
   */
  readonly workflowFilePath?: string;
}

export type LintResult = readonly Diagnostic[];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs all registered checks against `def`. Pure: same input => same
 * output. Diagnostics come back in a stable order (by check, then by state
 * declaration order).
 */
export function lintWorkflow(def: WorkflowDefinition, ctx: LintContext): LintResult {
  const reachable = findReachableStates(def.initial, def.states);
  const reachableAgentOutputs = collectReachableAgentOutputs(def, reachable);

  return [
    ...checkUnreachableTerminal(def, reachable),
    ...checkUnversionedArtifacts(def, reachableAgentOutputs),
    ...checkTerminalOutputs(def, reachable, reachableAgentOutputs),
    ...checkHumanGatePresent(def, reachable, reachableAgentOutputs),
    ...checkMaxRoundsHasGuard(def),
    ...checkPersonaExists(def, ctx),
    ...checkVisitCapTransitionOrder(def),
    ...checkContainerScopePopulatedByAgent(def),
    ...checkVerdictEdgesHaveResultFile(def),
    ...checkFanOutBudget(def),
    ...checkFanOutChildBounds(def),
    ...checkSkillReferencesAndManifests(def, ctx),
    ...checkHostDeterministicStates(def),
    ...checkVisitCapIsChecked(def),
    ...checkIgnoredLegacyFields(def),
    ...checkUnimplementedSchedule(def),
    ...checkFanOutWidth(def),
    ...checkModelMatchesHarness(def),
  ];
}

export function countBySeverity(diagnostics: readonly Diagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === 'error') errors++;
    else warnings++;
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Output artifacts produced by reachable agent states. Terminal
 * `outputs:` are declarations of expected arrival state, not production
 * (no runtime code writes them), so they don't count: WF002/WF003/WF004
 * all ask "is this name actually produced?"
 */
function collectReachableAgentOutputs(def: WorkflowDefinition, reachable: ReadonlySet<string>): Set<string> {
  const outputs = new Set<string>();
  for (const [stateId, state] of Object.entries(def.states)) {
    if (!reachable.has(stateId)) continue;
    if (state.type === 'agent') {
      for (const o of state.outputs) outputs.add(o);
    }
  }
  return outputs;
}

function isAgentState(state: WorkflowStateDefinition): state is AgentStateDefinition {
  return state.type === 'agent';
}

// ---------------------------------------------------------------------------
// WF001 — State can't reach any terminal
// ---------------------------------------------------------------------------

function checkUnreachableTerminal(def: WorkflowDefinition, reachable: ReadonlySet<string>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const stateId of reachable) {
    const state = def.states[stateId];
    if (state.type === 'terminal') continue;

    const cone = findReachableStates(stateId, def.states);
    let touchesTerminal = false;
    for (const target of cone) {
      if (def.states[target].type === 'terminal') {
        touchesTerminal = true;
        break;
      }
    }

    if (!touchesTerminal) {
      diagnostics.push({
        code: 'WF001',
        severity: 'error',
        stateId,
        message: `State "${stateId}" cannot reach any terminal state — the workflow will loop forever if it enters this state.`,
        hint: 'Add a transition (guarded or unconditional) whose forward graph eventually reaches a terminal state.',
      });
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF002 — unversionedArtifacts entry not produced by any state
// ---------------------------------------------------------------------------

function checkUnversionedArtifacts(def: WorkflowDefinition, produced: ReadonlySet<string>): Diagnostic[] {
  const entries = def.settings?.unversionedArtifacts ?? [];
  if (entries.length === 0) return [];

  const diagnostics: Diagnostic[] = [];
  for (const name of entries) {
    if (!produced.has(name)) {
      diagnostics.push({
        code: 'WF002',
        severity: 'warning',
        message: `settings.unversionedArtifacts entry "${name}" is not produced by any state — it will be silently versioned.`,
        hint: "Remove the entry, or add the artifact to some agent state's outputs list.",
      });
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF003 — terminal.outputs entry not produced by any reachable state
// ---------------------------------------------------------------------------

function checkTerminalOutputs(
  def: WorkflowDefinition,
  reachable: ReadonlySet<string>,
  produced: ReadonlySet<string>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [stateId, state] of Object.entries(def.states)) {
    if (state.type !== 'terminal') continue;
    if (!reachable.has(stateId)) continue;

    for (const name of state.outputs ?? []) {
      if (!produced.has(name)) {
        diagnostics.push({
          code: 'WF003',
          severity: 'warning',
          stateId,
          message: `Terminal "${stateId}" lists output "${name}" which is not produced by any reachable state.`,
          hint: 'Remove the output from the terminal, or ensure a reachable agent state produces it.',
        });
      }
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF004 — human_gate present entry not produced by any reachable state
// ---------------------------------------------------------------------------

function checkHumanGatePresent(
  def: WorkflowDefinition,
  reachable: ReadonlySet<string>,
  produced: ReadonlySet<string>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [stateId, state] of Object.entries(def.states)) {
    if (state.type !== 'human_gate') continue;
    if (!reachable.has(stateId)) continue;

    for (const entry of state.present ?? []) {
      const { name } = parseArtifactRef(entry);
      if (!produced.has(name)) {
        diagnostics.push({
          code: 'WF004',
          severity: 'error',
          stateId,
          message: `Human gate "${stateId}" presents artifact "${name}" which is not produced by any reachable state — the human will approve without seeing it.`,
          hint: 'Fix the artifact name, or ensure a reachable agent state produces it.',
        });
      }
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF006 — maxRounds set without any isRoundLimitReached guard
// ---------------------------------------------------------------------------

const ROUND_LIMIT_GUARD = 'isRoundLimitReached';

function checkMaxRoundsHasGuard(def: WorkflowDefinition): Diagnostic[] {
  if (def.settings?.maxRounds === undefined) return [];

  for (const state of Object.values(def.states)) {
    if (!isExecutableState(state)) continue;
    for (const t of state.transitions) {
      if (t.guard === ROUND_LIMIT_GUARD) return [];
    }
  }

  return [
    {
      code: 'WF006',
      severity: 'warning',
      message: `settings.maxRounds=${def.settings.maxRounds} is set but no transition uses the "isRoundLimitReached" guard — the limit is silently ignored.`,
      hint: 'Add a transition with guard: isRoundLimitReached to an iterative state, or remove maxRounds.',
    },
  ];
}

// ---------------------------------------------------------------------------
// WF007 — agent persona not installed
// ---------------------------------------------------------------------------

/**
 * Flags any agent state whose `persona` is neither the reserved
 * `GLOBAL_PERSONA` alias nor an installed persona directory.
 *
 * Emitted as a warning (not error) because personas are user-local state:
 * a workflow author may legitimately ship a definition that depends on
 * a persona the user hasn't installed yet. `--strict-lint` promotes this
 * to a failure.
 */
function checkPersonaExists(def: WorkflowDefinition, ctx: LintContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [stateId, state] of Object.entries(def.states)) {
    if (!isAgentState(state)) continue;
    const persona = state.persona;
    if (persona === GLOBAL_PERSONA) continue;
    if (ctx.personaExists(persona)) continue;

    diagnostics.push({
      code: 'WF007',
      severity: 'warning',
      stateId,
      message: `Agent state "${stateId}" references persona "${persona}" which is not installed locally — session creation will fail at runtime.`,
      hint: `Install the persona with: ironcurtain persona create ${persona}, or change the state's persona to "${GLOBAL_PERSONA}".`,
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF008 — visit-cap guard must precede loop-continuing transitions
// ---------------------------------------------------------------------------

/**
 * Verdict values that indicate an approval-style exit from a bounded loop.
 * Transitions taken on these verdicts represent the success path out of the
 * loop, so a visit-cap guard is legitimately ordered AFTER them (on the cap
 * visit, if the agent still emits `approved`, we take the approval exit
 * rather than escalating).
 *
 * Any other `when` verdict (rejected, rejected_build, blocked, or any
 * workflow-specific loop-continuation verdict) must NOT precede the cap
 * guard: if it did, the cap would never fire and the loop is effectively
 * unbounded except for the workflow-wide `maxRounds`. The exception is a
 * transition that leaves the bounded loop: its target can lead back into the
 * capped state only through a `resetVisitCounts` naming that state
 * ({@link returnsOnlyThroughVisitReset}).
 */
const VISIT_CAP_GUARD = 'isStateVisitLimitReached';
const APPROVAL_EXIT_VERDICTS: ReadonlySet<string> = new Set(['approved', 'complete', 'done', 'success', 'passed']);

/**
 * Returns true if `t.when` represents an approval-style exit. Approval
 * exits are allowed to precede the visit-cap guard. Everything else is
 * considered loop-continuing for the purposes of WF008 — including:
 *   - no `when` clause at all (always matches)
 *   - empty `when: {}` (always matches; flagged separately by validation)
 *   - a verdict not in the approval allowlist
 *   - a `when` clause that sets fields other than `verdict` (future-
 *     proofing: those match something other than the approval verdict)
 */
function isApprovalExitTransition(t: AgentTransitionDefinition): boolean {
  if (!t.when) return false;
  const keys = Object.keys(t.when);
  if (keys.length === 0) return false;
  if (keys.length !== 1 || keys[0] !== 'verdict') return false;
  const verdict = t.when.verdict;
  return typeof verdict === 'string' && APPROVAL_EXIT_VERDICTS.has(verdict);
}

/**
 * True when the state's visit cap actually bounds it: a plain (non-fan-out)
 * agent state that declares `maxVisits` AND routes on the
 * `isStateVisitLimitReached` guard. The guard reads the cap of the state
 * whose invoke just finished, so only a transition on the state itself can
 * enforce it; a fan-out parent counts no visits. (Whether the guard is
 * ordered so it can win is WF008's concern.)
 */
function hasEnforcedVisitCap(state: WorkflowStateDefinition): boolean {
  return (
    state.type === 'agent' &&
    state.fanOut === undefined &&
    state.maxVisits !== undefined &&
    state.transitions.some((t) => t.guard === VISIT_CAP_GUARD)
  );
}

function checkVisitCapTransitionOrder(def: WorkflowDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [stateId, state] of Object.entries(def.states)) {
    if (!isAgentState(state)) continue;
    if (state.maxVisits === undefined) continue;

    const transitions = state.transitions;
    const capIndex = transitions.findIndex((t) => t.guard === VISIT_CAP_GUARD);
    // No cap-guarded transition: the cap is never checked at all, which is
    // WF016's concern, not an ordering problem.
    if (capIndex === -1) continue;

    // Find the first loop-continuing transition that precedes the cap.
    for (let i = 0; i < capIndex; i++) {
      const t = transitions[i];
      if (isApprovalExitTransition(t)) continue;
      if (returnsOnlyThroughVisitReset(def, stateId, t.to)) continue;

      // `t` is either unconditional, a non-approval `when`, or a different
      // guard — all of which can match before the cap guard is evaluated.
      const descriptor = describeTransition(t);
      diagnostics.push({
        code: 'WF008',
        severity: 'error',
        stateId,
        message:
          `State "${stateId}" has maxVisits=${state.maxVisits} with an "${VISIT_CAP_GUARD}" ` +
          `transition at position ${capIndex + 1}, but a loop-continuing transition (${descriptor}) ` +
          `at position ${i + 1} will match first on every iteration, so the visit cap is never ` +
          `reached and the loop is effectively unbounded except by settings.maxRounds.`,
        hint:
          `Move the "${VISIT_CAP_GUARD}" transition above any non-approval "when" clause ` +
          `(only ${Array.from(APPROVAL_EXIT_VERDICTS).join('/')} verdicts, or a transition whose target re-enters ` +
          `"${stateId}" only through a resetVisitCounts of it, may precede the cap).`,
      });
      // One diagnostic per state is sufficient; multiple preceding loop-
      // continuing transitions all share the same fix.
      break;
    }
  }

  return diagnostics;
}

/**
 * True when every path from `target` back into `cappedStateId` takes a
 * transition whose `resetVisitCounts` action names `cappedStateId` (or when
 * `target` cannot reach it at all). The capped state is then entered again
 * only with a fresh count, so the order of such a transition relative to the
 * cap guard cannot be what keeps the cap from firing: the next pass through
 * the loop counts from zero either way. A router can dispatch
 * into a loop again after resetting its visit count.
 */
function returnsOnlyThroughVisitReset(def: WorkflowDefinition, cappedStateId: string, target: string): boolean {
  const seen = new Set<string>();
  const queue: string[] = [target];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined || seen.has(id)) continue;
    if (id === cappedStateId) return false;
    seen.add(id);
    const state = def.states[id] as WorkflowStateDefinition | undefined;
    if (!state) continue;
    for (const next of successorsKeepingVisitCount(state, cappedStateId)) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return true;
}

/** Targets reachable from `state` without resetting `countedStateId`'s visit count. */
function successorsKeepingVisitCount(state: WorkflowStateDefinition, countedStateId: string): string[] {
  const transitions: readonly (AgentTransitionDefinition | HumanGateTransitionDefinition)[] =
    state.type === 'terminal' ? [] : state.transitions;
  // `resetVisitCounts` is the only transition action type.
  const next = transitions
    .filter((t) => !(t.actions ?? []).some((action) => action.stateIds.includes(countedStateId)))
    .map((t) => t.to);
  if (isExecutableState(state) && state.segment !== undefined) next.push(...state.segment);
  return next;
}

function describeTransition(t: AgentTransitionDefinition): string {
  if (t.guard) return `guard: ${t.guard} -> ${t.to}`;
  if (t.when) {
    const parts = Object.entries(t.when).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    return `when { ${parts.join(', ')} } -> ${t.to}`;
  }
  return `unconditional -> ${t.to}`;
}

// ---------------------------------------------------------------------------
// WF011 — mixed agent/deterministic scope may run before agent population
// ---------------------------------------------------------------------------

/**
 * A containerized deterministic state may intentionally be the first and only
 * consumer of a scope: `ensureBundleForScope` mints the bundle on demand, which
 * is how no-LLM workflows run deterministic acceptance commands. When the same
 * scope also contains agent states, however, reaching a deterministic helper
 * before any of those agents is still a useful graph-ordering warning: the
 * workspace may not contain the work the helper was meant to check.
 */
function checkContainerScopePopulatedByAgent(def: WorkflowDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [stateId, state] of Object.entries(def.states)) {
    if (state.type !== 'deterministic' || state.container !== true) continue;
    const scope = state.containerScope ?? DEFAULT_CONTAINER_SCOPE;
    const scopeHasAgent = Object.values(def.states).some(
      (candidate) => candidate.type === 'agent' && (candidate.containerScope ?? DEFAULT_CONTAINER_SCOPE) === scope,
    );
    if (!scopeHasAgent || !isReachableWithoutScopeAgent(def, stateId, scope)) continue;

    diagnostics.push({
      code: 'WF011',
      severity: 'warning',
      stateId,
      message:
        `Deterministic state "${stateId}" runs in container scope "${scope}" but is reachable from ` +
        `"${def.initial}" without first passing through an agent state in that scope — its workspace ` +
        `may not contain the agent-produced work it was intended to check.`,
      hint:
        `If "${stateId}" checks agent output, place a "${scope}"-scope agent state before it. ` +
        `A deliberately no-LLM deterministic workflow may use a scope with no agent states.`,
    });
  }
  return diagnostics;
}

/** Return true when one path reaches `target` without crossing a same-scope agent. */
function isReachableWithoutScopeAgent(def: WorkflowDefinition, target: string, scope: string): boolean {
  const seen = new Set<string>();
  const queue: string[] = [def.initial];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (id === target) return true;
    const state = def.states[id] as WorkflowStateDefinition | undefined;
    if (!state) continue;
    if (state.type === 'agent' && (state.containerScope ?? DEFAULT_CONTAINER_SCOPE) === scope) continue;
    for (const next of collectTransitionTargets(state)) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// WF012 — deterministic verdict edges need a resultFile source
// ---------------------------------------------------------------------------

function checkVerdictEdgesHaveResultFile(def: WorkflowDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [stateId, state] of Object.entries(def.states)) {
    if (state.type !== 'deterministic') continue;
    if (state.fanOut !== undefined) continue;
    if (state.resultFile !== undefined) continue;

    if (!usesVerdictEdges(state.transitions)) continue;

    diagnostics.push({
      code: 'WF012',
      severity: 'warning',
      stateId,
      message:
        `Deterministic state "${stateId}" routes on when:{verdict} but declares no resultFile; ` +
        `the verdict will always be undefined and these edges are dead.`,
      hint: `Add resultFile: <path> and have the helper write { "verdict": ... } there.`,
    });
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF013 — fan-out re-scopes the maxRounds budget from candidates to batches
// ---------------------------------------------------------------------------

function checkFanOutBudget(def: WorkflowDefinition): Diagnostic[] {
  if (def.settings?.maxRounds === undefined) return [];
  const maxRounds = def.settings.maxRounds;

  const diagnostics: Diagnostic[] = [];
  for (const [stateId, state] of Object.entries(def.states)) {
    if (!isExecutableState(state) || state.fanOut === undefined) continue;
    // Gate on THIS state's effective lane count (a numeric fanOut.count override
    // multiplies the budget even when settings.workers is 1), and use it in the
    // maxRounds × workers math. Mirrors orchestrator.runFanOutSegment.
    const workers = resolveFanOutWorkers(state.fanOut, def.settings);
    if (workers <= 1) continue;
    diagnostics.push({
      code: 'WF013',
      severity: 'warning',
      stateId,
      message:
        `Fan-out state "${stateId}" runs with ${workers} lanes; settings.maxRounds=${maxRounds} ` +
        `now caps batches, so the candidate budget is maxRounds × workers = ${maxRounds * workers}.`,
      hint: 'If maxRounds is intended as a candidate budget, divide it by workers or set an explicit batch budget.',
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF014 — self-loopable fan-out segment child lacks a per-lane visit bound
// ---------------------------------------------------------------------------

function checkFanOutChildBounds(def: WorkflowDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const state of Object.values(def.states)) {
    if (!isExecutableState(state) || state.fanOut === undefined) continue;
    // Gate on THIS state's effective lane count: a numeric fanOut.count override
    // runs multiple lanes even at settings.workers: 1. Mirrors the runtime.
    if (resolveFanOutWorkers(state.fanOut, def.settings) <= 1) continue;
    const segment = state.segment ?? [];

    const segmentSet = new Set(segment);
    for (const memberId of segment) {
      const member = def.states[memberId] as WorkflowStateDefinition | undefined;
      if (member === undefined) continue;
      if (!isSelfLoopableWithinSegment(def, memberId, segmentSet)) continue;
      // `maxVisits` alone bounds nothing: without an isStateVisitLimitReached
      // transition the cap is never checked (WF016), so it must not silence
      // this warning either.
      if (hasEnforcedVisitCap(member)) continue;
      diagnostics.push({
        code: 'WF014',
        severity: 'warning',
        stateId: memberId,
        message:
          `Fan-out segment member "${memberId}" can loop within the segment but has no per-lane maxVisits bound ` +
          `enforced by an "${VISIT_CAP_GUARD}" transition; the parent maxRounds guard is blind to lane-internal visits.`,
        hint: `Give the child state maxVisits plus a transition with guard: ${VISIT_CAP_GUARD}, ordered before its loop-continuing transitions.`,
      });
    }
  }
  return diagnostics;
}

function isSelfLoopableWithinSegment(def: WorkflowDefinition, stateId: string, segment: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  const queue = collectTransitionTargets(def.states[stateId]).filter((target) => segment.has(target));
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    if (current === stateId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const state = def.states[current] as WorkflowStateDefinition | undefined;
    if (state === undefined) continue;
    for (const target of collectTransitionTargets(state)) {
      if (segment.has(target)) queue.push(target);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// WF015 — deterministic state runs workspace code on the host
// ---------------------------------------------------------------------------

/**
 * A `host: true` deterministic state runs its commands as the user running
 * IronCurtain, outside the container and the policy engine, in the run
 * workspace that agents write. The toolchains such a state usually runs
 * execute code and configuration from that workspace, so the state is a path
 * from a compromised agent to host code execution. Validation has already
 * required the acknowledgement; this warning explains what it accepts and
 * points at the contained alternative.
 */
function checkHostDeterministicStates(def: WorkflowDefinition): Diagnostic[] {
  const builtin = def.settings?.mode === 'builtin';
  const diagnostics: Diagnostic[] = [];
  for (const [stateId, state] of Object.entries(def.states)) {
    if (state.type !== 'deterministic' || !runsCommandsOnHost(state)) continue;
    diagnostics.push({
      code: 'WF015',
      severity: 'warning',
      stateId,
      message:
        `Deterministic state "${stateId}" runs its commands on the host (host: true), as your user with full network ` +
        `access and IronCurtain's environment, outside the container and the policy engine. Host toolchains such as ` +
        `npm, pytest, make, cargo and git execute code and configuration from the workspace (package.json scripts, ` +
        `conftest.py, Makefiles, .git/config and hooks), which agents can write, so an agent can run code on the ` +
        `host through this state.`,
      hint: builtin
        ? 'Builtin mode has no container. Keep host: true only for commands that do not read agent-writable files, ' +
          'or move the workflow to mode: docker with settings.sharedContainer: true and run the state with container: true.'
        : "Run the commands in the workflow's shared container instead: set container: true (with " +
          'settings.sharedContainer: true) and drop host: true. Keep host: true only for commands that do not read ' +
          'agent-writable files.',
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF016 — visit cap that is never checked
// ---------------------------------------------------------------------------

/**
 * `maxVisits` and the `isStateVisitLimitReached` guard only work as a pair on
 * one plain agent state (see {@link hasEnforcedVisitCap}). Each half on its
 * own is a silent no-op:
 *   - `maxVisits` without the guard transition: the loop the author meant to
 *     bound is bounded only by `settings.maxRounds`;
 *   - `maxVisits` on a fan-out parent: fan-out states count no visits, and the
 *     guard never sees an agent result there, so the cap cannot fire;
 *   - the guard without `maxVisits` (deterministic states cannot declare it):
 *     the guard is always false and its transition is dead.
 */
function checkVisitCapIsChecked(def: WorkflowDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [stateId, state] of Object.entries(def.states)) {
    if (!isExecutableState(state)) continue;
    const maxVisits = state.type === 'agent' ? state.maxVisits : undefined;
    const hasCapGuard = state.transitions.some((t) => t.guard === VISIT_CAP_GUARD);

    if (maxVisits !== undefined && state.fanOut !== undefined) {
      diagnostics.push({
        code: 'WF016',
        severity: 'warning',
        stateId,
        message:
          `Fan-out state "${stateId}" declares maxVisits=${maxVisits}, but fan-out states do not count visits ` +
          `and the "${VISIT_CAP_GUARD}" guard never fires on a batch result, so the cap is never applied.`,
        hint:
          `Remove maxVisits from the fan-out state. Bound lane loops with maxVisits plus a ${VISIT_CAP_GUARD} ` +
          `transition on the segment member, and batches with settings.maxRounds.`,
      });
    } else if (maxVisits !== undefined && !hasCapGuard) {
      diagnostics.push({
        code: 'WF016',
        severity: 'warning',
        stateId,
        message:
          `State "${stateId}" declares maxVisits=${maxVisits} but has no "${VISIT_CAP_GUARD}" transition, so the ` +
          `cap is never checked and the state can be re-entered without that limit.`,
        hint:
          `Add a transition with guard: ${VISIT_CAP_GUARD} (ordered before any loop-continuing transition, see ` +
          `WF008), or remove maxVisits.`,
      });
    } else if (maxVisits === undefined && hasCapGuard) {
      diagnostics.push({
        code: 'WF016',
        severity: 'warning',
        stateId,
        message:
          `State "${stateId}" has a "${VISIT_CAP_GUARD}" transition but declares no maxVisits, so the guard is ` +
          `always false and the transition never fires.`,
        hint:
          state.type === 'agent' && state.fanOut === undefined
            ? 'Add maxVisits to the state, or remove the transition.'
            : 'Only plain agent states can carry a visit cap; remove the transition.',
      });
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF017 — legacy fields that are accepted but ignored
// ---------------------------------------------------------------------------

/**
 * Fields the schema still accepts so that existing manifests keep loading,
 * but that no runtime code reads. Each describes behaviour an author could
 * rely on (git worktree isolation, the repository to take worktrees from,
 * commands run when the workflow ends) and none of it happens. Messages name
 * the field only; the author's values are not echoed.
 */
function checkIgnoredLegacyFields(def: WorkflowDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (def.settings?.gitRepoPath !== undefined) {
    diagnostics.push({
      code: 'WF017',
      severity: 'warning',
      message:
        'settings.gitRepoPath is ignored: git worktree management is not implemented, so nothing reads or ' +
        'prepares a repository from this path.',
      hint: 'Remove settings.gitRepoPath. To run against an existing repository, pass it as the workspace (--workspace).',
    });
  }

  for (const [stateId, state] of Object.entries(def.states)) {
    if (state.type === 'agent' && state.worktree !== undefined) {
      diagnostics.push({
        code: 'WF017',
        severity: 'warning',
        stateId,
        message:
          `Agent state "${stateId}" sets worktree: ${state.worktree}, a legacy field that is ignored: no git ` +
          `worktree is created, and the state works in the shared workspace like every other state.`,
        hint: 'Remove the worktree field.',
      });
    }
    if (state.type === 'terminal' && state.cleanup !== undefined) {
      diagnostics.push({
        code: 'WF017',
        severity: 'warning',
        stateId,
        message: `Terminal "${stateId}" declares cleanup commands, but terminal cleanup is not implemented: they never run.`,
        hint: 'Remove cleanup. Run any cleanup as a deterministic state before the terminal.',
      });
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF018 — lane scheduling metadata without a scheduler
// ---------------------------------------------------------------------------

/**
 * `schedule` (pool + `resources`) is metadata for the planned evaluation-slot
 * pool of the fan-out design (Phase 8), which does not exist yet. Until it
 * does, nothing reads the field: the state runs like any other, and every
 * lane of a fan-out segment shares the workflow's one container, including
 * its CPU and memory. A resource request is therefore reported on its own,
 * since an author may be counting on it for isolation.
 */
function checkUnimplementedSchedule(def: WorkflowDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [stateId, state] of Object.entries(def.states)) {
    if (!isExecutableState(state) || state.schedule === undefined) continue;
    diagnostics.push({
      code: 'WF018',
      severity: 'warning',
      stateId,
      message:
        `State "${stateId}" declares schedule.pool "${state.schedule.pool}", but scheduling pools are not ` +
        `implemented: the field is ignored and the state runs like any other.`,
      hint: 'Remove schedule until the evaluation-slot pool exists.',
    });

    const resources = state.schedule.resources;
    if (resources === undefined) continue;
    const requested = (['cpu', 'mem', 'gpu'] as const).filter((key) => resources[key] !== undefined);
    diagnostics.push({
      code: 'WF018',
      severity: 'warning',
      stateId,
      message:
        `State "${stateId}" requests schedule.resources (${requested.join(', ') || 'none'}), but per-lane resource ` +
        `caps are not enforced: every lane shares the workflow container's CPU and memory, so one lane can starve ` +
        `or exhaust the others.`,
      hint: "Remove schedule.resources, and keep settings.workers within what the container's CPU and memory can run at once.",
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF019 — fan-out wider than the default resource envelope
// ---------------------------------------------------------------------------

/**
 * Every lane of a fan-out is a concurrent agent. In shared-container mode all
 * of them run in the scope's one container, under one CPU and memory ceiling
 * (`dockerResources`, default 4 CPUs / 8 GB), so lanes past that budget
 * contend instead of overlapping, and memory-hungry evaluations OOM each
 * other. Otherwise each lane is its own agent session and takes one of the
 * `maxConcurrentAgentSessions` slots (default 4); lanes past the cap wait.
 */
function checkFanOutWidth(def: WorkflowDefinition): Diagnostic[] {
  const shared = usesSharedContainer(def.settings);
  const diagnostics: Diagnostic[] = [];
  for (const [stateId, state] of Object.entries(def.states)) {
    if (!isExecutableState(state) || state.fanOut === undefined) continue;
    const lanes = resolveFanOutWorkers(state.fanOut, def.settings);
    if (lanes <= FAN_OUT_LANES_WARNING_THRESHOLD) continue;
    diagnostics.push({
      code: 'WF019',
      severity: 'warning',
      stateId,
      message: shared
        ? `Fan-out state "${stateId}" runs ${lanes} concurrent lanes in one shared container. Every lane is an ` +
          `agent process under the container's single CPU and memory ceiling (dockerResources, default 4 CPUs / ` +
          `8 GB), so lanes beyond that budget contend instead of running in parallel and can exhaust its memory.`
        : `Fan-out state "${stateId}" runs ${lanes} concurrent lanes, each its own agent session. Each session ` +
          `takes one of the maxConcurrentAgentSessions slots (default 4); lanes beyond the free slots wait.`,
      hint:
        `Cap workers to the container's CPU and RAM budget (about one lane per CPU, at most ` +
        `${FAN_OUT_LANES_WARNING_THRESHOLD} with the defaults), or raise dockerResources and ` +
        'maxConcurrentAgentSessions in ~/.ironcurtain/config.json to match.',
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// WF020 — explicit model provider the state's harness does not call
// ---------------------------------------------------------------------------

/**
 * The provider each harness's own client calls when no gateway provider
 * profile routes it elsewhere: Claude Code speaks to Anthropic, Codex to
 * OpenAI. Goose is absent: it calls whichever provider `gooseProvider`
 * selects in the user's config, which the linter cannot see.
 */
const HARNESS_NATIVE_PROVIDER: Readonly<Partial<Record<DockerAgent, ProviderId>>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
};

/**
 * Flags an agent state whose effective model (`model`, else
 * `settings.model`) carries an explicit provider prefix its harness does not
 * call natively — typically a state moved to another harness (`dockerAgent:
 * codex`) that still inherits the workflow's Anthropic model, which fails
 * only when that state's first turn runs. A warning, not an error: a
 * gateway profile such as OpenRouter can serve other providers' models to
 * any harness. Bare model names carry no provider and are not checked.
 */
function checkModelMatchesHarness(def: WorkflowDefinition): Diagnostic[] {
  if (def.settings?.mode === 'builtin') return [];
  const diagnostics: Diagnostic[] = [];
  for (const [stateId, state] of Object.entries(def.states)) {
    if (state.type !== 'agent') continue;
    const model = state.model ?? def.settings?.model;
    if (model === undefined) continue;
    const provider = explicitModelProvider(model);
    if (provider === undefined) continue;
    const harness = resolveStateDockerAgent(state, def.settings);
    const native = HARNESS_NATIVE_PROVIDER[harness];
    if (native === undefined || native === provider) continue;
    const inherited = state.model === undefined ? ' (inherited from settings.model)' : '';
    diagnostics.push({
      code: 'WF020',
      severity: 'warning',
      stateId,
      message:
        `Agent state "${stateId}" runs on the ${harness} harness, whose client calls ${native} models, but its ` +
        `model "${model}"${inherited} is a ${provider} model, so the state's first turn will fail.`,
      hint:
        `Set states.${stateId}.model to a "${native}:" model, or ignore this warning when a gateway provider ` +
        `profile serves ${provider} models to ${harness}.`,
    });
  }
  return diagnostics;
}

/** The provider named by a `provider:model` prefix; undefined for a bare model name. */
function explicitModelProvider(model: string): ProviderId | undefined {
  try {
    const { provider, modelId } = parseModelId(model);
    return modelId === model ? undefined : provider;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// WF010 — skill references and skill-manifest integrity
// ---------------------------------------------------------------------------

/**
 * Entry point for WF010. Skips cleanly when `ctx.workflowFilePath` is
 * absent (in-memory definitions have no package dir to scan).
 * `checkSkillManifests` runs independently of any state reference so
 * a typo'd frontmatter — which would silently disappear from
 * discovery — still surfaces.
 */
function checkSkillReferencesAndManifests(def: WorkflowDefinition, ctx: LintContext): Diagnostic[] {
  if (!ctx.workflowFilePath) return [];
  const skillsRoot = resolve(getWorkflowPackageDir(ctx.workflowFilePath), 'skills');
  const { skills, errors } = discoverSkillsWithErrors(skillsRoot, 'workflow');

  return [...checkSkillManifests(errors), ...checkSkillReferences(def, skills, skillsRoot)];
}

function checkSkillManifests(errors: readonly SkillDiscoveryError[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const err of errors) {
    if (!ACTIONABLE_DISCOVERY_REASONS.has(err.reason)) continue;
    diagnostics.push({
      code: 'WF010',
      severity: 'error',
      ...buildSkillManifestDiagnostic(err),
    });
  }
  return diagnostics;
}

function buildSkillManifestDiagnostic(err: SkillDiscoveryError): { message: string; hint: string } {
  const detail = err.detail ?? err.reason;
  // Switch is exhaustive over `SkillDiscoveryErrorReason`. No `default`:
  // a new union member must add a case here or TypeScript will flag the
  // missing return-type coverage at compile time.
  switch (err.reason) {
    case 'malformed-frontmatter':
      return {
        message: `Malformed SKILL.md frontmatter at ${err.skillDir}: ${detail}.`,
        hint: 'Fix the YAML frontmatter (the block fenced by `---` lines at the top of SKILL.md).',
      };
    case 'missing-required-fields':
      return {
        message: `SKILL.md at ${err.skillDir} is missing required frontmatter fields: ${detail}.`,
        hint: 'SKILL.md frontmatter must declare both `name:` and `description:` as strings.',
      };
    case 'unreadable':
      return {
        message: `Unreadable SKILL.md at ${err.skillDir}: ${detail}.`,
        hint:
          'Check filesystem permissions, and that SKILL.md is a regular file in a real directory under skills/ ' +
          '(workflow skills are not read through symbolic links).',
      };
    case 'missing-manifest':
      return {
        message: `Missing SKILL.md at ${err.skillDir}: ${detail}.`,
        hint: 'Create a SKILL.md file with a `---`-fenced YAML frontmatter declaring `name:` and `description:`.',
      };
    case 'duplicate-name':
      return {
        message: `Duplicate skill at ${err.skillDir}: ${detail}.`,
        hint: 'Two skill directories under the same skills root cannot share the same frontmatter `name:`. Rename one in its SKILL.md frontmatter.',
      };
  }
}

/**
 * Walks every agent state's `skills?: string[]` and emits one
 * diagnostic per offending entry — either an invalid name (rejected by
 * `validateSkillName`) or a name that does not match any discovered
 * skill's frontmatter `name:` under `<packageDir>/skills/`. The
 * frontmatter name is the user-facing identifier (matched by
 * `workflowSkillFilter` in `src/skills/discovery.ts`), not the
 * directory name. The orchestrator's `validateWorkflowSkillReferences`
 * throws for the same conditions at start; surfacing them at lint time
 * gives authors fast feedback before they hit runtime.
 */
function checkSkillReferences(
  def: WorkflowDefinition,
  discovered: readonly ResolvedSkill[],
  skillsRoot: string,
): Diagnostic[] {
  const discoveredNames = new Set(discovered.map((s) => s.name));
  const available = [...discoveredNames].sort();
  const availableHint = available.length > 0 ? available.join(', ') : '(none)';
  const diagnostics: Diagnostic[] = [];

  for (const issue of iterateSkillRefIssues(def, discoveredNames)) {
    if (issue.kind === 'invalid-name') {
      diagnostics.push({
        code: 'WF010',
        severity: 'error',
        stateId: issue.stateId,
        message: `Invalid skill name "${issue.name}" in state "${issue.stateId}": ${issue.detail}.`,
        hint: 'Skill names must be a single non-empty path segment with no separators or "."/"..".',
      });
    } else {
      diagnostics.push({
        code: 'WF010',
        severity: 'error',
        stateId: issue.stateId,
        message: `State "${issue.stateId}" references skill "${issue.name}" but no skill with that frontmatter name was found under ${skillsRoot}. Available: ${availableHint}.`,
        hint: `Add a SKILL.md under <workflow-pkg>/skills/ whose frontmatter \`name:\` is "${issue.name}", or remove "${issue.name}" from the state's skills list.`,
      });
    }
  }

  return diagnostics;
}

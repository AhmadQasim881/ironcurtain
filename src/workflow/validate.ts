import { posix as pathPosix, resolve } from 'node:path';
import { z } from 'zod';
import { validateSkillName } from '../skills/staging.js';
import { discoverSkills } from '../skills/discovery.js';
import { errorMessage } from '../utils/error-message.js';
import type {
  WorkflowDefinition,
  WorkflowSettings,
  WorkflowStateDefinition,
  HumanGateStateDefinition,
  DeterministicStateDefinition,
  AgentOutput,
  AgentTransitionDefinition,
  HumanGateTransitionDefinition,
} from './types.js';
import {
  AGENT_OUTPUT_FIELDS,
  CONFIDENCE_VALUES,
  DEFAULT_CONTAINER_SCOPE,
  MAX_DETERMINISTIC_TIMEOUT_MS,
  MAX_GATE_IDLE_TIMEOUT_MINUTES,
  SKILLS_NONE,
  WORKSPACE_ACCESS_VALUES,
} from './types.js';
import { isPlainRelativePath } from '../types/read-only-workspace.js';
import { isReadOnlyAgentState } from './workspace-access.js';
import {
  DEFAULT_EVOLVE_LANE_DIR,
  DEFAULT_EVOLVE_LANE_RELATIVE_DIR,
  MAX_FAN_OUT_LANES,
  resolveFanOutWorkers,
} from './lane-template.js';
import { REGISTERED_GUARDS } from './guards.js';
import { DOCKER_AGENTS, resourceBudgetFieldsSchema, looseModelId } from '../config/user-config.js';
import { isPlainObject } from '../utils/is-plain-object.js';
import { collectScopeDockerAgents, describeScopeDockerAgents } from './agent-harness.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const whenValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// See WorkflowTransitionAction in types.ts for the scaffold rationale.
const transitionActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('resetVisitCounts'),
    stateIds: z.array(z.string()).min(1),
  }),
]);

const agentTransitionSchema = z.object({
  to: z.string(),
  guard: z.string().optional(),
  when: z.record(z.string(), whenValueSchema).optional(),
  actions: z.array(transitionActionSchema).optional(),
});

const humanGateTransitionSchema = z.object({
  to: z.string(),
  event: z.enum(['APPROVE', 'FORCE_REVISION', 'REPLAN', 'ABORT']),
  actions: z.array(transitionActionSchema).optional(),
});

/**
 * Charset for `containerScope` values. Path-safe identifier shape —
 * scope strings never appear in filesystem paths today, but keeping the
 * charset narrow rules out accidental injection into Docker labels,
 * diagnostics, or future path composition.
 */
const CONTAINER_SCOPE_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * A lane count (`settings.workers`, numeric `fanOut.count`), bounded by
 * {@link MAX_FAN_OUT_LANES}: every lane is a concurrent agent, and in a
 * shared container they all share one container's CPU and memory.
 */
const laneCountSchema = z
  .number()
  .int()
  .positive()
  .max(
    MAX_FAN_OUT_LANES,
    `at most ${MAX_FAN_OUT_LANES} concurrent fan-out lanes are supported; cap workers to the container's CPU and RAM budget`,
  );

const fanOutSchema = z.object({
  count: z.union([z.literal('workers'), laneCountSchema]),
  // Literal, not z.string(): only barrier joins are supported, and the
  // literal makes a non-barrier join a parse-time rejection (matching the
  // FanOutDefinition.join type). Async joins are a future, reviewed extension.
  join: z.literal('barrier'),
});

const laneResourceRequestSchema = z.object({
  cpu: z.number().positive().optional(),
  mem: z.string().min(1).optional(),
  gpu: z.number().int().min(0).optional(),
});

const scheduleSchema = z.object({
  pool: z.enum(['eval', 'agent']),
  resources: laneResourceRequestSchema.optional(),
});

const artifactHandoffSchema = z.object({
  requiredFiles: z.array(z.string().min(1)).min(1),
});

/**
 * Agent harness names (`settings.dockerAgent`, `states.<id>.dockerAgent`).
 * Checked against the static `DOCKER_AGENTS` list rather than the adapter
 * registry, which is filled lazily and is still empty at validation time, so
 * a misspelt harness fails when the workflow loads instead of when its first
 * container starts.
 */
const dockerAgentSchema = z.enum(DOCKER_AGENTS, {
  message: `dockerAgent must be one of ${DOCKER_AGENTS.join(', ')}`,
});

const agentStateSchema = z.object({
  type: z.literal('agent'),
  description: z.string().min(1),
  persona: z.string(),
  prompt: z.string().min(1),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  artifactHandoff: artifactHandoffSchema.optional(),
  transitions: z.array(agentTransitionSchema).min(1),
  worktree: z.boolean().optional(),
  fanOutMember: z.boolean().optional(),
  fanOut: fanOutSchema.optional(),
  segment: z.array(z.string()).min(1).optional(),
  schedule: scheduleSchema.optional(),
  freshSession: z.boolean().optional(),
  model: looseModelId.optional(),
  dockerAgent: dockerAgentSchema.optional(),
  maxVisits: z.number().int().positive().optional(),
  containerScope: z.string().regex(CONTAINER_SCOPE_PATTERN).optional(),
  skills: z.union([z.array(z.string()), z.literal(SKILLS_NONE)]).optional(),
  workspaceAccess: z.enum(WORKSPACE_ACCESS_VALUES).optional(),
});

const humanGateStateSchema = z.object({
  type: z.literal('human_gate'),
  description: z.string().min(1),
  acceptedEvents: z.array(z.enum(['APPROVE', 'FORCE_REVISION', 'REPLAN', 'ABORT'])),
  present: z.array(z.string()).optional(),
  transitions: z.array(humanGateTransitionSchema),
});

const deterministicStateSchema = z.object({
  type: z.literal('deterministic'),
  description: z.string().min(1),
  run: z.array(z.array(z.string())),
  container: z.boolean().optional(),
  host: z.boolean().optional(),
  containerScope: z.string().regex(CONTAINER_SCOPE_PATTERN).optional(),
  timeoutMs: z.number().int().positive().max(MAX_DETERMINISTIC_TIMEOUT_MS).optional(),
  resultFile: z.string().min(1).optional(),
  fanOut: fanOutSchema.optional(),
  segment: z.array(z.string()).min(1).optional(),
  fanOutMember: z.boolean().optional(),
  schedule: scheduleSchema.optional(),
  transitions: z.array(agentTransitionSchema).min(1),
});

const terminalStateSchema = z.object({
  type: z.literal('terminal'),
  description: z.string().min(1),
  outputs: z.array(z.string()).optional(),
  cleanup: z.array(z.array(z.string())).optional(),
});

const stateDefinitionSchema = z.discriminatedUnion('type', [
  agentStateSchema,
  humanGateStateSchema,
  deterministicStateSchema,
  terminalStateSchema,
]);

/**
 * `settings.workflowBudget`, the run-wide ceiling (see `WorkflowBudgetSettings`).
 * Strict, so a misspelled limit fails validation instead of silently setting
 * no ceiling; null states "no ceiling" explicitly.
 */
const workflowBudgetSchema = z
  .object({
    maxTotalTokens: z.number().int().positive().nullable().optional(),
    maxEstimatedCostUsd: z.number().positive().nullable().optional(),
    maxWallClockSeconds: z.number().positive().nullable().optional(),
  })
  .strict();

const workflowSettingsSchema = z
  .object({
    mode: z.enum(['docker', 'builtin']).optional(),
    dockerAgent: dockerAgentSchema.optional(),
    maxRounds: z.number().int().positive().optional(),
    gitRepoPath: z.string().optional(),
    workers: laneCountSchema.optional(),
    systemPrompt: z.string().optional(),
    maxSessionSeconds: z.number().positive().nullable().optional(),
    resourceBudget: resourceBudgetFieldsSchema.strict().optional(),
    workflowBudget: workflowBudgetSchema.optional(),
    unversionedArtifacts: z.array(z.string()).optional(),
    model: looseModelId.optional(),
    sharedContainer: z.boolean().optional(),
    allowMixedPersonas: z.boolean().optional(),
    snapshotOnStop: z.boolean().optional(),
    gateIdleTimeoutMinutes: z.number().positive().max(MAX_GATE_IDLE_TIMEOUT_MINUTES).nullable().optional(),
  })
  // Unknown keys fail instead of being stripped: a setting this version does
  // not know (a newer release's budget cap, say, or a typo) would otherwise be
  // dropped silently and the run would execute with looser limits than its
  // author set.
  .strict()
  .refine(
    (settings) =>
      settings.maxSessionSeconds === undefined ||
      settings.resourceBudget?.maxSessionSeconds === undefined ||
      settings.maxSessionSeconds === settings.resourceBudget.maxSessionSeconds,
    { message: 'Conflicting maxSessionSeconds values in settings and settings.resourceBudget' },
  )
  .optional();

const workflowDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  hidden: z.boolean().optional(),
  initial: z.string(),
  states: z.record(z.string(), stateDefinitionSchema),
  settings: workflowSettingsSchema,
});

// ---------------------------------------------------------------------------
// Raw-input checks (run before Zod so they catch fields Zod would strip)
// ---------------------------------------------------------------------------

/** State IDs must be valid identifiers so they don't collide with XState's
 * dotted-path state-node semantics (e.g., `xstate.done.actor.<stateId>`). */
const STATE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Zod strips unknown keys, so an agent-only field on another state type would
// otherwise be dropped without a word (a `dockerAgent` on a deterministic
// state does not choose the container its commands run in, and a
// `workspaceAccess: read-only` on one would not make it read-only).
const AGENT_ONLY_STATE_FIELDS = ['maxVisits', 'artifactHandoff', 'dockerAgent', 'workspaceAccess'] as const;

/**
 * Validates raw-level invariants that would otherwise be lost by Zod's default
 * `strip()` behavior or produce less helpful errors inside a discriminated-union
 * parse failure. Accumulates issues rather than throwing on the first one so
 * users see all problems at once.
 *
 * Note: this runs before Zod parsing, so `raw` is of unknown shape. We only
 * inspect fields we recognize; anything malformed is left for Zod to catch
 * with its own error messages.
 */
function validateRawInput(raw: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainObject(raw)) return issues;
  if (isPlainObject(raw.settings) && 'maxParallelism' in raw.settings) {
    issues.push('settings.maxParallelism is retired; use settings.workers instead.');
  }
  if (!isPlainObject(raw.states)) return issues;

  for (const [stateId, stateValue] of Object.entries(raw.states)) {
    if (!STATE_ID_PATTERN.test(stateId)) {
      issues.push(
        `State ID "${stateId}" is not a valid identifier — must match ${STATE_ID_PATTERN.source} ` +
          `(letters, digits, and underscores only; cannot start with a digit). ` +
          `Dots, spaces, and hyphens can collide with XState's nested-state path semantics.`,
      );
    }

    if (!isPlainObject(stateValue)) continue;
    const stateType = stateValue.type;
    if (typeof stateType !== 'string') continue;

    if ('resultFile' in stateValue && stateType !== 'deterministic') {
      issues.push(
        `State "${stateId}" (type: ${stateType}) has "resultFile" but that field is only valid on deterministic states.`,
      );
    }

    // Zod would strip it silently, and an author who writes `host: true` on
    // an agent state may believe it changes where that state runs.
    if ('host' in stateValue && stateType !== 'deterministic') {
      issues.push(
        `State "${stateId}" (type: ${stateType}) has "host" but that field is only valid on deterministic states.`,
      );
    }

    if (stateType === 'agent') continue;

    for (const field of AGENT_ONLY_STATE_FIELDS) {
      if (field in stateValue) {
        issues.push(
          `State "${stateId}" (type: ${stateType}) has "${field}" but that field is only valid on agent states.`,
        );
      }
    }

    if ('containerScope' in stateValue && stateType !== 'deterministic') {
      issues.push(
        `State "${stateId}" (type: ${stateType}) has "containerScope" but that field is only valid on agent states and containerized deterministic states.`,
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

export class WorkflowValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Workflow validation failed:\n  - ${issues.join('\n  - ')}`);
    this.name = 'WorkflowValidationError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

/**
 * The two state types that run an ordered `transitions` list with
 * agent-style `guard`/`when` routing (agent + deterministic). Human-gate
 * transitions use a different (event-keyed) shape, so they are excluded.
 */
export type ExecutableState = Extract<WorkflowStateDefinition, { readonly type: 'agent' | 'deterministic' }>;

/**
 * True for {@link ExecutableState}s. Narrows the union so call sites can
 * read `state.transitions` / `state.segment` without re-spelling the
 * `Extract<...>` longhand.
 */
export function isExecutableState(state: WorkflowStateDefinition): state is ExecutableState {
  return state.type === 'agent' || state.type === 'deterministic';
}

/**
 * True when a workflow actually runs in shared-container mode: an explicit
 * `settings.sharedContainer: true` opt-in on a Docker-backed workflow.
 * Builtin mode ignores the flag. Single source of truth for the
 * orchestrator's `shouldUseSharedContainer` and for the validator rules
 * that must mirror it (fan-out persona homogeneity, container scopes), so
 * the two cannot drift.
 */
export function usesSharedContainer(settings: WorkflowSettings | undefined): boolean {
  if (settings?.sharedContainer !== true) return false;
  return settings.mode !== 'builtin';
}

export function collectTransitionTargets(state: WorkflowStateDefinition): string[] {
  switch (state.type) {
    case 'agent':
    case 'deterministic':
      return state.transitions.map((t) => t.to);
    case 'human_gate':
      return state.transitions.map((t) => t.to);
    case 'terminal':
      return [];
  }
}

/**
 * True if any transition routes on a `when: { verdict: ... }` clause. Shared by
 * the container-only validation rule (`validateContainerScopes`) and the WF012
 * lint (which requires such states to declare a `resultFile`).
 */
export function usesVerdictEdges(transitions: readonly AgentTransitionDefinition[]): boolean {
  return transitions.some((t) => t.when !== undefined && 'verdict' in t.when);
}

/**
 * True when a deterministic state runs commands on the host: it is not
 * `container: true`, its `run` executes, and at least one of its commands is
 * non-empty (empty ones are skipped). Shared by the validation rule that
 * demands the `host: true` acknowledgement and the WF015 lint.
 *
 * A fan-out driver's own `run` never executes where it drives a batch (its
 * segment members do the work). A driver that is also a segment member
 * (`fanOutMember: true`, which every member must declare) is different: the
 * lane machine strips its fan-out markers and runs it as a plain
 * deterministic state, so its `run` does execute, in every lane.
 */
export function runsCommandsOnHost(state: DeterministicStateDefinition): boolean {
  const runExecutes = state.fanOut === undefined || state.fanOutMember === true;
  return state.container !== true && runExecutes && state.run.some((command) => command.length > 0);
}

/**
 * Parses a workflow input artifact reference. A trailing `?` marks the
 * input as optional — the consumer may skip it if the artifact isn't
 * produced.
 */
export function parseArtifactRef(ref: string): { readonly name: string; readonly isOptional: boolean } {
  const isOptional = ref.endsWith('?');
  return { name: isOptional ? ref.slice(0, -1) : ref, isOptional };
}

function collectGuardNames(state: WorkflowStateDefinition): string[] {
  if (isExecutableState(state)) {
    return state.transitions.filter((t): t is typeof t & { guard: string } => t.guard != null).map((t) => t.guard);
  }
  return [];
}

export function collectOutputArtifacts(states: Record<string, WorkflowStateDefinition>): Set<string> {
  const outputs = new Set<string>();
  for (const state of Object.values(states)) {
    if (state.type === 'agent' || state.type === 'terminal') {
      for (const o of state.outputs ?? []) {
        outputs.add(o);
      }
    }
  }
  return outputs;
}

export function findReachableStates(initial: string, states: Record<string, WorkflowStateDefinition>): Set<string> {
  const reachable = new Set<string>();
  const queue = [initial];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    if (reachable.has(current)) continue;
    reachable.add(current);
    const state = states[current] as WorkflowStateDefinition | undefined;
    if (!state) continue;
    for (const target of collectTransitionTargets(state)) {
      if (!reachable.has(target)) {
        queue.push(target);
      }
    }
    if (isExecutableState(state) && state.segment !== undefined) {
      for (const target of state.segment) {
        if (!reachable.has(target)) {
          queue.push(target);
        }
      }
    }
  }
  return reachable;
}

const AGENT_OUTPUT_FIELD_SET: ReadonlySet<string> = new Set(AGENT_OUTPUT_FIELDS);
const CONFIDENCE_VALUE_SET: ReadonlySet<string> = new Set(CONFIDENCE_VALUES);

export function isSafeWorkspaceRelativePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.includes('\0')) return false;
  if (path.startsWith('/')) return false;
  if (path === '.') return false;
  if (path.split('/').some((part) => part === '..')) return false;
  return pathPosix.normalize(path) === path;
}

/**
 * Expected runtime type for each AgentOutput field used in `when` clauses.
 * `expected` is the human-readable error label; `check` is the runtime test.
 */
const WHEN_KEY_TYPES: {
  readonly [K in keyof AgentOutput]: { readonly expected: string; readonly check: (v: unknown) => boolean };
} = {
  completed: { expected: 'boolean', check: (v) => typeof v === 'boolean' },
  verdict: { expected: 'string', check: (v) => typeof v === 'string' },
  confidence: { expected: 'string', check: (v) => typeof v === 'string' },
  escalation: { expected: 'string or null', check: (v) => typeof v === 'string' || v === null },
  testCount: { expected: 'number or null', check: (v) => typeof v === 'number' || v === null },
  notes: { expected: 'string or null', check: (v) => typeof v === 'string' || v === null },
};

function describeRuntimeType(value: unknown): string {
  if (value === null) return 'null';
  return typeof value;
}

/**
 * Returns all transitions on a state that may carry an `actions` array,
 * regardless of transition type. The validator only reads `to` and
 * `actions`, so narrowing the element type to the common fields lets us
 * treat agent, deterministic, and human-gate transitions uniformly.
 */
function collectTransitionsWithActions(
  state: WorkflowStateDefinition,
): readonly (AgentTransitionDefinition | HumanGateTransitionDefinition)[] {
  if (isExecutableState(state)) {
    return state.transitions;
  }
  if (state.type === 'human_gate') {
    return state.transitions;
  }
  return [];
}

function validateTransitionActions(
  stateId: string,
  state: WorkflowStateDefinition,
  stateNames: ReadonlySet<string>,
  issues: string[],
): void {
  // Per-action semantic checks. Today only `resetVisitCounts` needs one
  // (its `stateIds` must reference existing states). When a new action
  // type is added to the discriminated union, TS will flag the accesses
  // below as soon as `action.stateIds` is no longer unconditionally present.
  for (const t of collectTransitionsWithActions(state)) {
    if (!t.actions) continue;
    for (const action of t.actions) {
      for (const targetId of action.stateIds) {
        if (!stateNames.has(targetId)) {
          issues.push(
            `State "${stateId}" transition to "${t.to}" has resetVisitCounts referencing unknown state "${targetId}"`,
          );
        }
      }
    }
  }
}

function validateWhenClauses(stateId: string, state: WorkflowStateDefinition, issues: string[]): void {
  if (state.type === 'terminal' || state.type === 'human_gate') return;

  for (const t of state.transitions) {
    // Mutual exclusivity: guard + when on same transition
    if (t.guard && t.when) {
      issues.push(
        `State "${stateId}" has transition to "${t.to}" with both "guard" and "when" — they are mutually exclusive`,
      );
    }

    if (!t.when) continue;

    // Empty when rejected
    if (Object.keys(t.when).length === 0) {
      issues.push(
        `State "${stateId}" transition to "${t.to}" has empty "when" — use no guard for unconditional transitions`,
      );
    }

    // Only "verdict" is currently supported for when-clause routing.
    // The condensed status instructions only communicate verdict values
    // to agents, so routing on other fields would silently break.
    const nonVerdictKeys = Object.keys(t.when).filter((k) => k !== 'verdict');
    if (nonVerdictKeys.length > 0) {
      for (const k of nonVerdictKeys) {
        issues.push(
          `State "${stateId}" transition to "${t.to}" uses when clause key "${k}" — only "verdict" is currently supported for when-clause routing. Multi-field when conditions are a planned future feature.`,
        );
      }
    }

    // Key and value validation
    for (const [key, value] of Object.entries(t.when)) {
      if (!AGENT_OUTPUT_FIELD_SET.has(key)) {
        issues.push(
          `State "${stateId}" transition to "${t.to}" has "when" key "${key}" — not a valid AgentOutput field`,
        );
        continue;
      }

      // Per-key runtime type check (runs before enum value checks so that a
      // wrong-type value reports "wrong type" instead of "invalid value").
      const typeSpec = WHEN_KEY_TYPES[key as keyof AgentOutput];
      if (!typeSpec.check(value)) {
        issues.push(
          `State "${stateId}" transition to "${t.to}" has 'when' key '${key}' with wrong type: expected ${typeSpec.expected}, got ${describeRuntimeType(value)}`,
        );
        continue;
      }

      // Enum value checks run only when the type is already correct.
      // Verdict accepts any string (custom verdicts for direct routing).
      if (key === 'confidence' && typeof value === 'string' && !CONFIDENCE_VALUE_SET.has(value)) {
        issues.push(`State "${stateId}" transition to "${t.to}" has invalid confidence value "${value}"`);
      }
    }
  }
}

function validateFanOutScaffolding(definition: WorkflowDefinition, issues: string[]): void {
  const stateNames = new Set(Object.keys(definition.states));
  // The GLOBAL checks below (fanOutMember resultFile scoping + greedy rejection)
  // must fire whenever ANY fan-out segment runs multiple lanes at runtime — not
  // just when settings.workers > 1. A numeric `fanOut.count` override produces
  // multiple lanes even at settings.workers: 1 (the runtime resolves each state
  // with `resolveFanOutWorkers`), so gate on the EFFECTIVE max across all
  // fan-out states. Mirrors orchestrator.runFanOutSegment exactly.
  const effectiveWorkers = computeEffectiveMaxWorkers(definition);

  for (const [stateId, state] of Object.entries(definition.states)) {
    if (isExecutableState(state) && state.fanOut !== undefined) {
      validateFanOutState(definition, stateId, state, stateNames, issues);
    }

    if (isExecutableState(state) && state.schedule?.pool === 'eval' && state.fanOutMember !== true) {
      issues.push(`State "${stateId}" declares schedule.pool: eval but is not fanOutMember: true.`);
    }

    if (
      effectiveWorkers > 1 &&
      state.type === 'deterministic' &&
      state.fanOutMember === true &&
      state.resultFile !== undefined
    ) {
      const verdict = classifyFanOutResultFile(state.resultFile);
      if (verdict === 'hardcoded-lane') {
        issues.push(
          `State "${stateId}" is a fanOutMember with resultFile "${state.resultFile}" under ${effectiveWorkers} effective lanes; ` +
            `a hardcoded lane_<N> segment is written by EVERY lane (the pump leaves an already-lane_-prefixed path ` +
            `unchanged) and will clobber. Use the lane_\${laneId} placeholder (the pump substitutes it per lane) ` +
            `or a bare ${DEFAULT_EVOLVE_LANE_RELATIVE_DIR}/ path (the pump lane-scopes it per lane).`,
        );
      } else if (verdict === 'unscoped') {
        issues.push(
          `State "${stateId}" is a fanOutMember with resultFile "${state.resultFile}" under ${effectiveWorkers} effective lanes; ` +
            `resultFile must be per-lane-scoped: either rooted under the pump's current/ scratch dir (e.g. ` +
            `${DEFAULT_EVOLVE_LANE_RELATIVE_DIR}/result.json, which the pump rewrites to current/lane_<digits>/ per lane) ` +
            `or carry an explicit lane_\${laneId}/ segment.`,
        );
      }
    }
  }

  if (effectiveWorkers > 1 && workflowDeclaresGreedySampler(definition)) {
    issues.push(
      `A fan-out segment resolves to ${effectiveWorkers} lanes, which cannot be used with greedy sampling; ` +
        `multi-lane evolve runs must declare a stochastic sampler.`,
    );
  }
}

/**
 * The maximum effective lane count across all fan-out states, taking each
 * state's resolved count (`resolveFanOutWorkers`) into account. A bare
 * settings.workers floor is included so a `count: 'workers'` state still
 * reports the global worker count even when no numeric override is present.
 */
function computeEffectiveMaxWorkers(definition: WorkflowDefinition): number {
  let max = definition.settings?.workers ?? 1;
  for (const state of Object.values(definition.states)) {
    if (isExecutableState(state) && state.fanOut !== undefined) {
      max = Math.max(max, resolveFanOutWorkers(state.fanOut, definition.settings));
    }
  }
  return max;
}

function validateFanOutState(
  definition: WorkflowDefinition,
  stateId: string,
  state: ExecutableState,
  stateNames: ReadonlySet<string>,
  issues: string[],
): void {
  const segment = state.segment ?? [];
  if (segment.length === 0) {
    issues.push(`State "${stateId}" declares fanOut but has no non-empty segment list.`);
    return;
  }

  for (const memberId of segment) {
    if (!stateNames.has(memberId)) {
      issues.push(`State "${stateId}" fanOut segment references unknown state "${memberId}".`);
      continue;
    }
    const member = definition.states[memberId];
    if (member.type === 'human_gate') {
      issues.push(
        `State "${stateId}" fanOut segment includes human gate "${memberId}", but gates inside a fan-out segment are unreachable; aggregate to a gate outside the segment instead.`,
      );
      continue;
    }
    if ((member.type !== 'agent' && member.type !== 'deterministic') || member.fanOutMember !== true) {
      issues.push(`State "${stateId}" fanOut segment member "${memberId}" must declare fanOutMember: true.`);
    }
  }

  validateFanOutLaneConcurrency(definition, stateId, state, segment, issues);
}

/**
 * Rules about what N lanes running the SAME segment at the same time would
 * share. Everything here is gated on THIS state's effective lane count
 * (`resolveFanOutWorkers`, exactly as `orchestrator.runFanOutSegment`
 * resolves it): a numeric `fanOut.count` override runs multiple lanes even
 * at `settings.workers: 1`, and a `count: 'workers'` state at `workers: 1`
 * runs its lanes serially, where none of this applies.
 *
 * Shared-container execution (`usesSharedContainer`, mirroring the
 * orchestrator's `shouldUseSharedContainer`) additionally gates the two
 * container-bound rules:
 *
 * - **One scope per segment.** `preMintFanOutScopeBundle` mints exactly one
 *   bundle for the whole segment before any lane starts and refuses a
 *   segment spanning several scopes; reject it statically so authors learn
 *   at lint time rather than from a `result_file_error` verdict at runtime.
 * - **One persona per multi-lane segment (security).** Every lane borrows
 *   that one bundle's single coordinator, and `cyclePolicy` hot-swaps the
 *   coordinator's one active policy per persona. With agent members of
 *   different personas, lane 0 entering its second member would swap the
 *   policy out from under lane 1's still-running first member: tool calls
 *   evaluated and audited under the wrong persona — a silent policy bypass
 *   in one direction, spurious denials in the other. In per-state-container
 *   Docker mode and in builtin mode each session has its own coordinator,
 *   so mixed personas are safe there and are not rejected.
 *
 * Two rules apply in every mode once lanes are concurrent, because the
 * state they touch is per-run, not per-container:
 *
 * - **`freshSession: false`.** Lane contexts are shallow copies of the
 *   parent context, so every lane would `--resume` the one conversation id
 *   recorded for the member (concurrent writers to one transcript), and
 *   the join's last-writer-wins merge would keep an arbitrary lane's id.
 * - **Non-empty `outputs`.** Agent outputs are artifact NAMES under the
 *   run's single `.workflow/` dir (not paths, so `{laneRelDir}` templating
 *   cannot scope them): N lanes would write the same directories, one
 *   lane's files could satisfy another lane's missing-artifact check, and
 *   re-visit versioning would race.
 */
function validateFanOutLaneConcurrency(
  definition: WorkflowDefinition,
  stateId: string,
  state: ExecutableState,
  segment: readonly string[],
  issues: string[],
): void {
  const workers = state.fanOut === undefined ? 1 : resolveFanOutWorkers(state.fanOut, definition.settings);
  const agentMembers: Array<{ memberId: string; member: Extract<WorkflowStateDefinition, { type: 'agent' }> }> = [];
  const scopes = new Set<string>();
  for (const memberId of segment) {
    const member = definition.states[memberId] as WorkflowStateDefinition | undefined;
    if (member?.type === 'agent') {
      agentMembers.push({ memberId, member });
      scopes.add(member.containerScope ?? DEFAULT_CONTAINER_SCOPE);
    } else if (member?.type === 'deterministic' && member.container === true) {
      scopes.add(member.containerScope ?? DEFAULT_CONTAINER_SCOPE);
    }
  }

  if (usesSharedContainer(definition.settings)) {
    if (scopes.size > 1) {
      issues.push(
        `State "${stateId}" fanOut segment spans multiple container scopes (${[...scopes].sort().join(', ')}); ` +
          `a fan-out segment must run entirely within one containerScope — the orchestrator mints exactly one ` +
          `bundle per segment before any lane starts.`,
      );
    }

    if (workers > 1) {
      const personas = new Set(agentMembers.map(({ member }) => member.persona));
      if (personas.size > 1) {
        const described = agentMembers.map(({ memberId, member }) => `${memberId}: ${member.persona}`).join(', ');
        issues.push(
          `State "${stateId}" fanOut segment runs ${workers} concurrent lanes in a shared container, but its agent ` +
            `members use different personas (${described}). Every lane borrows the one coordinator for the segment's ` +
            `container scope, and that coordinator holds a single active policy that is hot-swapped per persona, so ` +
            `concurrent lanes would evaluate (and audit) tool calls under each other's policies. Use one persona for ` +
            `every agent member of the segment, or run the segment with a single lane.`,
        );
      }
    }
  }

  if (workers > 1) {
    for (const { memberId, member } of agentMembers) {
      if (member.freshSession === false) {
        issues.push(
          `State "${stateId}" fanOut segment member "${memberId}" sets freshSession: false, but ${workers} concurrent ` +
            `lanes start from the same parent context and would all resume the one agent conversation recorded for ` +
            `"${memberId}". Fan-out agent members must use fresh sessions (omit freshSession or set it to true).`,
        );
      }
      if (member.outputs.length > 0) {
        issues.push(
          `State "${stateId}" fanOut segment member "${memberId}" declares outputs [${member.outputs.join(', ')}], but ` +
            `artifact outputs are not lane-scoped: ${workers} concurrent lanes would write the same .workflow/<name> ` +
            `directories and one lane's files could satisfy another lane's artifact check. Fan-out agent members must ` +
            `declare outputs: [] (write lane results under the lane's result directory instead).`,
        );
      }
    }
  }
}

// The `lane_${laneId}` PLACEHOLDER path segment (e.g. current/lane_${laneId}/
// result.json). `applyLaneTemplate` expands this per lane BEFORE the pump's
// `replaceCurrentPrefix` runs, so every lane gets its own distinct `lane_<k>/`
// path. Safe author-written scoping.
const LANE_PLACEHOLDER_RESULT_FILE_RE = /(?:^|\/)lane_\$\{laneId\}(?:\/|$)/;
// A HARDCODED `lane_<digits>` path segment (e.g. current/lane_0/result.json).
// This is the FOOTGUN: there is no `${laneId}` for `applyLaneTemplate` to
// expand, and the pump's `replaceCurrentPrefix` idempotency guard
// (`/^lane_\d+\//` in lane-template.ts) sees the already-`lane_`-prefixed suffix
// and leaves it UNCHANGED — so all N lanes write the same literal `lane_<N>/...`
// path and mutually clobber. Must be rejected even though the path "looks"
// lane-scoped. Keep this in sync with that guard in lane-template.ts.
const HARDCODED_LANE_RESULT_FILE_RE = /(?:^|\/)lane_[0-9]+(?:\/|$)/;

type FanOutResultFileVerdict = 'safe' | 'hardcoded-lane' | 'unscoped';

/**
 * Classifies whether a fanOutMember's resultFile is guaranteed per-lane-scoped at
 * runtime, so concurrent lanes never clobber a shared file. Outcomes:
 *
 *  - `'safe'` — qualifies via ONE of:
 *      1. A BARE path rooted under the pump's `current/` scratch dir
 *         ({@link DEFAULT_EVOLVE_LANE_RELATIVE_DIR} / {@link DEFAULT_EVOLVE_LANE_DIR}).
 *         The deterministic pump (`laneScopeEvolveCurrentPath` in machine-builder.ts)
 *         idempotently rewrites that `current/` prefix to `current/lane_<k>/` for
 *         every lane at workers>1, and leaves it as the bare `current/` path at
 *         workers:1 — so the SAME bare manifest is correct at every worker count and
 *         byte-identical at the shipped workers:1 default. This relaxes the former
 *         strict requirement of a literal `lane_${laneId}/` segment, which forced
 *         the manifest to leak a `lane_0/` segment at workers:1 (the placeholder
 *         resolves to lane id 0 there) and so could not be both strict-lint-clean
 *         and workers:1 byte-identical at once.
 *      2. A `lane_${laneId}` PLACEHOLDER segment anywhere in the path — the author
 *         opts into explicit scoping and the pump expands it per lane.
 *
 *  - `'hardcoded-lane'` — carries a HARDCODED `lane_<digits>` segment. This LOOKS
 *    scoped but is a footgun: the pump's idempotency guard leaves an already-`lane_`
 *    -prefixed path untouched, so every lane writes the same literal path and they
 *    clobber. Rejected with a targeted diagnostic. (Checked first, so it overrides
 *    a misleading "rooted under current/" match like current/lane_0/result.json.)
 *
 *  - `'unscoped'` — neither scoped form: the pump would not lane-scope it, so N
 *    lanes would clobber one shared file.
 *
 * (Path-containment safety — no leading `/`, no `..` — is enforced separately and
 * unconditionally for every deterministic resultFile by `isSafeWorkspaceRelativePath`
 * in `validateContainerScopes`.)
 */
function classifyFanOutResultFile(resultFile: string): FanOutResultFileVerdict {
  const normalized = pathPosix.normalize(resultFile);
  if (HARDCODED_LANE_RESULT_FILE_RE.test(normalized)) return 'hardcoded-lane';
  if (LANE_PLACEHOLDER_RESULT_FILE_RE.test(normalized)) return 'safe';
  if (isRootedUnderPumpCurrentDir(normalized)) return 'safe';
  return 'unscoped';
}

// True when `normalized` is rooted under the pump's `current/` scratch dir (the
// prefix `laneScopeEvolveCurrentPath` idempotently lane-scopes at workers>1).
// Mirrors the pump's two accepted prefixes — the container-absolute and the
// workspace-relative forms — so the validator's notion of "the pump will scope
// this" is exactly the pump's, not a looser re-spelling.
function isRootedUnderPumpCurrentDir(normalized: string): boolean {
  for (const currentDir of [DEFAULT_EVOLVE_LANE_RELATIVE_DIR, DEFAULT_EVOLVE_LANE_DIR]) {
    const prefix = `${pathPosix.normalize(currentDir)}/`;
    if (normalized.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Heuristic detection of a greedy sampler declared anywhere in the manifest.
 * This encodes the inverse of the Python source of truth `STOCHASTIC_SAMPLERS`
 * (`scripts/evolve_result.py`) across the language boundary: greedy is the one
 * non-stochastic sampler, so a `workers>1` run that declares it is rejected.
 *
 * The detection is deliberately fragile: it scrapes manifest prompt/argv text
 * for `--sampling-algorithm greedy`-style flags because the host validator runs
 * at lint time, before any run-spec exists on disk — there is no authoritative
 * `sampling.algorithm` field to read. A future move of the sampler decision into
 * a manifest field would let this be exact; until then this is a best-effort guard.
 */
function workflowDeclaresGreedySampler(definition: WorkflowDefinition): boolean {
  for (const state of Object.values(definition.states)) {
    if (state.type === 'agent' && declaresGreedySamplerText(state.prompt)) {
      return true;
    }
    if (state.type !== 'deterministic') continue;
    for (const argv of state.run) {
      if (declaresGreedySamplerArgv(argv)) return true;
    }
  }
  return false;
}

function declaresGreedySamplerText(text: string): boolean {
  return (
    /--sampling-algorithm(?:=|\s+)["']?greedy\b/i.test(text) ||
    /\bsampling[_\-. ]algorithm\s*[:=]\s*["']?greedy\b/i.test(text)
  );
}

function declaresGreedySamplerArgv(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (/^--sampling-algorithm=greedy$/i.test(arg)) return true;
    if (arg === '--sampling-algorithm' && /^greedy$/i.test(argv[i + 1] ?? '')) return true;
  }
  return false;
}

function validateSemantics(definition: WorkflowDefinition, options: ValidateDefinitionOptions): void {
  const issues: string[] = [];
  const stateNames = new Set(Object.keys(definition.states));

  // Initial state must exist
  if (!stateNames.has(definition.initial)) {
    issues.push(`Initial state "${definition.initial}" does not exist`);
  }

  // At least one terminal state
  const hasTerminal = Object.values(definition.states).some((s) => s.type === 'terminal');
  if (!hasTerminal) {
    issues.push('At least one terminal state is required');
  }

  // Validate each state
  for (const [stateId, state] of Object.entries(definition.states)) {
    // Transition targets must reference existing states
    for (const target of collectTransitionTargets(state)) {
      if (!stateNames.has(target)) {
        issues.push(`State "${stateId}" has transition to unknown state "${target}"`);
      }
    }

    // Guard names must be registered
    for (const guard of collectGuardNames(state)) {
      if (!REGISTERED_GUARDS.has(guard)) {
        issues.push(`State "${stateId}" references unregistered guard "${guard}"`);
      }
    }

    // Transition action validation (currently: resetVisitCounts.stateIds
    // must reference existing states).
    validateTransitionActions(stateId, state, stateNames, issues);

    // When clause validation (mutual exclusivity, agent-only, keys, values, empty)
    validateWhenClauses(stateId, state, issues);

    if (state.type === 'agent' && state.artifactHandoff) {
      validateArtifactHandoff(definition, stateId, state, issues);
    }

    // Human gate-specific checks
    if (state.type === 'human_gate') {
      validateHumanGate(stateId, state, issues);
    }
  }

  // Unreachable states
  const reachable = findReachableStates(definition.initial, definition.states);
  for (const stateId of stateNames) {
    if (!reachable.has(stateId)) {
      issues.push(`State "${stateId}" is unreachable from initial state`);
    }
  }

  // Artifact input references
  validateArtifactInputs(definition, issues);

  // containerScope usage: gated on sharedContainer + charset.
  validateContainerScopes(definition, issues);

  // Per-state agent harness: builtin mode has none; one harness per shared scope.
  validateDockerAgents(definition, issues);

  // Host deterministic commands: explicit host: true acknowledgement.
  validateHostDeterministicStates(definition, issues, options.allowUnacknowledgedHostStates === true);

  // One persona per container scope unless the author opts in to treating
  // the scope as a single trust domain (settings.allowMixedPersonas).
  validateScopePersonaIsolation(definition, issues, options.allowMixedPersonaScopes === true);

  // workspaceAccess: read-only — where it is allowed, and one access per scope.
  validateReadOnlyStates(definition, issues);

  // Fan-out scaffold usage: schema-only fields are parsed now so later phases
  // can consume them without silent stripping.
  validateFanOutScaffolding(definition, issues);

  // Every executable state must be able to leave once its invoke settles.
  validateTransitionFallbacks(definition, issues);

  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }
}

/**
 * Requires an unconditional fallback transition wherever nothing else
 * guarantees that some transition matches once the state's invoke settles.
 *
 * XState evaluates `onDone` transitions in order and takes the first whose
 * guard / `when` clause holds. If none holds, the done event is simply
 * dropped and the state sits on its already-settled invoke forever: no
 * error, no gate, no terminal, the run stays in `listActive`, and resume
 * replays the same state into the same hang. The machine builder appends
 * an implicit fallback to the error target as a runtime safety net
 * (`buildOnDoneTransitions`); this rule surfaces the problem at lint time.
 *
 * - Deterministic states: a result-file verdict is NOT checked against the
 *   transition table (any string routes), and `isPassed` may simply be
 *   false, so an unconditional fallback is required.
 * - Fan-out parents, of EITHER type: the verdict is the barrier join's
 *   (`recorded`, `escalate`, `result_file_error`, ...), not an agent turn,
 *   so nothing reprompts it into the table; an agent-typed parent is built
 *   as a fan-out invoke, not an agent turn. An unconditional fallback is
 *   required.
 * - Agent states that route on `when: { verdict }`: exhaustive already —
 *   the orchestrator reprompts until the agent commits one of the declared
 *   verdicts (`getValidVerdicts` in status-parser.ts) — so the fallback is
 *   optional. Shipped workflows rely on this (e.g. review states that
 *   route only on approved/rejected plus a visit-cap guard).
 * - Agent states with guard-only routing (no `when` clause anywhere):
 *   nothing validates that any guard holds, so an unconditional fallback
 *   is required.
 */
function validateTransitionFallbacks(definition: WorkflowDefinition, issues: string[]): void {
  for (const [stateId, state] of Object.entries(definition.states)) {
    if (!isExecutableState(state)) continue;
    const hasUnconditional = state.transitions.some((t) => t.guard === undefined && t.when === undefined);
    if (hasUnconditional) continue;

    const described = summarizeTransitions(state.transitions);
    if (state.fanOut !== undefined) {
      issues.push(
        `State "${stateId}" is a fan-out state whose transitions are all conditional (${described}); ` +
          `the batch verdict comes from the barrier join and is not validated against the transition table, so a ` +
          `batch matching no transition (e.g. result_file_error after a failed lane) would leave the workflow stuck ` +
          `forever. Add an unconditional fallback transition (plain "to:") as the last entry.`,
      );
      continue;
    }
    if (state.type === 'deterministic') {
      issues.push(
        `State "${stateId}" is a deterministic state whose transitions are all conditional (${described}); ` +
          `deterministic results are not validated against the transition table, so a result matching no transition ` +
          `would leave the workflow stuck forever. Add an unconditional fallback transition (plain "to:") as the last entry.`,
      );
      continue;
    }

    const routesOnVerdict = state.transitions.some((t) => t.when !== undefined);
    if (routesOnVerdict) continue;
    issues.push(
      `State "${stateId}" is an agent state that routes only on guards (${described}) with no unconditional fallback; ` +
        `guard-only routing is not validated against the agent's output, so a turn matching no guard would leave the ` +
        `workflow stuck forever. Add an unconditional fallback transition (plain "to:") as the last entry.`,
    );
  }
}

function summarizeTransitions(transitions: readonly AgentTransitionDefinition[]): string {
  return transitions
    .map((t) => {
      if (t.guard !== undefined) return `guard ${t.guard} -> ${t.to}`;
      if (t.when !== undefined) return `when ${JSON.stringify(t.when)} -> ${t.to}`;
      return `-> ${t.to}`;
    })
    .join('; ');
}

function validateArtifactHandoff(
  definition: WorkflowDefinition,
  stateId: string,
  state: Extract<WorkflowStateDefinition, { readonly type: 'agent' }>,
  issues: string[],
): void {
  const policy = state.artifactHandoff;
  if (!policy) return;

  if (state.transitions.length !== 1 || state.transitions[0].guard || state.transitions[0].when) {
    issues.push(`State "${stateId}" artifactHandoff requires exactly one unconditional transition.`);
  } else {
    const target = definition.states[state.transitions[0].to] as WorkflowStateDefinition | undefined;
    if (target && target.type !== 'agent' && target.type !== 'deterministic') {
      issues.push(
        `State "${stateId}" artifactHandoff target "${state.transitions[0].to}" must be an agent or deterministic validator.`,
      );
    }
  }

  for (const requiredFile of policy.requiredFiles) {
    const output = state.outputs.find((name) => requiredFile.startsWith(`${name}/`));
    if (!isSafeWorkspaceRelativePath(requiredFile) || !output) {
      issues.push(
        `State "${stateId}" artifactHandoff required file "${requiredFile}" must be a safe path below one of its declared outputs.`,
      );
    }
  }
}

/**
 * Validates `containerScope` usage across a workflow definition.
 *
 * `containerScope` is meaningful only when a shared container is
 * actually active — i.e. `sharedContainer: true` AND `mode: docker`.
 * Builtin mode ignores `sharedContainer` (see the orchestrator's
 * `shouldUseSharedContainer`), so a scope declared under
 * `mode: builtin` is a silent no-op. Either condition missing is a
 * hard error (silent no-ops are footguns). For deterministic states
 * this is reached transitively (`containerScope` requires
 * `container: true`, which requires `mode: docker`); agent states are
 * checked directly. The charset check runs at the Zod layer (see
 * `CONTAINER_SCOPE_PATTERN`).
 *
 * Note: scope governs container lifecycle (which bundle a state runs
 * in); persona governs the active policy. A scope is also one trust
 * domain, so states of different personas may share it only with
 * `settings.allowMixedPersonas: true` (see
 * {@link validateScopePersonaIsolation}). Even then the lanes of a
 * multi-lane fan-out segment, which run concurrently against the one
 * coordinator, must share a persona, enforced by
 * `validateFanOutLaneConcurrency` (statically) and by the orchestrator's
 * `preMintFanOutScopeBundle` (at runtime).
 */
function validateContainerScopes(definition: WorkflowDefinition, issues: string[]): void {
  const sharedContainer = definition.settings?.sharedContainer === true;
  const mode = definition.settings?.mode ?? 'docker';

  for (const [stateId, state] of Object.entries(definition.states)) {
    if (state.type === 'agent') {
      if (state.containerScope !== undefined && !sharedContainer) {
        issues.push(
          `State "${stateId}" declares containerScope "${state.containerScope}" but the workflow does not have sharedContainer: true. ` +
            `containerScope is only valid when sharedContainer is true.`,
        );
      }
      if (state.containerScope !== undefined && mode !== 'docker') {
        issues.push(
          `State "${stateId}" declares containerScope "${state.containerScope}" but settings.mode is "${mode}", not "docker". ` +
            `Builtin mode ignores sharedContainer, so the scope would be a silent no-op.`,
        );
      }
      continue;
    }

    if (state.type !== 'deterministic') continue;

    if (state.containerScope !== undefined && state.container !== true) {
      issues.push(`State "${stateId}" declares containerScope but is not container: true`);
    }
    if (
      (state.resultFile !== undefined || (state.fanOut === undefined && usesVerdictEdges(state.transitions))) &&
      state.container !== true
    ) {
      issues.push(
        `State "${stateId}" uses resultFile / when:{verdict} routing but is not container: true. ` +
          `Structured deterministic result routing is container-only.`,
      );
    }
    if (state.resultFile !== undefined && !isSafeWorkspaceRelativePath(state.resultFile)) {
      issues.push(
        `State "${stateId}" has resultFile "${state.resultFile}" — must be a workspace-relative path (no leading "/", no "..").`,
      );
    }
    // container: true execs into the scope's long-lived shared bundle, which
    // only exists in shared-container mode: without it each agent state owns
    // a container that is gone before the next state starts, so there is
    // nothing to exec into (see validateHostDeterministicStates).
    if (state.container === true && !sharedContainer) {
      issues.push(`State "${stateId}" has container: true but the workflow does not have sharedContainer: true.`);
    }
    if (state.container === true && mode !== 'docker') {
      issues.push(`State "${stateId}" has container: true but settings.mode is not "docker".`);
    }
  }
}

/**
 * Validates per-state `dockerAgent` (agent harness) overrides. The names
 * themselves are checked by the Zod schema (`DOCKER_AGENTS`).
 *
 * - Builtin mode runs no container, so a state-level harness would be a
 *   silent no-op: rejected. (`settings.dockerAgent` stays allowed there;
 *   `workflow run-state --mode docker` reads it.)
 * - Shared-container mode builds each scope's one container from one
 *   harness image (`resolveScopeDockerAgent`), so the agent states of a
 *   scope must resolve to the same harness. Mixed harnesses are rejected
 *   with the remedy: a separate `containerScope` per harness. Fan-out
 *   segments already run in one scope, so this covers them too.
 * - Per-state-container Docker mode gives every state its own container,
 *   so any mix of harnesses is fine there.
 */
function validateDockerAgents(definition: WorkflowDefinition, issues: string[]): void {
  if (definition.settings?.mode === 'builtin') {
    for (const [stateId, state] of Object.entries(definition.states)) {
      if (state.type === 'agent' && state.dockerAgent !== undefined) {
        issues.push(
          `State "${stateId}" sets dockerAgent "${state.dockerAgent}" but settings.mode is "builtin", which runs ` +
            'no agent container; the harness would be silently ignored. Remove it or use mode: docker.',
        );
      }
    }
    return;
  }
  if (!usesSharedContainer(definition.settings)) return;

  const scopes = new Set<string>();
  for (const state of Object.values(definition.states)) {
    if (state.type === 'agent') scopes.add(state.containerScope ?? DEFAULT_CONTAINER_SCOPE);
  }
  for (const scope of [...scopes].sort()) {
    const byAgent = collectScopeDockerAgents(definition, scope);
    if (byAgent.size <= 1) continue;
    issues.push(
      `Container scope "${scope}" mixes agent harnesses: ${describeScopeDockerAgents(byAgent)}. Under ` +
        'sharedContainer: true every state in a scope runs in one container built from one harness image. ' +
        'Give the states that use a different dockerAgent their own containerScope.',
    );
  }
}

/**
 * Host deterministic commands need an explicit per-state `host: true`.
 *
 * Without `container: true` a deterministic state's commands run on the host
 * as the user running IronCurtain, with full network access and the
 * orchestrator's environment, outside the container and the policy engine,
 * in the run workspace. Agents can write that workspace, and the toolchains
 * such states typically run (npm, pytest, make, cargo, git) execute code and
 * configuration from it, so a prompt-injected agent could turn the state into
 * host code execution. The acknowledgement makes that choice explicit; the
 * runtime refuses an unacknowledged host state as well (orchestrator).
 *
 * Container execution is the alternative only in Docker shared-container mode
 * (`validateContainerScopes`). A non-shared Docker workflow keeps no container
 * between states, and running deterministic commands there would need a
 * bundle of their own (container, proxies, teardown) that does not exist yet;
 * such a workflow sets `sharedContainer: true` to use `container: true`.
 * Builtin mode has no container at all.
 *
 * `allowUnacknowledged` skips only the acknowledgement requirement, for the
 * display-only load of a past run (see `ValidateDefinitionOptions`); the
 * contradiction check still applies.
 */
function validateHostDeterministicStates(
  definition: WorkflowDefinition,
  issues: string[],
  allowUnacknowledged: boolean,
): void {
  const mode = definition.settings?.mode ?? 'docker';
  const sharedContainer = definition.settings?.sharedContainer === true;

  for (const [stateId, state] of Object.entries(definition.states)) {
    if (state.type !== 'deterministic') continue;
    if (state.host === true && state.container === true) {
      issues.push(
        `State "${stateId}" sets both host: true and container: true; a deterministic state runs either on the host or in the container. Remove one of them.`,
      );
      continue;
    }
    if (allowUnacknowledged || state.host === true || !runsCommandsOnHost(state)) continue;

    const remedy =
      mode === 'builtin'
        ? 'Builtin mode has no container to run them in: add host: true to the state to acknowledge host execution, or move the workflow to mode: docker with settings.sharedContainer: true and set container: true.'
        : sharedContainer
          ? "Set container: true to run them in the workflow's shared container, or add host: true to the state to acknowledge host execution."
          : "Set container: true (which needs settings.sharedContainer: true) to run them in the workflow's shared container, or add host: true to the state to acknowledge host execution.";
    issues.push(
      `State "${stateId}" runs its commands on the host but does not set host: true. ` +
        'Host deterministic commands run as your user with full network access and the environment IronCurtain runs with, ' +
        'outside the container and the policy engine, in the run workspace, which agents can write; toolchains such as ' +
        'npm, pytest, make, cargo and git execute code and configuration from it (package.json scripts, conftest.py, ' +
        `Makefiles, .git/config and hooks). ${remedy}`,
    );
  }
}

/**
 * A shared-container scope is one trust domain: the agent states sharing it
 * run in the same container, one after another, with nothing reset between
 * them. `cyclePolicy` only hot-swaps the coordinator's active policy. A
 * background process or detached tool an earlier state left running keeps
 * running; the read-write agent-CLI state mount (`~/.claude`, `~/.codex`)
 * keeps any settings or hooks it wrote; `/workspace` is pre-trusted, so
 * `.claude/settings.json` hooks planted there run in every later state; and
 * any process in the container can reach the scope's MCP proxy socket, whose
 * calls the coordinator evaluates (and audits) under whichever persona is
 * loaded at that moment. A low-privilege persona that reads untrusted content
 * could therefore act under a later, more privileged persona's policy, and
 * the audit log would attribute those calls to the later persona.
 *
 * So the agent states of one scope must share a persona unless the workflow
 * sets `settings.allowMixedPersonas: true`, which declares the scope a single
 * trust domain (effectively the union of its personas' policies). Authors
 * who want the personas' containers kept apart (processes, agent-CLI state,
 * proxy socket) give each its own `containerScope`. The workspace is shared
 * by every state in every mode, so what one state writes there, including
 * agent-CLI project settings, still reaches later states; separate scopes do
 * not change that. The opt-in is rejected wherever it would be a silent no-op
 * (no effective shared container), matching how `containerScope` itself is
 * validated.
 *
 * Per-state-container Docker mode (no `sharedContainer`) and builtin mode do
 * not share a container between states, so this rule does not apply there.
 *
 * `allowMixed` skips only the one-persona requirement, for the display-only
 * load of a past run (see `ValidateDefinitionOptions`); a misplaced
 * `allowMixedPersonas` is still rejected.
 */
function validateScopePersonaIsolation(definition: WorkflowDefinition, issues: string[], allowMixed: boolean): void {
  const settings = definition.settings;
  if (!usesSharedContainer(settings)) {
    if (settings?.allowMixedPersonas !== undefined) {
      issues.push(
        'settings.allowMixedPersonas is only valid when the workflow runs in a shared container ' +
          '(sharedContainer: true and mode: docker); without one, states never share a container.',
      );
    }
    return;
  }
  if (allowMixed || settings?.allowMixedPersonas === true) return;

  const statesByScopeAndPersona = new Map<string, Map<string, string[]>>();
  for (const [stateId, state] of Object.entries(definition.states)) {
    if (state.type !== 'agent') continue;
    const scope = state.containerScope ?? DEFAULT_CONTAINER_SCOPE;
    let personas = statesByScopeAndPersona.get(scope);
    if (personas === undefined) {
      personas = new Map();
      statesByScopeAndPersona.set(scope, personas);
    }
    const stateIds = personas.get(state.persona) ?? [];
    stateIds.push(stateId);
    personas.set(state.persona, stateIds);
  }

  for (const [scope, personas] of statesByScopeAndPersona) {
    if (personas.size < 2) continue;
    const described = [...personas].map(([persona, stateIds]) => `${persona} (${stateIds.join(', ')})`).join('; ');
    issues.push(
      `containerScope "${scope}" mixes personas: ${described}. The states of a scope share one container, so ` +
        `processes, agent-CLI settings and workspace hooks left by an earlier state run on under a later ` +
        `persona's policy, and its tool calls are audited as that persona. Give each persona its own ` +
        `containerScope, or set settings.allowMixedPersonas: true to accept the scope as one trust domain.`,
    );
  }
}

/**
 * `workspaceAccess: read-only` (see `AgentStateDefinition.workspaceAccess`):
 *
 * - Not on fan-out states: a driver's own prompt never runs, and the lanes
 *   of a segment would each need their own writable outputs.
 * - Every output name must be a plain relative path: its `.workflow/<output>`
 *   directory is the only place the state may write, and the policy engine
 *   and the orchestrator join it below the workspace.
 * - In shared-container mode the agent states of one `containerScope` must
 *   all have the same access: they share one container, whose `/workspace` is
 *   either mounted read-only or not, and one coordinator, which either
 *   confines changes or not. Read-only states get their own scope.
 * - A containerized deterministic state that runs in a read-only scope cannot
 *   declare a `resultFile`: its commands run in that container, so they could
 *   not write it.
 */
function validateReadOnlyStates(definition: WorkflowDefinition, issues: string[]): void {
  const shared = usesSharedContainer(definition.settings);
  const accessByScope = new Map<string, { readonly readOnly: string[]; readonly readWrite: string[] }>();

  for (const [stateId, state] of Object.entries(definition.states)) {
    if (state.type !== 'agent') continue;
    const readOnly = isReadOnlyAgentState(state);
    if (readOnly) {
      if (state.fanOut !== undefined || state.fanOutMember === true) {
        issues.push(
          `State "${stateId}" sets workspaceAccess: read-only but is a fan-out ${state.fanOut !== undefined ? 'state' : 'segment member'}; ` +
            'read-only access is only supported on ordinary agent states.',
        );
      }
      for (const output of state.outputs) {
        if (!isPlainRelativePath(output)) {
          issues.push(
            `State "${stateId}" sets workspaceAccess: read-only but its output "${output}" is not a plain relative path ` +
              '(no empty, "." or ".." components, no backslash); its .workflow/<output> directory is the only place the state may write.',
          );
        }
      }
    }
    if (!shared) continue;
    const scope = state.containerScope ?? DEFAULT_CONTAINER_SCOPE;
    let access = accessByScope.get(scope);
    if (access === undefined) {
      access = { readOnly: [], readWrite: [] };
      accessByScope.set(scope, access);
    }
    (readOnly ? access.readOnly : access.readWrite).push(stateId);
  }

  for (const [scope, access] of accessByScope) {
    if (access.readOnly.length === 0 || access.readWrite.length === 0) continue;
    issues.push(
      `containerScope "${scope}" mixes read-only states (${access.readOnly.join(', ')}) and read-write states ` +
        `(${access.readWrite.join(', ')}). The states of a scope share one container, whose /workspace is mounted ` +
        'read-only or not. Give the read-only states their own containerScope.',
    );
  }

  for (const [stateId, state] of Object.entries(definition.states)) {
    if (state.type !== 'deterministic' || state.container !== true || state.resultFile === undefined) continue;
    const scope = state.containerScope ?? DEFAULT_CONTAINER_SCOPE;
    if ((accessByScope.get(scope)?.readOnly.length ?? 0) === 0) continue;
    issues.push(
      `State "${stateId}" declares resultFile but runs in containerScope "${scope}", whose agent states are read-only: ` +
        'its commands could not write the result file there. Run it in a read-write scope.',
    );
  }
}

function validateHumanGate(stateId: string, state: HumanGateStateDefinition, issues: string[]): void {
  if (state.transitions.length === 0) {
    issues.push(`Human gate "${stateId}" must have at least one transition`);
  }

  const acceptedSet = new Set(state.acceptedEvents);
  for (const t of state.transitions) {
    if (!acceptedSet.has(t.event)) {
      issues.push(`Human gate "${stateId}" transition uses event "${t.event}" not in acceptedEvents`);
    }
  }
}

function validateArtifactInputs(definition: WorkflowDefinition, issues: string[]): void {
  const availableOutputs = collectOutputArtifacts(definition.states);

  for (const [stateId, state] of Object.entries(definition.states)) {
    if (state.type !== 'agent') continue;
    const agentState = state;
    for (const input of agentState.inputs) {
      const { name, isOptional } = parseArtifactRef(input);
      if (!isOptional && !availableOutputs.has(name)) {
        issues.push(`State "${stateId}" requires input artifact "${name}" not produced by any state`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * One issue produced by {@link iterateSkillRefIssues}. Surface code
 * (validate vs lint) formats the user-facing wording.
 */
export type SkillRefIssue =
  | { kind: 'invalid-name'; stateId: string; name: string; detail: string }
  | { kind: 'unknown-name'; stateId: string; name: string };

/**
 * Walks every agent state's `skills[]` and yields a structured issue
 * per offending entry, classifying shape failures (`invalid-name`)
 * separately from membership failures (`unknown-name`). Shape-first:
 * an entry that fails the shape check is yielded as such and not
 * checked for membership, which would otherwise emit a confusing
 * "skill not found" message for inputs that were never valid names.
 */
export function* iterateSkillRefIssues(
  definition: WorkflowDefinition,
  discoveredNames: ReadonlySet<string>,
): Generator<SkillRefIssue> {
  for (const [stateId, state] of Object.entries(definition.states)) {
    if (state.type !== 'agent' || state.skills === undefined) continue;
    if (state.skills === SKILLS_NONE) continue;
    for (const name of state.skills) {
      try {
        validateSkillName(name);
      } catch (err) {
        yield { kind: 'invalid-name', stateId, name, detail: errorMessage(err) };
        continue;
      }
      if (!discoveredNames.has(name)) {
        yield { kind: 'unknown-name', stateId, name };
      }
    }
  }
}

/**
 * Verifies every `skills[]` entry on an agent state matches a SKILL.md
 * frontmatter `name:` under `<packageDir>/skills/`. Membership is
 * keyed on the frontmatter name (also what `workflowSkillFilter` in
 * `src/skills/discovery.ts` matches), not the directory name —
 * `existsSync` on the dir would miss dir-vs-frontmatter mismatches.
 * Called from orchestrator `start()` only.
 *
 * @throws {WorkflowValidationError} when any entry is invalid or unknown
 */
export function validateWorkflowSkillReferences(definition: WorkflowDefinition, packageDir: string): void {
  const skillsRoot = resolve(packageDir, 'skills');
  const discoveredNames = new Set(discoverSkills(skillsRoot, 'workflow').map((s) => s.name));
  const available = [...discoveredNames].sort();
  const availableHint = available.length > 0 ? available.join(', ') : '(none)';

  const issues: string[] = [];
  for (const issue of iterateSkillRefIssues(definition, discoveredNames)) {
    if (issue.kind === 'invalid-name') {
      issues.push(`State "${issue.stateId}" has invalid skill name "${issue.name}": ${issue.detail}.`);
    } else {
      issues.push(
        `State "${issue.stateId}" references skill "${issue.name}" but no skill with that frontmatter name was found under ${skillsRoot}. Available: ${availableHint}.`,
      );
    }
  }

  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }
}

/** Options for {@link validateDefinition}. */
export interface ValidateDefinitionOptions {
  /**
   * Accept deterministic states that would run commands on the host without
   * `host: true`. Only for loading a past run's recorded definition in order
   * to display or check it (`workflow inspect`, the web UI's past runs and
   * message logs, an import and its host-command trust check; see
   * `RECORDED_DEFINITION_ALLOWANCES`): a run recorded before the
   * acknowledgement existed is still worth showing, and showing it runs
   * nothing. Starting and resuming a run never pass this, and the
   * orchestrator refuses an unacknowledged host state at runtime regardless.
   */
  readonly allowUnacknowledgedHostStates?: boolean;
  /**
   * Accept agent states of different personas in one shared-container scope
   * without `settings.allowMixedPersonas: true`. Display-only, exactly like
   * `allowUnacknowledgedHostStates`: a run recorded before the one persona
   * per scope rule existed is still worth showing, and showing it runs
   * nothing. Starting and resuming a run never pass this.
   */
  readonly allowMixedPersonaScopes?: boolean;
}

/**
 * Validates a parsed object as a WorkflowDefinition.
 * Performs structural parsing (Zod) then semantic checks.
 * The input can come from JSON.parse() or YAML.parse().
 *
 * @throws {WorkflowValidationError} with structured list of issues
 */
export function validateDefinition(raw: unknown, options: ValidateDefinitionOptions = {}): WorkflowDefinition {
  // Raw-level checks run first so that fields Zod would strip (e.g.,
  // `maxVisits` on non-agent states) and malformed state IDs produce
  // clear, targeted errors instead of being silently dropped.
  const rawIssues = validateRawInput(raw);
  if (rawIssues.length > 0) {
    throw new WorkflowValidationError(rawIssues);
  }

  let parsed: WorkflowDefinition;
  try {
    parsed = workflowDefinitionSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      throw new WorkflowValidationError(issues);
    }
    throw err;
  }
  validateSemantics(parsed, options);
  return parsed;
}

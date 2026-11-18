/**
 * Workflow-related JSON-RPC method dispatch.
 *
 * Handles all `workflows.*` methods: list, get, start, resume, abort,
 * resolveGate, inspect, fileTree, fileContent, artifacts, artifactFile,
 * messageLog, messageLogEntry.
 *
 * The file-browser methods read an agent-writable workspace, so every read of
 * agent-controlled bytes goes through the hardened helpers in
 * `src/hardened-fs.ts` (no-follow, non-blocking, bounded) and every listing is
 * bounded in entries, depth and bytes. See the "File browser helpers" section.
 */

import { existsSync, lstatSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve, extname, isAbsolute, normalize, relative, sep } from 'node:path';
import { z } from 'zod';

import { type DispatchContext, validateParams } from './types.js';
import {
  type WorkflowSummaryDto,
  type WorkflowDetailDto,
  type PastRunDto,
  type MessageLogEntryDto,
  type MessageLogEntryResponseDto,
  type MessageLogResponseDto,
  type FileTreeEntryDto,
  type FileTreeResponseDto,
  type FileContentResponseDto,
  type ArtifactContentDto,
  type ArtifactFileDto,
  type LatestVerdictDto,
  type LiveWorkflowPhase,
  type PastRunPhase,
  type WorkflowDefinitionDto,
  type WorkflowReadmeDto,
  type WorkflowEscalationDto,
  RpcError,
  MethodNotFoundError,
} from '../web-ui-types.js';
import { openDirectoryBelow, readUntrustedRegularFileBelow, type DirectoryBelow } from '../../hardened-fs.js';
import type { PastRunLoadError, PastRunLoadSuccess, WorkflowManager } from '../../workflow/workflow-manager.js';
import {
  toHumanGateRequestDto,
  WORKFLOW_ID_PATTERN,
  type WorkflowId,
  type WorkflowStatus,
  type WorkflowCheckpoint,
  type WorkflowDefinition,
} from '../../workflow/types.js';
import type { WorkflowDetail } from '../../workflow/orchestrator.js';
import {
  isWorkflowResumeError,
  isGateResolutionError,
  type GateResolutionErrorCode,
  type WorkflowResumeErrorCode,
} from '../../workflow/errors.js';
import { DECLARABLE_GATE_RESOLUTION_CHANNELS } from '../../workflow/gate-binding.js';
import {
  CHECKPOINT_SAVE_ERROR_CONTEXT,
  HOST_MOUNT_SCAN_ERROR_CONTEXT,
  MessageLog,
  type LocatedMessageLogEntry,
  type MessageLogEntry,
  type StateTransitionEntry,
} from '../../workflow/message-log.js';
import {
  discoverWorkflowRuns,
  discoverWorkspacePathFromContainers,
  summaryForId,
  type WorkflowRunSummary,
} from '../../workflow/workflow-discovery.js';
import { discoverWorkflows, findWorkflowByName, readWorkflowReadme } from '../../workflow/discovery.js';
import { extractStateGraph } from '../state-graph.js';
import { expandTilde, isWithinDirectory } from '../../types/argument-roles.js';
import { isWorkspaceValidationError } from '../../session/workspace-validation.js';
import { runPreflight } from '../../workflow/lint-integration.js';
import * as logger from '../../logger.js';
import { errorMessage } from '../../utils/error-message.js';
import { assertEscalationReviewable, escalationForWire } from '../escalation-wire.js';
import { isWorkflowRunLockHeld } from '../../workflow/run-lock.js';
import { terminalPhaseFromStateName } from '../../workflow/terminal-phase.js';
import { loadDefinition } from '../../workflow/definition-loader.js';
import {
  resolveWorkflowResourceBudget,
  legacyWorkflowBudget,
  pastRunWorkflowBudget,
} from '../../workflow/resource-budget.js';
import { parseWorkflowUsage } from '../../workflow/workflow-usage.js';

// Phases a checkpoint's recorded `finalStatus` may carry. `running_elsewhere`
// is never recorded: it is derived from a held run lock (computePastRunPhase).
const PAST_RUN_PHASES = new Set<PastRunPhase>(['completed', 'aborted', 'failed', 'waiting_human', 'interrupted']);

function isPastRunPhase(value: string | undefined): value is PastRunPhase {
  return value !== undefined && PAST_RUN_PHASES.has(value as PastRunPhase);
}

/** Returns the entry with the largest `ts` among `state_transition` entries, or undefined. */
function findLastStateTransition(entries: readonly MessageLogEntry[]): StateTransitionEntry | undefined {
  let last: StateTransitionEntry | undefined;
  for (const entry of entries) {
    if (entry.type !== 'state_transition') continue;
    if (last === undefined || entry.ts > last.ts) last = entry;
  }
  return last;
}

/** Defensive state lookup (runtime-safe; the index signature lies about presence). */
function getStateDef(definition: WorkflowDefinition, name: string): WorkflowDefinition['states'][string] | undefined {
  return Object.prototype.hasOwnProperty.call(definition.states, name) ? definition.states[name] : undefined;
}

// ---------------------------------------------------------------------------
// Param validation schemas
// ---------------------------------------------------------------------------

/**
 * Every workflow id names a directory under the workflow-runs directory, so
 * each `workflows.*` method accepts only a single safe path segment
 * (`WORKFLOW_ID_PATTERN`); `../x` is refused as INVALID_PARAMS before any
 * path is built from it.
 */
const workflowIdField = z
  .string()
  .regex(WORKFLOW_ID_PATTERN, 'workflowId must be 1-128 letters, digits, "_" or "-" (one path segment)');

const workflowIdSchema = z.object({ workflowId: workflowIdField });
const workflowResolveEscalationSchema = z.object({
  workflowId: workflowIdField,
  /**
   * Required for an approval. A denial may omit it when exactly one
   * escalation is pending (denying an unseen call fails closed).
   */
  escalationId: z.string().min(1).optional(),
  decision: z.enum(['approved', 'denied']),
  whitelistSelection: z.number().int().nonnegative().optional(),
});
const workflowStartSchema = z.object({
  definitionPath: z.string().min(1),
  taskDescription: z.string().min(1),
  workspacePath: z.string().min(1).optional(),
});
// Every gate decision is bound to one raise: `gateId` must be the id the
// client read from `workflows.get` / `workflow.gate_raised`, and the
// orchestrator rejects any other (GATE_MISMATCH). `resolvedBy` is the channel
// the client declares for the audit log (all clients share one bearer token,
// so it cannot be authenticated); undeclared callers are recorded as `rpc`.
// FORCE_REVISION and REPLAN require non-empty feedback: the orchestrator
// injects this into the next agent's prompt, and an empty string produces
// an incoherent re-entry prompt. Orchestrator validates too; this is the
// first line of defense for external (JSON-RPC) callers.
const gateDecisionFields = {
  workflowId: workflowIdField,
  gateId: z.string().min(1, 'gateId is required: pass the gateId of the gate being resolved'),
  resolvedBy: z.enum(DECLARABLE_GATE_RESOLUTION_CHANNELS).optional(),
};
const workflowResolveGateSchema = z.discriminatedUnion('event', [
  z.object({ ...gateDecisionFields, event: z.literal('APPROVE'), prompt: z.string().optional() }),
  z.object({ ...gateDecisionFields, event: z.literal('ABORT'), prompt: z.string().optional() }),
  z.object({
    ...gateDecisionFields,
    event: z.literal('FORCE_REVISION'),
    prompt: z.string().trim().min(1, 'Feedback is required for FORCE_REVISION events'),
  }),
  z.object({
    ...gateDecisionFields,
    event: z.literal('REPLAN'),
    prompt: z.string().trim().min(1, 'Feedback is required for REPLAN events'),
  }),
]);

/** Maps an orchestrator gate refusal onto the wire error code. */
function gateResolutionRpcCode(code: GateResolutionErrorCode): RpcError['code'] {
  // Missing feedback is a malformed request, the same class the schema
  // reports when it catches the case first.
  return code === 'FEEDBACK_REQUIRED' ? 'INVALID_PARAMS' : code;
}

/** Maps a resume / import refusal onto the wire error code. */
function resumeRpcCode(code: WorkflowResumeErrorCode): RpcError['code'] {
  switch (code) {
    case 'WORKFLOW_CHECKPOINT_CORRUPTED':
      return 'WORKFLOW_CORRUPTED';
    // A malformed id or a run directory given as a base directory is a bad
    // request, like the schema's own rejections.
    case 'WORKFLOW_INVALID_ID':
    case 'WORKFLOW_INVALID_BASE_DIR':
      return 'INVALID_PARAMS';
    default:
      return code;
  }
}

/** Runs `operation`, turning a resume / import refusal into its RPC error. */
async function withResumeErrors<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (isWorkflowResumeError(err)) throw new RpcError(resumeRpcCode(err.code), err.message);
    throw err;
  }
}

/** The RPC error for a past run that could not be loaded. */
function pastRunLoadRpcError(result: PastRunLoadError, workflowId: string): RpcError {
  switch (result.error) {
    case 'not_found':
      return new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${workflowId} not found`);
    case 'too_new':
      return new RpcError(
        'WORKFLOW_CHECKPOINT_TOO_NEW',
        result.message ?? `Workflow ${workflowId} was written by a newer IronCurtain`,
      );
    case 'corrupted':
      return new RpcError('WORKFLOW_CORRUPTED', result.message ?? `Workflow ${workflowId} checkpoint is corrupted`);
  }
}
const workflowFileTreeSchema = z.object({
  workflowId: workflowIdField,
  path: z.string().optional(),
});
const workflowFileContentSchema = z.object({
  workflowId: workflowIdField,
  path: z.string().min(1),
});
const workflowArtifactSchema = z.object({
  workflowId: workflowIdField,
  artifactName: z.string().min(1),
});
const workflowArtifactFileSchema = z.object({
  workflowId: workflowIdField,
  artifactName: z.string().min(1),
  path: z.string().min(1),
});
// Cursor-pagination params for `workflows.messageLog`. The 2000-entry hard
// cap is a DoS guardrail: each entry is read+parsed in process, and a single
// pathologically-large request shouldn't be able to stall the dispatch loop.
// The default of 200 (applied in the handler when `limit` is omitted) matches
// the page size the frontend's "Load older" UX is designed around. Pages are
// also capped in bytes (MAX_MESSAGE_LOG_PAGE_BYTES) by the reader.
const workflowMessageLogSchema = z.object({
  workflowId: workflowIdField,
  before: z.string().optional(),
  limit: z.number().int().positive().max(2000).optional(),
});
// `ref` is the `<offset>:<length>` location a page entry carries when it was
// truncated (see `toMessageLogEntryDto`).
const workflowMessageLogEntrySchema = z.object({
  workflowId: workflowIdField,
  ref: z.string().regex(/^\d{1,15}:\d{1,15}$/, 'ref must be <offset>:<length>'),
});

// `workflows.readme`: fetch a workflow's co-packaged README markdown. Address it
// either by definition manifest path (Start picker, no running workflow) or by a
// running/past workflow id (detail view). Exactly one must be provided.
const workflowReadmeSchema = z
  .object({
    definitionPath: z.string().min(1).optional(),
    workflowId: workflowIdField.optional(),
  })
  .refine((v) => (v.definitionPath ? 1 : 0) + (v.workflowId ? 1 : 0) === 1, {
    message: 'Provide exactly one of definitionPath or workflowId',
  });

const DEFAULT_MESSAGE_LOG_LIMIT = 200;

/**
 * Manifest names of workflows marked `hidden: true`. Used to suppress
 * smoke-test / fixture workflows' *runs* from the web UI's active and
 * past-run listings (the definition picker filters on the entry directly).
 * Run records carry `definition.name`, which equals the discovery entry's
 * directory name by convention — see {@link findWorkflowByName}.
 */
function hiddenWorkflowNames(): Set<string> {
  return new Set(
    discoverWorkflows()
      .filter((entry) => entry.hidden)
      .map((entry) => entry.name),
  );
}

/** True when a workflow's source package ships a README (best-effort name lookup). */
function workflowHasReadme(name: string): boolean {
  return findWorkflowByName(name)?.hasReadme ?? false;
}

/** Reads README markdown for a discovered manifest, or throws `README_NOT_FOUND`. */
function readmeDtoOrThrow(manifestPath: string, name: string): WorkflowReadmeDto {
  const content = readWorkflowReadme(manifestPath);
  if (content === undefined) {
    throw new RpcError('README_NOT_FOUND', `Workflow "${name}" has no README`);
  }
  return { content };
}

/**
 * Resolves a definition manifest for README and budget preview reads.
 * Only *discovered* workflows are served — never an arbitrary client path —
 * which both validates the input and confines reads to the workflow trees.
 */
function findDiscoveredDefinitionOrThrow(definitionPath: string) {
  const target = resolve(definitionPath);
  const entry = discoverWorkflows().find((e) => resolve(e.path) === target);
  if (!entry) {
    throw new RpcError('WORKFLOW_NOT_FOUND', `Unknown workflow definition: ${definitionPath}`);
  }
  return entry;
}

function readReadmeForDefinitionPath(definitionPath: string): WorkflowReadmeDto {
  const entry = findDiscoveredDefinitionOrThrow(definitionPath);
  return readmeDtoOrThrow(entry.path, entry.name);
}

/** Resolves a running/past workflow id to its definition name (manifest `name:`). */
function resolveWorkflowName(
  controller: ReturnType<WorkflowManager['getOrchestrator']>,
  manager: WorkflowManager,
  id: WorkflowId,
): string | undefined {
  const detail = controller.getDetail(id);
  if (detail) return detail.definition.name;
  const result = manager.loadPastRun(id);
  if ('error' in result) return undefined;
  return result.definition.name;
}

/** Serves a README addressed by running/past workflow id (detail view). */
function readReadmeForWorkflowId(
  controller: ReturnType<WorkflowManager['getOrchestrator']>,
  manager: WorkflowManager,
  id: WorkflowId,
): WorkflowReadmeDto {
  const name = resolveWorkflowName(controller, manager, id);
  if (!name) {
    throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${id} not found`);
  }
  const entry = findWorkflowByName(name);
  if (!entry) {
    // Run references a workflow no longer discoverable (e.g. a one-off custom path).
    throw new RpcError('README_NOT_FOUND', `No README available for workflow ${id}`);
  }
  return readmeDtoOrThrow(entry.path, entry.name);
}

/** An import source must be an existing directory (checked again, with more, by the manager). */
function assertImportableDirectory(baseDir: string): void {
  if (!existsSync(baseDir)) {
    throw new RpcError('INVALID_PARAMS', `Directory does not exist: ${baseDir}`);
  }
  if (!statSync(baseDir).isDirectory()) {
    throw new RpcError('INVALID_PARAMS', `Path is not a directory: ${baseDir}`);
  }
}

// ---------------------------------------------------------------------------
// Extended dispatch context
// ---------------------------------------------------------------------------

export interface WorkflowDispatchContext extends DispatchContext {
  workflowManager?: WorkflowManager;
}

// ---------------------------------------------------------------------------
// Lint pre-flight (daemon)
// ---------------------------------------------------------------------------

/**
 * Parses + validates the definition file, then runs the shared
 * `runPreflight()` helper in `warn` mode. Errors abort via `LINT_FAILED`;
 * warnings are logged and ignored.
 *
 * The `warn` mode is the right default for the daemon: warnings are
 * advisory and should not block a workflow start from the web UI,
 * whereas true errors indicate a workflow that will not run correctly.
 */
function preflightLintForDaemon(definitionPath: string): void {
  const result = runPreflight(definitionPath, 'warn');

  if (result.ok) {
    if (result.warnings > 0) {
      logger.warn(
        `[workflow-dispatch] Lint warnings for ${definitionPath}: ${result.diagnostics
          .map((d) => `[${d.code}] ${d.message}`)
          .join(' | ')}`,
      );
    }
    return;
  }

  if (result.kind === 'load') {
    // `loadDefinition` builds the message in the same format the previous
    // inline implementation used: validate failures begin with "Workflow
    // validation failed: ..."; parse failures are wrapped here with the
    // legacy "Failed to load workflow definition:" prefix to preserve the
    // existing wording for daemon consumers.
    if (result.loadKind === 'validate') {
      throw new RpcError('INVALID_PARAMS', result.message);
    }
    throw new RpcError('INVALID_PARAMS', `Failed to load workflow definition: ${result.message}`);
  }

  // Lint failure (load succeeded).
  throw new RpcError('LINT_FAILED', `Workflow lint failed: ${result.errors} error(s), ${result.warnings} warning(s).`, {
    diagnostics: result.diagnostics,
  });
}

// ---------------------------------------------------------------------------
// Workflow dispatch
// ---------------------------------------------------------------------------

export async function workflowDispatch(
  ctx: WorkflowDispatchContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'workflows.getBudgetPreview') {
    const { definitionPath } = validateParams(z.object({ definitionPath: z.string().min(1) }).strict(), params);
    const entry = findDiscoveredDefinitionOrThrow(definitionPath);
    const result = loadDefinition(entry.path);
    if (!result.ok) throw new RpcError('INVALID_PARAMS', result.message);
    return resolveWorkflowResourceBudget(result.definition.settings);
  }
  // workflows.listDefinitions does not need a running workflow manager.
  // `hidden` workflows (smoke tests / fixtures) are filtered out — they
  // remain runnable from the CLI but never appear in the web UI picker.
  if (method === 'workflows.listDefinitions') {
    const definitions: WorkflowDefinitionDto[] = discoverWorkflows()
      .filter((entry) => !entry.hidden)
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        path: entry.path,
        source: entry.source,
        hasReadme: entry.hasReadme,
      }));
    return definitions;
  }

  // workflows.readme is handled here, in one place: the definitionPath form
  // (Start picker) needs no workflow manager, while the workflowId form
  // (detail view) does. The schema's refine guarantees exactly one is set.
  if (method === 'workflows.readme') {
    const { definitionPath, workflowId } = validateParams(workflowReadmeSchema, params);
    if (definitionPath) {
      return readReadmeForDefinitionPath(definitionPath);
    }
    if (!ctx.workflowManager) {
      throw new RpcError('INTERNAL_ERROR', 'Workflow system not available');
    }
    const mgr = ctx.workflowManager;
    return readReadmeForWorkflowId(mgr.getOrchestrator(), mgr, workflowId as WorkflowId);
  }

  if (!ctx.workflowManager) {
    throw new RpcError('INTERNAL_ERROR', 'Workflow system not available');
  }
  const manager = ctx.workflowManager;
  const controller = manager.getOrchestrator();

  switch (method) {
    case 'workflows.getBudget': {
      const { workflowId } = validateParams(workflowIdSchema.strict(), params);
      const id = workflowId as WorkflowId;
      if (typeof controller.getBudget === 'function') {
        const budget = controller.getBudget(id);
        if (budget) return budget;
      } else {
        // Compatibility for injected controllers predating the narrow accessor.
        const detail = controller.getDetail(id);
        if (detail) return detail.budget ?? legacyWorkflowBudget(detail.definition.settings);
      }
      const result = manager.loadPastRun(id);
      if ('error' in result) throw pastRunLoadRpcError(result, workflowId);
      return pastRunWorkflowBudget(result.checkpoint, result.definition.settings);
    }

    case 'workflows.list': {
      const activeIds = controller.listActive();
      // Suppress hidden workflows' runs (smoke tests / fixtures) from the UI.
      const hidden = hiddenWorkflowNames();
      const summaries: WorkflowSummaryDto[] = [];
      for (const id of activeIds) {
        const status = controller.getStatus(id);
        if (status) {
          const detail = controller.getDetail(id);
          const dto = buildSummaryDto(id, status, detail);
          if (hidden.has(dto.name)) continue;
          summaries.push(dto);
        }
      }
      return summaries;
    }

    case 'workflows.get': {
      const { workflowId } = validateParams(workflowIdSchema, params);
      const id = workflowId as WorkflowId;
      const status = controller.getStatus(id);
      if (status) {
        const detail = controller.getDetail(id);
        return buildDetailDto(id, status, detail, controller.listToolCallEscalations(id));
      }
      // Live miss -- fall back to the on-disk past-run loader (D6). A
      // 'corrupted' result keeps the loader's diagnostic message for the UI.
      const result = manager.loadPastRun(id);
      if ('error' in result) throw pastRunLoadRpcError(result, workflowId);
      // `buildDetailFromPastRun` only consults `summary.mtime` in the
      // checkpoint-less branch, so a synthetic now-dated summary is safe in
      // the rare race where the directory vanished between load and lookup.
      const summary = summaryForId(manager.getBaseDir(), id) ?? {
        workflowId: id,
        directoryPath: resolve(manager.getBaseDir(), id),
        hasCheckpoint: false,
        hasDefinition: false,
        hasMessageLog: false,
        mtime: new Date(),
        filesKey: '',
      };
      return buildDetailFromPastRun(id, result, summary);
    }

    case 'workflows.start': {
      const { definitionPath, taskDescription, workspacePath } = validateParams(workflowStartSchema, params);
      // A relative path would resolve against the daemon's working directory,
      // which the caller neither sees nor controls.
      if (workspacePath !== undefined && !isAbsolute(expandTilde(workspacePath))) {
        throw new RpcError('INVALID_PARAMS', `workspacePath must be an absolute path: ${workspacePath}`);
      }
      // Pre-flight lint: runs in `warn` mode (errors abort, warnings log and pass).
      // Controller.start() re-parses and re-validates internally; this extra
      // parse is the cheapest way to reach a validated WorkflowDefinition.
      preflightLintForDaemon(definitionPath);
      try {
        // The orchestrator validates the workspace authoritatively
        // (validateWorkspacePath) before creating anything.
        const workflowId = await controller.start(definitionPath, taskDescription, workspacePath);
        return { workflowId };
      } catch (err) {
        if (isWorkspaceValidationError(err)) {
          throw new RpcError('INVALID_PARAMS', `Invalid workspace: ${err.message}`);
        }
        throw err;
      }
    }

    case 'workflows.listResumable': {
      // Despite the legacy name (kept per design decision D4), this method
      // returns *all* past runs on disk -- terminal (completed/failed/aborted),
      // gate-paused (`waiting_human`), and `interrupted` (no live orchestrator
      // and no `finalStatus`). Not just runs the user could literally resume.
      return buildResumableList(manager);
    }

    case 'workflows.import': {
      // `trust`: the caller reviewed the imported definition and accepts that
      // it runs commands on this host (CLI `--trust`); refused without it.
      const schema = z.object({
        baseDir: z.string().min(1),
        workflowId: workflowIdField.optional(),
        trust: z.boolean().optional(),
      });
      const { baseDir, workflowId, trust } = validateParams(schema, params);

      assertImportableDirectory(baseDir);
      const importedId = await withResumeErrors(() =>
        manager.importExternalCheckpoint(baseDir, workflowId, { trust: trust === true }),
      );
      return { workflowId: importedId };
    }

    case 'workflows.resume': {
      const schema = z.object({
        workflowId: workflowIdField.optional(),
        baseDir: z.string().min(1).optional(),
        useCurrentBudget: z.boolean().optional(),
        trust: z.boolean().optional(),
      });
      const { workflowId, baseDir, useCurrentBudget, trust } = validateParams(schema, params);

      return withResumeErrors(async () => {
        let resolvedId: WorkflowId;
        if (baseDir) {
          assertImportableDirectory(baseDir);
          resolvedId = manager.importExternalCheckpoint(baseDir, workflowId, { trust: trust === true });
        } else if (workflowId) {
          resolvedId = workflowId as WorkflowId;
        } else {
          throw new RpcError('INVALID_PARAMS', 'Either workflowId or baseDir must be provided');
        }

        await controller.resume(resolvedId, useCurrentBudget ? { useCurrentBudget: true } : undefined);
        return { accepted: true, workflowId: resolvedId };
      });
    }

    case 'workflows.abort': {
      const { workflowId } = validateParams(workflowIdSchema, params);
      const id = workflowId as WorkflowId;
      const status = controller.getStatus(id);
      if (!status) {
        throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${workflowId} not found`);
      }
      await controller.abort(id);
      return;
    }

    case 'workflows.resolveGate': {
      const { workflowId, gateId, event, prompt, resolvedBy } = validateParams(workflowResolveGateSchema, params);
      const id = workflowId as WorkflowId;
      const status = controller.getStatus(id);
      if (!status) {
        throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${workflowId} not found`);
      }
      if (status.phase !== 'waiting_human') {
        throw new RpcError('WORKFLOW_NOT_AT_GATE', `Workflow ${workflowId} is not waiting at a gate`);
      }
      // The orchestrator is authoritative for the gate binding and the
      // accepted-event check; a refusal surfaces as a typed RPC error and
      // the gate stays up untouched.
      try {
        controller.resolveGate(id, { gateId, type: event, prompt, resolvedBy: resolvedBy ?? 'rpc' });
      } catch (err) {
        if (isGateResolutionError(err)) {
          throw new RpcError(gateResolutionRpcCode(err.code), err.message);
        }
        throw err;
      }
      return;
    }

    case 'workflows.resolveEscalation': {
      const { workflowId, escalationId, decision, whitelistSelection } = validateParams(
        workflowResolveEscalationSchema,
        params,
      );
      const id = workflowId as WorkflowId;
      if (!controller.getStatus(id)) {
        throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${workflowId} not found`);
      }
      const pending = controller.listToolCallEscalations(id);
      let target: WorkflowEscalationDto | undefined;
      if (escalationId === undefined) {
        // An approval binds to the call the decider reviewed. Without the
        // id, an escalation that expired after it was reviewed and a new one
        // the agent raised meanwhile would be indistinguishable, and the
        // approval would run a call nobody saw.
        if (decision === 'approved') {
          throw new RpcError(
            'INVALID_PARAMS',
            'An approval must name the escalation it approves: pass escalationId (as listed by workflows.get)',
          );
        }
        if (pending.length === 0) {
          throw new RpcError('ESCALATION_NOT_FOUND', `Workflow ${workflowId} has no pending tool-call escalation`);
        }
        if (pending.length > 1) {
          throw new RpcError(
            'INVALID_PARAMS',
            `Workflow ${workflowId} has ${pending.length} pending escalations; pass escalationId`,
          );
        }
        target = pending[0];
      } else {
        target = pending.find((candidate) => candidate.escalationId === escalationId);
        if (!target) {
          throw new RpcError(
            'ESCALATION_NOT_FOUND',
            `Escalation ${escalationId} is not pending for workflow ${workflowId}`,
          );
        }
      }
      if (decision === 'approved') assertEscalationReviewable(target);
      if (whitelistSelection !== undefined) {
        if (decision !== 'approved') {
          throw new RpcError('INVALID_PARAMS', 'whitelistSelection only applies to an approval');
        }
        const candidateCount = target.whitelistCandidates?.length ?? 0;
        if (whitelistSelection >= candidateCount) {
          throw new RpcError(
            'INVALID_PARAMS',
            `whitelistSelection ${whitelistSelection} is out of range (escalation has ${candidateCount} whitelist candidate(s))`,
          );
        }
      }
      // The escalation can still expire between the check above and here;
      // the controller reports that as not pending.
      const resolved = controller.resolveToolCallEscalation(id, target.escalationId, {
        decision,
        ...(whitelistSelection !== undefined ? { whitelistSelection } : {}),
      });
      if (!resolved) {
        throw new RpcError(
          'ESCALATION_NOT_FOUND',
          `Escalation ${target.escalationId} is not pending for workflow ${workflowId}`,
        );
      }
      return { escalationId: target.escalationId, decision };
    }

    case 'workflows.inspect': {
      const { workflowId } = validateParams(workflowIdSchema, params);
      const id = workflowId as WorkflowId;
      const status = controller.getStatus(id);
      if (!status) {
        throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${workflowId} not found`);
      }
      return { status };
    }

    case 'workflows.fileTree': {
      const { workflowId, path: relPath } = validateParams(workflowFileTreeSchema, params);
      const workspacePath = getWorkspacePath(controller, manager, workflowId as WorkflowId);
      const targetDir = resolveAndContain(workspacePath, relPath ?? '');
      return listDirectory(workspacePath, targetDir);
    }

    case 'workflows.fileContent': {
      const { workflowId, path: relPath } = validateParams(workflowFileContentSchema, params);
      const workspacePath = getWorkspacePath(controller, manager, workflowId as WorkflowId);
      const targetFile = resolveAndContain(workspacePath, relPath);
      return readWorkspaceFile(workspacePath, targetFile);
    }

    case 'workflows.artifacts': {
      const { workflowId, artifactName } = validateParams(workflowArtifactSchema, params);
      const workspacePath = getWorkspacePath(controller, manager, workflowId as WorkflowId);
      return listArtifactFiles(workspacePath, artifactName);
    }

    case 'workflows.artifactFile': {
      const { workflowId, artifactName, path: filePath } = validateParams(workflowArtifactFileSchema, params);
      const workspacePath = getWorkspacePath(controller, manager, workflowId as WorkflowId);
      return readArtifactFile(workspacePath, artifactName, filePath);
    }

    case 'workflows.messageLog': {
      const { workflowId, before, limit } = validateParams(workflowMessageLogSchema, params);
      return readMessageLogPage(manager, workflowId as WorkflowId, {
        before,
        limit: limit ?? DEFAULT_MESSAGE_LOG_LIMIT,
      });
    }

    case 'workflows.messageLogEntry': {
      const { workflowId, ref } = validateParams(workflowMessageLogEntrySchema, params);
      return readMessageLogEntry(manager, workflowId as WorkflowId, ref);
    }

    default:
      throw new MethodNotFoundError(method);
  }
}

// ---------------------------------------------------------------------------
// DTO builders
// ---------------------------------------------------------------------------

function getCurrentState(status: WorkflowStatus): string {
  switch (status.phase) {
    case 'running':
      return status.currentState;
    case 'waiting_human':
      return status.gate.stateName;
    case 'completed':
      return 'completed';
    case 'failed':
      return status.lastState;
    case 'aborted':
      return 'aborted';
  }
}

function buildSummaryDto(id: WorkflowId, status: WorkflowStatus, detail?: WorkflowDetail): WorkflowSummaryDto {
  // `name` and `startedAt` are not available from the orchestrator's runtime
  // state alone. We use the workflow id as a name fallback and the current
  // wall-clock time as a stand-in start time -- the frontend's event handler
  // overwrites both with authoritative values from `workflow.started` events.
  return {
    workflowId: id,
    name: detail?.definition.name ?? id,
    phase: status.phase,
    currentState: getCurrentState(status),
    startedAt: new Date().toISOString(),
    taskDescription: detail?.context.taskDescription ?? '',
    round: detail?.context.round ?? 0,
    maxRounds: detail?.context.maxRounds ?? 0,
    totalTokens: detail?.context.totalTokens ?? 0,
    latestVerdict: extractLatestVerdictFromTransitions(),
    error: status.phase === 'failed' ? status.error : undefined,
  };
}

function buildDetailDto(
  id: WorkflowId,
  status: WorkflowStatus,
  detail?: WorkflowDetail,
  escalations: readonly WorkflowEscalationDto[] = [],
): WorkflowDetailDto {
  const base = buildSummaryDto(id, status, detail);
  const stateGraph = detail ? extractStateGraph(detail.definition) : { states: [], transitions: [] };
  const transitionHistory = mapTransitionRecords(detail?.transitionHistory);

  return {
    ...base,
    description: detail?.context.taskDescription ?? '',
    stateGraph,
    transitionHistory,
    context: detail
      ? {
          taskDescription: detail.context.taskDescription,
          round: detail.context.round,
          maxRounds: detail.context.maxRounds,
          totalTokens: detail.context.totalTokens,
          visitCounts: detail.context.visitCounts,
        }
      : { taskDescription: '', round: 0, maxRounds: 0, totalTokens: 0, visitCounts: {} },
    gate: status.phase === 'waiting_human' ? toHumanGateRequestDto(status.gate) : undefined,
    ...(escalations.length > 0 ? { escalations: escalations.map((item) => escalationForWire(item)) } : {}),
    workspacePath: detail?.workspacePath ?? '',
    hasReadme: workflowHasReadme(base.name),
    budget: detail?.budget,
    ...(detail?.usage !== undefined ? { usage: detail.usage } : {}),
  };
}

/**
 * Run-wide total tokens of a saved run: the checkpoint's usage record, or for
 * checkpoints written before it existed, the context's (output-only) total.
 */
function checkpointTotalTokens(checkpoint: WorkflowCheckpoint): number {
  return parseWorkflowUsage(checkpoint.usage)?.totalTokens ?? checkpoint.context.totalTokens;
}

// ---------------------------------------------------------------------------
// Past-run helpers (shared by B3 `workflows.get` and B4 `workflows.listResumable`)
// ---------------------------------------------------------------------------

/**
 * Synthesizes a phase value for a checkpoint loaded from disk.
 *
 * Requires a defined `WorkflowCheckpoint`. For checkpoint-less past-run rows
 * (i.e. directories where `checkpoint.json` is absent — e.g. runs completed
 * before B3b persisted `finalStatus`), callers must use
 * `synthesizePhaseFromMessageLog` instead.
 *
 * Resolution order:
 * - If `isLive` is true, returns `'running'`.
 * - If `runningElsewhere` is true (the run lock is held by another live
 *   process), returns `'running_elsewhere'`: whatever the checkpoint says,
 *   the run is executing there, not interrupted or resumable here.
 * - Post-B3b checkpoints carry a canonical `finalStatus.phase`. When present
 *   and valid (matches a `PastRunPhase` value), return it directly —
 *   this short-circuits the legacy state-name heuristic.
 * - Legacy pre-B3b checkpoints fall through to the state-name heuristic:
 *   - Terminal state in the definition: infer `'aborted'` from the
 *     conventional name pattern (`'aborted'` or contains `'abort'`);
 *     otherwise `'completed'`. Matches `handleWorkflowComplete` in the
 *     orchestrator.
 *   - Human-gate state: `'waiting_human'`.
 *   - Otherwise: `'interrupted'` (mid-run state with no live instance —
 *     typical of a daemon crash).
 */
export function computePastRunPhase(
  checkpoint: WorkflowCheckpoint,
  definition: WorkflowDefinition,
  isLive: boolean,
  runningElsewhere = false,
): LiveWorkflowPhase | PastRunPhase {
  if (isLive) return 'running';
  if (runningElsewhere) return 'running_elsewhere';
  const finalPhase = checkpoint.finalStatus?.phase;
  if (isPastRunPhase(finalPhase)) return finalPhase;
  // Legacy pre-B3b path: derive from the state name.
  const stateName = extractLastState(checkpoint.machineState);
  const stateDef = getStateDef(definition, stateName);
  if (stateDef?.type === 'terminal') return terminalPhaseFromStateName(stateName);
  if (stateDef?.type === 'human_gate') return 'waiting_human';
  return 'interrupted';
}

/**
 * Synthesize a `PastRunPhase` for a checkpoint-less directory from its message log.
 * `entries` must be chronological (oldest-first), matching `MessageLog.readAll()`.
 *
 * Per D6: the destination state of the last `state_transition` lives in the
 * `event` field (orchestrator.handleTransition writes it there). For non-terminal,
 * non-gate destinations, post-transition `quota_exhausted` → 'aborted',
 * `transient_failure` → 'aborted', `error` → 'failed' (except a failed
 * checkpoint save, which the run outlives), none → 'interrupted'.
 */
export function synthesizePhaseFromMessageLog(
  entries: readonly MessageLogEntry[],
  definition: WorkflowDefinition,
): PastRunPhase {
  // Single pass: track lastTransition AND post-transition signals together.
  // When a newer transition arrives, the post-transition accumulators reset.
  let lastTransition: StateTransitionEntry | undefined;
  let sawQuotaExhausted = false;
  let sawTransientFailure = false;
  let sawError = false;
  for (const entry of entries) {
    if (entry.type === 'state_transition') {
      if (lastTransition === undefined || entry.ts > lastTransition.ts) {
        lastTransition = entry;
        sawQuotaExhausted = false;
        sawTransientFailure = false;
        sawError = false;
      }
      continue;
    }
    if (lastTransition === undefined || entry.ts <= lastTransition.ts) continue;
    if (entry.type === 'quota_exhausted') sawQuotaExhausted = true;
    else if (entry.type === 'transient_failure') sawTransientFailure = true;
    // A failed checkpoint save is reported in the log but does not stop the
    // run: a checkpoint-less run (every save failed) is not thereby 'failed'.
    // Nor is a host-mount privilege finding, a warning for the user.
    else if (
      entry.type === 'error' &&
      entry.context !== CHECKPOINT_SAVE_ERROR_CONTEXT &&
      entry.context !== HOST_MOUNT_SCAN_ERROR_CONTEXT
    ) {
      sawError = true;
    }
  }
  if (lastTransition === undefined) return 'interrupted';
  const stateDef = getStateDef(definition, lastTransition.event);
  if (stateDef?.type === 'terminal') return terminalPhaseFromStateName(lastTransition.event);
  if (stateDef?.type === 'human_gate') return 'waiting_human';
  if (sawQuotaExhausted) return 'aborted';
  if (sawTransientFailure) return 'aborted';
  if (sawError) return 'failed';
  return 'interrupted';
}

/**
 * `TransitionRecord` doesn't carry a structured verdict; the frontend populates
 * `latestVerdict` from live `workflow.agent_completed` events. Past-run callers
 * receive `undefined` until checkpoints capture verdict/confidence first-class.
 */
export function extractLatestVerdictFromTransitions(): LatestVerdictDto | undefined {
  return undefined;
}

/**
 * Extracts the failure error message for a past-run checkpoint, when present.
 *
 * Past-run checkpoints don't persist `finalStatus`, but they do persist the
 * workflow context, which carries `lastError` for failed/aborted runs. This
 * is the closest thing to an authoritative error message from disk.
 */
function extractPastRunError(
  checkpoint: WorkflowCheckpoint,
  phase: LiveWorkflowPhase | PastRunPhase,
): string | undefined {
  // A run live in another process has no outcome yet; its last error may be
  // one it has since recovered from.
  if (phase === 'completed' || phase === 'running_elsewhere') return undefined;
  return checkpoint.context.lastError ?? undefined;
}

/** Maps domain `TransitionRecord[]` to DTO shape (renames `duration_ms` → `durationMs`). */
function mapTransitionRecords(
  history:
    | readonly {
        from: string;
        to: string;
        event: string;
        timestamp: string;
        duration_ms: number;
        agentMessage?: string;
      }[]
    | undefined,
) {
  return (history ?? []).map((t) => ({
    from: t.from,
    to: t.to,
    event: t.event,
    timestamp: t.timestamp,
    durationMs: t.duration_ms,
    agentMessage: t.agentMessage,
  }));
}

/** Destination state of the latest `state_transition`, or `definition.initial`. */
function deriveLastStateFromEntries(entries: readonly MessageLogEntry[], definition: WorkflowDefinition): string {
  return findLastStateTransition(entries)?.event ?? definition.initial;
}

/** Assembles a `WorkflowDetailDto` from on-disk past-run objects (checkpoint or message-log fallback). */
export function buildDetailFromPastRun(
  id: WorkflowId,
  load: PastRunLoadSuccess,
  summary: WorkflowRunSummary,
): WorkflowDetailDto {
  const { checkpoint, definition, isLive, runningElsewhere } = load;
  const stateGraph = extractStateGraph(definition);

  if (checkpoint) {
    const phase = computePastRunPhase(checkpoint, definition, isLive, runningElsewhere);
    const currentState = extractLastState(checkpoint.machineState);
    const usage = parseWorkflowUsage(checkpoint.usage);
    const totalTokens = checkpointTotalTokens(checkpoint);
    return {
      workflowId: id,
      name: definition.name,
      phase,
      currentState,
      // Checkpoint timestamp is a best-effort stand-in for startedAt.
      startedAt: checkpoint.timestamp,
      taskDescription: checkpoint.context.taskDescription,
      round: checkpoint.context.round,
      maxRounds: checkpoint.context.maxRounds,
      totalTokens,
      latestVerdict: extractLatestVerdictFromTransitions(),
      error: extractPastRunError(checkpoint, phase),
      description: checkpoint.context.taskDescription,
      stateGraph,
      transitionHistory: mapTransitionRecords(checkpoint.transitionHistory),
      context: {
        taskDescription: checkpoint.context.taskDescription,
        round: checkpoint.context.round,
        maxRounds: checkpoint.context.maxRounds,
        totalTokens,
        visitCounts: { ...checkpoint.context.visitCounts },
      },
      gate: undefined,
      workspacePath: checkpoint.workspacePath ?? '',
      hasReadme: workflowHasReadme(definition.name),
      budget: pastRunWorkflowBudget(checkpoint, definition.settings),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  const entries = new MessageLog(load.messageLogPath).readAll();
  const widePhase: LiveWorkflowPhase | PastRunPhase = isLive
    ? 'running'
    : runningElsewhere
      ? 'running_elsewhere'
      : synthesizePhaseFromMessageLog(entries, definition);
  const currentState = deriveLastStateFromEntries(entries, definition);
  const taskDescription = definition.description;
  const startedAt = summary.mtime.toISOString();
  const recoveredWorkspace = discoverWorkspacePathFromContainers(summary.directoryPath) ?? '';

  return {
    workflowId: id,
    name: definition.name,
    phase: widePhase,
    currentState,
    startedAt,
    taskDescription,
    round: 0,
    maxRounds: 0,
    totalTokens: 0,
    latestVerdict: undefined,
    error: undefined,
    description: taskDescription,
    stateGraph,
    // state_transition entries from the message log are surfaced via
    // workflows.messageLog instead, to avoid double-rendering.
    transitionHistory: [],
    context: { taskDescription, round: 0, maxRounds: 0, totalTokens: 0, visitCounts: {} },
    gate: undefined,
    workspacePath: recoveredWorkspace,
    hasReadme: workflowHasReadme(definition.name),
    budget: pastRunWorkflowBudget(undefined, definition.settings),
  };
}

// ---------------------------------------------------------------------------
// File browser helpers
// ---------------------------------------------------------------------------

// The workspace is bind-mounted read-write into the agent container, so every
// name below it is agent-controlled and may be swapped for a symlink, FIFO,
// socket or device between a check and a use. Three rules keep these methods
// from stalling or exhausting the daemon that hosts every session (WEB-3,
// WEB-4):
//
//  1. File bytes are read only through `readUntrustedRegularFileBelow`:
//     directory components are realpath-contained in the workspace, the final
//     component is opened `O_NOFOLLOW | O_NONBLOCK`, the opened object must
//     fstat as a regular file, and at most MAX_FILE_SIZE + 1 bytes are read.
//  2. Listings open each directory through `openDirectoryBelow` (the directory
//     actually opened must lie below the real root, and on Linux entries are
//     read and sized through its descriptor, so a racing symlink swap cannot
//     redirect a listing), are asynchronous, and are bounded in entries, depth
//     and bytes; they report `truncated: true` instead of growing without
//     limit.
//  3. Artifact listings carry names and sizes only; contents are fetched one
//     file at a time, so no single reply can exceed the response cap.

/** Directories excluded from listings by default. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);

/** Maximum file size (bytes) for content display. */
const MAX_FILE_SIZE = 1_048_576; // 1MB

/** Number of bytes to check for binary content. */
const BINARY_CHECK_BYTES = 8192;

/** A directory listing stops after this many entries and reports `truncated`. */
export const MAX_DIRECTORY_ENTRIES = 2_000;

/**
 * Directory entries a `workflows.fileTree` listing reads before it stops and
 * reports `truncated`, counting the ones it skips (symlinks, FIFOs, sockets,
 * devices, `.git`, `node_modules`), so a directory of a million symlinks
 * costs a bounded amount of work too.
 */
export const MAX_DIRECTORY_SCAN_ENTRIES = 10_000;

/** An artifact listing stops after this many files (and subdirectories) and reports `truncated`. */
export const MAX_ARTIFACT_FILES = 2_000;

/** Directory entries an artifact listing reads in total (skipped ones included) before it stops. */
export const MAX_ARTIFACT_SCAN_ENTRIES = 10_000;

/** Directory levels below the artifact root that an artifact listing descends into. */
export const MAX_ARTIFACT_DEPTH = 8;

/**
 * Budget for the serialized (JSON) bytes of the entries in one artifact
 * listing. Counted per entry as it is added, so names full of characters that
 * JSON escapes (a control character becomes six bytes) cannot inflate a
 * listing past it.
 */
export const MAX_ARTIFACT_LISTING_BYTES = 1_048_576;

/** `lstat` calls issued concurrently while sizing a listing. */
const STAT_BATCH_SIZE = 64;

/**
 * Budget for the serialized (JSON) bytes of the entries on one
 * `workflows.messageLog` page, measured after long strings are cut.
 */
export const MAX_MESSAGE_LOG_PAGE_BYTES = 1_048_576;

/**
 * Raw log-line bytes one `workflows.messageLog` page reads and parses for the
 * entries it returns. Bounds the work per page when messages are long, since
 * the byte budget above counts entries after they are cut.
 */
export const MAX_MESSAGE_LOG_SCAN_BYTES = 16 * 1_048_576;

/** String fields longer than this are cut in page entries (full text via `workflows.messageLogEntry`). */
export const MAX_INLINE_MESSAGE_CHARS = 8_192;

/** Largest single message-log line served by `workflows.messageLogEntry`. */
export const MAX_MESSAGE_LOG_ENTRY_BYTES = 4 * 1_048_576;

/** Extension-to-language mapping for syntax highlighting in the file viewer. */
const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.css': 'css',
  '.html': 'html',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.sh': 'shell',
  '.bash': 'shell',
  '.toml': 'toml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.sql': 'sql',
  '.dockerfile': 'dockerfile',
  '.txt': 'text',
};

/** Map file extensions to language identifiers for syntax highlighting. */
export function inferLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return LANG_MAP[ext] ?? 'text';
}

/**
 * Resolves a workflow's workspace path: live detail → past-run checkpoint →
 * recovered from container session-metadata. Throws `WORKFLOW_NOT_FOUND`
 * when all three sources are empty. The returned path is not guaranteed to
 * exist on disk (ephemeral workspaces may be torn down post-completion);
 * `listDirectory` handles ENOENT gracefully.
 */
function getWorkspacePath(
  controller: ReturnType<WorkflowManager['getOrchestrator']>,
  manager: WorkflowManager,
  id: WorkflowId,
): string {
  const liveDetail = controller.getDetail(id);
  if (liveDetail) return liveDetail.workspacePath;

  const result = manager.loadPastRun(id);
  if ('error' in result) {
    throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${id} not found`);
  }
  const pastWorkspace = result.checkpoint?.workspacePath;
  if (pastWorkspace) return pastWorkspace;

  const recovered = discoverWorkspacePathFromContainers(resolve(manager.getBaseDir(), id));
  if (recovered) return recovered;

  throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${id} has no recorded workspace`);
}

/**
 * Resolves a relative path within a workspace and validates containment.
 * Prevents path traversal attacks.
 */
export function resolveAndContain(workspacePath: string, relPath: string): string {
  const normalized = normalize(relPath);
  if (normalized.startsWith('..') || normalized.startsWith('/')) {
    throw new RpcError('INVALID_PARAMS', 'Path must be relative and within the workspace');
  }
  const target = resolve(workspacePath, normalized);

  if (!isWithinDirectory(target, workspacePath)) {
    throw new RpcError('INVALID_PARAMS', 'Path escapes workspace boundary');
  }
  return target;
}

function errnoCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

/** `code` of an `UntrustedFileError` from hardened-fs (matched by discriminant, not `instanceof`). */
function untrustedFileErrorCode(err: unknown): string | undefined {
  return err instanceof Error && err.name === 'UntrustedFileError' ? errnoCode(err) : undefined;
}

/** True when the entry at `path` is a directory (not followed through a symlink); false when missing. */
function isDirectoryNoFollow(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `isWithinDirectory`, false instead of throwing when a path cannot be resolved at all. */
function isContainedIn(target: string, directory: string): boolean {
  try {
    return isWithinDirectory(target, directory);
  } catch {
    return false;
  }
}

/** Asynchronous `realpath` (it never opens the entry); undefined when the path does not resolve. */
async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** A regular file found during a listing, sized in a later batched `lstat` pass. */
interface PendingFile {
  readonly name: string;
  readonly relPath: string;
}

/**
 * `lstat`s `files` (entries of `dir`) in batches and reports each one still
 * present as a regular file (an entry replaced by a FIFO, symlink or directory
 * since the `readdir` is dropped). The `lstat` goes through the opened
 * directory, never follows and never blocks, so an agent swapping entries
 * under a listing can neither stall it nor make it size another directory's
 * files. `onUnknownSize` decides what to do with an entry whose `lstat`
 * failed (e.g. removed meanwhile). `onFile` returns false to stop early (a
 * budget ran out); the result says whether every file was processed.
 */
async function sizeRegularFiles(
  dir: DirectoryBelow,
  files: readonly PendingFile[],
  onFile: (file: PendingFile, size: number) => boolean,
  onUnknownSize: (file: PendingFile) => void,
): Promise<boolean> {
  for (let i = 0; i < files.length; i += STAT_BATCH_SIZE) {
    const batch = files.slice(i, i + STAT_BATCH_SIZE);
    const stats = await Promise.all(batch.map((file) => dir.lstatEntry(file.name)));
    for (let index = 0; index < batch.length; index++) {
      const s = stats[index];
      if (s === undefined) onUnknownSize(batch[index]);
      else if (s.isFile() && !onFile(batch[index], s.size)) return false;
    }
  }
  return true;
}

/**
 * Lists one workspace directory for `workflows.fileTree`.
 *
 * `dirPath` was contained by `resolveAndContain`, but the agent can swap a
 * directory on it for a symlink at any moment, so the listing goes through
 * `openDirectoryBelow`: it opens `O_DIRECTORY | O_NONBLOCK` (a FIFO, socket,
 * device or file at `dirPath` is refused with "Path is not a directory"
 * instead of blocking), requires the directory actually opened to lie in the
 * real workspace, and on Linux reads and sizes the entries through that open
 * descriptor, so a swap cannot make the tree show another directory's names.
 *
 * Entries are read through an asynchronous iterator so a directory with
 * millions of entries does not block the daemon's event loop; the listing
 * stops after {@link MAX_DIRECTORY_ENTRIES} qualifying entries or
 * {@link MAX_DIRECTORY_SCAN_ENTRIES} entries read (`truncated: true`), and
 * only reports directories and regular files: symlinks, FIFOs, sockets and
 * devices are never listed, so the viewer cannot be pointed at them. Entries
 * beyond the cap are the ones later in directory order; the returned entries
 * are sorted directories-first, then alphabetically.
 */
async function listDirectory(workspacePath: string, dirPath: string): Promise<FileTreeResponseDto> {
  const realWorkspace = await realpathOrUndefined(workspacePath);
  if (realWorkspace === undefined) {
    return { entries: [], truncated: false };
  }
  let dir: DirectoryBelow;
  try {
    dir = await openDirectoryBelow(realWorkspace, dirPath, { allowRoot: true });
  } catch (err: unknown) {
    switch (untrustedFileErrorCode(err)) {
      case 'NOT_FOUND':
        return { entries: [], truncated: false };
      case 'NOT_DIRECTORY':
        throw new RpcError('INVALID_PARAMS', 'Path is not a directory');
      case 'OUTSIDE_ROOT':
      case 'CHANGED':
        throw new RpcError('INVALID_PARAMS', 'Path escapes workspace boundary');
      default:
        throw err;
    }
  }

  const entries: FileTreeEntryDto[] = [];
  let truncated = false;
  try {
    const pendingFiles: PendingFile[] = [];
    let scanned = 0;
    for await (const entry of dir.entries) {
      if (++scanned > MAX_DIRECTORY_SCAN_ENTRIES) {
        truncated = true;
        break;
      }
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const isDirectory = entry.isDirectory();
      if (!isDirectory && !entry.isFile()) continue;
      if (entries.length + pendingFiles.length >= MAX_DIRECTORY_ENTRIES) {
        truncated = true;
        break;
      }
      if (isDirectory) {
        entries.push({ name: entry.name, type: 'directory' });
      } else {
        pendingFiles.push({ name: entry.name, relPath: entry.name });
      }
    }

    await sizeRegularFiles(
      dir,
      pendingFiles,
      (file, size) => {
        entries.push({ name: file.name, type: 'file', size });
        return true;
      },
      (file) => entries.push({ name: file.name, type: 'file' }),
    );
  } finally {
    await dir.close();
  }

  // Sort: directories first, then files, both alphabetical
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { entries, truncated };
}

/**
 * Reads a file below `root` for display, the single sink for every workspace
 * byte the web UI serves. `relativePath` is `/`-separated plain components.
 *
 * `readUntrustedRegularFileBelow` realpath-contains the directory components,
 * opens the final component `O_NOFOLLOW | O_NONBLOCK`, requires the opened
 * descriptor to be a regular file and reads at most MAX_FILE_SIZE + 1 bytes,
 * so a FIFO, device, socket or symlink the agent swaps in yields an immediate
 * `{ error }` instead of blocking the daemon, and a file that grows past the
 * cap is reported as too large regardless of a stale `stat`.
 */
function readDisplayFile(root: string, relativePath: string, scope: 'workspace' | 'artifact'): FileContentResponseDto {
  let bytes: Buffer;
  try {
    ({ bytes } = readUntrustedRegularFileBelow(root, relativePath, { maxBytes: MAX_FILE_SIZE }));
  } catch (err: unknown) {
    switch (untrustedFileErrorCode(err)) {
      case 'NOT_FOUND':
        throw new RpcError('INVALID_PARAMS', 'File not found');
      case 'NOT_REGULAR_FILE':
        if (isDirectoryNoFollow(resolve(root, ...relativePath.split('/')))) {
          throw new RpcError('INVALID_PARAMS', 'Path is a directory, not a file');
        }
        return { error: 'Not a regular file' };
      case 'SYMLINK':
        return { error: 'Not a regular file' };
      case 'TOO_LARGE':
        return { error: 'File too large to display (>1MB)' };
      case 'INVALID_PATH':
        throw new RpcError('INVALID_PARAMS', 'Path must be relative and within the workspace');
      case 'OUTSIDE_ROOT':
      case 'CHANGED':
        throw new RpcError(
          'INVALID_PARAMS',
          scope === 'workspace' ? 'Path escapes workspace boundary' : 'Artifact path escapes workflow directory',
        );
      default:
        throw err;
    }
  }

  // Null bytes reliably indicate binary content; checking only the header avoids scanning large files
  const checkLen = Math.min(bytes.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < checkLen; i++) {
    if (bytes[i] === 0) {
      return { binary: true };
    }
  }

  return {
    content: bytes.toString('utf-8'),
    language: inferLanguage(relativePath),
  };
}

/**
 * `workflows.fileContent`: `targetFile` is the contained absolute path from
 * {@link resolveAndContain}; the read re-derives the workspace-relative path
 * so the hardened reader can re-check every component against the root.
 */
function readWorkspaceFile(workspacePath: string, targetFile: string): FileContentResponseDto {
  const rel = relative(workspacePath, targetFile);
  if (rel === '') {
    throw new RpcError('INVALID_PARAMS', 'Path is a directory, not a file');
  }
  return readDisplayFile(workspacePath, rel.split(sep).join('/'), 'workspace');
}

/**
 * Validates an artifact name and resolves its directory (`.workflow/<name>`
 * inside the workspace). `.workflow` and the artifact directory are
 * agent-writable names, so the directory must resolve (realpath) inside both
 * `.workflow` and the workspace: a `.workflow` symlinked out of the workspace
 * is refused rather than listed.
 */
function resolveArtifactDir(workspacePath: string, artifactName: string): string {
  // Validate artifact name: no path separators or traversal
  if (
    artifactName.includes('/') ||
    artifactName.includes('\\') ||
    artifactName.includes('\0') ||
    artifactName === '..' ||
    artifactName === '.'
  ) {
    throw new RpcError('INVALID_PARAMS', 'Invalid artifact name');
  }

  // Artifacts live in .workflow/{artifactName}/ inside the workspace
  const artifactDir = resolve(workspacePath, '.workflow', artifactName);

  const workflowDir = resolve(workspacePath, '.workflow');
  if (!isContainedIn(artifactDir, workflowDir) || !isContainedIn(artifactDir, workspacePath)) {
    throw new RpcError('INVALID_PARAMS', 'Artifact path escapes workflow directory');
  }
  return artifactDir;
}

/** Splits an artifact-relative file path into plain components (`INVALID_PARAMS` otherwise). */
function artifactFileComponents(filePath: string): string[] {
  const components = filePath.split('/');
  const invalid = components.some(
    (part) => part === '' || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'),
  );
  if (invalid) {
    throw new RpcError('INVALID_PARAMS', 'Invalid artifact file path');
  }
  return components;
}

/**
 * `workflows.artifacts`: lists the regular files of `.workflow/<artifactName>`
 * (paths and sizes, never contents) for the gate review panel and `workflow
 * show`, which fetch each file separately through `workflows.artifactFile`.
 *
 * The walk is asynchronous and bounded: it stops after
 * {@link MAX_ARTIFACT_FILES} accepted entries,
 * {@link MAX_ARTIFACT_SCAN_ENTRIES} entries read or
 * {@link MAX_ARTIFACT_LISTING_BYTES} of serialized listing, and does not
 * descend below {@link MAX_ARTIFACT_DEPTH} levels, reporting
 * `truncated: true` in each case, so a directory of a million files costs a
 * bounded amount of memory and event-loop time. Symlinks, FIFOs, sockets and
 * devices are skipped (a `Dirent` reports neither file nor directory for
 * them).
 *
 * `.workflow`, the artifact directory and every subdirectory are
 * agent-writable names that can be swapped for a symlink at any moment, so
 * each directory is opened with `openDirectoryBelow`: the artifact directory
 * actually opened must lie strictly below the workspace's real `.workflow`
 * (checked on the open descriptor on Linux, not on a path a racing agent can
 * retarget between a check and the open), every subdirectory must lie
 * strictly below that, and entries are listed and sized through the opened
 * descriptors. A subdirectory that is gone, no longer a directory or now leads
 * elsewhere is not walked.
 */
async function listArtifactFiles(workspacePath: string, artifactName: string): Promise<ArtifactContentDto> {
  const artifactDir = resolveArtifactDir(workspacePath, artifactName);
  const realWorkspace = await realpathOrUndefined(workspacePath);
  if (realWorkspace === undefined) {
    throw new RpcError('ARTIFACT_NOT_FOUND', `Artifact "${artifactName}" not found`);
  }
  const realWorkflowDir = resolve(realWorkspace, '.workflow');
  // Set from the artifact directory once it is open; subdirectories must stay below it.
  let realArtifactDir: string | undefined;

  const files: ArtifactFileDto[] = [];
  let truncated = false;
  let listingBytes = 2; // the enclosing `[]`
  // Entries accepted so far (files and directories), bounding memory for the
  // pending stack as well as the result, and entries read (skipped included).
  let accepted = 0;
  let scanned = 0;
  const stack: { path: string; prefix: string; depth: number }[] = [{ path: artifactDir, prefix: '', depth: 0 }];

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    let dir: DirectoryBelow;
    try {
      dir = await openDirectoryBelow(realArtifactDir ?? realWorkflowDir, frame.path);
    } catch (err: unknown) {
      if (frame.depth > 0) continue; // Gone, not a directory, unreadable or now elsewhere: not walked.
      switch (untrustedFileErrorCode(err)) {
        case 'NOT_FOUND':
        case 'NOT_DIRECTORY':
          throw new RpcError('ARTIFACT_NOT_FOUND', `Artifact "${artifactName}" not found`);
        case 'OUTSIDE_ROOT':
        case 'CHANGED':
          throw new RpcError('INVALID_PARAMS', 'Artifact path escapes workflow directory');
        default:
          throw err;
      }
    }
    realArtifactDir ??= dir.path;

    let withinBudget: boolean;
    try {
      const pendingFiles: PendingFile[] = [];
      for await (const entry of dir.entries) {
        if (++scanned > MAX_ARTIFACT_SCAN_ENTRIES) {
          truncated = true;
          break;
        }
        const isDirectory = entry.isDirectory();
        if (!isDirectory && !entry.isFile()) continue;
        if (accepted >= MAX_ARTIFACT_FILES) {
          truncated = true;
          break;
        }
        const relPath = frame.prefix ? `${frame.prefix}/${entry.name}` : entry.name;
        if (isDirectory) {
          if (frame.depth + 1 > MAX_ARTIFACT_DEPTH) {
            truncated = true;
            continue;
          }
          accepted++;
          // Below the canonical path of the directory just opened, not the
          // (agent-retargetable) path it was reached by.
          stack.push({ path: resolve(dir.path, entry.name), prefix: relPath, depth: frame.depth + 1 });
        } else {
          accepted++;
          pendingFiles.push({ name: entry.name, relPath });
        }
      }

      withinBudget = await sizeRegularFiles(
        dir,
        pendingFiles,
        (file, size) => {
          const dto: ArtifactFileDto = { path: file.relPath, size };
          // Exact serialized size plus the separating comma.
          const cost = Buffer.byteLength(JSON.stringify(dto), 'utf8') + 1;
          if (listingBytes + cost > MAX_ARTIFACT_LISTING_BYTES) return false;
          listingBytes += cost;
          files.push(dto);
          return true;
        },
        () => {
          // Removed between readdir and lstat: nothing to list.
        },
      );
    } finally {
      await dir.close();
    }
    if (!withinBudget) {
      truncated = true;
      break;
    }
    if (truncated && (accepted >= MAX_ARTIFACT_FILES || scanned > MAX_ARTIFACT_SCAN_ENTRIES)) break;
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated };
}

/**
 * `workflows.artifactFile`: reads one file of an artifact through
 * {@link readDisplayFile}, rooted at the workspace so `.workflow`, the
 * artifact directory and every component of `filePath` are re-checked for
 * containment and the final component is opened without following links.
 */
function readArtifactFile(workspacePath: string, artifactName: string, filePath: string): FileContentResponseDto {
  const artifactDir = resolveArtifactDir(workspacePath, artifactName);
  const components = artifactFileComponents(filePath);
  if (!existsSync(artifactDir)) {
    throw new RpcError('ARTIFACT_NOT_FOUND', `Artifact "${artifactName}" not found`);
  }
  return readDisplayFile(workspacePath, ['.workflow', artifactName, ...components].join('/'), 'artifact');
}

// ---------------------------------------------------------------------------
// Resumable workflow helpers
// ---------------------------------------------------------------------------

/**
 * One run's memoized listing outcome (see {@link pastRunRowMemos}): its row,
 * or `undefined` when the run has none (not loadable).
 */
interface PastRunRowMemoEntry {
  /** {@link WorkflowRunSummary.filesKey} of the run when the outcome was built. */
  readonly filesKey: string;
  /** Whether the run's lock was held then: it can change with no file changing (its holder exits). */
  readonly lockHeld: boolean;
  readonly dto: PastRunDto | undefined;
}

/**
 * Past-run listing outcomes per workflow manager, each reused while its run's
 * files keep their identity and its lock its state. Building a row parses the
 * run's whole checkpoint (transition history included) and validates its
 * definition, synchronously on the daemon's event loop, and the dashboard
 * lists past runs on every (re)connect: with the memo, listing unchanged runs
 * costs a directory scan, a few `stat`s and a lock check per run. Each listing
 * drops the entries of runs no longer on disk, and the map is weak in the
 * manager.
 */
const pastRunRowMemos = new WeakMap<WorkflowManager, Map<WorkflowId, PastRunRowMemoEntry>>();

/**
 * Returns every past-run directory as `PastRunDto[]` for `workflows.listResumable`
 * (RPC name kept per D4; payload covers terminal, gate-paused, and interrupted
 * rows). Live workflows are skipped (they belong to `workflows.list`); corrupted
 * rows are warned-and-skipped; not_found rows are silently skipped. A run that
 * cannot be read at all (a directory that cannot be examined, a message log
 * that is not a readable file) is warned-and-skipped too, never failing the
 * whole listing.
 */
function buildResumableList(manager: WorkflowManager): PastRunDto[] {
  const controller = manager.getOrchestrator();
  const baseDir = manager.getBaseDir();
  const runs = discoverWorkflowRuns(baseDir, { warn: (message) => logger.warn(message) });
  const activeIds = new Set<WorkflowId>(controller.listActive());
  // Suppress hidden workflows' past runs (smoke tests / fixtures) from the UI.
  const hidden = hiddenWorkflowNames();
  let memo = pastRunRowMemos.get(manager);
  if (memo === undefined) {
    memo = new Map();
    pastRunRowMemos.set(manager, memo);
  }
  const onDisk = new Set<WorkflowId>();
  const dtos: PastRunDto[] = [];

  for (const run of runs) {
    onDisk.add(run.workflowId);
    if (activeIds.has(run.workflowId)) continue;
    let dto: PastRunDto | undefined;
    try {
      dto = pastRunRow(manager, memo, baseDir, run, activeIds);
    } catch (err) {
      logger.warn(`[workflow-dispatch] skipping past run ${run.workflowId}: ${errorMessage(err)}`);
      continue;
    }
    if (dto === undefined || hidden.has(dto.name)) continue;
    dtos.push(dto);
  }
  for (const workflowId of memo.keys()) {
    if (!onDisk.has(workflowId)) memo.delete(workflowId);
  }

  dtos.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return dtos;
}

/**
 * One run's listing row, reused from `memo` while the run is unchanged. A run
 * with no definition copy of its own is rebuilt every time: its row depends
 * on the definition file its checkpoint names, which `filesKey` does not
 * cover.
 */
function pastRunRow(
  manager: WorkflowManager,
  memo: Map<WorkflowId, PastRunRowMemoEntry>,
  baseDir: string,
  run: WorkflowRunSummary,
  activeIds: ReadonlySet<WorkflowId>,
): PastRunDto | undefined {
  const lockHeld = isWorkflowRunLockHeld(baseDir, run.workflowId);
  const cached = memo.get(run.workflowId);
  if (cached !== undefined && cached.filesKey === run.filesKey && cached.lockHeld === lockHeld) return cached.dto;

  const result = manager.loadPastRun(run.workflowId, activeIds);
  let entry: PastRunRowMemoEntry;
  if ('error' in result) {
    if (result.error !== 'not_found') {
      logger.warn(
        `[workflow-dispatch] skipping ${result.error === 'too_new' ? 'newer-format' : 'corrupted'} checkpoint ` +
          `${run.workflowId}: ${result.message ?? 'unknown'}`,
      );
    }
    entry = { filesKey: run.filesKey, lockHeld, dto: undefined };
  } else {
    entry = {
      filesKey: run.filesKey,
      lockHeld: result.runningElsewhere,
      dto: buildPastRunDto(run.workflowId, result, run),
    };
  }
  if (run.hasDefinition) memo.set(run.workflowId, entry);
  else memo.delete(run.workflowId);
  return entry.dto;
}

/** Assembles a `PastRunDto` from on-disk past-run objects (checkpoint or message-log fallback). */
export function buildPastRunDto(id: WorkflowId, load: PastRunLoadSuccess, summary: WorkflowRunSummary): PastRunDto {
  const { checkpoint, definition, isLive, runningElsewhere } = load;

  if (checkpoint) {
    const widePhase = computePastRunPhase(checkpoint, definition, isLive, runningElsewhere);
    // PastRunDto.phase excludes 'running'; coerce the rare live-race row.
    const phase: PastRunPhase = widePhase === 'running' ? 'interrupted' : widePhase;
    const lastState = extractLastState(checkpoint.machineState);
    return {
      workflowId: id,
      name: definition.name,
      phase,
      currentState: lastState,
      lastState,
      taskDescription: checkpoint.context.taskDescription,
      round: checkpoint.context.round,
      maxRounds: checkpoint.context.maxRounds,
      totalTokens: checkpointTotalTokens(checkpoint),
      latestVerdict: extractLatestVerdictFromTransitions(),
      error: extractPastRunError(checkpoint, phase),
      timestamp: checkpoint.timestamp,
      durationMs: undefined,
      workspacePath: checkpoint.workspacePath,
    };
  }

  const entries = new MessageLog(load.messageLogPath).readAll();
  const phase = runningElsewhere ? 'running_elsewhere' : synthesizePhaseFromMessageLog(entries, definition);
  const lastState = deriveLastStateFromEntries(entries, definition);

  return {
    workflowId: id,
    name: definition.name,
    phase,
    currentState: lastState,
    lastState,
    taskDescription: definition.description,
    round: 0,
    maxRounds: 0,
    totalTokens: 0,
    latestVerdict: undefined,
    error: undefined,
    timestamp: summary.mtime.toISOString(),
    durationMs: undefined,
    workspacePath: undefined,
  };
}

/**
 * Validates that a workflow exists and returns its message-log path.
 *
 * Existence semantics: the workflow must be either currently active in the
 * orchestrator or recoverable from disk via {@link WorkflowManager.loadPastRun}.
 * Workflows write their checkpoint+definition immediately on `start()`, so
 * `loadPastRun` succeeds for live workflows too — this single check covers
 * both the live and past-run cases. Throws `WORKFLOW_NOT_FOUND` when neither
 * source has the id and `WORKFLOW_CORRUPTED` when the checkpoint or definition
 * file is present but unparseable.
 */
function resolveMessageLogPath(manager: WorkflowManager, workflowId: WorkflowId): string {
  const result = manager.loadPastRun(workflowId);
  if ('error' in result) throw pastRunLoadRpcError(result, workflowId);
  return resolve(manager.getBaseDir(), workflowId, 'messages.jsonl');
}

/**
 * Reads a page of {@link MessageLogEntry} records for a workflow with cursor
 * pagination (per design decision D5).
 *
 * Note: the log reader silently skips malformed JSONL lines (the log is
 * append-only and tolerant of truncated writes from crashes), so we cannot
 * surface log-file corruption distinctly here. The corruption error class
 * therefore reflects only checkpoint/definition issues, not log issues.
 *
 * Pagination shape: `entries` holds the newest entries with `ts < before`
 * (when `before` is set), sorted descending by `ts`: at most `limit` of them,
 * at most {@link MAX_MESSAGE_LOG_PAGE_BYTES} of serialized (cut) entries and
 * at most {@link MAX_MESSAGE_LOG_SCAN_BYTES} of raw log lines, whichever
 * comes first (the newest entry is always included). Entries that share the
 * page's oldest timestamp stay on the page even past those limits (up to a
 * small bounded overflow), because the next page's cursor (`before` = that
 * timestamp) would skip them for good. `hasMore` is true iff the page is full
 * AND at least one entry strictly older than the page's last entry exists in
 * the log.
 *
 * Cost: `MessageLog.readPage` scans the file backwards from its end and stops
 * once the page is complete, so the first page costs O(page), not O(log), and
 * no reply can exceed the byte budget whatever the agent wrote. Long string
 * fields are cut to {@link MAX_INLINE_MESSAGE_CHARS} with a `ref` for
 * `workflows.messageLogEntry`.
 */
export async function readMessageLogPage(
  manager: WorkflowManager,
  workflowId: WorkflowId,
  opts: { before?: string; limit: number },
): Promise<MessageLogResponseDto> {
  const logPath = resolveMessageLogPath(manager, workflowId);
  const page = await new MessageLog(logPath).readPage({
    before: opts.before,
    limit: opts.limit,
    maxBytes: MAX_MESSAGE_LOG_PAGE_BYTES,
    maxScanBytes: MAX_MESSAGE_LOG_SCAN_BYTES,
    measure: pageEntryBytes,
  });
  return { entries: page.entries.map(toMessageLogEntryDto), hasMore: page.hasMore };
}

/** Bytes a page entry's `"truncated":true,"ref":"<offset>:<length>"` adds at most. */
const PAGE_ENTRY_REF_BYTES = 64;

/**
 * `value` cut to at most `max` UTF-16 code units, never between the halves of
 * a surrogate pair (which would leave a lone surrogate in the page).
 */
function cutString(value: string, max: number): string {
  const last = value.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return value.slice(0, end);
}

/** The entry with every string field longer than {@link MAX_INLINE_MESSAGE_CHARS} cut, or undefined when none is. */
function cutLongStrings(entry: MessageLogEntry): MessageLogEntry | undefined {
  let cut: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === 'string' && value.length > MAX_INLINE_MESSAGE_CHARS) {
      cut ??= { ...entry };
      cut[key] = cutString(value, MAX_INLINE_MESSAGE_CHARS);
    }
  }
  return cut as MessageLogEntry | undefined;
}

/**
 * What an entry costs against {@link MAX_MESSAGE_LOG_PAGE_BYTES}: the bytes
 * it adds to the reply. An entry that is not cut is sent as it was logged (its
 * line is its serialization); a cut one is measured after cutting.
 */
function pageEntryBytes(entry: MessageLogEntry, lineBytes: number): number {
  const cut = cutLongStrings(entry);
  if (cut === undefined) return lineBytes + 1;
  return Buffer.byteLength(JSON.stringify(cut), 'utf8') + PAGE_ENTRY_REF_BYTES + 1;
}

/**
 * Cuts every string field longer than {@link MAX_INLINE_MESSAGE_CHARS} and
 * marks the entry `truncated` with the `<offset>:<length>` location of its
 * line, so the UI can fetch the complete entry on demand. Untouched entries
 * are returned as-is.
 */
function toMessageLogEntryDto(located: LocatedMessageLogEntry): MessageLogEntryDto {
  const { entry, offset, length } = located;
  const cut = cutLongStrings(entry);
  if (cut === undefined) return entry;
  return { ...cut, truncated: true, ref: `${offset}:${length}` };
}

/**
 * `workflows.messageLogEntry`: returns the complete entry a truncated page
 * entry's `ref` points at. The line is read in place (one bounded `read` at
 * the recorded offset) and must still be a whole entry line; a stale or
 * forged `ref` is `INVALID_PARAMS`, and a line above
 * {@link MAX_MESSAGE_LOG_ENTRY_BYTES} is `FILE_TOO_LARGE`.
 */
export async function readMessageLogEntry(
  manager: WorkflowManager,
  workflowId: WorkflowId,
  ref: string,
): Promise<MessageLogEntryResponseDto> {
  const logPath = resolveMessageLogPath(manager, workflowId);
  const [offsetText, lengthText] = ref.split(':');
  const offset = Number(offsetText);
  const length = Number(lengthText);
  if (length > MAX_MESSAGE_LOG_ENTRY_BYTES) {
    throw new RpcError('FILE_TOO_LARGE', `Message-log entry exceeds ${MAX_MESSAGE_LOG_ENTRY_BYTES} bytes`);
  }
  const entry = await new MessageLog(logPath).readEntryAt(offset, length, MAX_MESSAGE_LOG_ENTRY_BYTES);
  if (entry === undefined) {
    throw new RpcError('INVALID_PARAMS', 'Unknown message-log entry reference');
  }
  return { entry };
}

/**
 * Extracts a human-readable state name from an XState machine state snapshot.
 * The machineState can be a string (simple state) or a nested object (compound state).
 */
export function extractLastState(machineState: unknown): string {
  if (typeof machineState === 'string') return machineState;
  if (machineState && typeof machineState === 'object') {
    // Nested XState value: { parentState: "childState" }
    const keys = Object.keys(machineState);
    if (keys.length > 0) return keys[0];
  }
  return 'unknown';
}

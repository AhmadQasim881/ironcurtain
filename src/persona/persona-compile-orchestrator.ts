import { resolveHostModelApiKey } from '../config/model-provider.js';
/**
 * src/persona/persona-compile-orchestrator.ts
 *
 * The long-running persona-compile orchestrator for the daemon's web UI
 * (Phase 1b, §4.3).
 *
 * Owns:
 *  - the per-persona in-memory `active` Map (live snapshot, fast UX path) and a
 *    bounded `recent` LRU (~50) of TERMINAL records keyed by operationId;
 *  - a daemon-wide concurrency gate `globalLimit = pLimit(2)` + a queue cap;
 *  - credential preflight (derive the env var from the policy + prefilter model
 *    ids and verify it is present);
 *  - daemon-startup stale-lock recovery (synthetic failed events).
 *
 * The compile itself runs through `runPersonaCompile`
 * (persona-compile-service.ts), the one path every persona compile takes,
 * CLI compiles included: it holds the cross-process FS lock, runs the
 * broad-policy validator, arms the wall-clock cap and writes the audit record.
 * This module takes that lock synchronously in `startCompile` (so a duplicate
 * is refused before it queues) and hands it to `runPersonaCompile`.
 *
 * Carries ONLY type-only pipeline imports. Enforced by the Phase-0 ESLint
 * no-restricted-imports rule + test/pipeline-import-boundary.test.ts.
 *
 * @see docs/designs/web-ui-policy-persona-management.md §4.3, §6
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import pLimit from 'p-limit';

import { getPersonasDir } from './resolve.js';
import { createPersonaName, type PersonaName } from './types.js';
import { EventBusProgressReporter } from './event-bus-progress-reporter.js';
import type { EventBusProgressReporterContext } from './event-bus-progress-reporter.js';
import {
  acquirePersonaCompileLock,
  classifyPersonaCompileError,
  DEFAULT_COMPILE_WALL_CLOCK_CAP_MS,
  getPersonaCompileLockPath,
  isPersonaCompileLockStale,
  PersonaCompileError,
  readPersonaCompileLock,
  reclaimStalePersonaCompileLock,
  runPersonaCompile,
  type PersonaCompileImpl,
  type PersonaCompileLock,
} from './persona-compile-service.js';
// NOTE: EventBusProgressReporter carries ONLY type-only pipeline imports, so a
// static VALUE import of it does not violate the import boundary (the boundary
// forbids reaching pipeline-runner.ts / pipeline-shared.ts VALUES).
import { loadUserConfig } from '../config/user-config.js';
import { parseModelId, PROVIDER_ENV_VARS } from '../config/model-provider.js';
import type {
  ErrorCode,
  FailedServerDto,
  PersonaCompileOperationDto,
  PersonaCompileResultDto,
} from '../web-ui/web-ui-types.js';
import type { WebEventBus } from '../web-ui/web-event-bus.js';
// Type-only pipeline imports — no runtime edge.
import type { CompilationPhase } from '../pipeline/pipeline-shared.js';
import type { FailedServer } from '../pipeline/types.js';

/**
 * The typed compile error, under the name the WS dispatch and older callers
 * use. It is the same class as {@link PersonaCompileError}, so `instanceof`
 * matches errors thrown by the compile service (e.g. a lock held by a CLI
 * compile) too.
 */
export { PersonaCompileError as CompileOrchestratorError } from './persona-compile-service.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Daemon-wide compile concurrency. */
const GLOBAL_CONCURRENCY = 2;
/** Queue cap (number of operations waiting behind the global gate). */
const QUEUE_CAP = 10;
/** Bounded LRU size for terminal records. */
const RECENT_CAP = 50;

// ---------------------------------------------------------------------------
// Operation record store
// ---------------------------------------------------------------------------

interface OperationRecord {
  operationId: string;
  name: PersonaName;
  phase: 'started' | 'running' | 'done' | 'failed';
  serverProgress?: { server: string; compilationPhase: CompilationPhase; detail?: string };
  queuePosition?: number;
  startedAt: string;
  endedAt?: string;
  result?: PersonaCompileResultDto;
  error?: { code: ErrorCode; message: string };
  actor: string;
}

/** Test-injectable dependency seam. */
export interface OrchestratorDeps {
  /** Concrete compile implementation; defaults to the dynamic-import seam. */
  readonly compileImpl?: PersonaCompileImpl;
  /** Override the wall-clock cap (ms). */
  readonly wallClockCapMs?: number;
  /** Override the queue cap. */
  readonly queueCap?: number;
}

/**
 * Encapsulates all orchestrator state. A module-level singleton is exported for
 * the daemon, but tests instantiate their own to avoid cross-test bleed.
 */
export class PersonaCompileOrchestrator {
  private readonly active = new Map<PersonaName, OperationRecord>();
  private readonly recent = new Map<string, OperationRecord>();
  private readonly globalLimit = pLimit(GLOBAL_CONCURRENCY);
  /** Operations enqueued behind the global gate but not yet running. */
  private queueDepth = 0;
  private readonly deps: OrchestratorDeps;
  private readonly wallClockCapMs: number;
  private readonly queueCap: number;

  constructor(deps: OrchestratorDeps = {}) {
    this.deps = deps;
    this.wallClockCapMs = deps.wallClockCapMs ?? DEFAULT_COMPILE_WALL_CLOCK_CAP_MS;
    this.queueCap = deps.queueCap ?? QUEUE_CAP;
  }

  // -------------------------------------------------------------------------
  // Read APIs (ungated)
  // -------------------------------------------------------------------------

  /** Returns the live snapshot for an operation (active first, then recent). */
  getCompile(operationId: string): PersonaCompileOperationDto | undefined {
    for (const rec of this.active.values()) {
      if (rec.operationId === operationId) return toDto(rec);
    }
    const terminal = this.recent.get(operationId);
    return terminal ? toDto(terminal) : undefined;
  }

  /** Returns active + recent operations and the current queue depth. */
  listCompiles(): {
    active: PersonaCompileOperationDto[];
    recent: PersonaCompileOperationDto[];
    queueDepth: number;
  } {
    return {
      active: [...this.active.values()].map(toDto),
      recent: [...this.recent.values()].map(toDto),
      queueDepth: this.queueDepth,
    };
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  /**
   * Starts a streamed compile. Synchronously validates / acquires the lock /
   * mints the operationId / emits `persona.compile.started`, then detaches the
   * actual compile inside the global concurrency gate. Returns the ack.
   *
   * @throws {PersonaCompileError} with a typed code on a synchronous
   *   rejection (in-progress — in this daemon or in another process such as a
   *   CLI compile —, queue-full, credentials-missing).
   */
  startCompile(
    name: PersonaName,
    actor: string,
    eventBus: WebEventBus,
  ): { accepted: true; name: PersonaName; operationId: string; queued?: boolean } {
    // 1) Same-persona dedup via the live `active` Map (fast path). The op is
    //    only here while genuinely active; the active->recent transition is a
    //    single synchronous critical section so a just-settled op is not here.
    const live = this.active.get(name);
    if (live) {
      throw new PersonaCompileError('COMPILE_IN_PROGRESS', `A compile for persona "${name}" is already running.`, {
        operationId: live.operationId,
      });
    }

    // 2) The cross-process FS lock (shared with CLI compiles). Stale locks are
    //    reclaimed.
    const operationId = randomUUID();
    const startedAt = new Date().toISOString();
    const lock = acquirePersonaCompileLock(name, operationId, { staleAfterMs: this.wallClockCapMs });

    // 3) Credential preflight (both models). Runs AFTER the dispatch gate, so a
    //    read-only client never reaches here. On miss, release the lock.
    try {
      this.credentialPreflight();
    } catch (err) {
      lock.release();
      throw err;
    }

    // 4) Queue cap: if the global gate is saturated and the queue would exceed
    //    the cap, reject. Otherwise enqueue.
    const willQueue = this.globalLimit.activeCount >= GLOBAL_CONCURRENCY;
    if (willQueue && this.queueDepth >= this.queueCap) {
      lock.release();
      throw new PersonaCompileError('COMPILE_QUEUE_FULL', 'Too many persona compiles are queued.');
    }

    // 5) Insert active record, emit started.
    const record: OperationRecord = {
      operationId,
      name,
      phase: 'started',
      startedAt,
      actor,
    };
    this.active.set(name, record);
    eventBus.emit('persona.compile.started', { name, operationId, actor });

    // 6) Detach the compile inside the global gate. Track queue depth around the
    //    gate so listCompiles reports waiting operations.
    if (willQueue) {
      this.queueDepth += 1;
      record.queuePosition = this.queueDepth;
    }
    void this.globalLimit(async () => {
      if (willQueue) this.queueDepth = Math.max(0, this.queueDepth - 1);
      record.queuePosition = undefined;
      await this.runCompile(record, lock, eventBus);
    });

    return { accepted: true, name, operationId, ...(willQueue ? { queued: true } : {}) };
  }

  // -------------------------------------------------------------------------
  // Detached compile body
  // -------------------------------------------------------------------------

  private async runCompile(record: OperationRecord, lock: PersonaCompileLock, eventBus: WebEventBus): Promise<void> {
    const { name, operationId } = record;
    record.phase = 'running';

    try {
      const reporterFactory = (serverName: string) => {
        const ctx: EventBusProgressReporterContext = {
          operationId,
          personaName: name,
          serverName,
          emit: (p) => eventBus.emit('persona.compile.progress', p),
          snapshotUpdate: (snapshot) => {
            record.serverProgress = {
              server: snapshot.serverName,
              compilationPhase: snapshot.compilationPhase,
              ...(snapshot.detail ? { detail: snapshot.detail } : {}),
            };
          },
        };
        return new EventBusProgressReporter(ctx);
      };

      // Lock, broad-policy validator, wall-clock cap and audit record: the
      // shared compile path. No live MCP for list resolution over the WS.
      const { policy, ruleDelta } = await runPersonaCompile(name, record.actor, {
        lock,
        allowMcpLists: false,
        reporterFactory,
        quiet: true,
        wallClockCapMs: this.wallClockCapMs,
        ...(this.deps.compileImpl ? { compileImpl: this.deps.compileImpl } : {}),
      });

      // A partial failure still writes the policy (so it ends in `done`), but
      // the failed servers have no rules: carry them on the result and event so
      // the UI does not report an unqualified success.
      const failedServers = toFailedServerDtos(policy.failedServers);
      record.result = {
        success: true,
        ruleCount: policy.rules.length,
        ...(ruleDelta ? { ruleDelta } : {}),
        ...(failedServers.length > 0 ? { failedServers } : {}),
      };
    } catch (err) {
      record.error = classifyPersonaCompileError(err);
    } finally {
      // ONE synchronous critical section: move active->recent, release lock.
      // No `await` between these ops so getCompile/listCompiles always find the
      // op in exactly one place.
      record.endedAt = new Date().toISOString();
      record.phase = record.error ? 'failed' : 'done';
      this.active.delete(name);
      lock.release();
      this.pushRecent(record);

      if (record.error) {
        eventBus.emit('persona.compile.failed', {
          name,
          operationId,
          code: record.error.code,
          error: record.error.message,
        });
      } else if (record.result) {
        eventBus.emit('persona.compile.done', { name, operationId, result: record.result });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Startup recovery
  // -------------------------------------------------------------------------

  /**
   * Scans persona dirs for `.compile.lock` files. A stale lock (dead pid or
   * past the wall-clock cap) is released and a synthetic `persona.compile.failed`
   * event is emitted (operationId from the lock) so a reconnecting UI clears the
   * stuck card. Live (pid-alive, within-cap) locks are left in place.
   */
  recoverStaleLocks(eventBus: WebEventBus): void {
    const personasDir = getPersonasDir();
    if (!existsSync(personasDir)) return;
    let entries: string[];
    try {
      entries = readdirSync(personasDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      let name: PersonaName;
      try {
        name = createPersonaName(entry);
      } catch {
        continue; // tmp dirs / trash / invalid slugs
      }
      if (!existsSync(getPersonaCompileLockPath(name))) continue;
      const content = readPersonaCompileLock(name);
      if (!content) {
        // Unparseable lock — treat as stale and remove.
        reclaimStalePersonaCompileLock(name, null);
        continue;
      }
      if (isPersonaCompileLockStale(content, this.wallClockCapMs)) {
        reclaimStalePersonaCompileLock(name, content);
        eventBus.emit('persona.compile.failed', {
          name,
          operationId: content.operationId,
          code: 'INTERNAL_ERROR',
          error: 'Compile interrupted by daemon restart.',
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Credential preflight
  // -------------------------------------------------------------------------

  private credentialPreflight(): void {
    const config = loadUserConfig({ readOnly: true });
    const missing = new Set<string>();
    // A separate verifier model (scenarios and judge) uses the policy role's
    // host profile, like the policy model.
    const verifier = config.policyVerifierModelId;
    for (const [role, modelId] of [
      ['policy', config.policyModelId],
      ['prefilter', config.prefilterModelId],
      ...(verifier !== undefined ? ([['policy', verifier]] as const) : []),
    ] as const) {
      const { provider } = parseModelId(modelId);
      const key = resolveHostModelApiKey(modelId, config, role);
      if (!key) missing.add(config.hostModelProfiles?.[role] ?? PROVIDER_ENV_VARS[provider]);
    }
    if (missing.size > 0) {
      throw new PersonaCompileError(
        'CREDENTIALS_MISSING',
        `Missing credential(s) on the daemon host: ${[...missing].join(', ')}.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Recent LRU
  // -------------------------------------------------------------------------

  private pushRecent(record: OperationRecord): void {
    // Map preserves insertion order; delete-then-set moves to MRU.
    this.recent.delete(record.operationId);
    this.recent.set(record.operationId, record);
    while (this.recent.size > RECENT_CAP) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

function toDto(rec: OperationRecord): PersonaCompileOperationDto {
  return {
    operationId: rec.operationId,
    name: rec.name,
    phase: rec.phase,
    ...(rec.serverProgress ? { serverProgress: rec.serverProgress } : {}),
    ...(rec.queuePosition !== undefined ? { queuePosition: rec.queuePosition } : {}),
    startedAt: rec.startedAt,
    ...(rec.endedAt ? { endedAt: rec.endedAt } : {}),
    ...(rec.result ? { result: rec.result } : {}),
    ...(rec.error ? { error: rec.error } : {}),
    actor: rec.actor,
  };
}

/**
 * Maps a compiled policy's `failedServers` to wire DTOs. Typed against the
 * pipeline contract, so a pipeline failure phase the DTO cannot carry is a
 * compile error here rather than a silently dropped failure.
 */
function toFailedServerDtos(failed: readonly FailedServer[] | undefined): FailedServerDto[] {
  return (failed ?? []).map((f) => ({ serverName: f.serverName, phase: f.phase, reason: f.reason }));
}

// ---------------------------------------------------------------------------
// Daemon singleton
// ---------------------------------------------------------------------------

/** The daemon-wide orchestrator singleton. Tests construct their own instance. */
export const personaCompileOrchestrator = new PersonaCompileOrchestrator();

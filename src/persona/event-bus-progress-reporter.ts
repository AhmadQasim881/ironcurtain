/**
 * src/persona/event-bus-progress-reporter.ts
 *
 * Bridges the pipeline's per-server {@link ServerProgressReporter} contract to
 * the daemon's persona-compile operation record + WS event bus (Phase 1b, §4.2).
 *
 * The reporter is created per server via the `reporterFactory` injected into
 * `PipelineRunConfig`. On every phase transition it:
 *   1. writes the live `{ serverName, compilationPhase, detail }` into the
 *      active operation record (the SNAPSHOT — the source of truth, so a
 *      reconnecting client renders the current phase from one `listCompiles`
 *      call), THEN
 *   2. emits the best-effort / lossy `persona.compile.progress` event (which
 *      only reaches currently-open WS clients).
 *
 * ZERO runtime value-imports from src/pipeline — the `ServerProgressReporter` /
 * `CompilationPhase` contracts are TYPE-ONLY imports. Enforced by the Phase-0
 * ESLint no-restricted-imports rule + test/pipeline-import-boundary.test.ts.
 *
 * @see docs/designs/web-ui-policy-persona-management.md §4.2
 */

import type { ServerProgressReporter, CompilationPhase } from '../pipeline/pipeline-shared.js';
import { toDisplayText } from '../terminal/display-sanitize.js';

/** Longest failure message carried in a progress detail (rendered characters). */
const FAILURE_DETAIL_MAX_LENGTH = 300;

/** Live server-progress snapshot written into the operation record. */
export interface ServerProgressSnapshot {
  readonly serverName: string;
  readonly compilationPhase: CompilationPhase;
  readonly detail?: string;
}

/** Wiring the reporter needs to update the snapshot and emit progress. */
export interface EventBusProgressReporterContext {
  readonly operationId: string;
  readonly personaName: string;
  readonly serverName: string;
  /** Emit the (best-effort) progress event. */
  readonly emit: (progress: {
    name: string;
    operationId: string;
    serverName: string;
    phase: CompilationPhase;
    detail?: string;
  }) => void;
  /** Write the live phase into the active operation record (source of truth). */
  readonly snapshotUpdate: (snapshot: ServerProgressSnapshot) => void;
}

/**
 * `ServerProgressReporter` implementation that drives the operation-record
 * snapshot first, then emits a progress event.
 */
export class EventBusProgressReporter implements ServerProgressReporter {
  constructor(private readonly ctx: EventBusProgressReporterContext) {}

  update(phase: CompilationPhase, detail?: string): void {
    // 1) snapshot = source of truth — write BEFORE emitting.
    this.ctx.snapshotUpdate({
      serverName: this.ctx.serverName,
      compilationPhase: phase,
      ...(detail ? { detail } : {}),
    });
    // 2) best-effort, lossy progress event.
    this.ctx.emit({
      name: this.ctx.personaName,
      operationId: this.ctx.operationId,
      serverName: this.ctx.serverName,
      phase,
      ...(detail ? { detail } : {}),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface conformance (elapsed unused)
  complete(phase: CompilationPhase, summary: string, elapsed: number): void {
    this.update(phase, summary);
  }

  warn(message: string): void {
    // Route applyServerAllowlist-style warnings as progress, not stderr.
    this.update('compiling', message);
  }

  fail(phase: CompilationPhase, error: Error): void {
    // One server failed. Show it in the live snapshot and progress stream; the
    // compile may still finish for the other servers. The authoritative record
    // is emitted by the orchestrator: the terminal result's `failedServers`
    // (partial failure, `persona.compile.done`) or `persona.compile.failed`.
    this.update(phase, `Failed: ${toDisplayText(error.message, { maxLength: FAILURE_DETAIL_MAX_LENGTH })}`);
  }

  done(summary: string): void {
    // The terminal `persona.compile.done` event is emitted by the
    // orchestrator's finally block; reflect the final phase in the snapshot.
    this.update('done', summary);
  }
}

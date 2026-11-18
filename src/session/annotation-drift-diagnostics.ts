/**
 * Turns the live-schema drift a session's coordinator recorded while
 * registering its servers' tools (`trusted-process/schema-drift.ts`) into
 * `annotation_drift` diagnostics, one per server whose drift changes what
 * policy evaluates, and renders them for terminals. Shared by the builtin
 * and Docker agent sessions, the CLI transport and the PTY session (mux and
 * web terminals) so every surface reports drift the same way.
 *
 * Drift without a policy effect (schema text, the `required` list, stale
 * annotations) stays in the session log only.
 */

import {
  describeDriftNotice,
  serverDriftAffectsPolicy,
  type ServerSchemaDrift,
} from '../trusted-process/schema-drift.js';
import type { DiagnosticEvent } from './types.js';

export type AnnotationDriftDiagnostic = Extract<DiagnosticEvent, { kind: 'annotation_drift' }>;

export function annotationDriftDiagnostics(drifts: Iterable<ServerSchemaDrift>): AnnotationDriftDiagnostic[] {
  const events: AnnotationDriftDiagnostic[] = [];
  for (const drift of drifts) {
    if (!serverDriftAffectsPolicy(drift)) continue;
    const { message, hint } = describeDriftNotice(drift);
    events.push({ kind: 'annotation_drift', serverName: drift.serverName, message, hint });
  }
  return events;
}

/**
 * A drift diagnostic as terminal lines (no trailing newline, no color).
 * Server-provided names were already rendered as display text by
 * `describeDriftNotice`.
 */
export function formatAnnotationDriftNotice(event: AnnotationDriftDiagnostic): string {
  return `  [annotations] Warning: ${event.message}\n    ${event.hint}`;
}

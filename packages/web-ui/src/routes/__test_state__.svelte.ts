import type { PendingEscalation } from '$lib/types.js';

export const testWorkflowHistoryGeneration = $state({ value: 0 });

export const testConnectionGeneration = $state({ value: 0 });
export const testConfigChangedGeneration = $state({ value: 0 });

/** Reactive stand-in for the slice of `appState` the Escalations route reads. */
export const testEscalationsAppState = $state({
  pendingEscalations: new Map<string, PendingEscalation>(),
});

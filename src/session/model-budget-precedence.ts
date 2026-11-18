/**
 * Where a session's agent model and resource limits come from.
 *
 * Agent model, highest precedence first:
 *   1. `--model` on the command line: `ironcurtain start` (and so the
 *      `start --pty` children of the mux and the web UI) and `ironcurtain
 *      workflow start|resume-standalone|run-state`
 *   2. the workflow state's `model`
 *   3. the workflow's `settings.model`
 *   4. the persona's `agentModelId`
 *   5. the global `agentModelId` (config.json, else the built-in default)
 * Callers collapse 1-3 into `SessionOptions.agentModelOverride` (the
 * workflow session factory puts `--model` over the orchestrator's
 * `state.model ?? settings.model`); `buildSessionConfig` applies 4 and 5
 * through {@link resolveSessionAgentModel}.
 *
 * Resource limits, field by field, highest precedence first:
 *   1. limits the caller sets explicitly for the session
 *      (`SessionOptions.resourceBudgetOverrides`): a workflow's
 *      `settings.resourceBudget`, a cron job's `budgetOverrides`
 *   2. the persona's `resourceBudget`
 *   3. the caller's own defaults (`SessionOptions.resourceBudgetBaseline`):
 *      the global/default limits a workflow run saved at start, the cron
 *      defaults
 *   4. the session config's `resourceBudget` (config.json, else the
 *      built-in defaults)
 * `buildSessionConfig` applies them through {@link layerResourceBudget}.
 * A `null` limit is a value like any other: it disables that limit, and a
 * higher layer can set it again.
 */

import type { IronCurtainConfig } from '../config/types.js';
import type { ResolvedResourceBudgetConfig } from '../config/user-config.js';

/** Which layer chose a session's agent model. */
export type AgentModelSource = 'override' | 'persona' | 'global';

/** A session's agent model and the layer it came from. */
export interface SessionAgentModel {
  readonly modelId: string;
  readonly source: AgentModelSource;
}

/**
 * Picks the agent model for a session: the caller's override (`--model`, a
 * workflow state or workflow settings model), else the persona's
 * `agentModelId`, else the global `agentModelId`.
 */
export function resolveSessionAgentModel(input: {
  readonly override?: string;
  readonly persona?: string;
  readonly global: string;
}): SessionAgentModel {
  if (input.override !== undefined) return { modelId: input.override, source: 'override' };
  if (input.persona !== undefined) return { modelId: input.persona, source: 'persona' };
  return { modelId: input.global, source: 'global' };
}

/**
 * Lays partial limits over a complete budget, lowest layer first, field by
 * field. A field a layer leaves out (or sets to `undefined`) keeps the value
 * below it; `null` disables the limit.
 */
export function layerResourceBudget(
  base: ResolvedResourceBudgetConfig,
  ...layers: readonly (Partial<ResolvedResourceBudgetConfig> | undefined)[]
): ResolvedResourceBudgetConfig {
  const merged: Record<string, number | null> = { ...base };
  for (const layer of layers) {
    if (layer === undefined) continue;
    for (const key of Object.keys(layer) as (keyof ResolvedResourceBudgetConfig)[]) {
      const limit = layer[key];
      if (limit !== undefined) merged[key] = limit;
    }
  }
  return merged as unknown as ResolvedResourceBudgetConfig;
}

/**
 * Returns `config` with `modelId` as its agent model, in both places the
 * session layers read it: `agentModelId` (the builtin agent, provider
 * gateways) and `userConfig.agentModelId` (the container agent adapters).
 * The caller's config is not modified.
 */
export function withAgentModelId(config: IronCurtainConfig, modelId: string): IronCurtainConfig {
  return { ...config, agentModelId: modelId, userConfig: { ...config.userConfig, agentModelId: modelId } };
}

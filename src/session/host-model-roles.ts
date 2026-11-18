/**
 * Credentials of the host-side models a session uses beside its agent.
 *
 * A builtin session's agent model is checked by preflight: without a key
 * the session does not start. The other host-model roles belong to optional
 * features whose model defaults to an Anthropic model whatever provider the
 * agent uses, so a user with only an OpenAI or Google key used to start
 * normally and find them broken later:
 *
 * - `summary` (auto-compaction; builtin sessions only, the only ones that
 *   compact on the host). Every compaction failed, and a long conversation
 *   grew until the provider refused it. The session now summarizes with the
 *   agent's own model and host profile instead, or turns auto-compaction off
 *   when even that has no key (not reachable past preflight in practice).
 * - `autoApprove` (both modes). Every escalation made a doomed model call
 *   before it reached a human. The session now turns auto-approve off and
 *   escalations go straight to a human; the approving model is never
 *   swapped for another, since what may approve tool calls is the user's
 *   choice.
 * - memory (sessions that run the memory server). Without an LLM the
 *   server runs without summarization, deduplication and compaction, as
 *   designed; the session only says so.
 *
 * `policyModelId` and `prefilterModelId` are used by the offline pipeline
 * alone and are not a session's concern.
 *
 * Pure: preflight uses it to warn before a session exists, and
 * `buildSessionConfig` applies the plan to the session's configuration.
 */

import { PROVIDER_ENV_VARS, parseModelId, resolveHostModelApiKey } from '../config/model-provider.js';
import { resolveActiveProfile, type HostModelRole, type ResolvedUserConfig } from '../config/user-config.js';
import type { HostModelNoticeAction, HostModelNoticeRole } from './types.js';

/** What a session uses on the host. */
export interface HostModelRoleScope {
  /** `builtin` runs the agent loop, and with it auto-compaction, on the host; `docker` does not. */
  readonly mode: 'builtin' | 'docker';
  /** The agent model of a builtin session, a per-session override included. */
  readonly agentModelId: string;
  /** Whether the session runs the memory server. */
  readonly memoryEnabled: boolean;
}

/** One role the session runs differently, and why. */
export interface HostModelNotice {
  readonly role: HostModelNoticeRole;
  readonly action: HostModelNoticeAction;
  /** What happens and how to fix the configuration, as one line. */
  readonly message: string;
}

export interface HostModelRolePlan {
  /** The configuration to run with: the input object itself when nothing changed. */
  readonly userConfig: ResolvedUserConfig;
  readonly notices: readonly HostModelNotice[];
}

/**
 * Checks the credentials of every host-model role the session uses and
 * returns the configuration with the fallbacks applied (see the module
 * comment), plus one notice per role that changed.
 */
export function planHostModelRoles(userConfig: ResolvedUserConfig, scope: HostModelRoleScope): HostModelRolePlan {
  let planned = userConfig;
  const notices: HostModelNotice[] = [];

  // A configuration built by hand (tests, embedders) may omit a section;
  // a missing section is a feature that is off.
  const compact = planned.autoCompact as ResolvedUserConfig['autoCompact'] | undefined;
  if (
    scope.mode === 'builtin' &&
    compact?.enabled === true &&
    !hasHostModelKey(compact.summaryModelId, planned, 'summary')
  ) {
    const missing = describeMissingKey(compact.summaryModelId, planned, 'summary');
    if (hasHostModelKey(scope.agentModelId, planned, 'agent')) {
      planned = {
        ...planned,
        autoCompact: { ...compact, summaryModelId: scope.agentModelId },
        // The summary is then created exactly as the agent's model is,
        // through the agent's host profile, if it has one.
        hostModelProfiles: withRoleProfile(planned.hostModelProfiles, 'summary', planned.hostModelProfiles?.agent),
      };
      notices.push({
        role: 'summary',
        action: 'agent_model',
        message:
          `Auto-compaction's summary model "${compact.summaryModelId}" has no credentials (${missing}); ` +
          `this session summarizes with the agent model "${scope.agentModelId}" instead. ` +
          'Set autoCompact.summaryModelId (ironcurtain config) to a model you have a key for.',
      });
    } else {
      planned = { ...planned, autoCompact: { ...compact, enabled: false } };
      notices.push({
        role: 'summary',
        action: 'disabled',
        message:
          `Auto-compaction is off for this session: its summary model "${compact.summaryModelId}" has no ` +
          `credentials (${missing}), and neither does the agent model "${scope.agentModelId}". ` +
          'A long conversation will eventually exceed the context window.',
      });
    }
  }

  const approve = planned.autoApprove as ResolvedUserConfig['autoApprove'] | undefined;
  if (approve?.enabled === true && !hasHostModelKey(approve.modelId, planned, 'autoApprove')) {
    planned = { ...planned, autoApprove: { ...approve, enabled: false } };
    notices.push({
      role: 'autoApprove',
      action: 'disabled',
      message:
        `Auto-approve is off for this session: its model "${approve.modelId}" has no credentials ` +
        `(${describeMissingKey(approve.modelId, planned, 'autoApprove')}), so every escalation goes to a human. ` +
        'Set autoApprove.modelId (ironcurtain config) to a model you have a key for.',
    });
  }

  if (scope.memoryEnabled && !hasMemoryLlm(planned)) {
    notices.push({
      role: 'memory',
      action: 'degraded',
      message:
        'Memory runs without its LLM in this session (no summarization, deduplication or compaction): ' +
        'set memory.llmApiKey or memory.llmBaseUrl, or ANTHROPIC_API_KEY.',
    });
  }

  return { userConfig: planned, notices };
}

/** True when `role` has a key for `modelId` (its host profile's, or the provider's). */
function hasHostModelKey(modelId: string, userConfig: ResolvedUserConfig, role: HostModelRole): boolean {
  try {
    return resolveHostModelApiKey(modelId, userConfig, role).length > 0;
  } catch {
    // An unparsable model id or an unknown profile cannot authenticate either.
    return false;
  }
}

/** Which credential is missing for `role`, for the notice. */
function describeMissingKey(modelId: string, userConfig: ResolvedUserConfig, role: HostModelRole): string {
  try {
    const profileName = userConfig.hostModelProfiles?.[role];
    if (profileName !== undefined && resolveActiveProfile(userConfig.modelProviders, profileName).type !== 'native') {
      return `host model profile "${profileName}" has no API key`;
    }
    return `no ${PROVIDER_ENV_VARS[parseModelId(modelId).provider]} is configured`;
  } catch {
    return 'its provider or profile cannot be resolved';
  }
}

/**
 * Whether the memory server gets an LLM: an explicit memory key or base URL,
 * else the Anthropic key (see `resolveMemoryLlm` in memory-annotations.ts).
 */
function hasMemoryLlm(userConfig: ResolvedUserConfig): boolean {
  const memory = userConfig.memory as ResolvedUserConfig['memory'] | undefined;
  return Boolean(memory?.llmApiKey) || Boolean(memory?.llmBaseUrl) || Boolean(userConfig.anthropicApiKey);
}

/** `profiles` with `role` bound to `profileName`, or unbound when it is undefined. */
function withRoleProfile(
  profiles: ResolvedUserConfig['hostModelProfiles'],
  role: HostModelRole,
  profileName: string | undefined,
): Partial<Record<HostModelRole, string>> {
  const entries = Object.entries(profiles ?? {}).filter(([name]) => name !== role);
  if (profileName !== undefined) entries.push([role, profileName]);
  return Object.fromEntries(entries);
}

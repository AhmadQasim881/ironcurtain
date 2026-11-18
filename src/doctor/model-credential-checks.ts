/**
 * Per-role model credential checks for `ironcurtain doctor`.
 *
 * IronCurtain calls models on the host in several roles, each with its own
 * model id and, optionally, its own provider profile (`hostModelProfiles`):
 *
 *   - agent: the builtin (Code Mode) agent;
 *   - policy and prefilter: policy compilation (`compile-policy`,
 *     `annotate-tools`, persona and job policies, `customize-policy`);
 *   - summary: auto-compaction of builtin sessions;
 *   - autoApprove: the auto-approver, when it is enabled;
 *   - contentAssessment: the outbound content intelligibility check, when the
 *     content assessment and its LLM check are on (without a key every call
 *     that reaches the check escalates).
 *
 * A role whose key is missing fails only when it is first used, often
 * unattended (a cron job's recompile, a compaction in the middle of a
 * session). Each role in use is therefore resolved here exactly as it is at
 * run time (`resolveHostModelApiKey`), so a profile-routed role is checked
 * against its profile's key and a native one against its provider's key,
 * not always Anthropic's. Container gateway and Goose API keys are checked
 * separately below. Native OAuth login checks are in oauth-checks.ts.
 *
 * Read-only: nothing here writes or calls a provider.
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getIronCurtainHome, getJobsDir, getUserGeneratedDir } from '../config/paths.js';
import {
  parseModelId,
  PROVIDER_ENV_VARS,
  resolveApiKeyForProvider,
  resolveHostModelApiKey,
  type ProviderId,
} from '../config/model-provider.js';
import { getGatewayDefinition } from '../config/provider-definitions.js';
import {
  hostRoleModelId,
  resolveActiveProfile,
  type HostModelRole,
  type ResolvedUserConfig,
} from '../config/user-config.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import type { CheckResult } from './checks.js';

/** How one host model role's API key is supplied. */
export interface HostModelKeyStatus {
  readonly modelId: string;
  readonly present: boolean;
  /** The provider profile routing the role, when it is not `native`. */
  readonly profileName?: string;
  /** What is missing, for messages: an env var name or a profile's key. */
  readonly needed: string;
  /** How to supply it. */
  readonly hint: string;
}

/**
 * Resolves `role`'s key the way the role does at run time. Never throws: a
 * profile or model id that cannot be resolved counts as a missing key.
 */
export function hostModelKeyStatus(
  modelId: string,
  userConfig: ResolvedUserConfig,
  role: HostModelRole,
): HostModelKeyStatus {
  let key = '';
  try {
    key = resolveHostModelApiKey(modelId, userConfig, role);
  } catch {
    // An unknown profile or a malformed model id: sessions fail the same way.
  }
  const present = key.length > 0;
  const profileName = userConfig.hostModelProfiles?.[role];
  if (profileName !== undefined) {
    let profileType: string | undefined;
    try {
      profileType = resolveActiveProfile(userConfig.modelProviders, profileName).type;
    } catch {
      profileType = undefined;
    }
    if (profileType !== 'native') {
      let credentialEnv: string | undefined;
      try {
        credentialEnv = profileType === undefined ? undefined : getGatewayDefinition(profileType).editor.credentialEnv;
      } catch {
        credentialEnv = undefined;
      }
      return {
        modelId,
        present,
        profileName,
        needed: `API key for provider profile "${profileName}"`,
        hint:
          `${credentialEnv === undefined ? 'Set' : `Set ${credentialEnv} or`} the profile's apiKey ` +
          '(`ironcurtain config` > Model Providers).',
      };
    }
  }
  let provider: ProviderId = 'anthropic';
  try {
    provider = parseModelId(modelId).provider;
  } catch {
    // Reported as missing under the default provider's variable.
  }
  const envVar = PROVIDER_ENV_VARS[provider];
  return {
    modelId,
    present,
    needed: envVar,
    hint: `Set ${envVar} in your environment or in ${resolve(getIronCurtainHome(), '.env')}, or run \`ironcurtain config\`.`,
  };
}

/**
 * True when policies may need compiling on this host: the user has personas
 * or cron jobs (whose policies are compiled on their creation, on every
 * constitution edit and after upgrades) or a compiled global policy of
 * their own.
 */
function policyCompilationInUse(): boolean {
  return (
    hasEntries(resolve(getIronCurtainHome(), 'personas')) ||
    hasEntries(getJobsDir()) ||
    existsSync(resolve(getUserGeneratedDir(), 'compiled-policy.json'))
  );
}

function hasEntries(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => !entry.startsWith('.'));
  } catch {
    return false;
  }
}

interface RoleSpec {
  readonly role: HostModelRole;
  readonly name: string;
  readonly modelId: (userConfig: ResolvedUserConfig) => string;
  /** Whether the role is in use, and what fails without its key. */
  readonly use: (userConfig: ResolvedUserConfig) => { readonly inUse: boolean; readonly usage: string } | undefined;
}

const ROLES: readonly RoleSpec[] = [
  {
    role: 'agent',
    name: 'Agent model',
    modelId: (c) => c.agentModelId,
    use: (c) => ({ inUse: c.preferredMode === 'builtin', usage: 'builtin sessions' }),
  },
  {
    role: 'policy',
    name: 'Policy model',
    modelId: (c) => c.policyModelId,
    use: () => ({
      inUse: policyCompilationInUse(),
      usage: 'policy compilation (compile-policy, annotate-tools, persona and job policies)',
    }),
  },
  {
    role: 'prefilter',
    name: 'Prefilter model',
    modelId: (c) => c.prefilterModelId,
    use: () => ({ inUse: policyCompilationInUse(), usage: 'policy compilation' }),
  },
  {
    role: 'summary',
    name: 'Summary model',
    modelId: (c) => c.autoCompact.summaryModelId,
    // Disabled auto-compaction needs no key; nothing to report.
    use: (c) =>
      c.autoCompact.enabled
        ? { inUse: c.preferredMode === 'builtin', usage: 'auto-compaction of builtin sessions' }
        : undefined,
  },
  {
    role: 'autoApprove',
    name: 'Auto-approve model',
    modelId: (c) => c.autoApprove.modelId,
    use: (c) => (c.autoApprove.enabled ? { inUse: true, usage: 'the auto-approver' } : undefined),
  },
  {
    role: 'contentAssessment',
    name: 'Content assessment model',
    modelId: (c) => hostRoleModelId(c, 'contentAssessment'),
    // Needs no key unless the content assessment and its LLM check are both on.
    use: (c) =>
      c.contentAssessment?.enabled === true && c.contentAssessment.llmCheck
        ? { inUse: true, usage: 'the outbound content intelligibility check' }
        : undefined,
  },
];

/**
 * One result per host model role: ok with the key's source, a warning
 * (with the remedy) naming what fails when a role in use has no key, or a
 * skip line when the missing key is not needed by this configuration yet.
 * Disabled roles (auto-compaction, the auto-approver, the content
 * assessment's LLM check) are left out.
 */
export function checkModelCredentials(userConfig: ResolvedUserConfig): CheckResult[] {
  const results: CheckResult[] = [];
  for (const spec of ROLES) {
    const use = spec.use(userConfig);
    if (use === undefined) continue;
    const status = hostModelKeyStatus(spec.modelId(userConfig), userConfig, spec.role);
    const model = toDisplayText(status.modelId, { maxLength: 80 });
    if (status.present) {
      const via = status.profileName !== undefined ? ` (provider profile "${toDisplayText(status.profileName)}")` : '';
      results.push({ name: spec.name, status: 'ok', message: `${model}: API key set${via}` });
    } else if (use.inUse) {
      results.push({
        name: spec.name,
        status: 'warn',
        message: `${model}: no ${status.needed}; ${use.usage} will fail`,
        hint: status.hint,
      });
    } else {
      results.push({
        name: spec.name,
        status: 'skip',
        message: `${model}: no ${status.needed} (needed only for ${use.usage})`,
      });
    }
  }
  return results;
}

/** The preferred container route can require a different credential from every host role. */
export function checkContainerAgentCredentials(
  config: ResolvedUserConfig,
  codexLogin: CheckResult | undefined,
): CheckResult | undefined {
  if (config.preferredMode !== 'container') return undefined;
  const agent = config.preferredDockerAgent;
  const profile = resolveActiveProfile(config.modelProviders);
  const name = 'Container agent';
  if (profile.type === 'native' && agent !== 'goose') {
    // The native login checks already report Claude and any existing Codex
    // login. A missing Codex login normally has no line of its own.
    return agent === 'codex' && codexLogin === undefined
      ? { name, status: 'fail', message: 'codex: no ChatGPT login found', hint: 'Run `codex login` on the host.' }
      : undefined;
  }
  const route =
    profile.type === 'native'
      ? {
          label: `goose (${config.gooseProvider})`,
          present: Boolean(resolveApiKeyForProvider(config.gooseProvider, config)),
          env: PROVIDER_ENV_VARS[config.gooseProvider],
        }
      : {
          label: `${agent} (profile "${toDisplayText(config.modelProviders.default)}")`,
          present: Boolean(profile.apiKey),
          env: getGatewayDefinition(profile.type).editor.credentialEnv,
        };
  return route.present
    ? { name, status: 'ok', message: `${route.label}: API key set` }
    : {
        name,
        status: 'fail',
        message: `${route.label}: missing API key`,
        hint: `Set ${route.env} or use \`ironcurtain config\`.`,
      };
}

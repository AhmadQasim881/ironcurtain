/**
 * Collects the credential values IronCurtain itself holds so the audit
 * redactor can replace them wherever they appear in tool arguments and
 * results (an agent copying a key from a workspace `.env` into a
 * `write_file` call, a token echoed back in an error message, ...).
 *
 * Pattern-based redaction in `audit-redactor.ts` catches well-known key
 * formats; this list catches the exact values regardless of format. The
 * same idea protects the session log: the MCP relay replaces its
 * configured credentials in backend stderr before writing it. The session's
 * other logs (full-detail LLM interaction logs, interactions.jsonl) get the
 * same redaction through `resolveLogRedaction`.
 *
 * Everything here is best effort and read-only. A credential store that
 * is missing, unreadable or malformed contributes nothing; it never
 * prevents the coordinator from starting. The list is a snapshot taken
 * when the coordinator is built: a token refreshed later in the session
 * is covered by the format patterns only.
 */

import { loadClientCredentials } from '../auth/oauth-provider.js';
import { getAllOAuthProviders } from '../auth/oauth-registry.js';
import { loadOAuthToken } from '../auth/oauth-token-store.js';
import { loadAllOAuthCredentialFiles, loadCodexOAuthCredentials } from '../docker/oauth-credentials.js';
import { prepareRedactionSecrets, type LogRedaction } from './audit-redactor.js';

/**
 * The parts of the resolved user configuration that carry credentials.
 * Every field is optional so hand-built partial configurations (tests,
 * embedders) are accepted; `ResolvedUserConfig` satisfies it as is.
 */
export interface AuditSecretSources {
  readonly serverCredentials?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly anthropicApiKey?: string;
  readonly googleApiKey?: string;
  readonly openaiApiKey?: string;
  readonly modelProviders?: {
    readonly profiles: Readonly<Record<string, { readonly type: string; readonly apiKey?: string }>>;
  };
  readonly memory?: { readonly llmApiKey?: string | undefined };
  readonly webSearch?: {
    readonly brave: { readonly apiKey: string } | null;
    readonly tavily: { readonly apiKey: string } | null;
    readonly serpapi: { readonly apiKey: string } | null;
  };
}

export interface CollectAuditSecretsOptions {
  /**
   * Also read the OAuth tokens and client secrets stored on this host
   * (Claude Code / Anthropic CLI credentials, Codex CLI auth, IronCurtain's
   * own `~/.ironcurtain/oauth/` store). Default true. Offline callers that
   * never see those tokens may turn it off.
   */
  readonly includeHostCredentialStores?: boolean;
}

/**
 * Returns every credential value found in `sources` (and, by default, in
 * the host credential stores) for exact-match audit redaction. Empty and
 * non-string values are dropped; de-duplication and the minimum length
 * are applied by the redactor (`prepareRedactionSecrets`).
 */
export function collectAuditRedactionSecrets(
  sources: AuditSecretSources,
  options: CollectAuditSecretsOptions = {},
): readonly string[] {
  const secrets: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) secrets.push(value);
  };

  for (const serverEnv of Object.values(sources.serverCredentials ?? {})) {
    for (const value of Object.values(serverEnv)) add(value);
  }
  add(sources.anthropicApiKey);
  add(sources.googleApiKey);
  add(sources.openaiApiKey);
  for (const profile of Object.values(sources.modelProviders?.profiles ?? {})) add(profile.apiKey);
  add(sources.memory?.llmApiKey);
  add(sources.webSearch?.brave?.apiKey);
  add(sources.webSearch?.tavily?.apiKey);
  add(sources.webSearch?.serpapi?.apiKey);

  if (options.includeHostCredentialStores ?? true) {
    for (const value of readHostCredentialStores()) add(value);
  }

  return secrets;
}

/**
 * Redaction for the logs a session writes besides audit.jsonl (full-detail
 * LLM interaction logs, interactions.jsonl): the audit redactor's patterns
 * plus every credential value `collectAuditRedactionSecrets` finds. Null
 * when the user turned audit redaction off (`auditRedaction.enabled: false`),
 * which keeps those logs verbatim, like audit.jsonl. A configuration built
 * without `auditRedaction` gets the default: redaction on.
 */
export function resolveLogRedaction(
  sources: AuditSecretSources & { readonly auditRedaction?: { readonly enabled: boolean } },
  options: CollectAuditSecretsOptions = {},
): LogRedaction | null {
  if (sources.auditRedaction?.enabled === false) return null;
  return { secrets: prepareRedactionSecrets(collectAuditRedactionSecrets(sources, options)) };
}

/**
 * Credential values from the host's credential stores, each store read
 * independently so one unreadable file does not hide the others.
 */
function readHostCredentialStores(): readonly string[] {
  const values: string[] = [];

  attempt(() => {
    // Every Claude Code / Anthropic CLI credential file, not just the one a
    // session would pick: either can hold a token the user has in play.
    for (const { credentials } of loadAllOAuthCredentialFiles()) {
      values.push(credentials.accessToken, credentials.refreshToken);
    }
  });

  attempt(() => {
    const codex = loadCodexOAuthCredentials();
    if (codex) values.push(codex.accessToken, codex.refreshToken, codex.idToken ?? '');
  });

  for (const provider of getAllOAuthProviders()) {
    attempt(() => {
      const token = loadOAuthToken(provider.id);
      if (token) values.push(token.accessToken, token.refreshToken);
    });
    attempt(() => {
      const client = loadClientCredentials(provider);
      if (client) values.push(client.clientSecret);
    });
  }

  return values;
}

/** Runs a credential-store read; a failure contributes nothing. */
function attempt(read: () => void): void {
  try {
    read();
  } catch {
    // Missing, unreadable or malformed store: nothing to redact from it.
  }
}

/**
 * LLM interaction logging for the session runtime: the builtin agent's
 * `llm-interactions.jsonl` and the auto-approver's `auto-approve-llm.jsonl`.
 *
 * Applies the user's `observability.llmInteractionLog` setting:
 *   - 'off':      no middleware is installed and no file is created;
 *   - 'metadata': sizes, timings and token counts only (the default);
 *   - 'full':     prompts and responses as well, passed through the audit
 *                 redactor with every known credential value unless
 *                 `auditRedaction.enabled` is false.
 *
 * Session logs are only ever appended to. A session directory belongs to one
 * session, so a fresh session starts with no file, and a resumed session
 * (`--resume`) extends the log its earlier run wrote instead of truncating it.
 */

import type { LanguageModelMiddleware } from 'ai';
import { resolveLlmInteractionLogMode, type ResolvedUserConfig } from '../config/user-config.js';
import { resolveLogRedaction } from '../trusted-process/audit-secrets.js';
import { createLlmLoggingMiddleware, type LlmLogContext } from './llm-logger.js';

export interface SessionLlmLogOptions {
  /**
   * Log only the prompt messages added since the previous entry. For one
   * long-running conversation (the agent), not for independent calls (the
   * auto-approver).
   */
  readonly deltaLogging?: boolean;
}

/**
 * The logging middleware for an LLM the session calls itself, or undefined
 * when `observability.llmInteractionLog` is 'off'. The log at `logPath` is
 * created (mode 0600) when it is missing and appended to otherwise.
 */
export function createSessionLlmLogMiddleware(
  logPath: string,
  context: LlmLogContext,
  userConfig: ResolvedUserConfig,
  options: SessionLlmLogOptions = {},
): LanguageModelMiddleware | undefined {
  const mode = resolveLlmInteractionLogMode(userConfig);
  if (mode === 'off') return undefined;
  return createLlmLoggingMiddleware(logPath, context, {
    detail: mode,
    deltaLogging: options.deltaLogging,
    appendOnly: true,
    // The credential stores are read only when the log will hold text.
    redaction: mode === 'full' ? resolveLogRedaction(userConfig) : null,
  });
}

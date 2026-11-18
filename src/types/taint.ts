/**
 * Shared vocabulary of the sequence-aware (taint) policy: the user config
 * schema (`taintEscalation`), the audit record (`AuditEntry.taint`) and the
 * trusted process (`trusted-process/taint-policy.ts`) all use it, so it lives
 * in this leaf. See docs/designs/sequence-aware-policy.md.
 */

/**
 * How a tool takes part in taint tracking:
 * - `source`: its result can carry content other people wrote, so
 *   dispatching it taints the session;
 * - `sink`: it can deliver data to other people or act where they see it
 *   (send, post, push, share), so in a tainted session only a human may
 *   approve it;
 * - `both`: either role;
 * - `none`: neither.
 */
export const TAINT_TOOL_CLASSES = ['source', 'sink', 'both', 'none'] as const;
export type TaintToolClass = (typeof TAINT_TOOL_CLASSES)[number];

/**
 * A `taintEscalation.tools` key: `server/tool` names one tool, `server/*`
 * every tool of a server. Names are restricted to the characters MCP server
 * and tool names use, so a key can never be mistaken for a pattern.
 */
export const TAINT_TOOL_KEY_PATTERN = /^[A-Za-z0-9_.-]+\/(?:\*|[A-Za-z0-9_.-]+)$/;

/** What tainted a session: recorded on sink audit records and shown to the human approver. */
export interface TaintEvent {
  /**
   * `server/tool` of the call whose result could carry untrusted content,
   * or a fixed description when the state was restored without one (an
   * audit log that could not be replayed).
   */
  readonly via: string;
  /** The `requestId` of that call's audit records, when it was a call. */
  readonly requestId?: string;
  /** When it happened: the call's timestamp (ISO 8601). */
  readonly timestamp: string;
}

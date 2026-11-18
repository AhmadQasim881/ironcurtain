/**
 * Sequence-aware (taint) policy, slice 1: a monotonic per-session taint flag
 * and the human escalation it forces. See
 * docs/designs/sequence-aware-policy.md.
 *
 * The policy engine judges every call on its own. Some harm only shows in a
 * sequence of calls that are each allowed: the agent reads content an
 * attacker wrote (a web page, an email, an issue comment) and then acts on it
 * through an outbound channel (sends mail, posts a comment, pushes code).
 * This module tracks that pattern for one session:
 *
 * - A *taint source* is a tool whose result can carry content other people
 *   wrote. Dispatching one taints the session for the rest of its life. The
 *   flag is set when the call's write-ahead audit record is written, before
 *   the backend can return anything, and the record says so
 *   (`AuditEntry.taint.source`).
 * - A *taint sink* is a tool that can deliver data to other people or act
 *   where they see it: send, post, push, share. In a tainted session every
 *   sink call that policy does not deny must be decided by a human, one call
 *   at a time (`evaluateWithTaint`): an allowed call is escalated (rule
 *   `taint-escalation`), an escalated one becomes human-only. No approval
 *   whitelist pattern, no auto-approver and no bulk approval can decide it.
 *   A deny stays a deny.
 *
 * Taint is never cleared: once untrusted content is in the model's context
 * nothing proves later reasoning is free of it. It survives policy hot-swaps
 * (it describes the agent's context, not a persona's policy) and is shared by
 * every lane of a workflow bundle that shares one coordinator, since lanes
 * share a workspace through which content can travel. A coordinator built on
 * an existing audit log (a resumed session) replays it first
 * (`restoreTaintFromAuditLog`); a resumed workflow run mints new bundles
 * with new audit logs, and each replays the audit logs of the bundles the
 * run's earlier legs minted (`createSessionTaint`'s `earlierAuditLogPaths`).
 *
 * Opt-in: `taintEscalation.enabled` in the user config, default off. When it
 * is off the coordinator builds no `SessionTaint`, the pipeline behaves
 * exactly as before and no audit record carries taint facts.
 *
 * The classification is static and deterministic, no LLM involved: the
 * built-in servers' profiles below (`DEFAULT_TAINT_PROFILES`), overridden per
 * tool or per server by `taintEscalation.tools`. Trusted servers (the memory
 * server) skip annotations and compiled rules, and their own per-tool policy
 * (trusted-server-policy.ts) alone decides their calls, so they are never
 * sinks; they can be configured as sources.
 *
 * Not covered by this slice (see the design doc): content the agent reads
 * from its own workspace or from persistent memory, and Docker Agent Mode
 * traffic that never becomes an MCP call (package registry downloads,
 * preconfigured MITM hosts). An approved passthrough domain
 * (`proxy/add_proxy_domain`) is a source, because it opens a channel the
 * coordinator cannot see. So is a destination admitted by policy-evaluated
 * MITM egress (`network/request`, opt-in `egressPolicy`; see
 * `egress-policy.ts`): the coordinator decides and audits it like a call,
 * and marks the session when it admits one, before the proxy opens anything.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { EvaluationResult } from './policy-types.js';
import { AUDIT_STATUS_DISPATCHING, type AuditTaintFacts } from '../types/audit.js';
import { TAINT_TOOL_CLASSES, TAINT_TOOL_KEY_PATTERN, type TaintEvent, type TaintToolClass } from '../types/taint.js';
import * as logger from '../logger.js';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** The taint roles of one tool. */
export interface TaintRoles {
  readonly source: boolean;
  readonly sink: boolean;
}

/** `taintEscalation` from the resolved user config (`ResolvedTaintEscalationConfig`). */
export interface TaintEscalationOptions {
  readonly enabled: boolean;
  /**
   * Per-tool (`server/tool`) and per-server (`server/*`) classes that
   * replace the defaults. A tool key wins over its server's key, which wins
   * over the server's default profile.
   */
  readonly tools?: Readonly<Record<string, TaintToolClass>>;
}

/**
 * The default classification of one built-in server. Every tool the server
 * ships with is named in exactly one list (`test/taint-policy.test.ts`
 * checks this against the shipped tool annotations), so a re-annotation that
 * adds or renames tools fails the test until the new tools are classified.
 */
export interface ServerTaintProfile {
  /** Tools whose results can carry content other people wrote. */
  readonly sources: readonly string[];
  /** Tools that can deliver data to other people or act where they see it. */
  readonly sinks: readonly string[];
  /** Tools that are neither. */
  readonly neutral: readonly string[];
  /**
   * The class of a tool none of the lists names: one a newer server release
   * added (a user's own annotations can describe a newer release than the
   * package's). For servers that reach other people's content and accounts
   * it is `both`, so an unknown tool taints the session and needs a human
   * once the session is tainted.
   */
  readonly unlisted: TaintToolClass;
}

/**
 * Default classification of the built-in MCP servers.
 *
 * Sources: web fetches and searches, mail, calendar events, Drive files and
 * Docs/Sheets content and listings (anyone can share a file with you or send
 * you an invitation), every GitHub read except your own profile, and the git
 * operations that bring remote content into the workspace. An approved
 * passthrough domain and a destination admitted by policy-evaluated MITM
 * egress (Docker Agent Mode) are sources as well.
 *
 * Sinks: sending mail; calendar event changes, which notify attendees;
 * sharing changes; every change to Drive files and Docs/Sheets content
 * (collaborators of a shared file or folder see it, so a write there can
 * deliver data to them); every GitHub write; `git_push`.
 *
 * Neither: the local filesystem (the agent's workspace is not a source in
 * this slice), local git operations, mailbox organisation (labels), drafts
 * (never sent without the user), and settings or free/busy reads that carry
 * no text other people wrote.
 */
export const DEFAULT_TAINT_PROFILES: Readonly<Record<string, ServerTaintProfile>> = {
  fetch: {
    sources: ['http_fetch', 'web_search'],
    sinks: [],
    neutral: [],
    unlisted: 'both',
  },
  git: {
    sources: ['git_clone', 'git_fetch', 'git_pull'],
    sinks: ['git_push'],
    neutral: [
      'git_add',
      'git_blame',
      'git_branch',
      'git_changelog_analyze',
      'git_checkout',
      'git_cherry_pick',
      'git_clean',
      'git_clear_working_dir',
      'git_commit',
      'git_diff',
      'git_init',
      'git_log',
      'git_merge',
      'git_rebase',
      'git_reflog',
      'git_remote',
      'git_reset',
      'git_set_working_dir',
      'git_show',
      'git_stash',
      'git_status',
      'git_tag',
      'git_worktree',
      'git_wrapup_instructions',
    ],
    unlisted: 'both',
  },
  github: {
    sources: [
      'get_commit',
      'get_file_contents',
      'get_label',
      'get_latest_release',
      'get_release_by_tag',
      'get_tag',
      'get_team_members',
      'get_teams',
      'issue_read',
      'list_branches',
      'list_commits',
      'list_issue_types',
      'list_issues',
      'list_pull_requests',
      'list_releases',
      'list_tags',
      'pull_request_read',
      'search_code',
      'search_issues',
      'search_pull_requests',
      'search_repositories',
      'search_users',
    ],
    sinks: [
      'add_comment_to_pending_review',
      'add_issue_comment',
      'add_reply_to_pull_request_comment',
      'assign_copilot_to_issue',
      'create_branch',
      'create_or_update_file',
      'create_pull_request',
      'create_repository',
      'delete_file',
      'fork_repository',
      'issue_write',
      'merge_pull_request',
      'pull_request_review_write',
      'push_files',
      'request_copilot_review',
      'sub_issue_write',
      'update_pull_request',
      'update_pull_request_branch',
    ],
    neutral: ['get_me'],
    unlisted: 'both',
  },
  'google-workspace': {
    sources: [
      // Mail
      'gmail_search_messages',
      'gmail_get_message',
      'gmail_get_thread',
      'gmail_get_messages_batch',
      'gmail_get_threads_batch',
      // Calendar: invitations and shared calendars carry other people's text
      'calendar_list_events',
      'calendar_get_event',
      'calendar_events_instances',
      'calendar_calendarlist_list',
      'calendar_calendarlist_get',
      'calendar_calendars_get',
      // Drive, Docs, Sheets: files shared with you, their names and metadata
      'drive_search',
      'drive_list_files',
      'drive_list_folder_contents',
      'drive_read_file',
      'drive_export_file',
      'drive_get_metadata',
      'drive_list_permissions',
      'drive_list_revisions',
      'gdocs_read',
      'gdocs_export',
      'gdocs_get_metadata',
      'gdocs_list_documents',
      'gsheets_read',
      'gsheets_list_sheets',
    ],
    sinks: [
      // Send
      'gmail_send_message',
      // Calendar event changes notify attendees; sharing and shared metadata
      'calendar_create_event',
      'calendar_update_event',
      'calendar_delete_event',
      'calendar_events_quickadd',
      'calendar_events_move',
      'calendar_calendars_update',
      'calendar_acl_insert',
      // Drive: content, placement and sharing of files collaborators can see
      'drive_upload_file',
      'drive_create_file',
      'drive_delete_file',
      'drive_copy_file',
      'drive_move_file',
      'drive_rename_file',
      'drive_update_file',
      'drive_create_folder',
      'drive_move_to_folder',
      'drive_share_file',
      'drive_update_permission',
      'drive_remove_permission',
      'drive_empty_trash',
      // Docs
      'gdocs_create',
      'gdocs_insert_text',
      'gdocs_update_text',
      'gdocs_delete_text',
      'gdocs_replace_text',
      'gdocs_append_text',
      'gdocs_format_text',
      'gdocs_create_heading',
      'gdocs_create_list',
      'gdocs_set_alignment',
      'gdocs_apply_style',
      'gdocs_insert_image',
      'gdocs_create_table',
      'gdocs_insert_page_break',
      'gdocs_insert_link',
      'gdocs_insert_toc',
      'gdocs_batch_update',
      'gdocs_merge_documents',
      'gdocs_suggest_mode',
      // Sheets
      'gsheets_update_cell',
      'gsheets_add_sheet',
      'gsheets_delete_sheet',
      'gsheets_insert_rows',
      'gsheets_insert_columns',
      'gsheets_delete_rows',
      'gsheets_delete_columns',
      'gsheets_append_data',
      'gsheets_batch_update',
      'gsheets_clear_data',
      'gsheets_copy_sheet',
      'gsheets_copy_to',
      'gsheets_merge_cells',
      'gsheets_unmerge_cells',
      'gsheets_update_borders',
      'gsheets_format_cells',
      'gsheets_sort_range',
      'gsheets_create_spreadsheet',
      'gsheets_duplicate_sheet',
      'gsheets_rename_sheet',
      'gsheets_batch_clear',
      'gsheets_auto_resize',
      'gsheets_set_number_format',
      'gsheets_set_data_validation',
      'gsheets_add_conditional_format',
      'gsheets_create_filter',
      'gsheets_add_protected_range',
      'gsheets_delete_protected_range',
      'gsheets_update_protected_range',
      'gsheets_find_replace',
      'gsheets_add_named_range',
      'gsheets_update_named_range',
      'gsheets_delete_named_range',
      'gsheets_freeze_rows',
      'gsheets_freeze_columns',
      'gsheets_add_chart',
      'gsheets_update_chart',
      'gsheets_delete_chart',
      'gsheets_add_histogram',
      'gsheets_add_waterfall',
      'gsheets_add_candlestick',
      'gsheets_add_combo',
      'gsheets_add_bubble',
      'gsheets_add_treemap',
      'gsheets_add_org_chart',
      'gsheets_add_filter_view',
      'gsheets_add_pivot_table',
      'gsheets_add_dimension_group',
      'gsheets_delete_dimension_group',
      'gsheets_update_dimension_group',
      'gsheets_create_developer_metadata',
      'gsheets_update_developer_metadata',
      'gsheets_delete_developer_metadata',
    ],
    neutral: [
      'gmail_list_labels',
      'gmail_modify_labels',
      'gmail_batch_modify_labels',
      'gmail_manage_label',
      'gmail_draft_message',
      'calendar_freebusy_query',
      'calendar_colors_get',
      'calendar_settings_list',
      'calendar_acl_list',
      'calendar_calendars_insert',
    ],
    unlisted: 'both',
  },
  filesystem: {
    sources: [],
    sinks: [],
    neutral: [
      'read_file',
      'read_text_file',
      'read_media_file',
      'read_multiple_files',
      'write_file',
      'edit_file',
      'create_directory',
      'list_directory',
      'list_directory_with_sizes',
      'directory_tree',
      'move_file',
      'search_files',
      'get_file_info',
      'list_allowed_directories',
    ],
    unlisted: 'none',
  },
  // Virtual tools of Docker Agent Mode (docker/proxy-tools.ts). An approved
  // passthrough domain lets the container talk to that host directly, so
  // content from it can reach the agent without another MCP call.
  proxy: {
    sources: ['add_proxy_domain'],
    sinks: [],
    neutral: ['remove_proxy_domain', 'list_proxy_domains'],
    unlisted: 'none',
  },
  // The virtual server of policy-evaluated MITM egress (egress-policy.ts,
  // opt-in `egressPolicy`). A destination it admits is reachable from the
  // container without another MCP call, like an approved passthrough domain,
  // so content from it can reach the agent. A source and not a sink, like
  // `fetch/http_fetch`: the destinations stay gated by the egress rules.
  network: {
    sources: ['request'],
    sinks: [],
    neutral: [],
    unlisted: 'none',
  },
};

const ROLES: Readonly<Record<TaintToolClass, TaintRoles>> = {
  source: { source: true, sink: false },
  sink: { source: false, sink: true },
  both: { source: true, sink: true },
  none: { source: false, sink: false },
};

function isTaintToolClass(value: unknown): value is TaintToolClass {
  return typeof value === 'string' && (TAINT_TOOL_CLASSES as readonly string[]).includes(value);
}

/**
 * Resolves the taint roles of a tool: the user's per-tool override, else
 * their per-server override, else the server's default profile (a listed
 * tool, else the profile's `unlisted` class), else neither. Servers without
 * a default profile are neither unless configured.
 */
export class TaintClassifier {
  private readonly overrides = new Map<string, TaintToolClass>();
  private readonly profiles = new Map<
    string,
    { readonly tools: Map<string, TaintToolClass>; unlisted: TaintToolClass }
  >();

  /**
   * @throws {Error} for a key that is not `server/tool` or `server/*`, or a
   *   class that is not one of {@link TAINT_TOOL_CLASSES}. The user config
   *   schema rejects both already; this guards other callers.
   */
  constructor(
    overrides: Readonly<Record<string, TaintToolClass>> = {},
    profiles: Readonly<Record<string, ServerTaintProfile>> = DEFAULT_TAINT_PROFILES,
  ) {
    for (const [key, value] of Object.entries(overrides)) {
      if (!TAINT_TOOL_KEY_PATTERN.test(key)) {
        throw new Error(`Invalid taintEscalation.tools key "${key}": expected "server/tool" or "server/*"`);
      }
      if (!isTaintToolClass(value)) {
        throw new Error(
          `Invalid taintEscalation.tools class for "${key}": expected one of ${TAINT_TOOL_CLASSES.join(', ')}`,
        );
      }
      this.overrides.set(key, value);
    }
    for (const [serverName, profile] of Object.entries(profiles)) {
      const tools = new Map<string, TaintToolClass>();
      for (const tool of profile.neutral) tools.set(tool, 'none');
      for (const tool of profile.sources) tools.set(tool, 'source');
      for (const tool of profile.sinks) tools.set(tool, tools.get(tool) === 'source' ? 'both' : 'sink');
      this.profiles.set(serverName, { tools, unlisted: profile.unlisted });
    }
  }

  classify(serverName: string, toolName: string): TaintRoles {
    const override = this.overrides.get(`${serverName}/${toolName}`) ?? this.overrides.get(`${serverName}/*`);
    if (override !== undefined) return ROLES[override];
    const profile = this.profiles.get(serverName);
    if (profile === undefined) return ROLES.none;
    return ROLES[profile.tools.get(toolName) ?? profile.unlisted];
  }
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/**
 * One session's taint state. Owned by the `ToolCallCoordinator` (one per
 * session or workflow bundle), read and set by the security pipeline under
 * the coordinator's call mutex. The MITM egress gate (`decideEgress` in
 * `egress-policy.ts`) also sets it, without that mutex: marking is
 * synchronous and monotonic, and it happens before the proxy opens the
 * admitted destination, so nothing from there reaches the agent untainted.
 * Monotonic: the first taint event is kept for the life of the session.
 */
export class SessionTaint {
  private event: TaintEvent | undefined;

  constructor(
    private readonly classifier: TaintClassifier,
    restored?: TaintEvent,
  ) {
    this.event = restored;
  }

  classify(serverName: string, toolName: string): TaintRoles {
    return this.classifier.classify(serverName, toolName);
  }

  /** What first tainted the session; undefined while it is untainted. */
  get taintedBy(): TaintEvent | undefined {
    return this.event;
  }

  /** Taints the session (once; later events leave the first in place). */
  markTainted(event: TaintEvent): void {
    if (this.event !== undefined) return;
    this.event = event;
    logger.info(
      `[taint] Session tainted by ${event.via}: from now on outbound (sink) tools need a human decision for every call`,
    );
  }
}

/**
 * Builds the session's taint state, or undefined when taint escalation is
 * disabled (nothing is tracked then). Replays `auditLogPath` first, so a
 * session resumed on an existing audit log starts tainted when it was,
 * then each of `earlierAuditLogPaths`: audit logs that earlier coordinators
 * wrote for the same agent context and that this coordinator does not
 * append to (a resumed workflow run mints new bundles, each with a new
 * audit file, so the orchestrator passes the earlier bundles' logs). The
 * first taint event found wins; each path is replayed like `auditLogPath`
 * (missing: nothing to restore; unreadable: tainted).
 *
 * @throws {Error} for an invalid `options.tools` entry (see `TaintClassifier`).
 */
export function createSessionTaint(
  options: TaintEscalationOptions | undefined,
  auditLogPath: string,
  earlierAuditLogPaths: readonly string[] = [],
): SessionTaint | undefined {
  if (options?.enabled !== true) return undefined;
  const classifier = new TaintClassifier(options.tools);
  let restored: TaintEvent | undefined;
  for (const path of [auditLogPath, ...earlierAuditLogPaths]) {
    restored = restoreTaintFromAuditLog(path, classifier);
    if (restored !== undefined) {
      logger.info(`[taint] Session restored as tainted from audit log ${path} (first: ${restored.via})`);
      break;
    }
  }
  return new SessionTaint(classifier, restored);
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Rule name of an allowed sink call that taint turned into a human escalation. */
export const TAINT_ESCALATION_RULE = 'taint-escalation';

/**
 * Escalation-context key under which the human approver is shown what
 * tainted the session (the front-ends render context entries generically).
 */
export const TAINT_CONTEXT_KEY = 'Untrusted content';

/** The approver-facing description of a taint event (the {@link TAINT_CONTEXT_KEY} value). */
export function describeTaintEvent(event: TaintEvent): string {
  return `read via ${event.via} at ${event.timestamp}; outbound actions need your decision for the rest of the session`;
}

/** The outcome of {@link evaluateWithTaint}. */
export interface TaintedEvaluation {
  /** The decision the pipeline acts on. */
  readonly evaluation: EvaluationResult;
  /** Set when taint forced the decision: the sink facts for the call's audit records. */
  readonly sinkFacts?: AuditTaintFacts;
}

/** A call as taint escalation sees it. */
export interface TaintCall {
  readonly serverName: string;
  readonly toolName: string;
  /**
   * A trusted server's own per-tool policy (trusted-server-policy.ts) alone
   * decides its calls, so taint never gates it.
   */
  readonly trustedServer: boolean;
}

/**
 * What tainted the session, when the call is a sink that taint gates right
 * now: tracking is enabled, the session is tainted, the tool is a sink and
 * its server is not trusted. Undefined otherwise.
 *
 * The pipeline asks this once more after an approval wait: the call mutex
 * is released while the auto-approver decides, so another call can taint
 * the session in the meantime, and an approver's decision for a sink that
 * the taint now gates must not be acted on.
 */
export function sinkTaint(taint: SessionTaint | undefined, call: TaintCall): TaintEvent | undefined {
  if (taint === undefined || call.trustedServer) return undefined;
  const taintedBy = taint.taintedBy;
  if (taintedBy === undefined || !taint.classify(call.serverName, call.toolName).sink) return undefined;
  return taintedBy;
}

/**
 * Applies the session's taint to a policy decision. A sink call in a tainted
 * session that policy allowed becomes a human-only escalation (rule
 * {@link TAINT_ESCALATION_RULE}); one policy escalated becomes human-only
 * under its own rule. A deny, an untainted session, a call that is not a
 * sink, a trusted server (decided by its own per-tool policy) and disabled
 * tracking (`taint` undefined) leave the decision unchanged.
 *
 * The reason names what tainted the session; it carries no agent-chosen
 * text (`taintedBy.via` is a registered server and tool name).
 */
export function evaluateWithTaint(
  taint: SessionTaint | undefined,
  evaluation: EvaluationResult,
  call: TaintCall,
): TaintedEvaluation {
  if (evaluation.decision === 'deny') return { evaluation };
  const taintedBy = sinkTaint(taint, call);
  if (taintedBy === undefined) return { evaluation };

  const why = `the session has read content from an untrusted source (${taintedBy.via})`;
  const sinkFacts: AuditTaintFacts = { sink: true, taintedBy };
  if (evaluation.decision === 'allow') {
    return {
      evaluation: {
        decision: 'escalate',
        rule: TAINT_ESCALATION_RULE,
        reason:
          `Taint escalation: ${why}, so ${call.serverName}/${call.toolName} needs a human's approval ` +
          `(policy rule "${evaluation.rule}" alone would allow it)`,
        // Which roles policy would escalate is not the question here, so
        // none are named: no root is added on approval, and the approval
        // whitelist (which never sees a human-only call) has nothing to build.
        humanOnly: true,
      },
      sinkFacts,
    };
  }
  return {
    evaluation: {
      ...evaluation,
      reason: `${evaluation.reason}; ${why}, so only a human may approve it`,
      humanOnly: true,
    },
    sinkFacts,
  };
}

// ---------------------------------------------------------------------------
// Resume: replay the audit log
// ---------------------------------------------------------------------------

/** Read size for the audit replay; lines longer than this are assembled across reads. */
const REPLAY_CHUNK_BYTES = 64 * 1024;

/** Cap on a replayed string shown to the human approver (names, ids, timestamps). */
const MAX_REPLAYED_FIELD_LENGTH = 200;

/** Result statuses of records written for a call that reached (or was about to reach) its backend. */
const DISPATCHED_STATUSES: ReadonlySet<unknown> = new Set([AUDIT_STATUS_DISPATCHING, 'success', 'error']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function replayedField(value: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from replayed text
  const cleaned = value.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  return cleaned.length > MAX_REPLAYED_FIELD_LENGTH ? `${cleaned.slice(0, MAX_REPLAYED_FIELD_LENGTH)}...` : cleaned;
}

/**
 * The taint event an audit record proves, if any: a record marked as a
 * dispatched taint source (`taint.source`), or a dispatched call
 * (`dispatching`, `success` or `error`) to a tool the classifier calls a
 * source. The second case covers records written while taint escalation was
 * disabled, so enabling it on resume still sees what the session read.
 * Exported for tests.
 */
export function taintEventFromAuditRecord(record: unknown, classifier: TaintClassifier): TaintEvent | undefined {
  if (!isRecord(record)) return undefined;
  const { serverName, toolName, requestId, timestamp, result, taint } = record;
  if (typeof serverName !== 'string' || typeof toolName !== 'string') return undefined;
  const marked = isRecord(taint) && taint.source === true;
  const dispatchedSource =
    isRecord(result) && DISPATCHED_STATUSES.has(result.status) && classifier.classify(serverName, toolName).source;
  if (!marked && !dispatchedSource) return undefined;
  return {
    via: `${replayedField(serverName)}/${replayedField(toolName)}`,
    ...(typeof requestId === 'string' ? { requestId: replayedField(requestId) } : {}),
    timestamp: typeof timestamp === 'string' ? replayedField(timestamp) : 'an unknown time',
  };
}

function taintEventFromAuditLine(line: string, classifier: TaintClassifier): TaintEvent | undefined {
  if (line.trim() === '') return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    // A torn last line (the process died mid-append) proves nothing.
    return undefined;
  }
  return taintEventFromAuditRecord(record, classifier);
}

/** Streams the open audit log line by line and returns the first taint event. */
function scanAuditLog(fd: number, classifier: TaintClassifier): TaintEvent | undefined {
  const buffer = Buffer.alloc(REPLAY_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for (;;) {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    pending += decoder.write(buffer.subarray(0, bytesRead));
    let lineStart = 0;
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n', lineStart)) {
      const event = taintEventFromAuditLine(pending.slice(lineStart, newline), classifier);
      if (event !== undefined) return event;
      lineStart = newline + 1;
    }
    pending = pending.slice(lineStart);
  }
  pending += decoder.end();
  return taintEventFromAuditLine(pending, classifier);
}

function errorCode(err: unknown): string {
  const code = isRecord(err) ? err.code : undefined;
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err);
}

/** The fail-closed answer when an existing audit log cannot be replayed. */
function unreplayable(cause: string): TaintEvent {
  logger.warn(`[taint] Cannot replay the audit log (${cause}); treating the session as tainted`);
  return { via: `unreadable audit log (${replayedField(cause)})`, timestamp: new Date().toISOString() };
}

/**
 * Replays an audit log written by earlier runs of this session (a resumed
 * session appends to the same file; a resumed workflow run replays its
 * earlier bundles' files, see {@link createSessionTaint}) and returns the
 * first taint event it proves (see {@link taintEventFromAuditRecord}), or
 * undefined when it proves none. A missing file is a new session. A file
 * that exists but cannot be read to the end (permissions, not a regular
 * file, a read error) fails closed: the session starts tainted. The file is
 * read in chunks, never whole, and is opened non-blocking so a FIFO at the
 * path cannot stall start-up.
 */
export function restoreTaintFromAuditLog(auditLogPath: string, classifier: TaintClassifier): TaintEvent | undefined {
  let fd: number;
  try {
    fd = openSync(auditLogPath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined;
    return unreplayable(errorCode(err));
  }
  try {
    if (!fstatSync(fd).isFile()) return unreplayable('not a regular file');
    return scanAuditLog(fd, classifier);
  } catch (err) {
    return unreplayable(errorCode(err));
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing to recover: the descriptor is gone either way.
    }
  }
}

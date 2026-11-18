/**
 * Formatting utilities for Signal messages.
 *
 * Most functions produce plain text with Signal's styled markup
 * (**bold**, *italic*, `mono`, ~strike~), to be sent with
 * `text_mode: "styled"`. The exceptions carry agent-controlled text and are
 * meant for `text_mode: "normal"`, where nothing is interpreted as markup:
 * the escalation banner and details ({@link formatEscalationBanner},
 * {@link formatEscalationDetails}) and the session notices
 * ({@link formatSessionNoticesMessage}). The cron completion notice, which
 * quotes the agent-written run summary, is built by `formatRunNotification`
 * in `src/cron/run-summary.ts` and is sent in normal text mode too.
 */

import { formatSessionNotice, type SessionNotice } from '../session/startup-notices.js';
import type { EscalationRequest, BudgetStatus } from '../session/types.js';
import { formatTrackedTokens, NO_EXCHANGES_OBSERVED_YET, partialTokensNote } from '../session/usage-display.js';
import { formatCostAgainstLimit, formatCostSummary, formatCostUsd } from '../session/cost-display.js';
import { describeCronExpression, formatFailureStreak, formatRelativeTime } from '../cron/format-utils.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { displayedUserMessage } from '../escalation/escalation-review.js';
import { MEMORY_SERVER_NAME } from '../memory/memory-server-name.js';

/** Maximum length for a single Signal message. */
export const SIGNAL_MAX_MESSAGE_LENGTH = 2000;

// --- Escalation banners ---
//
// An escalation reaches the user as two parts: a short header (session,
// code, tool, reason and the reply instructions), then the arguments. The
// header is small and fixed in shape, so the instructions always arrive
// first and never depend on how much the agent put into the arguments.
//
// Everything agent-controlled is display-escaped (toDisplayText: controls,
// C1 such as U+0085, bidi and other format characters, U+2028/U+2029 become
// visible escapes), argument values are JSON-quoted, and the messages are
// sent in normal text mode, so a backtick, `*`, `~` or `||` in a value is
// shown as typed and cannot open or close any styling.
//
// Values that say what a call acts on (paths, URLs, remotes, commands,
// recipients, and the server context) are never cut: the decisive part can
// sit anywhere in them. Other values are cut to a short head with the
// omitted byte count, and `details <code>` (or `/show <code>`) shows more.
// When the values that must be shown in full do not fit, the banner says so
// and the escalation cannot be approved over Signal (it can still be denied).
// Every memory_forget selector and memory_ingest argument requires full review,
// including query text, tags and content that are not resource locators.
//
// When the proxy offers a whitelist pattern (the escalation's first, exact
// whitelist candidate, which is what `approve+` selects), the header shows
// it in full and offers `approve+ <code>`; a pattern too long to show in full
// is not offered, so `approve+` never whitelists more than the user read.
//
// Reviewer context (trusted-process/escalation-context.ts). The session's
// task and the human's last message are the human's own text: the header
// shows them, labelled, above the tool (left out when they would push the
// header past one message; every other header part is bounded, so the header
// without them, whitelist pattern included, always fits one message). The
// agent's justification is attacker-controlled, so it never enters the
// header, where it would sit above the reply instructions: it is the banner's
// last message, its "untrusted" label and the escaped, bounded text on one
// line that always fits one message, so the text never arrives without its
// label.

/** Longest cut-able value shown in a banner, in code points before escaping. */
const BANNER_VALUE_CHARS = 200;
/** Space for all cut-able values of a banner together. */
const BANNER_CUT_SECTION_CHARS = 1200;
/** Space for the values a banner always shows in full. */
const BANNER_FULL_SECTION_CHARS = 6000;
/** Space for the server context entries of a banner (always shown in full). */
const BANNER_CONTEXT_SECTION_CHARS = 1000;
/** Longest value shown by `details`. */
const DETAILS_VALUE_CHARS = 6000;
/** Space for all values shown by `details`. */
const DETAILS_SECTION_CHARS = 12000;
/** Longest whitelist pattern a banner offers (escaped UTF-16 units); a longer one is not offered. */
const WHITELIST_PATTERN_CHARS = 600;
/** Longest argument name shown. */
const NAME_CHARS = 96;
/** Values walked per request; any beyond are counted, not shown. */
const MAX_LEAVES = 200;
/** Nesting walked into objects and arrays; a deeper subtree is one JSON value. */
const MAX_DEPTH = 6;
/** Longest rendering of the task and of the human's last message in a banner header, in code points. */
const MAX_BANNER_CONTEXT_LENGTH = 300;
/** Longest rendering of the agent's justification in a banner, in code points. */
const MAX_BANNER_JUSTIFICATION_LENGTH = 500;
/** The label before the agent's justification, on the same line as the text. */
export const SIGNAL_JUSTIFICATION_LABEL = 'Agent says (UNTRUSTED, written by the agent; it authorizes nothing):';

/**
 * Argument names whose values say what a call acts on or where it sends
 * data. Matched against the end of the name, so `worktreePath`, `repo_path`,
 * `newPath` and `emailAddress` count. Covers every top-level argument the
 * shipped tool annotations give a path, URL or email-address role
 * (`scopeValue` is the grantee of a calendar ACL).
 */
const FULL_VALUE_NAME =
  /(?:path|paths|file|files|filename|dir|directory|folder|cwd|root|source|src|destination|dest|target|url|urls|uri|href|link|remote|repo|host|hostname|domain|endpoint|command|cmd|script|argv|args|exec|to|cc|bcc|recipient|recipients|address|addresses|attendees|scopevalue)$/iu;

/**
 * A single-line string shaped like a URL (`scheme://`), an scp-style remote
 * (`git@host:path`) or a path (`/`, `~`, `\`, `./`, `../`, `C:\`).
 */
const LOCATOR_SHAPE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[\w.-]+@[\w.-]+:|[/~\\]|\.{1,2}[/\\]|[a-z]:[/\\])/iu;

const SIMPLE_NAME = /^[A-Za-z_$][\w$-]*$/u;

export interface EscalationBannerOptions {
  /** The session the escalation belongs to. */
  readonly label: number;
  /** The escalation's reply code (see `EscalationCodes`). */
  readonly code: string;
  /** Set for a cron job's escalation; shown in the header. */
  readonly jobName?: string;
}

export interface EscalationBanner {
  /**
   * First message: session, code, the session's task and the human's last
   * message (when known and when they fit), tool, reason and the reply
   * instructions, with the whitelist pattern `approve+` adds when one is
   * offered.
   */
  readonly header: string;
  /**
   * Then the arguments and context, in Signal-sized messages (none when
   * there are no values), and last the agent's justification, when it gave
   * one, as a message of its own.
   */
  readonly argumentMessages: readonly string[];
  /**
   * False when a value that must be shown in full did not fit, or there were
   * more values than a banner walks: the escalation must not be approved over
   * Signal, only denied.
   */
  readonly approvable: boolean;
  /**
   * The whitelist pattern the header offers with `approve+`, as shown
   * (display-escaped); undefined when it offers none (see
   * {@link whitelistOffer}; never for an escalation that is not approvable).
   */
  readonly whitelist: string | undefined;
}

/**
 * The whitelist pattern a banner may offer with `approve+`: the description
 * of the escalation's first whitelist candidate (the one `approve+` selects),
 * display-escaped. Undefined for a human-only escalation, without a
 * candidate, or when the description is too long to show in full in a
 * banner header.
 */
export function whitelistOffer(request: EscalationRequest): string | undefined {
  if (request.humanOnly === true) return undefined;
  const candidates: unknown = request.whitelistCandidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const first: unknown = candidates[0];
  const description = isPlainRecord(first) ? first.description : undefined;
  if (typeof description !== 'string' || description.trim() === '') return undefined;
  const shown = toDisplayText(description);
  return shown.length <= WHITELIST_PATTERN_CHARS ? shown : undefined;
}

/** One value of a request, flattened out of nested objects and arrays. */
interface ArgumentLeaf {
  /** Display name, e.g. `files[0].path`. */
  readonly name: string;
  readonly value: unknown;
  /** Never cut: a locator name or a locator-shaped string. */
  readonly full: boolean;
}

interface CollectedLeaves {
  readonly leaves: readonly ArgumentLeaf[];
  /** Values beyond {@link MAX_LEAVES}, not walked and not shown. */
  readonly unwalked: number;
}

interface NamedValue {
  readonly name: string;
  readonly value: unknown;
}

interface RenderedSection {
  readonly lines: readonly string[];
  /** Values left out because the section was full. */
  readonly hidden: number;
  /** UTF-8 size of the values left out. */
  readonly hiddenBytes: number;
  /** Whether any shown value was cut. */
  readonly cut: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeLocator(value: unknown): boolean {
  return typeof value === 'string' && !/[\r\n]/u.test(value) && LOCATOR_SHAPE.test(value);
}

/** JSON text of a value, or a placeholder when it has none. */
function jsonText(value: unknown): string {
  try {
    // JSON.stringify returns undefined for undefined, functions and symbols.
    const json = JSON.stringify(value) as unknown;
    return typeof json === 'string' ? json : String(value);
  } catch {
    return '[unserializable value]';
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : jsonText(value), 'utf8');
}

function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString('en-US')} bytes`;
}

/** The first `count` code points of `text` (a code point is at most two UTF-16 units). */
function firstCodePoints(text: string, count: number): string {
  if (text.length <= count) return text;
  return Array.from(text.slice(0, count * 2))
    .slice(0, count)
    .join('');
}

function propertyName(key: string): string {
  return SIMPLE_NAME.test(key) ? key : JSON.stringify(key);
}

function propertySuffix(key: string): string {
  return SIMPLE_NAME.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/**
 * Flattens the arguments into named values, in order, up to
 * {@link MAX_LEAVES}. Arguments that are not an object (a malformed request)
 * are shown as one value named `arguments`.
 */
function collectLeaves(args: unknown, requireFullReview = false): CollectedLeaves {
  const leaves: ArgumentLeaf[] = [];
  let unwalked = 0;
  const visit = (value: unknown, name: string, ruleName: string, depth: number): void => {
    if (leaves.length >= MAX_LEAVES) {
      unwalked += 1;
      return;
    }
    if (depth < MAX_DEPTH && Array.isArray(value) && value.length > 0) {
      value.forEach((item: unknown, index) => visit(item, `${name}[${index}]`, ruleName, depth + 1));
      return;
    }
    if (depth < MAX_DEPTH && isPlainRecord(value) && Object.keys(value).length > 0) {
      for (const [key, item] of Object.entries(value)) visit(item, `${name}${propertySuffix(key)}`, key, depth + 1);
      return;
    }
    leaves.push({
      name: toDisplayText(name, requireFullReview ? {} : { maxLength: NAME_CHARS }),
      value,
      full: requireFullReview || FULL_VALUE_NAME.test(ruleName) || looksLikeLocator(value),
    });
  };
  if (isPlainRecord(args)) {
    for (const [key, value] of Object.entries(args)) visit(value, propertyName(key), key, 0);
  } else {
    visit(args, 'arguments', 'arguments', MAX_DEPTH);
  }
  return { leaves, unwalked };
}

/**
 * A value as shown: strings JSON-quoted, anything else as JSON, cut to
 * `limit` code points when given (a missing closing quote and an ellipsis
 * mark the cut), then display-escaped.
 */
function renderValue(value: unknown, limit: number | undefined): { text: string; omittedBytes: number } {
  const isString = typeof value === 'string';
  const source = isString ? value : jsonText(value);
  const kept = limit === undefined ? source : firstCodePoints(source, limit);
  const cut = kept.length < source.length;
  let shown: string;
  if (isString) shown = cut ? `${JSON.stringify(kept).slice(0, -1)}\u2026` : JSON.stringify(kept);
  else shown = cut ? `${kept}\u2026` : kept;
  return {
    text: toDisplayText(shown),
    omittedBytes: cut ? Buffer.byteLength(source, 'utf8') - Buffer.byteLength(kept, 'utf8') : 0,
  };
}

/**
 * Renders `name: value` lines into a section of at most `budget` characters.
 * Once a line does not fit, it and every later value are left out and only
 * counted, so the shown values keep their order. With no `valueLimit` a
 * value is shown whole or not at all.
 */
function renderSection(items: readonly NamedValue[], valueLimit: number | undefined, budget: number): RenderedSection {
  const lines: string[] = [];
  let used = 0;
  let hidden = 0;
  let hiddenBytes = 0;
  let cut = false;
  for (const item of items) {
    if (hidden === 0) {
      // A whole value longer than the room left cannot fit (rendering only
      // adds characters), so it is rendered no further than that to find out.
      const rendered = renderValue(item.value, valueLimit ?? Math.max(0, budget - used) + 1);
      const note = rendered.omittedBytes > 0 ? ` (+${formatBytes(rendered.omittedBytes)} not shown)` : '';
      const line = `${item.name}: ${rendered.text}${note}`;
      if (used + line.length <= budget) {
        lines.push(line);
        used += line.length + 1;
        if (rendered.omittedBytes > 0) cut = true;
        continue;
      }
    }
    hidden += 1;
    hiddenBytes += byteLength(item.value);
  }
  return { lines, hidden, hiddenBytes, cut };
}

function hiddenLine(count: number, bytes: number): string {
  return `(+${count} more ${count === 1 ? 'value' : 'values'}, ${formatBytes(bytes)}, not shown)`;
}

/**
 * Splits `text` after at most `room` UTF-16 units, never inside a surrogate
 * pair (lone surrogates were escaped by toDisplayText already).
 */
function splitAt(text: string, room: number): [string, string] {
  let end = Math.min(room, text.length);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return [text.slice(0, end), text.slice(end)];
}

/**
 * Packs lines into messages of at most {@link SIGNAL_MAX_MESSAGE_LENGTH}
 * characters; every message after the first starts with `continuation` on
 * its own line. A line goes to the next message when it would fit there
 * whole; a line longer than a message flows on from one message into the
 * next, so no line break is added inside a value.
 */
function packLines(lines: readonly string[], continuation: string): string[] {
  const max = SIGNAL_MAX_MESSAGE_LENGTH;
  const fresh = `${continuation}\n`;
  const messages: string[] = [];
  let current = '';
  for (const line of lines) {
    let rest = line;
    let separator = current === '' || current === fresh ? '' : '\n';
    while (rest !== '') {
      if (current.length + separator.length + rest.length <= max) {
        current += separator + rest;
        break;
      }
      if (rest.length <= max - fresh.length || current.length + separator.length >= max - 1) {
        messages.push(current);
      } else {
        const [head, tail] = splitAt(rest, max - current.length - separator.length);
        messages.push(current + separator + head);
        rest = tail;
      }
      current = fresh;
      separator = '';
    }
  }
  if (current !== '' && current !== fresh) messages.push(current);
  return messages;
}

function toolLabel(serverName: string, toolName: string): string {
  return `${toDisplayText(serverName, { maxLength: 64 })}/${toDisplayText(toolName, { maxLength: 64 })}`;
}

function toolText(request: EscalationRequest): string {
  return toolLabel(request.serverName, request.toolName);
}

function contextItems(request: EscalationRequest): NamedValue[] {
  return Object.entries(request.context ?? {}).map(([key, value]) => ({
    name: toDisplayText(key, { maxLength: NAME_CHARS }),
    value,
  }));
}

/**
 * The Signal banner for an escalation: a header message with the session,
 * the reply code, the human's context, the tool, the reason and the reply
 * instructions, then the arguments, then the agent's untrusted justification
 * (see the section comment above). Meant for `text_mode: "normal"`.
 */
export function formatEscalationBanner(request: EscalationRequest, options: EscalationBannerOptions): EscalationBanner {
  const { label, code } = options;
  // These calls deliberately require a person to judge the full content or
  // deletion criteria; a locator-only preview cannot authorize them.
  const fullMemoryReview =
    request.serverName === MEMORY_SERVER_NAME &&
    (request.toolName === 'memory_forget' || request.toolName === 'memory_ingest');
  const { leaves, unwalked } = collectLeaves(request.arguments, fullMemoryReview);
  const fullItems = leaves.filter((leaf) => leaf.full);
  const cutItems = leaves.filter((leaf) => !leaf.full);
  const context = contextItems(request);

  let fullSection = renderSection(fullItems, undefined, BANNER_FULL_SECTION_CHARS);
  let contextSection = renderSection(context, undefined, BANNER_CONTEXT_SECTION_CHARS);
  const approvable = fullSection.hidden === 0 && contextSection.hidden === 0 && unwalked === 0;
  if (fullSection.hidden > 0) fullSection = renderSection(fullItems, BANNER_VALUE_CHARS, BANNER_FULL_SECTION_CHARS);
  if (contextSection.hidden > 0) {
    contextSection = renderSection(context, BANNER_VALUE_CHARS, BANNER_CONTEXT_SECTION_CHARS);
  }
  const cutSection = renderSection(cutItems, BANNER_VALUE_CHARS, BANNER_CUT_SECTION_CHARS);

  const valueCount = leaves.length + unwalked;
  const lines: string[] = [];
  if (valueCount > 0 || context.length > 0) {
    lines.push(`[#${label}] ${code} arguments (${valueCount}):`);
    if (valueCount === 0) lines.push('(none)');
    lines.push(...fullSection.lines);
    if (fullSection.hidden > 0) lines.push(hiddenLine(fullSection.hidden, fullSection.hiddenBytes));
    lines.push(...cutSection.lines);
    if (cutSection.hidden > 0) lines.push(hiddenLine(cutSection.hidden, cutSection.hiddenBytes));
    if (unwalked > 0) lines.push(`(+${unwalked} more values not shown)`);
    if (context.length > 0) {
      lines.push('Context:', ...contextSection.lines);
      if (contextSection.hidden > 0) lines.push(hiddenLine(contextSection.hidden, contextSection.hiddenBytes));
    }
    const incomplete =
      fullSection.cut ||
      fullSection.hidden > 0 ||
      cutSection.cut ||
      cutSection.hidden > 0 ||
      contextSection.cut ||
      contextSection.hidden > 0 ||
      unwalked > 0;
    if (incomplete) lines.push(`Some values were cut or left out. Reply "details ${code}" to see more.`);
    if (!approvable) {
      lines.push(`Values that must be shown in full did not fit, so ${code} cannot be approved over Signal.`);
    }
  }

  const separator = '\u2501'.repeat(30); // box drawing heavy horizontal
  const origin = options.jobName !== undefined ? ` cron: ${toDisplayText(options.jobName, { maxLength: 60 })}` : '';
  let argumentsLine = `Arguments: ${valueCount} ${valueCount === 1 ? 'value' : 'values'}, in the next message`;
  if (valueCount === 0) {
    argumentsLine = context.length === 0 ? 'Arguments: none' : 'Arguments: none (context in the next message)';
  }
  const whitelist = approvable ? whitelistOffer(request) : undefined;
  const instructions = approvable
    ? [
        `Reply "approve ${code}" or "deny ${code}"`,
        ...(whitelist !== undefined
          ? [`or "approve+ ${code}" to approve and whitelist, for this session:`, whitelist]
          : []),
      ]
    : [
        'Some values are too long to show in full here,',
        'so this escalation cannot be approved over Signal.',
        `Reply "deny ${code}" to deny it now; otherwise it is denied when it times out.`,
      ];
  const headerWith = (reviewerLines: readonly string[]): string =>
    [
      separator,
      `ESCALATION [#${label}${origin}] code ${code}`,
      'Human approval required',
      separator,
      ...reviewerLines,
      `Tool: ${toolText(request)}`,
      `Reason: ${toDisplayText(request.reason, { maxLength: 300 })}`,
      argumentsLine,
      separator,
      ...instructions,
      separator,
    ].join('\n');
  // The header is one message: the human's context is left out rather than
  // splitting it (only text in rare scripts, near every bound, gets there).
  const withContext = headerWith(trustedContextLines(request));
  const header = withContext.length <= SIGNAL_MAX_MESSAGE_LENGTH ? withContext : headerWith([]);

  const justification = justificationMessage(request, label, code);
  return {
    header,
    argumentMessages: [
      ...(lines.length > 0 ? packLines(lines, `[#${label}] ${code} arguments (continued):`) : []),
      ...(justification !== undefined ? [justification] : []),
    ],
    approvable,
    whitelist,
  };
}

/** What the banner offered, repeated by {@link formatEscalationDetails}. */
export interface EscalationDetailsOptions extends EscalationBannerOptions {
  /** {@link EscalationBanner.approvable}; default true. */
  readonly approvable?: boolean;
  /** {@link EscalationBanner.whitelist}. */
  readonly whitelist?: string;
}

/**
 * The reply to `details <code>` / `/show <code>`: the tool, the reason and
 * every value at up to {@link DETAILS_VALUE_CHARS} code points, at most
 * {@link DETAILS_SECTION_CHARS} in all, display-escaped and JSON-quoted as
 * in the banner, then the whitelist pattern `approve+` would add and the
 * reply instructions. Meant for `text_mode: "normal"`.
 */
export function formatEscalationDetails(request: EscalationRequest, options: EscalationDetailsOptions): string[] {
  const { label, code } = options;
  const fullMemoryReview =
    request.serverName === MEMORY_SERVER_NAME &&
    (request.toolName === 'memory_forget' || request.toolName === 'memory_ingest');
  const { leaves, unwalked } = collectLeaves(request.arguments, fullMemoryReview);
  const ordered = [...leaves.filter((leaf) => leaf.full), ...leaves.filter((leaf) => !leaf.full)];
  const section = renderSection(ordered, DETAILS_VALUE_CHARS, DETAILS_SECTION_CHARS);
  const context = renderSection(contextItems(request), DETAILS_VALUE_CHARS, DETAILS_SECTION_CHARS);

  const lines = [
    `[#${label}] Details for ${code}: ${toolText(request)}`,
    `Reason: ${toDisplayText(request.reason, { maxLength: 2000 })}`,
    ordered.length + unwalked === 0 ? 'Arguments: none' : 'Arguments:',
    ...section.lines,
  ];
  if (section.hidden > 0) lines.push(hiddenLine(section.hidden, section.hiddenBytes));
  if (unwalked > 0) lines.push(`(+${unwalked} more values not shown)`);
  if (context.lines.length > 0 || context.hidden > 0) {
    lines.push('Context:', ...context.lines);
    if (context.hidden > 0) lines.push(hiddenLine(context.hidden, context.hiddenBytes));
  }
  if (options.approvable === false) {
    lines.push(`This escalation cannot be approved over Signal. Reply "deny ${code}" to deny it.`);
  } else if (options.whitelist !== undefined) {
    lines.push(`"approve+ ${code}" whitelists, for this session: ${options.whitelist}`);
    lines.push(`Reply "approve ${code}", "approve+ ${code}" or "deny ${code}"`);
  } else {
    lines.push(`Reply "approve ${code}" or "deny ${code}"`);
  }
  return packLines(lines, `[#${label}] ${code} details (continued):`);
}

/** The session's task and the human's last message, labelled as the human's own (trusted) text. */
function trustedContextLines(request: EscalationRequest): string[] {
  const lines: string[] = [];
  const userMessage = displayedUserMessage(request);
  if (request.taskSummary !== undefined) {
    lines.push(`Task: ${toDisplayText(request.taskSummary, { maxLength: MAX_BANNER_CONTEXT_LENGTH })}`);
  }
  if (userMessage !== undefined) {
    lines.push(`You said: ${toDisplayText(userMessage.text, { maxLength: MAX_BANNER_CONTEXT_LENGTH })}`);
  }
  return lines;
}

/**
 * The banner's last message when the agent gave a justification: the
 * session and code, the "untrusted" label and the escaped, bounded text, all
 * on one line. It is far shorter than a Signal message, so it is never split
 * and the text never arrives without its label (see the section comment).
 */
function justificationMessage(request: EscalationRequest, label: number, code: string): string | undefined {
  if (request.agentJustification === undefined) return undefined;
  const text = toDisplayText(request.agentJustification, { maxLength: MAX_BANNER_JUSTIFICATION_LENGTH });
  return `[#${label}] ${code} ${SIGNAL_JUSTIFICATION_LABEL} ${text}`;
}

/** One escalation in the `/pending` list. */
export interface PendingEscalationSummary {
  readonly label: number;
  readonly code: string;
  readonly serverName: string;
  readonly toolName: string;
  /** Set for a cron job's escalation. */
  readonly jobName?: string;
  /** Host time (ms since the epoch) at which the escalation was raised. */
  readonly raisedAt: number;
  /** Its banner is still being delivered (approvals wait for it). */
  readonly delivering: boolean;
  /** It can only be denied over Signal. */
  readonly denyOnly: boolean;
  /** Its banner offers `approve+`. */
  readonly whitelist: boolean;
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `raised ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `raised ${minutes} min ago`;
  return `raised ${Math.floor(minutes / 60)} h ago`;
}

/**
 * The `/pending` reply: one line per escalation whose banner went out over
 * Signal, with its session, code and tool, lowest session label first, and a
 * count of the escalations pending in other clients (the web UI), which are
 * decided there. Tool and job names are display-escaped; meant for
 * `text_mode: "normal"`.
 */
export function formatPendingEscalations(
  entries: readonly PendingEscalationSummary[],
  options: { readonly now?: number; readonly elsewhere?: number } = {},
): string {
  const now = options.now ?? Date.now();
  const elsewhere = options.elsewhere ?? 0;
  const elsewhereLine =
    elsewhere > 0
      ? `${elsewhere} more ${elsewhere === 1 ? 'escalation is' : 'escalations are'} pending in another client (such as the web UI) and must be decided there.`
      : undefined;
  if (entries.length === 0) {
    return elsewhereLine === undefined
      ? 'No escalation is pending.'
      : `No escalation is pending here. ${elsewhereLine}`;
  }
  const sorted = [...entries].sort((a, b) => a.label - b.label || a.raisedAt - b.raisedAt);
  const lines = [`Pending escalations (${entries.length}):`];
  for (const entry of sorted) {
    const origin = entry.jobName !== undefined ? ` cron: ${toDisplayText(entry.jobName, { maxLength: 60 })}` : '';
    const notes = [
      formatAge(now - entry.raisedAt),
      ...(entry.delivering ? ['banner still being delivered'] : []),
      ...(entry.denyOnly ? ['deny only'] : []),
      ...(entry.whitelist ? ['approve+ offered'] : []),
    ];
    lines.push(
      `[#${entry.label}${origin}] ${entry.code} ${toolLabel(entry.serverName, entry.toolName)} (${notes.join(', ')})`,
    );
  }
  lines.push('Send "/show <code>" to see an escalation in full, then reply "approve <code>" or "deny <code>".');
  if (elsewhereLine !== undefined) lines.push(elsewhereLine);
  return lines.join('\n');
}

/**
 * Formats budget status for the /budget command.
 * Shows current turn consumption and session totals.
 */
export function formatBudgetMessage(status: BudgetStatus): string {
  const { limits, cumulative } = status;
  const lines: string[] = ['**Current turn budget:**'];

  // A partial (lower-bound) total is marked, never shown as exact.
  const turnTokens = formatTrackedTokens(status.totalTokens, status);
  if (turnTokens === undefined) {
    lines.push('  Tokens: N/A');
  } else if (turnTokens === NO_EXCHANGES_OBSERVED_YET) {
    lines.push(`  Tokens: ${turnTokens}`);
  } else {
    lines.push(
      formatBudgetLine('Tokens', status.totalTokens, limits.maxTotalTokens, (v) => v.toLocaleString(), turnTokens),
    );
  }
  lines.push(formatBudgetLine('Steps', status.stepCount, limits.maxSteps, String));
  lines.push(formatBudgetLine('Time', status.elapsedSeconds, limits.maxSessionSeconds, (v) => `${Math.round(v)}s`));
  lines.push(
    `  Est. cost: ${formatCostAgainstLimit(status.estimatedCostUsd, status.costSource, limits.maxEstimatedCostUsd)}`,
  );

  lines.push('');
  lines.push('**Session totals:**');
  const sessionTokens = formatTrackedTokens(cumulative.totalTokens, status);
  lines.push(`  Tokens: ${sessionTokens ?? 'N/A'}${partialTokensNote(status)}`);
  lines.push(`  Steps: ${cumulative.stepCount}`);
  lines.push(`  Active time: ${Math.round(cumulative.activeSeconds)}s`);
  lines.push(`  Est. cost: ${formatCostUsd(cumulative.estimatedCostUsd, status.costSource)}`);

  return lines.join('\n');
}

/**
 * Formats a compact budget summary for session end messages.
 */
export function formatBudgetSummary(status: BudgetStatus): string {
  const { cumulative } = status;
  const tokens = formatTrackedTokens(cumulative.totalTokens, status);
  const tokensPart =
    tokens === undefined
      ? ''
      : tokens === NO_EXCHANGES_OBSERVED_YET
        ? `${tokens}, `
        : `${tokens} tokens${partialTokensNote(status)}, `;
  return (
    `Session: ${tokensPart}` +
    `${cumulative.stepCount} steps` +
    `, ${Math.round(cumulative.activeSeconds)}s` +
    `, ${formatCostSummary(cumulative.estimatedCostUsd, status.costSource)}`
  );
}

/**
 * Splits a message into chunks respecting the max length.
 * Prefers splitting at double-newlines (paragraph breaks),
 * then single newlines, then at the hard limit.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to find a paragraph break within the limit
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIdx <= 0) {
      // Fall back to line break
      splitIdx = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIdx <= 0) {
      // Hard split at max length
      splitIdx = maxLength;
    }

    chunks.push(remaining.substring(0, splitIdx).trimEnd());
    remaining = remaining.substring(splitIdx).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Token use against the per-turn token limit, as shown by /sessions: the
 * turn in progress while the session is processing, otherwise the last
 * completed turn. Limits are per turn, so session totals are not comparable
 * with them, and the in-progress counters read zero between turns.
 * Returns 0 when no token limit is configured.
 */
export function turnTokenBudgetPercent(status: BudgetStatus, turnInProgress: boolean): number {
  const limit = status.limits.maxTotalTokens;
  if (!limit) return 0;
  const tokens = turnInProgress ? status.totalTokens : (status.lastTurn?.totalTokens ?? 0);
  return Math.round((tokens / limit) * 100);
}

/**
 * Information about a managed session for display purposes.
 */
export interface SessionListEntry {
  readonly label: number;
  readonly turnCount: number;
  readonly budgetPercent: number;
}

/**
 * Formats the /sessions command output.
 * Marks the current session with `>`.
 */
export function formatSessionList(sessions: SessionListEntry[], currentLabel: number | null): string {
  if (sessions.length === 0) return 'No active sessions.';

  const lines = ['**Active sessions:**'];
  for (const s of sessions) {
    const marker = s.label === currentLabel ? '>' : ' ';
    lines.push(`${marker} #${s.label}  turns: ${s.turnCount}  budget: ${s.budgetPercent}%`);
  }
  return lines.join('\n');
}

/**
 * Prefixes a message with `[#N]` when multiple sessions are active.
 */
export function prefixWithLabel(text: string, label: number, sessionCount: number): string {
  if (sessionCount <= 1) return text;
  return `[#${label}] ${text}`;
}

// --- Session notices ---

/**
 * A session's notices (a stale policy, an MCP server that did not start,
 * setuid or root-owned files the agent left in its host mounts, ...) as one
 * message: the terminal rendering of each (`formatSessionNotice`, display
 * text throughout) with its first line flush left. Server-provided text and
 * agent-chosen paths are in it, so it is meant for `text_mode: "normal"`.
 */
export function formatSessionNoticesMessage(label: number, notices: readonly SessionNotice[]): string {
  const body = notices.map((notice) => formatSessionNotice(notice).replace(/^ {2}/gmu, '')).join('\n');
  return `[#${label}] Session notice${notices.length === 1 ? '' : 's'}:\n${body}`;
}

// --- Job list formatting ---

/**
 * Information about a scheduled job for display in Signal.
 * Dates are ISO strings (serialized by the control socket).
 */
export interface JobListEntry {
  readonly job: {
    readonly id: string;
    readonly name: string;
    readonly schedule: string;
    readonly enabled: boolean;
  };
  readonly nextRun: string | null;
  readonly lastRun:
    | {
        readonly outcome: { readonly kind: string; readonly message?: string; readonly dimension?: string };
        readonly startedAt: string;
      }
    | undefined;
  readonly isRunning: boolean;
  /** Runs in a row that ended in an error (absent from older daemons). */
  readonly consecutiveFailures?: number;
}

/**
 * Formats the /jobs command output.
 * Shows each job with schedule, status, next run, and last run outcome.
 */
export function formatJobList(jobs: JobListEntry[]): string {
  if (jobs.length === 0) return 'No scheduled jobs.';

  const lines = ['**Scheduled jobs:**'];
  for (const entry of jobs) {
    lines.push('');
    lines.push(formatJobEntry(entry));
  }
  return lines.join('\n');
}

function formatJobEntry(entry: JobListEntry): string {
  const { job, nextRun, lastRun, isRunning } = entry;
  const lines: string[] = [];

  // Header: name + status tags
  const tags: string[] = [];
  if (isRunning) tags.push('[RUNNING]');
  if (!job.enabled) tags.push('[DISABLED]');
  const tagSuffix = tags.length > 0 ? ' ' + tags.join(' ') : '';
  lines.push(`**${job.name}** (\`${job.id}\`)${tagSuffix}`);

  // Schedule
  const scheduleDesc = describeCronExpression(job.schedule);
  lines.push(`  Schedule: ${scheduleDesc}`);

  // Next run
  if (nextRun) {
    lines.push(`  Next run: ${formatRelativeTime(new Date(nextRun))}`);
  } else if (!job.enabled) {
    lines.push('  Next run: disabled');
  } else {
    lines.push('  Next run: --');
  }

  // Last run
  if (lastRun) {
    const outcomeStr = formatRunOutcome(lastRun.outcome);
    const timeStr = formatRelativeTime(new Date(lastRun.startedAt));
    lines.push(`  Last run: ${outcomeStr}, ${timeStr}`);
  }
  if (entry.consecutiveFailures !== undefined && entry.consecutiveFailures > 0) {
    lines.push(`  Failing: ${formatFailureStreak(entry.consecutiveFailures)}`);
  }

  return lines.join('\n');
}

function formatRunOutcome(outcome: { kind: string; message?: string; dimension?: string }): string {
  switch (outcome.kind) {
    case 'success':
      return 'success';
    case 'budget_exhausted':
      return `budget exhausted (${outcome.dimension ?? 'unknown'})`;
    case 'error':
      return `error: ${outcome.message ?? 'unknown'}`;
    default:
      return outcome.kind;
  }
}

// --- Private helpers ---

function formatBudgetLine(
  label: string,
  current: number,
  limit: number | null,
  format: (v: number) => string,
  currentText: string = format(current),
): string {
  const currentStr = currentText;
  if (limit === null) return `  ${label}: ${currentStr} (no limit)`;
  const pct = limit > 0 ? Math.round((current / limit) * 100) : 0;
  return `  ${label}: ${currentStr} / ${format(limit)} (${pct}%)`;
}

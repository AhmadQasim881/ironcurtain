/**
 * Host-side access to an agent's conversation-state directory.
 *
 * The directory (`<bundleDir>/claude-state` for Claude Code,
 * `<bundleDir>/codex-state` for Codex, `<bundleDir>/goose-state` for Goose)
 * is bind-mounted read-write into the agent container (`~/.claude/`,
 * `~/.codex/`, `~/.local/share/goose/sessions/`), where the agent runs an
 * unmediated shell with the host user's UID. Every entry inside it is
 * agent-controlled and can be swapped at any moment: a name can become an
 * absolute, relative or dangling symlink, a FIFO, a hard link, a directory or
 * a symlink loop. The directory itself is host-owned (its parent, the session
 * or bundle directory, is never mounted), so it is a safe anchor for the
 * final-component no-follow primitives in `../hardened-fs.ts`.
 *
 * The host's per-session accesses to this directory live here:
 *
 * - {@link syncConversationStateClaudeMd} replaces `CLAUDE.md` atomically
 *   (exclusive temporary file, then rename, which replaces a planted link or
 *   FIFO instead of writing through it) or removes it with `unlink`, which
 *   never follows a link.
 * - {@link hasStoredConversation}, {@link hasCodexRollout},
 *   {@link findLatestCodexThread} and {@link hasStoredTranscript} are bounded
 *   probes of the transcripts themselves (see `ConversationTranscriptLayout`).
 *   They walk a fixed number of levels, never follow a symlink they find,
 *   only `lstat` the entries they keep, and never open a file, so a planted
 *   loop, FIFO or `projects -> /` cannot stall or crash the host process.
 *
 * Next to the state directory, in the host-only bundle directory, the batch
 * session keeps one small record per agent conversation
 * ({@link recordStoredConversation}): which Codex thread continues it, or that
 * a Goose session of that name exists. The agent cannot reach that directory.
 *
 * The batch session (`docker-agent-session.ts`, through
 * {@link findStoredConversation}), the batch factory (`src/session/index.ts`)
 * and PTY mode (`pty-session.ts`, through {@link buildPtyConversationEnv} and
 * {@link hasStoredTranscript}) all call these helpers so the two session
 * modes stay in sync. Any other host access must follow the same rules:
 * never follow a link, never open a non-regular entry, and bound every read.
 * (`prepareConversationStateDir` only creates the directory and `unlink`s
 * stale credential files.)
 */

import { lstatSync, opendirSync, unlinkSync, type Dir, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { ensureRealDirectoryNoFollow, readUntrustedRegularFile, writeFileNoFollowAtomic } from '../hardened-fs.js';
import type { AgentId, ConversationStateConfig, ConversationTranscriptLayout } from './agent-adapter.js';

/** File Claude Code reads from `~/.claude/` as user-level instructions. */
export const CLAUDE_MD_FILE_NAME = 'CLAUDE.md';

/** The only adapter that reads `~/.claude/CLAUDE.md`. */
const CLAUDE_CODE_AGENT_ID = 'claude-code';

/**
 * Mode of the seeded CLAUDE.md. The content is static, non-secret text, and
 * 0644 is what the former plain `writeFileSync` produced under the default
 * umask, so the in-container reader keeps the access it had under every UID
 * mapping. The parent directory is 0700 in any case.
 */
const CLAUDE_MD_MODE = 0o644;

/** Claude Code keeps transcripts at `projects/<cwd-hash>/<conversation-id>.jsonl`. */
const PROJECTS_DIR_NAME = 'projects';
const TRANSCRIPT_SUFFIX = '.jsonl';

/**
 * Most `projects/` entries the transcript probe reads. Claude Code creates
 * one entry per working directory (IronCurtain always runs it in
 * `/workspace`), so real directories hold a handful; the cap only bounds the
 * work an agent can force by filling the directory.
 */
export const MAX_TRANSCRIPT_PROBE_ENTRIES = 10_000;

export interface SyncConversationStateClaudeMdOptions {
  /** Host-side conversation-state directory: absolute, and the read-write mount source. */
  readonly conversationStateDir: string;
  /** Adapter whose state directory this is. Only Claude Code reads `~/.claude/CLAUDE.md`. */
  readonly adapterId: AgentId;
  /** Desired CLAUDE.md content. `undefined` or empty means the file must not exist. */
  readonly content: string | undefined;
}

/**
 * Make `<conversationStateDir>/CLAUDE.md` match `content` without writing
 * through, opening or blocking on whatever the agent left at that name.
 *
 * - Claude Code with content: {@link writeFileNoFollowAtomic} writes a fresh
 *   exclusive temporary file and renames it over the name. The rename replaces
 *   a planted symlink (absolute, relative or dangling), FIFO or hard link; its
 *   target is never touched. A directory at the name throws an
 *   `UntrustedFileError` (`NOT_REGULAR_FILE`) and is left intact, which fails
 *   session start (fail closed).
 * - Otherwise (memory off, or an adapter that does not read CLAUDE.md, such as
 *   Codex): best-effort `unlink`, which removes the entry itself and never
 *   follows a link, so stale rules from an earlier session cannot linger.
 *
 * Callers run this on every session start, including resume and every
 * workflow state on a borrowed bundle, because persona and memory settings
 * can change between them while the agent keeps write access to the directory.
 */
export function syncConversationStateClaudeMd(options: SyncConversationStateClaudeMdOptions): void {
  const { conversationStateDir, adapterId, content } = options;
  if (content && adapterId === CLAUDE_CODE_AGENT_ID) {
    writeFileNoFollowAtomic(conversationStateDir, CLAUDE_MD_FILE_NAME, content, CLAUDE_MD_MODE);
    return;
  }
  try {
    unlinkSync(join(conversationStateDir, CLAUDE_MD_FILE_NAME));
  } catch {
    // Not present, or a directory the agent planted: nothing of ours to remove.
  }
}

export interface TranscriptProbeOptions {
  /** Most `projects/` entries to read (default {@link MAX_TRANSCRIPT_PROBE_ENTRIES}). */
  readonly maxEntries?: number;
}

/**
 * Returns true when the conversation-state directory already holds an
 * agent-CLI transcript for `agentConversationId`, at exactly
 * `projects/<cwd-hash>/<agentConversationId>.jsonl` (Claude Code's layout).
 * `prepareConversationStateDir()` seeds an empty `projects/` on fresh
 * sessions.
 *
 * Keyed on `agentConversationId`, not the IronCurtain session id: under
 * shared-container workflow mode one bundle's state directory accumulates one
 * `.jsonl` per state invocation, named by that state's conversation id, and
 * every DockerAgentSession gets a fresh session id, so matching on the session
 * id would miss a reused conversation (`freshSession: false` re-entry). See
 * §8.5 in docs/designs/workflow-session-identity.md.
 *
 * The directory is agent-writable, so the probe is two levels deep and never
 * follows a symlink it finds there:
 *
 * 1. `lstat(projects)` must be a real directory. A symlink (`projects -> /`)
 *    or any other type means no stored conversation; `existsSync` or `stat`
 *    would follow the link.
 * 2. One non-recursive pass over `projects/` with `opendir`, reading at most
 *    `maxEntries` entries (the cap bounds the directory reads themselves, not
 *    just the matching) and keeping only entries whose dirent is a directory.
 *    A non-recursive dirent reports a symlink as a symlink (Node falls back to
 *    `lstat` on `DT_UNKNOWN`), so a link to a directory, or a loop such as
 *    `a/l1 -> ..`, is skipped rather than entered.
 * 3. For each kept entry, `lstat(<entry>/<id>.jsonl)` must be a regular file.
 *    `lstat` never opens the entry, so a planted FIFO cannot block the probe.
 *
 * The work is at most `maxEntries` directory entries and as many `lstat`
 * calls, whatever the agent plants. Any error, an id that is not a single path
 * component, or reaching the cap means "no stored conversation". That is safe:
 * the answer only switches the next turn between `--session-id <id>` and
 * `--resume <id>`, and the agent already controls this directory's contents.
 *
 * The checks are path-based (Node has no `openat`), and on a borrowed workflow
 * bundle the agent's background processes keep running while the next state
 * starts. A swap that races the probe can therefore still route `opendir` or a
 * per-entry `lstat` through a link planted after the type check. That only
 * changes which directory the single bounded pass reads, or the answer: the
 * walk never recurses, never exceeds the cap, and never opens anything but a
 * directory (`opendir` uses `O_DIRECTORY`). Do not extend it to read or write
 * files below `projects/` by path: the intermediate components are
 * agent-controlled, and the `../hardened-fs.ts` helpers only protect the final
 * component.
 *
 * This is the `'claude-projects'` layout. Other CLIs keep their transcripts
 * elsewhere; {@link findStoredConversation} picks the probe for a layout.
 */
export function hasStoredConversation(
  stateDir: string,
  agentConversationId: string,
  options: TranscriptProbeOptions = {},
): boolean {
  if (!isSinglePathComponent(agentConversationId)) return false;
  const maxEntries = options.maxEntries ?? MAX_TRANSCRIPT_PROBE_ENTRIES;
  const transcriptName = `${agentConversationId}${TRANSCRIPT_SUFFIX}`;
  const projectsDir = join(stateDir, PROJECTS_DIR_NAME);
  let dir: Dir | undefined;
  try {
    if (!lstatSync(projectsDir, { throwIfNoEntry: false })?.isDirectory()) return false;
    dir = opendirSync(projectsDir);
    for (let read = 0; read < maxEntries; read++) {
      const entry = dir.readSync();
      if (entry === null) return false;
      if (!entry.isDirectory()) continue;
      const transcript = lstatSync(join(projectsDir, entry.name, transcriptName), { throwIfNoEntry: false });
      if (transcript?.isFile()) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    closeDirQuietly(dir);
  }
}

// ── Identifiers ──────────────────────────────────────────────────────

const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The canonical (lowercase) form of a Codex thread id, or `undefined` when
 * `value` is not a hyphenated UUID. Codex prints thread ids in this form and
 * names its rollout files with it. A thread id travels from agent-controlled
 * output into a host record and back into `codex ... resume <id>` argv, so
 * nothing else (an option such as `--last`, a path, an empty string) is ever
 * accepted.
 */
export function normalizeCodexThreadId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  return CODEX_THREAD_ID_PATTERN.test(lower) ? lower : undefined;
}

const CONVERSATION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Whether `name` may name a conversation on an agent CLI command line (Goose
 * `--name`) and in the host record store: one path component of 1-128
 * characters from `[A-Za-z0-9._-]` that starts with a letter or digit, so it
 * is never read as an option or a hidden or relative path. IronCurtain's
 * conversation and session ids are UUIDs.
 */
export function isConversationName(name: string): boolean {
  return CONVERSATION_NAME_PATTERN.test(name);
}

// ── Transcript probes ────────────────────────────────────────────────

/** Remaining directory entries a bounded walk may still read. */
interface EntryBudget {
  remaining: number;
}

/**
 * One bounded, non-recursive pass over `dirPath`: true at the first entry
 * `accept` takes, false at the end of the directory or when the shared
 * `budget` runs out. Errors propagate to the caller.
 */
function directoryHasEntry(dirPath: string, budget: EntryBudget, accept: (entry: Dirent) => boolean): boolean {
  const dir = opendirSync(dirPath);
  try {
    for (;;) {
      if (budget.remaining <= 0) return false;
      budget.remaining--;
      const entry = dir.readSync();
      if (entry === null) return false;
      if (accept(entry)) return true;
    }
  } finally {
    closeDirQuietly(dir);
  }
}

/** `lstat` only: a regular file with content. Never opens the entry, so a FIFO cannot block. */
function isNonEmptyRegularFile(path: string): boolean {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  return stats !== undefined && stats.isFile() && stats.size > 0;
}

/** Claude Code: any non-empty `projects/<cwd-hash>/*.jsonl`. Two levels, links never entered. */
function hasAnyClaudeTranscript(stateDir: string, maxEntries: number): boolean {
  const projectsDir = join(stateDir, PROJECTS_DIR_NAME);
  if (!lstatSync(projectsDir, { throwIfNoEntry: false })?.isDirectory()) return false;
  const budget: EntryBudget = { remaining: maxEntries };
  return directoryHasEntry(projectsDir, budget, (project) => {
    if (!project.isDirectory()) return false;
    const projectDir = join(projectsDir, project.name);
    return directoryHasEntry(
      projectDir,
      budget,
      (entry) =>
        entry.isFile() &&
        entry.name.length > TRANSCRIPT_SUFFIX.length &&
        entry.name.endsWith(TRANSCRIPT_SUFFIX) &&
        isNonEmptyRegularFile(join(projectDir, entry.name)),
    );
  });
}

/** Codex's rollout tree: `sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<thread-id>.jsonl`. */
const CODEX_SESSIONS_DIR_NAME = 'sessions';
const CODEX_DATE_DIR_PATTERNS: readonly RegExp[] = [/^\d{4}$/u, /^\d{2}$/u, /^\d{2}$/u];
const CODEX_ROLLOUT_PATTERN = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u;

interface CodexRollout {
  readonly threadId: string;
  readonly path: string;
  readonly name: string;
}

/** How a bounded walk ended: read everything, stopped by the visitor, or out of entry budget. */
type WalkOutcome = 'complete' | 'stopped' | 'capped';

/**
 * Visit each rollout file below `sessions/YYYY/MM/DD/`. Only real directories
 * with the date-shaped name of their level are entered, and only regular files
 * with the rollout name are visited (a non-recursive dirent reports a symlink
 * as a symlink), so a planted link or loop is skipped, never followed. At most
 * `maxEntries` directory entries are read over the whole walk. `visit` returns
 * true to stop. Errors propagate to the caller.
 */
function walkCodexRollouts(
  stateDir: string,
  maxEntries: number,
  visit: (rollout: CodexRollout) => boolean,
): WalkOutcome {
  const sessionsDir = join(stateDir, CODEX_SESSIONS_DIR_NAME);
  if (!lstatSync(sessionsDir, { throwIfNoEntry: false })?.isDirectory()) return 'complete';
  return walkCodexRolloutLevel(sessionsDir, 0, { remaining: maxEntries }, visit);
}

function walkCodexRolloutLevel(
  dirPath: string,
  depth: number,
  budget: EntryBudget,
  visit: (rollout: CodexRollout) => boolean,
): WalkOutcome {
  const dir = opendirSync(dirPath);
  try {
    for (;;) {
      if (budget.remaining <= 0) return 'capped';
      budget.remaining--;
      const entry = dir.readSync();
      if (entry === null) return 'complete';
      const entryPath = join(dirPath, entry.name);
      if (depth < CODEX_DATE_DIR_PATTERNS.length) {
        if (!entry.isDirectory() || !CODEX_DATE_DIR_PATTERNS[depth].test(entry.name)) continue;
        const outcome = walkCodexRolloutLevel(entryPath, depth + 1, budget, visit);
        if (outcome !== 'complete') return outcome;
        continue;
      }
      if (!entry.isFile()) continue;
      const match = CODEX_ROLLOUT_PATTERN.exec(entry.name);
      if (match === null) continue;
      if (visit({ threadId: match[1], path: entryPath, name: entry.name })) return 'stopped';
    }
  } finally {
    closeDirQuietly(dir);
  }
}

/**
 * Whether Codex holds a rollout for `threadId`
 * (`sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`, a non-empty regular
 * file, like every other transcript probe). This decides whether a batch turn
 * may run `codex exec resume <threadId>`; any error, a malformed id, an empty
 * rollout (nothing Codex could resume) or reaching the entry cap means no, and
 * the turn starts a new thread with the full prompt instead.
 */
export function hasCodexRollout(stateDir: string, threadId: string, options: TranscriptProbeOptions = {}): boolean {
  const wanted = normalizeCodexThreadId(threadId);
  if (wanted === undefined) return false;
  try {
    return (
      walkCodexRollouts(stateDir, options.maxEntries ?? MAX_TRANSCRIPT_PROBE_ENTRIES, (rollout) => {
        return rollout.threadId === wanted && isNonEmptyRegularFile(rollout.path);
      }) === 'stopped'
    );
  } catch {
    return false;
  }
}

/**
 * The thread id of the non-empty Codex rollout modified most recently: the
 * conversation a PTY resume continues (`codex resume <id>`). A PTY session
 * owns its state directory, but the user can start several threads in one
 * terminal; the last one active is the one to continue. `undefined` when there
 * is none, on any error, or when the walk reaches the entry cap (an agent that
 * floods the tree gets a fresh conversation, never an arbitrary one).
 *
 * Each candidate is `lstat`ed for its type, size and mtime; nothing is opened.
 */
export function findLatestCodexThread(stateDir: string, options: TranscriptProbeOptions = {}): string | undefined {
  let latest: { readonly threadId: string; readonly mtimeMs: number; readonly name: string } | undefined;
  try {
    const outcome = walkCodexRollouts(stateDir, options.maxEntries ?? MAX_TRANSCRIPT_PROBE_ENTRIES, (rollout) => {
      const stats = lstatSync(rollout.path, { throwIfNoEntry: false });
      if (stats === undefined || !stats.isFile() || stats.size === 0) return false;
      const newer =
        latest === undefined ||
        stats.mtimeMs > latest.mtimeMs ||
        (stats.mtimeMs === latest.mtimeMs && rollout.name > latest.name);
      if (newer) latest = { threadId: rollout.threadId, mtimeMs: stats.mtimeMs, name: rollout.name };
      return false;
    });
    if (outcome !== 'complete') return undefined;
  } catch {
    return undefined;
  }
  return latest?.threadId;
}

/** Goose's SQLite session store; releases before it kept one `<session>.jsonl` per session here. */
const GOOSE_SESSIONS_DB_NAME = 'sessions.db';

/** Goose: a non-empty session store in the mounted `sessions/` directory. */
function hasAnyGooseSession(stateDir: string, maxEntries: number): boolean {
  if (!lstatSync(stateDir, { throwIfNoEntry: false })?.isDirectory()) return false;
  if (isNonEmptyRegularFile(join(stateDir, GOOSE_SESSIONS_DB_NAME))) return true;
  return directoryHasEntry(
    stateDir,
    { remaining: maxEntries },
    (entry) =>
      entry.isFile() &&
      entry.name.length > TRANSCRIPT_SUFFIX.length &&
      entry.name.endsWith(TRANSCRIPT_SUFFIX) &&
      isNonEmptyRegularFile(join(stateDir, entry.name)),
  );
}

/**
 * Whether the state directory holds at least one real transcript of the
 * layout: a non-empty Claude Code `projects/<cwd-hash>/*.jsonl`, a non-empty
 * Codex `sessions/YYYY/MM/DD/rollout-*.jsonl`, or a non-empty Goose session
 * store. This decides whether an ended PTY session is resumable. The seeds
 * (`projects/`, `sessions/`, `logs/`) and settings files make every state
 * directory non-empty, so "anything there" would mark sessions that never
 * held a conversation as resumable.
 *
 * Bounded like the other probes (at most `maxEntries` directory entries over
 * the whole walk, links never entered, nothing opened). Any error or reaching
 * the cap means no transcript.
 */
export function hasStoredTranscript(
  stateDir: string,
  layout: ConversationTranscriptLayout,
  options: TranscriptProbeOptions = {},
): boolean {
  const maxEntries = options.maxEntries ?? MAX_TRANSCRIPT_PROBE_ENTRIES;
  try {
    switch (layout) {
      case 'claude-projects':
        return hasAnyClaudeTranscript(stateDir, maxEntries);
      case 'codex-rollouts':
        return walkCodexRollouts(stateDir, maxEntries, (rollout) => isNonEmptyRegularFile(rollout.path)) === 'stopped';
      case 'goose-sessions':
        return hasAnyGooseSession(stateDir, maxEntries);
    }
  } catch {
    return false;
  }
}

// ── Conversation records (host-only) ─────────────────────────────────

/**
 * Host-only directory, in the bundle directory beside the state directory,
 * holding one record per agent conversation. The bundle directory is never
 * mounted into the container, so the agent cannot plant or edit records.
 */
export const CONVERSATION_RECORDS_DIR_NAME = 'agent-conversations';
const CONVERSATION_RECORD_SUFFIX = '.json';
const MAX_CONVERSATION_RECORD_BYTES = 1024;
const CONVERSATION_RECORD_MODE = 0o600;
const CONVERSATION_RECORDS_DIR_MODE = 0o700;

interface ConversationRecord {
  /** Codex: the thread that continues this conversation. */
  readonly threadId?: string;
}

/**
 * Bounded, no-follow read of the record for `agentConversationId`. Anything
 * missing, oversized, malformed or with an invalid thread id reads as no
 * record, which only means the next turn starts the conversation afresh.
 */
function readConversationRecord(recordRoot: string, agentConversationId: string): ConversationRecord | undefined {
  if (!isConversationName(agentConversationId)) return undefined;
  const path = join(recordRoot, CONVERSATION_RECORDS_DIR_NAME, `${agentConversationId}${CONVERSATION_RECORD_SUFFIX}`);
  let parsed: unknown;
  try {
    const { bytes } = readUntrustedRegularFile(path, { maxBytes: MAX_CONVERSATION_RECORD_BYTES });
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const rawThreadId = (parsed as { readonly threadId?: unknown }).threadId;
  if (rawThreadId === undefined) return {};
  const threadId = normalizeCodexThreadId(rawThreadId);
  return threadId === undefined ? undefined : { threadId };
}

export interface RecordStoredConversationInput {
  readonly layout: ConversationTranscriptLayout;
  /** Host-only directory the records live under: the bundle directory, never a mount source. */
  readonly recordRoot: string;
  readonly agentConversationId: string;
  /** The CLI-minted thread the turn reported (`AgentResponse.agentThreadId`). */
  readonly threadId?: string;
}

/**
 * Record that the CLI now holds `agentConversationId`, after a turn in which
 * it materialized the conversation, so a later session that continues the
 * same conversation (a workflow state re-entered with `freshSession: false`,
 * or `ironcurtain start --resume`) resumes it instead of starting over:
 *
 * - `'codex-rollouts'`: the record names the thread (`codex exec resume
 *   <thread>`). Nothing is written without a valid thread id.
 * - `'goose-sessions'`: the record's presence says the named Goose session
 *   exists (`goose run --name <id> --resume`); Goose cannot be asked about one
 *   session without reading its SQLite store, which the host never opens.
 * - `'claude-projects'`: no record; the transcript is named by our id and
 *   probed directly ({@link hasStoredConversation}).
 *
 * Written atomically (exclusive temporary file, then rename) with mode 0600.
 * Returns whether a record was written; throws on I/O errors, which callers
 * log: the in-memory session still continues the conversation.
 */
export function recordStoredConversation(input: RecordStoredConversationInput): boolean {
  if (input.layout === 'claude-projects') return false;
  if (!isConversationName(input.agentConversationId)) return false;
  let record: ConversationRecord = {};
  if (input.layout === 'codex-rollouts') {
    const threadId = normalizeCodexThreadId(input.threadId);
    if (threadId === undefined) return false;
    record = { threadId };
  }
  const { path: recordsDir } = ensureRealDirectoryNoFollow(
    input.recordRoot,
    CONVERSATION_RECORDS_DIR_NAME,
    CONVERSATION_RECORDS_DIR_MODE,
  );
  writeFileNoFollowAtomic(
    recordsDir,
    `${input.agentConversationId}${CONVERSATION_RECORD_SUFFIX}`,
    `${JSON.stringify(record)}\n`,
    CONVERSATION_RECORD_MODE,
  );
  return true;
}

export interface StoredConversationProbe {
  /** Host-side conversation-state directory (the agent's read-write mount). */
  readonly stateDir: string;
  readonly layout: ConversationTranscriptLayout;
  /** Host-only directory holding the conversation records (the bundle directory). */
  readonly recordRoot: string;
  readonly agentConversationId: string;
  /** Entry cap for the transcript probe (default {@link MAX_TRANSCRIPT_PROBE_ENTRIES}). */
  readonly maxEntries?: number;
}

export interface StoredConversation {
  /** The CLI already holds this conversation, so the next turn continues it rather than starting it. */
  readonly stored: boolean;
  /** Codex: the thread the next turn resumes. Present only when `stored`. */
  readonly threadId?: string;
}

/**
 * Decide, for a batch session about to run its first turn, whether the agent
 * CLI already holds `agentConversationId`:
 *
 * - `'claude-projects'`: the exact transcript `projects/<hash>/<id>.jsonl`.
 * - `'codex-rollouts'`: a host record naming a thread, and that thread's
 *   rollout. Never Codex's "most recent session": workflow states that share
 *   a container share `~/.codex`, so only the recorded thread is ours.
 * - `'goose-sessions'`: a host record, and a non-empty Goose session store.
 *
 * Every negative answer only makes the turn start a fresh conversation.
 */
export function findStoredConversation(probe: StoredConversationProbe): StoredConversation {
  const options: TranscriptProbeOptions = probe.maxEntries === undefined ? {} : { maxEntries: probe.maxEntries };
  switch (probe.layout) {
    case 'claude-projects':
      return { stored: hasStoredConversation(probe.stateDir, probe.agentConversationId, options) };
    case 'codex-rollouts': {
      const threadId = readConversationRecord(probe.recordRoot, probe.agentConversationId)?.threadId;
      if (threadId === undefined || !hasCodexRollout(probe.stateDir, threadId, options)) return { stored: false };
      return { stored: true, threadId };
    }
    case 'goose-sessions': {
      const record = readConversationRecord(probe.recordRoot, probe.agentConversationId);
      return { stored: record !== undefined && hasStoredTranscript(probe.stateDir, 'goose-sessions', options) };
    }
  }
}

// ── PTY start-script environment ─────────────────────────────────────

/** Names the Goose session a PTY start script creates or resumes (`--name`). */
export const PTY_SESSION_NAME_ENV = 'IRONCURTAIN_SESSION_NAME';
/** The adapter's resume flags, expanded unquoted by the start scripts. */
export const PTY_RESUME_FLAGS_ENV = 'IRONCURTAIN_RESUME_FLAGS';
/** The Codex thread a PTY resume continues (`codex resume <id>`). */
export const PTY_RESUME_ID_ENV = 'IRONCURTAIN_RESUME_ID';

/** The start scripts expand the flags unquoted, so each must be a plain long option. */
const SAFE_RESUME_FLAG = /^--[a-z0-9-]+$/u;

export interface PtyConversationEnvInput {
  readonly stateDir: string;
  readonly stateConfig: ConversationStateConfig;
  /** The IronCurtain session id, stable across PTY resumes of the same session. */
  readonly sessionId: string;
  /** True when this PTY start resumes an earlier run of the session. */
  readonly resume: boolean;
}

/**
 * Container environment telling the adapter's PTY start script which
 * conversation to start or continue:
 *
 * - Goose (`'goose-sessions'`), always: {@link PTY_SESSION_NAME_ENV} = the
 *   IronCurtain session id, so a fresh start creates the named session and a
 *   resume finds it.
 * - On resume: {@link PTY_RESUME_FLAGS_ENV} = the adapter's validated resume
 *   flags (Claude Code `--continue`, Goose `--resume`), and for Codex
 *   (`'codex-rollouts'`) {@link PTY_RESUME_ID_ENV} = the thread of the most
 *   recently active rollout ({@link findLatestCodexThread}), never `--last`.
 *   No rollout means no resume variables: the script starts a new thread.
 *
 * Throws on a resume flag outside `--[a-z0-9-]+` or a session id that is not
 * a {@link isConversationName}, both host-side misconfigurations.
 */
export function buildPtyConversationEnv(input: PtyConversationEnvInput): Record<string, string> {
  const { stateConfig } = input;
  const env: Record<string, string> = {};
  if (stateConfig.transcriptLayout === 'goose-sessions') {
    if (!isConversationName(input.sessionId)) {
      throw new Error(`Invalid session name for a named agent session: ${JSON.stringify(input.sessionId)}`);
    }
    env[PTY_SESSION_NAME_ENV] = input.sessionId;
  }
  if (!input.resume) return env;
  for (const flag of stateConfig.resumeFlags) {
    if (!SAFE_RESUME_FLAG.test(flag)) throw new Error(`Invalid resume flag: ${flag}`);
  }
  if (stateConfig.resumeFlags.length > 0) env[PTY_RESUME_FLAGS_ENV] = stateConfig.resumeFlags.join(' ');
  if (stateConfig.transcriptLayout === 'codex-rollouts') {
    const threadId = findLatestCodexThread(input.stateDir);
    if (threadId !== undefined) env[PTY_RESUME_ID_ENV] = threadId;
  }
  return env;
}

function isSinglePathComponent(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/u.test(name);
}

function closeDirQuietly(dir: Dir | undefined): void {
  try {
    dir?.closeSync();
  } catch {
    // Already closed; nothing to release.
  }
}

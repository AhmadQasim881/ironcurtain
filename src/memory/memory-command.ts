/**
 * `ironcurtain memory <persona|job> <command>`: review and curate a persona's
 * or a cron job's persistent memory from the host; and `ironcurtain memory
 * prefetch`, the memory server's models.
 *
 *   list / search / show / stats   read the store (every memory: those waiting
 *                                  for review, decayed and compacted ones too)
 *   forget                         delete memories (after a database snapshot)
 *   export / import                the whole store as JSONL, page by page
 *   review [approve | reject]      memories unattended runs (cron jobs,
 *                                  workflows) wrote wait here until approved;
 *                                  interactive sessions do not see them before
 *
 * The store is read through the memory server package's admin API
 * (`@provos/memory-mcp-server/admin`), never through a running memory server:
 * nothing here starts maintenance (consolidation, decay, compaction) or calls
 * an LLM, and a database is never created, migrated or rebuilt by a read.
 * Everything a store holds was written by agents, so every string shown on the
 * terminal goes through the display sanitizer, and `--json` / export output
 * through the terminal-safe JSON escapes.
 *
 *   prefetch                       download the pinned embedding and re-ranking
 *                                  models into ~/.ironcurtain/models and verify
 *                                  them
 *
 * Memory sessions download missing models on first use anyway; prefetching
 * does it ahead of time, which a machine that will run with
 * `memory.offlineModels` (no downloads at all) needs, and it replaces a model
 * file that fails verification. `ironcurtain doctor` reports the store's
 * state without downloading anything. In the place of a persona or job,
 * `prefetch` always names that command: a persona or job named "prefetch" is
 * addressed as `persona:prefetch` or `job:prefetch`.
 */

import { createReadStream, existsSync, openSync, closeSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatHelp, type CommandSpec } from '../cli-help.js';
import { getJobDir } from '../config/paths.js';
import { loadUserConfig } from '../config/user-config.js';
import { getPersonaDir, loadPersona } from '../persona/resolve.js';
import { createPersonaName } from '../persona/types.js';
import { loadJob } from '../cron/job-store.js';
import { createJobId } from '../cron/types.js';
import { toDisplayText, toTerminalSafeJson, toTerminalSafeJsonText } from '../terminal/display-sanitize.js';
import { resolveMemoryDbPath, resolveMemoryModelsDir } from './resolve-memory-path.js';
import { runMemoryModelsTool, type MemoryModelEntry, type MemoryModelsRunner } from './memory-models.js';

// ---------------------------------------------------------------------------
// The admin API (the memory server package's `./admin` export)
// ---------------------------------------------------------------------------

/** A memory writer, as the memory server records it. */
export interface AdminMemoryWriter {
  kind: string;
  session_id?: string;
  scope?: string;
}

/** One memory, as the admin API reports it. */
export interface AdminMemory {
  id: string;
  content: string;
  tags: string[];
  importance: number;
  status: 'active' | 'decayed' | 'compacted';
  created_at: number;
  updated_at: number;
  last_accessed_at: number;
  access_count: number;
  consolidated: boolean;
  source: string | null;
  segment_id: string | null;
  writer: AdminMemoryWriter | null;
  pending_review: string | null;
  reviewed_at: number | null;
}

export interface AdminMemoryDetail extends AdminMemory {
  review_digest: string;
  metadata: Record<string, unknown> | null;
  segment: {
    id: string;
    content: string;
    source: string | null;
    mode: string | null;
    created_at: number;
    fact_count: number;
  } | null;
}

export interface AdminStats {
  namespace: string;
  total: number;
  active: number;
  decayed: number;
  compacted: number;
  pending_review: number;
  pending_by_scope: Array<{ scope: string; count: number }>;
  unconsolidated: number;
  segments: number;
  oldest: number | null;
  newest: number | null;
  storage_bytes: number;
  top_tags: Array<{ tag: string; count: number }>;
}

export interface AdminImportOutcome {
  memories: number;
  segments: number;
  skipped_existing: number;
  unlinked_segments: number;
  embedded: number;
  redacted_secrets: number;
}

export interface MemoryStoreReader {
  stats(): AdminStats;
  list(options?: { limit?: number; offset?: number; pendingOnly?: boolean }): AdminMemory[];
  search(text: string, options?: { limit?: number }): AdminMemory[];
  get(id: string): AdminMemoryDetail | undefined;
  exportLines(): Generator<string, void, undefined>;
  close(): void;
}

export interface MemoryStoreWriter extends MemoryStoreReader {
  forget(ids: readonly string[]): { forgotten: number; missing: string[]; snapshot: string | null };
  approve(receipts: readonly { id: string; digest: string }[]): {
    approved: number;
    missing: string[];
    notPending: string[];
    changed: string[];
  };
  importLines(
    lines: AsyncIterable<string> | Iterable<string>,
    options?: { modelStore?: { modelsDir: string; offline: boolean } },
  ): Promise<AdminImportOutcome>;
}

/** The part of `@provos/memory-mcp-server/admin` this command uses. */
export interface MemoryAdminModule {
  openMemoryStoreReader(options: { dbPath: string; namespace: string }): MemoryStoreReader;
  openMemoryStoreWriter(options: { dbPath: string; namespace: string; create?: boolean }): MemoryStoreWriter;
  isMemoryId(value: string): boolean;
}

/**
 * The package export the admin API is loaded from. Held in a `string` so the
 * import stays a runtime lookup: it resolves the installed memory server
 * package, like the memory server entry point does (memory-annotations.ts).
 */
const MEMORY_ADMIN_MODULE: string = '@provos/memory-mcp-server/admin';

async function loadMemoryAdmin(): Promise<MemoryAdminModule> {
  try {
    return (await import(MEMORY_ADMIN_MODULE)) as MemoryAdminModule;
  } catch (err) {
    throw new MemoryCommandError(
      `Could not load the memory admin API (${MEMORY_ADMIN_MODULE}): ${err instanceof Error ? err.message : String(err)}. ` +
        'The installed @provos/memory-mcp-server may be older than this IronCurtain; rebuild or reinstall it.',
    );
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const memoryCommandSpec: CommandSpec = {
  name: 'ironcurtain memory',
  description: "Review and curate a persona's or a cron job's persistent memory, and the memory server's models",
  usage: [
    'ironcurtain memory <persona|job> list [--pending] [--limit <n>] [--offset <n>] [--json]',
    'ironcurtain memory <persona|job> search <text> [--limit <n>] [--json]',
    'ironcurtain memory <persona|job> show <id> [--json]',
    'ironcurtain memory <persona|job> forget <id>...',
    'ironcurtain memory <persona|job> export [--output <file>]',
    'ironcurtain memory <persona|job> import <file>',
    'ironcurtain memory <persona|job> stats [--json]',
    'ironcurtain memory <persona|job> review [approve <id>@<digest>... | reject <id>...]',
    'ironcurtain memory prefetch',
  ],
  subcommands: [
    { name: 'list', description: 'Memories, newest first (waiting for review, decayed and compacted ones too)' },
    { name: 'search <text>', description: 'Memories whose text, tags or source contain <text> (no model needed)' },
    { name: 'show <id>', description: 'One memory: who wrote it, its review state, history and source passage' },
    { name: 'forget <id>...', description: 'Delete memories (a snapshot of the database is saved first)' },
    { name: 'export', description: 'Every memory and source passage as JSONL, with vectors (stdout by default)' },
    { name: 'import <file>', description: 'Load an export into this persona or job (existing ids are kept)' },
    { name: 'stats', description: 'Counts, memories waiting for review, storage size, top tags' },
    {
      name: 'review',
      description: 'Memories unattended runs wrote; interactive sessions see them only once approved',
    },
    {
      name: 'prefetch',
      description: 'Download the pinned memory models into ~/.ironcurtain/models and verify them',
    },
  ],
  options: [
    { flag: 'pending', description: 'list: only memories waiting for review' },
    { flag: 'limit', placeholder: '<n>', description: 'list, search, review: at most n memories (default 50)' },
    { flag: 'offset', placeholder: '<n>', description: 'list: skip the n newest' },
    { flag: 'output', placeholder: '<file>', description: 'export: write to a new file (mode 0600) instead of stdout' },
    { flag: 'all', description: 'review approve: refused; pass the receipts displayed by review or show' },
    { flag: 'scope', placeholder: '<scope>', description: 'review approve: refused; pass explicit review receipts' },
    { flag: 'json', description: 'Print machine-readable JSON' },
    { flag: 'help', short: 'h', description: 'Show this help' },
  ],
  examples: [
    'ironcurtain memory alice list',
    'ironcurtain memory alice review',
    'ironcurtain memory alice review approve <id>@<digest>',
    'ironcurtain memory job:daily-report forget 3f2a9c...',
    'ironcurtain memory alice export --output alice-memory.jsonl',
    'ironcurtain memory prefetch',
  ],
};

// ---------------------------------------------------------------------------
// Errors and dependencies
// ---------------------------------------------------------------------------

/** Exit status for a usage error (bad flags or arguments), as other subcommands use. */
const EXIT_USAGE = 2;

/** A bad command line: printed with the usage, exit 2. */
class MemoryUsageError extends Error {
  readonly code = 'MEMORY_USAGE';
}

/** A command that cannot be carried out (unknown target, missing database): exit 1. */
class MemoryCommandError extends Error {
  readonly code = 'MEMORY_COMMAND';
}

export interface MemoryCommandDependencies {
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
  /** Loads the admin API; tests pass the package source. */
  readonly loadAdmin?: () => Promise<MemoryAdminModule>;
  /** Runs the memory server's model tool (`prefetch`); tests pass a fake. */
  readonly run?: MemoryModelsRunner;
}

type Deps = Required<MemoryCommandDependencies>;

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/** Whose memory a command works on. */
interface MemoryTarget {
  readonly kind: 'persona' | 'job';
  readonly name: string;
  /** The persona's or job's directory (it must exist to import). */
  readonly dir: string;
  readonly dbPath: string;
  /**
   * The memory namespace the sessions of this persona or job use: the name,
   * or a renamed persona's `memoryNamespace` (see {@link withSessionNamespace}).
   */
  readonly namespace: string;
}

function personaTarget(name: string): MemoryTarget {
  const persona = createPersonaName(name);
  return {
    kind: 'persona',
    name: persona,
    dir: getPersonaDir(persona),
    dbPath: resolveMemoryDbPath({ persona }),
    namespace: persona,
  };
}

function jobTarget(name: string): MemoryTarget {
  const jobId = createJobId(name);
  return { kind: 'job', name: jobId, dir: getJobDir(jobId), dbPath: resolveMemoryDbPath({ jobId }), namespace: jobId };
}

/**
 * The target with the namespace its sessions use. A renamed persona's
 * sessions keep the namespace its memories were stored under (persona.json
 * `memoryNamespace`, written by `persona rename` and a trash restore under
 * another name), so its memories are listed, reviewed, curated and imported
 * there, not under its new name where its sessions would never see them. A
 * persona without persona.json uses its name; one whose persona.json cannot
 * be used is refused, since the namespace it names is unknown.
 */
function withSessionNamespace(target: MemoryTarget): MemoryTarget {
  if (target.kind !== 'persona') return target;
  let namespace: string | undefined;
  try {
    namespace = loadPersona(createPersonaName(target.name)).memoryNamespace;
  } catch (err) {
    if ((err as { code?: unknown }).code === 'PERSONA_NOT_FOUND') return target;
    throw new MemoryCommandError(err instanceof Error ? err.message : String(err));
  }
  return namespace === undefined ? target : { ...target, namespace };
}

/**
 * `persona:<name>`, `job:<id>`, or a bare name that is a persona or a job (not
 * both). A job that runs as a persona writes to the persona's memory.
 */
function resolveTarget(raw: string): MemoryTarget {
  const build = (fn: (name: string) => MemoryTarget, name: string): MemoryTarget => {
    try {
      return fn(name);
    } catch (err) {
      throw new MemoryUsageError(err instanceof Error ? err.message : String(err));
    }
  };
  if (raw.startsWith('persona:')) return build(personaTarget, raw.slice('persona:'.length));
  if (raw.startsWith('job:')) return build(jobTarget, raw.slice('job:'.length));

  const candidates: MemoryTarget[] = [];
  for (const fn of [personaTarget, jobTarget]) {
    try {
      const target = fn(raw);
      if (existsSync(target.dir)) candidates.push(target);
    } catch {
      // Not a valid name of this kind.
    }
  }
  if (candidates.length === 1) return candidates[0];
  const shown = toDisplayText(raw, { maxLength: 80 });
  if (candidates.length > 1) {
    throw new MemoryUsageError(`"${shown}" is both a persona and a job: name it as persona:${shown} or job:${shown}`);
  }
  throw new MemoryCommandError(`No persona or cron job named "${shown}"`);
}

function describeTarget(target: MemoryTarget): string {
  return `${target.kind} "${target.name}"`;
}

/** The target's database path, or an error saying it has no memories yet. */
function existingDatabase(target: MemoryTarget): string {
  if (!existsSync(target.dbPath)) {
    throw new MemoryCommandError(
      `The ${describeTarget(target)} has no memory database yet (${target.dbPath}).${personaOfJobHint(target)}`,
    );
  }
  return target.dbPath;
}

/**
 * For a cron job that runs as a persona: where its memories are. Such a job's
 * sessions use the persona's memory (its own database stays unused), so what it
 * wrote, and what waits for review, is found under the persona. Only a hint: a
 * job.json the job store refuses (it validates the definition) gives none.
 */
function personaOfJobHint(target: MemoryTarget): string {
  if (target.kind !== 'job') return '';
  let persona: unknown;
  try {
    persona = loadJob(createJobId(target.name))?.persona;
  } catch {
    return '';
  }
  if (typeof persona !== 'string' || persona === '') return '';
  return (
    ` The job runs as persona "${persona}": what it writes is in that persona's memory ` +
    `(ironcurtain memory persona:${persona} review).`
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatDay(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toISOString().slice(0, 10);
}

function formatTime(ms: number | null): string {
  if (ms === null) return '-';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? 'unknown time' : date.toISOString();
}

function formatWriter(writer: AdminMemoryWriter | null): string {
  if (writer === null) return 'not recorded';
  const session = writer.session_id === undefined ? '' : ` ${toDisplayText(writer.session_id, { maxLength: 80 })}`;
  const scope = writer.scope === undefined ? '' : ` (${toDisplayText(writer.scope, { maxLength: 80 })})`;
  return `${toDisplayText(writer.kind, { maxLength: 40 })} session${session}${scope}`;
}

function formatState(memory: AdminMemory): string {
  const parts: string[] = [memory.status];
  if (memory.pending_review !== null) {
    parts.push(`waiting for review (${toDisplayText(memory.pending_review, { maxLength: 80 })})`);
  }
  return parts.join(', ');
}

/** Two lines per memory: id, date, state and tags; then the text on one line. */
function formatMemoryLine(memory: AdminMemory): string {
  const tags =
    memory.tags.length > 0 ? `  [${memory.tags.map((tag) => toDisplayText(tag, { maxLength: 60 })).join(', ')}]` : '';
  return (
    `${toDisplayText(memory.id)}  ${formatDay(memory.created_at)}  ${formatState(memory)}  importance ${memory.importance}${tags}\n` +
    `    ${toDisplayText(memory.content, { maxLength: 300 })}`
  );
}

function formatMemoryList(memories: readonly AdminMemory[], empty: string): string {
  if (memories.length === 0) return `${empty}\n`;
  return `${memories.map(formatMemoryLine).join('\n')}\n`;
}

function formatDetail(memory: AdminMemoryDetail): string {
  const lines = [
    `Memory ${toDisplayText(memory.id)}`,
    `  State:        ${formatState(memory)}`,
    `  Written by:   ${formatWriter(memory.writer)}`,
    `  Created:      ${formatTime(memory.created_at)}`,
    `  Updated:      ${formatTime(memory.updated_at)}`,
    `  Last recall:  ${formatTime(memory.last_accessed_at)} (${memory.access_count} recalls)`,
    `  Importance:   ${memory.importance}`,
    `  Consolidated: ${memory.consolidated ? 'yes' : 'not yet'}`,
  ];
  if (memory.reviewed_at !== null) lines.push(`  Approved:     ${formatTime(memory.reviewed_at)}`);
  // JSON distinguishes literal backslashes from escaped control characters.
  // No field of the releasable payload is shortened or omitted.
  lines.push(
    '',
    '  Released payload (JSON; strings escaped):',
    indent(
      toTerminalSafeJsonText(
        JSON.stringify(
          {
            content: memory.content,
            tags: memory.tags,
            source: memory.source,
            metadata: memory.metadata,
            segment_id: memory.segment_id,
            segment: memory.segment,
          },
          null,
          2,
        ),
      ),
    ),
  );
  if (memory.pending_review !== null) lines.push('', `  Approval receipt: ${approvalReceipt(memory)}`);
  return `${lines.join('\n')}\n`;
}

function approvalReceipt(memory: AdminMemoryDetail): string {
  if (!/^[a-f0-9]{64}$/.test(memory.review_digest)) {
    throw new MemoryCommandError('The memory admin API did not supply a review digest; rebuild or reinstall it.');
  }
  return `${memory.id}@${memory.review_digest}`;
}

function indent(text: string, spaces = 4): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatStats(target: MemoryTarget, stats: AdminStats): string {
  const lines = [
    `Memory of ${describeTarget(target)}`,
    `  Memories:            ${stats.total} (${stats.active} active, ${stats.decayed} decayed, ${stats.compacted} compacted)`,
    `  Waiting for review:  ${stats.pending_review}`,
  ];
  for (const { scope, count } of stats.pending_by_scope) {
    lines.push(`    ${toDisplayText(scope, { maxLength: 80 })}: ${count}`);
  }
  lines.push(
    `  Not consolidated:    ${stats.unconsolidated}`,
    `  Source passages:     ${stats.segments}`,
    `  Oldest / newest:     ${formatTime(stats.oldest)} / ${formatTime(stats.newest)}`,
    `  Database size:       ${formatBytes(stats.storage_bytes)}`,
  );
  if (stats.top_tags.length > 0) {
    lines.push(
      `  Top tags:            ${stats.top_tags
        .map(({ tag, count }) => `${toDisplayText(tag, { maxLength: 60 })} (${count})`)
        .join(', ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface Values {
  pending?: boolean;
  limit?: string;
  offset?: string;
  output?: string;
  all?: boolean;
  scope?: string;
  json?: boolean;
}

function parseCount(flag: string, value: string | undefined, min: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,6}$/.test(value) || Number(value) < min) {
    throw new MemoryUsageError(`--${flag} must be an integer of at least ${min}`);
  }
  return Number(value);
}

function memoryIds(admin: MemoryAdminModule, args: readonly string[], command: string): string[] {
  if (args.length === 0) throw new MemoryUsageError(`${command} needs at least one memory id`);
  for (const id of args) {
    if (!admin.isMemoryId(id)) {
      throw new MemoryUsageError(
        `Not a memory id: ${toDisplayText(id, { maxLength: 80 })} (ids are 32 hex characters)`,
      );
    }
  }
  return [...new Set(args)];
}

function memoryReviewReceipts(
  admin: MemoryAdminModule,
  args: readonly string[],
): Array<{ id: string; digest: string }> {
  if (args.length === 0)
    throw new MemoryUsageError('approve needs at least one <id>@<digest> receipt from review or show');
  return args.map((receipt) => {
    const match = /^([a-f0-9]{32})@([a-f0-9]{64})$/.exec(receipt);
    if (match === null || !admin.isMemoryId(match[1])) {
      throw new MemoryUsageError('approve requires <id>@<digest> receipts from a full review or show listing');
    }
    return { id: match[1], digest: match[2] };
  });
}

function writeJson(deps: Deps, value: Readonly<Record<string, unknown>> | readonly unknown[]): void {
  deps.write(`${toTerminalSafeJson(value)}\n`);
}

/** Runs `fn` with a read-only store of the target's existing database. */
async function withReader<T>(
  deps: Deps,
  target: MemoryTarget,
  fn: (store: MemoryStoreReader) => T | Promise<T>,
): Promise<T> {
  const dbPath = existingDatabase(target);
  const admin = await deps.loadAdmin();
  const store = admin.openMemoryStoreReader({ dbPath, namespace: target.namespace });
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/** Runs `fn` with a writable store of the target's existing database (or a new one, with `create`). */
async function withWriter<T>(
  deps: Deps,
  target: MemoryTarget,
  fn: (store: MemoryStoreWriter, admin: MemoryAdminModule) => T | Promise<T>,
  create = false,
): Promise<T> {
  const dbPath = create ? target.dbPath : existingDatabase(target);
  const admin = await deps.loadAdmin();
  const store = admin.openMemoryStoreWriter({ dbPath, namespace: target.namespace, create });
  try {
    return await fn(store, admin);
  } finally {
    store.close();
  }
}

async function runList(deps: Deps, target: MemoryTarget, values: Values): Promise<number> {
  const memories = await withReader(deps, target, (store) =>
    store.list({
      limit: parseCount('limit', values.limit, 1),
      offset: parseCount('offset', values.offset, 0),
      pendingOnly: values.pending === true,
    }),
  );
  if (values.json === true) writeJson(deps, memories);
  else deps.write(formatMemoryList(memories, `No memories in ${describeTarget(target)}.`));
  return 0;
}

async function runSearch(deps: Deps, target: MemoryTarget, args: readonly string[], values: Values): Promise<number> {
  const text = args.join(' ').trim();
  if (text.length === 0) throw new MemoryUsageError('search needs the text to look for');
  const memories = await withReader(deps, target, (store) =>
    store.search(text, { limit: parseCount('limit', values.limit, 1) }),
  );
  if (values.json === true) writeJson(deps, memories);
  else deps.write(formatMemoryList(memories, 'No memory matches.'));
  return 0;
}

async function runShow(deps: Deps, target: MemoryTarget, args: readonly string[], values: Values): Promise<number> {
  if (args.length !== 1) throw new MemoryUsageError('show needs exactly one memory id');
  const memory = await withReader(deps, target, (store) => store.get(args[0]));
  if (memory === undefined) {
    deps.writeError(`No memory ${toDisplayText(args[0], { maxLength: 80 })} in ${describeTarget(target)}.\n`);
    return 1;
  }
  if (values.json === true)
    writeJson(deps, {
      ...memory,
      ...(memory.pending_review === null ? {} : { approval_receipt: approvalReceipt(memory) }),
    });
  else deps.write(formatDetail(memory));
  return 0;
}

async function runForget(deps: Deps, target: MemoryTarget, args: readonly string[]): Promise<number> {
  const outcome = await withWriter(deps, target, (store, admin) => store.forget(memoryIds(admin, args, 'forget')));
  deps.write(`Forgot ${outcome.forgotten} ${outcome.forgotten === 1 ? 'memory' : 'memories'}.\n`);
  if (outcome.snapshot !== null) deps.write(`A snapshot of the database from before is at ${outcome.snapshot}\n`);
  if (outcome.missing.length > 0) {
    deps.writeError(`Not found in ${describeTarget(target)}: ${outcome.missing.join(', ')}\n`);
    return 1;
  }
  return 0;
}

async function runExport(deps: Deps, target: MemoryTarget, values: Values): Promise<number> {
  const counts = { memory: 0, segment: 0 };
  const output = values.output === undefined ? undefined : resolve(values.output);
  await withReader(deps, target, (store) => {
    // A new file only, created private: the export holds every memory. An existing
    // file (or a symlink) is never replaced. Opened once the database is.
    let fd: number | undefined;
    if (output !== undefined) {
      try {
        fd = openSync(output, 'wx', 0o600);
      } catch (err) {
        throw new MemoryCommandError(
          `Cannot create ${output}: ${err instanceof Error ? err.message : String(err)} (export never overwrites a file)`,
        );
      }
    }
    let complete = false;
    try {
      for (const line of store.exportLines()) {
        // The package writes `kind` first on every line.
        if (line.startsWith('{"kind":"memory"')) counts.memory += 1;
        else if (line.startsWith('{"kind":"segment"')) counts.segment += 1;
        const safe = `${toTerminalSafeJsonText(line)}\n`;
        if (fd === undefined) deps.write(safe);
        else writeSync(fd, safe);
      }
      complete = true;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
        // A cut-off export is no backup and would pass for one: the file this
        // command created (exclusively, above) is removed. The error is reported.
        if (!complete && output !== undefined) removeQuietly(output);
      }
    }
  });
  deps.writeError(
    `Exported ${counts.memory} memories and ${counts.segment} source passages of ${describeTarget(target)}` +
      `${output === undefined ? '' : ` to ${output}`}.\n`,
  );
  return 0;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not removable: the command fails either way.
  }
}

/** Largest import file read (an export with vectors is about 5 KB per memory). */
const MAX_IMPORT_FILE_BYTES = 1024 * 1024 * 1024;

async function runImport(deps: Deps, target: MemoryTarget, args: readonly string[]): Promise<number> {
  if (args.length !== 1) throw new MemoryUsageError('import needs exactly one file');
  const path = resolve(args[0]);
  let size: number;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new Error('not a regular file');
    size = stats.size;
  } catch (err) {
    throw new MemoryCommandError(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (size > MAX_IMPORT_FILE_BYTES) throw new MemoryCommandError(`${path} is larger than 1 GiB`);
  // Import creates the database, but only for a persona or job that exists.
  if (!existsSync(target.dir)) throw new MemoryCommandError(`The ${describeTarget(target)} does not exist.`);

  // A memory that comes without a usable vector is embedded with the model the
  // memory servers use: from ~/.ironcurtain/models, verified, and never downloaded
  // under memory.offlineModels.
  const modelStore = {
    modelsDir: resolveMemoryModelsDir(),
    offline: loadUserConfig({ readOnly: true }).memory.offlineModels,
  };
  const outcome = await withWriter(
    deps,
    target,
    async (store) => {
      const input = createReadStream(path, { encoding: 'utf-8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        return await store.importLines(lines, { modelStore });
      } finally {
        lines.close();
        input.destroy();
      }
    },
    true,
  );
  deps.write(
    `Imported ${outcome.memories} memories and ${outcome.segments} source passages into ${describeTarget(target)}` +
      (outcome.skipped_existing > 0 ? `; kept ${outcome.skipped_existing} that were already there` : '') +
      '.\n',
  );
  if (outcome.embedded > 0) deps.write(`Embedded ${outcome.embedded} memories that came without a usable vector.\n`);
  if (outcome.unlinked_segments > 0) {
    deps.write(`${outcome.unlinked_segments} memories came without their source passage.\n`);
  }
  if (outcome.redacted_secrets > 0) deps.write(`Removed ${outcome.redacted_secrets} secret values.\n`);
  return 0;
}

async function runStats(deps: Deps, target: MemoryTarget, values: Values): Promise<number> {
  const stats = await withReader(deps, target, (store) => store.stats());
  if (values.json === true) writeJson(deps, { ...stats });
  else deps.write(formatStats(target, stats));
  return 0;
}

function reviewHint(target: MemoryTarget): string {
  const name = `${target.kind}:${target.name}`;
  return (
    `Approve:  ironcurtain memory ${name} review approve <id>@<digest>... (use each displayed approval receipt)\n` +
    `Reject:   ironcurtain memory ${name} review reject <id>...\n`
  );
}

async function runReview(deps: Deps, target: MemoryTarget, args: readonly string[], values: Values): Promise<number> {
  const action = args.length > 0 ? args[0] : undefined;
  const rest = args.slice(1);
  if (action === undefined) {
    if (values.all === true || values.scope !== undefined) {
      throw new MemoryUsageError('--all and --scope go with "review approve"');
    }
    const { pending, total } = await withReader(deps, target, (store) => {
      const listed = store.list({ pendingOnly: true, limit: parseCount('limit', values.limit, 1) });
      // Render and receipt the same full object. A disappeared or already-approved
      // row does not produce a receipt; approval rechecks the remaining snapshots.
      return {
        pending: listed
          .map((memory) => store.get(memory.id))
          .filter((memory): memory is AdminMemoryDetail => memory !== undefined && memory.pending_review !== null),
        total: store.stats().pending_review,
      };
    });
    if (values.json === true) {
      writeJson(
        deps,
        pending.map((memory) => ({ ...memory, approval_receipt: approvalReceipt(memory) })),
      );
      return 0;
    }
    if (pending.length === 0) {
      deps.write(`No memories of ${describeTarget(target)} wait for review.\n`);
      return 0;
    }
    const shown = pending.length < total ? ` (the ${pending.length} newest are shown; --limit shows more)` : '';
    deps.write(
      `${total} ${total === 1 ? 'memory waits' : 'memories wait'} for review${shown}: written by ` +
        'unattended runs, they are hidden from interactive sessions until approved. Approving a memory ' +
        'also lets sessions read the source passage it was extracted from, printed under it.\n\n',
    );
    for (const memory of pending) {
      deps.write(`${formatDetail(memory)}\n`);
    }
    deps.write(`\n${reviewHint(target)}`);
    return 0;
  }

  if (action === 'approve') {
    if (values.all === true) {
      throw new MemoryUsageError(
        'approve --all is unavailable; pass the <id>@<digest> receipts displayed by review or show',
      );
    }
    if (values.scope !== undefined) throw new MemoryUsageError('--scope is unavailable; pass explicit review receipts');
    const outcome = await withWriter(deps, target, (store, admin) => store.approve(memoryReviewReceipts(admin, rest)));
    deps.write(`Approved ${outcome.approved} ${outcome.approved === 1 ? 'memory' : 'memories'}.\n`);
    if (outcome.notPending.length > 0) deps.write(`Not waiting for review: ${outcome.notPending.join(', ')}\n`);
    if (outcome.changed.length > 0) {
      deps.writeError(`Changed since review; review again before approving: ${outcome.changed.join(', ')}\n`);
    }
    if (outcome.missing.length > 0) {
      deps.writeError(`Not found in ${describeTarget(target)}: ${outcome.missing.join(', ')}\n`);
      return 1;
    }
    return outcome.changed.length > 0 ? 1 : 0;
  }

  if (action === 'reject') {
    if (values.all === true || values.scope !== undefined) {
      throw new MemoryUsageError('--all and --scope go with "review approve"');
    }
    const result = await withWriter(deps, target, (store, admin) => {
      const ids = memoryIds(admin, rest, 'reject');
      // Only memories that wait for review are rejected; anything else needs `forget`.
      const pending: string[] = [];
      const notPending: string[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const memory = store.get(id);
        if (memory === undefined) missing.push(id);
        else if (memory.pending_review === null) notPending.push(id);
        else pending.push(id);
      }
      const outcome = pending.length > 0 ? store.forget(pending) : { forgotten: 0, snapshot: null };
      return { forgotten: outcome.forgotten, snapshot: outcome.snapshot, notPending, missing };
    });
    deps.write(`Rejected (deleted) ${result.forgotten} ${result.forgotten === 1 ? 'memory' : 'memories'}.\n`);
    if (result.snapshot !== null) deps.write(`A snapshot of the database from before is at ${result.snapshot}\n`);
    if (result.notPending.length > 0) {
      deps.writeError(`Not waiting for review (use "forget" to delete them): ${result.notPending.join(', ')}\n`);
    }
    if (result.missing.length > 0) {
      deps.writeError(`Not found in ${describeTarget(target)}: ${result.missing.join(', ')}\n`);
    }
    return result.notPending.length > 0 || result.missing.length > 0 ? 1 : 0;
  }

  throw new MemoryUsageError(`Unknown review action: ${toDisplayText(action, { maxLength: 40 })}`);
}

function describeModel(entry: MemoryModelEntry): string {
  const name = toDisplayText(`${entry.role} model ${entry.repo} (${entry.dtype})`);
  switch (entry.status) {
    case 'ok':
      return `  ok      ${name}: already installed and verified`;
    case 'downloaded':
      return `  ok      ${name}: downloaded and verified`;
    default: {
      const detail = entry.detail === undefined ? '' : `: ${toDisplayText(entry.detail, { maxLength: 600 })}`;
      return `  FAILED  ${name} (${entry.status})${detail}`;
    }
  }
}

/** `ironcurtain memory prefetch`: downloads and verifies the memory models through the bundled server. */
async function runPrefetch(deps: Deps): Promise<number> {
  const result = await deps.run('prefetch', { showProgress: true });
  if (result.kind === 'failed') {
    deps.writeError(`Could not prefetch the memory models: ${toDisplayText(result.reason, { maxLength: 600 })}\n`);
    return 1;
  }
  const { report } = result;
  deps.write(`Memory models in ${toDisplayText(report.modelsDir)}:\n`);
  for (const entry of report.models) {
    deps.write(`${describeModel(entry)}\n`);
  }
  const ok = result.exitCode === 0 && report.models.every((m) => m.status === 'ok' || m.status === 'downloaded');
  return ok ? 0 : 1;
}

/** The options of the store commands; `prefetch` takes none of them. */
const STORE_OPTIONS = ['pending', 'limit', 'offset', 'output', 'all', 'scope', 'json'] as const;

/**
 * Runs `ironcurtain memory <persona|job> <command>` or `ironcurtain memory
 * prefetch` and returns the exit status: 0 on success, 1 when the command
 * could not be carried out (an unknown persona or job, no database yet, an id
 * not found, a model that could not be installed), 2 for a usage error.
 */
export async function runMemoryCommand(
  args: readonly string[],
  dependencies: MemoryCommandDependencies = {},
): Promise<number> {
  const deps: Deps = {
    write: dependencies.write ?? ((text) => process.stdout.write(text)),
    writeError: dependencies.writeError ?? ((text) => process.stderr.write(text)),
    loadAdmin: dependencies.loadAdmin ?? loadMemoryAdmin,
    run: dependencies.run ?? runMemoryModelsTool,
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        pending: { type: 'boolean' },
        limit: { type: 'string' },
        offset: { type: 'string' },
        output: { type: 'string' },
        all: { type: 'boolean' },
        scope: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    deps.writeError(`${err instanceof Error ? err.message : String(err)}\n\n${formatHelp(memoryCommandSpec)}\n`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    deps.write(`${formatHelp(memoryCommandSpec)}\n`);
    return 0;
  }
  if (positionals[0] === 'prefetch') {
    // The models command; a persona or job named "prefetch" is persona:prefetch or job:prefetch.
    const option = STORE_OPTIONS.find((name) => values[name] !== undefined);
    if (positionals.length > 1 || option !== undefined) {
      const what =
        option !== undefined
          ? `prefetch takes no options (--${option})`
          : 'prefetch takes no arguments (a persona or job named "prefetch" is persona:prefetch or job:prefetch)';
      deps.writeError(`${what}\n\n${formatHelp(memoryCommandSpec)}\n`);
      return EXIT_USAGE;
    }
    return runPrefetch(deps);
  }
  if (positionals.length < 2) {
    deps.writeError(`${formatHelp(memoryCommandSpec)}\n`);
    return EXIT_USAGE;
  }
  const [rawTarget, command, ...rest] = positionals;
  try {
    const target = withSessionNamespace(resolveTarget(rawTarget));
    switch (command) {
      case 'list':
        return await runList(deps, target, values);
      case 'search':
        return await runSearch(deps, target, rest, values);
      case 'show':
        return await runShow(deps, target, rest, values);
      case 'forget':
        return await runForget(deps, target, rest);
      case 'export':
        return await runExport(deps, target, values);
      case 'import':
        return await runImport(deps, target, rest);
      case 'stats':
        return await runStats(deps, target, values);
      case 'review':
        return await runReview(deps, target, rest, values);
      default:
        throw new MemoryUsageError(`Unknown memory command: ${toDisplayText(command, { maxLength: 40 })}`);
    }
  } catch (err) {
    // Messages can quote a typed argument or a value read from the database.
    const message = toDisplayText(err instanceof Error ? err.message : String(err), { multiline: true });
    if (err instanceof MemoryUsageError) {
      deps.writeError(`${message}\n\n${formatHelp(memoryCommandSpec)}\n`);
      return EXIT_USAGE;
    }
    deps.writeError(`${message}\n`);
    return 1;
  }
}

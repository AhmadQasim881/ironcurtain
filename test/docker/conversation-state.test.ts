/**
 * Tests for `src/docker/conversation-state.ts`: host access to the
 * conversation-state directory the agent can write (`~/.claude/` and
 * `~/.codex/` are read-write bind mounts of it).
 *
 * Every entry in that directory is agent-controlled, so the tests plant what
 * a hostile agent would: absolute, relative and dangling symlinks, FIFOs, hard
 * links, directories, symlink loops and `projects -> /`.
 *
 * Cases that would block the event loop if the code regressed (opening a FIFO
 * for writing with no reader, a recursive walk through a symlink loop) run in
 * a child process with a hard timeout: a synchronous hang in this worker could
 * never trip vitest's timer, while the child is killed and the test fails.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  utimesSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildPtyConversationEnv,
  CLAUDE_MD_FILE_NAME,
  CONVERSATION_RECORDS_DIR_NAME,
  findLatestCodexThread,
  findStoredConversation,
  hasCodexRollout,
  hasStoredConversation,
  hasStoredTranscript,
  MAX_TRANSCRIPT_PROBE_ENTRIES,
  recordStoredConversation,
  syncConversationStateClaudeMd,
} from '../../src/docker/conversation-state.js';
import type { AgentId, ConversationStateConfig } from '../../src/docker/agent-adapter.js';
import { UntrustedFileError } from '../../src/hardened-fs.js';

const CLAUDE_CODE = 'claude-code' as AgentId;
const CODEX = 'codex' as AgentId;
const CONTENT = 'You are operating as the "researcher" persona.\n\n# Pre-response protocol\n';
const CONVERSATION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

let root: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ironcurtain-conversation-state-'));
  stateDir = join(root, 'session', 'claude-state');
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function claudeMd(): string {
  return join(stateDir, CLAUDE_MD_FILE_NAME);
}

function expectSeeded(): void {
  const stats = lstatSync(claudeMd());
  expect(stats.isFile()).toBe(true);
  expect(stats.nlink).toBe(1);
  expect(stats.mode & 0o777).toBe(0o644);
  expect(readFileSync(claudeMd(), 'utf8')).toBe(CONTENT);
}

/** Sync CLAUDE.md to `content` (`undefined` or empty: memory off). */
function sync(content: string | undefined, adapterId: AgentId = CLAUDE_CODE): void {
  syncConversationStateClaudeMd({ conversationStateDir: stateDir, adapterId, content });
}

/** Write `projects/<hash>/<id>.jsonl` as Claude Code would. */
function writeTranscript(dir: string, hash = '-workspace', id = CONVERSATION_ID): string {
  const projectDir = join(dir, 'projects', hash);
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, `${id}.jsonl`);
  writeFileSync(path, '{"type":"user"}\n');
  return path;
}

/** Bytes waiting in a FIFO opened non-blocking for reading (0 when nothing was written). */
function pendingFifoBytes(reader: number): number {
  try {
    return readSync(reader, Buffer.alloc(64 * 1024), 0, 64 * 1024, null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return 0;
    throw error;
  }
}

type ChildOperation =
  | { readonly op: 'probe'; readonly stateDir: string; readonly id: string }
  | { readonly op: 'sync'; readonly dir: string; readonly adapterId: string; readonly content: string };

interface ChildResult {
  readonly ok: boolean;
  readonly found?: boolean;
  /** Fastest of three probe runs, in milliseconds (scheduling noise only adds time). */
  readonly fastestMs?: number;
  readonly code?: string;
}

/** Run operations in a separate Node process that is killed if it does not finish in time. */
function runInChild(operations: readonly ChildOperation[]): ChildResult[] {
  const moduleUrl = pathToFileURL(resolve('src/docker/conversation-state.ts')).href;
  const program = [
    `import { hasStoredConversation, syncConversationStateClaudeMd } from ${JSON.stringify(moduleUrl)};`,
    "import { performance } from 'node:perf_hooks';",
    'const results = [];',
    'for (const operation of JSON.parse(process.argv[1])) {',
    '  try {',
    "    if (operation.op === 'probe') {",
    '      let fastestMs = Infinity;',
    '      const answers = new Set();',
    '      for (let run = 0; run < 3; run++) {',
    '        const started = performance.now();',
    '        answers.add(hasStoredConversation(operation.stateDir, operation.id));',
    '        fastestMs = Math.min(fastestMs, performance.now() - started);',
    '      }',
    "      if (answers.size !== 1) throw new Error('probe answers disagree');",
    '      results.push({ ok: true, found: [...answers][0], fastestMs });',
    '    } else {',
    '      syncConversationStateClaudeMd({',
    '        conversationStateDir: operation.dir,',
    '        adapterId: operation.adapterId,',
    '        content: operation.content,',
    '      });',
    '      results.push({ ok: true });',
    '    }',
    '  } catch (error) {',
    '    results.push({ ok: false, code: error.code ?? String(error) });',
    '  }',
    '}',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n');
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', program, JSON.stringify(operations)],
    { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' },
  );
  expect(child.error, 'child process must finish before the hard timeout').toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as ChildResult[];
}

describe('syncConversationStateClaudeMd', () => {
  it('writes CLAUDE.md for Claude Code as a fresh regular file', () => {
    sync(CONTENT);
    expectSeeded();
  });

  it('overwrites an existing CLAUDE.md, leaving no temporary files behind', () => {
    writeFileSync(claudeMd(), 'stale rules from an earlier session\n');
    sync(CONTENT);
    expectSeeded();
    expect(readdirSync(stateDir)).toEqual([CLAUDE_MD_FILE_NAME]);
  });

  it('replaces an absolute symlink and leaves its target untouched', () => {
    const victim = join(root, 'home', '.ssh', 'authorized_keys');
    mkdirSync(join(root, 'home', '.ssh'), { recursive: true });
    writeFileSync(victim, 'ssh-ed25519 AAAA original\n');
    symlinkSync(victim, claudeMd());

    sync(CONTENT);

    expect(readFileSync(victim, 'utf8')).toBe('ssh-ed25519 AAAA original\n');
    expectSeeded();
  });

  it('replaces a relative symlink that resolves against the host state dir', () => {
    // claude-state is <root>/session/claude-state, so ../../config.json is <root>/config.json.
    const victim = join(root, 'config.json');
    writeFileSync(victim, '{"original":true}\n');
    symlinkSync('../../config.json', claudeMd());

    sync(CONTENT);

    expect(readFileSync(victim, 'utf8')).toBe('{"original":true}\n');
    expectSeeded();
  });

  it('replaces a dangling symlink without creating its target', () => {
    const target = join(root, 'created-by-host.txt');
    symlinkSync(target, claudeMd());

    sync(CONTENT);

    expect(existsSync(target)).toBe(false);
    expectSeeded();
  });

  it('replaces a hard link without changing the other name', () => {
    const other = join(stateDir, 'settings.json');
    writeFileSync(other, '{"theme":"dark"}\n');
    linkSync(other, claudeMd());

    sync(CONTENT);

    expect(readFileSync(other, 'utf8')).toBe('{"theme":"dark"}\n');
    expect(statSync(other).nlink).toBe(1);
    expectSeeded();
  });

  it('replaces a FIFO without opening it', () => {
    execFileSync('mkfifo', [claudeMd()]);
    // A non-blocking read end keeps a regressed writer from blocking this
    // worker: it would complete and leave bytes in the pipe instead.
    const reader = openSync(claudeMd(), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      sync(CONTENT);
      expect(pendingFifoBytes(reader)).toBe(0);
    } finally {
      closeSync(reader);
    }
    expectSeeded();
  });

  it('never blocks on a FIFO with no reader (hard child timeout)', () => {
    execFileSync('mkfifo', [claudeMd()]);
    const [result] = runInChild([{ op: 'sync', dir: stateDir, adapterId: CLAUDE_CODE, content: CONTENT }]);
    expect(result).toEqual({ ok: true });
    expectSeeded();
  });

  it('refuses a directory at the name and leaves it intact', () => {
    mkdirSync(join(claudeMd(), 'agent-data'), { recursive: true });

    let caught: unknown;
    try {
      sync(CONTENT);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UntrustedFileError);
    expect((caught as UntrustedFileError).code).toBe('NOT_REGULAR_FILE');
    expect(lstatSync(join(claudeMd(), 'agent-data')).isDirectory()).toBe(true);
    // The temporary file was cleaned up.
    expect(readdirSync(stateDir)).toEqual([CLAUDE_MD_FILE_NAME]);
  });

  it('fails when the state dir is missing or is itself a symlink', () => {
    rmSync(stateDir, { recursive: true });
    expect(() => sync(CONTENT)).toThrow(UntrustedFileError);

    const realDir = join(root, 'elsewhere');
    mkdirSync(realDir);
    symlinkSync(realDir, stateDir);
    expect(() => sync(CONTENT)).toThrow(/not a real directory/u);
    expect(existsSync(join(realDir, CLAUDE_MD_FILE_NAME))).toBe(false);
  });

  it('does not seed a non-Claude adapter, and removes a planted link instead', () => {
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    symlinkSync(victim, claudeMd());

    sync(CONTENT, CODEX);

    expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
    expect(lstatSync(claudeMd(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('memory off: removes a stale file, or a planted link without touching its target', () => {
    writeFileSync(claudeMd(), 'stale\n');
    sync(undefined);
    expect(lstatSync(claudeMd(), { throwIfNoEntry: false })).toBeUndefined();

    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    symlinkSync(victim, claudeMd());
    sync('');
    expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
    expect(lstatSync(claudeMd(), { throwIfNoEntry: false })).toBeUndefined();

    // Nothing there, or a directory the agent planted: a no-op, not an error.
    expect(() => sync(undefined)).not.toThrow();
    mkdirSync(claudeMd());
    expect(() => sync(undefined)).not.toThrow();
    expect(lstatSync(claudeMd()).isDirectory()).toBe(true);
  });
});

describe('hasStoredConversation', () => {
  it('finds projects/<hash>/<id>.jsonl and nothing else', () => {
    writeTranscript(stateDir);
    expect(hasStoredConversation(stateDir, CONVERSATION_ID)).toBe(true);
    expect(hasStoredConversation(stateDir, '11111111-2222-3333-4444-555555555555')).toBe(false);
  });

  it('returns false when projects/ is missing, empty or not a directory', () => {
    expect(hasStoredConversation(stateDir, CONVERSATION_ID)).toBe(false);
    expect(hasStoredConversation(join(root, 'no-such-dir'), CONVERSATION_ID)).toBe(false);
    mkdirSync(join(stateDir, 'projects'));
    expect(hasStoredConversation(stateDir, CONVERSATION_ID)).toBe(false);
    rmSync(join(stateDir, 'projects'), { recursive: true });
    writeFileSync(join(stateDir, 'projects'), 'not a directory');
    expect(hasStoredConversation(stateDir, CONVERSATION_ID)).toBe(false);
  });

  it('does not look deeper than projects/<hash>/', () => {
    writeTranscript(stateDir, join('-workspace', 'nested'));
    writeFileSync(join(stateDir, `${CONVERSATION_ID}.jsonl`), '{}\n');
    writeFileSync(join(stateDir, 'projects', `${CONVERSATION_ID}.jsonl`), '{}\n');
    expect(hasStoredConversation(stateDir, CONVERSATION_ID)).toBe(false);
  });

  it('does not follow a symlinked projects/ directory', () => {
    const elsewhere = join(root, 'elsewhere');
    writeTranscript(elsewhere);
    symlinkSync(join(elsewhere, 'projects'), join(stateDir, 'projects'));
    expect(hasStoredConversation(stateDir, CONVERSATION_ID)).toBe(false);
  });

  it('does not follow a symlinked project directory', () => {
    const elsewhere = join(root, 'elsewhere');
    writeTranscript(elsewhere);
    mkdirSync(join(stateDir, 'projects'));
    symlinkSync(join(elsewhere, 'projects', '-workspace'), join(stateDir, 'projects', '-workspace'));
    expect(hasStoredConversation(stateDir, CONVERSATION_ID)).toBe(false);
  });

  it('only counts a regular transcript file', () => {
    const projectDir = join(stateDir, 'projects', '-workspace');
    mkdirSync(projectDir, { recursive: true });
    const transcript = join(projectDir, `${CONVERSATION_ID}.jsonl`);

    writeFileSync(join(root, 'real.jsonl'), '{}\n');
    symlinkSync(join(root, 'real.jsonl'), transcript);
    expect(hasStoredConversation(stateDir, CONVERSATION_ID)).toBe(false);

    rmSync(transcript);
    mkdirSync(transcript);
    expect(hasStoredConversation(stateDir, CONVERSATION_ID)).toBe(false);

    rmSync(transcript, { recursive: true });
    execFileSync('mkfifo', [transcript]);
    expect(hasStoredConversation(stateDir, CONVERSATION_ID)).toBe(false);
  });

  it('treats an id that is not a single path component as no stored conversation', () => {
    writeTranscript(stateDir);
    writeFileSync(join(stateDir, 'projects', '-workspace', 'x.jsonl'), '{}\n');
    for (const id of ['', '.', '..', '../-workspace/x', '-workspace/x', 'a\\b', 'a\0b']) {
      expect(hasStoredConversation(stateDir, id)).toBe(false);
    }
  });

  it('reads at most maxEntries entries of projects/', () => {
    writeTranscript(stateDir);
    for (let index = 0; index < 4; index++) mkdirSync(join(stateDir, 'projects', `decoy-${index}`));
    expect(MAX_TRANSCRIPT_PROBE_ENTRIES).toBe(10_000);
    expect(hasStoredConversation(stateDir, CONVERSATION_ID, { maxEntries: 0 })).toBe(false);
    expect(hasStoredConversation(stateDir, CONVERSATION_ID, { maxEntries: 5 })).toBe(true);
  });

  it('stays fast and still finds the transcript next to symlink loops, and gives up on projects -> /', () => {
    // An agent-planted loop: a recursive walk that follows directory links
    // grows exponentially here and froze (then OOM-crashed) the host.
    const looped = join(root, 'looped');
    writeTranscript(looped, 'f1e2d3-workspace-hash');
    mkdirSync(join(looped, 'projects', 'a'));
    symlinkSync('..', join(looped, 'projects', 'a', 'l1'));
    symlinkSync('.', join(looped, 'projects', 'a', 'l2'));
    symlinkSync('.', join(looped, 'projects', 'a', 'l3'));
    symlinkSync('.', join(looped, 'projects', 'self'));

    // `projects` itself replaced by a link to the host root.
    const rooted = join(root, 'rooted');
    mkdirSync(rooted);
    symlinkSync('/', join(rooted, 'projects'));

    const [loopResult, rootResult] = runInChild([
      { op: 'probe', stateDir: looped, id: CONVERSATION_ID },
      { op: 'probe', stateDir: rooted, id: CONVERSATION_ID },
    ]);

    expect(loopResult.ok).toBe(true);
    expect(loopResult.found).toBe(true);
    expect(loopResult.fastestMs).toBeLessThan(100);
    expect(rootResult.ok).toBe(true);
    expect(rootResult.found).toBe(false);
    expect(rootResult.fastestMs).toBeLessThan(100);
  });
});

// ── Transcript probes per layout ─────────────────────────────────────

const THREAD_A = '01a1b67b-5e92-7fb0-aa3e-ebe122186d0b';
const THREAD_B = '019a0c1d-2e3f-7a4b-8c5d-6e7f8091a2b3';

/** Write a Codex rollout `sessions/<date>/rollout-<timestamp>-<thread>.jsonl` and return its path. */
function writeRollout(
  dir: string,
  threadId: string,
  date = ['2026', '11', '11'],
  stamp = '2026-11-11T10-00-00',
): string {
  const dayDir = join(dir, 'sessions', ...date);
  mkdirSync(dayDir, { recursive: true });
  const path = join(dayDir, `rollout-${stamp}-${threadId}.jsonl`);
  writeFileSync(path, '{"type":"session_meta"}\n');
  return path;
}

describe('hasStoredTranscript', () => {
  it('claude-projects: the seeds and settings files are not a conversation', () => {
    mkdirSync(join(stateDir, 'projects'));
    writeFileSync(join(stateDir, 'settings.json'), '{}');
    writeFileSync(join(stateDir, CLAUDE_MD_FILE_NAME), CONTENT);
    expect(hasStoredTranscript(stateDir, 'claude-projects')).toBe(false);

    writeTranscript(stateDir, '-workspace', 'any-conversation');
    expect(hasStoredTranscript(stateDir, 'claude-projects')).toBe(true);
  });

  it('claude-projects: an empty, linked or misplaced transcript does not count', () => {
    const projectDir = join(stateDir, 'projects', '-workspace');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'empty.jsonl'), '');
    writeFileSync(join(stateDir, 'projects', 'top-level.jsonl'), '{}\n');
    writeFileSync(join(root, 'real.jsonl'), '{}\n');
    symlinkSync(join(root, 'real.jsonl'), join(projectDir, 'linked.jsonl'));
    expect(hasStoredTranscript(stateDir, 'claude-projects')).toBe(false);

    const elsewhere = join(root, 'elsewhere');
    writeTranscript(elsewhere);
    symlinkSync(join(elsewhere, 'projects', '-workspace'), join(stateDir, 'projects', 'linked-project'));
    expect(hasStoredTranscript(stateDir, 'claude-projects')).toBe(false);
  });

  it('codex-rollouts: the seeded sessions/ and logs/ are not a conversation; a rollout is', () => {
    const codexDir = join(root, 'codex-state');
    mkdirSync(join(codexDir, 'sessions'), { recursive: true });
    mkdirSync(join(codexDir, 'logs'));
    writeFileSync(join(codexDir, 'config.toml'), 'web_search = "disabled"\n');
    expect(hasStoredTranscript(codexDir, 'codex-rollouts')).toBe(false);

    writeRollout(codexDir, THREAD_A);
    expect(hasStoredTranscript(codexDir, 'codex-rollouts')).toBe(true);
  });

  it('codex-rollouts: only regular rollouts at sessions/YYYY/MM/DD count, links are never entered', () => {
    const codexDir = join(root, 'codex-state');
    // Wrong depth, wrong name, a FIFO and a link with a rollout name.
    mkdirSync(join(codexDir, 'sessions', '2026', '11'), { recursive: true });
    writeFileSync(join(codexDir, 'sessions', '2026', '11', `rollout-x-${THREAD_A}.jsonl`), '{}\n');
    mkdirSync(join(codexDir, 'sessions', '2026', '11', '12'), { recursive: true });
    writeFileSync(join(codexDir, 'sessions', '2026', '11', '12', `transcript-${THREAD_A}.jsonl`), '{}\n');
    execFileSync('mkfifo', [join(codexDir, 'sessions', '2026', '11', '12', `rollout-fifo-${THREAD_A}.jsonl`)]);
    writeFileSync(join(root, 'outside.jsonl'), '{}\n');
    symlinkSync(
      join(root, 'outside.jsonl'),
      join(codexDir, 'sessions', '2026', '11', '12', `rollout-link-${THREAD_A}.jsonl`),
    );
    // A date directory replaced by a link to a tree that holds a real rollout.
    const elsewhere = join(root, 'elsewhere-codex');
    writeRollout(elsewhere, THREAD_B);
    symlinkSync(join(elsewhere, 'sessions', '2026', '11', '11'), join(codexDir, 'sessions', '2026', '11', '11'));
    expect(hasStoredTranscript(codexDir, 'codex-rollouts')).toBe(false);
    expect(hasCodexRollout(codexDir, THREAD_A)).toBe(false);
    expect(hasCodexRollout(codexDir, THREAD_B)).toBe(false);
    expect(findLatestCodexThread(codexDir)).toBeUndefined();
  });

  it('codex-rollouts: a sessions/ that is a link (sessions -> /) is no transcript', () => {
    const codexDir = join(root, 'codex-state');
    mkdirSync(codexDir);
    symlinkSync('/', join(codexDir, 'sessions'));
    expect(hasStoredTranscript(codexDir, 'codex-rollouts')).toBe(false);
    expect(findLatestCodexThread(codexDir)).toBeUndefined();
  });

  it('goose-sessions: a non-empty session store, or a legacy session file, is a conversation', () => {
    const gooseDir = join(root, 'goose-state');
    mkdirSync(gooseDir);
    expect(hasStoredTranscript(gooseDir, 'goose-sessions')).toBe(false);
    writeFileSync(join(gooseDir, 'sessions.db'), '');
    expect(hasStoredTranscript(gooseDir, 'goose-sessions')).toBe(false);
    writeFileSync(join(gooseDir, 'sessions.db'), 'SQLite format 3\0');
    expect(hasStoredTranscript(gooseDir, 'goose-sessions')).toBe(true);

    const legacyDir = join(root, 'goose-legacy');
    mkdirSync(legacyDir);
    writeFileSync(join(legacyDir, '20250325_200615.jsonl'), '{"role":"user"}\n');
    expect(hasStoredTranscript(legacyDir, 'goose-sessions')).toBe(true);
  });

  it('goose-sessions: a linked or FIFO session store does not count', () => {
    const gooseDir = join(root, 'goose-state');
    mkdirSync(gooseDir);
    writeFileSync(join(root, 'real.db'), 'SQLite format 3\0');
    symlinkSync(join(root, 'real.db'), join(gooseDir, 'sessions.db'));
    execFileSync('mkfifo', [join(gooseDir, 'pending.jsonl')]);
    expect(hasStoredTranscript(gooseDir, 'goose-sessions')).toBe(false);
  });

  it('reads at most maxEntries directory entries', () => {
    const codexDir = join(root, 'codex-state');
    writeRollout(codexDir, THREAD_A);
    // sessions/, 2026/, 11/, 11/ plus the rollout: five reads find it.
    expect(hasStoredTranscript(codexDir, 'codex-rollouts', { maxEntries: 2 })).toBe(false);
    expect(hasStoredTranscript(codexDir, 'codex-rollouts', { maxEntries: 50 })).toBe(true);
    expect(findLatestCodexThread(codexDir, { maxEntries: 2 })).toBeUndefined();
  });
});

describe('Codex rollout lookups', () => {
  it('finds the rollout of exactly the requested thread', () => {
    const codexDir = join(root, 'codex-state');
    writeRollout(codexDir, THREAD_A);
    expect(hasCodexRollout(codexDir, THREAD_A)).toBe(true);
    expect(hasCodexRollout(codexDir, THREAD_A.toUpperCase())).toBe(true);
    expect(hasCodexRollout(codexDir, THREAD_B)).toBe(false);
    for (const bogus of ['', '--last', '*', `../${THREAD_A}`]) expect(hasCodexRollout(codexDir, bogus)).toBe(false);
  });

  it('does not count an empty rollout, which Codex could not resume', () => {
    const codexDir = join(root, 'codex-state');
    const rollout = writeRollout(codexDir, THREAD_A);
    writeFileSync(rollout, '');
    expect(hasCodexRollout(codexDir, THREAD_A)).toBe(false);

    // A later session with a recorded thread then starts a new thread instead.
    const bundleDir = join(root, 'bundle');
    mkdirSync(bundleDir);
    recordStoredConversation({
      layout: 'codex-rollouts',
      recordRoot: bundleDir,
      agentConversationId: CONVERSATION_ID,
      threadId: THREAD_A,
    });
    const probe = {
      stateDir: codexDir,
      layout: 'codex-rollouts',
      recordRoot: bundleDir,
      agentConversationId: CONVERSATION_ID,
    } as const;
    expect(findStoredConversation(probe)).toEqual({ stored: false });
    writeFileSync(rollout, '{"type":"session_meta"}\n');
    expect(findStoredConversation(probe)).toEqual({ stored: true, threadId: THREAD_A });
  });

  it('names the most recently active thread for a PTY resume', () => {
    const codexDir = join(root, 'codex-state');
    const older = writeRollout(codexDir, THREAD_A, ['2026', '11', '10'], '2026-11-10T09-00-00');
    const newer = writeRollout(codexDir, THREAD_B, ['2026', '11', '11'], '2026-11-11T09-00-00');
    utimesSync(older, new Date('2026-11-10T09:00:00Z'), new Date('2026-11-10T09:00:00Z'));
    utimesSync(newer, new Date('2026-11-11T09:00:00Z'), new Date('2026-11-11T09:00:00Z'));
    expect(findLatestCodexThread(codexDir)).toBe(THREAD_B);

    // The older thread was continued last: its rollout was written most recently.
    utimesSync(older, new Date('2026-11-12T09:00:00Z'), new Date('2026-11-12T09:00:00Z'));
    expect(findLatestCodexThread(codexDir)).toBe(THREAD_A);
  });
});

// ── Host-only conversation records ───────────────────────────────────

describe('conversation records', () => {
  let bundleDir: string;
  let codexDir: string;
  let gooseDir: string;

  beforeEach(() => {
    bundleDir = join(root, 'bundle');
    codexDir = join(bundleDir, 'codex-state');
    gooseDir = join(bundleDir, 'goose-state');
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(gooseDir, { recursive: true });
  });

  function recordPath(id = CONVERSATION_ID): string {
    return join(bundleDir, CONVERSATION_RECORDS_DIR_NAME, `${id}.json`);
  }

  it('Codex: the recorded thread continues the conversation only while its rollout exists', () => {
    expect(
      findStoredConversation({
        stateDir: codexDir,
        layout: 'codex-rollouts',
        recordRoot: bundleDir,
        agentConversationId: CONVERSATION_ID,
      }),
    ).toEqual({ stored: false });

    expect(
      recordStoredConversation({
        layout: 'codex-rollouts',
        recordRoot: bundleDir,
        agentConversationId: CONVERSATION_ID,
        threadId: THREAD_A,
      }),
    ).toBe(true);
    expect(JSON.parse(readFileSync(recordPath(), 'utf8'))).toEqual({ threadId: THREAD_A });
    expect(statSync(recordPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(bundleDir, CONVERSATION_RECORDS_DIR_NAME)).mode & 0o777).toBe(0o700);

    const probe = {
      stateDir: codexDir,
      layout: 'codex-rollouts',
      recordRoot: bundleDir,
      agentConversationId: CONVERSATION_ID,
    } as const;
    // Recorded, but Codex holds no rollout for it (deleted, or never written).
    expect(findStoredConversation(probe)).toEqual({ stored: false });
    writeRollout(codexDir, THREAD_A);
    expect(findStoredConversation(probe)).toEqual({ stored: true, threadId: THREAD_A });
    // Another conversation of the same container is not ours.
    expect(findStoredConversation({ ...probe, agentConversationId: '11111111-2222-3333-4444-555555555555' })).toEqual({
      stored: false,
    });
  });

  it('Codex: nothing is recorded without a valid thread id', () => {
    for (const threadId of [undefined, '--last', 'abc']) {
      expect(
        recordStoredConversation({
          layout: 'codex-rollouts',
          recordRoot: bundleDir,
          agentConversationId: CONVERSATION_ID,
          ...(threadId === undefined ? {} : { threadId }),
        }),
      ).toBe(false);
    }
    expect(existsSync(recordPath())).toBe(false);
  });

  it('Goose: a record plus a non-empty session store continue the named session', () => {
    const probe = {
      stateDir: gooseDir,
      layout: 'goose-sessions',
      recordRoot: bundleDir,
      agentConversationId: CONVERSATION_ID,
    } as const;
    writeFileSync(join(gooseDir, 'sessions.db'), 'SQLite format 3\0');
    // A store without a record: some other conversation's session.
    expect(findStoredConversation(probe)).toEqual({ stored: false });

    expect(
      recordStoredConversation({
        layout: 'goose-sessions',
        recordRoot: bundleDir,
        agentConversationId: CONVERSATION_ID,
      }),
    ).toBe(true);
    expect(JSON.parse(readFileSync(recordPath(), 'utf8'))).toEqual({});
    expect(findStoredConversation(probe)).toEqual({ stored: true });

    // A record whose session store is gone starts the session afresh.
    rmSync(join(gooseDir, 'sessions.db'));
    expect(findStoredConversation(probe)).toEqual({ stored: false });
  });

  it('Claude Code keeps no record: its transcript is named by our id', () => {
    expect(
      recordStoredConversation({
        layout: 'claude-projects',
        recordRoot: bundleDir,
        agentConversationId: CONVERSATION_ID,
      }),
    ).toBe(false);
    expect(existsSync(join(bundleDir, CONVERSATION_RECORDS_DIR_NAME))).toBe(false);
    writeTranscript(stateDir);
    expect(
      findStoredConversation({
        stateDir,
        layout: 'claude-projects',
        recordRoot: bundleDir,
        agentConversationId: CONVERSATION_ID,
      }),
    ).toEqual({ stored: true });
  });

  it('reads a malformed, oversized, linked or tampered record as no record', () => {
    writeRollout(codexDir, THREAD_A);
    const probe = {
      stateDir: codexDir,
      layout: 'codex-rollouts',
      recordRoot: bundleDir,
      agentConversationId: CONVERSATION_ID,
    } as const;
    mkdirSync(join(bundleDir, CONVERSATION_RECORDS_DIR_NAME));
    for (const content of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ threadId: '--last' }),
      `{"threadId":"${THREAD_A}","pad":"${'x'.repeat(2000)}"}`,
    ]) {
      writeFileSync(recordPath(), content);
      expect(findStoredConversation(probe)).toEqual({ stored: false });
    }
    rmSync(recordPath());
    writeFileSync(join(root, 'planted.json'), JSON.stringify({ threadId: THREAD_A }));
    symlinkSync(join(root, 'planted.json'), recordPath());
    expect(findStoredConversation(probe)).toEqual({ stored: false });
  });

  it('refuses conversation ids that are not a single safe name', () => {
    for (const id of ['', '.', '..', '../escape', 'a/b', '-flag', '.hidden']) {
      expect(
        recordStoredConversation({ layout: 'goose-sessions', recordRoot: bundleDir, agentConversationId: id }),
      ).toBe(false);
      expect(
        findStoredConversation({
          stateDir: gooseDir,
          layout: 'goose-sessions',
          recordRoot: bundleDir,
          agentConversationId: id,
        }),
      ).toEqual({
        stored: false,
      });
    }
    expect(existsSync(join(bundleDir, CONVERSATION_RECORDS_DIR_NAME))).toBe(false);
  });
});

// ── PTY start-script environment ─────────────────────────────────────

describe('buildPtyConversationEnv', () => {
  const SESSION_ID = '5f0c8a3e-1b2d-4c6e-9f80-a1b2c3d4e5f6';

  function stateConfig(overrides: Partial<ConversationStateConfig>): ConversationStateConfig {
    return {
      hostDirName: 'state',
      containerMountPath: '/home/codespace/.state/',
      seed: [],
      resumeFlags: [],
      transcriptLayout: 'claude-projects',
      ...overrides,
    };
  }

  it('Claude Code: passes --continue on resume only', () => {
    const config = stateConfig({ resumeFlags: ['--continue'] });
    expect(buildPtyConversationEnv({ stateDir, stateConfig: config, sessionId: SESSION_ID, resume: false })).toEqual(
      {},
    );
    expect(buildPtyConversationEnv({ stateDir, stateConfig: config, sessionId: SESSION_ID, resume: true })).toEqual({
      IRONCURTAIN_RESUME_FLAGS: '--continue',
    });
  });

  it('Goose: always names the session after the IronCurtain session, and resumes it on resume', () => {
    const config = stateConfig({ resumeFlags: ['--resume'], transcriptLayout: 'goose-sessions' });
    expect(buildPtyConversationEnv({ stateDir, stateConfig: config, sessionId: SESSION_ID, resume: false })).toEqual({
      IRONCURTAIN_SESSION_NAME: SESSION_ID,
    });
    expect(buildPtyConversationEnv({ stateDir, stateConfig: config, sessionId: SESSION_ID, resume: true })).toEqual({
      IRONCURTAIN_SESSION_NAME: SESSION_ID,
      IRONCURTAIN_RESUME_FLAGS: '--resume',
    });
    expect(() =>
      buildPtyConversationEnv({ stateDir, stateConfig: config, sessionId: '--resume', resume: false }),
    ).toThrow(/Invalid session name/);
  });

  it('Codex: resumes the most recently active thread by id, never --last', () => {
    const codexDir = join(root, 'codex-state');
    const config = stateConfig({ transcriptLayout: 'codex-rollouts' });
    mkdirSync(join(codexDir, 'sessions'), { recursive: true });
    expect(
      buildPtyConversationEnv({ stateDir: codexDir, stateConfig: config, sessionId: SESSION_ID, resume: true }),
    ).toEqual({});

    writeRollout(codexDir, THREAD_A);
    expect(
      buildPtyConversationEnv({ stateDir: codexDir, stateConfig: config, sessionId: SESSION_ID, resume: false }),
    ).toEqual({});
    expect(
      buildPtyConversationEnv({ stateDir: codexDir, stateConfig: config, sessionId: SESSION_ID, resume: true }),
    ).toEqual({
      IRONCURTAIN_RESUME_ID: THREAD_A,
    });
  });

  it('rejects a resume flag the start scripts could not expand safely', () => {
    for (const flag of ['--continue; rm -rf /', '-c', '--Continue', '$(id)']) {
      expect(() =>
        buildPtyConversationEnv({
          stateDir,
          stateConfig: stateConfig({ resumeFlags: [flag] }),
          sessionId: SESSION_ID,
          resume: true,
        }),
      ).toThrow(/Invalid resume flag/);
    }
  });
});

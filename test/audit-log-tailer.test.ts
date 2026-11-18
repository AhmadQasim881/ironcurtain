/**
 * Tests for AuditLogTailer: incremental JSONL file reading,
 * offset tracking, diagnostic event emission, and preview building; line-exact
 * reads across appends still in progress and the start offset (WP-83).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock watchFile/unwatchFile to prevent real filesystem watchers in tests.
// All other node:fs functions remain as real implementations.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
  };
});

import { watchFile, unwatchFile } from 'node:fs';
import { AuditLogTailer } from '../src/docker/audit-log-tailer.js';
import type { DiagnosticEvent } from '../src/session/types.js';
import type { AuditEntry } from '../src/types/audit.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    requestId: 'req-1',
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: { path: '/tmp/test.txt' },
    policyDecision: { status: 'allow', rule: 'default-allow', reason: 'safe read' },
    result: { status: 'success', content: 'hello' },
    durationMs: 5,
    ...overrides,
  };
}

function appendEntry(logPath: string, entry: AuditEntry): void {
  appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AuditLogTailer', () => {
  let tempDir: string;
  let logPath: string;
  let events: DiagnosticEvent[];
  let tailer: AuditLogTailer;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'audit-tailer-test-'));
    logPath = join(tempDir, 'audit.jsonl');
    events = [];
    tailer = new AuditLogTailer(logPath, (event) => events.push(event));
    vi.clearAllMocks();
  });

  afterEach(() => {
    tailer.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── readNewEntries() ─────────────────────────────────────────────────────

  describe('readNewEntries()', () => {
    it('returns silently if the log file does not exist', () => {
      tailer.readNewEntries();
      expect(events).toHaveLength(0);
    });

    it('emits nothing when there is no new data since the last read', () => {
      writeFileSync(logPath, JSON.stringify(makeEntry()) + '\n', 'utf-8');
      tailer.readNewEntries(); // consume the initial entry
      const countAfterFirst = events.length;

      tailer.readNewEntries(); // second call — same file size
      expect(events).toHaveLength(countAfterFirst); // no new events
    });

    it('emits a tool_call event for a valid JSONL entry', () => {
      writeFileSync(logPath, JSON.stringify(makeEntry()) + '\n', 'utf-8');
      tailer.readNewEntries();

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('tool_call');
    });

    it('formats toolName as "serverName.toolName"', () => {
      writeFileSync(
        logPath,
        JSON.stringify(makeEntry({ serverName: 'github', toolName: 'create_issue' })) + '\n',
        'utf-8',
      );
      tailer.readNewEntries();

      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev.toolName).toBe('github.create_issue');
    });

    it('includes the result status in the preview', () => {
      writeFileSync(logPath, JSON.stringify(makeEntry({ result: { status: 'denied' } })) + '\n', 'utf-8');
      tailer.readNewEntries();

      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev.preview).toMatch(/^\[denied\]/);
    });

    it('includes stringified arguments in the preview', () => {
      const entry = makeEntry({ arguments: { path: '/etc/hosts' } });
      writeFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
      tailer.readNewEntries();

      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev.preview).toContain('/etc/hosts');
    });

    it('does not truncate preview when args JSON is 80 chars or fewer', () => {
      // Craft args whose JSON serialization is exactly short
      const entry = makeEntry({ arguments: { k: 'v' } });
      writeFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
      tailer.readNewEntries();

      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev.preview).not.toContain('...');
    });

    it('truncates preview to 80 chars and appends "..." when args JSON is long', () => {
      // Build args whose JSON is > 80 characters
      const longValue = 'x'.repeat(100);
      const entry = makeEntry({ arguments: { data: longValue } });
      const argsJson = JSON.stringify(entry.arguments);
      expect(argsJson.length).toBeGreaterThan(80);

      writeFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
      tailer.readNewEntries();

      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      // Preview format: "[status] <first-80-chars>..."
      const argsPartOfPreview = ev.preview.replace(/^\[\w+\] /, '');
      expect(argsPartOfPreview).toHaveLength(83); // 80 chars + '...'
      expect(argsPartOfPreview.endsWith('...')).toBe(true);
      expect(argsPartOfPreview.slice(0, 80)).toBe(argsJson.slice(0, 80));
    });

    it('silently skips malformed JSON lines', () => {
      writeFileSync(logPath, 'not-valid-json\n', 'utf-8');
      expect(() => tailer.readNewEntries()).not.toThrow();
      expect(events).toHaveLength(0);
    });

    it('skips malformed lines and continues processing valid entries', () => {
      const valid = makeEntry({ toolName: 'list_dir' });
      writeFileSync(logPath, 'bad-json\n' + JSON.stringify(valid) + '\n', 'utf-8');
      tailer.readNewEntries();

      expect(events).toHaveLength(1);
      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev.toolName).toContain('list_dir');
    });

    it('processes multiple entries appended in a single write', () => {
      const entry1 = makeEntry({ toolName: 'read_file' });
      const entry2 = makeEntry({ toolName: 'write_file' });
      writeFileSync(logPath, JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n', 'utf-8');
      tailer.readNewEntries();

      expect(events).toHaveLength(2);
    });

    it('tracks file offset so previously-read entries are not re-emitted', () => {
      const entry1 = makeEntry({ toolName: 'read_file' });
      writeFileSync(logPath, JSON.stringify(entry1) + '\n', 'utf-8');
      tailer.readNewEntries();
      expect(events).toHaveLength(1);

      // Append a second entry
      const entry2 = makeEntry({ toolName: 'write_file' });
      appendEntry(logPath, entry2);
      tailer.readNewEntries();

      // Total should be 2, not 3 (first entry not re-read)
      expect(events).toHaveLength(2);
      const ev2 = events[1] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev2.toolName).toContain('write_file');
    });

    it('accumulates offset across multiple incremental reads', () => {
      // Write three entries one at a time, reading after each
      for (let i = 0; i < 3; i++) {
        appendEntry(logPath, makeEntry({ toolName: `tool_${i}` }));
        tailer.readNewEntries();
      }
      expect(events).toHaveLength(3);
    });

    it('reports outcomes only: the write-ahead dispatching record emits no event', () => {
      // The pipeline appends a `dispatching` record before it forwards an
      // allowed call and the outcome record once the call settles. Consumers
      // keep seeing one diagnostic per tool call.
      appendEntry(logPath, makeEntry({ requestId: 'req-9', result: { status: 'dispatching' }, durationMs: 0 }));
      tailer.readNewEntries();
      expect(events).toHaveLength(0);

      appendEntry(logPath, makeEntry({ requestId: 'req-9', result: { status: 'success' } }));
      tailer.readNewEntries();
      expect(events).toHaveLength(1);
      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev.preview).toMatch(/^\[success\]/);
    });
  });

  // ── Line-exact reads (WP-83, GAP4-7) ────────────────────────────────────

  describe('entries split across reads', () => {
    function toolNames(): string[] {
      return events.map((ev) => (ev.kind === 'tool_call' ? ev.toolName : ev.kind));
    }

    it('completes an entry whose append was still in progress at the previous read', () => {
      const line = JSON.stringify(makeEntry({ toolName: 'split_tool' })) + '\n';
      const cut = Math.floor(line.length / 2);
      appendFileSync(logPath, line.slice(0, cut), 'utf-8');
      tailer.readNewEntries();
      expect(events).toHaveLength(0);

      appendFileSync(logPath, line.slice(cut), 'utf-8');
      tailer.readNewEntries();
      expect(toolNames()).toEqual(['filesystem.split_tool']);
    });

    it('completes an entry split over several reads, including inside a multi-byte character', () => {
      const line = Buffer.from(
        JSON.stringify(makeEntry({ toolName: 'utf8_tool', arguments: { text: 'héllo ✓ 世界' } })) + '\n',
      );
      const multiByte = line.indexOf(Buffer.from('✓')) + 1; // inside the 3-byte sequence
      const cuts = [5, multiByte, line.length - 1];
      let from = 0;
      for (const cut of cuts) {
        appendFileSync(logPath, line.subarray(from, cut));
        tailer.readNewEntries();
        expect(events).toHaveLength(0);
        from = cut;
      }
      appendFileSync(logPath, line.subarray(from));
      tailer.readNewEntries();

      expect(toolNames()).toEqual(['filesystem.utf8_tool']);
      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev.preview).toContain('héllo ✓ 世界');
    });

    it('reports the complete entries of a read and keeps the unfinished one for the next', () => {
      const first = JSON.stringify(makeEntry({ toolName: 'first' })) + '\n';
      const second = JSON.stringify(makeEntry({ toolName: 'second' })) + '\n';
      appendFileSync(logPath, first + second.slice(0, 10), 'utf-8');
      tailer.readNewEntries();
      expect(toolNames()).toEqual(['filesystem.first']);

      appendFileSync(logPath, second.slice(10), 'utf-8');
      tailer.readNewEntries();
      expect(toolNames()).toEqual(['filesystem.first', 'filesystem.second']);
    });

    it('reads a backlog larger than one read chunk without losing entries at chunk boundaries', () => {
      // ~2.5 MiB of entries of varying length: several 1 MiB chunks, with
      // entries straddling every chunk boundary.
      const lines: string[] = [];
      let bytes = 0;
      for (let i = 0; bytes < 2.5 * 1024 * 1024; i++) {
        const line = JSON.stringify(makeEntry({ toolName: `tool_${i}`, arguments: { pad: 'p'.repeat(i % 977) } }));
        lines.push(line + '\n');
        bytes += line.length + 1;
      }
      writeFileSync(logPath, lines.join(''), 'utf-8');

      tailer.readNewEntries();

      expect(events).toHaveLength(lines.length);
      expect(toolNames()).toEqual(lines.map((_line, i) => `filesystem.tool_${i}`));
    });

    it('skips a line longer than maxLineBytes without buffering it, then resumes with the next line', () => {
      const small = new AuditLogTailer(logPath, (event) => events.push(event), { maxLineBytes: 2048 });
      const huge = JSON.stringify(makeEntry({ toolName: 'huge', arguments: { blob: 'x'.repeat(10_000) } })) + '\n';
      appendFileSync(logPath, huge.slice(0, 3000), 'utf-8');
      small.readNewEntries();
      appendFileSync(logPath, huge.slice(3000), 'utf-8');
      appendEntry(logPath, makeEntry({ toolName: 'after' }));
      small.readNewEntries();

      expect(toolNames()).toEqual(['filesystem.after']);
    });

    it('skips an over-long line that arrives complete in one read', () => {
      const small = new AuditLogTailer(logPath, (event) => events.push(event), { maxLineBytes: 2048 });
      appendEntry(logPath, makeEntry({ toolName: 'huge', arguments: { blob: 'x'.repeat(10_000) } }));
      appendEntry(logPath, makeEntry({ toolName: 'after' }));
      small.readNewEntries();

      expect(toolNames()).toEqual(['filesystem.after']);
    });

    it('starts over at offset 0 when the log is truncated', () => {
      appendEntry(logPath, makeEntry({ toolName: 'before' }));
      appendEntry(logPath, makeEntry({ toolName: 'before_too' }));
      tailer.readNewEntries();
      expect(events).toHaveLength(2);

      writeFileSync(logPath, JSON.stringify(makeEntry({ toolName: 'after_truncate' })) + '\n', 'utf-8');
      tailer.readNewEntries();

      expect(toolNames()).toEqual(['filesystem.before', 'filesystem.before_too', 'filesystem.after_truncate']);
    });

    it('never throws when the log path is unreadable as a file', () => {
      mkdirSync(logPath);
      expect(() => tailer.readNewEntries()).not.toThrow();
      expect(events).toHaveLength(0);
    });
  });

  describe('startOffset', () => {
    it("'end' reports only entries appended after the tailer was created", () => {
      // A borrowed workflow bundle's log (or a resumed session's) already
      // holds earlier sessions' entries.
      appendEntry(logPath, makeEntry({ toolName: 'earlier_state_1' }));
      appendEntry(logPath, makeEntry({ toolName: 'earlier_state_2' }));
      const fromEnd = new AuditLogTailer(logPath, (event) => events.push(event), { startOffset: 'end' });

      fromEnd.readNewEntries();
      expect(events).toHaveLength(0);

      appendEntry(logPath, makeEntry({ toolName: 'mine' }));
      fromEnd.readNewEntries();
      expect(events.map((ev) => (ev.kind === 'tool_call' ? ev.toolName : ev.kind))).toEqual(['filesystem.mine']);
    });

    it("'end' on a log that does not exist yet reports everything written to it", () => {
      const fromEnd = new AuditLogTailer(logPath, (event) => events.push(event), { startOffset: 'end' });
      appendEntry(logPath, makeEntry({ toolName: 'first_call' }));
      fromEnd.readNewEntries();
      expect(events).toHaveLength(1);
    });

    it("'end' inside an entry still being written skips that entry and reports the next", () => {
      const earlier = JSON.stringify(makeEntry({ toolName: 'earlier' })) + '\n';
      appendFileSync(logPath, earlier.slice(0, 20), 'utf-8');
      const fromEnd = new AuditLogTailer(logPath, (event) => events.push(event), { startOffset: 'end' });

      appendFileSync(logPath, earlier.slice(20), 'utf-8');
      appendEntry(logPath, makeEntry({ toolName: 'mine' }));
      fromEnd.readNewEntries();

      expect(events.map((ev) => (ev.kind === 'tool_call' ? ev.toolName : ev.kind))).toEqual(['filesystem.mine']);
    });

    it('a numeric offset at a line start reports from that line; inside a line, from the next', () => {
      const first = JSON.stringify(makeEntry({ toolName: 'first' })) + '\n';
      appendFileSync(logPath, first, 'utf-8');
      appendEntry(logPath, makeEntry({ toolName: 'second' }));
      appendEntry(logPath, makeEntry({ toolName: 'third' }));

      const atLine: DiagnosticEvent[] = [];
      new AuditLogTailer(logPath, (event) => atLine.push(event), { startOffset: first.length }).readNewEntries();
      expect(atLine.map((ev) => (ev.kind === 'tool_call' ? ev.toolName : ev.kind))).toEqual([
        'filesystem.second',
        'filesystem.third',
      ]);

      const inLine: DiagnosticEvent[] = [];
      new AuditLogTailer(logPath, (event) => inLine.push(event), { startOffset: first.length + 5 }).readNewEntries();
      expect(inLine.map((ev) => (ev.kind === 'tool_call' ? ev.toolName : ev.kind))).toEqual(['filesystem.third']);
    });

    it('rejects a negative or fractional offset', () => {
      expect(() => new AuditLogTailer(logPath, () => {}, { startOffset: -1 })).toThrow(RangeError);
      expect(() => new AuditLogTailer(logPath, () => {}, { startOffset: 1.5 })).toThrow(RangeError);
    });

    it('an offset past the end of the log starts over at 0, even when the log has grown past it by the first read', () => {
      appendEntry(logPath, makeEntry({ toolName: 'first' }));
      const pastEnd = new AuditLogTailer(logPath, (event) => events.push(event), { startOffset: 300 });
      // The log grows past the requested offset before anything is read:
      // offset 300 now falls inside an entry, which must not be read from there.
      appendEntry(logPath, makeEntry({ toolName: 'second', arguments: { pad: 'p'.repeat(200) } }));
      appendEntry(logPath, makeEntry({ toolName: 'third' }));
      pastEnd.readNewEntries();

      expect(events.map((ev) => (ev.kind === 'tool_call' ? ev.toolName : ev.kind))).toEqual([
        'filesystem.first',
        'filesystem.second',
        'filesystem.third',
      ]);
    });
  });

  // ── start() / stop() ─────────────────────────────────────────────────────

  describe('start()', () => {
    it('registers a watchFile listener on the log path', () => {
      tailer.start();
      expect(watchFile).toHaveBeenCalledOnce();
      const [path] = (watchFile as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
      expect(path).toBe(logPath);
    });

    it('passes a callback to watchFile', () => {
      tailer.start();
      const args = (watchFile as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      const callback = args[args.length - 1];
      expect(typeof callback).toBe('function');
    });
  });

  describe('stop()', () => {
    it('calls unwatchFile on the log path after start()', () => {
      tailer.start();
      tailer.stop();
      expect(unwatchFile).toHaveBeenCalledOnce();
      const [path] = (unwatchFile as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
      expect(path).toBe(logPath);
    });

    it('does nothing if called before start()', () => {
      tailer.stop(); // not watching yet
      expect(unwatchFile).not.toHaveBeenCalled();
    });

    it('is idempotent — a second stop() does not call unwatchFile again', () => {
      tailer.start();
      tailer.stop();
      tailer.stop();
      expect(unwatchFile).toHaveBeenCalledOnce();
    });

    it('removes only its own listener, so another tailer of the same log keeps watching', () => {
      // Workflow fan-out lanes share one bundle audit log; closing one lane's
      // session must not stop the others' tailers.
      const other = new AuditLogTailer(logPath, () => {});
      tailer.start();
      other.start();
      tailer.stop();

      const watchCalls = (watchFile as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const ownListener = watchCalls[0][watchCalls[0].length - 1];
      expect(unwatchFile).toHaveBeenCalledExactlyOnceWith(logPath, ownListener);
      expect(ownListener).not.toBe(watchCalls[1][watchCalls[1].length - 1]);
      other.stop();
    });

    it('start() twice registers one listener', () => {
      tailer.start();
      tailer.start();
      expect(watchFile).toHaveBeenCalledOnce();
    });
  });
});

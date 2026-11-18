/**
 * Tests for `MessageLog.readPage` (reverse, bounded page reader) and
 * `MessageLog.readEntryAt` (single-line fetch by location).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageLog, type MessageLogEntry } from '../src/workflow/message-log.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from './helpers/fifo.js';

const NO_LIMIT = { limit: 10_000, maxBytes: Number.MAX_SAFE_INTEGER };

function tsAt(i: number): string {
  return new Date(1_700_000_000_000 + i * 1000).toISOString();
}

function transition(i: number, state = `s${i}`): MessageLogEntry {
  return { type: 'state_transition', ts: tsAt(i), workflowId: 'wf', state, from: 'a', event: 'E' };
}

function sent(i: number, message: string): MessageLogEntry {
  return { type: 'agent_sent', ts: tsAt(i), workflowId: 'wf', state: 's', role: 'r', message };
}

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ironcurtain-msglog-page-'));
  logPath = join(dir, 'messages.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes lines (entries are serialized, strings verbatim) with a trailing newline unless told otherwise. */
function writeLines(lines: readonly (MessageLogEntry | string)[], trailingNewline = true): void {
  const text = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
  writeFileSync(logPath, trailingNewline ? text + '\n' : text);
}

describe('MessageLog.readPage', () => {
  it('returns an empty page when the log does not exist', async () => {
    await expect(new MessageLog(logPath).readPage({ limit: 10, maxBytes: 1024 })).resolves.toEqual({
      entries: [],
      hasMore: false,
    });
  });

  it('returns the newest `limit` entries first and reports older ones', async () => {
    writeLines(Array.from({ length: 10 }, (_, i) => transition(i)));
    const page = await new MessageLog(logPath).readPage({ limit: 3, maxBytes: 1024 * 1024 });
    expect(page.entries.map((e) => e.entry.ts)).toEqual([tsAt(9), tsAt(8), tsAt(7)]);
    expect(page.hasMore).toBe(true);
  });

  it('reports hasMore=false when the page holds everything', async () => {
    writeLines([transition(0), transition(1)]);
    const page = await new MessageLog(logPath).readPage({ limit: 5, maxBytes: 1024 * 1024 });
    expect(page.entries).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it('applies the before cursor strictly', async () => {
    writeLines([transition(0), transition(1), transition(1, 'dup'), transition(2)]);
    const page = await new MessageLog(logPath).readPage({ before: tsAt(1), limit: 10, maxBytes: 1024 * 1024 });
    expect(page.entries.map((e) => e.entry.ts)).toEqual([tsAt(0)]);
    expect(page.hasMore).toBe(false);
  });

  it('does not count equal-ts entries as more, matching the cursor semantics', async () => {
    writeLines([transition(0), transition(2, 'a'), transition(2, 'b'), transition(2, 'c')]);
    const log = new MessageLog(logPath);
    // The page fills at two entries, but the third shares the oldest
    // timestamp: the next cursor (`before` = that ts) would skip it, so it
    // stays on this page. Only the strictly older tsAt(0) makes hasMore true.
    const first = await log.readPage({ limit: 2, maxBytes: 1024 * 1024 });
    expect(first.entries.map((e) => e.entry.state)).toEqual(['c', 'b', 'a']);
    expect(first.hasMore).toBe(true);
    const next = await log.readPage({ before: tsAt(2), limit: 2, maxBytes: 1024 * 1024 });
    expect(next.entries.map((e) => e.entry.ts)).toEqual([tsAt(0)]);
    expect(next.hasMore).toBe(false);
    // Without a strictly older entry a full page of equal timestamps is final.
    writeLines([transition(2, 'a'), transition(2, 'b'), transition(2, 'c')]);
    const second = await log.readPage({ limit: 2, maxBytes: 1024 * 1024 });
    expect(second.entries).toHaveLength(3);
    expect(second.hasMore).toBe(false);
  });

  it('keeps every entry across a byte-budget page boundary that splits a timestamp', async () => {
    // Pairs of entries share a millisecond (as a transition logged right after
    // an agent message does). Whatever page boundary the byte budget picks,
    // paging through the cursor must return each entry exactly once.
    const entries: MessageLogEntry[] = [];
    for (let i = 0; i < 40; i++) {
      entries.push(sent(Math.floor(i / 2), `message ${i} `.padEnd(200 + ((i * 37) % 300), 'z')));
    }
    writeLines(entries);
    const log = new MessageLog(logPath);
    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = await log.readPage({ before, limit: 50, maxBytes: 1_000 });
      seen.push(...page.entries.map((e) => (e.entry.type === 'agent_sent' ? e.entry.message : '')));
      if (!page.hasMore) break;
      before = page.entries[page.entries.length - 1].entry.ts;
    }
    expect(seen.sort()).toEqual(entries.map((e) => (e.type === 'agent_sent' ? e.message : '')).sort());
  });

  it('bounds the entries a full page still takes for a shared timestamp', async () => {
    // 100 entries in one millisecond: the page takes `limit` plus a bounded
    // overflow, then reports more instead of growing without limit.
    writeLines([transition(0), ...Array.from({ length: 100 }, (_, i) => transition(1, `tie-${i}`))]);
    const page = await new MessageLog(logPath).readPage({ limit: 2, maxBytes: 1024 * 1024 });
    expect(page.entries.length).toBeGreaterThan(2);
    expect(page.entries.length).toBeLessThan(100);
    expect(page.hasMore).toBe(true);
  });

  it('reads the last line of a log without a trailing newline', async () => {
    writeLines([transition(0), transition(1)], false);
    const page = await new MessageLog(logPath).readPage(NO_LIMIT);
    expect(page.entries.map((e) => e.entry.ts)).toEqual([tsAt(1), tsAt(0)]);
  });

  it('skips blank, malformed and control lines', async () => {
    writeLines([
      JSON.stringify({ type: 'run_started', ts: tsAt(0), workflowId: 'wf', state: 's' }),
      transition(1),
      '',
      'not json at all',
      '{"type":"agent_sent"}',
      '[1,2,3]',
      JSON.stringify({ type: 'run_terminal', ts: tsAt(2), workflowId: 'wf', state: 's', phase: 'completed' }),
      transition(3),
    ]);
    const page = await new MessageLog(logPath).readPage(NO_LIMIT);
    expect(page.entries.map((e) => e.entry.ts)).toEqual([tsAt(3), tsAt(1)]);
  });

  it('sorts a page by ts even when the file order has small inversions', async () => {
    writeLines([transition(0), transition(2), transition(1), transition(3)]);
    const page = await new MessageLog(logPath).readPage(NO_LIMIT);
    expect(page.entries.map((e) => e.entry.ts)).toEqual([tsAt(3), tsAt(2), tsAt(1), tsAt(0)]);
  });

  it('locates every line exactly across chunk boundaries', async () => {
    // ~700-byte lines x 400 = ~280 KiB: several 64 KiB chunks, lines straddling them.
    const entries = Array.from({ length: 400 }, (_, i) => sent(i, `m${i}-`.padEnd(650, 'x')));
    writeLines(entries);
    const bytes = readFileSync(logPath);
    const page = await new MessageLog(logPath).readPage(NO_LIMIT);
    expect(page.entries).toHaveLength(400);
    for (const located of page.entries) {
      const line = bytes.subarray(located.offset, located.offset + located.length);
      expect(JSON.parse(line.toString('utf-8'))).toEqual(located.entry);
      expect(bytes[located.offset + located.length]).toBe(0x0a);
      expect(located.offset === 0 || bytes[located.offset - 1] === 0x0a).toBe(true);
    }
  });

  it('applies the byte budget but always returns at least one entry', async () => {
    writeLines(Array.from({ length: 5 }, (_, i) => sent(i, 'y'.repeat(1000))));
    const lineBytes = Buffer.byteLength(JSON.stringify(sent(4, 'y'.repeat(1000))));
    const log = new MessageLog(logPath);
    const tiny = await log.readPage({ limit: 10, maxBytes: 1 });
    expect(tiny.entries.map((e) => e.entry.ts)).toEqual([tsAt(4)]);
    expect(tiny.hasMore).toBe(true);
    const two = await log.readPage({ limit: 10, maxBytes: 2 * lineBytes + 10 });
    expect(two.entries.map((e) => e.entry.ts)).toEqual([tsAt(4), tsAt(3)]);
    expect(two.hasMore).toBe(true);
  });

  it('charges entries what `measure` says, so cut entries fill a page by their cut size', async () => {
    writeLines(Array.from({ length: 6 }, (_, i) => sent(i, 'y'.repeat(5000))));
    const measure = vi.fn<(entry: MessageLogEntry, lineBytes: number) => number>(() => 100);
    const page = await new MessageLog(logPath).readPage({ limit: 10, maxBytes: 350, measure });
    // 5 KB lines, but each costs 100: three fit 350.
    expect(page.entries.map((e) => e.entry.ts)).toEqual([tsAt(5), tsAt(4), tsAt(3)]);
    expect(page.hasMore).toBe(true);
    expect(measure.mock.calls[0][1]).toBe(Buffer.byteLength(JSON.stringify(sent(5, 'y'.repeat(5000)))));
  });

  it('stops a page once maxScanBytes of candidate lines have been read', async () => {
    writeLines(Array.from({ length: 6 }, (_, i) => sent(i, 'y'.repeat(5000))));
    const lineBytes = Buffer.byteLength(JSON.stringify(sent(5, 'y'.repeat(5000))));
    const page = await new MessageLog(logPath).readPage({
      limit: 10,
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxScanBytes: 2 * lineBytes + 10,
      measure: () => 1,
    });
    expect(page.entries.map((e) => e.entry.ts)).toEqual([tsAt(5), tsAt(4)]);
    expect(page.hasMore).toBe(true);
  });

  it.skipIf(!fifoSupported)('returns an empty page for a FIFO at the log path without blocking', async () => {
    makeFifo(logPath);
    const unblocker = startFifoUnblocker(logPath);
    const started = Date.now();
    try {
      await expect(new MessageLog(logPath).readPage(NO_LIMIT)).resolves.toEqual({ entries: [], hasMore: false });
      await expect(new MessageLog(logPath).readEntryAt(0, 10, 1024)).resolves.toBeUndefined();
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('skips a line larger than the scan cap and still returns the others', async () => {
    const giant = sent(1, 'g'.repeat(17 * 1024 * 1024));
    writeLines([transition(0), giant, transition(2)]);
    const page = await new MessageLog(logPath).readPage(NO_LIMIT);
    expect(page.entries.map((e) => e.entry.ts)).toEqual([tsAt(2), tsAt(0)]);
    expect(page.hasMore).toBe(false);
  }, 30_000);
});

describe('MessageLog.readEntryAt', () => {
  it('returns the entry at a location from readPage', async () => {
    writeLines([transition(0), sent(1, 'hello'), transition(2)]);
    const log = new MessageLog(logPath);
    const page = await log.readPage(NO_LIMIT);
    const located = page.entries.find((e) => e.entry.type === 'agent_sent');
    expect(located).toBeDefined();
    if (!located) return;
    await expect(log.readEntryAt(located.offset, located.length, 1024)).resolves.toEqual(sent(1, 'hello'));
  });

  it('refuses ranges that are not exactly one entry line', async () => {
    writeLines([transition(0), sent(1, 'hello'), transition(2)]);
    const log = new MessageLog(logPath);
    const page = await log.readPage(NO_LIMIT);
    const located = page.entries.find((e) => e.entry.type === 'agent_sent');
    if (!located) throw new Error('fixture entry missing');
    // Off by one at either end, a sub-range, a span over two lines, and past EOF.
    await expect(log.readEntryAt(located.offset + 1, located.length, 1024)).resolves.toBeUndefined();
    await expect(log.readEntryAt(located.offset, located.length - 1, 1024)).resolves.toBeUndefined();
    await expect(log.readEntryAt(located.offset + 2, located.length - 4, 1024)).resolves.toBeUndefined();
    await expect(log.readEntryAt(0, located.offset + located.length, 4096)).resolves.toBeUndefined();
    await expect(log.readEntryAt(located.offset, 100_000, 1_000_000)).resolves.toBeUndefined();
  });

  it('refuses lengths above the cap and non-integer or negative locations', async () => {
    writeLines([sent(0, 'hello')]);
    const log = new MessageLog(logPath);
    const page = await log.readPage(NO_LIMIT);
    const { offset, length } = page.entries[0];
    await expect(log.readEntryAt(offset, length, length - 1)).resolves.toBeUndefined();
    await expect(log.readEntryAt(-1, length, 1024)).resolves.toBeUndefined();
    await expect(log.readEntryAt(0.5, length, 1024)).resolves.toBeUndefined();
    await expect(log.readEntryAt(offset, 0, 1024)).resolves.toBeUndefined();
  });

  it('returns undefined for a missing log or a control record', async () => {
    await expect(new MessageLog(logPath).readEntryAt(0, 10, 1024)).resolves.toBeUndefined();
    const control = JSON.stringify({ type: 'run_started', ts: tsAt(0), workflowId: 'wf', state: 's' });
    writeLines([control]);
    await expect(new MessageLog(logPath).readEntryAt(0, control.length, 1024)).resolves.toBeUndefined();
  });
});

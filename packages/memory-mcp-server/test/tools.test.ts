import { describe, it, expect, vi } from 'vitest';
import type { MemoryEngine } from '../src/engine.js';
import { validateStoreInput, handleStore, formatStoreResult } from '../src/tools/store.js';
import { validateRecallInput, handleRecall } from '../src/tools/recall.js';
import { validateExpandInput, handleExpand, passageRangeNote } from '../src/tools/expand.js';
import { validateContextInput, handleContext } from '../src/tools/context.js';
import { validateForgetInput, handleForget } from '../src/tools/forget.js';
import { validateInspectInput, handleInspect } from '../src/tools/inspect.js';
import { MEMORY_NOTES_NOTICE, frameMemoryNotes } from '../src/utils/framing.js';

function createMockEngine(overrides: Partial<MemoryEngine> = {}): MemoryEngine {
  return {
    store: vi.fn().mockResolvedValue({ id: 'abc123', action: 'created' }),
    ingest: vi.fn().mockResolvedValue({
      created: 1,
      merged: 0,
      memory_ids: ['abc123'],
      facts: [{ fact: 'A fact', importance: 0.5 }],
    }),
    recall: vi.fn().mockResolvedValue({
      content: 'Recalled content',
      memories_used: 3,
      total_matches: 10,
    }),
    context: vi.fn().mockResolvedValue('## Memory Briefing\n\nSome context here.'),
    forget: vi.fn().mockResolvedValue({ forgotten: 2 }),
    inspect: vi.fn().mockResolvedValue({
      total_memories: 100,
      active_memories: 80,
      decayed_memories: 15,
      compacted_memories: 5,
      oldest_memory: '2025-01-01T00:00:00Z',
      newest_memory: '2026-03-11T00:00:00Z',
      storage_bytes: 1048576,
      top_tags: [{ tag: 'preference', count: 42 }],
    }),
    expand: vi.fn().mockResolvedValue({
      segment_id: 'seg-1',
      passages: ['Source passage one.', 'Source passage two.'],
      total_passages: 2,
      found: true,
    }),
    close: vi.fn(),
    ...overrides,
  };
}

// ── memory_store validation ──────────────────────────────────────────

describe('memory_store', () => {
  describe('validateStoreInput', () => {
    it('accepts valid content only', () => {
      const result = validateStoreInput({ content: 'User likes dark mode' });
      expect(result.content).toBe('User likes dark mode');
      expect(result.tags).toBeUndefined();
      expect(result.importance).toBeUndefined();
    });

    it('accepts content with tags and importance', () => {
      const result = validateStoreInput({
        content: 'A fact',
        tags: ['pref', 'ui'],
        importance: 0.8,
      });
      expect(result.tags).toEqual(['pref', 'ui']);
      expect(result.importance).toBe(0.8);
    });

    it('trims content whitespace', () => {
      const result = validateStoreInput({ content: '  trimmed  ' });
      expect(result.content).toBe('trimmed');
    });

    it('rejects missing content', () => {
      expect(() => validateStoreInput({})).toThrow('content is required');
    });

    it('rejects empty content', () => {
      expect(() => validateStoreInput({ content: '   ' })).toThrow('content is required');
    });

    it('rejects non-string content', () => {
      expect(() => validateStoreInput({ content: 42 })).toThrow('content is required');
    });

    it('rejects non-array tags', () => {
      expect(() => validateStoreInput({ content: 'ok', tags: 'not-array' })).toThrow('tags must be an array');
    });

    it('rejects tags with non-string elements', () => {
      expect(() => validateStoreInput({ content: 'ok', tags: [1, 2] })).toThrow('tags must be an array of strings');
    });

    it('stores importance above 0.8 as 0.8', () => {
      expect(validateStoreInput({ content: 'ok', importance: 1 }).importance).toBe(0.8);
      expect(validateStoreInput({ content: 'ok', importance: 0.95 }).importance).toBe(0.8);
      expect(validateStoreInput({ content: 'ok', importance: 0.3 }).importance).toBe(0.3);
    });

    it('rejects content that contains a secret value', () => {
      expect(() => validateStoreInput({ content: 'Token ghp_abcdefghijklmnopqrstuvwxyz0123456789' })).toThrow(
        'content appears to contain an API key or token',
      );
    });

    it('rejects importance out of range', () => {
      expect(() => validateStoreInput({ content: 'ok', importance: 1.5 })).toThrow(
        'importance must be a number between 0 and 1',
      );
    });

    it('rejects negative importance', () => {
      expect(() => validateStoreInput({ content: 'ok', importance: -0.1 })).toThrow(
        'importance must be a number between 0 and 1',
      );
    });
  });

  describe('formatStoreResult', () => {
    it('formats created result', () => {
      expect(formatStoreResult({ id: 'x', action: 'created' })).toBe('Stored memory x');
    });

    it('formats merged_duplicate result', () => {
      expect(formatStoreResult({ id: 'x', action: 'merged_duplicate' })).toContain('duplicate');
    });

    it('formats contradiction_resolved result', () => {
      expect(formatStoreResult({ id: 'x', action: 'contradiction_resolved' })).toContain('contradiction');
    });
  });

  describe('handleStore', () => {
    it('calls engine.store with correct args', async () => {
      const engine = createMockEngine();
      await handleStore(engine, {
        content: 'fact',
        tags: ['a'],
        importance: 0.7,
      });
      expect(engine.store).toHaveBeenCalledWith('fact', {
        tags: ['a'],
        importance: 0.7,
      });
    });

    it('returns formatted result', async () => {
      const engine = createMockEngine();
      const result = await handleStore(engine, { content: 'fact' });
      expect(result).toBe('Stored memory abc123');
    });
  });
});

// ── memory_recall validation ─────────────────────────────────────────

describe('memory_recall', () => {
  describe('validateRecallInput', () => {
    it('accepts query only', () => {
      const result = validateRecallInput({ query: 'testing preferences' });
      expect(result.query).toBe('testing preferences');
    });

    it('accepts all optional fields', () => {
      const result = validateRecallInput({
        query: 'q',
        token_budget: 200,
        tags: ['pref'],
        format: 'list',
      });
      expect(result.token_budget).toBe(200);
      expect(result.tags).toEqual(['pref']);
      expect(result.format).toBe('list');
    });

    it('rejects missing query', () => {
      expect(() => validateRecallInput({})).toThrow('query is required');
    });

    it('rejects empty query', () => {
      expect(() => validateRecallInput({ query: '' })).toThrow('query is required');
    });

    it('rejects non-integer token_budget', () => {
      expect(() => validateRecallInput({ query: 'q', token_budget: 1.5 })).toThrow(
        'token_budget must be a positive integer',
      );
    });

    it('rejects zero token_budget', () => {
      expect(() => validateRecallInput({ query: 'q', token_budget: 0 })).toThrow(
        'token_budget must be a positive integer',
      );
    });

    it('accepts answer format', () => {
      const result = validateRecallInput({ query: 'q', format: 'answer' });
      expect(result.format).toBe('answer');
    });

    it('rejects invalid format', () => {
      expect(() => validateRecallInput({ query: 'q', format: 'xml' })).toThrow('format must be one of');
    });

    it("defaults expand to 'auto'", () => {
      const result = validateRecallInput({ query: 'q' });
      expect(result.expand).toBe('auto');
    });

    it("accepts 'none' / 'auto' / 'parent' for expand", () => {
      expect(validateRecallInput({ query: 'q', expand: 'none' }).expand).toBe('none');
      expect(validateRecallInput({ query: 'q', expand: 'auto' }).expand).toBe('auto');
      expect(validateRecallInput({ query: 'q', expand: 'parent' }).expand).toBe('parent');
    });

    it('rejects an out-of-enum expand value', () => {
      expect(() => validateRecallInput({ query: 'q', expand: 'all' })).toThrow('expand must be one of');
      expect(() => validateRecallInput({ query: 'q', expand: 5 })).toThrow('expand must be one of');
    });

    it('validates max_expand_passages bounds', () => {
      expect(validateRecallInput({ query: 'q', max_expand_passages: 3 }).max_expand_passages).toBe(3);
      expect(validateRecallInput({ query: 'q' }).max_expand_passages).toBeUndefined();
      expect(() => validateRecallInput({ query: 'q', max_expand_passages: 0 })).toThrow(
        'max_expand_passages must be a positive integer',
      );
      expect(() => validateRecallInput({ query: 'q', max_expand_passages: 1.5 })).toThrow(
        'max_expand_passages must be a positive integer',
      );
      expect(() => validateRecallInput({ query: 'q', max_expand_passages: 999 })).toThrow(
        'max_expand_passages exceeds maximum',
      );
    });
  });

  describe('handleRecall', () => {
    it('calls engine.recall with correct args', async () => {
      const engine = createMockEngine();
      await handleRecall(engine, { query: 'test', format: 'raw' });
      // The second argument is the call controls (none when called outside an MCP request).
      expect(engine.recall).toHaveBeenCalledWith(
        {
          query: 'test',
          token_budget: undefined,
          tags: undefined,
          format: 'raw',
          expand: 'auto',
          max_expand_passages: undefined,
        },
        undefined,
      );
    });

    it('returns no-match message when empty', async () => {
      const engine = createMockEngine({
        recall: vi.fn().mockResolvedValue({
          content: '',
          memories_used: 0,
          total_matches: 0,
        }),
      });
      const result = await handleRecall(engine, { query: 'test' });
      expect(result.text).toBe('No relevant memories found.');
      expect(result.memories_used).toBe(0);
      expect(result.expanded).toBe(false);
      expect(result.expanded_segment_ids).toEqual([]);
    });

    it('returns content when memories found, framed as notes from earlier sessions', async () => {
      const engine = createMockEngine();
      const result = await handleRecall(engine, { query: 'test' });
      expect(result.text).toBe(frameMemoryNotes('Recalled content'));
    });

    it('wraps raw JSON output in an object that leads with the notice', async () => {
      const engine = createMockEngine({
        recall: vi.fn().mockResolvedValue({
          content: JSON.stringify([{ id: 'a', content: 'A fact' }]),
          memories_used: 1,
          total_matches: 1,
        }),
      });
      const result = await handleRecall(engine, { query: 'test', format: 'raw' });
      expect(JSON.parse(result.text)).toEqual({
        notice: MEMORY_NOTES_NOTICE,
        memories: [{ id: 'a', content: 'A fact' }],
      });
    });

    it('surfaces expansion metadata from the engine', async () => {
      const engine = createMockEngine({
        recall: vi.fn().mockResolvedValue({
          content: 'Recalled content',
          memories_used: 3,
          total_matches: 10,
          expanded: true,
          expanded_segment_ids: ['seg-1', 'seg-2'],
        }),
      });
      const result = await handleRecall(engine, { query: 'test' });
      expect(result.expanded).toBe(true);
      expect(result.expanded_segment_ids).toEqual(['seg-1', 'seg-2']);
      expect(result.total_matches).toBe(10);
    });

    it('threads expand and max_expand_passages through to the engine', async () => {
      const engine = createMockEngine();
      await handleRecall(engine, { query: 'test', expand: 'parent', max_expand_passages: 3 });
      expect(engine.recall).toHaveBeenCalledWith(
        {
          query: 'test',
          token_budget: undefined,
          tags: undefined,
          format: undefined,
          expand: 'parent',
          max_expand_passages: 3,
        },
        undefined,
      );
    });

    it('passes the call controls (cancellation signal) through to the engine', async () => {
      const engine = createMockEngine();
      const controls = { signal: new AbortController().signal };
      await handleRecall(engine, { query: 'test' }, controls);
      expect(engine.recall).toHaveBeenCalledWith(expect.objectContaining({ query: 'test' }), controls);
    });
  });
});

// ── memory_expand validation ─────────────────────────────────────────

describe('memory_expand', () => {
  describe('validateExpandInput', () => {
    it('accepts a segment_id', () => {
      expect(validateExpandInput({ segment_id: 'seg-1' })).toEqual({ segment_id: 'seg-1', query: undefined });
    });

    it('accepts an optional query', () => {
      const result = validateExpandInput({ segment_id: 'seg-1', query: 'cap clause' });
      expect(result.query).toBe('cap clause');
    });

    it('reads a blank query as no query (the start of the source)', () => {
      expect(validateExpandInput({ segment_id: 'seg-1', query: '   ' }).query).toBeUndefined();
      expect(validateExpandInput({ segment_id: 'seg-1', query: '' }).query).toBeUndefined();
    });

    it('rejects a missing/empty segment_id', () => {
      expect(() => validateExpandInput({})).toThrow('segment_id is required');
      expect(() => validateExpandInput({ segment_id: '  ' })).toThrow('segment_id is required');
    });

    it('accepts max_passages from 1 to 20 and rejects anything else', () => {
      expect(validateExpandInput({ segment_id: 'seg-1', max_passages: 1 }).max_passages).toBe(1);
      expect(validateExpandInput({ segment_id: 'seg-1', max_passages: 20 }).max_passages).toBe(20);
      expect(validateExpandInput({ segment_id: 'seg-1' }).max_passages).toBeUndefined();
      for (const bad of [0, -1, 2.5, '3', null]) {
        expect(() => validateExpandInput({ segment_id: 'seg-1', max_passages: bad })).toThrow(
          'max_passages must be a positive integer',
        );
      }
      expect(() => validateExpandInput({ segment_id: 'seg-1', max_passages: 21 })).toThrow(
        'max_passages exceeds maximum of 20',
      );
    });
  });

  describe('handleExpand', () => {
    it("returns the parent's ranked passages joined, then which of the source's passages they are", async () => {
      const engine = createMockEngine({
        expand: vi.fn().mockResolvedValue({
          segment_id: 'seg-1',
          passages: ['Cap clause: $250k.', 'IP clause: reverts.'],
          total_passages: 7,
          found: true,
        }),
      });
      const result = await handleExpand(engine, { segment_id: 'seg-1', query: 'cap', max_passages: 2 });
      expect(engine.expand).toHaveBeenCalledWith('seg-1', 'cap', 2);
      expect(result).toContain('$250k');
      expect(result).toContain('reverts');
      // The range note follows the framed passages: it is the server's, not stored text.
      expect(result.endsWith(`</memory_notes>\n${passageRangeNote(2, 7, true)}`)).toBe(true);
      expect(result).toContain('[passages 1-2 of 7 of this source, most relevant to the query first;');
    });

    it('passes no query and no passage count when the call gives none', async () => {
      const engine = createMockEngine();
      const result = await handleExpand(engine, { segment_id: 'seg-1', query: ' ' });
      expect(engine.expand).toHaveBeenCalledWith('seg-1', undefined, undefined);
      expect(result).toContain('[passages 1-2 of 2: the whole source, in source order]');
    });

    it('reports not-found for an unknown segment id', async () => {
      const engine = createMockEngine({
        expand: vi.fn().mockResolvedValue({ segment_id: 'nope', passages: [], total_passages: 0, found: false }),
      });
      const result = await handleExpand(engine, { segment_id: 'nope' });
      expect(result).toContain('No source segment found');
    });
  });

  describe('passageRangeNote', () => {
    it('says which passages of how many were shown, in what order, and how to get the rest', () => {
      expect(passageRangeNote(3, 20, false)).toBe(
        '[passages 1-3 of 20 of this source, in source order; pass a query to get the passages most relevant ' +
          'to it, or raise max_passages (at most 20) to read further]',
      );
      expect(passageRangeNote(3, 20, true)).toBe(
        '[passages 1-3 of 20 of this source, most relevant to the query first; raise max_passages (at most 20) ' +
          'to see more]',
      );
    });

    it('says when the whole source was shown', () => {
      expect(passageRangeNote(4, 4, false)).toBe('[passages 1-4 of 4: the whole source, in source order]');
      expect(passageRangeNote(1, 1, true)).toBe('[passage 1 of 1: the whole source, most relevant to the query first]');
    });

    it('does not offer a larger max_passages when the most was already shown', () => {
      expect(passageRangeNote(20, 26, false)).toBe(
        '[passages 1-20 of 26 of this source, in source order; pass a query to get the passages most relevant to it]',
      );
      expect(passageRangeNote(20, 26, true)).toBe(
        '[passages 1-20 of 26 of this source, most relevant to the query first]',
      );
    });
  });
});

// ── memory_context validation ────────────────────────────────────────

describe('memory_context', () => {
  describe('validateContextInput', () => {
    it('accepts empty args', () => {
      const result = validateContextInput({});
      expect(result.task).toBeUndefined();
      expect(result.token_budget).toBeUndefined();
    });

    it('accepts task and token_budget', () => {
      const result = validateContextInput({
        task: 'Fix auth bug',
        token_budget: 1000,
      });
      expect(result.task).toBe('Fix auth bug');
      expect(result.token_budget).toBe(1000);
    });

    it('trims task whitespace', () => {
      const result = validateContextInput({ task: '  fix it  ' });
      expect(result.task).toBe('fix it');
    });

    it('rejects non-string task', () => {
      expect(() => validateContextInput({ task: 42 })).toThrow('task must be a string');
    });
  });

  describe('handleContext', () => {
    it('calls engine.context', async () => {
      const engine = createMockEngine();
      await handleContext(engine, { task: 'test' });
      expect(engine.context).toHaveBeenCalledWith(
        {
          task: 'test',
          token_budget: undefined,
        },
        undefined,
      );
    });

    it('returns fresh session message when empty', async () => {
      const engine = createMockEngine({
        context: vi.fn().mockResolvedValue(''),
      });
      const result = await handleContext(engine, {});
      expect(result).toContain('fresh session');
    });
  });
});

// ── memory_forget validation ─────────────────────────────────────────

describe('memory_forget', () => {
  describe('validateForgetInput', () => {
    it('accepts ids', () => {
      const result = validateForgetInput({ ids: ['a', 'b'] });
      expect(result.ids).toEqual(['a', 'b']);
    });

    it('accepts tags with confirm', () => {
      const result = validateForgetInput({
        tags: ['old'],
        confirm: true,
      });
      expect(result.tags).toEqual(['old']);
      expect(result.confirm).toBe(true);
    });

    it('accepts before timestamp', () => {
      const result = validateForgetInput({
        before: '2025-01-01T00:00:00Z',
        confirm: true,
      });
      expect(result.before).toBe('2025-01-01T00:00:00Z');
    });

    it('rejects no targeting criteria', () => {
      expect(() => validateForgetInput({})).toThrow('At least one of ids, tags, query, or before');
    });

    it('rejects invalid before timestamp', () => {
      expect(() => validateForgetInput({ before: 'not-a-date' })).toThrow('valid ISO 8601');
    });

    it('rejects non-array ids', () => {
      expect(() => validateForgetInput({ ids: 'single' })).toThrow('ids must be an array');
    });

    // With intersection semantics a dropped criterion would widen the deletion.
    it('rejects a whitespace-only query instead of ignoring it', () => {
      expect(() => validateForgetInput({ tags: ['old'], query: '   ' })).toThrow('query must be a non-empty string');
    });

    it('treats empty arrays as not provided', () => {
      expect(() => validateForgetInput({ ids: [], tags: [] })).toThrow('At least one of ids, tags, query, or before');
      expect(validateForgetInput({ ids: [], tags: ['old'] })).toMatchObject({ ids: undefined, tags: ['old'] });
    });
  });

  describe('handleForget', () => {
    it('requires confirmation for bulk operations', async () => {
      const engine = createMockEngine();
      const result = await handleForget(engine, { tags: ['old'] });
      expect(result).toContain('confirm=true');
      expect(engine.forget).not.toHaveBeenCalled();
    });

    it.each([{ tags: ['old'] }, { query: 'old notes' }, { before: '2025-01-01T00:00:00Z' }])(
      'requires confirmation for a bulk criterion even when ids are given (%o)',
      async (criterion) => {
        const engine = createMockEngine();
        const result = await handleForget(engine, { ids: ['abc'], ...criterion });
        expect(result).toContain('confirm=true');
        expect(engine.forget).not.toHaveBeenCalled();
      },
    );

    it('previews a bulk dry_run without confirm', async () => {
      const engine = createMockEngine({
        forget: vi.fn().mockResolvedValue({ forgotten: 1, memories: [{ id: 'a', content: 'Old memory' }] }),
      });
      const result = await handleForget(engine, { tags: ['old'], dry_run: true });
      expect(result).toBe(`Would forget 1 memories:\n${frameMemoryNotes('- a: Old memory')}`);
      expect(engine.forget).toHaveBeenCalledWith(expect.objectContaining({ tags: ['old'], dry_run: true }));
    });

    it('allows id-based deletion without confirm', async () => {
      const engine = createMockEngine();
      await handleForget(engine, { ids: ['abc'] });
      expect(engine.forget).toHaveBeenCalled();
    });

    it('formats dry_run preview', async () => {
      const engine = createMockEngine({
        forget: vi.fn().mockResolvedValue({
          forgotten: 2,
          memories: [
            { id: 'a', content: 'First memory' },
            { id: 'b', content: 'Second memory' },
          ],
        }),
      });
      const result = await handleForget(engine, {
        tags: ['old'],
        confirm: true,
        dry_run: true,
      });
      expect(result).toContain('Would forget 2');
      expect(result).toContain('First memory');
    });

    it('formats deletion count', async () => {
      const engine = createMockEngine();
      const result = await handleForget(engine, { ids: ['a'] });
      expect(result).toBe('Forgot 2 memories.');
    });
  });
});

// ── memory_inspect validation ────────────────────────────────────────

describe('memory_inspect', () => {
  describe('validateInspectInput', () => {
    it('accepts empty args (defaults to stats)', () => {
      const result = validateInspectInput({});
      expect(result.view).toBeUndefined();
    });

    it('accepts valid view', () => {
      const result = validateInspectInput({ view: 'recent', limit: 5 });
      expect(result.view).toBe('recent');
      expect(result.limit).toBe(5);
    });

    it('accepts ids', () => {
      const result = validateInspectInput({ ids: ['x', 'y'] });
      expect(result.ids).toEqual(['x', 'y']);
    });

    it('rejects invalid view', () => {
      expect(() => validateInspectInput({ view: 'invalid' })).toThrow('view must be one of');
    });

    it('rejects non-positive limit', () => {
      expect(() => validateInspectInput({ limit: 0 })).toThrow('limit must be a positive integer');
    });

    it('rejects non-integer limit', () => {
      expect(() => validateInspectInput({ limit: 2.5 })).toThrow('limit must be a positive integer');
    });
  });

  describe('handleInspect', () => {
    it('formats stats view', async () => {
      const engine = createMockEngine();
      const result = await handleInspect(engine, { view: 'stats' });
      expect(result).toContain('Memory Statistics');
      expect(result).toContain('Total memories: 100');
      expect(result).toContain('Active: 80');
      expect(result).toContain('preference: 42');
      expect(result).toContain('1.0 MB');
    });

    it('formats memory list', async () => {
      const engine = createMockEngine({
        inspect: vi.fn().mockResolvedValue([
          {
            id: 'mem1',
            namespace: 'default',
            content: 'User likes tests',
            tags: ['preference'],
            importance: 0.8,
            created_at: 1710000000000,
            updated_at: 1710000000000,
            last_accessed_at: 1710000000000,
            access_count: 3,
            is_compacted: false,
            compacted_from: null,
            source: null,
            metadata: null,
          },
        ]),
      });
      const result = await handleInspect(engine, { view: 'recent' });
      expect(result).toContain('mem1');
      expect(result).toContain('User likes tests');
      expect(result).toContain('preference');
    });

    it('formats empty memory list', async () => {
      const engine = createMockEngine({
        inspect: vi.fn().mockResolvedValue([]),
      });
      const result = await handleInspect(engine, { view: 'recent' });
      expect(result).toBe('No memories found.');
    });

    it('returns the export inside the notes frame', async () => {
      const engine = createMockEngine({
        inspect: vi.fn().mockResolvedValue('{"id":"a","content":"test"}\n'),
      });
      const result = await handleInspect(engine, { view: 'export' });
      expect(result).toBe(frameMemoryNotes('{"id":"a","content":"test"}\n'));
    });
  });
});

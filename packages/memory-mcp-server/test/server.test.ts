import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallControls, MemoryEngine } from '../src/engine.js';
import { TOOL_ANNOTATIONS, createServer } from '../src/server.js';
import { passageRangeNote } from '../src/tools/expand.js';
import { frameMemoryNotes } from '../src/utils/framing.js';

function createMockEngine(overrides: Partial<MemoryEngine> = {}): MemoryEngine {
  return {
    store: vi.fn().mockResolvedValue({ id: 'test-id', action: 'created' }),
    ingest: vi.fn().mockResolvedValue({
      created: 1,
      merged: 0,
      memory_ids: ['test-id'],
      facts: [{ fact: 'A fact', importance: 0.5 }],
    }),
    recall: vi.fn().mockResolvedValue({
      content: 'test recall',
      memories_used: 1,
      total_matches: 1,
    }),
    context: vi.fn().mockResolvedValue('## Briefing\nSome context'),
    forget: vi.fn().mockResolvedValue({ forgotten: 1 }),
    inspect: vi.fn().mockResolvedValue({
      total_memories: 10,
      active_memories: 8,
      decayed_memories: 1,
      compacted_memories: 1,
      oldest_memory: null,
      newest_memory: null,
      storage_bytes: 4096,
      top_tags: [],
    }),
    expand: vi.fn().mockResolvedValue({
      segment_id: 'seg-1',
      passages: ['Source passage one.', 'Source passage two.'],
      total_passages: 5,
      found: true,
    }),
    close: vi.fn(),
    ...overrides,
  };
}

async function createConnectedClient(engine: MemoryEngine) {
  const server = createServer(engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, server };
}

describe('MCP server', () => {
  it('lists all 7 memory tools', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name).sort();

    expect(toolNames).toEqual([
      'memory_context',
      'memory_expand',
      'memory_forget',
      'memory_ingest',
      'memory_inspect',
      'memory_recall',
      'memory_store',
    ]);
  });

  it('memory_store tool has correct schema', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const { tools } = await client.listTools();
    const storeTool = tools.find((t) => t.name === 'memory_store');

    expect(storeTool).toBeDefined();
    expect(storeTool!.description).toContain('Store a memory');
    expect(storeTool!.inputSchema.required).toContain('content');
  });

  it('memory_recall tool has correct schema', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const { tools } = await client.listTools();
    const recallTool = tools.find((t) => t.name === 'memory_recall');

    expect(recallTool).toBeDefined();
    expect(recallTool!.description).toContain('Recall memories');
    expect(recallTool!.inputSchema.required).toContain('query');
  });

  it('memory_ingest tool has correct schema', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const { tools } = await client.listTools();
    const ingestTool = tools.find((t) => t.name === 'memory_ingest');

    expect(ingestTool).toBeDefined();
    expect(ingestTool!.inputSchema.required).toContain('content');

    // Everything except `content` is optional.
    const required = ingestTool!.inputSchema.required ?? [];
    const properties = ingestTool!.inputSchema.properties ?? {};
    for (const optional of ['mode', 'dry_run', 'as_of', 'on_extraction_failure', 'tags', 'importance', 'source']) {
      expect(properties).toHaveProperty(optional);
      expect(required).not.toContain(optional);
    }
  });

  it('memory_context tool has no required params', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const { tools } = await client.listTools();
    const contextTool = tools.find((t) => t.name === 'memory_context');

    expect(contextTool).toBeDefined();
    expect(contextTool!.description).toContain('briefing');
    // All params are optional
    expect(contextTool!.inputSchema.required ?? []).toEqual([]);
  });

  it('calls engine.store via memory_store tool', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { content: 'User prefers dark mode', tags: ['preference'] },
    });

    expect(engine.store).toHaveBeenCalledWith('User prefers dark mode', {
      tags: ['preference'],
      importance: undefined,
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Stored memory test-id' }]);
  });

  it('calls engine.recall via memory_recall tool', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'testing preferences' },
    });

    // The second argument carries the MCP request's abort signal (call controls).
    expect(engine.recall).toHaveBeenCalledWith(
      {
        query: 'testing preferences',
        token_budget: undefined,
        tags: undefined,
        format: undefined,
        expand: 'auto',
        max_expand_passages: undefined,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Recalled memories reach the agent framed as notes from earlier sessions.
    expect(result.content).toEqual([{ type: 'text', text: frameMemoryNotes('test recall') }]);
  });

  it('surfaces expansion metadata in the memory_recall tool result', async () => {
    const engine = createMockEngine({
      recall: vi.fn().mockResolvedValue({
        content: 'expanded recall',
        memories_used: 3,
        total_matches: 12,
        expanded: true,
        expanded_segment_ids: ['seg-a', 'seg-b'],
        source_segment_ids: ['seg-a', 'seg-b', 'seg-c'],
      }),
    });
    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'contract clauses' },
    });

    // Human-readable text is preserved exactly as the recall content, inside the notes frame.
    expect(result.content).toEqual([{ type: 'text', text: frameMemoryNotes('expanded recall') }]);
    // The agent-facing expansion handles ride on structuredContent, available in
    // every format (the engine-only metadata is now reachable by MCP callers).
    expect(result.structuredContent).toEqual({
      memories_used: 3,
      total_matches: 12,
      expanded: true,
      expanded_segment_ids: ['seg-a', 'seg-b'],
      // The source of every recalled fact, not only the inlined ones.
      source_segment_ids: ['seg-a', 'seg-b', 'seg-c'],
    });
  });

  it('calls engine.context via memory_context tool', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_context',
      arguments: { task: 'Fix auth bug' },
    });

    expect(engine.context).toHaveBeenCalledWith(
      {
        task: 'Fix auth bug',
        token_budget: undefined,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.content).toEqual([{ type: 'text', text: frameMemoryNotes('## Briefing\nSome context') }]);
  });

  it('calls engine.forget via memory_forget tool', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_forget',
      arguments: { ids: ['abc'] },
    });

    expect(engine.forget).toHaveBeenCalled();
    expect(result.content).toEqual([{ type: 'text', text: 'Forgot 1 memories.' }]);
  });

  it('calls engine.inspect via memory_inspect tool', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_inspect',
      arguments: { view: 'stats' },
    });

    expect(engine.inspect).toHaveBeenCalledWith({
      view: 'stats',
      ids: undefined,
      limit: undefined,
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Memory Statistics');
  });

  it('sends ingest progress as MCP progress notifications when the client asks for them', async () => {
    const engine = createMockEngine({
      ingest: vi.fn(async (_content: string, _opts: unknown, controls?: CallControls) => {
        controls?.onProgress?.({ progress: 1, total: 2, message: 'Extracted 1 of 2 chunk(s)' });
        controls?.onProgress?.({ progress: 2, total: 2, message: 'Extracted 2 of 2 chunk(s)' });
        return { created: 0, merged: 0, memory_ids: [], facts: [] };
      }),
    });
    const { client } = await createConnectedClient(engine);
    const progress: Array<{ progress: number; total?: number; message?: string }> = [];

    await client.callTool({ name: 'memory_ingest', arguments: { content: 'blob' } }, undefined, {
      onprogress: (update) => progress.push(update),
    });

    expect(progress).toEqual([
      { progress: 1, total: 2, message: 'Extracted 1 of 2 chunk(s)' },
      { progress: 2, total: 2, message: 'Extracted 2 of 2 chunk(s)' },
    ]);
  });

  it('gives the engine no progress reporter when the client asked for no progress', async () => {
    const engine = createMockEngine();
    const { client } = await createConnectedClient(engine);
    await client.callTool({ name: 'memory_ingest', arguments: { content: 'blob' } });
    const controls = vi.mocked(engine.ingest).mock.calls[0][2];
    expect(controls?.signal).toBeInstanceOf(AbortSignal);
    expect(controls?.onProgress).toBeUndefined();
  });

  it('aborts the engine call when the client cancels the request', async () => {
    let seen: AbortSignal | undefined;
    const engine = createMockEngine({
      ingest: vi.fn(
        (_content: string, _opts: unknown, controls?: CallControls) =>
          new Promise<never>((_resolve, reject) => {
            seen = controls?.signal;
            controls?.signal?.addEventListener('abort', () => reject(new Error('memory_ingest was cancelled')));
          }),
      ),
    });
    const { client } = await createConnectedClient(engine);
    const controller = new AbortController();

    const call = client.callTool({ name: 'memory_ingest', arguments: { content: 'blob' } }, undefined, {
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(seen).toBeDefined();
    });
    controller.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() => {
      expect(seen?.aborted).toBe(true);
    });
  });

  it('describes the ingest size limits in the tool schema', async () => {
    const { client } = await createConnectedClient(createMockEngine());
    const { tools } = await client.listTools();
    const ingest = tools.find((t) => t.name === 'memory_ingest');
    const properties = ingest?.inputSchema.properties as Record<string, { description?: string }>;
    expect(properties.content.description).toContain('At most 200 KB');
    expect(properties.source.description).toContain('at most 256 characters');
  });

  it('returns error for engine failures without crashing', async () => {
    const engine = createMockEngine();
    (engine.store as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB connection failed'));

    const { client } = await createConnectedClient(engine);

    const result = await client.callTool({
      name: 'memory_store',
      arguments: { content: 'test' },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Error: DB connection failed' }]);
  });

  // MEM-26: the tools are registered with registerTool, which carries the hints and the
  // recall output schema that server.tool() never sent.
  describe('tool metadata (registerTool)', () => {
    it('reports the version of the package, not a copy of it', async () => {
      const { client } = await createConnectedClient(createMockEngine());
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string;
      };
      expect(client.getServerVersion()).toMatchObject({ name: 'memory', version: pkg.version });
    });

    it('gives every tool behaviour hints: only context, expand and inspect are read-only', async () => {
      const { client } = await createConnectedClient(createMockEngine());
      const { tools } = await client.listTools();
      const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));

      const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
      expect(readOnly.sort()).toEqual(['memory_context', 'memory_expand', 'memory_inspect']);
      // A recall counts as an access (a write, not a destructive one).
      expect(hints.memory_recall).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
      // Forget deletes; store and ingest can merge into existing memories and start maintenance.
      for (const name of ['memory_forget', 'memory_store', 'memory_ingest']) {
        expect(hints[name]).toEqual({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        });
      }
      for (const tool of tools) {
        expect(tool.annotations?.openWorldHint).toBe(false);
        expect(tool.title).toEqual(expect.any(String));
      }
      expect(Object.keys(TOOL_ANNOTATIONS).sort()).toEqual(tools.map((t) => t.name).sort());
    });

    it('declares the structured result of memory_recall only', async () => {
      const { client } = await createConnectedClient(createMockEngine());
      const { tools } = await client.listTools();

      expect(tools.filter((t) => t.outputSchema !== undefined).map((t) => t.name)).toEqual(['memory_recall']);
      const schema = tools.find((t) => t.name === 'memory_recall')?.outputSchema;
      const fields = ['expanded', 'expanded_segment_ids', 'memories_used', 'source_segment_ids', 'total_matches'];
      expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(fields);
      expect([...(schema?.required ?? [])].sort()).toEqual(fields);
    });

    it('gives a client that checks results against the output schema recall results that pass it', async () => {
      // The SDK client checks structuredContent against the advertised outputSchema once
      // it has listed the tools. That schema allows no other properties, while the
      // server's own check ignores them: a field the result gains without the schema
      // passes on the server and breaks every such client.
      const results = [
        {
          content: 'expanded recall',
          memories_used: 2,
          total_matches: 7,
          expanded: true,
          expanded_segment_ids: ['seg-a'],
          source_segment_ids: ['seg-a', 'seg-b'],
        },
        { content: '', memories_used: 0, total_matches: 0 },
      ];
      for (const recalled of results) {
        const { client } = await createConnectedClient(
          createMockEngine({ recall: vi.fn().mockResolvedValue(recalled) }),
        );
        await client.listTools();
        const result = await client.callTool({ name: 'memory_recall', arguments: { query: 'contract clauses' } });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ memories_used: recalled.memories_used });
      }
    });

    it('returns a recall failure as an error result, which the output schema lets through', async () => {
      const engine = createMockEngine({ recall: vi.fn().mockRejectedValue(new Error('embedder unavailable')) });
      const { client } = await createConnectedClient(engine);

      const result = await client.callTool({ name: 'memory_recall', arguments: { query: 'anything' } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: 'Error: embedder unavailable' }]);
      expect(result.structuredContent).toBeUndefined();
    });

    it('memory_expand takes an optional max_passages of at most 20 and says which passages it returned', async () => {
      const engine = createMockEngine();
      const { client } = await createConnectedClient(engine);
      const { tools } = await client.listTools();
      const expandTool = tools.find((t) => t.name === 'memory_expand');
      expect(expandTool?.inputSchema.required).toEqual(['segment_id']);
      expect(Object.keys(expandTool?.inputSchema.properties ?? {})).toEqual(['segment_id', 'query', 'max_passages']);
      expect(expandTool?.description).not.toContain('whole source');

      const result = await client.callTool({
        name: 'memory_expand',
        arguments: { segment_id: 'seg-1', query: 'cap clause', max_passages: 2 },
      });
      expect(engine.expand).toHaveBeenCalledWith('seg-1', 'cap clause', 2);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('Source passage two.');
      expect(text.endsWith(passageRangeNote(2, 5, true))).toBe(true);

      const tooMany = await client.callTool({
        name: 'memory_expand',
        arguments: { segment_id: 'seg-1', max_passages: 21 },
      });
      expect(tooMany.isError).toBe(true);
      expect(engine.expand).toHaveBeenCalledTimes(1);
    });
  });
});

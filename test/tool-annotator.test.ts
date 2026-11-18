import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  annotateServerTools,
  annotateTools,
  annotationPromptVersion,
  buildRoleDescriptions,
  chunk,
  computeToolAnnotationKey,
  describeStructuredRoleArguments,
  findStructuredRoleArguments,
  schemaAdmitsStructuredValue,
  ANNOTATION_BATCH_SIZE,
  type MCPToolSchema,
} from '../src/pipeline/tool-annotator.js';
import type { StoredToolAnnotation, StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import { getRolesForServer } from '../src/types/argument-roles.js';

const sampleTools: MCPToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read the complete contents of a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with new content',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source path' },
        destination: { type: 'string', description: 'Destination path' },
      },
      required: ['source', 'destination'],
    },
  },
  {
    name: 'list_allowed_directories',
    description: 'List the directories the server is allowed to access',
    inputSchema: { type: 'object', properties: {} },
  },
];

const cannedAnnotations = {
  annotations: [
    {
      toolName: 'read_file',
      comment: 'Reads the complete contents of a file from disk',

      args: { path: ['read-path'] },
    },
    {
      toolName: 'write_file',
      comment: 'Creates or overwrites a file with new content',

      args: { path: ['write-path'], content: ['none'] },
    },
    {
      toolName: 'move_file',
      comment: 'Moves a file from source to destination, deleting the source',

      args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
    },
    {
      toolName: 'list_allowed_directories',
      comment: 'Lists directories the server is allowed to access',

      args: {},
    },
  ],
};

function createMockModel(response: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 50, text: undefined, reasoning: undefined },
      },
      warnings: [],
      request: {},
      response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
    }),
  });
}

describe('Tool Annotator', () => {
  describe('annotateTools', () => {
    it('returns annotations for all tools from LLM response', async () => {
      const mockLLM = createMockModel(cannedAnnotations);
      const result = await annotateTools('filesystem', sampleTools, mockLLM);

      expect(result).toHaveLength(4);
      expect(result.every((a) => a.serverName === 'filesystem')).toBe(true);
    });

    it('correctly maps tool names', async () => {
      const mockLLM = createMockModel(cannedAnnotations);
      const result = await annotateTools('filesystem', sampleTools, mockLLM);

      const names = result.map((a) => a.toolName);
      expect(names).toContain('read_file');
      expect(names).toContain('write_file');
      expect(names).toContain('move_file');
      expect(names).toContain('list_allowed_directories');
    });

    it('preserves multi-role annotations for move source', async () => {
      const mockLLM = createMockModel(cannedAnnotations);
      const result = await annotateTools('filesystem', sampleTools, mockLLM);

      const moveAnnotation = result.find((a) => a.toolName === 'move_file')!;
      expect(moveAnnotation.args.source).toEqual(['read-path', 'delete-path']);
      expect(moveAnnotation.args.destination).toEqual(['write-path']);
    });

    it('throws when LLM response is missing tools', async () => {
      const incomplete = {
        annotations: [cannedAnnotations.annotations[0]], // only read_file
      };
      const mockLLM = createMockModel(incomplete);

      await expect(annotateTools('filesystem', sampleTools, mockLLM)).rejects.toThrow(
        'Annotation incomplete: missing tools',
      );
    });

    it('returns empty array for empty tools list', async () => {
      const mockLLM = createMockModel({ annotations: [] });
      const result = await annotateTools('filesystem', [], mockLLM);
      expect(result).toEqual([]);
    });

    // WP-61: the runtime loaders refuse a server entry that annotates a tool
    // twice, so the annotator must not write one.
    it('asks for a repair when the LLM annotates a tool twice', async () => {
      const repeated = {
        annotations: [
          ...cannedAnnotations.annotations,
          { toolName: 'read_file', comment: 'Reads a file again', args: { path: ['write-path'] } },
        ],
      };
      const prompts: string[] = [];
      const replies = [repeated, cannedAnnotations];
      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          prompts.push(JSON.stringify(options.prompt));
          const reply = replies[Math.min(prompts.length - 1, replies.length - 1)];
          return createMockModel(reply).doGenerate(options);
        },
      });

      const result = await annotateTools('filesystem', sampleTools, model);

      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('is annotated more than once');
      expect(result.map((a) => a.toolName).sort()).toEqual(
        ['list_allowed_directories', 'move_file', 'read_file', 'write_file'].sort(),
      );
      expect(result.find((a) => a.toolName === 'read_file')?.args.path).toEqual(['read-path']);
    });

    it('refuses a conditional role on an inherited name such as "constructor"', async () => {
      const inherited = {
        annotations: cannedAnnotations.annotations.map((a) =>
          a.toolName === 'write_file'
            ? {
                ...a,
                args: {
                  path: {
                    default: ['write-path'],
                    when: [{ condition: { arg: 'constructor', is: 'present' }, roles: ['write-path'] }],
                  },
                  content: ['none'],
                },
              }
            : a,
        ),
      };
      // The zod error message is the issue list as JSON, so the quotes are escaped.
      await expect(annotateTools('filesystem', sampleTools, createMockModel(inherited))).rejects.toThrow(
        /references unknown argument \\"constructor\\"/,
      );
    });

    // WP-59: the policy lint uses the server's hints to recognize tools that
    // change state (tighten-only), so the annotation keeps them.
    it("stores the server's read-only and destructive hints, and nothing else from them", async () => {
      const hinted: MCPToolSchema[] = sampleTools.map((t) => {
        if (t.name === 'read_file') return { ...t, annotations: { readOnlyHint: true, title: 'Read' } };
        if (t.name === 'write_file') {
          return { ...t, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } };
        }
        if (t.name === 'move_file') return { ...t, annotations: { readOnlyHint: 'no', destructiveHint: 1 } };
        return t;
      });
      const result = await annotateTools('filesystem', hinted, createMockModel(cannedAnnotations));
      const hintsOf = (name: string) => result.find((a) => a.toolName === name)?.mcpHints;

      expect(hintsOf('read_file')).toEqual({ readOnlyHint: true });
      expect(hintsOf('write_file')).toEqual({ readOnlyHint: false, destructiveHint: true });
      // Non-boolean values are ignored, and a tool without hints gets no field.
      expect(result.find((a) => a.toolName === 'move_file')).not.toHaveProperty('mcpHints');
      expect(result.find((a) => a.toolName === 'list_allowed_directories')).not.toHaveProperty('mcpHints');
    });
  });

  describe('getRolesForServer', () => {
    const gitOnlyRoles = ['git-remote-url', 'branch-name', 'commit-message', 'write-history', 'delete-history'];
    const filesystemAndGitRoles = ['read-path', 'write-path', 'delete-path'];
    const fetchOnlyRoles = ['fetch-url'];
    const universalRoles = ['none'];

    it('excludes git-specific roles for filesystem server', () => {
      const roles = getRolesForServer('filesystem');
      const roleNames = roles.map(([name]) => name);
      for (const gitRole of gitOnlyRoles) {
        expect(roleNames).not.toContain(gitRole);
      }
    });

    it('includes git-specific roles for git server', () => {
      const roles = getRolesForServer('git');
      const roleNames = roles.map(([name]) => name);
      for (const gitRole of gitOnlyRoles) {
        expect(roleNames).toContain(gitRole);
      }
    });

    it('always includes universal roles', () => {
      for (const serverName of ['filesystem', 'git', 'fetch', 'unknown-server']) {
        const roles = getRolesForServer(serverName);
        const roleNames = roles.map(([name]) => name);
        for (const role of universalRoles) {
          expect(roleNames).toContain(role);
        }
      }
    });

    it('includes filesystem/git path roles for both servers', () => {
      for (const serverName of ['filesystem', 'git']) {
        const roles = getRolesForServer(serverName);
        const roleNames = roles.map(([name]) => name);
        for (const role of filesystemAndGitRoles) {
          expect(roleNames).toContain(role);
        }
      }
    });

    it('excludes filesystem path roles from fetch server', () => {
      const roles = getRolesForServer('fetch');
      const roleNames = roles.map(([name]) => name);
      for (const role of filesystemAndGitRoles) {
        expect(roleNames).not.toContain(role);
      }
    });

    it('includes fetch-url only for fetch server', () => {
      const fetchRoles = getRolesForServer('fetch');
      const fetchRoleNames = fetchRoles.map(([name]) => name);
      for (const role of fetchOnlyRoles) {
        expect(fetchRoleNames).toContain(role);
      }

      const fsRoles = getRolesForServer('filesystem');
      const fsRoleNames = fsRoles.map(([name]) => name);
      for (const role of fetchOnlyRoles) {
        expect(fsRoleNames).not.toContain(role);
      }
    });

    it('git server gets the most roles (path + git-specific + universal)', () => {
      const gitRoles = getRolesForServer('git');
      const fsRoles = getRolesForServer('filesystem');
      const fetchRoles = getRolesForServer('fetch');
      expect(gitRoles.length).toBeGreaterThan(fsRoles.length);
      expect(gitRoles.length).toBeGreaterThan(fetchRoles.length);
    });
  });

  describe('chunk', () => {
    it('returns empty array wrapped for empty input', () => {
      expect(chunk([], 5)).toEqual([[]]);
    });

    it('returns single chunk when array is smaller than batch size', () => {
      const items = [1, 2, 3];
      const result = chunk(items, 5);
      expect(result).toEqual([[1, 2, 3]]);
      // Should return the original array reference (no copy)
      expect(result[0]).toBe(items);
    });

    it('returns single chunk when array equals batch size', () => {
      const items = [1, 2, 3, 4, 5];
      const result = chunk(items, 5);
      expect(result).toEqual([[1, 2, 3, 4, 5]]);
      expect(result[0]).toBe(items);
    });

    it('splits into exact multiples', () => {
      const result = chunk([1, 2, 3, 4, 5, 6], 3);
      expect(result).toEqual([
        [1, 2, 3],
        [4, 5, 6],
      ]);
    });

    it('handles non-exact multiples with smaller last chunk', () => {
      const result = chunk([1, 2, 3, 4, 5, 6, 7], 3);
      expect(result).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    });

    it('throws on zero size', () => {
      expect(() => chunk([1, 2], 0)).toThrow(RangeError);
    });

    it('throws on negative size', () => {
      expect(() => chunk([1, 2], -1)).toThrow(RangeError);
    });
  });

  describe('ANNOTATION_BATCH_SIZE', () => {
    it('is 25', () => {
      expect(ANNOTATION_BATCH_SIZE).toBe(25);
    });
  });

  describe('annotateTools batching', () => {
    // Helper to generate N minimal tools for the filesystem server
    function makeTools(count: number): MCPToolSchema[] {
      return Array.from({ length: count }, (_, i) => ({
        name: `tool_${i}`,
        description: `Tool number ${i}`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'A path' },
          },
          required: ['path'],
        },
      }));
    }

    // Create a mock model that tracks call count and returns correct annotations
    // for whichever tools appear in the prompt
    function createBatchTrackingModel(tools: MCPToolSchema[]) {
      let callCount = 0;
      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          callCount++;
          // Extract tool names from the prompt to determine which batch this is.
          // Use word-boundary regex to avoid "tool_2" matching inside "tool_25".
          const prompt = JSON.stringify(options.prompt);
          const batchTools = tools.filter((t) => {
            const pattern = new RegExp(`Tool: ${t.name}\\b`);
            return pattern.test(prompt);
          });

          const annotations = batchTools.map((t) => ({
            toolName: t.name,
            comment: `Annotation for ${t.name}`,

            args: { path: ['read-path'] },
          }));

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ annotations }) }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 50, text: undefined, reasoning: undefined },
            },
            warnings: [],
            request: {},
            response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
          };
        },
      });

      return { model, getCallCount: () => callCount };
    }

    it('makes a single LLM call for tools within batch size', async () => {
      const tools = makeTools(10);
      const { model, getCallCount } = createBatchTrackingModel(tools);

      const result = await annotateTools('filesystem', tools, model);

      expect(getCallCount()).toBe(1);
      expect(result).toHaveLength(10);
      expect(result.every((a) => a.serverName === 'filesystem')).toBe(true);
    });

    it('makes two LLM calls for tools exceeding batch size', async () => {
      const tools = makeTools(30);
      const { model, getCallCount } = createBatchTrackingModel(tools);

      const result = await annotateTools('filesystem', tools, model);

      expect(getCallCount()).toBe(2); // 25 + 5
      expect(result).toHaveLength(30);
      // Verify all tool names are present
      const names = new Set(result.map((a) => a.toolName));
      for (const t of tools) {
        expect(names.has(t.name)).toBe(true);
      }
    });

    it('makes three LLM calls for 60 tools', async () => {
      const tools = makeTools(60);
      const { model, getCallCount } = createBatchTrackingModel(tools);

      const result = await annotateTools('filesystem', tools, model);

      expect(getCallCount()).toBe(3); // 25 + 25 + 10
      expect(result).toHaveLength(60);
    });

    it('suppresses batch progress messages for single batch', async () => {
      const tools = makeTools(10);
      const { model } = createBatchTrackingModel(tools);
      const messages: string[] = [];

      await annotateTools('filesystem', tools, model, (msg) => messages.push(msg));

      // No "Batch 1/1" messages
      expect(messages.every((m) => !m.includes('Batch'))).toBe(true);
    });

    it('emits batch progress messages for multiple batches', async () => {
      const tools = makeTools(30);
      const { model } = createBatchTrackingModel(tools);
      const messages: string[] = [];

      await annotateTools('filesystem', tools, model, (msg) => messages.push(msg));

      expect(messages.some((m) => m.includes('Batch 1/2'))).toBe(true);
      expect(messages.some((m) => m.includes('Batch 2/2'))).toBe(true);
    });

    it('propagates error from failed batch without partial results', async () => {
      const tools = makeTools(30);
      let callCount = 0;

      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          callCount++;
          if (callCount === 2) {
            throw new Error('LLM service unavailable');
          }

          // Return valid annotations for the first batch
          const prompt = JSON.stringify(options.prompt);
          const batchTools = tools.filter((t) => new RegExp(`Tool: ${t.name}\\b`).test(prompt));
          const annotations = batchTools.map((t) => ({
            toolName: t.name,
            comment: `Annotation for ${t.name}`,

            args: { path: ['read-path'] },
          }));

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ annotations }) }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 50, text: undefined, reasoning: undefined },
            },
            warnings: [],
            request: {},
            response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
          };
        },
      });

      await expect(annotateTools('filesystem', tools, model)).rejects.toThrow('LLM service unavailable');
    });

    it('detects missing tools across batches', async () => {
      const tools = makeTools(30);
      let callCount = 0;

      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          callCount++;
          const prompt = JSON.stringify(options.prompt);
          const batchTools = tools.filter((t) => new RegExp(`Tool: ${t.name}\\b`).test(prompt));

          // Second batch drops some tools
          const annotations =
            callCount === 2
              ? batchTools.slice(0, 2).map((t) => ({
                  toolName: t.name,
                  comment: `Annotation for ${t.name}`,

                  args: { path: ['read-path'] },
                }))
              : batchTools.map((t) => ({
                  toolName: t.name,
                  comment: `Annotation for ${t.name}`,

                  args: { path: ['read-path'] },
                }));

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ annotations }) }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 50, text: undefined, reasoning: undefined },
            },
            warnings: [],
            request: {},
            response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
          };
        },
      });

      await expect(annotateTools('filesystem', tools, model)).rejects.toThrow('Annotation incomplete: missing tools');
    });

    it('fails when the server lists a tool in two batches instead of writing it twice', async () => {
      // tool_0 is listed first and again as the 26th tool, so each batch annotates it once.
      const tools = [...makeTools(ANNOTATION_BATCH_SIZE), { ...makeTools(1)[0] }];
      const names = [...new Set(tools.map((t) => t.name))];
      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          const prompt = JSON.stringify(options.prompt);
          const annotations = names
            .filter((name) => new RegExp(`Tool: ${name}\\b`).test(prompt))
            .map((name) => ({ toolName: name, comment: `Annotation for ${name}`, args: { path: ['read-path'] } }));
          return createMockModel({ annotations }).doGenerate(options);
        },
      });

      await expect(annotateTools('filesystem', tools, model)).rejects.toThrow(
        'the server lists these tools more than once: "tool_0"',
      );
    });
  });

  describe('buildRoleDescriptions', () => {
    it('includes all roles when no server name is given', () => {
      const descriptions = buildRoleDescriptions();
      expect(descriptions).toContain('read-path');
      expect(descriptions).toContain('git-remote-url');
      expect(descriptions).toContain('branch-name');
    });

    it('excludes git-specific roles for filesystem server', () => {
      const descriptions = buildRoleDescriptions('filesystem');
      expect(descriptions).toContain('read-path');
      expect(descriptions).toContain('write-path');
      expect(descriptions).not.toContain('git-remote-url');
      expect(descriptions).not.toContain('branch-name');
      expect(descriptions).not.toContain('commit-message');
    });

    it('includes git-specific roles for git server', () => {
      const descriptions = buildRoleDescriptions('git');
      expect(descriptions).toContain('git-remote-url');
      expect(descriptions).toContain('branch-name');
      expect(descriptions).toContain('commit-message');
    });
  });

  describe('roles on arguments that can hold structured values', () => {
    function annotation(
      args: StoredToolAnnotation['args'],
      properties: Record<string, unknown>,
      toolName = 'tool',
    ): StoredToolAnnotation {
      return { toolName, serverName: 'srv', comment: 'test', args, inputSchema: { type: 'object', properties } };
    }

    it('recognizes schemas that admit an object or an array of structured elements', () => {
      expect(schemaAdmitsStructuredValue({ type: 'object', properties: { users: { type: 'array' } } })).toBe(true);
      expect(schemaAdmitsStructuredValue({ properties: { p: { type: 'string' } } })).toBe(true);
      expect(schemaAdmitsStructuredValue({ type: ['object', 'null'] })).toBe(true);
      expect(schemaAdmitsStructuredValue({ type: 'array', items: { type: 'object' } })).toBe(true);
      expect(schemaAdmitsStructuredValue({ type: 'array', items: { type: 'array', items: { type: 'string' } } })).toBe(
        true,
      );
      expect(
        schemaAdmitsStructuredValue({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'object' }] }),
      ).toBe(true);
      expect(schemaAdmitsStructuredValue({ anyOf: [{ type: 'string' }, { type: 'object' }] })).toBe(true);
      expect(
        schemaAdmitsStructuredValue({
          oneOf: [{ type: 'string' }, { type: 'array', items: { anyOf: [{ type: 'object' }] } }],
        }),
      ).toBe(true);
    });

    it('does not flag strings, numbers, flat arrays or schemas that do not say', () => {
      expect(schemaAdmitsStructuredValue({ type: 'string' })).toBe(false);
      expect(schemaAdmitsStructuredValue({ type: 'number' })).toBe(false);
      expect(schemaAdmitsStructuredValue({ type: ['string', 'null'] })).toBe(false);
      expect(schemaAdmitsStructuredValue({ type: 'array', items: { type: 'string' } })).toBe(false);
      expect(
        schemaAdmitsStructuredValue({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer' }] } }),
      ).toBe(false);
      // git_checkout.target: two string branches.
      expect(schemaAdmitsStructuredValue({ anyOf: [{ type: 'string' }, { type: 'string', minLength: 1 }] })).toBe(
        false,
      );
      expect(schemaAdmitsStructuredValue({ $ref: '#/$defs/thing' })).toBe(false);
      expect(schemaAdmitsStructuredValue({})).toBe(false);
      expect(schemaAdmitsStructuredValue(undefined)).toBe(false);
    });

    it('flags a role other than none on such an argument, and nothing else', () => {
      const found = findStructuredRoleArguments([
        annotation(
          {
            editors: ['email-address'],
            files: ['none'],
            paths: ['read-path'],
            ops: {
              default: ['write-path', 'none'],
              when: [{ condition: { arg: 'mode', equals: 'dry' }, roles: ['none'] }],
            },
            mode: ['none'],
          },
          {
            editors: { type: 'object', properties: { users: { type: 'array', items: { type: 'string' } } } },
            files: { type: 'array', items: { type: 'object' } },
            paths: { type: 'array', items: { type: 'string' } },
            ops: { type: 'array', items: { type: 'object' } },
            mode: { type: 'string' },
          },
        ),
      ]);
      expect(found).toEqual([
        { toolName: 'tool', argName: 'editors', roles: ['email-address'] },
        { toolName: 'tool', argName: 'ops', roles: ['write-path'] },
      ]);
    });

    it('flags exactly the gsheets protected-range editors in the shipped annotations', () => {
      // A new entry here needs review: policy can only escalate calls that
      // pass a structured value to such an argument, never judge its values.
      const generated = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../src/config/generated/tool-annotations.json',
      );
      const shipped = JSON.parse(readFileSync(generated, 'utf-8')) as StoredToolAnnotationsFile;
      const flagged = Object.entries(shipped.servers).flatMap(([server, entry]) =>
        findStructuredRoleArguments(entry.tools).map((found) => ({ server, ...found })),
      );
      expect(flagged).toEqual([
        {
          server: 'google-workspace',
          toolName: 'gsheets_add_protected_range',
          argName: 'editors',
          roles: ['email-address'],
        },
        {
          server: 'google-workspace',
          toolName: 'gsheets_update_protected_range',
          argName: 'editors',
          roles: ['email-address'],
        },
      ]);
    });

    it('describes each one terminal-safely', () => {
      const lines = describeStructuredRoleArguments('srv\u001b[31m', [
        { toolName: 'tool', argName: 'arg\u0007', roles: ['email-address'] },
      ]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^Warning: /);
      expect(lines[0]).toContain('email-address');
      expect(lines[0]).toContain('escalated to a human');
      expect(lines[0]).not.toMatch(/\p{Cc}/u);
    });

    it('can be checked on what annotateTools returns', async () => {
      const tools: MCPToolSchema[] = [
        {
          name: 'protect_range',
          inputSchema: {
            type: 'object',
            properties: { editors: { type: 'object', properties: { users: { type: 'array' } } } },
          },
        },
      ];
      const model = createMockModel({
        annotations: [{ toolName: 'protect_range', comment: 'Protects a range', args: { editors: ['email-address'] } }],
      });
      const result = await annotateTools('google-workspace', tools, model);
      expect(findStructuredRoleArguments(result)).toEqual([
        { toolName: 'protect_range', argName: 'editors', roles: ['email-address'] },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // WP-88 / GAP1-9: per-tool annotation cache
  // -------------------------------------------------------------------------

  describe('per-tool annotation cache', () => {
    function pathTool(name: string, description = `Tool ${name}`): MCPToolSchema {
      return {
        name,
        description,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      };
    }

    /**
     * Annotates whichever tools the prompt lists (`roles` per tool, default
     * read-path) and records, per call, the tools it was asked about and the
     * temperature.
     */
    function recordingModel(roles: Record<string, string[]> = {}) {
      const calls: Array<{ tools: string[]; temperature: number | undefined }> = [];
      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          const prompt = JSON.stringify(options.prompt);
          const asked = [...prompt.matchAll(/Tool: ([A-Za-z0-9_]+)/g)].map((m) => m[1]);
          calls.push({ tools: asked, temperature: options.temperature });
          const annotations = asked.map((name) => ({
            toolName: name,
            comment: `Annotation for ${name}`,
            args: { path: roles[name] ?? ['read-path'] },
          }));
          return createMockModel({ annotations }).doGenerate(options);
        },
      });
      return { model, calls };
    }

    const TOOLS = Array.from({ length: 30 }, (_, i) => pathTool(`tool_${i}`));

    it('adding one tool re-annotates only that tool', async () => {
      const first = recordingModel();
      const before = await annotateServerTools({ serverName: 'filesystem', tools: TOOLS, llm: first.model });
      expect(first.calls.map((c) => c.tools.length)).toEqual([25, 5]);
      expect(before.annotations.every((a) => typeof a.annotationKey === 'string')).toBe(true);

      const withNewTool = [...TOOLS.slice(0, 12), pathTool('tool_new'), ...TOOLS.slice(12)];
      const second = recordingModel();
      const after = await annotateServerTools({
        serverName: 'filesystem',
        tools: withNewTool,
        llm: second.model,
        previous: [before.annotations],
      });

      expect(second.calls.map((c) => c.tools)).toEqual([['tool_new']]);
      expect(after.annotated).toEqual(['tool_new']);
      expect(after.reused).toEqual(TOOLS.map((t) => t.name));
      // The unchanged tools keep their annotations verbatim, in the server's order.
      expect(after.annotations.map((a) => a.toolName)).toEqual(withNewTool.map((t) => t.name));
      expect(after.annotations.filter((a) => a.toolName !== 'tool_new')).toEqual(before.annotations);
      expect(after.annotations.find((a) => a.toolName === 'tool_new')?.annotationKey).toBe(
        computeToolAnnotationKey(pathTool('tool_new'), annotationPromptVersion('filesystem')),
      );
    });

    it('makes no LLM call when every tool is unchanged', async () => {
      const before = await annotateServerTools({ serverName: 'filesystem', tools: TOOLS, llm: recordingModel().model });
      const again = recordingModel();
      const after = await annotateServerTools({
        serverName: 'filesystem',
        tools: TOOLS,
        llm: again.model,
        previous: [before.annotations],
      });
      expect(again.calls).toHaveLength(0);
      expect(after.annotations).toEqual(before.annotations);
    });

    it('re-annotates a tool whose description changed, even with the same input schema', async () => {
      const tools = [pathTool('git_clone', 'Clones a remote repository.'), pathTool('git_log')];
      const before = await annotateServerTools({ serverName: 'git', tools, llm: recordingModel().model });
      const changed = [pathTool('git_clone', 'Clones a repository; now also accepts local paths.'), tools[1]];
      const second = recordingModel({ git_clone: ['read-path', 'write-path'] });

      const after = await annotateServerTools({
        serverName: 'git',
        tools: changed,
        llm: second.model,
        previous: [before.annotations],
      });

      expect(second.calls.map((c) => c.tools)).toEqual([['git_clone']]);
      expect(after.annotations.find((a) => a.toolName === 'git_clone')?.args.path).toEqual(['read-path', 'write-path']);
    });

    it('re-annotates a tool whose input schema changed', async () => {
      const before = await annotateServerTools({ serverName: 'filesystem', tools: TOOLS, llm: recordingModel().model });
      const renamed: MCPToolSchema = {
        ...TOOLS[3],
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } } },
      };
      const second = new MockLanguageModelV3({
        doGenerate: async (options) =>
          createMockModel({
            annotations: [{ toolName: 'tool_3', comment: 'c', args: { path: ['read-path'], recursive: ['none'] } }],
          }).doGenerate(options),
      });
      const after = await annotateServerTools({
        serverName: 'filesystem',
        tools: TOOLS.map((t) => (t.name === 'tool_3' ? renamed : t)),
        llm: second,
        previous: [before.annotations],
      });
      expect(after.annotated).toEqual(['tool_3']);
      expect(after.reused).toHaveLength(29);
    });

    it('re-annotates when the prompt or role-registry version behind a key differs', async () => {
      const before = await annotateServerTools({ serverName: 'filesystem', tools: TOOLS, llm: recordingModel().model });
      // A key made under another prompt/registry version never matches.
      const staleKeys: StoredToolAnnotation[] = before.annotations.map((a) => ({
        ...a,
        annotationKey: computeToolAnnotationKey(
          TOOLS.find((t) => t.name === a.toolName) ?? TOOLS[0],
          'an-older-version',
        ),
      }));
      const second = recordingModel();
      const after = await annotateServerTools({
        serverName: 'filesystem',
        tools: TOOLS,
        llm: second.model,
        previous: [staleKeys],
      });
      expect(after.reused).toEqual([]);
      expect(second.calls.flatMap((c) => c.tools)).toHaveLength(30);
      // The registry version is per server: another server's tools get other keys.
      expect(annotationPromptVersion('git')).not.toBe(annotationPromptVersion('filesystem'));
    });

    it('does not reuse an annotation without a key, or one that no longer validates', async () => {
      const promptVersion = annotationPromptVersion('filesystem');
      const keyOf = (t: MCPToolSchema) => computeToolAnnotationKey(t, promptVersion);
      const previous: StoredToolAnnotation[] = [
        // Written before keys existed.
        {
          toolName: 'tool_0',
          serverName: 'filesystem',
          comment: 'old',
          args: { path: ['read-path'] },
          inputSchema: {},
        },
        // A matching key, but its argument is not annotated (hand-edited).
        {
          toolName: 'tool_1',
          serverName: 'filesystem',
          comment: 'x',
          args: {},
          inputSchema: {},
          annotationKey: keyOf(TOOLS[1]),
        },
        // A matching key and a role the filesystem server may not use.
        {
          toolName: 'tool_2',
          serverName: 'filesystem',
          comment: 'x',
          args: { path: ['git-remote-url'] },
          inputSchema: {},
          annotationKey: keyOf(TOOLS[2]),
        },
        // Valid and current.
        {
          toolName: 'tool_3',
          serverName: 'filesystem',
          comment: 'kept',
          args: { path: ['write-path'] },
          inputSchema: {},
          annotationKey: keyOf(TOOLS[3]),
        },
      ];
      const second = recordingModel();
      const after = await annotateServerTools({
        serverName: 'filesystem',
        tools: TOOLS.slice(0, 4),
        llm: second.model,
        previous: [previous],
      });
      expect(after.reused).toEqual(['tool_3']);
      expect(second.calls.flatMap((c) => c.tools)).toEqual(['tool_0', 'tool_1', 'tool_2']);
      expect(after.annotations.find((a) => a.toolName === 'tool_3')?.args.path).toEqual(['write-path']);
    });

    it('takes a tool from the first previous annotation set that has it current', async () => {
      const key = computeToolAnnotationKey(TOOLS[0], annotationPromptVersion('filesystem'));
      const reviewed: StoredToolAnnotation = {
        toolName: 'tool_0',
        serverName: 'filesystem',
        comment: 'reviewed',
        args: { path: ['read-path'] },
        inputSchema: {},
        annotationKey: key,
      };
      const own: StoredToolAnnotation = { ...reviewed, comment: 'mine', args: { path: ['write-path'] } };
      const after = await annotateServerTools({
        serverName: 'filesystem',
        tools: [TOOLS[0]],
        llm: recordingModel().model,
        previous: [[reviewed], [own]],
      });
      // Roles and comment as reviewed; the input schema recorded is the live one.
      expect(after.annotations).toEqual([{ ...reviewed, inputSchema: TOOLS[0].inputSchema }]);
      expect(after.reused).toEqual(['tool_0']);
    });

    // WP-59 + WP-88: the policy lint reads the server's hints (tighten-only).
    // They are not part of the key, so a reused annotation must not keep the
    // hints of the run that annotated it.
    it("gives a reused annotation the live tool's MCP hints", async () => {
      const plain = TOOLS.slice(0, 3);
      const before = await annotateServerTools({ serverName: 'filesystem', tools: plain, llm: recordingModel().model });
      expect(before.annotations.some((a) => 'mcpHints' in a)).toBe(false);

      // The server now marks tool_0 destructive and tool_1 read-only; nothing
      // the key covers changed, so no tool goes back to the LLM.
      const hinted: MCPToolSchema[] = [
        { ...plain[0], annotations: { readOnlyHint: false, destructiveHint: true } },
        { ...plain[1], annotations: { readOnlyHint: true } },
        plain[2],
      ];
      const again = recordingModel();
      const after = await annotateServerTools({
        serverName: 'filesystem',
        tools: hinted,
        llm: again.model,
        previous: [before.annotations],
      });
      expect(again.calls).toHaveLength(0);
      expect(after.reused).toEqual(plain.map((t) => t.name));
      expect(after.annotations.map((a) => a.mcpHints)).toEqual([
        { readOnlyHint: false, destructiveHint: true },
        { readOnlyHint: true },
        undefined,
      ]);
      // Roles and comments are the reused ones.
      expect(after.annotations.map((a) => [a.comment, a.args])).toEqual(
        before.annotations.map((a) => [a.comment, a.args]),
      );

      // Hints the server no longer declares are dropped, as on a fresh annotation.
      const dropped = await annotateServerTools({
        serverName: 'filesystem',
        tools: plain,
        llm: again.model,
        previous: [after.annotations],
      });
      expect(again.calls).toHaveLength(0);
      expect(dropped.annotations.some((a) => 'mcpHints' in a)).toBe(false);
    });

    it('asks for the model only when some tool needs the LLM, and once per call', async () => {
      const before = await annotateServerTools({ serverName: 'filesystem', tools: TOOLS, llm: recordingModel().model });
      let requested = 0;
      const unavailable = () => {
        requested++;
        return Promise.reject(new Error('no credentials'));
      };

      // A tool removed: every remaining tool is unchanged, so no model is needed.
      const after = await annotateServerTools({
        serverName: 'filesystem',
        tools: TOOLS.slice(1),
        llm: unavailable,
        previous: [before.annotations],
      });
      expect(requested).toBe(0);
      expect(after.reused).toEqual(TOOLS.slice(1).map((t) => t.name));

      // Two batches to annotate: the model is requested once.
      const fresh = recordingModel();
      const annotated = await annotateServerTools({
        serverName: 'filesystem',
        tools: TOOLS,
        llm: () => {
          requested++;
          return Promise.resolve(fresh.model);
        },
      });
      expect(requested).toBe(1);
      expect(fresh.calls).toHaveLength(2);
      expect(annotated.annotated).toHaveLength(30);
    });

    it('annotates at temperature 0', async () => {
      const { model, calls } = recordingModel();
      await annotateTools('filesystem', TOOLS.slice(0, 2), model);
      expect(calls.map((c) => c.temperature)).toEqual([0]);
    });

    it('fails before any LLM call when the server lists a tool twice', async () => {
      const { model, calls } = recordingModel();
      await expect(
        annotateServerTools({ serverName: 'filesystem', tools: [TOOLS[0], TOOLS[1], TOOLS[0]], llm: model }),
      ).rejects.toThrow('the server lists these tools more than once: "tool_0"');
      expect(calls).toHaveLength(0);
    });
  });
});

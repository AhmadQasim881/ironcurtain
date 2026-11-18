import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import {
  bridgeMediatedTools,
  diffListValues,
  formatListValueChanges,
  resolveList,
  resolveAllLists,
  revalidateResolvedList,
  type ListResolverConfig,
} from '../src/pipeline/list-resolver.js';
import { mergeRefreshedLists } from '../src/pipeline/refresh-lists.js';
import type { DynamicListsFile, ListDefinition, ResolvedList } from '../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const MOCK_GENERATE_RESULT = {
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 50, text: undefined, reasoning: undefined },
  },
  warnings: [],
  request: {},
  response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
};

/**
 * Creates a MockLanguageModelV3 that always returns the given values array.
 */
function createMockModel(values: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ values }) }],
      ...MOCK_GENERATE_RESULT,
    }),
  });
}

/**
 * Creates a MockLanguageModelV3 that counts calls and returns the given values.
 */
function createCountingMockModel(values: string[]): { model: MockLanguageModelV3; callCount: () => number } {
  let count = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      count++;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ values }) }],
        ...MOCK_GENERATE_RESULT,
      };
    },
  });
  return { model, callCount: () => count };
}

/**
 * Creates a minimal ListDefinition for testing.
 */
function makeDefinition(overrides: Partial<ListDefinition> = {}): ListDefinition {
  return {
    name: 'test-list',
    type: 'identifiers',
    principle: 'Test principle',
    generationPrompt: 'Generate a list of test items',
    requiresMcp: false,
    ...overrides,
  };
}

function makeConfig(values: string[]): ListResolverConfig {
  return { model: createMockModel(values) };
}

// ---------------------------------------------------------------------------
// resolveList — basic behavior
// ---------------------------------------------------------------------------

describe('resolveList', () => {
  describe('basic resolution', () => {
    it('returns the values produced by the LLM', async () => {
      const def = makeDefinition({ type: 'identifiers' });
      const result = await resolveList(def, makeConfig(['alpha', 'beta', 'gamma']));
      expect(result.values).toContain('alpha');
      expect(result.values).toContain('beta');
      expect(result.values).toContain('gamma');
    });

    it('returns a valid ISO 8601 resolvedAt timestamp', async () => {
      const def = makeDefinition();
      const result = await resolveList(def, makeConfig(['x']));
      expect(Number.isNaN(Date.parse(result.resolvedAt))).toBe(false);
      expect(new Date(result.resolvedAt).toISOString()).toBe(result.resolvedAt);
    });

    it('returns a non-empty inputHash', async () => {
      const def = makeDefinition();
      const result = await resolveList(def, makeConfig(['x']));
      expect(result.inputHash).toBeTruthy();
      expect(typeof result.inputHash).toBe('string');
    });

    it('starts with empty manualAdditions and manualRemovals when none in existing', async () => {
      const def = makeDefinition();
      const result = await resolveList(def, makeConfig(['x']));
      expect(result.manualAdditions).toEqual([]);
      expect(result.manualRemovals).toEqual([]);
    });

    it('deduplicates identical values', async () => {
      const def = makeDefinition({ type: 'identifiers' });
      const result = await resolveList(def, makeConfig(['dup', 'dup', 'unique']));
      expect(result.values.filter((v) => v === 'dup')).toHaveLength(1);
    });

    it('calls onProgress with list name', async () => {
      const def = makeDefinition({ name: 'my-list' });
      const progress: string[] = [];
      await resolveList(def, makeConfig(['x']), undefined, (msg) => progress.push(msg));
      expect(progress.some((m) => m.includes('my-list'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // domain type — auto-expansion of apex domains
  // ---------------------------------------------------------------------------

  describe('domain type — automatic wildcard expansion', () => {
    it('auto-adds *.domain wildcard for bare apex domain', async () => {
      const def = makeDefinition({ type: 'domains' });
      const result = await resolveList(def, makeConfig(['example.com']));
      expect(result.values).toContain('example.com');
      expect(result.values).toContain('*.example.com');
    });

    it('does not double-add wildcard when already present', async () => {
      const def = makeDefinition({ type: 'domains' });
      const result = await resolveList(def, makeConfig(['*.example.com']));
      const wildcardCount = result.values.filter((v) => v === '*.example.com').length;
      expect(wildcardCount).toBe(1);
      // The bare apex should NOT be added for already-wildcard entries
      expect(result.values).toContain('*.example.com');
    });

    it('expands multiple apex domains independently', async () => {
      const def = makeDefinition({ type: 'domains' });
      const result = await resolveList(def, makeConfig(['foo.com', 'bar.org']));
      expect(result.values).toContain('foo.com');
      expect(result.values).toContain('*.foo.com');
      expect(result.values).toContain('bar.org');
      expect(result.values).toContain('*.bar.org');
    });

    it('widens only names under an ICANN suffix, never multi-tenant hosting names', async () => {
      const def = makeDefinition({ type: 'domains' });
      const result = await resolveList(
        def,
        makeConfig(['www.example.co.uk', 'alice.github.io', 'raw.githubusercontent.com', 'sts.amazonaws.com']),
      );
      expect(result.values).toEqual([
        'www.example.co.uk',
        'alice.github.io',
        'raw.githubusercontent.com',
        'sts.amazonaws.com',
        '*.www.example.co.uk',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // domain type — Public Suffix List, IP and local-name checks
  // ---------------------------------------------------------------------------

  describe('domain type — values that would widen egress beyond one registrant are dropped', () => {
    /** Resolves a domains list from `values`, capturing the warnings it prints. */
    async function resolveDomains(values: string[]): Promise<{ values: string[]; warnings: string[] }> {
      const warnings: string[] = [];
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
        warnings.push(String(message));
      });
      try {
        const result = await resolveList(makeDefinition({ name: 'sites', type: 'domains' }), makeConfig(values));
        return { values: result.values, warnings };
      } finally {
        consoleSpy.mockRestore();
      }
    }

    it("drops 169.254.169.254, localhost and 'com'", async () => {
      const { values, warnings } = await resolveDomains(['169.254.169.254', 'localhost', 'com', 'nytimes.com']);
      expect(values).toEqual(['nytimes.com', '*.nytimes.com']);
      expect(warnings).toEqual([
        '  Warning: Dropped invalid domains value "169.254.169.254" from @sites: an IP address',
        '  Warning: Dropped invalid domains value "localhost" from @sites: a local, private-use or single-label name',
        '  Warning: Dropped invalid domains value "com" from @sites: a public suffix (registry section of the Public Suffix List)',
      ]);
    });

    it('drops other IP spellings, local and private-use names, single labels and public suffixes', async () => {
      const rejected = [
        '127.0.0.1',
        '10.0.0.1',
        '2130706433',
        '127.1',
        'metadata.google.internal',
        'printer.local',
        'db.internal',
        'intranet',
        'host.corp',
        'co.uk',
        'github.io',
        'readthedocs.io',
        'githubusercontent.com',
      ];
      const { values } = await resolveDomains([...rejected, 'example.com']);
      expect(values).toEqual(['example.com', '*.example.com']);
    });

    it('drops wildcards over public suffixes and multi-tenant parents, whoever wrote them', async () => {
      const wildcards = [
        '*.com',
        '*.co.uk',
        '*.github.io',
        '*.readthedocs.io',
        '*.githubusercontent.com',
        '*.amazonaws.com',
      ];
      const { values, warnings } = await resolveDomains([...wildcards, '*.github.com']);
      expect(values).toEqual(['*.github.com']);
      expect(warnings).toContain(
        '  Warning: Dropped invalid domains value "*.github.io" from @sites: ' +
          'a wildcard over a public suffix (multi-tenant hosting section of the Public Suffix List)',
      );
      expect(warnings).toContain(
        '  Warning: Dropped invalid domains value "*.amazonaws.com" from @sites: ' +
          'a wildcard over the multi-tenant domain amazonaws.com',
      );
    });

    it('keeps a name above a PSL wildcard rule exact and drops a wildcard over it', async () => {
      // Every child of gateway.dev is a separate customer's public suffix.
      const { values, warnings } = await resolveDomains(['gateway.dev', '*.gateway.dev']);
      expect(values).toEqual(['gateway.dev']);
      expect(warnings).toEqual([
        '  Warning: Dropped invalid domains value "*.gateway.dev" from @sites: ' +
          'a wildcard over the multi-tenant domain gateway.dev',
      ]);
    });

    it('keeps registrable names and narrow wildcards, including one tenant of a hosting suffix', async () => {
      const { values } = await resolveDomains(['example.co.uk', '*.example.co.uk', 'alice.github.io', '*.github.com']);
      expect(values).toEqual(['example.co.uk', '*.example.co.uk', 'alice.github.io', '*.github.com']);
    });

    it('escapes control characters when it reports a dropped value', async () => {
      const { warnings } = await resolveDomains(['evil\u001b]52;c;Zm9v\u0007.com']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain('\u001b');
      expect(warnings[0]).not.toContain('\u0007');
      expect(warnings[0]).toContain('evil\\u001b]52;c;Zm9v\\u0007.com');
    });

    // WP-59: a broad wildcard covers hosts anyone can register, and the policy
    // lint rejects allow rules that reach one; a manual addition is the user's
    // own choice and stays (the lint still reports it).
    it('drops broad wildcards from the resolver output, but keeps manual additions', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const def = makeDefinition({ name: 'dev-sites', type: 'domains' });
      const existing: ResolvedList = {
        values: [],
        manualAdditions: ['*.pages.dev'],
        manualRemovals: [],
        resolvedAt: '',
        inputHash: 'stale',
      };
      const result = await resolveList(def, makeConfig(['*', '*.com', '*.github.io', '*.github.com']), existing);
      expect(result.values).toEqual(['*.github.com', '*.pages.dev']);
      expect(consoleSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('"*.github.io"');
      vi.restoreAllMocks();
    });
  });

  // ---------------------------------------------------------------------------
  // validation — type-specific filters
  // ---------------------------------------------------------------------------

  describe('validation — invalid values are dropped', () => {
    it('drops invalid domain values (with whitespace)', async () => {
      const def = makeDefinition({ type: 'domains' });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await resolveList(def, makeConfig(['valid.com', 'not valid.com', '']));
        expect(result.values).toContain('valid.com');
        expect(result.values).not.toContain('not valid.com');
        expect(result.values).not.toContain('');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('drops domain values with protocol prefix', async () => {
      const def = makeDefinition({ type: 'domains' });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await resolveList(def, makeConfig(['https://example.com', 'example.com']));
        expect(result.values).not.toContain('https://example.com');
        expect(result.values).toContain('example.com');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('accepts valid wildcard domain', async () => {
      const def = makeDefinition({ type: 'domains' });
      const result = await resolveList(def, makeConfig(['*.github.com']));
      expect(result.values).toContain('*.github.com');
    });

    it('drops invalid email values (no @)', async () => {
      const def = makeDefinition({ type: 'emails' });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await resolveList(def, makeConfig(['valid@example.com', 'notanemail', '']));
        expect(result.values).toContain('valid@example.com');
        expect(result.values).not.toContain('notanemail');
        expect(result.values).not.toContain('');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('drops identifier values that contain whitespace', async () => {
      const def = makeDefinition({ type: 'identifiers' });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await resolveList(def, makeConfig(['valid-id', 'has space', '']));
        expect(result.values).toContain('valid-id');
        expect(result.values).not.toContain('has space');
        expect(result.values).not.toContain('');
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // manual overrides from existing ResolvedList
  // ---------------------------------------------------------------------------

  describe('manual overrides', () => {
    it('preserves manualAdditions from existing resolution', async () => {
      const def = makeDefinition({ type: 'identifiers' });
      const existing: ResolvedList = {
        values: [],
        manualAdditions: ['always-include'],
        manualRemovals: [],
        resolvedAt: new Date().toISOString(),
        inputHash: 'old-hash',
      };
      const result = await resolveList(def, makeConfig(['llm-value']), existing);
      expect(result.values).toContain('always-include');
      expect(result.values).toContain('llm-value');
      expect(result.manualAdditions).toEqual(['always-include']);
    });

    it('applies manualRemovals to exclude values from LLM output', async () => {
      const def = makeDefinition({ type: 'identifiers' });
      const existing: ResolvedList = {
        values: [],
        manualAdditions: [],
        manualRemovals: ['remove-me'],
        resolvedAt: new Date().toISOString(),
        inputHash: 'old-hash',
      };
      const result = await resolveList(def, makeConfig(['keep-me', 'remove-me']), existing);
      expect(result.values).toContain('keep-me');
      expect(result.values).not.toContain('remove-me');
      expect(result.manualRemovals).toEqual(['remove-me']);
    });

    it('manual removals also block values from manualAdditions', async () => {
      const def = makeDefinition({ type: 'identifiers' });
      const existing: ResolvedList = {
        values: [],
        manualAdditions: ['conflict'],
        manualRemovals: ['conflict'],
        resolvedAt: new Date().toISOString(),
        inputHash: 'old-hash',
      };
      const result = await resolveList(def, makeConfig([]), existing);
      expect(result.values).not.toContain('conflict');
    });
  });

  // ---------------------------------------------------------------------------
  // MCP-required error cases
  // ---------------------------------------------------------------------------

  describe('MCP-required list without a usable MCP connection', () => {
    it('throws when requiresMcp is true and no mcpConnection provided', async () => {
      const def = makeDefinition({ requiresMcp: true, name: 'github-repos', mcpServerHint: 'github' });
      const config: ListResolverConfig = { model: createMockModel([]) };
      // The message names the list and its server and says how to resolve it;
      // it no longer suggests --no-mcp, which is exactly how a run gets here.
      await expect(resolveList(def, config)).rejects.toThrow(/has no MCP access/);
      await expect(resolveList(def, config)).rejects.toThrow(/github-repos/);
      await expect(resolveList(def, config)).rejects.toThrow(/"github"/);
      await expect(resolveList(def, config)).rejects.not.toThrow(/use --no-mcp to skip/);
    });

    it('throws when mcpConnection has no tools', async () => {
      const def = makeDefinition({ requiresMcp: true, mcpServerHint: 'github' });
      const config: ListResolverConfig = {
        model: createMockModel([]),
        mcpConnection: { tools: [], callTool: vi.fn() },
      };
      await expect(resolveList(def, config)).rejects.toThrow(/no MCP tools are available/);
    });

    it('throws when a data-backed list names no MCP server, before any tool call', async () => {
      const def = makeDefinition({ requiresMcp: true, name: 'unscoped' });
      const callTool = vi.fn();
      const config: ListResolverConfig = {
        model: createMockModel([]),
        mcpConnection: {
          tools: [{ serverName: 'github', name: 'list_issues', inputSchema: {}, offered: true }],
          callTool,
        },
      };
      await expect(resolveList(def, config)).rejects.toThrow(/no mcpServerHint/);
      expect(callTool).not.toHaveBeenCalled();
    });

    it('refuses a network-egress server as the data source', async () => {
      const def = makeDefinition({ requiresMcp: true, mcpServerHint: 'fetch' });
      const config: ListResolverConfig = {
        model: createMockModel([]),
        mcpConnection: {
          tools: [{ serverName: 'fetch', name: 'web_search', inputSchema: {}, offered: true }],
          callTool: vi.fn(),
        },
      };
      await expect(resolveList(def, config)).rejects.toThrow(/network server "fetch"/);
    });

    it('does not fall back to the tools of another server', async () => {
      const def = makeDefinition({ requiresMcp: true, mcpServerHint: 'google-workspace' });
      const config: ListResolverConfig = {
        model: createMockModel([]),
        mcpConnection: {
          tools: [{ serverName: 'github', name: 'list_issues', inputSchema: {}, offered: true }],
          callTool: vi.fn(),
        },
      };
      await expect(resolveList(def, config)).rejects.toThrow(
        /no MCP tools are available from server "google-workspace"/,
      );
    });

    it('throws when the named server offers no tool the read-only policy can allow', async () => {
      const def = makeDefinition({ requiresMcp: true, mcpServerHint: 'github' });
      const config: ListResolverConfig = {
        model: createMockModel([]),
        mcpConnection: {
          tools: [{ serverName: 'github', name: 'push_files', inputSchema: {}, offered: false }],
          callTool: vi.fn(),
        },
      };
      await expect(resolveList(def, config)).rejects.toThrow(/no MCP tools are available/);
    });
  });

  // ---------------------------------------------------------------------------
  // inputHash consistency
  // ---------------------------------------------------------------------------

  describe('inputHash consistency', () => {
    it('produces the same hash for the same definition', async () => {
      const def = makeDefinition();
      const result1 = await resolveList(def, makeConfig(['a']));
      const result2 = await resolveList(def, makeConfig(['b']));
      expect(result1.inputHash).toBe(result2.inputHash);
    });

    it('produces a different hash when generationPrompt changes', async () => {
      const def1 = makeDefinition({ generationPrompt: 'Prompt A' });
      const def2 = makeDefinition({ generationPrompt: 'Prompt B' });
      const result1 = await resolveList(def1, makeConfig(['x']));
      const result2 = await resolveList(def2, makeConfig(['x']));
      expect(result1.inputHash).not.toBe(result2.inputHash);
    });

    it('produces a different hash when type changes', async () => {
      const def1 = makeDefinition({ type: 'domains' });
      const def2 = makeDefinition({ type: 'emails' });
      const result1 = await resolveList(def1, makeConfig(['a@b.com']));
      const result2 = await resolveList(def2, makeConfig(['a@b.com']));
      expect(result1.inputHash).not.toBe(result2.inputHash);
    });

    it('produces a different hash when a data-backed list names another server', async () => {
      const fromGithub = makeDefinition({ type: 'emails', requiresMcp: true, mcpServerHint: 'github' });
      const fromMail = makeDefinition({ type: 'emails', requiresMcp: true, mcpServerHint: 'google-workspace' });
      const mcpConnection = twoServerConnection();
      const result1 = await resolveList(fromGithub, { model: createMockModel(['a@b.com']), mcpConnection });
      const result2 = await resolveList(fromMail, { model: createMockModel(['a@b.com']), mcpConnection });
      expect(result1.inputHash).not.toBe(result2.inputHash);
    });

    it('ignores mcpServerHint on a knowledge-based list', async () => {
      const result1 = await resolveList(makeDefinition(), makeConfig(['x']));
      const result2 = await resolveList(makeDefinition({ mcpServerHint: 'github' }), makeConfig(['x']));
      expect(result1.inputHash).toBe(result2.inputHash);
    });
  });
});

/** A mediated connection offering one read tool on each of two servers. */
function twoServerConnection(): NonNullable<ListResolverConfig['mcpConnection']> {
  return {
    tools: [
      { serverName: 'github', name: 'list_issues', inputSchema: {}, offered: true },
      { serverName: 'google-workspace', name: 'gmail_search_messages', inputSchema: {}, offered: true },
    ],
    callTool: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// resolveAllLists — caching and batch behavior
// ---------------------------------------------------------------------------

describe('resolveAllLists', () => {
  describe('empty input', () => {
    it('returns a DynamicListsFile with empty lists for empty definitions', async () => {
      const config = makeConfig([]);
      const result = await resolveAllLists([], config);
      expect(result.lists).toEqual({});
      expect(result.generatedAt).toBeTruthy();
    });
  });

  describe('cache behavior', () => {
    it('calls the LLM once when there is no existing resolved list', async () => {
      const { model, callCount } = createCountingMockModel(['item1']);
      const def = makeDefinition({ name: 'my-list' });
      const config: ListResolverConfig = { model };

      await resolveAllLists([def], config);
      expect(callCount()).toBe(1);
    });

    it('skips LLM call when inputHash matches (cache hit)', async () => {
      // First pass: resolve and get the hash
      const { model: model1, callCount: callCount1 } = createCountingMockModel(['cached-value']);
      const def = makeDefinition({ name: 'cached-list', type: 'identifiers' });
      const config1: ListResolverConfig = { model: model1 };

      const first = await resolveAllLists([def], config1);
      expect(callCount1()).toBe(1);

      // Second pass: same definition + existing result (hash matches) → no LLM call
      const { model: model2, callCount: callCount2 } = createCountingMockModel(['new-value']);
      const config2: ListResolverConfig = { model: model2 };

      const second = await resolveAllLists([def], config2, first);
      expect(callCount2()).toBe(0);
      // The cached values are preserved
      expect(second.lists['cached-list'].values).toContain('cached-value');
    });

    it('drops broad wildcards an older resolver cached, but keeps manual additions (no LLM call)', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const def = makeDefinition({ name: 'dev-sites', type: 'domains' });
      const first = await resolveAllLists([def], makeConfig(['docs.python.org']));
      const cached = first.lists['dev-sites'];
      const stale = {
        ...first,
        lists: {
          'dev-sites': {
            ...cached,
            values: [...cached.values, '*.readthedocs.io', '*.github.io'],
            manualAdditions: ['*.github.io'],
          },
        },
      };

      const { model, callCount } = createCountingMockModel(['unused.example']);
      const second = await resolveAllLists([def], { model }, stale);
      expect(callCount()).toBe(0);
      expect(second.lists['dev-sites'].values).toEqual(['docs.python.org', '*.docs.python.org', '*.github.io']);
      expect(second.lists['dev-sites'].inputHash).toBe(cached.inputHash);
      vi.restoreAllMocks();
    });

    it('re-resolves when the definition changes (cache miss)', async () => {
      // First pass: compute hash for def1
      const { model: model1, callCount: callCount1 } = createCountingMockModel(['old-value']);
      const def1 = makeDefinition({ name: 'evolving-list', generationPrompt: 'First prompt' });
      const config1: ListResolverConfig = { model: model1 };

      const first = await resolveAllLists([def1], config1);
      expect(callCount1()).toBe(1);

      // Second pass: different generationPrompt → different hash → re-resolves
      const { model: model2, callCount: callCount2 } = createCountingMockModel(['new-value']);
      const def2 = makeDefinition({ name: 'evolving-list', generationPrompt: 'Changed prompt' });
      const config2: ListResolverConfig = { model: model2 };

      const second = await resolveAllLists([def2], config2, first);
      expect(callCount2()).toBe(1);
      expect(second.lists['evolving-list'].values).toContain('new-value');
    });

    it('reuses a data-backed list only while it names the same server', async () => {
      const mcpConnection = twoServerConnection();
      const fromGithub = makeDefinition({
        name: 'reporters',
        type: 'emails',
        requiresMcp: true,
        mcpServerHint: 'github',
      });
      const first = await resolveAllLists([fromGithub], { model: createMockModel(['old@example.com']), mcpConnection });

      // Same definition, same server: served from the cache.
      const sameServer = createCountingMockModel(['unused@example.com']);
      await resolveAllLists([fromGithub], { model: sameServer.model, mcpConnection }, first);
      expect(sameServer.callCount()).toBe(0);

      // The list now reads another server: values cached from github must
      // not be reused as if google-workspace had produced them.
      const otherServer = createCountingMockModel(['new@example.com']);
      const fromMail = { ...fromGithub, mcpServerHint: 'google-workspace' };
      const second = await resolveAllLists([fromMail], { model: otherServer.model, mcpConnection }, first);
      expect(otherServer.callCount()).toBe(1);
      expect(second.lists.reporters.values).toEqual(['new@example.com']);
    });

    it('bypasses cache when bypassCache is true', async () => {
      // First pass: populate cache
      const { model: model1 } = createCountingMockModel(['original']);
      const def = makeDefinition({ name: 'force-refresh' });
      const config1: ListResolverConfig = { model: model1 };
      const first = await resolveAllLists([def], config1);

      // Second pass: same hash, but bypassCache forces re-resolution
      const { model: model2, callCount: callCount2 } = createCountingMockModel(['fresh-value']);
      const config2: ListResolverConfig = { model: model2 };

      const second = await resolveAllLists([def], config2, first, undefined, true);
      expect(callCount2()).toBe(1);
      expect(second.lists['force-refresh'].values).toContain('fresh-value');
    });

    it('re-validates a cached resolution against the current rules, keeping manual additions', async () => {
      const def = makeDefinition({ name: 'dev-sites', type: 'domains' });
      const first = await resolveAllLists([def], makeConfig(['github.com']));
      // A resolution cached under older, looser rules (same inputHash).
      const stale: ResolvedList = {
        ...first.lists['dev-sites'],
        values: ['github.com', '*.github.com', 'readthedocs.io', '*.readthedocs.io', '169.254.169.254', '*.co.uk'],
        manualAdditions: ['*.co.uk'],
      };
      const { model, callCount } = createCountingMockModel(['unused.com']);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const second = await resolveAllLists([def], { model }, { generatedAt: '', lists: { 'dev-sites': stale } });
        expect(callCount()).toBe(0);
        expect(second.lists['dev-sites'].values).toEqual(['github.com', '*.github.com', '*.co.uk']);
        expect(second.lists['dev-sites'].inputHash).toBe(stale.inputHash);
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Dropped previously resolved domains value "*.readthedocs.io" from @dev-sites'),
        );
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('reports progress for cached lists', async () => {
      // Set up a cached list (matching hash)
      const { model: model1 } = createCountingMockModel(['cached']);
      const def = makeDefinition({ name: 'progress-list' });
      const first = await resolveAllLists([def], { model: model1 });

      // On second pass, onProgress should fire with "(cached)" message
      const { model: model2 } = createCountingMockModel(['new']);
      const progressMessages: string[] = [];
      await resolveAllLists([def], { model: model2 }, first, (msg) => progressMessages.push(msg));

      expect(progressMessages.some((m) => m.includes('cached'))).toBe(true);
    });

    it('resolves multiple lists, caching only those with matching hashes', async () => {
      const defA = makeDefinition({ name: 'list-a', generationPrompt: 'Prompt A' });
      const defB = makeDefinition({ name: 'list-b', generationPrompt: 'Prompt B' });

      // First pass: resolve both
      const { model: model1, callCount: callCount1 } = createCountingMockModel(['x']);
      const first = await resolveAllLists([defA, defB], { model: model1 });
      expect(callCount1()).toBe(2);

      // Second pass: only defB changed → only one LLM call
      const defBChanged = makeDefinition({ name: 'list-b', generationPrompt: 'NEW Prompt B' });
      const { model: model2, callCount: callCount2 } = createCountingMockModel(['y']);
      await resolveAllLists([defA, defBChanged], { model: model2 }, first);
      expect(callCount2()).toBe(1);
    });
  });

  describe('output structure', () => {
    it('includes all resolved list names as keys', async () => {
      const defA = makeDefinition({ name: 'alpha' });
      const defB = makeDefinition({ name: 'beta' });
      const result = await resolveAllLists([defA, defB], makeConfig(['v']));
      expect(Object.keys(result.lists)).toContain('alpha');
      expect(Object.keys(result.lists)).toContain('beta');
    });

    it('each resolved entry has required fields', async () => {
      const def = makeDefinition({ name: 'check' });
      const result = await resolveAllLists([def], makeConfig(['item']));
      const entry = result.lists['check'];
      expect(Array.isArray(entry.values)).toBe(true);
      expect(Array.isArray(entry.manualAdditions)).toBe(true);
      expect(Array.isArray(entry.manualRemovals)).toBe(true);
      expect(typeof entry.resolvedAt).toBe('string');
      expect(typeof entry.inputHash).toBe('string');
    });
  });
});

// ---------------------------------------------------------------------------
// revalidateResolvedList / list value changes — review output
// ---------------------------------------------------------------------------

function resolvedList(values: string[], manualAdditions: string[] = []): ResolvedList {
  return { values, manualAdditions, manualRemovals: [], resolvedAt: '', inputHash: 'h' };
}

function listsFile(lists: Record<string, ResolvedList>): DynamicListsFile {
  return { generatedAt: '', lists };
}

describe('revalidateResolvedList', () => {
  it('retains partial validation loss after later validations and refresh carry-over', () => {
    const definition = makeDefinition({ name: 'docs', type: 'domains' });
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const partial = revalidateResolvedList(
        { ...resolvedList(['docs.example.com', '*.co.uk']), resolutionState: 'complete' },
        definition,
      );
      expect(partial.values).toEqual(['docs.example.com']);
      expect(partial.resolutionState).toBe('incomplete');
      expect(revalidateResolvedList(partial, definition).resolutionState).toBe('incomplete');
      const carried = mergeRefreshedLists(listsFile({ docs: partial }), listsFile({}), [definition]);
      expect(carried.lists.docs.resolutionState).toBe('incomplete');
    } finally {
      warning.mockRestore();
    }
  });

  it('marks empty and partially filtered fresh resolutions incomplete, including manual additions', async () => {
    const definition = makeDefinition({ type: 'domains' });
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const partial = await resolveList(definition, makeConfig(['docs.example.com', '*.co.uk']));
      expect(partial.resolutionState).toBe('incomplete');
      const empty = await resolveList(definition, makeConfig([]), resolvedList([], ['manual.example.com']));
      expect(empty.values).toEqual(['manual.example.com']);
      expect(empty.resolutionState).toBe('incomplete');
      expect((await resolveList(definition, makeConfig(['docs.example.com']))).resolutionState).toBe('complete');
    } finally {
      warning.mockRestore();
    }
  });

  it('resolves legacy and incomplete entries again instead of treating survivors as complete cache hits', async () => {
    const definition = makeDefinition();
    const fresh = await resolveAllLists([definition], makeConfig(['ordinary']));
    const legacy = { ...fresh.lists[definition.name], resolutionState: undefined };
    for (const entry of [legacy, { ...legacy, resolutionState: 'incomplete' as const }]) {
      const mock = createCountingMockModel(['fresh']);
      const result = await resolveAllLists(
        [definition],
        { model: mock.model },
        listsFile({ [definition.name]: entry }),
      );
      expect(mock.callCount()).toBe(1);
      expect(result.lists[definition.name].resolutionState).toBe('complete');
    }
  });
  it('returns the list unchanged when every value is still valid', () => {
    const list = resolvedList(['github.com', '*.github.com']);
    expect(revalidateResolvedList(list, makeDefinition({ type: 'domains' }))).toBe(list);
  });

  it('leaves non-domain lists to their own rules', () => {
    const list = resolvedList(['169.254.169.254', 'com']);
    expect(revalidateResolvedList(list, makeDefinition({ type: 'identifiers' }))).toBe(list);
  });
});

describe('mergeRefreshedLists (refresh-lists output)', () => {
  it('re-validates the lists it carries over, replaces refreshed ones in place, and keeps the order', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const existing = listsFile({
        docs: resolvedList(['readthedocs.org', '*.readthedocs.org', 'readthedocs.io', '*.readthedocs.io']),
        news: resolvedList(['bbc.com', '*.bbc.com']),
        contacts: resolvedList(['alice@example.com']),
        orphan: resolvedList(['*.co.uk']),
      });
      const refreshed = listsFile({ news: resolvedList(['npr.org', '*.npr.org']) });
      const merged = mergeRefreshedLists(existing, refreshed, [
        makeDefinition({ name: 'docs', type: 'domains' }),
        makeDefinition({ name: 'news', type: 'domains' }),
        makeDefinition({ name: 'contacts', type: 'emails' }),
      ]);

      expect(Object.keys(merged.lists)).toEqual(['docs', 'news', 'contacts', 'orphan']);
      // Cached under older rules and not refreshed: the multi-tenant suffix goes.
      expect(merged.lists.docs.values).toEqual(['readthedocs.org', '*.readthedocs.org']);
      expect(merged.lists.news).toBe(refreshed.lists.news);
      expect(merged.lists.contacts).toBe(existing.lists.contacts);
      // A list the policy no longer defines has no type to check it by.
      expect(merged.lists.orphan).toBe(existing.lists.orphan);
      expect(diffListValues(existing, merged)).toEqual([
        { name: 'docs', added: [], removed: ['readthedocs.io', '*.readthedocs.io'], total: 2 },
        { name: 'news', added: ['npr.org', '*.npr.org'], removed: ['bbc.com', '*.bbc.com'], total: 2 },
      ]);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe('list value changes', () => {
  it('reports added and removed values per list and skips unchanged lists', () => {
    const before = listsFile({
      news: resolvedList(['bbc.com', '*.bbc.com', 'cnn.com']),
      same: resolvedList(['x.com']),
    });
    const after = listsFile({
      news: resolvedList(['bbc.com', '*.bbc.com', 'npr.org', '*.npr.org']),
      same: resolvedList(['x.com']),
    });
    expect(diffListValues(before, after)).toEqual([
      { name: 'news', added: ['npr.org', '*.npr.org'], removed: ['cnn.com'], total: 4 },
    ]);
  });

  it('counts every value of a new list as added', () => {
    const after = listsFile({ contacts: resolvedList(['alice@example.com']) });
    expect(diffListValues(undefined, after)).toEqual([
      { name: 'contacts', added: ['alice@example.com'], removed: [], total: 1 },
    ]);
  });

  it('formats every changed value for review, escaping control characters', () => {
    const lines = formatListValueChanges([
      { name: 'news', added: ['npr.org', '*.npr.org'], removed: ['cnn.com'], total: 4 },
      { name: 'ids', added: ['evil\u001b[2J'], removed: [], total: 1 },
    ]);
    expect(lines).toEqual([
      '  @news: 4 value(s), 2 added, 1 removed',
      '    + npr.org, *.npr.org',
      '    - cnn.com',
      '  @ids: 1 value(s), 1 added, 0 removed',
      '    + evil\\u001b[2J',
    ]);
  });
});

// ---------------------------------------------------------------------------
// bridgeMediatedTools — input guards in front of the security kernel
// ---------------------------------------------------------------------------

describe('bridgeMediatedTools', () => {
  const listIssues = { serverName: 'github', name: 'list_issues', inputSchema: {}, offered: true };
  const callOptions = { toolCallId: 'call-1', messages: [] };

  it('routes a call to the mediated caller with its server', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false });
    const tools = bridgeMediatedTools({ callTool }, [listIssues]);

    const output: unknown = await tools.list_issues.execute?.({ owner: 'acme', repo: 'widgets' }, callOptions);

    expect(output).toBe('ok');
    expect(callTool).toHaveBeenCalledWith('github', 'list_issues', { owner: 'acme', repo: 'widgets' });
  });

  it.each([[[1, 2]], ['text'], [null]])('refuses arguments that are not a JSON object (%j)', async (args) => {
    const callTool = vi.fn();
    const tools = bridgeMediatedTools({ callTool }, [listIssues]);

    const output: unknown = await tools.list_issues.execute?.(args, callOptions);

    expect(output).toMatch(/must be a JSON object/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('keeps a tool named "__proto__" as an ordinary entry', () => {
    const tools = bridgeMediatedTools({ callTool: vi.fn() }, [{ ...listIssues, name: '__proto__' }]);
    expect(Object.keys(tools)).toEqual(['__proto__']);
  });
});

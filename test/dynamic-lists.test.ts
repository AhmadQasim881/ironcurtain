/**
 * Tests for dynamic lists: types, compiler emission, validation,
 * list type registry, list resolver, policy engine expansion,
 * ListCondition evaluation, and MCP-backed resolution.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import {
  buildRepairInstructions,
  compileConstitution,
  validateCompiledRules,
  type CompilerConfig,
} from '../src/pipeline/constitution-compiler.js';
import { LIST_TYPE_REGISTRY } from '../src/pipeline/dynamic-list-types.js';
import { getListMatcher } from '../src/trusted-process/list-matcher.js';
import { resolveList, resolveAllLists, type ListResolverConfig } from '../src/pipeline/list-resolver.js';
import type { MediatedTool, MediatedToolCaller, MediatedToolResult } from '../src/pipeline/proxy-mcp-connections.js';
import { buildGeneratorSystemPrompt, formatDynamicListsSection } from '../src/pipeline/scenario-generator.js';
import { buildJudgeSystemPrompt } from '../src/pipeline/policy-verifier.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  DynamicListsFile,
  ListDefinition,
  RepairContext,
  ResolvedList,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const sampleAnnotations: StoredToolAnnotation[] = [
  {
    toolName: 'fetch',
    serverName: 'fetch',
    comment: 'Fetches a URL via HTTP',
    args: { url: ['fetch-url'] },
    inputSchema: {},
  },
  {
    toolName: 'read_file',
    serverName: 'filesystem',
    comment: 'Reads a file',
    args: { path: ['read-path'] },
    inputSchema: {},
  },
];

const compilerConfig: CompilerConfig = {
  protectedPaths: ['/etc/ironcurtain'],
};

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

function createMockModel(response: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      ...MOCK_GENERATE_RESULT,
    }),
  });
}

/**
 * Creates a mock model that counts calls and returns dynamic values.
 * The valueFactory receives the 1-based call index for dynamic responses.
 */
function createCountingModel(valueFactory: (callIndex: number) => string[] = () => ['NEW']): {
  model: MockLanguageModelV3;
  getCallCount: () => number;
} {
  let callCount = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      callCount++;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ values: valueFactory(callCount) }) }],
        ...MOCK_GENERATE_RESULT,
      };
    },
  });
  return { model, getCallCount: () => callCount };
}

function createPromptCapturingModel(response: unknown): {
  model: MockLanguageModelV3;
  getPrompt: () => string;
  getSystemPrompt: () => string;
} {
  let capturedPrompt = '';
  let capturedSystem = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      for (const msg of options.prompt) {
        if (msg.role === 'system') {
          capturedSystem = typeof msg.content === 'string' ? msg.content : '';
        }
        if (msg.role === 'user') {
          for (const part of msg.content) {
            if (part.type === 'text') capturedPrompt = part.text;
          }
        }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response) }],
        ...MOCK_GENERATE_RESULT,
      };
    },
  });
  return { model, getPrompt: () => capturedPrompt, getSystemPrompt: () => capturedSystem };
}

const fetchAnnotation: StoredToolAnnotation = {
  toolName: 'fetch',
  serverName: 'fetch',
  comment: 'Fetches URL',
  args: { url: ['fetch-url'] },
  inputSchema: {},
};

/**
 * A tool whose argument has an identifier-category role, the stand-in for
 * list conditions on values that are not URLs (email recipients, tickers).
 * A url-category role would not do: the structural domain gate treats a
 * fetch-url value that is not an http(s) URL as unverifiable and escalates.
 */
const identifierAnnotation: StoredToolAnnotation = {
  toolName: 'lookup',
  serverName: 'directory',
  comment: 'Looks up an identifier',
  args: { id: ['github-owner'] },
  inputSchema: {},
};

// Reusable list definitions for tests
const newsListDef: ListDefinition = {
  name: 'major-news-sites',
  type: 'domains',
  principle: 'collect news from major news sites',
  generationPrompt: 'List 20 major English-language news sites.',
  requiresMcp: false,
};

const contactsListDef: ListDefinition = {
  name: 'my-contacts',
  type: 'emails',
  principle: 'send email to my contacts',
  generationPrompt: 'Query the contacts database for all email addresses.',
  requiresMcp: true,
  mcpServerHint: 'contacts',
};

const stocksListDef: ListDefinition = {
  name: 'tech-stock-tickers',
  type: 'identifiers',
  principle: 'get financial data for major tech stocks',
  generationPrompt: 'List 20 major tech stock ticker symbols.',
  requiresMcp: false,
};

const plainReadRule: CompiledRule = {
  name: 'allow-reads',
  description: 'Allow reads',
  principle: 'open',
  if: { tool: ['fetch', 'read_file'] },
  then: 'allow',
  reason: 'Safe',
};

// Reusable rules that reference lists
function makeRuleWithDomainList(listName: string): CompiledRule {
  return {
    name: 'allow-news',
    description: 'Allow fetching from news sites',
    principle: 'collect news',
    if: {
      domains: {
        roles: ['fetch-url'],
        allowed: [`@${listName}`],
      },
    },
    then: 'allow',
    reason: 'News sites are allowed',
  };
}

function makeRuleWithListCondition(listName: string, matchType: 'domains' | 'emails' | 'identifiers'): CompiledRule {
  return {
    name: 'allow-contacts',
    description: 'Allow sending to contacts',
    principle: 'send to contacts',
    if: {
      lists: [
        {
          roles: ['fetch-url'],
          allowed: [`@${listName}`],
          matchType,
        },
      ],
    },
    then: 'allow',
    reason: 'Known contacts are allowed',
  };
}

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe('Dynamic Lists Validation', () => {
  describe('orphaned @list-name references', () => {
    it('errors when @list-name in domains.allowed has no matching definition', () => {
      const rules = [makeRuleWithDomainList('nonexistent-list')];
      const result = validateCompiledRules(rules, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('@nonexistent-list');
      expect(result.errors[0]).toContain('no matching list definition');
    });

    it('errors when @list-name in lists[].allowed has no matching definition', () => {
      const rules = [makeRuleWithListCondition('nonexistent-list', 'emails')];
      const result = validateCompiledRules(rules, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('@nonexistent-list');
      expect(result.errors[0]).toContain('no matching list definition');
    });
  });

  describe('orphaned list definitions', () => {
    it('warns when a list definition is not referenced by any rule', () => {
      const rules: CompiledRule[] = [
        {
          name: 'allow-all-reads',
          description: 'Allow reads',
          principle: 'open read',
          if: { tool: ['fetch', 'read_file'] },
          then: 'allow',
          reason: 'Read tools are safe',
        },
      ];

      const result = validateCompiledRules(rules, [newsListDef]);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('major-news-sites');
      expect(result.warnings[0]).toContain('not referenced');
    });
  });

  describe('domain-type list in ListCondition', () => {
    it('errors when a domains-type list appears in lists[] instead of domains.allowed', () => {
      const rules = [makeRuleWithListCondition('major-news-sites', 'domains')];
      const result = validateCompiledRules(rules, [newsListDef]);

      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.includes('@major-news-sites') && e.includes('"domains" list') && e.includes('domains.allowed'),
        ),
      ).toBe(true);
    });
  });

  describe('matchType mismatch with list type', () => {
    it('errors when lists[].matchType does not match the list definition type', () => {
      // contacts list is type: 'emails', but rule says matchType: 'identifiers'
      const rules = [makeRuleWithListCondition('my-contacts', 'identifiers')];
      const result = validateCompiledRules(rules, [contactsListDef]);

      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.includes('matchType "identifiers"') && e.includes('@my-contacts') && e.includes('"emails"'),
        ),
      ).toBe(true);
    });
  });

  describe('non-domain list in domains.allowed', () => {
    it('errors when an emails-type list is referenced in domains.allowed', () => {
      const rules = [makeRuleWithDomainList('my-contacts')];
      const result = validateCompiledRules(rules, [contactsListDef]);

      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) =>
            e.includes('@my-contacts') &&
            e.includes('"emails" list') &&
            e.includes('only "domains" lists belong in domains.allowed'),
        ),
      ).toBe(true);
    });
  });

  describe('valid list references', () => {
    it('passes when domain list is correctly referenced in domains.allowed', () => {
      const rules = [makeRuleWithDomainList('major-news-sites')];
      const result = validateCompiledRules(rules, [newsListDef]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('passes when email list is correctly referenced in lists[] with matching matchType', () => {
      const rules = [makeRuleWithListCondition('my-contacts', 'emails')];
      const result = validateCompiledRules(rules, [contactsListDef]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('passes when identifier list is correctly referenced in lists[] with matching matchType', () => {
      const rules = [makeRuleWithListCondition('tech-stock-tickers', 'identifiers')];
      const result = validateCompiledRules(rules, [stocksListDef]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('passes with mixed concrete values and @list-name references', () => {
      const rules: CompiledRule[] = [
        {
          name: 'allow-news-and-specific',
          description: 'Allow news sites and a specific domain',
          principle: 'news access',
          if: {
            domains: {
              roles: ['fetch-url'],
              allowed: ['example.com', '@major-news-sites'],
            },
          },
          then: 'allow',
          reason: 'Allowed domains',
        },
      ];

      const result = validateCompiledRules(rules, [newsListDef]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes with no list definitions and no @list-name references', () => {
      const result = validateCompiledRules([plainReadRule], []);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Compiler output tests
// ---------------------------------------------------------------------------

describe('Dynamic Lists Compiler Output', () => {
  it('includes listDefinitions when LLM emits them', async () => {
    const rulesWithLists = [makeRuleWithDomainList('major-news-sites')];

    const mockLLM = createMockModel({
      rules: rulesWithLists,
      listDefinitions: [newsListDef],
    });

    const result = await compileConstitution(
      'Collect news from major news sites.',
      sampleAnnotations,
      compilerConfig,
      mockLLM,
    );

    expect(result.rules).toHaveLength(1);
    expect(result.listDefinitions).toHaveLength(1);
    expect(result.listDefinitions[0].name).toBe('major-news-sites');
    expect(result.listDefinitions[0].type).toBe('domains');
    expect(result.listDefinitions[0].requiresMcp).toBe(false);
  });

  it('returns empty listDefinitions when LLM emits none', async () => {
    const mockLLM = createMockModel({ rules: [plainReadRule] });

    const result = await compileConstitution('Allow all read operations.', sampleAnnotations, compilerConfig, mockLLM);

    expect(result.rules).toHaveLength(1);
    expect(result.listDefinitions).toEqual([]);
  });

  it('returns empty listDefinitions when LLM explicitly passes empty array', async () => {
    const mockLLM = createMockModel({ rules: [plainReadRule], listDefinitions: [] });

    const result = await compileConstitution('Allow all read operations.', sampleAnnotations, compilerConfig, mockLLM);

    expect(result.listDefinitions).toEqual([]);
  });

  it('includes lists condition in rule when LLM emits it', async () => {
    const rulesWithListCondition: CompiledRule[] = [
      {
        name: 'allow-contacts',
        description: 'Allow sending to contacts',
        principle: 'send to contacts',
        if: {
          lists: [
            {
              roles: ['fetch-url'],
              allowed: ['@my-contacts'],
              matchType: 'emails',
            },
          ],
        },
        then: 'allow',
        reason: 'Contact is known',
      },
    ];

    const mockLLM = createMockModel({
      rules: rulesWithListCondition,
      listDefinitions: [contactsListDef],
    });

    const result = await compileConstitution(
      'Send email to my contacts without asking.',
      sampleAnnotations,
      compilerConfig,
      mockLLM,
    );

    expect(result.rules[0].if.lists).toBeDefined();
    expect(result.rules[0].if.lists![0].matchType).toBe('emails');
    expect(result.rules[0].if.lists![0].allowed).toEqual(['@my-contacts']);
    expect(result.listDefinitions[0].name).toBe('my-contacts');
  });

  describe('MCP scope of data-backed lists', () => {
    const contactsRule: CompiledRule = {
      name: 'allow-contacts',
      description: 'Allow sending to contacts',
      principle: 'send to contacts',
      if: { lists: [{ roles: ['fetch-url'], allowed: ['@my-contacts'], matchType: 'emails' }] },
      then: 'allow',
      reason: 'Contact is known',
    };

    /** Model whose first answer uses `firstDefinition`, and whose repair answer uses contactsListDef. */
    function createRepairingModel(firstDefinition: Record<string, unknown>): MockLanguageModelV3 {
      let call = 0;
      return new MockLanguageModelV3({
        doGenerate: async () => {
          call++;
          const listDefinitions = call === 1 ? [firstDefinition] : [contactsListDef];
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ rules: [contactsRule], listDefinitions }) }],
            ...MOCK_GENERATE_RESULT,
          };
        },
      });
    }

    it('rejects a data-backed list without mcpServerHint and asks the compiler to repair it', async () => {
      const unhinted = {
        name: contactsListDef.name,
        type: contactsListDef.type,
        principle: contactsListDef.principle,
        generationPrompt: contactsListDef.generationPrompt,
        requiresMcp: true,
      };
      const model = createRepairingModel(unhinted);

      const result = await compileConstitution('Email my contacts.', sampleAnnotations, compilerConfig, model);

      expect(model.doGenerateCalls).toHaveLength(2);
      expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('no mcpServerHint');
      expect(result.listDefinitions[0].mcpServerHint).toBe('contacts');
    });

    it('rejects a list backed by the network-fetch server', async () => {
      const model = createRepairingModel({ ...contactsListDef, mcpServerHint: 'fetch' });

      const result = await compileConstitution('Email my contacts.', sampleAnnotations, compilerConfig, model);

      expect(model.doGenerateCalls).toHaveLength(2);
      expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('network server');
      expect(result.listDefinitions[0].mcpServerHint).toBe('contacts');
    });

    it('accepts a knowledge-based list without mcpServerHint', async () => {
      const mockLLM = createMockModel({
        rules: [makeRuleWithDomainList('major-news-sites')],
        listDefinitions: [newsListDef],
      });

      const result = await compileConstitution('Collect news.', sampleAnnotations, compilerConfig, mockLLM);

      expect(result.listDefinitions[0].mcpServerHint).toBeUndefined();
    });

    it('tells the compiler that mcpServerHint is required for data-backed lists', async () => {
      const { model, getSystemPrompt } = createPromptCapturingModel({ rules: [] });

      await compileConstitution('Email my contacts.', sampleAnnotations, compilerConfig, model);

      expect(getSystemPrompt()).toContain('mcpServerHint: REQUIRED when requiresMcp is true');
    });
  });

  it('system prompt includes Dynamic Lists section', async () => {
    const { model, getSystemPrompt } = createPromptCapturingModel({ rules: [] });

    await compileConstitution('Allow news sites.', sampleAnnotations, compilerConfig, model);

    const system = getSystemPrompt();
    expect(system).toContain('## Dynamic Lists');
    expect(system).toContain('@major-news-sites');
    expect(system).toContain('listDefinitions');
    expect(system).toContain('kebab-case');
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('Dynamic Lists Backward Compatibility', () => {
  it('validateCompiledRules works without listDefinitions parameter', () => {
    // Call without second argument -- should use default empty array
    const result = validateCompiledRules([plainReadRule]);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('CompiledRuleCondition without lists field is valid', () => {
    const rules: CompiledRule[] = [
      {
        name: 'allow-sandbox',
        description: 'Allow sandbox reads',
        principle: 'containment',
        if: {
          paths: { roles: ['read-path'], within: '/tmp/sandbox' },
        },
        then: 'allow',
        reason: 'Sandbox',
      },
    ];

    const result = validateCompiledRules(rules, []);

    expect(result.valid).toBe(true);
  });

  it('PolicyEngine works without dynamicLists parameter', () => {
    const policy: CompiledPolicyFile = {
      generatedAt: '',
      constitutionHash: '',
      inputHash: '',
      rules: [plainReadRule],
    };
    const annotations: StoredToolAnnotationsFile = {
      generatedAt: '',
      servers: {
        filesystem: { inputHash: '', tools: [sampleAnnotations[1]] },
      },
    };

    // No dynamicLists parameter -- backward compatible
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: '/tmp/file.txt' },
      timestamp: '',
    });
    expect(result.decision).toBe('allow');
  });
});

// ===========================================================================
// Phase 2: List type registry, resolver, policy engine expansion
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared fixtures for Phase 2 tests
// ---------------------------------------------------------------------------

function makeToolAnnotationsFile(tools: StoredToolAnnotation[]): StoredToolAnnotationsFile {
  const servers: StoredToolAnnotationsFile['servers'] = {};
  for (const tool of tools) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: building map, key may not exist yet
    if (!servers[tool.serverName]) {
      servers[tool.serverName] = { inputHash: '', tools: [] };
    }
    servers[tool.serverName].tools.push(tool);
  }
  return { generatedAt: '', servers };
}

function makePolicyFile(rules: CompiledRule[], listDefinitions?: ListDefinition[]): CompiledPolicyFile {
  return {
    generatedAt: '',
    constitutionHash: '',
    inputHash: '',
    rules,
    listDefinitions,
  };
}

function makeDynamicLists(lists: Record<string, Partial<ResolvedList> & { values: string[] }>): DynamicListsFile {
  const fullLists: Record<string, ResolvedList> = {};
  for (const [name, partial] of Object.entries(lists)) {
    fullLists[name] = {
      values: partial.values,
      manualAdditions: partial.manualAdditions ?? [],
      manualRemovals: partial.manualRemovals ?? [],
      resolvedAt: partial.resolvedAt ?? new Date().toISOString(),
      inputHash: partial.inputHash ?? 'test-hash',
    };
  }
  return { generatedAt: '', lists: fullLists };
}

// ---------------------------------------------------------------------------
// List Type Registry tests
// ---------------------------------------------------------------------------

describe('List Type Registry', () => {
  describe('domains type', () => {
    const domainType = LIST_TYPE_REGISTRY.get('domains')!;

    it('validates valid domain names', () => {
      expect(domainType.validate('example.com')).toBe(true);
      expect(domainType.validate('sub.example.com')).toBe(true);
      expect(domainType.validate('*.example.com')).toBe(true);
      expect(domainType.validate('bbc.com')).toBe(true);
    });

    it('rejects invalid domain values', () => {
      expect(domainType.validate('')).toBe(false);
      expect(domainType.validate('has spaces')).toBe(false);
      expect(domainType.validate('https://example.com')).toBe(false);
      expect(domainType.validate('example.com/path')).toBe(false);
      expect(domainType.validate('*.')).toBe(false);
    });

    it('has format guidance', () => {
      expect(domainType.formatGuidance).toContain('domain');
    });
  });

  describe('emails type', () => {
    const emailType = LIST_TYPE_REGISTRY.get('emails')!;

    it('validates valid email addresses', () => {
      expect(emailType.validate('user@example.com')).toBe(true);
      expect(emailType.validate('a@b.c')).toBe(true);
    });

    it('rejects invalid email values', () => {
      expect(emailType.validate('')).toBe(false);
      expect(emailType.validate('no-at-sign')).toBe(false);
      expect(emailType.validate('has spaces@example.com')).toBe(false);
      expect(emailType.validate('@')).toBe(false);
    });

    it('has format guidance', () => {
      expect(emailType.formatGuidance).toContain('email');
    });
  });

  describe('identifiers type', () => {
    const idType = LIST_TYPE_REGISTRY.get('identifiers')!;

    it('validates valid identifier values', () => {
      expect(idType.validate('AAPL')).toBe(true);
      expect(idType.validate('my-thing')).toBe(true);
      expect(idType.validate('123')).toBe(true);
    });

    it('rejects invalid identifier values', () => {
      expect(idType.validate('')).toBe(false);
      expect(idType.validate('has spaces')).toBe(false);
      expect(idType.validate('has\ttabs')).toBe(false);
    });

    it('has format guidance', () => {
      expect(idType.formatGuidance).toContain('identifiers');
    });
  });

  describe('matcher functions', () => {
    it('domains matcher uses domainMatchesAllowlist', () => {
      const matcher = getListMatcher('domains');
      expect(matcher('example.com', 'example.com')).toBe(true);
      expect(matcher('sub.example.com', '*.example.com')).toBe(true);
      expect(matcher('other.com', 'example.com')).toBe(false);
    });

    it('emails matcher is case-insensitive', () => {
      const matcher = getListMatcher('emails');
      expect(matcher('User@Example.COM', 'user@example.com')).toBe(true);
      expect(matcher('user@example.com', 'USER@EXAMPLE.COM')).toBe(true);
      expect(matcher('other@example.com', 'user@example.com')).toBe(false);
    });

    it('identifiers matcher is case-sensitive exact', () => {
      const matcher = getListMatcher('identifiers');
      expect(matcher('AAPL', 'AAPL')).toBe(true);
      expect(matcher('aapl', 'AAPL')).toBe(false);
      expect(matcher('GOOG', 'AAPL')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// List Resolver tests
// ---------------------------------------------------------------------------

describe('List Resolver', () => {
  it('resolves a knowledge-based list via LLM', async () => {
    const mockLLM = createMockModel({
      values: ['cnn.com', 'bbc.com', 'nytimes.com'],
    });

    const result = await resolveList(newsListDef, { model: mockLLM });

    expect(result.values).toContain('cnn.com');
    expect(result.values).toContain('bbc.com');
    expect(result.values).toContain('nytimes.com');
    expect(result.manualAdditions).toEqual([]);
    expect(result.manualRemovals).toEqual([]);
    expect(result.resolvedAt).toBeTruthy();
    expect(result.inputHash).toBeTruthy();
  });

  it('filters invalid values using type validation', async () => {
    const mockLLM = createMockModel({
      values: ['cnn.com', 'not a domain', 'https://bad.com', 'bbc.com'],
    });

    const result = await resolveList(newsListDef, { model: mockLLM });

    expect(result.values).toContain('cnn.com');
    expect(result.values).toContain('bbc.com');
    expect(result.values).not.toContain('not a domain');
    expect(result.values).not.toContain('https://bad.com');
  });

  it('deduplicates values', async () => {
    const mockLLM = createMockModel({
      values: ['cnn.com', 'bbc.com', 'cnn.com', 'bbc.com'],
    });

    const result = await resolveList(newsListDef, { model: mockLLM });

    expect(result.values).toContain('cnn.com');
    expect(result.values).toContain('bbc.com');
    expect(result.values).toContain('*.cnn.com');
    expect(result.values).toContain('*.bbc.com');
    // No extra entries beyond apex + wildcard pairs
    expect(result.values).toHaveLength(4);
  });

  it('preserves manualAdditions from existing resolution', async () => {
    const mockLLM = createMockModel({ values: ['cnn.com'] });
    const existing: ResolvedList = {
      values: ['old.com'],
      manualAdditions: ['custom.com'],
      manualRemovals: [],
      resolvedAt: '2025-01-01T00:00:00Z',
      inputHash: 'old-hash',
    };

    const result = await resolveList(newsListDef, { model: mockLLM }, existing);

    expect(result.values).toContain('cnn.com');
    expect(result.values).toContain('custom.com');
    expect(result.manualAdditions).toEqual(['custom.com']);
  });

  it('applies manualRemovals from existing resolution', async () => {
    const mockLLM = createMockModel({ values: ['cnn.com', 'bbc.com'] });
    const existing: ResolvedList = {
      values: [],
      manualAdditions: [],
      manualRemovals: ['bbc.com'],
      resolvedAt: '2025-01-01T00:00:00Z',
      inputHash: 'old-hash',
    };

    const result = await resolveList(newsListDef, { model: mockLLM }, existing);

    expect(result.values).toContain('cnn.com');
    expect(result.values).not.toContain('bbc.com');
    expect(result.manualRemovals).toEqual(['bbc.com']);
  });

  it('fails with descriptive error for requiresMcp lists without proxy connection', async () => {
    const mockLLM = createMockModel({ values: [] });

    await expect(resolveList(contactsListDef, { model: mockLLM })).rejects.toThrow(/has no MCP access/);
  });

  describe('resolveAllLists', () => {
    it('resolves all definitions', async () => {
      const mockLLM = createMockModel({ values: ['AAPL', 'GOOG'] });

      const result = await resolveAllLists([stocksListDef], { model: mockLLM });

      expect(result.lists['tech-stock-tickers']).toBeDefined();
      expect(result.lists['tech-stock-tickers'].values).toContain('AAPL');
      expect(result.generatedAt).toBeTruthy();
    });

    it('uses cache when inputHash matches', async () => {
      const { model, getCallCount } = createCountingModel();

      // First resolution to get the hash
      const first = await resolveAllLists([stocksListDef], { model });
      const firstHash = first.lists['tech-stock-tickers'].inputHash;
      expect(getCallCount()).toBe(1);

      // Second resolution with matching hash should be cached
      const result = await resolveAllLists([stocksListDef], { model }, first);

      expect(getCallCount()).toBe(1); // No additional LLM call
      expect(result.lists['tech-stock-tickers'].inputHash).toBe(firstHash);
    });

    it('re-resolves when inputHash does not match', async () => {
      const { model, getCallCount } = createCountingModel();

      const existing = makeDynamicLists({
        'tech-stock-tickers': {
          values: ['OLD'],
          inputHash: 'different-hash',
        },
      });

      await resolveAllLists([stocksListDef], { model }, existing);

      expect(getCallCount()).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Policy Engine Expansion tests
// ---------------------------------------------------------------------------

describe('Policy Engine List Expansion', () => {
  it('expands @list-name in domains.allowed', () => {
    const policy = makePolicyFile([makeRuleWithDomainList('major-news-sites')], [newsListDef]);
    const lists = makeDynamicLists({
      'major-news-sites': { values: ['cnn.com', 'bbc.com'] },
    });
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);

    const engine = new PolicyEngine(policy, annotations, [], undefined, undefined, lists);

    // cnn.com should be allowed (expanded from @major-news-sites)
    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'https://cnn.com/news' },
      timestamp: '',
    });
    expect(result.decision).toBe('allow');
  });

  it('expands @list-name in lists[].allowed', () => {
    const rule: CompiledRule = {
      name: 'allow-known-ids',
      description: 'Allow known identifiers',
      principle: 'permit known values',
      if: {
        lists: [
          {
            roles: ['github-owner'],
            allowed: ['@tech-stock-tickers'],
            matchType: 'identifiers',
          },
        ],
      },
      then: 'allow',
      reason: 'Known identifier',
    };
    const policy = makePolicyFile([rule], [stocksListDef]);
    const lists = makeDynamicLists({
      'tech-stock-tickers': { values: ['AAPL', 'GOOG'] },
    });
    const annotations = makeToolAnnotationsFile([identifierAnnotation]);

    const engine = new PolicyEngine(policy, annotations, [], undefined, undefined, lists);

    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'directory',
      toolName: 'lookup',
      arguments: { id: 'AAPL' },
      timestamp: '',
    });
    expect(result.decision).toBe('allow');
  });

  it('treats a missing @list-name reference as deny (fail closed), not a throw', () => {
    const policy = makePolicyFile([makeRuleWithDomainList('missing-list')]);
    const emptyLists = makeDynamicLists({});
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);

    // Construction no longer throws on a missing list (would otherwise crash
    // policy load during the accepted concurrent-recompile interleaving).
    const engine = new PolicyEngine(policy, annotations, [], undefined, undefined, emptyLists);

    // The @missing-list rule's allowlist resolves to empty, so the fetch it
    // would have allowed is now denied (default-deny).
    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'https://example.com' },
      timestamp: '',
    });
    expect(result.decision).toBe('deny');
  });

  it('applies manual additions during expansion', () => {
    const policy = makePolicyFile([makeRuleWithDomainList('major-news-sites')], [newsListDef]);
    const lists = makeDynamicLists({
      'major-news-sites': {
        values: ['cnn.com'],
        manualAdditions: ['custom-news.com'],
      },
    });
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);

    const engine = new PolicyEngine(policy, annotations, [], undefined, undefined, lists);

    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'https://custom-news.com/article' },
      timestamp: '',
    });
    expect(result.decision).toBe('allow');
  });

  it('applies manual removals during expansion', () => {
    const policy = makePolicyFile([makeRuleWithDomainList('major-news-sites')], [newsListDef]);
    const lists = makeDynamicLists({
      'major-news-sites': {
        values: ['cnn.com', 'bbc.com'],
        manualRemovals: ['bbc.com'],
      },
    });
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);

    const engine = new PolicyEngine(policy, annotations, [], undefined, undefined, lists);

    // bbc.com should NOT match (removed via manualRemovals)
    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'https://bbc.com/news' },
      timestamp: '',
    });
    expect(result.decision).not.toBe('allow');
  });

  it('mixes concrete and expanded values in domains.allowed', () => {
    const rule: CompiledRule = {
      name: 'allow-news',
      description: 'Allow news',
      principle: 'news',
      if: {
        domains: {
          roles: ['fetch-url'],
          allowed: ['specific.com', '@major-news-sites'],
        },
      },
      then: 'allow',
      reason: 'Allowed',
    };
    const policy = makePolicyFile([rule], [newsListDef]);
    const lists = makeDynamicLists({
      'major-news-sites': { values: ['cnn.com'] },
    });
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);

    const engine = new PolicyEngine(policy, annotations, [], undefined, undefined, lists);

    // Both concrete and expanded values should work
    const specificResult = engine.evaluate({
      requestId: '1',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'https://specific.com/page' },
      timestamp: '',
    });
    expect(specificResult.decision).toBe('allow');

    const expandedResult = engine.evaluate({
      requestId: '2',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'https://cnn.com/news' },
      timestamp: '',
    });
    expect(expandedResult.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// ListCondition Evaluation tests
// ---------------------------------------------------------------------------

describe('ListCondition Evaluation', () => {
  it('matches email list condition (case-insensitive)', () => {
    const rule: CompiledRule = {
      name: 'allow-contacts',
      description: 'Allow sending to contacts',
      principle: 'contacts',
      if: {
        lists: [
          {
            roles: ['github-owner'],
            allowed: ['alice@example.com', 'bob@example.com'],
            matchType: 'emails',
          },
        ],
      },
      then: 'allow',
      reason: 'Contact',
    };
    const policy = makePolicyFile([rule]);
    const annotations = makeToolAnnotationsFile([identifierAnnotation]);
    const engine = new PolicyEngine(policy, annotations, []);

    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'directory',
      toolName: 'lookup',
      arguments: { id: 'ALICE@EXAMPLE.COM' },
      timestamp: '',
    });
    expect(result.decision).toBe('allow');
  });

  it('matches identifier list condition (case-sensitive)', () => {
    const rule: CompiledRule = {
      name: 'allow-tickers',
      description: 'Allow known tickers',
      principle: 'tickers',
      if: {
        lists: [
          {
            roles: ['github-owner'],
            allowed: ['AAPL', 'GOOG'],
            matchType: 'identifiers',
          },
        ],
      },
      then: 'allow',
      reason: 'Known ticker',
    };
    const policy = makePolicyFile([rule]);
    const annotations = makeToolAnnotationsFile([identifierAnnotation]);
    const engine = new PolicyEngine(policy, annotations, []);

    const matchResult = engine.evaluate({
      requestId: '1',
      serverName: 'directory',
      toolName: 'lookup',
      arguments: { id: 'AAPL' },
      timestamp: '',
    });
    expect(matchResult.decision).toBe('allow');

    // Case mismatch should not match
    const noMatchResult = engine.evaluate({
      requestId: '2',
      serverName: 'directory',
      toolName: 'lookup',
      arguments: { id: 'aapl' },
      timestamp: '',
    });
    expect(noMatchResult.decision).not.toBe('allow');
  });

  it('returns false when zero values are extracted', () => {
    const rule: CompiledRule = {
      name: 'allow-contacts',
      description: 'Allow contacts',
      principle: 'contacts',
      if: {
        lists: [
          {
            roles: ['fetch-url'], // This role won't match read_file's path arg
            allowed: ['alice@example.com'],
            matchType: 'emails',
          },
        ],
      },
      then: 'allow',
      reason: 'Contact',
    };
    const readAnnotation: StoredToolAnnotation = {
      toolName: 'read_file',
      serverName: 'filesystem',
      comment: 'Reads file',
      args: { path: ['read-path'] },
      inputSchema: {},
    };
    const policy = makePolicyFile([rule]);
    const annotations = makeToolAnnotationsFile([readAnnotation]);
    const engine = new PolicyEngine(policy, annotations, []);

    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: '/tmp/file.txt' },
      timestamp: '',
    });
    // Rule should not match (zero extraction), falls through to default deny
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('default-deny');
  });

  it('requires ALL list conditions to be satisfied (AND semantics)', () => {
    const rule: CompiledRule = {
      name: 'allow-if-both',
      description: 'Both conditions must match',
      principle: 'dual check',
      if: {
        lists: [
          {
            roles: ['fetch-url'],
            allowed: ['AAPL'],
            matchType: 'identifiers',
          },
          {
            roles: ['fetch-url'],
            allowed: ['GOOG'],
            matchType: 'identifiers',
          },
        ],
      },
      then: 'allow',
      reason: 'Both matched',
    };
    const policy = makePolicyFile([rule]);
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);
    const engine = new PolicyEngine(policy, annotations, []);

    // AAPL matches first condition but not second
    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'AAPL' },
      timestamp: '',
    });
    expect(result.decision).not.toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// hasRoleConditions and ruleRelevantToRole integration tests
// ---------------------------------------------------------------------------

describe('Per-Role Evaluation with Lists', () => {
  it('lists condition makes a rule role-specific (not role-agnostic)', () => {
    // A rule with only lists condition should be treated as role-specific
    const emailSendAnnotation: StoredToolAnnotation = {
      toolName: 'send_email',
      serverName: 'email',
      comment: 'Sends email',
      // Tool has both a read-path arg (for attachment) and a fetch-url arg (for recipient)
      args: { recipient: ['fetch-url'], attachment: ['read-path'] },
      inputSchema: {},
    };
    const rule: CompiledRule = {
      name: 'allow-contacts',
      description: 'Allow sending to contacts',
      principle: 'contacts',
      if: {
        lists: [
          {
            roles: ['fetch-url'],
            allowed: ['alice@example.com'],
            matchType: 'emails',
          },
        ],
      },
      then: 'allow',
      reason: 'Contact',
    };
    const fallbackRule: CompiledRule = {
      name: 'escalate-all',
      description: 'Escalate everything else',
      principle: 'safety',
      if: {},
      then: 'escalate',
      reason: 'Not explicitly allowed',
    };
    const policy = makePolicyFile([rule, fallbackRule]);
    const annotations = makeToolAnnotationsFile([emailSendAnnotation]);

    const engine = new PolicyEngine(policy, annotations, []);

    // When the recipient matches the contact list, fetch-url role gets "allow"
    // but read-path role should fall through to escalate (lists condition is
    // not relevant to read-path)
    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'email',
      toolName: 'send_email',
      arguments: { recipient: 'alice@example.com', attachment: '/tmp/file.txt' },
      timestamp: '',
    });
    // Most restrictive wins: escalate > allow
    expect(result.decision).toBe('escalate');
  });
});

// ===========================================================================
// Phase 3: MCP-backed list resolution
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared fixtures for Phase 3 tests
// ---------------------------------------------------------------------------

const TEXT_RESULT_EMPTY: MediatedToolResult = { content: [{ type: 'text', text: '[]' }], isError: false };

interface MockToolSpec {
  readonly name: string;
  readonly serverName?: string;
  readonly offered?: boolean;
}

/**
 * Creates a mock mediated MCP connection (the shape `connectViaProxy`
 * returns). `callTool` stands in for the security kernel; the real
 * kernel path is covered by list-resolver-mediation.integration.test.ts.
 */
function createMockMcpConnection(
  tools: ReadonlyArray<string | MockToolSpec> = ['list_contacts'],
  callResult: MediatedToolResult = TEXT_RESULT_EMPTY,
): { connection: NonNullable<ListResolverConfig['mcpConnection']>; callTool: Mock<MediatedToolCaller['callTool']> } {
  const callTool = vi.fn<MediatedToolCaller['callTool']>().mockResolvedValue(callResult);
  const mediatedTools: MediatedTool[] = tools.map((spec) => {
    const { name, serverName = 'contacts', offered = true } = typeof spec === 'string' ? { name: spec } : spec;
    return {
      serverName,
      name,
      description: `Mock tool: ${name}`,
      inputSchema: { type: 'object', properties: {} },
      offered,
    };
  });
  return { connection: { tools: mediatedTools, callTool }, callTool };
}

/** A model step that calls one tool. */
function toolCallStep(toolCallId: string, toolName: string, input: Record<string, unknown>) {
  return {
    ...MOCK_GENERATE_RESULT,
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
  };
}

/** A model step that answers with the final list. */
function finalValuesStep(values: string[]) {
  return {
    ...MOCK_GENERATE_RESULT,
    content: [{ type: 'text' as const, text: JSON.stringify({ values }) }],
  };
}

/**
 * Creates a function-form MockLanguageModelV3 that simulates a multi-step
 * tool-use conversation: step 1 calls the given tool, step 2 answers with
 * the final JSON values. (Array-form doGenerate is effectively 1-indexed in
 * ai@6, so it would skip the tool call and make these tests vacuous.)
 */
function createToolUseModel(
  toolName: string,
  toolInput: Record<string, unknown>,
  finalValues: string[],
): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      step++;
      return step === 1 ? toolCallStep('call-1', toolName, toolInput) : finalValuesStep(finalValues);
    },
  });
}

/** Names of the tools described to the model on its first step. */
function offeredToolNames(model: MockLanguageModelV3): string[] {
  return (model.doGenerateCalls[0].tools ?? []).map((t) => t.name);
}

/**
 * Asserts the resolution took the MCP path: exactly one tool call through
 * the mediated connection, with these arguments, and a second model step
 * that received its result. Without this a test could pass on the model's
 * final text alone, never touching the tool path it is named after.
 */
function expectOneMediatedToolCall(
  model: MockLanguageModelV3,
  callTool: Mock<MediatedToolCaller['callTool']>,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  expect(callTool).toHaveBeenCalledTimes(1);
  expect(callTool).toHaveBeenCalledWith(serverName, toolName, args);
  expect(model.doGenerateCalls).toHaveLength(2);
}

// ---------------------------------------------------------------------------
// MCP-backed resolution tests
// ---------------------------------------------------------------------------

describe('MCP-Backed List Resolution', () => {
  it('resolves a data-backed list via MCP tools', async () => {
    const { connection, callTool } = createMockMcpConnection(['list_contacts'], {
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            { name: 'Alice', email: 'alice@example.com' },
            { name: 'Bob', email: 'bob@company.org' },
          ]),
        },
      ],
      isError: false,
    });

    const model = createToolUseModel('list_contacts', {}, ['alice@example.com', 'bob@company.org']);

    const config: ListResolverConfig = { model, mcpConnection: connection };
    const result = await resolveList(contactsListDef, config);

    // The tool call really happened, routed through the mediated connection.
    expectOneMediatedToolCall(model, callTool, 'contacts', 'list_contacts', {});
    expect(result.values).toContain('alice@example.com');
    expect(result.values).toContain('bob@company.org');
    expect(result.resolvedAt).toBeTruthy();
    expect(result.inputHash).toBeTruthy();
  });

  it('feeds the tool result back to the model', async () => {
    const { connection, callTool } = createMockMcpConnection(['list_contacts'], {
      content: [{ type: 'text', text: 'alice@example.com' }],
      isError: false,
    });
    const model = createToolUseModel('list_contacts', {}, ['alice@example.com']);

    await resolveList(contactsListDef, { model, mcpConnection: connection });

    expectOneMediatedToolCall(model, callTool, 'contacts', 'list_contacts', {});
    const secondStepPrompt = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(secondStepPrompt).toContain('alice@example.com');
  });

  it('fails when requiresMcp but no mcpConnection is provided', async () => {
    const model = createMockModel({ values: [] });

    await expect(resolveList(contactsListDef, { model })).rejects.toThrow(/has no MCP access/);
  });

  it('fails when requiresMcp but mcpConnection has no tools', async () => {
    const model = createMockModel({ values: [] });
    const { connection } = createMockMcpConnection([]);

    await expect(resolveList(contactsListDef, { model, mcpConnection: connection })).rejects.toThrow(
      /no MCP tools are available/,
    );
  });

  it('offers only the tools of the server named by mcpServerHint', async () => {
    const { connection, callTool } = createMockMcpConnection(
      [
        { name: 'list_contacts', serverName: 'contacts' },
        { name: 'list_records', serverName: 'crm' },
      ],
      { content: [{ type: 'text', text: JSON.stringify([{ email: 'alice@example.com' }]) }], isError: false },
    );

    const model = createToolUseModel('list_contacts', {}, ['alice@example.com']);

    const result = await resolveList(contactsListDef, { model, mcpConnection: connection });

    expect(offeredToolNames(model)).toEqual(['list_contacts']);
    expectOneMediatedToolCall(model, callTool, 'contacts', 'list_contacts', {});
    expect(result.values).toContain('alice@example.com');
  });

  it('never falls back to another server when the hinted server has no tools', async () => {
    // Previously an unhinted or mismatched list could use any connected
    // server's tools. A data-backed list now reads only the server it names.
    const { connection, callTool } = createMockMcpConnection([{ name: 'query_data', serverName: 'crm' }]);
    const model = createToolUseModel('query_data', {}, ['fallback@example.com']);

    await expect(resolveList(contactsListDef, { model, mcpConnection: connection })).rejects.toThrow(
      /no MCP tools are available from server "contacts"/,
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('describes only offered tools to the model, and mediates a call to a hidden tool', async () => {
    // The model is told about list_contacts only. When (e.g. after a prompt
    // injection) it calls delete_contact anyway, the call still goes through
    // the mediated connection -- where the security kernel refuses and
    // audits it -- and the refusal text is returned to the model.
    const refusal = 'ESCALATION REQUIRED: deleting contacts needs approval. Action denied (no escalation handler).';
    const { connection, callTool } = createMockMcpConnection([
      'list_contacts',
      { name: 'delete_contact', offered: false },
    ]);
    callTool.mockImplementation(async (_server, toolName) =>
      toolName === 'delete_contact'
        ? { content: [{ type: 'text', text: refusal }], isError: true }
        : { content: [{ type: 'text', text: '[]' }], isError: false },
    );

    const model = createToolUseModel('delete_contact', { id: '123' }, ['alice@example.com']);
    const result = await resolveList(contactsListDef, { model, mcpConnection: connection });

    expect(offeredToolNames(model)).toEqual(['list_contacts']);
    expectOneMediatedToolCall(model, callTool, 'contacts', 'delete_contact', { id: '123' });
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('Action denied (no escalation handler)');
    // Resolution still completes from the model's final text.
    expect(result.values).toContain('alice@example.com');
  });

  it('tells the model that tool results are untrusted data', async () => {
    const { connection, callTool } = createMockMcpConnection(['list_contacts']);
    const model = createToolUseModel('list_contacts', {}, ['alice@example.com']);

    await resolveList(contactsListDef, { model, mcpConnection: connection });

    expectOneMediatedToolCall(model, callTool, 'contacts', 'list_contacts', {});
    const system = model.doGenerateCalls[0].prompt.find((m) => m.role === 'system');
    expect(system?.content).toContain('untrusted data');
  });

  it('applies type validation to MCP-resolved values', async () => {
    const { connection, callTool } = createMockMcpConnection(['list_contacts']);

    // LLM returns some invalid emails mixed with valid ones
    const model = createToolUseModel('list_contacts', {}, ['alice@example.com', 'not-an-email', 'bob@company.org']);

    const config: ListResolverConfig = { model, mcpConnection: connection };
    const result = await resolveList(contactsListDef, config);

    expectOneMediatedToolCall(model, callTool, 'contacts', 'list_contacts', {});
    expect(result.values).toContain('alice@example.com');
    expect(result.values).toContain('bob@company.org');
    expect(result.values).not.toContain('not-an-email');
  });

  it('preserves manual overrides for MCP-resolved lists', async () => {
    const { connection, callTool } = createMockMcpConnection(['list_contacts']);

    const model = createToolUseModel('list_contacts', {}, ['alice@example.com']);

    const existing: ResolvedList = {
      values: ['old@example.com'],
      manualAdditions: ['manual@example.com'],
      manualRemovals: ['alice@example.com'],
      resolvedAt: '2025-01-01T00:00:00Z',
      inputHash: 'old-hash',
    };

    const config: ListResolverConfig = { model, mcpConnection: connection };
    const result = await resolveList(contactsListDef, config, existing);

    expectOneMediatedToolCall(model, callTool, 'contacts', 'list_contacts', {});
    expect(result.values).toContain('manual@example.com');
    expect(result.values).not.toContain('alice@example.com');
    expect(result.manualAdditions).toEqual(['manual@example.com']);
    expect(result.manualRemovals).toEqual(['alice@example.com']);
  });

  it('knowledge-based lists ignore mcpConnection', async () => {
    const { connection, callTool } = createMockMcpConnection(['list_contacts']);
    const model = createMockModel({
      values: ['cnn.com', 'bbc.com'],
    });

    // newsListDef has requiresMcp: false -- should use LLM directly
    const config: ListResolverConfig = { model, mcpConnection: connection };
    const result = await resolveList(newsListDef, config);

    expect(result.values).toContain('cnn.com');
    expect(result.values).toContain('bbc.com');
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('MCP-Backed resolveAllLists', () => {
  it('resolves mixed knowledge-based and MCP-backed lists', async () => {
    const { connection, callTool } = createMockMcpConnection(['list_contacts']);

    let callIndex = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        callIndex++;
        // First call: knowledge-based list (stocksListDef)
        // Second+: MCP-backed list tool call then text
        if (callIndex === 1) return finalValuesStep(['AAPL', 'GOOG']);
        if (callIndex === 2) return toolCallStep('call-1', 'list_contacts', {});
        return finalValuesStep(['alice@example.com']);
      },
    });

    const result = await resolveAllLists([stocksListDef, contactsListDef], { model, mcpConnection: connection });

    // One step for the knowledge-based list, two for the MCP round trip.
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('contacts', 'list_contacts', {});
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(result.lists['tech-stock-tickers']).toBeDefined();
    expect(result.lists['tech-stock-tickers'].values).toContain('AAPL');
    expect(result.lists['my-contacts']).toBeDefined();
    expect(result.lists['my-contacts'].values).toContain('alice@example.com');
  });
});

// ===========================================================================
// Phase 4: bypassCache for refresh-lists
// ===========================================================================

describe('resolveAllLists bypassCache', () => {
  it('re-resolves even when hash matches when bypassCache is true', async () => {
    const { model, getCallCount } = createCountingModel((i) => [`value-${i}`]);

    // First resolution to get a valid hash
    const first = await resolveAllLists([stocksListDef], { model });
    expect(getCallCount()).toBe(1);

    // With bypassCache: true, should re-resolve despite matching hash
    const result = await resolveAllLists([stocksListDef], { model }, first, undefined, true);

    expect(getCallCount()).toBe(2);
    expect(result.lists['tech-stock-tickers'].values).toContain('value-2');
  });

  it('skips cached lists when bypassCache is false (default)', async () => {
    const { model, getCallCount } = createCountingModel(() => ['AAPL']);

    // First resolution
    const first = await resolveAllLists([stocksListDef], { model });
    expect(getCallCount()).toBe(1);

    // Default behavior (no bypassCache) should use cache
    const result = await resolveAllLists([stocksListDef], { model }, first);

    expect(getCallCount()).toBe(1); // No additional LLM call
    expect(result.lists['tech-stock-tickers'].values).toContain('AAPL');
  });
});

// ===========================================================================
// Phase 5: Dynamic list values in prompts
// ===========================================================================

describe('Dynamic List Values in Prompts', () => {
  const testDynamicLists = makeDynamicLists({
    'major-news-sites': { values: ['cnn.com', 'bbc.com', 'nytimes.com'] },
    'financial-sites': { values: ['bloomberg.com', 'wsj.com'] },
  });

  describe('formatDynamicListsSection', () => {
    it('formats resolved list values into a markdown section', () => {
      const section = formatDynamicListsSection(testDynamicLists);

      expect(section).toContain('## Dynamic List Values');
      expect(section).toContain('@major-news-sites');
      expect(section).toContain('cnn.com, bbc.com, nytimes.com');
      expect(section).toContain('@financial-sites');
      expect(section).toContain('bloomberg.com, wsj.com');
      expect(section).toContain('obviously unrelated');
    });

    it('presents the values as part of the policy under test, never as "allow" cases (PIP-12)', () => {
      const section = formatDynamicListsSection(testDynamicLists);

      expect(section).toContain('The rules under test reference');
      expect(section).toContain('may be wrong: being on a list does not make a value permitted');
      expect(section).toContain('expect "allow" for a list value only when the constitution permits that value');
      expect(section).not.toContain('positive/allow cases');
    });

    it('truncates lists longer than 5 values', () => {
      const longLists = makeDynamicLists({
        'many-sites': {
          values: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com', 'g.com'],
        },
      });
      const section = formatDynamicListsSection(longLists);

      expect(section).toContain('a.com, b.com, c.com, d.com, e.com');
      expect(section).toContain('... (7 total)');
      expect(section).not.toContain('f.com');
    });

    it('returns empty string when dynamicLists is undefined', () => {
      expect(formatDynamicListsSection(undefined)).toBe('');
    });

    it('returns empty string when dynamicLists has no lists', () => {
      expect(formatDynamicListsSection({ generatedAt: '', lists: {} })).toBe('');
    });
  });

  describe('buildGeneratorSystemPrompt', () => {
    it('includes dynamic list values when provided', () => {
      const prompt = buildGeneratorSystemPrompt(
        'Allow news sites.',
        sampleAnnotations,
        '/tmp/sandbox',
        [],
        testDynamicLists,
      );

      expect(prompt).toContain('## Dynamic List Values');
      expect(prompt).toContain('@major-news-sites');
      expect(prompt).toContain('cnn.com, bbc.com, nytimes.com');
      expect(prompt).toContain('@financial-sites');
      expect(prompt).toContain('bloomberg.com, wsj.com');
    });

    it('omits dynamic list section when dynamicLists is undefined', () => {
      const prompt = buildGeneratorSystemPrompt('Allow news sites.', sampleAnnotations, '/tmp/sandbox');

      expect(prompt).not.toContain('## Dynamic List Values');
    });
  });

  describe('buildJudgeSystemPrompt', () => {
    const compiledPolicy = makePolicyFile([plainReadRule], [newsListDef]);

    it('includes dynamic list values when provided', () => {
      const prompt = buildJudgeSystemPrompt(
        'Allow news sites.',
        compiledPolicy,
        ['/etc/ironcurtain'],
        [],
        testDynamicLists,
        undefined,
        [],
      );

      expect(prompt).toContain('## Dynamic List Values');
      expect(prompt).toContain('@major-news-sites');
      expect(prompt).toContain('cnn.com, bbc.com, nytimes.com');
      expect(prompt).toContain('@financial-sites');
    });

    it('omits dynamic list section when dynamicLists is undefined', () => {
      const prompt = buildJudgeSystemPrompt(
        'Allow news sites.',
        compiledPolicy,
        ['/etc/ironcurtain'],
        undefined,
        undefined,
        undefined,
        [],
      );

      expect(prompt).not.toContain('## Dynamic List Values');
    });
  });
});

// ===========================================================================
// Phase 6: Repair instructions include existing list names
// ===========================================================================

describe('Repair Instructions with Existing Lists', () => {
  it('includes existing list definitions in repair instructions', () => {
    const repairContext: RepairContext = {
      failedScenarios: [],
      judgeAnalysis: 'Some analysis',
      attemptNumber: 1,
      existingListDefinitions: [newsListDef, stocksListDef],
    };

    const instructions = buildRepairInstructions(repairContext);

    expect(instructions).toContain('### Available Dynamic Lists');
    expect(instructions).toContain('@major-news-sites (type: domains)');
    expect(instructions).toContain('@tech-stock-tickers (type: identifiers)');
    expect(instructions).toContain('MUST use these exact names');
    expect(instructions).toContain('do NOT rename or create new lists');
  });

  it('includes handwritten scenarios as ground truth in repair instructions', () => {
    const repairContext: RepairContext = {
      failedScenarios: [],
      judgeAnalysis: 'Some analysis',
      attemptNumber: 1,
      handwrittenScenarios: [
        {
          description: 'Delete file outside sandbox -- deny',
          request: {
            serverName: 'filesystem',
            toolName: 'delete_file',
            arguments: { path: '/etc/important.txt' },
          },
          expectedDecision: 'deny',
          reasoning: 'No destruction principle',
          source: 'handwritten',
        },
      ],
    };

    const instructions = buildRepairInstructions(repairContext);

    expect(instructions).toContain('## Ground Truth Constraints');
    expect(instructions).toContain('filesystem/delete_file');
    expect(instructions).toContain('deny');
    expect(instructions).toContain('No destruction principle');
  });

  it('omits dynamic lists section when no list definitions exist', () => {
    const repairContext: RepairContext = {
      failedScenarios: [],
      judgeAnalysis: 'Some analysis',
      attemptNumber: 1,
    };

    const instructions = buildRepairInstructions(repairContext);

    expect(instructions).not.toContain('### Available Dynamic Lists');
  });

  it('omits dynamic lists section when list definitions array is empty', () => {
    const repairContext: RepairContext = {
      failedScenarios: [],
      judgeAnalysis: 'Some analysis',
      attemptNumber: 1,
      existingListDefinitions: [],
    };

    const instructions = buildRepairInstructions(repairContext);

    expect(instructions).not.toContain('### Available Dynamic Lists');
  });
});

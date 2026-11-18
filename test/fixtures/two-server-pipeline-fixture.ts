/**
 * Two-server (`fs`, `news`) fixture for pipeline runner and compile-policy CLI
 * tests driven by `createScriptedPipelineModels`.
 *
 * `fs` has read_file / delete_file; `news` has http_fetch. BAD_FS is
 * over-permissive (it also allows deleting files outside the sandbox) and
 * REJECT_FS is the judge's verdict on it; GOOD_FS and NEWS pass verification.
 * Every rule passes the deterministic policy lint (policy-lint.ts), so these
 * scripts exercise verification; test/pipeline-policy-lint.test.ts covers
 * rules the lint rejects.
 * The scripts route by server through the system prompt, so they work for the
 * sequential and the parallel (multi-server) compile paths alike.
 */

import type { CompiledRule, StoredToolAnnotation, StoredToolAnnotationsFile } from '../../src/pipeline/types.js';
import type { FakeLlmCall, FakePhaseScript } from './fake-pipeline-models.js';

export const SANDBOX = '/wp15/sandbox';
export const CONSTITUTION =
  'Reading files anywhere is fine. Deleting files outside the sandbox is forbidden. News may be read.';

const PATH_SCHEMA = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
const URL_SCHEMA = { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] };

export const FS_TOOLS: StoredToolAnnotation[] = [
  {
    serverName: 'fs',
    toolName: 'read_file',
    comment: 'Reads a file.',
    args: { path: ['read-path'] },
    inputSchema: PATH_SCHEMA,
  },
  {
    serverName: 'fs',
    toolName: 'delete_file',
    comment: 'Deletes a file.',
    args: { path: ['delete-path'] },
    inputSchema: PATH_SCHEMA,
  },
];

export const NEWS_TOOLS: StoredToolAnnotation[] = [
  {
    serverName: 'news',
    toolName: 'http_fetch',
    comment: 'Fetches a web page.',
    args: { url: ['fetch-url'] },
    inputSchema: URL_SCHEMA,
  },
];

export function annotationsFor(servers: Record<string, StoredToolAnnotation[]>): StoredToolAnnotationsFile {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    servers: Object.fromEntries(Object.entries(servers).map(([name, tools]) => [name, { inputHash: name, tools }])),
  };
}

export const FS_ONLY = annotationsFor({ fs: FS_TOOLS });
export const FS_AND_NEWS = annotationsFor({ fs: FS_TOOLS, news: NEWS_TOOLS });
/** news with a changed tool description, so news (and only news) recompiles. */
export const FS_AND_CHANGED_NEWS = annotationsFor({
  fs: FS_TOOLS,
  news: [{ ...NEWS_TOOLS[0], comment: 'Fetches a web page (updated).' }],
});

/** A compiled rule as the compiler LLM returns it. */
export function rule(
  name: string,
  server: string,
  cond: Partial<CompiledRule['if']>,
  then: 'allow' | 'escalate' = 'allow',
): CompiledRule {
  return { name, description: 'd', principle: 'p', if: { server: [server], ...cond }, then, reason: 'r' };
}

/** The directory both fs rule sets name, so their scenario prompts (and caches) match. */
const FS_RULES_DIR = '/etc';

/**
 * Over-permissive: allows deletes as well as reads under /etc, so deleting
 * /etc/passwd is allowed. Shaped to pass the policy lint (a directory-scoped
 * delete allow), so only the verifier catches it.
 */
export const BAD_FS = {
  rules: [rule('allow-all-fs', 'fs', { paths: { roles: ['read-path', 'delete-path'], within: FS_RULES_DIR } })],
};
export const GOOD_FS = {
  rules: [rule('allow-fs-reads', 'fs', { tool: ['read_file'], paths: { roles: ['read-path'], within: FS_RULES_DIR } })],
};
export const NEWS = {
  rules: [
    rule('allow-news', 'news', {
      tool: ['http_fetch'],
      domains: { roles: ['fetch-url'], allowed: ['news.example.com'] },
    }),
  ],
};

export const FS_SCENARIOS = {
  scenarios: [
    {
      description: 'read a file outside the sandbox',
      request: { serverName: 'fs', toolName: 'read_file', arguments: { path: '/etc/hosts' } },
      expectedDecision: 'allow',
      reasoning: 'Reading files anywhere is fine.',
    },
    {
      description: 'delete a file outside the sandbox',
      request: { serverName: 'fs', toolName: 'delete_file', arguments: { path: '/etc/passwd' } },
      expectedDecision: 'deny',
      reasoning: 'Deleting outside the sandbox is forbidden.',
    },
  ],
};

export const NEWS_SCENARIOS = {
  scenarios: [
    {
      description: 'fetch a news page',
      // A registrable host: domain lists refuse reserved TLDs such as `.example`.
      request: { serverName: 'news', toolName: 'http_fetch', arguments: { url: 'https://news.example.com/today' } },
      expectedDecision: 'allow',
      reasoning: 'News may be read.',
    },
  ],
};

export const PASS = {
  analysis: 'PASS: every scenario matches the constitution.',
  pass: true,
  failureAttributions: [],
  additionalScenarios: [],
};

export const REJECT_FS = {
  analysis: 'FAIL: allow-all-fs also allows deleting files outside the sandbox.',
  pass: false,
  failureAttributions: [
    {
      scenarioIndex: 2,
      scenarioDescription: 'delete a file outside the sandbox',
      blame: { kind: 'rule', reasoning: 'Over-permissive.' },
    },
  ],
  additionalScenarios: [],
};

/** A point-fix repair that changes nothing (the compiler cannot fix the rules). */
export const NO_CHANGE_PATCH = { reasoning: 'No change.', operations: [] };

const isFsCompile = (call: FakeLlmCall): boolean => call.system.includes('for the "fs" server');
const isFsScenarios = (call: FakeLlmCall): boolean => call.system.includes('read_file');

/** The fs compiler emits BAD_FS and the judge rejects it through every repair; news compiles and passes. */
export const BAD_FS_GOOD_NEWS: FakePhaseScript = {
  compile: [(call: FakeLlmCall) => (isFsCompile(call) ? BAD_FS : NEWS)],
  scenarios: [(call: FakeLlmCall) => (isFsScenarios(call) ? FS_SCENARIOS : NEWS_SCENARIOS)],
  judge: [(call: FakeLlmCall) => (call.system.includes('allow-all-fs') ? REJECT_FS : PASS)],
  repair: [NO_CHANGE_PATCH],
};

/** Both servers compile and pass verification. */
export const GOOD_BOTH: FakePhaseScript = {
  compile: [(call: FakeLlmCall) => (isFsCompile(call) ? GOOD_FS : NEWS)],
  scenarios: [(call: FakeLlmCall) => (isFsScenarios(call) ? FS_SCENARIOS : NEWS_SCENARIOS)],
  judge: [PASS],
};

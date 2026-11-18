/**
 * Coverage and freshness checks for the bundled read-only policy
 * (src/config/generated-readonly), which mediates dynamic-list resolution
 * and constitution-generation sessions.
 *
 * The artifact is produced by
 *   npm run compile-policy -- --no-mcp --constitution src/config/constitution-readonly.md \
 *     --output-dir src/config/generated-readonly
 * and once silently lost every git rule (DOM-16), so default-deny blocked
 * the git reads the read-only constitution grants. These tests fail when a
 * server the constitution names, configures, or annotates has no rules.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { executeScenarios } from '../src/pipeline/policy-verifier.js';
import { findUnannotatedArguments } from '../src/trusted-process/tool-call-pipeline.js';
import type {
  CompiledPolicyFile,
  Decision,
  StoredToolAnnotationsFile,
  TestScenariosFile,
} from '../src/pipeline/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = resolve(__dirname, '..', 'src', 'config');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(configDir, path), 'utf-8'));
}

const constitution = readFileSync(resolve(configDir, 'constitution-readonly.md'), 'utf-8');
const policy = readJson('generated-readonly/compiled-policy.json') as CompiledPolicyFile;
const scenarios = readJson('generated-readonly/test-scenarios.json') as TestScenariosFile;
const annotations = readJson('generated/tool-annotations.json') as StoredToolAnnotationsFile;
const mcpServers = readJson('mcp-servers.json') as Record<string, unknown>;

/** Each MCP server the read-only constitution grants access to, and the wording that grants it. */
const SERVERS_NAMED_BY_CONSTITUTION: ReadonlyArray<{ server: string; mention: RegExp }> = [
  { server: 'filesystem', mention: /read files and list directories/i },
  { server: 'git', mention: /read git log, status, diff/i },
  { server: 'github', mention: /GitHub issues, pull requests/ },
  { server: 'google-workspace', mention: /connected cloud services/i },
  { server: 'fetch', mention: /fetch URLs and perform web searches/i },
];

function rulesFor(server: string) {
  return policy.rules.filter((rule) => rule.if.server?.includes(server) === true);
}

/** Engine with no sandbox and no protected paths: decisions come from the compiled rules. */
const engine = new PolicyEngine(policy, annotations, []);

function decide(serverName: string, toolName: string, args: Record<string, unknown>): Decision {
  return engine.evaluate({ requestId: 'coverage', serverName, toolName, arguments: args, timestamp: '' }).decision;
}

describe('read-only policy coverage', () => {
  it.each(SERVERS_NAMED_BY_CONSTITUTION)(
    'has an allow rule for $server, which the read-only constitution names',
    ({ server, mention }) => {
      expect(constitution).toMatch(mention);
      expect(rulesFor(server).some((rule) => rule.then === 'allow')).toBe(true);
    },
  );

  it('has rules for every server configured in mcp-servers.json', () => {
    const uncovered = Object.keys(mcpServers).filter((server) => rulesFor(server).length === 0);
    expect(uncovered).toEqual([]);
  });

  it('has rules for every server in the bundled tool annotations', () => {
    const uncovered = Object.keys(annotations.servers).filter((server) => rulesFor(server).length === 0);
    expect(uncovered).toEqual([]);
  });

  it('references only tools that exist in the bundled annotations', () => {
    const known = new Set(
      Object.entries(annotations.servers).flatMap(([server, s]) => s.tools.map((t) => `${server}__${t.toolName}`)),
    );
    const unknown = policy.rules.flatMap((rule) =>
      (rule.if.server ?? []).flatMap((server) =>
        (rule.if.tool ?? []).map((tool) => `${server}__${tool}`).filter((key) => !known.has(key)),
      ),
    );
    expect(unknown).toEqual([]);
  });

  it('ships no dynamic lists (the read-only constitution must not depend on list resolution)', () => {
    expect(policy.listDefinitions ?? []).toEqual([]);
  });
});

describe('read-only policy: git', () => {
  const repo = '/home/user/project';

  it.each([
    ['git_status', { path: repo }],
    ['git_log', { path: repo, maxCount: 5 }],
    ['git_diff', { path: repo }],
    ['git_show', { path: repo, object: 'HEAD' }],
    ['git_branch', { path: repo, mode: 'list' }],
    ['git_remote', { path: repo, mode: 'list' }],
    ['git_set_working_dir', { path: repo }],
  ])('allows the read %s', (tool, args) => {
    expect(decide('git', tool, args)).toBe('allow');
  });

  it.each([
    ['git_commit', { path: repo, message: 'm' }],
    ['git_checkout', { path: repo, target: 'main' }],
    ['git_branch', { path: repo, mode: 'create', branchName: 'x' }],
    ['git_remote', { path: repo, mode: 'add', name: 'up', url: 'https://github.com/o/r.git' }],
    ['git_remote', { path: repo, mode: 'set-url', name: 'origin', url: 'https://github.com/o/r.git' }],
    ['git_set_working_dir', { path: repo, initializeIfNotPresent: true }],
    ['git_push', { path: repo, remote: 'https://github.com/o/r.git', branch: 'main' }],
    ['git_clone', { url: 'https://github.com/o/r.git', path: '/home/user/clone' }],
  ])('escalates the mutation %s', (tool, args) => {
    expect(decide('git', tool, args)).toBe('escalate');
  });
});

describe('read-only policy: web access', () => {
  it.each([
    'https://github.com/torvalds/linux',
    'https://raw.githubusercontent.com/org/repo/main/README.md',
    'https://en.wikipedia.org/wiki/Cryptography',
  ])('allows fetching a known safe domain: %s', (url) => {
    expect(decide('fetch', 'http_fetch', { url })).toBe('allow');
  });

  it.each([
    'https://attacker.example/collect?d=secret',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:8080/secret',
    'http://10.0.0.1/',
    'http://[::1]/',
    'file:///etc/passwd',
  ])('does not allow fetching any other URL: %s', (url) => {
    expect(decide('fetch', 'http_fetch', { url })).not.toBe('allow');
  });

  it('still allows web search', () => {
    expect(decide('fetch', 'web_search', { query: 'release notes' })).toBe('allow');
  });
});

describe('read-only test scenarios', () => {
  // Filesystem scenarios encode the compile machine's sandbox and protected
  // paths; every other server's decisions depend only on the compiled rules.
  const contextFree = scenarios.scenarios.filter((s) => s.request.serverName !== 'filesystem');

  it('include git scenarios', () => {
    expect(contextFree.some((s) => s.request.serverName === 'git')).toBe(true);
  });

  it('use only argument names the bundled annotations classify', () => {
    // The tool-call pipeline denies a call with an unclassified argument
    // ('unannotated-arguments') before policy runs, and the engine ignores the
    // key: a scenario still written for git-mcp-server < 2.15 (git_branch
    // `operation`, git_clone `localPath`) tests a call the kernel never
    // evaluates, and a stale discriminator silently falls back to the default
    // roles.
    const stale = scenarios.scenarios.flatMap(({ request }) => {
      const server = annotations.servers[request.serverName] as
        StoredToolAnnotationsFile['servers'][string] | undefined;
      const stored = server?.tools.find((t) => t.toolName === request.toolName);
      const unclassified = findUnannotatedArguments(request.arguments, stored);
      return unclassified.length > 0 ? [`${request.serverName}/${request.toolName}: ${unclassified.join(', ')}`] : [];
    });
    expect(stale).toEqual([]);
  });

  it('agree with the compiled read-only policy for every non-filesystem server', () => {
    const failures = executeScenarios(engine, contextFree)
      .filter((r) => !r.pass)
      .map(
        (r) =>
          `${r.scenario.request.serverName}/${r.scenario.request.toolName} ${JSON.stringify(r.scenario.request.arguments)}: ` +
          `expected ${r.scenario.expectedDecision}, got ${r.actualDecision} (${r.matchingRule})`,
      );
    expect(failures).toEqual([]);
  });
});

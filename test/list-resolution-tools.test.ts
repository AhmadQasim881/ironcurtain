/**
 * Tests for which MCP tools the list resolver describes to its LLM
 * (src/pipeline/list-resolution-tools.ts) and for the MCP scope rule of
 * data-backed lists (getMcpListScopeError).
 *
 * The per-call policy check in the security kernel is the real control; see
 * list-resolver-mediation.integration.test.ts. These tests cover the
 * least-privilege exposure layer on top of it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canPolicyAllowNetworkEgress,
  canPolicyAllowTool,
  hasNetworkEgressRole,
  isListResolutionTool,
} from '../src/pipeline/list-resolution-tools.js';
import { getMcpListScopeError, LIST_RESOLUTION_EXCLUDED_SERVERS } from '../src/pipeline/dynamic-list-types.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = resolve(__dirname, '..', 'src', 'config');
const readOnlyPolicy = JSON.parse(
  readFileSync(resolve(configDir, 'generated-readonly', 'compiled-policy.json'), 'utf-8'),
) as CompiledPolicyFile;
const bundledAnnotations = JSON.parse(
  readFileSync(resolve(configDir, 'generated', 'tool-annotations.json'), 'utf-8'),
) as StoredToolAnnotationsFile;

function bundled(server: string, tool: string): StoredToolAnnotation | undefined {
  const entry = bundledAnnotations.servers[server] as StoredToolAnnotationsFile['servers'][string] | undefined;
  return entry?.tools.find((t) => t.toolName === tool);
}

/** Whether the bundled read-only policy lets the resolver offer server/tool. */
function offered(server: string, tool: string): boolean {
  return isListResolutionTool(readOnlyPolicy.rules, server, tool, bundled(server, tool));
}

function annotation(toolName: string, args: StoredToolAnnotation['args'], serverName = 'svc'): StoredToolAnnotation {
  return { toolName, serverName, comment: '', args, inputSchema: {} };
}

function rule(name: string, condition: CompiledRule['if'], then: CompiledRule['then']): CompiledRule {
  return { name, description: name, principle: '', if: condition, then, reason: name };
}

describe('list-resolution tool exposure with the bundled read-only policy', () => {
  it.each([
    ['github', 'list_issues'],
    ['github', 'get_file_contents'],
    ['github', 'search_code'],
    ['google-workspace', 'gmail_search_messages'],
    ['google-workspace', 'gmail_get_message'],
    ['google-workspace', 'drive_read_file'],
    ['google-workspace', 'calendar_list_events'],
    ['filesystem', 'read_text_file'],
    ['filesystem', 'list_directory'],
    ['git', 'git_log'],
    ['git', 'git_status'],
    // Multi-mode tools are offered for their read modes; the kernel still
    // escalates (= denies) their mutating modes call by call.
    ['git', 'git_branch'],
    ['git', 'git_remote'],
  ])('offers the read tool %s/%s', (server, tool) => {
    expect(offered(server, tool)).toBe(true);
  });

  it.each([
    ['github', 'push_files'],
    ['github', 'issue_write'],
    ['github', 'create_branch'],
    ['github', 'delete_file'],
    ['github', 'merge_pull_request'],
    ['google-workspace', 'gmail_send_message'],
    ['google-workspace', 'gmail_draft_message'],
    ['google-workspace', 'drive_share_file'],
    ['google-workspace', 'drive_delete_file'],
    ['google-workspace', 'calendar_create_event'],
    ['filesystem', 'write_file'],
    ['filesystem', 'move_file'],
    ['filesystem', 'create_directory'],
    ['git', 'git_commit'],
    ['git', 'git_checkout'],
  ])('hides the mutating tool %s/%s', (server, tool) => {
    expect(offered(server, tool)).toBe(false);
  });

  it.each([
    ['fetch', 'http_fetch'],
    ['fetch', 'web_search'],
    ['git', 'git_push'],
    ['git', 'git_fetch'],
    ['git', 'git_clone'],
  ])('hides the network tool %s/%s', (server, tool) => {
    expect(offered(server, tool)).toBe(false);
  });

  it('offers git_remote for listing although its url is a git-remote-url in add/set-url mode', () => {
    // The read-only policy escalates (= refuses) every git_remote call that
    // sets a remote URL, so the URL role never makes the tool network-capable.
    const remote = bundled('git', 'git_remote');
    expect(remote && hasNetworkEgressRole(remote)).toBe(true);
    expect(remote && canPolicyAllowNetworkEgress(readOnlyPolicy.rules, 'git', 'git_remote', remote)).toBe(false);
    expect(offered('git', 'git_remote')).toBe(true);
  });

  it('hides a tool that has no annotation', () => {
    expect(isListResolutionTool(readOnlyPolicy.rules, 'github', 'send_report', undefined)).toBe(false);
  });

  it('hides no tool that the bundled policy could allow on a server list resolution can connect', () => {
    // A hidden tool stays callable by name (the call is still mediated), so
    // hiding is only least privilege if the kernel then refuses the call. A
    // new read-only allow rule for a hidden tool -- e.g. git_fetch for some
    // remotes -- would make it reachable during list resolution again.
    const allowableButHidden = Object.entries(bundledAnnotations.servers)
      .filter(([server]) => !LIST_RESOLUTION_EXCLUDED_SERVERS.has(server))
      .flatMap(([server, entry]) =>
        entry.tools
          .filter(
            (t) => !offered(server, t.toolName) && canPolicyAllowTool(readOnlyPolicy.rules, server, t.toolName, t),
          )
          .map((t) => `${server}/${t.toolName}`),
      );
    expect(allowableButHidden).toEqual([]);
  });

  it('hides every tool of an excluded server, whatever its roles', () => {
    expect(LIST_RESOLUTION_EXCLUDED_SERVERS.has('fetch')).toBe(true);
    const search = bundled('fetch', 'web_search');
    expect(search && hasNetworkEgressRole(search)).toBe(false);
    expect(search && canPolicyAllowTool(readOnlyPolicy.rules, 'fetch', 'web_search', search)).toBe(true);
    expect(offered('fetch', 'web_search')).toBe(false);
  });
});

describe('canPolicyAllowTool', () => {
  const readTool = annotation('read', { path: ['read-path'] });
  const editTool = annotation('edit', { path: ['read-path', 'write-path'] });

  it('is false under default deny', () => {
    expect(canPolicyAllowTool([], 'svc', 'read', readTool)).toBe(false);
  });

  it('is true when an allow rule matches the server and tool', () => {
    const rules = [rule('allow-read', { server: ['svc'], tool: ['read'] }, 'allow')];
    expect(canPolicyAllowTool(rules, 'svc', 'read', readTool)).toBe(true);
    expect(canPolicyAllowTool(rules, 'other', 'read', readTool)).toBe(false);
  });

  it('is false when a value-independent escalate rule comes first', () => {
    const rules = [
      rule('escalate-read', { server: ['svc'], tool: ['read'] }, 'escalate'),
      rule('allow-read', { server: ['svc'], tool: ['read'] }, 'allow'),
    ];
    expect(canPolicyAllowTool(rules, 'svc', 'read', readTool)).toBe(false);
  });

  it('looks past a value-dependent escalate rule to a later allow', () => {
    const rules = [
      rule('escalate-secrets', { server: ['svc'], paths: { roles: ['read-path'], within: '/secrets' } }, 'escalate'),
      rule('allow-read', { server: ['svc'], tool: ['read'] }, 'allow'),
    ];
    expect(canPolicyAllowTool(rules, 'svc', 'read', readTool)).toBe(true);
  });

  it('counts a value-dependent allow rule as reachable', () => {
    const rules = [rule('allow-docs', { server: ['svc'], paths: { roles: ['read-path'], within: '/docs' } }, 'allow')];
    expect(canPolicyAllowTool(rules, 'svc', 'read', readTool)).toBe(true);
  });

  it('requires every resource role to be allowable (most restrictive wins)', () => {
    // The read-only policy's edit_file shape: the read role is allowed, the
    // write role escalates, so the call as a whole can never be allowed.
    const rules = [
      rule('allow-edit-read', { roles: ['read-path'], server: ['svc'], tool: ['edit'] }, 'allow'),
      rule('escalate-edit', { server: ['svc'], tool: ['edit'] }, 'escalate'),
    ];
    expect(canPolicyAllowTool(rules, 'svc', 'edit', editTool)).toBe(false);
  });

  it('allows a multi-mode tool when one mode is allowable', () => {
    const branch = annotation('branch', {
      path: {
        default: ['read-path', 'write-history'],
        when: [{ condition: { arg: 'operation', in: ['list', 'show'] }, roles: ['read-path'] }],
      },
      operation: ['none'],
    });
    const rules = [
      rule('allow-branch-read', { roles: ['read-path'], server: ['svc'], tool: ['branch'] }, 'allow'),
      rule('escalate-branch', { server: ['svc'], tool: ['branch'] }, 'escalate'),
    ];
    expect(canPolicyAllowTool(rules, 'svc', 'branch', branch)).toBe(true);

    const onlyWrites = annotation('branch', {
      path: {
        default: ['read-path', 'write-history'],
        when: [{ condition: { arg: 'operation', equals: 'create' }, roles: ['read-path', 'write-history'] }],
      },
    });
    expect(canPolicyAllowTool(rules, 'svc', 'branch', onlyWrites)).toBe(false);
  });

  it('evaluates a tool without resource roles unscoped (first matching rule decides)', () => {
    const send = annotation('send', { to: ['email-address'], body: ['email-body'] });
    const escalateFirst = [
      rule('escalate-send', { server: ['svc'], tool: ['send'] }, 'escalate'),
      rule('allow-send', { server: ['svc'], tool: ['send'] }, 'allow'),
    ];
    expect(canPolicyAllowTool(escalateFirst, 'svc', 'send', send)).toBe(false);
    expect(canPolicyAllowTool([...escalateFirst].reverse(), 'svc', 'send', send)).toBe(true);
  });

  it('skips role-scoped rules for roles the tool does not have', () => {
    const rules = [rule('allow-urls', { roles: ['fetch-url'], server: ['svc'] }, 'allow')];
    expect(canPolicyAllowTool(rules, 'svc', 'read', readTool)).toBe(false);
  });
});

describe('canPolicyAllowNetworkEgress', () => {
  // The shape of git_remote's annotation for git-mcp-server 2.15.3: `url` is
  // a git-remote-url only when it sets a remote URL (add/set-url).
  const remoteTool = annotation('remote', {
    path: {
      default: ['read-path', 'write-history'],
      when: [{ condition: { arg: 'mode', in: ['list', 'get-url'] }, roles: ['read-path'] }],
    },
    mode: ['none'],
    url: {
      default: ['git-remote-url'],
      when: [
        { condition: { arg: 'url', is: 'absent' }, roles: ['none'] },
        { condition: { arg: 'mode', in: ['list', 'get-url'] }, roles: ['none'] },
      ],
    },
  });
  const listRemotes = rule('allow-remote-list', { roles: ['read-path'], server: ['svc'], tool: ['remote'] }, 'allow');
  const escalateRemote = rule('escalate-remote', { server: ['svc'], tool: ['remote'] }, 'escalate');

  it('is false for a tool without URL roles', () => {
    const rules = [rule('allow-read', { server: ['svc'], tool: ['read'] }, 'allow')];
    expect(canPolicyAllowNetworkEgress(rules, 'svc', 'read', annotation('read', { path: ['read-path'] }))).toBe(false);
  });

  it('is false when every rule that applies to the URL role refuses it', () => {
    expect(canPolicyAllowNetworkEgress([listRemotes, escalateRemote], 'svc', 'remote', remoteTool)).toBe(false);
  });

  it('is true when a rule could allow the URL role, in whatever mode it occurs', () => {
    const allowGithubRemotes = rule(
      'allow-github-remotes',
      { server: ['svc'], tool: ['remote'], domains: { roles: ['git-remote-url'], allowed: ['github.com'] } },
      'allow',
    );
    expect(
      canPolicyAllowNetworkEgress([allowGithubRemotes, listRemotes, escalateRemote], 'svc', 'remote', remoteTool),
    ).toBe(true);
    // A role-agnostic allow of the tool allows its URL-carrying calls too.
    const allowRemote = rule('allow-remote', { server: ['svc'], tool: ['remote'] }, 'allow');
    expect(canPolicyAllowNetworkEgress([allowRemote], 'svc', 'remote', remoteTool)).toBe(true);
  });

  it('decides whether a multi-mode tool with a URL argument is offered to the resolver', () => {
    // Listing is allowable and URL changes are refused: offered (the kernel
    // refuses add/set-url call by call).
    expect(isListResolutionTool([listRemotes, escalateRemote], 'svc', 'remote', remoteTool)).toBe(true);
    // A policy that could allow a URL change: hidden, although listing is allowable.
    const allowRemote = rule('allow-remote', { server: ['svc'], tool: ['remote'] }, 'allow');
    expect(canPolicyAllowTool([allowRemote], 'svc', 'remote', remoteTool)).toBe(true);
    expect(isListResolutionTool([allowRemote], 'svc', 'remote', remoteTool)).toBe(false);
  });
});

describe('hasNetworkEgressRole', () => {
  it('detects URL roles in static and conditional specs', () => {
    expect(hasNetworkEgressRole(annotation('get', { url: ['fetch-url'] }))).toBe(true);
    expect(
      hasNetworkEgressRole(
        annotation('sync', {
          remote: {
            default: ['git-remote-url'],
            when: [{ condition: { arg: 'mode', equals: 'local' }, roles: ['none'] }],
          },
        }),
      ),
    ).toBe(true);
    expect(hasNetworkEgressRole(annotation('read', { path: ['read-path'], query: ['none'] }))).toBe(false);
  });
});

describe('getMcpListScopeError', () => {
  const base = { name: 'my-contacts', requiresMcp: true } as const;

  it('accepts a knowledge-based list without a server', () => {
    expect(getMcpListScopeError({ name: 'news', requiresMcp: false })).toBeUndefined();
  });

  it('accepts a data-backed list that names its server', () => {
    expect(getMcpListScopeError({ ...base, mcpServerHint: 'google-workspace' })).toBeUndefined();
  });

  it('rejects a data-backed list without mcpServerHint', () => {
    expect(getMcpListScopeError(base)).toMatch(/no mcpServerHint/);
    expect(getMcpListScopeError({ ...base, mcpServerHint: '' })).toMatch(/no mcpServerHint/);
  });

  it('rejects a network-egress server', () => {
    expect(getMcpListScopeError({ ...base, mcpServerHint: 'fetch' })).toMatch(/network server "fetch"/);
  });

  it('quotes names read from disk so they print safely', () => {
    expect(getMcpListScopeError({ name: 'x\u001b[31m', requiresMcp: true })).toContain('\\u001b');
  });
});

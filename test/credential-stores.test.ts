/**
 * Host credential stores are hard-protected paths (WP-02, CFG-13).
 *
 * Covers the store list (src/config/credential-stores.ts), the config field
 * that extends or trims it, computeProtectedPaths, and the PolicyEngine
 * consequence: even a compiled rule that allows reading and writing the whole
 * home directory cannot reach a credential store.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CORE_CREDENTIAL_STORE_IDS,
  EXTENDED_CREDENTIAL_STORE_IDS,
  computeCredentialStoreProtectedPaths,
  getAnthropicCliCredentialsPath,
  getClaudeCodeCredentialsPath,
  getCodexAuthPath,
  listProtectedCredentialStores,
} from '../src/config/credential-stores.js';
import { computeProtectedPaths } from '../src/config/index.js';
import { loadUserConfig, userConfigSchema } from '../src/config/user-config.js';
import { getCodexAuthFilePath, getCredentialsFilePath } from '../src/docker/oauth-credentials.js';
import { loadPipelineConfig } from '../src/pipeline/pipeline-shared.js';
import type { CompiledPolicyFile } from '../src/pipeline/types.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import { testToolAnnotations } from './fixtures/test-policy.js';

let root: string;
let home: string;
let icHome: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-cred-stores-')));
  home = join(root, 'home');
  icHome = join(home, '.ironcurtain');
  mkdirSync(icHome, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('IRONCURTAIN_HOME', icHome);
  for (const name of ['ANTHROPIC_CONFIG_DIR', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'IRONCURTAIN_ENV_FILE']) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function storePaths(id: string, settings?: Parameters<typeof listProtectedCredentialStores>[0]): readonly string[] {
  return listProtectedCredentialStores(settings).find((store) => store.id === id)?.paths ?? [];
}

describe('listProtectedCredentialStores', () => {
  it('protects the stores IronCurtain reads at their default locations', () => {
    expect(storePaths('claude-code')).toEqual([join(home, '.claude', '.credentials.json')]);
    expect(storePaths('anthropic-cli')).toEqual([join(home, '.config', 'anthropic', 'credentials')]);
    expect(storePaths('codex')).toEqual([join(home, '.codex', 'auth.json')]);
    expect(storePaths('ironcurtain-oauth')).toEqual([join(icHome, 'oauth')]);
  });

  it('honours ANTHROPIC_CONFIG_DIR, XDG_CONFIG_HOME and CODEX_HOME and keeps the defaults', () => {
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', join(root, 'anthropic-cfg'));
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'));
    vi.stubEnv('CODEX_HOME', join(root, 'codex-home'));
    expect(storePaths('anthropic-cli')).toEqual([
      join(root, 'anthropic-cfg', 'credentials'),
      join(home, '.config', 'anthropic', 'credentials'),
      join(root, 'xdg', 'anthropic', 'credentials'),
    ]);
    expect(storePaths('codex')).toEqual([join(root, 'codex-home', 'auth.json'), join(home, '.codex', 'auth.json')]);
  });

  it('protects exactly the files the OAuth readers open', () => {
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'));
    vi.stubEnv('CODEX_HOME', join(root, 'codex-home'));
    const protectedPaths = computeCredentialStoreProtectedPaths();
    const covered = (file: string) => protectedPaths.some((p) => file === p || file.startsWith(`${p}/`));
    expect(getCredentialsFilePath()).toBe(getClaudeCodeCredentialsPath());
    expect(getCodexAuthFilePath()).toBe(getCodexAuthPath());
    for (const file of [getClaudeCodeCredentialsPath(), getAnthropicCliCredentialsPath(), getCodexAuthPath()]) {
      expect(covered(file)).toBe(true);
    }
  });

  it('treats an empty CODEX_HOME as unset instead of the working directory', () => {
    vi.stubEnv('CODEX_HOME', '');
    expect(getCodexAuthPath()).toBe(join(home, '.codex', 'auth.json'));
  });

  it('protects every extended store by default', () => {
    const extended = listProtectedCredentialStores().filter((store) => store.tier === 'extended');
    expect(extended.map((store) => store.id)).toEqual([...EXTENDED_CREDENTIAL_STORE_IDS]);
    expect(extended.flatMap((store) => store.paths)).toEqual([
      join(home, '.ssh'),
      join(home, '.aws'),
      join(home, '.gnupg'),
      join(home, '.config', 'gcloud'),
      join(home, '.docker', 'config.json'),
      join(home, '.git-credentials'),
      join(home, '.netrc'),
      join(home, '.npmrc'),
      join(home, '.config', 'gh'),
      join(home, '.kube', 'config'),
    ]);
  });

  it('drops an opted-out extended store but never a core store', () => {
    const stores = listProtectedCredentialStores({ disabledStores: ['npmrc', 'claude-code', 'codex', 'bogus'] });
    const ids = stores.map((store) => store.id);
    expect(ids).not.toContain('npmrc');
    for (const id of CORE_CREDENTIAL_STORE_IDS) expect(ids).toContain(id);
    expect(ids).toContain('ssh');
  });

  it('adds extra paths, expanding ~', () => {
    const stores = listProtectedCredentialStores({ extraPaths: ['~/.vault-token', '/opt/secrets', '~'] });
    expect(stores.at(-1)).toEqual({
      id: 'user',
      tier: 'user',
      paths: [join(home, '.vault-token'), '/opt/secrets', home],
    });
  });

  it('fails closed on a relative extra path', () => {
    expect(() => listProtectedCredentialStores({ extraPaths: ['secrets/token'] })).toThrow(
      /absolute or start with ~\//,
    );
  });
});

describe('credentialProtection config field', () => {
  it('accepts extended ids and absolute or ~/ paths', () => {
    const result = userConfigSchema.safeParse({
      credentialProtection: { disabledStores: ['npmrc', 'kube'], extraPaths: ['~/.vault-token', '/opt/keys'] },
    });
    expect(result.success).toBe(true);
  });

  it.each([
    [{ disabledStores: ['claude-code'] }],
    [{ disabledStores: ['ironcurtain-oauth'] }],
    [{ extraPaths: ['relative/secret'] }],
    [{ extraPaths: ['./secret'] }],
    [{ extraPaths: [''] }],
    [{ extraPaths: ['/opt/\u0000secret'] }],
    [{ extraPath: ['/typo'] }],
  ])('rejects %j', (credentialProtection) => {
    expect(userConfigSchema.safeParse({ credentialProtection }).success).toBe(false);
  });

  it('resolves to empty additions and opt-outs by default', () => {
    expect(loadUserConfig({ readOnly: true }).credentialProtection).toEqual({ extraPaths: [], disabledStores: [] });
  });
});

describe('computeProtectedPaths', () => {
  const base = () => ({
    constitutionPath: join(root, 'constitution.md'),
    generatedDir: join(root, 'generated'),
    packageGeneratedDir: join(root, 'generated'),
    mcpServersPath: join(root, 'mcp-servers.json'),
    auditLogPath: join(root, 'audit.jsonl'),
  });

  it('lists the trusted env file and the credential stores, not the working-directory .env', () => {
    const paths = computeProtectedPaths(base());
    expect(paths).toContain(join(icHome, '.env'));
    expect(paths).toContain(join(icHome, 'oauth'));
    expect(paths).toContain(join(home, '.claude', '.credentials.json'));
    expect(paths).toContain(join(home, '.ssh'));
    expect(paths).not.toContain(resolve('.env'));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('adds an explicit IRONCURTAIN_ENV_FILE and honours credentialProtection', () => {
    vi.stubEnv('IRONCURTAIN_ENV_FILE', join(root, 'work.env'));
    const paths = computeProtectedPaths({
      ...base(),
      credentialProtection: { disabledStores: ['npmrc'], extraPaths: ['~/.vault-token'] },
    });
    expect(paths).toContain(join(root, 'work.env'));
    expect(paths).toContain(join(home, '.vault-token'));
    expect(paths).not.toContain(join(home, '.npmrc'));
  });

  it('is fed config.json credentialProtection by the offline pipeline too (loadPipelineConfig)', () => {
    // compile-policy / annotate-tools / refresh-lists list the protected paths in
    // the compiler prompt and evaluate scenarios with them; they must match the
    // live engine's list (loadConfig), including user additions and opt-outs.
    writeFileSync(
      join(icHome, 'config.json'),
      JSON.stringify({ credentialProtection: { disabledStores: ['npmrc'], extraPaths: ['~/.vault-token'] } }),
    );
    const { protectedPaths } = loadPipelineConfig();
    expect(protectedPaths).toContain(join(home, '.vault-token'));
    expect(protectedPaths).not.toContain(join(home, '.npmrc'));
    expect(protectedPaths).toContain(join(home, '.claude', '.credentials.json'));
    expect(protectedPaths).toContain(join(icHome, '.env'));
  });
});

describe('PolicyEngine: credential stores under an allow-home rule', () => {
  const SANDBOX_NAME = 'sandbox';

  function allowHomePolicy(): CompiledPolicyFile {
    return {
      generatedAt: 'test',
      constitutionHash: 'test',
      inputHash: 'test',
      rules: [
        {
          name: 'allow-read-home',
          description: 'Allow reading anything in the home directory.',
          principle: 'A deliberately broad grant',
          if: { paths: { roles: ['read-path'], within: home }, server: ['filesystem'] },
          then: 'allow',
          reason: 'Broad home read grant.',
        },
        {
          name: 'allow-write-home',
          description: 'Allow writing anything in the home directory.',
          principle: 'A deliberately broad grant',
          if: { paths: { roles: ['write-path'], within: home }, server: ['filesystem'] },
          then: 'allow',
          reason: 'Broad home write grant.',
        },
      ],
    };
  }

  function engineFor(settings?: { disabledStores?: string[]; extraPaths?: string[] }): PolicyEngine {
    const sandbox = join(root, SANDBOX_NAME);
    mkdirSync(sandbox, { recursive: true });
    const protectedPaths = computeProtectedPaths({
      constitutionPath: join(root, 'constitution.md'),
      generatedDir: join(root, 'generated'),
      packageGeneratedDir: join(root, 'generated'),
      mcpServersPath: join(root, 'mcp-servers.json'),
      auditLogPath: join(root, 'audit.jsonl'),
      credentialProtection: settings,
    });
    return new PolicyEngine(allowHomePolicy(), testToolAnnotations, protectedPaths, sandbox);
  }

  function request(toolName: 'read_file' | 'write_file', path: string): ToolCallRequest {
    return {
      requestId: 'cred-test',
      serverName: 'filesystem',
      toolName,
      arguments: toolName === 'write_file' ? { path, content: 'x' } : { path },
      timestamp: new Date().toISOString(),
    };
  }

  it('denies reading ~/.claude/.credentials.json even though the rule allows all of ~', () => {
    const result = engineFor().evaluate(request('read_file', join(home, '.claude', '.credentials.json')));
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('structural-protected-path');
  });

  it('still allows the rest of ~/.claude (only the credential file is protected)', () => {
    const result = engineFor().evaluate(request('read_file', join(home, '.claude', 'settings.json')));
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-read-home');
  });

  it.each([
    ['the Anthropic CLI store', ['.config', 'anthropic', 'credentials', 'default.json']],
    ['the Codex auth cache', ['.codex', 'auth.json']],
    ['IronCurtain OAuth tokens', ['.ironcurtain', 'oauth', 'google-workspace.json']],
    ['the trusted .env', ['.ironcurtain', '.env']],
    ['an SSH private key', ['.ssh', 'id_ed25519']],
    ['SSH config', ['.ssh', 'config']],
    ['AWS credentials', ['.aws', 'credentials']],
    ['the GnuPG keyring', ['.gnupg', 'private-keys-v1.d', 'key.key']],
    ['gcloud credentials', ['.config', 'gcloud', 'application_default_credentials.json']],
    ['Docker registry auth', ['.docker', 'config.json']],
    ['git credentials', ['.git-credentials']],
    ['.netrc', ['.netrc']],
    ['.npmrc', ['.npmrc']],
    ['the GitHub CLI token', ['.config', 'gh', 'hosts.yml']],
    ['the kubeconfig', ['.kube', 'config']],
  ])('denies reading and writing %s', (_label, parts) => {
    const engine = engineFor();
    const path = join(home, ...parts);
    for (const tool of ['read_file', 'write_file'] as const) {
      const result = engine.evaluate(request(tool, path));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    }
  });

  it('allows an extended store the user opted out of, and denies a user-added path', () => {
    const engine = engineFor({ disabledStores: ['npmrc'], extraPaths: ['~/.vault-token'] });
    expect(engine.evaluate(request('read_file', join(home, '.npmrc'))).decision).toBe('allow');
    expect(engine.evaluate(request('read_file', join(home, '.vault-token'))).decision).toBe('deny');
    expect(engine.evaluate(request('read_file', join(home, '.claude', '.credentials.json'))).decision).toBe('deny');
  });

  it('protects the Codex store at CODEX_HOME as well as the default', () => {
    vi.stubEnv('CODEX_HOME', join(root, 'codex-home'));
    const engine = engineFor();
    for (const path of [join(root, 'codex-home', 'auth.json'), join(home, '.codex', 'auth.json')]) {
      expect(engine.evaluate(request('read_file', path)).rule).toBe('structural-protected-path');
    }
  });
});

describe('PolicyEngine: credential stores inside the workspace', () => {
  // The sandbox exemption (src/trusted-process/protected-paths.ts) only covers
  // protected entries that strictly contain the sandbox. A credential store or
  // an explicit --env-file inside a --workspace is an entry inside the sandbox,
  // so sandbox containment must never allow it, under any spelling.
  const noRules: CompiledPolicyFile = { generatedAt: 'test', constitutionHash: 'test', inputHash: 'test', rules: [] };

  function workspaceEngine(workspace: string): PolicyEngine {
    mkdirSync(workspace, { recursive: true });
    const protectedPaths = computeProtectedPaths({
      constitutionPath: join(root, 'constitution.md'),
      generatedDir: join(root, 'generated'),
      packageGeneratedDir: join(root, 'generated'),
      mcpServersPath: join(root, 'mcp-servers.json'),
      auditLogPath: join(root, 'audit.jsonl'),
    });
    return new PolicyEngine(noRules, testToolAnnotations, protectedPaths, workspace);
  }

  function evaluate(engine: PolicyEngine, toolName: 'read_file' | 'write_file', path: string) {
    return engine.evaluate({
      requestId: 'cred-ws-test',
      serverName: 'filesystem',
      toolName,
      arguments: toolName === 'write_file' ? { path, content: 'x' } : { path },
      timestamp: new Date().toISOString(),
    });
  }

  it('denies the Claude Code credentials under a ~/.claude workspace and allows the rest of it', () => {
    const workspace = join(home, '.claude');
    const engine = workspaceEngine(workspace);
    for (const name of ['.credentials.json', '.CREDENTIALS.json', '.Credentials.JSON']) {
      for (const tool of ['read_file', 'write_file'] as const) {
        const result = evaluate(engine, tool, join(workspace, name));
        expect(result.decision, `${tool} ${name}`).toBe('deny');
        expect(result.rule, `${tool} ${name}`).toBe('structural-protected-path');
      }
    }
    const settings = evaluate(engine, 'write_file', join(workspace, 'settings.json'));
    expect(settings.decision).toBe('allow');
    expect(settings.rule).toBe('structural-sandbox-allow');
  });

  it('denies an explicit IRONCURTAIN_ENV_FILE kept in the workspace', () => {
    const workspace = join(root, 'project');
    vi.stubEnv('IRONCURTAIN_ENV_FILE', join(workspace, 'work.env'));
    const engine = workspaceEngine(workspace);
    for (const tool of ['read_file', 'write_file'] as const) {
      const result = evaluate(engine, tool, join(workspace, 'work.env'));
      expect(result.decision, tool).toBe('deny');
      expect(result.rule, tool).toBe('structural-protected-path');
    }
  });
});

/**
 * Allowlisted child environments (src/trusted-process/child-env.ts): the
 * host's secrets never reach an MCP relay or backend, the variables a server
 * genuinely needs do, and a `-e NAME` credential is found wherever it is
 * configured. The relay round trip itself is covered by
 * child-env-relay.integration.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_INHERITED_ENV_VARS as SDK_DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  DEFAULT_INHERITED_ENV_VARS,
  inheritedEnv,
  ironcurtainSubprocessEnv,
  isEnvVarProvided,
  isNeverInheritedEnvName,
  mcpServerSpawnEnv,
  missingPassthroughEnvVars,
  passthroughEnvNames,
  pickPassthroughEnv,
  relayHostSettings,
  RELAY_HOST_SETTING_NAMES,
  RELAY_INTERNAL_ENV_NAMES,
  type HostEnv,
} from '../src/trusted-process/child-env.js';
import { PROVIDER_ENV_VARS } from '../src/config/model-id.js';

/** A host environment with everything a user's shell might carry. */
function hostEnv(extra: Record<string, string | undefined> = {}): HostEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/home/user',
    USER: 'user',
    LOGNAME: 'user',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'Europe/Amsterdam',
    TMPDIR: '/tmp/user',
    XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_CONFIG_HOME: '/home/user/.config',
    HTTPS_PROXY: 'http://proxy:3128',
    NO_PROXY: 'localhost',
    NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem',
    npm_config_registry: 'https://npm.corp.example',
    npm_config_cache: '/home/user/.npm',
    DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
    DOCKER_CONTEXT: 'rootless',
    NVM_DIR: '/home/user/.nvm',
    IRONCURTAIN_HOME: '/home/user/.ironcurtain',
    IRONCURTAIN_CONTAINER_RUNTIME: 'docker',
    TSX_TSCONFIG_PATH: '/src/tsconfig.json',
    SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.sock',
    // What must stay behind.
    ANTHROPIC_API_KEY: 'sk-ant-host',
    OPENAI_API_KEY: 'sk-openai-host',
    GOOGLE_GENERATIVE_AI_API_KEY: 'google-host',
    OPENROUTER_API_KEY: 'or-host',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_host',
    MCP_SERVERS_CONFIG: '{"other":{"env":{"SECRET":"x"}}}',
    SERVER_CREDENTIALS: '{"TOKEN":"x"}',
    SESSION_LOG_PATH: '/home/user/.ironcurtain/sessions/s/session.log',
    MITM_CONTROL_ADDR: 'http://127.0.0.1:1',
    NODE_OPTIONS: '--require /tmp/evil.js',
    NODE_PATH: '/tmp/evil-modules',
    LD_PRELOAD: '/tmp/evil.so',
    DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
    BASH_ENV: '/tmp/evil.sh',
    'BASH_FUNC_ls%%': '() {  echo pwned; }',
    npm_config__authToken: 'npm-secret',
    'npm_config_//registry.npmjs.org/:_authToken': 'npm-secret-2',
    npm_config_node_options: '--require /tmp/evil.js',
    npm_config_key: '-----BEGIN PRIVATE KEY-----',
    npm_config_client_secret: 'npm-secret-3',
    REQUESTS_CA_BUNDLE: '/etc/corp-ca.pem',
    IRONCURTAIN_CANARY: 'canary',
    ...extra,
  };
}

describe('inheritedEnv', () => {
  it("mirrors the MCP SDK's default inherited set exactly", () => {
    // Copied, not imported, so spawn sites work under test doubles of the SDK;
    // this keeps the copy honest across SDK upgrades.
    expect([...DEFAULT_INHERITED_ENV_VARS]).toEqual([...SDK_DEFAULT_INHERITED_ENV_VARS]);
  });

  it("inherits the SDK's default set and the system variables a server needs", () => {
    const env = inheritedEnv(hostEnv());
    for (const name of DEFAULT_INHERITED_ENV_VARS) expect(env[name]).toBe(hostEnv()[name]);
    for (const name of [
      'LANG',
      'LC_ALL',
      'TZ',
      'TMPDIR',
      'XDG_RUNTIME_DIR',
      'XDG_CONFIG_HOME',
      'HTTPS_PROXY',
      'NO_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'REQUESTS_CA_BUNDLE',
      'npm_config_registry',
      'npm_config_cache',
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'NVM_DIR',
      'IRONCURTAIN_HOME',
      'IRONCURTAIN_CONTAINER_RUNTIME',
      'TSX_TSCONFIG_PATH',
    ]) {
      expect(env[name], name).toBe(hostEnv()[name]);
    }
  });

  it('drops provider keys, other servers’ tokens, relay configuration and anything else unlisted', () => {
    const env = inheritedEnv(hostEnv());
    for (const name of Object.values(PROVIDER_ENV_VARS)) expect(env).not.toHaveProperty(name);
    for (const name of [
      'OPENROUTER_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      'IRONCURTAIN_CANARY',
      ...RELAY_INTERNAL_ENV_NAMES,
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it('never inherits the code-injection variables, exported functions or npm credentials', () => {
    const env = inheritedEnv(hostEnv());
    for (const name of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'BASH_FUNC_ls%%',
      'npm_config__authToken',
      'npm_config_//registry.npmjs.org/:_authToken',
      'npm_config_node_options',
      'npm_config_key',
      'npm_config_client_secret',
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
    // A `-e NODE_OPTIONS` argument does not smuggle it in either.
    expect(inheritedEnv(hostEnv(), { passthroughNames: ['NODE_OPTIONS', 'LD_PRELOAD'] })).not.toHaveProperty(
      'NODE_OPTIONS',
    );
    expect(inheritedEnv(hostEnv(), { passthroughNames: ['NODE_OPTIONS', 'LD_PRELOAD'] })).not.toHaveProperty(
      'LD_PRELOAD',
    );
    expect(isNeverInheritedEnvName('LD_LIBRARY_PATH')).toBe(true);
    expect(isNeverInheritedEnvName('DYLD_LIBRARY_PATH')).toBe(true);
    expect(isNeverInheritedEnvName('NODE_EXTRA_CA_CERTS')).toBe(false);
  });

  it("inherits git's config-file selection, and no other GIT_* variable", () => {
    // The policy engine resolves where a git remote connects from the files
    // these name (git-remote-resolution.ts); the git a backend runs must read
    // the same ones, or what was evaluated is not what runs.
    const env = inheritedEnv(
      hostEnv({
        GIT_CONFIG_GLOBAL: '/home/user/dotfiles/gitconfig',
        GIT_CONFIG_SYSTEM: '/etc/gitconfig.d/corp',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_DIR: '/elsewhere/.git',
        GIT_SSH_COMMAND: 'ssh -i /home/user/.ssh/other',
        GIT_CEILING_DIRECTORIES: '/net',
        GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='touch /tmp/x'",
      }),
    );
    expect(env.GIT_CONFIG_GLOBAL).toBe('/home/user/dotfiles/gitconfig');
    expect(env.GIT_CONFIG_SYSTEM).toBe('/etc/gitconfig.d/corp');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    for (const name of ['GIT_DIR', 'GIT_SSH_COMMAND', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_PARAMETERS']) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it('forwards the ssh-agent socket only on request', () => {
    expect(inheritedEnv(hostEnv())).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(inheritedEnv(hostEnv(), { sshAgent: false })).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(inheritedEnv(hostEnv(), { sshAgent: true }).SSH_AUTH_SOCK).toBe('/run/user/1000/ssh-agent.sock');
  });

  it('forwards the named `-e` passthroughs that are set, and only those', () => {
    const env = inheritedEnv(hostEnv(), { passthroughNames: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'UNSET_TOKEN'] });
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_host');
    expect(env).not.toHaveProperty('UNSET_TOKEN');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it("never forwards the relay's own configuration, even when a `-e` argument names it", () => {
    const env = inheritedEnv(hostEnv(), { passthroughNames: [...RELAY_INTERNAL_ENV_NAMES] });
    for (const name of RELAY_INTERNAL_ENV_NAMES) expect(env, name).not.toHaveProperty(name);
  });

  it('skips undefined values and exported shell functions under an allowed name', () => {
    const env = inheritedEnv(hostEnv({ LANG: undefined, TZ: '() { :; }' }));
    expect(env).not.toHaveProperty('LANG');
    expect(env).not.toHaveProperty('TZ');
  });

  it('reads process.env by default', () => {
    expect(inheritedEnv().PATH).toBe(process.env.PATH);
  });
});

describe('relayHostSettings', () => {
  const moved = { ANTHROPIC_CONFIG_DIR: '/data/anthropic-cli', CODEX_HOME: '/data/codex' };

  it('hands a relay the locations of the moved credential stores, and no backend', () => {
    expect(relayHostSettings(hostEnv(moved))).toEqual(moved);
    // Backends inherit only the allowlist: where the stores are is none of their business.
    for (const name of RELAY_HOST_SETTING_NAMES) {
      expect(inheritedEnv(hostEnv(moved)), name).not.toHaveProperty(name);
    }
  });

  it('skips unset and empty values (credential-stores.ts reads an empty value as unset)', () => {
    expect(relayHostSettings(hostEnv())).toEqual({});
    expect(relayHostSettings(hostEnv({ ANTHROPIC_CONFIG_DIR: '', CODEX_HOME: undefined }))).toEqual({});
  });

  it('covers every environment override credential-stores.ts reads', () => {
    // The relay locates the stores it hides from sandboxed servers through
    // credential-stores.ts. Each override it reads must reach the relay:
    // inherited by every child, or a relay-only host setting. A new override
    // added there without one of these would silently move the srt deny
    // back to the default location.
    const source = readFileSync(new URL('../src/config/credential-stores.ts', import.meta.url), 'utf-8');
    const read = [...source.matchAll(/envValue\('([A-Z0-9_]+)'\)/g)].map((match) => match[1]);
    expect(read.length).toBeGreaterThanOrEqual(3);
    for (const name of read) {
      const inherited = name in inheritedEnv({ [name]: '/x' });
      expect(inherited || RELAY_HOST_SETTING_NAMES.includes(name), name).toBe(true);
    }
  });
});

describe('passthroughEnvNames', () => {
  it('collects `-e NAME` arguments and skips `-e NAME=value`, duplicates and a trailing -e', () => {
    expect(
      passthroughEnvNames(['run', '-i', '--rm', '-e', 'TOKEN', '-e', 'MODE=prod', '-e', 'TOKEN', 'img', '-e']),
    ).toEqual(['TOKEN']);
    expect(passthroughEnvNames([])).toEqual([]);
    expect(passthroughEnvNames(['node', 'server.js'])).toEqual([]);
  });
});

describe('pickPassthroughEnv', () => {
  it('copies the set passthrough values from the host and never a code-injection variable', () => {
    const picked = pickPassthroughEnv(hostEnv(), [
      'run',
      '-e',
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      '-e',
      'UNSET',
      '-e',
      'NODE_OPTIONS',
    ]);
    expect(picked).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_host' });
  });

  it("never copies the relay's own configuration from the host", () => {
    const args = RELAY_INTERNAL_ENV_NAMES.flatMap((name) => ['-e', name]);
    expect(pickPassthroughEnv(hostEnv(), ['run', ...args, 'image'])).toEqual({});
  });
});

describe('isEnvVarProvided', () => {
  it('accepts a non-empty value from any one source and nothing else', () => {
    expect(isEnvVarProvided('TOKEN', { env: { TOKEN: 'a' } })).toBe(true);
    expect(isEnvVarProvided('TOKEN', { env: {}, configEnv: { TOKEN: 'a' } })).toBe(true);
    expect(isEnvVarProvided('TOKEN', { env: {}, credentials: { TOKEN: 'a' } })).toBe(true);
    expect(
      isEnvVarProvided('TOKEN', { env: { TOKEN: '' }, configEnv: { TOKEN: '' }, credentials: { TOKEN: '' } }),
    ).toBe(false);
    expect(isEnvVarProvided('TOKEN', { env: { OTHER: 'a' }, credentials: { OTHER: 'b' } })).toBe(false);
  });
});

describe('missingPassthroughEnvVars', () => {
  const args = ['run', '-e', 'TOKEN_A', '-e', 'TOKEN_B', 'image'];

  it('reports a variable missing only when no source has a non-empty value', () => {
    expect(missingPassthroughEnvVars(args, { env: {} })).toEqual(['TOKEN_A', 'TOKEN_B']);
    expect(missingPassthroughEnvVars(args, { env: { TOKEN_A: '' }, configEnv: { TOKEN_B: '' } })).toEqual([
      'TOKEN_A',
      'TOKEN_B',
    ]);
  });

  it('accepts the host environment, the server env block and stored credentials alike', () => {
    expect(missingPassthroughEnvVars(args, { env: { TOKEN_A: 'a' }, credentials: { TOKEN_B: 'b' } })).toEqual([]);
    expect(
      missingPassthroughEnvVars(args, { env: {}, configEnv: { TOKEN_A: 'a' }, credentials: { TOKEN_B: 'b' } }),
    ).toEqual([]);
    // The documented case: the credential lives only in config.json.
    expect(missingPassthroughEnvVars(args, { env: {}, credentials: { TOKEN_A: 'a', TOKEN_B: 'b' } })).toEqual([]);
  });
});

describe('mcpServerSpawnEnv', () => {
  it('layers the allowlist, the passthroughs, the env block and the credentials in that order', () => {
    const env = mcpServerSpawnEnv(
      {
        command: 'docker',
        args: ['run', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'img'],
        env: { MCP_TRANSPORT_TYPE: 'stdio', LANG: 'C', GITHUB_PERSONAL_ACCESS_TOKEN: 'from-env-block' },
      },
      hostEnv(),
      { credentials: { GITHUB_PERSONAL_ACCESS_TOKEN: 'from-config' } },
    );
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.MCP_TRANSPORT_TYPE).toBe('stdio');
    expect(env.LANG).toBe('C');
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('from-config');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it('forwards the ssh-agent socket when asked (the git backend)', () => {
    expect(mcpServerSpawnEnv({ command: 'node', args: [] }, hostEnv(), { sshAgent: true }).SSH_AUTH_SOCK).toBe(
      '/run/user/1000/ssh-agent.sock',
    );
  });
});

describe('ironcurtainSubprocessEnv', () => {
  it("keeps the user's credentials and settings for IronCurtain's own child", () => {
    const env = ironcurtainSubprocessEnv(hostEnv());
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      'IRONCURTAIN_CANARY',
      'SSH_AUTH_SOCK',
      'TERM',
    ]) {
      expect(env[name], name).toBe(hostEnv()[name]);
    }
  });

  it('drops the code-injection, shell start-up and relay-internal variables', () => {
    const env = ironcurtainSubprocessEnv(hostEnv());
    for (const name of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'BASH_FUNC_ls%%',
      ...RELAY_INTERNAL_ENV_NAMES,
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
    expect(Object.keys(env)).not.toContain(undefined);
  });
});

describe.each(['IRONCURTAIN_MCP_TCP_TOKEN', 'IRONCURTAIN_HTTP_PROXY_AUTHORIZATION', 'IRONCURTAIN_APT_PROXY_CONFIG'])(
  'runtime admission channel %s',
  (name) => {
    const environment = (): HostEnv => hostEnv({ [name]: 'a1'.repeat(32) });

    it('is reserved and never inherited or explicitly forwarded to a backend', () => {
      expect(RELAY_INTERNAL_ENV_NAMES).toContain(name);
      expect(inheritedEnv(environment(), { passthroughNames: [name] })).not.toHaveProperty(name);
      expect(pickPassthroughEnv(environment(), ['run', '-e', name, 'image'])).toEqual({});
      expect(ironcurtainSubprocessEnv(environment())).not.toHaveProperty(name);
    });
  },
);

describe('the MITM control API token', () => {
  // Whoever holds MITM_CONTROL_TOKEN can approve and revoke passthrough
  // hosts. Only the virtual proxy-tool relay is given it, in the explicit
  // block its parent builds; no other child may receive it by any route.
  const withToken = (): HostEnv => hostEnv({ MITM_CONTROL_TOKEN: 'per-bundle-control-token' });

  it('is relay-internal configuration', () => {
    expect(RELAY_INTERNAL_ENV_NAMES).toContain('MITM_CONTROL_TOKEN');
  });

  it('is never inherited, not even when a `-e` argument names it', () => {
    expect(inheritedEnv(withToken())).not.toHaveProperty('MITM_CONTROL_TOKEN');
    expect(inheritedEnv(withToken(), { passthroughNames: ['MITM_CONTROL_TOKEN'] })).not.toHaveProperty(
      'MITM_CONTROL_TOKEN',
    );
    expect(pickPassthroughEnv(withToken(), ['run', '-e', 'MITM_CONTROL_TOKEN', 'image'])).toEqual({});
  });

  it("does not reach IronCurtain's own interactive child either", () => {
    expect(ironcurtainSubprocessEnv(withToken())).not.toHaveProperty('MITM_CONTROL_TOKEN');
  });
});

describe("the relay's backend call bound", () => {
  // BACKEND_CALL_TIMEOUT_MS bounds one backend tool call in a relay. Only a
  // session parent sets it, explicitly, from the session config: an
  // inherited or forwarded value would move another relay's deadline, and a
  // malformed one would stop it.
  const withBound = (): HostEnv => hostEnv({ BACKEND_CALL_TIMEOUT_MS: '60s' });

  it('is relay-internal configuration', () => {
    expect(RELAY_INTERNAL_ENV_NAMES).toContain('BACKEND_CALL_TIMEOUT_MS');
  });

  it('is never inherited, not even when a `-e` argument names it', () => {
    expect(inheritedEnv(withBound())).not.toHaveProperty('BACKEND_CALL_TIMEOUT_MS');
    expect(inheritedEnv(withBound(), { passthroughNames: ['BACKEND_CALL_TIMEOUT_MS'] })).not.toHaveProperty(
      'BACKEND_CALL_TIMEOUT_MS',
    );
    expect(pickPassthroughEnv(withBound(), ['run', '-e', 'BACKEND_CALL_TIMEOUT_MS', 'image'])).toEqual({});
    expect(ironcurtainSubprocessEnv(withBound())).not.toHaveProperty('BACKEND_CALL_TIMEOUT_MS');
  });
});

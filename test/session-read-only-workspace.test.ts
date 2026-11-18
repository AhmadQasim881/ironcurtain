/**
 * `buildSessionConfig` for a read-only workflow state (WP-131): the session's
 * own config carries the read-only workspace (read-only Docker mount and a
 * confining coordinator), switches nested Docker off, and keeps the filesystem
 * server the agent writes its outputs through. A borrowed bundle cannot be
 * made read-only per session.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as loggerModule from '../src/logger.js';
import { REAL_TMP, TEST_SANDBOX_DIR } from './fixtures/test-policy.js';
import { writePersonaPolicy } from './fixtures/scoped-policy.js';
import { buildSessionConfig } from '../src/session/index.js';
import { createSessionId } from '../src/session/types.js';
import { applyReadOnlyWorkspace, assertReadOnlyWorkspaceSupported } from '../src/config/read-only-workspace.js';
import { createReadOnlyWorkspace } from '../src/types/read-only-workspace.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';

const TEST_HOME = `${REAL_TMP}/ironcurtain-session-read-only-test-${process.pid}`;
const READ_ONLY = createReadOnlyWorkspace(['.workflow/reviews']);

function createTestConfig(): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: TEST_SANDBOX_DIR,
    mcpServers: {
      filesystem: { command: 'echo', args: ['filesystem'] },
      git: { command: 'echo', args: ['git'] },
    },
    protectedPaths: [],
    generatedDir: resolve(TEST_HOME, 'generated'),
    constitutionPath: `${REAL_TMP}/test-constitution.md`,
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'test-api-key',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      memory: { enabled: false, autoSave: false, llmBaseUrl: undefined, llmApiKey: undefined },
      dockerWorkload: { enabled: true },
    },
  } as unknown as IronCurtainConfig;
}

/**
 * A persona whose compiled policy names only the git server. The rule
 * escalates: an unconditioned `allow` would grant broad access, which
 * `resolvePersona` refuses for a persona without the broad-policy opt-in.
 */
function createGitOnlyPersona(name: string, servers?: readonly string[]): void {
  const personaDir = resolve(TEST_HOME, 'personas', name);
  mkdirSync(resolve(personaDir, 'workspace'), { recursive: true });
  writeFileSync(
    resolve(personaDir, 'persona.json'),
    JSON.stringify({
      name,
      description: 'test',
      createdAt: '2026-11-11T00:00:00.000Z',
      memory: { enabled: false },
      ...(servers !== undefined ? { servers } : {}),
    }),
  );
  writePersonaPolicy(personaDir, {
    rules: [
      {
        name: 'escalate-git',
        description: 'test',
        principle: 'test',
        if: { server: ['git'] },
        then: 'escalate',
        reason: 'test',
      },
    ],
  });
}

beforeEach(() => {
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  mkdirSync(resolve(TEST_HOME, 'generated'), { recursive: true });
});

afterEach(() => {
  loggerModule.teardown();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('buildSessionConfig with a read-only workspace', () => {
  it('makes the session read-only, without nested Docker, keeping the filesystem server', () => {
    createGitOnlyPersona('git-only');
    const config = createTestConfig();
    const sessionId = createSessionId();

    const readOnly = buildSessionConfig(config, sessionId, sessionId, {
      persona: 'git-only',
      workflow: { stateId: 'review', readOnlyWorkspace: READ_ONLY },
    });

    expect(readOnly.config.readOnlyWorkspace).toEqual(READ_ONLY);
    expect(readOnly.config.userConfig.dockerWorkload).toEqual({ enabled: false });
    // The persona's policy names no filesystem server; the read-only agent
    // still needs it to write its outputs.
    expect(Object.keys(readOnly.config.mcpServers).sort()).toEqual(['filesystem', 'git']);
    // The caller's config is untouched.
    expect(config.readOnlyWorkspace).toBeUndefined();
    expect(config.userConfig.dockerWorkload).toEqual({ enabled: true });

    loggerModule.teardown();
    const readWriteId = createSessionId();
    const readWrite = buildSessionConfig(config, readWriteId, readWriteId, {
      persona: 'git-only',
      workflow: { stateId: 'implement' },
    });
    expect(readWrite.config.readOnlyWorkspace).toBeUndefined();
    expect(readWrite.config.userConfig.dockerWorkload).toEqual({ enabled: true });
    expect(Object.keys(readWrite.config.mcpServers)).toEqual(['git']);
  });

  it('keeps the filesystem server when the persona server allowlist leaves it out', () => {
    // The allowlist always includes the filesystem server, so a read-only
    // state whose persona allows only other servers can still write its outputs.
    createGitOnlyPersona('git-allowlist', ['git']);
    const config = createTestConfig();
    const sessionId = createSessionId();

    const readOnly = buildSessionConfig(config, sessionId, sessionId, {
      persona: 'git-allowlist',
      workflow: { stateId: 'review', readOnlyWorkspace: READ_ONLY },
    });

    expect(Object.keys(readOnly.config.mcpServers).sort()).toEqual(['filesystem', 'git']);
  });

  it('refuses a read-only workspace for a session that borrows a bundle', () => {
    const config = createTestConfig();
    const sessionId = createSessionId();
    const bundle = {
      bundleDir: resolve(TEST_HOME, 'bundle'),
      escalationDir: resolve(TEST_HOME, 'bundle', 'escalations'),
      auditLogPath: resolve(TEST_HOME, 'bundle', 'audit.jsonl'),
      restageSkills: () => {},
    } as unknown as DockerInfrastructure;

    expect(() =>
      buildSessionConfig(config, sessionId, sessionId, {
        workflow: { stateId: 'review', infrastructure: bundle, readOnlyWorkspace: READ_ONLY },
      }),
    ).toThrow(/borrowed bundle carries its scope's workspace access/);
  });
});

describe('applyReadOnlyWorkspace', () => {
  it('sets the read-only workspace and disables nested Docker on a copy', () => {
    const config = createTestConfig();
    const applied = applyReadOnlyWorkspace(config, READ_ONLY);
    expect(applied.readOnlyWorkspace).toBe(READ_ONLY);
    expect(applied.userConfig.dockerWorkload).toEqual({ enabled: false });
    expect(config.readOnlyWorkspace).toBeUndefined();
    expect(() => assertReadOnlyWorkspaceSupported(applied)).not.toThrow();
  });

  it('refuses a read-only workspace that still has nested Docker enabled', () => {
    const config = { ...createTestConfig(), readOnlyWorkspace: READ_ONLY };
    expect(() => assertReadOnlyWorkspaceSupported(config)).toThrow(/cannot run with nested Docker/);
    expect(() => assertReadOnlyWorkspaceSupported(createTestConfig())).not.toThrow();
  });
});

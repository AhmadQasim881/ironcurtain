/**
 * The configured `escalationTimeoutSeconds` reaches the coordinator a real
 * `Sandbox` builds (WP-35, SES-12).
 *
 * Before the fix the in-process escalation wait read
 * `process.env.ESCALATION_TIMEOUT_SECONDS`, which only relay subprocesses
 * were given, so it always waited 300 s whatever the user configured. Now
 * `buildCoordinator` passes the configured value, the relay gets only the
 * backend call bound, and the Code Mode chain outlives the longest single
 * wait inside it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sandbox } from '../src/sandbox/index.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { codeModeChainTimeoutMs, DEFAULT_BACKEND_CALL_TIMEOUT_MS } from '../src/trusted-process/call-timeouts.js';
import { testCompiledPolicy, testToolAnnotations, REAL_TMP } from './fixtures/test-policy.js';

const TEST_ROOT = `${REAL_TMP}/ironcurtain-sandbox-esc-timeout-${process.pid}`;
const GENERATED_DIR = `${TEST_ROOT}/generated`;
const SANDBOX_DIR = `${TEST_ROOT}/sandbox`;

function makeConfig(escalationTimeoutSeconds: number): IronCurtainConfig {
  return {
    auditLogPath: `${TEST_ROOT}/audit-${escalationTimeoutSeconds}.jsonl`,
    allowedDirectory: SANDBOX_DIR,
    // No backends: only the coordinator wiring is under test.
    mcpServers: {},
    protectedPaths: [],
    generatedDir: GENERATED_DIR,
    constitutionPath: resolve(TEST_ROOT, 'constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds,
    userConfig: {
      escalationTimeoutSeconds,
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      serverCredentials: {},
    },
  } as unknown as IronCurtainConfig;
}

// No backends and no execute_code: initialize() creates no V8 isolate, so this
// file needs neither the isolated-vm gate nor the serialized vitest project.
describe('Sandbox escalation and chain timeouts', () => {
  let sandbox: Sandbox | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    mkdirSync(SANDBOX_DIR, { recursive: true });
    mkdirSync(GENERATED_DIR, { recursive: true });
    writeFileSync(resolve(GENERATED_DIR, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(GENERATED_DIR, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));
    savedEnv = process.env.ESCALATION_TIMEOUT_SECONDS;
  });

  afterEach(async () => {
    await sandbox?.shutdown();
    sandbox = undefined;
    if (savedEnv === undefined) delete process.env.ESCALATION_TIMEOUT_SECONDS;
    else process.env.ESCALATION_TIMEOUT_SECONDS = savedEnv;
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('applies the configured escalationTimeoutSeconds, not the environment', async () => {
    // A stray value in this process's environment must not change the wait.
    process.env.ESCALATION_TIMEOUT_SECONDS = '7';
    sandbox = new Sandbox();
    await sandbox.initialize(makeConfig(45));

    const coordinator = sandbox.getCoordinator();
    expect(coordinator?.getEscalationTimeoutMs()).toBe(45_000);
    expect(coordinator?.getBackendCallTimeoutMs()).toBe(DEFAULT_BACKEND_CALL_TIMEOUT_MS);
  });

  it('keeps the execute_code chain alive past the longest configured wait', async () => {
    sandbox = new Sandbox();
    await sandbox.initialize(makeConfig(600));

    const chain = sandbox.getChainTimeoutMs();
    expect(chain).toBe(
      codeModeChainTimeoutMs({ escalationTimeoutMs: 600_000, backendCallTimeoutMs: DEFAULT_BACKEND_CALL_TIMEOUT_MS }),
    );
    // The old fixed 300 s chain timed out while a 600 s escalation still waited.
    expect(chain).toBeGreaterThan(600_000);
  });
});

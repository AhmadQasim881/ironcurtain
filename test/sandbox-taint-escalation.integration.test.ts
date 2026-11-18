/**
 * The user's `taintEscalation` setting reaches the coordinator a real
 * `Sandbox` builds (the path every Code Mode and Docker Agent Mode session
 * takes), and that coordinator replays the session's existing audit log, so
 * a resumed session that had read untrusted content starts tainted (WP-117).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sandbox } from '../src/sandbox/index.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ResolvedTaintEscalationConfig } from '../src/config/user-config.js';
import { testCompiledPolicy, testToolAnnotations, REAL_TMP } from './fixtures/test-policy.js';

const TEST_ROOT = `${REAL_TMP}/ironcurtain-sandbox-taint-${process.pid}`;
const GENERATED_DIR = `${TEST_ROOT}/generated`;
const SANDBOX_DIR = `${TEST_ROOT}/sandbox`;
const AUDIT_LOG = `${TEST_ROOT}/audit.jsonl`;

function makeConfig(
  taintEscalation?: ResolvedTaintEscalationConfig,
  overrides: Partial<IronCurtainConfig> = {},
): IronCurtainConfig {
  return {
    ...overrides,
    auditLogPath: overrides.auditLogPath ?? AUDIT_LOG,
    allowedDirectory: SANDBOX_DIR,
    // No backends: only the coordinator wiring is under test.
    mcpServers: {},
    protectedPaths: [],
    generatedDir: GENERATED_DIR,
    constitutionPath: resolve(TEST_ROOT, 'constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      escalationTimeoutSeconds: 300,
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      serverCredentials: {},
      ...(taintEscalation ? { taintEscalation } : {}),
    },
  } as unknown as IronCurtainConfig;
}

// No backends and no execute_code: initialize() creates no V8 isolate, so this
// file needs neither the isolated-vm gate nor the serialized vitest project.
describe('Sandbox taint escalation wiring', () => {
  let sandbox: Sandbox | undefined;

  beforeEach(() => {
    mkdirSync(SANDBOX_DIR, { recursive: true });
    mkdirSync(GENERATED_DIR, { recursive: true });
    writeFileSync(resolve(GENERATED_DIR, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(GENERATED_DIR, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));
    // An earlier run of this session read a web page.
    writeFileSync(
      AUDIT_LOG,
      JSON.stringify({
        timestamp: '2026-11-11T10:00:00.000Z',
        requestId: 'earlier-fetch',
        serverName: 'fetch',
        toolName: 'http_fetch',
        arguments: { url: 'https://news.example.com/' },
        policyDecision: { status: 'allow', rule: 'allow-fetch-get', reason: 'allowed' },
        result: { status: 'dispatching' },
        durationMs: 0,
      }) + '\n',
    );
  });

  afterEach(async () => {
    await sandbox?.shutdown();
    sandbox = undefined;
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('leaves taint escalation off when the user config does not enable it', async () => {
    sandbox = new Sandbox();
    await sandbox.initialize(makeConfig());

    expect(sandbox.getCoordinator()?.getTaintStatus()).toEqual({ enabled: false, taintedBy: undefined });
  });

  it('enables it from the user config and replays the session audit log', async () => {
    sandbox = new Sandbox();
    await sandbox.initialize(makeConfig({ enabled: true, tools: {} }));

    expect(sandbox.getCoordinator()?.getTaintStatus()).toEqual({
      enabled: true,
      taintedBy: { via: 'fetch/http_fetch', requestId: 'earlier-fetch', timestamp: '2026-11-11T10:00:00.000Z' },
    });
  });

  it('replays the earlier audit logs the config names (a resumed workflow bundle)', async () => {
    // A new bundle writes a new audit log; the earlier leg's log is the one
    // that read the web page.
    const newBundleLog = `${TEST_ROOT}/bundle-2/audit.jsonl`;
    sandbox = new Sandbox();
    await sandbox.initialize(
      makeConfig({ enabled: true, tools: {} }, { auditLogPath: newBundleLog, taintReplayAuditLogPaths: [AUDIT_LOG] }),
    );

    expect(sandbox.getCoordinator()?.getTaintStatus().taintedBy).toEqual({
      via: 'fetch/http_fetch',
      requestId: 'earlier-fetch',
      timestamp: '2026-11-11T10:00:00.000Z',
    });
  });
});

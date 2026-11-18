/**
 * An approval that arrives after its `execute_code` script ended is never
 * dispatched (WP-55, SES-6), through the full production path:
 *
 *   V8 isolate -> chain runner (per-call signal) -> UTCP client
 *     -> IronCurtain protocol (withToolCallOptions) -> ToolCallCoordinator
 *     -> escalation wait -> relay subprocess -> server-filesystem
 *
 * Before the fix the chain timed out and told the agent "Script execution
 * timeout" while the escalation kept waiting; a human who approved it later
 * still ran the write. Now the chain's end withdraws the escalation: an
 * in-process handler's signal aborts, a file-IPC request file is removed,
 * the call is audited as `cancelled`, and a late approval changes nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sandbox } from '../src/sandbox/index.js';
import type { EscalationPromptDetails, EscalationPromptFn } from '../src/trusted-process/tool-call-coordinator.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { isDispatchingAuditEntry } from '../src/types/audit.js';
import { testCompiledPolicy, testToolAnnotations, REAL_TMP } from './fixtures/test-policy.js';
import { isIsolatedVmAvailable } from './helpers/isolated-vm-available.js';
import { packagedFilesystemServer } from './helpers/filesystem-server.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TEST_ROOT = `${REAL_TMP}/ironcurtain-chain-cancel-${process.pid}`;
const SANDBOX_DIR = `${TEST_ROOT}/sandbox`;
const OUTSIDE_DIR = `${REAL_TMP}/ironcurtain-chain-cancel-outside-${process.pid}`;
const GENERATED_DIR = `${TEST_ROOT}/generated`;
const ESCALATION_DIR = `${TEST_ROOT}/escalations`;

function makeConfig(name: string, extra: Partial<IronCurtainConfig> = {}): IronCurtainConfig {
  const auditLogPath = `${TEST_ROOT}/audit-${name}.jsonl`;
  return {
    auditLogPath,
    allowedDirectory: SANDBOX_DIR,
    mcpServers: {
      filesystem: {
        description: 'Read, write, search, and manage files and directories',
        ...packagedFilesystemServer(SANDBOX_DIR),
        sandbox: false,
      },
    },
    protectedPaths: [resolve(projectRoot, 'src/config/constitution.md'), auditLogPath],
    generatedDir: GENERATED_DIR,
    constitutionPath: resolve(projectRoot, 'src/config/constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      escalationTimeoutSeconds: 300,
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      serverCredentials: {},
    },
    ...extra,
  } as unknown as IronCurtainConfig;
}

/** Outcome audit records (the write-ahead `dispatching` records are returned separately). */
function readAudit(path: string): { outcomes: Record<string, unknown>[]; dispatching: Record<string, unknown>[] } {
  const entries = existsSync(path)
    ? readFileSync(path, 'utf-8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
  return {
    outcomes: entries.filter((entry) => !isDispatchingAuditEntry(entry)),
    dispatching: entries.filter((entry) => isDispatchingAuditEntry(entry)),
  };
}

/** An in-process escalation handler the test answers by hand. */
function heldEscalation(): {
  onEscalation: EscalationPromptFn;
  entered: Promise<EscalationPromptDetails>;
  decide: (decision: 'approved' | 'denied') => void;
} {
  let enter: (details: EscalationPromptDetails) => void = () => {};
  let decide: (decision: 'approved' | 'denied') => void = () => {};
  const entered = new Promise<EscalationPromptDetails>((resolve) => {
    enter = resolve;
  });
  const decision = new Promise<{ decision: 'approved' | 'denied' }>((resolve) => {
    decide = (d) => {
      resolve({ decision: d });
    };
  });
  return {
    onEscalation: (_request, _reason, _context, _candidates, details) => {
      enter(details);
      return decision;
    },
    entered,
    decide: (d) => {
      decide(d);
    },
  };
}

function writeScript(target: string): string {
  return `return filesystem.write_file({ path: ${JSON.stringify(target)}, content: 'written after approval' });`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!isIsolatedVmAvailable())('execute_code cancellation reaches pending escalations', () => {
  const sandboxes: Sandbox[] = [];

  async function startSandbox(
    name: string,
    extra: Partial<IronCurtainConfig>,
    onEscalation?: EscalationPromptFn,
  ): Promise<{ sandbox: Sandbox; auditLogPath: string }> {
    const config = makeConfig(name, extra);
    const sandbox = new Sandbox();
    sandboxes.push(sandbox);
    await sandbox.initialize(config, onEscalation ? { onEscalation } : {});
    return { sandbox, auditLogPath: config.auditLogPath };
  }

  beforeAll(() => {
    mkdirSync(SANDBOX_DIR, { recursive: true });
    mkdirSync(OUTSIDE_DIR, { recursive: true });
    mkdirSync(GENERATED_DIR, { recursive: true });
    mkdirSync(ESCALATION_DIR, { recursive: true });
    writeFileSync(resolve(GENERATED_DIR, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(GENERATED_DIR, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));
  });

  afterAll(async () => {
    for (const sandbox of sandboxes.splice(0)) await sandbox.shutdown();
    rmSync(TEST_ROOT, { recursive: true, force: true });
    rmSync(OUTSIDE_DIR, { recursive: true, force: true });
  });

  it('control: an approval given while the script waits runs the write', async () => {
    const held = heldEscalation();
    const { sandbox } = await startSandbox('control', {}, held.onEscalation);
    const target = `${OUTSIDE_DIR}/approved-in-time.txt`;

    const run = sandbox.executeCode(writeScript(target), { timeoutMs: 20_000 });
    await held.entered;
    held.decide('approved');
    const { result, logs } = await run;

    expect(logs.join('\n')).not.toContain('Code execution failed');
    expect(result).not.toBeNull();
    expect(readFileSync(target, 'utf-8')).toBe('written after approval');
  }, 30_000);

  it('an in-process approval arriving after the script timed out is not dispatched', async () => {
    const held = heldEscalation();
    const { sandbox, auditLogPath } = await startSandbox('in-process', {}, held.onEscalation);
    const target = `${OUTSIDE_DIR}/late-in-process.txt`;

    const run = sandbox.executeCode(writeScript(target), { timeoutMs: 1_500 });
    const details = await held.entered;
    const { result, logs } = await run;

    expect(result).toBeNull();
    expect(logs.join('\n')).toContain('Script execution timeout');
    // The chain's end withdrew the escalation: the handler's signal aborted.
    expect(details.signal.aborted).toBe(true);
    expect(details.signal.reason).toMatchObject({ kind: 'cancelled' });

    // The human approves afterwards. Nothing happens.
    held.decide('approved');
    await sleep(500);
    expect(existsSync(target)).toBe(false);

    const { outcomes, dispatching } = readAudit(auditLogPath);
    const writes = outcomes.filter((entry) => entry.toolName === 'write_file');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ escalationResult: 'cancelled', result: { status: 'denied' } });
    expect(String((writes[0].result as { error?: string }).error)).toContain('timed out');
    expect(dispatching.filter((entry) => entry.toolName === 'write_file')).toEqual([]);
  }, 30_000);

  it('a file-IPC approval written after the script timed out is not dispatched', async () => {
    const { sandbox, auditLogPath } = await startSandbox('file-ipc', { escalationDir: ESCALATION_DIR });
    const target = `${OUTSIDE_DIR}/late-file-ipc.txt`;

    const run = sandbox.executeCode(writeScript(target), { timeoutMs: 1_500 });
    let requestFile: string | undefined;
    for (let i = 0; i < 200 && requestFile === undefined; i++) {
      requestFile = readdirSync(ESCALATION_DIR).find((f) => f.startsWith('request-'));
      if (requestFile === undefined) await sleep(10);
    }
    expect(requestFile).toBeDefined();

    const { result, logs } = await run;
    expect(result).toBeNull();
    expect(logs.join('\n')).toContain('Script execution timeout');
    // Withdrawn: the session side sees the request vanish and reports it expired.
    expect(readdirSync(ESCALATION_DIR).filter((f) => f.startsWith('request-'))).toEqual([]);

    // A late approval lands anyway.
    const escalationId = String(requestFile)
      .replace(/^request-/, '')
      .replace(/\.json$/, '');
    writeFileSync(resolve(ESCALATION_DIR, `response-${escalationId}.json`), JSON.stringify({ decision: 'approved' }));
    await sleep(1_200);
    expect(existsSync(target)).toBe(false);

    const { outcomes, dispatching } = readAudit(auditLogPath);
    const writes = outcomes.filter((entry) => entry.toolName === 'write_file');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ escalationResult: 'cancelled', result: { status: 'denied' } });
    expect(dispatching.filter((entry) => entry.toolName === 'write_file')).toEqual([]);
  }, 30_000);

  it('a cancelled script withdraws its pending escalation at once', async () => {
    const held = heldEscalation();
    const { sandbox } = await startSandbox('signal', {}, held.onEscalation);
    const target = `${OUTSIDE_DIR}/cancelled.txt`;
    const controller = new AbortController();

    const run = sandbox.executeCode(writeScript(target), { signal: controller.signal, timeoutMs: 60_000 });
    const details = await held.entered;
    const started = Date.now();
    controller.abort(new Error('Session has been closed'));
    const { result, logs } = await run;

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toBeNull();
    expect(logs.join('\n')).toContain('Script execution cancelled: Session has been closed');
    expect(details.signal.aborted).toBe(true);
    held.decide('approved');
    await sleep(300);
    expect(existsSync(target)).toBe(false);
  }, 30_000);
});

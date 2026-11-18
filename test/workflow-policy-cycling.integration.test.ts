/**
 * Integration test for the end-to-end policy hot-swap path used by the
 * workflow orchestrator.
 *
 * Stands up a real `CodeModeProxy`, binds the coordinator's HTTP control
 * server on a real UDS, and POSTs real `loadPolicy` requests over
 * HTTP/1.1. Verifies the swap landed by running the same `execute_code`
 * script before and after the RPC and asserting the decision flipped.
 *
 * Exercises Step 5 (Round 2) of the workflow-container-lifecycle design.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createCodeModeProxy, type DockerProxy } from '../src/docker/code-mode-proxy.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { CompiledPolicyFile, StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import { isDispatchingAuditEntry, type AuditEntry } from '../src/types/audit.js';
import { defaultLoadPolicyRpc } from '../src/workflow/orchestrator.js';
import { POLICY_LOAD_PATH } from '../src/trusted-process/control-server.js';
import type {
  EscalationPromptDetails,
  EscalationPromptFn,
  EscalationResult,
} from '../src/trusted-process/tool-call-coordinator.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import { getBundleAuditLogPath, getBundleControlSocketPath, getBundleRuntimeRoot } from '../src/config/paths.js';
import type { BundleId } from '../src/session/types.js';
import { testCompiledPolicy, testToolAnnotations, REAL_TMP } from './fixtures/test-policy.js';
import { UdsClientTransport } from './helpers/uds-client-transport.js';
import { isIsolatedVmAvailable } from './helpers/isolated-vm-available.js';
import { packagedFilesystemServer } from './helpers/filesystem-server.js';
import { testUserConfig } from './helpers/user-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const TEST_ROOT = `${REAL_TMP}/ironcurtain-wf-policy-test-${process.pid}`;
// The filesystem MCP server's allowed root. Broader than the policy
// sandbox so read targets can fall outside `allowedDirectory` and
// actually reach the compiled rules.
const WS_ROOT = `${TEST_ROOT}/ws`;
// Policy sandbox: tiny subdir so reads into DIR_A / DIR_B are
// explicitly outside sandbox containment and must be resolved by
// compiled rules.
const SANDBOX_DIR = `${WS_ROOT}/sandbox`;
const DIR_A = `${WS_ROOT}/dir-a`;
const DIR_B = `${WS_ROOT}/dir-b`;
const FILE_A = `${DIR_A}/file.txt`;
const FILE_B = `${DIR_B}/file.txt`;
// Persona-layout policy dirs: validatePolicyDir accepts only the exact
// compiled-policy directories under the IronCurtain home (TEST_ROOT here).
const POLICY_A_DIR = `${TEST_ROOT}/personas/policy-a/generated`;
const POLICY_B_DIR = `${TEST_ROOT}/personas/policy-b/generated`;
const GENERATED_DIR = `${TEST_ROOT}/generated`;
const MCP_SOCKET = `${REAL_TMP}/ironcurtain-wf-policy-mcp-${process.pid}.sock`;
// Synthetic workflow/bundle identifiers pin the audit log and control
// socket under the new per-bundle layout
// (`workflow-runs/<wfId>/containers/<bundleId>/audit.jsonl` and
// `~/.ironcurtain/run/<bundleId[0:12]>/ctrl.sock`). The test sets
// `IRONCURTAIN_HOME = TEST_ROOT` in beforeAll so the helpers resolve
// inside the test tree.
const WORKFLOW_ID = `wf-${process.pid}`;
const BUNDLE_ID = `bundle-${process.pid}` as unknown as BundleId;

/**
 * Writes a compiled-policy.json into `dir`. Tool annotations are not
 * shipped per-persona (they're globally retained by the coordinator)
 * so this file is all the hot-swap path actually reads.
 */
function writePolicyDir(dir: string, policy: CompiledPolicyFile): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'compiled-policy.json'), JSON.stringify(policy));
}

/**
 * Writes the initial generated-dir fixtures (both annotations and the
 * starting compiled policy). The proxy reads from here at start().
 */
function writeTestArtifacts(
  dir: string,
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: StoredToolAnnotationsFile,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'compiled-policy.json'), JSON.stringify(compiledPolicy));
  writeFileSync(resolve(dir, 'tool-annotations.json'), JSON.stringify(toolAnnotations));
}

/**
 * Reads an audit log file (JSONL) and returns parsed entries.
 * Returns [] if the file does not yet exist (not all test branches
 * produce both audit files).
 */
function readAuditLines(path: string): AuditEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  return (
    raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AuditEntry)
      // Outcome records only: every dispatched call is preceded by a
      // write-ahead `dispatching` record for the same request.
      .filter((entry) => !isDispatchingAuditEntry(entry))
  );
}

/** Finds the most recent audit entry whose `path` argument matches `file`. */
function findAudit(entries: AuditEntry[], file: string): AuditEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (fileFromArgs(entries[i]) === file) return entries[i];
  }
  return undefined;
}

/** Extracts the `path` argument from an audit entry's arguments block. */
function fileFromArgs(entry: AuditEntry): string | undefined {
  const p = entry.arguments.path;
  return typeof p === 'string' ? p : undefined;
}

async function withClient<T>(socketPath: string, name: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new UdsClientTransport(socketPath);
  const client = new Client({ name, version: '0.0.0' }, {});
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Builds a compiled policy whose single `read-path` allow rule is
 * scoped to `allowedDir`. Reads outside it fall through to the
 * `escalate-read-outside-permitted-areas` rule below. Everything else
 * mirrors `testCompiledPolicy` so the rest of the engine keeps working.
 */
function buildPolicyAllowingReadsWithin(allowedDir: string): CompiledPolicyFile {
  return {
    ...testCompiledPolicy,
    rules: [
      {
        name: 'allow-list-allowed-directories',
        description: 'Allow list_allowed_directories introspection.',
        principle: 'Least privilege',
        if: { server: ['filesystem'], tool: ['list_allowed_directories'] },
        then: 'allow',
        reason: 'No filesystem changes, no path arguments.',
      },
      {
        name: 'deny-delete-outside-permitted-areas',
        description: 'Deny delete-path ops outside sandbox.',
        principle: 'No destruction',
        if: { roles: ['delete-path'], server: ['filesystem'] },
        then: 'deny',
        reason: 'Deletes outside sandbox are forbidden.',
      },
      {
        name: 'escalate-write-outside-permitted-areas',
        description: 'Escalate write-path ops outside sandbox.',
        principle: 'Human oversight',
        if: { roles: ['write-path'], server: ['filesystem'] },
        then: 'escalate',
        reason: 'Writes outside sandbox require human approval.',
      },
      {
        name: 'allow-reads-within-allowed-dir',
        description: `Allow read-path within ${allowedDir}.`,
        principle: 'Least privilege',
        if: {
          paths: { roles: ['read-path'], within: allowedDir },
          server: ['filesystem'],
        },
        then: 'allow',
        reason: 'Reads within the persona-scoped directory are allowed.',
      },
      {
        name: 'escalate-read-outside-permitted-areas',
        description: 'Escalate read-path ops outside sandbox.',
        principle: 'Human oversight',
        if: { roles: ['read-path'], server: ['filesystem'] },
        then: 'escalate',
        reason: 'Reads outside sandbox require human approval.',
      },
    ],
  };
}

/**
 * POSTs a raw JSON body to the control socket at POLICY_LOAD_PATH and
 * resolves with `{status, body}`. Used by the malformed-request case
 * where the orchestrator's RPC helper (which only tolerates 2xx) would
 * throw before we can inspect the status.
 */
function rawPolicyLoadPost(socketPath: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveFn, rejectFn) => {
    const req = http.request(
      {
        socketPath,
        method: 'POST',
        path: POLICY_LOAD_PATH,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf-8'),
        },
        timeout: 5_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolveFn({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', rejectFn);
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', rejectFn);
    req.end(body);
  });
}

describe.skipIf(!isIsolatedVmAvailable())('loadPolicy over control socket — end-to-end policy swap', () => {
  let proxy: DockerProxy;
  // Computed lazily in beforeAll so the path helpers pick up
  // `IRONCURTAIN_HOME = TEST_ROOT` (set in the same hook). Resolving at
  // module-eval time would bind to the user's real ~/.ironcurtain.
  let auditPath: string;
  let controlSocket: string;

  const policyA = buildPolicyAllowingReadsWithin(DIR_A);
  const policyB = buildPolicyAllowingReadsWithin(DIR_B);

  // Audit log path is rebound in beforeAll once `IRONCURTAIN_HOME` is
  // overridden. We prefill a placeholder here so the const object shape
  // is stable; the actual path is written in via `config.auditLogPath = auditPath`.
  const config: IronCurtainConfig = {
    auditLogPath: '',
    allowedDirectory: SANDBOX_DIR,
    mcpServers: {
      filesystem: {
        description: 'Read, write, search, and manage files and directories',
        ...packagedFilesystemServer(WS_ROOT),
        sandbox: false,
      },
    },
    protectedPaths: [
      resolve(projectRoot, 'src/config/constitution.md'),
      resolve(projectRoot, 'src/config/generated'),
      resolve(projectRoot, 'src/config/mcp-servers.json'),
    ],
    generatedDir: GENERATED_DIR,
    constitutionPath: resolve(projectRoot, 'src/config/constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: testUserConfig(),
  };

  beforeAll(async () => {
    // Make POLICY_A_DIR / POLICY_B_DIR persona policy dirs of the home.
    // The coordinator's `loadPolicy` canonicalizes the incoming path and
    // accepts only the exact compiled-policy directories under
    // `$IRONCURTAIN_HOME` (or the package's bundled ones) — pointing the
    // home at the test's isolated TEST_ROOT satisfies the check without
    // leaking into the user's real `~/.ironcurtain`.
    process.env.IRONCURTAIN_HOME = TEST_ROOT;
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(SANDBOX_DIR, { recursive: true });
    mkdirSync(DIR_A, { recursive: true });
    mkdirSync(DIR_B, { recursive: true });
    writeFileSync(FILE_A, 'contents-of-file-a');
    writeFileSync(FILE_B, 'contents-of-file-b');

    // Resolve the per-bundle audit + control-socket paths under the
    // new workflow-run layout. The bundle directory must exist before
    // the coordinator opens the audit log, and the sockets directory
    // must exist before `bind(2)` is called on the control socket.
    auditPath = getBundleAuditLogPath(WORKFLOW_ID, BUNDLE_ID);
    controlSocket = getBundleControlSocketPath(BUNDLE_ID);
    mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 });
    mkdirSync(getBundleRuntimeRoot(BUNDLE_ID), { recursive: true, mode: 0o700 });
    config.auditLogPath = auditPath;

    // The proxy's initial policy is policyA. Write both the compiled
    // policy and annotations into the generated dir; the hot-swap path
    // only reads compiled-policy.json per-persona, but start-up uses
    // both.
    writeTestArtifacts(GENERATED_DIR, policyA, testToolAnnotations);
    writePolicyDir(POLICY_A_DIR, policyA);
    writePolicyDir(POLICY_B_DIR, policyB);

    proxy = createCodeModeProxy({
      socketPath: MCP_SOCKET,
      config,
      listenMode: 'uds',
    });
    await proxy.start();

    // Attach the control server. This is exactly what the
    // orchestrator's defaultStartWorkflowControlServer does.
    const swapTarget = proxy.getPolicySwapTarget();
    expect(swapTarget).not.toBeNull();
    if (!swapTarget) throw new Error('policy swap target unexpectedly null');
    await swapTarget.startControlServer({ socketPath: controlSocket });
  }, 30_000);

  afterAll(async () => {
    await proxy.stop();
    rmSync(TEST_ROOT, { recursive: true, force: true });
    rmSync(MCP_SOCKET, { force: true });
    rmSync(controlSocket, { force: true });
    delete process.env.IRONCURTAIN_HOME;
  });

  it('control server accepts loadPolicy and swaps the active policy', async () => {
    // The observable signal is the audit log: the policy engine records
    // its decision for every call regardless of whether the backend MCP
    // server later enforces its own filesystem boundary. Using audit
    // lines isolates the test to exactly the component under test
    // (policy evaluation) without coupling to unrelated MCP-server
    // root enforcement.
    //
    // Audit layout: one file for the entire run. Each entry is tagged
    // with the active `persona`, so we slice pre- vs post-swap entries
    // by that field. Before the first loadPolicy, the coordinator has
    // no current persona, so we explicitly fire a loadPolicy with
    // persona "policy-a" first; every entry under test therefore
    // carries a persona tag we can filter on.
    await defaultLoadPolicyRpc({
      socketPath: controlSocket,
      persona: 'policy-a',
      policyDir: POLICY_A_DIR,
    });

    // Pre-swap under policyA: FILE_A read → allow, FILE_B read → escalate
    // (then auto-denied because no escalation handler is wired).
    await withClient(MCP_SOCKET, 'pre-swap', async (client) => {
      await client.callTool({
        name: 'execute_code',
        arguments: { code: `return filesystem.read_file({ path: "${FILE_A}" });` },
      });
      await client.callTool({
        name: 'execute_code',
        arguments: { code: `return filesystem.read_file({ path: "${FILE_B}" });` },
      });
    });

    const preSwapEntries = readAuditLines(auditPath).filter((e) => e.persona === 'policy-a');
    const preA = findAudit(preSwapEntries, FILE_A);
    const preB = findAudit(preSwapEntries, FILE_B);
    // When no escalation handler is wired, the pipeline auto-denies
    // but the audit line records the original `escalate` decision
    // (the deny override only appears on the response, not the audit
    // entry). That's the observable signal.
    expect(preA?.policyDecision.status).toBe('allow');
    expect(preB?.policyDecision.status).toBe('escalate');

    // Hot-swap to policyB via the orchestrator's own default RPC
    // helper. This guarantees we exercise the exact wire format
    // production uses.
    await defaultLoadPolicyRpc({
      socketPath: controlSocket,
      persona: 'policy-b',
      policyDir: POLICY_B_DIR,
    });

    // Post-swap under policyB: decisions must flip.
    await withClient(MCP_SOCKET, 'post-swap', async (client) => {
      await client.callTool({
        name: 'execute_code',
        arguments: { code: `return filesystem.read_file({ path: "${FILE_A}" });` },
      });
      await client.callTool({
        name: 'execute_code',
        arguments: { code: `return filesystem.read_file({ path: "${FILE_B}" });` },
      });
    });

    // Single audit file for the whole run. The flipped decisions on
    // persona-tagged entries prove the engine was actually swapped.
    expect(existsSync(auditPath)).toBe(true);
    const allEntries = readAuditLines(auditPath);
    const postEntries = allEntries.filter((e) => e.persona === 'policy-b');
    const postA = findAudit(postEntries, FILE_A);
    const postB = findAudit(postEntries, FILE_B);
    expect(postA?.policyDecision.status).toBe('escalate');
    expect(postB?.policyDecision.status).toBe('allow');

    // Pre-swap entries are still present, unchanged, in the same file.
    // Post-swap entries did not retroactively change their persona.
    const preAfter = allEntries.filter((e) => e.persona === 'policy-a');
    expect(preAfter.length).toBe(preSwapEntries.length);
  });

  it('malformed loadPolicy request returns 400 without disturbing the running policy', async () => {
    // Missing policyDir -> 400. The server must not touch the live engine.
    const bad = await rawPolicyLoadPost(controlSocket, JSON.stringify({ persona: 'global' }));
    expect(bad.status).toBe(400);

    // Missing persona -> 400 as well.
    const bad2 = await rawPolicyLoadPost(controlSocket, JSON.stringify({ policyDir: POLICY_A_DIR }));
    expect(bad2.status).toBe(400);

    // Confirm policyB is still the active policy: FILE_A still escalates,
    // FILE_B still allows. Same single audit file.
    await withClient(MCP_SOCKET, 'post-400', async (client) => {
      await client.callTool({
        name: 'execute_code',
        arguments: { code: `return filesystem.read_file({ path: "${FILE_A}" });` },
      });
      await client.callTool({
        name: 'execute_code',
        arguments: { code: `return filesystem.read_file({ path: "${FILE_B}" });` },
      });
    });

    const audit = readAuditLines(auditPath);
    // Take the last two entries — those are the calls we just made.
    const lastTwo = audit.slice(-2);
    const lastA = lastTwo.find((e) => fileFromArgs(e) === FILE_A);
    const lastB = lastTwo.find((e) => fileFromArgs(e) === FILE_B);
    expect(lastA?.policyDecision.status).toBe('escalate');
    expect(lastA?.persona).toBe('policy-b');
    expect(lastB?.policyDecision.status).toBe('allow');
    expect(lastB?.persona).toBe('policy-b');
  });
});

// ---------------------------------------------------------------------------
// Escalations on a workflow bundle's proxy (WP-35: TPM-9, TPM-13).
//
// The orchestrator hands a shared-container bundle's proxy an in-process
// escalation handler (`CodeModeProxyOptions.onEscalation`, threaded through
// `Sandbox.initialize` into the coordinator). An escalated call then waits
// for that handler instead of being denied on the spot, and a policy
// hot-swap (`loadPolicy`) cancels a pending escalation at once -- denied and
// audited as `cancelled` under the old persona -- instead of waiting out the
// escalation timeout before it swaps.
// ---------------------------------------------------------------------------

describe.skipIf(!isIsolatedVmAvailable())('escalations on a workflow bundle proxy', () => {
  const ESC_ROOT = `${REAL_TMP}/ironcurtain-wf-esc-test-${process.pid}`;
  const ESC_WS = `${ESC_ROOT}/ws`;
  const ESC_SANDBOX = `${ESC_WS}/sandbox`;
  const ESC_DIR_A = `${ESC_WS}/dir-a`;
  const ESC_DIR_B = `${ESC_WS}/dir-b`;
  const ESC_FILE_B = `${ESC_DIR_B}/file.txt`;
  const ESC_POLICY_A = `${ESC_ROOT}/personas/policy-a/generated`;
  const ESC_POLICY_B = `${ESC_ROOT}/personas/policy-b/generated`;
  const ESC_GENERATED = `${ESC_ROOT}/generated`;
  const ESC_MCP_SOCKET = `${REAL_TMP}/ironcurtain-wf-esc-mcp-${process.pid}.sock`;
  const ESC_WORKFLOW_ID = `wf-esc-${process.pid}`;
  const ESC_BUNDLE_ID = `bundle-esc-${process.pid}` as unknown as BundleId;

  interface HeldEscalation {
    readonly request: ToolCallRequest;
    readonly details: EscalationPromptDetails;
    readonly settle: (result: EscalationResult) => void;
  }
  const held: HeldEscalation[] = [];
  const onEscalation: EscalationPromptFn = (request, _reason, _context, _candidates, details) =>
    new Promise<EscalationResult>((settle) => {
      held.push({ request, details, settle });
    });

  async function waitForHeld(count: number): Promise<HeldEscalation> {
    const deadline = Date.now() + 10_000;
    while (held.length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for escalation #${count}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return held[count - 1];
  }

  function readFileB(client: Client): Promise<unknown> {
    return client.callTool({
      name: 'execute_code',
      arguments: { code: `return filesystem.read_file({ path: "${ESC_FILE_B}" });` },
    });
  }

  let proxy: DockerProxy;
  let auditPath: string;
  let controlSocket: string;

  beforeAll(async () => {
    process.env.IRONCURTAIN_HOME = ESC_ROOT;
    for (const dir of [ESC_SANDBOX, ESC_DIR_A, ESC_DIR_B]) mkdirSync(dir, { recursive: true });
    writeFileSync(ESC_FILE_B, 'contents-of-file-b');
    auditPath = getBundleAuditLogPath(ESC_WORKFLOW_ID, ESC_BUNDLE_ID);
    controlSocket = getBundleControlSocketPath(ESC_BUNDLE_ID);
    mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 });
    mkdirSync(getBundleRuntimeRoot(ESC_BUNDLE_ID), { recursive: true, mode: 0o700 });

    const policyA = buildPolicyAllowingReadsWithin(ESC_DIR_A);
    writeTestArtifacts(ESC_GENERATED, policyA, testToolAnnotations);
    writePolicyDir(ESC_POLICY_A, policyA);
    writePolicyDir(ESC_POLICY_B, buildPolicyAllowingReadsWithin(ESC_DIR_B));

    const config: IronCurtainConfig = {
      auditLogPath: auditPath,
      allowedDirectory: ESC_SANDBOX,
      mcpServers: {
        filesystem: {
          description: 'Read, write, search, and manage files and directories',
          ...packagedFilesystemServer(ESC_WS),
          sandbox: false,
        },
      },
      protectedPaths: [resolve(projectRoot, 'src/config/constitution.md')],
      generatedDir: ESC_GENERATED,
      constitutionPath: resolve(projectRoot, 'src/config/constitution.md'),
      agentModelId: 'anthropic:claude-sonnet-4-6',
      // The real default: a policy swap must not have to wait this out.
      escalationTimeoutSeconds: 300,
      userConfig: testUserConfig(),
    };

    proxy = createCodeModeProxy({ socketPath: ESC_MCP_SOCKET, config, listenMode: 'uds', onEscalation });
    await proxy.start();
    const swapTarget = proxy.getPolicySwapTarget();
    if (!swapTarget) throw new Error('policy swap target unexpectedly null');
    await swapTarget.startControlServer({ socketPath: controlSocket });
    await defaultLoadPolicyRpc({ socketPath: controlSocket, persona: 'policy-a', policyDir: ESC_POLICY_A });
  }, 30_000);

  afterAll(async () => {
    for (const pending of held) pending.settle({ decision: 'denied' });
    await proxy.stop();
    rmSync(ESC_ROOT, { recursive: true, force: true });
    rmSync(ESC_MCP_SOCKET, { force: true });
    rmSync(controlSocket, { force: true });
    delete process.env.IRONCURTAIN_HOME;
  });

  it('waits for the in-process handler instead of denying, and runs the call once approved', async () => {
    await withClient(ESC_MCP_SOCKET, 'esc-approve', async (client) => {
      const call = readFileB(client);
      const escalation = await waitForHeld(1);
      expect(escalation.request).toMatchObject({ serverName: 'filesystem', toolName: 'read_file' });
      expect(escalation.request.arguments.path).toBe(ESC_FILE_B);
      expect(escalation.details.persona).toBe('policy-a');
      expect(escalation.details.signal.aborted).toBe(false);

      escalation.settle({ decision: 'approved' });
      const result = JSON.stringify(await call);
      expect(result).not.toContain('ESCALATION DENIED');
      expect(result).not.toContain('no escalation handler');
    });

    const entry = findAudit(
      readAuditLines(auditPath).filter((e) => e.persona === 'policy-a'),
      ESC_FILE_B,
    );
    expect(entry?.escalationResult).toBe('approved');
    expect(entry?.policyDecision.reason).toBe('Approved by human during escalation');
  });

  it('a policy hot-swap cancels a pending escalation promptly, then swaps', async () => {
    await withClient(ESC_MCP_SOCKET, 'esc-cancel', async (client) => {
      const call = readFileB(client);
      const escalation = await waitForHeld(2);

      const started = Date.now();
      await defaultLoadPolicyRpc({ socketPath: controlSocket, persona: 'policy-b', policyDir: ESC_POLICY_B });
      // Well under the 300 s escalation timeout the swap used to wait out.
      expect(Date.now() - started).toBeLessThan(5_000);

      const result = JSON.stringify(await call);
      expect(result).toContain('Escalation cancelled');
      expect(result).toContain('policy hot-swap to persona');
      expect(escalation.details.signal.aborted).toBe(true);
      expect(escalation.details.signal.reason).toMatchObject({ kind: 'cancelled' });

      // The new policy is live: the same read is now allowed outright.
      await readFileB(client);
    });
    expect(held).toHaveLength(2);

    const entries = readAuditLines(auditPath);
    const cancelled = entries.filter((e) => e.persona === 'policy-a' && e.escalationResult === 'cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].result.status).toBe('denied');
    const after = findAudit(
      entries.filter((e) => e.persona === 'policy-b'),
      ESC_FILE_B,
    );
    expect(after?.policyDecision.status).toBe('allow');
  });
});

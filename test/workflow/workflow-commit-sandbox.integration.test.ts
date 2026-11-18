/**
 * `workflow.commit(...)` from inside the real Code Mode sandbox (V8 isolate,
 * UTCP, the in-process IronCurtain protocol, the coordinator and its
 * pipeline) reaches the workflow commit channel. No backend MCP server is
 * configured, so nothing is spawned.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sandbox } from '../../src/sandbox/index.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import { WorkflowCommitChannel } from '../../src/workflow/workflow-commit.js';
import { WORKFLOW_COMMIT_SERVER_DESCRIPTION } from '../../src/trusted-process/workflow-commit-tool.js';
import { testCompiledPolicy, testToolAnnotations, REAL_TMP } from '../fixtures/test-policy.js';
import { isIsolatedVmAvailable } from '../helpers/isolated-vm-available.js';

const ROOT = `${REAL_TMP}/ironcurtain-commit-sandbox-${process.pid}`;

describe.skipIf(!isIsolatedVmAvailable())('workflow.commit in the Code Mode sandbox', () => {
  const channel = new WorkflowCommitChannel();
  let sandbox: Sandbox;

  beforeAll(async () => {
    const generatedDir = resolve(ROOT, 'generated');
    mkdirSync(resolve(ROOT, 'sandbox'), { recursive: true });
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(resolve(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));
    const config = {
      auditLogPath: resolve(ROOT, 'audit.jsonl'),
      allowedDirectory: resolve(ROOT, 'sandbox'),
      mcpServers: {},
      protectedPaths: [],
      generatedDir,
      constitutionPath: resolve(ROOT, 'constitution.md'),
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      userConfig: {
        autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
        auditRedaction: { enabled: false },
        serverCredentials: {},
      },
    } as unknown as IronCurtainConfig;

    sandbox = new Sandbox();
    await sandbox.initialize(config, { workflowCommit: channel });
  }, 30_000);

  afterAll(async () => {
    await sandbox.shutdown();
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('offers the tool under the workflow server, and attaches the channel', () => {
    expect(channel.isAttached).toBe(true);
    expect(sandbox.getHelpData().serverDescriptions).toEqual({ workflow: WORKFLOW_COMMIT_SERVER_DESCRIPTION });
    expect(sandbox.getToolInterfaces()).toContain('workflow.commit({ invocation, verdict })');
  });

  it('commits from agent code, and refuses a second commit inside the isolate', async () => {
    const invocation = channel.open({ stateId: 'review', validVerdicts: new Set(['approved', 'rejected']) });
    const { result } = await sandbox.executeCode(`
      const first = workflow.commit({ invocation: ${JSON.stringify(invocation.id)}, verdict: "approved", notes: "ok" });
      let second;
      try {
        workflow.commit({ invocation: ${JSON.stringify(invocation.id)}, verdict: "rejected" });
        second = "accepted";
      } catch (err) {
        second = String(err && err.message);
      }
      return { first, second };
    `);

    expect(invocation.committed()).toMatchObject({ verdict: 'approved', notes: 'ok' });
    expect(JSON.stringify(result)).toContain('Committed verdict');
    expect((result as { second: string }).second).toContain('already committed');
  });
});

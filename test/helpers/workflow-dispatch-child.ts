/**
 * Child-process runner for the workflow file-browser RPCs.
 *
 * `workflows.fileContent`, `workflows.artifacts` and `workflows.artifactFile`
 * read an agent-writable workspace. A regression in their special-file
 * handling (opening a FIFO or a device link without O_NONBLOCK, reading a
 * device without a bound) blocks the calling thread, and a test that blocks
 * freezes its vitest worker so its own timeout can never fire. The tests in
 * `test/workflow-file-dispatch.test.ts` therefore run those calls here, in a
 * process they spawn with a hard timeout: a hang becomes a killed child and a
 * clear assertion failure instead of a wedged test run.
 *
 * Invocation: `tsx workflow-dispatch-child.ts '<plan JSON>'` with a
 * {@link ChildPlan}. A `call` step dispatches one RPC against a fake workflow
 * manager whose only workflow lives at `plan.workspace`; `fifo` and `symlink`
 * steps replace a workspace entry between calls, which runs the
 * swap-after-listing race deterministically. The results of the `call` steps
 * are written to stdout as one JSON array of {@link ChildResult}.
 */

import { execFileSync } from 'node:child_process';
import { rmSync, symlinkSync } from 'node:fs';

import { workflowDispatch, type WorkflowDispatchContext } from '../../src/web-ui/dispatch/workflow-dispatch.js';
import { RpcError } from '../../src/web-ui/web-ui-types.js';
import type { WorkflowController } from '../../src/workflow/orchestrator.js';
import type { WorkflowManager } from '../../src/workflow/workflow-manager.js';

export type ChildStep =
  | { readonly type: 'call'; readonly method: string; readonly params: Record<string, unknown> }
  /** Replace the entry at `path` with a FIFO (`mkfifo`). */
  | { readonly type: 'fifo'; readonly path: string }
  /** Replace the entry at `path` with a symbolic link to `target`. */
  | { readonly type: 'symlink'; readonly path: string; readonly target: string };

export interface ChildPlan {
  readonly workspace: string;
  readonly steps: readonly ChildStep[];
}

export type ChildResult =
  | { readonly ok: true; readonly payload: unknown; readonly ms: number }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly ms: number };

function buildContext(workspace: string): WorkflowDispatchContext {
  const controller = {
    getDetail: () => ({ workspacePath: workspace }),
    getStatus: () => undefined,
    listActive: () => [],
  } as unknown as WorkflowController;
  const manager = {
    getOrchestrator: () => controller,
    getBaseDir: () => workspace,
    loadPastRun: () => ({ error: 'not_found' as const }),
  } as unknown as WorkflowManager;
  return {
    handler: {} as WorkflowDispatchContext['handler'],
    sessionManager: {} as WorkflowDispatchContext['sessionManager'],
    mode: { kind: 'builtin' },
    eventBus: {} as WorkflowDispatchContext['eventBus'],
    maxConcurrentWebSessions: 1,
    sessionQueues: new Map(),
    workflowManager: manager,
  };
}

async function run(plan: ChildPlan): Promise<ChildResult[]> {
  const ctx = buildContext(plan.workspace);
  const results: ChildResult[] = [];
  for (const step of plan.steps) {
    if (step.type === 'fifo') {
      rmSync(step.path, { force: true });
      execFileSync('mkfifo', [step.path]);
      continue;
    }
    if (step.type === 'symlink') {
      rmSync(step.path, { force: true });
      symlinkSync(step.target, step.path);
      continue;
    }
    const started = Date.now();
    try {
      const payload = await workflowDispatch(ctx, step.method, step.params);
      results.push({ ok: true, payload, ms: Date.now() - started });
    } catch (err) {
      results.push({
        ok: false,
        code: err instanceof RpcError ? err.code : 'THROWN',
        message: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      });
    }
  }
  return results;
}

const plan = JSON.parse(process.argv[2] ?? '{}') as ChildPlan;
run(plan).then(
  (results) => {
    process.stdout.write(JSON.stringify(results));
  },
  (err: unknown) => {
    process.stderr.write(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  },
);

/**
 * Operator documentation and agent guidance that restate what the code does.
 *
 * Each check ties a statement in DAEMON.md, CONFIG.md, the root CLAUDE.md,
 * src/persona/CLAUDE.md, src/docker/CLAUDE.md or the Docker broker design to
 * the code it describes: the constant it quotes, or the behaviour, run here
 * in a few lines. A docs edit that brings back a description these documents
 * once had (budgets "per session", cron escalations always auto-denied, a
 * Signal transport that "stopped" falling back to the web UI, an HMAC'd
 * policy-mutation log, `--allow-policy-mutation` gating personas alone,
 * `operation` as git_branch's discriminator), or a code change that makes a
 * statement false, fails here. The behaviour behind each statement is tested
 * in depth where it lives; each check names that test.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LATE_FIRE_GRACE_MS } from '../src/cron/cron-scheduler.js';
import { PREVIOUS_RUN_SUMMARY_FILE, RUN_SUMMARY_FILE, retireRunSummary } from '../src/cron/run-summary.js';
import { DOCKER_WORKLOAD_LEASE_SCHEMA_VERSION } from '../src/docker-workload/bundle-lease.js';
import { STALE_LOCK_MS } from '../src/persona/policy-mutation-audit.js';
import { ResourceBudgetTracker, STEP_SAFETY_CAP } from '../src/session/resource-budget-tracker.js';
import { SignalLockBusyError } from '../src/signal/signal-lock.js';
import { isBroadDomainPattern } from '../src/types/public-suffix.js';
import { configDispatch } from '../src/web-ui/dispatch/config-dispatch.js';
import type { WorkflowDispatchContext } from '../src/web-ui/dispatch/workflow-dispatch.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A repository document with whitespace runs collapsed, so a statement may wrap. */
function doc(path: string): string {
  return readFileSync(join(projectRoot, path), 'utf-8').replace(/\s+/g, ' ');
}

/** Asserts that `path` says `statement` (whitespace-insensitive); a failure names the statement, not the document. */
function expectSays(path: string, statement: string): void {
  expect(doc(path).includes(statement), `${path} should say: ${statement}`).toBe(true);
}

/** Asserts that `path` no longer says `statement` (a string, or a pattern). */
function expectNotSays(path: string, statement: string | RegExp): void {
  const text = doc(path);
  const found = typeof statement === 'string' ? text.includes(statement) : statement.test(text);
  expect(found, `${path} should not say: ${String(statement)}`).toBe(false);
}

/** The TypeScript sources under a repository directory, repository-relative. */
function typeScriptSources(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) files.push(relative(projectRoot, path));
    }
  };
  walk(join(projectRoot, dir));
  return files;
}

describe('resource budgets', () => {
  it('CONFIG.md and CLAUDE.md: builtin limits are per turn and reset when the agent returns control', () => {
    // A turn that used up the step budget leaves the next turn its whole
    // budget; the totals live on in `lastTurn` and `cumulative`
    // (test/resource-budget-tracker.test.ts covers every dimension).
    const tracker = new ResourceBudgetTracker(
      {
        maxTotalTokens: null,
        maxSteps: 1,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
        warnThresholdPercent: 80,
      },
      'anthropic:claude-sonnet-4-6',
    );
    tracker.startTurn();
    tracker.recordStep(undefined);
    expect(tracker.isExhausted()?.dimension).toBe('steps');
    tracker.endTurn();
    tracker.startTurn();
    expect(tracker.isExhausted()).toBeNull();
    expect(tracker.getSnapshot()).toMatchObject({
      stepCount: 0,
      lastTurn: { stepCount: 1 },
      cumulative: { stepCount: 1 },
    });

    expectSays(
      'CONFIG.md',
      '**Builtin agent (Code Mode):** every limit is per turn and resets when the agent returns control.',
    );
    expectSays('CONFIG.md', `a safety cap of ${STEP_SAFETY_CAP} steps per turn still applies`);
    expectSays('CONFIG.md', '`resourceBudget.modelPricing` overrides the price of a model');
    expectSays('CLAUDE.md', 'are **per turn**: they reset when the agent returns control');
    expectSays('CLAUDE.md', `\`STEP_SAFETY_CAP\` (${STEP_SAFETY_CAP})`);
    expectNotSays('CLAUDE.md', 'enforces per-session limits');
  });

  it('CONFIG.md and the broker design: only the builtin agent emits budget warnings', () => {
    // `budget_warning` diagnostics come from AgentSession alone: Docker
    // sessions report exhaustion (admission, the MITM budget gate, the turn
    // timeout) but never a threshold warning.
    expect(readFileSync(join(projectRoot, 'src/session/agent-session.ts'), 'utf-8')).toContain(
      "kind: 'budget_warning'",
    );
    const dockerSources = typeScriptSources('src/docker');
    expect(dockerSources.length).toBeGreaterThan(20);
    const dockerEmitters = dockerSources.filter((file) =>
      readFileSync(join(projectRoot, file), 'utf-8').includes('budget_warning'),
    );
    expect(dockerEmitters).toEqual([]);

    expectSays('CONFIG.md', 'Builtin agent: emit a warning when this percentage of a limit is consumed');
    expectSays('CONFIG.md', 'Docker sessions emit no budget warnings');
    const broker = 'docs/designs/docker-agent-broker.md';
    expectSays(broker, '| `budget_warning` | Yes in this design; **No** as implemented (2026-11) |');
    // Token usage is observed at the MITM proxy, so a turn's usage is not 0.
    expectSays(
      broker,
      "Docker sessions cannot observe token usage — the agent's LLM calls happen inside the container. (As implemented, the host does observe it",
    );
    expectSays(broker, "As implemented, `ConversationTurn.usage` carries the turn's proxy-observed tokens instead");
  });
});

describe('the daemon (DAEMON.md)', () => {
  it('a fire time reached more than LATE_FIRE_GRACE_MS late is a missed run', () => {
    // test/cron-scheduler-dst.test.ts and test/daemon-cron-scheduling.test.ts
    // cover the classification and cron.catchUpMissedRuns.
    const minutes = LATE_FIRE_GRACE_MS / 60_000;
    expect(Number.isInteger(minutes)).toBe(true);
    expectSays(
      'DAEMON.md',
      `A fire time the daemon reaches more than ${minutes} minutes late (the machine slept, or the daemon was blocked) counts as missed`,
    );
    expectSays(
      'CONFIG.md',
      `more than ${minutes} minutes late (the machine slept, or the daemon was blocked); otherwise such a run is skipped and logged`,
    );
  });

  it('cron escalations without Signal wait for a connected browser, and Signal approvals need the code', () => {
    // IronCurtainDaemon.handleCronEscalation; end to end in
    // test/daemon-cron-web-escalation.test.ts and test/ironcurtain-daemon.test.ts.
    expectNotSays('DAEMON.md', 'auto-denied');
    // The daemon drops its Signal transport only when run() rejects, which a
    // dropped connection never makes it do (test/signal/signal-bot-daemon.test.ts:
    // it reconnects, and only shutdown() ends run()). So "Without Signal" is
    // never a transport that started and later lost its connection.
    expectNotSays('DAEMON.md', 'failed to start or stopped');
    // A daemon that finds an `ironcurtain bot` holding the Signal lock starts
    // without the transport (test/signal-transport-lock.test.ts), so its cron
    // escalations take this path too; it prints the lock error that the
    // troubleshooting row quotes.
    expectSays(
      'DAEMON.md',
      '**Without Signal (not configured, `--no-signal`, an `ironcurtain bot` holding the Signal lock, or the Signal transport failed to start):**',
    );
    expect(new SignalLockBusyError('/home/user/.ironcurtain/signal.lock', 4242).message).toContain(
      'Process 4242 holds the IronCurtain Signal lock',
    );
    expectSays('DAEMON.md', '**"Signal transport not started: Process N holds the IronCurtain Signal lock"**');
    expectSays(
      'DAEMON.md',
      'Once the transport has started, it counts as running until the daemon stops, also while its connection is down (it keeps reconnecting)',
    );
    expectSays(
      'DAEMON.md',
      'A banner that still cannot be delivered after retries (for example while signal-cli is unreachable) denies the escalation.',
    );
    expectSays(
      'DAEMON.md',
      "When a browser has the daemon's web UI open as the escalation arrives, the escalation waits there for a decision for up to `escalationTimeoutSeconds`",
    );
    expectSays(
      'DAEMON.md',
      'When no browser is connected (a CLI client such as `observe` does not count), it is denied at once.',
    );
    expectSays('DAEMON.md', 'Escalations are denied at once, even while a browser has the web UI open.');
    expectSays('DAEMON.md', 'A bare `approve`, or `approve 2` without the code, is refused.');
  });

  it("the previous run's last-run.md is renamed previous-run.md before each run", () => {
    // retireRunSummary runs before every session (test/cron-run-summary.test.ts).
    const workspace = mkdtempSync(join(tmpdir(), 'ironcurtain-operator-docs-'));
    try {
      writeFileSync(join(workspace, RUN_SUMMARY_FILE), 'what the last run did');
      retireRunSummary(workspace);
      expect(existsSync(join(workspace, RUN_SUMMARY_FILE))).toBe(false);
      expect(readFileSync(join(workspace, PREVIOUS_RUN_SUMMARY_FILE), 'utf-8')).toBe('what the last run did');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }

    expectNotSays('DAEMON.md', 'Untracked files (including `last-run.md`) are preserved');
    expectSays(
      'DAEMON.md',
      "Untracked files are kept, except that the previous run's `last-run.md` is renamed `previous-run.md`.",
    );
    expectSays('DAEMON.md', 'Before every run the daemon moves the previous `last-run.md` to **`previous-run.md`**');
  });

  it('startup never compiles a policy; runs refuse a missing or stale one', () => {
    // IronCurtainDaemon.start() only reports such jobs; every run checks
    // (checkJobPolicy in src/cron/job-policy.ts).
    expectSays('DAEMON.md', 'It does not compile policies:');
    expectSays('DAEMON.md', 'The daemon never compiles by itself');
    expectNotSays('DAEMON.md', /compiles any missing per-job polic/);
    expectNotSays('DAEMON.md', 'Policy compilation happens automatically when the daemon starts');
    // checkJobPolicy takes no override (unattended runs never pass
    // allowStalePolicy to resolvePersona); test/job-policy-freshness.test.ts.
    expectSays(
      'DAEMON.md',
      'no override lets a job run with a stale policy: `--allow-stale-policy` is accepted only by an interactive `ironcurtain start`',
    );
    // A persona refused as too broad (POLICY_TOO_BROAD) is listed as NO POLICY.
    expectSays(
      'DAEMON.md',
      "A persona job also shows `NO POLICY` when the persona's policy grants broad access without its opt-in",
    );
  });

  it('--allow-policy-mutation also unlocks the Settings writes, which the policy-mutation log does not record', async () => {
    // Every config.set* method refuses before reading anything unless the
    // daemon runs with the flag (src/web-ui/dispatch/config-dispatch.ts;
    // per method in src/web-ui/__tests__/config-dispatch.test.ts and
    // test/workflow-resource-budget.test.ts).
    const methods = [
      ...readFileSync(join(projectRoot, 'src/web-ui/web-ui-types.ts'), 'utf-8').matchAll(/'(config\.set\w+)'/g),
    ].map((match) => match[1]);
    expect(methods).toEqual(
      expect.arrayContaining([
        'config.setResourceBudget',
        'config.setModelProviders',
        'config.setDockerWorkload',
        'config.setStatistics',
      ]),
    );
    const readOnly = { allowPolicyMutation: false } as WorkflowDispatchContext;
    for (const method of methods) {
      await expect(configDispatch(readOnly, method, {}), method).rejects.toMatchObject({
        code: 'POLICY_MUTATION_FORBIDDEN',
      });
    }
    // Settings go to config.json (saveUserConfig); only persona-service and
    // the persona compile path append to the policy-mutation log.
    const auditWriters = typeScriptSources('src').filter(
      (file) =>
        file !== 'src/persona/policy-mutation-audit.ts' &&
        readFileSync(join(projectRoot, file), 'utf-8').includes('policyMutationAuditLog'),
    );
    expect(auditWriters.sort()).toEqual(['src/persona/persona-compile-service.ts', 'src/persona/persona-service.ts']);

    expectSays('DAEMON.md', 'Allow the web UI to create/edit/compile/delete personas and to change its Settings');
    expectSays(
      'DAEMON.md',
      'Read-only unless the daemon is started with `--allow-policy-mutation`; changes are written to `config.json` and are not recorded in the policy-mutation log.',
    );
    expectSays('DAEMON.md', 'Every persona mutation is recorded in `~/.ironcurtain/audit/policy-mutation.jsonl`');
    expectSays(
      'CONFIG.md',
      'the web UI Settings page (when the daemon was started with `--allow-policy-mutation`; otherwise the page is read-only)',
    );
  });
});

describe('the policy-mutation log', () => {
  it('src/persona/CLAUDE.md and DAEMON.md describe the keyless chain and what it cannot detect', () => {
    // src/persona/policy-mutation-audit.ts; test/persona-policy-mutation-audit.test.ts
    // pins that a chain starting later in the oldest rotated file verifies.
    const guide = 'src/persona/CLAUDE.md';
    expectNotSays(guide, 'daemon-private');
    expectSays(guide, 'the chain is keyless');
    expectSays(guide, '`ironcurtain audit verify` (`verifyPolicyMutationLog`)');
    expectSays(guide, `older than \`STALE_LOCK_MS\`, ${STALE_LOCK_MS / 1000} s, is reclaimed`);
    expectSays(guide, 'look like rotation');

    expectSays('DAEMON.md', 'a hash chain with a persisted head that `ironcurtain audit verify` checks');
    expectSays('DAEMON.md', 'so it is evidence, not tamper-proofing');
    expectSays('DAEMON.md', 'removing its oldest records can look like rotation and go unreported');
  });
});

describe('agent guidance', () => {
  it('src/persona/CLAUDE.md: the compile seam and the breadth rules it names', () => {
    // The seam itself is pinned by test/persona-compile-paths.test.ts.
    const guide = 'src/persona/CLAUDE.md';
    expectSays(guide, 'Its only runtime caller is `runPersonaCompile` in `persona-compile-service.ts`');
    expectNotSays(guide, /label[- ]count/i);
    expectSays(guide, '`ruleDelta.escalateBreadth`');
    expectSays(guide, '(`POLICY_TOO_BROAD`)');
    // The examples it gives of broad and narrow wildcards.
    for (const pattern of ['*', '*.', '*.com', '*.co.uk', '*.github.io', '*.amazonaws.com']) {
      expect(isBroadDomainPattern(pattern), pattern).toBe(true);
    }
    expect(isBroadDomainPattern('*.github.com')).toBe(false);
    expectSays(
      guide,
      'so `*`, `*.`, `*.com`, `*.co.uk`, `*.github.io` and `*.amazonaws.com` are broad while `*.github.com` is not',
    );
  });

  it('src/docker/CLAUDE.md: new nested-Docker leases use the current schema version', () => {
    expectSays('src/docker/CLAUDE.md', `New leases are schema v${DOCKER_WORKLOAD_LEASE_SCHEMA_VERSION}`);
  });

  it('CLAUDE.md: the policy-validation recipe uses the discriminator the shipped git annotations key on', () => {
    interface ConditionalSpec {
      readonly when?: readonly { readonly condition: { readonly arg: string } }[];
    }
    interface StoredTool {
      readonly toolName: string;
      readonly args: Readonly<Record<string, unknown>>;
    }
    const annotations = JSON.parse(
      readFileSync(join(projectRoot, 'src/config/generated/tool-annotations.json'), 'utf-8'),
    ) as { servers: { git: { tools: readonly StoredTool[] } } };
    for (const name of ['git_branch', 'git_stash', 'git_remote', 'git_worktree', 'git_tag']) {
      const tool = annotations.servers.git.tools.find((candidate) => candidate.toolName === name);
      expect(tool, name).toBeDefined();
      const args = tool?.args ?? {};
      expect(Object.keys(args), name).toContain('mode');
      expect(Object.keys(args), name).not.toContain('operation');
      const pathConditions = ((args.path as ConditionalSpec | undefined)?.when ?? []).map((w) => w.condition.arg);
      expect(pathConditions, name).toContain('mode');
    }

    expectSays('CLAUDE.md', "toolName: 'git_branch', arguments: { path: '/some/repo', mode: 'list' }");
    expectNotSays('CLAUDE.md', "operation: 'list'");
    expectSays('CLAUDE.md', 'it is `mode` for all of these tools');
    expectSays(
      'CLAUDE.md',
      'a call using an argument the annotation does not list is denied (`unannotated-arguments`)',
    );
  });
});

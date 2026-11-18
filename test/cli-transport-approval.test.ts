/**
 * Builtin CLI approval commands (src/session/cli-transport.ts).
 *
 * In the interactive CLI the user answers an escalation by typing /approve,
 * /approve+ (approve and whitelist the pattern) or /deny while the agent's
 * turn is still in flight, waiting on that very escalation. Each command must
 * resolve the escalation the session reports as pending at that moment, with
 * exactly the decision typed; only /approve+ may pass a whitelist selection,
 * and /deny+ is a plain deny. With nothing pending the commands do nothing.
 * Several escalations can be pending at once (parallel tool calls): every
 * banner is shown, numbered, and a command without a number is refused
 * while more than one is pending; `/approve N` decides exactly #N.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import type {
  BudgetStatus,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
  Session,
  SessionInfo,
} from '../src/session/types.js';
import type { CliTransport as CliTransportType } from '../src/session/cli-transport.js';
import { DEFAULT_WHITELIST_OPTIONS } from '../src/trusted-process/approval-whitelist.js';
import { EscalationExpiredError } from '../src/types/errors.js';

const ESCALATION: EscalationRequest = {
  escalationId: 'esc-cli-1',
  serverName: 'filesystem',
  toolName: 'write_file',
  arguments: { path: '/etc/hosts', content: '127.0.0.1 example.com' },
  reason: 'Writes outside the sandbox',
  whitelistCandidates: [{ description: 'Allow write_file within /etc' }],
};

function budgetStatus(): BudgetStatus {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    stepCount: 0,
    elapsedSeconds: 0,
    estimatedCostUsd: 0,
    limits: {
      maxTotalTokens: null,
      maxSteps: null,
      maxSessionSeconds: null,
      maxEstimatedCostUsd: null,
      warnThresholdPercent: 80,
    },
    lastTurn: null,
    cumulative: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
      activeSeconds: 0,
      estimatedCostUsd: 0,
    },
    tokenTrackingAvailable: false,
  };
}

interface Turn {
  /** Finishes the in-flight turn with the agent's answer. */
  finish(answer: string): void;
}

/**
 * A session whose turns stay in flight until the test finishes them, and
 * whose pending escalations the test sets, like an agent blocked on approval.
 */
function blockedSession() {
  let pending: EscalationRequest[] = [];
  const turns: Turn[] = [];
  const resolveEscalation = vi.fn<Session['resolveEscalation']>().mockResolvedValue(undefined);
  const sendMessage = vi.fn<Session['sendMessage']>(
    () =>
      new Promise<string>((resolve) => {
        turns.push({ finish: resolve });
      }),
  );
  const session: Session = {
    getInfo: () =>
      ({ id: 'cli-approval', status: 'ready', turnCount: 0, createdAt: new Date().toISOString() }) as SessionInfo,
    sendMessage,
    getHistory: () => [] as readonly ConversationTurn[],
    getDiagnosticLog: () => [] as readonly DiagnosticEvent[],
    resolveEscalation,
    getPendingEscalations: () => pending,
    getBudgetStatus: () => budgetStatus(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    session,
    sendMessage,
    resolveEscalation,
    turns,
    setPending(...requests: EscalationRequest[]): void {
      pending = requests;
    },
  };
}

/** Lets readline deliver a line and the command's promise chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('CliTransport approval commands', () => {
  let CliTransport: typeof CliTransportType;
  let input: PassThrough;
  let transport: CliTransportType | undefined;
  let run: Promise<void> | undefined;
  let stderr: MockInstance<typeof process.stderr.write>;
  let stdout: MockInstance<typeof process.stdout.write>;
  let home: string;
  let previousHome: string | undefined;

  /** Everything written to the terminal's stderr so far, without styling. */
  const terminal = (): string =>
    stripVTControlCharacters(stderr.mock.calls.map(([chunk]) => (typeof chunk === 'string' ? chunk : '')).join(''));

  beforeEach(async () => {
    // run() writes the interaction log under the IronCurtain home.
    previousHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-cli-approval-'));
    process.env.IRONCURTAIN_HOME = home;
    // Imported here: the module configures marked at load time.
    ({ CliTransport } = await import('../src/session/cli-transport.js'));
    input = new PassThrough();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    transport?.close();
    await run;
    transport = undefined;
    run = undefined;
    stderr.mockRestore();
    stdout.mockRestore();
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** Starts an interactive session and a turn that blocks on `escalation`. */
  async function turnBlockedOn(escalation: EscalationRequest | undefined): Promise<ReturnType<typeof blockedSession>> {
    const s = blockedSession();
    const cli = new CliTransport({ input });
    transport = cli;
    run = cli.run(s.session);
    await settle();

    input.write('update the hosts file\n');
    await settle();
    expect(s.sendMessage).toHaveBeenCalledWith('update the hosts file');

    if (escalation) {
      s.setPending(escalation);
      cli.createEscalationHandler()(escalation);
    }
    return s;
  }

  it('shows the escalation and the commands that answer it', async () => {
    await turnBlockedOn(ESCALATION);

    const shown = terminal();
    expect(shown).toContain('ESCALATION #1: Human approval required');
    expect(shown).toContain('Tool:      filesystem/write_file');
    expect(shown).toContain('"path": "/etc/hosts"');
    expect(shown).toContain('Reason:    Writes outside the sandbox');
    expect(shown).toContain('Allow write_file within /etc');
    expect(shown).toContain('Type /approve 1, /approve+ 1 (approve & whitelist), or /deny 1');
  });

  it('/approve approves the pending escalation once, while the turn is still in flight', async () => {
    const s = await turnBlockedOn(ESCALATION);

    input.write('/approve\n');
    await settle();

    expect(s.resolveEscalation.mock.calls).toEqual([['esc-cli-1', 'approved', undefined]]);
    expect(terminal()).toContain('Escalation #1 approved.');
    expect(terminal()).not.toContain('Whitelisted:');
    // The command was not sent to the agent as a message.
    expect(s.sendMessage).toHaveBeenCalledTimes(1);

    s.turns[0].finish('Hosts file updated.');
    await settle();
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('Hosts file updated.');
  });

  it('/approve+ approves with the default whitelist selection and names the pattern', async () => {
    const s = await turnBlockedOn(ESCALATION);

    input.write('/approve+\n');
    await settle();

    expect(s.resolveEscalation.mock.calls).toEqual([['esc-cli-1', 'approved', DEFAULT_WHITELIST_OPTIONS]]);
    expect(DEFAULT_WHITELIST_OPTIONS).toEqual({ whitelistSelection: 0 });
    expect(terminal()).toContain('Escalation #1 approved.');
    expect(terminal()).toContain('Whitelisted: Allow write_file within /etc');
  });

  it('/deny denies the pending escalation', async () => {
    const s = await turnBlockedOn(ESCALATION);

    input.write('/deny\n');
    await settle();

    expect(s.resolveEscalation.mock.calls).toEqual([['esc-cli-1', 'denied', undefined]]);
    expect(terminal()).toContain('Escalation #1 denied.');
  });

  it('/deny+ is a plain deny: a denial is never whitelisted', async () => {
    const s = await turnBlockedOn(ESCALATION);

    input.write('/deny+\n');
    await settle();

    expect(s.resolveEscalation.mock.calls).toEqual([['esc-cli-1', 'denied', undefined]]);
    expect(terminal()).not.toContain('Whitelisted:');
  });

  it('answers the escalation pending when the command is typed, not one shown earlier', async () => {
    const s = await turnBlockedOn(ESCALATION);
    const transportUnderTest = transport;
    if (!transportUnderTest) throw new Error('transport not started');

    // The first request timed out in the proxy; the agent retried and escalated again.
    s.setPending();
    transportUnderTest.createEscalationExpiredHandler()('esc-cli-1');
    const retry: EscalationRequest = { ...ESCALATION, escalationId: 'esc-cli-2', arguments: { path: '/etc/passwd' } };
    s.setPending(retry);
    transportUnderTest.createEscalationHandler()(retry);
    expect(terminal()).toContain('Escalation #1 expired (timed out).');
    expect(terminal()).toContain('ESCALATION #2: Human approval required');

    input.write('/approve\n');
    await settle();

    expect(s.resolveEscalation.mock.calls).toEqual([['esc-cli-2', 'approved', undefined]]);
  });

  it('with nothing pending, the commands resolve nothing', async () => {
    const s = await turnBlockedOn(undefined);

    for (const command of ['/approve', '/approve+', '/approve+dir', '/deny']) {
      input.write(`${command}\n`);
      await settle();
    }

    expect(s.resolveEscalation).not.toHaveBeenCalled();
    expect(terminal().match(/No escalation pending\./g)).toHaveLength(4);
    expect(s.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reports a resolution the session rejects', async () => {
    const s = await turnBlockedOn(ESCALATION);
    s.resolveEscalation.mockRejectedValueOnce(new Error('No pending escalation with ID: esc-cli-1'));

    input.write('/approve\n');
    await settle();

    expect(terminal()).toContain('Error: No pending escalation with ID: esc-cli-1');
    expect(terminal()).not.toContain('approved.');
  });

  it('reports a decision that came after the proxy timed the escalation out as expired, never as applied', async () => {
    const s = await turnBlockedOn(ESCALATION);
    s.resolveEscalation.mockRejectedValueOnce(new EscalationExpiredError('esc-cli-1'));

    input.write('/approve\n');
    await settle();

    expect(terminal()).toContain('Escalation #1 had already expired (timed out); the tool call was denied.');
    expect(terminal()).not.toContain('approved.');
    expect(terminal()).not.toContain('Still pending');
  });

  it('a message typed while the turn waits for approval is held back, not sent', async () => {
    const s = await turnBlockedOn(ESCALATION);

    input.write('also fix the DNS\n');
    await settle();

    expect(s.sendMessage).toHaveBeenCalledTimes(1);
    expect(terminal()).toContain('(still processing previous message, please wait)');
    expect(s.resolveEscalation).not.toHaveBeenCalled();
  });
  describe('several pending escalations', () => {
    const SECOND: EscalationRequest = {
      ...ESCALATION,
      escalationId: 'esc-cli-2',
      serverName: 'git',
      toolName: 'git_push',
      arguments: { path: '/workspace' },
    };

    /** A turn blocked on two escalations raised by parallel tool calls. */
    async function turnBlockedOnTwo(): Promise<ReturnType<typeof blockedSession>> {
      const s = await turnBlockedOn(ESCALATION);
      const cli = transport;
      if (!cli) throw new Error('transport not started');
      s.setPending(ESCALATION, SECOND);
      cli.createEscalationHandler()(SECOND);
      return s;
    }

    it('shows both banners, each numbered', async () => {
      await turnBlockedOnTwo();

      const shown = terminal();
      expect(shown).toContain('ESCALATION #1: Human approval required');
      expect(shown).toContain('ESCALATION #2: Human approval required');
      expect(shown).toContain('Tool:      git/git_push');
      expect(shown).toContain('Type /approve 2, /approve+ 2 (approve & whitelist), or /deny 2');
    });

    it('a command without a number decides nothing and lists what is pending', async () => {
      const s = await turnBlockedOnTwo();

      for (const command of ['/approve', '/approve+', '/deny']) {
        input.write(`${command}\n`);
        await settle();
      }

      expect(s.resolveEscalation).not.toHaveBeenCalled();
      expect(terminal()).toContain('2 escalations are pending (#1 filesystem/write_file, #2 git/git_push)');
      // Never sent to the agent either.
      expect(s.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('/approve N and /deny N decide exactly that escalation; the other stays pending', async () => {
      const s = await turnBlockedOnTwo();

      input.write('/approve 2\n');
      await settle();
      expect(s.resolveEscalation.mock.calls).toEqual([['esc-cli-2', 'approved', undefined]]);
      expect(terminal()).toContain('Escalation #2 approved.');
      expect(terminal()).toContain('Still pending: #1.');

      s.setPending(ESCALATION);
      input.write('/deny #1\n');
      await settle();
      expect(s.resolveEscalation.mock.calls).toEqual([
        ['esc-cli-2', 'approved', undefined],
        ['esc-cli-1', 'denied', undefined],
      ]);
      expect(terminal()).toContain('Escalation #1 denied.');
    });

    it('a number that is not pending, or a malformed argument, decides nothing', async () => {
      const s = await turnBlockedOnTwo();

      input.write('/approve 7\n');
      await settle();
      input.write('/approve all\n');
      await settle();

      expect(s.resolveEscalation).not.toHaveBeenCalled();
      expect(terminal()).toContain('No pending escalation #7.');
      expect(terminal()).toContain("Usage: /approve [N], where N is the escalation's number from its banner.");
      expect(s.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('one expiring leaves the other pending and decidable without a number', async () => {
      const s = await turnBlockedOnTwo();
      const cli = transport;
      if (!cli) throw new Error('transport not started');

      s.setPending(SECOND);
      cli.createEscalationExpiredHandler()('esc-cli-1');
      expect(terminal()).toContain('Escalation #1 expired (timed out).');
      expect(terminal()).toContain('Still pending: #2.');

      input.write('/approve\n');
      await settle();
      expect(s.resolveEscalation.mock.calls).toEqual([['esc-cli-2', 'approved', undefined]]);
    });
  });
});

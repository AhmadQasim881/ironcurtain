/**
 * The builtin CLI's escalation commands: `/approve+` whitelists the exact
 * pattern (the first candidate), `/approve+dir` the directory-wide one, and
 * `/approve+dir` decides nothing when the escalation offers none.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import type { BudgetStatus, EscalationRequest, Session } from '../src/session/types.js';
import { CliTransport, escalationCommandOutcome } from '../src/session/cli-transport.js';

const EXACT = {
  description: 'Allow filesystem/read_text_file read-path /home/user/notes/a.txt',
  scope: 'exact',
} as const;
const DIRECTORY = {
  description: 'Allow filesystem/read_text_file read-path within /home/user/notes (recursive)',
  scope: 'directory',
} as const;

function pending(whitelistCandidates?: EscalationRequest['whitelistCandidates']): EscalationRequest {
  return {
    escalationId: 'esc-1',
    serverName: 'filesystem',
    toolName: 'read_text_file',
    arguments: { path: '/home/user/notes/a.txt' },
    reason: 'Reads outside the sandbox require approval',
    ...(whitelistCandidates ? { whitelistCandidates } : {}),
  };
}

describe('escalationCommandOutcome', () => {
  it('maps /approve, /deny and /deny+ to plain decisions', () => {
    const request = pending([EXACT, DIRECTORY]);
    expect(escalationCommandOutcome('/approve', request)).toEqual({ kind: 'resolve', decision: 'approved' });
    expect(escalationCommandOutcome('/deny', request)).toEqual({ kind: 'resolve', decision: 'denied' });
    expect(escalationCommandOutcome('/deny+', request)).toEqual({ kind: 'resolve', decision: 'denied' });
    // Anything else decides nothing.
    expect(escalationCommandOutcome('/approve++', request)).toMatchObject({ kind: 'refused' });
  });

  it('/approve+ whitelists the exact pattern, /approve+dir the directory-wide one', () => {
    const request = pending([EXACT, DIRECTORY]);
    expect(escalationCommandOutcome('/approve+', request)).toEqual({
      kind: 'resolve',
      decision: 'approved',
      options: { whitelistSelection: 0 },
      whitelisted: EXACT,
    });
    expect(escalationCommandOutcome('/approve+dir', request)).toEqual({
      kind: 'resolve',
      decision: 'approved',
      options: { whitelistSelection: 1 },
      whitelisted: DIRECTORY,
    });
  });

  it('/approve+dir decides nothing when no directory-wide pattern is offered', () => {
    for (const request of [pending([EXACT]), pending()]) {
      expect(escalationCommandOutcome('/approve+dir', request)).toMatchObject({
        kind: 'refused',
        message: expect.stringContaining('offers no directory-wide whitelist pattern') as unknown,
      });
    }
  });
});

const BUDGET: BudgetStatus = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  stepCount: 0,
  elapsedSeconds: 0,
  estimatedCostUsd: 0,
  limits: {
    maxTotalTokens: 1_000_000,
    maxSteps: 200,
    maxSessionSeconds: 1800,
    maxEstimatedCostUsd: 5,
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

describe('CliTransport escalation commands', () => {
  let transport: CliTransport | undefined;

  afterEach(() => {
    transport?.close();
    vi.restoreAllMocks();
  });

  function session(request: EscalationRequest): Session {
    return {
      getInfo: () => ({ id: 'test', status: 'ready', turnCount: 0, createdAt: new Date().toISOString() }),
      sendMessage: vi.fn().mockResolvedValue('response'),
      getHistory: () => [],
      getDiagnosticLog: () => [],
      resolveEscalation: vi.fn().mockResolvedValue(undefined),
      getPendingEscalations: () => [request],
      getBudgetStatus: () => BUDGET,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
  }

  /** Types `line` into an interactive CliTransport; returns what it wrote to stderr. */
  async function type(s: Session, line: string): Promise<string> {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const input = new PassThrough();
    transport = new CliTransport({ input });
    const running = transport.run(s);
    await new Promise((r) => setImmediate(r));
    input.write(`${line}\n`);
    await vi.waitFor(() => {
      expect(written.join('')).toMatch(/Escalation #\d+ approved|offers no directory-wide/u);
    });
    transport.close();
    transport = undefined;
    await running;
    return stripVTControlCharacters(written.join(''));
  }

  it('/approve+dir sends the directory-wide candidate index', async () => {
    const s = session(pending([EXACT, DIRECTORY]));
    const output = await type(s, '/approve+dir');
    expect(s.resolveEscalation).toHaveBeenCalledWith('esc-1', 'approved', { whitelistSelection: 1 });
    expect(output).toContain(`Whitelisted: ${DIRECTORY.description}`);
  });

  it('/approve+ sends the exact candidate index', async () => {
    const s = session(pending([EXACT, DIRECTORY]));
    const output = await type(s, '/approve+');
    expect(s.resolveEscalation).toHaveBeenCalledWith('esc-1', 'approved', { whitelistSelection: 0 });
    expect(output).toContain(`Whitelisted: ${EXACT.description}`);
  });

  it('/approve+dir leaves an escalation without a directory-wide pattern pending', async () => {
    const s = session(pending([EXACT]));
    const output = await type(s, '/approve+dir');
    expect(s.resolveEscalation).not.toHaveBeenCalled();
    expect(output).toContain('offers no directory-wide whitelist pattern');
  });
});

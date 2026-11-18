/**
 * Escalation listener commands: bulk approval, human-only escalations, and
 * the display numbers that /approve N and /deny N name.
 *
 * "/approve all" approves only with the code of the set it listed, so a
 * request that arrived after the list was shown is never approved unseen.
 * A human-only escalation (`EscalationRequest.humanOnly`, e.g. add_proxy_domain
 * opening a passthrough tunnel) must be approved individually: "approve all"
 * leaves it pending, and "/approve+" approves it once without whitelisting.
 * "/approve+ N" whitelists an escalation's exact pattern; "/approve+dir N"
 * its directory-wide one, which is never chosen in bulk.
 * A number names one escalation for good: while other requests keep arriving
 * from several sessions, /approve N resolves exactly the escalation shown as
 * #N, through the watcher of the session that raised it, and a number that
 * was resolved, expired or whose session ended is never reused.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  buildDashboard,
  bulkApprovalCode,
  createWatcherForSession,
  handleCommand,
} from '../src/escalation/listener-command.js';
import {
  addEscalation,
  addSession,
  createInitialState,
  expireEscalation,
  removeSession,
  type ListenerState,
} from '../src/escalation/listener-state.js';
import type { EscalationWatcher } from '../src/escalation/escalation-watcher.js';
import type { PtySessionRegistration } from '../src/docker/pty-types.js';
import type { EscalationRequest } from '../src/session/types.js';

interface Resolution {
  readonly escalationId: string;
  readonly decision: 'approved' | 'denied';
  readonly options?: { whitelistSelection?: number };
}

function recordingWatcher(resolutions: Resolution[]): EscalationWatcher {
  return {
    start() {},
    stop() {},
    getPending() {
      return [];
    },
    resolve(escalationId, decision, options) {
      resolutions.push({ escalationId, decision, ...(options !== undefined ? { options } : {}) });
      return true;
    },
  };
}

function request(escalationId: string, humanOnly: boolean): EscalationRequest {
  if (humanOnly) {
    return {
      escalationId,
      serverName: 'proxy',
      toolName: 'add_proxy_domain',
      arguments: { domain: 'api.example.com' },
      reason: 'Test escalation',
      humanOnly: true,
    };
  }
  return {
    escalationId,
    serverName: 'filesystem',
    toolName: 'write_file',
    arguments: { path: '/etc/app.conf' },
    reason: 'Test escalation',
    whitelistCandidates: [{ description: 'Allow write_file within /etc' }],
  };
}

/** One session with an ordinary escalation (#1) and a human-only one (#2). */
function stateWithPair(resolutions: Resolution[]): ListenerState {
  let state = addSession(
    createInitialState(),
    {
      sessionId: 'session-1',
      escalationDir: '/tmp/ic-listener-test/escalations',
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    },
    recordingWatcher(resolutions),
  );
  state = addEscalation(state, 'session-1', request('esc-plain', false));
  state = addEscalation(state, 'session-1', request('esc-human', true));
  return state;
}

function text(message: string | undefined): string {
  return stripVTControlCharacters(message ?? '');
}

describe('escalation listener: approve all needs the code of the listed set', () => {
  it('"/approve all" alone approves nothing: it lists every pending escalation and the code', () => {
    const resolutions: Resolution[] = [];
    const state = stateWithPair(resolutions);
    const result = handleCommand('/approve all', state);

    expect(resolutions).toEqual([]);
    expect(result.state.pendingEscalations.size).toBe(2);
    const listing = text(result.message);
    expect(listing).toContain('/approve all would approve 1 of 2 pending escalations:');
    expect(listing).toContain('[1] Session #1  filesystem/write_file');
    expect(listing).toContain('path: "/etc/app.conf"');
    expect(listing).toContain('[2] Session #1  proxy/add_proxy_domain');
    expect(listing).toContain('domain: "api.example.com"');
    expect(listing).toContain('human-only: stays pending; approve it on its own with /approve 2');
    expect(listing).toContain(`To approve exactly these, type: /approve all ${bulkApprovalCode(state, false)}`);
  });

  it('"/approve+ all" lists the pattern each escalation would whitelist', () => {
    const state = stateWithPair([]);
    const listing = text(handleCommand('/approve+ all', state).message);
    expect(listing).toContain('Whitelist: Allow write_file within /etc');
    expect(listing).toContain(`/approve+ all ${bulkApprovalCode(state, true)}`);
  });

  it('the code approves the listed set and leaves a human-only escalation pending', () => {
    const resolutions: Resolution[] = [];
    const state = stateWithPair(resolutions);
    const result = handleCommand(`/approve all ${bulkApprovalCode(state, false)}`, state);

    expect(resolutions).toEqual([{ escalationId: 'esc-plain', decision: 'approved' }]);
    expect(text(result.message)).toContain('Escalation #1 APPROVED');
    expect(text(result.message)).toContain('Escalation #2 requires individual approval (/approve 2)');
    expect([...result.state.pendingEscalations.keys()]).toEqual([2]);
  });

  it('"/approve+ all <code>" whitelists the ordinary escalation only and still skips the human-only one', () => {
    const resolutions: Resolution[] = [];
    const state = stateWithPair(resolutions);
    const result = handleCommand(`/approve+ all ${bulkApprovalCode(state, true)}`, state);

    expect(resolutions).toEqual([
      { escalationId: 'esc-plain', decision: 'approved', options: { whitelistSelection: 0 } },
    ]);
    expect([...result.state.pendingEscalations.keys()]).toEqual([2]);
  });

  it('approve-all after a new arrival is refused and lists the new set', () => {
    const resolutions: Resolution[] = [];
    const listed = stateWithPair(resolutions);
    const code = bulkApprovalCode(listed, false);
    const changed = addEscalation(listed, 'session-1', request('esc-late', false));

    const result = handleCommand(`/approve all ${code}`, changed);

    expect(resolutions).toEqual([]);
    expect(result.state.pendingEscalations.size).toBe(3);
    const message = text(result.message);
    expect(message).toContain('Nothing was approved: the pending escalations changed since they were listed');
    expect(message).toContain(`/approve all ${bulkApprovalCode(changed, false)}`);
    expect(bulkApprovalCode(changed, false)).not.toBe(code);
  });

  it('the code of "/approve all" does not approve "/approve+ all", and a wrong code is refused', () => {
    const resolutions: Resolution[] = [];
    const state = stateWithPair(resolutions);
    handleCommand(`/approve+ all ${bulkApprovalCode(state, false)}`, state);
    handleCommand('/approve all 000000', state);
    expect(resolutions).toEqual([]);
  });
});

describe('escalation listener: human-only escalations', () => {
  it('"/deny all" denies a human-only escalation like any other', () => {
    const resolutions: Resolution[] = [];
    const result = handleCommand('/deny all', stateWithPair(resolutions));

    expect(resolutions.map((r) => [r.escalationId, r.decision])).toEqual([
      ['esc-plain', 'denied'],
      ['esc-human', 'denied'],
    ]);
    expect(result.state.pendingEscalations.size).toBe(0);
  });

  it('"/approve N" approves a human-only escalation explicitly', () => {
    const resolutions: Resolution[] = [];
    const result = handleCommand('/approve 2', stateWithPair(resolutions));

    expect(resolutions).toEqual([{ escalationId: 'esc-human', decision: 'approved' }]);
    expect(text(result.message)).toBe('Escalation #2 APPROVED');
  });

  it('"/approve+ N" approves a human-only escalation once, without a whitelist selection', () => {
    const resolutions: Resolution[] = [];
    const result = handleCommand('/approve+ 2', stateWithPair(resolutions));

    expect(resolutions).toEqual([{ escalationId: 'esc-human', decision: 'approved' }]);
    expect(text(result.message)).toBe('Escalation #2 APPROVED (human-only: approved once, not whitelisted)');
  });

  it('"/approve+ N" still whitelists an ordinary escalation', () => {
    const resolutions: Resolution[] = [];
    const result = handleCommand('/approve+ 1', stateWithPair(resolutions));

    expect(resolutions).toEqual([
      { escalationId: 'esc-plain', decision: 'approved', options: { whitelistSelection: 0 } },
    ]);
    expect(text(result.message)).toBe('Escalation #1 APPROVED (whitelisted)');
  });
});

describe('escalation listener: exact and directory-wide whitelisting', () => {
  /** An escalation offering the exact file (index 0) and, unless `exactOnly`, its directory (index 1). */
  function readRequest(escalationId: string, exactOnly = false): EscalationRequest {
    return {
      escalationId,
      serverName: 'filesystem',
      toolName: 'read_text_file',
      arguments: { path: '/home/user/notes/a.txt' },
      reason: 'Test escalation',
      whitelistCandidates: [
        { description: 'Allow filesystem/read_text_file read-path /home/user/notes/a.txt', scope: 'exact' },
        ...(exactOnly
          ? []
          : [
              {
                description: 'Allow filesystem/read_text_file read-path within /home/user/notes (recursive)',
                scope: 'directory' as const,
              },
            ]),
      ],
    };
  }

  /** One session with #1 offering both patterns, #2 offering only the exact one, #3 human-only. */
  function stateWithReads(resolutions: Resolution[]): ListenerState {
    let state = addSession(
      createInitialState(),
      {
        sessionId: 'session-1',
        escalationDir: '/tmp/ic-listener-test/escalations',
        label: 'test session',
        startedAt: new Date().toISOString(),
        pid: process.pid,
      },
      recordingWatcher(resolutions),
    );
    state = addEscalation(state, 'session-1', readRequest('esc-both'));
    state = addEscalation(state, 'session-1', readRequest('esc-exact', true));
    state = addEscalation(state, 'session-1', request('esc-human', true));
    return state;
  }

  it('"/approve+ N" whitelists the exact pattern (index 0)', () => {
    const resolutions: Resolution[] = [];
    const result = handleCommand('/approve+ 1', stateWithReads(resolutions));
    expect(resolutions).toEqual([
      { escalationId: 'esc-both', decision: 'approved', options: { whitelistSelection: 0 } },
    ]);
    expect(text(result.message)).toBe('Escalation #1 APPROVED (whitelisted)');
  });

  it('"/approve+dir N" whitelists the directory-wide pattern', () => {
    const resolutions: Resolution[] = [];
    const result = handleCommand('/approve+dir 1', stateWithReads(resolutions));
    expect(resolutions).toEqual([
      { escalationId: 'esc-both', decision: 'approved', options: { whitelistSelection: 1 } },
    ]);
    expect(text(result.message)).toBe('Escalation #1 APPROVED (whitelisted: directory-wide)');
    expect(result.state.pendingEscalations.has(1)).toBe(false);
  });

  it('"/approve+dir N" resolves nothing when no directory-wide pattern is offered, human-only included', () => {
    const messages: Record<number, string> = {
      2: 'Escalation #2 was not resolved: it offers no directory-wide whitelist pattern (/approve+ 2 whitelists this path only)',
      3: 'Escalation #3 was not resolved: a human-only escalation is never whitelisted (/approve 3 approves it once)',
    };
    for (const num of [2, 3]) {
      const resolutions: Resolution[] = [];
      const state = stateWithReads(resolutions);
      const result = handleCommand(`/approve+dir ${num}`, state);
      expect(resolutions, String(num)).toEqual([]);
      expect(result.state.pendingEscalations.has(num), String(num)).toBe(true);
      expect(text(result.message), String(num)).toBe(messages[num]);
    }
  });

  it('"/approve+dir N" never whitelists a human-only escalation, even one that carries candidates', () => {
    const resolutions: Resolution[] = [];
    const state = addEscalation(
      addSession(
        createInitialState(),
        {
          sessionId: 'session-1',
          escalationDir: '/tmp/ic-listener-test/escalations',
          label: 'test session',
          startedAt: new Date().toISOString(),
          pid: process.pid,
        },
        recordingWatcher(resolutions),
      ),
      'session-1',
      { ...readRequest('esc-forged'), humanOnly: true },
    );
    const result = handleCommand('/approve+dir 1', state);
    expect(resolutions).toEqual([]);
    expect(text(result.message)).toContain('a human-only escalation is never whitelisted');
  });

  it('"/approve+dir all" is refused: directory-wide whitelisting is chosen one escalation at a time', () => {
    const resolutions: Resolution[] = [];
    const state = stateWithReads(resolutions);
    const result = handleCommand('/approve+dir all', state);
    expect(resolutions).toEqual([]);
    expect(result.state.pendingEscalations.size).toBe(3);
    expect(text(result.message)).toContain('one escalation at a time');
  });

  it('"/approve+ all" whitelists only exact patterns, and lists only those', () => {
    const resolutions: Resolution[] = [];
    const state = stateWithReads(resolutions);
    const listing = text(handleCommand('/approve+ all', state).message);
    expect(listing).toContain('Whitelist: Allow filesystem/read_text_file read-path /home/user/notes/a.txt');
    expect(listing).not.toContain('(recursive)');
    handleCommand(`/approve+ all ${bulkApprovalCode(state, true)}`, state);
    expect(resolutions.map((r) => r.options)).toEqual([{ whitelistSelection: 0 }, { whitelistSelection: 0 }]);
  });

  it('the dashboard shows each pattern behind the command that adds it', () => {
    const dashboard = text(buildDashboard(stateWithReads([])));
    expect(dashboard).toContain('/approve+ 1: Allow filesystem/read_text_file read-path /home/user/notes/a.txt');
    expect(dashboard).toContain(
      '/approve+dir 1: Allow filesystem/read_text_file read-path within /home/user/notes (recursive)',
    );
    expect(dashboard).toContain('/approve+ 2: Allow filesystem/read_text_file read-path /home/user/notes/a.txt');
    expect(dashboard).not.toContain('/approve+dir 2');
    expect(dashboard).not.toContain('/approve+dir 3');
    expect(dashboard).toContain('/approve+dir N');
  });
});

function registration(sessionId: string, escalationDir = `/tmp/ic-listener-test/${sessionId}`): PtySessionRegistration {
  return { sessionId, escalationDir, label: sessionId, startedAt: new Date().toISOString(), pid: process.pid };
}

describe('escalation listener: /approve N while escalations keep arriving', () => {
  it('a number keeps naming the escalation it was shown with while others arrive, resolve and expire', () => {
    const fromA: Resolution[] = [];
    const fromB: Resolution[] = [];
    let state = addSession(createInitialState(), registration('session-a'), recordingWatcher(fromA));
    state = addSession(state, registration('session-b'), recordingWatcher(fromB));
    state = addEscalation(state, 'session-a', request('a-1', false)); // #1
    state = addEscalation(state, 'session-b', request('b-1', false)); // #2
    state = addEscalation(state, 'session-a', request('a-2', false)); // #3

    let result = handleCommand('/approve 2', state);
    expect(text(result.message)).toBe('Escalation #2 APPROVED');
    // Session B asks again right after: the new request is #4, never a reused #2.
    state = addEscalation(result.state, 'session-b', request('b-2', false));
    expect(state.pendingEscalations.get(4)?.request.escalationId).toBe('b-2');

    result = handleCommand('/deny 3', state);
    expect(text(result.message)).toBe('Escalation #3 DENIED');
    // #1 times out in the proxy before anyone answers it.
    state = expireEscalation(result.state, 'session-a', 'a-1');

    for (const stale of ['/approve 1', '/approve 2', '/deny 3']) {
      const staleResult = handleCommand(stale, state);
      expect(text(staleResult.message)).toBe(`No pending escalation #${stale.split(' ')[1]}`);
      expect(staleResult.state).toBe(state);
    }

    result = handleCommand('/approve 4', state);
    expect(text(result.message)).toBe('Escalation #4 APPROVED');
    expect(result.state.pendingEscalations.size).toBe(0);

    // Each decision went to the watcher of the session that raised it.
    expect(fromA).toEqual([{ escalationId: 'a-2', decision: 'denied' }]);
    expect(fromB).toEqual([
      { escalationId: 'b-1', decision: 'approved' },
      { escalationId: 'b-2', decision: 'approved' },
    ]);
  });

  it('an escalation of a session that ended can no longer be answered by its number', () => {
    const fromA: Resolution[] = [];
    const fromB: Resolution[] = [];
    let state = addSession(createInitialState(), registration('session-a'), recordingWatcher(fromA));
    state = addSession(state, registration('session-b'), recordingWatcher(fromB));
    state = addEscalation(state, 'session-a', request('a-1', false)); // #1
    state = addEscalation(state, 'session-b', request('b-1', false)); // #2

    state = removeSession(state, 'session-a');
    state = addEscalation(state, 'session-b', request('b-2', false)); // #3

    expect(text(handleCommand('/approve 1', state).message)).toBe('No pending escalation #1');
    expect(text(handleCommand('/deny all', state).message)).toBe('Escalation #2 DENIED\nEscalation #3 DENIED');
    expect(fromA).toEqual([]);
    expect(fromB.map((r) => r.escalationId)).toEqual(['b-1', 'b-2']);
  });

  it('a response that arrives after the proxy gave up is reported as expired and retires the number', () => {
    const watcher: EscalationWatcher = { ...recordingWatcher([]), resolve: () => false };
    let state = addSession(createInitialState(), registration('session-a'), watcher);
    state = addEscalation(state, 'session-a', request('a-1', false));

    const result = handleCommand('/approve 1', state);

    expect(text(result.message)).toBe('Escalation #1 expired (response was too late)');
    expect(result.state.pendingEscalations.size).toBe(0);
  });
});

describe('escalation listener: decisions reach the session that asked', () => {
  let root: string;
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ironcurtain-listener-'));
    // The listener rings the terminal bell on each new escalation.
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  function escalationDir(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir);
    return dir;
  }

  /** The proxy side of the file IPC: one pending request file. */
  function raise(dir: string, escalationId: string): void {
    writeFileSync(join(dir, `request-${escalationId}.json`), JSON.stringify(request(escalationId, false)));
  }

  /** One poll of the watcher (start() polls at once; stop() cancels the interval). */
  function poll(watcher: EscalationWatcher): void {
    watcher.start();
    watcher.stop();
  }

  function response(dir: string, escalationId: string): unknown {
    return JSON.parse(readFileSync(join(dir, `response-${escalationId}.json`), 'utf8'));
  }

  it('writes each answer into the escalation directory of the session that raised #N', () => {
    const dirA = escalationDir('a');
    const dirB = escalationDir('b');
    let state = createInitialState();
    const setState = (next: ListenerState): void => {
      state = next;
    };
    const getState = (): ListenerState => state;
    const watcherA = createWatcherForSession(registration('session-a', dirA), setState, getState);
    state = addSession(state, registration('session-a', dirA), watcherA);
    const watcherB = createWatcherForSession(registration('session-b', dirB), setState, getState);
    state = addSession(state, registration('session-b', dirB), watcherB);

    raise(dirA, 'a-1');
    poll(watcherA);
    raise(dirB, 'b-1');
    poll(watcherB);
    expect(
      [...state.pendingEscalations.values()].map((e) => [e.displayNumber, e.sessionId, e.request.escalationId]),
    ).toEqual([
      [1, 'session-a', 'a-1'],
      [2, 'session-b', 'b-1'],
    ]);

    state = handleCommand('/approve+ 2', state).state;
    expect(response(dirB, 'b-1')).toEqual({ decision: 'approved', whitelistSelection: 0 });
    expect(existsSync(join(dirA, 'response-a-1.json'))).toBe(false);

    // Session B's next request arrives as #3 while #1 still waits.
    raise(dirB, 'b-2');
    poll(watcherB);
    expect(state.pendingEscalations.get(3)?.request.escalationId).toBe('b-2');

    state = handleCommand('/deny 1', state).state;
    expect(response(dirA, 'a-1')).toEqual({ decision: 'denied' });
    expect(existsSync(join(dirB, 'response-b-2.json'))).toBe(false);

    state = handleCommand('/approve 3', state).state;
    expect(response(dirB, 'b-2')).toEqual({ decision: 'approved' });
    expect(state.pendingEscalations.size).toBe(0);
  });
});

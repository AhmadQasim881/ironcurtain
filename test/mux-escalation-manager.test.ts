import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createMuxEscalationManager } from '../src/mux/mux-escalation-manager.js';
import { atomicWriteJsonSync } from '../src/escalation/escalation-watcher.js';
import type { PtySessionRegistration } from '../src/docker/pty-types.js';

// Dynamic path updated per-test in beforeEach so the mock registry dir
// lives under tempDir and gets cleaned up automatically.
let mockRegistryDir = '/tmp/ironcurtain-test-registry';

// Mock modules used by registry polling (isOwnedByLiveMux stays real and
// consults the mocked isPidAlive below)
vi.mock('../src/escalation/session-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/escalation/session-registry.js')>()),
  readActiveRegistrations: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/config/paths.js', () => ({
  getListenerLockPath: vi.fn().mockReturnValue('/tmp/nonexistent-lock'),
  getPtyRegistryDir: vi.fn(() => mockRegistryDir),
}));

// Partial mock: keep isPidAlive and isListenerLockHeld mockable
vi.mock('../src/escalation/listener-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/escalation/listener-lock.js')>();
  return {
    ...actual,
    isPidAlive: vi.fn().mockReturnValue(true),
    isListenerLockHeld: vi.fn().mockReturnValue(false),
  };
});

// The watcher polls on a 300ms interval, so a fixed sleep can lose the race under
// a GC/scheduler stall. Poll the live `pendingCount` getter until it reaches the
// expected value or a generous timeout elapses.
async function waitForPendingCount(
  manager: { readonly pendingCount: number },
  expected: number,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (manager.pendingCount < expected) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for pendingCount to reach ${expected} (last seen: ${manager.pendingCount})`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('MuxEscalationManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-mux-esc-'));
    mockRegistryDir = resolve(tempDir, 'registry');
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts with empty state', () => {
    const manager = createMuxEscalationManager();
    expect(manager.pendingCount).toBe(0);
    expect(manager.state.sessions.size).toBe(0);
    manager.stop();
  });

  it('adding a session updates state', () => {
    const manager = createMuxEscalationManager();
    const escalationDir = resolve(tempDir, 'session1');
    mkdirSync(escalationDir, { recursive: true });

    manager.addSession({
      sessionId: 'session-1',
      escalationDir,
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });
    expect(manager.state.sessions.size).toBe(1);
    expect(manager.state.sessions.get('session-1')).toBeDefined();
    manager.stop();
  });

  it('removing a session updates state', () => {
    const manager = createMuxEscalationManager();
    const escalationDir = resolve(tempDir, 'session1');
    mkdirSync(escalationDir, { recursive: true });

    manager.addSession({
      sessionId: 'session-1',
      escalationDir,
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });
    manager.removeSession('session-1');
    expect(manager.state.sessions.size).toBe(0);
    manager.stop();
  });

  it('fires change callback on session add', () => {
    const manager = createMuxEscalationManager();
    let changed = false;
    manager.onChange(() => {
      changed = true;
    });

    const escalationDir = resolve(tempDir, 'session1');
    mkdirSync(escalationDir, { recursive: true });
    manager.addSession({
      sessionId: 'session-1',
      escalationDir,
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });

    expect(changed).toBe(true);
    manager.stop();
  });

  it('fires change callback on session remove', () => {
    const manager = createMuxEscalationManager();
    const escalationDir = resolve(tempDir, 'session1');
    mkdirSync(escalationDir, { recursive: true });
    manager.addSession({
      sessionId: 'session-1',
      escalationDir,
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });

    let changed = false;
    manager.onChange(() => {
      changed = true;
    });
    manager.removeSession('session-1');
    expect(changed).toBe(true);
    manager.stop();
  });

  it('detects pending escalation via watcher', async () => {
    const manager = createMuxEscalationManager();
    const escalationDir = resolve(tempDir, 'session1');
    mkdirSync(escalationDir, { recursive: true });
    manager.addSession({
      sessionId: 'session-1',
      escalationDir,
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });

    // Write an escalation request file
    const requestFile = resolve(escalationDir, 'request-test-123.json');
    atomicWriteJsonSync(requestFile, {
      escalationId: 'test-123',
      serverName: 'filesystem',
      toolName: 'write_file',
      arguments: { path: '/test' },
      reason: 'Test escalation',
    });

    // Wait for the watcher to poll (default 300ms)
    await waitForPendingCount(manager, 1);

    expect(manager.pendingCount).toBe(1);
    manager.stop();
  });

  it('re-adding a session stops the old watcher (no duplicate escalations)', async () => {
    const manager = createMuxEscalationManager();
    const escalationDir = resolve(tempDir, 'session1');
    mkdirSync(escalationDir, { recursive: true });

    const registration = {
      sessionId: 'session-1',
      escalationDir,
      label: 'test session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };

    // Simulate the race: registry polling adds the session first
    manager.addSession(registration);
    // Then bridge discovery adds it again (same session ID)
    manager.addSession(registration);

    // Should still be just one session
    expect(manager.state.sessions.size).toBe(1);

    // Write an escalation request file
    const requestFile = resolve(escalationDir, 'request-dup-test.json');
    atomicWriteJsonSync(requestFile, {
      escalationId: 'dup-test',
      serverName: 'filesystem',
      toolName: 'write_file',
      arguments: { path: '/test' },
      reason: 'Test escalation',
    });

    // Wait for the watcher to poll (default 300ms)
    await waitForPendingCount(manager, 1);

    // Should only have 1 pending escalation, not 2
    expect(manager.pendingCount).toBe(1);
    manager.stop();
  });

  it('resolve returns message for non-existent escalation', () => {
    const manager = createMuxEscalationManager();
    const result = manager.resolve(999, 'approved');
    expect(result).toContain('No pending escalation #999');
    manager.stop();
  });

  it('denyAll and approveAll return a message when no escalations are pending', () => {
    const manager = createMuxEscalationManager();
    expect(manager.denyAll()).toBe('No pending escalations');
    expect(manager.approveAll([])).toBe('No pending escalations');
    manager.stop();
  });

  describe('decisions bound to what was shown', () => {
    /** A session; writes request files on demand and waits for the watcher to surface them. */
    function oneSession(
      manager: ReturnType<typeof createMuxEscalationManager>,
      name = 'bound',
    ): {
      escalationDir: string;
      request(id: string): Promise<void>;
    } {
      const escalationDir = resolve(tempDir, name);
      mkdirSync(escalationDir, { recursive: true });
      manager.addSession({
        sessionId: `session-${name}`,
        escalationDir,
        label: `${name} session`,
        startedAt: new Date().toISOString(),
        pid: process.pid,
      });
      return {
        escalationDir,
        async request(id: string) {
          const before = manager.pendingCount;
          atomicWriteJsonSync(resolve(escalationDir, `request-${id}.json`), {
            escalationId: id,
            serverName: 'filesystem',
            toolName: 'write_file',
            arguments: { path: `/test/${id}` },
            reason: 'Test escalation',
            whitelistCandidates: [{ description: `Allow write_file within /test/${id}` }],
          });
          await waitForPendingCount(manager, before + 1);
        },
      };
    }

    it('resolve() with a stale escalation id is rejected and writes nothing', async () => {
      const manager = createMuxEscalationManager();
      const session = oneSession(manager);
      await session.request('esc-shown');
      const [num] = manager.sortedDisplayNumbers();

      const message = manager.resolve(num, 'approved', { escalationId: 'esc-other', whitelist: 'exact' });

      expect(message).toBe(`Escalation #${num} was not resolved: it is not the request that was shown`);
      expect(existsSync(resolve(session.escalationDir, 'response-esc-shown.json'))).toBe(false);
      expect(manager.pendingRefs()).toEqual([{ displayNumber: num, escalationId: 'esc-shown' }]);

      // The matching id resolves it.
      expect(manager.resolve(num, 'approved', { escalationId: 'esc-shown' })).toBe(`Escalation #${num} APPROVED`);
      expect(manager.pendingCount).toBe(0);
      manager.stop();
    });

    it('approve-all after a new arrival is refused and approves nothing', async () => {
      const manager = createMuxEscalationManager();
      const first = oneSession(manager, 'first');
      const second = oneSession(manager, 'second');
      await first.request('esc-reviewed');
      const reviewed = manager.pendingRefs(); // what the confirmation screen listed

      await second.request('esc-new'); // arrives after the list was shown

      const message = manager.approveAll(reviewed);

      expect(message).toBe(
        'Nothing was approved: the pending escalations changed since they were listed. Review them again.',
      );
      expect(existsSync(resolve(first.escalationDir, 'response-esc-reviewed.json'))).toBe(false);
      expect(existsSync(resolve(second.escalationDir, 'response-esc-new.json'))).toBe(false);
      expect(manager.pendingRefs().map((r) => r.escalationId)).toEqual(['esc-reviewed', 'esc-new']);

      // A set that lost a member is refused too.
      manager.resolve(manager.pendingRefs()[1].displayNumber, 'denied');
      expect(manager.approveAll([...reviewed, { displayNumber: 99, escalationId: 'esc-gone' }])).toContain(
        'Nothing was approved',
      );
      expect(manager.pendingCount).toBe(1);
      manager.stop();
    });

    it('approveAll approves exactly the reviewed set, whitelisting with /approve+ all', async () => {
      const manager = createMuxEscalationManager();
      const session = oneSession(manager);
      await session.request('esc-a');
      const reviewed = manager.pendingRefs();

      expect(manager.approveAll(reviewed, { whitelist: true })).toBe(
        `Escalation #${reviewed[0].displayNumber} APPROVED (whitelisted)`,
      );
      const response = JSON.parse(
        readFileSync(resolve(session.escalationDir, 'response-esc-a.json'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(response).toEqual({ decision: 'approved', whitelistSelection: 0 });
      manager.stop();
    });
  });

  describe('exact and directory-wide whitelisting', () => {
    /**
     * Two sessions (a session has one pending escalation at a time): #1
     * offers both patterns, #2 only the exact one. Returns their
     * escalation directories, by escalation id.
     */
    async function pendingReads(
      manager: ReturnType<typeof createMuxEscalationManager>,
    ): Promise<Record<string, string>> {
      const dirs: Record<string, string> = {};
      for (const [id, withDirectory] of [
        ['esc-both', true],
        ['esc-exact', false],
      ] as const) {
        const escalationDir = resolve(tempDir, id);
        mkdirSync(escalationDir, { recursive: true });
        dirs[id] = escalationDir;
        manager.addSession({
          sessionId: `session-${id}`,
          escalationDir,
          label: id,
          startedAt: new Date().toISOString(),
          pid: process.pid,
        });
        atomicWriteJsonSync(resolve(escalationDir, `request-${id}.json`), {
          escalationId: id,
          serverName: 'filesystem',
          toolName: 'read_text_file',
          arguments: { path: '/home/user/notes/a.txt' },
          reason: 'Test escalation',
          whitelistCandidates: [
            { description: 'Allow filesystem/read_text_file read-path /home/user/notes/a.txt', scope: 'exact' },
            ...(withDirectory
              ? [
                  {
                    description: 'Allow filesystem/read_text_file read-path within /home/user/notes (recursive)',
                    scope: 'directory',
                  },
                ]
              : []),
          ],
        });
        await waitForPendingCount(manager, id === 'esc-both' ? 1 : 2);
      }
      return dirs;
    }

    const response = (dirs: Record<string, string>, id: string) =>
      JSON.parse(readFileSync(resolve(dirs[id], `response-${id}.json`), 'utf-8')) as Record<string, unknown>;

    it('/approve+dir N writes the directory-wide candidate index; /approve+ N the exact one', async () => {
      const manager = createMuxEscalationManager();
      const dir = await pendingReads(manager);
      const [both, exactOnly] = manager.pendingRefs();

      expect(manager.resolve(both.displayNumber, 'approved', { whitelist: 'directory' })).toBe(
        `Escalation #${both.displayNumber} APPROVED (whitelisted: directory-wide)`,
      );
      expect(response(dir, 'esc-both')).toEqual({ decision: 'approved', whitelistSelection: 1 });

      expect(manager.resolve(exactOnly.displayNumber, 'approved', { whitelist: 'exact' })).toBe(
        `Escalation #${exactOnly.displayNumber} APPROVED (whitelisted)`,
      );
      expect(response(dir, 'esc-exact')).toEqual({ decision: 'approved', whitelistSelection: 0 });
      manager.stop();
    });

    it('/approve+dir N resolves nothing when the escalation offers no directory-wide pattern', async () => {
      const manager = createMuxEscalationManager();
      const dir = await pendingReads(manager);
      const exactOnly = manager.pendingRefs()[1];

      expect(manager.resolve(exactOnly.displayNumber, 'approved', { whitelist: 'directory' })).toBe(
        `Escalation #${exactOnly.displayNumber} was not resolved: it offers no directory-wide whitelist pattern (/approve+ ${exactOnly.displayNumber} whitelists this path only)`,
      );
      expect(existsSync(resolve(dir['esc-exact'], 'response-esc-exact.json'))).toBe(false);
      expect(manager.pendingCount).toBe(2);
      manager.stop();
    });

    it('approve all with whitelisting picks the exact pattern of each', async () => {
      const manager = createMuxEscalationManager();
      const dir = await pendingReads(manager);
      manager.approveAll(manager.pendingRefs(), { whitelist: true });
      expect(response(dir, 'esc-both')).toEqual({ decision: 'approved', whitelistSelection: 0 });
      expect(response(dir, 'esc-exact')).toEqual({ decision: 'approved', whitelistSelection: 0 });
      manager.stop();
    });
  });

  describe('human-only escalations', () => {
    /** Two sessions, each with one pending escalation; the second one is human-only. */
    async function pendingPair(manager: ReturnType<typeof createMuxEscalationManager>): Promise<void> {
      for (const [n, humanOnly] of [
        [1, false],
        [2, true],
      ] as const) {
        const escalationDir = resolve(tempDir, `session${n}`);
        mkdirSync(escalationDir, { recursive: true });
        manager.addSession({
          sessionId: `session-${n}`,
          escalationDir,
          label: `session ${n}`,
          startedAt: new Date().toISOString(),
          pid: process.pid,
        });
        atomicWriteJsonSync(resolve(escalationDir, `request-esc-${n}.json`), {
          escalationId: `esc-${n}`,
          serverName: humanOnly ? 'proxy' : 'filesystem',
          toolName: humanOnly ? 'add_proxy_domain' : 'write_file',
          arguments: humanOnly ? { domain: 'api.example.com' } : { path: '/test' },
          reason: 'Test escalation',
          ...(humanOnly ? { humanOnly: true } : {}),
        });
      }
      await waitForPendingCount(manager, 2);
    }

    it('"approve all" leaves a human-only escalation pending and says so', async () => {
      const manager = createMuxEscalationManager();
      await pendingPair(manager);
      const [plain, humanOnly] = manager.sortedDisplayNumbers();

      const message = manager.approveAll(manager.pendingRefs());

      expect(message).toContain(`Escalation #${plain} APPROVED`);
      expect(message).toContain(`Escalation #${humanOnly} requires individual approval (/approve ${humanOnly})`);
      expect(manager.pendingCount).toBe(1);
      expect(manager.state.pendingEscalations.get(humanOnly)?.request.humanOnly).toBe(true);

      // An explicit approval of that one escalation still works.
      expect(manager.resolve(humanOnly, 'approved')).toContain(`Escalation #${humanOnly} APPROVED`);
      expect(manager.pendingCount).toBe(0);
      manager.stop();
    });

    it('"deny all" denies a human-only escalation like any other', async () => {
      const manager = createMuxEscalationManager();
      await pendingPair(manager);

      const message = manager.denyAll();

      expect(message).not.toContain('requires individual approval');
      expect(manager.pendingCount).toBe(0);
      manager.stop();
    });

    it('"/approve+ N" approves a human-only escalation once and writes no whitelist selection', async () => {
      const manager = createMuxEscalationManager();
      await pendingPair(manager);
      const [plain, humanOnly] = manager.sortedDisplayNumbers();

      const message = manager.resolve(humanOnly, 'approved', { whitelist: 'exact' });

      expect(message).toBe(`Escalation #${humanOnly} APPROVED (human-only: approved once, not whitelisted)`);
      const response = JSON.parse(readFileSync(resolve(tempDir, 'session2', 'response-esc-2.json'), 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(response).toEqual({ decision: 'approved' });

      // An ordinary escalation is still whitelisted by /approve+.
      expect(manager.resolve(plain, 'approved', { whitelist: 'exact' })).toBe(
        `Escalation #${plain} APPROVED (whitelisted)`,
      );
      const plainResponse = JSON.parse(
        readFileSync(resolve(tempDir, 'session1', 'response-esc-1.json'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(plainResponse).toEqual({ decision: 'approved', whitelistSelection: 0 });
      manager.stop();
    });
  });

  describe('ownership filtering during registry polling', () => {
    const OUR_MUX_ID = 'mux-aaaa1111';
    const OTHER_MUX_ID = 'mux-bbbb2222';

    function makeRegistration(
      sessionId: string,
      overrides: Partial<PtySessionRegistration> = {},
    ): PtySessionRegistration {
      const escalationDir = resolve(tempDir, sessionId);
      mkdirSync(escalationDir, { recursive: true });
      return {
        sessionId,
        escalationDir,
        label: `test ${sessionId}`,
        startedAt: new Date().toISOString(),
        pid: process.pid,
        ...overrides,
      };
    }

    /** Triggers one registry poll tick by advancing the fake timer. */
    async function triggerPoll(): Promise<void> {
      await vi.advanceTimersByTimeAsync(1100);
    }

    let readActiveRegistrationsMock: ReturnType<typeof vi.fn>;
    let isPidAliveMock: ReturnType<typeof vi.fn>;
    let isLockHolderAliveMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.useFakeTimers();
      const sessionRegistry = await import('../src/escalation/session-registry.js');
      readActiveRegistrationsMock = sessionRegistry.readActiveRegistrations as ReturnType<typeof vi.fn>;
      const listenerLock = await import('../src/escalation/listener-lock.js');
      isPidAliveMock = listenerLock.isPidAlive as ReturnType<typeof vi.fn>;
      isLockHolderAliveMock = listenerLock.isListenerLockHeld as ReturnType<typeof vi.fn>;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('picks up registrations with matching muxId', async () => {
      const reg = makeRegistration('sess-own', { muxId: OUR_MUX_ID, muxPid: process.pid });
      readActiveRegistrationsMock.mockReturnValue([reg]);

      const manager = createMuxEscalationManager({ muxId: OUR_MUX_ID });
      manager.startRegistryPolling();

      await triggerPoll();

      expect(manager.state.sessions.size).toBe(1);
      expect(manager.state.sessions.has('sess-own')).toBe(true);
      manager.stop();
    });

    it('ignores registrations with different muxId when owning mux is alive', async () => {
      const reg = makeRegistration('sess-other', { muxId: OTHER_MUX_ID, muxPid: 12345 });
      readActiveRegistrationsMock.mockReturnValue([reg]);
      // The other mux process is alive
      isPidAliveMock.mockReturnValue(true);

      const manager = createMuxEscalationManager({ muxId: OUR_MUX_ID });
      manager.startRegistryPolling();

      await triggerPoll();

      expect(manager.state.sessions.size).toBe(0);
      manager.stop();
    });

    it('reclaims orphaned registrations (different muxId, dead muxPid)', async () => {
      const reg = makeRegistration('sess-orphan', { muxId: OTHER_MUX_ID, muxPid: 999999999 });
      readActiveRegistrationsMock.mockReturnValue([reg]);
      // The other mux process is dead
      isPidAliveMock.mockReturnValue(false);
      // No standalone listener running
      isLockHolderAliveMock.mockReturnValue(false);

      const manager = createMuxEscalationManager({ muxId: OUR_MUX_ID });
      manager.startRegistryPolling();

      await triggerPoll();

      expect(manager.state.sessions.size).toBe(1);
      expect(manager.state.sessions.has('sess-orphan')).toBe(true);
      manager.stop();
    });

    it('picks up unowned registrations (no muxId) when no standalone listener is running', async () => {
      const reg = makeRegistration('sess-unowned');
      readActiveRegistrationsMock.mockReturnValue([reg]);
      // No standalone listener running
      isLockHolderAliveMock.mockReturnValue(false);

      const manager = createMuxEscalationManager({ muxId: OUR_MUX_ID });
      manager.startRegistryPolling();

      await triggerPoll();

      expect(manager.state.sessions.size).toBe(1);
      expect(manager.state.sessions.has('sess-unowned')).toBe(true);
      manager.stop();
    });

    it('ignores unowned registrations when a standalone listener is running', async () => {
      const reg = makeRegistration('sess-unowned-skip');
      readActiveRegistrationsMock.mockReturnValue([reg]);
      // Standalone listener IS running
      isLockHolderAliveMock.mockReturnValue(true);

      const manager = createMuxEscalationManager({ muxId: OUR_MUX_ID });
      manager.startRegistryPolling();

      await triggerPoll();

      expect(manager.state.sessions.size).toBe(0);
      manager.stop();
    });

    it('ignores orphaned registrations when a standalone listener is running', async () => {
      const reg = makeRegistration('sess-orphan-skip', { muxId: OTHER_MUX_ID, muxPid: 999999999 });
      readActiveRegistrationsMock.mockReturnValue([reg]);
      // Standalone listener IS running
      isLockHolderAliveMock.mockReturnValue(true);
      // The other mux process is dead (orphaned)
      isPidAliveMock.mockReturnValue(false);

      const manager = createMuxEscalationManager({ muxId: OUR_MUX_ID });
      manager.startRegistryPolling();

      await triggerPoll();

      expect(manager.state.sessions.size).toBe(0);
      manager.stop();
    });
  });
});

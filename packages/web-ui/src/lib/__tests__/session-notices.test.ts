import { describe, it, expect } from 'vitest';
import {
  MAX_SESSION_NOTICES,
  addSessionNotices,
  describeSessionNotice,
  dismissSessionNoticeEntry,
  isSameSession,
  retainSessionNotices,
  seedSessionNotices,
  sessionNoticeKey,
  toSessionNotice,
} from '../session-notices.js';
import type { SessionNoticeEvent } from '../types.js';
import { mockSession } from './fixtures.js';

const UNAVAILABLE: SessionNoticeEvent = {
  kind: 'mcp_server_unavailable',
  serverName: 'github',
  reason: 'MCP error -32000: Connection closed',
};
const STALE: SessionNoticeEvent = {
  kind: 'policy_stale',
  message: 'Warning: the compiled policy at /home/u/.ironcurtain/generated/compiled-policy.json may be stale:',
};
const HOST_FILES: SessionNoticeEvent = {
  kind: 'host_privileged_files',
  when: 'after agent turn',
  stripped: 0,
  unstripped: 1,
  rootOwned: 2,
  unlisted: 0,
  paths: ['/home/u/project/bin/shell'],
  incomplete: false,
  hint: 'Remove them as root (for example with sudo rm).',
};

describe('toSessionNotice', () => {
  it('keeps the notice kinds and only their fields', () => {
    expect(toSessionNotice({ ...UNAVAILABLE, extra: 'x' })).toEqual(UNAVAILABLE);
    expect(toSessionNotice(STALE)).toEqual(STALE);
    expect(toSessionNotice(HOST_FILES)).toEqual(HOST_FILES);
    expect(
      toSessionNotice({ kind: 'host_model_fallback', role: 'summary', action: 'agent_model', message: 'm' }),
    ).toEqual({ kind: 'host_model_fallback', role: 'summary', action: 'agent_model', message: 'm' });
    expect(toSessionNotice({ kind: 'annotation_drift', serverName: 'git', message: 'm', hint: 'h' })).toEqual({
      kind: 'annotation_drift',
      serverName: 'git',
      message: 'm',
      hint: 'h',
    });
  });

  it('ignores other diagnostics and malformed notices', () => {
    expect(toSessionNotice({ kind: 'tool_call', toolName: 't', preview: 'p' })).toBeUndefined();
    expect(
      toSessionNotice({ kind: 'budget_warning', dimension: 'tokens', percentUsed: 80, message: 'm' }),
    ).toBeUndefined();
    expect(toSessionNotice({ kind: 'mcp_server_unavailable', serverName: 7, reason: 'r' })).toBeUndefined();
    expect(toSessionNotice({ ...HOST_FILES, paths: 'not a list' })).toBeUndefined();
    expect(toSessionNotice({ ...HOST_FILES, unstripped: -1 })).toBeUndefined();
    expect(toSessionNotice(null)).toBeUndefined();
    expect(toSessionNotice('policy_stale')).toBeUndefined();
  });
});

describe('session notice lists', () => {
  it('holds each notice once, pushed or seeded', () => {
    const pushed = addSessionNotices(undefined, [UNAVAILABLE, UNAVAILABLE]);
    expect(pushed.map((entry) => entry.notice)).toEqual([UNAVAILABLE]);
    // The same notice with its fields in another order is the same notice.
    expect(sessionNoticeKey({ reason: UNAVAILABLE.reason, serverName: 'github', kind: 'mcp_server_unavailable' })).toBe(
      pushed[0].key,
    );

    const seeded = seedSessionNotices(pushed, [STALE, UNAVAILABLE]);
    expect(seeded.map((entry) => entry.notice)).toEqual([STALE, UNAVAILABLE]);
    // A notice pushed meanwhile that the log did not have yet stays, after the logged ones.
    expect(seedSessionNotices(addSessionNotices(seeded, [HOST_FILES]), [STALE]).map((entry) => entry.notice)).toEqual([
      STALE,
      UNAVAILABLE,
      HOST_FILES,
    ]);
  });

  it('keeps a dismissed notice dismissed when the notices are seeded again', () => {
    const entries = addSessionNotices(undefined, [STALE, UNAVAILABLE]);
    const dismissed = dismissSessionNoticeEntry(entries, entries[1].key);
    expect(dismissed.map((entry) => entry.dismissed)).toEqual([false, true]);
    expect(seedSessionNotices(dismissed, [STALE, UNAVAILABLE]).map((entry) => entry.dismissed)).toEqual([false, true]);
  });

  it('keeps the lists of the sessions a fresh session list still has, and drops the others', () => {
    const signal = mockSession(1, { source: { kind: 'signal' } });
    const cron = mockSession(2, { source: { kind: 'cron', jobId: 'j', jobName: 'J' } });
    const notices = new Map([
      [1, addSessionNotices(undefined, [UNAVAILABLE])],
      [2, addSessionNotices(undefined, [STALE])],
    ]);
    const previous = new Map([
      [1, signal],
      [2, cron],
    ]);

    // Same sessions (a status change is no new session): nothing to drop.
    const busy = mockSession(1, { source: { kind: 'signal' }, status: 'processing', turnCount: 3 });
    expect(retainSessionNotices(notices, previous, new Map([...previous, [1, busy]]))).toBe(undefined);
    // Session 2 ended while the client was disconnected.
    expect([...(retainSessionNotices(notices, previous, new Map([[1, signal]])) ?? []).keys()]).toEqual([1]);
    // The daemon restarted: label 1 now names a session created later, label 2 one of another kind.
    const restarted = new Map([
      [1, { ...signal, createdAt: '2026-11-15T09:00:00Z' }],
      [2, { ...cron, source: { kind: 'web' as const } }],
    ]);
    expect(retainSessionNotices(notices, previous, restarted)?.size).toBe(0);
    expect(isSameSession(signal, busy)).toBe(true);
    expect(isSameSession(signal, restarted.get(1) ?? signal)).toBe(false);
  });

  it(`keeps the newest ${MAX_SESSION_NOTICES} notices of a session`, () => {
    const many = Array.from({ length: MAX_SESSION_NOTICES + 5 }, (_, index) => ({
      kind: 'policy_stale' as const,
      message: `warning ${index}`,
    }));
    const entries = addSessionNotices(undefined, many);
    expect(entries).toHaveLength(MAX_SESSION_NOTICES);
    expect(entries[0].notice).toEqual(many[5]);
  });
});

describe('describeSessionNotice', () => {
  it('names the unavailable MCP server and why', () => {
    expect(describeSessionNotice(UNAVAILABLE)).toEqual({
      title: 'MCP server "github" is unavailable',
      detail: 'Its tools cannot be used in this session: MCP error -32000: Connection closed',
    });
  });

  it('shows host-mount findings with their counts, paths and what to do', () => {
    const { title, detail } = describeSessionNotice(HOST_FILES);
    expect(title).toBe("Setuid/setgid or root-owned files in the agent's host mounts (after agent turn)");
    expect(detail.split('\n')).toEqual([
      '1 setuid/setgid file IronCurtain could not neutralize, 2 root-owned entries.',
      '/home/u/project/bin/shell',
      'Remove them as root (for example with sudo rm).',
    ]);
  });

  it('shows the stale-policy warning as it was reported', () => {
    expect(describeSessionNotice(STALE)).toEqual({ title: 'The compiled policy may be stale', detail: STALE.message });
  });
});

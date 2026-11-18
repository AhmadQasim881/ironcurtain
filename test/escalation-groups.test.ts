/**
 * Grouped approval: pending escalations sharing one whitelist pattern can be
 * approved together, but only through a confirmation that lists every
 * member, and only while the reviewed set is still exactly the group.
 *
 * Covers the shared grouping rules, the unambiguous pattern key the
 * pipeline stamps on candidates, and every front-end that offers it: the
 * mux (manager + confirmation screen), the standalone listener (code-bound
 * confirmation) and the web UI dispatch (`escalations.approveGroup`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  escalationGroupKey,
  escalationGroupPattern,
  escalationGroups,
  groupMembers,
} from '../src/escalation/escalation-groups.js';
import {
  extractWhitelistCandidates,
  whitelistPatternKey,
  type WhitelistConstraint,
} from '../src/trusted-process/approval-whitelist.js';
import { atomicWriteJsonSync, type EscalationWatcher } from '../src/escalation/escalation-watcher.js';
import { groupApprovalCode, handleCommand } from '../src/escalation/listener-command.js';
import { addEscalation, addSession, createInitialState, type ListenerState } from '../src/escalation/listener-state.js';
import { createMuxInputHandler } from '../src/mux/mux-input-handler.js';
import {
  bulkApprovalKey,
  ESCALATION_ARMING_DELAY_MS,
  reconcileEscalationUi,
  type BulkApproveState,
} from '../src/mux/escalation-picker-state.js';
import type { PendingRef } from '../src/mux/types.js';
import type { EscalationRequest } from '../src/session/types.js';
import { SessionManager, type PendingEscalationData } from '../src/session/session-manager.js';
import type { Session } from '../src/session/types.js';
import type { Transport } from '../src/session/transport.js';
import { escalationDispatch } from '../src/web-ui/dispatch/escalation-dispatch.js';
import type { DispatchContext } from '../src/web-ui/dispatch/types.js';
import { RpcError } from '../src/web-ui/web-ui-types.js';
import { resolveStoredAnnotation } from '../src/types/argument-roles.js';
import { EscalationExpiredError } from '../src/types/errors.js';
import { testToolAnnotations, TEST_SANDBOX_DIR } from './fixtures/test-policy.js';

// Registry polling is not exercised here; keep the mux manager off the real home.
vi.mock('../src/escalation/session-registry.js', () => ({
  readActiveRegistrations: vi.fn().mockReturnValue([]),
}));
vi.mock('../src/config/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/paths.js')>()),
  getListenerLockPath: vi.fn().mockReturnValue('/tmp/nonexistent-lock'),
  getPtyRegistryDir: vi.fn().mockReturnValue('/tmp/nonexistent-registry'),
}));

// Imported after the mocks above.
const { createMuxEscalationManager } = await import('../src/mux/mux-escalation-manager.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The exact pattern of a write to `<dir>/app.ts`: what `/approve+` whitelists, and the group key. */
const exactKey = (dir: string): string =>
  whitelistPatternKey('filesystem', 'write_file', [{ kind: 'path', role: 'write-path', path: `${dir}/app.ts` }]);
/** The directory-wide pattern of the same write (`/approve+dir`): never a group key. */
const directoryKey = (dir: string): string =>
  whitelistPatternKey('filesystem', 'write_file', [{ kind: 'directory', role: 'write-path', directory: dir }]);

const KEY_SRC = exactKey('/work/src');
const KEY_DOCS = exactKey('/work/docs');

/**
 * A write escalation to `<dir>/app.ts` with the candidates the pipeline
 * offers: the exact pattern first, carrying `patternKey` (the group key), then
 * the directory-wide one. The content tells the members apart.
 */
function groupedRequest(escalationId: string, patternKey: string | undefined, dir = '/work/src'): EscalationRequest {
  return {
    escalationId,
    serverName: 'filesystem',
    toolName: 'write_file',
    arguments: { path: `${dir}/app.ts`, content: escalationId },
    reason: 'Write outside the sandbox',
    whitelistCandidates: [
      {
        description: `Allow filesystem/write_file write-path ${dir}/app.ts`,
        scope: 'exact',
        ...(patternKey ? { patternKey } : {}),
      },
      {
        description: `Allow filesystem/write_file write-path within ${dir} (recursive)`,
        scope: 'directory',
        patternKey: directoryKey(dir),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Grouping rules
// ---------------------------------------------------------------------------

describe('escalation grouping rules', () => {
  it('groups by the first (exact) candidate pattern key; never a human-only or keyless escalation', () => {
    expect(escalationGroupKey(groupedRequest('a', KEY_SRC))).toBe(KEY_SRC);
    expect(escalationGroupPattern(groupedRequest('a', KEY_SRC))).toEqual({
      description: 'Allow filesystem/write_file write-path /work/src/app.ts',
      patternKey: KEY_SRC,
    });
    // The directory-wide candidate's key never stands in for a missing exact one.
    expect(escalationGroupKey(groupedRequest('a', undefined))).toBeUndefined();
    expect(escalationGroupKey({ ...groupedRequest('a', KEY_SRC), humanOnly: true })).toBeUndefined();
    expect(escalationGroupKey({ whitelistCandidates: [] })).toBeUndefined();
    // A request written before candidates had scopes: its first candidate is the one /approve+ selects.
    expect(escalationGroupKey({ whitelistCandidates: [{ description: 'a', patternKey: KEY_SRC }] })).toBe(KEY_SRC);
    expect(
      escalationGroupKey({
        whitelistCandidates: [
          { description: 'a', patternKey: KEY_SRC },
          { description: 'b', patternKey: KEY_DOCS },
        ],
      }),
    ).toBe(KEY_SRC);
    // A first candidate that is not the exact one never groups.
    expect(
      escalationGroupKey({ whitelistCandidates: [{ description: 'd', scope: 'directory', patternKey: KEY_SRC }] }),
    ).toBeUndefined();
    expect(
      escalationGroupKey({ whitelistCandidates: [{ description: 'd', scope: 'wider', patternKey: KEY_SRC }] }),
    ).toBeUndefined();
    // Request files are parsed without a schema.
    expect(
      escalationGroupKey({ whitelistCandidates: [{ description: 'x', patternKey: 42 as unknown as string }] }),
    ).toBe(undefined);
  });

  it('never groups calls that only share a directory-wide candidate', () => {
    // Two writes to different files in one directory: the same directory-wide
    // pattern (/approve+dir), different exact ones. Widening to a directory is
    // chosen one escalation at a time, so these are no group.
    const write = (id: string, file: string): EscalationRequest => ({
      ...groupedRequest(id, undefined),
      arguments: { path: `/work/src/${file}`, content: id },
      whitelistCandidates: [
        {
          description: `Allow filesystem/write_file write-path /work/src/${file}`,
          scope: 'exact',
          patternKey: whitelistPatternKey('filesystem', 'write_file', [
            { kind: 'path', role: 'write-path', path: `/work/src/${file}` },
          ]),
        },
        {
          description: 'Allow filesystem/write_file write-path within /work/src (recursive)',
          scope: 'directory',
          patternKey: directoryKey('/work/src'),
        },
      ],
    });
    const requests = [write('a', 'a.ts'), write('b', 'b.ts')];
    expect(escalationGroups(requests, (r) => r)).toEqual([]);
    expect(escalationGroupKey(requests[0])).not.toBe(directoryKey('/work/src'));
  });

  it('tolerates any malformed candidate list without throwing, and never groups it', () => {
    const malformed: unknown[] = [
      { length: 1, 0: { description: 'x', patternKey: KEY_SRC } }, // array-like, not an array
      'k',
      [null],
      ['not an object'],
      [{ patternKey: KEY_SRC }], // no description
      [{ description: 42, patternKey: KEY_SRC }],
      [{ description: 'x', patternKey: '' }],
    ];
    for (const whitelistCandidates of malformed) {
      const request = { whitelistCandidates } as unknown as EscalationRequest;
      expect(() => escalationGroupKey(request)).not.toThrow();
      expect(escalationGroupKey(request)).toBeUndefined();
      expect(escalationGroups([request, request], (r) => r)).toEqual([]);
    }
  });

  it('lists only groups of two or more, members in input order', () => {
    const requests = [
      groupedRequest('a', KEY_SRC),
      groupedRequest('b', KEY_DOCS, '/work/docs'),
      groupedRequest('c', KEY_SRC),
      groupedRequest('d', undefined),
    ];
    const groups = escalationGroups(requests, (r) => r);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(KEY_SRC);
    expect(groups[0].members.map((r) => r.escalationId)).toEqual(['a', 'c']);
    expect(groupMembers(requests, (r) => r, KEY_DOCS).map((r) => r.escalationId)).toEqual(['b']);
  });

  it('pattern keys are unambiguous where descriptions collide, and independent of constraint order', () => {
    // A directory name can contain the description's label separator: these
    // two different patterns read the same, but never share a key.
    const crafted: WhitelistConstraint[] = [
      { kind: 'directory', role: 'write-path', directory: '/tmp/x, write-path within /etc' },
    ];
    const two: WhitelistConstraint[] = [
      { kind: 'directory', role: 'write-path', directory: '/tmp/x' },
      { kind: 'directory', role: 'write-path', directory: '/etc' },
    ];
    const label = (c: readonly WhitelistConstraint[]): string =>
      c.map((x) => (x.kind === 'directory' ? `${x.role} within ${x.directory}` : '')).join(', ');
    expect(label(crafted)).toBe(label(two));
    expect(whitelistPatternKey('filesystem', 'move_file', crafted)).not.toBe(
      whitelistPatternKey('filesystem', 'move_file', two),
    );
    expect(whitelistPatternKey('filesystem', 'move_file', two)).toBe(
      whitelistPatternKey('filesystem', 'move_file', [...two].reverse()),
    );
  });

  it('the pipeline stamps each candidate with its pattern key; the exact one is the group key', () => {
    const stored = testToolAnnotations.servers.filesystem.tools.find((t) => t.toolName === 'write_file');
    expect(stored).toBeDefined();
    const args = { path: '/etc/app/settings.conf', content: 'x' };
    const annotation = resolveStoredAnnotation(stored as NonNullable<typeof stored>, args);
    const { ipcs } = extractWhitelistCandidates(
      'filesystem',
      'write_file',
      args,
      annotation,
      { escalatedRoles: ['write-path'], allowedDirectory: TEST_SANDBOX_DIR },
      'esc-1',
      'reason',
    );
    const exact = whitelistPatternKey('filesystem', 'write_file', [
      { kind: 'path', role: 'write-path', path: '/etc/app/settings.conf' },
    ]);
    expect(ipcs.map((ipc) => [ipc.scope, ipc.patternKey])).toEqual([
      ['exact', exact],
      [
        'directory',
        whitelistPatternKey('filesystem', 'write_file', [
          { kind: 'directory', role: 'write-path', directory: '/etc/app' },
        ]),
      ],
    ]);
    expect(escalationGroupKey({ whitelistCandidates: ipcs })).toBe(exact);
  });
});

// ---------------------------------------------------------------------------
// Mux: manager
// ---------------------------------------------------------------------------

async function waitForPendingCount(manager: { readonly pendingCount: number }, expected: number): Promise<void> {
  for (let i = 0; i < 200 && manager.pendingCount < expected; i++) await new Promise((r) => setTimeout(r, 25));
  expect(manager.pendingCount).toBe(expected);
}

describe('mux escalation manager: approve group', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'ic-mux-group-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** One mux session per name; `raise` writes a request file and waits for it to surface. */
  function session(manager: ReturnType<typeof createMuxEscalationManager>, name: string) {
    const escalationDir = resolve(tempDir, name);
    mkdirSync(escalationDir, { recursive: true });
    manager.addSession({
      sessionId: `session-${name}`,
      escalationDir,
      label: name,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });
    return {
      escalationDir,
      async raise(request: EscalationRequest): Promise<void> {
        const before = manager.pendingCount;
        atomicWriteJsonSync(resolve(escalationDir, `request-${request.escalationId}.json`), request);
        await waitForPendingCount(manager, before + 1);
      },
      response(id: string): Record<string, unknown> | undefined {
        const path = resolve(escalationDir, `response-${id}.json`);
        return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>) : undefined;
      },
    };
  }

  async function threeSessions(manager: ReturnType<typeof createMuxEscalationManager>) {
    const a = session(manager, 'a');
    const b = session(manager, 'b');
    const c = session(manager, 'c');
    await a.raise(groupedRequest('esc-a', KEY_SRC));
    await b.raise(groupedRequest('esc-b', KEY_DOCS, '/work/docs'));
    await c.raise(groupedRequest('esc-c', KEY_SRC));
    return { a, b, c };
  }

  it('groupOf names the members sharing the pattern, and pendingRefs carries the group key', async () => {
    const manager = createMuxEscalationManager();
    try {
      await threeSessions(manager);
      const [first, second, third] = manager.pendingRefs();
      expect(first.groupKey).toBe(KEY_SRC);
      expect(second.groupKey).toBe(KEY_DOCS);
      const group = manager.groupOf(first.displayNumber);
      expect(group?.key).toBe(KEY_SRC);
      expect(group?.description).toBe('Allow filesystem/write_file write-path /work/src/app.ts');
      expect(group?.members.map((r) => r.escalationId)).toEqual(['esc-a', 'esc-c']);
      expect(manager.groupOf(third.displayNumber)?.members).toHaveLength(2);
      expect(manager.groupOf(999)).toBeUndefined();
    } finally {
      manager.stop();
    }
  });

  it('approves exactly the reviewed group, once each, and leaves everything else pending', async () => {
    const manager = createMuxEscalationManager();
    try {
      const { a, b, c } = await threeSessions(manager);
      const group = manager.groupOf(manager.pendingRefs()[0].displayNumber);
      expect(group).toBeDefined();

      const message = manager.approveGroup(group?.members ?? [], KEY_SRC);

      expect(message).toContain('APPROVED');
      expect(a.response('esc-a')).toEqual({ decision: 'approved' });
      expect(c.response('esc-c')).toEqual({ decision: 'approved' });
      expect(b.response('esc-b')).toBeUndefined();
      expect(manager.pendingRefs().map((r) => r.escalationId)).toEqual(['esc-b']);
    } finally {
      manager.stop();
    }
  });

  it('refuses, approving nothing, when the group changed since it was listed', async () => {
    const manager = createMuxEscalationManager();
    try {
      const { a, c } = await threeSessions(manager);
      const reviewed = manager.groupOf(manager.pendingRefs()[0].displayNumber)?.members ?? [];
      const d = session(manager, 'd');
      await d.raise(groupedRequest('esc-d', KEY_SRC)); // a new member arrives

      expect(manager.approveGroup(reviewed, KEY_SRC)).toBe(
        "Nothing was approved: the group's escalations changed since they were listed. Review the group again.",
      );
      expect(a.response('esc-a')).toBeUndefined();
      expect(c.response('esc-c')).toBeUndefined();
      expect(d.response('esc-d')).toBeUndefined();

      // A reviewed set naming a non-member, or only part of the group, is refused too.
      const members = manager.groupOf(reviewed[0].displayNumber)?.members ?? [];
      const other = manager.pendingRefs().find((r) => r.escalationId === 'esc-b') as PendingRef;
      expect(manager.approveGroup([...members.slice(0, 2), other], KEY_SRC)).toContain('Nothing was approved');
      expect(manager.approveGroup(members.slice(0, 2), KEY_SRC)).toContain('Nothing was approved');
      expect(manager.approveGroup([], KEY_SRC)).toContain('Nothing was approved');
      expect(manager.pendingCount).toBe(4);
    } finally {
      manager.stop();
    }
  });

  it('/approve+ group whitelists the exact pattern of each member, never the directory-wide one', async () => {
    const manager = createMuxEscalationManager();
    try {
      const { a, b, c } = await threeSessions(manager);
      const group = manager.groupOf(manager.pendingRefs()[0].displayNumber);

      const message = manager.approveGroup(group?.members ?? [], KEY_SRC, { whitelist: true });

      expect(message).toContain('(whitelisted)');
      expect(message).not.toContain('directory-wide');
      // Index 0 is the exact candidate; the directory-wide one sits at index 1.
      expect(a.response('esc-a')).toEqual({ decision: 'approved', whitelistSelection: 0 });
      expect(c.response('esc-c')).toEqual({ decision: 'approved', whitelistSelection: 0 });
      expect(b.response('esc-b')).toBeUndefined();
    } finally {
      manager.stop();
    }
  });

  it('a human-only escalation never joins a group, even with a keyed candidate', async () => {
    const manager = createMuxEscalationManager();
    try {
      const a = session(manager, 'a');
      const h = session(manager, 'h');
      await a.raise(groupedRequest('esc-a', KEY_SRC));
      await h.raise({ ...groupedRequest('esc-h', KEY_SRC), humanOnly: true });
      const [first, second] = manager.pendingRefs();
      expect(second.groupKey).toBeUndefined();
      expect(manager.groupOf(first.displayNumber)?.members.map((r) => r.escalationId)).toEqual(['esc-a']);
      expect(manager.groupOf(second.displayNumber)).toBeUndefined();
      expect(manager.approveGroup([first, second], KEY_SRC)).toContain('Nothing was approved');
      expect(h.response('esc-h')).toBeUndefined();
    } finally {
      manager.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Mux: confirmation screen
// ---------------------------------------------------------------------------

describe('mux approve-group confirmation screen', () => {
  const GROUP = { key: KEY_SRC, description: 'Allow filesystem/write_file write-path /work/src/app.ts' };
  const member = (n: number): PendingRef => ({ displayNumber: n, escalationId: `esc-${n}`, groupKey: KEY_SRC });
  const other = (n: number): PendingRef => ({ displayNumber: n, escalationId: `esc-${n}`, groupKey: KEY_DOCS });
  const REVIEWED = [member(1), member(3)];

  function openGroupScreen() {
    let time = 100_000;
    const clock = { now: () => time, advance: (ms: number) => (time += ms) };
    const handler = createMuxInputHandler({
      initialMode: 'command',
      now: clock.now,
      displayedBulkApproval: () => ({ setKey: bulkApprovalKey(REVIEWED, false), seenAllSince: 0 }),
    });
    handler.enterBulkApproveConfirm(REVIEWED, false, 'command', GROUP);
    return { handler, clock };
  }

  it('opens disarmed; y approves nothing before the arming delay', () => {
    const { handler, clock } = openGroupScreen();
    expect(handler.mode).toBe('escalation-approve-all');
    expect(handler.bulkApproveState?.group).toEqual(GROUP);
    clock.advance(200);
    expect(handler.handleKey('y')).toEqual({ kind: 'redraw-picker' });
  });

  it('y, once armed and seen, approves exactly the listed members and names the group', () => {
    const { handler, clock } = openGroupScreen();
    clock.advance(ESCALATION_ARMING_DELAY_MS + 1);
    expect(handler.handleKey('y')).toEqual({
      kind: 'escalation-approve-reviewed',
      reviewed: REVIEWED,
      whitelist: false,
      groupKey: KEY_SRC,
    });
  });

  it('an arrival outside the group leaves the screen open; a change to the group closes it', () => {
    const bulk: BulkApproveState = {
      reviewed: REVIEWED,
      group: GROUP,
      whitelist: false,
      previousMode: 'command',
      scrollOffset: 0,
      armedAt: 0,
    };
    const state = { mode: 'escalation-approve-all' as const, picker: null, bulk };

    expect(reconcileEscalationUi(state, [member(1), other(2), member(3)], 0).outcome).toBe('unchanged');

    const arrival = reconcileEscalationUi(state, [member(1), other(2), member(3), member(4)], 0);
    expect(arrival.outcome).toBe('bulk-cancelled');
    expect(arrival.next.bulk).toBeNull();
    expect(arrival.next.mode).toBe('command');
    expect(arrival.message).toContain('/approve group N');

    expect(reconcileEscalationUi(state, [member(1), other(2)], 0).outcome).toBe('bulk-cancelled');
  });
});

// ---------------------------------------------------------------------------
// Standalone listener
// ---------------------------------------------------------------------------

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

function listenerState(resolutions: Resolution[], requests: readonly EscalationRequest[]): ListenerState {
  let state = createInitialState();
  requests.forEach((request, index) => {
    const sessionId = `session-${index}`;
    state = addSession(
      state,
      {
        sessionId,
        escalationDir: `/tmp/ic-listener-group/${index}`,
        label: `session ${index}`,
        startedAt: new Date().toISOString(),
        pid: process.pid,
      },
      recordingWatcher(resolutions),
    );
    state = addEscalation(state, sessionId, request);
  });
  return state;
}

describe('escalation listener: approve group', () => {
  const requests = [
    groupedRequest('esc-a', KEY_SRC),
    groupedRequest('esc-b', KEY_DOCS, '/work/docs'),
    groupedRequest('esc-c', KEY_SRC),
  ];

  it('without a code it approves nothing and lists exactly the group with its code', () => {
    const resolutions: Resolution[] = [];
    const state = listenerState(resolutions, requests);

    const result = handleCommand('/approve group 1', state);

    expect(resolutions).toEqual([]);
    const listing = stripVTControlCharacters(result.message ?? '');
    expect(listing).toContain('/approve group 1 would approve these 2 escalations, each once:');
    expect(listing).toContain('Every call matches: Allow filesystem/write_file write-path /work/src/app.ts');
    expect(listing).toContain('[1]');
    expect(listing).toContain('[3]');
    expect(listing).not.toContain('[2]');
    const members = [...state.pendingEscalations.values()].filter((esc) => esc.displayNumber !== 2);
    expect(listing).toContain(`/approve group 1 ${groupApprovalCode(members, KEY_SRC, false)}`);
  });

  it('with the code it approves each member once and nothing else', () => {
    const resolutions: Resolution[] = [];
    const state = listenerState(resolutions, requests);
    const members = [...state.pendingEscalations.values()].filter((esc) => esc.displayNumber !== 2);

    const result = handleCommand(`/approve group 3 ${groupApprovalCode(members, KEY_SRC, false)}`, state);

    expect(resolutions).toEqual([
      { escalationId: 'esc-a', decision: 'approved' },
      { escalationId: 'esc-c', decision: 'approved' },
    ]);
    expect([...result.state.pendingEscalations.values()].map((esc) => esc.request.escalationId)).toEqual(['esc-b']);
  });

  it('a code for an earlier group is refused once the group changed', () => {
    const resolutions: Resolution[] = [];
    const before = listenerState(resolutions, requests);
    const staleCode = groupApprovalCode(
      [...before.pendingEscalations.values()].filter((esc) => esc.displayNumber !== 2),
      KEY_SRC,
      false,
    );
    const after = addEscalation(before, 'session-0', groupedRequest('esc-d', KEY_SRC));

    const result = handleCommand(`/approve group 1 ${staleCode}`, after);

    expect(resolutions).toEqual([]);
    expect(stripVTControlCharacters(result.message ?? '')).toContain("Nothing was approved: the group's escalations");
  });

  it('/approve+ group whitelists the exact pattern of each member; /approve+dir group is refused', () => {
    const resolutions: Resolution[] = [];
    const state = listenerState(resolutions, requests);
    const members = [...state.pendingEscalations.values()].filter((esc) => esc.displayNumber !== 2);

    // A directory-wide pattern is chosen one escalation at a time, never for a group.
    expect(stripVTControlCharacters(handleCommand('/approve+dir group 1', state).message ?? '')).toContain(
      'Directory-wide whitelisting is chosen one escalation at a time',
    );
    expect(resolutions).toEqual([]);

    // A code for the plain approval does not approve with whitelisting.
    const plainCode = groupApprovalCode(members, KEY_SRC, false);
    handleCommand(`/approve+ group 1 ${plainCode}`, state);
    expect(resolutions).toEqual([]);

    handleCommand(`/approve+ group 1 ${groupApprovalCode(members, KEY_SRC, true)}`, state);
    expect(resolutions).toEqual([
      { escalationId: 'esc-a', decision: 'approved', options: { whitelistSelection: 0 } },
      { escalationId: 'esc-c', decision: 'approved', options: { whitelistSelection: 0 } },
    ]);
  });

  it('refuses an escalation that is alone, ungrouped or human-only', () => {
    const resolutions: Resolution[] = [];
    const state = listenerState(resolutions, [
      ...requests,
      groupedRequest('esc-plain', undefined),
      { ...groupedRequest('esc-human', KEY_SRC), humanOnly: true },
    ]);
    expect(stripVTControlCharacters(handleCommand('/approve group 2', state).message ?? '')).toContain(
      'No other pending escalation shares the pattern of #2',
    );
    expect(stripVTControlCharacters(handleCommand('/approve group 4', state).message ?? '')).toContain(
      'is not in a group',
    );
    expect(stripVTControlCharacters(handleCommand('/approve group 5', state).message ?? '')).toContain(
      'is not in a group',
    );
    expect(stripVTControlCharacters(handleCommand('/approve group 99', state).message ?? '')).toContain(
      'No pending escalation #99',
    );
    expect(stripVTControlCharacters(handleCommand('/approve group', state).message ?? '')).toContain(
      'Usage: /approve group <number>',
    );
    expect(resolutions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Web UI: escalations.approveGroup
// ---------------------------------------------------------------------------

describe('web UI escalations.approveGroup', () => {
  it('refuses the whole original group if one member cannot be reviewed completely', async () => {
    const { ctx, sessions } = context();
    ctx.sessionManager.setPendingEscalation(1, {
      ...pending('esc-0', 1, KEY_SRC),
      arguments: { content: 'Example prose. '.repeat(1200) },
    });
    await expect(
      escalationDispatch(ctx, 'escalations.approveGroup', {
        groupKey: KEY_SRC,
        escalationIds: ['esc-0', 'esc-2'],
      }),
    ).rejects.toThrow('can only be denied');
    for (const session of sessions) expect(session.resolveEscalation).not.toHaveBeenCalled();
  });

  function mockSession(): Session {
    return {
      resolveEscalation: vi.fn().mockResolvedValue(undefined),
      getPendingEscalations: vi.fn().mockReturnValue([]),
    } as unknown as Session;
  }
  const transport = { run: vi.fn(), close: vi.fn() } as unknown as Transport;

  function pending(escalationId: string, label: number, groupKey: string | undefined): PendingEscalationData {
    return {
      escalationId,
      sessionLabel: label,
      toolName: 'write_file',
      serverName: 'filesystem',
      arguments: { path: `/work/src/${escalationId}.ts` },
      reason: 'Write outside the sandbox',
      ...(groupKey !== undefined ? { groupKey } : {}),
      receivedAt: new Date().toISOString(),
    };
  }

  function context(): { ctx: DispatchContext; sessions: Session[] } {
    const sessionManager = new SessionManager();
    const sessions = [mockSession(), mockSession(), mockSession()];
    const groupKeys = [KEY_SRC, KEY_DOCS, KEY_SRC];
    sessions.forEach((session, index) => {
      const label = sessionManager.register(session, transport, { kind: 'web' });
      sessionManager.setPendingEscalation(label, pending(`esc-${index}`, label, groupKeys[index]));
    });
    return { ctx: { sessionManager } as unknown as DispatchContext, sessions };
  }

  it('lists the group key with each escalation', async () => {
    const { ctx } = context();
    const listed = (await escalationDispatch(ctx, 'escalations.list', {})) as { groupKey?: string }[];
    expect(listed.map((esc) => esc.groupKey)).toEqual([KEY_SRC, KEY_DOCS, KEY_SRC]);
  });

  it('approves exactly the group the user confirmed', async () => {
    const { ctx, sessions } = context();

    const result = await escalationDispatch(ctx, 'escalations.approveGroup', {
      groupKey: KEY_SRC,
      escalationIds: ['esc-2', 'esc-0'],
    });

    expect(result).toEqual({ approved: ['esc-0', 'esc-2'], failed: [] });
    expect(vi.mocked(sessions[0].resolveEscalation)).toHaveBeenCalledWith('esc-0', 'approved', undefined);
    expect(vi.mocked(sessions[2].resolveEscalation)).toHaveBeenCalledWith('esc-2', 'approved', undefined);
    expect(vi.mocked(sessions[1].resolveEscalation)).not.toHaveBeenCalled();
  });

  it.each([
    ['a member is missing from the reviewed list', ['esc-0']],
    ['the list names an escalation outside the group', ['esc-0', 'esc-1', 'esc-2']],
    ['the list names an escalation that is not pending', ['esc-0', 'esc-2', 'esc-9']],
  ])('refuses, approving nothing, when %s', async (_case, escalationIds) => {
    const { ctx, sessions } = context();
    const call = escalationDispatch(ctx, 'escalations.approveGroup', { groupKey: KEY_SRC, escalationIds });
    await expect(call).rejects.toBeInstanceOf(RpcError);
    await expect(call).rejects.toMatchObject({ code: 'ESCALATION_GROUP_CHANGED' });
    for (const session of sessions) expect(vi.mocked(session.resolveEscalation)).not.toHaveBeenCalled();
  });

  it('rejects a repeated id or an empty list as invalid parameters', async () => {
    const { ctx, sessions } = context();
    await expect(
      escalationDispatch(ctx, 'escalations.approveGroup', { groupKey: KEY_SRC, escalationIds: ['esc-0', 'esc-0'] }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      escalationDispatch(ctx, 'escalations.approveGroup', { groupKey: KEY_SRC, escalationIds: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    for (const session of sessions) expect(vi.mocked(session.resolveEscalation)).not.toHaveBeenCalled();
  });

  it('reports a member that expired meanwhile as ESCALATION_EXPIRED and announces the expiry', async () => {
    const { ctx, sessions } = context();
    const emit = vi.fn();
    const withBus = { ...ctx, eventBus: { emit } } as unknown as DispatchContext;
    vi.mocked(sessions[0].resolveEscalation).mockRejectedValueOnce(new EscalationExpiredError('esc-0'));

    const result = await escalationDispatch(withBus, 'escalations.approveGroup', {
      groupKey: KEY_SRC,
      escalationIds: ['esc-0', 'esc-2'],
    });

    // Never reported as approved: the proxy had already denied the call.
    expect(result).toMatchObject({
      approved: ['esc-2'],
      failed: [{ escalationId: 'esc-0', code: 'ESCALATION_EXPIRED' }],
    });
    expect(emit).toHaveBeenCalledWith('escalation.expired', { escalationId: 'esc-0', sessionLabel: 1 });
  });

  it('reports a member that fails on its own without stopping the others', async () => {
    const { ctx, sessions } = context();
    vi.mocked(sessions[0].resolveEscalation).mockRejectedValueOnce(new Error('expired'));

    const result = await escalationDispatch(ctx, 'escalations.approveGroup', {
      groupKey: KEY_SRC,
      escalationIds: ['esc-0', 'esc-2'],
    });

    expect(result).toMatchObject({ approved: ['esc-2'], failed: [{ escalationId: 'esc-0', message: 'expired' }] });
  });
});

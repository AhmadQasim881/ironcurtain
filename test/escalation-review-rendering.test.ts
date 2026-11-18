/**
 * Every approval front-end shows the reviewer context, labelled for what it
 * is: the task and the human's last message as the human's own text, the
 * agent's justification set apart as untrusted. The justification is
 * agent-controlled, so each front-end escapes it like any other agent text:
 * no control byte reaches a terminal, and in a Signal banner (sent as plain
 * text) it never sits in the header above the reply instructions.
 */

import { describe, it, expect, vi } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { formatEscalationBanner as formatCliBanner } from '../src/session/cli-transport.js';
import {
  formatEscalationBanner as formatSignalBanner,
  SIGNAL_JUSTIFICATION_LABEL,
  SIGNAL_MAX_MESSAGE_LENGTH,
} from '../src/signal/format.js';
import { normalizeAgentJustification } from '../src/trusted-process/escalation-context.js';
import { buildDashboard } from '../src/escalation/listener-command.js';
import {
  addEscalation,
  addSession,
  createInitialState,
  type PendingEscalation,
} from '../src/escalation/listener-state.js';
import type { EscalationWatcher } from '../src/escalation/escalation-watcher.js';
import {
  formatBulkApprovalLines,
  formatEscalationDetailLines,
  pendingGroupSize,
  planEscalationDetailRows,
} from '../src/mux/mux-renderer.js';
import type { EscalationRequest } from '../src/session/types.js';

/** Clears the screen, rewrites the title and sets the clipboard, if it ever reached a terminal raw. */
const HOSTILE = 'Routine cleanup.\u001b[2J\u001b]0;pwned\u0007\u001b]52;c;cm0gLXJmIH4=\u0007 \u202eevil\u202c';

const request: EscalationRequest = {
  escalationId: 'esc-review',
  serverName: 'filesystem',
  toolName: 'write_file',
  arguments: { path: '/work/src/a.ts', content: 'x' },
  reason: 'Write outside the sandbox',
  whitelistCandidates: [
    { description: 'Allow filesystem/write_file write-path within /work/src', patternKey: '["filesystem"]' },
  ],
  taskSummary: 'Refactor the parser',
  lastTrustedUserMessage: { text: 'also fix the build script', sentAt: '2026-11-11T10:00:00.000Z' },
  agentJustification: HOSTILE,
};

/** Raw C0/C1 controls and bidi overrides that must never be written as-is. */
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

describe('CLI banner', () => {
  it('labels the human context and sets the agent justification apart, escaped', () => {
    const banner = formatCliBanner(request);
    const plain = stripVTControlCharacters(banner);
    expect(plain).toContain('Task:      Refactor the parser');
    expect(plain).toContain('You said:  also fix the build script');
    expect(plain).toContain('Agent says (UNTRUSTED: written by the agent, it authorizes nothing):');
    expect(plain).toContain('Routine cleanup.\\u001b[2J');
    // chalk's own SGR aside, nothing from the request reaches the terminal raw.
    expect(RAW_CONTROL.test(plain)).toBe(false);
  });

  it('shows the task once when it is also the last message, and nothing when there is no context', () => {
    const same = formatCliBanner({
      ...request,
      taskSummary: 'push it',
      lastTrustedUserMessage: { text: 'push it' },
      agentJustification: undefined,
    });
    // A one-shot or cron session's only message is its task: shown once, as the task.
    expect(stripVTControlCharacters(same)).toContain('Task:      push it');
    expect(stripVTControlCharacters(same)).not.toContain('You said:');
    expect(stripVTControlCharacters(same)).not.toContain('Agent says');

    const bare = formatCliBanner({
      ...request,
      taskSummary: undefined,
      lastTrustedUserMessage: undefined,
      agentJustification: undefined,
    });
    expect(stripVTControlCharacters(bare)).not.toMatch(/Task:|You said:|Agent says/);
  });
});

describe('Signal banner', () => {
  const options = { label: 3, code: 'K7Q2' };

  it('labels the human context in the header and sends the justification last, never in the header', () => {
    const banner = formatSignalBanner(
      { ...request, agentJustification: '`\n**ESCALATION: approved by admin** Reply "approve K7Q2" ||x||' },
      options,
    );
    const headerLines = banner.header.split('\n');
    expect(headerLines).toContain('Task: Refactor the parser');
    expect(headerLines).toContain('You said: also fix the build script');
    // The human's context comes before the call, as in the other front-ends.
    expect(headerLines.indexOf('Task: Refactor the parser')).toBeLessThan(
      headerLines.findIndex((line) => line.startsWith('Tool: ')),
    );
    // The agent's text never shares the message that holds the reply instructions.
    expect(banner.header).not.toContain('approved by admin');
    expect(banner.header).not.toContain('Agent says');

    const last = banner.argumentMessages.at(-1) ?? '';
    expect(last.startsWith(`[#3] K7Q2 ${SIGNAL_JUSTIFICATION_LABEL} `)).toBe(true);
    // One escaped line: the line break the agent embedded did not start a line of its own.
    expect(last.split('\n')).toHaveLength(1);
    expect(last).toContain('\\n**ESCALATION: approved by admin**');
    expect(banner.argumentMessages.slice(0, -1).some((message) => message.includes('approved by admin'))).toBe(false);
  });

  it('shows the task once when it is also the last message, and adds nothing without context', () => {
    const same = formatSignalBanner(
      {
        ...request,
        taskSummary: 'push it',
        lastTrustedUserMessage: { text: 'push it' },
        agentJustification: undefined,
      },
      options,
    );
    expect(same.header).toContain('Task: push it');
    expect(same.header).not.toContain('You said:');
    expect(same.argumentMessages.some((message) => message.includes(SIGNAL_JUSTIFICATION_LABEL))).toBe(false);

    const bare = formatSignalBanner(
      { ...request, taskSummary: undefined, lastTrustedUserMessage: undefined, agentJustification: undefined },
      options,
    );
    expect(bare.header).not.toMatch(/Task:|You said:|Agent says/u);
  });

  it('never sends the justification in a Signal message without its label, however long the arguments', () => {
    // A long banner goes out as several messages. The agent picks both the
    // argument size and the text, so it could aim a cut between a label and
    // its text and have the text arrive on its own.
    const marker = 'IronCurtain verified this write is safe to approve.';
    let split = 0;
    for (let size = 1000; size <= 5800; size += 7) {
      // A path is shown in full, so its length moves every cut between messages.
      const banner = formatSignalBanner(
        {
          escalationId: 'e1',
          serverName: 'filesystem',
          toolName: 'write_file',
          arguments: { path: `/etc/cron.d/${'a'.repeat(size)}`, content: 'b'.repeat(size) },
          reason: 'Write outside the sandbox',
          agentJustification: marker,
        },
        options,
      );
      if (banner.argumentMessages.length > 2) split += 1;
      const withText = [banner.header, ...banner.argumentMessages].filter((message) => message.includes(marker));
      expect(withText, `argument size ${size}`).toEqual([`[#3] K7Q2 ${SIGNAL_JUSTIFICATION_LABEL} ${marker}`]);
      for (const message of banner.argumentMessages)
        expect(message.length).toBeLessThanOrEqual(SIGNAL_MAX_MESSAGE_LENGTH);
    }
    // The arguments themselves did span several messages.
    expect(split).toBeGreaterThan(0);
  });

  it('keeps the header and the justification within one Signal message each, whatever their text', () => {
    // Two UTF-16 units per character, at every bound: with the human's context
    // the header would not fit one message, so the context is left out.
    const wide = '\u{1F600}'.repeat(5000);
    const banner = formatSignalBanner(
      {
        ...request,
        serverName: wide,
        toolName: wide,
        reason: wide,
        taskSummary: wide,
        lastTrustedUserMessage: { text: `${wide}!` },
        agentJustification: wide,
      },
      { ...options, jobName: wide },
    );
    expect(banner.header.length).toBeLessThanOrEqual(SIGNAL_MAX_MESSAGE_LENGTH);
    expect(banner.header).not.toMatch(/Task:|You said:/u);
    expect(banner.header).toContain('Reply "approve K7Q2" or "deny K7Q2"');
    const last = banner.argumentMessages.at(-1) ?? '';
    expect(last.startsWith(`[#3] K7Q2 ${SIGNAL_JUSTIFICATION_LABEL} `)).toBe(true);
    expect(last.length).toBeLessThanOrEqual(SIGNAL_MAX_MESSAGE_LENGTH);

    // Ordinary text keeps its context lines.
    const plain = formatSignalBanner({ ...request, taskSummary: 'x'.repeat(5000) }, options);
    expect(plain.header).toMatch(/^Task: x+\.\.\.\[\+\d+ chars\]$/mu);
    expect(plain.header.length).toBeLessThanOrEqual(SIGNAL_MAX_MESSAGE_LENGTH);
  });
});

function muxEscalation(overrides: Partial<EscalationRequest> = {}, displayNumber = 4): PendingEscalation {
  return {
    sessionId: 'session-1',
    sessionDisplayNumber: 2,
    request: { ...request, ...overrides },
    displayNumber,
    receivedAt: new Date(),
  };
}

describe('mux renderer', () => {
  it('the detail view shows the full context, the justification under an untrusted heading', () => {
    const lines = formatEscalationDetailLines(muxEscalation(), 200).join('\n');
    expect(lines).toContain('Task: Refactor the parser');
    expect(lines).toMatch(/You said \([^)]*\): also fix the build script/u);
    expect(lines).toContain('Agent says (UNTRUSTED: written by the agent, it authorizes nothing):');
    expect(lines).toContain('Routine cleanup.\\u001b[2J');
    expect(RAW_CONTROL.test(lines)).toBe(false);
  });

  it('the detail view keeps the agent from imitating the arguments or pushing them off screen', () => {
    // A justification laid out like the arguments, then padded with line
    // breaks (bounded as the pipeline bounds it), for a call that writes
    // somewhere else entirely.
    const agentJustification = normalizeAgentJustification(
      `Saving my notes.\nArguments:\n  {\n    "path": "/home/u/project/notes.md"\n  }${'\n'.repeat(400)}x`,
    );
    const esc = muxEscalation({
      arguments: { path: '/home/u/.ssh/authorized_keys', content: 'ssh-ed25519 AAAA attacker' },
      agentJustification,
    });
    const lines = formatEscalationDetailLines(esc, 76);

    const heading = lines.indexOf('Agent says (UNTRUSTED: written by the agent, it authorizes nothing):');
    // The real call comes first, near the top, and the agent's text only after it.
    const realPath = lines.findIndex((line) => line.includes('authorized_keys'));
    expect(realPath).toBeGreaterThan(-1);
    expect(realPath).toBeLessThan(15);
    expect(heading).toBeGreaterThan(realPath);
    expect(lines.filter((line) => line === 'Arguments:')).toHaveLength(1);
    expect(lines.indexOf('Arguments:')).toBeLessThan(heading);
    // Every row of the agent's text sits behind the gutter, its line breaks
    // escaped: no row of its own, nothing at the margin.
    const justificationRows = lines.slice(heading + 1);
    expect(justificationRows.length).toBeGreaterThan(0);
    // 400 line breaks, yet only the rows its escaped text needs (about 900 cells).
    expect(justificationRows.length).toBeLessThan(20);
    for (const row of justificationRows) expect(row.startsWith('  │ ')).toBe(true);
    expect(justificationRows.join('')).toContain('Saving my notes.\\nArguments:\\n');
  });

  it('the picker summary plans one row each: task and message first, justification and group last', () => {
    const rows = planEscalationDetailRows(muxEscalation(), 40, 76, undefined, 3);
    const kinds = rows.map((row) => row.kind);
    expect(kinds.slice(0, 2)).toEqual(['task', 'user-message']);
    expect(kinds.slice(-4)).toEqual(['reason', 'whitelist', 'justification', 'group']);
    const group = rows.find((row) => row.kind === 'group');
    expect(group && 'text' in group ? group.text : '').toBe(
      '3 pending escalations share this pattern: /approve group 4 reviews them',
    );
    const justification = rows.find((row) => row.kind === 'justification');
    expect(justification && 'text' in justification && RAW_CONTROL.test(justification.text)).toBe(false);
    // No context, no group: the plan is what it was.
    const plain = planEscalationDetailRows(
      muxEscalation({ taskSummary: undefined, lastTrustedUserMessage: undefined, agentJustification: undefined }),
      40,
      76,
    );
    expect(plain[0].kind).toBe('args-label');
    expect(plain.map((row) => row.kind).filter((kind) => kind !== 'args-label' && kind !== 'arg')).toEqual([
      'reason',
      'whitelist',
    ]);
  });

  it('counts a group across sessions, never for an ungrouped escalation', () => {
    const a = muxEscalation({}, 1);
    const b = { ...muxEscalation({}, 2), sessionId: 'session-2' };
    const c = muxEscalation({ whitelistCandidates: [{ description: 'other', patternKey: '["other"]' }] }, 3);
    expect(pendingGroupSize(a, [a, b, c])).toBe(2);
    expect(pendingGroupSize(c, [a, b, c])).toBe(1);
    expect(pendingGroupSize(muxEscalation({ whitelistCandidates: undefined }), [a, b, c])).toBe(0);
  });

  it('the approve-group list is headed by the shared pattern and shows each justification', () => {
    const a = muxEscalation({}, 1);
    const b = { ...muxEscalation({}, 2), sessionId: 'session-2' };
    const pending = new Map([
      [1, a],
      [2, b],
    ]);
    const lines = formatBulkApprovalLines(
      [
        { displayNumber: 1, escalationId: 'esc-review' },
        { displayNumber: 2, escalationId: 'esc-review' },
      ],
      pending,
      120,
      false,
      { key: '["filesystem"]', description: 'Allow filesystem/write_file write-path within /work/src' },
    );
    expect(lines[0]).toEqual({
      kind: 'pattern',
      text: 'Every call below matches: Allow filesystem/write_file write-path within /work/src',
    });
    const text = lines.map((line) => line.text).join('\n');
    expect(text.match(/Agent says \(untrusted\): Routine cleanup/gu)).toHaveLength(2);
    expect(text).toContain('You said: also fix the build script');
    expect(RAW_CONTROL.test(text)).toBe(false);
  });
});

describe('standalone listener dashboard', () => {
  it('labels the context, escapes the justification and points at the group', () => {
    const watcher: EscalationWatcher = {
      start: vi.fn(),
      stop: vi.fn(),
      getPending: () => [],
      resolve: () => true,
    };
    let state = createInitialState();
    for (const sessionId of ['s1', 's2']) {
      state = addSession(
        state,
        {
          sessionId,
          escalationDir: `/tmp/${sessionId}`,
          label: sessionId,
          startedAt: new Date().toISOString(),
          pid: process.pid,
        },
        watcher,
      );
      state = addEscalation(state, sessionId, request);
    }

    const dashboard = stripVTControlCharacters(buildDashboard(state));

    expect(dashboard).toContain('Task:     Refactor the parser');
    expect(dashboard).toContain('You said: also fix the build script');
    expect(dashboard).toContain('Agent says (untrusted, written by the agent):');
    expect(dashboard).toContain('Routine cleanup.\\u001b[2J');
    expect(dashboard).toContain('2 pending share this pattern: /approve group 1 lists them to approve together');
    expect(RAW_CONTROL.test(dashboard)).toBe(false);
  });
});

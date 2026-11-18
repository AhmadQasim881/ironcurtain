import { describe, it, expect } from 'vitest';
import { createMuxInputHandler } from '../src/mux/mux-input-handler.js';
import {
  bulkApprovalKey,
  ESCALATION_ARMING_DELAY_MS,
  type DisplayedEscalation,
  type EscalationView,
} from '../src/mux/escalation-picker-state.js';
import type { MuxAction, PendingRef } from '../src/mux/types.js';
import { createPersonaName } from '../src/persona/types.js';
import type { PersonaSnapshot } from '../src/mux/persona-scanner.js';
import type { ProviderProfileSnapshot } from '../src/mux/provider-profile-snapshot.js';

/** A clock the test moves by hand (the handler's `now` option). */
function fakeClock(start = 100_000): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

/** Just past the arming delay. */
const ARMED = ESCALATION_ARMING_DELAY_MS + 1;

/** Escalation `n` as the picker refers to it. */
function ref(displayNumber: number): PendingRef {
  return { displayNumber, escalationId: `esc-${displayNumber}` };
}

describe('MuxInputHandler', () => {
  describe('initialMode option', () => {
    it('starts in command mode when initialMode is "command"', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      expect(handler.mode).toBe('command');
    });

    it('starts in PTY mode when initialMode is "pty"', () => {
      const handler = createMuxInputHandler({ initialMode: 'pty' });
      expect(handler.mode).toBe('pty');
    });
  });

  describe('PTY mode (default)', () => {
    it('starts in PTY mode', () => {
      const handler = createMuxInputHandler();
      expect(handler.mode).toBe('pty');
    });

    it('forwards regular keys as write-pty actions', () => {
      const handler = createMuxInputHandler();
      const action = handler.handleKey('a');
      expect(action).toEqual({ kind: 'write-pty', data: 'a' });
    });

    it('Ctrl-A enters command mode', () => {
      const handler = createMuxInputHandler();
      const action = handler.handleKey('CTRL_A');
      expect(action).toEqual({ kind: 'enter-command-mode' });
      expect(handler.mode).toBe('command');
    });

    it('Ctrl-A Ctrl-A toggles back to PTY mode', () => {
      const handler = createMuxInputHandler();
      handler.handleKey('CTRL_A'); // enter command mode
      expect(handler.mode).toBe('command');

      const action = handler.handleKey('CTRL_A');
      expect(action).toEqual({ kind: 'enter-pty-mode' });
      expect(handler.mode).toBe('pty');
    });

    it('forwards special characters to PTY', () => {
      const handler = createMuxInputHandler();
      const action = handler.handleKey('\x1c'); // Ctrl-backslash
      expect(action).toEqual({ kind: 'write-pty', data: '\x1c' });
    });

    it('forwards raw bytes from terminal-kit data.code to PTY', () => {
      const handler = createMuxInputHandler();
      // Buffer rawCode (escape sequences)
      expect(handler.handleKey('ENTER', 0x0d)).toEqual({ kind: 'write-pty', data: '\r' });
      expect(handler.handleKey('BACKSPACE', 0x7f)).toEqual({ kind: 'write-pty', data: '\x7f' });
      expect(handler.handleKey('ESCAPE', 0x1b)).toEqual({ kind: 'write-pty', data: '\x1b' });
      expect(handler.handleKey('UP', Buffer.from('\x1b[A'))).toEqual({ kind: 'write-pty', data: '\x1b[A' });
      expect(handler.handleKey('DOWN', Buffer.from('\x1b[B'))).toEqual({ kind: 'write-pty', data: '\x1b[B' });
      expect(handler.handleKey('LEFT', Buffer.from('\x1b[D'))).toEqual({ kind: 'write-pty', data: '\x1b[D' });
      expect(handler.handleKey('RIGHT', Buffer.from('\x1b[C'))).toEqual({ kind: 'write-pty', data: '\x1b[C' });
      expect(handler.handleKey('CTRL_C', 0x03)).toEqual({ kind: 'write-pty', data: '\x03' });
      // Keys not in any map are forwarded via rawCode
      expect(handler.handleKey('SHIFT_TAB', Buffer.from('\x1b[Z'))).toEqual({
        kind: 'write-pty',
        data: '\x1b[Z',
      });
    });

    it('falls back to key name string when rawCode is not provided', () => {
      const handler = createMuxInputHandler();
      // Without rawCode, the literal key name is forwarded (caller responsibility)
      expect(handler.handleKey('ENTER')).toEqual({ kind: 'write-pty', data: 'ENTER' });
      // Single printable chars pass through fine without rawCode
      expect(handler.handleKey('a')).toEqual({ kind: 'write-pty', data: 'a' });
    });
  });

  describe('command mode', () => {
    function enterCommandMode() {
      const handler = createMuxInputHandler();
      handler.handleKey('CTRL_A'); // Ctrl-A enters command mode
      return handler;
    }

    it('input buffer starts empty', () => {
      const handler = enterCommandMode();
      expect(handler.inputBuffer).toBe('');
    });

    it('regular characters are appended to input buffer', () => {
      const handler = enterCommandMode();
      handler.handleKey('h');
      handler.handleKey('i');
      expect(handler.inputBuffer).toBe('hi');
    });

    it('Enter dispatches command starting with /', () => {
      const handler = enterCommandMode();
      handler.handleKey('/');
      handler.handleKey('a');
      handler.handleKey('p');
      handler.handleKey('p');
      handler.handleKey('r');
      handler.handleKey('o');
      handler.handleKey('v');
      handler.handleKey('e');
      handler.handleKey(' ');
      handler.handleKey('1');
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'command', command: 'approve', args: ['1'] });
    });

    it('/approve all parses correctly', () => {
      const handler = enterCommandMode();
      for (const c of '/approve all') handler.handleKey(c);
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'command', command: 'approve', args: ['all'] });
    });

    it('non-command text produces trusted-input', () => {
      const handler = enterCommandMode();
      for (const c of 'push my changes') handler.handleKey(c);
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'trusted-input', text: 'push my changes' });
    });

    it('empty Enter produces redraw-input', () => {
      const handler = enterCommandMode();
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'redraw-input' });
    });

    it('Escape clears buffer and stays in command mode', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      const action = handler.handleKey('ESCAPE');
      expect(action).toEqual({ kind: 'redraw-input' });
      expect(handler.mode).toBe('command');
      expect(handler.inputBuffer).toBe('');
      expect(handler.cursorPos).toBe(0);
    });

    it('Ctrl-C clears the input buffer', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      const action = handler.handleKey('CTRL_C');
      expect(action).toEqual({ kind: 'redraw-input' });
      expect(handler.inputBuffer).toBe('');
    });

    it('Ctrl-A in command mode returns to PTY mode', () => {
      const handler = enterCommandMode();
      const action = handler.handleKey('CTRL_A');
      expect(action).toEqual({ kind: 'enter-pty-mode' });
      expect(handler.mode).toBe('pty');
    });

    it('input buffer is preserved across Ctrl-A toggles', () => {
      const handler = createMuxInputHandler();
      // Enter command mode, type some text
      handler.handleKey('CTRL_A');
      expect(handler.mode).toBe('command');
      handler.handleKey('h');
      handler.handleKey('e');
      handler.handleKey('l');
      handler.handleKey('l');
      handler.handleKey('o');
      expect(handler.inputBuffer).toBe('hello');
      expect(handler.cursorPos).toBe(5);

      // Toggle to PTY mode
      handler.handleKey('CTRL_A');
      expect(handler.mode).toBe('pty');

      // Toggle back to command mode -- buffer should be preserved
      handler.handleKey('CTRL_A');
      expect(handler.mode).toBe('command');
      expect(handler.inputBuffer).toBe('hello');
      expect(handler.cursorPos).toBe(5);
    });

    it('ESC clears input buffer in command mode', () => {
      const handler = createMuxInputHandler();
      handler.handleKey('CTRL_A');
      handler.handleKey('t');
      handler.handleKey('e');
      handler.handleKey('s');
      handler.handleKey('t');
      expect(handler.inputBuffer).toBe('test');

      handler.handleKey('ESCAPE');
      expect(handler.inputBuffer).toBe('');
      expect(handler.cursorPos).toBe(0);
      expect(handler.mode).toBe('command');
    });

    it('Backspace deletes character', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      handler.handleKey('c');
      handler.handleKey('BACKSPACE');
      expect(handler.inputBuffer).toBe('ab');
    });

    it('cursor navigation works', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      handler.handleKey('c');
      expect(handler.cursorPos).toBe(3);

      handler.handleKey('LEFT');
      expect(handler.cursorPos).toBe(2);

      handler.handleKey('LEFT');
      expect(handler.cursorPos).toBe(1);

      handler.handleKey('RIGHT');
      expect(handler.cursorPos).toBe(2);
    });

    it('typing at cursor position inserts character', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('c');
      handler.handleKey('LEFT'); // cursor at position 1
      handler.handleKey('b'); // insert 'b' at position 1
      expect(handler.inputBuffer).toBe('abc');
    });

    it('clears input buffer after dispatch', () => {
      const handler = enterCommandMode();
      for (const c of 'hello') handler.handleKey(c);
      handler.handleKey('ENTER');
      expect(handler.inputBuffer).toBe('');
    });

    it('Up arrow moves cursor to previous line at same column', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('abc\ndef\nghi');
      // cursor at end: pos 11, on line 3 col 3
      expect(handler.cursorPos).toBe(11);
      handler.handleKey('UP');
      // should be on line 2, col 3 → pos 7 ("abc\ndef|")
      expect(handler.cursorPos).toBe(7);
      handler.handleKey('UP');
      // should be on line 1, col 3 → pos 3 ("abc|")
      expect(handler.cursorPos).toBe(3);
    });

    it('Up arrow clamps to shorter line length', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('ab\nc\ndef');
      // cursor at end: pos 7, line 3 col 2
      handler.handleKey('UP');
      // line 2 is "c" (length 1), col clamped to 1 → pos 4
      expect(handler.cursorPos).toBe(4);
    });

    it('Up arrow on first line scrolls up', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('abc');
      const action = handler.handleKey('UP');
      expect(action).toEqual({ kind: 'scroll-up', amount: 3 });
      expect(handler.cursorPos).toBe(3);
    });

    it('Down arrow moves cursor to next line at same column', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('abc\ndef\nghi');
      // move to beginning
      handler.handleKey('HOME');
      expect(handler.cursorPos).toBe(0);
      handler.handleKey('DOWN');
      // line 2, col 0 → pos 4
      expect(handler.cursorPos).toBe(4);
      handler.handleKey('DOWN');
      // line 3, col 0 → pos 8
      expect(handler.cursorPos).toBe(8);
    });

    it('Down arrow clamps to shorter line length', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('abc\nd');
      handler.handleKey('HOME');
      // cursor at pos 0, line 1 col 0
      // move right to col 2
      handler.handleKey('RIGHT');
      handler.handleKey('RIGHT');
      expect(handler.cursorPos).toBe(2);
      handler.handleKey('DOWN');
      // line 2 is "d" (length 1), col clamped to 1 → pos 5
      expect(handler.cursorPos).toBe(5);
    });

    it('Down arrow on last line scrolls down', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('abc');
      handler.handleKey('HOME');
      const action = handler.handleKey('DOWN');
      expect(action).toEqual({ kind: 'scroll-down', amount: 3 });
      expect(handler.cursorPos).toBe(0);
    });

    it('Home key moves cursor to position 0', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      handler.handleKey('c');
      expect(handler.cursorPos).toBe(3);
      const action = handler.handleKey('HOME');
      expect(action).toEqual({ kind: 'redraw-input' });
      expect(handler.cursorPos).toBe(0);
    });

    it('End key moves cursor to end of buffer', () => {
      const handler = enterCommandMode();
      handler.handleKey('a');
      handler.handleKey('b');
      handler.handleKey('c');
      handler.handleKey('LEFT');
      handler.handleKey('LEFT');
      expect(handler.cursorPos).toBe(1);
      const action = handler.handleKey('END');
      expect(action).toEqual({ kind: 'redraw-input' });
      expect(handler.cursorPos).toBe(3);
    });
  });

  describe('handlePaste', () => {
    it('wraps text in bracketed paste markers for PTY mode', () => {
      const handler = createMuxInputHandler();
      const action = handler.handlePaste('hello world');
      expect(action).toEqual({
        kind: 'write-pty',
        data: '\x1b[200~hello world\x1b[201~',
      });
    });

    it('inserts text at cursor in command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      const action = handler.handlePaste('pasted text');
      expect(action).toEqual({ kind: 'redraw-input' });
      expect(handler.inputBuffer).toBe('pasted text');
      expect(handler.cursorPos).toBe(11);
    });

    it('inserts at mid-buffer cursor position in command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handleKey('a');
      handler.handleKey('b');
      handler.handleKey('LEFT'); // cursor at 1
      handler.handlePaste('XY');
      expect(handler.inputBuffer).toBe('aXYb');
      expect(handler.cursorPos).toBe(3);
    });

    it('preserves newlines (normalized to LF) in command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.handlePaste('line1\nline2\r\nline3');
      expect(handler.inputBuffer).toBe('line1\nline2\nline3');
      expect(handler.cursorPos).toBe(17);
    });

    it('returns none for empty paste', () => {
      const handler = createMuxInputHandler();
      expect(handler.handlePaste('')).toEqual({ kind: 'none' });
    });

    it('inserts into picker browse mode inputPath', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      // Navigate to browse phase
      handler.handleKey('2'); // select "Existing directory"
      expect(handler.pickerState?.phase).toBe('browse');

      const action = handler.handlePaste('/tmp/test');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.pickerState?.inputPath).toContain('/tmp/test');
    });

    it('returns none in picker menu phase', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      expect(handler.pickerState?.phase).toBe('menu');

      const action = handler.handlePaste('text');
      expect(action).toEqual({ kind: 'none' });
    });

    it('returns none in picker browse mode with list focused', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      handler.handleKey('2'); // browse phase
      // Move focus to list
      handler.handleKey('DOWN');

      const action = handler.handlePaste('text');
      expect(action).toEqual({ kind: 'none' });
    });
  });

  describe('picker mode transitions', () => {
    it('exitPickerMode returns to command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      expect(handler.mode).toBe('picker');

      handler.exitPickerMode();
      expect(handler.mode).toBe('command');
      expect(handler.pickerState).toBeNull();
    });

    it('/new quick-spawn (menu option 1) returns to command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      expect(handler.mode).toBe('picker');

      // Select option 1 (quick-spawn)
      const action = handler.handleKey('1');
      expect(action).toEqual({ kind: 'picker-spawn' });
      expect(handler.mode).toBe('command');
      expect(handler.pickerState).toBeNull();
    });

    it('/new browse path submit returns to command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      // Select option 2 (browse)
      handler.handleKey('2');
      expect(handler.pickerState?.phase).toBe('browse');

      // Clear the default path and type a custom one
      const ps = handler.pickerState!;
      while (ps.cursorPos > 0) {
        handler.handleKey('BACKSPACE');
      }
      for (const c of '/tmp/test') handler.handleKey(c);

      // Submit
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'picker-spawn', workspacePath: '/tmp/test' });
      expect(handler.mode).toBe('command');
      expect(handler.pickerState).toBeNull();
    });

    it('picker cancel (ESC from menu) returns to command mode', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      expect(handler.mode).toBe('picker');

      const action = handler.handleKey('ESCAPE');
      expect(action).toEqual({ kind: 'picker-cancel' });
      expect(handler.mode).toBe('command');
    });
  });

  describe('resume picker mode', () => {
    const sessions = [
      {
        sessionId: 'session-aaa',
        status: 'user-exit' as const,
        exitCode: 0,
        lastActivity: '2026-03-10T18:00:00Z',

        workspacePath: '/workspace',
        agent: 'claude-code',
        label: 'Claude Code (interactive)',
        resumable: true,
      },
      {
        sessionId: 'session-bbb',
        status: 'crashed' as const,
        exitCode: 1,
        lastActivity: '2026-03-10T12:00:00Z',

        workspacePath: '/workspace',
        agent: 'claude-code',
        label: 'Claude Code (interactive)',
        resumable: true,
      },
    ];

    function enterResumePicker() {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterResumePickerMode(sessions);
      return handler;
    }

    it('enters resume-picker mode', () => {
      const handler = enterResumePicker();
      expect(handler.mode).toBe('resume-picker');
      expect(handler.resumePickerState).not.toBeNull();
      expect(handler.resumePickerState?.sessions).toHaveLength(2);
      expect(handler.resumePickerState?.selectedIndex).toBe(0);
    });

    it('navigates down in session list', () => {
      const handler = enterResumePicker();
      const action = handler.handleKey('DOWN');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.resumePickerState?.selectedIndex).toBe(1);
    });

    it('does not go below last session', () => {
      const handler = enterResumePicker();
      handler.handleKey('DOWN');
      handler.handleKey('DOWN');
      expect(handler.resumePickerState?.selectedIndex).toBe(1);
    });

    it('navigates up in session list', () => {
      const handler = enterResumePicker();
      handler.handleKey('DOWN');
      const action = handler.handleKey('UP');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.resumePickerState?.selectedIndex).toBe(0);
    });

    it('does not go above first session', () => {
      const handler = enterResumePicker();
      handler.handleKey('UP');
      expect(handler.resumePickerState?.selectedIndex).toBe(0);
    });

    it('Enter selects session and returns resume-spawn', () => {
      const handler = enterResumePicker();
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({
        kind: 'resume-spawn',
        sessionId: 'session-aaa',
        agent: 'claude-code',
      });
      expect(handler.mode).toBe('command');
      expect(handler.resumePickerState).toBeNull();
    });

    it('Enter selects second session after DOWN', () => {
      const handler = enterResumePicker();
      handler.handleKey('DOWN');
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({
        kind: 'resume-spawn',
        sessionId: 'session-bbb',
        agent: 'claude-code',
      });
    });

    it('Escape cancels resume picker', () => {
      const handler = enterResumePicker();
      const action = handler.handleKey('ESCAPE');
      expect(action).toEqual({ kind: 'picker-cancel' });
      expect(handler.mode).toBe('command');
      expect(handler.resumePickerState).toBeNull();
    });

    it('Ctrl-C cancels resume picker', () => {
      const handler = enterResumePicker();
      const action = handler.handleKey('CTRL_C');
      expect(action).toEqual({ kind: 'picker-cancel' });
      expect(handler.mode).toBe('command');
    });

    it('exitResumePickerMode returns to command mode', () => {
      const handler = enterResumePicker();
      handler.exitResumePickerMode();
      expect(handler.mode).toBe('command');
      expect(handler.resumePickerState).toBeNull();
    });

    it('handles empty session list gracefully', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterResumePickerMode([]);
      expect(handler.mode).toBe('resume-picker');

      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'picker-cancel' });
      expect(handler.mode).toBe('command');
    });
  });

  describe('persona picker mode', () => {
    const personas: PersonaSnapshot[] = [
      {
        name: createPersonaName('researcher'),
        description: 'Research assistant',
        compiled: true,
        workspacePath: '/home/user/research',
      },
      {
        name: createPersonaName('writer'),
        description: 'Writing helper',
        compiled: false,
        workspacePath: '/home/user/writing',
      },
      {
        name: createPersonaName('editor'),
        description: 'Constitution edited since compile',
        compiled: true,
        stale: 'constitution',
        workspacePath: '/home/user/editing',
      },
      {
        name: createPersonaName('misconfigured'),
        description: 'Agent name given as its model',
        compiled: true,
        invalidOverrides: 'Persona "misconfigured" has an invalid agentModelId ("goose" is an agent, not a model).',
        workspacePath: '/home/user/misconfigured',
      },
    ];

    function enterPersonaPicker() {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode(personas);
      // Select option 3 (persona picker) from the /new menu
      handler.handleKey('3');
      expect(handler.mode).toBe('persona-picker');
      return handler;
    }

    it('ESC in persona picker returns to /new menu', () => {
      const handler = enterPersonaPicker();
      const action = handler.handleKey('ESCAPE');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.mode).toBe('picker');
      expect(handler.personaPickerState).toBeNull();
      expect(handler.pickerState).not.toBeNull();
      expect(handler.pickerState?.phase).toBe('menu');
    });

    it('ENTER on compiled persona transitions to browse with prefilled workspacePath', () => {
      const handler = enterPersonaPicker();
      // First persona (researcher) is compiled and selected by default
      expect(handler.personaPickerState?.selectedIndex).toBe(0);

      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.mode).toBe('picker');
      expect(handler.personaPickerState).toBeNull();
      expect(handler.pickerState).not.toBeNull();
      expect(handler.pickerState?.phase).toBe('browse');
      expect(handler.pickerState?.inputPath).toBe('/home/user/research/');
      expect(handler.pickerState?.persona).toBe('researcher');
    });

    it('ENTER on non-compiled persona is ignored', () => {
      const handler = enterPersonaPicker();
      // Navigate to second persona (writer, not compiled)
      handler.handleKey('DOWN');
      expect(handler.personaPickerState?.selectedIndex).toBe(1);

      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'none' });
      expect(handler.mode).toBe('persona-picker');
      expect(handler.personaPickerState).not.toBeNull();
    });

    it('ENTER on a persona with a stale policy is ignored (the session would refuse it)', () => {
      const handler = enterPersonaPicker();
      handler.handleKey('DOWN');
      handler.handleKey('DOWN');
      expect(handler.personaPickerState?.selectedIndex).toBe(2);

      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'none' });
      expect(handler.mode).toBe('persona-picker');
      expect(handler.pickerState?.persona).toBeUndefined();
    });

    it('ENTER on a persona with a malformed model or budget is ignored (the session would refuse it)', () => {
      const handler = enterPersonaPicker();
      handler.handleKey('DOWN');
      handler.handleKey('DOWN');
      handler.handleKey('DOWN');
      expect(handler.personaPickerState?.selectedIndex).toBe(3);

      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'none' });
      expect(handler.mode).toBe('persona-picker');
      expect(handler.pickerState?.persona).toBeUndefined();
    });

    it('browse submit with persona carries through to picker-spawn', () => {
      const handler = enterPersonaPicker();
      // Select compiled persona
      handler.handleKey('ENTER');
      expect(handler.pickerState?.phase).toBe('browse');
      expect(handler.pickerState?.persona).toBe('researcher');

      // Clear the prefilled path and type a custom one
      const ps = handler.pickerState!;
      while (ps.cursorPos > 0) {
        handler.handleKey('BACKSPACE');
      }
      for (const c of '/tmp/work') handler.handleKey(c);

      // Submit the path
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({
        kind: 'picker-spawn',
        workspacePath: '/tmp/work',
        persona: 'researcher',
      });
      expect(handler.mode).toBe('command');
      expect(handler.pickerState).toBeNull();
    });

    it('browse submit without persona omits persona field', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode();
      // Select option 2 (browse, no personas)
      handler.handleKey('2');
      expect(handler.pickerState?.phase).toBe('browse');

      // Clear default path and type a custom one
      const ps = handler.pickerState!;
      while (ps.cursorPos > 0) {
        handler.handleKey('BACKSPACE');
      }
      for (const c of '/tmp/test') handler.handleKey(c);

      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'picker-spawn', workspacePath: '/tmp/test' });
      expect(action).not.toHaveProperty('persona');
    });
  });

  describe('provider picker mode (G13)', () => {
    // Two configured profiles + native, glm-5.2 marked default — the snapshot
    // shape mux-command builds from `modelProviders`.
    const profiles: ProviderProfileSnapshot[] = [
      { name: 'native', type: 'native', primaryModelLabel: 'Anthropic / OpenAI / ChatGPT', isDefault: false },
      { name: 'glm-5.2', type: 'openrouter', primaryModelLabel: 'z-ai/glm-5.2 (OpenRouter)', isDefault: true },
      { name: 'kimi', type: 'openrouter', primaryModelLabel: 'moonshot/kimi-k3 (OpenRouter)', isDefault: false },
    ];

    /** Native-only snapshot (no selectable profiles). */
    const nativeOnly: ProviderProfileSnapshot[] = [
      { name: 'native', type: 'native', primaryModelLabel: 'Anthropic / OpenAI / ChatGPT', isDefault: true },
    ];

    it('quick-spawn (menu option 1) opens the provider picker when profiles are configured', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode([], profiles);
      const action = handler.handleKey('1');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.mode).toBe('provider-picker');
      // The picker lists native + both profiles, and pre-selects the default.
      expect(handler.providerPickerState?.profiles.map((p) => p.name)).toEqual(['native', 'glm-5.2', 'kimi']);
      expect(handler.providerPickerState?.profiles[handler.providerPickerState.selectedIndex].name).toBe('glm-5.2');
    });

    it('selecting kimi emits picker-spawn carrying providerProfileName: kimi', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode([], profiles);
      handler.handleKey('1'); // quick-spawn → provider picker
      // Move from the default (glm-5.2, index 1) down to kimi (index 2).
      handler.handleKey('DOWN');
      expect(handler.providerPickerState?.selectedIndex).toBe(2);

      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'picker-spawn', providerProfileName: 'kimi' });
      expect(handler.mode).toBe('command');
      expect(handler.providerPickerState).toBeNull();
    });

    it('selecting the default (Enter without navigation) uses the default profile', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode([], profiles);
      handler.handleKey('1');
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'picker-spawn', providerProfileName: 'glm-5.2' });
    });

    it('carries the pending workspace/persona through the provider step', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode([], profiles);
      // Menu option 2 → browse; type a workspace path.
      handler.handleKey('2');
      const ps = handler.pickerState!;
      while (ps.cursorPos > 0) handler.handleKey('BACKSPACE');
      for (const c of '/tmp/ws') handler.handleKey(c);
      // Submitting the path now opens the provider picker (not picker-spawn yet).
      const submit = handler.handleKey('ENTER');
      expect(submit).toEqual({ kind: 'redraw-picker' });
      expect(handler.mode).toBe('provider-picker');
      expect(handler.providerPickerState?.pending).toEqual({ workspacePath: '/tmp/ws' });

      // Selecting a profile combines the pending workspace with the choice.
      handler.handleKey('DOWN'); // → kimi
      const action = handler.handleKey('ENTER');
      expect(action).toEqual({ kind: 'picker-spawn', workspacePath: '/tmp/ws', providerProfileName: 'kimi' });
    });

    it('SKIPS the provider step entirely when only native is configured (zero friction)', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode([], nativeOnly);
      const action = handler.handleKey('1');
      // No provider-picker transition; emits picker-spawn directly with no profile.
      expect(action).toEqual({ kind: 'picker-spawn' });
      expect(handler.mode).toBe('command');
      expect(action).not.toHaveProperty('providerProfileName');
    });

    it('SKIPS the provider step when no profile snapshot is supplied (native default)', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode(); // no personas, no profiles
      const action = handler.handleKey('1');
      expect(action).toEqual({ kind: 'picker-spawn' });
      expect(handler.mode).toBe('command');
    });

    it('ESC in the provider picker cancels the whole /new flow', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode([], profiles);
      handler.handleKey('1');
      expect(handler.mode).toBe('provider-picker');
      const action = handler.handleKey('ESCAPE');
      expect(action).toEqual({ kind: 'picker-cancel' });
      expect(handler.mode).toBe('command');
      expect(handler.providerPickerState).toBeNull();
    });

    it('exitProviderPickerMode returns to command mode with no side effects', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      handler.enterPickerMode([], profiles);
      handler.handleKey('1');
      handler.exitProviderPickerMode();
      expect(handler.mode).toBe('command');
      expect(handler.providerPickerState).toBeNull();
    });

    it('backing out of persona selection (ESC) preserves configured provider profiles', () => {
      const personas: PersonaSnapshot[] = [
        {
          name: createPersonaName('researcher'),
          description: 'Research assistant',
          compiled: true,
          workspacePath: '/home/user/research',
        },
      ];
      const handler = createMuxInputHandler({ initialMode: 'command' });
      // Enter the /new picker with BOTH personas and provider profiles.
      handler.enterPickerMode(personas, profiles);

      // Drill into persona selection (menu option 3), then back out with ESC.
      handler.handleKey('3');
      expect(handler.mode).toBe('persona-picker');
      handler.handleKey('ESCAPE');
      expect(handler.mode).toBe('picker');
      expect(handler.pickerState?.phase).toBe('menu');
      // Persona menu item survives the round-trip (cache not wiped).
      expect(handler.pickerState?.menuItemCount).toBe(3);

      // Quick-spawn (option 1) now runs finishSelection. With the profile cache
      // preserved, the provider-picker step MUST be interposed rather than
      // skipped to a default-provider spawn.
      const action = handler.handleKey('1');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.mode).toBe('provider-picker');
      expect(handler.providerPickerState?.profiles.map((p) => p.name)).toEqual(['native', 'glm-5.2', 'kimi']);
      // The default profile is still pre-selected.
      expect(handler.providerPickerState?.profiles[handler.providerPickerState.selectedIndex].name).toBe('glm-5.2');
    });
  });

  describe('escalation picker mode', () => {
    /** A picker opened on #3 whose arming delay has passed. */
    function enterEscalationPicker(previousMode: 'pty' | 'command' = 'pty') {
      const clock = fakeClock();
      const handler = createMuxInputHandler({ initialMode: previousMode, now: clock.now });
      handler.enterEscalationPickerMode(ref(3), previousMode);
      clock.advance(ARMED);
      return handler;
    }

    it('enters escalation-picker mode with correct state, disarmed', () => {
      const clock = fakeClock(50_000);
      const handler = createMuxInputHandler({ now: clock.now });
      handler.enterEscalationPickerMode(ref(3), 'pty');
      expect(handler.mode).toBe('escalation-picker');
      expect(handler.escalationPickerState).toEqual({
        focusedDisplayNumber: 3,
        focusedEscalationId: 'esc-3',
        previousMode: 'pty',
        detailView: null,
        armedAt: 50_000 + ESCALATION_ARMING_DELAY_MS,
        whitelistConfirm: false,
      });
    });

    it('exitEscalationPickerMode returns to previous mode', () => {
      const handler = enterEscalationPicker('command');
      handler.exitEscalationPickerMode();
      expect(handler.mode).toBe('command');
      expect(handler.escalationPickerState).toBeNull();
    });

    it('exitEscalationPickerMode defaults to pty when state is null', () => {
      const handler = createMuxInputHandler();
      // Exit without entering first -- should not crash, defaults to pty
      handler.exitEscalationPickerMode();
      expect(handler.mode).toBe('pty');
    });

    it('dismissEscalationPicker returns to the mode the picker was opened from', () => {
      const handler = enterEscalationPicker('command');
      handler.dismissEscalationPicker();
      expect(handler.mode).toBe('command');
      expect(handler.escalationPickerState).toBeNull();
    });

    it('dismissEscalationPicker with targetMode overrides previousMode', () => {
      const handler = createMuxInputHandler();
      handler.enterEscalationPickerMode(ref(3), 'pty');
      handler.dismissEscalationPicker('command');
      expect(handler.mode).toBe('command');
    });

    it('Escape, Ctrl-C and Ctrl-A dismiss even while the picker is disarmed', () => {
      const handler = createMuxInputHandler({ now: fakeClock().now });
      handler.enterEscalationPickerMode(ref(3), 'pty');
      expect(handler.handleKey('ESCAPE')).toEqual({ kind: 'escalation-dismiss' });
      expect(handler.handleKey('CTRL_C')).toEqual({ kind: 'escalation-dismiss' });
      expect(handler.handleKey('CTRL_A')).toEqual({ kind: 'escalation-dismiss', targetMode: 'command' });
    });

    it('RIGHT and TAB emit escalation-navigate next; LEFT and SHIFT_TAB prev', () => {
      const handler = createMuxInputHandler({ now: fakeClock().now });
      handler.enterEscalationPickerMode(ref(3), 'pty'); // disarmed: navigation decides nothing
      expect(handler.handleKey('RIGHT')).toEqual({ kind: 'escalation-navigate', direction: 'next' });
      expect(handler.handleKey('TAB')).toEqual({ kind: 'escalation-navigate', direction: 'next' });
      expect(handler.handleKey('LEFT')).toEqual({ kind: 'escalation-navigate', direction: 'prev' });
      expect(handler.handleKey('SHIFT_TAB')).toEqual({ kind: 'escalation-navigate', direction: 'prev' });
    });

    it('"a" emits escalation-resolve approved, bound to the escalation id', () => {
      const handler = enterEscalationPicker();
      expect(handler.handleKey('a')).toEqual({
        kind: 'escalation-resolve',
        displayNumber: 3,
        escalationId: 'esc-3',
        decision: 'approved',
        whitelist: false,
      });
    });

    it('"d" emits escalation-resolve denied, bound to the escalation id', () => {
      const handler = enterEscalationPicker();
      expect(handler.handleKey('d')).toEqual({
        kind: 'escalation-resolve',
        displayNumber: 3,
        escalationId: 'esc-3',
        decision: 'denied',
        whitelist: false,
      });
    });

    it('"w" opens the whitelist confirmation of the exact pattern instead of deciding', () => {
      const handler = enterEscalationPicker();
      const action = handler.handleKey('w');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.escalationPickerState?.whitelistConfirm).toBe('exact');
      expect(handler.mode).toBe('escalation-picker');
    });

    it('"W" opens the whitelist confirmation of the directory-wide pattern instead of deciding', () => {
      const handler = enterEscalationPicker();
      const action = handler.handleKey('W');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.escalationPickerState?.whitelistConfirm).toBe('directory');
      expect(handler.mode).toBe('escalation-picker');
    });

    it('"A" (shift) does nothing: there is no single-key approve all', () => {
      const handler = enterEscalationPicker();
      const before = { ...handler.escalationPickerState };
      const action = handler.handleKey('A');
      expect(action.kind).not.toBe('escalation-resolve');
      expect(action.kind).not.toBe('escalation-approve-reviewed');
      expect(action.kind).not.toBe('write-pty');
      expect(handler.mode).toBe('escalation-picker');
      expect(handler.escalationPickerState?.focusedDisplayNumber).toBe(before.focusedDisplayNumber);
      expect(handler.escalationPickerState?.whitelistConfirm).toBe(false);
      // Caps Lock on: 'A' is a stray key, so it re-arms and an 'a' right after decides nothing either.
      expect(handler.handleKey('a').kind).not.toBe('escalation-resolve');
    });

    it('"D" (shift) emits escalation-deny-all', () => {
      const handler = enterEscalationPicker();
      expect(handler.handleKey('D')).toEqual({ kind: 'escalation-deny-all' });
    });

    it('an unrecognized key is swallowed, never forwarded to the PTY', () => {
      const handler = enterEscalationPicker();
      const action = handler.handleKey('x');
      expect(action).toEqual({ kind: 'redraw-picker' });
      expect(handler.mode).toBe('escalation-picker');
    });

    it('escalationPickerState is null after exiting', () => {
      const handler = createMuxInputHandler();
      handler.enterEscalationPickerMode(ref(1), 'pty');
      handler.exitEscalationPickerMode();
      expect(handler.escalationPickerState).toBeNull();
      expect(handler.mode).toBe('pty');
    });

    it('Ctrl-E in PTY mode emits escalation-open', () => {
      const handler = createMuxInputHandler();
      const action = handler.handleKey('CTRL_E');
      expect(action).toEqual({ kind: 'escalation-open' });
    });

    it('Ctrl-E in command mode emits escalation-open', () => {
      const handler = createMuxInputHandler({ initialMode: 'command' });
      const action = handler.handleKey('CTRL_E');
      expect(action).toEqual({ kind: 'escalation-open' });
    });

    it('resolve action uses the current focus', () => {
      const clock = fakeClock();
      const handler = createMuxInputHandler({ now: clock.now });
      handler.enterEscalationPickerMode(ref(42), 'pty');
      handler.focusEscalation(ref(43));
      clock.advance(ARMED);
      expect(handler.handleKey('a')).toEqual({
        kind: 'escalation-resolve',
        displayNumber: 43,
        escalationId: 'esc-43',
        decision: 'approved',
        whitelist: false,
      });
    });
  });
});

describe('message panel mode', () => {
  it('enters and exits, restoring the previous mode', () => {
    const handler = createMuxInputHandler({ initialMode: 'command' });
    handler.enterMessagePanel('Sessions', ['a', 'b'], 'command');
    expect(handler.mode).toBe('message-panel');
    expect(handler.messagePanelState).toEqual({
      title: 'Sessions',
      lines: ['a', 'b'],
      scrollOffset: 0,
      previousMode: 'command',
    });
    handler.exitMessagePanel();
    expect(handler.mode).toBe('command');
    expect(handler.messagePanelState).toBeNull();
  });

  it('Escape, Enter, q and Ctrl-C emit message-panel-dismiss', () => {
    for (const key of ['ESCAPE', 'ENTER', 'q', 'CTRL_C']) {
      const handler = createMuxInputHandler({ initialMode: 'pty' });
      handler.enterMessagePanel('t', ['a'], 'pty');
      expect(handler.handleKey(key)).toEqual({ kind: 'message-panel-dismiss' });
    }
  });

  it('arrow and page keys scroll within bounds and request a redraw', () => {
    const handler = createMuxInputHandler({ initialMode: 'pty' });
    handler.enterMessagePanel('t', ['1', '2', '3', '4', '5', '6', '7'], 'pty');
    expect(handler.handleKey('DOWN')).toEqual({ kind: 'redraw-picker' });
    expect(handler.messagePanelState?.scrollOffset).toBe(1);
    handler.handleKey('PAGE_DOWN');
    expect(handler.messagePanelState?.scrollOffset).toBe(6);
    handler.handleKey('DOWN');
    expect(handler.messagePanelState?.scrollOffset).toBe(6);
    handler.handleKey('PAGE_UP');
    expect(handler.messagePanelState?.scrollOffset).toBe(1);
    handler.handleKey('UP');
    handler.handleKey('UP');
    expect(handler.messagePanelState?.scrollOffset).toBe(0);
  });

  it('swallows other keys and pastes instead of forwarding them to the PTY', () => {
    const handler = createMuxInputHandler({ initialMode: 'pty' });
    handler.enterMessagePanel('t', ['a'], 'pty');
    expect(handler.handleKey('x')).toEqual({ kind: 'none' });
    expect(handler.handleKey('a')).toEqual({ kind: 'none' });
    expect(handler.handlePaste('pasted')).toEqual({ kind: 'none' });
  });
});

describe('escalation detail view state', () => {
  it('starts in the summary view and toggles', () => {
    const handler = createMuxInputHandler();
    handler.enterEscalationPickerMode(ref(2), 'pty');
    expect(handler.escalationPickerState?.detailView).toBeNull();
    handler.toggleEscalationDetailView();
    expect(handler.escalationPickerState?.detailView).toEqual({ scrollOffset: 0 });
    handler.toggleEscalationDetailView();
    expect(handler.escalationPickerState?.detailView).toBeNull();
  });

  it('scrolls the detail view but never above the top', () => {
    const handler = createMuxInputHandler();
    handler.enterEscalationPickerMode(ref(2), 'pty');
    handler.scrollEscalationDetailView(3); // no detail view open: no-op
    expect(handler.escalationPickerState?.detailView).toBeNull();
    handler.toggleEscalationDetailView();
    handler.scrollEscalationDetailView(3);
    expect(handler.escalationPickerState?.detailView).toEqual({ scrollOffset: 3 });
    handler.scrollEscalationDetailView(-10);
    expect(handler.escalationPickerState?.detailView).toEqual({ scrollOffset: 0 });
  });

  it('ignores detail-view calls outside the picker', () => {
    const handler = createMuxInputHandler();
    handler.toggleEscalationDetailView();
    handler.scrollEscalationDetailView(1);
    expect(handler.escalationPickerState).toBeNull();
    expect(handler.mode).toBe('pty');
  });

  it('"v" toggles the detail view the "(+N hidden, v to view)" notice points to, even while disarmed', () => {
    const handler = createMuxInputHandler({ now: fakeClock().now });
    handler.enterEscalationPickerMode(ref(2), 'pty');
    expect(handler.handleKey('v')).toEqual({ kind: 'redraw-picker' });
    expect(handler.escalationPickerState?.detailView).toEqual({ scrollOffset: 0 });
    expect(handler.handleKey('v')).toEqual({ kind: 'redraw-picker' });
    expect(handler.escalationPickerState?.detailView).toBeNull();
    expect(handler.mode).toBe('escalation-picker');
  });

  it('arrow, page, Home and End keys scroll only an open detail view', () => {
    const handler = createMuxInputHandler();
    handler.enterEscalationPickerMode(ref(2), 'pty');
    // Summary view: the keys scroll nothing and are not forwarded anywhere.
    expect(handler.handleKey('DOWN')).toEqual({ kind: 'redraw-picker' });
    expect(handler.handleKey('PAGE_DOWN')).toEqual({ kind: 'redraw-picker' });
    expect(handler.escalationPickerState?.detailView).toBeNull();

    handler.handleKey('v');
    const offset = (): number | undefined => handler.escalationPickerState?.detailView?.scrollOffset;
    expect(handler.handleKey('DOWN')).toEqual({ kind: 'redraw-picker' });
    expect(offset()).toBe(1);
    handler.handleKey('PAGE_DOWN');
    expect(offset()).toBe(11);
    handler.handleKey('UP');
    expect(offset()).toBe(10);
    handler.handleKey('PAGE_UP');
    expect(offset()).toBe(0);
    handler.handleKey('END'); // the renderer clamps this to the last page
    expect(offset()).toBe(Number.MAX_SAFE_INTEGER);
    handler.handleKey('HOME');
    expect(offset()).toBe(0);
  });

  it('a and w act only on an escalation the renderer showed in full for the arming delay; d always denies', () => {
    const clock = fakeClock();
    let shown: DisplayedEscalation | null = null;
    const handler = createMuxInputHandler({ now: clock.now, displayedEscalation: () => shown });
    handler.enterEscalationPickerMode(ref(2), 'pty');
    clock.advance(ARMED);

    // Terminal too small: the dialog was replaced by a notice. Swallowed, not forwarded.
    expect(handler.handleKey('a').kind).toBe('redraw-picker');
    clock.advance(ARMED);
    expect(handler.handleKey('w').kind).toBe('redraw-picker');
    expect(handler.escalationPickerState?.whitelistConfirm).toBe(false);
    clock.advance(ARMED);
    expect(handler.handleKey('d')).toEqual({
      kind: 'escalation-resolve',
      displayNumber: 2,
      escalationId: 'esc-2',
      decision: 'denied',
      whitelist: false,
    });
    expect(handler.mode).toBe('escalation-picker');

    // Enlarged: the dialog appears now. Approving waits for the delay from this moment.
    shown = {
      displayNumber: 2,
      escalationId: 'esc-2',
      view: 'summary',
      since: clock.now(),
      canWhitelist: true,
      canWhitelistDirectory: true,
    };
    clock.advance(ESCALATION_ARMING_DELAY_MS / 2);
    expect(handler.handleKey('a').kind).toBe('redraw-picker');
    clock.advance(ARMED);
    expect(handler.handleKey('a')).toEqual({
      kind: 'escalation-resolve',
      displayNumber: 2,
      escalationId: 'esc-2',
      decision: 'approved',
      whitelist: false,
    });

    // A drawing of another request under the same number does not count.
    shown = {
      displayNumber: 2,
      escalationId: 'esc-other',
      view: 'summary',
      since: 0,
      canWhitelist: true,
      canWhitelistDirectory: true,
    };
    clock.advance(ARMED);
    expect(handler.handleKey('a').kind).toBe('redraw-picker');
  });

  it('w and W do nothing for an escalation that offers no whitelist pattern', () => {
    const clock = fakeClock();
    const handler = createMuxInputHandler({
      now: clock.now,
      displayedEscalation: () => ({
        displayNumber: 2,
        escalationId: 'esc-2',
        view: 'summary',
        since: 0,
        canWhitelist: false,
        canWhitelistDirectory: false,
      }),
    });
    handler.enterEscalationPickerMode(ref(2), 'pty');
    for (const key of ['w', 'W']) {
      clock.advance(ARMED);
      expect(handler.handleKey(key), key).toEqual({ kind: 'redraw-picker' });
      expect(handler.escalationPickerState?.whitelistConfirm, key).toBe(false);
    }
  });

  it('W does nothing for an escalation that offers only the exact pattern', () => {
    const clock = fakeClock();
    const handler = createMuxInputHandler({
      now: clock.now,
      displayedEscalation: () => ({
        displayNumber: 2,
        escalationId: 'esc-2',
        view: 'summary',
        since: 0,
        canWhitelist: true,
        canWhitelistDirectory: false,
      }),
    });
    handler.enterEscalationPickerMode(ref(2), 'pty');
    clock.advance(ARMED);
    expect(handler.handleKey('W')).toEqual({ kind: 'redraw-picker' });
    expect(handler.escalationPickerState?.whitelistConfirm).toBe(false);
    clock.advance(ARMED);
    expect(handler.handleKey('w')).toEqual({ kind: 'redraw-picker' });
    expect(handler.escalationPickerState?.whitelistConfirm).toBe('exact');
  });

  it('decision keys keep working from the detail view', () => {
    const clock = fakeClock();
    const handler = createMuxInputHandler({ now: clock.now });
    handler.enterEscalationPickerMode(ref(2), 'pty');
    handler.handleKey('v');
    clock.advance(ARMED);
    expect(handler.handleKey('d')).toEqual({
      kind: 'escalation-resolve',
      displayNumber: 2,
      escalationId: 'esc-2',
      decision: 'denied',
      whitelist: false,
    });
  });
});

describe('escalation picker arming', () => {
  const DECISION_KEYS = ['a', 'd', 'w', 'D'];

  function isDecision(action: MuxAction): boolean {
    return (
      action.kind === 'escalation-resolve' ||
      action.kind === 'escalation-deny-all' ||
      action.kind === 'escalation-approve-reviewed'
    );
  }

  it('decision keys inside the arming window do nothing and are never forwarded', () => {
    for (const key of DECISION_KEYS) {
      const clock = fakeClock();
      const handler = createMuxInputHandler({ now: clock.now });
      handler.enterEscalationPickerMode(ref(1), 'pty');
      clock.advance(ESCALATION_ARMING_DELAY_MS - 1);
      const action = handler.handleKey(key);
      expect(isDecision(action), key).toBe(false);
      expect(action.kind, key).not.toBe('write-pty');
      expect(handler.mode, key).toBe('escalation-picker');
      expect(handler.escalationPickerState?.whitelistConfirm, key).toBe(false);
    }
  });

  it('a key ignored while disarmed restarts the window', () => {
    const clock = fakeClock();
    const handler = createMuxInputHandler({ now: clock.now });
    handler.enterEscalationPickerMode(ref(1), 'pty');
    clock.advance(900);
    expect(isDecision(handler.handleKey('a'))).toBe(false);
    clock.advance(200); // 1100 ms after opening, 200 ms after the ignored key
    expect(isDecision(handler.handleKey('a'))).toBe(false);
    clock.advance(ARMED);
    expect(handler.handleKey('a')).toMatchObject({ kind: 'escalation-resolve', displayNumber: 1 });
  });

  it('a held key (auto-repeat) never decides', () => {
    const clock = fakeClock();
    const handler = createMuxInputHandler({ now: clock.now });
    handler.enterEscalationPickerMode(ref(1), 'pty');
    for (let i = 0; i < 200; i++) {
      clock.advance(33);
      expect(isDecision(handler.handleKey('a'))).toBe(false);
    }
  });

  it('a stray key re-arms an armed picker, so typing that lands in it decides nothing', () => {
    const clock = fakeClock();
    const handler = createMuxInputHandler({ now: clock.now });
    handler.enterEscalationPickerMode(ref(1), 'pty');
    clock.advance(5_000);
    const actions = 'make a backup and add a whitelist entry'.split('').map((key) => {
      clock.advance(60);
      return handler.handleKey(key === ' ' ? 'SPACE' : key);
    });
    expect(actions.some(isDecision)).toBe(false);
    expect(actions.some((action) => action.kind === 'write-pty')).toBe(false);
    expect(handler.escalationPickerState?.whitelistConfirm).toBe(false);
  });

  it('keys right after a focus snap (the focused escalation resolved or expired) do nothing', () => {
    const clock = fakeClock();
    const handler = createMuxInputHandler({ now: clock.now });
    handler.enterEscalationPickerMode(ref(1), 'pty');
    clock.advance(ARMED);

    // `a` approves #1; the manager's change snaps the focus to #2 at once.
    expect(handler.handleKey('a')).toMatchObject({ kind: 'escalation-resolve', displayNumber: 1 });
    const transition = handler.reconcileEscalations([ref(2)]);
    expect(transition.outcome).toBe('refocused');
    expect(handler.escalationPickerState?.focusedDisplayNumber).toBe(2);

    // A double tap 30 ms later must not approve #2, which was never read.
    clock.advance(30);
    for (const key of DECISION_KEYS) {
      expect(isDecision(handler.handleKey(key)), key).toBe(false);
    }
    clock.advance(ARMED);
    expect(handler.handleKey('a')).toEqual({
      kind: 'escalation-resolve',
      displayNumber: 2,
      escalationId: 'esc-2',
      decision: 'approved',
      whitelist: false,
    });
  });

  it('moving to another escalation re-arms; the same focus does not', () => {
    const clock = fakeClock();
    const handler = createMuxInputHandler({ now: clock.now });
    handler.enterEscalationPickerMode(ref(1), 'pty');
    clock.advance(ARMED);
    handler.focusEscalation(ref(1));
    expect(handler.handleKey('d')).toMatchObject({ kind: 'escalation-resolve', displayNumber: 1 });
    handler.focusEscalation(ref(2));
    expect(isDecision(handler.handleKey('d'))).toBe(false);
  });

  it('a paste into the picker is swallowed and re-arms', () => {
    const clock = fakeClock();
    const handler = createMuxInputHandler({ now: clock.now });
    handler.enterEscalationPickerMode(ref(1), 'pty');
    clock.advance(ARMED);
    expect(handler.handlePaste('a backup')).toEqual({ kind: 'redraw-picker' });
    expect(isDecision(handler.handleKey('a'))).toBe(false);
  });

  it('viewing and navigating work while disarmed but restart the window: "va" or Tab right before a decision decide nothing', () => {
    for (const key of ['v', 'TAB', 'RIGHT', 'LEFT', 'SHIFT_TAB']) {
      const clock = fakeClock();
      const handler = createMuxInputHandler({ now: clock.now });
      handler.enterEscalationPickerMode(ref(1), 'pty');
      clock.advance(5_000); // idle long enough: armed
      const action = handler.handleKey(key);
      expect(isDecision(action), key).toBe(false);
      expect(action.kind, key).not.toBe('write-pty');
      clock.advance(60);
      for (const decision of DECISION_KEYS) {
        expect(isDecision(handler.handleKey(decision)), `${key} then ${decision}`).toBe(false);
      }
      // Only a delay: after a full window with no other key the decision counts.
      clock.advance(ARMED);
      expect(handler.handleKey('a'), key).toMatchObject({ kind: 'escalation-resolve', displayNumber: 1 });
    }
  });

  it('scrolling the detail view restarts the window', () => {
    for (const key of ['UP', 'DOWN', 'PAGE_UP', 'PAGE_DOWN', 'HOME', 'END']) {
      const clock = fakeClock();
      const handler = createMuxInputHandler({ now: clock.now });
      handler.enterEscalationPickerMode(ref(1), 'pty');
      handler.handleKey('v');
      clock.advance(ARMED);
      expect(handler.handleKey(key), key).toEqual({ kind: 'redraw-picker' });
      expect(handler.escalationPickerState?.detailView, key).not.toBeNull();
      clock.advance(60);
      expect(isDecision(handler.handleKey('a')), key).toBe(false);
    }
  });
});

describe('an arriving escalation never takes the keyboard', () => {
  it('typing in the PTY while an escalation arrives never approves it', () => {
    const clock = fakeClock();
    const handler = createMuxInputHandler({ initialMode: 'pty', now: clock.now });
    const actions: MuxAction[] = [];
    const type = (text: string): void => {
      for (const key of text) {
        clock.advance(80);
        actions.push(handler.handleKey(key, key.charCodeAt(0)));
      }
    };

    type('mak');
    // The escalation manager reports an arrival (proxy/add_proxy_domain) mid-word.
    const transition = handler.reconcileEscalations([ref(7)]);
    expect(transition.outcome).toBe('unchanged');
    expect(handler.mode).toBe('pty');
    type('e a backup, then add a domain');

    expect(actions.every((action) => action.kind === 'write-pty')).toBe(true);
    expect(actions.map((action) => (action.kind === 'write-pty' ? action.data : '')).join('')).toBe(
      'make a backup, then add a domain',
    );
    expect(handler.escalationPickerState).toBeNull();
  });

  it('a command-mode message keeps every character, including a capital A', () => {
    const handler = createMuxInputHandler({ initialMode: 'command', now: fakeClock().now });
    for (const key of 'Also') handler.handleKey(key);
    handler.reconcileEscalations([ref(1), ref(2)]);
    for (const key of ' check logs') handler.handleKey(key);
    expect(handler.mode).toBe('command');
    expect(handler.inputBuffer).toBe('Also check logs');
  });

  it('the /new path browser is not cancelled and keeps its typed path', () => {
    const handler = createMuxInputHandler({ initialMode: 'command', now: fakeClock().now });
    handler.enterBrowseWithError('/tmp/proj', 'x');
    handler.reconcileEscalations([ref(1)]);
    handler.handleKey('a');
    expect(handler.mode).toBe('picker');
    expect(handler.pickerState?.inputPath).toBe('/tmp/proja');
  });

  it('the resume, persona and provider pickers and the message panel stay open', () => {
    const resume = createMuxInputHandler({ initialMode: 'command' });
    resume.enterResumePickerMode([]);
    resume.reconcileEscalations([ref(1)]);
    expect(resume.mode).toBe('resume-picker');

    const persona = createMuxInputHandler({ initialMode: 'command' });
    persona.enterPersonaPickerMode([]);
    persona.reconcileEscalations([ref(1)]);
    expect(persona.mode).toBe('persona-picker');

    const panel = createMuxInputHandler({ initialMode: 'pty' });
    panel.enterMessagePanel('Sessions', ['a', 'b'], 'pty');
    panel.reconcileEscalations([ref(1)]);
    expect(panel.mode).toBe('message-panel');
  });

  it('the picker closes and restores the previous mode when nothing is left', () => {
    const handler = createMuxInputHandler({ initialMode: 'command', now: fakeClock().now });
    handler.enterEscalationPickerMode(ref(1), 'command');
    expect(handler.reconcileEscalations([]).outcome).toBe('picker-closed');
    expect(handler.mode).toBe('command');
    expect(handler.escalationPickerState).toBeNull();
  });
});

describe('whitelist confirmation', () => {
  function whitelistConfirmOpen(view: EscalationView = 'whitelist-confirm', key: 'w' | 'W' = 'w') {
    const clock = fakeClock();
    let drawnView: EscalationView = 'summary';
    const handler = createMuxInputHandler({
      now: clock.now,
      displayedEscalation: () => ({
        displayNumber: 4,
        escalationId: 'esc-4',
        view: drawnView,
        since: 0,
        canWhitelist: true,
        canWhitelistDirectory: true,
      }),
    });
    handler.enterEscalationPickerMode(ref(4), 'pty');
    clock.advance(ARMED);
    expect(handler.handleKey(key)).toEqual({ kind: 'redraw-picker' });
    drawnView = view; // what the renderer draws for the confirmation
    return { handler, clock };
  }

  it('y approves and whitelists the exact pattern shown, after its own arming delay', () => {
    const { handler, clock } = whitelistConfirmOpen();
    clock.advance(100);
    expect(handler.handleKey('y').kind).toBe('redraw-picker'); // too soon after w
    clock.advance(ARMED);
    expect(handler.handleKey('y')).toEqual({
      kind: 'escalation-resolve',
      displayNumber: 4,
      escalationId: 'esc-4',
      decision: 'approved',
      whitelist: 'exact',
    });
  });

  it('y after W approves and whitelists the directory-wide pattern, only while its confirmation is shown', () => {
    const { handler, clock } = whitelistConfirmOpen('whitelist-directory-confirm', 'W');
    clock.advance(100);
    expect(handler.handleKey('y').kind).toBe('redraw-picker'); // too soon after W
    clock.advance(ARMED);
    expect(handler.handleKey('y')).toEqual({
      kind: 'escalation-resolve',
      displayNumber: 4,
      escalationId: 'esc-4',
      decision: 'approved',
      whitelist: 'directory',
    });
  });

  it('y does nothing when the confirmation on screen is for the other pattern', () => {
    // W was pressed, but the renderer shows the exact pattern's confirmation (and vice versa).
    for (const [view, key] of [
      ['whitelist-confirm', 'W'],
      ['whitelist-directory-confirm', 'w'],
    ] as const) {
      const { handler, clock } = whitelistConfirmOpen(view, key);
      clock.advance(ARMED);
      expect(handler.handleKey('y').kind, key).toBe('redraw-picker');
    }
  });

  it('y does nothing while the confirmation (and so the pattern) is not on screen', () => {
    const { handler, clock } = whitelistConfirmOpen('summary');
    clock.advance(ARMED);
    expect(handler.handleKey('y').kind).toBe('redraw-picker');
  });

  it('other decision keys do nothing on the confirmation; n and Esc go back', () => {
    const { handler, clock } = whitelistConfirmOpen();
    clock.advance(ARMED);
    for (const key of ['a', 'd', 'D', 'w', 'W', 'A']) {
      expect(handler.handleKey(key).kind, key).toBe('redraw-picker');
    }
    expect(handler.escalationPickerState?.whitelistConfirm).toBe('exact');
    expect(handler.handleKey('n')).toEqual({ kind: 'redraw-picker' });
    expect(handler.escalationPickerState?.whitelistConfirm).toBe(false);
    handler.handleKey('w'); // re-armed by the stray keys above: ignored
    expect(handler.escalationPickerState?.whitelistConfirm).toBe(false);
    clock.advance(ARMED);
    handler.handleKey('w');
    expect(handler.escalationPickerState?.whitelistConfirm).toBe('exact');
    expect(handler.handleKey('ESCAPE')).toEqual({ kind: 'redraw-picker' });
    expect(handler.escalationPickerState?.whitelistConfirm).toBe(false);
    expect(handler.mode).toBe('escalation-picker');
  });

  it('going back with n or Esc restarts the window, so an a right after it decides nothing', () => {
    for (const key of ['n', 'ESCAPE', 'CTRL_C']) {
      const { handler, clock } = whitelistConfirmOpen();
      clock.advance(ARMED);
      expect(handler.handleKey(key), key).toEqual({ kind: 'redraw-picker' });
      expect(handler.escalationPickerState?.whitelistConfirm, key).toBe(false);
      clock.advance(60);
      expect(handler.handleKey('a').kind, key).toBe('redraw-picker');
      clock.advance(ARMED);
      expect(handler.handleKey('a'), key).toMatchObject({ kind: 'escalation-resolve', whitelist: false });
    }
  });

  it('a focus snap cancels the confirmation', () => {
    const { handler } = whitelistConfirmOpen();
    handler.reconcileEscalations([ref(5)]);
    expect(handler.escalationPickerState?.focusedDisplayNumber).toBe(5);
    expect(handler.escalationPickerState?.whitelistConfirm).toBe(false);
  });
});

describe('approve-all confirmation screen', () => {
  const REVIEWED = [ref(1), ref(2)];

  function openConfirm(options: { seenAllSince?: number | null; setKey?: string; whitelist?: boolean } = {}) {
    const clock = fakeClock();
    const whitelist = options.whitelist ?? false;
    const handler = createMuxInputHandler({
      initialMode: 'command',
      now: clock.now,
      displayedBulkApproval: () => ({
        setKey: options.setKey ?? bulkApprovalKey(REVIEWED, whitelist),
        seenAllSince: options.seenAllSince === undefined ? 0 : options.seenAllSince,
      }),
    });
    handler.enterBulkApproveConfirm(REVIEWED, whitelist, 'command');
    return { handler, clock };
  }

  it('opens disarmed on exactly the listed set', () => {
    const { handler, clock } = openConfirm();
    expect(handler.mode).toBe('escalation-approve-all');
    expect(handler.bulkApproveState).toEqual({
      reviewed: REVIEWED,
      whitelist: false,
      previousMode: 'command',
      scrollOffset: 0,
      armedAt: clock.now() + ESCALATION_ARMING_DELAY_MS,
    });
  });

  it('y inside the arming window does nothing', () => {
    const { handler, clock } = openConfirm();
    clock.advance(500);
    expect(handler.handleKey('y')).toEqual({ kind: 'redraw-picker' });
    expect(handler.mode).toBe('escalation-approve-all');
  });

  it('y approves exactly the listed set once it has all been seen for the delay', () => {
    const { handler, clock } = openConfirm({ whitelist: true });
    clock.advance(ARMED);
    expect(handler.handleKey('y')).toEqual({
      kind: 'escalation-approve-reviewed',
      reviewed: REVIEWED,
      whitelist: true,
    });
  });

  it('y does nothing until every line of the list has been on screen', () => {
    const { handler, clock } = openConfirm({ seenAllSince: null });
    clock.advance(ARMED);
    expect(handler.handleKey('y')).toEqual({ kind: 'redraw-picker' });
  });

  it('y does nothing when the screen shows another set', () => {
    const { handler, clock } = openConfirm({ setKey: bulkApprovalKey([ref(1)], false) });
    clock.advance(ARMED);
    expect(handler.handleKey('y')).toEqual({ kind: 'redraw-picker' });
  });

  it('A, a and other keys decide nothing; n, Esc, Ctrl-C and Ctrl-A cancel', () => {
    const { handler, clock } = openConfirm();
    clock.advance(ARMED);
    for (const key of ['A', 'a', 'w', 'ENTER', 'x']) {
      expect(handler.handleKey(key), key).toEqual({ kind: 'redraw-picker' });
    }
    for (const key of ['n', 'ESCAPE', 'CTRL_C', 'CTRL_A']) {
      expect(handler.handleKey(key), key).toEqual({ kind: 'escalation-approve-all-cancel' });
    }
    handler.exitBulkApproveConfirm();
    expect(handler.mode).toBe('command');
    expect(handler.bulkApproveState).toBeNull();
  });

  it('scroll keys move the list, never above the top', () => {
    const { handler } = openConfirm();
    expect(handler.handleKey('DOWN')).toEqual({ kind: 'redraw-picker' });
    expect(handler.bulkApproveState?.scrollOffset).toBe(1);
    handler.handleKey('PAGE_UP');
    expect(handler.bulkApproveState?.scrollOffset).toBe(0);
  });

  it('a scroll key right before y makes it not count; y after a full window with no other key does', () => {
    const { handler, clock } = openConfirm();
    clock.advance(5_000);
    handler.handleKey('END');
    clock.advance(60);
    expect(handler.handleKey('y')).toEqual({ kind: 'redraw-picker' });
    clock.advance(ARMED);
    expect(handler.handleKey('y')).toMatchObject({ kind: 'escalation-approve-reviewed', reviewed: REVIEWED });
  });

  it('approve-all after a new arrival is refused: the screen closes and a later y is plain typing', () => {
    const { handler, clock } = openConfirm();
    clock.advance(ARMED);
    const transition = handler.reconcileEscalations([ref(1), ref(2), ref(3)]);
    expect(transition.outcome).toBe('bulk-cancelled');
    expect(transition.message).toContain('nothing was approved');
    expect(handler.mode).toBe('command');
    expect(handler.bulkApproveState).toBeNull();
    expect(handler.handleKey('y')).toEqual({ kind: 'redraw-input' });
    expect(handler.inputBuffer).toBe('y');
  });

  it('closing a screen that is not open changes no mode', () => {
    const handler = createMuxInputHandler({ initialMode: 'pty' });
    handler.exitBulkApproveConfirm();
    expect(handler.mode).toBe('pty');
  });
});

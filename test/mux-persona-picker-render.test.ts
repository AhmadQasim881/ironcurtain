/**
 * The mux `/new` persona picker shows each persona's own agent model (WP-126)
 * and marks a persona whose model or resource limits are malformed as not
 * ready, like an uncompiled or stale one: its sessions would be refused.
 *
 * Renders through a real terminal-kit Terminal captured in memory and reads
 * the screen back from a headless xterm (see helpers/terminal-kit-capture.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';

import { createMuxRenderer, type MuxRenderer, type MuxRendererDeps } from '../src/mux/mux-renderer.js';
import type { PersonaPickerState } from '../src/mux/mux-input-handler.js';
import type { MuxTab } from '../src/mux/types.js';
import type { PtyBridge } from '../src/pty/pty-bridge.js';
import { createInitialState } from '../src/escalation/listener-state.js';
import { createPersonaName } from '../src/persona/types.js';
import { captureTerminalKit } from './helpers/terminal-kit-capture.js';

const { Terminal } = xtermHeadless;

const renderers: MuxRenderer[] = [];

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy();
});

async function renderPicker(state: PersonaPickerState): Promise<string> {
  const cols = 110;
  const rows = 24;
  const capture = await captureTerminalKit(cols, rows);
  const tab: MuxTab = {
    number: 1,
    bridge: {
      terminal: new Terminal({ cols, rows: rows - 3, allowProposedApi: true }),
      alive: true,
    } as unknown as PtyBridge,
    label: 'claude-code',
    escalationAvailable: true,
    scrollOffset: null,
  };
  const listener = createInitialState();
  const deps: MuxRendererDeps = {
    getActiveTab: () => tab,
    getTabs: () => [tab],
    getActiveTabIndex: () => 0,
    getMode: () => 'persona-picker',
    getInputBuffer: () => '',
    getCursorPos: () => 0,
    getEscalationState: () => listener,
    getPendingCount: () => 0,
    getPickerState: () => null,
    getResumePickerState: () => null,
    getPersonaPickerState: () => state,
    getProviderPickerState: () => null,
    getEscalationPickerState: () => null,
    getBulkApproveState: () => null,
    getMessagePanelState: () => null,
    getScrollOffset: () => null,
  };
  const renderer = createMuxRenderer(capture.term, cols, rows, deps);
  renderers.push(renderer);
  renderer.fullRedraw();
  return (await capture.screen()).rows.join('\n');
}

describe('mux persona picker', () => {
  it("shows a persona's agent model and marks malformed overrides as not ready", async () => {
    const screen = await renderPicker({
      personas: [
        {
          name: createPersonaName('cheap'),
          description: 'Inbox triage',
          compiled: true,
          workspacePath: '/tmp/cheap',
          agentModelId: 'anthropic:claude-haiku-4-5',
        },
        {
          name: createPersonaName('plain'),
          description: 'General work',
          compiled: true,
          workspacePath: '/tmp/plain',
        },
        {
          name: createPersonaName('broken'),
          description: 'Typo in its limits',
          compiled: true,
          workspacePath: '/tmp/broken',
          invalidOverrides: 'Persona "broken" has an invalid resourceBudget (maxSteps: expected number).',
        },
      ],
      selectedIndex: 1,
      scrollOffset: 0,
    });

    const line = (name: string): string => screen.split('\n').find((row) => row.includes(name)) ?? '';
    expect(line('cheap')).toContain('Inbox triage (anthropic:claude-haiku-4-5)');
    expect(line('plain')).toContain('General work');
    expect(line('plain')).not.toContain('(');
    expect(line('broken')).toContain('[invalid model or limits]');
  });
});

/**
 * MuxApp -- top-level orchestrator for the terminal multiplexer.
 *
 * Creates and owns all child components. Handles MuxAction dispatch,
 * tab lifecycle, resize events, trusted input flow, and cleanup.
 */

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */

import { performance } from 'node:perf_hooks';
import { createPtyBridge } from '../pty/pty-bridge.js';
import { resolveIroncurtainBin } from '../pty/resolve-ironcurtain-bin.js';
import { createMuxInputHandler, SCROLL_LINES, type MuxInputHandler } from './mux-input-handler.js';
import { createMuxEscalationManager, type MuxEscalationManager } from './mux-escalation-manager.js';
import { createMuxRenderer, type MuxRenderer } from './mux-renderer.js';
import { navigateFocus } from './escalation-picker-state.js';
import { writeTrustedUserContext } from '../escalation/trusted-input.js';
import { createPasteInterceptor, type PasteInterceptor } from './paste-interceptor.js';
import type { MuxTab, MuxAction } from './types.js';
import { validateWorkspacePath } from '../session/workspace-validation.js';
import { scanResumableSessions } from '../pty/session-scanner.js';
import { scanPersonas } from './persona-scanner.js';
import { parseNewCommandArgs } from './new-command-args.js';
import type { ProviderProfileSnapshot } from './provider-profile-snapshot.js';
import ora from 'ora';
import chalk from 'chalk';
import * as logger from '../logger.js';

export interface MuxApp {
  /** Starts the multiplexer (enters fullscreen, spawns initial session). */
  start(): Promise<void>;
  /** Graceful shutdown: kills all child processes, restores terminal. */
  shutdown(): Promise<void>;
}

export interface MuxAppOptions {
  /** Agent to use for PTY sessions. Defaults to 'claude-code'. */
  readonly agent?: string;
  /** Optional model ID override (passed as --model to child sessions). */
  readonly model?: string;
  /** When true, spawned child sessions capture LLM API traces (`--capture-traces`). */
  readonly captureTraces?: boolean;
  /** Whether to auto-spawn an initial session. Default: true. */
  readonly autoSpawn?: boolean;
  /** Protected paths for workspace validation. */
  readonly protectedPaths?: string[];
  /** Unique mux instance ID for session ownership. */
  readonly muxId?: string;
  /** PID of this mux process (for orphan detection by other mux instances). */
  readonly muxPid?: number;
  /**
   * Provider-profile snapshot for the `/new` picker. When it contains a
   * selectable (non-`native`) profile, `/new` shows a profile-picker step;
   * otherwise the step is skipped. Empty/absent → native-only, no step.
   */
  readonly providerProfiles?: readonly ProviderProfileSnapshot[];
}

/**
 * Creates and returns a MuxApp.
 */
export function createMuxApp(options: MuxAppOptions): MuxApp {
  const agent = options.agent ?? 'claude-code';
  const autoSpawn = options.autoSpawn ?? true;
  const protectedPaths = options.protectedPaths ?? [];
  const providerProfiles = options.providerProfiles ?? [];

  const tabs: MuxTab[] = [];
  let activeTabIndex = 0;
  /**
   * Task text from a `/new --task-scoped <task>` whose picker is still open:
   * the session the picker spawns is task-scoped. Cleared by that spawn and
   * by cancelling the picker.
   */
  let pendingTaskScope: string | undefined;
  let nextTabNumber = 1;
  let running = false;
  // Monotonic: a wall-clock step must neither skip nor stretch the arming delay.
  const clock = (): number => performance.now();

  // Components (initialized in start())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let term: any;
  let inputHandler!: MuxInputHandler;
  let escalationManager!: MuxEscalationManager;
  let renderer!: MuxRenderer;
  let pasteInterceptor: PasteInterceptor | undefined;

  function getActiveTab(): MuxTab | undefined {
    return tabs[activeTabIndex];
  }

  function removeTab(tab: MuxTab): void {
    if (tab.bridge.sessionId) {
      escalationManager.removeSession(tab.bridge.sessionId);
    }

    const index = tabs.indexOf(tab);
    if (index === -1) return;
    tabs.splice(index, 1);

    if (tabs.length === 0) {
      activeTabIndex = 0;
    } else if (activeTabIndex >= tabs.length) {
      activeTabIndex = tabs.length - 1;
    }
  }

  async function spawnSession(opts?: {
    workspacePath?: string;
    resumeSessionId?: string;
    agentOverride?: string;
    persona?: string;
    providerProfileName?: string;
    /** Task text for `--task-scoped` (the child compiles the scope). */
    taskScope?: string;
  }): Promise<MuxTab> {
    const { columns } = process.stdout;
    const ptyRows = renderer.layout.ptyViewportRows;
    const ptyCols = columns || 80;
    const sessionAgent = opts?.agentOverride ?? agent;

    const { bin, prefixArgs } = resolveIroncurtainBin();
    const bridge = await createPtyBridge({
      cols: ptyCols,
      rows: ptyRows,
      ironcurtainBin: bin,
      prefixArgs,
      agent: sessionAgent,
      workspacePath: opts?.workspacePath,
      resumeSessionId: opts?.resumeSessionId,
      persona: opts?.persona,
      providerProfileName: opts?.providerProfileName,
      model: options.model,
      captureTraces: options.captureTraces,
      ...(opts?.taskScope !== undefined ? { taskScope: opts.taskScope } : {}),
      muxId: options.muxId,
      muxPid: options.muxPid,
      // The mux re-renders cells, so the host terminal never sees a query
      // from the agent: the headless terminal answers it (cursor position,
      // device attributes) or the agent waits for a reply that never comes.
      answerTerminalQueries: true,
    });

    const tab: MuxTab = {
      number: nextTabNumber++,
      bridge,
      label: opts?.persona ? `${sessionAgent} (${opts.persona})` : sessionAgent,
      persona: opts?.persona,
      escalationAvailable: false,
      scrollOffset: null,
    };

    tabs.push(tab);

    // Wire bridge events
    bridge.onOutput(() => {
      if (getActiveTab() === tab) {
        renderer.scheduleRedraw();
      }
    });

    bridge.onExit((exitCode: number) => {
      // Skip UI effects if the mux is shutting down or the tab was already removed
      if (!running || !tabs.includes(tab)) return;

      removeTab(tab);
      renderer.fullRedraw();
      showMessage(`Session #${tab.number} exited with code ${exitCode}`);
      process.stderr.write('\x07');
    });

    bridge.onSessionDiscovered((registration) => {
      if (registration && tabs.includes(tab)) {
        tab.escalationAvailable = true;
        escalationManager.addSession(registration);
        tab.label = tab.persona ? `${registration.label} [${tab.persona}]` : registration.label;
        renderer.redrawTabBar();
      } else if (!registration) {
        logger.warn(`Could not discover session registration for tab #${tab.number}`);
        tab.escalationAvailable = false;
      }
    });

    return tab;
  }

  function switchTab(index: number): void {
    if (index < 0 || index >= tabs.length) return;
    activeTabIndex = index;
    renderer.fullRedraw();
  }

  function closeTab(tabNumber: number): void {
    const tab = tabs.find((t) => t.number === tabNumber);
    if (!tab) {
      showMessage(`No tab #${tabNumber}`);
      return;
    }

    tab.bridge.kill();
    removeTab(tab);
    renderer.fullRedraw();
  }

  /** Adjusts scroll offset by delta lines (negative = up, positive = down). */
  function adjustScroll(tab: MuxTab, delta: number): void {
    const baseY = tab.bridge.terminal.buffer.active.baseY;
    if (baseY === 0) return; // no scrollback available
    const current = tab.scrollOffset ?? baseY;
    const newOffset = current + delta;
    if (newOffset >= baseY) {
      tab.scrollOffset = null; // snap to live
    } else {
      tab.scrollOffset = Math.max(0, newOffset);
    }
  }

  function showMessage(message: string): void {
    logger.info(message);
    renderer.showMessage(message);
  }

  /**
   * Shows multi-line output in the dismissible message panel. The footer
   * flash holds one line only (anything more scrolls the alternate screen),
   * so a result with several lines opens the panel instead; while another
   * overlay is open, or when a single line is all there is, the flash is used.
   */
  function showLines(title: string, lines: readonly string[]): void {
    const mode = inputHandler.mode;
    if (lines.length <= 1 || (mode !== 'pty' && mode !== 'command')) {
      showMessage(lines.join('\n'));
      return;
    }
    logger.info(`${title}: ${lines.join(' | ')}`);
    inputHandler.enterMessagePanel(title, lines, mode);
    renderer.fullRedraw();
  }

  /** Bulk resolve results are one line per escalation; more than one goes to the panel. */
  function showResolveResult(message: string): void {
    showLines('Escalations resolved', message.split('\n'));
  }

  function baseMode(): 'pty' | 'command' {
    return inputHandler.mode === 'command' ? 'command' : 'pty';
  }

  /** Moves the picker's focus one tab; a different escalation re-arms it (see escalation-picker-state.ts). */
  function navigateEscalationTab(direction: 'next' | 'prev'): void {
    const eps = inputHandler.escalationPickerState;
    if (!eps) return;
    const target = navigateFocus(escalationManager.pendingRefs(), eps.focusedDisplayNumber, direction);
    if (target) inputHandler.focusEscalation(target);
  }

  /**
   * `/approve all` and `/approve+ all`: opens the confirmation screen that
   * lists every pending escalation. Nothing is approved here; `y` on that
   * screen approves exactly the listed set (escalation-approve-reviewed).
   */
  function openApproveAllConfirmation(whitelist: boolean): void {
    const pending = escalationManager.pendingRefs();
    if (pending.length === 0) {
      showMessage('No pending escalations');
      return;
    }
    const approvable = pending.filter(
      (ref) => escalationManager.state.pendingEscalations.get(ref.displayNumber)?.request.humanOnly !== true,
    );
    if (approvable.length === 0) {
      const numbers = pending.map((ref) => `#${ref.displayNumber}`).join(', ');
      showMessage(`Nothing to approve in bulk: ${numbers} must be approved one at a time (/approve N)`);
      return;
    }
    inputHandler.enterBulkApproveConfirm(pending, whitelist, baseMode());
    renderer.fullRedraw();
  }

  /**
   * `/approve group N` and `/approve+ group N`: opens the confirmation screen
   * listing every pending escalation that shares #N's whitelist pattern
   * (escalation/escalation-groups.ts). Nothing is approved here; `y` on that
   * screen approves exactly the listed members, and only while they are
   * still exactly the group.
   */
  function openApproveGroupConfirmation(displayNumber: number, whitelist: boolean): void {
    const command = whitelist ? '/approve+' : '/approve';
    if (!escalationManager.state.pendingEscalations.has(displayNumber)) {
      showMessage(`No pending escalation #${displayNumber}`);
      return;
    }
    const group = escalationManager.groupOf(displayNumber);
    if (!group) {
      showMessage(
        `Escalation #${displayNumber} is not in a group (no whitelist pattern, or human-only): use ${command} ${displayNumber}`,
      );
      return;
    }
    if (group.members.length < 2) {
      showMessage(
        `No other pending escalation shares the pattern of #${displayNumber}: use ${command} ${displayNumber}`,
      );
      return;
    }
    inputHandler.enterBulkApproveConfirm(group.members, whitelist, baseMode(), {
      key: group.key,
      description: group.description,
    });
    renderer.fullRedraw();
  }

  async function handleAction(action: MuxAction): Promise<void> {
    switch (action.kind) {
      case 'none':
        break;

      case 'write-pty': {
        const active = getActiveTab();
        if (active && active.bridge.alive) {
          active.bridge.write(action.data);
        }
        break;
      }

      case 'enter-command-mode':
      case 'enter-pty-mode':
        renderer.fullRedraw();
        break;

      case 'command':
        handleCommand(action.command, action.args);
        break;

      case 'trusted-input': {
        const active = getActiveTab();
        if (active && active.bridge.alive) {
          if (active.bridge.escalationDir) {
            writeTrustedUserContext(active.bridge.escalationDir, action.text);
          } else {
            logger.warn(`Tab #${active.number}: escalation dir not yet available, skipping user-context write`);
            process.stderr.write('\x07');
          }
          // Write text first, then \r separately after a short delay so
          // Claude Code's Ink UI processes them as distinct input events.
          // A single write of "text\r" arrives as one chunk and Ink may
          // not trigger Enter when \r is bundled with preceding text.
          active.bridge.write(action.text);
          const bridge = active.bridge;
          setTimeout(() => {
            if (bridge.alive) bridge.write('\r');
          }, 50);
        }
        renderer.fullRedraw();
        break;
      }

      case 'redraw-input':
        renderer.redrawCommandArea();
        break;

      case 'enter-picker-mode':
        renderer.fullRedraw();
        break;

      case 'picker-spawn': {
        let validatedPath: string | undefined;
        if (action.workspacePath) {
          try {
            validatedPath = validateWorkspacePath(action.workspacePath, protectedPaths);
          } catch (err) {
            inputHandler.enterBrowseWithError(
              action.workspacePath,
              err instanceof Error ? err.message : String(err),
              action.persona,
            );
            renderer.fullRedraw();
            break;
          }
        }
        // A `/new --task-scoped <task>` that opened this picker scopes the
        // session it spawns; the task is consumed by this one spawn.
        const taskScope = pendingTaskScope;
        pendingTaskScope = undefined;
        const tab = await spawnSession({
          workspacePath: validatedPath,
          persona: action.persona,
          providerProfileName: action.providerProfileName,
          ...(taskScope !== undefined ? { taskScope } : {}),
        });
        activeTabIndex = tabs.length - 1;
        const personaPrefix = action.persona ? `persona "${action.persona}" ` : '';
        const scopePrefix = taskScope !== undefined ? 'task-scoped ' : '';
        const profileSuffix = action.providerProfileName ? ` [${action.providerProfileName}]` : '';
        const suffix = validatedPath ? ` in ${validatedPath}` : '';
        showMessage(`Spawned ${scopePrefix}${personaPrefix}session #${tab.number}${suffix}${profileSuffix}`);
        inputHandler.exitPickerMode();
        renderer.fullRedraw();
        break;
      }

      case 'picker-cancel':
        pendingTaskScope = undefined;
        renderer.fullRedraw();
        break;

      case 'resume-spawn': {
        const resumeTab = await spawnSession({
          resumeSessionId: action.sessionId,
          agentOverride: action.agent,
        });
        activeTabIndex = tabs.length - 1;
        showMessage(`Resuming session ${action.sessionId.substring(0, 8)} as tab #${resumeTab.number}`);
        renderer.fullRedraw();
        break;
      }

      case 'persona-spawn': {
        const personaTab = await spawnSession({
          persona: action.persona,
          ...(action.taskScope !== undefined ? { taskScope: action.taskScope } : {}),
        });
        activeTabIndex = tabs.length - 1;
        const scopePrefix = action.taskScope !== undefined ? 'task-scoped ' : '';
        showMessage(`Spawned ${scopePrefix}persona "${action.persona}" as tab #${personaTab.number}`);
        renderer.fullRedraw();
        break;
      }

      case 'redraw-picker':
        renderer.redrawCommandArea();
        break;

      case 'escalation-open': {
        // Ctrl-E is the only way into the picker: an arrival never opens it.
        const pending = escalationManager.pendingRefs();
        if (pending.length === 0) {
          showMessage('No pending escalations');
          break;
        }
        inputHandler.enterEscalationPickerMode(pending[0], baseMode());
        renderer.fullRedraw();
        break;
      }

      case 'escalation-dismiss': {
        inputHandler.dismissEscalationPicker(action.targetMode);
        renderer.fullRedraw();
        break;
      }

      case 'escalation-navigate': {
        navigateEscalationTab(action.direction);
        renderer.redrawCommandArea();
        break;
      }

      case 'escalation-resolve': {
        // Bound to the request the picker showed: the manager refuses the
        // decision when another one is pending under that number.
        const message = escalationManager.resolve(action.displayNumber, action.decision, {
          whitelist: action.whitelist,
          escalationId: action.escalationId,
        });
        showMessage(message);
        // onChange callback (fired synchronously by resolve) handles focus adjustment,
        // re-arming, auto-close, and redraws — no additional redraw needed here.
        break;
      }

      case 'escalation-deny-all': {
        const message = escalationManager.denyAll();
        // onChange (fired synchronously by resolve) has already auto-closed the
        // picker, so the per-escalation results can open the message panel.
        showResolveResult(message);
        break;
      }

      case 'escalation-approve-reviewed': {
        // Close the screen first: the results may open the message panel.
        inputHandler.exitBulkApproveConfirm();
        // The manager approves only if the pending set (or, for a group, the
        // group's members) is still exactly the one the screen listed.
        const message =
          action.groupKey !== undefined
            ? escalationManager.approveGroup(action.reviewed, action.groupKey, { whitelist: action.whitelist })
            : escalationManager.approveAll(action.reviewed, { whitelist: action.whitelist });
        renderer.fullRedraw();
        showResolveResult(message);
        break;
      }

      case 'escalation-approve-all-cancel':
        inputHandler.exitBulkApproveConfirm();
        renderer.fullRedraw();
        showMessage('Approve all cancelled: nothing was approved');
        break;

      case 'message-panel-dismiss':
        inputHandler.exitMessagePanel();
        renderer.fullRedraw();
        break;

      case 'scroll-up':
      case 'scroll-down': {
        const active = getActiveTab();
        if (!active) break;
        const delta = action.kind === 'scroll-up' ? -action.amount : action.amount;
        adjustScroll(active, delta);
        renderer.scheduleRedraw();
        break;
      }

      case 'quit':
        doShutdown();
        break;
    }
  }

  function handleCommand(command: string, args: string[]): void {
    switch (command) {
      case 'approve':
      case 'approve+':
      case 'deny':
      case 'deny+': {
        const baseCommand = command.endsWith('+') ? command.slice(0, -1) : command;
        // Only approve+ enables whitelisting; deny+ is treated as plain deny.
        const withWhitelist = command === 'approve+';
        const decision = baseCommand === 'approve' ? 'approved' : 'denied';
        const arg = args[0];
        if (!arg) {
          showMessage(
            decision === 'approved'
              ? `Usage: /${command} <number>, /${command} all or /${command} group <number>`
              : `Usage: /${command} <number> or /${command} all`,
          );
          break;
        }
        if (arg === 'group' && decision === 'approved') {
          // Group approval only through the screen that lists every member.
          // A missing number parses as NaN.
          const groupNumber = args.length > 1 ? parseInt(args[1], 10) : NaN;
          if (isNaN(groupNumber)) {
            showMessage(`Usage: /${command} group <number>`);
            break;
          }
          openApproveGroupConfirmation(groupNumber, withWhitelist);
          break;
        }
        if (arg === 'all') {
          if (decision === 'approved') {
            // Bulk approval only through the screen that lists every item.
            openApproveAllConfirmation(withWhitelist);
            break;
          }
          const message = escalationManager.denyAll();
          renderer.redrawTabBar();
          renderer.redrawCommandArea();
          showResolveResult(message);
          break;
        }
        const num = parseInt(arg, 10);
        if (isNaN(num)) {
          showMessage('Invalid escalation number');
          break;
        }
        showMessage(escalationManager.resolve(num, decision, { whitelist: withWhitelist ? 'exact' : false }));
        renderer.redrawTabBar();
        renderer.redrawCommandArea();
        break;
      }

      case 'approve+dir': {
        // Approve and whitelist the directory-wide pattern: an explicit
        // choice, one escalation at a time (never in bulk). The manager
        // refuses, resolving nothing, when the escalation offers none.
        const arg = args[0];
        if (!arg) {
          showMessage('Usage: /approve+dir <number>');
          break;
        }
        if (arg === 'all' || arg === 'group') {
          showMessage('Directory-wide whitelisting is chosen one escalation at a time: /approve+dir <number>');
          break;
        }
        const num = parseInt(arg, 10);
        if (isNaN(num)) {
          showMessage('Invalid escalation number');
          break;
        }
        showMessage(escalationManager.resolve(num, 'approved', { whitelist: 'directory' }));
        renderer.redrawTabBar();
        renderer.redrawCommandArea();
        break;
      }

      case 'new': {
        const parsed = parseNewCommandArgs(args);
        if ('error' in parsed) {
          showMessage(parsed.error);
          break;
        }
        const personaArg = parsed.persona;
        if (personaArg) {
          // Validate persona before spawning
          const personas = scanPersonas();
          const match = personas.find((p) => p.name === personaArg);
          if (!match) {
            showMessage(`Unknown persona: "${personaArg}"`);
            break;
          }
          if (!match.compiled) {
            showMessage(`Persona "${personaArg}" is not compiled. Run: ironcurtain persona compile ${personaArg}`);
            break;
          }
          if (match.stale) {
            showMessage(
              `Persona "${personaArg}" has a stale compiled policy (its constitution changed). ` +
                `Run: ironcurtain persona compile ${personaArg}`,
            );
            break;
          }
          if (match.invalidOverrides !== undefined) {
            showMessage(match.invalidOverrides);
            break;
          }
          void handleAction({
            kind: 'persona-spawn',
            persona: personaArg,
            ...(parsed.taskScope !== undefined ? { taskScope: parsed.taskScope } : {}),
          });
          break;
        }
        // Held until the picker spawns (or is cancelled).
        pendingTaskScope = parsed.taskScope;
        const personas = scanPersonas();
        inputHandler.enterPickerMode(personas, [...providerProfiles]);
        renderer.fullRedraw();
        break;
      }

      case 'resume': {
        const directId = args[0];
        if (directId) {
          // Direct resume by session ID
          const sessions = scanResumableSessions(protectedPaths);
          const match = sessions.find((s) => s.sessionId.startsWith(directId));
          if (!match) {
            showMessage(`No resumable session matching "${directId}"`);
          } else {
            void handleAction({ kind: 'resume-spawn', sessionId: match.sessionId, agent: match.agent });
          }
          break;
        }
        // Open the resume picker
        const sessions = scanResumableSessions(protectedPaths);
        if (sessions.length === 0) {
          showMessage('No resumable sessions found');
          break;
        }
        inputHandler.enterResumePickerMode(sessions);
        renderer.fullRedraw();
        break;
      }

      case 'tab': {
        const num = parseInt(args[0], 10);
        if (isNaN(num)) {
          showMessage('Usage: /tab <number>');
          break;
        }
        const index = tabs.findIndex((t) => t.number === num);
        if (index === -1) {
          showMessage(`No tab #${num}`);
          break;
        }
        switchTab(index);
        break;
      }

      case 'close': {
        const num = args[0] ? parseInt(args[0], 10) : getActiveTab()?.number;
        if (num === undefined || isNaN(num)) {
          showMessage('Usage: /close [number]');
          break;
        }
        closeTab(num);
        break;
      }

      case 'sessions': {
        const sessionLines = [...escalationManager.state.sessions.values()].map(
          (s) => `[${s.displayNumber}] ${s.registration.sessionId.substring(0, 8)} ${s.registration.label}`,
        );
        if (sessionLines.length === 0) {
          showMessage('No active sessions');
          break;
        }
        // One line per session: the message panel, not the one-row flash.
        inputHandler.enterMessagePanel('Sessions', sessionLines, baseMode());
        renderer.fullRedraw();
        break;
      }

      case 'quit':
      case 'q':
        doShutdown();
        break;

      default:
        showMessage(`Unknown command: /${command}`);
    }
  }

  let resolveShutdown: (() => void) | null = null;

  function doShutdown(): void {
    if (!running) return;
    running = false;

    pasteInterceptor?.uninstall();
    escalationManager.stop();

    // Exit fullscreen and destroy renderer before any async work
    // so the normal terminal is restored immediately.
    if (term) {
      if (process.platform === 'darwin') {
        process.stdout.write('\x1b[?1007l');
      }
      process.stdout.write('\x1b[?7h'); // restore autowrap
      term.grabInput(false);
      term.hideCursor(false);
      term.fullscreen(false);
      term.styleReset();
    }
    renderer.destroy();

    // Collect alive tabs that need to be waited on
    const aliveTabs = tabs.filter((t) => t.bridge.alive);

    if (aliveTabs.length === 0) {
      resolveShutdown?.();
      return;
    }

    // Show a spinner on the real terminal while children shut down
    const spinner = ora({
      text: `Shutting down ${aliveTabs.length} PTY session${aliveTabs.length > 1 ? 's' : ''}...`,
      stream: process.stderr,
      discardStdin: false,
    }).start();

    // Kill all children
    for (const tab of aliveTabs) {
      tab.bridge.kill();
    }

    // Wait for all children to exit, with a safety timeout
    let remaining = aliveTabs.length;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      spinner.succeed(chalk.dim('All sessions ended'));
      resolveShutdown?.();
    };

    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      spinner.warn(chalk.dim(`Timed out waiting for ${remaining} session(s)`));
      resolveShutdown?.();
    }, 10_000);

    for (const tab of aliveTabs) {
      tab.bridge.onExit(() => {
        remaining--;
        if (remaining === 0) settle();
      });
    }
  }

  return {
    async start(): Promise<void> {
      running = true;

      const terminalKit = await import('terminal-kit');
      // CJS interop: terminal lives on the default export object
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      term = terminalKit.default.terminal ?? (terminalKit as any).terminal;

      term.fullscreen(true);
      term.hideCursor(true);
      // Autowrap off while fullscreen (DECAWM reset): a write that reaches the
      // last column of the bottom row would otherwise wrap and scroll the
      // alternate screen, shifting every region. The renderer also cuts its
      // text to the width; this is the guard for anything it misses. Restored
      // on shutdown and at exit.
      process.stdout.write('\x1b[?7l');

      if (process.platform === 'darwin') {
        // On macOS, avoid X11 mouse tracking -- it prevents native text selection
        // (Shift+click drag) in Terminal.app. Instead, enable alternate scroll mode
        // which translates scroll wheel into Up/Down arrow sequences while the
        // alternate screen buffer is active (enabled by fullscreen(true) above).
        term.grabInput({ mouse: false });
        process.stdout.write('\x1b[?1007h');
      } else {
        term.grabInput({ mouse: 'button' });
      }

      inputHandler = createMuxInputHandler({
        initialMode: autoSpawn ? 'pty' : 'command',
        // One monotonic clock for the arming delay, shared with the renderer.
        now: clock,
        // `a` and `w` approve only an escalation the picker has drawn in full
        // for the arming delay, and `y` on the approve-all screen only a list
        // that has been on screen completely; the renderer is created below,
        // before any key can arrive.
        displayedEscalation: () => renderer.displayedEscalation,
        displayedBulkApproval: () => renderer.displayedBulkApproval,
      });

      pasteInterceptor = createPasteInterceptor((text) => {
        if (!running) return;
        const action = inputHandler.handlePaste(text);
        void handleAction(action);
      });
      pasteInterceptor.install();
      escalationManager = createMuxEscalationManager({ muxId: options.muxId });

      const { columns, rows } = process.stdout;
      const cols = columns || 80;
      const totalRows = rows || 24;

      renderer = createMuxRenderer(term, cols, totalRows, {
        getActiveTab,
        getTabs: () => tabs,
        getActiveTabIndex: () => activeTabIndex,
        getMode: () => inputHandler.mode,
        getInputBuffer: () => inputHandler.inputBuffer,
        getCursorPos: () => inputHandler.cursorPos,
        getEscalationState: () => escalationManager.state,
        getPendingCount: () => escalationManager.pendingCount,
        getPickerState: () => inputHandler.pickerState,
        getResumePickerState: () => inputHandler.resumePickerState,
        getPersonaPickerState: () => inputHandler.personaPickerState,
        getProviderPickerState: () => inputHandler.providerPickerState,
        getEscalationPickerState: () => inputHandler.escalationPickerState,
        getBulkApproveState: () => inputHandler.bulkApproveState,
        getMessagePanelState: () => inputHandler.messagePanelState,
        getScrollOffset: () => {
          const active = getActiveTab();
          return active?.scrollOffset ?? null;
        },
        now: clock,
      });

      term.on('key', (key: string, _matches: unknown, data: { code?: Buffer | number }) => {
        if (!running) return;
        const action = inputHandler.handleKey(key, data.code);
        void handleAction(action);
      });

      // Mouse events come through a separate 'mouse' emitter, not 'key'
      term.on('mouse', (name: string) => {
        if (!running) return;
        if (name === 'MOUSE_WHEEL_UP') {
          void handleAction({ kind: 'scroll-up', amount: SCROLL_LINES });
        } else if (name === 'MOUSE_WHEEL_DOWN') {
          void handleAction({ kind: 'scroll-down', amount: SCROLL_LINES });
        }
      });

      process.stdout.on('resize', () => {
        const { columns: newCols, rows: newRows } = process.stdout;
        if (!newCols || !newRows) return;

        renderer.resize(newCols, newRows);

        const layout = renderer.layout;
        for (const tab of tabs) {
          if (tab.bridge.alive) {
            tab.bridge.resize(newCols, layout.ptyViewportRows);
          }
        }

        renderer.fullRedraw();
      });

      escalationManager.onChange(() => {
        // The transition rules live in escalation-picker-state.ts
        // (reconcileEscalationUi): an arrival never takes the keyboard -- the
        // manager rings the bell, the tab bar and footer show the badge and
        // the footer banner, and Ctrl-E opens the picker. An open picker
        // closes when nothing is left and re-arms when its focus snaps to
        // another escalation; the approve-all screen closes when its set
        // changes.
        const transition = inputHandler.reconcileEscalations(escalationManager.pendingRefs());
        if (transition.outcome === 'picker-closed' || transition.outcome === 'bulk-cancelled') {
          renderer.fullRedraw();
        } else {
          renderer.redrawTabBar();
          renderer.redrawCommandArea();
        }
        if (transition.message) showMessage(transition.message);
      });

      escalationManager.startRegistryPolling();

      // Back-fill bridge registrations that timed out during initial
      // discovery. When registry polling finds a session whose PID
      // matches a bridge that still has no registration, push it in.
      escalationManager.onSessionDiscovered((reg) => {
        for (const tab of tabs) {
          if (tab.bridge.pid === reg.pid && !tab.bridge.sessionId) {
            tab.bridge.updateRegistration(reg);
            tab.escalationAvailable = true;
            tab.label = reg.label;
            escalationManager.claimSession(reg.sessionId);
            renderer.redrawTabBar();
            break;
          }
        }
      });

      const handleSignal = (): void => {
        doShutdown();
      };
      process.on('SIGINT', handleSignal);
      process.on('SIGTERM', handleSignal);
      process.on('SIGHUP', handleSignal);

      process.on('exit', () => {
        pasteInterceptor?.uninstall();
        if (term) {
          if (process.platform === 'darwin') {
            process.stdout.write('\x1b[?1007l');
          }
          process.stdout.write('\x1b[?7h'); // restore autowrap
          term.grabInput(false);
        }
      });

      if (autoSpawn) {
        await spawnSession();
      }

      renderer.fullRedraw();

      await new Promise<void>((resolve) => {
        if (!running) {
          resolve();
          return;
        }
        resolveShutdown = resolve;
      });
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async shutdown(): Promise<void> {
      doShutdown();
    },
  };
}

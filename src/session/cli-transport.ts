/**
 * CLI transport -- reads from stdin, writes to stdout/stderr.
 *
 * Supports two modes:
 * - Single-shot: if initialMessage is provided, sends it and returns
 * - Interactive: event-driven REPL with slash commands
 *
 * Provides a rich terminal experience:
 * - Spinner (via ora) during message processing
 * - Colored prompts and status messages (via chalk)
 * - Markdown-rendered agent responses (via marked + marked-terminal)
 *
 * Slash commands:
 *   /quit, /exit  -- end the session
 *   /logs         -- display accumulated diagnostic events
 *   /budget       -- show resource budget usage
 *   /approve [N]      -- approve a pending escalation
 *   /approve+ [N]     -- approve and whitelist the exact pattern for this session
 *   /approve+dir [N]  -- approve and whitelist the directory-wide pattern, when offered
 *   /deny [N]         -- deny a pending escalation
 *
 * Several escalations can be pending at once (the agent's parallel tool
 * calls each wait for a decision). Each banner carries the escalation's
 * number; a command without a number decides the only pending escalation
 * and is refused, deciding nothing, while more than one is pending.
 *
 * Untrusted text. Agent responses, tool previews, escalation arguments,
 * reasons, context values and whitelist descriptions are agent-influenced
 * and are written to the user's terminal. Raw escape sequences there can
 * overwrite the approval banner or set the clipboard (OSC 52), so quoted
 * fields go through `toDisplayText` (hidden characters become visible
 * `\u...` escapes) and agent prose goes through `stripTerminalSequences` and
 * `escapeBidiControls` before markdown rendering, which adds its own
 * legitimate styling.
 */

import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import ora from 'ora';
import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { Ora } from 'ora';
import { BaseTransport } from './base-transport.js';
import type { Session, DiagnosticEvent, EscalationRequest, BudgetStatus } from './types.js';
import { formatTrackedTokens, NO_EXCHANGES_OBSERVED_YET, partialTokensNote } from './usage-display.js';
import { formatCostAgainstLimit, formatCostSummary, formatCostUsd } from './cost-display.js';
import {
  DEFAULT_WHITELIST_OPTIONS,
  directoryCandidateIndex,
  type WhitelistCandidateIpc,
} from '../trusted-process/approval-whitelist.js';
import { escapeBidiControls, stripTerminalSequences, toDisplayText } from '../terminal/display-sanitize.js';
import { displayedUserMessage } from '../escalation/escalation-review.js';
import { isEscalationExpiredError } from '../types/errors.js';
import { formatSessionNotice, formatStartupNotice, isStartupNotice, type StartupNotice } from './startup-notices.js';

/** Options for constructing a CliTransport. */
export interface CliTransportOptions {
  /** If provided, run in single-shot mode with this message. */
  initialMessage?: string;
  /** Override stdin for testing. Defaults to process.stdin. */
  input?: Readable;
  /** When true, save session memory when the session ends. */
  autoSaveMemory?: boolean;
  /** When true, session is running in Docker mode. */
  dockerMode?: boolean;
}

// Configure marked to render markdown for the terminal.
// This is module-level since marked is a singleton.
marked.use(markedTerminal());
// Agent links must expose their destinations even on OSC 8-capable terminals.
// This override also keeps non-web schemes inert; nothing here opens a URI.
marked.use({
  renderer: {
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      const destination = toDisplayText(href);
      return label === destination ? destination : `${label} (${destination})`;
    },
    image({ href, text, title }) {
      const label = toDisplayText(text);
      const caption = title ? ` — ${toDisplayText(title)}` : '';
      return `[image: ${label}${caption}] ${toDisplayText(href)}`;
    },
  },
});

export class CliTransport extends BaseTransport {
  private readonly initialMessage?: string;
  private readonly input: Readable;

  /** The spinner instance, managed across the message lifecycle. */
  private spinner: Ora | null = null;

  /** The readline interface, stored so escalation handlers can re-prompt. */
  private rl: ReturnType<typeof createInterface> | null = null;

  /**
   * The number each pending escalation's banner shows, by escalation id.
   * An entry is removed once its escalation is decided or expires, so the
   * map holds exactly the escalations this transport is waiting on.
   */
  private readonly escalationNumbers = new Map<string, number>();
  private nextEscalationNumber = 1;

  /** The session being run: the source of truth for which escalations are still pending. */
  private session: Session | null = null;

  /**
   * Start-up notices (`annotation_drift`, `mcp_server_unavailable`,
   * `host_model_fallback`, `policy_stale`) received while the session was
   * being created, under the caller's initialization spinner. Printed when
   * the session starts running, so they are neither garbled by nor hidden
   * behind a spinner.
   */
  private startupNotices: StartupNotice[] = [];

  constructor(options: CliTransportOptions = {}) {
    super({ autoSaveMemory: options.autoSaveMemory, dockerMode: options.dockerMode });
    this.initialMessage = options.initialMessage;
    this.input = options.input ?? process.stdin;
  }

  protected async runSession(session: Session): Promise<void> {
    this.session = session;
    this.printStartupNotices();
    if (this.initialMessage) {
      return this.runSingleShot(session);
    }
    return this.runInteractive(session);
  }

  /**
   * Signals the transport to stop: closes readline (unblocking runInteractive)
   * and stops any active spinner.
   */
  close(): void {
    if (this.spinner?.isSpinning) {
      this.spinner.stop();
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /**
   * Returns an onDiagnostic callback that updates the spinner.
   * Wire this into SessionOptions so the transport controls display.
   */
  createDiagnosticHandler(): (event: DiagnosticEvent) => void {
    return (event) => {
      if (isStartupNotice(event)) {
        // Emitted while the session initializes: keep it for printStartupNotices().
        this.startupNotices.push(event);
        return;
      }
      if (event.kind === 'host_privileged_files') {
        // After a turn (the spinner still runs until the response arrives)
        // or at session end: printed right away, above the spinner.
        this.printAboveSpinner(chalk.yellow(`${formatSessionNotice(event)}\n`));
        return;
      }
      if (!this.spinner?.isSpinning) return;

      switch (event.kind) {
        case 'tool_call':
          this.spinner.text = 'Executing code...';
          break;
        case 'agent_text':
          this.spinner.text = 'Generating response...';
          break;
        case 'budget_warning':
          this.spinner.text = chalk.yellow(`Budget warning: ${event.message}`);
          break;
        case 'budget_exhausted':
          this.spinner.fail(chalk.red(`Budget exhausted: ${event.message}`));
          break;
        case 'message_compaction':
          this.spinner.text = 'Compacting conversation history...';
          break;
        case 'message_compaction_failed':
          this.spinner.text = chalk.yellow('Compaction failed; continuing with the full history...');
          break;
      }
    };
  }

  /** Writes `text` to stderr without garbling a running spinner: it is paused and resumed below the text. */
  private printAboveSpinner(text: string): void {
    const spinner = this.spinner;
    if (spinner?.isSpinning) {
      spinner.stop();
      process.stderr.write(text);
      spinner.start();
      return;
    }
    process.stderr.write(text);
  }

  /** Prints the start-up notices once, before the first prompt or message. */
  private printStartupNotices(): void {
    const notices = this.startupNotices;
    this.startupNotices = [];
    for (const notice of notices) {
      process.stderr.write(chalk.yellow(`${formatStartupNotice(notice)}\n`));
    }
    if (notices.length > 0) process.stderr.write('\n');
  }

  /**
   * Returns an onEscalationExpired callback that notifies the user that the
   * proxy timed this escalation out (the call was denied).
   */
  createEscalationExpiredHandler(): (escalationId: string) => void {
    return (escalationId) => {
      const number = this.escalationNumbers.get(escalationId);
      this.escalationNumbers.delete(escalationId);
      const which = number === undefined ? '' : ` #${number}`;
      process.stderr.write(chalk.yellow(`  Escalation${which} expired (timed out).\n`));
      this.afterEscalationSettled();
    };
  }

  /**
   * Returns an onEscalation callback that stops the spinner and
   * shows an escalation banner, numbered, with the readline prompt so the
   * user can type /approve or /deny. The spinner is restarted only once no
   * escalation is pending any more (see afterEscalationSettled).
   */
  createEscalationHandler(): (request: EscalationRequest) => void {
    return (request) => {
      if (this.spinner?.isSpinning) {
        this.spinner.stop();
      }

      this.writeEscalationBanner(request, this.escalationNumber(request.escalationId));

      // Re-show the readline prompt so the user can type /approve or /deny
      if (this.rl) {
        this.rl.prompt();
      }
    };
  }

  /** The number shown for an escalation, assigned when it is first seen. */
  private escalationNumber(escalationId: string): number {
    let number = this.escalationNumbers.get(escalationId);
    if (number === undefined) {
      number = this.nextEscalationNumber++;
      this.escalationNumbers.set(escalationId, number);
    }
    return number;
  }

  /**
   * After an escalation was decided or expired: while others are still
   * pending, say which and keep the prompt; once none is, restart the
   * spinner, because sendMessage() is still in flight, waiting for the proxy
   * to process the escalation results and continue.
   */
  private afterEscalationSettled(): void {
    // Forget numbers the session no longer has pending (decided elsewhere,
    // or a decision that came too late).
    if (this.session) {
      const pending = new Set(this.session.getPendingEscalations().map((request) => request.escalationId));
      for (const escalationId of [...this.escalationNumbers.keys()]) {
        if (!pending.has(escalationId)) this.escalationNumbers.delete(escalationId);
      }
    }
    if (this.escalationNumbers.size > 0) {
      const numbers = [...this.escalationNumbers.values()].map((n) => `#${n}`).join(', ');
      process.stderr.write(chalk.yellow(`  Still pending: ${numbers}. Decide each with /approve N or /deny N.\n`));
      this.rl?.prompt();
      return;
    }
    this.startSpinner('Processing...');
  }

  // --- Single-shot mode ---

  private async runSingleShot(session: Session): Promise<void> {
    this.startSpinner('Thinking...');

    try {
      if (!this.initialMessage) throw new Error('runSingleShot called without initialMessage');
      const response = await this.sendAndLog(session, this.initialMessage);
      this.spinner?.stop();
      process.stdout.write('\n');
      process.stdout.write(renderAgentMarkdown(response));

      this.displaySessionSummary(session.getBudgetStatus());
    } catch (error) {
      this.stopSpinnerWithError(error);
      // A budget stop ends the task without an answer, but its steps were
      // paid for: still show what the session spent.
      if (isBudgetExhausted(error)) this.displaySessionSummary(session.getBudgetStatus());
      throw error;
    }
  }

  // --- Interactive mode ---

  private async runInteractive(session: Session): Promise<void> {
    this.rl = createInterface({
      input: this.input,
      output: process.stderr, // Prompts to stderr, responses to stdout
      prompt: chalk.cyan('> '),
    });
    const rl = this.rl;

    process.stderr.write(chalk.dim('IronCurtain interactive mode. Type /quit to exit.\n\n'));
    process.stderr.write(
      chalk.dim('Commands: /quit /logs /budget /approve [N] /approve+ [N] /approve+dir [N] /deny [N]\n\n'),
    );
    rl.prompt();

    let running = true;
    let messageInFlight = false;

    const processLine = async (input: string): Promise<void> => {
      const trimmed = input.trim();
      if (!trimmed) {
        rl.prompt();
        return;
      }

      if (
        this.handleSlashCommand(trimmed, session, () => {
          running = false;
          rl.close();
        })
      ) {
        if (running) rl.prompt();
        return;
      }

      if (messageInFlight) {
        process.stderr.write(chalk.dim('  (still processing previous message, please wait)\n'));
        rl.prompt();
        return;
      }

      messageInFlight = true;
      this.startSpinner('Thinking...');

      try {
        const response = await this.sendAndLog(session, trimmed);
        this.spinner?.stop();
        process.stdout.write('\n');
        process.stdout.write(renderAgentMarkdown(response));
        process.stdout.write('\n');
      } catch (error) {
        this.stopSpinnerWithError(error);
      } finally {
        messageInFlight = false;
        if (running) rl.prompt();
      }
    };

    rl.on('line', (line) => {
      if (running) {
        processLine(line).catch((err: unknown) => {
          process.stderr.write(chalk.red(`Unexpected error: ${errorText(err)}\n`));
        });
      }
    });

    // When readline is active on a TTY, Ctrl-C is intercepted at the raw
    // stream level and never reaches process-level SIGINT handlers.
    // We must re-emit SIGINT so the shutdown handler in index.ts fires.
    rl.on('SIGINT', () => {
      process.emit('SIGINT');
    });

    await new Promise<void>((resolvePromise) => {
      rl.on('close', () => {
        this.rl = null;
        resolvePromise();
      });
    });

    this.displaySessionSummary(session.getBudgetStatus());
  }

  // --- Slash commands ---

  /**
   * Handles slash commands. Returns true if the input was a command,
   * false if it should be treated as a regular message.
   */
  private handleSlashCommand(input: string, session: Session, onQuit: () => void): boolean {
    if (input === '/quit' || input === '/exit') {
      onQuit();
      return true;
    }

    if (input === '/logs') {
      this.displayDiagnosticLog(session.getDiagnosticLog());
      return true;
    }

    if (input === '/budget') {
      this.displayBudgetStatus(session.getBudgetStatus());
      return true;
    }

    const escalationCommand = parseEscalationCommand(input);
    if (escalationCommand) {
      this.handleEscalationCommand(escalationCommand, session);
      return true;
    }

    return false;
  }

  private displayDiagnosticLog(logs: readonly DiagnosticEvent[]): void {
    if (logs.length === 0) {
      process.stderr.write(chalk.dim('  (no diagnostic events yet)\n'));
      return;
    }

    // Tool names and previews are agent-written code and prose: one escaped line each.
    for (const event of logs) {
      switch (event.kind) {
        case 'tool_call':
          process.stderr.write(
            chalk.dim(`  [tool] ${toDisplayText(event.toolName)}: ${toDisplayText(event.preview)}\n`),
          );
          break;
        case 'agent_text':
          process.stderr.write(chalk.dim(`  [agent] ${toDisplayText(event.preview)}\n`));
          break;
        case 'budget_warning':
          process.stderr.write(chalk.yellow(`  [budget] ${event.message}\n`));
          break;
        case 'budget_exhausted':
          process.stderr.write(chalk.red(`  [budget] ${event.message}\n`));
          break;
        case 'message_compaction':
          process.stderr.write(
            chalk.dim(`  [compact] ${event.originalMessageCount} → ${event.newMessageCount} messages\n`),
          );
          break;
        case 'annotation_drift':
        case 'mcp_server_unavailable':
        case 'host_model_fallback':
        case 'policy_stale':
        case 'host_privileged_files':
          process.stderr.write(chalk.yellow(`${formatSessionNotice(event)}\n`));
          break;
        case 'message_compaction_failed':
          // The reason can carry provider error text: one escaped line.
          process.stderr.write(
            chalk.yellow(
              `  [compact] failed, history kept as is (next attempt in ${event.retryAfterTurns} turn(s)): ${toDisplayText(event.reason)}\n`,
            ),
          );
          break;
      }
    }
  }

  private handleEscalationCommand(parsed: ParsedEscalationCommand, session: Session): void {
    if ('usage' in parsed) {
      process.stderr.write(chalk.yellow(`  ${parsed.usage}\n`));
      return;
    }
    const target = this.escalationTarget(parsed, session.getPendingEscalations());
    if ('message' in target) {
      // Nothing was decided: every escalation stays pending.
      process.stderr.write(chalk.yellow(`  ${target.message}\n`));
      return;
    }
    const { request, number } = target;

    const outcome = escalationCommandOutcome(parsed.command, request);
    if (outcome.kind === 'refused') {
      // Nothing was decided: the escalation stays pending.
      process.stderr.write(chalk.yellow(`  ${outcome.message}\n`));
      return;
    }
    const { decision, options, whitelisted } = outcome;

    session
      .resolveEscalation(request.escalationId, decision, options)
      .then(() => {
        this.escalationNumbers.delete(request.escalationId);
        const color = decision === 'approved' ? chalk.green : chalk.red;
        process.stderr.write(color(`  Escalation #${number} ${decision}.\n`));
        if (whitelisted) {
          process.stderr.write(chalk.green(`  Whitelisted: ${toDisplayText(whitelisted.description)}\n`));
        }
        this.afterEscalationSettled();
      })
      .catch((err: unknown) => {
        if (isEscalationExpiredError(err)) {
          // The proxy had already timed it out: the call was denied, whatever was typed.
          this.escalationNumbers.delete(request.escalationId);
          process.stderr.write(
            chalk.yellow(`  Escalation #${number} had already expired (timed out); the tool call was denied.\n`),
          );
        } else {
          process.stderr.write(chalk.red(`  Error: ${errorText(err)}\n`));
        }
        this.afterEscalationSettled();
      });
  }

  /**
   * The pending escalation a command decides: the one with the number it
   * names, or the only one pending when it names none. Otherwise the
   * message saying why nothing is decided: never a guess between several.
   */
  private escalationTarget(
    parsed: { readonly number?: number },
    pending: readonly EscalationRequest[],
  ): { readonly request: EscalationRequest; readonly number: number } | { readonly message: string } {
    const numbered = pending.map((request) => ({ request, number: this.escalationNumber(request.escalationId) }));
    if (parsed.number !== undefined) {
      const match = numbered.find((entry) => entry.number === parsed.number);
      return match ?? { message: `No pending escalation #${parsed.number}.` };
    }
    if (numbered.length === 0) return { message: 'No escalation pending.' };
    if (numbered.length === 1) return numbered[0];
    const list = numbered
      .map(
        (entry) =>
          `#${entry.number} ${toDisplayText(entry.request.serverName)}/${toDisplayText(entry.request.toolName)}`,
      )
      .join(', ');
    return {
      message: `${numbered.length} escalations are pending (${list}). Add the number of the one you decide, e.g. /approve ${numbered[0].number}.`,
    };
  }

  // --- Budget display ---

  private displayBudgetStatus(status: BudgetStatus): void {
    const { limits, cumulative } = status;
    process.stderr.write(chalk.cyan('  Current turn budget:\n'));
    // A partial (lower-bound) total is marked, never shown as exact.
    const turnTokens = formatTrackedTokens(status.totalTokens, status);
    if (turnTokens === undefined) {
      process.stderr.write(`    Tokens: N/A\n`);
    } else if (turnTokens === NO_EXCHANGES_OBSERVED_YET) {
      process.stderr.write(`    Tokens: ${turnTokens}\n`);
    } else {
      process.stderr.write(
        formatBudgetLine('Tokens', status.totalTokens, limits.maxTotalTokens, (v) => v.toLocaleString(), turnTokens),
      );
    }
    process.stderr.write(formatBudgetLine('Steps', status.stepCount, limits.maxSteps, String));
    process.stderr.write(
      formatBudgetLine('Time', status.elapsedSeconds, limits.maxSessionSeconds, (v) => `${Math.round(v)}s`),
    );
    process.stderr.write(
      `    Est. cost: ${formatCostAgainstLimit(status.estimatedCostUsd, status.costSource, limits.maxEstimatedCostUsd)}\n`,
    );
    process.stderr.write(chalk.cyan('  Session totals:\n'));
    const sessionTokens = formatTrackedTokens(cumulative.totalTokens, status);
    process.stderr.write(`    Tokens: ${sessionTokens ?? 'N/A'}${partialTokensNote(status)}\n`);
    process.stderr.write(`    Steps: ${cumulative.stepCount}\n`);
    process.stderr.write(`    Active time: ${Math.round(cumulative.activeSeconds)}s\n`);
    process.stderr.write(`    Est. cost: ${formatCostUsd(cumulative.estimatedCostUsd, status.costSource)}\n`);
  }

  private displaySessionSummary(status: BudgetStatus): void {
    const { cumulative } = status;
    const tokens = formatTrackedTokens(cumulative.totalTokens, status);
    const tokensPart =
      tokens === undefined
        ? ''
        : tokens === NO_EXCHANGES_OBSERVED_YET
          ? `${tokens} · `
          : `${tokens} tokens${partialTokensNote(status)} · `;
    process.stderr.write(
      chalk.dim(
        `\nSession: ${tokensPart}` +
          `${cumulative.stepCount} steps` +
          ` · ${Math.round(cumulative.activeSeconds)}s` +
          ` · ${formatCostSummary(cumulative.estimatedCostUsd, status.costSource)}\n`,
      ),
    );
  }

  // --- Spinner helpers ---

  private startSpinner(text: string): void {
    this.spinner = ora({
      text,
      stream: process.stderr,
      discardStdin: false,
    }).start();
  }

  private stopSpinnerWithError(error: unknown): void {
    const message = errorText(error);
    if (this.spinner?.isSpinning) {
      this.spinner.fail(chalk.red(message));
    } else {
      process.stderr.write(chalk.red(`Error: ${message}\n`));
    }
  }

  // --- Escalation banner ---

  private writeEscalationBanner(request: EscalationRequest, number: number): void {
    process.stderr.write(formatEscalationBanner(request, number));
  }
}

/**
 * Longest rendering of the task and the human's last message in the banner,
 * in code points of the escaped text; the cut is marked. Both are the
 * human's own text, shown so the reviewer recalls what was asked for.
 */
const MAX_BANNER_CONTEXT_LENGTH = 300;

/** Error text for the terminal: messages can quote agent-derived strings. */
function errorText(error: unknown): string {
  return toDisplayText(error instanceof Error ? error.message : String(error));
}

/** The escalation commands, without their optional number. */
export type EscalationCommand = '/approve' | '/approve+' | '/approve+dir' | '/deny' | '/deny+';

/**
 * A typed escalation command: the command and the escalation number it
 * names, if any, or the usage text for a malformed one (nothing is decided).
 */
export type ParsedEscalationCommand =
  { readonly command: EscalationCommand; readonly number?: number } | { readonly usage: string };

const ESCALATION_COMMANDS: readonly EscalationCommand[] = ['/approve+dir', '/approve+', '/approve', '/deny+', '/deny'];

/**
 * Parses `/approve`, `/approve+`, `/approve+dir`, `/deny` and `/deny+`,
 * each optionally followed by an escalation number (`/approve 2`, `/deny #3`).
 * Undefined for any other input. A command word followed by anything but a
 * number is not sent to the agent as a message: it parses as `usage`.
 * Pure and exported for tests.
 */
export function parseEscalationCommand(input: string): ParsedEscalationCommand | undefined {
  const [word, ...rest] = input.trim().split(/\s+/u);
  const command = ESCALATION_COMMANDS.find((candidate) => candidate === word);
  if (command === undefined) return undefined;
  if (rest.length === 0) return { command };
  const match = rest.length === 1 ? /^#?([1-9][0-9]{0,8})$/u.exec(rest[0]) : null;
  if (!match) return { usage: `Usage: ${command} [N], where N is the escalation's number from its banner.` };
  return { command, number: Number(match[1]) };
}

/** What a typed escalation command does to the pending escalation. */
export type EscalationCommandOutcome =
  | {
      readonly kind: 'resolve';
      readonly decision: 'approved' | 'denied';
      /** The whitelist selection sent with the decision, if any. */
      readonly options?: { readonly whitelistSelection: number };
      /** The candidate that selection whitelists, for the confirmation line. */
      readonly whitelisted?: WhitelistCandidateIpc;
    }
  | {
      /** Nothing is decided; `message` says why. */
      readonly kind: 'refused';
      readonly message: string;
    };

/**
 * Maps `/approve`, `/approve+`, `/approve+dir`, `/deny` and `/deny+` onto a
 * decision for `pending`. `/approve+` whitelists the first candidate, which
 * binds paths exactly; `/approve+dir` whitelists the directory-wide one and
 * is refused, deciding nothing, when the escalation offers none. `/deny+`
 * is a plain deny. Pure and exported for tests.
 */
export function escalationCommandOutcome(command: string, pending: EscalationRequest): EscalationCommandOutcome {
  const candidates = pending.whitelistCandidates;
  switch (command) {
    case '/deny':
    case '/deny+':
      return { kind: 'resolve', decision: 'denied' };
    case '/approve':
      return { kind: 'resolve', decision: 'approved' };
    case '/approve+':
      return {
        kind: 'resolve',
        decision: 'approved',
        options: DEFAULT_WHITELIST_OPTIONS,
        whitelisted: candidates?.[0],
      };
    case '/approve+dir': {
      const index = directoryCandidateIndex(candidates);
      const candidate = index === undefined ? undefined : candidates?.[index];
      if (index === undefined || candidate === undefined) {
        return {
          kind: 'refused',
          message:
            'This escalation offers no directory-wide whitelist pattern. Type /approve+ to whitelist this path only, /approve or /deny.',
        };
      }
      return { kind: 'resolve', decision: 'approved', options: { whitelistSelection: index }, whitelisted: candidate };
    }
    default:
      return { kind: 'refused', message: 'Unknown escalation command.' };
  }
}

/**
 * The approval banner for an escalation. Every agent-derived field is
 * display-escaped: the tool name, the arguments (JSON, then escaped, because
 * JSON leaves C1 controls and bidi characters raw), the context values (JSON
 * quoted like the arguments), the reason, the whitelist descriptions (each
 * shown behind the command that whitelists it) and the agent's
 * justification. The reviewer context is labelled for what it is: the
 * session's task and the human's last message are the human's own text; the
 * agent's justification is set apart under an UNTRUSTED heading.
 * With `displayNumber`, the banner names the escalation (`ESCALATION #2`)
 * and its commands carry the number (`/approve 2`), which always decides
 * this escalation, also while others are pending.
 * Pure and exported so tests can assert that no control byte from the
 * request reaches the terminal.
 */
export function formatEscalationBanner(request: EscalationRequest, displayNumber?: number): string {
  const border = chalk.yellow.bold('========================================');
  const json = JSON.stringify(request.arguments, null, 2) as string | undefined;
  const userMessage = displayedUserMessage(request);
  const ref = displayNumber === undefined ? '' : ` ${displayNumber}`;
  const lines = [
    '',
    border,
    chalk.yellow.bold(
      displayNumber === undefined
        ? '  ESCALATION: Human approval required'
        : `  ESCALATION #${displayNumber}: Human approval required`,
    ),
    border,
    ...(request.taskSummary !== undefined
      ? [chalk.green(`  Task:      ${toDisplayText(request.taskSummary, { maxLength: MAX_BANNER_CONTEXT_LENGTH })}`)]
      : []),
    ...(userMessage !== undefined
      ? [
          chalk.green(
            `  You said:  ${toDisplayText(userMessage.text, { maxLength: MAX_BANNER_CONTEXT_LENGTH })}${userMessage.sentAt !== undefined ? ` (at ${new Date(userMessage.sentAt).toLocaleTimeString()})` : ''}`,
          ),
        ]
      : []),
    chalk.yellow(`  Tool:      ${toDisplayText(request.serverName)}/${toDisplayText(request.toolName)}`),
    chalk.yellow(`  Arguments: ${toDisplayText(json ?? typeof request.arguments, { multiline: true })}`),
    ...(request.context
      ? Object.entries(request.context).map(([k, v]) =>
          chalk.yellow(`  ${toDisplayText(k)}: ${toDisplayText(JSON.stringify(v))}`),
        )
      : []),
    chalk.yellow(`  Reason:    ${toDisplayText(request.reason)}`),
  ];

  // Each whitelist pattern behind the command that adds it: /approve+ the
  // exact one (always first), /approve+dir the directory-wide one.
  const candidates = request.whitelistCandidates ?? [];
  const directoryIndex = directoryCandidateIndex(candidates);
  if (candidates.length > 0) {
    const exactCommand = `/approve+${ref}`;
    const directoryCommand = `/approve+dir${ref}`;
    const commandWidth = directoryCommand.length + 2;
    lines.push(border);
    lines.push(chalk.cyan(directoryIndex === undefined ? '  Whitelist pattern:' : '  Whitelist patterns:'));
    lines.push(chalk.cyan(`    ${exactCommand.padEnd(commandWidth)}${toDisplayText(candidates[0].description)}`));
    if (directoryIndex !== undefined) {
      lines.push(
        chalk.cyan(
          `    ${directoryCommand.padEnd(commandWidth)}${toDisplayText(candidates[directoryIndex].description)}`,
        ),
      );
    }
  }

  // The agent's own explanation, set apart: it is attacker-controlled text.
  if (request.agentJustification !== undefined) {
    lines.push(border);
    lines.push(chalk.red('  Agent says (UNTRUSTED: written by the agent, it authorizes nothing):'));
    lines.push(chalk.dim(`    ${toDisplayText(request.agentJustification)}`));
  }

  lines.push(border);
  lines.push(
    chalk.yellow.bold(
      directoryIndex === undefined
        ? `  Type /approve${ref}, /approve+${ref} (approve & whitelist), or /deny${ref}`
        : `  Type /approve${ref}, /approve+${ref} or /approve+dir${ref} (approve & whitelist), or /deny${ref}`,
    ),
  );
  lines.push(border);
  lines.push('');

  return lines.join('\n') + '\n';
}

// --- Budget formatting ---

/** Whether `error` is a budget stop (BudgetExhaustedError), by its discriminant code. */
function isBudgetExhausted(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'BUDGET_EXHAUSTED';
}

function formatBudgetLine(
  label: string,
  current: number,
  limit: number | null,
  format: (v: number) => string,
  currentText: string = format(current),
): string {
  const currentStr = currentText;
  if (limit === null) return `    ${label}: ${currentStr} (no limit)\n`;
  const pct = limit > 0 ? Math.round((current / limit) * 100) : 0;
  return `    ${label}: ${currentStr} / ${format(limit)} (${pct}%)\n`;
}

// --- Markdown rendering ---

/**
 * Renders agent markdown for terminal display.
 * Returns the formatted string with ANSI codes for colors,
 * bold/italic, syntax-highlighted code blocks, etc.
 *
 * Escape sequences and control characters are removed from the agent's text
 * first (not from the rendered output, which legitimately contains SGR from
 * marked-terminal): an agent response could otherwise carry OSC 52 to write
 * the clipboard, cursor movement to repaint the screen, or a title change.
 * Bidi embedding, override and isolate characters are shown as visible
 * escapes, so a file name or command in the answer reads in its real order.
 * Exported for tests.
 */
export function renderAgentMarkdown(text: string): string {
  const safeText = escapeBidiControls(stripTerminalSequences(text));
  if (!safeText.trim()) return '';

  // marked.parse() can return string or Promise<string> depending on
  // extensions. With marked-terminal (synchronous), it returns a string.
  const rendered = marked.parse(safeText);
  if (typeof rendered !== 'string') {
    // Defensive: if somehow async, fall back to the stripped text
    return safeText;
  }
  return rendered;
}

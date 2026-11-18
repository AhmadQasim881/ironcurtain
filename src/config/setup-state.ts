/**
 * Whether the first-start wizard has run against this IronCurtain home.
 *
 * The wizard (`runFirstStart`, which `ironcurtain setup` runs on demand)
 * records its completion as `"setupCompleted": true` in config.json. Every
 * other way config.json comes into being writes `"setupCompleted": false`:
 * the default file a non-read-only load creates (`mux`, `daemon`, `config`,
 * workflows) and a save to a home that has none (see user-config.ts). So the
 * file's existence no longer stands for "setup ran": a user whose first
 * command is `ironcurtain doctor` (which writes nothing), `mux` or `daemon`
 * still gets the wizard from the first interactive `ironcurtain start`, and
 * mux and the daemon say that setup has not run.
 *
 * A config.json without the field was written before the marker existed.
 * Whether its wizard ran cannot be known; it counts as set up, as the
 * IronCurtain that wrote it assumed (that version ran the wizard only while
 * config.json did not exist), so an upgrade never brings the wizard back
 * unasked. `ironcurtain setup` runs it at any time.
 *
 * Read-only: nothing here writes.
 */

import { readFileSync } from 'node:fs';
import { getIronCurtainHome, getUserConfigPath } from './paths.js';
import { toDisplayText } from '../terminal/display-sanitize.js';

/**
 * - `pending`: no config.json yet, or one another command created
 *   (`setupCompleted: false`): the wizard has not completed here.
 * - `completed`: the wizard completed (`setupCompleted: true`).
 * - `unrecorded`: a config.json from before the marker, or one that cannot be
 *   read or parsed (the regular config load reports that); never prompted.
 */
export type FirstStartSetupState = 'pending' | 'completed' | 'unrecorded';

/** Reads the first-start marker from config.json without creating or changing anything. */
export function readFirstStartSetupState(): FirstStartSetupState {
  let text: string;
  try {
    text = readFileSync(getUserConfigPath(), 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'pending' : 'unrecorded';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'unrecorded';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unrecorded';
  const marker = (parsed as Record<string, unknown>)['setupCompleted'];
  if (marker === true) return 'completed';
  if (marker === false) return 'pending';
  return 'unrecorded';
}

/** What decides whether `ironcurtain start` runs the wizard first. */
export interface FirstStartWizardContext {
  /** stdin is a terminal, so a person can answer the prompts. */
  readonly interactive: boolean;
  /** The process is a `start --pty` child (see {@link shouldRunFirstStartWizard}). */
  readonly ptyChild: boolean;
}

/**
 * Whether `ironcurtain start` runs the first-start wizard before its session:
 * setup is pending in this home and a person is at the terminal. Never in a
 * `start --pty` process: mux and the web UI spawn those in pseudo-terminals
 * of their own, where the wizard would take over a session's tab (mux and the
 * daemon point out a pending setup themselves, see
 * {@link formatSetupPendingNotice}).
 */
export function shouldRunFirstStartWizard(context: FirstStartWizardContext): boolean {
  // `process.stdin.isTTY` is undefined, not false, when stdin is no terminal.
  if (!context.interactive || context.ptyChild) return false;
  return readFirstStartSetupState() === 'pending';
}

/**
 * The note mux and the daemon print while setup is pending: one paragraph,
 * naming the home it is about (a daemon may serve a different one than the
 * user's shell would).
 */
export function formatSetupPendingNotice(): string {
  return (
    `Note: the IronCurtain first-start setup has not been run for ${toDisplayText(getIronCurtainHome())}. ` +
    'Run `ironcurtain setup` in a terminal: it explains the security model, checks your credentials ' +
    '(API keys and Claude login) and offers web search, a GitHub token and auto-approve.'
  );
}

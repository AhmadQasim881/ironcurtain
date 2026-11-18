/**
 * StepLoopDetector -- Agent-level loop detection.
 *
 * Analyzes each execute_code step (code + result) using a 2x2 progress
 * matrix to detect stuck or stagnating agents. The unit of analysis is
 * the step, not individual MCP calls.
 *
 * Progress matrix:
 *   - Full progress:    new approach + new outcome → reset concern
 *   - World changed:    repeated approach + new outcome → reset concern
 *   - Stuck:            new approach + repeated outcome → increment stuck
 *   - Full stagnation:  repeated approach + repeated outcome → increment stagnation
 *
 * A stuck streak is judged by what the repeated outcomes say. Outcomes that
 * report a failure (see {@link outcomeCarriesError}) hit the `stuck`
 * thresholds: different code failing the same way is the loop this category
 * exists to stop. Benign outcomes hit the much higher `benignStuck`
 * thresholds, because ordinary step-by-step work looks the same: each write
 * in a series returns `null`, each step may return `'ok'`. Those are still
 * counted, so an agent that keeps failing silently is eventually stopped too.
 *
 * The detector's state covers one turn: the session calls {@link reset} at
 * the start of every turn, so a block lasts only for the rest of the turn
 * that caused it.
 */

import { computeHash } from '../hash.js';

export type ProgressCategory = 'full_progress' | 'world_changed' | 'stuck' | 'full_stagnation';

export type BlockVerdict = { action: 'block'; message: string; category: ProgressCategory };

export type StepVerdict =
  { action: 'allow' } | { action: 'warn'; message: string; category: ProgressCategory } | BlockVerdict;

export interface StepLoopDetectorConfig {
  /** Same code, same outcome. */
  stagnation: { warn: number; block: number };
  /** New code, already-seen outcome, counting only outcomes that report a failure. */
  stuck: { warn: number; block: number };
  /** New code, already-seen outcome, counting every outcome (benign ones included). */
  benignStuck: { warn: number; block: number };
}

const DEFAULT_CONFIG: StepLoopDetectorConfig = {
  stagnation: { warn: 3, block: 5 },
  stuck: { warn: 5, block: 8 },
  benignStuck: { warn: 15, block: 25 },
};

/** `String(error)` of a JavaScript error: `Error: ...`, `TypeError: ...`, `McpError: ...`. */
const ERROR_TEXT_PATTERN = /^\s*[a-z]*(?:error|exception)\s*:/i;

/** Prefix the Code Mode console bridge gives `console.error` lines and uncaught exceptions. */
const CONSOLE_ERROR_PREFIX = '[ERROR]';

/**
 * Whether an execute_code outcome reports a failure: a host-side `error`
 * field, an `[ERROR]` console line (an uncaught exception inside the
 * sandbox, which is how a denied or failed tool call surfaces, or
 * `console.error`), or a result that is itself an error report (an object
 * with a truthy `error` or `isError: true`, or text that starts like
 * `String(error)`).
 *
 * Only the thresholds depend on this, so a misjudged outcome is still
 * caught, just later or sooner.
 */
export function outcomeCarriesError(outcome: unknown): boolean {
  return carriesError(outcome, true);
}

function carriesError(value: unknown, descendIntoResult: boolean): boolean {
  if (typeof value === 'string') return ERROR_TEXT_PATTERN.test(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.isError === true) return true;
  const error = record.error;
  if (error !== undefined && error !== null && error !== false && error !== '') return true;
  const consoleLines = record.console;
  if (
    Array.isArray(consoleLines) &&
    consoleLines.some((line) => typeof line === 'string' && line.startsWith(CONSOLE_ERROR_PREFIX))
  ) {
    return true;
  }
  return descendIntoResult && carriesError(record.result, false);
}

export class StepLoopDetector {
  private readonly config: StepLoopDetectorConfig;
  private approachHashes = new Set<string>();
  private outcomeHashes = new Set<string>();
  private stagnationStreak = 0;
  /** Consecutive stuck steps, whatever their outcome. */
  private stuckStreak = 0;
  /** Stuck steps in the current stuck streak whose outcome reported a failure. */
  private stuckErrorCount = 0;
  private blocked = false;
  private blockVerdict: BlockVerdict | null = null;

  constructor(config?: Partial<StepLoopDetectorConfig>) {
    this.config = {
      stagnation: { ...DEFAULT_CONFIG.stagnation, ...config?.stagnation },
      stuck: { ...DEFAULT_CONFIG.stuck, ...config?.stuck },
      benignStuck: { ...DEFAULT_CONFIG.benignStuck, ...config?.benignStuck },
    };
  }

  /**
   * Check if execution is blocked before running code.
   * Returns the block verdict if blocked, null otherwise.
   */
  isBlocked(): BlockVerdict | null {
    return this.blocked ? this.blockVerdict : null;
  }

  /**
   * Analyze a completed step and return a verdict.
   *
   * @param code - The TypeScript code that was executed
   * @param result - The execution result (will be hashed)
   */
  analyzeStep(code: string, result: unknown): StepVerdict {
    const approachHash = computeHash(code);
    const outcomeHash = computeHash(result);

    const isNewApproach = !this.approachHashes.has(approachHash);
    const isNewOutcome = !this.outcomeHashes.has(outcomeHash);

    this.approachHashes.add(approachHash);
    this.outcomeHashes.add(outcomeHash);

    const category = this.classify(isNewApproach, isNewOutcome);
    this.updateStreaks(category, category === 'stuck' && outcomeCarriesError(result));

    return this.checkThresholds();
  }

  /**
   * Reset all state: the block, the streaks, and the approaches and outcomes
   * seen so far. Called at the start of every turn.
   */
  reset(): void {
    this.approachHashes.clear();
    this.outcomeHashes.clear();
    this.stagnationStreak = 0;
    this.stuckStreak = 0;
    this.stuckErrorCount = 0;
    this.blocked = false;
    this.blockVerdict = null;
  }

  private classify(isNewApproach: boolean, isNewOutcome: boolean): ProgressCategory {
    if (isNewApproach && isNewOutcome) return 'full_progress';
    if (!isNewApproach && isNewOutcome) return 'world_changed';
    if (isNewApproach && !isNewOutcome) return 'stuck';
    return 'full_stagnation';
  }

  private updateStreaks(category: ProgressCategory, stuckOnError: boolean): void {
    switch (category) {
      case 'full_progress':
      case 'world_changed':
        this.stagnationStreak = 0;
        this.resetStuck();
        break;
      case 'stuck':
        this.stuckStreak++;
        if (stuckOnError) this.stuckErrorCount++;
        this.stagnationStreak = 0;
        break;
      case 'full_stagnation':
        this.stagnationStreak++;
        this.resetStuck();
        break;
    }
  }

  private resetStuck(): void {
    this.stuckStreak = 0;
    this.stuckErrorCount = 0;
  }

  private checkThresholds(): StepVerdict {
    // Check block thresholds first
    if (this.stagnationStreak >= this.config.stagnation.block) {
      return this.block(
        'full_stagnation',
        'LOOP DETECTED: You have been repeating the same code with the same result. ' +
          'Execution is blocked for the rest of this turn. Summarize what you have accomplished and stop.',
      );
    }

    if (this.stuckErrorCount >= this.config.stuck.block) {
      return this.block(
        'stuck',
        'LOOP DETECTED: You keep trying different approaches but getting the same error. ' +
          'Execution is blocked for the rest of this turn. Summarize what you have accomplished and stop.',
      );
    }

    if (this.stuckStreak >= this.config.benignStuck.block) {
      return this.block(
        'stuck',
        'LOOP DETECTED: Many different steps in a row have returned results you had already seen. ' +
          'Execution is blocked for the rest of this turn. Summarize what you have accomplished and stop.',
      );
    }

    // Check warn thresholds
    if (this.stagnationStreak >= this.config.stagnation.warn) {
      return {
        action: 'warn',
        message:
          'WARNING: You are repeating the same code with the same result. ' +
          `Try a fundamentally different approach. (${this.stagnationStreak}/${this.config.stagnation.block} before block)`,
        category: 'full_stagnation',
      };
    }

    if (this.stuckErrorCount >= this.config.stuck.warn) {
      return {
        action: 'warn',
        message:
          'WARNING: Different approaches are producing the same error. ' +
          `Re-examine your assumptions. (${this.stuckErrorCount}/${this.config.stuck.block} before block)`,
        category: 'stuck',
      };
    }

    if (this.stuckStreak >= this.config.benignStuck.warn) {
      return {
        action: 'warn',
        message:
          'WARNING: Different code keeps returning results you have already seen, so these steps show no progress. ' +
          'If each step does change something (for example, writes that return nothing), return a short ' +
          'description of what it changed; otherwise re-examine your assumptions. ' +
          `(${this.stuckStreak}/${this.config.benignStuck.block} before block)`,
        category: 'stuck',
      };
    }

    return { action: 'allow' };
  }

  private block(category: ProgressCategory, message: string): BlockVerdict {
    const verdict: BlockVerdict = { action: 'block', message, category };
    this.blocked = true;
    this.blockVerdict = verdict;
    return verdict;
  }
}

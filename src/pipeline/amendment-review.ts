/**
 * Review step for constitution amendments proposed from repeated human
 * approvals (policy learning, `src/audit/amendment-proposals.ts`).
 *
 * The customize-policy flows run it before their LLM conversation: every
 * pending proposal for the constitution being edited is shown as a diff,
 * and the user accepts it, skips it for now, or dismisses it. Nothing is
 * applied without an explicit "accept", and an accepted amendment only
 * changes the in-memory constitution: the caller saves it through its normal
 * path and the user recompiles. A dismissal is recorded in the approval
 * history right away, so the same pattern is proposed again only after
 * another round of approvals. No LLM is involved: the statement comes from a
 * fixed template.
 */

import * as p from '@clack/prompts';
import chalk from 'chalk';
import { recordProposalDismissal, type ApprovalScope } from '../audit/approval-history.js';
import {
  constitutionContainsAmendment,
  loadAmendmentProposals,
  type AmendmentProposal,
} from '../audit/amendment-proposals.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { applyChanges, computeLineDiff, type DiffLine } from './constitution-diff.js';

/** What the user chose for one proposal. */
export type AmendmentChoice = 'accept' | 'skip' | 'dismiss';

/** The interaction surface of the review (a terminal prompt, or a test fake). */
export interface AmendmentReviewPrompter {
  /** Shows a block of already display-safe text under a title. */
  show(title: string, body: string): void;
  /** Asks for a choice; resolves undefined when the user cancels. */
  choose(message: string): Promise<AmendmentChoice | undefined>;
}

export interface AmendmentReviewResult {
  /** The constitution with every accepted amendment applied. */
  readonly constitution: string;
  readonly accepted: readonly AmendmentProposal[];
  readonly dismissed: readonly AmendmentProposal[];
  /** True when the user cancelled; `constitution` then holds what was accepted before. */
  readonly cancelled: boolean;
}

/** Lines of unchanged context shown around each change. */
const DIFF_CONTEXT_LINES = 2;

/** A diff limited to the changed lines and a little context around them. */
export function formatCompactDiff(diff: readonly DiffLine[], context = DIFF_CONTEXT_LINES): string {
  const changed = diff.map((line) => line.type !== 'unchanged');
  const keep = diff.map((_line, index) => {
    for (let j = Math.max(0, index - context); j <= Math.min(diff.length - 1, index + context); j += 1) {
      if (changed[j]) return true;
    }
    return false;
  });
  const out: string[] = [];
  let skipped = false;
  diff.forEach((line, index) => {
    if (!keep[index]) {
      skipped = true;
      return;
    }
    if (skipped) out.push(chalk.dim('  ...'));
    skipped = false;
    const text = toDisplayText(line.text);
    if (line.type === 'added') out.push(chalk.green(`+ ${text}`));
    else if (line.type === 'removed') out.push(chalk.red(`- ${text}`));
    else out.push(`  ${text}`);
  });
  return out.join('\n');
}

function formatDay(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/**
 * Walks the user through `proposals` for one constitution. Proposals the
 * constitution already holds are skipped silently. Each dismissal is passed
 * to `onDismiss` as it happens.
 */
export async function reviewAmendmentProposals(
  constitution: string,
  proposals: readonly AmendmentProposal[],
  prompter: AmendmentReviewPrompter,
  onDismiss: (proposal: AmendmentProposal) => void = () => {},
): Promise<AmendmentReviewResult> {
  let current = constitution;
  const accepted: AmendmentProposal[] = [];
  const dismissed: AmendmentProposal[] = [];
  const pending = proposals.filter((proposal) => !constitutionContainsAmendment(current, proposal.amendment));
  for (const [index, proposal] of pending.entries()) {
    const proposed = applyChanges(current, [proposal.amendment], []);
    const times = proposal.approvals === 1 ? 'once' : `${proposal.approvals} times`;
    const period =
      formatDay(proposal.firstSeen) === formatDay(proposal.lastSeen)
        ? `on ${formatDay(proposal.lastSeen)}`
        : `between ${formatDay(proposal.firstSeen)} and ${formatDay(proposal.lastSeen)}`;
    const body =
      `${formatCompactDiff(computeLineDiff(current, proposed))}\n\n` +
      chalk.dim(`You approved this ${times} ${period}: ${toDisplayText(proposal.description, { maxLength: 300 })}`) +
      '\n' +
      chalk.dim('Accepting adds the statement above; it takes effect once the policy is recompiled.');
    prompter.show(`Suggested amendment ${index + 1} of ${pending.length} (from your approvals)`, body);
    const choice = await prompter.choose('Add this statement to the constitution?');
    if (choice === undefined) return { constitution: current, accepted, dismissed, cancelled: true };
    if (choice === 'accept') {
      current = proposed;
      accepted.push(proposal);
    } else if (choice === 'dismiss') {
      dismissed.push(proposal);
      onDismiss(proposal);
    }
  }
  return { constitution: current, accepted, dismissed, cancelled: false };
}

/** The review prompter on the terminal, with @clack/prompts. */
export function createTerminalAmendmentPrompter(): AmendmentReviewPrompter {
  return {
    show(title, body) {
      p.note(body, title);
    },
    async choose(message) {
      const choice = await p.select<AmendmentChoice>({
        message,
        options: [
          { value: 'accept', label: 'Accept (add it to the constitution)' },
          { value: 'skip', label: 'Skip for now' },
          { value: 'dismiss', label: 'Dismiss (do not suggest it again until it is approved again)' },
        ],
      });
      return p.isCancel(choice) ? undefined : choice;
    },
  };
}

export interface ReviewPendingAmendmentsOptions {
  readonly prompter?: AmendmentReviewPrompter;
  /** Approval-history location (test seam). */
  readonly historyPath?: string;
}

/**
 * Loads the pending proposals for `scope` and reviews them. Returns undefined
 * when there is nothing to review. Dismissals are recorded in the approval
 * history; acceptances are left to the caller, which saves the constitution.
 */
export async function reviewPendingAmendments(
  scope: ApprovalScope,
  constitution: string,
  options: ReviewPendingAmendmentsOptions = {},
): Promise<AmendmentReviewResult | undefined> {
  const location = options.historyPath !== undefined ? { path: options.historyPath } : {};
  const { proposals } = loadAmendmentProposals({ scope, ...location });
  if (!proposals.some((proposal) => !constitutionContainsAmendment(constitution, proposal.amendment))) {
    return undefined;
  }
  return reviewAmendmentProposals(
    constitution,
    proposals,
    options.prompter ?? createTerminalAmendmentPrompter(),
    (proposal) => {
      recordProposalDismissal(scope, proposal.key, location);
    },
  );
}

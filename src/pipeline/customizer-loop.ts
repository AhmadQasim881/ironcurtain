/**
 * Shared interactive customizer loop for LLM-assisted constitution editing.
 *
 * Used by both persona-customizer.ts and job-customizer.ts. Handles the
 * common infrastructure: TTY check, annotation loading, GitHub identity
 * discovery, LLM setup, the review of amendments learned from repeated human
 * approvals (when the caller names the constitution's scope), and the
 * outer/inner accept-refine-reject loop.
 */

import * as p from '@clack/prompts';
import type { ModelMessage } from 'ai';
import chalk from 'chalk';
import { getPackageGeneratedDir } from '../config/index.js';
import { getUserGeneratedDir } from '../config/paths.js';
import { loadUserConfig } from '../config/user-config.js';
import { createCacheStrategy } from '../session/prompt-cache.js';
import {
  applyChanges,
  buildUserMessage,
  callLlm,
  computeLineDiff,
  formatDiff,
  loadAnnotations,
  type CustomizerResponse,
} from './constitution-customizer.js';
import { createPipelineLlm } from './pipeline-shared.js';
import { reviewPendingAmendments } from './amendment-review.js';
import type { ApprovalScope } from '../audit/approval-history.js';
import { resolveGitHubToken, discoverGitHubIdentity } from './github-identity.js';
import type { GitHubIdentity } from './github-identity.js';
import type { ToolAnnotation } from './types.js';
import { toDisplayText } from '../terminal/display-sanitize.js';

/** Options for the shared customizer loop. */
export interface CustomizerLoopOptions {
  /** LLM log step name (e.g. 'job-customize-policy'). */
  stepName: string;

  /** Title for the @clack/prompts note showing the current constitution. */
  noteTitle: string;

  /** Placeholder for the refine text input (optional). */
  refinePlaceholder?: string;

  /**
   * Scope of the constitution being edited (`persona:<name>`, `job:<id>`).
   * When set, the amendments proposed from repeated human approvals under it
   * are offered as diffs before the conversation; each is applied only when
   * the user accepts it.
   */
  amendmentScope?: ApprovalScope;
}

/** Context provided to the system prompt builder callback. */
export interface CustomizerLoopContext {
  annotations: ToolAnnotation[];
  githubIdentity: GitHubIdentity | null;
}

/**
 * Runs the shared interactive customizer loop.
 *
 * The caller provides a `buildSystemPromptFn` callback that receives
 * loaded annotations and GitHub identity, and returns the raw system
 * prompt string. This keeps domain-specific prompt construction in
 * the calling module.
 *
 * @returns The final constitution text, or undefined if the user cancelled.
 */
export async function runConstitutionCustomizerLoop(
  initialConstitution: string,
  buildSystemPromptFn: (ctx: CustomizerLoopContext) => string,
  options: CustomizerLoopOptions,
): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    p.log.error('Interactive customizer requires a terminal (TTY).');
    return undefined;
  }

  // Load tool annotations (user overlay layered over the package's)
  const generatedDir = getUserGeneratedDir();
  const packageGeneratedDir = getPackageGeneratedDir();
  let annotations: ToolAnnotation[];
  try {
    annotations = loadAnnotations(generatedDir, packageGeneratedDir);
  } catch (err) {
    // loadAnnotations reports both a missing file and a damaged overlay.
    p.log.error(toDisplayText(err instanceof Error ? err.message : String(err), { multiline: true }));
    return undefined;
  }

  // Discover GitHub identity (best-effort)
  const userConfig = loadUserConfig();
  const ghToken = resolveGitHubToken(userConfig.serverCredentials);
  let ghIdentity: GitHubIdentity | null = null;
  if (ghToken) {
    const spinner = p.spinner();
    spinner.start('Discovering GitHub identity...');
    ghIdentity = await discoverGitHubIdentity(ghToken);
    if (ghIdentity) {
      const owners = [ghIdentity.login, ...ghIdentity.orgs].join(', ');
      spinner.stop(`GitHub identity: ${toDisplayText(owners)}`);
    } else {
      spinner.stop('GitHub identity discovery failed (continuing without it)');
    }
  }

  // Build system prompt via caller's callback
  const cacheStrategy = createCacheStrategy(userConfig.policyModelId);
  const rawSystemPrompt = buildSystemPromptFn({ annotations, githubIdentity: ghIdentity });
  const systemPrompt = cacheStrategy.wrapSystemPrompt(rawSystemPrompt);

  // Set up LLM
  const { model, logContext } = await createPipelineLlm(generatedDir, options.stepName);
  logContext.stepName = options.stepName;

  let currentConstitution = initialConstitution;
  const conversationHistory: ModelMessage[] = [];

  p.note(toDisplayText(currentConstitution, { multiline: true }), options.noteTitle);

  if (options.amendmentScope !== undefined) {
    const review = await reviewPendingAmendments(options.amendmentScope, currentConstitution);
    if (review?.cancelled === true) {
      p.cancel('Customization cancelled.');
      return undefined;
    }
    if (review !== undefined && review.accepted.length > 0) {
      currentConstitution = review.constitution;
      p.log.success(`${review.accepted.length} suggested amendment(s) accepted.`);
    }
  }

  // Main loop
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via break
  while (true) {
    const userInput = await p.text({
      message: 'How would you like to refine this constitution?',
      placeholder: 'describe what to change, or "done" to finish',
    });

    if (p.isCancel(userInput)) {
      p.cancel('Customization cancelled.');
      return undefined;
    }

    const request = userInput.trim();
    if (request.toLowerCase() === 'done') break;
    if (!request) continue;

    // Build user message and add to conversation
    const userMsg = buildUserMessage(currentConstitution, request);
    conversationHistory.push({ role: 'user', content: userMsg });

    const cachedMessages = cacheStrategy.applyHistoryBreakpoint(conversationHistory);

    // Call LLM
    let response: CustomizerResponse;
    const llmSpinner = p.spinner();
    llmSpinner.start('Thinking...');
    try {
      response = await callLlm(model, systemPrompt, cachedMessages);
      llmSpinner.stop('Done.');
    } catch (err) {
      llmSpinner.stop('Failed.');
      p.log.error(`LLM error: ${toDisplayText(err instanceof Error ? err.message : String(err), { multiline: true })}`);
      conversationHistory.pop();
      continue;
    }

    conversationHistory.push({ role: 'assistant', content: JSON.stringify(response) });

    if (response.type === 'question') {
      p.log.info(toDisplayText(response.question ?? 'Could you clarify your request?', { multiline: true }));
      continue;
    }

    // Handle changes -- show diff, ask for feedback
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via break
    while (true) {
      const proposed = applyChanges(currentConstitution, response.addRules ?? [], response.removeRules ?? []);
      const diff = computeLineDiff(currentConstitution, proposed);
      const diffText = formatDiff(diff);
      p.note(
        `${diffText}\n\n${chalk.dim(toDisplayText(response.summary ?? '', { multiline: true }))}`,
        'Proposed changes',
      );

      const action = await p.select({
        message: 'What would you like to do?',
        options: [
          { value: 'accept', label: 'Accept changes' },
          { value: 'refine', label: 'Refine (provide feedback)' },
          { value: 'reject', label: 'Reject changes' },
        ],
      });
      if (p.isCancel(action)) {
        p.cancel('Customization cancelled.');
        return undefined;
      }

      if (action === 'accept') {
        currentConstitution = proposed;
        p.log.success('Changes accepted.');
        break;
      }

      if (action === 'reject') {
        p.log.info('Changes rejected.');
        break;
      }

      // Refine: get follow-up
      const refinement = await p.text({
        message: 'How would you like to refine this?',
        placeholder: options.refinePlaceholder ?? 'e.g., "also allow fetching from news sites"',
      });
      if (p.isCancel(refinement)) return undefined;

      const refineMsg = buildUserMessage(currentConstitution, refinement.trim());
      conversationHistory.push({ role: 'user', content: refineMsg });

      const refinedMessages = cacheStrategy.applyHistoryBreakpoint(conversationHistory);

      const refineSpinner = p.spinner();
      refineSpinner.start('Thinking...');
      try {
        response = await callLlm(model, systemPrompt, refinedMessages);
        refineSpinner.stop('Done.');
      } catch (err) {
        refineSpinner.stop('Failed.');
        p.log.error(
          `LLM error: ${toDisplayText(err instanceof Error ? err.message : String(err), { multiline: true })}`,
        );
        conversationHistory.pop();
        break;
      }

      conversationHistory.push({ role: 'assistant', content: JSON.stringify(response) });

      if (response.type === 'question') {
        p.log.info(toDisplayText(response.question ?? 'Could you clarify your request?', { multiline: true }));
        break;
      }
    }
  }

  return currentConstitution;
}

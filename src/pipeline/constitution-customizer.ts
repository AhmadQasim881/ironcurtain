/**
 * LLM-assisted conversational constitution customizer.
 *
 * Helps users describe tasks and purposes in natural language, then
 * translates them into concrete policy statements via an LLM. Uses
 * a conversational loop with accept/refine/reject feedback.
 *
 * Before the conversation it offers the amendments proposed from the
 * user's repeated human approvals under the global policy (policy
 * learning, `amendment-review.ts`): each one is shown as a diff and added
 * only on an explicit accept, then saved and compiled like any other change.
 *
 * CLI entry point: `ironcurtain customize-policy`
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import type { LanguageModel, ModelMessage, SystemModelMessage } from 'ai';
import { generateText, Output } from 'ai';
import chalk from 'chalk';
import { z } from 'zod';
import { checkHelp, parseArgsStrict, type CommandSpec } from '../cli-help.js';
import { getBaseUserConstitutionPath, getUserConstitutionPath, getUserGeneratedDir } from '../config/paths.js';
import { loadUserConfig } from '../config/user-config.js';
import { createCacheStrategy } from '../session/prompt-cache.js';
import type { GitHubIdentity } from './github-identity.js';
import { discoverGitHubIdentity, resolveGitHubToken } from './github-identity.js';
import { createPipelineLlm, loadToolAnnotationsFile } from './pipeline-shared.js';
import type { ToolAnnotation } from './types.js';
import { reviewPendingAmendments } from './amendment-review.js';
import { GLOBAL_APPROVAL_SCOPE } from '../audit/approval-history.js';
import { applyChanges, computeLineDiff, formatDiff } from './constitution-diff.js';
import { toDisplayText } from '../terminal/display-sanitize.js';

// The constitution diff helpers live in a leaf module so the amendment review
// can use them without importing this one; re-exported for existing callers.
export { applyChanges, computeLineDiff, formatDiff, type DiffLine } from './constitution-diff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Structured Output Schema
// ---------------------------------------------------------------------------

export const CustomizerResponseSchema = z.object({
  type: z.enum(['changes', 'question']).describe('Whether this proposes changes or asks a clarifying question'),
  addRules: z.array(z.string()).optional().describe('New policy statements to append (when type is "changes")'),
  removeRules: z
    .array(z.string())
    .optional()
    .describe('Existing policy statements to remove — must match existing lines exactly (when type is "changes")'),
  summary: z
    .string()
    .optional()
    .describe(
      'Brief summary of what changed and why, including any permissions already covered (when type is "changes")',
    ),
  question: z.string().optional().describe('A clarifying question to ask the user (when type is "question")'),
});

export type CustomizerResponse = z.infer<typeof CustomizerResponseSchema>;

// ---------------------------------------------------------------------------
// Tool Annotation Formatting
// ---------------------------------------------------------------------------

/** Max bytes for the formatted annotation section before we truncate. */
const ANNOTATION_SIZE_LIMIT = 8192;

/**
 * Formats tool annotations into a compact prompt-friendly summary.
 * Each tool gets its name, a one-line description, and the argument
 * roles that matter for policy (non-none roles).
 */
export function formatAnnotationsForPrompt(annotations: ToolAnnotation[]): string {
  const lines: string[] = [];

  for (const ann of annotations) {
    const argEntries = Object.entries(ann.args).filter(
      ([, roles]) => roles.length > 0 && !roles.every((r) => r === 'none'),
    );

    let line = `- **${ann.serverName}/${ann.toolName}**: ${ann.comment}`;
    if (argEntries.length > 0) {
      const argParts = argEntries.map(([name, roles]) => `${name} (${roles.join(', ')})`);
      line += `\n  Args: ${argParts.join('; ')}`;
    }
    lines.push(line);
  }

  const result = lines.join('\n');

  // If the output is too large, summarize by omitting argument details
  if (Buffer.byteLength(result, 'utf-8') > ANNOTATION_SIZE_LIMIT) {
    return annotations.map((ann) => `- **${ann.serverName}/${ann.toolName}**: ${ann.comment}`).join('\n');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prompt Construction
// ---------------------------------------------------------------------------

export function buildSystemPrompt(
  baseConstitution: string,
  toolAnnotations: ToolAnnotation[],
  githubIdentity?: GitHubIdentity | null,
): string {
  let prompt = `You are helping a user customize their IronCurtain security policy.

The user will describe tasks and purposes they want their agent to perform.
Your job is to infer the specific permissions needed and generate precise,
enforceable policy statements.

## Base Constitution (read-only, cannot be modified)
${baseConstitution}

## Available Tools and Their Capabilities
${formatAnnotationsForPrompt(toolAnnotations)}

## How to Translate User Intent to Policy

When the user describes a purpose (e.g., "fix bugs in my code", "write a news
dossier"), reason about:
- Which tools does this task require? (file read/write, git, web fetch, etc.)
- Which paths or directories are involved?
- Which domains need to be accessible?
- What is read-only vs. read-write?
- What should require human approval vs. be automatic?
- What is explicitly NOT needed and should remain restricted?

Apply the principle of least privilege: only grant what the stated purpose
requires. If a task needs web fetching, allow only relevant domains, not all
web access. If it needs file writes, scope to the relevant directory.

## Using Category References (Dynamic Lists)

When the user's purpose involves a CATEGORY of things (e.g., "finance sites",
"news sites", "my contacts", "tech companies"), use a descriptive category
name instead of enumerating specific values. The downstream policy compiler
resolves these categories into concrete lists automatically.

Examples of good category usage:
- "The agent may fetch web content from finance news sites" (NOT a list of bloomberg.com, reuters.com, etc.)
- "The agent may fetch web content from major news sites" (NOT a list of cnn.com, bbc.com, etc.)
- "The agent may send emails to my contacts" (NOT specific email addresses)
- "The agent may read stock data for major tech companies" (NOT AAPL, GOOG, etc.)

Only enumerate specific values when the user explicitly names them (e.g.,
"allow access to github.com and gitlab.com").

## Response Format

Respond with either "changes" or a "question":

- Use "changes" when you have enough information to generate policy.
  Return ONLY the delta:
  - "addRules": new policy statements to append (just the text, no bullet prefix)
  - "removeRules": existing statements to remove (must match existing lines exactly)
  - "summary": what changed and why. If some aspect of the user's request is
    ALREADY covered by existing rules, note it here (e.g., "Writing to Downloads
    is already permitted — no new rule needed for that").
  Do NOT repeat existing rules in addRules. Only include genuinely new permissions.

- Use "question" when the user's request is ambiguous and you need
  clarification before generating. For example: "Where is your source
  code located?" or "Should the agent be able to push to git, or just
  commit locally?"

## Rules for Policy Statements
1. Each statement should be a clear, specific policy statement.
2. Use concrete terms the policy compiler can translate to rules:
   - "allow" / "deny" / "require approval" (maps to escalate)
   - Reference specific tools (git push, git commit) or categories
   - Reference domains when relevant (github.com, *.gov)
   - Reference paths when relevant (~/Documents, ~/src/myapp)
   - Reference categories for groups of domains/contacts/identifiers
     (e.g., "finance news sites", "my contacts") — DO NOT enumerate
3. Avoid vague statements. "Be careful with git" is not enforceable.
4. If the user's request conflicts with the base constitution, explain the
   conflict in the summary and suggest an alternative within base constraints.
`;

  if (githubIdentity) {
    const orgsLine =
      githubIdentity.orgs.length > 0
        ? `\nThey belong to these organizations: ${githubIdentity.orgs.map((o) => `**${o}**`).join(', ')}.`
        : '';

    prompt += `
## GitHub Identity Context
The user is authenticated as **${githubIdentity.login}** on GitHub.${orgsLine}

When the user's request involves GitHub operations, use this context to:
- Suggest policy rules scoped to their username and/or organizations
- Ask which of their organizations (if any) the agent should have access to
- Generate precise owner names in policy statements (e.g., "The agent may \
interact with GitHub repositories owned by ${githubIdentity.login}")
- Do NOT automatically grant access to all organizations -- ask the user \
which ones are relevant to their task`;
  }

  return prompt;
}

export function buildUserMessage(currentUserConstitution: string | undefined, userRequest: string): string {
  const current = currentUserConstitution
    ? `## Current User Customizations\n${currentUserConstitution}`
    : '## No existing user customizations.';
  return `${current}\n\n## User Request\n"${userRequest}"`;
}

// ---------------------------------------------------------------------------
// Backup / Revert
// ---------------------------------------------------------------------------

/**
 * Writes the user constitution to disk, backing up the previous version.
 * Returns the path written to.
 */
export function writeConstitution(content: string): string {
  const userPath = getUserConstitutionPath();
  if (existsSync(userPath)) {
    copyFileSync(userPath, `${userPath}.bak`);
  }
  writeFileSync(userPath, content, 'utf-8');
  return userPath;
}

/**
 * Reverts the user constitution from the `.bak` file.
 * Throws if no backup exists.
 */
export function revertConstitution(): void {
  const userPath = getUserConstitutionPath();
  const bakPath = `${userPath}.bak`;
  if (!existsSync(bakPath)) {
    throw new Error('No backup file found to revert from.');
  }
  renameSync(bakPath, userPath);
}

// ---------------------------------------------------------------------------
// Base Constitution Seeding
// ---------------------------------------------------------------------------

/**
 * Ensures a user constitution file exists. If not, copies the
 * package-bundled base as a starting point.
 * Returns the current content of the user constitution (or undefined).
 */
export function seedBaseConstitution(): string | undefined {
  const userPath = getUserConstitutionPath();
  if (existsSync(userPath)) {
    return readFileSync(userPath, 'utf-8');
  }

  const basePath = getBaseUserConstitutionPath();
  if (existsSync(basePath)) {
    copyFileSync(basePath, userPath);
    return readFileSync(userPath, 'utf-8');
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Cancel Handling (follows config-command.ts pattern)
// ---------------------------------------------------------------------------

function handleCancel(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel('Customization cancelled.');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// LLM Call
// ---------------------------------------------------------------------------

export async function callLlm(
  model: LanguageModel,
  systemPrompt: string | SystemModelMessage,
  messages: ModelMessage[],
): Promise<CustomizerResponse> {
  const result = await generateText({
    model,
    output: Output.object({ schema: CustomizerResponseSchema }),
    system: systemPrompt,
    messages,
    maxOutputTokens: 4096,
  });

  return result.output;
}

// ---------------------------------------------------------------------------
// Load Tool Annotations
// ---------------------------------------------------------------------------

/**
 * Loads the effective tool annotations (the user overlay in `generatedDir`
 * layered per server over the package annotations) with conditional role
 * specs resolved to their default roles.
 */
export function loadAnnotations(generatedDir: string, packageGeneratedDir: string): ToolAnnotation[] {
  const file = loadToolAnnotationsFile(generatedDir, packageGeneratedDir);
  if (!file) {
    throw new Error(
      "tool-annotations.json not found. Run 'ironcurtain annotate-tools' first to generate tool annotations.",
    );
  }
  return Object.values(file.servers).flatMap((server) => server.tools);
}

// ---------------------------------------------------------------------------
// Compile After Save
// ---------------------------------------------------------------------------

/** What the compile run after saving a customized constitution produced. */
export type PostSaveCompileOutcome =
  /** Every server compiled and the policy was written. */
  | { readonly kind: 'compiled' }
  /** The policy was written, but some servers failed and have no rules. */
  | { readonly kind: 'partial'; readonly exitCode: number }
  /** No policy was written. `exitCode` is set when compile-policy returned one. */
  | { readonly kind: 'failed'; readonly message: string; readonly exitCode?: number };

/**
 * Runs compile-policy in-process through `runCompilePolicy`, which returns the
 * exit status instead of exiting, so the customizer can finish its flow and
 * tell a partial failure apart from a success. `runCompile` is a test seam.
 */
export async function compileAfterSave(
  argv: string[],
  runCompile?: (argv: string[]) => Promise<number>,
): Promise<PostSaveCompileOutcome> {
  try {
    const { runCompilePolicy, COMPILE_PARTIAL_FAILURE_EXIT_CODE } = await import('./compile.js');
    const exitCode = await (runCompile ?? runCompilePolicy)(argv);
    if (exitCode === 0) return { kind: 'compiled' };
    if (exitCode === COMPILE_PARTIAL_FAILURE_EXIT_CODE) return { kind: 'partial', exitCode };
    return { kind: 'failed', message: `compile-policy exited with status ${exitCode}`, exitCode };
  } catch (err) {
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Main Conversational Loop
// ---------------------------------------------------------------------------

export const customizePolicySpec: CommandSpec = {
  name: 'ironcurtain customize-policy',
  description: 'Customize your policy in an LLM-assisted conversation (interactive)',
  usage: ['ironcurtain customize-policy'],
  options: [{ flag: 'help', short: 'h', description: 'Show this help message' }],
  examples: [
    'ironcurtain customize-policy   # Amend ~/.ironcurtain/constitution-user.md by conversation, then compile',
  ],
};

/**
 * `ironcurtain customize-policy`. `--help` is answered before anything else:
 * the conversation needs a terminal, loads (and may create) the user config
 * and seeds the user constitution.
 */
export async function main(args: readonly string[] = []): Promise<void> {
  const { values } = parseArgsStrict(
    { args: [...args], options: { help: { type: 'boolean', short: 'h' } } },
    customizePolicySpec.name,
  );
  if (checkHelp(values, customizePolicySpec)) return;

  if (!process.stdin.isTTY) {
    console.error('Error: ironcurtain customize-policy requires an interactive terminal (TTY).');
    process.exit(1);
  }

  p.intro('IronCurtain Policy Customizer');

  // Load user config for model selection
  const userConfig = loadUserConfig();
  const cacheStrategy = createCacheStrategy(userConfig.policyModelId);

  // Resolve directories for artifact loading
  const configDir = resolve(__dirname, '..', 'config');
  const packageGeneratedDir = resolve(configDir, 'generated');
  const generatedDir = getUserGeneratedDir();

  // Load tool annotations
  let annotations: ToolAnnotation[];
  try {
    annotations = loadAnnotations(generatedDir, packageGeneratedDir);
  } catch (err) {
    p.log.error(toDisplayText(err instanceof Error ? err.message : String(err), { multiline: true }));
    process.exit(1);
  }
  const serverCount = new Set(annotations.map((a) => a.serverName)).size;
  p.log.info(
    `Loaded tool annotations (${serverCount} server${serverCount !== 1 ? 's' : ''}, ${annotations.length} tools)`,
  );

  // Discover GitHub identity (best-effort enrichment)
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

  // Load base constitution (guiding principles -- read-only context for LLM)
  const constitutionPath = resolve(configDir, 'constitution.md');
  const baseConstitution = existsSync(constitutionPath) ? readFileSync(constitutionPath, 'utf-8') : '';

  // Seed user constitution if it doesn't exist
  let currentConstitution = seedBaseConstitution();

  // Display current state
  if (currentConstitution) {
    p.note(toDisplayText(currentConstitution, { multiline: true }), 'Current User Constitution');
  } else {
    p.log.info('No user constitution yet. Starting from scratch.');
  }

  // Track whether we have unsaved changes
  let hasUnsavedChanges = false;

  // Amendments learned from repeated human approvals: shown as diffs, added
  // only when accepted. A dismissal is recorded right away.
  const amendmentReview = await reviewPendingAmendments(GLOBAL_APPROVAL_SCOPE, currentConstitution ?? '');
  if (amendmentReview?.cancelled === true) {
    p.cancel('Customization cancelled.');
    process.exit(0);
  }
  if (amendmentReview !== undefined && amendmentReview.accepted.length > 0) {
    currentConstitution = amendmentReview.constitution;
    hasUnsavedChanges = true;
    p.log.success(
      `${amendmentReview.accepted.length} suggested amendment(s) accepted. They are saved when you finish ("done").`,
    );
  }

  // Set up LLM
  const { model, logContext } = await createPipelineLlm(generatedDir, 'customize-policy');
  logContext.stepName = 'customize-policy';

  // Build system prompt (stable across turns -- ideal for caching)
  const rawSystemPrompt = buildSystemPrompt(baseConstitution, annotations, ghIdentity);
  const systemPrompt = cacheStrategy.wrapSystemPrompt(rawSystemPrompt);

  // Conversation history for multi-turn context
  const conversationHistory: ModelMessage[] = [];

  // Main loop
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via break
  while (true) {
    const prompt = hasUnsavedChanges ? 'Anything else? (type "done" to finish)' : 'What do you want the agent to do?';

    const userInput = await p.text({
      message: prompt,
      placeholder: hasUnsavedChanges
        ? 'describe another task, or "done"'
        : 'e.g., "fix bugs in my code at ~/src/myapp"',
    });
    handleCancel(userInput);

    const request = (userInput as string).trim();
    if (request.toLowerCase() === 'done') break;
    if (!request) continue;

    // Build user message and add to conversation
    const userMsg = buildUserMessage(currentConstitution, request);
    conversationHistory.push({ role: 'user', content: userMsg });

    // Apply cache breakpoint to history
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
      // Remove the user message we just added since the call failed
      conversationHistory.pop();
      continue;
    }

    // Add assistant response to history
    conversationHistory.push({ role: 'assistant', content: JSON.stringify(response) });

    // Handle question response
    if (response.type === 'question') {
      p.log.info(toDisplayText(response.question ?? 'Could you clarify your request?', { multiline: true }));
      continue;
    }

    // Handle changes response -- merge, show diff, ask for feedback
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via break
    while (true) {
      const proposed = applyChanges(currentConstitution ?? '', response.addRules ?? [], response.removeRules ?? []);
      const diff = computeLineDiff(currentConstitution ?? '', proposed);
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
      handleCancel(action);

      if (action === 'accept') {
        currentConstitution = proposed;
        hasUnsavedChanges = true;
        p.log.success('Changes accepted.');
        break;
      }

      if (action === 'reject') {
        p.log.info('Changes rejected.');
        break;
      }

      // Refine: get follow-up and re-call LLM
      const refinement = await p.text({
        message: 'How would you like to refine this?',
        placeholder: 'e.g., "put the output in ~/Desktop instead"',
      });
      handleCancel(refinement);

      const refineMsg = buildUserMessage(currentConstitution, (refinement as string).trim());
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

      // Loop back to show new diff
    }
  }

  // Write changes if any
  if (!hasUnsavedChanges || !currentConstitution) {
    p.outro('No changes to save.');
    return;
  }

  const writtenPath = writeConstitution(currentConstitution);
  p.log.success(`Saved to ${toDisplayText(writtenPath)}`);

  // Ask about compilation
  const shouldCompile = await p.confirm({
    message: 'Compile policy now?',
    initialValue: true,
  });
  handleCancel(shouldCompile);

  if (!shouldCompile) {
    p.log.info('Remember to run `ironcurtain compile-policy` before your next session.');
    p.outro('Done.');
    return;
  }

  // Invoke compile-policy programmatically, with its default options (this
  // command takes none to pass on).
  const outcome = await compileAfterSave([]);
  if (outcome.kind === 'compiled') {
    p.outro('Policy compiled successfully.');
    return;
  }
  if (outcome.kind === 'partial') {
    // The policy was written without the failed servers (listed above), so
    // reverting the constitution would not undo it. Report it and keep the
    // partial-failure exit status.
    process.exitCode = outcome.exitCode;
    p.log.warn(
      'Policy compiled, but some servers failed and have no rules, so their tools are denied. ' +
        'Re-run `ironcurtain compile-policy` to retry them.',
    );
    p.outro('Done.');
    return;
  }

  if (outcome.exitCode !== undefined) process.exitCode = outcome.exitCode;
  p.log.error(`Compilation failed: ${toDisplayText(outcome.message, { multiline: true })}`);

  const shouldRevert = await p.confirm({
    message: 'Revert to previous constitution?',
    initialValue: true,
  });
  handleCancel(shouldRevert);

  if (shouldRevert) {
    try {
      revertConstitution();
      p.log.success('Reverted to previous constitution.');
    } catch (revertErr) {
      p.log.error(
        `Revert failed: ${toDisplayText(revertErr instanceof Error ? revertErr.message : String(revertErr), { multiline: true })}`,
      );
    }
  }
  p.outro('Done.');
}

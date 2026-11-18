import { DOCKER_AGENTS, validateWorkflowModelId } from './user-config.js';

/**
 * Guard against the common `--model <agent-name>` slip.
 *
 * `--agent` selects the agent (claude-code / goose / codex); `--model` only
 * overrides the LLM model ID. Passing an agent name to `--model` silently runs
 * the wrong (default) agent with a bogus model override, so the CLI entry
 * points (`start`, `mux`) reject it up front rather than launching the wrong
 * thing.
 *
 * Pure and side-effect free: returns a user-facing error message when `model`
 * is actually an agent name, otherwise `null`. Callers print it and exit in
 * their own style.
 */
export function modelFlagMisusedAsAgent(model: string | undefined): string | null {
  if (model === undefined) return null;
  if (!(DOCKER_AGENTS as readonly string[]).includes(model)) return null;
  return (
    `"${model}" is an agent, not a model. Did you mean --agent ${model}?\n` +
    `--agent selects the agent (${DOCKER_AGENTS.join(', ')}); ` +
    `--model only overrides the LLM model ID (e.g. --model claude-opus-4-8).`
  );
}

/**
 * Everything wrong with a `--model` value (`ironcurtain start`, `mux`), or
 * null: an agent name passed by mistake ({@link modelFlagMisusedAsAgent}), or
 * an ID the model-ID validators refuse, such as a misspelled provider prefix
 * ("opnai:gpt-5", which would otherwise go to the default provider as an
 * opaque model name) or a malformed "name:" / ":tag" shape. The rules are
 * those of workflow definitions, so an Ollama-style "name:tag" ID for an
 * upstream gateway is accepted.
 */
export function modelFlagProblem(model: string | undefined): string | null {
  const misuse = modelFlagMisusedAsAgent(model);
  if (misuse !== null || model === undefined) return misuse;
  const problem = validateWorkflowModelId(model);
  return problem === undefined ? null : `Invalid --model ${JSON.stringify(model)}: ${problem}`;
}

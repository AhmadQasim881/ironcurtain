import { describe, it, expect } from 'vitest';
import { modelFlagMisusedAsAgent, modelFlagProblem } from '../src/config/agent-model-guard.js';
import { DOCKER_AGENTS } from '../src/config/user-config.js';

describe('modelFlagMisusedAsAgent', () => {
  it('flags every known agent name passed as a model', () => {
    for (const agent of DOCKER_AGENTS) {
      const msg = modelFlagMisusedAsAgent(agent);
      expect(msg).not.toBeNull();
      expect(msg).toContain(`"${agent}" is an agent, not a model`);
      expect(msg).toContain(`--agent ${agent}`);
    }
  });

  it('returns null for undefined (no --model passed)', () => {
    expect(modelFlagMisusedAsAgent(undefined)).toBeNull();
  });

  it('returns null for a real model ID', () => {
    expect(modelFlagMisusedAsAgent('claude-opus-4-8')).toBeNull();
    expect(modelFlagMisusedAsAgent('openai:gpt-5.5')).toBeNull();
    expect(modelFlagMisusedAsAgent('sonnet')).toBeNull();
  });

  it('is exact-match only — does not flag substrings or prefixes', () => {
    expect(modelFlagMisusedAsAgent('codex-mini')).toBeNull();
    expect(modelFlagMisusedAsAgent('claude-code-fast')).toBeNull();
    expect(modelFlagMisusedAsAgent('')).toBeNull();
  });
});

describe('modelFlagProblem', () => {
  it('reports an agent name passed as a model', () => {
    expect(modelFlagProblem('codex')).toContain('"codex" is an agent, not a model');
  });

  // Regression: `start --model opnai:gpt-5` ran against Anthropic with the
  // model name "opnai:gpt-5" and failed only at the provider.
  it('refuses a misspelled provider prefix, naming the provider it resembles', () => {
    expect(modelFlagProblem('opnai:gpt-5')).toMatch(/^Invalid --model "opnai:gpt-5": .*did you mean "openai"\?/);
    expect(modelFlagProblem('anthropc:claude-x')).toContain('did you mean "anthropic"?');
    expect(modelFlagProblem(':tag')).toMatch(/^Invalid --model/);
  });

  it('accepts real model IDs, including Ollama-style name:tag IDs, and no flag at all', () => {
    for (const model of [undefined, 'claude-opus-4-8', 'openai:gpt-5.5', 'glm-5.1:cloud', 'qwen3.5-uncensored:35b']) {
      expect(modelFlagProblem(model), String(model)).toBeNull();
    }
  });
});

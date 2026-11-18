/**
 * The workflow `--model` flag (start, resume-standalone, run-state) is held to
 * the same rules as a workflow definition's `model` field: a misspelled
 * provider prefix is refused before the run starts, instead of being sent to
 * the default provider as an opaque model name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkedModelOverride } from '../../src/workflow/cli-shared.js';

describe('checkedModelOverride', () => {
  let stderr: string[];
  let exitCodes: unknown[];

  beforeEach(() => {
    stderr = [];
    exitCodes = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      exitCodes.push(code);
      throw new Error('process.exit');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes valid and absent overrides through', () => {
    expect(checkedModelOverride(undefined, 1)).toBeUndefined();
    expect(checkedModelOverride('anthropic:claude-haiku-4-5', 1)).toBe('anthropic:claude-haiku-4-5');
    expect(checkedModelOverride('glm-5.1:cloud', 1)).toBe('glm-5.1:cloud');
    expect(exitCodes).toEqual([]);
  });

  // Regression: `--model opnai:gpt-5` was not validated at all and ran the
  // workflow against Anthropic with the model name "opnai:gpt-5".
  it.each([
    ['opnai:gpt-5', 1, /did you mean "openai"\?/],
    ['anthropc:claude-x', 2, /did you mean "anthropic"\?/],
    [':tag', 1, /Model ID must be/],
    ['', 2, /Model ID must be|Too small|>=1/],
  ])('refuses %j and exits with the caller’s usage code', (model, exitCode, reason) => {
    expect(() => checkedModelOverride(model, exitCode)).toThrow('process.exit');
    expect(exitCodes).toEqual([exitCode]);
    const output = stderr.join('');
    expect(output).toContain('Invalid --model');
    expect(output).toMatch(reason);
  });
});

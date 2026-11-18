import { describe, it, expect } from 'vitest';
import type { ModelMessage, ToolModelMessage } from 'ai';
import { ToolResultTrimmer } from '../src/session/tool-result-trimmer.js';

type Output = Extract<ToolModelMessage['content'][number], { type: 'tool-result' }>['output'];

function step(id: string, output: Output): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: id, toolName: 'execute_code', input: { code: id } }],
    },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'execute_code', output }] },
  ];
}

const big = (label: string): Output => ({ type: 'json', value: { result: `${label}:${'x'.repeat(3_000)}` } });

function resultOf(messages: readonly ModelMessage[], id: string): Output | undefined {
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.toolCallId === id) return part.output;
    }
  }
  return undefined;
}

function history(): ModelMessage[] {
  return [
    { role: 'user', content: 'task' },
    ...step('c1', big('one')),
    ...step('c2', { type: 'text', value: 'small' }),
    ...step('c3', big('three')),
    ...step('c4', big('four')),
    ...step('c5', big('five')),
    ...step('c6', big('six')),
  ];
}

describe('ToolResultTrimmer', () => {
  it('trims large results older than the most recent ones', () => {
    const trimmer = new ToolResultTrimmer({ keepRecent: 3, minChars: 2_000, previewChars: 20 });
    const messages = history();

    expect(trimmer.markOlderResults(messages)).toBe(2); // c1 and c3; c2 is small; c4..c6 are recent
    const trimmed = trimmer.apply(messages);

    const stub = resultOf(trimmed, 'c1');
    expect(stub).toMatchObject({ type: 'text' });
    expect(JSON.stringify(stub)).toContain('IronCurtain trimmed this earlier tool result');
    // Getting the full output back must not repeat side effects.
    expect(JSON.stringify(stub)).toContain('do not repeat actions that changed anything');
    expect(JSON.stringify(stub)).toContain('{\\"result\\":\\"one:xxxx');
    expect(JSON.stringify(stub)).not.toContain('x'.repeat(100));
    expect(resultOf(trimmed, 'c3')).toMatchObject({ type: 'text' });
    expect(resultOf(trimmed, 'c2')).toEqual({ type: 'text', value: 'small' });
    expect(resultOf(trimmed, 'c4')).toEqual(big('four'));
    expect(trimmer.trimmedCount).toBe(2);
  });

  it('keeps every call paired with a result and leaves untouched messages as they were', () => {
    const trimmer = new ToolResultTrimmer({ keepRecent: 3, minChars: 2_000, previewChars: 20 });
    const messages = history();
    trimmer.markOlderResults(messages);

    const trimmed = trimmer.apply(messages);

    expect(trimmed).toHaveLength(messages.length);
    trimmed.forEach((message, index) => {
      if (message.role === 'tool') {
        const [part] = message.content;
        const [original] = (messages[index] as ToolModelMessage).content;
        expect(part).toMatchObject({
          type: 'tool-result',
          toolCallId: original.type === 'tool-result' ? original.toolCallId : '',
        });
      } else {
        expect(message).toBe(messages[index]);
      }
    });
    expect(trimmed[4]).toBe(messages[4]); // c2's small result was not touched
  });

  it('is sticky and idempotent', () => {
    const trimmer = new ToolResultTrimmer({ keepRecent: 3, minChars: 2_000, previewChars: 20 });
    const messages = history();
    trimmer.markOlderResults(messages);
    const once = trimmer.apply(messages);

    expect(trimmer.markOlderResults(once)).toBe(0);
    const twice = trimmer.apply(once);
    twice.forEach((message, index) => expect(message).toBe(once[index]));

    // More steps arrive: the earlier stubs stay, and only newly old results are added.
    const longer = [...once, ...step('c7', big('seven')), ...step('c8', big('eight'))];
    expect(trimmer.markOlderResults(longer)).toBe(2); // c4 and c5
    const later = trimmer.apply(longer);
    expect(resultOf(later, 'c1')).toBe(resultOf(once, 'c1'));
    expect(resultOf(later, 'c6')).toEqual(big('six'));
  });

  it('keeps an error result an error', () => {
    const trimmer = new ToolResultTrimmer({ keepRecent: 0, minChars: 10, previewChars: 5 });
    const messages = step('c1', { type: 'error-text', value: 'failure '.repeat(10) });
    trimmer.markOlderResults(messages);
    expect(resultOf(trimmer.apply(messages), 'c1')).toMatchObject({ type: 'error-text' });
  });

  it('never trims results whose toolCallId another result shares', () => {
    const trimmer = new ToolResultTrimmer({ keepRecent: 1, minChars: 2_000, previewChars: 20 });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'task' },
      ...step('call_0', big('one')),
      ...step('call_0', big('two')),
      ...step('call_0', big('three')),
    ];

    expect(trimmer.markOlderResults(messages)).toBe(0);
    expect(trimmer.trimmedCount).toBe(0);
    const applied = trimmer.apply(messages);
    applied.forEach((message, index) => expect(message).toBe(messages[index]));
  });

  it('drops a stub once a later result reuses its id, so the stub never replaces that result', () => {
    const trimmer = new ToolResultTrimmer({ keepRecent: 1, minChars: 2_000, previewChars: 20 });
    const history = [...step('c1', big('one')), ...step('c2', big('two'))];
    expect(trimmer.markOlderResults(history)).toBe(1); // c1
    const stored = trimmer.apply(history);
    expect(JSON.stringify(resultOf(stored, 'c1'))).toContain('IronCurtain trimmed');

    // A later step reuses c1: its result must reach the model as it is.
    const later = [...stored, ...step('c1', big('newest'))];
    const applied = trimmer.apply(later);
    const newest = applied.at(-1);
    expect(newest?.role === 'tool' ? newest.content[0] : undefined).toMatchObject({ output: big('newest') });
    // The result trimmed earlier keeps its own stub.
    expect(applied[1]).toBe(stored[1]);
    expect(trimmer.trimmedCount).toBe(0);
    // And the shared id stays untrimmed from then on.
    expect(trimmer.markOlderResults([...later, ...step('c3', big('three'))])).toBe(1); // c2 only
    expect(JSON.stringify(resultOf(trimmer.apply(later), 'c2'))).toContain('IronCurtain trimmed');
  });

  it('forgets results that left the history, and everything on reset', () => {
    const trimmer = new ToolResultTrimmer({ keepRecent: 3, minChars: 2_000, previewChars: 20 });
    const messages = history();
    trimmer.markOlderResults(messages);

    trimmer.retainOnly(messages.slice(3)); // c1 was compacted away
    expect(trimmer.trimmedCount).toBe(1);
    trimmer.reset();
    expect(trimmer.trimmedCount).toBe(0);
    const copy = trimmer.apply(messages);
    expect(copy).not.toBe(messages);
    expect(copy).toEqual(messages);
  });
});

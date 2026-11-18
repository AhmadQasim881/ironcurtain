/**
 * Depth-aware field lookup and replacement in the trajectory reassemblers
 * (MITM-16).
 *
 * `findFieldValueSubstring` and `replaceTopLevelField` used to match the first
 * key of that name at any nesting depth. A Responses envelope lists `tools`
 * before `usage`, so a tool schema property named `usage` became the captured
 * usage, and the Anthropic splices rewrote `stop_reason`/`usage` keys inside a
 * tool_use input. Keys now match only at depth 1 of the object searched.
 */

import { describe, expect, it } from 'vitest';
import {
  AnthropicReassembler,
  ResponsesReassembler,
  findFieldValueSubstring,
  peekStringField,
  replaceTopLevelField,
} from '../../src/docker/trajectory-reassembler.js';

function sse(eventType: string, data: string): string {
  return `event: ${eventType}\ndata: ${data}\n\n`;
}

describe('findFieldValueSubstring / replaceTopLevelField', () => {
  const nestedFirst =
    '{"tools":[{"name":"t","parameters":{"properties":{"usage":{"type":"string"},"status":{"type":"string"}}}}],' +
    '"meta":{"usage":"nested"},"status":"completed","usage":{"input_tokens":11}}';

  it('returns the depth-1 value even when a nested key of the same name comes first', () => {
    expect(findFieldValueSubstring(nestedFirst, 'usage')).toBe('{"input_tokens":11}');
    expect(peekStringField(nestedFirst, 'status')).toBe('completed');
  });

  it('returns undefined when the name exists only below depth 1 or only as a string value', () => {
    expect(findFieldValueSubstring('{"a":{"usage":1},"b":["usage"],"c":"usage"}', 'usage')).toBeUndefined();
  });

  it('replaces only the depth-1 field', () => {
    expect(replaceTopLevelField(nestedFirst, 'usage', '{"input_tokens":99}')).toBe(
      nestedFirst.replace('"usage":{"input_tokens":11}', '"usage":{"input_tokens":99}'),
    );
    expect(replaceTopLevelField('{"a":{"usage":1}}', 'usage', '2')).toBe('{"a":{"usage":1}}');
  });

  it('tolerates whitespace around keys and values', () => {
    const spaced = '{ "a" : { "usage" : 1 } , "usage" : { "n" : 2 } }';
    expect(findFieldValueSubstring(spaced, 'usage')).toBe('{ "n" : 2 }');
    expect(replaceTopLevelField(spaced, 'usage', '3')).toBe('{ "a" : { "usage" : 1 } , "usage" : 3 }');
  });
});

describe('ResponsesReassembler: a tool schema with usage/output/status properties', () => {
  it('captures the envelope usage, status and output, not the schema properties', () => {
    const tools =
      '[{"type":"function","name":"lookup","parameters":{"type":"object","properties":{' +
      '"usage":{"type":"string","description":"how to use"},"output":{"type":"string"},"status":{"type":"string"}}}}]';
    const envelope = (output: string): string =>
      `{"id":"resp_1","object":"response","tools":${tools},"status":"completed","output":${output},` +
      '"usage":{"input_tokens":11,"output_tokens":5,"total_tokens":16}}';
    const item =
      '{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","annotations":[],"text":"hi"}]}';

    const reassembler = new ResponsesReassembler();
    reassembler.push(
      Buffer.from(
        sse('response.created', `{"type":"response.created","response":${envelope('[]')}}`) +
          sse(
            'response.output_item.added',
            '{"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message"}}',
          ) +
          sse(
            'response.output_text.delta',
            '{"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hi"}',
          ) +
          sse(
            'response.output_text.done',
            '{"type":"response.output_text.done","output_index":0,"content_index":0,"text":"hi"}',
          ) +
          sse('response.output_item.done', `{"type":"response.output_item.done","output_index":0,"item":${item}}`) +
          sse('response.completed', `{"type":"response.completed","response":${envelope('[]')}}`),
      ),
    );

    const result = reassembler.finalize();
    expect(result.usage).toEqual({ input_tokens: 11, output_tokens: 5, total_tokens: 16 });
    expect(result.stopReason).toBe('completed');
    // The item lands in the envelope's own output array; the schema is untouched.
    expect(result.bodyUtf8).toBe(envelope(`[${item}]`));
  });
});

describe('AnthropicReassembler: tool_use input keys named like envelope fields', () => {
  it('splices the envelope fields and leaves the tool input byte-for-byte intact', () => {
    const reassembler = new AnthropicReassembler();
    reassembler.push(
      Buffer.from(
        sse(
          'message_start',
          '{"type":"message_start","message":{"id":"msg_t","type":"message","role":"assistant","model":"c","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":1}}}',
        ) +
          sse(
            'content_block_start',
            '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"run","input":{}}}',
          ) +
          sse(
            'content_block_delta',
            `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify('{"stop_reason":"x","usage":"cpu"}')}}}`,
          ) +
          sse('content_block_stop', '{"type":"content_block_stop","index":0}') +
          sse(
            'message_delta',
            '{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null,"details":{"usage":"nested"}},"usage":{"output_tokens":42}}',
          ) +
          sse('message_stop', '{"type":"message_stop"}'),
      ),
    );

    const result = reassembler.finalize();
    expect(result.bodyUtf8).toBe(
      '{"id":"msg_t","type":"message","role":"assistant","model":"c",' +
        '"content":[{"type":"tool_use","id":"toolu_1","name":"run","input":{"stop_reason":"x","usage":"cpu"}}],' +
        '"stop_reason":"tool_use","stop_sequence":null,"usage":{"output_tokens":42}}',
    );
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage).toEqual({ output_tokens: 42 });
  });
});

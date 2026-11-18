import { describe, expect, it } from 'vitest';
import {
  JsonScanError,
  JsonStreamScanner,
  type JsonPathSegment,
  type JsonScanChild,
  type JsonScanLimits,
  type JsonScanVisitor,
} from '../../src/docker/json-stream-scanner.js';

interface RecordedChild {
  readonly path: JsonPathSegment[];
  readonly kind: JsonScanChild['kind'];
  readonly member: string;
  readonly value: string;
  readonly text?: string;
}

/** Scans `source` in chunks of `chunkSize` bytes (the whole buffer when undefined), recording every child. */
function scan(
  source: Buffer,
  visitor: Partial<JsonScanVisitor> = {},
  chunkSize?: number,
  limits?: Partial<JsonScanLimits>,
): RecordedChild[] {
  const recorded: RecordedChild[] = [];
  const scanner = new JsonStreamScanner(
    {
      track: visitor.track ?? (() => true),
      capture: visitor.capture ?? (() => true),
      child: (child) => {
        recorded.push({
          path: [...child.path],
          kind: child.kind,
          member: source.subarray(child.start, child.end).toString('utf8'),
          value: source.subarray(child.valueStart, child.end).toString('utf8'),
          ...(child.text === undefined ? {} : { text: child.text }),
        });
        visitor.child?.(child);
      },
    },
    limits,
  );
  const step = chunkSize ?? Math.max(1, source.length);
  for (let offset = 0; offset < source.length; offset += step) {
    scanner.write(source.subarray(offset, Math.min(source.length, offset + step)));
  }
  scanner.end();
  return recorded;
}

function scanError(run: () => unknown): JsonScanError {
  try {
    run();
  } catch (error) {
    if (error instanceof JsonScanError) return error;
    throw error;
  }
  throw new Error('expected a JsonScanError');
}

function valueAt(root: unknown, path: readonly JsonPathSegment[]): unknown {
  let value = root;
  for (const segment of path) value = (value as Record<string | number, unknown>)[segment];
  return value;
}

function countNodes(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce((sum: number, item) => sum + countNodes(item), 0);
  if (typeof value === 'object' && value !== null) {
    return 1 + Object.values(value).reduce((sum: number, item) => sum + countNodes(item), 0);
  }
  return 1;
}

/** A small deterministic generator, so a failure always reproduces. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const STRING_PIECES = ['a', 'Z', '0', ' ', '"', '\\', '/', '\n', '\t', '\u0001', 'é', '中', '🎉', ' ', 'versions'];

function randomString(random: () => number): string {
  let text = '';
  const length = Math.floor(random() * 6);
  for (let index = 0; index < length; index += 1) text += STRING_PIECES[Math.floor(random() * STRING_PIECES.length)];
  return text;
}

function randomValue(random: () => number, depth: number): unknown {
  const choice = Math.floor(random() * (depth > 3 ? 5 : 7));
  switch (choice) {
    case 0:
      return randomString(random);
    case 1:
      return [0, -0.5, 12, 1e21, -3.25e-7, 1234567890][Math.floor(random() * 6)];
    case 2:
      return random() < 0.5;
    case 3:
      return null;
    case 4:
      return '';
    case 5:
      return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth + 1));
    default: {
      const value: Record<string, unknown> = {};
      const members = Math.floor(random() * 4);
      for (let index = 0; index < members; index += 1)
        value[`${randomString(random)}${index}`] = randomValue(random, depth + 1);
      return value;
    }
  }
}

describe('JsonStreamScanner', () => {
  const VALID = [
    '{}',
    '[]',
    '0',
    '-0',
    '1.5e-3',
    '-12.5E+10',
    '"x"',
    'true',
    'false',
    'null',
    ' \n\t{ "a" : [ 1 , 2 ] }\r\n ',
    '{"a":1,"b":[true,false,null],"c":{"d":"e"}}',
    '{"k\\u0041y":"\\ud83d\\ude00","esc":"\\"\\\\\\/\\b\\f\\n\\r\\t"}',
    '{"unicode":"héllo 中文 🎉"}',
    '[[[[[]]]]]',
    '{"":""}',
    '[-1.25E+10,0.0,1e5,0e0]',
    '{"dup":1,"inner":{"x":1,"x":2}}',
  ];

  it.each(VALID)('accepts %j and reports exactly what JSON.parse sees', (text) => {
    const source = Buffer.from(text);
    const parsed: unknown = JSON.parse(text);
    // An untracked object may repeat a name (JSON.parse keeps the last); track
    // only what is unambiguous here so the comparison holds.
    const children = scan(source, { track: (path) => !path.includes('inner') });
    for (const child of children) {
      expect(JSON.parse(child.value)).toEqual(valueAt(parsed, child.path));
      if (child.kind === 'string') expect(child.text).toBe(valueAt(parsed, child.path));
    }
    expect(children.at(-1)?.path).toEqual([]);
  });

  it('reports every node of generated documents identically for any chunking', () => {
    const random = lcg(0x5eed);
    for (let round = 0; round < 200; round += 1) {
      const value = randomValue(random, 0);
      const text = JSON.stringify(value, null, random() < 0.5 ? 0 : 2);
      const source = Buffer.from(text);
      const whole = scan(source);
      expect(whole).toHaveLength(countNodes(value));
      for (const child of whole) {
        expect(JSON.parse(child.value)).toEqual(valueAt(value, child.path));
        const parent = valueAt(value, child.path.slice(0, -1));
        if (child.path.length > 0 && !Array.isArray(parent)) {
          // An object member's range is `"name": value`, so it parses as a one-member object.
          expect(JSON.parse(`{${child.member}}`)).toEqual({
            [child.path[child.path.length - 1]]: valueAt(value, child.path),
          });
        }
      }
      for (const chunkSize of [1, 2, 3, 7]) expect(scan(source, {}, chunkSize)).toEqual(whole);
    }
  });

  it.each([
    '',
    ' ',
    '{',
    '}',
    '[1,]',
    '{"a":1,}',
    '{a:1}',
    "{'a':1}",
    '[01]',
    '[1.]',
    '[.5]',
    '[+1]',
    '[1e]',
    '[-]',
    '[NaN]',
    '[Infinity]',
    '{"a" 1}',
    '{"a":1 "b":2}',
    '"\u0001"',
    '"\\x"',
    '"\\u12"',
    '"\\u12g4"',
    '1 2',
    '{} {}',
    'tru',
    'nul',
    '[true false]',
    '﻿{}',
    '{"a":1}x',
    '[1]]',
    '"unterminated',
    '[1,2',
    '//c\n{}',
    '[,1]',
    '{,}',
    '{"a"}',
    '{"a":}',
  ])('rejects %j as malformed, like JSON.parse', (text) => {
    expect(() => JSON.parse(text) as unknown).toThrow();
    for (const chunkSize of [undefined, 1]) {
      expect(scanError(() => scan(Buffer.from(text), {}, chunkSize)).code).toBe('malformed');
    }
  });

  it('reports absolute byte offsets across chunks, member name included', () => {
    const source = Buffer.from('{ "a" : [1, 2],\n  "é" : {"c": "x"} }');
    const children = scan(source, { track: (path) => path.length === 0, capture: () => false }, 3);

    expect(children.map(({ path, member, value }) => ({ path, member, value }))).toEqual([
      { path: ['a'], member: '"a" : [1, 2]', value: '[1, 2]' },
      { path: ['é'], member: '"é" : {"c": "x"}', value: '{"c": "x"}' },
      { path: [], member: source.toString(), value: source.toString() },
    ]);
  });

  it('reports only the children of tracked containers and captures only the strings asked for', () => {
    const source = Buffer.from('{"keep":{"s":"yes","n":1},"skip":{"s":"no"},"top":"t"}');
    const children = scan(source, {
      track: (path) => path.length === 0 || path[0] === 'keep',
      capture: (path) => path[0] === 'keep',
    });

    expect(children.map(({ path, text }) => ({ path, text }))).toEqual([
      { path: ['keep', 's'], text: 'yes' },
      { path: ['keep', 'n'] },
      { path: ['keep'] },
      { path: ['skip'] },
      { path: ['top'] },
      { path: [] },
    ]);
  });

  it('decodes captured strings whose escapes and multi-byte characters are split across chunks', () => {
    const value = 'aé中🎉"\\\n\u0001end';
    const source = Buffer.from(JSON.stringify({ key: value, ['kéy🎉']: 1 }));
    for (const chunkSize of [1, 2, 5]) {
      const children = scan(source, {}, chunkSize);
      expect(children.find((child) => child.path[0] === 'key')?.text).toBe(value);
      expect(children.some((child) => child.path[0] === 'kéy🎉')).toBe(true);
    }
  });

  it.each([
    ['a repeated name', '{"versions":{},"versions":{}}'],
    ['a repeated name spelled with an escape', '{"versions":{},"vers\\u0069ons":{}}'],
    ['a repeated name in a tracked child', '{"versions":{"1.0.0":{},"1.0.0":{"evil":true}}}'],
  ])('refuses %s in a tracked object', (_label, text) => {
    expect(scanError(() => scan(Buffer.from(text))).code).toBe('malformed');
  });

  it('allows a repeated name inside an object it does not track, as JSON.parse does', () => {
    const children = scan(Buffer.from('{"versions":{"1.0.0":{"a":1,"a":2}}}'), { track: (path) => path.length < 2 });
    expect(children.map((child) => child.path)).toEqual([['versions', '1.0.0'], ['versions'], []]);
  });

  it.each<[string, string, Partial<JsonScanLimits>]>([
    ['nesting depth', '[[[[1]]]]', { maxDepth: 3 }],
    ['member name length', `{"${'k'.repeat(65)}":1}`, { maxKeyBytes: 64 }],
    ['captured string length', `{"k":"${'v'.repeat(65)}"}`, { maxCaptureBytes: 64 }],
    ['tracked object members', '{"a":1,"b":2,"c":3}', { maxTrackedMembers: 2 }],
    ['tracked array elements', '[1,2,3]', { maxTrackedMembers: 2 }],
  ])('enforces its %s bound', (_label, text, limits) => {
    expect(scanError(() => scan(Buffer.from(text), {}, undefined, limits)).code).toBe('limit');
  });

  it('does not decode or bound names and strings it skips', () => {
    const text = `{"skip":{"${'k'.repeat(100)}":"${'v'.repeat(100)}"}}`;
    expect(() =>
      scan(Buffer.from(text), { track: (path) => path.length === 0 }, undefined, {
        maxKeyBytes: 8,
        maxCaptureBytes: 8,
      }),
    ).not.toThrow();
  });

  it('is unusable after an error and after end', () => {
    const failed = new JsonStreamScanner({ track: () => true, child: () => undefined });
    expect(() => failed.write(Buffer.from('{]'))).toThrow(JsonScanError);
    expect(() => failed.write(Buffer.from('{}'))).toThrow(JsonScanError);

    const ended = new JsonStreamScanner({ track: () => true, child: () => undefined });
    ended.write(Buffer.from('{}'));
    ended.end();
    expect(ended.bytesScanned).toBe(2);
    expect(() => ended.write(Buffer.from(' '))).toThrow(JsonScanError);
  });

  it('propagates an error the visitor throws', () => {
    const scanner = new JsonStreamScanner({
      track: () => true,
      child: () => {
        throw new Error('visitor refused');
      },
    });
    expect(() => scanner.write(Buffer.from('[1]'))).toThrow('visitor refused');
  });
});

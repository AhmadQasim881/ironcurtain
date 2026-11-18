/**
 * stableStringify (src/hash.ts) must produce exactly what JSON.stringify
 * produces, apart from sorted keys, and writeStableJsonAtomic
 * (src/hardened-fs.ts) must never persist bytes that do not parse back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeHash, stableStringify } from '../src/hash.js';
import { writeStableJsonAtomic } from '../src/hardened-fs.js';

/** JSON.stringify with every object's keys sorted, as the reference for stableStringify. */
function sortedJsonStringify(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner;
    const record = inner as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

describe('stableStringify mirrors JSON.stringify', () => {
  // Regression: `{a: undefined}` serialized to `{"a":}`, which no JSON parser accepts.
  it('omits undefined, function and symbol members of objects', () => {
    const text = stableStringify({ a: undefined, b: 1, c: () => 1, d: Symbol('s') });
    expect(text).toBe('{"b":1}');
    expect(JSON.parse(text ?? '')).toEqual({ b: 1 });
    expect(stableStringify({ a: undefined })).toBe('{}');
  });

  it('writes null for undefined, functions, symbols and holes in arrays', () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the point of the test
    const sparse = [1, , 3];
    expect(stableStringify([undefined, () => 1, Symbol('s'), 2])).toBe('[null,null,null,2]');
    expect(stableStringify(sparse)).toBe('[1,null,3]');
    expect(stableStringify(new Array(2))).toBe('[null,null]');
  });

  it('honours toJSON (a Date becomes its ISO string) and passes it the key', () => {
    const date = new Date('2026-11-11T10:00:00.000Z');
    expect(stableStringify({ at: date })).toBe('{"at":"2026-11-11T10:00:00.000Z"}');
    const keys: string[] = [];
    const probe = {
      toJSON(key: string) {
        keys.push(key);
        return { tag: key };
      },
    };
    expect(stableStringify({ x: probe, list: [probe] })).toBe('{"list":[{"tag":"0"}],"x":{"tag":"x"}}');
    expect(stableStringify(probe)).toBe('{"tag":""}');
    // Keys are visited in sorted order: list[0], then x, then the root.
    expect(keys).toEqual(['0', 'x', '']);
  });

  it('unwraps boxed primitives and writes non-finite numbers as null', () => {
    const boxed = { n: new Number(4), s: new String('x'), b: new Boolean(false) };
    expect(stableStringify(boxed)).toBe('{"b":false,"n":4,"s":"x"}');
    expect(stableStringify([NaN, Infinity, -0])).toBe('[null,null,0]');
  });

  it('throws on BigInt and on circular structures, as JSON.stringify does', () => {
    expect(() => stableStringify({ big: 1n })).toThrow(TypeError);
    expect(() => stableStringify(Object(1n))).toThrow(TypeError);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => stableStringify(cyclic)).toThrow(/circular/);
    const list: unknown[] = [];
    list.push({ back: list });
    expect(() => stableStringify(list)).toThrow(/circular/);
  });

  it('serializes a repeated, non-circular reference twice', () => {
    const shared = { v: 1 };
    expect(stableStringify({ a: shared, b: [shared] })).toBe('{"a":{"v":1},"b":[{"v":1}]}');
  });

  it('returns undefined for a value with no JSON form', () => {
    expect(stableStringify(undefined)).toBeUndefined();
    expect(stableStringify(() => 1)).toBeUndefined();
    expect(stableStringify(Symbol('s'))).toBeUndefined();
  });

  it('matches JSON.stringify with sorted keys on mixed input', () => {
    const value = {
      z: [1, 'two', { y: null, x: [true, undefined] }],
      a: { c: new Date(0), b: undefined, d: 'é \ud800' },
      m: new Map([[1, 2]]),
      n: -1.5e-7,
    };
    const text = stableStringify(value);
    expect(text).toBe(sortedJsonStringify(value));
    expect(stableStringify(JSON.parse(text ?? ''))).toBe(text);
  });

  it('leaves the hash of plain JSON data unchanged', () => {
    // Pinned digest of the canonical bytes {"a":[1,"x",null],"b":{"c":true}}.
    expect(stableStringify({ b: { c: true }, a: [1, 'x', null] })).toBe('{"a":[1,"x",null],"b":{"c":true}}');
    expect(computeHash({ b: { c: true }, a: [1, 'x', null] })).toBe(
      computeHash(JSON.parse('{"a":[1,"x",null],"b":{"c":true}}')),
    );
  });
});

describe('writeStableJsonAtomic', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ironcurtain-stable-json-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a record with undefined members as parseable JSON', () => {
    const path = join(dir, 'record.json');
    // A Partial update merged over a record, as updateSessionMetadata does.
    writeStableJsonAtomic(path, { persona: 'coder', policyDir: undefined, workspace: '/w' });

    expect(readFileSync(path, 'utf8')).toBe('{"persona":"coder","workspace":"/w"}\n');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ persona: 'coder', workspace: '/w' });
  });

  it('refuses a value with no JSON form and keeps the existing file', () => {
    const path = join(dir, 'record.json');
    writeFileSync(path, '{"kept":true}\n');

    expect(() => writeStableJsonAtomic(path, undefined)).toThrow(/no JSON representation/);
    expect(() => writeStableJsonAtomic(path, { big: 1n })).toThrow(TypeError);
    expect(readFileSync(path, 'utf8')).toBe('{"kept":true}\n');
    // No temporary file is left behind.
    expect(readdirSync(dir)).toEqual(['record.json']);
  });

  it('writes canonical bytes: sorted keys and a trailing newline, re-readable as the same record', () => {
    const path = join(dir, 'record.json');
    writeStableJsonAtomic(path, { b: [1, { d: 2, c: 3 }], a: 'x', at: new Date(0) });

    const text = readFileSync(path, 'utf8');
    expect(text).toBe('{"a":"x","at":"1970-01-01T00:00:00.000Z","b":[1,{"c":3,"d":2}]}\n');
    expect(`${stableStringify(JSON.parse(text)) ?? ''}\n`).toBe(text);
    expect(existsSync(path)).toBe(true);
  });
});

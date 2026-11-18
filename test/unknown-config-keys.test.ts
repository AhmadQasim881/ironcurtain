/**
 * findUnknownKeys (src/config/unknown-config-keys.ts) walks a zod schema and
 * lists the keys a parse would silently strip. editDistance/closestMatch
 * (src/utils/edit-distance.ts) back the "did you mean" suggestions.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findUnknownKeys } from '../src/config/unknown-config-keys.js';
import { closestMatch, editDistance } from '../src/utils/edit-distance.js';

describe('findUnknownKeys', () => {
  const schema = z.object({
    top: z.string().optional(),
    nested: z
      .object({ limit: z.number().nullable().optional(), deeper: z.object({ flag: z.boolean() }).optional() })
      .optional(),
    list: z.array(z.object({ name: z.string() })).optional(),
    record: z.record(z.string(), z.object({ value: z.number() })).optional(),
    tuple: z.tuple([z.object({ first: z.number() })]).optional(),
    mode: z.preprocess((v) => v, z.object({ kind: z.string() })).optional(),
    transformed: z
      .object({ raw: z.string() })
      .transform((v) => v.raw)
      .optional(),
    strict: z.strictObject({ only: z.number() }).optional(),
    loose: z.looseObject({ known: z.number() }).optional(),
    tagged: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('a'), alpha: z.number() }),
        z.object({ type: z.literal('b'), beta: z.number() }),
      ])
      .optional(),
    either: z.union([z.object({ left: z.number() }), z.object({ right: z.string() })]).optional(),
  });

  it('reports unknown keys at every depth with the keys known at that level', () => {
    const found = findUnknownKeys(schema, {
      top: 'x',
      tpo: 'typo',
      nested: { limt: 3, deeper: { flag: true, flg: false } },
      list: [{ name: 'a' }, { name: 'b', nmae: 'c' }],
      record: { anyKey: { value: 1, vaule: 2 } },
      tuple: [{ first: 1, frist: 2 }],
      mode: { kind: 'k', knid: 'x' },
      transformed: { raw: 'r', rwa: 's' },
    });

    expect(found.map((entry) => entry.path)).toEqual([
      ['tpo'],
      ['nested', 'limt'],
      ['nested', 'deeper', 'flg'],
      ['list', 1, 'nmae'],
      ['record', 'anyKey', 'vaule'],
      ['tuple', 0, 'frist'],
      ['mode', 'knid'],
      ['transformed', 'rwa'],
    ]);
    expect(found[1].knownKeys).toEqual(['limit', 'deeper']);
  });

  it('never reports record keys, loose-object keys, or the keys a strict object rejects itself', () => {
    expect(
      findUnknownKeys(schema, {
        record: { whatever: { value: 1 }, 'any.name': { value: 2 } },
        loose: { known: 1, extra: 2 },
        strict: { only: 1, rejectedByParse: 2 },
      }),
    ).toEqual([]);
  });

  it('follows the union option the value matches, by tag for a discriminated union', () => {
    expect(findUnknownKeys(schema, { tagged: { type: 'b', beta: 1, betta: 2 } }).map((e) => e.path)).toEqual([
      ['tagged', 'betta'],
    ]);
    // The tag picks the option even when another field is invalid.
    expect(findUnknownKeys(schema, { tagged: { type: 'a', alpha: 'not a number', alhpa: 1 } })[0]?.path).toEqual([
      'tagged',
      'alhpa',
    ]);
    expect(findUnknownKeys(schema, { either: { right: 'r', rigth: 'x' } })[0]?.path).toEqual(['either', 'rigth']);
    // No option matches: nothing is guessed.
    expect(findUnknownKeys(schema, { either: { neither: 1 } })).toEqual([]);
  });

  it('ignores values of the wrong shape (validation reports those)', () => {
    expect(findUnknownKeys(schema, { nested: 'not an object', list: { not: 'an array' } })).toEqual([]);
    expect(findUnknownKeys(schema, null)).toEqual([]);
    expect(findUnknownKeys(schema, [1, 2])).toEqual([]);
  });
});

describe('editDistance', () => {
  it('counts insertions, deletions, substitutions and adjacent transpositions', () => {
    expect(editDistance('anthropic', 'anthropic')).toBe(0);
    expect(editDistance('anthropc', 'anthropic')).toBe(1);
    expect(editDistance('opneai', 'openai')).toBe(1);
    expect(editDistance('opnai', 'openai')).toBe(1);
    expect(editDistance('gogle', 'google')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('ca', 'abc')).toBe(3);
  });

  it('closestMatch returns the nearest candidate within the limit', () => {
    expect(closestMatch('maxstep', ['maxsteps', 'maxtotaltokens'], 2)).toBe('maxsteps');
    expect(closestMatch('maxcostusd', ['maxestimatedcostusd'], 2)).toBeUndefined();
    expect(closestMatch<string>('x', [], 2)).toBeUndefined();
  });
});

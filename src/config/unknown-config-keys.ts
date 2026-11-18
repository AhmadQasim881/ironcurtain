/**
 * Finds object keys that a zod schema does not recognize, at any depth.
 *
 * `z.object()` strips keys it does not know, so a misspelled nested setting
 * (`resourceBudget.maxStep` for `maxSteps`) parses cleanly and the default
 * silently applies. Turning every section into `z.strictObject()` would make
 * such typos hard errors, but config.json deliberately tolerates (and keeps)
 * fields it does not know. This walker gives the loader the list of keys the
 * schema would have dropped, so it can warn about each one instead.
 *
 * The walk mirrors how zod parses: object shapes, optional/nullable/default
 * wrappers, records, arrays, tuples, unions (the first option the value
 * satisfies) and pipes. Keys of a strict object are not reported (the parse
 * itself rejects them), and keys a catchall or loose object accepts are known.
 * Schemas it cannot see into (refinement-only or custom types, intersections)
 * end the walk without reports, so it never invents a warning.
 */

import { z } from 'zod';
import { isPlainObject } from '../utils/is-plain-object.js';

export interface UnknownKey {
  /** Path from the root to the unknown key, ending with the key itself. */
  readonly path: readonly (string | number)[];
  /** Keys the schema accepts in the object that holds it (for suggestions). */
  readonly knownKeys: readonly string[];
}

/**
 * Every key in `value` that `schema` would strip, in document order. A value
 * the schema rejects outright is still walked where its shape is clear, so a
 * typo next to an invalid field is reported too.
 */
export function findUnknownKeys(schema: z.ZodType, value: unknown): UnknownKey[] {
  const found: UnknownKey[] = [];
  walk(schema, value, [], found);
  return found;
}

/** Guards against a pathological recursive (lazy) schema. Config files are shallow. */
const MAX_DEPTH = 64;

function walk(schema: z.ZodType, value: unknown, path: (string | number)[], found: UnknownKey[]): void {
  if (path.length > MAX_DEPTH || value === undefined || value === null) return;

  if (schema instanceof z.ZodObject) {
    walkObject(schema, value, path, found);
  } else if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodNonOptional ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodLazy
  ) {
    walk(schema.unwrap() as z.ZodType, value, path, found);
  } else if (schema instanceof z.ZodPipe) {
    // `z.preprocess(fn, s)` is a pipe from a transform into `s`: the raw value
    // is what `s` describes. Otherwise (`s.transform(fn)`) the input side does.
    const inner = schema.in instanceof z.ZodTransform ? schema.out : schema.in;
    walk(inner as z.ZodType, value, path, found);
  } else if (schema instanceof z.ZodRecord) {
    if (!isPlainObject(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      walk(schema.valueType as z.ZodType, entry, [...path, key], found);
    }
  } else if (schema instanceof z.ZodArray) {
    if (!Array.isArray(value)) return;
    value.forEach((entry, index) => walk(schema.element as z.ZodType, entry, [...path, index], found));
  } else if (schema instanceof z.ZodTuple) {
    if (!Array.isArray(value)) return;
    const items = schema.def.items as readonly z.ZodType[];
    const rest = schema.def.rest as z.ZodType | null;
    value.forEach((entry, index) => {
      const item = index < items.length ? items[index] : rest;
      if (item) walk(item, entry, [...path, index], found);
    });
  } else if (schema instanceof z.ZodUnion) {
    const match = unionOptionFor(schema, value);
    if (match) walk(match, value, path, found);
  }
}

/**
 * The union option that describes `value`: for a discriminated union the one
 * its tag selects (so a typo is still found when another field is invalid),
 * otherwise the first option that parses it.
 */
function unionOptionFor(schema: z.ZodUnion, value: unknown): z.ZodType | undefined {
  const options = schema.options as readonly z.ZodType[];
  if (schema instanceof z.ZodDiscriminatedUnion && isPlainObject(value)) {
    const tag = schema.def.discriminator;
    const tagged = options.find((option) => {
      if (!(option instanceof z.ZodObject)) return false;
      const tagSchema = (option.shape as Readonly<Record<string, z.ZodType>>)[tag] as z.ZodType | undefined;
      return tagSchema !== undefined && tagSchema.safeParse(value[tag]).success;
    });
    if (tagged) return tagged;
  }
  return options.find((option) => option.safeParse(value).success);
}

function walkObject(schema: z.ZodObject, value: unknown, path: (string | number)[], found: UnknownKey[]): void {
  if (!isPlainObject(value)) return;
  const shape = schema.shape as Readonly<Record<string, z.ZodType>>;
  const catchall = schema.def.catchall as z.ZodType | undefined;
  const knownKeys = Object.keys(shape);
  for (const [key, entry] of Object.entries(value)) {
    if (Object.hasOwn(shape, key)) {
      walk(shape[key], entry, [...path, key], found);
    } else if (catchall === undefined) {
      found.push({ path: [...path, key], knownKeys });
    } else if (!(catchall instanceof z.ZodNever)) {
      // Loose objects and catchalls accept the key; a strict object
      // (catchall never) rejects it in the parse, so it is not repeated here.
      walk(catchall, entry, [...path, key], found);
    }
  }
}

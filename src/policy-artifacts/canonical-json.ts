/**
 * Canonical JSON and content digests for policy artifacts.
 *
 * Digests of artifact content (tool annotations, verified rules, resolved
 * lists, and the tool input schemas the live-schema drift check compares in
 * `src/trusted-process/schema-drift.ts`) must not depend on key order or
 * formatting, and an in-memory value must digest the same as its JSON
 * round-trip: the compile pipeline digests what it is about to write, and
 * loaders digest what they read back.
 *
 * Runtime leaf: no imports from src/pipeline.
 */

import { createHash } from 'node:crypto';
import { isPlainObject } from '../utils/is-plain-object.js';

/**
 * JSON with object keys sorted at every level. Follows JSON.stringify for
 * values JSON cannot hold (undefined members are skipped, undefined array
 * elements become null), so an in-memory value and its JSON round-trip have
 * the same canonical form.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const members: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const member = value[key];
      if (member === undefined || typeof member === 'function' || typeof member === 'symbol') continue;
      members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
    }
    return `{${members.join(',')}}`;
  }
  // As in a JSON array: values JSON cannot represent become null.
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null';
  return JSON.stringify(value);
}

/** sha256 (hex) of {@link canonicalJson}. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

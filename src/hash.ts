/**
 * Shared hashing utilities for loop detection and canonical records.
 *
 * Provides deterministic JSON serialization and SHA-256 hashing
 * used by both the StepLoopDetector (agent level) and the
 * CallCircuitBreaker (proxy level), and the canonical bytes that
 * `writeStableJsonAtomic` (src/hardened-fs.ts) persists.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Deterministic JSON serialization with sorted keys.
 * Ensures `{a:1, b:2}` and `{b:2, a:1}` produce identical strings.
 *
 * Apart from the key order it produces exactly what `JSON.stringify` does, so
 * the output always parses: object members whose value is `undefined`, a
 * function or a symbol are omitted, the same values in an array become
 * `null` (as do array holes), a `toJSON()` method is honoured (a `Date`
 * becomes its ISO string), boxed primitives are unwrapped, and non-finite
 * numbers become `null`. Like `JSON.stringify`, it throws a `TypeError` for a
 * BigInt (unless it has a `toJSON`) and for a circular structure. Returns
 * `undefined` when the value itself has no JSON representation (`undefined`,
 * a function, a symbol).
 */
export function stableStringify(value: unknown): string | undefined {
  return serialize('', value, []);
}

/** `ancestors` holds the objects being serialized above this one, for cycle detection. */
function serialize(key: string, input: unknown, ancestors: object[]): string | undefined {
  const value = unboxPrimitive(applyToJSON(key, input));
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'bigint':
      throw new TypeError('Do not know how to serialize a BigInt');
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value);
    default:
      break;
  }
  if (ancestors.includes(value)) throw new TypeError('Converting circular structure to JSON');
  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      // Index loop, not map(): map() skips holes, and a hole must become null.
      for (let index = 0; index < value.length; index += 1) {
        items.push(serialize(String(index), (value as unknown[])[index], ancestors) ?? 'null');
      }
      return '[' + items.join(',') + ']';
    }
    const record = value as Record<string, unknown>;
    const pairs: string[] = [];
    for (const k of Object.keys(record).sort()) {
      const member = serialize(k, record[k], ancestors);
      if (member !== undefined) pairs.push(JSON.stringify(k) + ':' + member);
    }
    return '{' + pairs.join(',') + '}';
  } finally {
    ancestors.pop();
  }
}

/** `value.toJSON(key)` when the value (an object, function or BigInt) has one, as `JSON.stringify` calls it. */
function applyToJSON(key: string, value: unknown): unknown {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function' || typeof value === 'bigint') {
    const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') return (toJSON as (this: unknown, key: string) => unknown).call(value, key);
  }
  return value;
}

/** Number, String, Boolean and BigInt objects serialize as their primitive value. */
function unboxPrimitive(value: unknown): unknown {
  if (value instanceof Number) return Number(value);
  if (value instanceof String) return String(value);
  if (value instanceof Boolean || value instanceof BigInt) return value.valueOf();
  return value;
}

/**
 * SHA-256 hash of a deterministically serialized value.
 * Returns a hex-encoded digest.
 */
export function computeHash(value: unknown): string {
  return createHash('sha256')
    .update(stableStringify(value) ?? '')
    .digest('hex');
}

/** SHA-256 hex digest of raw bytes (Buffer/Uint8Array) or a UTF-8 string. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Lowercase 64-char SHA-256 hex string, shared across host-owned record schemas. */
export const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);

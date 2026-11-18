/**
 * Writer provenance in a memory row's `metadata` JSON (`metadata.writer`).
 *
 * The writer comes from the host-set environment (see config.ts), never from tool
 * arguments, and is kept in the existing `metadata` column so no schema change (and
 * no rebuild of existing databases) is needed. A row written before provenance
 * existed, or by a server the host gave no writer, has none.
 */

import { MEMORY_WRITER_KINDS, type MemoryWriter, type MemoryWriterKind } from '../types.js';

function parseMetadataObject(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const value: unknown = JSON.parse(metadata);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A well-formed writer record, or undefined. */
export function asMemoryWriter(value: unknown): MemoryWriter | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== 'string' || !(MEMORY_WRITER_KINDS as readonly string[]).includes(kind)) return undefined;
  const writer: MemoryWriter = { kind: kind as MemoryWriterKind };
  if (typeof record.session_id === 'string') writer.session_id = record.session_id;
  if (typeof record.scope === 'string') writer.scope = record.scope;
  return writer;
}

/** The writer recorded in a row's `metadata` JSON, if any. */
export function readWriter(metadata: string | null): MemoryWriter | undefined {
  return asMemoryWriter(parseMetadataObject(metadata)?.writer);
}

/**
 * `metadata` with its writer replaced by `writer`, or removed when `writer` is
 * undefined. Other keys are kept; unparseable metadata is replaced. Returns null
 * when nothing is left.
 */
export function withWriter(metadata: string | null, writer: MemoryWriter | undefined): string | null {
  const parsed = parseMetadataObject(metadata) ?? {};
  if (writer === undefined) {
    delete parsed.writer;
  } else {
    parsed.writer = writer;
  }
  return Object.keys(parsed).length > 0 ? JSON.stringify(parsed) : null;
}

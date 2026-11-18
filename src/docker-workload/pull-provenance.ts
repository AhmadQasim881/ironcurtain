/**
 * Durable, append-only provenance for the registry pulls of one admitted
 * Docker-workload bundle (§6.4 of the secure nested runtime plan).
 *
 * Every manifest or blob request that completes through the bundle's
 * registry-egress listener appends one JSON line: the reviewed origin that
 * served it (`<origin>:cdn` after a followed redirect to an unlisted CDN), the
 * final HTTPS destination and its HTTP status (a refused or missing pull is
 * recorded with its 4xx status, never as a delivered one), the repository and
 * reference the bundle asked for, the digest it requested (for a by-digest
 * pull), the digest the registry reported, and the bytes streamed. These are
 * registry-reported values. They are audit provenance, never an
 * attestation of the pulled bytes (§16.6): workload images stay untrusted
 * bundle state.
 *
 * The lease owns the log. It lives in the lease's host-only `evidence/`
 * directory, which teardown never deletes, so the record outlives the session.
 * A bundle controls how often it pulls, so the log is bounded: past
 * {@link MAX_REGISTRY_PULL_PROVENANCE_BYTES} one truncation marker is appended
 * and later pulls are dropped.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { assertCanonicalHostPath } from '../hardened-fs.js';
import { lifecycleIdentifierSchema, timestampSchema } from '../zod-helpers.js';
import type { RegistryPullProvenance } from '../docker/registry-egress-proxy.js';

/** File name inside the lease's evidence directory. */
export const REGISTRY_PULL_PROVENANCE_FILE = 'registry-pull-provenance.jsonl';
export const REGISTRY_PULL_PROVENANCE_SCHEMA_VERSION = 1;
/** Largest log one lease keeps; roughly tens of thousands of pulls. */
export const MAX_REGISTRY_PULL_PROVENANCE_BYTES = 16 * 1024 * 1024;
/** Space held back so the truncation marker always fits. */
const TRUNCATION_MARKER_RESERVE_BYTES = 1024;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
/**
 * A reviewed origin ID, suffixed `:cdn` once per followed redirect to an
 * unlisted CDN host (Docker Hub serves every blob that way), so the schema
 * must admit the suffix or the common blob pull would never be recorded.
 */
const originIdSchema = z
  .string()
  .max(256)
  .regex(/^[a-z0-9][a-z0-9._-]{2,127}(?::cdn)*$/u);
/**
 * Where the terminal response came from. A derived CDN host is whatever DNS
 * name the registry redirected to, so only printable, space-free ASCII is
 * required; JSON encoding keeps the line intact.
 */
const destinationSchema = z
  .object({
    hostname: z.string().regex(/^[\x21-\x7e]{1,253}$/u),
    port: z.number().int().min(1).max(65_535),
  })
  .strict();
const bindingShape = {
  schemaVersion: z.literal(REGISTRY_PULL_PROVENANCE_SCHEMA_VERSION),
  at: timestampSchema,
  leaseId: lifecycleIdentifierSchema,
  generation: lifecycleIdentifierSchema,
  bundleId: lifecycleIdentifierSchema,
};

const pullRecordSchema = z
  .object({
    ...bindingShape,
    kind: z.literal('registry-pull'),
    originId: originIdSchema,
    operation: z.enum(['manifest-pull', 'blob-pull']),
    method: z.enum(['GET', 'HEAD']),
    destination: destinationSchema,
    /** A refused or missing pull completes too; only a 2xx status delivered content. */
    status: z.number().int().min(100).max(599),
    repository: z.string().min(1).max(255).optional(),
    reference: z.string().min(1).max(255).optional(),
    requestedDigest: digestSchema.optional(),
    resolvedDigest: digestSchema.optional(),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const truncationRecordSchema = z
  .object({
    ...bindingShape,
    kind: z.literal('truncated'),
    maxBytes: z.number().int().positive(),
  })
  .strict();

export const registryPullProvenanceRecordSchema = z.discriminatedUnion('kind', [
  pullRecordSchema,
  truncationRecordSchema,
]);
export type RegistryPullProvenanceRecord = z.infer<typeof registryPullProvenanceRecordSchema>;

/** The lease identity stamped on every record. */
export interface RegistryPullProvenanceBinding {
  readonly leaseId: string;
  readonly generation: string;
  readonly bundleId: string;
}

export interface RegistryPullProvenanceSink {
  readonly path: string;
  /** Append one completed pull. Throws on a write failure; callers decide how a gap is reported. */
  append(record: RegistryPullProvenance, at: Date): void;
}

/**
 * Append-only JSONL sink for one lease. Every append opens the file without
 * following links, requires an owner-only single-link regular file in an
 * owner-only directory, and writes one validated line with `O_APPEND`.
 */
export function createRegistryPullProvenanceSink(
  path: string,
  binding: RegistryPullProvenanceBinding,
  maxBytes: number = MAX_REGISTRY_PULL_PROVENANCE_BYTES,
): RegistryPullProvenanceSink {
  assertCanonicalHostPath(path, 'registry pull provenance log');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= TRUNCATION_MARKER_RESERVE_BYTES) {
    throw new Error('registry pull provenance bound is invalid');
  }
  let truncated = false;
  return {
    path,
    append(record: RegistryPullProvenance, at: Date): void {
      if (truncated) return;
      const line = serializeRecord({
        schemaVersion: REGISTRY_PULL_PROVENANCE_SCHEMA_VERSION,
        kind: 'registry-pull',
        at: at.toISOString(),
        ...binding,
        ...definedFields(record),
      });
      const marker = serializeRecord({
        schemaVersion: REGISTRY_PULL_PROVENANCE_SCHEMA_VERSION,
        kind: 'truncated',
        at: at.toISOString(),
        ...binding,
        maxBytes,
      });
      truncated = appendBounded(path, line, marker, maxBytes) === 'truncated';
    },
  };
}

function serializeRecord(record: unknown): string {
  return `${JSON.stringify(registryPullProvenanceRecordSchema.parse(record))}\n`;
}

/** Drop `undefined` optionals so the strict schema sees only present fields. */
function definedFields(record: RegistryPullProvenance): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/** Append `line`, or the truncation marker instead once `line` would cross the bound. */
function appendBounded(path: string, line: string, marker: string, maxBytes: number): 'appended' | 'truncated' {
  assertPrivateParent(path);
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stats = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o077) !== 0 ||
      (uid !== undefined && stats.uid !== uid)
    ) {
      throw new Error('registry pull provenance log must be an owner-only, single-link regular file');
    }
    const bytes = Buffer.from(line, 'utf8');
    if (stats.size + bytes.length > maxBytes - TRUNCATION_MARKER_RESERVE_BYTES) {
      writeAll(descriptor, Buffer.from(marker, 'utf8'));
      return 'truncated';
    }
    writeAll(descriptor, bytes);
    return 'appended';
  } finally {
    closeSync(descriptor);
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
}

function assertPrivateParent(path: string): void {
  const parent = lstatSync(dirname(path));
  const uid = process.getuid?.();
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    (uid !== undefined && parent.uid !== uid)
  ) {
    throw new Error('registry pull provenance directory must be an owner-only real directory');
  }
}

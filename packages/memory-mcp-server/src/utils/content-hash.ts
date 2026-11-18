import { createHash } from 'node:crypto';

/**
 * The identity of a source segment's text: a SHA-256 over its content, the ingest's
 * `source` label and its mode. An ingest that is retried (the MCP call timed out on the
 * client side, or the agent sent it again) finds the segment its first run wrote under
 * this hash and links its facts to that row instead of writing a duplicate (see
 * materializeSegment in storage/queries.ts).
 */
export function segmentContentHash(
  content: string,
  source: string | null | undefined,
  mode: string | null | undefined,
): string {
  return createHash('sha256')
    .update(JSON.stringify([content, source ?? null, mode ?? null]))
    .digest('hex');
}

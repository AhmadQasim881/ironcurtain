/**
 * Resource limits for `--capture-traces` response capture.
 *
 * Trajectory capture predates the bounded metrics observer and deliberately
 * records a whole exchange or none of it, so it must not silently inherit the
 * metrics observer's smaller per-response limits (32 MiB, 100,000 SSE
 * events): a partial training record is not useful. These caps are
 * deliberately generous but finite, because the reassembler retains every
 * event of the stream until it settles; they protect the process from an
 * unbounded response or a decompressor that falls behind.
 *
 * Exceeding a limit is a resource condition, not a parser fault: it costs the
 * one exchange (dropped and counted in `session-end.abortedExchanges`), never
 * the session. See docs/designs/mitm-token-trajectory-capture.md §9.7.
 */

import type { ContentDecoderLimits } from './llm-observation/content-decoder.js';
import type { SseEventFramerLimits } from './llm-observation/sse-event-framer.js';

/** Bounded decoding of a compressed (gzip, deflate, br) response for capture. */
export const TRAJECTORY_DECODER_LIMITS: Readonly<ContentDecoderLimits> = Object.freeze({
  maxCompressedBytes: 64 * 1024 * 1024,
  maxDecodedBytes: 128 * 1024 * 1024,
  maxExpansionRatio: 4_096,
  expansionRatioSlackBytes: 4 * 1024 * 1024,
  maxPendingInputBytes: 8 * 1024 * 1024,
});

/**
 * SSE framing for the reassemblers. The stream cap equals the decoded-byte
 * cap, so a compressed and an uncompressed stream are bounded alike (an
 * identity stream has no decoder in front of the framer). A line or an event
 * may be as large as a quarter of the stream: a Responses `output_item.done`
 * or `response.completed` carries a whole item or envelope on one line. The
 * event count keeps the metrics framer's density (100,000 events per 32 MiB)
 * scaled to the 128 MiB stream, which also bounds the per-event bookkeeping of
 * a stream of tiny events.
 */
export const TRAJECTORY_SSE_FRAMER_LIMITS: Readonly<SseEventFramerLimits> = Object.freeze({
  maxStreamBytes: TRAJECTORY_DECODER_LIMITS.maxDecodedBytes,
  maxLineBytes: 32 * 1024 * 1024,
  maxEventBytes: 32 * 1024 * 1024,
  maxEvents: 400_000,
});

/**
 * A response captured verbatim (a non-streaming JSON body, or SSE on a route
 * without a reassembler) is buffered whole, so it gets the same decoded-byte
 * cap.
 */
export const TRAJECTORY_MAX_RAW_RESPONSE_BYTES = TRAJECTORY_DECODER_LIMITS.maxDecodedBytes;

/**
 * Request `Content-Encoding` handling for buffered (sanitized or rewritten)
 * endpoints.
 *
 * A sanitizer can only inspect plain bytes, and the proxy never forwards
 * bytes it did not inspect. Clients do compress request bodies: Codex enables
 * zstd request compression (`enable_request_compression`) by default for the
 * ChatGPT backend. So the proxy decodes the single standard codings Node can
 * decode (gzip, deflate, br, zstd), sanitizes the decoded JSON and forwards
 * the canonical serialization uncompressed (the caller drops the
 * `Content-Encoding` header). Anything else is refused locally:
 *
 * - an unknown coding, or several stacked codings: 415, before the body is
 *   buffered ({@link parseRequestContentCoding});
 * - corrupt or truncated compressed data: 400;
 * - a body that decodes to more than the buffering limit: 413. Decoding stops
 *   as soon as the output passes the limit, so a decompression bomb never
 *   allocates more than the limit, and the zstd decoder's window is capped so
 *   a frame cannot demand a huge window buffer.
 *
 * The caller can also charge each decoded chunk to a shared budget as it is
 * produced (`reserve`): the MITM proxy charges its per-bundle buffered-body
 * budget, so concurrent bombs that each stay under the per-request limit
 * cannot together hold more than the budget, even while they decode.
 *
 * Decoding runs on the libuv thread pool (async zlib), not the event loop.
 */

import type { OutgoingHttpHeaders } from 'node:http';
import * as zlib from 'node:zlib';
import { isObjectWithProp } from '../../utils/is-plain-object.js';
import { RequestRejectedError, labelValue } from './core.js';

/** A request content coding the proxy can decode. */
export type RequestContentCoding = 'gzip' | 'deflate' | 'br' | 'zstd';

/** Registered coding names (RFC 9110 §8.4.1; `x-gzip` is an alias of `gzip`). */
const CODINGS: ReadonlyMap<string, RequestContentCoding> = new Map<string, RequestContentCoding>([
  ['gzip', 'gzip'],
  ['x-gzip', 'gzip'],
  ['deflate', 'deflate'],
  ['br', 'br'],
  ['zstd', 'zstd'],
]);

/**
 * Largest zstd window the decoder accepts: 2^24 bytes (16 MiB). Compression
 * levels 1-19 never use a window above 2^23, whatever the body size, and zstd
 * shrinks the window to the content when its size is known; only the "ultra"
 * levels (20-22) or long-distance matching, on a body over 16 MiB, could need
 * more, and such a frame is refused as invalid (400). The decoder's default
 * limit (2^27) would let a crafted frame claim a 128 MiB buffer per request.
 */
const ZSTD_MAX_WINDOW_LOG = 24;

/**
 * A fresh streaming decoder per coding. These are the engines behind
 * `zlib.gunzip` and its siblings; the proxy drives them as streams so it can
 * count (and charge) every decoded chunk as it is produced.
 */
const DECODERS: Readonly<
  Record<RequestContentCoding, () => zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | zlib.ZstdDecompress>
> = {
  gzip: () => zlib.createGunzip(),
  // HTTP `deflate` is the zlib format (RFC 9110 §8.4.1.2), which `inflate` expects.
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
  zstd: () => zlib.createZstdDecompress({ params: { [zlib.constants.ZSTD_d_windowLogMax]: ZSTD_MAX_WINDOW_LOG } }),
};

/** Error-code discriminant: a decode stopped because the caller's `reserve` hook refused more output. */
export const DECODE_BUDGET_EXHAUSTED = 'DECODE_BUDGET_EXHAUSTED';

/**
 * Thrown by {@link decodeRequestBody} when its `reserve` hook refuses the next
 * decoded chunk. Not a {@link RequestRejectedError}: the body may be fine, the
 * shared budget is spent, so the caller answers it as a transient refusal.
 */
export class DecodeBudgetExhaustedError extends Error {
  readonly code = DECODE_BUDGET_EXHAUSTED;

  constructor(readonly decodedBytes: number) {
    super(`decoding stopped after ${decodedBytes} bytes: the buffering budget cannot hold more`);
    this.name = 'DecodeBudgetExhaustedError';
  }
}

export function isDecodeBudgetExhaustedError(error: unknown): error is DecodeBudgetExhaustedError {
  return isObjectWithProp(error, 'code') && error.code === DECODE_BUDGET_EXHAUSTED;
}

/**
 * The coding named by a request's `Content-Encoding` header, or `undefined`
 * for an absent header or `identity`. Throws {@link RequestRejectedError}
 * (415) for an unknown coding or for more than one coding: a stacked body is
 * never produced by an LLM client, and refusing it keeps decoding to one
 * bounded pass. Repeated headers arrive joined with commas, so they count as
 * stacked too.
 */
export function parseRequestContentCoding(
  header: string | readonly string[] | undefined,
): RequestContentCoding | undefined {
  if (header === undefined) return undefined;
  const value = typeof header === 'string' ? header : header.join(',');
  const codings = value
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== '' && coding !== 'identity');
  if (codings.length === 0) return undefined;
  if (codings.length > 1) {
    throw new RequestRejectedError(415, `unsupported Content-Encoding: ${labelValue(value)} (stacked codings)`);
  }
  const coding = CODINGS.get(codings[0]);
  if (coding === undefined) {
    throw new RequestRejectedError(415, `unsupported Content-Encoding: ${labelValue(codings[0])}`);
  }
  return coding;
}

/**
 * Decode a buffered request body. Returns `body` itself when there is no
 * coding. Throws {@link RequestRejectedError}: 400 for data that is not valid
 * in its declared coding, 413 when the decoded body would exceed `maxBytes`.
 *
 * With `reserve`, every decoded chunk is offered to it before it is kept; when
 * it returns false, decoding stops at once and the call throws
 * {@link DecodeBudgetExhaustedError}. Bytes it accepted stay accepted (the
 * caller returns them with the rest of its account). Without the hook, the
 * output is bounded by `maxBytes` alone.
 */
export function decodeRequestBody(
  body: Buffer,
  coding: RequestContentCoding | undefined,
  maxBytes: number,
  reserve?: (bytes: number) => boolean,
): Promise<Buffer> {
  if (coding === undefined) return Promise.resolve(body);
  return new Promise((resolve, reject) => {
    const decoder = DECODERS[coding]();
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      // Stops the engine; work already queued on the thread pool is discarded.
      decoder.destroy();
      reject(error);
    };
    decoder.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new RequestRejectedError(413, `request body exceeds ${maxBytes} bytes once decoded`));
        return;
      }
      if (reserve !== undefined && !reserve(chunk.length)) {
        fail(new DecodeBudgetExhaustedError(size - chunk.length));
        return;
      }
      chunks.push(chunk);
    });
    decoder.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
    decoder.on('error', () => {
      fail(new RequestRejectedError(400, `request body is not valid ${coding} data`));
    });
    decoder.end(body);
  });
}

/**
 * Remove every `Content-Encoding` header (any letter case) from forwarded
 * headers, in place: the proxy forwards the decoded body.
 */
export function clearContentEncoding(headers: OutgoingHttpHeaders): void {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'content-encoding') Reflect.deleteProperty(headers, name);
  }
}

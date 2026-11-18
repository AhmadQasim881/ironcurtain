/**
 * WebSocket send-buffer backpressure shared by every daemon -> browser push
 * path (`WebUiServer.sendToSubscribers`, `TokenStreamBridge`, PTY output).
 *
 * `ws` buffers outgoing frames in user space without bound: a stalled or
 * backgrounded tab that stops reading makes `bufferedAmount` grow until the
 * 60 s ping timeout terminates it. Unsolicited frames are therefore skipped
 * for a client above the threshold instead of growing the heap further, and
 * each push path recovers in its own way once the client drains: generic
 * events end in a `daemon.resync` frame (the UI refetches its state), PTY
 * output in a full-screen replay, and token-stream deltas (display-only) are
 * simply dropped. Request *responses* are never skipped here; see
 * `WebUiServer.sendResponse`, which replaces an oversized reply with a bounded
 * `RESPONSE_TOO_LARGE` error and keeps the socket open.
 *
 * All paths use the same threshold so a PTY replay that its manager decides
 * to send is never itself skipped by `sendToSubscribers`.
 */

/** Above this many buffered bytes a client stops receiving event frames until it drains. */
export const WS_EVENT_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

/** Minimal view of a `ws` WebSocket for the backpressure decision (testable without a socket). */
export interface BackpressureProbe {
  readonly bufferedAmount: number;
}

/** True when `client` has more than `threshold` bytes queued and should be skipped for this frame. */
export function isBackpressured(client: BackpressureProbe, threshold = WS_EVENT_BACKPRESSURE_BYTES): boolean {
  return client.bufferedAmount > threshold;
}

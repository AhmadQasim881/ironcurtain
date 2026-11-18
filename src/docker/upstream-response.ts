/** Exchange-local validation and exception containment for HTTP response relays. */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Only standard integer HTTP status codes can cross a response boundary. */
export function isValidUpstreamStatus(status: unknown): status is number {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599;
}

/**
 * An upstream callback runs after the request listener's try/catch returned.
 * Validate its metadata and contain failures here, before they can leave the
 * callback. A failed relay closes this exchange, never the host process.
 */
export function guardUpstreamResponse(
  client: ServerResponse,
  forward: (upstream: IncomingMessage) => void,
  onRejected?: () => void,
): (upstream: IncomingMessage) => void {
  return (upstream) => {
    const destroyClient = (): void => {
      try {
        client.destroy();
      } catch {
        // Cleanup must not throw out of a response callback either.
      }
    };
    const reject = (): void => {
      try {
        upstream.on('error', () => undefined);
        upstream.destroy();
      } catch {
        // Continue refusing the client response even if upstream cleanup fails.
      }
      // Settle transport bookkeeping before end() can finalize the exchange.
      try {
        onRejected?.();
      } catch {
        destroyClient();
      }
      try {
        if (client.headersSent || client.writableEnded || client.destroyed) {
          destroyClient();
        } else {
          // A failed writeHead may have staged some headers before throwing.
          for (const name of client.getHeaderNames()) client.removeHeader(name);
          client.writeHead(502, { 'Content-Type': 'text/plain', Connection: 'close' });
          client.end('Invalid upstream response.');
        }
      } catch {
        destroyClient();
      }
    };

    if (!isValidUpstreamStatus(upstream.statusCode)) {
      reject();
      return;
    }
    try {
      forward(upstream);
    } catch {
      reject();
    }
  };
}

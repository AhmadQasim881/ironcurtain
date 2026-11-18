import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const USERNAME = 'ironcurtain';
const TOKEN_BYTES = 32;

/** Per-bundle credential used only on Docker Desktop's host-gateway TCP hop. */
export interface ProxyAuthorization {
  readonly header: string;
}

export function createProxyAuthorization(): ProxyAuthorization {
  const password = randomBytes(TOKEN_BYTES).toString('base64url');
  return { header: `Basic ${Buffer.from(`${USERNAME}:${password}`, 'utf8').toString('base64')}` };
}

/** Standard proxy userinfo, with a separate optional metrics correlation token. */
export function proxyAuthorizedUrl(
  baseUrl: string,
  authorization: ProxyAuthorization,
  correlationToken?: string,
): string {
  const credentials = basicCredentials(authorization.header);
  if (!credentials || credentials.username !== USERNAME || !/^[A-Za-z0-9_-]{43}$/.test(credentials.password)) {
    throw new Error('Invalid per-bundle proxy authorization');
  }
  if (correlationToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(correlationToken)) {
    throw new Error('Invalid proxy correlation token');
  }
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:') throw new Error('Transport proxy URL must use http:');
  url.username = USERNAME;
  url.password = credentials.password + (correlationToken === undefined ? '' : `.${correlationToken}`);
  return url.toString().replace(/\/$/, '');
}

function basicCredentials(header: string): { username: string; password: string } | undefined {
  if (!header.startsWith('Basic ') || header.length > 256) return undefined;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? undefined : { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** Validate and consume the hop credential before downstream policy sees headers. */
export function consumeProxyAuthorization(request: IncomingMessage, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  const actual = request.headers['proxy-authorization'];
  if (typeof actual !== 'string') return false;
  const credentials = basicCredentials(actual);
  const composite = credentials?.password.match(/^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/);
  const candidate =
    composite && credentials?.username === USERNAME
      ? `Basic ${Buffer.from(`${USERNAME}:${composite[1]}`, 'utf8').toString('base64')}`
      : actual;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(candidate, 'utf8');
  const accepted = expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
  if (accepted) {
    delete request.headers['proxy-authorization'];
    for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
      if (request.rawHeaders[index]?.toLowerCase() === 'proxy-authorization') {
        request.rawHeaders.splice(index, 2);
      }
    }
    if (composite) {
      // Preserve only correlation metadata after authenticating the hop.
      const metricsHeader = `Basic ${Buffer.from(`${USERNAME}:${composite[2]}`, 'utf8').toString('base64')}`;
      request.headers['proxy-authorization'] = metricsHeader;
      request.rawHeaders.push('Proxy-Authorization', metricsHeader);
    }
  }
  return accepted;
}

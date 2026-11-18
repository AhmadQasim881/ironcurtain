import type { TlsOptions } from 'node:tls';
import { createLeafSecureContextCache, prepareLeafIssuance, type CertificateAuthority } from './ca.js';

export const TCP_TRANSPORT_SERVER_NAME = 'host.docker.internal';

/** Host-only TLS key material; the sidecar receives only the public issuer. */
export async function createTcpTransportTlsOptions(ca: CertificateAuthority): Promise<TlsOptions> {
  await prepareLeafIssuance(ca);
  const contextForHost = createLeafSecureContextCache(ca);
  contextForHost(TCP_TRANSPORT_SERVER_NAME);
  return {
    minVersion: 'TLSv1.2',
    handshakeTimeout: 5_000,
    SNICallback(servername, callback) {
      if (servername !== TCP_TRANSPORT_SERVER_NAME) {
        callback(new Error('Unexpected TCP transport server name'));
        return;
      }
      try {
        callback(null, contextForHost(TCP_TRANSPORT_SERVER_NAME));
      } catch {
        callback(new Error('TCP transport certificate is unavailable'));
      }
    },
  };
}

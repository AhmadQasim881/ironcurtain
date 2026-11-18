/** Keep every TCP transport listener on its own bundle's internal interface. */
import { isIPv4 } from 'node:net';
import { resolve } from 'node:path';
import { ironCurtainInternalSubnetHostAddress } from './docker-resource-lifecycle.js';
import type { ContainerRuntime, DockerMount } from './types.js';

export const TCP_TRANSPORT_HOST_CA_PATH = '/etc/ironcurtain-host-ca.pem';

/** Only the public issuer is shared; private host TLS keys remain on the host. */
export function tcpTransportHostCaMount(orientationDirectory: string): DockerMount {
  return { source: resolve(orientationDirectory, 'ca-cert.pem'), target: TCP_TRANSPORT_HOST_CA_PATH, readonly: true };
}

/** Encrypt credentials on the host-facing bridge and require the exact host identity. */
export function tcpTransportUpstreamEndpoint(port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid TCP transport upstream port');
  return `OPENSSL:host.docker.internal:${port},verify=1,cafile=${TCP_TRANSPORT_HOST_CA_PATH},commonname=host.docker.internal,snihost=host.docker.internal`;
}

/** The first container endpoint after the allocator's .1 gateway. */
export function tcpTransportSidecarAddress(subnet: string): string {
  return ironCurtainInternalSubnetHostAddress(subnet, 2);
}

/** A socat listener must never fall back to all interfaces. */
export function tcpTransportListenEndpoint(address: string, port: number, subnet: string): string {
  if (
    !isIPv4(address) ||
    tcpTransportSidecarAddress(subnet) !== address ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('TCP transport listener requires its exact internal IPv4 address and port');
  }
  return `TCP-LISTEN:${port},bind=${address},range=${subnet},fork,reuseaddr`;
}

/**
 * Create callers use the internal network and its planned static address.
 * Attach the host-facing bridge while stopped, then verify the runtime's
 * assignment before any agent can start. No listener is ever on that bridge.
 */
export async function startTcpTransportSidecar(
  runtime: Pick<ContainerRuntime, 'connectNetwork' | 'start' | 'getContainerIp'>,
  containerId: string,
  networkName: string,
  address: string,
  subnet: string,
): Promise<void> {
  tcpTransportListenEndpoint(address, 1, subnet);
  await runtime.connectNetwork('bridge', containerId);
  await runtime.start(containerId);
  if ((await runtime.getContainerIp(containerId, networkName)) !== address) {
    throw new Error('TCP transport sidecar did not receive its planned internal IPv4 address');
  }
}

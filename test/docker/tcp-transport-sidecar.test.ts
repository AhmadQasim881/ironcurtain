import { describe, expect, it, vi } from 'vitest';
import {
  tcpTransportSidecarAddress,
  tcpTransportListenEndpoint,
  startTcpTransportSidecar,
  tcpTransportUpstreamEndpoint,
} from '../../src/docker/tcp-transport-sidecar.js';

describe('private TCP transport sidecar', () => {
  it('requires issuer, peer-name and SNI verification on every host-facing TLS hop', () => {
    expect(tcpTransportUpstreamEndpoint(31080)).toBe(
      'OPENSSL:host.docker.internal:31080,verify=1,cafile=/etc/ironcurtain-host-ca.pem,commonname=host.docker.internal,snihost=host.docker.internal',
    );
    expect(() => tcpTransportUpstreamEndpoint(0)).toThrow();
  });
  it('binds its reserved address and admits only the internal peer subnet', () => {
    expect(tcpTransportSidecarAddress('172.24.0.8/29')).toBe('172.24.0.10');
    expect(tcpTransportListenEndpoint('172.24.0.10', 31080, '172.24.0.8/29')).toBe(
      'TCP-LISTEN:31080,bind=172.24.0.10,range=172.24.0.8/29,fork,reuseaddr',
    );
    expect(() => tcpTransportListenEndpoint('0.0.0.0', 31080, '172.24.0.8/29')).toThrow();
    expect(() => tcpTransportListenEndpoint('172.24.0.11', 31080, '172.24.0.8/29')).toThrow();
    expect(() => tcpTransportListenEndpoint('172.24.0.10', 0, '172.24.0.8/29')).toThrow();
    expect(() => tcpTransportSidecarAddress('172.24.0.0/24')).toThrow();
  });

  it('attaches the bridge while stopped and refuses an incorrect runtime IP assignment', async () => {
    const events: string[] = [];
    const runtime = {
      connectNetwork: vi.fn(async (network: string) => {
        events.push(`connect:${network}`);
      }),
      start: vi.fn(async () => {
        events.push('start');
      }),
      getContainerIp: vi.fn(async () => {
        events.push('inspect');
        return '172.24.0.10';
      }),
    };
    await startTcpTransportSidecar(runtime, 'sidecar', 'private', '172.24.0.10', '172.24.0.8/29');
    expect(events).toEqual(['connect:bridge', 'start', 'inspect']);
    runtime.getContainerIp.mockResolvedValueOnce('172.24.0.11');
    await expect(
      startTcpTransportSidecar(runtime, 'sidecar', 'private', '172.24.0.10', '172.24.0.8/29'),
    ).rejects.toThrow('planned internal');
    runtime.connectNetwork.mockRejectedValueOnce(new Error('attachment failed'));
    const previousStarts = runtime.start.mock.calls.length;
    await expect(
      startTcpTransportSidecar(runtime, 'sidecar', 'private', '172.24.0.10', '172.24.0.8/29'),
    ).rejects.toThrow('attachment failed');
    expect(runtime.start).toHaveBeenCalledTimes(previousStarts);
  });
});

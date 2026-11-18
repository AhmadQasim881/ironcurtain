/**
 * Where the macOS (TCP topology) MITM proxy listens, and who may connect.
 *
 * Docker Desktop delivers `host.docker.internal` traffic to the host as
 * loopback, so the tcp-sidecar MITM binds 127.0.0.1 like the Code Mode proxy
 * and the nested egress listeners on the same hop. It used to bind 0.0.0.0
 * with no source guard, which handed every LAN peer the session's proxy.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces, tmpdir } from 'node:os';
import { allowDockerDesktopRelaySource, resolveMitmTcpBind } from '../../src/docker/docker-infrastructure.js';
import { makeSourceAddressGuard } from '../../src/docker/network-topology.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import { loadOrCreateCA } from '../../src/docker/ca.js';

const HEALTH_URL = 'http://ironcurtain.invalid/__ironcurtain/health';

function request(
  options: http.RequestOptions,
  body?: string,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A non-loopback IPv4 address of this host, if it has one (none inside a network namespace). */
function externalIpv4Address(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

describe('resolveMitmTcpBind', () => {
  it('binds the tcp-sidecar MITM to loopback, guarded to loopback sources', () => {
    const bind = resolveMitmTcpBind('tcp-sidecar', undefined);
    expect(bind.listenHost).toBe('127.0.0.1');
    expect(bind.allowRemoteAddress).toBe(allowDockerDesktopRelaySource);
  });

  it('keeps the wildcard bind only for tcp-hostonly, and only with the subnet guard', () => {
    const subnetGuard = makeSourceAddressGuard('192.168.201.0/24');
    const bind = resolveMitmTcpBind('tcp-hostonly', subnetGuard);
    expect(bind).toEqual({ listenHost: '0.0.0.0', allowRemoteAddress: subnetGuard });
    expect(() => resolveMitmTcpBind('tcp-hostonly', undefined)).toThrow(/connection-source guard/u);
  });

  it('admits only loopback sources on the Docker Desktop hop', () => {
    for (const source of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(allowDockerDesktopRelaySource(source), source).toBe(true);
    }
    for (const source of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', '172.17.0.2', undefined]) {
      expect(allowDockerDesktopRelaySource(source), String(source)).toBe(false);
    }
  });
});

describe('tcp-sidecar MITM listener', () => {
  let tmpDir: string | undefined;
  let proxy: MitmProxy | undefined;

  afterEach(async () => {
    await proxy?.stop();
    proxy = undefined;
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  async function startSidecarMitm(): Promise<Awaited<ReturnType<MitmProxy['start']>>> {
    tmpDir = mkdtempSync(join(tmpdir(), 'mitm-tcp-bind-'));
    const bind = resolveMitmTcpBind('tcp-sidecar', undefined);
    proxy = createMitmProxy({
      listenPort: 0,
      listenHost: bind.listenHost,
      allowRemoteAddress: bind.allowRemoteAddress,
      controlPort: 0,
      ca: loadOrCreateCA(join(tmpDir, 'ca')),
      providers: [],
    });
    return proxy.start();
  }

  it('listens on 127.0.0.1 and serves the sidecar health probe over loopback', async () => {
    const address = await startSidecarMitm();
    expect(address.host).toBe('127.0.0.1');
    if (address.port === undefined) throw new Error('expected a TCP port');

    const probe = await request({ host: '127.0.0.1', port: address.port, method: 'GET', path: HEALTH_URL });
    expect(probe).toEqual({ status: 200, body: 'IRONCURTAIN_OK/1\n' });
  });

  it('is not reachable through a non-loopback interface address', async (context) => {
    const external = externalIpv4Address();
    if (external === undefined) {
      context.skip();
      return;
    }
    const address = await startSidecarMitm();
    const outcome = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: external, port: address.port ?? 0 });
      socket.once('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
    });
    expect(outcome).toBe('ECONNREFUSED');
  });

  it('serves its control API on 127.0.0.1 only to holders of the per-bundle token', async () => {
    const address = await startSidecarMitm();
    if (address.controlPort === undefined || address.controlToken === undefined) {
      throw new Error('expected a TCP control endpoint with a token');
    }
    const add = (authorization?: string): Promise<{ readonly status: number; readonly body: string }> =>
      request(
        {
          host: '127.0.0.1',
          port: address.controlPort,
          method: 'POST',
          path: '/__ironcurtain/domains/add',
          headers: {
            'Content-Type': 'application/json',
            ...(authorization === undefined ? {} : { Authorization: authorization }),
          },
        },
        JSON.stringify({ domain: 'api.example.com' }),
      );

    // Any local process (or Desktop container) can reach the port; only the
    // token holder can change the allowlist.
    expect((await add()).status).toBe(401);
    expect((await add('Bearer guessed')).status).toBe(401);
    expect(proxy?.hosts.listHosts().dynamic).toEqual([]);

    expect(await add(`Bearer ${address.controlToken}`)).toEqual({ status: 200, body: '{"added":true}' });
    expect(proxy?.hosts.listHosts().dynamic).toEqual(['api.example.com:443']);
  });
});

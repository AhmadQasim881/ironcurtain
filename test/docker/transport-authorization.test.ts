import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { buildCreateArgs, createDockerManager, type ExecFileFn } from '../../src/docker/docker-manager.js';
import type { DockerContainerConfig } from '../../src/docker/types.js';
import {
  createProxyAuthorization,
  consumeProxyAuthorization,
  proxyAuthorizedUrl,
} from '../../src/docker/proxy-authorization.js';
import { parseMetricsProxyAuthorization } from '../../src/llm-metrics/attribution-registry.js';
import { renderAptProxyConfig, stageAptProxyConfig } from '../../src/docker/runtime-trust.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import { loadOrCreateCA } from '../../src/docker/ca.js';
import { writeAptProxyConfigViaExec } from '../../src/docker/docker-infrastructure.js';
import { createTcpTransportTlsOptions, TCP_TRANSPORT_SERVER_NAME } from '../../src/docker/tcp-transport-tls.js';

const password = 'a'.repeat(43);
const correlation = 'b'.repeat(43);
const authorization = { header: `Basic ${Buffer.from(`ironcurtain:${password}`).toString('base64')}` };
const directories: string[] = [];
const proxies: MitmProxy[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ironcurtain-transport-auth-'));
  directories.push(directory);
  return directory;
}

function authRequest(header: string): IncomingMessage {
  return { headers: { 'proxy-authorization': header }, rawHeaders: ['Proxy-Authorization', header] } as IncomingMessage;
}

async function startTlsProxy() {
  const ca = loadOrCreateCA(join(temporaryDirectory(), 'ca'));
  const proxy = createMitmProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    ca,
    providers: [],
    transportTls: await createTcpTransportTlsOptions(ca),
    requiredProxyAuthorization: authorization.header,
  });
  proxies.push(proxy);
  const address = await proxy.start();
  return { ca, port: address.port! };
}

function tlsHealth(port: number, ca: string, servername = TCP_TRANSPORT_SERVER_NAME, header?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        ca,
        servername,
        path: 'http://ironcurtain.invalid/__ironcurtain/health',
        headers: header ? { 'Proxy-Authorization': header } : {},
        agent: false,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      },
    );
    req.setTimeout(3_000, () => req.destroy(new Error('Local TLS fixture deadline exceeded')));
    req.on('error', reject);
    req.end();
  });
}

describe('per-bundle transport authorization', () => {
  it('writes authenticated apt configuration through a private exec environment', async () => {
    let invocation: Parameters<ExecFileFn> | undefined;
    const runtime = createDockerManager(async (...args) => {
      invocation = args;
      return { stdout: '', stderr: '' };
    });
    await writeAptProxyConfigViaExec(runtime, 'fixture', proxyAuthorizedUrl('http://127.0.0.1:18080', authorization));
    expect(invocation?.[1]).toEqual(expect.arrayContaining(['--env', 'IRONCURTAIN_APT_PROXY_CONFIG']));
    expect(invocation?.[1].join(' ')).not.toContain(password);
    expect(invocation?.[2]?.env?.IRONCURTAIN_APT_PROXY_CONFIG).toContain(password);
  });
  it('accepts the expected TLS issuer and SNI while retaining proxy admission', async () => {
    const { ca, port } = await startTlsProxy();
    expect(await tlsHealth(port, ca.certPem, TCP_TRANSPORT_SERVER_NAME, authorization.header)).toBe(200);
    expect(await tlsHealth(port, ca.certPem)).toBe(407);
  });

  it('rejects an unrelated TLS issuer before HTTP admission', async () => {
    const { port } = await startTlsProxy();
    const unrelated = loadOrCreateCA(join(temporaryDirectory(), 'unrelated-ca'));
    await expect(
      tlsHealth(port, unrelated.certPem, TCP_TRANSPORT_SERVER_NAME, authorization.header),
    ).rejects.toMatchObject({ code: expect.stringMatching(/CERT|SIGNATURE|UNABLE_TO_VERIFY|SELF_SIGNED/u) });
  });

  it('rejects an unexpected TLS SNI before HTTP admission', async () => {
    const { ca, port } = await startTlsProxy();
    await expect(tlsHealth(port, ca.certPem, 'other.example.invalid', authorization.header)).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:ECONNRESET|EPROTO|ERR_TLS_CERT_ALTNAME_INVALID|ERR_SSL_.*)$/u),
    });
  });

  it('keeps transport admission distinct from metrics correlation', () => {
    const url = new URL(proxyAuthorizedUrl('http://127.0.0.1:18080', authorization, correlation));
    const header = `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`;
    const message = authRequest(header);
    expect(consumeProxyAuthorization(message, authorization.header)).toBe(true);
    expect(parseMetricsProxyAuthorization(message.headers['proxy-authorization'])).toBe(correlation);
    expect(message.rawHeaders).not.toContain(header);
    expect(consumeProxyAuthorization(authRequest(header), createProxyAuthorization().header)).toBe(false);
    expect(
      consumeProxyAuthorization(
        authRequest(`Basic ${Buffer.from(`ironcurtain:${correlation}`).toString('base64')}`),
        authorization.header,
      ),
    ).toBe(false);
  });

  it('consumes an exact hop credential without forwarding it', () => {
    const message = authRequest(authorization.header);
    expect(consumeProxyAuthorization(message, authorization.header)).toBe(true);
    expect(message.headers['proxy-authorization']).toBeUndefined();
    expect(message.rawHeaders).toEqual([]);
  });

  it('writes only validated bundle credentials to private apt configuration', () => {
    const path = join(temporaryDirectory(), 'apt.conf');
    const url = proxyAuthorizedUrl('http://127.0.0.1:18080', authorization);
    expect(renderAptProxyConfig(url)).toContain(`Proxy "${url}"`);
    stageAptProxyConfig(path, url);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => renderAptProxyConfig('http://other:ordinary@127.0.0.1:18080')).toThrow(/fixed http/u);
  });

  it('passes private container values through the CLI environment instead of argv', async () => {
    const privateEnv = {
      IRONCURTAIN_MCP_TCP_TOKEN: 'c'.repeat(64),
      HTTPS_PROXY: proxyAuthorizedUrl('http://127.0.0.1:18080', authorization),
    };
    const config: DockerContainerConfig = {
      image: 'fixture',
      name: 'fixture',
      mounts: [],
      network: 'none',
      env: { PUBLIC: 'ordinary' },
      command: ['true'],
      privateEnv,
    };
    let invocation: Parameters<ExecFileFn> | undefined;
    const runtime = createDockerManager(async (...args) => {
      invocation = args;
      return { stdout: 'fixture-id\n', stderr: '' };
    });
    await expect(runtime.create(config)).resolves.toBe('fixture-id');
    expect(invocation?.[1]).toEqual(
      expect.arrayContaining(['--env', 'IRONCURTAIN_MCP_TCP_TOKEN', '--env', 'HTTPS_PROXY']),
    );
    expect(invocation?.[1].join(' ')).not.toContain(password);
    expect(invocation?.[1].join(' ')).not.toContain('c'.repeat(64));
    expect(invocation?.[2]?.env).toMatchObject(privateEnv);
    expect(() => buildCreateArgs({ ...config, env: { HTTPS_PROXY: 'duplicate' } })).toThrow(/distinct/u);
    expect(() => buildCreateArgs({ ...config, privateEnv: { 'invalid-name': 'ordinary' } })).toThrow(
      /environment variable name/u,
    );
  });

  it('requires admission on health, CONNECT and upgrade while accepting a complete metrics lease', async () => {
    const proxy = createMitmProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      ca: loadOrCreateCA(join(temporaryDirectory(), 'ca')),
      providers: [],
      requiredProxyAuthorization: authorization.header,
    });
    proxies.push(proxy);
    const address = await proxy.start();
    const port = address.port!;
    const health = (header?: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: 'http://ironcurtain.invalid/__ironcurtain/health',
            headers: header ? { 'Proxy-Authorization': header } : {},
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode!));
          },
        );
        req.on('error', reject);
        req.end();
      });
    expect(await health()).toBe(407);
    expect(await health(authorization.header)).toBe(200);
    for (const line of [
      'CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid\r\n\r\n',
      'GET http://example.invalid/ HTTP/1.1\r\nHost: example.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    ]) {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => socket.write(line));
        let text = '';
        socket.on('data', (chunk) => {
          text += chunk.toString();
        });
        socket.on('error', reject);
        socket.on('end', () => resolve(text));
      });
      expect(response).toMatch(/^HTTP\/1\.1 407/u);
    }
    const lease = proxy.beginMetricsInvocation(`http://127.0.0.1:${port}`, { sessionId: 'ordinary-session' });
    const url = new URL(lease.proxyUrl);
    expect(await health(`Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`)).toBe(200);
    await lease.end();
  });
});

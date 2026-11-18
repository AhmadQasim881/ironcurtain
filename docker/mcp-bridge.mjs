/** TCP-only stdio bridge. Credentials travel in the stream, never in argv. */
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
export const MCP_TCP_TOKEN_ENV = 'IRONCURTAIN_MCP_TCP_TOKEN';
export const MCP_TCP_AUTH_PREFIX = 'IRONCURTAIN_AUTH/1 ';
const HEALTH_REQUEST = 'IRONCURTAIN_HEALTH/1\n';
const HEALTH_RESPONSE = 'IRONCURTAIN_OK/1\n';
const TOKEN = /^[a-f0-9]{64}$/u;

export function parseTcpAddress(address) {
  const match = typeof address === 'string' && /^(?:([a-zA-Z0-9.-]+)|\[([a-fA-F0-9:]+)\]):([0-9]{1,5})$/u.exec(address);
  const port = match ? Number(match[3]) : 0;
  if (!match || port < 1 || port > 65535) throw new Error('MCP TCP bridge requires a host and valid port');
  return { host: match[1] ?? match[2], port };
}

export async function runMcpTcpBridge({
  address,
  health = false,
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
  connect = createConnection,
  timeoutMs = 5000,
}) {
  const endpoint = parseTcpAddress(address);
  const token = environment[MCP_TCP_TOKEN_ENV] || undefined;
  if (token !== undefined && !TOKEN.test(token)) throw new Error('MCP TCP bridge credential is invalid');
  input.pause();
  const socket = connect(endpoint);
  await new Promise((resolvePromise, reject) => {
    let connected = false;
    let settled = false;
    let response = '';
    const timer = setTimeout(() => fail(), timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      input.unpipe(socket);
      socket.unpipe(output);
      input.pause();
      input.off('error', fail);
      output.off('error', fail);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new Error('MCP TCP bridge connection failed'));
    };
    socket.once('error', fail);
    input.once('error', fail);
    output.once('error', fail);
    socket.once('close', () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!connected || (health && response !== HEALTH_RESPONSE)) reject(new Error('MCP TCP bridge connection failed'));
      else resolvePromise();
    });
    socket.once('connect', () => {
      connected = true;
      if (token !== undefined) socket.write(`${MCP_TCP_AUTH_PREFIX}${token}\n`);
      if (health) {
        socket.on('data', (chunk) => {
          if (response.length + chunk.length > HEALTH_RESPONSE.length) return fail();
          response += chunk.toString('utf8');
          if (!HEALTH_RESPONSE.startsWith(response)) fail();
          else if (response === HEALTH_RESPONSE) output.write(HEALTH_RESPONSE);
        });
        socket.write(HEALTH_REQUEST);
      } else {
        clearTimeout(timer);
        socket.pipe(output, { end: false });
        input.pipe(socket);
      }
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const health = args[0] === '--health';
  if (args.length !== (health ? 2 : 1)) {
    process.stderr.write('Usage: ironcurtain-mcp-bridge [--health] host:port\n');
    process.exitCode = 1;
  } else {
    try {
      await runMcpTcpBridge({ address: args[health ? 1 : 0], health });
    } catch {
      process.stderr.write('MCP TCP bridge connection failed\n');
      process.exitCode = 1;
    }
  }
}

/** Explicit network/image build command; all source and runtime inputs are pinned. */
import { createHash } from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { fetch, AbortSignal } = globalThis;

const recipe = dirname(fileURLToPath(import.meta.url));
const commit = '74253a3a41c2cade40fd4a53cf3fb7a3fdf305dc';
const tag = 'ironcurtain-signal-bridge:0.101-auth1';
const args = process.argv.slice(2);
if (args.length > 1 || (args[0] !== undefined && !args[0].startsWith('--source-dir='))) {
  throw new Error('Usage: npm run build:signal-bridge -- [--source-dir=/verified/source]');
}
const manifest = (await readFile(join(recipe, 'upstream.sha256'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9_./-]+)$/.exec(line);
    if (match === null || match[2].startsWith('/') || match[2].split('/').includes('..'))
      throw new Error('Invalid source manifest');
    return { hash: match[1], path: match[2] };
  });
if (manifest.length !== 35 || new Set(manifest.map((entry) => entry.path)).size !== 35)
  throw new Error('Unexpected source manifest');
let temporary;
try {
  const supplied = args[0]?.slice('--source-dir='.length);
  const source = supplied
    ? await realpath(resolve(supplied))
    : (temporary = await mkdtemp(join(tmpdir(), 'ironcurtain-signal-source-')));
  if (!supplied) {
    for (const entry of manifest) {
      const response = await fetch(
        `https://raw.githubusercontent.com/bbernhard/signal-cli-rest-api/${commit}/${entry.path}`,
        { redirect: 'error', signal: AbortSignal.timeout(60_000) },
      );
      if (!response.ok || response.body === null) throw new Error(`Could not fetch pinned source: ${entry.path}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('Pinned source file exceeds size limit');
        chunks.push(Buffer.from(chunk));
      }
      const data = Buffer.concat(chunks);
      if (createHash('sha256').update(data).digest('hex') !== entry.hash)
        throw new Error(`Pinned source checksum mismatch: ${entry.path}`);
      const target = join(source, entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { flag: 'wx', mode: 0o600 });
    }
  }
  const files = [];
  async function walk(directory, prefix = '') {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const stat = await lstat(path);
      const relative = prefix + name;
      if (stat.isDirectory()) await walk(path, relative + '/');
      else if (stat.isFile()) files.push(relative);
      else throw new Error('Source context must contain only regular files and directories');
    }
  }
  await walk(source);
  if (files.length !== manifest.length) throw new Error('Source context contains unexpected files');
  for (const entry of manifest) {
    const stat = await lstat(join(source, entry.path));
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid pinned source file');
    if (
      createHash('sha256')
        .update(await readFile(join(source, entry.path)))
        .digest('hex') !== entry.hash
    )
      throw new Error(`Pinned source checksum mismatch: ${entry.path}`);
  }
  const env = {};
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TERM',
    'DOCKER_CONFIG',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'BUILDKIT_PROGRESS',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  await new Promise((done, fail) => {
    const child = spawn(
      'docker',
      [
        'build',
        '--build-context',
        `signal-source=${source}`,
        '--tag',
        tag,
        '--file',
        join(recipe, 'Dockerfile'),
        recipe,
      ],
      { stdio: 'inherit', env },
    );
    child.once('error', fail);
    child.once('exit', (code, signal) =>
      code === 0 ? done() : fail(new Error(`Signal image build failed (${signal ?? code})`)),
    );
  });
} finally {
  if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
}

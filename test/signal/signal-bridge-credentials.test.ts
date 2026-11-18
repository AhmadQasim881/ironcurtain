import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import forge from 'node-forge';
import { loadOrCreateSignalBridgeCredentials } from '../../src/signal/signal-bridge-credentials.js';

const DAY_MS = 24 * 60 * 60 * 1000;
interface Bundle {
  version: number;
  token: string;
  certPem: string;
  keyPem: string;
}

describe('Signal bridge credentials', () => {
  let home: string;
  let directory: string;
  let filePath: string;
  let template: Bundle;

  beforeAll(() => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'signal-credential-template-')));
    try {
      const generated = loadOrCreateSignalBridgeCredentials(fixture);
      template = JSON.parse(readFileSync(generated.filePath, 'utf8')) as Bundle;
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'signal-credential-test-')));
    directory = join(home, 'oauth', 'signal-bridge');
    filePath = join(directory, 'credentials.json');
    vi.stubEnv('IRONCURTAIN_HOME', home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function store(value: unknown = template): string {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const contents = JSON.stringify(value, null, 2) + '\n';
    writeFileSync(filePath, contents, { mode: 0o600 });
    return contents;
  }

  function rewriteCertificate(change: (certificate: forge.pki.Certificate) => void): Bundle {
    const certificate = forge.pki.certificateFromPem(template.certPem);
    change(certificate);
    certificate.sign(forge.pki.privateKeyFromPem(template.keyPem), forge.md.sha256.create());
    return { ...template, certPem: forge.pki.certificateToPem(certificate) };
  }

  it('creates one private bundle with the required pinned local server identity', () => {
    const credentials = loadOrCreateSignalBridgeCredentials();
    expect(credentials.filePath).toBe(filePath);
    expect(credentials.token).toMatch(/^[a-f0-9]{64}$/u);
    expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
    expect(lstatSync(filePath).mode & 0o7777).toBe(0o600);
    expect(lstatSync(filePath).nlink).toBe(1);
    const bytes = readFileSync(filePath);
    const stored = JSON.parse(bytes.toString('utf8')) as Bundle;
    expect(Object.keys(stored).sort()).toEqual(['certPem', 'keyPem', 'token', 'version']);
    expect(stored.version).toBe(1);
    expect(credentials).not.toHaveProperty('keyPem');
    expect(credentials.fingerprint).toBe(createHash('sha256').update(bytes).digest('hex'));
    const cert = new X509Certificate(credentials.certPem);
    expect(cert.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(cert.ca).toBe(false);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.checkHost('localhost', { subject: 'never' })).toBe('localhost');
    expect(cert.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
    expect(readdirSync(directory)).toEqual(['credentials.json']);
  });

  it('keeps a valid persisted bundle stable and hashes its exact bytes', () => {
    const original = store();
    const first = loadOrCreateSignalBridgeCredentials();
    expect(loadOrCreateSignalBridgeCredentials()).toEqual(first);
    expect(readFileSync(filePath, 'utf8')).toBe(original);
    const compact = JSON.stringify(template) + '\n';
    writeFileSync(filePath, compact);
    const next = loadOrCreateSignalBridgeCredentials();
    expect(next.token).toBe(first.token);
    expect(next.certPem).toBe(first.certPem);
    expect(next.fingerprint).not.toBe(first.fingerprint);
    expect(next.fingerprint).toBe(createHash('sha256').update(compact).digest('hex'));
    expect(readFileSync(filePath, 'utf8')).toBe(compact);
  });

  it.each([0o644, 0o640, 0o660, 0o400, 0o700])('refuses an existing file with mode %s', (mode) => {
    const original = store();
    chmodSync(filePath, mode);
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/mode 0600/u);
    expect(readFileSync(filePath, 'utf8')).toBe(original);
    expect(lstatSync(filePath).mode & 0o777).toBe(mode);
  });

  it.each([false, true])('refuses a final file symlink, including dangling=%s', (dangling) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(home, 'neutral.json');
    if (!dangling) writeFileSync(target, 'neutral fixture', { mode: 0o600 });
    symlinkSync(target, filePath);
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/single-link regular file/u);
    expect(lstatSync(filePath).isSymbolicLink()).toBe(true);
    expect(dangling ? !existsSync(target) : readFileSync(target, 'utf8') === 'neutral fixture').toBe(true);
  });

  it('refuses a hard-linked bundle without replacing either name', () => {
    const original = store();
    const alias = join(home, 'bundle-alias.json');
    linkSync(filePath, alias);
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/single-link regular file/u);
    expect(readFileSync(alias, 'utf8')).toBe(original);
    expect(lstatSync(filePath).ino).toBe(lstatSync(alias).ino);
  });

  it('refuses a bundle larger than its bounded reader limit', () => {
    store();
    writeFileSync(filePath, 'x'.repeat(32_769));
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/size limit/u);
    expect(lstatSync(filePath).size).toBe(32_769);
  });

  it.each([
    ['wrong version', () => ({ ...template, version: 2 })],
    ['unknown field', () => ({ ...template, ordinary: true })],
    ['short token', () => ({ ...template, token: 'a'.repeat(63) })],
    ['noncanonical token', () => ({ ...template, token: 'A'.repeat(64) })],
    ['missing private key', () => ({ version: 1, token: template.token, certPem: template.certPem })],
    ['nonobject', () => []],
    ['multiple certificates', () => ({ ...template, certPem: template.certPem + template.certPem })],
    ['multiple keys', () => ({ ...template, keyPem: template.keyPem + template.keyPem })],
  ] as const)('fails closed on %s', (_label, value) => {
    const original = store(value());
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/schema is invalid/u);
    expect(readFileSync(filePath, 'utf8')).toBe(original);
  });

  it('does not include corrupt credential content or parser causes in errors', () => {
    store();
    writeFileSync(filePath, `{"token":"${template.token}", invalid`);
    let failure: unknown;
    try {
      loadOrCreateSignalBridgeCredentials();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('JSON is invalid');
    expect(String(failure)).not.toContain(template.token);
    expect(failure).not.toHaveProperty('cause');
  });

  it.each(['"version"', '"\\u0076ersion"'])('refuses duplicate decoded member names %s', (name) => {
    store();
    const contents = `{${name}:1,${JSON.stringify(template).slice(1)}`;
    writeFileSync(filePath, contents);
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/schema is invalid/u);
    expect(readFileSync(filePath, 'utf8')).toBe(contents);
  });

  it('refuses mismatched private keys', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const original = store({
      ...template,
      keyPem: other.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    });
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/certificate or private key is invalid/u);
    expect(readFileSync(filePath, 'utf8')).toBe(original);
  });

  it('verifies the self-signature', () => {
    const cert = forge.pki.certificateFromPem(template.certPem);
    const signature: unknown = cert.signature;
    if (typeof signature !== 'string') throw new Error('fixture signature missing');
    cert.signature = String.fromCharCode(signature.charCodeAt(0) ^ 1) + signature.slice(1);
    store({ ...template, certPem: forge.pki.certificateToPem(cert) });
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/certificate or private key is invalid/u);
  });

  it.each(['dns', 'ip', 'server-auth', 'leaf', 'digital-signature'] as const)(
    'requires the complete local server profile: %s',
    (missing) => {
      store(
        rewriteCertificate((cert) => {
          cert.setExtensions([
            { name: 'basicConstraints', cA: missing === 'leaf' },
            { name: 'keyUsage', digitalSignature: missing !== 'digital-signature', keyEncipherment: true },
            ...(missing === 'server-auth' ? [] : [{ name: 'extKeyUsage', serverAuth: true }]),
            {
              name: 'subjectAltName',
              altNames: [
                ...(missing === 'dns' ? [] : [{ type: 2, value: 'localhost' }]),
                ...(missing === 'ip' ? [] : [{ type: 7, ip: '127.0.0.1' }]),
              ],
            },
          ]);
        }),
      );
      expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/certificate or private key is invalid/u);
    },
  );

  it('refuses a not-yet-valid certificate rather than treating corruption as renewal', () => {
    const original = store(
      rewriteCertificate((cert) => {
        cert.validity.notBefore = new Date(Date.now() + DAY_MS);
        cert.validity.notAfter = new Date(Date.now() + 10 * DAY_MS);
      }),
    );
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/certificate or private key is invalid/u);
    expect(readFileSync(filePath, 'utf8')).toBe(original);
  });

  it.each([-DAY_MS, DAY_MS / 2])('atomically rotates a valid identity with %s ms remaining', (remaining) => {
    store(
      rewriteCertificate((cert) => {
        cert.validity.notBefore = new Date(Date.now() - 10 * DAY_MS);
        cert.validity.notAfter = new Date(Date.now() + remaining);
      }),
    );
    const previous = lstatSync(filePath);
    const credentials = loadOrCreateSignalBridgeCredentials();
    expect(credentials.token).not.toBe(template.token);
    expect(credentials.certPem).not.toBe(template.certPem);
    expect(lstatSync(filePath).ino).not.toBe(previous.ino);
    expect(lstatSync(filePath).mode & 0o777).toBe(0o600);
    expect(credentials.fingerprint).toBe(createHash('sha256').update(readFileSync(filePath)).digest('hex'));
    expect(loadOrCreateSignalBridgeCredentials()).toEqual(credentials);
  });

  it('retains an identity with exactly one day left', () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const original = store(
      rewriteCertificate((cert) => {
        cert.validity.notBefore = new Date(now - DAY_MS);
        cert.validity.notAfter = new Date(now + DAY_MS);
      }),
    );
    expect(loadOrCreateSignalBridgeCredentials().token).toBe(template.token);
    expect(readFileSync(filePath, 'utf8')).toBe(original);
  });

  it.each([0o755, 0o750, 0o770])('refuses a bridge directory with mode %s', (mode) => {
    store();
    chmodSync(directory, mode);
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow();
  });

  it('refuses a replaceable ancestor below the configured home', () => {
    mkdirSync(dirname(directory), { mode: 0o700 });
    chmodSync(dirname(directory), 0o777);
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/world-writable directory/u);
    expect(existsSync(directory)).toBe(false);
  });

  it('refuses a final directory symlink', () => {
    const target = join(home, 'ordinary');
    mkdirSync(target, { mode: 0o700 });
    mkdirSync(dirname(directory), { mode: 0o700 });
    symlinkSync(target, directory);
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/real directory/u);
    expect(readdirSync(target)).toEqual([]);
  });

  it('allows deliberate relocation of the configured home', () => {
    const target = join(home, 'relocated');
    const alias = join(home, 'home-link');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, alias);
    vi.stubEnv('IRONCURTAIN_HOME', alias);
    const credentials = loadOrCreateSignalBridgeCredentials();
    expect(credentials.filePath).toBe(join(target, 'oauth', 'signal-bridge', 'credentials.json'));
    vi.stubEnv('IRONCURTAIN_HOME', target);
    expect(loadOrCreateSignalBridgeCredentials()).toEqual(credentials);
  });

  it('refuses foreign ownership without adopting the directory', () => {
    const uid = process.geteuid?.();
    if (uid === undefined) throw new Error('fixture requires POSIX ownership');
    vi.spyOn(process, 'geteuid').mockReturnValue(uid + 1);
    expect(() => loadOrCreateSignalBridgeCredentials()).toThrow(/not owned by a trusted user/u);
    expect(existsSync(directory)).toBe(false);
  });

  it('supports a private explicit directory and refuses relative locations', () => {
    const selected = join(home, 'fixture');
    expect(loadOrCreateSignalBridgeCredentials(selected).filePath).toBe(join(selected, 'credentials.json'));
    expect(() => loadOrCreateSignalBridgeCredentials('relative')).toThrow(/absolute/u);
  });

  it('works with pinned HTTPS and refuses another issuer or server name', async () => {
    const credentials = loadOrCreateSignalBridgeCredentials();
    const stored = JSON.parse(readFileSync(credentials.filePath, 'utf8')) as Bundle;
    let requests = 0;
    const server = https.createServer({ cert: stored.certPem, key: stored.keyPem }, (_req, res) => {
      requests++;
      res.end('ordinary local fixture');
    });
    server.on('tlsClientError', () => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fixture listener missing');
    const request = (ca: string, servername = 'localhost'): Promise<string> =>
      new Promise((resolve, reject) => {
        const req = https.get({ hostname: '127.0.0.1', port: address.port, ca, servername, agent: false }, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () => resolve(body));
        });
        req.setTimeout(2_000, () => req.destroy(new Error('fixture deadline')));
        req.on('error', reject);
      });
    try {
      await expect(request(credentials.certPem)).resolves.toBe('ordinary local fixture');
      await expect(request(template.certPem)).rejects.toThrow();
      await expect(request(credentials.certPem, 'ordinary.invalid')).rejects.toThrow();
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

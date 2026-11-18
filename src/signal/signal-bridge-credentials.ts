/** Private, atomic credentials for the authenticated local Signal bridge. */
import { createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import forge from 'node-forge';
import { getIronCurtainHome, getOAuthDir } from '../config/paths.js';
import { assertTrustedDirectoryChain, readOwnedRegularFile } from '../hardened-fs.js';
import { writePrivateFileAtomicSync } from '../util/atomic-write.js';
import { withFileLockSync } from '../util/file-lock.js';

const LABEL = 'Signal bridge credentials';
const MAX_BUNDLE_BYTES = 32_768;
const DAY_MS = 24 * 60 * 60 * 1000;
const CERTIFICATE_VALIDITY_MS = 365 * DAY_MS;
const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';

interface CredentialBundle {
  readonly version: 1;
  readonly token: string;
  readonly certPem: string;
  readonly keyPem: string;
}

export interface SignalBridgeCredentials {
  readonly filePath: string;
  readonly token: string;
  readonly certPem: string;
  /** SHA-256 of the exact persisted JSON bytes, including whitespace. */
  readonly fingerprint: string;
}

/**
 * Load one private bundle, or create/renew it under its cross-process lock.
 * A corrupt or insecure existing bundle is refused rather than overwritten.
 * The optional directory is a trusted private-directory seam for tests.
 */
export function loadOrCreateSignalBridgeCredentials(directory?: string): SignalBridgeCredentials {
  const selected = directory ?? resolve(getOAuthDir(), 'signal-bridge');
  if (!isAbsolute(selected)) throw new Error(`${LABEL} directory must be absolute`);
  const root = directory === undefined ? getIronCurtainHome() : nearestExistingDirectory(selected);
  const canonicalDirectory = prepareDirectory(selected, root);
  const directoryIdentity = lstatSync(canonicalDirectory);
  const filePath = resolve(canonicalDirectory, 'credentials.json');

  return withFileLockSync(filePath, () => {
    assertPrivateDirectory(canonicalDirectory);
    if (!sameIdentity(directoryIdentity, lstatSync(canonicalDirectory))) {
      throw new Error(`${LABEL} directory changed while acquiring its lock`);
    }
    assertTrustedChain(canonicalDirectory, root);
    const existing = lstatIfPresent(filePath);
    if (existing !== undefined) {
      assertPrivateFile(existing);
      const bytes = readOwnedRegularFile(filePath, { label: LABEL, minBytes: 2, maxBytes: MAX_BUNDLE_BYTES });
      const after = lstatSync(filePath);
      assertPrivateFile(after);
      if (!sameIdentity(existing, after)) throw new Error(`${LABEL} file changed while being read`);
      const bundle = parseBundle(bytes);
      if (validateCertificate(bundle) >= DAY_MS) return result(filePath, bytes, bundle);
    }

    const replacement = generateBundle();
    const current = lstatIfPresent(filePath);
    if (existing === undefined ? current !== undefined : current === undefined || !sameIdentity(existing, current)) {
      throw new Error(`${LABEL} file changed before publication`);
    }
    if (current !== undefined) assertPrivateFile(current);
    assertPrivateDirectory(canonicalDirectory);
    assertTrustedChain(canonicalDirectory, root);
    const serialized = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);
    writePrivateFileAtomicSync(filePath, serialized);
    return result(filePath, serialized, replacement);
  });
}

function result(filePath: string, bytes: Buffer, bundle: CredentialBundle): SignalBridgeCredentials {
  return {
    filePath,
    token: bundle.token,
    certPem: bundle.certPem,
    fingerprint: createHash('sha256').update(bytes).digest('hex'),
  };
}

function parseBundle(bytes: Buffer): CredentialBundle {
  const text = bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Parser errors can quote credential bytes; keep them out of diagnostics.
    throw new Error(`${LABEL} JSON is invalid`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${LABEL} schema is invalid`);
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).length !== 4 ||
    memberNames(text).length !== 4 ||
    value.version !== 1 ||
    typeof value.token !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.token) ||
    typeof value.certPem !== 'string' ||
    typeof value.keyPem !== 'string' ||
    !singlePem(value.certPem, 'CERTIFICATE') ||
    !(singlePem(value.keyPem, 'RSA PRIVATE KEY') || singlePem(value.keyPem, 'PRIVATE KEY'))
  )
    throw new Error(`${LABEL} schema is invalid`);
  return { version: 1, token: value.token, certPem: value.certPem, keyPem: value.keyPem };
}

/** Count decoded JSON member names; JSON.parse alone discards duplicates. */
function memberNames(text: string): string[] {
  const names: string[] = [];
  let start = -1;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (start < 0) {
      if (character === '"') start = index;
    } else if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      let next = index + 1;
      while (next < text.length && /[ \t\r\n]/u.test(text[next])) next++;
      if (text[next] === ':') {
        const name: unknown = JSON.parse(text.slice(start, index + 1));
        if (typeof name === 'string') names.push(name);
      }
      start = -1;
    }
  }
  return names;
}

function singlePem(value: string, kind: string): boolean {
  const normalized = value.trim();
  const begin = `-----BEGIN ${kind}-----`;
  const end = `-----END ${kind}-----`;
  return normalized.startsWith(`${begin}\n`) || normalized.startsWith(`${begin}\r\n`)
    ? normalized.endsWith(end) && /^[A-Za-z0-9+/=\r\n]+$/u.test(normalized.slice(begin.length, -end.length))
    : false;
}

/** Returns remaining validity after checking the full stored identity. */
function validateCertificate(bundle: CredentialBundle): number {
  try {
    const certificate = new X509Certificate(bundle.certPem);
    const key = createPrivateKey(bundle.keyPem);
    const parsedCertificate = forge.pki.certificateFromPem(bundle.certPem);
    const constraints: unknown = parsedCertificate.getExtension('basicConstraints');
    const isCertificateAuthority =
      typeof constraints === 'object' && constraints !== null && 'cA' in constraints && constraints.cA === true;
    const keyUsage: unknown = parsedCertificate.getExtension('keyUsage');
    const permitsSignature =
      typeof keyUsage === 'object' &&
      keyUsage !== null &&
      'digitalSignature' in keyUsage &&
      keyUsage.digitalSignature === true;
    if (
      certificate.publicKey.asymmetricKeyType !== 'rsa' ||
      certificate.publicKey.asymmetricKeyDetails?.modulusLength !== 2048 ||
      !certificate.checkPrivateKey(key) ||
      certificate.subject !== certificate.issuer ||
      !certificate.verify(certificate.publicKey) ||
      certificate.ca ||
      isCertificateAuthority ||
      !permitsSignature ||
      !certificate.keyUsage.includes(SERVER_AUTH_OID) ||
      certificate.checkHost('localhost', { subject: 'never' }) !== 'localhost' ||
      certificate.checkIP('127.0.0.1') !== '127.0.0.1'
    )
      throw new Error('identity');
    const notBefore = Date.parse(certificate.validFrom);
    const notAfter = Date.parse(certificate.validTo);
    const now = Date.now();
    if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notBefore > now || notAfter <= notBefore) {
      throw new Error('validity');
    }
    return notAfter - now;
  } catch {
    throw new Error(`${LABEL} certificate or private key is invalid`);
  }
}

function generateBundle(): CredentialBundle {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  const serial = randomBytes(16);
  serial[0] = serial[0] & 0x7f || 1;
  certificate.serialNumber = serial.toString('hex');
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + CERTIFICATE_VALIDITY_MS);
  certificate.setSubject([{ name: 'commonName', value: 'localhost' }]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const bundle: CredentialBundle = {
    version: 1,
    token: randomBytes(32).toString('hex'),
    certPem: forge.pki.certificateToPem(certificate),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
  if (validateCertificate(bundle) < DAY_MS) throw new Error(`${LABEL} generated certificate is not valid`);
  return bundle;
}

function assertTrustedChain(directory: string, root: string): void {
  assertTrustedDirectoryChain(directory, { label: LABEL, root, rootDescription: 'the configured credential root' });
}

function nearestExistingDirectory(directory: string): string {
  let current = resolve(directory);
  while (lstatIfPresent(current) === undefined) current = dirname(current);
  return current;
}

function prepareDirectory(directory: string, root: string): string {
  const anchor = nearestExistingDirectory(root);
  const anchorStats = lstatSync(realpathSync(anchor));
  const uid = process.geteuid?.();
  if (uid === undefined || (anchorStats.uid !== uid && anchorStats.uid !== 0)) {
    throw new Error(`${LABEL} root is not owned by a trusted user`);
  }
  assertTrustedChain(anchor, anchor);
  const suffix = relative(anchor, directory);
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
    throw new Error(`${LABEL} directory escapes its root`);
  let current = anchor;
  for (const part of suffix.split(sep).filter(Boolean)) {
    assertTrustedChain(current, anchor);
    current = resolve(current, part);
    if (lstatIfPresent(current) === undefined) {
      try {
        mkdirSync(current, { mode: 0o700 });
        chmodSync(current, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (!lstatSync(current).isDirectory()) throw new Error(`${LABEL} path must be a real directory`);
    assertTrustedChain(current, anchor);
  }
  assertPrivateDirectory(directory);
  assertTrustedChain(directory, root);
  return realpathSync(directory);
}

function assertPrivateDirectory(path: string): void {
  const stats = lstatSync(path);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== process.geteuid?.() ||
    (stats.mode & 0o7777) !== 0o700
  ) {
    throw new Error(`${LABEL} directory must be a current-user-owned real directory with mode 0700`);
  }
}

function assertPrivateFile(stats: Stats): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== process.geteuid?.() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o7777) !== 0o600
  ) {
    throw new Error(`${LABEL} file must be a current-user-owned single-link regular file with mode 0600`);
  }
  if (stats.size > MAX_BUNDLE_BYTES) throw new Error(`${LABEL} file exceeds its size limit`);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

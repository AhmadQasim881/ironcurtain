import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRegistryPullProvenanceSink,
  registryPullProvenanceRecordSchema,
  REGISTRY_PULL_PROVENANCE_FILE,
} from '../../src/docker-workload/pull-provenance.js';
import type { RegistryPullProvenance } from '../../src/docker/registry-egress-proxy.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function evidenceDirectory(): string {
  const directory = join(realpathSync(mkdtempSync(join(tmpdir(), 'pull-provenance-'))), 'evidence');
  directories.push(join(directory, '..'));
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

const BINDING = { leaseId: 'dw-provenance', generation: 'gen-provenance', bundleId: 'bundle-provenance' } as const;
const MANIFEST_DIGEST = `sha256:${'a'.repeat(64)}`;
const BLOB_DIGEST = `sha256:${'b'.repeat(64)}`;

const TAG_RESOLUTION: RegistryPullProvenance = {
  originId: 'docker-hub',
  operation: 'manifest-pull',
  method: 'HEAD',
  destination: { hostname: 'registry-1.docker.io', port: 443 },
  status: 200,
  repository: 'library/alpine',
  reference: '3.20',
  resolvedDigest: MANIFEST_DIGEST,
  sizeBytes: 0,
};
/** Docker Hub serves blobs from an unlisted CDN after a followed redirect. */
const BLOB_PULL: RegistryPullProvenance = {
  originId: 'docker-hub:cdn',
  operation: 'blob-pull',
  method: 'GET',
  destination: { hostname: 'production.cloudflare.docker.com', port: 443 },
  status: 200,
  repository: 'library/alpine',
  reference: BLOB_DIGEST,
  requestedDigest: BLOB_DIGEST,
  resolvedDigest: BLOB_DIGEST,
  sizeBytes: 3_623_807,
};

function readRecords(path: string) {
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => registryPullProvenanceRecordSchema.parse(JSON.parse(line)));
}

describe('registry pull provenance log', () => {
  it('appends one lease-bound record per pull with the requested and registry-reported digests', () => {
    const path = join(evidenceDirectory(), REGISTRY_PULL_PROVENANCE_FILE);
    const sink = createRegistryPullProvenanceSink(path, BINDING);

    sink.append(TAG_RESOLUTION, new Date('2026-11-11T10:00:00.000Z'));
    sink.append(BLOB_PULL, new Date('2026-11-11T10:00:01.000Z'));

    expect(readRecords(path)).toEqual([
      {
        schemaVersion: 1,
        kind: 'registry-pull',
        at: '2026-11-11T10:00:00.000Z',
        ...BINDING,
        ...TAG_RESOLUTION,
      },
      {
        schemaVersion: 1,
        kind: 'registry-pull',
        at: '2026-11-11T10:00:01.000Z',
        ...BINDING,
        ...BLOB_PULL,
      },
    ]);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it('only ever appends: earlier evidence survives a new sink for the same lease', () => {
    const path = join(evidenceDirectory(), REGISTRY_PULL_PROVENANCE_FILE);
    createRegistryPullProvenanceSink(path, BINDING).append(TAG_RESOLUTION, new Date('2026-11-11T10:00:00.000Z'));
    createRegistryPullProvenanceSink(path, BINDING).append(BLOB_PULL, new Date('2026-11-11T10:00:01.000Z'));

    expect(readRecords(path).map((record) => record.kind === 'registry-pull' && record.operation)).toEqual([
      'manifest-pull',
      'blob-pull',
    ]);
  });

  it('bounds the log: one truncation marker, then later pulls are dropped', () => {
    const path = join(evidenceDirectory(), REGISTRY_PULL_PROVENANCE_FILE);
    const sink = createRegistryPullProvenanceSink(path, BINDING, 2048);

    for (let index = 0; index < 50; index += 1) sink.append(BLOB_PULL, new Date('2026-11-11T10:00:00.000Z'));

    const records = readRecords(path);
    expect(readFileSync(path).length).toBeLessThanOrEqual(2048);
    expect(records.at(-1)).toMatchObject({ kind: 'truncated', maxBytes: 2048, ...BINDING });
    expect(records.filter((record) => record.kind === 'truncated')).toHaveLength(1);
    expect(records.length).toBeLessThan(50);
  });

  it('refuses a symlinked log, a shared directory, and an invalid record without writing', () => {
    const directory = evidenceDirectory();
    const target = join(directory, 'elsewhere.jsonl');
    writeFileSync(target, '', { mode: 0o600 });
    const linked = join(directory, REGISTRY_PULL_PROVENANCE_FILE);
    symlinkSync(target, linked);
    expect(() => createRegistryPullProvenanceSink(linked, BINDING).append(BLOB_PULL, new Date())).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('');

    const shared = evidenceDirectory();
    chmodSync(shared, 0o755);
    expect(() =>
      createRegistryPullProvenanceSink(join(shared, REGISTRY_PULL_PROVENANCE_FILE), BINDING).append(
        BLOB_PULL,
        new Date(),
      ),
    ).toThrow(/owner-only real directory/u);

    const path = join(evidenceDirectory(), REGISTRY_PULL_PROVENANCE_FILE);
    const sink = createRegistryPullProvenanceSink(path, BINDING);
    expect(() => sink.append({ ...BLOB_PULL, resolvedDigest: 'md5:abc' }, new Date())).toThrow();
    expect(() => sink.append({ ...BLOB_PULL, status: 99 }, new Date())).toThrow();
    expect(() => sink.append({ ...BLOB_PULL, originId: 'docker-hub:other' }, new Date())).toThrow();
    expect(() => sink.append({ ...BLOB_PULL, destination: { hostname: 'cdn host', port: 443 } }, new Date())).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('records a refused pull with its status and a multi-hop CDN origin', () => {
    const path = join(evidenceDirectory(), REGISTRY_PULL_PROVENANCE_FILE);
    const sink = createRegistryPullProvenanceSink(path, BINDING);

    sink.append(
      { ...TAG_RESOLUTION, method: 'GET', status: 404, resolvedDigest: undefined, sizeBytes: 52 },
      new Date('2026-11-11T10:00:00.000Z'),
    );
    sink.append({ ...BLOB_PULL, originId: 'docker-hub:cdn:cdn' }, new Date('2026-11-11T10:00:01.000Z'));

    expect(readRecords(path)).toEqual([
      expect.objectContaining({ kind: 'registry-pull', status: 404, sizeBytes: 52 }),
      expect.objectContaining({ kind: 'registry-pull', originId: 'docker-hub:cdn:cdn', status: 200 }),
    ]);
    expect(readRecords(path)[0]).not.toHaveProperty('resolvedDigest');
  });
});

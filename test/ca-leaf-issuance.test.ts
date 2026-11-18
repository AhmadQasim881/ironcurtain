/**
 * Leaf issuance keeps RSA key generation off the request path (WP-44, MITM-7):
 * one key pair per CA generation per process, generated asynchronously by
 * `prepareLeafIssuance`, after which minting a leaf is a signature only.
 *
 * `node:crypto` is wrapped with call-through spies so the test can count key
 * generations; every function keeps its real behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLeafSecureContextCache, loadOrCreateCA, prepareLeafIssuance } from '../src/docker/ca.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    generateKeyPair: vi.fn(actual.generateKeyPair),
    generateKeyPairSync: vi.fn(actual.generateKeyPairSync),
  };
});

describe('leaf key generation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-leaf-issuance-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates the shared leaf key pair once, asynchronously, and never per host', async () => {
    const authority = loadOrCreateCA(join(tempDir, 'ca'));
    vi.mocked(crypto.generateKeyPair).mockClear();
    vi.mocked(crypto.generateKeyPairSync).mockClear();

    await Promise.all([prepareLeafIssuance(authority), prepareLeafIssuance(authority)]);
    expect(crypto.generateKeyPair).toHaveBeenCalledTimes(1);

    const firstProxy = createLeafSecureContextCache(authority);
    const secondProxy = createLeafSecureContextCache(authority);
    for (let i = 0; i < 20; i++) firstProxy(`host-${i}.issuance.example`);
    secondProxy('another.issuance.example');
    await prepareLeafIssuance(authority);

    expect(crypto.generateKeyPair).toHaveBeenCalledTimes(1);
    expect(crypto.generateKeyPairSync).not.toHaveBeenCalled();
  });

  it('falls back to one synchronous generation when issuance was never prepared', () => {
    const authority = loadOrCreateCA(join(tempDir, 'unprepared-ca'));
    vi.mocked(crypto.generateKeyPair).mockClear();
    vi.mocked(crypto.generateKeyPairSync).mockClear();

    const cache = createLeafSecureContextCache(authority);
    cache('one.unprepared.example');
    cache('two.unprepared.example');

    expect(crypto.generateKeyPairSync).toHaveBeenCalledTimes(1);
    expect(crypto.generateKeyPair).not.toHaveBeenCalled();
  });
});

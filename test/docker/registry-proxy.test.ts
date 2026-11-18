import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import {
  parseNpmUrl,
  parseNpmPackageRequest,
  npmMetadataPath,
  npmTarballPath,
  parsePypiSimpleUrl,
  parsePypiTarballUrl,
  extractPypiPackageFromFilename,
  extractDebianPackageFromFilename,
  parseDebianPackageUrl,
  classifyDebianRequestPath,
  normalizePypiName,
  pypiJsonApiRedirectPath,
  isNpmMetadataRequest,
  isNpmTarballRequest,
  isPypiSimpleRequest,
  filterNpmPackument,
  filterPypiIndex,
  getCachedVersions,
  setCachedVersions,
  handleRegistryRequest,
  npmRegistry,
  pypiRegistry,
  debianRegistry,
  cargoRegistry,
  cargoSparseIndexPath,
  parseCargoSparseIndexUrl,
  parseCargoDownloadUrl,
  filterCargoSparseIndex,
  classifyRegistryRoute,
  type NpmPackument,
  type RegistryHandlerOptions,
  type RegistryRoute,
} from '../../src/docker/registry-proxy.js';
import { createPackageValidator, DENY_ALL_VALIDATOR } from '../../src/docker/package-validator.js';
import type { AllowedVersionCache, PackageIdentity, RegistryConfig } from '../../src/docker/package-types.js';
import type { OutboundTransport } from '../../src/docker/outbound-transport.js';
import { checkRegistryRequestPath } from '../../src/docker/registry-request-path.js';
import { CREDENTIAL_HEADERS } from '../../src/docker/package-egress-proxy.js';
import { RegistryMetadataBudget } from '../../src/docker/registry-metadata-budget.js';
import { NpmPublishTimeCache } from '../../src/docker/registry-metadata.js';

// Mock node:https so the Debian allow/metadata tests can exercise the
// forwardReadOnly path without a real network call. The default wraps the real
// implementation (call-through), so every other test behaves as before; the
// affected tests install a one-shot override via mockImplementationOnce.
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: vi.fn(actual.request) };
});

// ── npm URL parsing ─────────────────────────────────────────────────

describe('parseNpmUrl', () => {
  describe('metadata requests', () => {
    it('parses unscoped package', () => {
      expect(parseNpmUrl('/express')).toEqual({
        registry: 'npm',
        name: 'express',
      });
    });

    it('parses scoped package', () => {
      expect(parseNpmUrl('/@types/node')).toEqual({
        registry: 'npm',
        name: 'node',
        scope: 'types',
      });
    });

    it('parses URL-encoded scoped package', () => {
      expect(parseNpmUrl('/@types%2fnode')).toEqual({
        registry: 'npm',
        name: 'node',
        scope: 'types',
      });
    });

    it('strips query string', () => {
      expect(parseNpmUrl('/express?version=latest')).toEqual({
        registry: 'npm',
        name: 'express',
      });
    });

    it('returns undefined for root path', () => {
      expect(parseNpmUrl('/')).toBeUndefined();
    });

    it('returns undefined for /-/ path', () => {
      expect(parseNpmUrl('/-')).toBeUndefined();
    });

    it('returns undefined for paths with extra segments', () => {
      expect(parseNpmUrl('/express/something')).toBeUndefined();
    });

    it('returns undefined for empty package name (/-/ prefix paths)', () => {
      // /-/ping has empty package part before /-/
      expect(parseNpmUrl('/-/ping')).toBeUndefined();
      expect(parseNpmUrl('/-/v1/security/advisories')).toBeUndefined();
      expect(parseNpmUrl('/-/')).toBeUndefined();
    });
  });

  describe('tarball requests', () => {
    it('parses unscoped tarball', () => {
      expect(parseNpmUrl('/express/-/express-4.18.2.tgz')).toEqual({
        registry: 'npm',
        name: 'express',
        version: '4.18.2',
      });
    });

    it('parses scoped tarball', () => {
      expect(parseNpmUrl('/@types/node/-/node-20.0.0.tgz')).toEqual({
        registry: 'npm',
        name: 'node',
        scope: 'types',
        version: '20.0.0',
      });
    });

    it('handles pre-release versions', () => {
      expect(parseNpmUrl('/react/-/react-19.0.0-rc.1.tgz')).toEqual({
        registry: 'npm',
        name: 'react',
        version: '19.0.0-rc.1',
      });
    });

    it('parses a tarball under an encoded scope separator', () => {
      expect(parseNpmUrl('/@types%2fnode/-/node-20.0.0.tgz')).toEqual({
        registry: 'npm',
        name: 'node',
        scope: 'types',
        version: '20.0.0',
      });
    });

    it('returns undefined for a tarball-shaped path whose file name does not parse', () => {
      expect(parseNpmUrl('/express/-/not-a-real-tarball')).toBeUndefined();
      expect(parseNpmUrl('/express/-/express-.tgz')).toBeUndefined();
      expect(parseNpmUrl('/express/-/express-4.18.2.tgz/extra')).toBeUndefined();
      expect(parseNpmUrl('/express/-/express-4.18.2%20.tgz')).toBeUndefined();
    });
  });

  // EGR-1: the scoped branch used to accept any name, so `/@x/../express`
  // parsed as a package called `../express` that no denylist entry matched.
  describe('strict name grammar', () => {
    it.each([
      '/@x/../express',
      '/@x/../express/-/express-4.18.2.tgz',
      '/@x/a/b',
      '/@x%2f..%2fexpress',
      '/@x/',
      '/@/express',
      '/@x',
      '/@./express',
      '/@_x/express',
      '/@x/.express',
      '/@x/_express',
      '/.express',
      '/_express',
      '/-express',
      '/..',
      '/express%5cx',
      '/express%25',
      '/express%20',
      `/${'a'.repeat(215)}`,
    ])('rejects %s', (path) => {
      expect(parseNpmUrl(path)).toBeUndefined();
    });

    it('accepts legacy mixed-case names (case-insensitive grammar)', () => {
      expect(parseNpmUrl('/JSONStream')).toEqual({ registry: 'npm', name: 'JSONStream' });
      expect(parseNpmUrl('/JSONStream/-/JSONStream-1.3.5.tgz')).toEqual({
        registry: 'npm',
        name: 'JSONStream',
        version: '1.3.5',
      });
    });

    it('accepts dotted, underscored and other URL-safe names that do not lead with . or _', () => {
      expect(parseNpmUrl('/lodash.merge')?.name).toBe('lodash.merge');
      expect(parseNpmUrl('/@babel/plugin-transform-runtime')?.name).toBe('plugin-transform-runtime');
      expect(parseNpmUrl('/string_decoder')?.name).toBe('string_decoder');
      expect(parseNpmUrl(`/${'a'.repeat(214)}`)?.name).toHaveLength(214);
    });

    it('decodes the path once, so the identity is what the registry will serve', () => {
      expect(parseNpmUrl('/%65xpress/-/%65xpress-4.18.2.tgz')).toEqual({
        registry: 'npm',
        name: 'express',
        version: '4.18.2',
      });
      expect(parseNpmUrl('/%40types%2fnode')).toEqual({ registry: 'npm', name: 'node', scope: 'types' });
      // An encoded `-` separator is still a tarball request, not metadata.
      expect(parseNpmPackageRequest('/express/%2d/express-4.18.2.tgz')?.kind).toBe('tarball');
    });
  });

  describe('canonical upstream paths', () => {
    it('rebuilds metadata paths from the validated identity', () => {
      expect(npmMetadataPath({ registry: 'npm', name: 'express' })).toBe('/express');
      expect(npmMetadataPath({ registry: 'npm', name: 'node', scope: 'types' })).toBe('/@types%2fnode');
    });

    it('rebuilds tarball paths from the validated identity', () => {
      expect(npmTarballPath({ registry: 'npm', name: 'express', version: '4.18.2' })).toBe(
        '/express/-/express-4.18.2.tgz',
      );
      expect(npmTarballPath({ registry: 'npm', name: 'node', scope: 'types', version: '20.0.0' })).toBe(
        '/@types/node/-/node-20.0.0.tgz',
      );
    });
  });
});

// ── PyPI URL parsing ────────────────────────────────────────────────

describe('parsePypiSimpleUrl', () => {
  it('parses simple package path with trailing slash', () => {
    expect(parsePypiSimpleUrl('/simple/numpy/')).toEqual({
      registry: 'pypi',
      name: 'numpy',
    });
  });

  it('parses without trailing slash', () => {
    expect(parsePypiSimpleUrl('/simple/numpy')).toEqual({
      registry: 'pypi',
      name: 'numpy',
    });
  });

  it('normalizes package name', () => {
    const result = parsePypiSimpleUrl('/simple/My_Package/');
    expect(result?.name).toBe('my-package');
  });

  it('returns undefined for non-simple paths', () => {
    expect(parsePypiSimpleUrl('/pypi/numpy/json')).toBeUndefined();
  });

  it('returns undefined for root simple path', () => {
    expect(parsePypiSimpleUrl('/simple/')).toBeUndefined();
  });
});

describe('parsePypiTarballUrl', () => {
  it('parses sdist tar.gz', () => {
    const result = parsePypiTarballUrl('/packages/hash/numpy-1.26.0.tar.gz');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'numpy',
      version: '1.26.0',
    });
  });

  it('parses wheel', () => {
    const result = parsePypiTarballUrl('/packages/hash/numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.whl');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'numpy',
      version: '1.26.0',
    });
  });

  it('parses zip sdist', () => {
    const result = parsePypiTarballUrl('/packages/hash/some-package-2.0.0.zip');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'some-package',
      version: '2.0.0',
    });
  });

  it('parses .whl.metadata sidecar URL', () => {
    const result = parsePypiTarballUrl('/packages/hash/hatchling-1.25.0-py3-none-any.whl.metadata');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'hatchling',
      version: '1.25.0',
    });
  });

  it('returns undefined for unrecognized format', () => {
    expect(parsePypiTarballUrl('/packages/hash/readme.txt')).toBeUndefined();
  });
});

describe('extractPypiPackageFromFilename', () => {
  it('handles hyphenated package names', () => {
    const result = extractPypiPackageFromFilename('my-package-1.0.0.tar.gz');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'my-package',
      version: '1.0.0',
    });
  });

  it('handles underscore package names', () => {
    const result = extractPypiPackageFromFilename('my_package-1.0.0.tar.gz');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'my-package', // normalized
      version: '1.0.0',
    });
  });

  it('handles complex wheel filenames', () => {
    const result = extractPypiPackageFromFilename('scipy-1.12.0-cp312-cp312-macosx_12_0_arm64.whl');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'scipy',
      version: '1.12.0',
    });
  });

  it('handles .whl.metadata sidecar (PEP 658)', () => {
    const result = extractPypiPackageFromFilename('hatchling-1.25.0-py3-none-any.whl.metadata');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'hatchling',
      version: '1.25.0',
    });
  });

  it('handles .whl.metadata for complex wheel names', () => {
    const result = extractPypiPackageFromFilename('shiboken6-6.8.3-cp39-abi3-manylinux_2_28_x86_64.whl.metadata');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'shiboken6',
      version: '6.8.3',
    });
  });

  it('handles .whl.provenance sidecar (PEP 714)', () => {
    const result = extractPypiPackageFromFilename('numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.whl.provenance');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'numpy',
      version: '1.26.0',
    });
  });

  it('handles .tar.gz.metadata sidecar', () => {
    const result = extractPypiPackageFromFilename('requests-2.31.0.tar.gz.metadata');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'requests',
      version: '2.31.0',
    });
  });

  it('rejects double-suffix .whl.metadata.metadata (fail-closed)', () => {
    expect(
      extractPypiPackageFromFilename('numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.whl.metadata.metadata'),
    ).toBeUndefined();
  });

  it('rejects bare .metadata without distribution extension', () => {
    expect(extractPypiPackageFromFilename('something.metadata')).toBeUndefined();
  });
});

describe('normalizePypiName', () => {
  it('lowercases', () => {
    expect(normalizePypiName('NumPy')).toBe('numpy');
  });

  it('replaces underscores with hyphens', () => {
    expect(normalizePypiName('my_package')).toBe('my-package');
  });

  it('replaces dots with hyphens', () => {
    expect(normalizePypiName('zope.interface')).toBe('zope-interface');
  });

  it('collapses consecutive separators', () => {
    expect(normalizePypiName('my__package')).toBe('my-package');
  });
});

describe('pypiJsonApiRedirectPath', () => {
  it.each([
    [301, 'https://pypi.org/pypi/Django/json', 'django', '/pypi/Django/json'],
    [302, 'https://pypi.org/pypi/PyYAML/json', 'pyyaml', '/pypi/PyYAML/json'],
    [307, 'https://pypi.org/pypi/typing_extensions/json', 'typing-extensions', '/pypi/typing_extensions/json'],
    [308, '/pypi/zope.interface/json', 'zope-interface', '/pypi/zope.interface/json'],
    [301, 'https://PyPI.org:443/pypi/Django/json', 'django', '/pypi/Django/json'],
  ])('admits a %i to %s for %s', (status, location, name, path) => {
    expect(pypiJsonApiRedirectPath(status, location, 'pypi.org', name)).toBe(path);
  });

  it.each([
    [303, 'https://pypi.org/pypi/Django/json'],
    [200, 'https://pypi.org/pypi/Django/json'],
    [301, 'https://pypi.org/pypi/Flask/json'],
    [301, 'https://pypi.org/pypi/django-stubs/json'],
    [301, 'https://files.pythonhosted.org/pypi/Django/json'],
    [301, '//pypi.example/pypi/Django/json'],
    [301, 'http://pypi.org/pypi/Django/json'],
    [301, 'https://pypi.org:8443/pypi/Django/json'],
    [301, 'https://user@pypi.org/pypi/Django/json'],
    [301, 'https://pypi.org/pypi/Django/json?x=1'],
    [301, 'https://pypi.org/pypi/Django/json#top'],
    [301, 'https://pypi.org/pypi/Django/4.2.7/json'],
    [301, 'https://pypi.org/simple/Django/'],
    [301, 'https://pypi.org/pypi/Dj%61ngo/json'],
    [301, 'https://pypi.org/pypi/Django/json/..'],
    [301, 'https://[::1'],
  ])('refuses a %i to %s', (status, location) => {
    expect(pypiJsonApiRedirectPath(status, location, 'pypi.org', 'django')).toBeUndefined();
  });
});

// ── Request classification ──────────────────────────────────────────

describe('isNpmMetadataRequest', () => {
  it('returns true for metadata URLs', () => {
    expect(isNpmMetadataRequest('/express')).toBe(true);
    expect(isNpmMetadataRequest('/@types/node')).toBe(true);
  });

  it('returns false for tarball URLs', () => {
    expect(isNpmMetadataRequest('/express/-/express-4.18.2.tgz')).toBe(false);
  });

  it('returns false for non-package paths', () => {
    expect(isNpmMetadataRequest('/')).toBe(false);
  });
});

describe('isNpmTarballRequest', () => {
  it('returns true for tarball URLs', () => {
    expect(isNpmTarballRequest('/express/-/express-4.18.2.tgz')).toBe(true);
  });

  it('returns false for metadata URLs', () => {
    expect(isNpmTarballRequest('/express')).toBe(false);
  });
});

describe('isPypiSimpleRequest', () => {
  it('returns true for simple index URLs', () => {
    expect(isPypiSimpleRequest('/simple/numpy/')).toBe(true);
  });

  it('returns false for other paths', () => {
    expect(isPypiSimpleRequest('/pypi/numpy/json')).toBe(false);
  });
});

// ── npm packument filtering ─────────────────────────────────────────

describe('filterNpmPackument', () => {
  const olderDate = new Date('2022-06-01T00:00:00Z').toISOString();
  const oldDate = new Date('2023-01-01T00:00:00Z').toISOString();
  const newDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

  const packument: NpmPackument = {
    name: 'express',
    versions: {
      '4.17.0': { version: '4.17.0' },
      '4.18.0': { version: '4.18.0' },
      '5.0.0': { version: '5.0.0' },
    },
    'dist-tags': {
      latest: '5.0.0',
      previous: '4.18.0',
    },
    time: {
      created: '2010-01-01T00:00:00Z',
      modified: newDate,
      '4.17.0': olderDate,
      '4.18.0': oldDate,
      '5.0.0': newDate,
    },
  };

  it('filters out versions newer than quarantine period', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered, denied } = filterNpmPackument(packument, validator, 'express');

    expect(Object.keys(filtered.versions)).toEqual(['4.17.0', '4.18.0']);
    expect(denied).toHaveLength(1);
    expect(denied[0].version).toBe('5.0.0');
  });

  it('updates dist-tags.latest when original latest is filtered', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered } = filterNpmPackument(packument, validator, 'express');

    expect(filtered['dist-tags']?.latest).toBe('4.18.0');
    // 'previous' still points to an allowed version
    expect(filtered['dist-tags']?.previous).toBe('4.18.0');
  });

  it('preserves created and modified timestamps', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered } = filterNpmPackument(packument, validator, 'express');

    expect(filtered.time?.created).toBe('2010-01-01T00:00:00Z');
    expect(filtered.time?.modified).toBe(newDate);
  });

  it('removes filtered version timestamps from time object', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered } = filterNpmPackument(packument, validator, 'express');

    expect(filtered.time?.['5.0.0']).toBeUndefined();
    expect(filtered.time?.['4.17.0']).toBe(olderDate);
  });

  it('allows all versions when quarantine is disabled', () => {
    const validator = createPackageValidator({ quarantineDays: 0 });
    const { filtered, denied } = filterNpmPackument(packument, validator, 'express');

    expect(Object.keys(filtered.versions)).toEqual(['4.17.0', '4.18.0', '5.0.0']);
    expect(denied).toHaveLength(0);
  });

  it('filters denied packages completely', () => {
    const validator = createPackageValidator({ deniedPackages: ['express'] });
    const { filtered, denied } = filterNpmPackument(packument, validator, 'express');

    expect(Object.keys(filtered.versions)).toHaveLength(0);
    expect(denied).toHaveLength(3);
  });

  it('handles scoped packages', () => {
    const scopedPackument: NpmPackument = {
      name: '@types/node',
      versions: { '20.0.0': { version: '20.0.0' } },
      'dist-tags': { latest: '20.0.0' },
      time: { '20.0.0': oldDate },
    };
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered } = filterNpmPackument(scopedPackument, validator, 'node', 'types');

    expect(Object.keys(filtered.versions)).toEqual(['20.0.0']);
  });

  it('treats invalid timestamps as missing metadata (fail-closed)', () => {
    const packument: NpmPackument = {
      name: 'express',
      versions: { '5.0.0': { version: '5.0.0' } },
      'dist-tags': { latest: '5.0.0' },
      time: { '5.0.0': 'not-a-valid-date' },
    };
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered, denied } = filterNpmPackument(packument, validator, 'express');

    // Invalid date should be treated as no timestamp -> fail-closed deny
    expect(Object.keys(filtered.versions)).toHaveLength(0);
    expect(denied).toHaveLength(1);
    expect(denied[0].reason).toContain('fail-closed');
  });
});

// ── PyPI index filtering ────────────────────────────────────────────

/** A files.pythonhosted.org path: the blake2b-256 digest split 2/2/60, then the file name. */
function pypiFilePath(digestByte: string, filename: string): string {
  const digest = digestByte.repeat(32);
  return `/packages/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest.slice(4)}/${filename}`;
}

/** One Simple Repository link, the way pypi.org writes it. */
function pypiLink(filePath: string): string {
  return `<a href="https://files.pythonhosted.org${filePath}#sha256=00">${filePath.split('/').pop()}</a>`;
}

describe('filterPypiIndex', () => {
  const oldTime = Date.parse('2023-01-01T00:00:00Z');
  const newTime = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago

  const files = {
    sdist125: pypiFilePath('a1', 'numpy-1.25.0.tar.gz'),
    sdist126: pypiFilePath('b2', 'numpy-1.26.0.tar.gz'),
    sdist200: pypiFilePath('c3', 'numpy-2.0.0.tar.gz'),
    wheel200: pypiFilePath('d4', 'numpy-2.0.0-cp312-cp312-manylinux.whl'),
  };
  const html = `<!DOCTYPE html>\n<html><body>\n${Object.values(files).map(pypiLink).join('\n')}\n</body></html>`;

  const uploadTimes = new Map<string, number>([
    [files.sdist125, oldTime],
    [files.sdist126, oldTime],
    [files.sdist200, newTime],
    [files.wheel200, newTime],
  ]);

  it('removes links for denied versions', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered, denied, allowedVersions, allowedFiles } = filterPypiIndex(html, validator, 'numpy', uploadTimes);

    expect(filtered).toContain('numpy-1.25.0.tar.gz');
    expect(filtered).toContain('numpy-1.26.0.tar.gz');
    expect(filtered).not.toContain('numpy-2.0.0');
    expect(denied.map((d) => d.version)).toEqual(['2.0.0', '2.0.0']);
    expect(allowedVersions).toEqual(new Set(['1.25.0', '1.26.0']));
    expect(allowedFiles).toEqual(new Set([files.sdist125, files.sdist126]));
  });

  it('reports each withheld file of a denied version by name', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { denied } = filterPypiIndex(html, validator, 'numpy', uploadTimes);

    expect(denied.map((d) => d.file)).toEqual(['numpy-2.0.0.tar.gz', 'numpy-2.0.0-cp312-cp312-manylinux.whl']);
    expect(denied.every((d) => d.reason.includes('day(s) old'))).toBe(true);
  });

  // EGR-5: the gate used the release's earliest upload, so a wheel uploaded
  // today to a release published years ago passed as years old.
  it('gates each file by its own upload time: a new wheel on an old release is withheld', () => {
    const lateWheel = pypiFilePath('e5', 'numpy-1.26.0-cp313-cp313-manylinux_2_17_aarch64.whl');
    const page = `<html><body>${pypiLink(files.sdist126)}${pypiLink(lateWheel)}</body></html>`;
    const times = new Map([
      [files.sdist126, oldTime],
      [lateWheel, Date.now() - 60 * 60 * 1000],
    ]);
    const validator = createPackageValidator({ quarantineDays: 2 });

    const { filtered, denied, allowedVersions, allowedFiles } = filterPypiIndex(page, validator, 'numpy', times);

    expect(filtered).toContain('numpy-1.26.0.tar.gz');
    expect(filtered).not.toContain('cp313');
    expect(denied).toEqual([
      expect.objectContaining({ version: '1.26.0', file: 'numpy-1.26.0-cp313-cp313-manylinux_2_17_aarch64.whl' }),
    ]);
    expect(allowedVersions).toEqual(new Set(['1.26.0']));
    expect(allowedFiles).toEqual(new Set([files.sdist126]));
  });

  it('withholds a file it has no upload time for, and a link that is not a files.pythonhosted.org file (fail-closed)', () => {
    const unknown = pypiFilePath('f6', 'numpy-1.26.1.tar.gz');
    const page =
      `<html><body>${pypiLink(files.sdist126)}${pypiLink(unknown)}` +
      `<a href="../../packages/b2/b2/${'b2'.repeat(30)}/numpy-1.26.0.tar.gz">relative</a>` +
      `<a href="https://mirror.example${files.sdist126}">elsewhere</a></body></html>`;
    const validator = createPackageValidator({ quarantineDays: 2 });

    const { filtered, denied, allowedFiles } = filterPypiIndex(page, validator, 'numpy', uploadTimes);

    expect(filtered).toBe(`<html><body>${pypiLink(files.sdist126)}</body></html>`);
    expect(denied).toHaveLength(3);
    expect(denied.every((d) => d.reason.includes('fail-closed'))).toBe(true);
    expect(allowedFiles).toEqual(new Set([files.sdist126]));
  });

  it('keeps all links when quarantine is disabled', () => {
    const validator = createPackageValidator({ quarantineDays: 0 });
    const { filtered, denied, allowedVersions } = filterPypiIndex(html, validator, 'numpy', uploadTimes);

    expect(filtered).toContain('numpy-2.0.0.tar.gz');
    expect(denied).toHaveLength(0);
    expect(allowedVersions).toEqual(new Set(['1.25.0', '1.26.0', '2.0.0']));
  });

  it('removes all links for denied packages', () => {
    const validator = createPackageValidator({ deniedPackages: ['numpy'] });
    const { denied, allowedVersions } = filterPypiIndex(html, validator, 'numpy', uploadTimes);

    expect(denied.length).toBeGreaterThan(0);
    expect(allowedVersions.size).toBe(0);
  });
});

// ── AllowedVersionCache ─────────────────────────────────────────────

describe('AllowedVersionCache', () => {
  it('stores and retrieves versions', () => {
    const cache: AllowedVersionCache = new Map();
    const pkg: PackageIdentity = { registry: 'npm', name: 'express' };

    setCachedVersions(cache, pkg, new Set(['4.17.0', '4.18.0']));
    const versions = getCachedVersions(cache, pkg);

    expect(versions).toBeDefined();
    expect(versions!.has('4.17.0')).toBe(true);
    expect(versions!.has('4.18.0')).toBe(true);
    expect(versions!.has('5.0.0')).toBe(false);
  });

  it('returns undefined on cache miss', () => {
    const cache: AllowedVersionCache = new Map();
    const pkg: PackageIdentity = { registry: 'npm', name: 'express' };

    expect(getCachedVersions(cache, pkg)).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    const cache: AllowedVersionCache = new Map();
    const pkg: PackageIdentity = { registry: 'npm', name: 'express' };

    // Manually set an old entry
    const key = 'npm:express';
    cache.set(key, {
      allowedVersions: new Set(['4.17.0']),
      cachedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    });

    expect(getCachedVersions(cache, pkg)).toBeUndefined();
  });

  it('uses different keys for different registries', () => {
    const cache: AllowedVersionCache = new Map();
    const npmPkg: PackageIdentity = { registry: 'npm', name: 'requests' };
    const pypiPkg: PackageIdentity = { registry: 'pypi', name: 'requests' };

    setCachedVersions(cache, npmPkg, new Set(['1.0.0']));
    setCachedVersions(cache, pypiPkg, new Set(['2.0.0']));

    expect(getCachedVersions(cache, npmPkg)!.has('1.0.0')).toBe(true);
    expect(getCachedVersions(cache, pypiPkg)!.has('2.0.0')).toBe(true);
  });
});

// ── Test helpers for handleRegistryRequest ───────────────────────────

/** Creates a fake IncomingMessage with the given URL. */
function fakeReq(url: string): http.IncomingMessage {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  req.url = url;
  req.method = 'GET';
  req.headers = {};
  return req;
}

/** Creates a fake ServerResponse that captures statusCode and body. */
function fakeRes(): http.ServerResponse & { body: string; statusCode: number } {
  const res = new PassThrough() as unknown as http.ServerResponse & { body: string; statusCode: number };
  res.body = '';
  res.statusCode = 0;
  res.writeHead = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.end = ((data?: string) => {
    if (data) res.body = data;
    return res;
  }) as unknown as typeof res.end;
  return res;
}

// ── Adversarial tarball backstop routing ─────────────────────────────

describe('handleRegistryRequest: adversarial /-/ paths', () => {
  const options: RegistryHandlerOptions = {
    validator: DENY_ALL_VALIDATOR,
    cache: new Map(),
  };

  // Paths with a package prefix before /-/ go to tarball backstop (403)
  const tarballBackstopPaths = [
    '/express/-/not-a-real-tarball',
    '/express/-/',
    '/@scope/pkg/-/garbled-filename.xyz',
    '/express/-/express-99.99.99.tgz', // valid-looking but won't be in cache
  ];

  for (const path of tarballBackstopPaths) {
    it(`denies crafted tarball path: ${path}`, async () => {
      const req = fakeReq(path);
      const res = fakeRes();

      await handleRegistryRequest(npmRegistry, req, res, 'registry.npmjs.org', 443, options);

      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('Forbidden');
    });
  }

  // Paths starting with /-/ are npm internal endpoints — verify they are NOT
  // routed to the tarball backstop by confirming parseNpmUrl returns undefined
  // (so handleTarballDownload would not be invoked for these).
  const npmInternalPaths = ['/-/ping', '/-/', '/-/v1/security/advisories', '/-/some-random-path'];

  for (const path of npmInternalPaths) {
    it(`does not parse as package: ${path}`, () => {
      // These paths have empty package part before /-/, so parseNpmUrl returns undefined
      expect(parseNpmUrl(path)).toBeUndefined();
    });

    it(`is not classified as tarball request: ${path}`, () => {
      expect(isNpmTarballRequest(path)).toBe(false);
    });

    it(`is not classified as metadata request: ${path}`, () => {
      expect(isNpmMetadataRequest(path)).toBe(false);
    });
  }

  it('classifies legitimate metadata requests correctly', () => {
    // Metadata requests are routed to handleNpmMetadata, not tarball backstop
    expect(isNpmMetadataRequest('/express')).toBe(true);
    expect(isNpmTarballRequest('/express')).toBe(false);
    expect(isNpmMetadataRequest('/@types/node')).toBe(true);
  });
});

// ── Debian .deb filename parsing ────────────────────────────────────

describe('extractDebianPackageFromFilename', () => {
  it('parses standard .deb filename', () => {
    expect(extractDebianPackageFromFilename('libssl3_3.0.11-1~deb12u2_arm64.deb')).toEqual({
      registry: 'debian',
      name: 'libssl3',
      version: '3.0.11-1~deb12u2',
    });
  });

  it('parses package with hyphens in name', () => {
    expect(extractDebianPackageFromFilename('gcc-14-base_14.2.0-19_arm64.deb')).toEqual({
      registry: 'debian',
      name: 'gcc-14-base',
      version: '14.2.0-19',
    });
  });

  it('parses epoch version (URL-encoded colon)', () => {
    expect(extractDebianPackageFromFilename('tar_1%3a1.35-2_arm64.deb')).toEqual({
      registry: 'debian',
      name: 'tar',
      version: '1:1.35-2',
    });
  });

  it('parses multi-arch all package', () => {
    expect(extractDebianPackageFromFilename('fonts-dejavu-core_2.37-8_all.deb')).toEqual({
      registry: 'debian',
      name: 'fonts-dejavu-core',
      version: '2.37-8',
    });
  });

  it('returns undefined for non-.deb file', () => {
    expect(extractDebianPackageFromFilename('Release')).toBeUndefined();
    expect(extractDebianPackageFromFilename('Packages.gz')).toBeUndefined();
    expect(extractDebianPackageFromFilename('something.tar.gz')).toBeUndefined();
  });

  it('returns undefined for malformed .deb (no underscores)', () => {
    expect(extractDebianPackageFromFilename('broken.deb')).toBeUndefined();
  });

  it('returns undefined for .deb with only one underscore', () => {
    expect(extractDebianPackageFromFilename('name_version.deb')).toBeUndefined();
  });

  // EGR-2: the name used to be read from the still-encoded file name, so a
  // percent-encoded byte produced a name no denylist entry matched.
  describe('decodes the whole file name once before parsing', () => {
    it('decodes an encoded byte in the name', () => {
      expect(extractDebianPackageFromFilename('%6Eetcat-traditional_1.10-47_amd64.deb')).toEqual({
        registry: 'debian',
        name: 'netcat-traditional',
        version: '1.10-47',
      });
      expect(extractDebianPackageFromFilename('%6E%65%74%63%61%74-traditional_1.10-47_amd64.deb')?.name).toBe(
        'netcat-traditional',
      );
    });

    it("decodes apt's %2b/%7e quoting of + and ~ across the whole file name", () => {
      expect(extractDebianPackageFromFilename('g%2b%2b-12_12.2.0-14_amd64.deb')).toEqual({
        registry: 'debian',
        name: 'g++-12',
        version: '12.2.0-14',
      });
      expect(extractDebianPackageFromFilename('libstdc%2B%2B6_12.2.0-14%7edeb12u1_amd64.deb')).toEqual({
        registry: 'debian',
        name: 'libstdc++6',
        version: '12.2.0-14~deb12u1',
      });
    });

    it('reads the .deb suffix from the decoded file name', () => {
      expect(extractDebianPackageFromFilename('netcat-traditional_1.10-47_amd64.d%65b')?.name).toBe(
        'netcat-traditional',
      );
      expect(extractDebianPackageFromFilename('netcat-traditional_1.10-47_amd64%2Edeb')?.name).toBe(
        'netcat-traditional',
      );
    });

    it.each([
      ['double encoding', 'g%252b%252b-12_12.2.0-14_amd64.deb'],
      ['malformed encoding', 'netcat_1.10%E0%A4_amd64.deb'],
      ['encoded slash', 'netcat_1.10%2f47_amd64.deb'],
      ['encoded backslash', 'netcat_1.10%5c47_amd64.deb'],
      ['control character', 'netcat_1.10-47_amd64%0a.deb'],
      ['uppercase name', 'Netcat-traditional_1.10-47_amd64.deb'],
      ['one-character name', 'n_1.10-47_amd64.deb'],
      ['name with an invalid character', 'netcat!_1.10-47_amd64.deb'],
      ['extra underscore field', 'netcat_1.10-47_amd64_extra.deb'],
      ['version with a space', 'netcat_1.10%2047_amd64.deb'],
      ['version starting with a separator', 'netcat_-1.10_amd64.deb'],
      ['empty arch', 'netcat_1.10-47_.deb'],
      ['arch with an invalid character', 'netcat_1.10-47_amd64;x.deb'],
    ])('rejects %s', (_label, filename) => {
      expect(extractDebianPackageFromFilename(filename)).toBeUndefined();
    });
  });
});

// ── Debian URL parsing ──────────────────────────────────────────────

describe('parseDebianPackageUrl', () => {
  it('parses pool path with .deb', () => {
    expect(parseDebianPackageUrl('/debian/pool/main/l/libssl3/libssl3_3.0.11-1~deb12u2_arm64.deb')).toEqual({
      registry: 'debian',
      name: 'libssl3',
      version: '3.0.11-1~deb12u2',
    });
  });

  it('returns undefined for Release file', () => {
    expect(parseDebianPackageUrl('/debian/dists/trixie/Release')).toBeUndefined();
  });

  it('returns undefined for InRelease file', () => {
    expect(parseDebianPackageUrl('/debian/dists/trixie/InRelease')).toBeUndefined();
  });

  it('returns undefined for Packages.gz', () => {
    expect(parseDebianPackageUrl('/debian/dists/trixie/main/binary-arm64/Packages.gz')).toBeUndefined();
  });

  it('returns undefined for GPG key paths', () => {
    expect(parseDebianPackageUrl('/debian/dists/trixie/Release.gpg')).toBeUndefined();
  });

  it('strips query string before parsing', () => {
    expect(parseDebianPackageUrl('/debian/pool/main/l/libegl1/libegl1_1.7.0-1_arm64.deb?some=param')).toEqual({
      registry: 'debian',
      name: 'libegl1',
      version: '1.7.0-1',
    });
  });

  it('identifies a .deb whose extension is percent-encoded instead of treating it as metadata', () => {
    expect(parseDebianPackageUrl('/debian/pool/main/n/netcat/netcat-traditional_1.10-47_amd64%2Edeb')).toEqual({
      registry: 'debian',
      name: 'netcat-traditional',
      version: '1.10-47',
    });
  });
});

// ── Debian request classification ───────────────────────────────────

describe('classifyDebianRequestPath', () => {
  const hash = 'a'.repeat(64);

  it.each([
    '/debian/dists/bookworm/InRelease',
    '/debian/dists/bookworm/Release',
    '/debian/dists/bookworm/Release.gpg',
    '/debian/dists/bookworm/main/binary-amd64/Packages',
    '/debian/dists/bookworm/main/binary-arm64/Packages.xz',
    '/debian/dists/bookworm/main/binary-all/Packages.gz',
    '/debian/dists/bookworm/main/binary-amd64/Release',
    '/debian/dists/bookworm/main/i18n/Translation-en.bz2',
    '/debian/dists/bookworm/main/i18n/Translation-pt_BR.xz',
    '/debian/dists/bookworm/main/source/Sources.xz',
    '/debian/dists/bookworm/main/Contents-amd64.gz',
    '/debian/dists/bookworm/main/Contents-udeb-amd64.gz',
    '/debian/dists/bookworm/main/cnf/Commands-amd64.xz',
    '/debian/dists/bookworm/main/dep11/Components-amd64.yml.gz',
    '/debian/dists/bookworm/main/dep11/icons-64x64@2.tar.gz',
    `/debian/dists/bookworm/main/binary-amd64/by-hash/SHA256/${hash}`,
    `/debian-security/dists/bookworm-security/main/binary-arm64/by-hash/SHA256/${hash}`,
    '/debian-security/dists/bookworm-security/InRelease',
    '/dists/bookworm-security/InRelease',
  ])('passes repository metadata %s', (path) => {
    expect(classifyDebianRequestPath(path)).toEqual({ kind: 'metadata' });
  });

  it.each([
    ['a directory listing under pool/', '/debian/pool/main/n/netcat/'],
    ['a source package', '/debian/pool/main/n/netcat/netcat_1.10-47.dsc'],
    ['an upstream tarball', '/debian/pool/main/n/netcat/netcat_1.10.orig.tar.gz'],
    ['a udeb', '/debian/pool/main/n/netcat/netcat-udeb_1.10-47_amd64.udeb'],
    ['an unparseable .deb', '/debian/pool/main/b/broken/broken.deb'],
    ['an uppercase .DEB', '/debian/pool/main/n/netcat/netcat-traditional_1.10-47_amd64.DEB'],
    ['a file outside dists/ and pool/', '/debian/README'],
    ['the archive root', '/debian/'],
    ['installer images under dists/', '/debian/dists/bookworm/main/installer-amd64/current/images/MANIFEST'],
    ['dists/ without a suite', '/debian/dists/InRelease'],
    ['a by-hash entry with an unknown algorithm', `/debian/dists/bookworm/main/by-hash/SHA3/${hash}`],
    ['a by-hash entry with a non-hex digest', '/debian/dists/bookworm/main/by-hash/SHA256/not-a-digest'],
    ['encoded metadata', '/debian/dists/bookworm/In%52elease'],
    ['a metadata name under pool/', '/debian/pool/main/dists/bookworm/InRelease'],
    ['a pdiff patch', '/debian/dists/sid/main/binary-amd64/Packages.diff/T-2024-01-01-0000.00-F-2024-01-01-0000.00.gz'],
  ])('refuses %s', (_label, path) => {
    expect(classifyDebianRequestPath(path).kind).toBe('refused');
  });

  it('classifies a .deb by its decoded file name', () => {
    expect(
      classifyDebianRequestPath('/debian/pool/main/n/netcat/%6Eetcat-traditional_1.10-47_amd64.d%65b?x=1'),
    ).toEqual({
      kind: 'artifact',
      pkg: { registry: 'debian', name: 'netcat-traditional', version: '1.10-47' },
    });
  });
});

// ── Debian handleRegistryRequest ────────────────────────────────────

describe('handleRegistryRequest: debian', () => {
  it('blocks .deb download for denied package', async () => {
    const options: RegistryHandlerOptions = {
      validator: DENY_ALL_VALIDATOR,
      cache: new Map(),
    };
    const req = fakeReq('/debian/pool/main/l/libssl3/libssl3_3.0.11-1~deb12u2_arm64.deb');
    const res = fakeRes();

    await handleRegistryRequest(debianRegistry, req, res, 'deb.debian.org', 443, options);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Forbidden');
    expect(res.body).toContain('libssl3');
  });

  it('blocks unparseable .deb filename (fail-closed)', async () => {
    const options: RegistryHandlerOptions = {
      validator: createPackageValidator({}),
      cache: new Map(),
    };
    const req = fakeReq('/debian/pool/main/b/broken/broken.deb');
    const res = fakeRes();

    await handleRegistryRequest(debianRegistry, req, res, 'deb.debian.org', 443, options);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Forbidden');
  });

  it('calls validator with epoch date to bypass quarantine for .deb files', async () => {
    // Track what the validator receives to verify quarantine bypass
    let validatedPkg: import('../../src/docker/package-types.js').PackageIdentity | undefined;
    let validatedMetadata: import('../../src/docker/package-types.js').VersionMetadata | undefined;

    const options: RegistryHandlerOptions = {
      validator: {
        validate(pkg, metadata) {
          validatedPkg = pkg;
          validatedMetadata = metadata;
          // Return deny to avoid triggering forwardReadOnly (which would try real network)
          return { status: 'deny', reason: 'test deny' };
        },
      },
      cache: new Map(),
    };
    const req = fakeReq('/debian/pool/main/l/libssl3/libssl3_3.0.11-1~deb12u2_arm64.deb');
    const res = fakeRes();

    await handleRegistryRequest(debianRegistry, req, res, 'deb.debian.org', 443, options);

    // Validator should have been called with the parsed package
    expect(validatedPkg).toEqual({
      registry: 'debian',
      name: 'libssl3',
      version: '3.0.11-1~deb12u2',
    });
    // Debian packages bypass quarantine via epoch publishedAt
    expect(validatedMetadata?.publishedAt).toEqual(new Date(0));
  });
});

// ── Cargo sparse-index path computation ─────────────────────────────

describe('cargoSparseIndexPath', () => {
  it('handles 1-char crate names', () => {
    expect(cargoSparseIndexPath('a')).toBe('1/a');
  });

  it('handles 2-char crate names', () => {
    expect(cargoSparseIndexPath('io')).toBe('2/io');
  });

  it('handles 3-char crate names', () => {
    expect(cargoSparseIndexPath('rmp')).toBe('3/r/rmp');
  });

  it('handles 4+ char crate names', () => {
    expect(cargoSparseIndexPath('serde')).toBe('se/rd/serde');
    expect(cargoSparseIndexPath('tokio')).toBe('to/ki/tokio');
  });

  it('lowercases the name', () => {
    expect(cargoSparseIndexPath('Serde')).toBe('se/rd/serde');
  });
});

// ── Cargo sparse-index URL parsing ──────────────────────────────────

describe('parseCargoSparseIndexUrl', () => {
  it('parses 4+ char crate path', () => {
    expect(parseCargoSparseIndexUrl('/se/rd/serde')).toEqual({ registry: 'cargo', name: 'serde' });
  });

  it('parses 3-char crate path', () => {
    expect(parseCargoSparseIndexUrl('/3/r/rmp')).toEqual({ registry: 'cargo', name: 'rmp' });
  });

  it('parses 2-char crate path', () => {
    expect(parseCargoSparseIndexUrl('/2/io')).toEqual({ registry: 'cargo', name: 'io' });
  });

  it('parses 1-char crate path', () => {
    expect(parseCargoSparseIndexUrl('/1/a')).toEqual({ registry: 'cargo', name: 'a' });
  });

  it('returns undefined for /config.json', () => {
    expect(parseCargoSparseIndexUrl('/config.json')).toBeUndefined();
  });

  it('returns undefined for root', () => {
    expect(parseCargoSparseIndexUrl('/')).toBeUndefined();
  });

  it('returns undefined when prefix does not match name', () => {
    // Wrong prefix for "serde" — should be /se/rd/serde
    expect(parseCargoSparseIndexUrl('/ab/cd/serde')).toBeUndefined();
  });

  it('returns undefined for invalid crate-name characters', () => {
    expect(parseCargoSparseIndexUrl('/se/rd/ser.de')).toBeUndefined();
  });

  it('strips query string', () => {
    expect(parseCargoSparseIndexUrl('/se/rd/serde?foo=bar')).toEqual({ registry: 'cargo', name: 'serde' });
  });
});

// ── Cargo download URL parsing ──────────────────────────────────────

describe('parseCargoDownloadUrl', () => {
  it('parses static.crates.io /crates/{name}/{version}/download', () => {
    expect(parseCargoDownloadUrl('/crates/serde/1.0.193/download')).toEqual({
      registry: 'cargo',
      name: 'serde',
      version: '1.0.193',
    });
  });

  it('parses crates.io API /api/v1/crates/{name}/{version}/download', () => {
    expect(parseCargoDownloadUrl('/api/v1/crates/tokio/1.35.1/download')).toEqual({
      registry: 'cargo',
      name: 'tokio',
      version: '1.35.1',
    });
  });

  it('parses /crates/{name}/{name}-{version}.crate', () => {
    expect(parseCargoDownloadUrl('/crates/serde/serde-1.0.193.crate')).toEqual({
      registry: 'cargo',
      name: 'serde',
      version: '1.0.193',
    });
  });

  it('handles pre-release versions', () => {
    expect(parseCargoDownloadUrl('/crates/tokio/1.0.0-rc.1/download')).toEqual({
      registry: 'cargo',
      name: 'tokio',
      version: '1.0.0-rc.1',
    });
  });

  it('handles underscores in crate names', () => {
    expect(parseCargoDownloadUrl('/crates/serde_json/1.0.108/download')).toEqual({
      registry: 'cargo',
      name: 'serde_json',
      version: '1.0.108',
    });
  });

  it('lowercases the crate name', () => {
    expect(parseCargoDownloadUrl('/crates/Inflector/0.11.4/download')?.name).toBe('inflector');
  });

  it('returns undefined for non-download paths', () => {
    expect(parseCargoDownloadUrl('/api/v1/crates/serde')).toBeUndefined();
    expect(parseCargoDownloadUrl('/api/v1/crates/serde/owners')).toBeUndefined();
    expect(parseCargoDownloadUrl('/')).toBeUndefined();
  });

  it('returns undefined when .crate filename does not match crate name', () => {
    expect(parseCargoDownloadUrl('/crates/serde/tokio-1.0.0.crate')).toBeUndefined();
  });

  it('parses canonical mixed-case .crate filenames', () => {
    expect(parseCargoDownloadUrl('/crates/Inflector/Inflector-0.11.4.crate')).toEqual({
      registry: 'cargo',
      name: 'inflector',
      version: '0.11.4',
    });
  });

  it('parses .crate when dir and filename case differ (case-insensitive prefix)', () => {
    expect(parseCargoDownloadUrl('/crates/Inflector/inflector-0.11.4.crate')).toEqual({
      registry: 'cargo',
      name: 'inflector',
      version: '0.11.4',
    });
  });
});

// ── Cargo sparse-index filtering ────────────────────────────────────

describe('filterCargoSparseIndex', () => {
  const oldDate = '2023-01-01T00:00:00Z';
  const newDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

  const ndjson =
    [
      JSON.stringify({ name: 'serde', vers: '1.0.100', cksum: 'a', yanked: false, pubtime: oldDate }),
      JSON.stringify({ name: 'serde', vers: '1.0.193', cksum: 'b', yanked: false, pubtime: oldDate }),
      JSON.stringify({ name: 'serde', vers: '1.0.999', cksum: 'c', yanked: false, pubtime: newDate }),
    ].join('\n') + '\n';

  it('filters out versions newer than quarantine period', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered, denied, allowedVersions } = filterCargoSparseIndex(ndjson, validator, 'serde');

    expect(filtered).toContain('"vers":"1.0.100"');
    expect(filtered).toContain('"vers":"1.0.193"');
    expect(filtered).not.toContain('"vers":"1.0.999"');
    expect(denied).toHaveLength(1);
    expect(denied[0].version).toBe('1.0.999');
    expect(allowedVersions).toEqual(new Set(['1.0.100', '1.0.193']));
  });

  it('outputs valid newline-delimited JSON', () => {
    const validator = createPackageValidator({ quarantineDays: 0 });
    const { filtered } = filterCargoSparseIndex(ndjson, validator, 'serde');

    const lines = filtered.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('treats missing pubtime as fail-closed under quarantine', () => {
    const noTime = JSON.stringify({ name: 'serde', vers: '2.0.0', cksum: 'd', yanked: false }) + '\n';
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { allowedVersions, denied } = filterCargoSparseIndex(noTime, validator, 'serde');

    expect(allowedVersions.size).toBe(0);
    expect(denied[0].reason).toContain('fail-closed');
  });

  it('drops unparseable lines (fail-closed)', () => {
    const garbage = '{"name":"serde","vers":"1.0.0","pubtime":"' + oldDate + '"}\nnot json\n';
    const validator = createPackageValidator({ quarantineDays: 0 });
    const { allowedVersions } = filterCargoSparseIndex(garbage, validator, 'serde');

    expect(allowedVersions).toEqual(new Set(['1.0.0']));
  });

  it('removes all versions for denylisted crates', () => {
    const validator = createPackageValidator({ deniedPackages: ['serde'] });
    const { allowedVersions, denied } = filterCargoSparseIndex(ndjson, validator, 'serde');

    expect(allowedVersions.size).toBe(0);
    expect(denied).toHaveLength(3);
  });
});

// ── Cargo handleRegistryRequest ─────────────────────────────────────

describe('handleRegistryRequest: cargo', () => {
  it('blocks .crate download not in allowed cache (tarball backstop)', async () => {
    const cache: AllowedVersionCache = new Map();
    setCachedVersions(cache, { registry: 'cargo', name: 'serde' }, new Set(['1.0.100']));

    const options: RegistryHandlerOptions = { validator: DENY_ALL_VALIDATOR, cache };
    const req = fakeReq('/crates/serde/1.0.999/download');
    const res = fakeRes();

    await handleRegistryRequest(cargoRegistry, req, res, 'static.crates.io', 443, options);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Forbidden');
    expect(res.body).toContain('serde');
  });

  it('blocks API download path on crates.io', async () => {
    const cache: AllowedVersionCache = new Map();
    setCachedVersions(cache, { registry: 'cargo', name: 'tokio' }, new Set(['1.0.0']));

    const options: RegistryHandlerOptions = { validator: DENY_ALL_VALIDATOR, cache };
    const req = fakeReq('/api/v1/crates/tokio/1.35.1/download');
    const res = fakeRes();

    await handleRegistryRequest(cargoRegistry, req, res, 'crates.io', 443, options);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('tokio');
  });

  it('fails closed on an unrecognized path on static.crates.io (no pass-through)', async () => {
    // static.crates.io is a pure tarball CDN — like files.pythonhosted.org it
    // must never pass a request straight upstream. An unparseable path is
    // denied rather than forwarded unvalidated.
    const options: RegistryHandlerOptions = { validator: DENY_ALL_VALIDATOR, cache: new Map() };
    const req = fakeReq('/some/unexpected/path');
    const res = fakeRes();

    await handleRegistryRequest(cargoRegistry, req, res, 'static.crates.io', 443, options);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Forbidden');
  });
});

// ── Debian plain-HTTP proxy path (URL rewrite from absolute to origin-form) ──
//
// When apt uses plain HTTP, the MITM proxy's outerServer.on('request') handler
// receives absolute-form URLs like "http://deb.debian.org/debian/pool/.../foo.deb".
// The fix in mitm-proxy.ts rewrites req.url to the origin-form path before
// calling dispatchRegistryRequest. These tests exercise handleRegistryRequest
// directly with origin-form paths (simulating the post-rewrite state) to verify
// that the registry handler applies denylist/allowlist + writes audit entries.
// This is the highest-fidelity layer the unit-test harness supports without
// spinning up a real HTTP server.

describe('handleRegistryRequest: debian plain-HTTP path (URL rewrite from absolute to origin-form)', () => {
  // Temp directory for audit log files; cleaned up after each test.
  let auditDir = '';

  afterEach(async () => {
    if (auditDir) {
      await fs.rm(auditDir, { recursive: true, force: true }).catch(() => undefined);
      auditDir = '';
    }
  });

  /**
   * Installs a one-shot https.request override so the next forwardReadOnly call
   * completes without a real network connection. The fake emits 'error', which
   * forwardReadOnly turns into a 502 — enough to prove "not denied (403)" and
   * that any audit entry was written before forwarding, with zero network I/O.
   */
  function mockUpstreamOnce(): void {
    vi.mocked(https.request).mockImplementationOnce((): http.ClientRequest => {
      const fake = new PassThrough() as unknown as http.ClientRequest;
      (fake as unknown as { setTimeout: () => void }).setTimeout = () => {};
      setImmediate(() => fake.emit('error', new Error('mock upstream (no network in tests)')));
      return fake;
    });
  }

  /** Reads a JSONL audit log and returns parsed entries. */
  async function readAuditEntries(auditLogPath: string): Promise<Record<string, unknown>[]> {
    const content = await fs.readFile(auditLogPath, 'utf-8').catch(() => '');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** Waits for at least one audit entry to appear in the log file. */
  async function waitForAuditEntry(auditLogPath: string, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const content = await fs.readFile(auditLogPath, 'utf-8').catch(() => '');
      if (content.trim()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('returns 403 and writes a deny audit entry for a denylisted .deb', async () => {
    auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ironcurtain-test-'));
    const auditLogPath = path.join(auditDir, 'pkg-audit.jsonl');

    const options: RegistryHandlerOptions = {
      validator: createPackageValidator({ deniedPackages: ['libssl3'] }),
      cache: new Map(),
      auditLogPath,
    };
    // Origin-form path — as mitm-proxy.ts produces after rewriting the absolute URL.
    const req = fakeReq('/debian/pool/main/l/libssl3/libssl3_3.0.11-1~deb12u2_arm64.deb');
    const res = fakeRes();

    await handleRegistryRequest(debianRegistry, req, res, 'deb.debian.org', 80, options);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Forbidden');
    expect(res.body).toContain('libssl3');

    await waitForAuditEntry(auditLogPath);
    const entries = await readAuditEntries(auditLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe('deny');
    expect(entries[0].packageName).toBe('libssl3');
    expect(entries[0].packageVersion).toBe('3.0.11-1~deb12u2');
    expect(entries[0].registry).toBe('debian');
    expect(entries[0].source).toBe('deb-backstop');
  });

  it('writes an allow audit entry for a permitted .deb (passes validation, not 403)', async () => {
    auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ironcurtain-test-'));
    const auditLogPath = path.join(auditDir, 'pkg-audit.jsonl');

    // Allow-all validator: quarantine-days=0, no denylist. The validator returns
    // 'allow', writeAuditEntry runs before forwardReadOnly. The mocked upstream
    // fails fast (502), but the audit entry is already committed.
    const options: RegistryHandlerOptions = {
      validator: createPackageValidator({ quarantineDays: 0 }),
      cache: new Map(),
      auditLogPath,
    };
    const req = fakeReq('/debian/pool/main/l/libssl3/libssl3_3.0.11-1~deb12u2_arm64.deb');
    const res = fakeRes();

    mockUpstreamOnce();
    await handleRegistryRequest(debianRegistry, req, res, 'deb.debian.org', 443, options);

    // Not denied — the mocked upstream yields 502, but never 403 (policy deny).
    expect(res.statusCode).not.toBe(403);

    await waitForAuditEntry(auditLogPath);
    const entries = await readAuditEntries(auditLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe('allow');
    expect(entries[0].packageName).toBe('libssl3');
    expect(entries[0].registry).toBe('debian');
    expect(entries[0].source).toBe('deb-backstop');
  });

  it('passes metadata requests (InRelease) without validation, auditing the pass-through', async () => {
    auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ironcurtain-test-'));
    const auditLogPath = path.join(auditDir, 'pkg-audit.jsonl');

    // DENY_ALL_VALIDATOR: if validation were applied, metadata would be denied.
    // Metadata (.../InRelease, Packages.gz, etc.) must pass through untouched.
    const options: RegistryHandlerOptions = {
      validator: DENY_ALL_VALIDATOR,
      cache: new Map(),
      auditLogPath,
    };
    // Origin-form path for a Release metadata file — not a .deb, so no validation.
    const req = fakeReq('/debian/dists/bookworm/InRelease');
    const res = fakeRes();

    mockUpstreamOnce();
    await handleRegistryRequest(debianRegistry, req, res, 'deb.debian.org', 443, options);

    // Metadata is never denied by the registry handler regardless of validator.
    expect(res.statusCode).not.toBe(403);

    // The pass-through itself is audited (method, host, path), with no package.
    await waitForAuditEntry(auditLogPath);
    const entries = await readAuditEntries(auditLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      registry: 'debian',
      method: 'GET',
      host: 'deb.debian.org',
      decision: 'allow',
      source: 'pass-through',
      requestPath: '/debian/dists/bookworm/InRelease',
    });
    expect(entries[0].packageName).toBeUndefined();
  });

  it('passes Packages.gz metadata without validation', async () => {
    const options: RegistryHandlerOptions = {
      validator: DENY_ALL_VALIDATOR,
      cache: new Map(),
    };
    const req = fakeReq('/debian/dists/bookworm/main/binary-arm64/Packages.gz');
    const res = fakeRes();

    mockUpstreamOnce();
    await handleRegistryRequest(debianRegistry, req, res, 'deb.debian.org', 443, options);

    // Metadata requests are forwarded upstream (not denied), so statusCode is not 403.
    expect(res.statusCode).not.toBe(403);
  });
});

// ── Canonical request paths through the real handler (EGR-1, EGR-2) ──
//
// These tests serve handleRegistryRequest on a loopback HTTP server so each
// request target reaches the handler exactly as sent, as it does from the
// MITM proxy's inner server. The upstream registry is a fake
// OutboundTransport that, like registry.npmjs.org and deb.debian.org, removes
// dot segments and percent-decodes the path before looking a resource up. A
// path the proxy forwarded without validating would be served here, just as
// the real registries served it during the audit.

/** One request the fake upstream registry received. */
interface UpstreamHit {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly headers: http.OutgoingHttpHeaders;
  /** Every request-body byte the proxy sent upstream (filled in as it arrives). */
  body: string;
}

function createFakeUpstream(
  resourceTable: Readonly<Record<string, string>>,
  options: {
    readonly serveEverything?: boolean;
    /**
     * Resolve like a servlet container: decode, drop each segment's `;`
     * parameters, then resolve dot segments, so `/-/..;/express` is `/express`.
     */
    readonly stripPathParameters?: boolean;
  } = {},
): { readonly transport: OutboundTransport; readonly hits: UpstreamHit[] } {
  const hits: UpstreamHit[] = [];
  const resources = new Map(Object.entries(resourceTable));
  const decodeOnce = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const resolveLikeRegistry = (requestPath: string): string => {
    let candidate = requestPath.split('?')[0];
    if (options.stripPathParameters === true) {
      candidate = decodeOnce(candidate)
        .split('/')
        .map((segment) => segment.split(';')[0])
        .join('/');
    }
    return decodeOnce(new URL(candidate, 'https://upstream.invalid').pathname);
  };
  const transport: OutboundTransport = {
    kind: 'direct',
    addressGuard: 'local-resolver',
    request(request, onResponse) {
      const hit: UpstreamHit = {
        method: request.method ?? 'GET',
        host: request.destination.hostname,
        path: request.path,
        headers: { ...request.headers },
        body: '',
      };
      hits.push(hit);
      const upstreamReq = new PassThrough();
      upstreamReq.on('data', (chunk: Buffer) => {
        hit.body += chunk.toString();
      });
      Object.assign(upstreamReq, { setTimeout: () => upstreamReq });
      upstreamReq.on('finish', () => {
        const resource = resources.get(resolveLikeRegistry(request.path));
        const body = resource ?? (options.serveEverything === true ? 'UPSTREAM-FILE' : undefined);
        const upstreamRes = new PassThrough();
        Object.assign(upstreamRes, {
          statusCode: body === undefined ? 404 : 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
        onResponse?.(upstreamRes as unknown as http.IncomingMessage);
        upstreamRes.end(body ?? 'not found');
      });
      return upstreamReq as unknown as http.ClientRequest;
    },
  };
  return { transport, hits };
}

interface RegistryResponse {
  readonly status: number;
  readonly body: string;
}

interface RegistryClientRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: http.OutgoingHttpHeaders;
  /** Sent with `Content-Length` unless the headers ask for chunked encoding. */
  readonly body?: string;
}

interface RegistryServer {
  get(requestTarget: string): Promise<RegistryResponse>;
  send(request: RegistryClientRequest): Promise<RegistryResponse>;
  close(): Promise<void>;
}

async function startRegistryServer(
  registry: RegistryConfig,
  upstreamHost: string,
  options: RegistryHandlerOptions,
): Promise<RegistryServer> {
  const server = http.createServer((req, res) => {
    handleRegistryRequest(registry, req, res, upstreamHost, 443, options).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const send = (request: RegistryClientRequest): Promise<RegistryResponse> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: request.path, method: request.method, headers: request.headers, agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on('error', reject);
      req.end(request.body);
    });
  return {
    get: (requestTarget) => send({ method: 'GET', path: requestTarget }),
    send,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Polls a JSONL audit log until it holds at least `count` entries (or the deadline passes). */
async function readAuditLog(
  auditLogPath: string,
  count: number,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await fs.readFile(auditLogPath, 'utf-8').catch(() => '');
    const entries = content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (entries.length >= count || Date.now() > deadline) return entries;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const OLD_DATE = '2020-01-01T00:00:00.000Z';

function packumentJson(name: string, versions: readonly string[]): string {
  return JSON.stringify({
    name,
    versions: Object.fromEntries(versions.map((version) => [version, { name, version }])),
    'dist-tags': { latest: versions[versions.length - 1] },
    time: { created: OLD_DATE, modified: OLD_DATE, ...Object.fromEntries(versions.map((v) => [v, OLD_DATE])) },
  });
}

const NPM_UPSTREAM_RESOURCES: Readonly<Record<string, string>> = {
  '/express': packumentJson('express', ['4.18.2']),
  '/express/-/express-4.18.2.tgz': 'EXPRESS-TARBALL',
  '/@types/node': packumentJson('@types/node', ['20.0.0']),
  '/@types/node/-/node-20.0.0.tgz': 'TYPES-NODE-TARBALL',
  '/JSONStream': packumentJson('JSONStream', ['1.3.5']),
  '/-/ping': '{}',
};

describe('handleRegistryRequest: npm request paths are canonical (EGR-1)', () => {
  const servers: RegistryServer[] = [];
  let auditDir = '';

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    if (auditDir) {
      await fs.rm(auditDir, { recursive: true, force: true });
      auditDir = '';
    }
  });

  async function startNpm(validatorConfig: Parameters<typeof createPackageValidator>[0]) {
    auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ironcurtain-registry-path-'));
    const auditLogPath = path.join(auditDir, 'package-audit.jsonl');
    const upstream = createFakeUpstream(NPM_UPSTREAM_RESOURCES);
    const server = await startRegistryServer(npmRegistry, 'registry.npmjs.org', {
      validator: createPackageValidator(validatorConfig),
      cache: new Map(),
      auditLogPath,
      outboundTransport: upstream.transport,
    });
    servers.push(server);
    return { server, hits: upstream.hits, auditLogPath };
  }

  it('control: denies the denylisted tarball requested canonically', async () => {
    const { server, hits } = await startNpm({ deniedPackages: ['express'], quarantineDays: 0 });

    const res = await server.get('/express/-/express-4.18.2.tgz');

    expect(res.status).toBe(403);
    expect(res.body).toContain('deny list');
    // Only the metadata lookup reached upstream, never the tarball.
    expect(hits.map((hit) => hit.path)).toEqual(['/express']);
  });

  it.each([
    '/@x/../express/-/express-4.18.2.tgz',
    '/@x/../express',
    '/-/../express/-/express-4.18.2.tgz',
    '/-/../express',
    '/express/x/..',
    '/@x/%2e%2e/express/-/express-4.18.2.tgz',
    '/-/%2E%2E/express',
    '/@x%2f..%2fexpress/-/express-4.18.2.tgz',
    '/@x/..%2fexpress',
    '/@x\\..\\express/-/express-4.18.2.tgz',
    '//registry.npmjs.org/express',
  ])('refuses %s with 403 before anything reaches upstream', async (requestTarget) => {
    const { server, hits, auditLogPath } = await startNpm({ deniedPackages: ['express'], quarantineDays: 100_000 });

    const res = await server.get(requestTarget);

    expect(res.status).toBe(403);
    expect(res.body).toContain('Forbidden');
    expect(hits).toEqual([]);
    const entries = await readAuditLog(auditLogPath, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      registry: 'npm',
      decision: 'deny',
      source: 'request-path',
      requestPath: requestTarget,
    });
    expect(entries[0].packageName).toBeUndefined();
  });

  it('validates the decoded identity of a percent-encoded package name', async () => {
    const { server, hits, auditLogPath } = await startNpm({ deniedPackages: ['express'], quarantineDays: 0 });

    const res = await server.get('/%65xpress/-/%65xpress-4.18.2.tgz');

    expect(res.status).toBe(403);
    expect(hits.map((hit) => hit.path)).toEqual(['/express']);
    const entries = await readAuditLog(auditLogPath, 1);
    expect(entries[0]).toMatchObject({ packageName: 'express', decision: 'deny', source: 'tarball-backstop' });
  });

  it.each([
    ['an underscore-leading name', '/_express'],
    ['a dot-leading name', '/.express'],
    ['a scoped name with two slashes', '/@x/a/b'],
    ['a trailing slash', '/express/'],
    ['a version manifest path', '/express/4.18.2'],
  ])('refuses %s instead of passing it through unfiltered', async (_label, requestTarget) => {
    const { server, hits } = await startNpm({ quarantineDays: 0 });

    const res = await server.get(requestTarget);

    expect(res.status).toBe(403);
    expect(res.body).toContain('Forbidden');
    expect(hits).toEqual([]);
  });

  it('denies a tarball-shaped path whose package name is invalid (tarball backstop)', async () => {
    const { server, hits } = await startNpm({ quarantineDays: 0 });

    const res = await server.get('/@x/_y/-/_y-1.0.0.tgz');

    expect(res.status).toBe(403);
    expect(res.body).toContain('unable to identify package');
    expect(hits).toEqual([]);
  });

  it('fetches metadata at the canonical path rebuilt from the validated identity', async () => {
    const { server, hits } = await startNpm({ quarantineDays: 0 });

    const scoped = await server.get('/@types/node?write=true');
    const encoded = await server.get('/%40types%2Fnode');
    const legacy = await server.get('/JSONStream');

    expect(scoped.status).toBe(200);
    expect((JSON.parse(scoped.body) as NpmPackument).versions).toHaveProperty('20.0.0');
    expect(encoded.status).toBe(200);
    expect(legacy.status).toBe(200);
    expect(hits.map((hit) => hit.path)).toEqual(['/@types%2fnode', '/@types%2fnode', '/JSONStream']);
  });

  it('forwards an allowed tarball at the canonical path, never the client spelling', async () => {
    const { server, hits } = await startNpm({ quarantineDays: 0 });

    const res = await server.get('/@types%2fnode/-/node-20.0.0.tgz?cache=bust');

    expect(res.status).toBe(200);
    expect(res.body).toBe('TYPES-NODE-TARBALL');
    expect(hits.map((hit) => hit.path)).toEqual(['/@types%2fnode', '/@types/node/-/node-20.0.0.tgz']);
  });

  it('still passes npm internal endpoints through', async () => {
    const { server, hits } = await startNpm({ quarantineDays: 0 });

    const res = await server.get('/-/ping?write=true');

    expect(res.status).toBe(200);
    expect(hits.map((hit) => hit.path)).toEqual(['/-/ping?write=true']);
  });

  // `..;` is not a dot segment to WHATWG, but a servlet container drops the
  // `;` parameter and resolves it as `..`. Under the raw `/-/` pass-through,
  // `/-/..;/express` would then reach the unfiltered `express` packument.
  it.each(['/-/..;/express', '/-/x/..;/..;/express', '/-/..%3b/express', '/-/..;jsessionid=x/express'])(
    'refuses %s even against an upstream that resolves `..;` as `..`',
    async (requestTarget) => {
      auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ironcurtain-registry-path-'));
      const auditLogPath = path.join(auditDir, 'package-audit.jsonl');
      const upstream = createFakeUpstream(NPM_UPSTREAM_RESOURCES, { stripPathParameters: true });
      const server = await startRegistryServer(npmRegistry, 'registry.npmjs.org', {
        validator: createPackageValidator({ deniedPackages: ['express'], quarantineDays: 100_000 }),
        cache: new Map(),
        auditLogPath,
        outboundTransport: upstream.transport,
      });
      servers.push(server);

      const res = await server.get(requestTarget);

      expect(res.status).toBe(403);
      expect(upstream.hits).toEqual([]);
      const entries = await readAuditLog(auditLogPath, 1);
      expect(entries[0]).toMatchObject({ registry: 'npm', decision: 'deny', source: 'request-path' });
    },
  );
});

describe('handleRegistryRequest: Debian file names are decoded once (EGR-2)', () => {
  const servers: RegistryServer[] = [];
  let auditDir = '';

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    if (auditDir) {
      await fs.rm(auditDir, { recursive: true, force: true });
      auditDir = '';
    }
  });

  async function startDebian(validatorConfig: Parameters<typeof createPackageValidator>[0]) {
    auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ironcurtain-registry-path-'));
    const auditLogPath = path.join(auditDir, 'package-audit.jsonl');
    const upstream = createFakeUpstream({}, { serveEverything: true });
    const server = await startRegistryServer(debianRegistry, 'deb.debian.org', {
      validator: createPackageValidator(validatorConfig),
      cache: new Map(),
      auditLogPath,
      outboundTransport: upstream.transport,
    });
    servers.push(server);
    return { server, hits: upstream.hits, auditLogPath };
  }

  const NETCAT_DIR = '/debian/pool/main/n/netcat';
  const denylist = { deniedPackages: ['netcat-traditional', 'g++-12'] };

  it.each([
    ['plain name (control)', `${NETCAT_DIR}/netcat-traditional_1.10-47_amd64.deb`],
    ['%6E in the name', `${NETCAT_DIR}/%6Eetcat-traditional_1.10-47_amd64.deb`],
    ['a fully encoded name', `${NETCAT_DIR}/%6E%65%74%63%61%74-traditional_1.10-47_amd64.deb`],
    ['an encoded extension letter (.d%65b)', `${NETCAT_DIR}/netcat-traditional_1.10-47_amd64.d%65b`],
  ])('denies a denylisted package requested with %s, auditing the decoded name', async (_label, requestTarget) => {
    const { server, hits, auditLogPath } = await startDebian(denylist);

    const res = await server.get(requestTarget);

    expect(res.status).toBe(403);
    expect(res.body).toContain('netcat-traditional');
    expect(hits).toEqual([]);
    const entries = await readAuditLog(auditLogPath, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      registry: 'debian',
      packageName: 'netcat-traditional',
      packageVersion: '1.10-47',
      decision: 'deny',
      source: 'deb-backstop',
      requestPath: requestTarget,
    });
  });

  it.each([
    `${NETCAT_DIR}/netcat-traditional_1.10-47_amd64%2Edeb`,
    `${NETCAT_DIR}/netcat-traditional_1.10-47_amd64%2edeb`,
  ])('refuses an encoded extension dot %s and audits the refusal', async (requestTarget) => {
    const { server, hits, auditLogPath } = await startDebian(denylist);

    const res = await server.get(requestTarget);

    expect(res.status).toBe(403);
    expect(hits).toEqual([]);
    const entries = await readAuditLog(auditLogPath, 1);
    expect(entries[0]).toMatchObject({
      registry: 'debian',
      decision: 'deny',
      source: 'request-path',
      requestPath: requestTarget,
    });
  });

  it("denies apt's g%2b%2b-12 spelling when g++-12 is denylisted, auditing the decoded name", async () => {
    const { server, hits, auditLogPath } = await startDebian(denylist);
    const requestTarget = '/debian/pool/main/g/gcc-12/g%2b%2b-12_12.2.0-14_amd64.deb';

    const res = await server.get(requestTarget);

    expect(res.status).toBe(403);
    expect(hits).toEqual([]);
    const entries = await readAuditLog(auditLogPath, 1);
    expect(entries[0]).toMatchObject({
      packageName: 'g++-12',
      packageVersion: '12.2.0-14',
      decision: 'deny',
      requestPath: requestTarget,
    });
  });

  it("allows an apt-quoted package that is not denylisted and forwards apt's own spelling", async () => {
    const { server, hits, auditLogPath } = await startDebian(denylist);
    const requestTarget = '/debian/pool/main/g/gcc-12/libstdc%2b%2b6_12.2.0-14%7edeb12u1_amd64.deb';

    const res = await server.get(requestTarget);

    expect(res.status).toBe(200);
    expect(hits.map((hit) => hit.path)).toEqual([requestTarget]);
    const entries = await readAuditLog(auditLogPath, 1);
    expect(entries[0]).toMatchObject({
      packageName: 'libstdc++6',
      packageVersion: '12.2.0-14~deb12u1',
      decision: 'allow',
    });
  });

  it.each([
    ['a source package under pool/', `${NETCAT_DIR}/netcat_1.10-47.dsc`],
    ['a udeb under pool/', `${NETCAT_DIR}/netcat-udeb_1.10-47_amd64.udeb`],
    ['a pool/ directory listing', `${NETCAT_DIR}/`],
    ['an unparseable .deb', `${NETCAT_DIR}/Netcat-traditional_1.10-47_amd64.deb`],
    ['a double-encoded name', '/debian/pool/main/g/gcc-12/g%252b%252b-12_12.2.0-14_amd64.deb'],
    ['malformed encoding', `${NETCAT_DIR}/netcat%E0%A4_1.10-47_amd64.deb`],
    ['a path outside dists/ and pool/', '/debian/README'],
    ['a dot-segment escape from dists/', '/debian/dists/../pool/main/n/netcat/netcat-traditional_1.10-47_amd64.deb'],
  ])('refuses %s without forwarding it', async (_label, requestTarget) => {
    const { server, hits, auditLogPath } = await startDebian({ quarantineDays: 0 });

    const res = await server.get(requestTarget);

    expect(res.status).toBe(403);
    expect(hits).toEqual([]);
    const entries = await readAuditLog(auditLogPath, 1);
    expect(entries[0]).toMatchObject({ registry: 'debian', decision: 'deny', source: 'request-path' });
  });

  it.each([
    '/debian/dists/bookworm/InRelease',
    '/debian/dists/bookworm/main/binary-amd64/Packages.xz',
    `/debian-security/dists/bookworm-security/main/binary-amd64/by-hash/SHA256/${'b'.repeat(64)}`,
  ])('passes allowlisted metadata %s through unvalidated, auditing the pass-through', async (requestTarget) => {
    // A deny-everything validator proves metadata never reaches the validator.
    auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ironcurtain-registry-path-'));
    const auditLogPath = path.join(auditDir, 'package-audit.jsonl');
    const upstream = createFakeUpstream({}, { serveEverything: true });
    const server = await startRegistryServer(debianRegistry, 'deb.debian.org', {
      validator: DENY_ALL_VALIDATOR,
      cache: new Map(),
      auditLogPath,
      outboundTransport: upstream.transport,
    });
    servers.push(server);

    const res = await server.get(requestTarget);

    expect(res.status).toBe(200);
    expect(upstream.hits.map((hit) => hit.path)).toEqual([requestTarget]);
    const entries = await readAuditLog(auditLogPath, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      registry: 'debian',
      method: 'GET',
      host: 'deb.debian.org',
      decision: 'allow',
      source: 'pass-through',
      requestPath: requestTarget,
    });
  });
});

describe('handleRegistryRequest: the request-path gate covers every registry type', () => {
  const servers: RegistryServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it.each<[RegistryConfig, string, string]>([
    [pypiRegistry, 'files.pythonhosted.org', '/packages/aa/../bb/numpy-1.26.0.tar.gz'],
    [pypiRegistry, 'pypi.org', '/simple/x/../numpy/'],
    [pypiRegistry, 'pypi.org', '/pypi/%2e%2e/json'],
    [cargoRegistry, 'crates.io', '/api/v1/crates/../crates/serde/1.0.0/download'],
    [cargoRegistry, 'index.crates.io', '/se/rd/../rd/serde'],
    [cargoRegistry, 'static.crates.io', '/crates/serde/serde-1.0.0.crate%2f..'],
  ])('refuses a non-canonical %s path on %s: %s', async (registry, host, requestTarget) => {
    const upstream = createFakeUpstream({}, { serveEverything: true });
    const server = await startRegistryServer(registry, host, {
      validator: createPackageValidator({ quarantineDays: 0 }),
      cache: new Map(),
      outboundTransport: upstream.transport,
    });
    servers.push(server);

    const res = await server.get(requestTarget);

    expect(res.status).toBe(403);
    expect(upstream.hits).toEqual([]);
  });
});

// ── Read-only gate, route allowlist and credential stripping (EGR-3) ──
//
// The audit found that every request the handler did not recognise was
// forwarded with the client's method, all of its headers and its body: a
// crate publish, an npm dist-tag or packument write, a profile POST, a PyPI
// login. None of it was audited, and an npm publish (`PUT /<pkg>`) was even
// answered 200 from a GET of the packument.

describe('classifyRegistryRoute', () => {
  const NPM = 'registry.npmjs.org';
  const FILES = 'files.pythonhosted.org';
  const SDIST = '/packages/aa/bb/0123456789abcdef/numpy-1.26.0.tar.gz';

  it.each<[string, string, RegistryRoute['kind'], RegistryConfig]>([
    // npm: packages, tarballs, and three read-only endpoints.
    [NPM, '/express', 'npm-metadata', npmRegistry],
    [NPM, '/@types%2fnode', 'npm-metadata', npmRegistry],
    [NPM, '/express/-/express-4.18.2.tgz', 'artifact', npmRegistry],
    [NPM, '/express/-/not-a-tarball', 'artifact', npmRegistry],
    [NPM, '/-/ping?write=true', 'read-only', npmRegistry],
    [NPM, '/-/v1/search?text=express&size=20', 'read-only', npmRegistry],
    [NPM, '/-/package/express/dist-tags', 'read-only', npmRegistry],
    [NPM, '/-/package/@types%2fnode/dist-tags', 'read-only', npmRegistry],
    [NPM, '/-/package/@types/node/dist-tags', 'read-only', npmRegistry],
    [NPM, '/', 'refused', npmRegistry],
    [NPM, '/-/whoami', 'refused', npmRegistry],
    [NPM, '/-/all', 'refused', npmRegistry],
    [NPM, '/-/npm/v1/security/advisories/bulk', 'refused', npmRegistry],
    [NPM, '/-/npm/v1/security/audits/quick', 'refused', npmRegistry],
    [NPM, '/-/npm/v1/user', 'refused', npmRegistry],
    [NPM, '/-/npm/v1/tokens', 'refused', npmRegistry],
    [NPM, '/-/npm/v1/keys', 'refused', npmRegistry],
    [NPM, '/-/v1/login', 'refused', npmRegistry],
    [NPM, '/-/user/org.couchdb.user:attacker', 'refused', npmRegistry],
    [NPM, '/-/package/express/dist-tags/latest', 'refused', npmRegistry],
    [NPM, '/-/package/express/collaborators', 'refused', npmRegistry],
    [NPM, '/-/package/_express/dist-tags', 'refused', npmRegistry],
    [NPM, '/-/package/a/b/dist-tags', 'refused', npmRegistry],
    [NPM, '/express/-rev/1-abc', 'refused', npmRegistry],
    // PyPI: the simple index and the JSON API on pypi.org; files under /packages/.
    ['pypi.org', '/simple/numpy/', 'pypi-simple', pypiRegistry],
    ['pypi.org', '/pypi/numpy/json', 'read-only', pypiRegistry],
    ['pypi.org', '/pypi/Django/4.2.7/json', 'read-only', pypiRegistry],
    ['pypi.org', '/pypi/zope.interface/6.0/json', 'read-only', pypiRegistry],
    ['pypi.org', '/', 'refused', pypiRegistry],
    ['pypi.org', '/simple/', 'refused', pypiRegistry],
    ['pypi.org', '/account/login/', 'refused', pypiRegistry],
    ['pypi.org', '/legacy/', 'refused', pypiRegistry],
    ['pypi.org', '/manage/projects/', 'refused', pypiRegistry],
    ['pypi.org', '/pypi', 'refused', pypiRegistry],
    ['pypi.org', '/pypi/numpy', 'refused', pypiRegistry],
    ['pypi.org', '/pypi/numpy/json/extra', 'refused', pypiRegistry],
    ['pypi.org', SDIST, 'refused', pypiRegistry],
    [FILES, SDIST, 'artifact', pypiRegistry],
    [FILES, '/simple/numpy/', 'refused', pypiRegistry],
    [FILES, '/', 'refused', pypiRegistry],
    // Debian: .deb packages and dists/ metadata.
    ['deb.debian.org', '/debian/dists/bookworm/InRelease', 'read-only', debianRegistry],
    ['security.debian.org', '/debian-security/dists/bookworm-security/InRelease', 'read-only', debianRegistry],
    ['deb.debian.org', '/debian/pool/main/c/curl/curl_7.88.1-10_amd64.deb', 'debian-package', debianRegistry],
    ['deb.debian.org', '/debian/README', 'refused', debianRegistry],
    // crates.io: index files and config.json, downloads, and cargo search.
    ['index.crates.io', '/config.json', 'read-only', cargoRegistry],
    ['index.crates.io', '/se/rd/serde', 'cargo-index', cargoRegistry],
    ['index.crates.io', '/api/v1/crates', 'refused', cargoRegistry],
    ['static.crates.io', '/crates/serde/serde-1.0.0.crate', 'artifact', cargoRegistry],
    ['static.crates.io', '/api/v1/crates/serde/1.0.0/download', 'refused', cargoRegistry],
    ['static.crates.io', '/', 'refused', cargoRegistry],
    ['crates.io', '/api/v1/crates/serde/1.0.0/download', 'artifact', cargoRegistry],
    ['crates.io', '/api/v1/crates?q=serde&per_page=10', 'read-only', cargoRegistry],
    ['crates.io', '/api/v1/crates/new', 'refused', cargoRegistry],
    ['crates.io', '/api/v1/crates/serde', 'refused', cargoRegistry],
    ['crates.io', '/api/v1/crates/serde/owners', 'refused', cargoRegistry],
    ['crates.io', '/api/v1/crates/foo/1.0.0/yank', 'refused', cargoRegistry],
    ['crates.io', '/api/v1/me', 'refused', cargoRegistry],
    ['crates.io', '/crates/serde/1.0.0/download', 'refused', cargoRegistry],
    ['crates.io', '/', 'refused', cargoRegistry],
    // A host the registry does not serve.
    ['pypi.org', '/express', 'refused', npmRegistry],
  ])('%s %s routes to %s', (host, requestTarget, kind, registry) => {
    // Every row is a canonical path, so the route allowlist is what decides.
    expect(checkRegistryRequestPath(registry.type, requestTarget)).toEqual({ ok: true });
    expect(classifyRegistryRoute(registry, host, requestTarget).kind).toBe(kind);
  });
});

/** Every credential header the strict package listener refuses, plus npm's own `npm-*` headers. */
const CLIENT_CREDENTIAL_HEADERS: Readonly<Record<string, string>> = {
  ...Object.fromEntries([...CREDENTIAL_HEADERS].map((name) => [name, `SECRET-${name}`])),
  'npm-otp': 'SECRET-OTP',
  'npm-session': 'SECRET-SESSION',
  'npm-command': 'install',
  'npm-auth-type': 'web',
  'npm-scope': '@acme',
};

/** Fails if any upstream request carried a body, a non-read method, or a credential or npm-* header. */
function expectCredentialFreeReads(hits: readonly UpstreamHit[]): void {
  for (const hit of hits) {
    expect(['GET', 'HEAD'], hit.path).toContain(hit.method);
    expect(hit.body, hit.path).toBe('');
    for (const name of Object.keys(hit.headers)) {
      expect(CREDENTIAL_HEADERS.has(name.toLowerCase()), `${hit.path}: ${name}`).toBe(false);
      expect(name.toLowerCase().startsWith('npm-'), `${hit.path}: ${name}`).toBe(false);
    }
    expect(JSON.stringify(hit.headers), hit.path).not.toContain('SECRET');
  }
}

const NUMPY_SDIST = '/packages/aa/bb/0123456789abcdef/numpy-1.26.0.tar.gz';
const CURL_DEB = '/debian/pool/main/c/curl/curl_7.88.1-10_amd64.deb';

/** Upstream fixtures for one install per registry, plus the read-only APIs kept by the owner decision. */
const INSTALL_RESOURCES: Readonly<Record<string, string>> = {
  '/express': packumentJson('express', ['4.18.2']),
  '/express/-/express-4.18.2.tgz': 'EXPRESS-TARBALL',
  // A packument that lists no version, and JSON that is no packument at all.
  '/unpublished': packumentJson('unpublished', []),
  '/not-a-packument': '{"error":"unexpected"}',
  '/-/ping': '{}',
  '/-/v1/search': '{"objects":[],"total":0}',
  '/-/package/express/dist-tags': '{"latest":"4.18.2"}',
  '/simple/numpy/':
    '<!DOCTYPE html><html><body>' +
    `<a href="https://files.pythonhosted.org${NUMPY_SDIST}#sha256=00">numpy-1.26.0.tar.gz</a>` +
    '</body></html>',
  // Like the real JSON API, each file record carries its own URL and upload time.
  '/pypi/numpy/json': JSON.stringify({
    releases: {
      '1.26.0': [
        {
          filename: 'numpy-1.26.0.tar.gz',
          url: `https://files.pythonhosted.org${NUMPY_SDIST}`,
          upload_time_iso_8601: OLD_DATE,
        },
      ],
    },
  }),
  [NUMPY_SDIST]: 'NUMPY-SDIST',
  '/config.json': '{"dl":"https://static.crates.io/crates","api":"https://crates.io"}',
  '/se/rd/serde': `${JSON.stringify({ name: 'serde', vers: '1.0.0', deps: [], cksum: '00', pubtime: OLD_DATE })}\n`,
  '/crates/serde/serde-1.0.0.crate': 'SERDE-CRATE',
  '/api/v1/crates': '{"crates":[],"meta":{"total":0}}',
  '/debian/dists/bookworm/InRelease': 'SIGNED-RELEASE',
  '/debian/dists/bookworm/main/binary-amd64/Packages.xz': 'PACKAGES-INDEX',
  [CURL_DEB]: 'CURL-DEB',
};

describe('handleRegistryRequest: the registry proxy is read-only (EGR-3)', () => {
  const servers: RegistryServer[] = [];
  let auditDir = '';

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    if (auditDir) {
      await fs.rm(auditDir, { recursive: true, force: true });
      auditDir = '';
    }
  });

  interface ProxyFixture {
    /** The proxy listener for one registry host. */
    at(host: string): RegistryServer;
    readonly hits: UpstreamHit[];
    readonly auditLogPath: string;
  }

  /** One proxy listener per host, sharing a validator, version cache, audit log and fake upstream. */
  async function startProxy(
    hosts: ReadonlyArray<readonly [RegistryConfig, string]>,
    options: { readonly outboundTransport?: OutboundTransport } = {},
  ): Promise<ProxyFixture> {
    auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ironcurtain-registry-gate-'));
    const auditLogPath = path.join(auditDir, 'package-audit.jsonl');
    const upstream = createFakeUpstream(INSTALL_RESOURCES);
    const handlerOptions: RegistryHandlerOptions = {
      validator: createPackageValidator({ quarantineDays: 2 }),
      cache: new Map(),
      auditLogPath,
      outboundTransport: options.outboundTransport ?? upstream.transport,
    };
    const byHost = new Map<string, RegistryServer>();
    for (const [registry, host] of hosts) {
      const server = await startRegistryServer(registry, host, handlerOptions);
      servers.push(server);
      byHost.set(host, server);
    }
    return {
      at(host) {
        const server = byHost.get(host);
        if (server === undefined) throw new Error(`no proxy listener for ${host}`);
        return server;
      },
      hits: upstream.hits,
      auditLogPath,
    };
  }

  const STOLEN = 'STOLEN-WORKSPACE-DATA';

  it.each<[string, RegistryConfig, string, RegistryClientRequest]>([
    [
      'an npm publish',
      npmRegistry,
      'registry.npmjs.org',
      {
        method: 'PUT',
        path: '/express',
        headers: { authorization: 'Bearer npm_ATTACKER', 'content-type': 'application/json', 'npm-otp': 'OTP-SECRET' },
        body: JSON.stringify({ name: 'express', versions: { '9.9.9': { readme: STOLEN } } }),
      },
    ],
    ['a scoped npm publish', npmRegistry, 'registry.npmjs.org', { method: 'PUT', path: '/@acme%2fleak', body: STOLEN }],
    [
      'an npm dist-tag write',
      npmRegistry,
      'registry.npmjs.org',
      { method: 'PUT', path: '/-/package/express/dist-tags/latest', body: '"9.9.9"' },
    ],
    [
      'an npm dist-tag removal',
      npmRegistry,
      'registry.npmjs.org',
      { method: 'DELETE', path: '/-/package/express/dist-tags/beta' },
    ],
    [
      'an npm packument rewrite',
      npmRegistry,
      'registry.npmjs.org',
      { method: 'PUT', path: '/express/-rev/1-abc', body: STOLEN },
    ],
    [
      'an npm unpublish',
      npmRegistry,
      'registry.npmjs.org',
      { method: 'DELETE', path: '/express/-/express-4.18.2.tgz/-rev/1-abc' },
    ],
    [
      'an npm profile write',
      npmRegistry,
      'registry.npmjs.org',
      { method: 'POST', path: '/-/npm/v1/user', body: STOLEN },
    ],
    [
      'an npm login',
      npmRegistry,
      'registry.npmjs.org',
      { method: 'PUT', path: '/-/user/org.couchdb.user:attacker', body: STOLEN },
    ],
    [
      "npm audit's bulk advisory POST",
      npmRegistry,
      'registry.npmjs.org',
      { method: 'POST', path: '/-/npm/v1/security/advisories/bulk', body: '{"express":["4.18.2"]}' },
    ],
    [
      "npm audit's quick-audit fallback",
      npmRegistry,
      'registry.npmjs.org',
      { method: 'POST', path: '/-/npm/v1/security/audits/quick', body: '{}' },
    ],
    ['an npm PATCH', npmRegistry, 'registry.npmjs.org', { method: 'PATCH', path: '/express', body: '{}' }],
    ['an OPTIONS probe', npmRegistry, 'registry.npmjs.org', { method: 'OPTIONS', path: '/express' }],
    [
      'a cargo publish',
      cargoRegistry,
      'crates.io',
      { method: 'PUT', path: '/api/v1/crates/new', headers: { authorization: 'cio-ATTACKER-TOKEN' }, body: STOLEN },
    ],
    [
      'a cargo yank',
      cargoRegistry,
      'crates.io',
      { method: 'DELETE', path: '/api/v1/crates/foo/1.0.0/yank', headers: { authorization: 'cio-ATTACKER-TOKEN' } },
    ],
    ['a cargo unyank', cargoRegistry, 'crates.io', { method: 'PUT', path: '/api/v1/crates/foo/1.0.0/unyank' }],
    [
      'a POST to the sparse index',
      cargoRegistry,
      'index.crates.io',
      { method: 'POST', path: '/config.json', body: STOLEN },
    ],
    [
      'a PyPI login form',
      pypiRegistry,
      'pypi.org',
      {
        method: 'POST',
        path: '/account/login/',
        headers: { cookie: 'session_id=ATTACKER', 'content-type': 'application/x-www-form-urlencoded' },
        body: `username=attacker&password=${STOLEN}`,
      },
    ],
    ['a POST to the simple index', pypiRegistry, 'pypi.org', { method: 'POST', path: '/simple/numpy/', body: STOLEN }],
    [
      'a POST to the PyPI file host',
      pypiRegistry,
      'files.pythonhosted.org',
      { method: 'POST', path: NUMPY_SDIST, body: STOLEN },
    ],
    [
      'a POST to a Debian mirror',
      debianRegistry,
      'deb.debian.org',
      { method: 'POST', path: '/debian/dists/bookworm/InRelease', body: STOLEN },
    ],
  ])('refuses %s with 403 before anything reaches upstream, and audits it', async (_label, registry, host, request) => {
    const proxy = await startProxy([[registry, host]]);

    const res = await proxy.at(host).send(request);

    expect(res.status).toBe(403);
    expect(res.body).toContain('read-only: only GET and HEAD are allowed');
    expect(proxy.hits).toEqual([]);
    const entries = await readAuditLog(proxy.auditLogPath, 1);
    expect(entries).toEqual([
      expect.objectContaining({
        registry: registry.type,
        method: request.method,
        host,
        requestPath: request.path,
        decision: 'deny',
        source: 'request-gate',
      }),
    ]);
    // The audit records the method, host and path, never a header value or the body.
    expect(JSON.stringify(entries)).not.toMatch(/ATTACKER|STOLEN|OTP-SECRET/);
  });

  it.each<[string, http.OutgoingHttpHeaders]>([
    // Node's client sends a GET body unframed unless the length is set explicitly.
    ['a Content-Length body', { 'content-length': String(Buffer.byteLength(STOLEN)) }],
    ['a chunked body', { 'transfer-encoding': 'chunked' }],
  ])('refuses a GET that carries %s', async (_label, headers) => {
    const proxy = await startProxy([[npmRegistry, 'registry.npmjs.org']]);

    const res = await proxy.at('registry.npmjs.org').send({ method: 'GET', path: '/-/ping', headers, body: STOLEN });

    expect(res.status).toBe(403);
    expect(res.body).toContain('request bodies are refused');
    expect(proxy.hits).toEqual([]);
    const entries = await readAuditLog(proxy.auditLogPath, 1);
    expect(entries[0]).toMatchObject({
      method: 'GET',
      requestPath: '/-/ping',
      decision: 'deny',
      source: 'request-gate',
    });
  });

  it.each<[string, string, RegistryConfig]>([
    ['registry.npmjs.org', '/', npmRegistry],
    ['registry.npmjs.org', '/-/whoami', npmRegistry],
    ['registry.npmjs.org', '/-/npm/v1/keys', npmRegistry],
    ['registry.npmjs.org', '/-/npm/v1/security/advisories/bulk', npmRegistry],
    ['pypi.org', '/simple/', pypiRegistry],
    ['pypi.org', '/manage/projects/', pypiRegistry],
    ['crates.io', '/api/v1/crates/serde/owners', cargoRegistry],
    ['crates.io', '/api/v1/me', cargoRegistry],
  ])('refuses GET %s%s: off the route allowlist', async (host, requestTarget, registry) => {
    const proxy = await startProxy([[registry, host]]);

    const res = await proxy.at(host).send({ method: 'GET', path: requestTarget, headers: CLIENT_CREDENTIAL_HEADERS });

    expect(res.status).toBe(403);
    expect(proxy.hits).toEqual([]);
    const entries = await readAuditLog(proxy.auditLogPath, 1);
    expect(entries).toEqual([
      expect.objectContaining({
        registry: registry.type,
        method: 'GET',
        host,
        requestPath: requestTarget,
        decision: 'deny',
        source: 'request-path',
      }),
    ]);
  });

  it('npm install still succeeds, and no credential or npm-* header reaches upstream', async () => {
    const proxy = await startProxy([[npmRegistry, 'registry.npmjs.org']]);
    const npm = proxy.at('registry.npmjs.org');
    const headers = {
      ...CLIENT_CREDENTIAL_HEADERS,
      'user-agent': 'npm/10.8.2 node/v22.11.0 linux x64 workspaces/false',
      accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
    };

    const metadata = await npm.send({ method: 'GET', path: '/express', headers });
    const tarball = await npm.send({ method: 'GET', path: '/express/-/express-4.18.2.tgz', headers });

    expect(metadata.status).toBe(200);
    expect((JSON.parse(metadata.body) as NpmPackument).versions).toHaveProperty('4.18.2');
    expect(tarball.status).toBe(200);
    expect(tarball.body).toBe('EXPRESS-TARBALL');
    expect(proxy.hits.map((hit) => `${hit.method} ${hit.path}`)).toEqual([
      'GET /express',
      'GET /express/-/express-4.18.2.tgz',
    ]);
    expectCredentialFreeReads(proxy.hits);
    // The tarball is forwarded with the client's read-only headers.
    expect(proxy.hits[1].headers['user-agent']).toBe(headers['user-agent']);
    const entries = await readAuditLog(proxy.auditLogPath, 2);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'GET', host: 'registry.npmjs.org', source: 'metadata-filter' }),
        expect.objectContaining({ method: 'GET', host: 'registry.npmjs.org', source: 'tarball-backstop' }),
      ]),
    );
    expect(entries.every((entry) => entry.decision === 'allow')).toBe(true);
  });

  it('pip install still succeeds across pypi.org and files.pythonhosted.org without credentials', async () => {
    const proxy = await startProxy([
      [pypiRegistry, 'pypi.org'],
      [pypiRegistry, 'files.pythonhosted.org'],
    ]);
    const headers = { ...CLIENT_CREDENTIAL_HEADERS, 'user-agent': 'pip/24.0', accept: 'text/html' };

    const index = await proxy.at('pypi.org').send({ method: 'GET', path: '/simple/numpy/', headers });
    const sdist = await proxy.at('files.pythonhosted.org').send({ method: 'GET', path: NUMPY_SDIST, headers });

    expect(index.status).toBe(200);
    expect(index.body).toContain('numpy-1.26.0.tar.gz');
    expect(sdist.status).toBe(200);
    expect(sdist.body).toBe('NUMPY-SDIST');
    expect(proxy.hits.map((hit) => hit.path).sort()).toEqual(
      ['/pypi/numpy/json', '/simple/numpy/', NUMPY_SDIST].sort(),
    );
    expectCredentialFreeReads(proxy.hits);
  });

  it('cargo fetch still succeeds: config.json, the sparse index and the crate download', async () => {
    const proxy = await startProxy([
      [cargoRegistry, 'index.crates.io'],
      [cargoRegistry, 'static.crates.io'],
    ]);
    const headers = { ...CLIENT_CREDENTIAL_HEADERS, 'user-agent': 'cargo/1.82.0' };

    const config = await proxy.at('index.crates.io').send({ method: 'GET', path: '/config.json', headers });
    const index = await proxy.at('index.crates.io').send({ method: 'GET', path: '/se/rd/serde', headers });
    const crate = await proxy
      .at('static.crates.io')
      .send({ method: 'GET', path: '/crates/serde/serde-1.0.0.crate', headers });

    expect(config.status).toBe(200);
    expect(config.body).toContain('static.crates.io');
    expect(index.status).toBe(200);
    expect(index.body).toContain('"vers":"1.0.0"');
    expect(crate.status).toBe(200);
    expect(crate.body).toBe('SERDE-CRATE');
    expectCredentialFreeReads(proxy.hits);
    const entries = await readAuditLog(proxy.auditLogPath, 3);
    expect(entries.find((entry) => entry.requestPath === '/config.json')).toMatchObject({
      method: 'GET',
      host: 'index.crates.io',
      decision: 'allow',
      source: 'pass-through',
    });
  });

  it("apt-get still succeeds, forwarding apt's revalidation headers but no credentials", async () => {
    const proxy = await startProxy([[debianRegistry, 'deb.debian.org']]);
    const apt = proxy.at('deb.debian.org');
    const headers = {
      ...CLIENT_CREDENTIAL_HEADERS,
      'user-agent': 'Debian APT-HTTP/1.3 (2.6.1)',
      'cache-control': 'max-age=0',
      'if-modified-since': 'Sat, 01 Jun 2024 00:00:00 GMT',
    };

    const release = await apt.send({ method: 'GET', path: '/debian/dists/bookworm/InRelease', headers });
    const packages = await apt.send({
      method: 'GET',
      path: '/debian/dists/bookworm/main/binary-amd64/Packages.xz',
      headers,
    });
    const deb = await apt.send({ method: 'GET', path: CURL_DEB, headers });

    expect([release.status, packages.status, deb.status]).toEqual([200, 200, 200]);
    expect(deb.body).toBe('CURL-DEB');
    expectCredentialFreeReads(proxy.hits);
    expect(proxy.hits[0].headers).toMatchObject({
      'user-agent': 'Debian APT-HTTP/1.3 (2.6.1)',
      'cache-control': 'max-age=0',
      'if-modified-since': 'Sat, 01 Jun 2024 00:00:00 GMT',
    });
    const entries = await readAuditLog(proxy.auditLogPath, 3);
    expect(entries.map((entry) => `${String(entry.source)} ${String(entry.decision)}`).sort()).toEqual([
      'deb-backstop allow',
      'pass-through allow',
      'pass-through allow',
    ]);
  });

  it.each<[string, RegistryConfig, string, string]>([
    ['npm ping', npmRegistry, 'registry.npmjs.org', '/-/ping?write=true'],
    ['npm search', npmRegistry, 'registry.npmjs.org', '/-/v1/search?text=express&size=20'],
    ['npm dist-tag ls', npmRegistry, 'registry.npmjs.org', '/-/package/express/dist-tags'],
    ['cargo search', cargoRegistry, 'crates.io', '/api/v1/crates?q=serde&per_page=10'],
    ['PyPI JSON API', pypiRegistry, 'pypi.org', '/pypi/numpy/json'],
  ])(
    'keeps %s reachable as an audited, credential-free read-only pass-through',
    async (endpoint, registry, host, target) => {
      const proxy = await startProxy([[registry, host]]);

      const res = await proxy.at(host).send({ method: 'GET', path: target, headers: CLIENT_CREDENTIAL_HEADERS });

      expect(res.status).toBe(200);
      expect(proxy.hits.map((hit) => `${hit.method} ${hit.path}`)).toEqual([`GET ${target}`]);
      expectCredentialFreeReads(proxy.hits);
      const entries = await readAuditLog(proxy.auditLogPath, 1);
      expect(entries).toEqual([
        expect.objectContaining({
          registry: registry.type,
          method: 'GET',
          host,
          requestPath: target,
          decision: 'allow',
          reason: `allowlisted read-only route: ${endpoint}`,
          source: 'pass-through',
        }),
      ]);
      expect(entries[0].packageName).toBeUndefined();
    },
  );

  it('forwards a HEAD request as HEAD', async () => {
    const proxy = await startProxy([[npmRegistry, 'registry.npmjs.org']]);

    const res = await proxy.at('registry.npmjs.org').send({ method: 'HEAD', path: '/-/ping' });

    expect(res.status).toBe(200);
    expect(proxy.hits.map((hit) => `${hit.method} ${hit.path}`)).toEqual(['HEAD /-/ping']);
    const entries = await readAuditLog(proxy.auditLogPath, 1);
    expect(entries[0]).toMatchObject({ method: 'HEAD', source: 'pass-through', decision: 'allow' });
  });

  it('audits a tarball path the backstop cannot parse', async () => {
    const proxy = await startProxy([[npmRegistry, 'registry.npmjs.org']]);

    const res = await proxy.at('registry.npmjs.org').get('/express/-/not-a-tarball');

    expect(res.status).toBe(403);
    expect(proxy.hits).toEqual([]);
    const entries = await readAuditLog(proxy.auditLogPath, 1);
    expect(entries).toEqual([
      expect.objectContaining({
        method: 'GET',
        host: 'registry.npmjs.org',
        requestPath: '/express/-/not-a-tarball',
        decision: 'deny',
        source: 'tarball-backstop',
      }),
    ]);
    expect(entries[0].packageName).toBeUndefined();
  });

  // A metadata request is sent upstream even when it serves nothing, so it
  // must leave an audit entry: before the review, a name or sparse-index path
  // that upstream did not serve (or a packument with no versions) reached the
  // registry with no trace in package-audit.jsonl.
  it.each<[string, RegistryConfig, string, string, string, number, string]>([
    [
      'an npm packument upstream does not serve',
      npmRegistry,
      'registry.npmjs.org',
      '/left-pad',
      'left-pad',
      502,
      'Upstream metadata unavailable (fetch failed or not found)',
    ],
    [
      'npm JSON that is no packument',
      npmRegistry,
      'registry.npmjs.org',
      '/not-a-packument',
      'not-a-packument',
      502,
      'Unable to process upstream metadata',
    ],
    [
      'a PyPI simple page upstream does not serve',
      pypiRegistry,
      'pypi.org',
      '/simple/requests/',
      'requests',
      502,
      'Upstream metadata unavailable (fetch failed or not found)',
    ],
    [
      'a sparse-index file upstream does not serve',
      cargoRegistry,
      'index.crates.io',
      '/to/ki/tokio',
      'tokio',
      404,
      'Upstream metadata unavailable (fetch failed or not found)',
    ],
    [
      'an npm packument with no versions',
      npmRegistry,
      'registry.npmjs.org',
      '/unpublished',
      'unpublished',
      200,
      'Upstream metadata lists no installable version',
    ],
  ])('audits %s', async (_label, registry, host, target, packageName, status, reason) => {
    const proxy = await startProxy([[registry, host]]);

    const res = await proxy.at(host).send({ method: 'GET', path: target, headers: CLIENT_CREDENTIAL_HEADERS });

    expect(res.status).toBe(status);
    expect(proxy.hits.length).toBeGreaterThan(0);
    expectCredentialFreeReads(proxy.hits);
    const entries = await readAuditLog(proxy.auditLogPath, 1);
    expect(entries).toEqual([
      expect.objectContaining({
        registry: registry.type,
        method: 'GET',
        host,
        requestPath: target,
        packageName,
        decision: 'deny',
        reason,
        source: 'metadata-filter',
      }),
    ]);
    expect(entries[0].packageVersion).toBeUndefined();
  });

  it('audits a tarball refused because its metadata could not be fetched', async () => {
    const failingTransport: OutboundTransport = {
      kind: 'direct',
      addressGuard: 'local-resolver',
      request() {
        throw new Error('upstream unavailable');
      },
    };
    const proxy = await startProxy([[npmRegistry, 'registry.npmjs.org']], { outboundTransport: failingTransport });

    const res = await proxy.at('registry.npmjs.org').get('/express/-/express-4.18.2.tgz');

    expect(res.status).toBe(403);
    expect(res.body).toContain('fail-closed');
    const entries = await readAuditLog(proxy.auditLogPath, 1);
    expect(entries).toEqual([
      expect.objectContaining({
        method: 'GET',
        packageName: 'express',
        packageVersion: '4.18.2',
        decision: 'deny',
        source: 'tarball-backstop',
      }),
    ]);
  });
});

// ── Metadata resource bounds (EGR-4) ─────────────────────────────────
//
// The audit found every metadata request buffered its whole upstream body
// with no byte, concurrency or total-time bound, then parsed and
// re-serialized it: four concurrent 120 MB packuments added about 512 MB to
// the trusted host process. These tests drive the real handler on a loopback
// server against a pull-based fake upstream, so "bytes delivered by the
// upstream" is exactly what the proxy has read.

interface StreamedResource {
  readonly body: Buffer;
  readonly status?: number;
  /** Send Content-Length (the default). */
  readonly declareLength?: boolean;
  /** Deliver this many bytes, then hold the response open without ending it. */
  readonly stallAfter?: number;
  readonly chunkBytes?: number;
  /** Wait this long before each chunk: a slow upstream that never stalls. */
  readonly delayMs?: number;
}

interface StreamedExchange {
  readonly path: string;
  delivered: number;
  /** The response ended normally. */
  completed: boolean;
  /** The proxy destroyed the request or the response before it ended. */
  aborted: boolean;
}

function createStreamingUpstream(
  serve: (requestPath: string) => StreamedResource | undefined,
  onDelivery: () => void = () => undefined,
): { readonly transport: OutboundTransport; readonly exchanges: StreamedExchange[] } {
  const exchanges: StreamedExchange[] = [];
  const transport: OutboundTransport = {
    kind: 'direct',
    addressGuard: 'local-resolver',
    request(request, onResponse) {
      const exchange: StreamedExchange = { path: request.path, delivered: 0, completed: false, aborted: false };
      exchanges.push(exchange);
      const markAborted = (): void => {
        if (!exchange.completed) exchange.aborted = true;
      };
      const upstreamReq = new PassThrough();
      const destroyRequest = upstreamReq.destroy.bind(upstreamReq);
      Object.assign(upstreamReq, {
        setTimeout: () => upstreamReq,
        destroy: (error?: Error) => {
          markAborted();
          return destroyRequest(error);
        },
      });
      upstreamReq.on('finish', () => {
        const resource = serve(request.path);
        const body = resource?.body ?? Buffer.from('not found');
        const stallAfter = resource?.stallAfter ?? Number.POSITIVE_INFINITY;
        const chunkBytes = resource?.chunkBytes ?? 64 * 1024;
        let offset = 0;
        let timer: NodeJS.Timeout | undefined;
        const response: Readable = new Readable({
          read() {
            if (offset >= body.length) {
              this.push(null);
              return;
            }
            if (offset >= stallAfter) return; // hold the response open
            const deliver = (): void => {
              timer = undefined;
              if (response.destroyed) return;
              const end = Math.min(body.length, offset + chunkBytes, stallAfter);
              const chunk = body.subarray(offset, end);
              offset = end;
              exchange.delivered += chunk.length;
              onDelivery();
              response.push(chunk);
            };
            if (resource?.delayMs === undefined) deliver();
            else timer = setTimeout(deliver, resource.delayMs);
          },
          destroy(error, callback) {
            if (timer !== undefined) clearTimeout(timer);
            markAborted();
            callback(error);
          },
        });
        response.once('end', () => {
          exchange.completed = true;
        });
        Object.assign(response, {
          statusCode: resource === undefined ? 404 : (resource.status ?? 200),
          headers: resource?.declareLength === false ? {} : { 'content-length': String(body.length) },
        });
        onResponse?.(response as unknown as http.IncomingMessage);
      });
      return upstreamReq as unknown as http.ClientRequest;
    },
  };
  return { transport, exchanges };
}

interface CountedResponse {
  readonly status: number;
  readonly bytes: number;
  readonly sha256: string;
  /** The body, when it is at most 1 MiB. */
  readonly body: string;
}

interface BoundedRegistryServer {
  readonly port: number;
  /** GETs `requestTarget`, hashing and counting the body rather than holding it. */
  fetch(requestTarget: string): Promise<CountedResponse>;
  /** Opens a raw connection that sends one GET and can be dropped at any time. */
  connect(requestTarget: string): net.Socket;
  close(): Promise<void>;
}

/**
 * Serves handleRegistryRequest on loopback. `onResponseDone` runs when a
 * response finishes or its connection closes, before any listener the
 * handler adds, so it sees a response as done before its budget is returned.
 */
async function startBoundedServer(
  registry: RegistryConfig,
  upstreamHost: string,
  options: RegistryHandlerOptions,
  onResponseDone: (requestTarget: string) => void = () => undefined,
): Promise<BoundedRegistryServer> {
  const server = http.createServer((req, res) => {
    const target = req.url ?? '';
    let done = false;
    const markDone = (): void => {
      if (done) return;
      done = true;
      onResponseDone(target);
    };
    res.once('finish', markDone);
    res.once('close', markDone);
    handleRegistryRequest(registry, req, res, upstreamHost, 443, options).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    fetch: (requestTarget) =>
      new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: requestTarget, agent: false }, (res) => {
          const hash = createHash('sha256');
          const kept: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            hash.update(chunk);
            bytes += chunk.length;
            if (bytes <= 1024 * 1024) kept.push(chunk);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              bytes,
              sha256: hash.digest('hex'),
              body: bytes <= 1024 * 1024 ? Buffer.concat(kept).toString() : '',
            }),
          );
          res.on('error', reject);
        });
        req.on('error', reject);
      }),
    connect: (requestTarget) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('error', () => undefined);
      socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
      return socket;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A compact packument of about `targetBytes`, every version published long ago. */
function largePackument(name: string, targetBytes: number): Buffer {
  const filler = 'x'.repeat(100 * 1024);
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = { created: OLD_DATE, modified: OLD_DATE };
  let count = 0;
  for (let size = 0; size < targetBytes; size += filler.length + 96) {
    const version = `1.0.${count++}`;
    versions[version] = { name, version, readme: filler };
    time[version] = OLD_DATE;
  }
  return Buffer.from(JSON.stringify({ name, 'dist-tags': { latest: `1.0.${count - 1}` }, versions, time }));
}

describe('handleRegistryRequest: metadata resource bounds (EGR-4)', () => {
  const servers: BoundedRegistryServer[] = [];
  const sockets: net.Socket[] = [];
  let auditDir = '';

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.all(servers.splice(0).map((server) => server.close()));
    if (auditDir) {
      await fs.rm(auditDir, { recursive: true, force: true });
      auditDir = '';
    }
  });

  async function start(
    upstream: { readonly transport: OutboundTransport },
    budget: RegistryMetadataBudget,
    onResponseDone?: (requestTarget: string) => void,
    extra: Partial<RegistryHandlerOptions> = {},
  ): Promise<{ readonly server: BoundedRegistryServer; readonly auditLogPath: string }> {
    auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ironcurtain-registry-bounds-'));
    const auditLogPath = path.join(auditDir, 'package-audit.jsonl');
    const server = await startBoundedServer(
      npmRegistry,
      'registry.npmjs.org',
      {
        validator: createPackageValidator({ quarantineDays: 2 }),
        cache: new Map(),
        auditLogPath,
        outboundTransport: upstream.transport,
        metadataBudget: budget,
        ...extra,
      },
      onResponseDone,
    );
    servers.push(server);
    return { server, auditLogPath };
  }

  it('holds at most its buffer budget across 20 concurrent 60 MB packuments, queueing instead of refusing', async () => {
    const packument = largePackument('big', 60 * 1024 * 1024);
    const digest = createHash('sha256').update(packument).digest('hex');
    const budget = new RegistryMetadataBudget();
    const finished = new Set<string>();
    let peakHeld = 0;
    const upstream = createStreamingUpstream(
      () => ({ body: packument }),
      () => {
        // Bytes the proxy has read for responses it has not finished serving:
        // a lower bound on what it holds in memory.
        let held = 0;
        for (const exchange of upstream.exchanges) if (!finished.has(exchange.path)) held += exchange.delivered;
        peakHeld = Math.max(peakHeld, held);
      },
    );
    const { server } = await start(upstream, budget, (target) => finished.add(target));

    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => server.fetch(`/big-${index}`)));

    // Every install succeeds, with the packument intact.
    expect(responses.map((res) => res.status)).toEqual(Array<number>(20).fill(200));
    expect(responses.every((res) => res.bytes === packument.length && res.sha256 === digest)).toBe(true);
    expect(upstream.exchanges).toHaveLength(20);
    // ...yet never more than the budget was held at once (the old proxy held all 20, 1.2 GB).
    expect(peakHeld).toBeLessThanOrEqual(budget.limits.maxBufferedBytes);
    expect(peakHeld).toBeGreaterThan(packument.length);
    expect(budget.snapshot.peakBufferedBytes).toBeLessThanOrEqual(budget.limits.maxBufferedBytes);
    expect(budget.snapshot.peakActiveOperations).toBeLessThanOrEqual(budget.limits.maxConcurrentOperations);
    expect(budget.snapshot).toMatchObject({ activeOperations: 0, queuedOperations: 0, bufferedBytes: 0 });
  }, 180_000);

  it('aborts the upstream fetch and returns its budget when the client disconnects mid-download', async () => {
    const budget = new RegistryMetadataBudget();
    const upstream = createStreamingUpstream(() => ({
      body: Buffer.from(packumentJson('express', ['4.18.2'])),
      stallAfter: 16,
    }));
    const { server, auditLogPath } = await start(upstream, budget);

    const socket = server.connect('/express');
    sockets.push(socket);
    await waitUntil(() => (upstream.exchanges[0]?.delivered ?? 0) > 0);
    expect(budget.snapshot.activeOperations).toBe(1);
    socket.destroy();

    await waitUntil(() => upstream.exchanges[0].aborted && budget.snapshot.activeOperations === 0);
    expect(budget.snapshot.bufferedBytes).toBe(0);
    const entries = await readAuditLog(auditLogPath, 1);
    expect(entries).toEqual([
      expect.objectContaining({
        packageName: 'express',
        decision: 'deny',
        reason: 'Client closed the connection before the metadata was served',
        source: 'metadata-filter',
      }),
    ]);
  });

  it('aborts a tarball download upstream when the client disconnects', async () => {
    const cache: AllowedVersionCache = new Map();
    setCachedVersions(cache, { registry: 'npm', name: 'express' }, new Set(['4.18.2']));
    const upstream = createStreamingUpstream(() => ({ body: Buffer.alloc(1024 * 1024), stallAfter: 1024 }));
    const { server } = await start(upstream, new RegistryMetadataBudget(), undefined, { cache });

    const socket = server.connect('/express/-/express-4.18.2.tgz');
    sockets.push(socket);
    await waitUntil(() => (upstream.exchanges[0]?.delivered ?? 0) > 0);
    socket.destroy();

    await waitUntil(() => upstream.exchanges[0].aborted);
  });

  it('drops a queued request whose client disconnects before it reaches upstream', async () => {
    const budget = new RegistryMetadataBudget({ maxConcurrentOperations: 1 });
    const upstream = createStreamingUpstream(() => ({ body: Buffer.from('{}'), stallAfter: 0 }));
    const { server } = await start(upstream, budget);

    const holder = server.connect('/express');
    sockets.push(holder);
    await waitUntil(() => upstream.exchanges.length === 1);
    const queued = server.connect('/left-pad');
    sockets.push(queued);
    await waitUntil(() => budget.snapshot.queuedOperations === 1);
    queued.destroy();
    await waitUntil(() => budget.snapshot.queuedOperations === 0);

    holder.destroy();
    await waitUntil(() => budget.snapshot.activeOperations === 0);
    expect(upstream.exchanges.map((exchange) => exchange.path)).toEqual(['/express']);
  });

  it('gives each metadata request an absolute deadline, even when its upstream keeps trickling', async () => {
    const budget = new RegistryMetadataBudget({ operationTimeoutMs: 300 });
    const upstream = createStreamingUpstream(() => ({
      body: largePackument('slow', 64 * 1024),
      chunkBytes: 1,
      delayMs: 20,
    }));
    const { server, auditLogPath } = await start(upstream, budget);

    const res = await server.fetch('/slow');

    expect(res.status).toBe(504);
    expect(res.body).toContain('300 ms deadline');
    expect(upstream.exchanges[0].aborted).toBe(true);
    const entries = await readAuditLog(auditLogPath, 1);
    expect(entries[0]).toMatchObject({
      decision: 'deny',
      reason: 'Registry metadata request exceeded its 300 ms deadline',
      source: 'metadata-filter',
    });
    expect(budget.snapshot).toMatchObject({ activeOperations: 0, bufferedBytes: 0 });
  });

  it('abandons an upstream that stops sending', async () => {
    const budget = new RegistryMetadataBudget({ upstreamIdleTimeoutMs: 200 });
    const upstream = createStreamingUpstream(() => ({ body: largePackument('stuck', 64 * 1024), stallAfter: 100 }));
    const { server, auditLogPath } = await start(upstream, budget);

    const res = await server.fetch('/stuck');

    expect(res.status).toBe(504);
    expect(upstream.exchanges[0].aborted).toBe(true);
    const entries = await readAuditLog(auditLogPath, 1);
    expect(entries[0]).toMatchObject({ decision: 'deny', reason: 'Upstream metadata stalled for 200 ms' });
  });

  it.each([true, false])(
    'fails closed on metadata above the per-response ceiling, naming it (Content-Length sent: %s)',
    async (declareLength) => {
      const budget = new RegistryMetadataBudget({ maxResponseBytes: 64 * 1024, maxBufferedBytes: 1024 * 1024 });
      const body = largePackument('huge', 600 * 1024);
      const upstream = createStreamingUpstream(() => ({ body, declareLength }));
      const { server, auditLogPath } = await start(upstream, budget);

      const res = await server.fetch('/huge');

      expect(res.status).toBe(502);
      expect(res.body).toContain('65536 bytes metadata size ceiling');
      expect(upstream.exchanges[0].aborted).toBe(true);
      // A declared length over the ceiling is refused before any of the body is
      // read; an undeclared one as soon as the ceiling is passed.
      if (declareLength) expect(upstream.exchanges[0].delivered).toBe(0);
      else expect(upstream.exchanges[0].delivered).toBeLessThanOrEqual(256 * 1024);
      const entries = await readAuditLog(auditLogPath, 1);
      expect(entries[0]).toMatchObject({
        decision: 'deny',
        reason: 'Upstream metadata exceeds the 65536 bytes metadata size ceiling',
      });
    },
  );

  it('answers 503 once its queue is full, and audits it', async () => {
    const budget = new RegistryMetadataBudget({ maxConcurrentOperations: 1, maxQueuedOperations: 1 });
    const upstream = createStreamingUpstream(() => ({ body: Buffer.from('{}'), stallAfter: 0 }));
    const { server, auditLogPath } = await start(upstream, budget);

    sockets.push(server.connect('/express'));
    await waitUntil(() => upstream.exchanges.length === 1);
    sockets.push(server.connect('/left-pad'));
    await waitUntil(() => budget.snapshot.queuedOperations === 1);

    const res = await server.fetch('/react');

    expect(res.status).toBe(503);
    expect(res.body).toContain('retry later');
    const entries = await readAuditLog(auditLogPath, 1);
    expect(entries).toEqual([
      expect.objectContaining({ packageName: 'react', decision: 'deny', reason: 'Registry metadata queue is full' }),
    ]);
  });

  it('neither filters, caches nor audits a PyPI index whose client leaves while its upload times are read', async () => {
    // The page arrives at once; the JSON API it is filtered against stalls.
    const file = `/packages/a1/a1/${'a1'.repeat(30)}/demo-1.0.0.tar.gz`;
    const page = `<html><body><a href="https://files.pythonhosted.org${file}#sha256=00">demo-1.0.0.tar.gz</a></body></html>`;
    const upstream = createStreamingUpstream((requestPath) => {
      if (requestPath === '/simple/demo/') return { body: Buffer.from(page) };
      if (requestPath === '/pypi/demo/json') return { body: Buffer.from('{"releases":{}}'), stallAfter: 1 };
      return undefined;
    });
    const budget = new RegistryMetadataBudget();
    const cache: AllowedVersionCache = new Map();
    auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ironcurtain-registry-bounds-'));
    const auditLogPath = path.join(auditDir, 'package-audit.jsonl');
    const server = await startBoundedServer(pypiRegistry, 'pypi.org', {
      validator: createPackageValidator({ quarantineDays: 2 }),
      cache,
      auditLogPath,
      outboundTransport: upstream.transport,
      metadataBudget: budget,
    });
    servers.push(server);
    const exchange = (requestPath: string): StreamedExchange | undefined =>
      upstream.exchanges.find((entry) => entry.path === requestPath);

    const socket = server.connect('/simple/demo/');
    sockets.push(socket);
    await waitUntil(
      () => exchange('/simple/demo/')?.completed === true && (exchange('/pypi/demo/json')?.delivered ?? 0) > 0,
    );
    socket.destroy();

    await waitUntil(() => budget.snapshot.activeOperations === 0);
    expect(exchange('/pypi/demo/json')?.aborted).toBe(true);
    // The upload times are missing because the request was abandoned: no file
    // is recorded as denied, and the backstop's file cache is left alone.
    expect(cache.size).toBe(0);
    expect(await readAuditLog(auditLogPath, 1)).toEqual([
      expect.objectContaining({
        packageName: 'demo',
        decision: 'deny',
        reason: 'Client closed the connection before the metadata was served',
        source: 'metadata-filter',
      }),
    ]);
  });

  it('opens no upstream transfer for a client already gone when its request is dispatched', async () => {
    const cache: AllowedVersionCache = new Map();
    setCachedVersions(cache, { registry: 'npm', name: 'express' }, new Set(['4.18.2']));
    const upstream = createStreamingUpstream(() => ({ body: Buffer.alloc(1024), stallAfter: 16 }));
    let received = false;
    let dispatched = false;
    // The handler runs only after the client has gone, as a request can while
    // the MITM proxy is still loading this module.
    const server = http.createServer((req, res) => {
      received = true;
      res.once('close', () => {
        dispatched = true;
        void handleRegistryRequest(npmRegistry, req, res, 'registry.npmjs.org', 443, {
          validator: createPackageValidator({ quarantineDays: 2 }),
          cache,
          outboundTransport: upstream.transport,
          metadataBudget: new RegistryMetadataBudget(),
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const socket = net.connect((server.address() as AddressInfo).port, '127.0.0.1');
      socket.on('error', () => undefined);
      sockets.push(socket);
      socket.write('GET /express/-/express-4.18.2.tgz HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n');
      await waitUntil(() => received);
      socket.destroy();
      await waitUntil(() => dispatched);

      // Nothing would end such a transfer: its client's 'close' has already fired.
      expect(upstream.exchanges).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('handleRegistryRequest: packuments are filtered without re-serializing them', () => {
  const servers: RegistryServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function serveNpm(resources: Readonly<Record<string, string>>, extra: Partial<RegistryHandlerOptions> = {}) {
    const upstream = createFakeUpstream(resources);
    const server = await startRegistryServer(npmRegistry, 'registry.npmjs.org', {
      validator: createPackageValidator({ quarantineDays: 2 }),
      cache: new Map(),
      outboundTransport: upstream.transport,
      ...extra,
    });
    servers.push(server);
    return { server, hits: upstream.hits };
  }

  it('cuts out only the denied versions and copies everything else byte for byte', async () => {
    const fresh = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const keptManifest = '{"name":"demo",   "description":"caf\\u00e9 \\"quoted\\" 中"}';
    const text =
      '{\n  "name" : "demo",\n' +
      '  "dist-tags": {"latest": "2.0.0", "beta": "1.0.0"},\n' +
      `  "versions": {\n    "1.0.0": ${keptManifest},\n    "2.0.0": {"name":"demo"},\n    "1.5.0": { "name" : "demo" }\n  },\n` +
      `  "time": {"created": "${OLD_DATE}", "1.0.0": "2019-01-01T00:00:00.000Z", "2.0.0": "${fresh}", "1.5.0": "${OLD_DATE}"},\n` +
      '  "readme": "keep\\nme"\n}';
    const { server } = await serveNpm({ '/demo': text });

    const res = await server.get('/demo');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      name: 'demo',
      'dist-tags': { beta: '1.0.0', latest: '1.5.0' },
      versions: { '1.0.0': JSON.parse(keptManifest) as unknown, '1.5.0': { name: 'demo' } },
      time: { created: OLD_DATE, '1.0.0': '2019-01-01T00:00:00.000Z', '1.5.0': OLD_DATE },
      readme: 'keep\nme',
    });
    // Kept members are the upstream's own bytes, escapes and spacing included.
    expect(res.body).toContain(`"1.0.0": ${keptManifest}`);
    expect(res.body).toContain('"1.5.0": { "name" : "demo" }');
    expect(res.body).toContain('"readme": "keep\\nme"');
  });

  it.each([
    ['a repeated versions member', '{"versions":{},"versions":{"9.9.9":{}}}'],
    ['a repeated version', `{"versions":{"1.0.0":{},"1.0.0":{"x":1}},"time":{"1.0.0":"${OLD_DATE}"}}`],
    ['a truncated document', '{"versions":{"1.0.0":{}'],
    ['a document that is not JSON', 'not json'],
  ])('refuses to serve %s (502)', async (_label, text) => {
    const { server } = await serveNpm({ '/demo': text });
    const res = await server.get('/demo');
    expect(res.status).toBe(502);
    expect(res.body).toBe('Failed to process package metadata');
  });

  it('validates later tarballs from cached publish times, refetching only for a version the cache lacks', async () => {
    const cache: AllowedVersionCache = new Map();
    const { server, hits } = await serveNpm(
      {
        '/express': packumentJson('express', ['4.18.2', '4.18.3']),
        '/express/-/express-4.18.2.tgz': 'TARBALL-1',
        '/express/-/express-4.18.3.tgz': 'TARBALL-2',
      },
      { cache, publishTimeCache: new NpmPublishTimeCache() },
    );

    expect((await server.get('/express/-/express-4.18.2.tgz')).status).toBe(200);
    cache.clear(); // the allowed-version cache has expired
    expect((await server.get('/express/-/express-4.18.3.tgz')).status).toBe(200);
    cache.clear();
    const unknown = await server.get('/express/-/express-9.9.9.tgz');

    expect(unknown.status).toBe(403);
    expect(unknown.body).toContain('Version not found in package metadata');
    expect(hits.map((hit) => hit.path)).toEqual([
      '/express',
      '/express/-/express-4.18.2.tgz',
      '/express/-/express-4.18.3.tgz',
      '/express',
    ]);
  });
});

describe('handleRegistryRequest: PyPI files are gated by their own upload time (EGR-5)', () => {
  const servers: RegistryServer[] = [];
  let auditDir = '';

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    if (auditDir) {
      await fs.rm(auditDir, { recursive: true, force: true });
      auditDir = '';
    }
  });

  // PyYAML 6.0.1 gained a cp312 aarch64 wheel 184 days after release. Here a
  // malicious wheel lands on a release that is years old.
  const sdist = pypiFilePath('a1', 'PyYAML-6.0.1.tar.gz');
  const lateWheel = pypiFilePath('b2', 'PyYAML-6.0.1-cp313-cp313-manylinux_2_17_aarch64.whl');
  const unlisted = pypiFilePath('c3', 'PyYAML-6.0.1-cp313-cp313-win_amd64.whl');
  const justNow = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const resources: Readonly<Record<string, string>> = {
    '/simple/pyyaml/': `<!DOCTYPE html><html><body>${pypiLink(sdist)}${pypiLink(lateWheel)}</body></html>`,
    '/pypi/pyyaml/json': JSON.stringify({
      releases: {
        '6.0.1': [
          {
            filename: 'PyYAML-6.0.1.tar.gz',
            url: `https://files.pythonhosted.org${sdist}`,
            upload_time_iso_8601: OLD_DATE,
          },
          {
            filename: 'PyYAML-6.0.1-cp313-cp313-manylinux_2_17_aarch64.whl',
            url: `https://files.pythonhosted.org${lateWheel}`,
            upload_time_iso_8601: justNow,
          },
        ],
      },
    }),
    [sdist]: 'OLD-SDIST',
    [lateWheel]: 'MALICIOUS-WHEEL',
    [`${lateWheel}.metadata`]: 'WHEEL-METADATA',
    [unlisted]: 'UNLISTED',
  };

  async function startPypi() {
    auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ironcurtain-registry-pypi-'));
    const auditLogPath = path.join(auditDir, 'package-audit.jsonl');
    const upstream = createFakeUpstream(resources);
    const options: RegistryHandlerOptions = {
      validator: createPackageValidator({ quarantineDays: 2 }),
      cache: new Map(),
      auditLogPath,
      outboundTransport: upstream.transport,
    };
    const index = await startRegistryServer(pypiRegistry, 'pypi.org', options);
    const files = await startRegistryServer(pypiRegistry, 'files.pythonhosted.org', options);
    servers.push(index, files);
    return { index, files, hits: upstream.hits, auditLogPath };
  }

  it('withholds a new wheel on an old release from the index, and refuses its download and sidecar', async () => {
    const { index, files, auditLogPath } = await startPypi();

    const page = await index.get('/simple/pyyaml/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('PyYAML-6.0.1.tar.gz');
    expect(page.body).not.toContain('cp313');

    expect(await files.get(sdist)).toMatchObject({ status: 200, body: 'OLD-SDIST' });
    const wheel = await files.get(lateWheel);
    expect(wheel.status).toBe(403);
    expect(wheel.body).not.toContain('MALICIOUS');
    expect((await files.get(`${lateWheel}.metadata`)).status).toBe(403);

    const entries = await readAuditLog(auditLogPath, 5);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'metadata-filter',
          decision: 'deny',
          packageVersion: '6.0.1',
          packageFile: 'PyYAML-6.0.1-cp313-cp313-manylinux_2_17_aarch64.whl',
        }),
        expect.objectContaining({ source: 'metadata-filter', decision: 'allow', packageVersion: '1 file(s)' }),
        expect.objectContaining({
          source: 'tarball-backstop',
          decision: 'deny',
          packageFile: 'PyYAML-6.0.1-cp313-cp313-manylinux_2_17_aarch64.whl',
          reason: 'File not in allowed cache (filtered from metadata)',
        }),
      ]),
    );
  });

  it('gates a download it has no cache entry for by that file alone', async () => {
    const { files, hits } = await startPypi();

    const wheel = await files.get(lateWheel);
    expect(wheel.status).toBe(403);
    expect(wheel.body).toContain('day(s) old');
    expect(await files.get(sdist)).toMatchObject({ status: 200, body: 'OLD-SDIST' });

    // The first download read the JSON API; the second used the per-file cache it filled.
    expect(hits.map((hit) => hit.path)).toEqual(['/pypi/pyyaml/json', sdist]);
  });

  it('refuses a file the JSON API does not list (fail-closed)', async () => {
    const { files, hits } = await startPypi();

    const missing = await files.get(unlisted);

    expect(missing.status).toBe(403);
    expect(missing.body).toContain('File not found in package metadata');
    expect(hits.map((hit) => hit.path)).toEqual(['/pypi/pyyaml/json']);
  });
});

describe('handleRegistryRequest: an upstream that fails mid-body aborts the client response', () => {
  const servers: BoundedRegistryServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  const DEB_PATH = '/debian/pool/main/c/curl/curl_7.88.1-10_amd64.deb';
  const DECLARED_BYTES = 64 * 1024;
  const SENT_BYTES = 1024;

  /**
   * An upstream that answers 200 with a 64 KiB Content-Length and sends 1 KiB
   * of it, then fails as `mode` says: the response errors (a reset), the
   * request errors (a socket error), or the transfer stalls until the
   * proxy's idle timeout fires. The timeout callback is the one the proxy
   * registered with `setTimeout`, so no test waits for the real timeout.
   * Destroying the fake request ends its response without an error, so only
   * the path under test reacts.
   */
  function createFailingUpstream(mode: 'response-error' | 'request-error' | 'stall'): OutboundTransport {
    return {
      kind: 'direct',
      addressGuard: 'local-resolver',
      request(_request, onResponse) {
        const upstreamReq = new PassThrough();
        const response = new PassThrough();
        let onTimeout: (() => void) | undefined;
        const destroyRequest = upstreamReq.destroy.bind(upstreamReq);
        Object.assign(upstreamReq, {
          setTimeout: (_ms: number, callback?: () => void) => {
            onTimeout = callback;
            return upstreamReq;
          },
          destroy: (error?: Error) => {
            response.destroy();
            return destroyRequest(error);
          },
        });
        upstreamReq.on('error', () => undefined);
        upstreamReq.on('finish', () => {
          Object.assign(response, {
            statusCode: 200,
            headers: { 'content-type': 'application/vnd.debian.binary-package', 'content-length': `${DECLARED_BYTES}` },
          });
          onResponse?.(response as unknown as http.IncomingMessage);
          response.write(Buffer.alloc(SENT_BYTES, 0x61));
          setTimeout(() => {
            if (mode === 'response-error') response.destroy(new Error('upstream reset'));
            else if (mode === 'request-error') upstreamReq.emit('error', new Error('socket hang up'));
            else onTimeout?.();
          }, 50);
        });
        return upstreamReq as unknown as http.ClientRequest;
      },
    };
  }

  /** GETs `path` and reports how the response ended, or `undefined` when it is still open after `withinMs`. */
  async function getUntilClosed(
    port: number,
    path: string,
    withinMs: number,
  ): Promise<{ status: number; bytes: number; complete: boolean } | undefined> {
    const outcome = new Promise<{ status: number; bytes: number; complete: boolean }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.on('error', () => undefined);
        res.on('close', () => resolve({ status: res.statusCode ?? 0, bytes, complete: res.complete }));
      });
      req.on('error', reject);
    });
    const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, withinMs, undefined));
    return Promise.race([outcome, timeout]);
  }

  it.each(['response-error', 'request-error', 'stall'] as const)(
    'a %s after the headers were sent ends the client transfer at once (complete=false)',
    async (mode) => {
      const options: RegistryHandlerOptions = {
        validator: createPackageValidator({}),
        cache: new Map(),
        outboundTransport: createFailingUpstream(mode),
      };
      const server = await startBoundedServer(debianRegistry, 'deb.debian.org', options);
      servers.push(server);

      const ended = await getUntilClosed(server.port, DEB_PATH, 1_000);

      expect(ended).toEqual({ status: 200, bytes: SENT_BYTES, complete: false });
    },
  );

  it('still answers 502 when the upstream fails before sending headers', async () => {
    const options: RegistryHandlerOptions = {
      validator: createPackageValidator({}),
      cache: new Map(),
      outboundTransport: {
        kind: 'direct',
        addressGuard: 'local-resolver',
        request() {
          const upstreamReq = new PassThrough();
          Object.assign(upstreamReq, { setTimeout: () => upstreamReq });
          upstreamReq.on('finish', () => setTimeout(() => upstreamReq.emit('error', new Error('refused')), 10));
          return upstreamReq as unknown as http.ClientRequest;
        },
      },
    };
    const server = await startBoundedServer(debianRegistry, 'deb.debian.org', options);
    servers.push(server);

    expect(await server.fetch(DEB_PATH)).toMatchObject({ status: 502, body: 'Upstream connection error' });
  });
});

describe("handleRegistryRequest: the PyPI JSON API redirect to a project's display name", () => {
  const servers: RegistryServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  // Warehouse answers /pypi/django/json with a 301 to /pypi/Django/json.
  const sdist = pypiFilePath('d1', 'Django-4.2.7.tar.gz');
  const freshWheel = pypiFilePath('e2', 'Django-4.2.7-py3-none-any.whl');
  const djangoJson = JSON.stringify({
    releases: {
      '4.2.7': [
        {
          filename: 'Django-4.2.7.tar.gz',
          url: `https://files.pythonhosted.org${sdist}`,
          upload_time_iso_8601: OLD_DATE,
        },
        {
          filename: 'Django-4.2.7-py3-none-any.whl',
          url: `https://files.pythonhosted.org${freshWheel}`,
          upload_time_iso_8601: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        },
      ],
    },
  });

  interface Answer {
    readonly status: number;
    readonly location?: string;
    readonly body?: string;
  }

  /** An upstream that answers each exact path (no decoding) as listed, and 404 otherwise. */
  function createAnsweringUpstream(answers: Readonly<Record<string, Answer>>): {
    readonly transport: OutboundTransport;
    readonly hits: string[];
  } {
    const hits: string[] = [];
    const transport: OutboundTransport = {
      kind: 'direct',
      addressGuard: 'local-resolver',
      request(request, onResponse) {
        hits.push(`${request.destination.hostname}${request.path}`);
        const upstreamReq = new PassThrough();
        Object.assign(upstreamReq, { setTimeout: () => upstreamReq });
        upstreamReq.on('finish', () => {
          const answer = answers[request.path] ?? { status: 404, body: 'not found' };
          const upstreamRes = new PassThrough();
          Object.assign(upstreamRes, {
            statusCode: answer.status,
            headers: answer.location === undefined ? {} : { location: answer.location },
          });
          onResponse?.(upstreamRes as unknown as http.IncomingMessage);
          upstreamRes.end(answer.body ?? '');
        });
        return upstreamReq as unknown as http.ClientRequest;
      },
    };
    return { transport, hits };
  }

  async function startPypi(redirect: Answer) {
    const upstream = createAnsweringUpstream({
      '/simple/django/': {
        status: 200,
        body: `<!DOCTYPE html><html><body>${pypiLink(sdist)}${pypiLink(freshWheel)}</body></html>`,
      },
      '/pypi/django/json': redirect,
      '/pypi/Django/json': { status: 200, body: djangoJson },
      '/pypi/flask/json': { status: 200, body: djangoJson },
      [sdist]: { status: 200, body: 'DJANGO-SDIST' },
      [freshWheel]: { status: 200, body: 'FRESH-WHEEL' },
    });
    const options: RegistryHandlerOptions = {
      validator: createPackageValidator({ quarantineDays: 2 }),
      cache: new Map(),
      outboundTransport: upstream.transport,
    };
    const index = await startRegistryServer(pypiRegistry, 'pypi.org', options);
    const files = await startRegistryServer(pypiRegistry, 'files.pythonhosted.org', options);
    servers.push(index, files);
    return { index, files, hits: upstream.hits };
  }

  it.each([
    ['an absolute 301', { status: 301, location: 'https://pypi.org/pypi/Django/json' }],
    ['a relative 308', { status: 308, location: '/pypi/Django/json' }],
    ['a 302', { status: 302, location: 'https://pypi.org/pypi/Django/json' }],
    ['a 307', { status: 307, location: 'https://pypi.org/pypi/Django/json' }],
  ])('follows %s and age-gates each file by the redirected upload times', async (_label, redirect) => {
    const { index, files, hits } = await startPypi(redirect);

    const page = await index.get('/simple/django/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('Django-4.2.7.tar.gz');
    expect(page.body).not.toContain('py3-none-any');
    expect(await files.get(sdist)).toMatchObject({ status: 200, body: 'DJANGO-SDIST' });
    expect((await files.get(freshWheel)).status).toBe(403);

    expect(hits).toEqual(
      expect.arrayContaining(['pypi.org/simple/django/', 'pypi.org/pypi/django/json', 'pypi.org/pypi/Django/json']),
    );
    expect(hits.filter((hit) => hit.includes('/pypi/'))).toHaveLength(2);
  });

  it('follows the redirect on a download it has no cache entry for', async () => {
    const { files, hits } = await startPypi({ status: 301, location: 'https://pypi.org/pypi/Django/json' });

    expect(await files.get(sdist)).toMatchObject({ status: 200, body: 'DJANGO-SDIST' });
    expect((await files.get(freshWheel)).status).toBe(403);
    expect(hits).toEqual(['pypi.org/pypi/django/json', 'pypi.org/pypi/Django/json', `files.pythonhosted.org${sdist}`]);
  });

  it.each([
    ['another project', 'https://pypi.org/pypi/flask/json'],
    ['another host', 'https://pypi.example/pypi/Django/json'],
    ['plain HTTP', 'http://pypi.org/pypi/Django/json'],
    ['another port', 'https://pypi.org:8443/pypi/Django/json'],
    ['credentials', 'https://user:secret@pypi.org/pypi/Django/json'],
    ['a query', 'https://pypi.org/pypi/Django/json?serial=1'],
    ['another route of the project', 'https://pypi.org/simple/Django/'],
    ['a version document', 'https://pypi.org/pypi/Django/4.2.7/json'],
    ['an encoded name', 'https://pypi.org/pypi/Dj%61ngo/json'],
  ])('refuses a redirect to %s and withholds every file', async (_label, location) => {
    const { index, files, hits } = await startPypi({ status: 301, location });

    const page = await index.get('/simple/django/');
    expect(page.status).toBe(200);
    expect(page.body).not.toContain('Django-4.2.7');
    expect((await files.get(sdist)).status).toBe(403);
    // The redirect target is never read.
    expect(hits.filter((hit) => hit.includes('/json') && !hit.endsWith('/pypi/django/json'))).toEqual([]);
  });

  it.each([
    ['a 303', { status: 303, location: 'https://pypi.org/pypi/Django/json' }],
    ['a redirect without Location', { status: 301 }],
  ])('does not follow %s', async (_label, redirect) => {
    const { files, hits } = await startPypi(redirect);

    expect((await files.get(sdist)).status).toBe(403);
    expect(hits).toEqual(['pypi.org/pypi/django/json']);
  });

  it('follows at most one redirect', async () => {
    const upstream = createAnsweringUpstream({
      '/pypi/django/json': { status: 301, location: 'https://pypi.org/pypi/Django/json' },
      '/pypi/Django/json': { status: 301, location: 'https://pypi.org/pypi/DJANGO/json' },
      '/pypi/DJANGO/json': { status: 200, body: djangoJson },
    });
    const options: RegistryHandlerOptions = {
      validator: createPackageValidator({ quarantineDays: 2 }),
      cache: new Map(),
      outboundTransport: upstream.transport,
    };
    const files = await startRegistryServer(pypiRegistry, 'files.pythonhosted.org', options);
    servers.push(files);

    expect((await files.get(sdist)).status).toBe(403);
    expect(upstream.hits).toEqual(['pypi.org/pypi/django/json', 'pypi.org/pypi/Django/json']);
  });
});

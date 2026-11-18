import { describe, expect, it } from 'vitest';
import {
  createCargoVersionTimeReader,
  createNpmPackumentIndexer,
  createNpmPublishTimesReader,
  createNpmVersionTimeReader,
  createPypiFileTimeReader,
  createPypiFileTimesReader,
  formatByteCeiling,
  NpmPublishTimeCache,
  parsePublishTime,
  pypiDistributionFileKey,
  pypiFileKeyFromUrl,
  RegistryMetadataError,
  stripPypiSidecarSuffix,
  type StreamingMetadataReader,
} from '../../src/docker/registry-metadata.js';

/** Feeds `text` to `reader` in `chunkSize`-byte chunks (whole when undefined) and returns its result. */
function read<T>(reader: StreamingMetadataReader<T>, text: string, chunkSize?: number): T {
  const source = Buffer.from(text);
  const step = chunkSize ?? Math.max(1, source.length);
  for (let offset = 0; offset < source.length; offset += step) {
    reader.write(source.subarray(offset, Math.min(source.length, offset + step)));
  }
  return reader.finish();
}

function metadataError(run: () => unknown): RegistryMetadataError {
  try {
    run();
  } catch (error) {
    if (error instanceof RegistryMetadataError) return error;
    throw error;
  }
  throw new Error('expected a RegistryMetadataError');
}

const OLD = '2020-01-01T00:00:00.000Z';
const NEW = '2026-11-10T00:00:00.000Z';

describe('npm metadata readers', () => {
  const packument = JSON.stringify({
    _id: 'demo',
    name: 'demo',
    'dist-tags': { latest: '1.1.0' },
    versions: { '1.0.0': { name: 'demo', readme: 'x'.repeat(1000) }, '1.1.0': { name: 'demo' } },
    time: { created: OLD, modified: NEW, '1.0.0': OLD, '1.1.0': 'not-a-date' },
    readme: 'README',
  });

  it.each([undefined, 1, 7])(
    'reads one version and its publish time without keeping the document (chunk %s)',
    (size) => {
      expect(read(createNpmVersionTimeReader('1.0.0'), packument, size)).toBe(Date.parse(OLD));
      expect(read(createNpmVersionTimeReader('1.1.0'), packument, size)).toBeUndefined();
    },
  );

  it('matches a version name spelled with JSON escapes, as JSON.parse would', () => {
    const escaped = '{"versions":{"1.0.\\u0030":{}},"time":{"1.0.\\u0030":"2020-01-01T00:00:00Z"}}';
    expect(read(createNpmVersionTimeReader('1.0.0'), escaped)).toBe(Date.parse('2020-01-01T00:00:00Z'));
  });

  it.each([
    ['a version it does not list', packument, 'absent'],
    ['a versions member that is not an object', '{"versions":[],"time":{"1.0.0":"2020-01-01T00:00:00Z"}}', 'absent'],
    ['a time entry without a version', '{"versions":{},"time":{"1.0.0":"2020-01-01T00:00:00Z"}}', 'absent'],
    ['a document that is not an object', '["1.0.0"]', 'malformed'],
    ['invalid JSON', '{"versions":{"1.0.0":{}', 'malformed'],
    ['a repeated version', '{"versions":{"1.0.0":{},"1.0.0":{}},"time":{}}', 'malformed'],
    [
      'a repeated time entry',
      '{"versions":{"1.0.0":{}},"time":{"1.0.0":"x","1.0.0":"2020-01-01T00:00:00Z"}}',
      'malformed',
    ],
    ['a repeated versions member', '{"versions":{},"versions":{"1.0.0":{}}}', 'malformed'],
  ])('fails closed on %s', (_label, text, code) => {
    const version = text === packument ? '9.9.9' : '1.0.0';
    expect(metadataError(() => read(createNpmVersionTimeReader(version), text)).code).toBe(code);
  });

  it('reads every version with its publish time', () => {
    const times = read(createNpmPublishTimesReader(), packument, 3);
    expect([...times.versions]).toEqual([
      ['1.0.0', Date.parse(OLD)],
      ['1.1.0', undefined],
    ]);
  });

  it('bounds the versions it reads', () => {
    expect(metadataError(() => read(createNpmPublishTimesReader(1), packument)).code).toBe('limit');
  });

  it('indexes the members a filter cuts, by byte offset', () => {
    const source = Buffer.from(packument);
    const indexer = createNpmPackumentIndexer();
    indexer.write(source);
    const index = indexer.finish();

    expect(index.members.map((member) => member.name)).toEqual([
      '_id',
      'name',
      'dist-tags',
      'versions',
      'time',
      'readme',
    ]);
    expect(index.versions.map((member) => source.subarray(member.start, member.end).toString())).toEqual([
      `"1.0.0":{"name":"demo","readme":"${'x'.repeat(1000)}"}`,
      '"1.1.0":{"name":"demo"}',
    ]);
    expect(index.time?.map((member) => [member.name, member.text])).toEqual([
      ['created', OLD],
      ['modified', NEW],
      ['1.0.0', OLD],
      ['1.1.0', 'not-a-date'],
    ]);
    expect(index.distTags?.map((member) => [member.name, member.text])).toEqual([['latest', '1.1.0']]);
  });

  it.each([
    ['no versions object', '{"name":"demo"}'],
    ['a time member that is not an object', '{"versions":{},"time":"2020"}'],
    ['a dist-tags member that is not an object', '{"versions":{},"dist-tags":[]}'],
  ])('refuses to index a packument with %s', (_label, text) => {
    const indexer = createNpmPackumentIndexer();
    expect(metadataError(() => read(indexer, text)).code).toBe('malformed');
  });
});

describe('PyPI metadata readers', () => {
  const digest = (byte: string): string => byte.repeat(32);
  const path = (byte: string, file: string): string =>
    `/packages/${digest(byte).slice(0, 2)}/${digest(byte).slice(2, 4)}/${digest(byte).slice(4)}/${file}`;
  const sdist = path('a1', 'demo-1.0.0.tar.gz');
  const lateWheel = path('b2', 'demo-1.0.0-py3-none-any.whl');
  const json = JSON.stringify({
    info: { name: 'demo', project_urls: { ['k'.repeat(10_000)]: 'https://example.invalid' } },
    releases: {
      '1.0.0': [
        { filename: 'demo-1.0.0.tar.gz', url: `https://files.pythonhosted.org${sdist}`, upload_time_iso_8601: OLD },
        {
          filename: 'demo-1.0.0-py3-none-any.whl',
          url: `https://files.pythonhosted.org${lateWheel}`,
          upload_time_iso_8601: NEW,
          digests: { blake2b_256: digest('b2') },
        },
      ],
      '0.9.0': [],
    },
    urls: [{ url: `https://files.pythonhosted.org${path('c3', 'demo-9.9.9.tar.gz')}`, upload_time_iso_8601: OLD }],
  });

  it.each([undefined, 1, 13])('reads each file by its own upload time, keyed by exact path (chunk %s)', (size) => {
    expect([...read(createPypiFileTimesReader(), json, size)]).toEqual([
      [sdist, Date.parse(OLD)],
      [lateWheel, Date.parse(NEW)],
    ]);
  });

  it('reads exactly one file, and refuses one no release lists', () => {
    expect(read(createPypiFileTimeReader(lateWheel), json)).toBe(Date.parse(NEW));
    expect(read(createPypiFileTimeReader(sdist), json, 5)).toBe(Date.parse(OLD));
    // Same file name, different digest path: not the same file.
    const impostor = path('d4', 'demo-1.0.0-py3-none-any.whl');
    expect(metadataError(() => read(createPypiFileTimeReader(impostor), json)).code).toBe('absent');
    // The top-level `urls` list is not where files are matched.
    expect(metadataError(() => read(createPypiFileTimeReader(path('c3', 'demo-9.9.9.tar.gz')), json)).code).toBe(
      'absent',
    );
  });

  it('keeps the more restrictive time when a file is listed twice', () => {
    const twice = (second: string | undefined): string =>
      JSON.stringify({
        releases: {
          '1.0.0': [{ url: `https://files.pythonhosted.org${sdist}`, upload_time_iso_8601: OLD }],
          '1.0': [
            {
              url: `https://files.pythonhosted.org${sdist}`,
              ...(second === undefined ? {} : { upload_time_iso_8601: second }),
            },
          ],
        },
      });
    expect(read(createPypiFileTimesReader(), twice(NEW)).get(sdist)).toBe(Date.parse(NEW));
    expect(read(createPypiFileTimeReader(sdist), twice(NEW))).toBe(Date.parse(NEW));
    expect(read(createPypiFileTimesReader(), twice(undefined)).get(sdist)).toBeUndefined();
    expect(read(createPypiFileTimeReader(sdist), twice(undefined))).toBeUndefined();
  });

  it('ignores URLs that are not plain https files.pythonhosted.org paths', () => {
    const urls = [
      `http://files.pythonhosted.org${sdist}`,
      `https://files.pythonhosted.org:8443${sdist}`,
      `https://files.pythonhosted.org${sdist}?x=1`,
      `https://user@files.pythonhosted.org${sdist}`,
      `https://mirror.example${sdist}`,
      'not a url',
    ];
    const text = JSON.stringify({ releases: { '1.0.0': urls.map((url) => ({ url, upload_time_iso_8601: OLD })) } });
    expect(read(createPypiFileTimesReader(), text).size).toBe(0);
  });

  it('fails closed on a document that is not an object, and bounds the files it reads', () => {
    expect(metadataError(() => read(createPypiFileTimesReader(), '[]')).code).toBe('malformed');
    expect(metadataError(() => read(createPypiFileTimeReader(sdist), '"x"')).code).toBe('malformed');
    expect(metadataError(() => read(createPypiFileTimesReader(1), json)).code).toBe('limit');
  });

  it('derives file keys from request paths and URLs', () => {
    expect(pypiDistributionFileKey(`${lateWheel}.metadata`)).toBe(lateWheel);
    expect(pypiDistributionFileKey(`${sdist}.provenance?cache=1`)).toBe(sdist);
    expect(stripPypiSidecarSuffix('demo-1.0.0.whl.metadata.metadata')).toBe('demo-1.0.0.whl.metadata');
    expect(pypiFileKeyFromUrl(`https://files.pythonhosted.org${sdist}#sha256=00`)).toBe(sdist);
    expect(pypiFileKeyFromUrl(`../../packages/x/demo-1.0.0.tar.gz`, 'https://pypi.org/simple/demo/')).toBeUndefined();
  });
});

describe('createCargoVersionTimeReader', () => {
  const index = [
    JSON.stringify({ name: 'demo', vers: '0.9.0', pubtime: OLD }),
    JSON.stringify({ name: 'demo', vers: '1.0.0', pubtime: NEW }),
    JSON.stringify({ name: 'demo', vers: '1.1.0' }),
  ].join('\r\n');

  it.each([undefined, 1, 10])('reads one version from lines split across chunks (chunk %s)', (size) => {
    expect(read(createCargoVersionTimeReader('1.0.0'), `${index}\n`, size)).toBe(Date.parse(NEW));
    expect(read(createCargoVersionTimeReader('1.1.0'), `\n${index}`, size)).toBeUndefined();
  });

  it.each([
    ['a version no line lists', `${index}\n`, '2.0.0', 'absent'],
    ['a repeated version', `${index}\n${JSON.stringify({ vers: '1.0.0', pubtime: OLD })}`, '1.0.0', 'malformed'],
    ['a line that is not JSON', `${index}\n{oops`, '1.0.0', 'malformed'],
    ['a line that is not an object', `${index}\n[1]`, '1.0.0', 'malformed'],
  ])('fails closed on %s', (_label, text, version, code) => {
    expect(metadataError(() => read(createCargoVersionTimeReader(version), text)).code).toBe(code);
  });

  it('bounds the length of one line', () => {
    const long = JSON.stringify({ vers: '1.0.0', features: 'x'.repeat(200) });
    expect(metadataError(() => read(createCargoVersionTimeReader('1.0.0', 64), long, 16)).code).toBe('limit');
  });
});

describe('NpmPublishTimeCache', () => {
  const times = (count: number) => ({
    versions: new Map(Array.from({ length: count }, (_, index) => [`1.0.${index}`, Date.parse(OLD)] as const)),
  });

  it('returns what it holds until the entry expires', () => {
    let now = 1_000;
    const cache = new NpmPublishTimeCache({ ttlMs: 100 }, () => now);
    const entry = times(2);
    cache.set('npm:demo', entry);
    expect(cache.get('npm:demo')).toBe(entry);
    now += 101;
    expect(cache.get('npm:demo')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used packages to stay within its package and version bounds', () => {
    const cache = new NpmPublishTimeCache({ maxPackages: 2, maxVersions: 5 });
    cache.set('npm:a', times(2));
    cache.set('npm:b', times(2));
    cache.get('npm:a');
    cache.set('npm:c', times(1));
    expect(cache.get('npm:b')).toBeUndefined();
    expect(cache.get('npm:a')).toBeDefined();
    cache.set('npm:d', times(4));
    expect(cache.size).toBe(1);
    expect(cache.get('npm:d')).toBeDefined();
    // An entry above the version bound is not cached at all.
    cache.set('npm:e', times(6));
    expect(cache.get('npm:e')).toBeUndefined();
  });
});

describe('registry metadata helpers', () => {
  it('formats byte ceilings and parses publish times', () => {
    expect(formatByteCeiling(128 * 1024 * 1024)).toBe('128 MiB');
    expect(formatByteCeiling(4096)).toBe('4096 bytes');
    expect(parsePublishTime(OLD)).toBe(Date.parse(OLD));
    expect(parsePublishTime('yesterday')).toBeUndefined();
    expect(parsePublishTime(undefined)).toBeUndefined();
  });
});

/**
 * `[src:<segment id>]` markers (utils/source-markers.ts): every recall format and the
 * briefing name the source segment of each fact that `memory_ingest` extracted, so an
 * agent can follow a thin headline to its passage with `memory_expand`, whatever
 * format it asked for. The ids work as given: bare, as `src:<id>`, or as the marker.
 *
 * Real SQLite + embedder; the LLM is stubbed (extraction returns canned facts, the
 * summary/answer formatters return canned prose).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const llmMock = vi.hoisted(() => ({ responses: [] as Array<string | null> }));

vi.mock('../src/llm/client.js', () => ({
  getLLMClient: vi.fn(() => ({})),
  llmComplete: vi.fn(async () => {
    const next = llmMock.responses.shift();
    return next === undefined ? null : next;
  }),
}));

import { createMemoryEngineFromConfig } from '../src/engine-impl.js';
import type { MemoryEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { testModelEnv } from './helpers/test-models.js';
import type { MemoryConfig } from '../src/config.js';
import { handleRecall } from '../src/tools/recall.js';
import { handleExpand, validateExpandInput } from '../src/tools/expand.js';
import { handleContext } from '../src/tools/context.js';
import { segmentIdFromMarker, sourceMarker, sourcesLine } from '../src/utils/source-markers.js';

const NAMESPACE = 'test';

const SOURCE_TEXT = [
  'Release checklist for the Orion service.',
  '',
  'Deployments of Orion happen on Tuesdays after the 10:00 standup, never on Fridays. The deploy needs a green ' +
    'canary in the eu-west region for at least thirty minutes before the global rollout, and the on-call engineer ' +
    'signs off in the release channel.',
  '',
  'Rollbacks of Orion use the previous container tag and must be announced in the incident channel within five ' +
    'minutes. The database migration for a release is applied one day before the deploy.',
].join('\n');

const FACTS = [
  { fact: 'Orion deployments happen on Tuesdays', importance: 0.7 },
  { fact: 'Orion deploys need a green canary before the global rollout', importance: 0.6 },
  { fact: 'Orion rollbacks use the previous container tag', importance: 0.6 },
];

function testConfig(dbPath: string): MemoryConfig {
  return {
    ...loadConfig(testModelEnv()),
    dbPath,
    namespace: NAMESPACE,
    llmApiKey: 'test-key',
    llmBaseUrl: 'http://127.0.0.1:9/v1',
    maintenanceInterval: 10_000,
    rerankerEnabled: false,
  };
}

const SEGMENT_MARKER = /\[src:([0-9a-f]{32})\]/g;

function markersIn(text: string): string[] {
  return [...text.matchAll(SEGMENT_MARKER)].map((m) => m[1]);
}

describe('source markers', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let segmentId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-src-markers-'));
    engine = createMemoryEngineFromConfig(testConfig(join(tmpDir, 'test.db')));
    llmMock.responses = [JSON.stringify(FACTS)];
    const ingested = await engine.ingest(SOURCE_TEXT, { mode: 'document' });
    expect(ingested.segments_created).toBe(1);
    const recalled = await engine.recall({ query: 'Orion deployments', format: 'raw', expand: 'none' });
    const units = JSON.parse(recalled.content) as Array<{ segment_id: string | null }>;
    segmentId = units[0].segment_id ?? '';
    expect(segmentId).toMatch(/^[0-9a-f]{32}$/);
    llmMock.responses = [];
  });

  afterEach(() => {
    engine.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('puts the source marker on every list line of an ingested fact, and the id opens its passage', async () => {
    const result = await handleRecall(engine, { query: 'When are Orion deployments?', format: 'list', expand: 'none' });

    const lines = result.text.split('\n').filter((line) => line.startsWith('- ['));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.endsWith(sourceMarker(segmentId))).toBe(true);
    // The structured result names the same source, for callers that read it.
    expect(result.source_segment_ids).toEqual([segmentId]);

    // The marker's id is what memory_expand takes: the passage is the source text.
    const [id] = markersIn(result.text);
    const passages = await handleExpand(engine, { segment_id: id, query: 'Tuesday deploy rules' });
    expect(passages).toContain('never on Fridays');
  });

  it('ends a summary with a sources line, even though the model rewrote the facts', async () => {
    llmMock.responses = ['Orion is deployed on Tuesdays once its canary is green.'];
    const result = await handleRecall(engine, { query: 'When are Orion deployments?', expand: 'none' });

    expect(result.text).toContain('Orion is deployed on Tuesdays');
    expect(result.text).toContain(sourcesLine([segmentId]));
    expect(markersIn(result.text)).toEqual([segmentId]);
  });

  it('ends an answer with a sources line', async () => {
    llmMock.responses = ['On Tuesdays.'];
    const result = await handleRecall(engine, {
      query: 'Which weekday are Orion deployments?',
      format: 'answer',
      expand: 'none',
    });
    expect(result.text).toContain('On Tuesdays.');
    expect(markersIn(result.text)).toEqual([segmentId]);
  });

  it('keeps the segment id in raw results', async () => {
    const result = await handleRecall(engine, { query: 'Orion rollbacks', format: 'raw', expand: 'none' });
    const parsed = JSON.parse(result.text) as { memories: Array<{ segment_id: string | null }> };
    expect(parsed.memories.length).toBeGreaterThan(0);
    for (const memory of parsed.memories) expect(memory.segment_id).toBe(segmentId);
  });

  it('marks briefing lines of ingested facts', async () => {
    const briefing = await handleContext(engine, {});
    expect(markersIn(briefing).length).toBe(FACTS.length);
    expect(new Set(markersIn(briefing))).toEqual(new Set([segmentId]));
  });

  it('accepts the marker itself, or src:<id>, as the memory_expand segment id', async () => {
    for (const given of [sourceMarker(segmentId), `src:${segmentId}`, ` ${segmentId} `]) {
      expect(validateExpandInput({ segment_id: given }).segment_id).toBe(segmentId);
      expect(await handleExpand(engine, { segment_id: given })).toContain('Release checklist');
    }
    // Anything that is not a marker is passed on as it is.
    expect(segmentIdFromMarker(' plain-id ')).toBe('plain-id');
  });

  it('gives a memory_store fact no marker (it has no source)', async () => {
    await engine.store('The Orion pager rota changes monthly', {});
    const result = await handleRecall(engine, { query: 'Orion pager rota', format: 'list', expand: 'none' });
    const pagerLine = result.text.split('\n').find((line) => line.includes('pager rota'));
    expect(pagerLine).toBeDefined();
    expect(pagerLine).not.toContain('[src:');
  });
});

describe('sourcesLine', () => {
  it('lists distinct ids in first-seen order, and is empty without any', () => {
    expect(sourcesLine(['b', null, 'a', 'b'])).toBe(
      'Sources (pass one to memory_expand as segment_id to read the passage): [src:b] [src:a]',
    );
    expect(sourcesLine([null, null])).toBe('');
  });
});

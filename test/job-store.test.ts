/**
 * Tests for the filesystem-backed job store (CRUD + run records).
 * Uses real temp directories -- no filesystem mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  saveJob,
  loadJob,
  loadAllJobs,
  readJob,
  scanJobs,
  updateJob,
  saveEditedJob,
  deleteJob,
  saveRunRecord,
  loadRecentRuns,
  loadLatestRun,
  listPrunableRunRecords,
  countConsecutiveFailures,
  LATEST_RUN_POINTER_FILE,
} from '../src/cron/job-store.js';
import { createJobId, InvalidJobError, JobNotFoundError, MAX_COUNTED_FAILURES } from '../src/cron/types.js';
import type { JobDefinition, JobId, RunRecord } from '../src/cron/types.js';

const TEST_DIR = resolve(`/tmp/ironcurtain-jobstore-test-${process.pid}`);

function makeJob(id: string, overrides?: Partial<JobDefinition>): JobDefinition {
  return {
    id: createJobId(id),
    name: `Test Job ${id}`,
    schedule: '0 9 * * *',
    taskDescription: 'do something',
    taskConstitution: 'be safe',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
    ...overrides,
  };
}

function makeRunRecord(startedAt: string, overrides?: Partial<RunRecord>): RunRecord {
  return {
    startedAt,
    completedAt: '2026-03-04T09:05:00.000Z',
    outcome: { kind: 'success' },
    budget: { totalTokens: 1000, stepCount: 5, elapsedSeconds: 60, estimatedCostUsd: 0.1 },
    summary: 'All good',
    escalationsEncountered: 0,
    escalationsApproved: 0,
    discardedChanges: null,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.IRONCURTAIN_HOME = TEST_DIR;
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env.IRONCURTAIN_HOME;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('job-store', () => {
  describe('saveJob / loadJob', () => {
    it('round-trips a job definition through save and load', async () => {
      const job = makeJob('my-job');
      await saveJob(job);
      const loaded = loadJob(job.id);
      expect(loaded).toEqual(job);
    });

    it('creates the job directory structure on save', async () => {
      const job = makeJob('new-job');
      await saveJob(job);
      const jobDir = resolve(TEST_DIR, 'jobs', 'new-job');
      expect(existsSync(jobDir)).toBe(true);
      expect(existsSync(resolve(jobDir, 'job.json'))).toBe(true);
    });

    it('overwrites an existing job on re-save', async () => {
      const job = makeJob('overwrite-job');
      await saveJob(job);

      const updated = makeJob('overwrite-job', { name: 'Updated Name' });
      await saveJob(updated);

      const loaded = loadJob(job.id);
      expect(loaded?.name).toBe('Updated Name');
    });

    it('returns undefined for a non-existent job', () => {
      const loaded = loadJob(createJobId('nonexistent'));
      expect(loaded).toBeUndefined();
    });

    it('reports a malformed job file as invalid, not as missing', () => {
      const jobDir = resolve(TEST_DIR, 'jobs', 'bad-job');
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(resolve(jobDir, 'job.json'), 'not json!!!');
      expect(() => loadJob(createJobId('bad-job'))).toThrow(InvalidJobError);
      const read = readJob(createJobId('bad-job'));
      expect(read.kind).toBe('invalid');
      expect(read.kind === 'invalid' && read.error.code).toBe('JOB_INVALID');
      expect(read.kind === 'invalid' && read.error.reason).toMatch(/^not valid JSON/);
      expect(readJob(createJobId('no-such-job'))).toEqual({ kind: 'missing' });
    });

    it('writes job.json atomically, with its trailing newline and no temp file left behind', async () => {
      const job = makeJob('atomic-job');
      await saveJob(job);
      const jobDir = resolve(TEST_DIR, 'jobs', 'atomic-job');
      expect(readFileSync(resolve(jobDir, 'job.json'), 'utf-8')).toBe(JSON.stringify(job, null, 2) + '\n');
      expect(readdirSync(jobDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      // The lock is gone once the save is done.
      expect(existsSync(resolve(jobDir, 'job.lock'))).toBe(false);
    });

    it('keeps fields it does not know when a job is rewritten', async () => {
      const jobDir = resolve(TEST_DIR, 'jobs', 'future-job');
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(resolve(jobDir, 'job.json'), JSON.stringify({ ...makeJob('future-job'), addedLater: { x: 1 } }));

      await updateJob(createJobId('future-job'), (job) => ({ ...job, enabled: false }));
      const raw = JSON.parse(readFileSync(resolve(jobDir, 'job.json'), 'utf-8')) as Record<string, unknown>;
      expect(raw).toMatchObject({ enabled: false, addedLater: { x: 1 } });
    });
  });

  describe('validation (readJob / scanJobs)', () => {
    function writeRawJob(dirName: string, content: string): void {
      const jobDir = resolve(TEST_DIR, 'jobs', dirName);
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(resolve(jobDir, 'job.json'), content);
    }

    it('lists a truncated job.json as invalid instead of dropping it silently', async () => {
      await saveJob(makeJob('good-job'));
      const full = JSON.stringify(makeJob('torn-job'), null, 2);
      writeRawJob('torn-job', full.slice(0, full.length / 2));
      writeRawJob('empty-job', '');

      const scan = scanJobs();
      expect(scan.jobs.map((job) => job.id)).toEqual(['good-job']);
      expect(scan.invalid.map((entry) => entry.jobId)).toEqual(['empty-job', 'torn-job']);
      for (const entry of scan.invalid) {
        expect(entry.reason).toMatch(/^not valid JSON/);
        expect(entry.path).toBe(resolve(TEST_DIR, 'jobs', entry.jobId, 'job.json'));
      }
      // loadAllJobs keeps returning the valid ones only.
      expect(loadAllJobs().map((job) => job.id)).toEqual(['good-job']);
    });

    it('rejects a job.json whose id does not name its directory', () => {
      writeRawJob('renamed', JSON.stringify({ ...makeJob('other-name') }));
      const read = readJob(createJobId('renamed'));
      expect(read.kind === 'invalid' && read.error.reason).toBe(
        'id "other-name" does not match its job directory "renamed"',
      );
    });

    it('rejects missing and mistyped fields, naming them', () => {
      const withoutConstitution: Partial<JobDefinition> = makeJob('fields-job');
      // JobDefinition's fields are readonly; this test builds a broken file on purpose.
      delete (withoutConstitution as { taskConstitution?: string }).taskConstitution;
      writeRawJob('fields-job', JSON.stringify({ ...withoutConstitution, enabled: 'yes' }));
      const read = readJob(createJobId('fields-job'));
      expect(read.kind).toBe('invalid');
      const reason = read.kind === 'invalid' ? read.error.reason : '';
      expect(reason).toContain('taskConstitution');
      expect(reason).toContain('enabled');
    });

    it('rejects budget overrides that are not positive numbers or null', () => {
      writeRawJob('budget-job', JSON.stringify(makeJob('budget-job', { budgetOverrides: { maxSteps: -1 } })));
      expect(readJob(createJobId('budget-job')).kind).toBe('invalid');
      writeRawJob(
        'budget-ok',
        JSON.stringify(makeJob('budget-ok', { budgetOverrides: { maxSteps: null, maxEstimatedCostUsd: 0.5 } })),
      );
      expect(readJob(createJobId('budget-ok')).kind).toBe('ok');
    });

    it('keeps a job with an unparseable schedule loadable, so edit-job can fix it', () => {
      writeRawJob('bad-schedule', JSON.stringify(makeJob('bad-schedule', { schedule: '0 0 31 2 *' })));
      expect(readJob(createJobId('bad-schedule')).kind).toBe('ok');
    });
  });

  describe('updateJob / saveEditedJob', () => {
    it('applies a change to the definition on disk now, never to a stale copy', async () => {
      const original = makeJob('locked-job');
      await saveJob(original);
      // Someone else changed the job after this caller loaded it.
      await saveJob({ ...original, name: 'Renamed elsewhere' });

      const saved = await updateJob(original.id, (current) => ({ ...current, enabled: false }));
      expect(saved).toMatchObject({ name: 'Renamed elsewhere', enabled: false });
      expect(loadJob(original.id)).toEqual(saved);
    });

    it('serializes concurrent updates of one job', async () => {
      await saveJob(makeJob('counter-job', { name: '0' }));
      const bump = (): Promise<JobDefinition> =>
        updateJob(createJobId('counter-job'), (current) => ({ ...current, name: String(Number(current.name) + 1) }));
      await Promise.all([bump(), bump(), bump(), bump()]);
      expect(loadJob(createJobId('counter-job'))?.name).toBe('4');
    });

    it('refuses a job that does not exist or is invalid, without creating anything', async () => {
      await expect(updateJob(createJobId('ghost-job'), (job) => job)).rejects.toThrow(JobNotFoundError);
      expect(existsSync(resolve(TEST_DIR, 'jobs', 'ghost-job'))).toBe(false);

      const jobDir = resolve(TEST_DIR, 'jobs', 'broken-job');
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(resolve(jobDir, 'job.json'), '{');
      await expect(updateJob(createJobId('broken-job'), (job) => job)).rejects.toMatchObject({ code: 'JOB_INVALID' });
      expect(readFileSync(resolve(jobDir, 'job.json'), 'utf-8')).toBe('{');
    });

    it('an edit keeps a change made while the editor was open (a disable-job does not get undone)', async () => {
      const original = makeJob('edited-job', { enabled: true });
      await saveJob(original);
      // While the wizard is open: disable-job.
      await updateJob(original.id, (current) => ({ ...current, enabled: false }));

      // The wizard changed only the name, starting from the enabled copy.
      const saved = await saveEditedJob(original, { ...original, name: 'New name' });
      expect(saved).toMatchObject({ name: 'New name', enabled: false });
      expect(loadJob(original.id)).toEqual(saved);
    });

    it('an edit can remove an optional field', async () => {
      const original = makeJob('optional-job', { gitRepo: 'https://example.invalid/r.git' });
      await saveJob(original);
      const withoutRepo: JobDefinition = { ...original };
      delete (withoutRepo as { gitRepo?: string }).gitRepo;
      const saved = await saveEditedJob(original, withoutRepo);
      expect(saved.gitRepo).toBeUndefined();
      expect(loadJob(original.id)?.gitRepo).toBeUndefined();
    });

    it('an edit of a job removed meanwhile is refused and does not recreate it', async () => {
      const original = makeJob('removed-job');
      await saveJob(original);
      deleteJob(original.id);
      await expect(saveEditedJob(original, { ...original, name: 'x' })).rejects.toThrow(JobNotFoundError);
      expect(existsSync(resolve(TEST_DIR, 'jobs', 'removed-job'))).toBe(false);
    });
  });

  describe('loadAllJobs', () => {
    it('returns an empty array when no jobs directory exists', () => {
      const jobs = loadAllJobs();
      expect(jobs).toEqual([]);
    });

    it('loads all valid jobs from disk', async () => {
      await saveJob(makeJob('alpha'));
      await saveJob(makeJob('beta'));
      await saveJob(makeJob('gamma'));

      const jobs = loadAllJobs();
      expect(jobs).toHaveLength(3);
      const ids = jobs.map((j) => j.id).sort();
      expect(ids).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('skips directories that are not valid job IDs', async () => {
      await saveJob(makeJob('valid-job'));

      // Create a directory with an invalid job ID (uppercase)
      const badDir = resolve(TEST_DIR, 'jobs', 'INVALID');
      mkdirSync(badDir, { recursive: true });

      const jobs = loadAllJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('valid-job');
    });

    it('skips directories with malformed job.json', async () => {
      await saveJob(makeJob('good'));
      const badDir = resolve(TEST_DIR, 'jobs', 'bad');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(resolve(badDir, 'job.json'), '{broken');

      const jobs = loadAllJobs();
      expect(jobs).toHaveLength(1);
    });
  });

  describe('deleteJob', () => {
    it('removes the job directory and all contents', async () => {
      const job = makeJob('doomed');
      await saveJob(job);
      const jobDir = resolve(TEST_DIR, 'jobs', 'doomed');
      expect(existsSync(jobDir)).toBe(true);

      deleteJob(job.id);
      expect(existsSync(jobDir)).toBe(false);
    });

    it('is a no-op for non-existent jobs', () => {
      expect(() => deleteJob(createJobId('ghost'))).not.toThrow();
    });
  });

  describe('saveRunRecord / loadRecentRuns', () => {
    const jobId = createJobId('run-test');

    beforeEach(async () => {
      await saveJob(makeJob('run-test'));
    });

    it('saves and loads a single run record', () => {
      const record = makeRunRecord('2026-03-04T09:00:00.000Z');
      saveRunRecord(jobId, record);

      const runs = loadRecentRuns(jobId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toEqual(record);
    });

    it('returns runs in reverse chronological order', () => {
      saveRunRecord(jobId, makeRunRecord('2026-03-01T09:00:00.000Z'));
      saveRunRecord(jobId, makeRunRecord('2026-03-03T09:00:00.000Z'));
      saveRunRecord(jobId, makeRunRecord('2026-03-02T09:00:00.000Z'));

      const runs = loadRecentRuns(jobId);
      expect(runs).toHaveLength(3);
      expect(runs[0].startedAt).toBe('2026-03-03T09:00:00.000Z');
      expect(runs[1].startedAt).toBe('2026-03-02T09:00:00.000Z');
      expect(runs[2].startedAt).toBe('2026-03-01T09:00:00.000Z');
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        saveRunRecord(jobId, makeRunRecord(`2026-03-0${i + 1}T09:00:00.000Z`));
      }

      const runs = loadRecentRuns(jobId, 2);
      expect(runs).toHaveLength(2);
    });

    it('returns an empty array when no runs exist', () => {
      const runs = loadRecentRuns(jobId);
      expect(runs).toEqual([]);
    });

    it('returns an empty array for a non-existent job', () => {
      const runs = loadRecentRuns(createJobId('no-such-job'));
      expect(runs).toEqual([]);
    });

    it('stores different outcome types correctly', () => {
      saveRunRecord(
        jobId,
        makeRunRecord('2026-03-01T09:00:00.000Z', {
          outcome: { kind: 'error', message: 'something broke' },
        }),
      );
      saveRunRecord(
        jobId,
        makeRunRecord('2026-03-02T09:00:00.000Z', {
          outcome: { kind: 'budget_exhausted', dimension: 'tokens' },
        }),
      );

      const runs = loadRecentRuns(jobId);
      expect(runs[0].outcome).toEqual({ kind: 'budget_exhausted', dimension: 'tokens' });
      expect(runs[1].outcome).toEqual({ kind: 'error', message: 'something broke' });
    });

    it('stores the phase of a failed run', () => {
      const record = makeRunRecord('2026-03-01T09:00:00.000Z', {
        outcome: { kind: 'error', phase: 'sync', message: 'Git sync failed: boom' },
      });
      saveRunRecord(jobId, record);
      expect(loadRecentRuns(jobId)).toEqual([record]);
    });

    it('writes run records atomically, with a trailing newline and no temp file left behind', () => {
      const record = makeRunRecord('2026-03-05T09:00:00.000Z');
      saveRunRecord(jobId, record);
      const runsDir = resolve(TEST_DIR, 'jobs', 'run-test', 'runs');
      // The record, and the pointer the job listings read instead of the directory.
      expect(readdirSync(runsDir).sort()).toEqual(['2026-03-05T09-00-00.000Z.json', LATEST_RUN_POINTER_FILE]);
      expect(readFileSync(resolve(runsDir, '2026-03-05T09-00-00.000Z.json'), 'utf-8')).toBe(
        JSON.stringify(record, null, 2) + '\n',
      );
    });

    it('never recreates the directory of a job removed while it ran', () => {
      deleteJob(jobId);
      expect(() => saveRunRecord(jobId, makeRunRecord('2026-03-01T09:00:00.000Z'))).toThrow(/ENOENT/);
      expect(existsSync(resolve(TEST_DIR, 'jobs', 'run-test'))).toBe(false);
    });
  });

  describe('countConsecutiveFailures', () => {
    const jobId = createJobId('streak-job');
    const error = (message: string): RunRecord['outcome'] => ({ kind: 'error', phase: 'setup', message });

    beforeEach(async () => {
      await saveJob(makeJob('streak-job'));
    });

    it('is zero without runs and after a run that did not fail', () => {
      expect(countConsecutiveFailures(jobId)).toBe(0);
      saveRunRecord(jobId, makeRunRecord('2026-03-01T09:00:00.000Z', { outcome: error('a') }));
      saveRunRecord(jobId, makeRunRecord('2026-03-02T09:00:00.000Z'));
      expect(countConsecutiveFailures(jobId)).toBe(0);
      saveRunRecord(
        jobId,
        makeRunRecord('2026-03-03T09:00:00.000Z', { outcome: { kind: 'budget_exhausted', dimension: 'steps' } }),
      );
      expect(countConsecutiveFailures(jobId)).toBe(0);
    });

    it('counts the failed runs since the last run that did not fail, skipping malformed records', () => {
      saveRunRecord(jobId, makeRunRecord('2026-03-01T09:00:00.000Z', { outcome: error('old') }));
      saveRunRecord(jobId, makeRunRecord('2026-03-02T09:00:00.000Z'));
      saveRunRecord(jobId, makeRunRecord('2026-03-03T09:00:00.000Z', { outcome: error('one') }));
      writeFileSync(resolve(TEST_DIR, 'jobs', 'streak-job', 'runs', '2026-03-04T09-00-00.000Z.json'), '{broken');
      saveRunRecord(
        jobId,
        makeRunRecord('2026-03-05T09:00:00.000Z', { outcome: { kind: 'error', message: 'pre-phase record' } }),
      );
      expect(countConsecutiveFailures(jobId)).toBe(2);
    });

    it('skips parseable records that carry no outcome kind instead of throwing', () => {
      saveRunRecord(jobId, makeRunRecord('2026-03-01T09:00:00.000Z', { outcome: error('counted') }));
      const runsDir = resolve(TEST_DIR, 'jobs', 'streak-job', 'runs');
      ['{}', '[]', '1', '"x"', '{"outcome":null}', '{"outcome":{}}', '{"outcome":{"kind":7}}'].forEach((body, i) => {
        writeFileSync(resolve(runsDir, `2026-03-0${i + 2}T09-00-00.000Z.json`), body);
      });
      expect(countConsecutiveFailures(jobId)).toBe(1);
    });

    it('counts nothing for an id that names no job directory instead of throwing', () => {
      // loadAllJobs() returns the id written inside job.json, which a hand edit can break.
      expect(countConsecutiveFailures('My Job' as JobId)).toBe(0);
      expect(countConsecutiveFailures(undefined as unknown as JobId)).toBe(0);
    });

    it(`stops counting at ${MAX_COUNTED_FAILURES}`, () => {
      for (let day = 0; day < MAX_COUNTED_FAILURES + 5; day++) {
        const startedAt = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000).toISOString();
        saveRunRecord(jobId, makeRunRecord(startedAt, { outcome: error(`run ${day}`) }));
      }
      expect(countConsecutiveFailures(jobId)).toBe(MAX_COUNTED_FAILURES);
    });
  });

  describe('latest.json pointer and pruning', () => {
    const jobId = createJobId('pointer-job');
    const runsDir = (): string => resolve(TEST_DIR, 'jobs', 'pointer-job', 'runs');
    const pointer = (): { version: number; file: string; consecutiveFailures: number } =>
      JSON.parse(readFileSync(resolve(runsDir(), LATEST_RUN_POINTER_FILE), 'utf-8')) as {
        version: number;
        file: string;
        consecutiveFailures: number;
      };
    const failed = (message: string): RunRecord['outcome'] => ({ kind: 'error', phase: 'session', message });

    beforeEach(async () => {
      await saveJob(makeJob('pointer-job'));
    });

    it('points latest.json at the newest record and carries the failure streak', () => {
      saveRunRecord(jobId, makeRunRecord('2026-03-01T09:00:00.000Z', { outcome: failed('a') }));
      expect(pointer()).toEqual({ version: 1, file: '2026-03-01T09-00-00.000Z.json', consecutiveFailures: 1 });
      saveRunRecord(jobId, makeRunRecord('2026-03-02T09:00:00.000Z', { outcome: failed('b') }));
      expect(pointer()).toEqual({ version: 1, file: '2026-03-02T09-00-00.000Z.json', consecutiveFailures: 2 });
      saveRunRecord(jobId, makeRunRecord('2026-03-03T09:00:00.000Z'));
      expect(pointer()).toEqual({ version: 1, file: '2026-03-03T09-00-00.000Z.json', consecutiveFailures: 0 });
      expect(loadLatestRun(jobId)?.startedAt).toBe('2026-03-03T09:00:00.000Z');
    });

    it('reads the latest run through the pointer, not by listing the directory', () => {
      saveRunRecord(jobId, makeRunRecord('2026-03-01T09:00:00.000Z', { summary: 'first' }));
      // A record named like a newer one, written behind the store's back, is not
      // what the pointer names; the listing (loadRecentRuns) still sees it.
      writeFileSync(
        resolve(runsDir(), '2026-03-09T09-00-00.000Z.json'),
        JSON.stringify(makeRunRecord('2026-03-09T09:00:00.000Z', { summary: 'stray' })),
      );
      expect(loadLatestRun(jobId)?.summary).toBe('first');
      expect(loadRecentRuns(jobId, 1)[0]?.summary).toBe('stray');
    });

    it('falls back to the directory when the pointer is missing, malformed or names a missing record', () => {
      saveRunRecord(jobId, makeRunRecord('2026-03-01T09:00:00.000Z', { outcome: failed('a') }));
      saveRunRecord(jobId, makeRunRecord('2026-03-02T09:00:00.000Z', { outcome: failed('b') }));
      const pointerPath = resolve(runsDir(), LATEST_RUN_POINTER_FILE);

      rmSync(pointerPath);
      expect(loadLatestRun(jobId)?.startedAt).toBe('2026-03-02T09:00:00.000Z');
      expect(countConsecutiveFailures(jobId)).toBe(2);

      writeFileSync(pointerPath, '{not json');
      expect(loadLatestRun(jobId)?.startedAt).toBe('2026-03-02T09:00:00.000Z');
      expect(countConsecutiveFailures(jobId)).toBe(2);

      writeFileSync(
        pointerPath,
        JSON.stringify({ version: 1, file: '2026-03-07T09-00-00.000Z.json', consecutiveFailures: 9 }),
      );
      expect(loadLatestRun(jobId)?.startedAt).toBe('2026-03-02T09:00:00.000Z');
      expect(countConsecutiveFailures(jobId)).toBe(2);

      // A pointer naming something that is not a record is ignored too.
      writeFileSync(pointerPath, JSON.stringify({ version: 1, file: '../../job.json', consecutiveFailures: 0 }));
      expect(countConsecutiveFailures(jobId)).toBe(2);
    });

    it('recounts the streak from the records when a run is saved out of order', () => {
      saveRunRecord(jobId, makeRunRecord('2026-03-05T09:00:00.000Z', { outcome: failed('newest') }));
      // The clock went back: an older start time is saved after a newer one.
      saveRunRecord(jobId, makeRunRecord('2026-03-04T09:00:00.000Z'));
      expect(pointer()).toEqual({ version: 1, file: '2026-03-05T09-00-00.000Z.json', consecutiveFailures: 1 });
    });

    it('lists the records beyond the newest N for pruning, never the pointer or what it names', () => {
      for (let day = 1; day <= 6; day++) {
        saveRunRecord(jobId, makeRunRecord(`2026-03-0${day}T09:00:00.000Z`));
      }
      writeFileSync(resolve(runsDir(), 'notes.txt'), 'not a record');
      const prunable = listPrunableRunRecords(jobId, 4);
      expect(prunable.runsDir).toBe(runsDir());
      expect(prunable.kept).toBe(4);
      expect(prunable.files).toEqual(['2026-03-02T09-00-00.000Z.json', '2026-03-01T09-00-00.000Z.json']);
      expect(listPrunableRunRecords(jobId, 0).files).toHaveLength(5); // at least one record is kept
      expect(listPrunableRunRecords(jobId, 10).files).toEqual([]);
    });

    it('keeps the failure streak when old records are pruned', () => {
      for (let day = 1; day <= 5; day++) {
        saveRunRecord(jobId, makeRunRecord(`2026-03-0${day}T09:00:00.000Z`, { outcome: failed(`run ${day}`) }));
      }
      for (const file of listPrunableRunRecords(jobId, 2).files) rmSync(resolve(runsDir(), file));
      expect(loadRecentRuns(jobId)).toHaveLength(2);
      expect(countConsecutiveFailures(jobId)).toBe(5);
    });
  });
});

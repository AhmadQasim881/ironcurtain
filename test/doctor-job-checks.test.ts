/**
 * `ironcurtain doctor` names every cron job whose job.json is invalid (so the
 * daemon does not schedule it) with `INVALID: <reason>`, escaped.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveJob } from '../src/cron/job-store.js';
import { createJobId, type JobDefinition } from '../src/cron/types.js';
import { checkJobDefinitions } from '../src/doctor/job-checks.js';

function job(id: string): JobDefinition {
  return {
    id: createJobId(id),
    name: `Job ${id}`,
    schedule: '0 9 * * *',
    taskDescription: 'task',
    taskConstitution: 'constitution',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
  };
}

describe('doctor: cron job definitions', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ic-doctor-jobs-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('is ok when there are no jobs, or only valid ones', async () => {
    expect(checkJobDefinitions()).toMatchObject({ status: 'ok', message: 'no jobs configured' });
    await saveJob(job('fine'));
    expect(checkJobDefinitions()).toMatchObject({ status: 'ok', message: '1 job definition(s) valid' });
  });

  it('warns about each invalid job.json with its reason, escaped', async () => {
    await saveJob(job('fine'));
    mkdirSync(join(home, 'jobs', 'torn'), { recursive: true });
    writeFileSync(join(home, 'jobs', 'torn', 'job.json'), '{"id": "torn", "name": "\u001b[2J');

    const result = checkJobDefinitions();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('1 job.json file(s) invalid');
    expect(result.message).toContain('torn: INVALID: not valid JSON');
    expect(result.message).not.toContain('\u001b');
    expect(result.hint).toContain('ironcurtain daemon remove-job');
  });
});

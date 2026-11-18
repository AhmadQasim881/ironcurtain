/**
 * Wall-clock behaviour of the cron scheduler, in a real DST time zone
 * (America/New_York: 2026-03-08 02:00 EST jumps to 03:00 EDT, 2026-11-01
 * 02:00 EDT falls back to 01:00 EST), driven by fake timers polling every 30 s:
 *
 * - a job whose time falls in the spring-forward gap runs exactly once, at the
 *   first minute after the gap (fixed-time jobs), while a job whose minute or
 *   hour field starts with `*` skips the gap without an extra run;
 * - the repeated fall-back hour does not run a fixed-time job twice, while a
 *   wildcard job runs on through both occurrences (Vixie cron);
 * - a minor clock set back does not re-run a fixed-time job's last run;
 * - impossible day/month combinations are rejected, rare ones (Feb 29) get
 *   their real next date instead of an invented one;
 * - next run times are cached, and recomputed after a fire or a clock set back;
 * - a fire time missed while the machine slept is reported once as `missed`.
 *
 * Each test file runs in its own worker process, so setting TZ here affects
 * no other file.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createCronScheduler,
  getNextFireTime,
  InvalidCronExpressionError,
  parseCronExpression,
  type CronScheduler,
  type JobTrigger,
} from '../src/cron/cron-scheduler.js';
import { createJobId, type JobDefinition } from '../src/cron/types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let savedTz: string | undefined;

beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
});

afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

function makeJob(id: string, schedule: string): JobDefinition {
  return {
    id: createJobId(id),
    name: `Test ${id}`,
    schedule,
    taskDescription: 'test task',
    taskConstitution: 'test constitution',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
  };
}

/** The ISO (UTC) instants at which `schedule` fires while the fake clock runs from `startUtc` for `durationMs`. */
function firesBetween(
  schedule: string,
  startUtc: number,
  durationMs: number,
): { fires: string[]; triggers: JobTrigger[] } {
  vi.useFakeTimers({ now: startUtc });
  const fires: string[] = [];
  const triggers: JobTrigger[] = [];
  const scheduler = createCronScheduler();
  scheduler.schedule(makeJob('dst-job', schedule), async (_job, trigger) => {
    fires.push(new Date().toISOString());
    triggers.push(trigger);
  });
  vi.advanceTimersByTime(durationMs);
  scheduler.unscheduleAll();
  return { fires, triggers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('cron scheduler around DST (America/New_York)', () => {
  it('runs in the DST zone (the other tests would prove nothing in UTC)', () => {
    expect(new Date(Date.UTC(2026, 2, 8, 6, 59)).getHours()).toBe(1); // 01:59 EST
    expect(new Date(Date.UTC(2026, 2, 8, 7, 0)).getHours()).toBe(3); // 03:00 EDT
  });

  it('runs exactly once a job whose time falls in the spring-forward gap, at the first minute after it', () => {
    // 2026-03-08 00:00 EST (05:00Z) through 2026-03-09 12:00 EDT.
    const { fires, triggers } = firesBetween('30 2 * * *', Date.UTC(2026, 2, 8, 5, 0), 36 * HOUR);

    // 03:00 EDT = 07:00Z on the 8th; then 02:30 EDT = 06:30Z on the 9th.
    expect(fires.map((iso) => iso.slice(0, 16))).toEqual(['2026-03-08T07:00', '2026-03-09T06:30']);
    expect(triggers.map((trigger) => trigger.kind)).toEqual(['scheduled', 'scheduled']);
  });

  it('runs the common 0 2 * * * once on the spring-forward day', () => {
    const { fires } = firesBetween('0 2 * * *', Date.UTC(2026, 2, 8, 5, 0), 12 * HOUR);
    expect(fires.map((iso) => iso.slice(0, 16))).toEqual(['2026-03-08T07:00']);
  });

  it('collapses every minute a fixed-time job had in the gap into one run', () => {
    const { fires } = firesBetween('0,15,30,45 2 * * *', Date.UTC(2026, 2, 8, 5, 0), 12 * HOUR);
    expect(fires.map((iso) => iso.slice(0, 16))).toEqual(['2026-03-08T07:00']);
  });

  it('does not give an hourly job (hour field *) an extra run at the end of the gap', () => {
    // 01:00 EST (06:00Z) through 05:00 EDT (09:00Z).
    const { fires } = firesBetween('30 * * * *', Date.UTC(2026, 2, 8, 6, 0), 3 * HOUR);
    // 01:30 EST, then 03:30 and 04:30 EDT: 02:30 does not exist and is skipped.
    expect(fires.map((iso) => iso.slice(0, 16))).toEqual(['2026-03-08T06:30', '2026-03-08T07:30', '2026-03-08T08:30']);
  });

  it('keeps an every-15-minutes job regular across the gap', () => {
    const { fires } = firesBetween('*/15 * * * *', Date.UTC(2026, 2, 8, 6, 40), 40 * MINUTE);
    // 01:45 EST, then 03:00 and 03:15 EDT.
    expect(fires.map((iso) => iso.slice(0, 16))).toEqual(['2026-03-08T06:45', '2026-03-08T07:00', '2026-03-08T07:15']);
  });

  it('runs a fixed-time job once in the repeated fall-back hour', () => {
    // 2026-11-01 00:00 EDT (04:00Z) through 04:00 EST (09:00Z).
    const { fires } = firesBetween('30 1 * * *', Date.UTC(2026, 10, 1, 4, 0), 5 * HOUR);
    // 01:30 EDT = 05:30Z only; 01:30 EST (06:30Z) is the same wall-clock minute.
    expect(fires.map((iso) => iso.slice(0, 16))).toEqual(['2026-11-01T05:30']);

    // Each of several fixed minutes in the repeated hour runs once, too.
    const twice = firesBetween('0,30 1 * * *', Date.UTC(2026, 10, 1, 4, 0), 5 * HOUR);
    expect(twice.fires.map((iso) => iso.slice(0, 16))).toEqual(['2026-11-01T05:00', '2026-11-01T05:30']);
  });

  it('keeps an every-20-minutes job running through both occurrences of the repeated hour', () => {
    // 00:40 EDT (04:40Z) through 02:10 EST (07:10Z).
    const { fires, triggers } = firesBetween('*/20 * * * *', Date.UTC(2026, 10, 1, 4, 40), 150 * MINUTE);
    // 01:00/01:20/01:40 EDT, then 01:00/01:20/01:40 EST, then 02:00 EST: no
    // 80-minute hole in an every-20-minutes job.
    expect(fires.map((iso) => iso.slice(0, 16))).toEqual([
      '2026-11-01T05:00',
      '2026-11-01T05:20',
      '2026-11-01T05:40',
      '2026-11-01T06:00',
      '2026-11-01T06:20',
      '2026-11-01T06:40',
      '2026-11-01T07:00',
    ]);
    expect(new Set(triggers.map((trigger) => trigger.kind))).toEqual(new Set(['scheduled']));
  });

  it('runs an hourly job (hour field *) at both 01:00s of the fall-back night', () => {
    const { fires } = firesBetween('0 * * * *', Date.UTC(2026, 10, 1, 4, 30), 3 * HOUR);
    expect(fires.map((iso) => iso.slice(0, 16))).toEqual(['2026-11-01T05:00', '2026-11-01T06:00', '2026-11-01T07:00']);
  });

  it('picks up the second occurrence when started during the repeated hour', () => {
    // 01:05 EST (06:05Z): an every-20-minutes job next runs at 01:20 EST, not 02:00.
    expect(
      getNextFireTime(parseCronExpression('*/20 * * * *'), new Date(Date.UTC(2026, 10, 1, 6, 5)))?.toISOString(),
    ).toBe('2026-11-01T06:20:00.000Z');
    // From 01:45 EDT (05:45Z): the next 01:00 is the EST one, an hour later.
    expect(
      getNextFireTime(parseCronExpression('0 * * * *'), new Date(Date.UTC(2026, 10, 1, 5, 45)))?.toISOString(),
    ).toBe('2026-11-01T06:00:00.000Z');
  });

  it('computes next fire times by wall-clock arithmetic across the transitions', () => {
    const fields = parseCronExpression('30 2 * * *');
    // From 01:59 EST on the gap day: the gap end, 03:00 EDT.
    expect(getNextFireTime(fields, new Date(Date.UTC(2026, 2, 8, 6, 59)))?.toISOString()).toBe(
      '2026-03-08T07:00:00.000Z',
    );
    // From the gap end itself: the next day.
    expect(getNextFireTime(fields, new Date(Date.UTC(2026, 2, 8, 7, 0)))?.toISOString()).toBe(
      '2026-03-09T06:30:00.000Z',
    );
    // During the second 01:xx of fall-back, a 01:45 job already ran (at 01:45 EDT).
    expect(
      getNextFireTime(parseCronExpression('45 1 * * *'), new Date(Date.UTC(2026, 10, 1, 6, 15)))?.toISOString(),
    ).toBe('2026-11-02T06:45:00.000Z');
  });
});

describe('cron schedules that are rare or impossible', () => {
  it('rejects a day of month that never occurs in its months when day-of-week is *', () => {
    expect(() => parseCronExpression('0 0 31 2 *')).toThrow(/never occurs in Feb/);
    expect(() => parseCronExpression('0 0 30 2 *')).toThrow(/never/);
    expect(() => parseCronExpression('0 0 31 4,6,9,11 *')).toThrow(/never/);
    expect(() => createCronScheduler().schedule(makeJob('impossible', '0 0 31 2 *'), async () => {})).toThrow(
      InvalidCronExpressionError,
    );
  });

  it('accepts the rare but possible ones, and a restricted day-of-week (cron ORs the day fields)', () => {
    expect(() => parseCronExpression('0 0 29 2 *')).not.toThrow();
    expect(() => parseCronExpression('0 0 31 1-12 *')).not.toThrow();
    expect(() => parseCronExpression('0 0 30,31 2,3 *')).not.toThrow();
    // Day 31 of February OR every Monday in February: runs on the Mondays.
    const fields = parseCronExpression('0 0 31 2 1');
    expect(getNextFireTime(fields, new Date(2027, 0, 15))?.getDate()).toBe(1); // Mon 2027-02-01
  });

  it('finds the real next February 29 instead of inventing a date a year out', () => {
    const fields = parseCronExpression('0 0 29 2 *');
    const next = getNextFireTime(fields, new Date(2026, 10, 7, 12, 0));
    expect(next && [next.getFullYear(), next.getMonth() + 1, next.getDate(), next.getHours()]).toEqual([
      2028, 2, 29, 0,
    ]);
  });

  it('searches far enough ahead to jump the non-leap year 2100', () => {
    const fields = parseCronExpression('0 0 29 2 *');
    const next = getNextFireTime(fields, new Date(2096, 2, 1));
    expect(next && [next.getFullYear(), next.getMonth() + 1, next.getDate()]).toEqual([2104, 2, 29]);
  });

  it('returns undefined rather than a made-up date when nothing fires in the horizon', () => {
    // Not reachable from a parsed expression; built by hand to exercise the bound.
    const fields = { ...parseCronExpression('0 0 1 1 *'), months: new Set<number>() };
    expect(getNextFireTime(fields, new Date(2026, 0, 1))).toBeUndefined();
  });
});

describe('cron scheduler caching and missed runs', () => {
  let scheduler: CronScheduler;

  afterEach(() => {
    scheduler.unscheduleAll();
  });

  it('caches the next run and recomputes it only after the job fires', () => {
    vi.useFakeTimers({ now: new Date(2026, 5, 1, 8, 59, 10) });
    const fired: string[] = [];
    scheduler = createCronScheduler();
    const job = makeJob('cached', '0 9 * * *');
    scheduler.schedule(job, async () => {
      fired.push(new Date().toISOString());
    });

    const first = scheduler.getNextRun(job.id);
    expect(first).toEqual(new Date(2026, 5, 1, 9, 0));
    // The same cached value, not a fresh scan.
    expect(scheduler.getNextRun(job.id)).toBe(first);

    vi.advanceTimersByTime(2 * MINUTE);
    expect(fired).toHaveLength(1);
    expect(scheduler.getNextRun(job.id)).toEqual(new Date(2026, 5, 2, 9, 0));
    expect(scheduler.getScheduledJob(job.id)).toBe(job);
  });

  it('reports a run missed while the machine slept once, as missed, and moves on', () => {
    vi.useFakeTimers({ now: new Date(2026, 5, 1, 8, 0) });
    const triggers: JobTrigger[] = [];
    scheduler = createCronScheduler();
    const job = makeJob('sleeper', '*/5 * * * *');
    scheduler.schedule(job, async (_job, trigger) => {
      triggers.push(trigger);
    });

    // The machine sleeps from 08:00 to 11:00: no poll runs meanwhile.
    vi.setSystemTime(new Date(2026, 5, 1, 11, 0, 10));
    vi.advanceTimersByTime(30_000);

    expect(triggers).toEqual([{ kind: 'missed', scheduledFor: new Date(2026, 5, 1, 8, 5) }]);
    expect(scheduler.getNextRun(job.id)).toEqual(new Date(2026, 5, 1, 11, 5));
  });

  it('still runs a fire time reached a few minutes late (blocked event loop) as scheduled', () => {
    vi.useFakeTimers({ now: new Date(2026, 5, 1, 8, 59, 50) });
    const triggers: JobTrigger[] = [];
    scheduler = createCronScheduler();
    scheduler.schedule(makeJob('late', '0 9 * * *'), async (_job, trigger) => {
      triggers.push(trigger);
    });

    vi.setSystemTime(new Date(2026, 5, 1, 9, 3, 0));
    vi.advanceTimersByTime(30_000);
    expect(triggers).toEqual([{ kind: 'scheduled', scheduledFor: new Date(2026, 5, 1, 9, 0) }]);
  });

  it('recomputes next runs when the clock is set back', () => {
    vi.useFakeTimers({ now: new Date(2026, 5, 1, 10, 0) });
    const fired: string[] = [];
    scheduler = createCronScheduler();
    const job = makeJob('setback', '0 9 * * *');
    scheduler.schedule(job, async () => {
      fired.push(new Date().toISOString());
    });
    expect(scheduler.getNextRun(job.id)).toEqual(new Date(2026, 5, 2, 9, 0));

    vi.setSystemTime(new Date(2026, 5, 1, 8, 0));
    vi.advanceTimersByTime(30_000);
    expect(scheduler.getNextRun(job.id)).toEqual(new Date(2026, 5, 1, 9, 0));

    vi.advanceTimersByTime(HOUR + MINUTE);
    expect(fired).toHaveLength(1);
  });

  it('does not re-run a fixed-time job when a minor clock correction brings its time round again', () => {
    vi.useFakeTimers({ now: new Date(2026, 5, 1, 8, 59, 50) });
    const fired: string[] = [];
    scheduler = createCronScheduler();
    const job = makeJob('ntp', '0 9 * * *');
    scheduler.schedule(job, async () => {
      fired.push(new Date().toISOString());
    });
    vi.advanceTimersByTime(MINUTE); // fires at 09:00
    expect(fired).toHaveLength(1);

    // NTP steps the clock back 3 minutes (it ran fast): 09:00 comes again.
    vi.setSystemTime(new Date(2026, 5, 1, 8, 57, 50));
    vi.advanceTimersByTime(10 * MINUTE);
    expect(fired).toHaveLength(1);
    expect(scheduler.getNextRun(job.id)).toEqual(new Date(2026, 5, 2, 9, 0));
  });

  it('after a minor set back keeps a wildcard job running, and after a big one starts afresh', () => {
    vi.useFakeTimers({ now: new Date(2026, 5, 1, 8, 59, 50) });
    const fired: Record<string, number> = { wild: 0, fixed: 0 };
    scheduler = createCronScheduler();
    scheduler.schedule(makeJob('wild', '*/5 * * * *'), async () => {
      fired.wild += 1;
    });
    scheduler.schedule(makeJob('fixed', '0 9 * * *'), async () => {
      fired.fixed += 1;
    });
    vi.advanceTimersByTime(MINUTE); // both fire at 09:00
    expect(fired).toEqual({ wild: 1, fixed: 1 });

    // A minor set back (the next poll sees 08:53:20): the wildcard job runs
    // on, at 08:55 and 09:00 again; the fixed-time job does not.
    vi.setSystemTime(new Date(2026, 5, 1, 8, 52, 50));
    vi.advanceTimersByTime(8 * MINUTE);
    expect(fired).toEqual({ wild: 3, fixed: 1 });

    // A set back of a day (the clock was wrong): everything starts afresh.
    vi.setSystemTime(new Date(2026, 4, 31, 8, 58, 50));
    vi.advanceTimersByTime(2 * MINUTE);
    expect(fired).toEqual({ wild: 4, fixed: 2 });
  });
});

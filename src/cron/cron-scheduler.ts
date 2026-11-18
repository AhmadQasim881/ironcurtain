/**
 * CronScheduler -- manages cron schedules for all enabled jobs.
 *
 * Each scheduled job caches its next fire time, computed by field arithmetic
 * over local wall-clock time (see {@link getNextFireTime}) when the job is
 * scheduled and again each time it fires; status and job listings read the
 * cached value. A poll every 30 seconds fires every job whose time has come.
 *
 * Wall-clock rules (local time zone, Vixie cron style). A *fixed-time* job
 * has minute and hour fields that do not start with `*` (`30 2 * * *`); a
 * *wildcard* job has one that does (`*\/5 * * * *`, `30 * * * *`), Vixie
 * cron's MIN_STAR / HR_STAR.
 * - A fixed-time job fires each scheduled wall-clock minute at most once: in
 *   the repeated hour after a fall-back transition, at its first occurrence
 *   only. A wildcard job runs on every real minute that matches, so in the
 *   repeated hour it runs at both occurrences (an every-5-minutes job keeps
 *   running every 5 minutes).
 * - A minute that does not exist because a spring-forward transition skipped
 *   it (02:30 on the night clocks jump from 02:00 to 03:00) fires at the
 *   first minute after the gap (03:00) for a fixed-time job, once however
 *   many of its minutes the gap swallowed. A wildcard job skips the gap
 *   instead: it runs again at its next minute that exists.
 * - A fire time the poll reaches more than {@link LATE_FIRE_GRACE_MS} late
 *   (the machine slept, or the event loop was blocked) is reported as
 *   `missed`, once per job however many fire times the gap covered; the
 *   trigger callback decides whether to catch it up.
 * - When the clock is set back, every next fire time is recomputed. After a
 *   set back of at most {@link MAX_MINOR_SET_BACK_MS} (an NTP correction,
 *   say) a fixed-time job does not run again a time it has already run;
 *   wildcard jobs run on. A bigger set back starts afresh.
 *
 * Expressions whose day-of-month never occurs in any of their months
 * (`0 0 31 2 *`) are rejected when parsed, and a next fire time that cannot
 * be found is reported as undefined, never invented.
 */

import type { JobDefinition, JobId } from './types.js';
import * as logger from '../logger.js';

/**
 * Why a trigger fired: `scheduled` when the poll reached the job's fire time
 * on time (at most {@link LATE_FIRE_GRACE_MS} late), `missed` when the time
 * passed long before the poll saw it (later fire times missed in the same
 * gap are folded into this one trigger).
 */
export type JobTriggerKind = 'scheduled' | 'missed';

/** The fire time a trigger is for. */
export interface JobTrigger {
  readonly kind: JobTriggerKind;
  /** When the run was due. */
  readonly scheduledFor: Date;
}

/**
 * Callback invoked when a scheduled job fires.
 * The daemon implements this to create a session.
 */
export type JobTriggerCallback = (job: JobDefinition, trigger: JobTrigger) => Promise<void>;

/**
 * Manages cron schedules for all enabled jobs.
 *
 * Invariant: at most one schedule exists per jobId at any time.
 * Calling schedule() for an already-scheduled job replaces the
 * previous schedule.
 */
export interface CronScheduler {
  /**
   * Registers a job's schedule. The callback fires at each
   * scheduled time. Does not fire immediately.
   *
   * @throws InvalidCronExpressionError if the cron expression
   * is syntactically invalid or can never fire.
   */
  schedule(job: JobDefinition, onTrigger: JobTriggerCallback): void;

  /** Removes a job's schedule. No-op if not scheduled. */
  unschedule(jobId: JobId): void;

  /** Removes all schedules. Called during shutdown. */
  unscheduleAll(): void;

  /**
   * Returns the next scheduled fire time for a job (cached, not recomputed),
   * or undefined if the job is not scheduled.
   */
  getNextRun(jobId: JobId): Date | undefined;

  /** The definition a job is scheduled with, or undefined when it is not scheduled. */
  getScheduledJob(jobId: JobId): JobDefinition | undefined;
}

export interface CronSchedulerOptions {
  /** Clock (default `new Date()`); tests drive time through it or fake timers. */
  readonly now?: () => Date;
  /** Poll interval (default {@link POLL_INTERVAL_MS}). */
  readonly pollIntervalMs?: number;
}

/**
 * Thrown when a cron expression cannot be parsed.
 */
export class InvalidCronExpressionError extends Error {
  constructor(
    readonly expression: string,
    cause: unknown,
  ) {
    super(`Invalid cron expression "${expression}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'InvalidCronExpressionError';
  }
}

/** Poll interval (within the 60-second cron granularity). */
export const POLL_INTERVAL_MS = 30_000;

/**
 * A fire time reached at most this late still runs as `scheduled` (a slow
 * poll, a briefly blocked event loop). Later than that it is `missed`.
 */
export const LATE_FIRE_GRACE_MS = 5 * 60_000;

/** A clock that went back further than this between polls recomputes every next fire time. */
const CLOCK_SET_BACK_MS = 60_000;

const MINUTE_MS = 60_000;

/**
 * A clock set back by at most this much (Vixie cron's limit for treating a
 * jump as DST-like) does not make a fixed-time job run a time again.
 */
export const MAX_MINOR_SET_BACK_MS = 3 * 60 * MINUTE_MS;

/**
 * Longest repeated wall-clock stretch (fall-back) looked for around a fire
 * time. Real ones last an hour, 30 minutes (Lord Howe) or two hours
 * (Antarctica/Troll).
 */
const MAX_FALL_BACK_MS = 3 * 60 * MINUTE_MS;

/** Step of the scan for fall-back transitions (real ones are months apart). */
const TRANSITION_SCAN_STEP_MS = 15 * MINUTE_MS;

/**
 * How far ahead the next fire time is searched. Every expression that
 * parses fires within 8 years (`0 0 29 2 *` from 2096 waits for 2104).
 */
const SEARCH_HORIZON_MS = 10 * 366 * 24 * 60 * MINUTE_MS;

/** Longest spring-forward gap stepped over (Samoa skipped a whole day in 2011). */
const MAX_GAP_MINUTES = 48 * 60;

// ---------------------------------------------------------------------------
// Cron expression parsing (minimal 5-field parser)
// ---------------------------------------------------------------------------

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** The minute field starts with `*` (Vixie cron's MIN_STAR). */
  minuteWildcard: boolean;
  /** The hour field starts with `*` (Vixie cron's HR_STAR). */
  hourWildcard: boolean;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Most days each month can have (February 29 in leap years). */
const MAX_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    if (stepMatch && (isNaN(step) || step < 1)) {
      throw new Error(`Invalid step "${stepMatch[2]}" in "${part}" (expected integer >= 1)`);
    }
    const range = stepMatch ? stepMatch[1] : part;

    if (range === '*') {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (range.includes('-')) {
      const [startStr, endStr] = range.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
        throw new Error(`Invalid range "${range}" (expected ${min}-${max})`);
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else {
      const val = parseInt(range, 10);
      if (isNaN(val) || val < min || val > max) {
        throw new Error(`Invalid value "${range}" (expected ${min}-${max})`);
      }
      values.add(val);
    }
  }

  return values;
}

/**
 * Rejects a day-of-month that occurs in none of the expression's months
 * (`0 0 31 2 *`, `0 0 31 4,6 *`), which would be accepted and then never
 * run. Only when day-of-week is a wildcard: with both restricted, cron's OR
 * rule makes the job run on the matching weekdays anyway. February 29 is
 * allowed (leap years).
 */
function rejectImpossibleDates(daysOfMonth: Set<number>, months: Set<number>, daysOfWeek: Set<number>): void {
  if (daysOfWeek.size !== 7 || daysOfMonth.size === 31) return;
  const sortedMonths = [...months].sort((a, b) => a - b);
  const possible = sortedMonths.some((month) => [...daysOfMonth].some((day) => day <= MAX_DAYS_IN_MONTH[month - 1]));
  if (possible) return;
  const days = [...daysOfMonth].sort((a, b) => a - b).join(',');
  throw new Error(
    `day-of-month ${days} never occurs in ${sortedMonths.map((m) => MONTH_NAMES[m - 1]).join(', ')}, ` +
      'so the schedule would never run',
  );
}

function parseCronExpression(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Expected 5 fields (min hour dom mon dow), got ${parts.length}`);
  }

  const daysOfWeek = parseField(parts[4], 0, 7); // 0 and 7 both mean Sunday
  if (daysOfWeek.has(7)) {
    daysOfWeek.add(0);
    daysOfWeek.delete(7);
  }

  const daysOfMonth = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  rejectImpossibleDates(daysOfMonth, months, daysOfWeek);

  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth,
    months,
    daysOfWeek,
    minuteWildcard: parts[0].startsWith('*'),
    hourWildcard: parts[1].startsWith('*'),
  };
}

/** The day rule: standard cron ORs day-of-month and day-of-week when both are restricted. */
function dayMatches(fields: CronFields, dayOfMonth: number, dayOfWeek: number): boolean {
  const domIsWildcard = fields.daysOfMonth.size === 31;
  const dowIsWildcard = fields.daysOfWeek.size === 7;

  if (domIsWildcard && dowIsWildcard) return true;
  if (domIsWildcard) return fields.daysOfWeek.has(dayOfWeek);
  if (dowIsWildcard) return fields.daysOfMonth.has(dayOfMonth);

  // Both restricted: OR logic (standard cron behavior)
  return fields.daysOfMonth.has(dayOfMonth) || fields.daysOfWeek.has(dayOfWeek);
}

/** Whether `date`'s local wall-clock minute matches the expression. */
function cronMatchesTime(fields: CronFields, date: Date): boolean {
  if (!fields.minutes.has(date.getMinutes())) return false;
  if (!fields.hours.has(date.getHours())) return false;
  if (!fields.months.has(date.getMonth() + 1)) return false;
  return dayMatches(fields, date.getDate(), date.getDay());
}

// ---------------------------------------------------------------------------
// Next fire time (field arithmetic over local wall-clock time)
// ---------------------------------------------------------------------------

/*
 * A wall-clock minute is represented as the epoch milliseconds of the same
 * calendar fields read as UTC ("wall ms"): calendar arithmetic on it is plain
 * arithmetic, with no time zone or DST involved. Converting back to a real
 * instant goes through the local time zone.
 */

/** The local wall-clock minute of `date`, as wall ms. */
function wallClockOf(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes());
}

/**
 * The instant a wall-clock minute denotes in the local time zone. For a
 * repeated time (fall-back) this is its first occurrence; for a skipped one
 * (spring-forward) ECMAScript reads it with the offset in force before the
 * transition, which lands past the gap.
 */
function instantOfWallClock(wall: number): Date {
  const w = new Date(wall);
  return new Date(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes());
}

/** Smallest value in `sorted` that is >= `from`, or undefined. */
function firstAtOrAfter(sorted: readonly number[], from: number): number | undefined {
  return sorted.find((value) => value >= from);
}

/**
 * The first wall-clock minute at or after `fromWall` (and at most
 * `limitWall`) that the expression matches, jumping whole months, days and
 * hours instead of stepping minute by minute.
 */
function nextWallMatch(fields: CronFields, fromWall: number, limitWall: number): number | undefined {
  const hours = [...fields.hours].sort((a, b) => a - b);
  const minutes = [...fields.minutes].sort((a, b) => a - b);
  let t = fromWall;
  while (t <= limitWall) {
    const d = new Date(t);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const day = d.getUTCDate();
    if (!fields.months.has(month + 1)) {
      t = Date.UTC(year, month + 1, 1);
      continue;
    }
    if (!dayMatches(fields, day, d.getUTCDay())) {
      t = Date.UTC(year, month, day + 1);
      continue;
    }
    const hour = d.getUTCHours();
    if (!fields.hours.has(hour)) {
      const nextHour = firstAtOrAfter(hours, hour + 1);
      t = nextHour === undefined ? Date.UTC(year, month, day + 1) : Date.UTC(year, month, day, nextHour);
      continue;
    }
    const minute = d.getUTCMinutes();
    if (!fields.minutes.has(minute)) {
      const nextMinute = firstAtOrAfter(minutes, minute + 1);
      t =
        nextMinute === undefined ? Date.UTC(year, month, day, hour + 1) : Date.UTC(year, month, day, hour, nextMinute);
      continue;
    }
    return t;
  }
  return undefined;
}

/**
 * The first instant after a spring-forward gap containing the (nonexistent)
 * wall-clock minute `wall`: the first instant whose wall clock is past it.
 */
function gapEndAfter(wall: number): Date {
  let t = instantOfWallClock(wall).getTime();
  for (let i = 0; i < MAX_GAP_MINUTES; i++) {
    const previous = t - MINUTE_MS;
    if (wallClockOf(new Date(previous)) < wall) break;
    t = previous;
  }
  return new Date(t);
}

/** Whether the minute or hour field starts with `*` (see the module comment). */
function isWildcardJob(fields: CronFields): boolean {
  return fields.minuteWildcard || fields.hourWildcard;
}

/**
 * When the matched wall-clock minute `wall` fires: its instant (the first
 * occurrence of a repeated minute), or for a minute inside a spring-forward
 * gap the end of the gap (fixed-time jobs) or never (wildcard jobs).
 */
function fireInstantOf(fields: CronFields, wall: number): Date | undefined {
  const instant = instantOfWallClock(wall);
  if (wallClockOf(instant) === wall) return instant;
  return isWildcardJob(fields) ? undefined : gapEndAfter(wall);
}

/**
 * The next fire after `after` among the first occurrences of wall-clock
 * minutes (and the ends of spring-forward gaps): every fire of a fixed-time
 * job, and every fire of a wildcard job outside a repeated hour.
 */
function nextFirstOccurrenceFire(fields: CronFields, after: Date): Date | undefined {
  const afterMs = after.getTime();
  // The wall-clock minutes up to `after`'s own fire at or before it: a fire
  // instant is never earlier than its minute's first occurrence.
  let fromWall = wallClockOf(after) + MINUTE_MS;
  const limitWall = fromWall + SEARCH_HORIZON_MS;
  for (;;) {
    const wall = nextWallMatch(fields, fromWall, limitWall);
    if (wall === undefined) return undefined;
    const fire = fireInstantOf(fields, wall);
    // A minute of the repeated hour whose first occurrence is already past.
    if (fire !== undefined && fire.getTime() > afterMs) return fire;
    fromWall = wall + MINUTE_MS;
  }
}

/**
 * The fall-back transitions (the local clock set back) within
 * {@link MAX_FALL_BACK_MS} of `aroundMs`, oldest first: each as the first
 * instant on the new offset and how long the repeated wall-clock stretch
 * that starts there lasts.
 */
function fallBacksAround(aroundMs: number): Array<{ readonly at: number; readonly lengthMs: number }> {
  const found: Array<{ readonly at: number; readonly lengthMs: number }> = [];
  const end = aroundMs + MAX_FALL_BACK_MS;
  let t = Math.floor((aroundMs - MAX_FALL_BACK_MS) / MINUTE_MS) * MINUTE_MS;
  let offset = new Date(t).getTimezoneOffset();
  while (t < end) {
    const next = t + TRANSITION_SCAN_STEP_MS;
    const nextOffset = new Date(next).getTimezoneOffset();
    // getTimezoneOffset() grows when the wall clock goes back.
    if (nextOffset > offset) {
      let lo = t;
      let hi = next;
      while (hi - lo > MINUTE_MS) {
        const mid = lo + Math.floor((hi - lo) / MINUTE_MS / 2) * MINUTE_MS;
        if (new Date(mid).getTimezoneOffset() > offset) hi = mid;
        else lo = mid;
      }
      found.push({ at: hi, lengthMs: Math.round(nextOffset - offset) * MINUTE_MS });
    }
    t = next;
    offset = nextOffset;
  }
  return found;
}

/**
 * The first minute after `afterMs` that repeats a wall-clock minute (the
 * stretch after a fall-back transition) and matches the expression, or
 * undefined. Only wildcard jobs fire at these second occurrences.
 */
function nextRepeatedMinuteFire(fields: CronFields, afterMs: number): Date | undefined {
  for (const { at, lengthMs } of fallBacksAround(afterMs)) {
    for (let t = at; t < at + lengthMs; t += MINUTE_MS) {
      if (t > afterMs && cronMatchesTime(fields, new Date(t))) return new Date(t);
    }
  }
  return undefined;
}

/**
 * The next time a cron expression fires after `after` (strictly later, at a
 * minute boundary), following the wall-clock rules in the module comment.
 * Undefined when nothing fires within the search horizon (ten years; every
 * expression that parses fires within eight), never an invented date.
 */
function getNextFireTime(fields: CronFields, after: Date): Date | undefined {
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) return undefined;
  const first = nextFirstOccurrenceFire(fields, after);
  if (!isWildcardJob(fields)) return first;
  // A second occurrence can only come first when `after` is within a repeat
  // length of the transition, which is where fallBacksAround looks.
  const repeated = nextRepeatedMinuteFire(fields, afterMs);
  return repeated !== undefined && (first === undefined || repeated.getTime() < first.getTime()) ? repeated : first;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface ScheduledJob {
  job: JobDefinition;
  fields: CronFields;
  callback: JobTriggerCallback;
  /** Cached next fire time; undefined only for an expression that never fires. */
  nextFireAt: Date | undefined;
  /** The fire time the job last fired for (its trigger's `scheduledFor`), if it has fired. */
  lastFiredFor: Date | undefined;
}

/** Creates a CronScheduler with built-in cron expression parsing. */
export function createCronScheduler(options: CronSchedulerOptions = {}): CronScheduler {
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const jobs = new Map<string, ScheduledJob>();
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let lastPollMs: number | undefined;

  function startPolling(): void {
    if (pollInterval) return;
    lastPollMs = now().getTime();
    pollInterval = setInterval(() => tick(), pollIntervalMs);
    pollInterval.unref(); // Don't keep the process alive just for polling
  }

  function stopPolling(): void {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  function tick(): void {
    const current = now();
    const currentMs = current.getTime();

    if (lastPollMs !== undefined && currentMs < lastPollMs - CLOCK_SET_BACK_MS) {
      const setBackMs = lastPollMs - currentMs;
      logger.warn(`[CronScheduler] The clock went back by ${Math.round(setBackMs / 1000)}s; recomputing next runs`);
      for (const scheduled of jobs.values()) {
        // A fixed-time job does not run again a time it already ran, which
        // a minor set back makes come round once more (Vixie cron).
        const last = scheduled.lastFiredFor;
        const keepLast =
          setBackMs <= MAX_MINOR_SET_BACK_MS &&
          !isWildcardJob(scheduled.fields) &&
          last !== undefined &&
          last.getTime() > currentMs;
        scheduled.nextFireAt = getNextFireTime(scheduled.fields, keepLast ? last : current);
      }
    }
    lastPollMs = currentMs;

    for (const [jobId, scheduled] of [...jobs.entries()]) {
      const due = scheduled.nextFireAt;
      if (due === undefined || currentMs < due.getTime()) continue;

      const lateMs = currentMs - due.getTime();
      scheduled.lastFiredFor = due;
      scheduled.nextFireAt = getNextFireTime(scheduled.fields, current);
      const trigger: JobTrigger = { kind: lateMs <= LATE_FIRE_GRACE_MS ? 'scheduled' : 'missed', scheduledFor: due };
      if (trigger.kind === 'scheduled') {
        logger.info(`[CronScheduler] Firing job ${jobId} (due ${due.toISOString()})`);
      } else {
        logger.warn(
          `[CronScheduler] Job ${jobId} missed its run due ${due.toISOString()} ` +
            `(${Math.round(lateMs / 60_000)} min ago: the machine slept or the daemon was blocked)`,
        );
      }
      scheduled.callback(scheduled.job, trigger).catch((err: unknown) => {
        logger.warn(`[CronScheduler] Job ${jobId} callback failed: ${String(err)}`);
      });
    }
  }

  return {
    schedule(job: JobDefinition, onTrigger: JobTriggerCallback): void {
      let fields: CronFields;
      try {
        fields = parseCronExpression(job.schedule);
      } catch (err) {
        throw new InvalidCronExpressionError(job.schedule, err);
      }
      const nextFireAt = getNextFireTime(fields, now());
      if (nextFireAt === undefined) {
        throw new InvalidCronExpressionError(job.schedule, new Error('it never fires within the next ten years'));
      }

      // Replace any existing schedule for this job
      jobs.set(job.id, { job, fields, callback: onTrigger, nextFireAt, lastFiredFor: undefined });
      startPolling();
    },

    unschedule(jobId: JobId): void {
      jobs.delete(jobId);
      if (jobs.size === 0) {
        stopPolling();
      }
    },

    unscheduleAll(): void {
      jobs.clear();
      stopPolling();
    },

    getNextRun(jobId: JobId): Date | undefined {
      return jobs.get(jobId)?.nextFireAt;
    },

    getScheduledJob(jobId: JobId): JobDefinition | undefined {
      return jobs.get(jobId)?.job;
    },
  };
}

// Export for testing
export { parseCronExpression, cronMatchesTime, getNextFireTime };
export type { CronFields };

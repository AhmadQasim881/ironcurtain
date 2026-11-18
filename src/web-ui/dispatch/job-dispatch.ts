/**
 * Job-related JSON-RPC method dispatch.
 *
 * Handles all `jobs.*` methods: list, remove, enable, disable,
 * recompile, refreshLists, reload, run, logs.
 */

import { z } from 'zod';

import { type DispatchContext, validateParams } from './types.js';
import { type JobListDto, MethodNotFoundError, RpcError } from '../web-ui-types.js';
import type { JobRunStart } from '../../daemon/control-socket.js';
import { loadRecentRuns } from '../../cron/job-store.js';
import { isJobAlreadyRunningError, isJobNotFoundError, type JobId } from '../../cron/types.js';

// ---------------------------------------------------------------------------
// Param validation schemas
// ---------------------------------------------------------------------------

const jobIdSchema = z.object({ jobId: z.string().min(1) });
const jobLogsSchema = z.object({ jobId: z.string().min(1), limit: z.number().int().positive().optional() });
const jobRefreshListsSchema = z.object({
  jobId: z.string().min(1),
  list: z.string().min(1).optional(),
  withMcp: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Job dispatch
// ---------------------------------------------------------------------------

export async function jobDispatch(
  ctx: DispatchContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'jobs.list':
      return listJobs(ctx);
    case 'jobs.remove': {
      const { jobId } = validateParams(jobIdSchema, params);
      await jobOperation(ctx.handler.removeJob(jobId));
      ctx.eventBus.emit('job.list_changed', {});
      return;
    }
    case 'jobs.enable': {
      const { jobId } = validateParams(jobIdSchema, params);
      await jobOperation(ctx.handler.enableJob(jobId));
      ctx.eventBus.emit('job.list_changed', {});
      return;
    }
    case 'jobs.disable': {
      const { jobId } = validateParams(jobIdSchema, params);
      await jobOperation(ctx.handler.disableJob(jobId));
      ctx.eventBus.emit('job.list_changed', {});
      return;
    }
    case 'jobs.recompile': {
      const { jobId } = validateParams(jobIdSchema, params);
      await jobOperation(ctx.handler.recompileJob(jobId));
      // A recompile also reloads the job, which schedules one whose policy
      // never compiled before, so its next run can change.
      ctx.eventBus.emit('job.list_changed', {});
      return;
    }
    case 'jobs.refreshLists': {
      const { jobId, list, withMcp } = validateParams(jobRefreshListsSchema, params);
      return jobOperation(
        ctx.handler.refreshLists({
          target: { kind: 'job', name: jobId },
          ...(list !== undefined ? { list } : {}),
          ...(withMcp !== undefined ? { withMcp } : {}),
        }),
      );
    }
    case 'jobs.reload': {
      const { jobId } = validateParams(jobIdSchema, params);
      await jobOperation(ctx.handler.reloadJob(jobId));
      ctx.eventBus.emit('job.list_changed', {});
      return;
    }
    case 'jobs.run': {
      const { jobId } = validateParams(jobIdSchema, params);
      // The run is fire-and-forget, so the refusal must happen before the
      // reply: startJobRun reserves the job synchronously and throws while a
      // scheduled, CLI or earlier web run of it is still in progress, or for
      // an unknown job.
      let started: JobRunStart;
      try {
        started = ctx.handler.startJobRun(jobId);
      } catch (err) {
        if (isJobAlreadyRunningError(err)) throw new RpcError('JOB_ALREADY_RUNNING', err.message);
        if (isJobNotFoundError(err)) throw new RpcError('JOB_NOT_FOUND', err.message);
        throw err;
      }
      started.completion
        .then((record) => ctx.eventBus.emit('job.completed', { jobId, record }))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          ctx.eventBus.emit('job.failed', { jobId, error: message });
        });
      ctx.eventBus.emit('job.started', { jobId, sessionLabel: 0 });
      return { accepted: true, jobId };
    }
    case 'jobs.logs': {
      const { jobId, limit } = validateParams(jobLogsSchema, params);
      return loadRecentRuns(jobId as JobId, limit ?? 20);
    }
    default:
      throw new MethodNotFoundError(method);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Awaits a job operation, reporting an unknown job id as `JOB_NOT_FOUND` rather than an internal error. */
async function jobOperation<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (err) {
    if (isJobNotFoundError(err)) throw new RpcError('JOB_NOT_FOUND', err.message);
    throw err;
  }
}

function listJobs(ctx: DispatchContext): JobListDto[] {
  return ctx.handler.listJobs().map((j) => ({
    job: j.job,
    nextRun: j.nextRun?.toISOString() ?? null,
    lastRun: j.lastRun ?? null,
    isRunning: j.isRunning,
    consecutiveFailures: j.consecutiveFailures,
  }));
}

/**
 * Shared escalation watcher for polling escalation directories.
 *
 * Pure data module -- no I/O presentation. Consumers (DockerAgentSession,
 * EscalationListener) handle display. Polls a session's escalation
 * directory for new request files and handles resolution via response files.
 *
 * Several escalations of one session can be pending at once: the
 * coordinator releases its call mutex while it waits for a decision, so
 * parallel tool calls (an agent's parallel tool use, parallel subagents)
 * each write their own `request-<id>.json` with its own deadline. Every
 * poll therefore surfaces every request not seen before, oldest first (by
 * the `createdAt` the trusted process writes into the request file, or the
 * file's modification time when it has none), and checks each surfaced one
 * for expiry on its own. A request that is surfaced late would otherwise
 * stay hidden behind the first one and could time out unseen.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EscalationRequest } from '../session/types.js';
import { atomicWriteTextSync } from '../util/atomic-write.js';
import { withValidReviewFields } from './escalation-review.js';

const DEFAULT_POLL_INTERVAL_MS = 300;

/** Events emitted by the escalation watcher. */
export interface EscalationWatcherEvents {
  /** A new escalation request was detected. Fires once per request, oldest first. */
  onEscalation: (request: EscalationRequest) => void;
  /**
   * A pending escalation expired: the proxy timed it out (or withdrew it)
   * and removed its files without a response. Fires once per surfaced
   * escalation, each on its own.
   */
  onEscalationExpired: (escalationId: string) => void;
  /** A pending escalation was resolved (approved or denied). */
  onEscalationResolved?: (escalationId: string, decision: 'approved' | 'denied') => void;
}

export interface EscalationWatcher {
  /** Start polling the escalation directory. */
  start(): void;
  /** Stop polling. */
  stop(): void;
  /**
   * Every escalation surfaced and not yet resolved or expired, in the order
   * they were surfaced (oldest first). Empty when none is pending.
   */
  getPending(): readonly EscalationRequest[];
  /**
   * Resolves a pending escalation by writing the response file.
   * Returns true if the resolution was accepted (request file still exists),
   * or false if the escalation had already expired.
   *
   * @throws {Error} if no escalation with this ID is pending
   */
  resolve(escalationId: string, decision: 'approved' | 'denied', options?: { whitelistSelection?: number }): boolean;
}

export interface EscalationWatcherOptions {
  /** Poll interval in ms. Default: 300. */
  pollIntervalMs?: number;
}

/**
 * Atomically writes a JSON file using write-to-temp-then-rename.
 * Prevents partial reads by other processes polling the same directory.
 *
 * The temp file has a unique name (`<file>.<pid>.<uuid>.tmp`, created
 * exclusively), so concurrent writers of the same file (two UIs answering one
 * escalation, a session and a mux writing its user context) never share a
 * temp file and rename a torn mix of both into place. The directory is never
 * created: writing into an escalation directory that is gone fails.
 */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  atomicWriteTextSync(filePath, JSON.stringify(data, null, 2), { createParentDirs: false });
}

const REQUEST_PREFIX = 'request-';
const REQUEST_SUFFIX = '.json';

/** The escalation id a request file name carries, or undefined when it is not a request file. */
function requestFileId(filename: string): string | undefined {
  if (!filename.startsWith(REQUEST_PREFIX) || !filename.endsWith(REQUEST_SUFFIX)) return undefined;
  const id = filename.slice(REQUEST_PREFIX.length, filename.length - REQUEST_SUFFIX.length);
  return id === '' ? undefined : id;
}

/**
 * When a request was raised, in epoch milliseconds: its `createdAt` when
 * that is a valid timestamp, otherwise the file's modification time.
 */
function raisedAt(request: EscalationRequest, mtimeMs: number): number {
  const created = typeof request.createdAt === 'string' ? Date.parse(request.createdAt) : NaN;
  return Number.isFinite(created) ? created : mtimeMs;
}

/** A request read in one poll, with the time it is ordered by. */
interface FreshRequest {
  readonly request: EscalationRequest;
  readonly raisedAt: number;
}

/**
 * Creates an escalation watcher for a single session's escalation directory.
 */
export function createEscalationWatcher(
  escalationDir: string,
  events: EscalationWatcherEvents,
  options?: EscalationWatcherOptions,
): EscalationWatcher {
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  /** Surfaced, undecided escalations by id, in the order they were surfaced. */
  const pending = new Map<string, EscalationRequest>();
  /** Every request file id ever read (surfaced or rejected): never surfaced twice. */
  const seenEscalationIds = new Set<string>();
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  function requestPath(escalationId: string): string {
    return resolve(escalationDir, `${REQUEST_PREFIX}${escalationId}${REQUEST_SUFFIX}`);
  }

  function responsePath(escalationId: string): string {
    return resolve(escalationDir, `response-${escalationId}.json`);
  }

  /** Runs a consumer callback; one that throws must not stop the others or the poll. */
  function notify(callback: () => void): void {
    try {
      callback();
    } catch {
      // The consumer's own failure; the watcher's state is already consistent.
    }
  }

  /**
   * Expires every surfaced escalation whose request and response files are
   * both gone: the proxy timed it out (or withdrew it) and cleaned up. Each
   * one is checked on its own; the others stay pending.
   */
  function expireVanished(): void {
    for (const escalationId of [...pending.keys()]) {
      if (existsSync(requestPath(escalationId)) || existsSync(responsePath(escalationId))) continue;
      pending.delete(escalationId);
      notify(() => events.onEscalationExpired(escalationId));
    }
  }

  /**
   * Reads the request file with this id. Undefined when it vanished before
   * it could be read or is not readable yet (it is retried on the next
   * poll); a file whose content names another escalation than its file name
   * is marked seen and never surfaced, because a decision on it would be
   * written where the proxy does not look (the call then times out and is
   * denied).
   */
  function readRequest(escalationId: string): FreshRequest | undefined {
    const path = requestPath(escalationId);
    let parsed: unknown;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return undefined;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { escalationId?: unknown }).escalationId !== escalationId
    ) {
      seenEscalationIds.add(escalationId);
      return undefined;
    }
    // Parsed without a schema: keep `createdAt` only when it is a string.
    const { createdAt, ...rest } = withValidReviewFields(parsed as EscalationRequest) as EscalationRequest & {
      createdAt?: unknown;
    };
    const request: EscalationRequest = typeof createdAt === 'string' ? { ...rest, createdAt } : rest;
    return { request, raisedAt: raisedAt(request, mtimeMs) };
  }

  /** Surfaces every request file not seen before, oldest first. */
  function surfaceNewRequests(): void {
    let files: string[];
    try {
      files = readdirSync(escalationDir);
    } catch {
      // Directory may not exist yet
      return;
    }

    const fresh: FreshRequest[] = [];
    for (const file of files) {
      const escalationId = requestFileId(file);
      if (escalationId === undefined || seenEscalationIds.has(escalationId)) continue;
      const request = readRequest(escalationId);
      if (request) fresh.push(request);
    }
    // Oldest first; the id breaks ties so the order never depends on readdir.
    fresh.sort(
      (a, b) =>
        a.raisedAt - b.raisedAt ||
        (a.request.escalationId < b.request.escalationId
          ? -1
          : a.request.escalationId > b.request.escalationId
            ? 1
            : 0),
    );

    for (const { request } of fresh) {
      seenEscalationIds.add(request.escalationId);
      pending.set(request.escalationId, request);
      notify(() => events.onEscalation(request));
    }
  }

  function pollEscalationDirectory(): void {
    expireVanished();
    surfaceNewRequests();
  }

  return {
    start(): void {
      if (pollInterval) return;
      // Poll once immediately, before scheduling the interval, so a request
      // written in the window before the first interval tick (~pollIntervalMs)
      // is not missed -- a missed escalation hangs the agent waiting on an
      // approval nobody sees. The `seenEscalationIds` dedup makes this safe:
      // the interval never re-fires an escalation the immediate poll surfaced.
      pollEscalationDirectory();
      pollInterval = setInterval(pollEscalationDirectory, pollIntervalMs);
      // Don't keep the process alive just for escalation polling.
      pollInterval.unref();
    },

    stop(): void {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    },

    getPending(): readonly EscalationRequest[] {
      return [...pending.values()];
    },

    resolve(escalationId: string, decision: 'approved' | 'denied', options?: { whitelistSelection?: number }): boolean {
      if (!pending.has(escalationId)) {
        throw new Error(`No pending escalation with ID: ${escalationId}`);
      }

      const responseData: Record<string, unknown> = { decision };
      if (options?.whitelistSelection !== undefined) {
        responseData.whitelistSelection = options.whitelistSelection;
      }
      atomicWriteJsonSync(responsePath(escalationId), responseData);
      pending.delete(escalationId);

      // Stale detection: verify the request file still exists after writing the response.
      // If the proxy already timed out and cleaned up, the response was too late.
      const requestStillExists = existsSync(requestPath(escalationId));
      if (requestStillExists) {
        events.onEscalationResolved?.(escalationId, decision);
      }
      return requestStillExists;
    },
  };
}

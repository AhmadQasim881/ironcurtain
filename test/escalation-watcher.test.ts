import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEscalationWatcher,
  atomicWriteJsonSync,
  type EscalationWatcherEvents,
} from '../src/escalation/escalation-watcher.js';
import type { EscalationRequest } from '../src/session/types.js';

describe('atomicWriteJsonSync', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('writes JSON atomically via temp-then-rename', () => {
    const filePath = join(tempDir, 'test.json');
    const data = { foo: 'bar', count: 42 };

    atomicWriteJsonSync(filePath, data);

    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content).toEqual(data);
  });

  it('does not leave temp file after successful write', () => {
    const filePath = join(tempDir, 'clean.json');
    atomicWriteJsonSync(filePath, { clean: true });

    expect(readdirSync(tempDir)).toEqual(['clean.json']);
  });

  it('writes through its own unique temp file, never a name another writer shares', () => {
    const filePath = join(tempDir, 'response.json');
    // A second writer of the same file mid-write would hold the old fixed
    // `<file>.tmp`; a directory there stands in for it (and made the old
    // implementation fail).
    mkdirSync(`${filePath}.tmp`);

    atomicWriteJsonSync(filePath, { decision: 'approved' });

    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ decision: 'approved' });
    expect(readdirSync(tempDir).sort()).toEqual(['response.json', 'response.json.tmp']);
  });

  it('removes its temp file when the rename fails, and never creates a missing directory', () => {
    const target = join(tempDir, 'occupied.json');
    mkdirSync(join(target, 'not-empty'), { recursive: true });
    expect(() => atomicWriteJsonSync(target, { x: 1 })).toThrow();
    expect(readdirSync(tempDir)).toEqual(['occupied.json']);

    const missing = join(tempDir, 'gone', 'response.json');
    expect(() => atomicWriteJsonSync(missing, { x: 1 })).toThrow(/ENOENT/);
    expect(existsSync(join(tempDir, 'gone'))).toBe(false);
  });

  it('overwrites existing file', () => {
    const filePath = join(tempDir, 'overwrite.json');
    atomicWriteJsonSync(filePath, { version: 1 });
    atomicWriteJsonSync(filePath, { version: 2 });

    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content).toEqual({ version: 2 });
  });
});

describe('createEscalationWatcher', () => {
  let tempDir: string;
  let escalationDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tempDir = mkdtempSync(join(tmpdir(), 'escalation-watcher-test-'));
    escalationDir = join(tempDir, 'escalations');
    mkdirSync(escalationDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function writeRequest(escalationId: string, request?: Partial<EscalationRequest>): void {
    const full: EscalationRequest = {
      escalationId,
      toolName: 'write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/passwd' },
      reason: 'Protected path',
      ...request,
    };
    writeFileSync(join(escalationDir, `request-${escalationId}.json`), JSON.stringify(full));
  }

  /** Advance fake timers enough to trigger at least one poll cycle. */
  function advancePastPoll(): void {
    vi.advanceTimersByTime(60);
  }

  it('detects new escalation request via polling', () => {
    const escalations: EscalationRequest[] = [];
    const events: EscalationWatcherEvents = {
      onEscalation: (req) => escalations.push(req),
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-001');

    advancePastPoll();

    expect(escalations).toHaveLength(1);
    expect(escalations[0].escalationId).toBe('esc-001');
    expect(watcher.getPending().at(0)?.escalationId).toBe('esc-001');

    watcher.stop();
  });

  it('polls immediately on start so a request written before start() is not missed', () => {
    const escalations: EscalationRequest[] = [];
    const events: EscalationWatcherEvents = {
      onEscalation: (req) => escalations.push(req),
      onEscalationExpired: () => {},
    };

    // The pre-start-window race: the request file already exists when start()
    // is called. The immediate poll must surface it without any timer advance.
    writeRequest('esc-immediate');

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    // No advancePastPoll(): the immediate poll fires synchronously in start().
    expect(escalations).toHaveLength(1);
    expect(escalations[0].escalationId).toBe('esc-immediate');
    expect(watcher.getPending().at(0)?.escalationId).toBe('esc-immediate');

    // And the interval must not re-fire the already-seen escalation.
    advancePastPoll();
    expect(escalations).toHaveLength(1);

    watcher.stop();
  });

  it('does not emit the same escalation twice', () => {
    const escalations: EscalationRequest[] = [];
    const events: EscalationWatcherEvents = {
      onEscalation: (req) => escalations.push(req),
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-002');
    advancePastPoll();

    // Resolve the escalation so the watcher can look for new ones
    watcher.resolve('esc-002', 'approved');
    advancePastPoll();

    // The same request file is still there but should not be emitted again
    expect(escalations).toHaveLength(1);

    watcher.stop();
  });

  it('resolves escalation by writing response file atomically', () => {
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-003');
    advancePastPoll();

    expect(watcher.getPending().at(0)?.escalationId).toBe('esc-003');

    const accepted = watcher.resolve('esc-003', 'approved');
    expect(accepted).toBe(true);

    // Response file was written atomically (no leftover .tmp)
    const responsePath = join(escalationDir, 'response-esc-003.json');
    expect(existsSync(responsePath)).toBe(true);
    expect(readdirSync(escalationDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const response = JSON.parse(readFileSync(responsePath, 'utf-8'));
    expect(response.decision).toBe('approved');

    // Pending cleared after resolve
    expect(watcher.getPending()).toEqual([]);

    watcher.stop();
  });

  it('resolve writes response file and returns true when request exists', () => {
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-004');
    advancePastPoll();

    expect(watcher.getPending()).toHaveLength(1);
    const accepted = watcher.resolve('esc-004', 'denied');

    expect(accepted).toBe(true);

    const responsePath = join(escalationDir, 'response-esc-004.json');
    expect(existsSync(responsePath)).toBe(true);
    const response = JSON.parse(readFileSync(responsePath, 'utf-8'));
    expect(response.decision).toBe('denied');

    // No temp file left
    expect(readdirSync(escalationDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    // Pending cleared
    expect(watcher.getPending()).toEqual([]);

    watcher.stop();
  });

  it('resolve returns false when request has been cleaned up (expired)', () => {
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-005');
    advancePastPoll();

    // Simulate proxy timeout cleanup: remove the request file
    rmSync(join(escalationDir, 'request-esc-005.json'));

    const accepted = watcher.resolve('esc-005', 'approved');
    expect(accepted).toBe(false);

    watcher.stop();
  });

  it('throws when resolving unknown escalation', () => {
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events);
    expect(() => watcher.resolve('nonexistent', 'approved')).toThrow('No pending escalation');
  });

  it('detects escalation expiry when files are removed', () => {
    const expiredIds: string[] = [];
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: (id) => expiredIds.push(id),
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-006');
    advancePastPoll();

    expect(watcher.getPending()).toHaveLength(1);

    // Simulate proxy-side cleanup (both files removed = expired)
    rmSync(join(escalationDir, 'request-esc-006.json'));

    advancePastPoll();

    expect(expiredIds).toContain('esc-006');
    expect(watcher.getPending()).toEqual([]);

    watcher.stop();
  });

  it('does not detect expiry when response file exists', () => {
    const expiredIds: string[] = [];
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: (id) => expiredIds.push(id),
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-007');
    advancePastPoll();

    // Remove request but leave a response (not expired -- response was written)
    rmSync(join(escalationDir, 'request-esc-007.json'));
    writeFileSync(join(escalationDir, 'response-esc-007.json'), JSON.stringify({ decision: 'approved' }));

    advancePastPoll();

    // Should NOT be considered expired because response exists
    expect(expiredIds).toHaveLength(0);

    watcher.stop();
  });

  it('start is idempotent', () => {
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events);
    watcher.start();
    watcher.start(); // Should not throw or create duplicate intervals

    watcher.stop();
  });

  it('stop is idempotent', () => {
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events);
    watcher.start();
    watcher.stop();
    watcher.stop(); // Should not throw
  });

  it('handles missing escalation directory gracefully', () => {
    const nonExistentDir = join(tempDir, 'does-not-exist');
    const events: EscalationWatcherEvents = {
      onEscalation: () => {},
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(nonExistentDir, events, { pollIntervalMs: 50 });
    watcher.start();

    // Should not throw during polling
    advancePastPoll();

    expect(watcher.getPending()).toEqual([]);
    watcher.stop();
  });

  it('picks up next escalation after resolving previous', () => {
    const escalations: EscalationRequest[] = [];
    const events: EscalationWatcherEvents = {
      onEscalation: (req) => escalations.push(req),
      onEscalationExpired: () => {},
    };

    const watcher = createEscalationWatcher(escalationDir, events, { pollIntervalMs: 50 });
    watcher.start();

    writeRequest('esc-008');
    advancePastPoll();

    watcher.resolve('esc-008', 'approved');

    // Write a second escalation
    writeRequest('esc-009', { toolName: 'delete_file' });
    advancePastPoll();

    expect(escalations).toHaveLength(2);
    expect(escalations[1].escalationId).toBe('esc-009');

    watcher.stop();
  });
  describe('several pending escalations (parallel tool calls)', () => {
    /** A request file as the pipeline writes it: with its createdAt. */
    function writeRequestAt(escalationId: string, createdAt: string, extra?: Partial<EscalationRequest>): void {
      writeRequest(escalationId, { createdAt, ...extra });
    }

    function recordingWatcher(): {
      watcher: ReturnType<typeof createEscalationWatcher>;
      surfaced: string[];
      expired: string[];
      resolved: string[];
    } {
      const surfaced: string[] = [];
      const expired: string[] = [];
      const resolved: string[] = [];
      const watcher = createEscalationWatcher(
        escalationDir,
        {
          onEscalation: (req) => surfaced.push(req.escalationId),
          onEscalationExpired: (id) => expired.push(id),
          onEscalationResolved: (id) => resolved.push(id),
        },
        { pollIntervalMs: 50 },
      );
      return { watcher, surfaced, expired, resolved };
    }

    it('surfaces two concurrent escalations in the same poll, both pending', () => {
      const { watcher, surfaced } = recordingWatcher();
      writeRequestAt('esc-a', '2026-01-01T10:00:00.000Z');
      writeRequestAt('esc-b', '2026-01-01T10:00:01.000Z', { toolName: 'delete_file' });

      watcher.start();

      expect(surfaced).toEqual(['esc-a', 'esc-b']);
      expect(watcher.getPending().map((r) => r.escalationId)).toEqual(['esc-a', 'esc-b']);
      watcher.stop();
    });

    it('surfaces them oldest first by createdAt, whatever the directory order', () => {
      const { watcher, surfaced } = recordingWatcher();
      // Names sort the other way round from their creation times.
      writeRequestAt('esc-1-newest', '2026-01-01T10:00:02.000Z');
      writeRequestAt('esc-2-middle', '2026-01-01T10:00:01.000Z');
      writeRequestAt('esc-3-oldest', '2026-01-01T10:00:00.000Z');

      watcher.start();

      expect(surfaced).toEqual(['esc-3-oldest', 'esc-2-middle', 'esc-1-newest']);
      expect(watcher.getPending().map((r) => r.createdAt)).toEqual([
        '2026-01-01T10:00:00.000Z',
        '2026-01-01T10:00:01.000Z',
        '2026-01-01T10:00:02.000Z',
      ]);
      watcher.stop();
    });

    it('orders a request file without createdAt by its modification time', () => {
      const { watcher, surfaced } = recordingWatcher();
      writeRequest('esc-z-old');
      writeRequest('esc-a-new');
      utimesSync(join(escalationDir, 'request-esc-z-old.json'), new Date(1_000_000), new Date(1_000_000));
      utimesSync(join(escalationDir, 'request-esc-a-new.json'), new Date(2_000_000), new Date(2_000_000));

      watcher.start();

      expect(surfaced).toEqual(['esc-z-old', 'esc-a-new']);
      watcher.stop();
    });

    it('surfaces a request that arrives while another is pending without waiting for it', () => {
      const { watcher, surfaced } = recordingWatcher();
      watcher.start();
      writeRequest('esc-first');
      advancePastPoll();
      writeRequest('esc-second');
      advancePastPoll();

      expect(surfaced).toEqual(['esc-first', 'esc-second']);
      expect(watcher.getPending()).toHaveLength(2);
      watcher.stop();
    });

    it('resolves each one by its id; the others stay pending', () => {
      const { watcher, resolved } = recordingWatcher();
      writeRequest('esc-a');
      writeRequest('esc-b');
      watcher.start();

      expect(watcher.resolve('esc-b', 'denied')).toBe(true);

      expect(resolved).toEqual(['esc-b']);
      expect(watcher.getPending().map((r) => r.escalationId)).toEqual(['esc-a']);
      expect(JSON.parse(readFileSync(join(escalationDir, 'response-esc-b.json'), 'utf-8'))).toEqual({
        decision: 'denied',
      });
      expect(existsSync(join(escalationDir, 'response-esc-a.json'))).toBe(false);
      expect(watcher.resolve('esc-a', 'approved')).toBe(true);
      expect(watcher.getPending()).toEqual([]);
      watcher.stop();
    });

    it('expires each one independently when its files vanish', () => {
      const { watcher, expired } = recordingWatcher();
      writeRequest('esc-a');
      writeRequest('esc-b');
      watcher.start();

      // The proxy timed esc-a out and removed its request file.
      rmSync(join(escalationDir, 'request-esc-a.json'));
      advancePastPoll();

      expect(expired).toEqual(['esc-a']);
      expect(watcher.getPending().map((r) => r.escalationId)).toEqual(['esc-b']);

      rmSync(join(escalationDir, 'request-esc-b.json'));
      advancePastPoll();
      expect(expired).toEqual(['esc-a', 'esc-b']);
      expect(watcher.getPending()).toEqual([]);
      watcher.stop();
    });

    it('one malformed request file does not hide the others', () => {
      const { watcher, surfaced } = recordingWatcher();
      writeFileSync(join(escalationDir, 'request-esc-broken.json'), '{ not json');
      writeRequest('esc-good');
      // Its content names another escalation than its file name: a response
      // to it would be written where the proxy never looks, so it is skipped.
      writeFileSync(
        join(escalationDir, 'request-esc-mismatch.json'),
        JSON.stringify({ escalationId: 'esc-other', toolName: 't', serverName: 's', arguments: {}, reason: 'r' }),
      );

      watcher.start();
      advancePastPoll();

      expect(surfaced).toEqual(['esc-good']);
      watcher.stop();
    });

    it('a consumer callback that throws does not stop the other escalations from surfacing', () => {
      const surfaced: string[] = [];
      const watcher = createEscalationWatcher(
        escalationDir,
        {
          onEscalation: (req) => {
            surfaced.push(req.escalationId);
            throw new Error('consumer failed');
          },
          onEscalationExpired: () => {},
        },
        { pollIntervalMs: 50 },
      );
      writeRequest('esc-a');
      writeRequest('esc-b');

      expect(() => watcher.start()).not.toThrow();
      expect(surfaced.sort()).toEqual(['esc-a', 'esc-b']);
      expect(watcher.getPending()).toHaveLength(2);
      watcher.stop();
    });

    it('drops a createdAt that is not a string', () => {
      const { watcher } = recordingWatcher();
      writeFileSync(
        join(escalationDir, 'request-esc-a.json'),
        JSON.stringify({
          escalationId: 'esc-a',
          toolName: 't',
          serverName: 's',
          arguments: {},
          reason: 'r',
          createdAt: 12,
        }),
      );
      watcher.start();
      expect(watcher.getPending()[0]).not.toHaveProperty('createdAt');
      watcher.stop();
    });
  });
});

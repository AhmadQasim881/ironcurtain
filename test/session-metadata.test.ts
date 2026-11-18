/**
 * Unit tests for session metadata persistence (save/load).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
  saveSessionMetadata,
  loadResumeSessionMetadata,
  loadSessionMetadata,
  updateSessionMetadata,
} from '../src/session/session-metadata.js';
import { getSessionDir, getSessionMetadataPath } from '../src/config/paths.js';
import type { SessionMetadata } from '../src/session/types.js';
import { resolveDockerWorkloadConfig } from '../src/docker-workload/config.js';
import {
  buildRuntimeWatchdogPolicy,
  loadFrozenWatchdogPolicyTemplate,
} from '../src/docker-workload/watchdog-policy.js';

const TEST_HOME = `/tmp/ironcurtain-metadata-test-${process.pid}`;
const TEST_SESSION_ID = 'test-session-001';

beforeEach(() => {
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  // Create the session directory so save has somewhere to write
  const sessionDir = resolve(TEST_HOME, 'sessions', TEST_SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('saveSessionMetadata', () => {
  it('writes metadata to session-metadata.json', () => {
    const metadata: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
      persona: 'exec-assistant',
    };

    saveSessionMetadata(TEST_SESSION_ID, metadata);

    const path = getSessionMetadataPath(TEST_SESSION_ID);
    expect(existsSync(path)).toBe(true);

    const written = JSON.parse(readFileSync(path, 'utf-8'));
    expect(written.createdAt).toBe('2026-03-08T12:00:00.000Z');
    expect(written.persona).toBe('exec-assistant');
  });

  it('is idempotent — does not overwrite existing file', () => {
    const first: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
      persona: 'first',
    };
    const second: SessionMetadata = {
      createdAt: '2026-03-08T13:00:00.000Z',
      persona: 'second',
    };

    saveSessionMetadata(TEST_SESSION_ID, first);
    saveSessionMetadata(TEST_SESSION_ID, second);

    const written = JSON.parse(readFileSync(getSessionMetadataPath(TEST_SESSION_ID), 'utf-8'));
    expect(written.persona).toBe('first');
  });

  it('publishes the record complete, owner-only, and leaves no temporary file behind', () => {
    saveSessionMetadata(TEST_SESSION_ID, { createdAt: '2026-03-08T12:00:00.000Z', persona: 'coder' });
    saveSessionMetadata(TEST_SESSION_ID, { createdAt: '2026-03-08T13:00:00.000Z', persona: 'other' });

    const path = getSessionMetadataPath(TEST_SESSION_ID);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      createdAt: '2026-03-08T12:00:00.000Z',
      persona: 'coder',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(getSessionDir(TEST_SESSION_ID))).toEqual(['session-metadata.json']);
  });

  it('keeps an entry already at the name, a dangling symlink included, without writing through it', () => {
    const path = getSessionMetadataPath(TEST_SESSION_ID);
    const target = resolve(TEST_HOME, 'planted-target.json');
    symlinkSync(target, path);

    saveSessionMetadata(TEST_SESSION_ID, { createdAt: '2026-03-08T12:00:00.000Z' });

    expect(existsSync(target)).toBe(false);
    expect(readdirSync(getSessionDir(TEST_SESSION_ID))).toEqual(['session-metadata.json']);
  });

  it('omits optional fields when undefined', () => {
    const metadata: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
    };

    saveSessionMetadata(TEST_SESSION_ID, metadata);

    const written = JSON.parse(readFileSync(getSessionMetadataPath(TEST_SESSION_ID), 'utf-8'));
    expect(written).toEqual({ createdAt: '2026-03-08T12:00:00.000Z' });
    expect('persona' in written).toBe(false);
    expect('workspacePath' in written).toBe(false);
    expect('policyDir' in written).toBe(false);
  });
});

describe('loadSessionMetadata', () => {
  it('round-trips: save then load returns same data', () => {
    const metadata: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
      persona: 'coder',
      workspacePath: '/home/user/project',
      disableAutoApprove: true,
    };

    saveSessionMetadata(TEST_SESSION_ID, metadata);
    const loaded = loadSessionMetadata(TEST_SESSION_ID);

    expect(loaded).toEqual(metadata);
  });

  it('returns undefined for nonexistent session', () => {
    const result = loadSessionMetadata('nonexistent-session-xyz');
    expect(result).toBeUndefined();
  });

  it('returns undefined for corrupt JSON', () => {
    const path = getSessionMetadataPath(TEST_SESSION_ID);
    writeFileSync(path, '{ invalid json !!!', 'utf-8');

    const result = loadSessionMetadata(TEST_SESSION_ID);
    expect(result).toBeUndefined();
  });

  it('handles metadata with only createdAt', () => {
    const metadata: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
    };

    saveSessionMetadata(TEST_SESSION_ID, metadata);
    const loaded = loadSessionMetadata(TEST_SESSION_ID);

    expect(loaded).toEqual({ createdAt: '2026-03-08T12:00:00.000Z' });
    expect(loaded?.persona).toBeUndefined();
    expect(loaded?.workspacePath).toBeUndefined();
    expect(loaded?.policyDir).toBeUndefined();
  });

  it('handles metadata with policyDir (no persona)', () => {
    const metadata: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
      policyDir: '/home/user/.ironcurtain/jobs/daily/generated',
    };

    saveSessionMetadata(TEST_SESSION_ID, metadata);
    const loaded = loadSessionMetadata(TEST_SESSION_ID);

    expect(loaded?.policyDir).toBe('/home/user/.ironcurtain/jobs/daily/generated');
    expect(loaded?.persona).toBeUndefined();
  });

  it('round-trips agentConversationId so --resume can continue the Claude conversation', async () => {
    // Regression guard for the resume-the-Claude-conversation fix: if the
    // field isn't persisted, `ironcurtain --resume <id>` mints a fresh
    // AgentConversationId and the adapter starts a new conversation
    // instead of continuing the stored one.
    const { createAgentConversationId } = await import('../src/session/types.js');
    const convoId = createAgentConversationId();

    const metadata: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
      persona: 'exec-assistant',
      agentConversationId: convoId,
    };

    saveSessionMetadata(TEST_SESSION_ID, metadata);
    const loaded = loadSessionMetadata(TEST_SESSION_ID);

    expect(loaded?.agentConversationId).toBe(convoId);
  });
});

describe('loadResumeSessionMetadata', () => {
  const path = (): string => getSessionMetadataPath(TEST_SESSION_ID);

  it('returns the record a session was created with', () => {
    const metadata: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
      persona: 'coder',
      taskPolicyDir: '/home/user/.ironcurtain/task-policies/abc',
      disableAutoApprove: true,
    };
    saveSessionMetadata(TEST_SESSION_ID, metadata);
    expect(loadResumeSessionMetadata(TEST_SESSION_ID)).toEqual(metadata);
  });

  it('returns undefined only when there is no file (a session created before metadata was recorded)', () => {
    expect(loadResumeSessionMetadata(TEST_SESSION_ID)).toBeUndefined();
    expect(loadResumeSessionMetadata('no-such-session')).toBeUndefined();
  });

  it.each([
    ['truncated JSON', '{"createdAt":"2026-03-08T12:00:00.000Z","taskPolicyDir":"/ho', /is not valid JSON/],
    ['an empty file', '', /is not valid JSON/],
    ['an array', '[]', /is not a JSON object/],
    ['null', 'null', /is not a JSON object/],
    ['a null task scope', '{"taskPolicyDir":null}', /"taskPolicyDir" is not a non-empty string/],
    ['an empty persona', '{"persona":""}', /"persona" is not a non-empty string/],
    ['a numeric policy directory', '{"policyDir":1}', /"policyDir" is not a non-empty string/],
    ['a non-string profile', '{"providerProfileName":["native"]}', /"providerProfileName" is not a non-empty string/],
    ['a non-string conversation id', '{"agentConversationId":7}', /"agentConversationId" is not a non-empty string/],
    ['a string auto-approve flag', '{"disableAutoApprove":"false"}', /"disableAutoApprove" is not true or false/],
  ])('refuses %s with SESSION_INIT_FAILED, naming the file', (_label, content, expected) => {
    writeFileSync(path(), content);
    let thrown: unknown;
    try {
      loadResumeSessionMetadata(TEST_SESSION_ID);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'SESSION_INIT_FAILED', message: expect.stringMatching(expected) });
    expect((thrown as Error).message).toContain(path());
    expect((thrown as Error).message).toMatch(/fix the file, or move it aside to resume without them\.$/);
  });

  it('refuses a symlink without following it, and a directory', () => {
    const target = resolve(TEST_HOME, 'elsewhere.json');
    writeFileSync(target, '{"createdAt":"2026-03-08T12:00:00.000Z"}');
    symlinkSync(target, path());
    expect(() => loadResumeSessionMetadata(TEST_SESSION_ID)).toThrow(/is a symbolic link/);

    rmSync(path());
    mkdirSync(path());
    expect(() => loadResumeSessionMetadata(TEST_SESSION_ID)).toThrow(/is not a regular file/);
  });

  it('keeps refusing a session ID that is not a path-safe slug', () => {
    expect(() => loadResumeSessionMetadata('../escape')).toThrow(/Invalid session ID/);
  });
});

describe('updateSessionMetadata', () => {
  it('preserves historical hash-shaped workload metadata without losing creation metadata', () => {
    saveSessionMetadata(TEST_SESSION_ID, {
      createdAt: '2026-03-08T12:00:00.000Z',
      persona: 'coder',
      workspacePath: '/workspace',
    });
    const dockerWorkload = {
      leaseId: 'lease-001',
      generation: 'generation-001',
      configHash: '1'.repeat(64),
      watchdogPolicySha256: '2'.repeat(64),
      backend: 'apple-container' as const,
    };

    updateSessionMetadata(TEST_SESSION_ID, { dockerWorkload });

    expect(loadSessionMetadata(TEST_SESSION_ID)).toEqual({
      createdAt: '2026-03-08T12:00:00.000Z',
      persona: 'coder',
      workspacePath: '/workspace',
      dockerWorkload,
    });
  });

  it('persists the complete current workload configuration and watchdog snapshot', () => {
    saveSessionMetadata(TEST_SESSION_ID, { createdAt: '2026-09-10T12:00:00.000Z', persona: 'coder' });
    const dockerWorkload = {
      leaseId: 'lease-current',
      generation: 'generation-current',
      configuration: resolveDockerWorkloadConfig(
        { enabled: true, networkAccess: 'packages' },
        { memoryMb: 8192, cpus: 4 },
      ),
      watchdogPolicy: buildRuntimeWatchdogPolicy(
        loadFrozenWatchdogPolicyTemplate(resolve('config/docker-workload/resource-watchdog-policy.json')),
        'docker',
        { root: '/state', device: 1, inode: 2 },
      ),
      backend: 'docker' as const,
    };
    updateSessionMetadata(TEST_SESSION_ID, { dockerWorkload });
    expect(loadSessionMetadata(TEST_SESSION_ID)).toEqual({
      createdAt: '2026-09-10T12:00:00.000Z',
      persona: 'coder',
      dockerWorkload,
    });
    expect(loadSessionMetadata(TEST_SESSION_ID)?.dockerWorkload).not.toHaveProperty('configHash');
    expect(loadSessionMetadata(TEST_SESSION_ID)?.dockerWorkload).not.toHaveProperty('watchdogPolicySha256');
  });

  it('refuses to fabricate metadata when the create-once record is absent', () => {
    expect(() => updateSessionMetadata('missing-session', { persona: 'coder' })).toThrow(
      /cannot update missing or invalid session metadata/u,
    );
  });
});

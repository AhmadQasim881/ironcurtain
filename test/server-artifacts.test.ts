/**
 * Unit tests for the per-server artifact store (src/pipeline/server-artifacts.ts):
 * which files the per-server cache may serve, and the guarantees around them.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  SERVER_POLICY_FILE,
  SERVER_SCENARIOS_FILE,
  SERVER_UNVERIFIED_POLICY_FILE,
  SERVER_UNVERIFIED_SCENARIOS_FILE,
  commitVerifiedServerArtifacts,
  invalidateServerArtifacts,
  loadVerifiedServerArtifacts,
  serverArtifactDir,
  writeUnverifiedServerPolicy,
  writeUnverifiedServerScenarios,
  type ServerPolicyDraft,
} from '../src/pipeline/server-artifacts.js';
import type { ServerCompiledPolicyFile, TestScenariosFile } from '../src/pipeline/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeServerDir(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ic-wp15-artifacts-'));
  dirs.push(root);
  return serverArtifactDir(root, 'fs');
}

const draft: ServerPolicyDraft = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  serverName: 'fs',
  constitutionHash: 'c',
  inputHash: 'input-1',
  rules: [
    { name: 'allow-fs-reads', description: 'd', principle: 'p', if: { server: ['fs'] }, then: 'allow', reason: 'r' },
  ],
};

const scenarios: TestScenariosFile = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  constitutionHash: 'c',
  inputHash: 'scenarios-1',
  scenarios: [],
};

function readPolicy(dir: string, file: string): ServerCompiledPolicyFile {
  return JSON.parse(readFileSync(resolve(dir, file), 'utf-8')) as ServerCompiledPolicyFile;
}

describe('serverArtifactDir', () => {
  it('places a server under <outputDir>/servers/<name>', () => {
    expect(serverArtifactDir('/out', 'git')).toBe('/out/servers/git');
  });

  it.each(['', '.', '..', '../x', 'a/b', 'a\\b', 'a\0b'])('rejects %j, which could leave servers/', (name) => {
    expect(() => serverArtifactDir('/out', name)).toThrow(/Invalid server name/);
  });
});

describe('verified commit', () => {
  it('commits the scenarios and the policy with verified: true, and drops inspection copies', () => {
    const dir = makeServerDir();
    writeUnverifiedServerPolicy(dir, draft);
    writeUnverifiedServerScenarios(dir, scenarios);

    commitVerifiedServerArtifacts(dir, draft, scenarios, { pass: true });

    const committed = readPolicy(dir, SERVER_POLICY_FILE);
    expect(committed.verified).toBe(true);
    expect(typeof committed.verifiedAt).toBe('string');
    expect(existsSync(resolve(dir, SERVER_SCENARIOS_FILE))).toBe(true);
    expect(existsSync(resolve(dir, SERVER_UNVERIFIED_POLICY_FILE))).toBe(false);
    expect(existsSync(resolve(dir, SERVER_UNVERIFIED_SCENARIOS_FILE))).toBe(false);
    expect(loadVerifiedServerArtifacts(dir, 'fs')?.policy.inputHash).toBe('input-1');
  });

  it('refuses to commit rules whose verification did not pass', () => {
    const dir = makeServerDir();
    expect(() => commitVerifiedServerArtifacts(dir, draft, scenarios, { pass: false })).toThrow(/Refusing/);
    expect(existsSync(resolve(dir, SERVER_POLICY_FILE))).toBe(false);
    expect(existsSync(resolve(dir, SERVER_SCENARIOS_FILE))).toBe(false);
  });

  it('marks unverified copies false, even when handed a policy claiming verification', () => {
    const dir = makeServerDir();
    const claimsVerified = { ...draft, verified: true } as ServerPolicyDraft;
    writeUnverifiedServerPolicy(dir, claimsVerified);
    expect(readPolicy(dir, SERVER_UNVERIFIED_POLICY_FILE).verified).toBe(false);
    expect(existsSync(resolve(dir, SERVER_POLICY_FILE))).toBe(false);
  });
});

describe('loadVerifiedServerArtifacts', () => {
  function writePair(dir: string, policy: Record<string, unknown>): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, SERVER_POLICY_FILE), JSON.stringify(policy));
    writeFileSync(resolve(dir, SERVER_SCENARIOS_FILE), JSON.stringify(scenarios));
  }

  it('ignores a policy without the verified marker (written by older versions)', () => {
    const dir = makeServerDir();
    writePair(dir, { ...draft });
    expect(loadVerifiedServerArtifacts(dir, 'fs')).toBeUndefined();
  });

  it('ignores a policy marked unverified, or recorded for another server', () => {
    const dir = makeServerDir();
    writePair(dir, { ...draft, verified: false });
    expect(loadVerifiedServerArtifacts(dir, 'fs')).toBeUndefined();
    writePair(dir, { ...draft, verified: true });
    expect(loadVerifiedServerArtifacts(dir, 'git')).toBeUndefined();
  });

  it('ignores a verified policy whose scenarios file is missing or corrupt', () => {
    const dir = makeServerDir();
    writePair(dir, { ...draft, verified: true });
    writeFileSync(resolve(dir, SERVER_SCENARIOS_FILE), '{ not json');
    expect(loadVerifiedServerArtifacts(dir, 'fs')).toBeUndefined();
    rmSync(resolve(dir, SERVER_SCENARIOS_FILE));
    expect(loadVerifiedServerArtifacts(dir, 'fs')).toBeUndefined();
  });

  it('never serves an inspection copy', () => {
    const dir = makeServerDir();
    writeUnverifiedServerPolicy(dir, draft);
    writeUnverifiedServerScenarios(dir, scenarios);
    expect(loadVerifiedServerArtifacts(dir, 'fs')).toBeUndefined();
  });
});

describe('invalidateServerArtifacts', () => {
  it('removes the cache-eligible pair and stale inspection copies, and tolerates a missing dir', () => {
    const dir = makeServerDir();
    expect(() => invalidateServerArtifacts(dir)).not.toThrow();

    commitVerifiedServerArtifacts(dir, draft, scenarios, { pass: true });
    writeUnverifiedServerPolicy(dir, draft);
    writeUnverifiedServerScenarios(dir, scenarios);
    writeFileSync(resolve(dir, 'dynamic-lists.json'), '{}');

    invalidateServerArtifacts(dir);

    for (const file of [
      SERVER_POLICY_FILE,
      SERVER_SCENARIOS_FILE,
      SERVER_UNVERIFIED_POLICY_FILE,
      SERVER_UNVERIFIED_SCENARIOS_FILE,
    ]) {
      expect(existsSync(resolve(dir, file))).toBe(false);
    }
    // Resolved list values are a separate cache and are kept.
    expect(existsSync(resolve(dir, 'dynamic-lists.json'))).toBe(true);
  });
});

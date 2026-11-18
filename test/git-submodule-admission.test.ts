import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hardenedGitEnv } from '../src/security/git-hardening.js';
import { inspectRepositoryForPolicy, requiresPerCallApproval } from '../src/trusted-process/git-structural-rules.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { StoredToolAnnotationsFile } from '../src/pipeline/types.js';

function entry(env: NodeJS.ProcessEnv, key: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++)
    if (env[`GIT_CONFIG_KEY_${i}`] === key) value = env[`GIT_CONFIG_VALUE_${i}`];
  return value;
}

describe('submodule admission without recursive repository inspection', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-submodule-admission-')));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '[core]\n repositoryformatversion = 0\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('pins non-recursive defaults for every shared hardened git caller', () => {
    const env = hardenedGitEnv({ baseEnv: {}, trustedConfig: { entries: [] } });
    for (const [key, value] of [
      ['submodule.recurse', 'false'],
      ['fetch.recurseSubmodules', 'false'],
      ['push.recurseSubmodules', 'no'],
      ['diff.ignoreSubmodules', 'all'],
      ['status.submoduleSummary', 'false'],
    ])
      expect(entry(env, key)).toBe(value);
  });

  it.each(['worktree metadata', 'stored modules', 'named config'])(
    'requires per-call review for %s without walking the child',
    (kind) => {
      if (kind === 'worktree metadata') writeFileSync(join(root, '.gitmodules'), '# ordinary fixture\n');
      else if (kind === 'stored modules') mkdirSync(join(root, '.git', 'modules', 'ordinary'), { recursive: true });
      else writeFileSync(join(root, '.git', 'config'), '[submodule "ordinary"]\n ignore = all\n');
      expect(inspectRepositoryForPolicy(root, root)).toContain('submodule');
    },
  );

  it('keeps an ordinary repository eligible for policy evaluation', () => {
    expect(inspectRepositoryForPolicy(root, root)).toBeUndefined();
  });

  it('carries metadata findings into a per-call structural policy escalation', () => {
    writeFileSync(join(root, '.gitmodules'), '# ordinary fixture\n');
    const annotations: StoredToolAnnotationsFile = {
      generatedAt: '',
      servers: {
        git: {
          inputHash: '',
          tools: [
            { serverName: 'git', toolName: 'git_status', comment: '', inputSchema: {}, args: { path: ['read-path'] } },
          ],
        },
      },
    };
    const engine = new PolicyEngine(
      { generatedAt: '', inputHash: '', constitutionHash: '', rules: [] },
      annotations,
      [],
      root,
    );
    const result = engine.evaluate({
      requestId: 'fixture',
      serverName: 'git',
      toolName: 'git_status',
      arguments: { path: root },
      timestamp: '',
    });
    expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-git-repository-escalate' });
    expect(requiresPerCallApproval(result)).toBe(true);
  });
});

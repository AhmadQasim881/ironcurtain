/**
 * Tests for the doctor's file and environment checks
 * (src/doctor/home-checks.ts): home and secret-file modes, the trusted env
 * files, trust-changing environment variables, package assets and fenced
 * nested-Docker leases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const assetFailure = vi.hoisted(() => ({ message: undefined as string | undefined }));

vi.mock('../src/docker-workload/watchdog-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/docker-workload/watchdog-policy.js')>();
  return {
    ...actual,
    loadFrozenWatchdogPolicyTemplate: vi.fn((...args: Parameters<typeof actual.loadFrozenWatchdogPolicyTemplate>) => {
      if (assetFailure.message !== undefined) throw new Error(assetFailure.message);
      return actual.loadFrozenWatchdogPolicyTemplate(...args);
    }),
  };
});

import {
  checkDockerWorkloadLeases,
  checkEnvFiles,
  checkEnvironmentVariables,
  checkHomePermissions,
  checkPackageAssets,
  checkSecretFiles,
} from '../src/doctor/home-checks.js';
import type { IronCurtainConfig } from '../src/config/types.js';

function configWith(dockerWorkloadEnabled: boolean): IronCurtainConfig {
  return {
    userConfig: { dockerWorkload: { enabled: dockerWorkloadEnabled } },
  } as unknown as IronCurtainConfig;
}

describe('doctor file checks', () => {
  let root: string;
  let home: string;
  const savedHome = process.env.IRONCURTAIN_HOME;
  const uid = process.geteuid?.();

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-files-'));
    home = join(root, 'home');
    mkdirSync(home, { mode: 0o700 });
    chmodSync(home, 0o700);
    process.env.IRONCURTAIN_HOME = home;
    assetFailure.message = undefined;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('wants the home closed to other users', () => {
    expect(checkHomePermissions(home, uid)).toMatchObject({ status: 'ok' });
    chmodSync(home, 0o755);
    const open = checkHomePermissions(home, uid);
    expect(open.status).toBe('warn');
    expect(open.message).toContain('open to other users (mode 0755)');
    expect(open.hint).toBe(`Run: chmod 700 ${home}`);
    chmodSync(home, 0o777);
    expect(checkHomePermissions(home, uid).status).toBe('fail');
    expect(checkHomePermissions(join(root, 'missing'), uid)).toMatchObject({ status: 'ok' });
  });

  it("fails group write only when the group is not the owner's private group (umask 002 homes)", () => {
    chmodSync(home, 0o775);
    const { uid: owner, gid } = statSync(home);
    const passwd = `owner:x:${owner}:${gid}::/home/owner:/bin/sh\nother:x:${owner + 4242}:${gid + 4242}::/home/other:/bin/sh\n`;
    // The owner's user-private group: group write grants nobody else anything.
    const privateGroup = { passwd, group: `owner:x:${gid}:\n` };
    const onPrivateGroup = checkHomePermissions(home, owner, () => privateGroup);
    expect(onPrivateGroup.status).toBe('warn');
    expect(onPrivateGroup.message).toContain('open to other users (mode 0775)');
    // A group another account belongs to can plant files in the home.
    const sharedGroup = { passwd, group: `staff:x:${gid}:other\n` };
    const onSharedGroup = checkHomePermissions(home, owner, () => sharedGroup);
    expect(onSharedGroup.status).toBe('fail');
    expect(onSharedGroup.message).toContain('writable by other users (mode 0775)');
    // Unprovable without the account database: fail closed.
    expect(checkHomePermissions(home, owner, () => undefined).status).toBe('fail');
  });

  it('wants every secret file owner-only', () => {
    const config = join(home, 'config.json');
    writeFileSync(config, '{}', { mode: 0o600 });
    chmodSync(config, 0o600);
    const oauthDir = join(home, 'oauth');
    mkdirSync(oauthDir, { mode: 0o700 });
    chmodSync(oauthDir, 0o700);
    expect(checkSecretFiles([config], oauthDir, uid)).toMatchObject({ status: 'ok', message: '1 file, owner-only' });

    chmodSync(config, 0o644);
    chmodSync(oauthDir, 0o755);
    const loose = checkSecretFiles([config, join(home, 'absent.json')], oauthDir, uid);
    expect(loose.status).toBe('warn');
    expect(loose.message).toContain(`${config} is readable by other users (mode 0644)`);
    expect(loose.message).toContain('is open to other users (mode 0755)');
    expect(loose.hint).toContain(`chmod 600 ${config}`);
    expect(loose.hint).toContain(`chmod 700 ${oauthDir}`);
  });

  it('reports a .env in the working directory that is never read, and loose env-file modes', () => {
    const project = join(root, 'project');
    mkdirSync(project);
    writeFileSync(join(project, '.env'), 'ANTHROPIC_API_KEY=sk-in-cwd\n');
    const ignored = checkEnvFiles({ IRONCURTAIN_HOME: home }, project);
    expect(ignored.status).toBe('warn');
    expect(ignored.message).toContain(`Note: ignoring ${join(project, '.env')}`);

    const homeEnv = join(home, '.env');
    writeFileSync(homeEnv, 'ANTHROPIC_API_KEY=sk-home\nNODE_OPTIONS=--inspect\n', { mode: 0o600 });
    chmodSync(homeEnv, 0o640);
    const loose = checkEnvFiles({ IRONCURTAIN_HOME: home }, home);
    expect(loose.status).toBe('warn');
    expect(loose.message).toContain('readable by others');
    expect(loose.message).toContain('ignored non-credential keys');
    expect(loose.message).toContain('NODE_OPTIONS');

    chmodSync(homeEnv, 0o600);
    writeFileSync(homeEnv, 'ANTHROPIC_API_KEY=sk-home\n');
    expect(checkEnvFiles({ IRONCURTAIN_HOME: home }, home)).toMatchObject({ status: 'ok' });
    // Run from the CLI, whose bootstrap has already copied the file's keys
    // into the environment: the file still counts as providing them.
    expect(checkEnvFiles({ IRONCURTAIN_HOME: home, ANTHROPIC_API_KEY: 'sk-home' }, home).message).toBe(
      `${homeEnv}: 1 credential key (a value set in the shell takes precedence)`,
    );

    chmodSync(homeEnv, 0o666);
    const refused = checkEnvFiles({ IRONCURTAIN_HOME: home }, home);
    expect(refused.status).toBe('fail');
    expect(refused.message).toContain('writable by every user');
  });

  it('flags environment variables that change IronCurtain trust settings', () => {
    expect(checkEnvironmentVariables({})).toMatchObject({ status: 'ok' });
    const risky = checkEnvironmentVariables({
      NODE_OPTIONS: '--require /tmp/x.cjs',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      IRONCURTAIN_MITM_ALLOW_ALL_HOSTS: '1',
      OPENAI_BASE_URL: 'http://gateway.example:8080/v1',
    });
    expect(risky.status).toBe('warn');
    expect(risky.message).toContain('NODE_OPTIONS is set');
    expect(risky.message).toContain('turns off TLS certificate checks');
    expect(risky.message).toContain('tunnel every unknown host without TLS inspection or egress filtering');
    expect(risky.message).not.toContain('terminate TLS for every host');
    expect(risky.message).toContain(
      'OPENAI_BASE_URL sends provider credentials unencrypted to http://gateway.example:8080',
    );

    const noted = checkEnvironmentVariables({ ANTHROPIC_BASE_URL: 'https://llm.internal.example' });
    expect(noted.status).toBe('ok');
    expect(noted.message).toContain(
      'ANTHROPIC_BASE_URL sends provider requests and credentials to https://llm.internal.example',
    );
    expect(checkEnvironmentVariables({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' }).status).toBe('ok');
  });

  it('reads the package assets nested Docker uses with the same loaders', async () => {
    expect(await checkPackageAssets(configWith(false))).toMatchObject({ status: 'ok' });

    assetFailure.message =
      'watchdog policy template is group-writable and its group (gid 1000) is not the private group';
    const disabled = await checkPackageAssets(configWith(false));
    expect(disabled.status).toBe('warn');
    expect(disabled.message).toContain('group-writable');
    expect(disabled.hint).toContain('would refuse');
    expect((await checkPackageAssets(configWith(true))).status).toBe('fail');
  });

  it('reports fenced nested-Docker leases and stays quiet without any', async () => {
    expect(await checkDockerWorkloadLeases(configWith(false))).toBeUndefined();
    expect(await checkDockerWorkloadLeases(configWith(true))).toMatchObject({ status: 'ok', message: 'none' });

    const leaseDir = join(home, 'docker-workload', 'leases', 'dw-broken');
    mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(leaseDir, 'lease.json'), '{not json', { mode: 0o600 });
    const disabled = await checkDockerWorkloadLeases(configWith(false));
    expect(disabled?.status).toBe('warn');
    expect(disabled?.message).toContain(
      '1 fenced, blocking nested-Docker admission: dw-broken (lease record is unreadable',
    );
    expect(disabled?.hint).toContain('`ironcurtain docker-workload status`');
    expect(disabled?.hint).toContain('`ironcurtain docker-workload clear <lease-id> --force`');
    expect((await checkDockerWorkloadLeases(configWith(true)))?.status).toBe('fail');
  });
});

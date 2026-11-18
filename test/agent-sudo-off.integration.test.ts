/**
 * Live acceptance check for `agentSudo: false` (audit finding DINF-3): a
 * container created from the real privilege plan cannot sudo, cannot make a
 * root-owned or root-chowned file in its workspace, and the setuid file it
 * can still make out of its own file is neutralized by the host-side scan.
 *
 * Needs native Linux Docker, the claude-code agent image, and a coordinator
 * running as UID 1000 (the only host identity a sudo-off Linux agent can
 * run as). Skipped otherwise, including under the verification harness, which
 * hides the Docker daemon.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAgentContainerConfig } from '../src/docker/docker-infrastructure.js';
import { buildCreateArgs } from '../src/docker/docker-manager.js';
import { scanHostMountPrivileges } from '../src/docker/host-mount-privilege-scan.js';
import { isDockerAvailable, isDockerImageAvailable } from './helpers/docker-available.js';

const execFile = promisify(execFileCallback);
const IMAGE = 'ironcurtain-claude-code:latest';

const ready =
  process.platform === 'linux' && process.getuid?.() === 1000 && isDockerAvailable() && isDockerImageAvailable(IMAGE);

async function dockerExec(name: string, script: string): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFile('docker', ['exec', '--user', '1000', name, 'sh', '-c', script], {
      timeout: 30_000,
    });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '' };
  }
}

describe.skipIf(!ready)('agentSudo: false container (live Docker)', () => {
  it('cannot sudo or plant a root-owned setuid file in /workspace; its own setuid copy is stripped', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ic-sudo-off-'));
    const workspace = join(base, 'workspace');
    mkdirSync(workspace);
    const name = `ic-sudo-off-${randomUUID()}`;
    const config = buildAgentContainerConfig(
      {
        runtimeKind: 'docker',
        useTcp: false,
        dockerWorkload: undefined,
        dockerWorkloadBootstrap: undefined,
        dockerDesktopAgentAccess: undefined,
        dockerDesktopResources: undefined,
      },
      {
        agentSudo: false,
        dockerResources: { memoryMb: null, cpus: null, pidsLimit: 256 },
        dockerWorkload: { enabled: false },
      },
      {
        image: IMAGE,
        name,
        network: 'none',
        mounts: [{ source: workspace, target: '/workspace', readonly: false }],
        env: {},
        command: ['sleep', 'infinity'],
      },
    );
    try {
      await execFile('docker', buildCreateArgs(config), { timeout: 60_000 });
      await execFile('docker', ['start', name], { timeout: 60_000 });

      const status = await dockerExec(name, 'grep -E "^(NoNewPrivs|CapBnd):" /proc/self/status');
      expect(status.stdout).toMatch(/NoNewPrivs:\s+1/u);
      expect(status.stdout).toMatch(/CapBnd:\s+0+\n/u);

      expect((await dockerExec(name, 'sudo -n true')).code).not.toBe(0);
      expect((await dockerExec(name, 'sudo -n install -m 4755 /bin/sh /workspace/root-shell')).code).not.toBe(0);
      expect(
        (await dockerExec(name, 'cp /bin/sh /workspace/own-shell && chown 0:0 /workspace/own-shell')).code,
      ).not.toBe(0);
      expect((await dockerExec(name, 'chmod u+s /workspace/own-shell')).code).toBe(0);

      // On the host: nothing is root-owned, and the agent's own setuid copy is neutralized.
      expect(existsSync(join(workspace, 'root-shell'))).toBe(false);
      expect(lstatSync(join(workspace, 'own-shell')).uid).toBe(1000);
      const scan = await scanHostMountPrivileges([{ hostPath: workspace, containerPath: '/workspace' }]);
      expect(scan.rootOwned).toEqual([]);
      expect(scan.unstripped).toEqual([]);
      expect(scan.stripped.map((entry) => entry.path)).toEqual([join(workspace, 'own-shell')]);
      expect(lstatSync(join(workspace, 'own-shell')).mode & 0o6000).toBe(0);
    } finally {
      await execFile('docker', ['rm', '-f', name], { timeout: 30_000 }).catch(() => {});
      rmSync(base, { recursive: true, force: true });
    }
  }, 180_000);
});

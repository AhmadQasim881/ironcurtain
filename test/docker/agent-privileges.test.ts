import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_SUDO_CAPABILITIES,
  AGENT_SUDO_UNSUPPORTED,
  AgentSudoUnsupportedError,
  NO_NEW_PRIVILEGES_SECURITY_OPTION,
  isAgentSudoEnabled,
  planAgentContainerPrivileges,
  planBundleAgentPrivileges,
} from '../../src/docker/agent-privileges.js';
import { buildAgentContainerConfig } from '../../src/docker/docker-infrastructure.js';
import { buildCreateArgs } from '../../src/docker/docker-manager.js';
import { createContainerRuntime } from '../../src/docker/container-runtime.js';
import type { DockerContainerConfig } from '../../src/docker/types.js';

const BASE_CONFIG: DockerContainerConfig = {
  image: 'ironcurtain-claude-code:latest',
  name: 'ironcurtain-test',
  network: 'none',
  mounts: [{ source: '/tmp/ironcurtain-test-workspace', target: '/workspace', readonly: false }],
  env: { TEST: '1' },
  command: ['sleep', 'infinity'],
};

function expectUnsupported(run: () => unknown, message: RegExp): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentSudoUnsupportedError);
    expect((error as AgentSudoUnsupportedError).code).toBe(AGENT_SUDO_UNSUPPORTED);
    expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error('expected an AgentSudoUnsupportedError');
}

describe('agent container privilege plan (DINF-3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps today's sudo default: root start with the UID remap on Linux Docker, sudo capabilities everywhere", () => {
    const linux = planAgentContainerPrivileges({
      runtimeKind: 'docker',
      useTcp: false,
      agentSudo: true,
      nestedDocker: false,
      hostIdentity: { uid: 1500, gid: 100 },
    });
    expect(linux.agentSudo).toBe(true);
    expect(linux.user).toBe('0:0');
    expect(linux.env).toEqual({ IRONCURTAIN_AGENT_UID: '1500', IRONCURTAIN_AGENT_GID: '100' });
    expect(linux.capAdd).toEqual(['SETUID', 'SETGID', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'AUDIT_WRITE']);
    expect(linux.securityOptions).toEqual([]);
    expect(linux.startupProbeUser).toBe('0:0');
    expect(linux.execUser).toBeUndefined();

    for (const runtime of [
      { runtimeKind: 'docker', useTcp: true },
      { runtimeKind: 'apple-container', useTcp: false },
    ] as const) {
      const plan = planAgentContainerPrivileges({ ...runtime, agentSudo: true, nestedDocker: true });
      expect(plan.user).toBeUndefined();
      expect(plan.env).toEqual({});
      expect(plan.capAdd).toEqual(AGENT_SUDO_CAPABILITIES);
      expect(plan.securityOptions).toEqual([]);
      expect(plan.startupProbeUser).toBeUndefined();
      expect(plan.execUser).toBeUndefined();
    }
  });

  it('with agentSudo: false runs the Linux agent as numeric UID 1000 with no-new-privileges and no capabilities', () => {
    const plan = planAgentContainerPrivileges({
      runtimeKind: 'docker',
      useTcp: false,
      agentSudo: false,
      nestedDocker: false,
      hostIdentity: { uid: 1000, gid: 100 },
    });
    expect(plan).toEqual({
      agentSudo: false,
      user: '1000',
      env: { IRONCURTAIN_AGENT_SUDO: 'disabled' },
      capAdd: [],
      securityOptions: [NO_NEW_PRIVILEGES_SECURITY_OPTION],
      startupProbeUser: '1000',
      execUser: '1000',
    });
    for (const capability of ['CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'SETUID', 'SETGID']) {
      expect(plan.capAdd).not.toContain(capability);
    }
  });

  it('with agentSudo: false on Docker Desktop pins the image UID without the Linux probe', () => {
    const plan = planAgentContainerPrivileges({
      runtimeKind: 'docker',
      useTcp: true,
      agentSudo: false,
      nestedDocker: false,
      // The host identity does not matter where VirtioFS translates ownership.
      hostIdentity: { uid: 501, gid: 20 },
    });
    expect(plan.user).toBe('1000');
    expect(plan.capAdd).toEqual([]);
    expect(plan.securityOptions).toEqual(['no-new-privileges:true']);
    expect(plan.startupProbeUser).toBeUndefined();
    expect(plan.execUser).toBe('1000');
  });

  it('refuses agentSudo: false where it cannot be enforced instead of keeping root quietly', () => {
    expectUnsupported(
      () =>
        planAgentContainerPrivileges({
          runtimeKind: 'docker',
          useTcp: false,
          agentSudo: false,
          nestedDocker: false,
          hostIdentity: { uid: 1500, gid: 1500 },
        }),
      /needs IronCurtain to run as UID 1000.*runs as UID 1500/su,
    );
    expectUnsupported(
      () =>
        planAgentContainerPrivileges({
          runtimeKind: 'apple-container',
          useTcp: false,
          agentSudo: false,
          nestedDocker: false,
        }),
      /apple-container runtime/u,
    );
    expectUnsupported(
      () =>
        planAgentContainerPrivileges({
          runtimeKind: 'docker',
          useTcp: true,
          agentSudo: false,
          nestedDocker: true,
        }),
      /nested Docker/u,
    );
  });

  it('defaults to sudo on when the config does not say false', () => {
    expect(isAgentSudoEnabled({})).toBe(true);
    expect(isAgentSudoEnabled({ agentSudo: true })).toBe(true);
    expect(isAgentSudoEnabled({ agentSudo: false })).toBe(false);
    expect(planBundleAgentPrivileges({ runtimeKind: 'docker', useTcp: true }, {}).agentSudo).toBe(true);
    expect(
      planBundleAgentPrivileges(
        { runtimeKind: 'docker', useTcp: true, dockerWorkload: undefined },
        { agentSudo: false },
      ).agentSudo,
    ).toBe(false);
  });
});

describe('agent container create flags from the privilege plan', () => {
  const linuxCore = {
    runtimeKind: 'docker',
    useTcp: false,
    dockerWorkload: undefined,
    dockerWorkloadBootstrap: undefined,
    dockerDesktopAgentAccess: undefined,
    dockerDesktopResources: undefined,
  } as const;
  const userConfig = (agentSudo?: boolean) => ({
    dockerResources: { memoryMb: null, cpus: null, pidsLimit: 4096 },
    dockerWorkload: { enabled: false as const },
    ...(agentSudo === undefined ? {} : { agentSudo }),
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits no-new-privileges, no capabilities and --user 1000 for a sudo-off Linux container', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    vi.spyOn(process, 'getgid').mockReturnValue(1000);
    const config = buildAgentContainerConfig(linuxCore, userConfig(false), BASE_CONFIG);
    const args = buildCreateArgs(config);

    expect(args).toContain('--cap-drop=ALL');
    expect(args).not.toContain('--cap-add');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges:true');
    expect(args[args.indexOf('--user') + 1]).toBe('1000');
    expect(args).toContain('IRONCURTAIN_AGENT_SUDO=disabled');
    expect(args.some((arg) => arg.startsWith('IRONCURTAIN_AGENT_UID='))).toBe(false);
    expect(config.env.TEST).toBe('1');
  });

  it('keeps the sudo capabilities, the root start and no security option by default', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1500);
    vi.spyOn(process, 'getgid').mockReturnValue(1500);
    const args = buildCreateArgs(buildAgentContainerConfig(linuxCore, userConfig(), BASE_CONFIG));

    const capabilities = args.flatMap((arg, index) => (args[index - 1] === '--cap-add' ? [arg] : []));
    expect(capabilities).toEqual(['SETUID', 'SETGID', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'AUDIT_WRITE']);
    expect(args).not.toContain('--security-opt');
    expect(args[args.indexOf('--user') + 1]).toBe('0:0');
    expect(args).toContain('IRONCURTAIN_AGENT_UID=1500');
  });

  it('fails closed when a sudo-off container would need the root UID remap', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1500);
    vi.spyOn(process, 'getgid').mockReturnValue(1500);
    expect(() => buildAgentContainerConfig(linuxCore, userConfig(false), BASE_CONFIG)).toThrow(
      AgentSudoUnsupportedError,
    );
  });
});

describe('runtime default exec user', () => {
  it('is Docker-only: the Apple runtime never hosts a sudo-off agent', () => {
    expect(createContainerRuntime('docker', undefined, { defaultExecUser: '1000' }).supportsImageSnapshots).toBe(true);
    expect(() => createContainerRuntime('apple-container', undefined, { defaultExecUser: '1000' })).toThrow(
      /does not support a non-default agent exec user/u,
    );
  });
});

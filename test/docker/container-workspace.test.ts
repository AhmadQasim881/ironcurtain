/**
 * The Docker workspace mount helper is filesystem-independent defense in
 * depth behind validateWorkspacePath(): it refuses to bind-mount the user's
 * home, the IronCurtain home, or an ancestor of either, and anything that is,
 * contains or lies inside the MCP relays' private scratch root, by spelling.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildContainerWorkspaceMount, CONTAINER_WORKSPACE_DIR } from '../../src/docker/container-workspace.js';
import { getPrivateScratchRoot } from '../../src/trusted-process/spawn-cwd.js';

const TRUSTED_ROOT_ERROR = 'must not be the home directory, the IronCurtain home, or an ancestor of either';
const SCRATCH_ROOT_ERROR = 'must not be, contain or lie inside the private scratch directory of the MCP servers';

describe('buildContainerWorkspaceMount', () => {
  const saved = {
    HOME: process.env.HOME,
    IRONCURTAIN_HOME: process.env.IRONCURTAIN_HOME,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };

  beforeEach(() => {
    process.env.HOME = '/home/alice';
    process.env.IRONCURTAIN_HOME = '/srv/ic/state';
    // os.tmpdir(), under which the relays keep their scratch root.
    process.env.TMPDIR = '/var/scratch-tmp';
    delete process.env.TMP;
    delete process.env.TEMP;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('mounts an ordinary canonical workspace read-write at /workspace', () => {
    expect(buildContainerWorkspaceMount('/home/alice/project')).toEqual({
      source: '/home/alice/project',
      target: CONTAINER_WORKSPACE_DIR,
      readonly: false,
    });
  });

  it('mounts the workspace read-only for a read-only workspace session', () => {
    expect(buildContainerWorkspaceMount('/home/alice/project', { readonly: true })).toEqual({
      source: '/home/alice/project',
      target: CONTAINER_WORKSPACE_DIR,
      readonly: true,
    });
    expect(buildContainerWorkspaceMount('/home/alice/project', { readonly: false }).readonly).toBe(false);
  });

  it('still mounts managed workspaces inside the IronCurtain home', () => {
    for (const dir of ['/srv/ic/state/sessions/abc/sandbox', '/srv/ic/state/workflow-runs/wf-1/workspace']) {
      expect(buildContainerWorkspaceMount(dir).source).toBe(dir);
    }
  });

  it.each(['relative/path', '/home/alice/../bob', '/home/alice/project/', '/'])(
    'rejects the non-canonical or root source %s',
    (dir) => {
      expect(() => buildContainerWorkspaceMount(dir)).toThrow('canonical absolute directory below root');
    },
  );

  it.each(['/home/alice', '/home', '/srv/ic/state', '/srv/ic', '/srv'])(
    'refuses to mount %s (a trusted root or an ancestor of one)',
    (dir) => {
      expect(() => buildContainerWorkspaceMount(dir)).toThrow(TRUSTED_ROOT_ERROR);
    },
  );

  it('compares folded spellings, since the check only denies', () => {
    expect(() => buildContainerWorkspaceMount('/home/ALICE')).toThrow(TRUSTED_ROOT_ERROR);
    expect(() => buildContainerWorkspaceMount('/SRV/IC/State')).toThrow(TRUSTED_ROOT_ERROR);
  });

  it("refuses the relays' scratch root, anything inside it and every ancestor of it (such as /tmp)", () => {
    const scratchRoot = getPrivateScratchRoot();
    expect(scratchRoot.startsWith('/var/scratch-tmp/ironcurtain-')).toBe(true);
    for (const dir of [scratchRoot, `${scratchRoot}/srt-abc123/filesystem.cwd`, '/var/scratch-tmp', '/var']) {
      expect(() => buildContainerWorkspaceMount(dir)).toThrow(SCRATCH_ROOT_ERROR);
    }
    expect(() => buildContainerWorkspaceMount('/VAR/Scratch-Tmp')).toThrow(SCRATCH_ROOT_ERROR);
    // Its siblings are ordinary directories.
    expect(buildContainerWorkspaceMount('/var/scratch-tmp/project').source).toBe('/var/scratch-tmp/project');
  });

  it('protects the default IronCurtain home under $HOME', () => {
    delete process.env.IRONCURTAIN_HOME;
    expect(() => buildContainerWorkspaceMount('/home/alice/.ironcurtain')).toThrow(TRUSTED_ROOT_ERROR);
    expect(buildContainerWorkspaceMount('/home/alice/.ironcurtain/workflow-runs/wf-1/workspace').source).toBe(
      '/home/alice/.ironcurtain/workflow-runs/wf-1/workspace',
    );
  });
});

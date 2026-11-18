/** Numeric identity shared by the agent, private daemon, and trust staging. */
export interface ContainerIdentity {
  readonly uid: number;
  readonly gid: number;
}

/** Linux bind mounts use the host identity; VM file sharing keeps the image identity. */
export function resolveContainerIdentity(useHostIdentity: boolean): ContainerIdentity {
  return useHostIdentity
    ? { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 }
    : { uid: 1000, gid: 1000 };
}

/**
 * Why Linux Docker agent mode refuses to run as root. The entrypoint renumbers
 * the baked `codespace` user to the host identity (`usermod -u
 * "$IRONCURTAIN_AGENT_UID"`), and UID 0 already exists in every image, so the
 * container would fail at start, after the image had already been built
 * (audit finding DINF-23). Running the agent as container root is not an
 * alternative: Claude Code refuses `--dangerously-skip-permissions` as root.
 */
export const ROOT_HOST_IDENTITY_MESSAGE =
  'IronCurtain is running as root (UID 0). Linux Docker agent mode renumbers the container agent user to the ' +
  "host UID, and the image cannot renumber it to 0 (usermod: UID '0' already exists). Run IronCurtain as a " +
  'regular, non-root user; sudo remains available inside agent containers.';

/**
 * Fails fast, before any image build or container creation, when the host
 * identity that Linux Docker agent containers would inherit is root.
 */
export function assertAgentHostIdentityIsNotRoot(identity: ContainerIdentity): void {
  if (identity.uid === 0) {
    throw new Error(ROOT_HOST_IDENTITY_MESSAGE);
  }
}

/**
 * The transport sidecar image against a real Docker daemon (WP-27). Opt-in,
 * like the Docker Desktop relay suite: set TRANSPORT_SIDECAR_INTEGRATION=1 on
 * a host with Docker and network access (the first build pulls the alpine
 * base image and installs socat). Not run by default or in CI.
 *
 * It builds docker/transport-sidecar/Dockerfile through
 * ensureTransportSidecarImage, checks that a second call reuses the cached
 * build, and runs the image with the sidecar's hardening (read-only root,
 * nobody, every capability dropped, no new privileges) to show socat starts
 * under it. The relay topology itself is exercised by the macOS manual tests
 * in docs/designs/tcp-mode-network-egress-restriction.md.
 */

import { describe, expect, it } from 'vitest';
import { createContainerRuntime } from '../../src/docker/container-runtime.js';
import { defaultExecFile } from '../../src/docker/docker-manager.js';
import { ensureTransportSidecarImage, TRANSPORT_SIDECAR_USER } from '../../src/docker/transport-sidecar-image.js';
import { isRuntimeAvailable } from '../helpers/container-runtimes.js';

const enabled = process.env.TRANSPORT_SIDECAR_INTEGRATION === '1';
const ready = enabled && isRuntimeAvailable('docker');

describe.skipIf(!ready)('transport sidecar image (Docker)', () => {
  it('builds from the vendored Dockerfile, reuses the build, and runs socat read-only as nobody', async () => {
    const imageId = await ensureTransportSidecarImage(createContainerRuntime('docker'));
    expect(imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(ensureTransportSidecarImage(createContainerRuntime('docker'))).resolves.toBe(imageId);

    const { stdout } = await defaultExecFile(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop=ALL',
        '--read-only',
        '--security-opt',
        'no-new-privileges:true',
        '--user',
        TRANSPORT_SIDECAR_USER,
        '--entrypoint',
        '/bin/sh',
        imageId,
        '-c',
        'id -u && socat -V',
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    expect(stdout.split('\n')[0]).toBe('65534');
    expect(stdout).toMatch(/socat version \d/);
  }, 600_000);
});

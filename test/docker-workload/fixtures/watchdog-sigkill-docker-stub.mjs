#!/usr/bin/env -S -u NODE_OPTIONS node
/**
 * Stateful `docker` CLI stub for the watchdog SIGKILL cross-process test.
 *
 * This is deliberately plain JavaScript: the test's coordinator and detached
 * supervisor need the tsx loader, but DockerManager launches this short-lived
 * process repeatedly. Keeping the CLI stub loader-free prevents inherited
 * Node instrumentation from delaying or intercepting exact-ID probes.
 *
 * Supported subcommands (everything else fails loudly):
 * - container list/inspect/stop/rm for the leased agent, nested daemon, and proxy
 * - network list/inspect/rm for the leased transport network
 * - volume list/inspect/rm for the leased daemon volume
 * - `inspect <id>` existence probes for any container
 * - the watchdog's two Docker Desktop readings: `exec` of the VM-disk statfs in
 *   the nested daemon, and `system df` volume sizes (read from `volumeSizePath`,
 *   which the test rewrites to grow the volume)
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const configPath = process.env.IRONCURTAIN_WATCHDOG_DOCKER_STUB_CONFIG;
if (configPath === undefined || configPath === '') {
  process.stderr.write('docker-stub: IRONCURTAIN_WATCHDOG_DOCKER_STUB_CONFIG is not set\n');
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--host') {
  if (args[1] !== 'unix:///var/run/docker.sock') throw new Error('unexpected watchdog endpoint');
  args.splice(0, 2);
}
appendFileSync(config.logPath, `${JSON.stringify(args)}\n`, { mode: 0o600 });

const containers = [
  { id: config.containerId, name: config.containerName, removedMarkerPath: config.removedMarkerPath },
  {
    id: config.proxyContainerId,
    name: config.proxyContainerName,
    removedMarkerPath: config.proxyRemovedMarkerPath,
  },
  {
    id: config.daemonContainerId,
    name: config.daemonContainerName,
    removedMarkerPath: config.daemonRemovedMarkerPath,
  },
];
const volumeRemoved = () => existsSync(config.volumeRemovedMarkerPath);
const activeContainers = () => containers.filter(({ removedMarkerPath }) => !existsSync(removedMarkerPath));
const containerPayload = (resources) =>
  JSON.stringify(
    resources.map(({ id, name }) => ({
      Id: id,
      Name: `/${name}`,
      Created: '2026-07-21T00:00:00.000000000Z',
      Config: { Labels: { [config.labelKey]: config.labelValue } },
      State: { Running: true },
    })),
  );
const networkRemoved = () => existsSync(config.networkRemovedMarkerPath);
const networkPayload = () =>
  JSON.stringify([
    {
      Id: config.networkId,
      Name: config.networkName,
      Created: '2026-07-21T00:00:00.000000000Z',
      Labels: { [config.labelKey]: config.labelValue },
      IPAM: { Config: [{ Subnet: '172.31.250.0/24' }] },
      Containers: {},
    },
  ]);

if (args[0] === 'container' && args[1] === 'ls') {
  const ids = activeContainers().map(({ id }) => id);
  if (ids.length > 0) writeFileSync(1, `${ids.join('\n')}\n`);
  process.exit(0);
}
if (args[0] === 'container' && args[1] === 'inspect') {
  const requested = args.slice(2);
  const matching = activeContainers().filter(({ id }) => requested.includes(id));
  if (matching.length !== requested.length) {
    process.stderr.write(`Error: No such container: ${args.slice(2).join(' ')}\n`);
    process.exit(1);
  }
  writeFileSync(1, `${containerPayload(matching)}\n`);
  process.exit(0);
}
const targetContainer = containers.find(({ id }) => id === args.at(-1));
if (args[0] === 'stop' && targetContainer !== undefined && !existsSync(targetContainer.removedMarkerPath)) {
  writeFileSync(1, `${targetContainer.id}\n`);
  process.exit(0);
}
const removedContainer = containers.find(({ id }) => id === args[2]);
if (args[0] === 'rm' && args[1] === '-f' && removedContainer !== undefined) {
  writeFileSync(removedContainer.removedMarkerPath, 'removed\n', { mode: 0o600 });
  writeFileSync(1, `${removedContainer.id}\n`);
  process.exit(0);
}
const inspectedContainer = containers.find(({ id }) => id === args[1]);
if (args[0] === 'inspect' && inspectedContainer !== undefined) {
  if (existsSync(inspectedContainer.removedMarkerPath)) {
    process.stderr.write(`Error: No such object: ${inspectedContainer.id}\n`);
    process.exit(1);
  }
  writeFileSync(1, `${containerPayload([inspectedContainer])}\n`);
  process.exit(0);
}
if (
  args[0] === 'exec' &&
  args[1] === '--user' &&
  args[2] === '0:0' &&
  args[3] === config.daemonContainerId &&
  args.slice(4).join(' ') === '/bin/busybox stat -f -c %S %b %f %a /home/codespace/.local/share'
) {
  if (existsSync(config.daemonRemovedMarkerPath)) {
    process.stderr.write(`Error: No such container: ${config.daemonContainerId}\n`);
    process.exit(1);
  }
  // 4 KiB blocks, 64 GiB disk, plenty free: the runtime reserve never trips here.
  writeFileSync(1, '4096 16777216 15728640 15728640\n');
  process.exit(0);
}
if (args.join(' ') === 'system df --verbose --format {{json .Volumes}}') {
  const size = existsSync(config.volumeSizePath) ? readFileSync(config.volumeSizePath, 'utf8').trim() : '0B';
  const volumes = volumeRemoved() ? [] : [{ Name: config.volumeName, Driver: 'local', Links: '1', Size: size }];
  writeFileSync(1, `${JSON.stringify(volumes)}\n`);
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'ls') {
  if (!volumeRemoved()) writeFileSync(1, `${config.volumeName}\n`);
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'inspect') {
  if (volumeRemoved() || !args.slice(2).includes(config.volumeName)) {
    process.stderr.write(`Error: No such volume: ${args.slice(2).join(' ')}\n`);
    process.exit(1);
  }
  writeFileSync(
    1,
    `${JSON.stringify([
      {
        Name: config.volumeName,
        CreatedAt: '2026-07-21T00:00:00Z',
        Driver: 'local',
        Labels: { [config.labelKey]: config.labelValue },
        Mountpoint: `/var/lib/docker/volumes/${config.volumeName}/_data`,
      },
    ])}\n`,
  );
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'rm' && args[2] === config.volumeName) {
  writeFileSync(config.volumeRemovedMarkerPath, 'removed\n', { mode: 0o600 });
  writeFileSync(1, `${config.volumeName}\n`);
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'ls') {
  if (!networkRemoved()) writeFileSync(1, `${config.networkId}\n`);
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'inspect') {
  if (networkRemoved() || !args.slice(2).includes(config.networkId)) {
    process.stderr.write(`Error: No such network: ${args.slice(2).join(' ')}\n`);
    process.exit(1);
  }
  writeFileSync(1, `${networkPayload()}\n`);
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'rm' && args[2] === config.networkId) {
  writeFileSync(config.networkRemovedMarkerPath, 'removed\n', { mode: 0o600 });
  writeFileSync(1, `${config.networkId}\n`);
  process.exit(0);
}
process.stderr.write(`docker-stub: unsupported invocation: ${JSON.stringify(args)}\n`);
process.exit(1);

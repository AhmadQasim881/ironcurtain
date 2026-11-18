# TCP Mode: Network Egress Restriction via `--internal` Docker Network + Socat Sidecar

**Status (2026-11-14):** Implemented (PR #32). The socat sidecar image is now built locally from `docker/transport-sidecar/Dockerfile` instead of being pulled by name, and the container is created from its immutable image ID and runs read-only, as an unprivileged user, with every capability dropped (`src/docker/transport-sidecar-image.ts`).

## Problem

On macOS, Docker Desktop's VirtioFS does not support Unix domain sockets in
bind mounts. PR #28 adds TCP-based proxy transport as a workaround: the MCP
proxy and MITM proxy listen on TCP ports on the host, and the container
connects via `host.docker.internal`. This requires switching the container
from `--network=none` to a networked mode.

The security regression: a container on a bridge network can make arbitrary
outbound TCP connections to the internet, bypassing both the MITM proxy
(which filters LLM API endpoints) and the MCP proxy (which enforces policy).
The `HTTP_PROXY` / `HTTPS_PROXY` environment variables are advisory -- any
software in the container can ignore them.

## Solution: `--internal` Network + Socat Sidecar

### How `--internal` Networks Work

Docker's `--internal` flag on a bridge network does three things:

1. **No default route** in the container's routing table
2. **iptables DROP rules** that block traffic leaving the bridge subnet
3. **Gateway IP remains reachable** (documented, by design)

All enforcement is at the Docker daemon / host network layer. The container
cannot circumvent it without `CAP_NET_ADMIN`, which is not granted.

### Docker Desktop macOS Complication

On Docker Desktop, containers run inside a Linux VM. The bridge gateway IP
(e.g., `172.30.0.1`) lives inside the VM and does **not** forward TCP traffic
to the macOS host. This means the agent container on an `--internal` network
cannot directly reach host-side proxies via the gateway IP.

### Sidecar Solution

A lightweight socat sidecar container bridges the gap:

```
┌─────────────────────────────────┐
│  ironcurtain-internal (--internal) │
│                                 │
│  App Container ──TCP──► Sidecar │
│  (no internet)          (socat) │
└─────────────────────────┬───────┘
                          │
┌─────────────────────────┴───────┐
│  bridge (default)               │
│                                 │
│  Sidecar ──TCP──► host.docker.  │
│  (socat)          internal      │
└─────────────────────────────────┘
                          │
                     macOS host
                  (MCP + MITM proxies)
```

1. The sidecar is created on the default `bridge` network (can reach
   `host.docker.internal`).
2. It is then connected to the `--internal` network, giving it a second
   network interface.
3. The sidecar runs two socat forwarders — one for each proxy port — that
   listen on the internal network and forward to the host.
4. The app container's `host.docker.internal` is overridden via `--add-host`
   to point at the sidecar's IP on the internal network.

The app container can **only** reach the two forwarded proxy ports. It cannot
reach the host gateway, any host service, or the internet. This provides
the same security guarantee as Linux's `--network=none`.

## Implementation

### Network and sidecar creation (session startup)

```bash
# 1. Create --internal network
docker network create --internal \
  --subnet 172.30.0.0/24 --gateway 172.30.0.1 \
  ironcurtain-internal

# 2. Build the sidecar image from the vendored Dockerfile (only when the
#    cached image's build-hash label differs) and resolve it to its
#    immutable ID
docker build --label ironcurtain.build-hash=${BUILD_HASH} \
  --label ironcurtain.component=transport-sidecar \
  -t ironcurtain-transport-sidecar:latest docker/transport-sidecar
SIDECAR_IMAGE=$(docker image inspect -f '{{.Id}}' ironcurtain-transport-sidecar:latest)

# 3. Create and start the socat sidecar on default bridge: read-only,
#    unprivileged, every capability dropped, no new privileges
docker create --name ironcurtain-sidecar-${ID} \
  --network bridge --init --cap-drop=ALL --read-only \
  --security-opt no-new-privileges:true --user 65534:65534 \
  --entrypoint /bin/sh ${SIDECAR_IMAGE} \
  -c "socat TCP-LISTEN:${MCP_PORT},fork,reuseaddr TCP:host.docker.internal:${MCP_PORT} & \
      socat TCP-LISTEN:${MITM_PORT},fork,reuseaddr TCP:host.docker.internal:${MITM_PORT}"
docker start ironcurtain-sidecar-${ID}

# 4. Connect sidecar to internal network
docker network connect ironcurtain-internal ironcurtain-sidecar-${ID}

# 5. Get sidecar's IP on internal network
SIDECAR_IP=$(docker inspect -f '{{json .NetworkSettings.Networks}}' \
  ironcurtain-sidecar-${ID} | jq -r '.["ironcurtain-internal"].IPAddress')

# 6. Create app container on internal network, pointing at sidecar
docker create --network ironcurtain-internal \
  --add-host=host.docker.internal:${SIDECAR_IP} \
  -e HTTPS_PROXY=http://host.docker.internal:${MITM_PORT} \
  ...
```

### Sidecar image

The sidecar relays plaintext MCP JSON-RPC and the agent's CONNECT streams (and,
in PTY mode, the terminal), so its image is part of the isolation boundary.
It used to be `alpine/socat`, a community Docker Hub repository pulled by
name (so `:latest`) and trusted by name whenever an image with that name was
present. `src/docker/transport-sidecar-image.ts` is now the only place that
resolves it:

- the image is built locally from the vendored
  `docker/transport-sidecar/Dockerfile`: the Docker Official `alpine` image
  plus Alpine's `socat` package, whose signature apk verifies against the
  keys the base image ships. Nothing is pulled from a third-party namespace;
- `ensureTransportSidecarImage` goes through the build-hash-labelled image
  cache like the other locally built images (`ironcurtain.build-hash` over
  the build inputs, plus `ironcurtain.component=transport-sidecar`): it
  rebuilds when the Dockerfile changed, then inspects the tag and returns the
  immutable image ID only when both labels name this build. The sidecar is
  created from that ID, so a local image that merely carries the tag is
  never run;
- `hardenTransportSidecarCreate` runs it with a read-only root filesystem, as
  `65534:65534` (nobody, also the image's default user), with
  `no-new-privileges` on top of the unconditional `--cap-drop=ALL` and the
  Docker Desktop transport resource share. socat needs no privilege and no
  writable path: every relayed port is unprivileged.

The first TCP-mode session on a host builds the image, which needs network
access for the base image and the package (as pulling `alpine/socat` did); a
failed build fails the session closed with the build error. The base image is
named by tag, as for the other locally built images; pinning it by digest is
a reviewed follow-up.

### Connectivity validation

After starting the app container, verify proxy reachability:

```bash
docker exec $CONTAINER_ID \
  socat -u /dev/null TCP:host.docker.internal:${MCP_PORT},connect-timeout=5
```

If this fails, IronCurtain aborts session initialization.

### Cleanup (session close)

Both the app container and sidecar are stopped and removed. The internal
network is removed (errors ignored — other sessions may still use it).

## DockerManager Interface Additions

```typescript
// Connect an existing container to a Docker network
connectNetwork(networkName: string, containerId: string): Promise<void>;

// Get a container's IP on a specific network (with retry for async IP assignment)
getContainerIp(containerId: string, network: string): Promise<string>;
```

The `DockerContainerConfig` also gained an `entrypoint` field to override
the sidecar image's `ENTRYPOINT ["socat"]` (the sidecar runs `/bin/sh -c` to
start one socat per relayed port), and the sidecar uses the `user` and
`trustedCreateOptions` (`readOnlyRootfs`, `securityOptions`) fields for its
hardening.

## Manual Testing on macOS

### Test 1: Verify `--internal` network blocks internet egress

```bash
docker network create --internal \
  --subnet 172.30.0.0/24 --gateway 172.30.0.1 \
  ironcurtain-test-net

docker run --rm --network ironcurtain-test-net alpine:latest \
  sh -c "wget -q -O- --timeout=5 http://example.com && echo REACHABLE || echo BLOCKED"
# Expected: BLOCKED

docker network rm ironcurtain-test-net
```

### Test 2: End-to-end with IronCurtain

Run a full IronCurtain Docker session on macOS and verify:

1. The agent can call MCP tools (traffic goes through MCP proxy)
2. The agent can make LLM API calls (traffic goes through MITM proxy)
3. The agent cannot `curl` or `wget` arbitrary URLs directly
4. The audit log shows all tool calls

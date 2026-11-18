# Docker Desktop TCP admission

**Status (2026-11-16):** Implemented (`src/docker/tcp-transport-sidecar.ts`, `src/trusted-process/tcp-server-transport.ts`); final qualification is recorded in the handoff report.

Ordinary macOS Docker Desktop sessions use an internal bundle network and a dual-homed transport sidecar. A private destination bind alone does not authorize the shared host-gateway route. Each bundle therefore has independent MCP and HTTP proxy credentials. They are delivered to the agent through value-free Docker environment arguments; their values remain in the Docker CLI child environment. Privileged Docker inspection can still read the container environment. The agent is allowed to use its own credentials.

The host MCP listener requires a bounded authentication preface before health checks or MCP server allocation. All three agent adapters use the packaged Node TCP bridge; UDS configuration retains socat. Missing or wrong credentials fail closed. The host HTTP proxy requires its own credential for requests, CONNECT and upgrades, including health. A metrics lease combines the transport credential with a separate correlation token; admission consumes the transport part before policy and upstream forwarding. Correlation alone grants no admission.

The sidecar-to-host hop uses TLS verified against the public bundle CA and the exact host.docker.internal server name. The CA private key stays on the host. Both listeners enforce bounded handshake/admission deadlines and connection limits; shutdown destroys pending raw sockets. Sidecar listeners bind only the allocator-selected internal address and accept only the bundle subnet. The runtime must report the planned address before the agent starts. There is no plaintext or verification-disabled fallback on the shared external bridge.

Desktop PTYs use Docker native interactive exec through the existing filtered host-terminal relay. No sidecar PTY listener or host-published PTY port is created. Abort detaches the host PTY within a bounded interval. Ordinary Linux UDS and Apple runtime selection are unchanged.

Dependency provisioning receives only the authenticated package proxy URL, through private environment delivery. It receives neither the MCP token nor an MCP health probe. Authenticated apt configuration is written as a private host file. New agent images include the common bridge, so rebuild the base and selected agents; older workflow snapshots with another build identity start fresh while retaining their workspace.

Flattened snapshot imports omit live MCP and proxy-admission environment values; resume restages current bundle credentials. This is a targeted transient-value exclusion, not a scrub of arbitrary image environment or filesystem contents. The explicitly enabled legacy `PROXY_TCP_PORT` relay now requires a valid token before backend setup and binds only loopback; supported launchers do not select that mode. Internal admission/configuration variables are reserved from backend inheritance.

Qualification uses source review, bounded mock admission tests, and isolated positive transport fixtures. Linux Docker proves the tested TLS, native exec and stopped-network-attachment contracts; actual macOS Desktop and live agent/provider behavior still need platform qualification. No boundary-bypass or packet-interception demonstration was run.

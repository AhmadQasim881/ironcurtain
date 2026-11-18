# Sandboxing Architecture

IronCurtain uses defense-in-depth to contain untrusted AI agents. No single layer is assumed to be sufficient -- each layer catches what the others miss. This document describes how the layers work together and names the module that implements each of them. What the layers do **not** stop is listed in [docs/SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md).

_Last verified against code: 2026-11-14, at commit `1471366e`._

## Two Session Modes

IronCurtain supports two session modes that share the same policy engine but differ in how the agent runs:

- **Builtin Agent (Code Mode)** - IronCurtain's own LLM agent writes TypeScript snippets that execute in a V8 sandbox. The agent has no direct system access; every interaction goes through MCP tool calls that are policy-checked. IronCurtain controls the agent, the sandbox, and the policy engine.

- **Docker Agent Mode** - An external agent (Claude Code, Codex, Goose) runs inside a container with no network of its own (`--network none` on Linux Docker and Apple `container`; an `--internal` network behind a two-port sidecar on macOS Docker Desktop). The agent has its own LLM loop and tool-calling mechanism - IronCurtain doesn't control the agent's execution. Instead, IronCurtain mediates the agent's external access: LLM API calls and every other network request go through a MITM proxy, and MCP tool calls go through the same policy engine used by Code Mode.

The layers below apply differently depending on the session mode. Layers 1 and 2 are Docker Agent Mode only. Layer 3 applies to both modes. Layer 4 applies to MCP servers in both modes.

### Builtin Agent (Code Mode)

```
┌─────────────────────────────────────────────┐
│              Agent (LLM)                    │
│  Generates TypeScript to accomplish tasks   │
└──────────────────┬──────────────────────────┘
                   │ TypeScript code
                   ▼
┌─────────────────────────────────────────────┐
│         V8 Isolated Sandbox                 │
│  Code executes in isolation.                │
│  Only interface to the world: typed         │
│  function stubs that produce MCP requests.  │
│                                             │
│  filesystem.read_file({path: '...'})        │
│  git.git_status({path: '...'})              │
└──────────────────┬──────────────────────────┘
                   │ MCP tool-call requests
                   ▼
┌─────────────────────────────────────────────┐
│     Trusted Process (MCP Proxy)             │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │  Policy Engine                        │  │
│  │  1. Structural invariants (hardcoded) │  │
│  │  2. Compiled constitution rules       │  │
│  │  → allow / deny / escalate            │  │
│  └───────────────────────────────────────┘  │
│  ┌──────────────┐  ┌─────────────────────┐  │
│  │  Audit Log   │  │ Escalation Handler  │  │
│  │  (JSONL)     │  │ (human approval)    │  │
│  └──────────────┘  └─────────────────────┘  │
└──────────────────┬──────────────────────────┘
                   │ approved calls only
                   ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│Filesystem│ │   Git    │ │  Other   │
│MCP Server│ │MCP Server│ │MCP Server│
└──────────┘ └──────────┘ └──────────┘
```

**Four layers, strict trust boundaries:**

1. **Agent** -- An LLM (Claude, GPT, Gemini) that writes TypeScript to accomplish user tasks. It has no direct access to the system.
2. **Sandbox** -- A fresh V8 isolate per script (isolated-vm, `src/sandbox/code-mode-chain.ts`) that executes the agent's TypeScript under host-enforced memory, console and concurrency limits (`src/sandbox/chain-limits.ts`). The only way to interact with the outside world is through typed function stubs that produce structured MCP requests.
3. **Trusted Process** -- The security kernel (`src/trusted-process/`). Every MCP request from the sandbox passes through a two-phase policy engine before reaching any real server. Structural checks enforce hardcoded invariants (protected paths, unknown tool denial). Compiled rule evaluation evaluates the compiled constitution rules. Denied calls are blocked; escalated calls are presented to the user for approval.
4. **MCP Servers** -- Standard [Model Context Protocol](https://modelcontextprotocol.io/) servers that provide filesystem access, git operations, and other capabilities. Only approved requests reach them.

### Docker Agent Mode

```
┌──────────────────────────────────────────────┐
│     Container (no network of its own)        │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │         External Agent                 │  │
│  │    (Claude Code, Codex, Goose)         │  │
│  │    Own LLM loop, tools, execution      │  │
│  └──────┬──────────────────┬──────────────┘  │
│         │ HTTP(S) traffic  │ MCP tool calls  │
│         ▼                  ▼                 │
│      [UDS]              [UDS]                │
└─────────┬──────────────────┬─────────────────┘
          │                  │
          ▼                  ▼
┌──────────────────┐  ┌─────────────────────────┐
│  MITM Proxy      │  │  MCP Proxy              │
│  (host process)  │  │  (host process)         │
│                  │  │                         │
│  Host allowlist  │  │  Policy Engine          │
│  Endpoint filter │  │  allow / deny /         │
│  Fake→real key   │  │  escalate               │
│  Budget gate     │  │                         │
│  Registry proxy  │  │                         │
└────────┬─────────┘  └────────────┬────────────┘
         │                         │
         ▼                         ▼
   LLM providers,           MCP Servers
   package registries,      (filesystem, git, etc.)
   approved hosts
```

IronCurtain does **not** control the agent's execution in Docker mode. The agent has its own tool-calling mechanism; IronCurtain only sees the external effects — network requests and MCP tool calls — and enforces policy on those boundaries. What the agent does to the files mounted into its container is not mediated (see Layer 1).

## The Threat Model

The AI agent is **untrusted**. It may be compromised via prompt injection, multi-turn drift, or adversarial inputs from external sources (emails, web pages, code). IronCurtain assumes the worst and enforces security boundaries that the agent cannot bypass regardless of its intent. [docs/SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md) §0 lists the trust boundaries and what is not enforced.

## Four Layers of Defense

```
┌──────────────────────────────────────────────────────────┐
│  Layer 1: Container (no network of its own)              │
│  Process isolation, filesystem isolation                 │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Layer 2: TLS-Terminating MITM Proxy               │  │
│  │  API key protection, endpoint filtering,           │  │
│  │  budget gate, registry proxy, egress decisions     │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Layer 3: MCP Policy Engine                        │  │
│  │  Per-tool-call allow/deny/escalate decisions        │  │
│  │  Compiled from human-readable constitution          │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Layer 4: OS-Level Sandbox (bubblewrap/srt)        │  │
│  │  Per-MCP-server filesystem and network isolation    │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Layer 1: Container _(Docker Agent Mode only)_

The agent process runs inside a container (`buildAgentContainerConfig` in `src/docker/docker-infrastructure.ts`, create flags in `src/docker/docker-manager.ts`). The container isolates processes and the filesystem, but it does **not** make the agent unprivileged:

- **No network of its own** -- On Linux Docker the container runs with `--network none`: no network interface besides loopback. The only way out is through two bind-mounted Unix domain sockets: the MCP proxy (tool calls) and the MITM proxy (all HTTP and HTTPS traffic). macOS and nested Docker differ; see below.
- **Capabilities** -- `--cap-drop=ALL`, then SETUID, SETGID, CHOWN, FOWNER, DAC_OVERRIDE, AUDIT_WRITE are added back (`AGENT_SUDO_CAPABILITIES` in `src/docker/agent-privileges.ts`), so that `sudo apt-get install` works through the registry proxy.
- **Passwordless sudo** -- The agent images grant the `codespace` user `NOPASSWD:ALL` (`docker/Dockerfile.base.arm64`; the x86 base inherits it from the devcontainers universal image). The agent can become root inside its container at any time.
- **Start user** -- On Linux Docker the container starts as `0:0`; `docker/entrypoint-uid-remap.sh` renumbers `codespace` to the host user's UID and GID and then drops to it. IronCurtain refuses to run Linux Docker agent mode as host root (`src/docker/container-identity.ts`).
- **Container root can be host root** -- On native Linux Docker without rootless mode or userns-remap, container UID 0 is host UID 0 on every bind mount, so a compromised agent can leave root-owned or setuid files in your workspace. IronCurtain warns once per bundle, `ironcurtain doctor` reports the daemon's mode, and the read-write host mounts are scanned after each turn and at session end: setuid and setgid bits are stripped from your files, and root-owned entries are reported for removal (`src/docker/host-mount-privilege-scan.ts`).
- **Opt-in: no sudo** -- `"agentSudo": false` in `~/.ironcurtain/config.json` starts the container as the image's numeric agent UID with no added capabilities and `--security-opt no-new-privileges:true` (`src/docker/agent-privileges.ts`). apt and the system trust store are then unavailable. It needs the Docker runtime, IronCurtain running as UID 1000 on Linux, and nested Docker off.
- **Mounts** -- Read-write: the workspace (`/workspace`; read-only for read-only workflow states), the proxy sockets (`/run/ironcurtain`), the agent CLI's conversation state (`~/.claude/`, `~/.codex/` or Goose's sessions directory), in workflows the run's dependency layers (`/opt/workflow-venv`, `/opt/workflow-node_modules`), and for nested Docker on Apple `container` its egress sockets. Read-only: `/etc/ironcurtain` (orientation files and the public session CA), the apt proxy configuration, staged skills and scripts. The agent changes the read-write mounts directly; nothing there passes through the policy engine.
- **Resource limits** -- 8192 MB of memory without swap, 4 CPUs and 4096 PIDs by default (`dockerResources` in `~/.ironcurtain/config.json`; null disables a limit, and memory and CPUs are clamped to the host), plus `--ulimit nofile=65536`.

#### macOS: Sidecar-Based Network Isolation (Docker Desktop)

On macOS, Docker Desktop's VirtioFS does not support Unix domain sockets in bind mounts. IronCurtain falls back to TCP transport: the MCP and MITM proxies listen on TCP ports on the host's loopback interface (`127.0.0.1`).

To keep network isolation equivalent to Linux's `--network none`, IronCurtain uses a socat sidecar container (`src/docker/transport-sidecar-image.ts`):

1. The agent container runs on a Docker `--internal` bridge network with no default route — no internet egress is possible.
2. A sidecar connects to both the default `bridge` network (host-reachable) and the `--internal` network. It forwards only the two proxy ports (MCP and MITM). Its image is built locally from `docker/transport-sidecar/Dockerfile` and run by immutable image ID, read-only, as `nobody`, with every capability dropped and `no-new-privileges`, limited to 64 MB, 0.25 CPU, 64 PIDs and 256 open files.
3. The agent container resolves `host.docker.internal` to the sidecar's IP on the internal network, so proxy traffic routes through the sidecar while all other connectivity is blocked.

The agent cannot reach the host gateway or any host service directly — it can only reach the two proxy ports forwarded by the sidecar. If the connectivity check fails at startup, IronCurtain aborts session initialization rather than falling back to a less secure network configuration.

#### macOS: Apple `container` Backend (VM per Container)

On macOS 26+ (Apple silicon), IronCurtain can run the agent under [Apple `container`](https://github.com/apple/container) instead of Docker — selected by the `containerRuntime` config field (`auto`, the default, prefers it when its services are available) or `IRONCURTAIN_CONTAINER_RUNTIME`. Each container is a dedicated lightweight VM, upgrading Layer 1 from shared-kernel namespaces to a hardware-virtualization boundary. IronCurtain requires `container` 1.2.1 or later (`src/docker/apple-container-manager.ts`).

Apple `container` uses the same `uds` topology as Linux Docker (`resolveNetworkTopology` in `src/docker/network-topology.ts`):

1. The VM is created with `--network none`: it has only a loopback interface, so internet egress fails at the network layer.
2. Each proxy socket file (not its directory) is mounted with `-v`; the runtime creates a vsock relay per socket. The sockets are mode 0666 inside a 0700 host directory, because the relay carries the host mode bits into the VM, where the owner is root.
3. No sidecar and no host listener on a network interface is involved.

Inside the VM the container has the same capabilities and sudo as on Docker; `agentSudo: false` is not available there. When nested Docker is enabled, the agent container of that session runs with a fully visible `/proc` (`APPLE_FULLY_VISIBLE_PROC_ARGS`), which the nested daemon needs. The host-only vmnet topology with `0.0.0.0` listeners (`tcp-hostonly`) that earlier releases used is retained in the code but not selected. See [docs/designs/apple-container-runtime.md](docs/designs/apple-container-runtime.md) for the design history.

#### Nested Docker (opt-in)

With `dockerWorkload.enabled`, a session also gets a private Docker daemon, which needs kernel features ordinary agent containers never get (user namespaces, a widened seccomp profile, unmasked `/proc`). It also adds egress that an ordinary session does not have, through dedicated host proxies (`src/docker/registry-egress-proxy.ts`, `src/docker/package-egress-proxy.ts`): with `networkAccess` `images` (the default when the field is unset) the daemon pulls images from Docker Hub and GHCR; `packages` also lets any process of the session download from the fixed public apt, npm, PyPI and Cargo repositories, a route that can also carry bounded data out; `offline` adds no egress. On Docker Desktop every session's daemon shares the one Docker Desktop VM and kernel, and online nested sessions attach the agent to an isolated relay network (on WSL2 in place of `--network none`); on Apple `container` the daemon runs in the session's own VM, which keeps `--network none` and reaches the registries through mounted sockets. The accepted risks per backend are in [docs/SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md) §2d; configuration is in [CONFIG.md](CONFIG.md#nested-docker-workloads).

### Layer 2: TLS-Terminating MITM Proxy _(Docker Agent Mode only)_

The agent needs to call its LLM provider's API (e.g., Anthropic's `/v1/messages`). Since the container has no network, these requests — and every other HTTP or HTTPS request the agent makes — go through a MITM proxy running on the host (`src/docker/mitm-proxy.ts`).

**API key protection:** Real API keys and OAuth tokens never enter the container. The agent receives a randomly generated fake sentinel key. The MITM proxy swaps the sentinel for the real credential before forwarding upstream (`src/docker/provider-credentials.ts`). Even if the agent is fully compromised, it cannot exfiltrate the real key because it never has access to it.

**How it works:**

1. IronCurtain keeps a self-signed CA on the host (`src/docker/ca.ts`; the private key never leaves the host). The public certificate is mounted read-only into the container and installed into its trust store by the entrypoint at startup (`docker/entrypoint-uid-remap.sh`); the image itself carries no CA.
2. The proxy listens on a Unix domain socket, bind-mounted into the container. Inside the container, `socat` bridges `127.0.0.1:18080` to the socket so that standard `HTTPS_PROXY` environment variables work.
3. When the agent makes an HTTPS request to a provider, the proxy:
   - Checks the target hostname against the provider allowlist (e.g., only `api.anthropic.com`)
   - Terminates TLS using a certificate for exactly that host, signed by the IronCurtain CA
   - Validates the HTTP method and path against the endpoint allowlist (e.g., only `POST /v1/messages`)
   - Removes every credential carrier, swaps the sentinel for the real credential, and answers any other credential with a local 401
   - Strips provider-hosted tools (web search, web fetch, code execution, connectors) from completion requests (`src/docker/request-sanitizers/`)
   - Admits the request against the bundle's token and cost budget (`src/docker/budget-gate.ts`)
   - Forwards the request upstream and streams the response back, without `Set-Cookie` or hop-by-hop headers

**Budget gate:** Every completion request is admitted against `resourceBudget.maxTotalTokens` and `maxEstimatedCostUsd` for the whole bundle before it is forwarded. Batch and workflow bundles forward completions only while the host runs an agent turn; PTY sessions get one session-long allowance. The per-turn wall clock (`maxSessionSeconds`) is enforced inside the container (`src/docker/turn-timeout.ts`). See [docs/SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md) §9.

**Dynamic domain management:** The agent can request access to additional internet domains at runtime via `add_proxy_domain` / `remove_proxy_domain` / `list_proxy_domains` MCP tools (`src/docker/proxy-tools.ts`). Adding a domain always requires a human's approval: the escalation is human-only, so neither the auto-approver, nor an `/approve+` whitelist, nor "approve all" can approve it. Removing one is auto-allowed since it reduces the attack surface. An approval covers one host on one port (443 by default, or 80). Approved hosts get a **passthrough tunnel**: TLS is **not** terminated, so the traffic is not inspected, and no credential replacement or endpoint filtering is applied. The proxy only checks that a 443 tunnel's TLS ClientHello names the approved host (SNI), re-originates port-80 requests to the approved host, refuses private, loopback, link-local and metadata destinations, and closes a raw tunnel idle for 10 minutes and a port-80 tunnel idle for 15 minutes.

**Opt-in policy-evaluated egress:** With `egressPolicy.enabled` in `~/.ironcurtain/config.json`, every destination that is not a provider or a registry is decided by the session's policy as a `network/request` call: hosts listed in `egressPolicy.allowedHosts` (`*`, `*.example.com`, exact names) are allowed, every other one is escalated to a human once per host and port, only ports 443 and 80 are admitted, and every decision is audited (`src/trusted-process/egress-policy.ts`, [docs/designs/mitm-egress-policy.md](docs/designs/mitm-egress-policy.md)). This is the replacement for the escape hatch below, and the way to give workflows that fetch from many hosts a reviewed allowlist.

**Deprecated escape hatch -- `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS`:** Setting `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS=1` (or `=true`) on the host process makes the MITM proxy tunnel any **unknown** host, on any port, with egress filtering disabled. The flag applies to HTTPS CONNECT, plain-HTTP proxy requests and `ws://` upgrades. Configured providers and registries are _never_ widened by this flag -- they keep their dedicated MITM and registry paths. Non-public IP literals and local or metadata names are still refused. The proxy prints a deprecation warning at every start, and the flag is ignored while `egressPolicy.enabled` is on. **Only use in trusted environments.**

**Package installation proxy:** The MITM proxy doubles as a read-only registry proxy for npm, PyPI, Debian APT and crates.io (`src/docker/registry-proxy.ts`):

- Only bodiless GET and HEAD requests on a per-host route allowlist are forwarded (`src/docker/registry-request-gate.ts`, `classifyRegistryRoute`). Publishing, dist-tag changes, yanks, logins and `npm audit` get a 403, so agents cannot publish to npm, crates.io or PyPI or use registry accounts from inside a session; `npm audit`, `npm whoami` and `npm audit signatures` fail. Containers set `NPM_CONFIG_AUDIT=false` and `NPM_CONFIG_FUND=false`.
- Client credentials (`Authorization`, `Cookie`, `npm-*` and every header outside a content-negotiation, caching and range allowlist) are stripped.
- Request paths must have one reading (no segment that starts with a dot, no backslashes, no percent-encoded dots, backslashes, percent signs or delimiters, no non-ASCII characters), and the denylist matches decoded package names, so entries like `g++-12` work as written. PyPI names are compared in their PEP 503 form, so a PyPI entry must be written that way (`typing-extensions`, not `typing_extensions`).
- Packages are validated against allowlists, denylists and a quarantine age gate (default: 2 days, `packageInstall.quarantineDays`) that blocks newly published versions; PyPI is gated per distribution file. Debian `.deb` packages are exempt from the age gate (only the allow and deny lists apply). npm per-version manifest URLs, `apt-get source`, `.udeb` downloads and apt pdiffs are not served.
- Every forwarded or refused request is written to `package-audit.jsonl` in the session directory. See [docs/designs/package-installation-proxy.md](docs/designs/package-installation-proxy.md) for the design.

**What this blocks:**

- Requests to non-allowlisted hosts (403 at CONNECT), unless a human approved the host or egress policy allows it
- Requests to non-allowlisted endpoints on provider and registry hosts (403 at HTTP layer)
- Requests with a wrong, missing or foreign credential (401, answered locally)
- Any attempt to extract the real API key (it exists only in host process memory)
- Completion requests past the token or cost budget
- Registry writes, and installation of denied or too-recently-published packages

### Layer 3: MCP Policy Engine _(both modes)_

All external operations beyond the network traffic Layer 2 handles -- filesystem access, git operations, network fetch, etc. -- go through MCP (Model Context Protocol) tool calls. Every tool call passes through a policy engine before reaching the real MCP server (`src/trusted-process/policy-engine.ts`, `src/trusted-process/tool-call-pipeline.ts`).

The policy is compiled from a human-readable **constitution** -- a short document describing what the agent is and isn't allowed to do. The compilation pipeline translates English intent into deterministic JSON rules that are enforced without further LLM involvement at runtime.

Policy decisions are:

- **Allow** -- The tool call proceeds.
- **Deny** -- The tool call is blocked (default when no rule matches).
- **Escalate** -- The user is prompted for approval before proceeding.

Structural invariants are enforced regardless of compiled rules: protected paths (including the host credential stores) are always denied, unknown tools are always denied, fetches of local names (`localhost`, `*.local`, `*.internal` and similar) and of cloud-metadata names and addresses are denied, and path traversal and symlink escapes are neutralized by resolving to canonical real paths before comparison. Every argument of a call must be classified by the tool's stored annotation -- calls with unannotated argument keys are denied outright, preventing schema-smuggling attacks -- and arguments are also validated against the tool's input schema.

Policy rules can reference **dynamic lists** -- named collections of domains, emails, or identifiers that are resolved at compile time (from LLM knowledge or MCP server queries) and expanded at runtime. This allows rules like "allow sending email to known team members" without hardcoding values in the constitution.

When a user approves an escalated tool call with `/approve+`, the **approval whitelist** auto-approves later calls in the same session that match the approved resources exactly (`src/trusted-process/approval-whitelist.ts`). A directory-wide pattern is an explicit second choice and is never offered for the home directory, its ancestors or credential directories. Whitelisted patterns can only convert `escalate` to `allow`, never override `deny`.

Opt-in additions to Layer 3: task-scoped policies (`--task-scoped`), taint escalation (`taintEscalation`), outbound content assessment (`contentAssessment`) and the LLM auto-approver (`autoApprove`). See [docs/SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md) §4–§6.

See the [README](README.md) for details on the policy compilation pipeline.

### Layer 4: OS-Level Sandbox (bubblewrap/srt) _(both modes)_

MCP server processes themselves can be sandboxed using `@anthropic-ai/sandbox-runtime` (`srt`): bubblewrap on Linux, Seatbelt on macOS (`src/trusted-process/sandbox-integration.ts`). Each sandboxed MCP server runs in its own `srt` process with independent:

- **Filesystem restrictions** -- Write access limited to the session sandbox directory. Reads of the IronCurtain home, the relays' per-user scratch root (`<os.tmpdir()>/ironcurtain-<uid>`, which holds relay settings, server working directories and OAuth credential files) and the host credential stores (SSH private keys at their default names `~/.ssh/id_*`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.kube/config`, `~/.config/gh`, `~/.git-credentials`, `~/.docker/config.json`, `~/.npmrc`, the Claude and Codex credential files; of the stores the policy engine protects, only `~/.netrc` and the rest of `~/.ssh` are left out), the shell startup files where API keys are often exported (`~/.bashrc`, `~/.bash_profile`, `~/.bash_login`, `~/.profile`, `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, `~/.config/fish`) and a `.env` left in IronCurtain's package root are denied for every server. Inside the IronCurtain home and the scratch root a server gets back only the session sandbox and its own working and credential directories; a credential store or startup file is re-opened only for a server whose `allowRead` names that exact entry. On macOS, where srt blocks Unix sockets except those a profile names, only the git server's profile names the ssh-agent socket.
- **Network isolation** -- Per-server network proxy infrastructure. Servers that don't need network access get none.
- **Process isolation** -- Linux namespaces via bubblewrap.

Not every server is sandboxed. The shipped servers (`src/config/mcp-servers.json`):

| Server             | OS sandbox                                                         | Notes                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filesystem`       | yes: confined to its MCP roots, no network                         | Home, temporary and runtime directories hidden; restarted when its roots change (`src/trusted-process/roots-confinement.ts`)                                                         |
| `git`              | yes: network limited to github.com and gitlab.com (and subdomains) | Hardened git environment (`src/trusted-process/git-backend-env.ts`); SSH keys at their default names (`~/.ssh/id_*`) are hidden, so SSH uses ssh-agent unless a key has another name |
| `fetch`            | no (`sandbox: false`): runs on the host                            | Its own connect-time destination guard refuses private and metadata addresses (`src/servers/guarded-fetch.ts`)                                                                       |
| `github`           | no (`sandbox: false`): runs in Docker                              | Image pinned by digest; the container gets only `GITHUB_PERSONAL_ACCESS_TOKEN` from the host environment                                                                             |
| `google-workspace` | yes: network limited to Google APIs and the npm registry           | Gets an access-token file without the refresh token (`src/trusted-process/gworkspace-credentials.ts`)                                                                                |
| `memory`           | no (`sandbox: false`): runs on the host                            | IronCurtain's own memory server, added for persona and job sessions (`src/memory/memory-annotations.ts`)                                                                             |

`sandboxPolicy` decides what happens when the OS sandbox is unavailable (bubblewrap, socat or ripgrep missing, an unsupported platform, or srt unable to start a sandbox on this host, such as one that restricts user namespaces with AppArmor): `"enforce"`, the default on Linux and macOS, refuses to start a server that asks for a sandbox, while other servers keep running; `"warn"` starts it unconfined with a visible warning (`src/config/sandbox-policy.ts`). Whether srt can start a sandbox is checked with one srt test run per process (`resolveOsSandboxAvailability` in `src/trusted-process/sandbox-integration.ts`), and the session hands its verdict to every relay, so they plan alike. Relays and servers inherit only an allowlisted environment, never the host's (`src/trusted-process/child-env.ts`).

The servers `annotate-tools`, `compile-policy` (its live-schema drift check) and `ironcurtain mcp add` start to list their tools are launched as their relays launch them (`src/trusted-process/tool-listing-launch.ts`, shared with `ironcurtain doctor`): under srt when they ask for it, refused or unconfined as `sandboxPolicy` says, with their stored credentials, and the filesystem server against an empty temporary directory. The google-workspace server is not started there: sessions give it an OAuth access token that a tool listing does not create.

This layer catches threats that the policy engine cannot see: compromised MCP servers, indirect code execution through tool calls, and side-channel attacks from within server processes. For MCP servers that need OAuth credentials (e.g., Google Workspace), IronCurtain writes credential files into the relay's private scratch directory and proactively refreshes them before expiry -- the MCP server never holds a refresh token and cannot independently obtain new credentials (`src/trusted-process/token-file-refresher.ts`).

See [docs/designs/execution-containment.md](docs/designs/execution-containment.md) for the full design specification.

## How the Layers Interact

Each layer addresses a different class of threat:

| Threat                            |   Layer 1 (Container)   |            Layer 2 (MITM)            |       Layer 3 (Policy)       |         Layer 4 (srt)          |
| --------------------------------- | :---------------------: | :----------------------------------: | :--------------------------: | :----------------------------: |
| Network exfiltration              |         Blocked         |  Filtered (passthrough uninspected)  |         Not covered          | Restricted (sandboxed servers) |
| API key theft                     |       Not covered       |              Prevented               |         Not covered          |          Not covered           |
| Unauthorized file access          | Contained (mounts only) |             Not covered              |           Blocked            | Contained (sandboxed servers)  |
| Unauthorized git operations       |       Not covered       |             Not covered              |      Blocked/Escalated       |          Not covered           |
| Compromised MCP server            |       Not covered       |             Not covered              |         Not covered          | Contained (sandboxed servers)  |
| Prompt injection → bad tool calls |       Not covered       |             Not covered              |      Blocked/Escalated       |          Not covered           |
| Malicious package install         |       Not covered       | Read-only proxy, age gate, deny list |         Not covered          |          Not covered           |
| Excessive API spending            |       Not covered       |        Token and cost budget         | Per-turn budgets (Code Mode) |          Not covered           |

No single layer handles everything. A prompt-injected agent might try to exfiltrate data via an API call, but Layer 2 blocks non-allowlisted endpoints. It might try to read sensitive files, but Layer 3 enforces the policy. It might try to exploit an MCP server, but Layer 4 contains the blast radius of the sandboxed ones.

## Design Documents

- [Docker Agent Broker](docs/designs/docker-agent-broker.md) -- Full design for the Docker container + MITM proxy architecture
- [TLS-Terminating API Proxy](docs/designs/tls-terminating-api-proxy.md) -- Detailed MITM proxy design
- [MITM Egress Policy](docs/designs/mitm-egress-policy.md) -- Policy-evaluated egress for passthrough destinations
- [Package Installation Proxy](docs/designs/package-installation-proxy.md) -- Registry proxy for npm/PyPI/APT with age gate
- [Google Workspace Integration](docs/designs/google-workspace-integration.md) -- OAuth credential management for Google MCP servers
- [Execution Containment](docs/designs/execution-containment.md) -- OS-level sandboxing via bubblewrap/srt
- [Filesystem Server Confinement](docs/designs/filesystem-server-confinement.md) -- Confining the filesystem server to its MCP roots
- [Apple `container` Runtime](docs/designs/apple-container-runtime.md) -- VM-per-container backend for macOS (implemented)
- [Security Concerns](docs/SECURITY_CONCERNS.md) -- Known threats, attack vectors, and residual risks

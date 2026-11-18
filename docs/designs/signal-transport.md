# Signal Messaging Transport Design

**Status (2026-11-16):** Partial — the authenticated Signal bridge, shared host client and private credential lifecycle are implemented (`src/signal/`, `docker/signal-bridge/`). Actual macOS Docker Desktop/Apple runtime and live Signal account qualification remain separate owner work. The current contract below supersedes the historical design record. An approval must name the code shown in its escalation banner (`approve <code>`).

**Date:** 2026-02-24
**Author:** Feature Architect

## Current transport contract

The authoritative shipped contract is TLS plus bearer admission on every HTTP route and WebSocket upgrade. The derived router authenticates before Gin route logging, including health, OPTIONS, unknown routes and receive upgrades; redirects are disabled. Its internal JSON-RPC daemon and client use container loopback only. An unmodified upstream image is refused. A contract label is a compatibility declaration by an already trusted image publisher, not proof that a malicious image implements the contract.

`src/signal/signal-bridge-client.ts` is the shared host client for setup, registration/linking, health, identity checks, send and receive. It accepts only a loopback HTTPS origin, explicitly trusts the private certificate, verifies server name `localhost`, supplies the bearer header and refuses redirects or plaintext fallback. WebSocket receive uses WSS with the same trust and admission. Secret values are never passed through Docker arguments, environment values, images or URL query strings.

`loadOrCreateSignalBridgeCredentials()` keeps one exact-schema JSON bundle at `$IRONCURTAIN_HOME/oauth/signal-bridge/credentials.json` (default `~/.ironcurtain/oauth/signal-bridge/credentials.json`): `version: 1`, a random 64-hex token, the self-signed server certificate and its private key. The directory is 0700 and the file 0600, owned by the current user. The reader refuses links, foreign ownership, insecure modes, oversized files and corrupt schema/certificate/key data. Reads and renewal share a file lock; publication uses an atomic private write. RSA-2048/SHA-256 server certificates name both `localhost` and `127.0.0.1`. An expired certificate or one with less than one day remaining renews atomically. A SHA-256 fingerprint of the exact bundle bytes binds container reuse to those credentials. The bundle is mounted read-only.

The default `SIGNAL_DEFAULT_IMAGE` is local `ironcurtain-signal-bridge:0.101-auth1`. Build it explicitly with `npm run build:signal-bridge`; it is not published or pullable and is never automatically pulled. The [recipe](../../docker/signal-bridge/README.md) pins official 0.101 source commit `74253a3a41c2cade40fd4a53cf3fb7a3fdf305dc`, verifies the 35-file source manifest before patching, pins runtime and Go 1.26.11 builder digests, and compiles the API and authentication plugin together. With no `--source-dir`, the build command downloads only the pinned manifest URLs and checks SHA-256; `--source-dir=/absolute/verified/context` uses an existing context. Docker can still download pinned base images and Go dependencies. Every accepted image must carry `org.ironcurtain.signal-bridge-auth=1`. For the local default `setup-signal --update-image` prints rebuild guidance; a compatible published custom image can be pulled, contract-checked and digest-pinned after confirmation. Configured tags are used only as already cached locally.

Before reuse, the manager validates owner and exact data mount, immutable image ID, entrypoint, network/ports, mounts, credentials fingerprint and runtime security profile. Foreign-owned or mismatched-data containers are refused untouched. An owned legacy container lacking authentication contract `1` is stopped and removed by its inspected immutable ID before resolving a replacement image; a rejected or unavailable image therefore cannot leave that listener running. An already authenticated owned container may remain protected if a replacement is unavailable. The default name is shared across installations, so a collision with another home is refused rather than taken over. Linux uses the host numeric UID/GID and does not recursively chown data or credentials.

The runtime retains `--cap-drop=ALL`, then CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID and KILL are added back for its entrypoint, with `no-new-privileges`. Restart policy is none as built (the bot or daemon starts it). Setup can restart it to load an account; the manager recreates an owned container when its authenticated profile, credentials, image or data-mount freshness changes. The bridge still holds the bot keys and is trusted for inbound messages and identity answers; Docker administrators and the owner remain trusted principals. Local synthetic validation does not qualify actual macOS Docker Desktop/Apple runtimes or a live Signal account.

See [TRANSPORT.md](../../TRANSPORT.md) for current setup and update instructions.

## Historical design record

The numbered sections below preserve the earlier design, sample transcripts and pseudocode. Plain HTTP/WebSocket examples, generic upstream images and the old unrecorded default-digest workflow describe the pre-authentication design and are historical, not current implementation instructions. The current contract above and the linked user guide are authoritative for transport, credentials, image admission and migration.
## 1. Overview

This document specifies a Signal messaging transport for IronCurtain, enabling users to interact with agent sessions from any device running the Signal app. The transport implements the existing `Transport` interface (`src/session/transport.ts`) and communicates with Signal's servers through a locally-managed `signal-cli-rest-api` Docker container.

No other agent framework offers Signal as a transport. This is a deliberate differentiator -- IronCurtain is a security-first runtime, and Signal is the messaging platform with the strongest privacy guarantees (full E2E encryption, no metadata collection, open-source protocol). Choosing Signal over more convenient alternatives like Telegram or Discord sends a clear message about IronCurtain's security posture.

### CLI Integration: `ironcurtain bot`

The Signal transport runs as a long-lived process via `ironcurtain bot`. Unlike `ironcurtain start "task"` which runs a single task and exits, `ironcurtain bot` starts the `SignalBotDaemon` and waits for messages indefinitely. 

Each incoming Signal message is routed by the Daemon:
- If no session exists, it creates a new `Session` and a corresponding `SignalSessionTransport`.
- If a session is active, it routes the message to it.
- If the user sends a control command (like `/quit` or `/new`), the Daemon closes the current session but continues running.

This decoupled execution model ensures the bot stays online:
- **SignalBotDaemon**: Persistent process, owns the WebSocket, manages session lifecycle.
- **SignalSessionTransport**: Ephemeral adapter, 1:1 with a `Session`.

The `ironcurtain bot` subcommand:
1. Loads Signal config from `~/.ironcurtain/config.json`.
2. Ensures the signal-cli container is running.
3. Starts the `SignalBotDaemon` and enters the message loop.
4. Handles SIGTERM/SIGINT for graceful shutdown (closes active session, sends goodbye).

### Implementation Areas

1. **Docker container management** -- lifecycle for the signal-cli-rest-api container with persistent data volumes.
2. **Interactive onboarding** -- `ironcurtain setup-signal` command for registration or device linking.
3. **SignalBotDaemon class** -- manages the WebSocket connection, identity verification, and session multiplexing.
4. **SignalSessionTransport class** -- implements `Transport` for a single session, proxying to the Daemon.
5. **Markdown-to-Signal converter** -- transforms Markdown agent output into Signal's styled text markup.
6. **Bot subcommand** -- `ironcurtain bot` entry point with signal handling and daemon lifecycle.

## 2. Architecture

### Component Diagram

```
                        Signal App (phone/desktop)
                                |
                         Signal Servers
                                |
                                | (Signal Protocol, E2EE)
                                |
┌───────────────────────────────────────────────────────────┐
│  Host Machine                                             │
│                                                           │
│  ┌─────────────────────┐    ┌──────────────────────────┐  │
│  │  IronCurtain         │    │  signal-cli-rest-api     │  │
│  │  Process              │    │  (Docker container)      │  │
│  │                       │    │                          │  │
│  │  ┌─────────────────┐ │    │  REST API (:8080)        │  │
│  │  │ SignalBotDaemon │─┼──>│    POST /v2/send         │  │
│  │  │  (HTTP + WS)     │ │    │    POST /v1/register/... │  │
│  │  └────────┬─────────┘ │<┼────│  WebSocket               │  │
│  │           │           │    │    /v1/receive/{number}  │  │
│  │  ┌────────v─────────┐ │    │                          │  │
│  │  │ SignalSessionTr. │ │    │  signal-cli (Java/JVM)   │  │
│  │  │  (Adapter)       │ │    │  ~200-400MB RAM           │  │
│  │  └────────┬─────────┘ │    └────────────┬─────────────┘  │
│  │           │           │                 │                │
│  │  ┌────────v─────────┐ │    ┌────────────v─────────────┐  │
│  │  │ Session          │ │    │  ~/.ironcurtain/          │  │
│  │  │  .sendMessage()  │ │    │    signal-data/           │  │
│  │  │  .resolveEsc..() │ │    │    (host-mounted volume)  │  │
│  │  └──────────────────┘ │    └──────────────────────────┘  │
│                          │                                │
└───────────────────────────────────────────────────────────┘
```

### Data Flow

**Incoming message (user sends Signal message to bot):**

```
User Signal App
  -> Signal servers
    -> signal-cli (in Docker container)
      -> signal-cli-rest-api WebSocket
        -> SignalBotDaemon.onWebSocketMessage()
          -> Check if session exists (create if not)
          -> session.sendMessage(text)
          -> markdownToSignal(response)
            -> POST /v2/send (back through signal-cli)
              -> Signal servers -> User's Signal App
```

**Escalation flow:**

```
PolicyEngine escalates tool call -> session surfaces EscalationRequest
  -> SignalSessionTransport.onEscalation()
    -> SignalBotDaemon.surfaceEscalation(label, request)
      -> code = HMAC(per-process key, escalationId), e.g. K7Q2
      -> POST /v2/send (text_mode "normal"): header with code + instructions,
         then the arguments (retried with backoff; undeliverable -> denied)
        -> User reads, replies "approve K7Q2" or "deny K7Q2"
          -> WebSocket (or the reconnect drain) delivers reply to Daemon
            -> Daemon finds the pending escalation with that code,
               refuses replies sent before it was raised
              -> session.resolveEscalation(id, decision)
```

See "Escalation Banners and Replies" in section 5 for the rules.

## 3. Docker Container Management

### Extending DockerManager (not replacing it)

The signal-cli container needs capabilities that agent containers do not: port bindings, a restart policy, and network access. Rather than creating a parallel Docker CLI wrapper, we extend the existing `DockerContainerConfig` and `DockerManager` with optional fields. The security-critical defaults remain unchanged.

#### Changes to `DockerContainerConfig` (`src/docker/types.ts`)

```typescript
export interface DockerContainerConfig {
  // ... all existing fields unchanged ...

  /**
   * Port bindings in 'hostPort:containerPort' format.
   * Optional. Defaults to no ports exposed.
   *
   * SECURITY NOTE: Agent containers must NEVER expose ports.
   * This field exists solely for service containers (e.g., signal-cli)
   * that need to expose a local API. Only bind to 127.0.0.1 in practice
   * (e.g., '127.0.0.1:18080:8080').
   */
  readonly ports?: readonly string[];

  /**
   * Docker restart policy (e.g., 'unless-stopped', 'on-failure:3').
   * Optional. Defaults to no restart policy (container stops when stopped).
   *
   * Agent containers must NEVER set a restart policy -- they are
   * ephemeral per-session containers managed by session lifecycle.
   */
  readonly restartPolicy?: string;
}
```

#### Changes to `buildCreateArgs` (`src/docker/docker-manager.ts`)

```typescript
export function buildCreateArgs(config: DockerContainerConfig): string[] {
  const args = ['create'];

  args.push('--name', config.name);
  args.push('--network', config.network);

  if (config.network !== 'none') {
    args.push('--add-host=host.docker.internal:host-gateway');
  }

  // Security: ALWAYS drop all capabilities. This is unconditional.
  // Dropping capabilities does not prevent network access (that is
  // controlled by --network). Even service containers like signal-cli
  // work fine with no capabilities -- they only need to make outbound
  // TCP connections, which does not require CAP_NET_RAW or similar.
  args.push('--cap-drop=ALL');

  // Port bindings (service containers only)
  for (const port of config.ports ?? []) {
    args.push('-p', port);
  }

  // Restart policy (service containers only)
  if (config.restartPolicy) {
    args.push('--restart', config.restartPolicy);
  }

  // ... rest of existing implementation unchanged (labels, resources, mounts, env, image, command)
}
```

Key security properties preserved:
- `--cap-drop=ALL` remains **unconditional** -- there is no flag to disable it
- `--network` is always explicitly set by the caller -- no default that could accidentally grant access
- `ports` and `restartPolicy` default to empty/undefined (no ports exposed, no restart)
- Agent container configs simply never set these fields

#### Parameter naming: `containerId` accepts names too

The existing `DockerManager` interface uses `containerId: string` as the parameter name for `start()`, `stop()`, `remove()`, `isRunning()`, and `exec()`. The Docker CLI accepts both container IDs and names interchangeably for all these commands. The `SignalContainerManager` passes container names (e.g., `'ironcurtain-signal'`) to these methods, which works correctly.

To make the interface honest about this, rename the parameter in `DockerManager` and its implementation:

```typescript
// In types.ts -- rename containerId -> nameOrId in all methods:
start(nameOrId: string): Promise<void>;
stop(nameOrId: string): Promise<void>;
remove(nameOrId: string): Promise<void>;
isRunning(nameOrId: string): Promise<boolean>;
exec(nameOrId: string, command: readonly string[], timeoutMs?: number): Promise<DockerExecResult>;
```

This is a pure rename with no behavioral change. Existing callers that pass container IDs (returned by `create()`) continue to work. New callers can pass names.

#### New methods on `DockerManager`

```typescript
export interface DockerManager {
  // ... all existing methods unchanged ...

  /** Pull a Docker image from a registry. */
  pullImage(image: string): Promise<void>;

  /**
   * Check if a container exists (running or stopped).
   * Unlike isRunning(), returns true for stopped containers.
   */
  containerExists(nameOrId: string): Promise<boolean>;
}
```

Implementation:

```typescript
async pullImage(image: string): Promise<void> {
  await exec('docker', ['pull', image], {
    timeout: 300_000,  // 5 minutes for large images
    maxBuffer: 50 * 1024 * 1024,
  });
},

async containerExists(nameOrId: string): Promise<boolean> {
  try {
    // docker inspect succeeds for both running and stopped containers,
    // fails only when the container does not exist.
    await exec('docker', ['inspect', nameOrId], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
},
```

#### Why this is safe

The existing agent container creation code in `DockerAgentSession` sets:
```typescript
{ network: 'none', /* no ports, no restartPolicy */ }
```

Since `ports` and `restartPolicy` are optional and default to nothing, the agent code path is unchanged. There is no way for an agent container to accidentally get ports or a restart policy -- those fields must be explicitly set. The `--cap-drop=ALL` line is not behind any conditional, so it cannot be accidentally skipped.

### Container Image

The transport uses the community-maintained `bbernhard/signal-cli-rest-api` Docker image. That container holds the bot's Signal keys and is the only source of inbound messages and of the identity check, so it can forge an "approve" reply: the image is part of the approval path and is pinned by digest (`src/signal/signal-image.ts`).

- **Default.** `SIGNAL_DEFAULT_IMAGE` is `bbernhard/signal-cli-rest-api@<SIGNAL_IMAGE_PINNED_DIGEST>`, used by both `resolveSignalConfig()` and `loadUserConfig()`. While no reviewed digest is recorded in the build, `SIGNAL_IMAGE_PINNED_DIGEST` is the all-zero placeholder: the default image is then refused before any Docker call, with a message pointing at `ironcurtain setup-signal --update-image` (the setup wizard offers that step itself).
- **`signal.container.image`** accepts `<repository>@sha256:<digest>` (what `--update-image` records) or a tag. A tag is used only as already present locally, with a warning; it is never pulled or updated automatically, and a missing one is refused with the same pointer.
- **No automatic pulls.** `ensureRunning()` resolves the configured image first (`resolveSignalImage()`): a digest reference is pulled only when that image is missing locally (content-addressed, so the registry cannot hand back anything else), and the local image must carry the digest in its RepoDigests and have an immutable `sha256:` ID. If the existing container was created from another image ID (an older pin, or a tag an earlier version pulled on its own), it is removed and recreated from the resolved image ID. When the image is the same, the container is started or left running as before. Nothing else is pulled.
- **Updating.** `ironcurtain setup-signal --update-image` pulls `<repository>:<tag>` (the tag the configured image names, else `latest`), shows the registry digest, image ID and build date next to the current setting, and on confirmation records `<repository>@<digest>` as `signal.container.image` (keeping `signal.container.port`). The bot or daemon recreates the container from it on its next start. Several or no registry digests for the pulled image are refused rather than guessed. Declining changes nothing: the pull moved the local tag, and a `signal.container.image` that names that tag would run whatever it names, so a declined (or cancelled, or unpinnable) candidate puts the tag back on the image it named before, or removes it when it named none (`discardSignalImageCandidate()`); when that fails, the command says so and how to recover. The setup wizard's pin step does the same.
- **Staleness.** Signal changes its protocol from time to time, so a pinned image eventually stops working. Starting the bridge logs a reminder to run `--update-image` once the image is more than 90 days old (`SIGNAL_IMAGE_STALE_DAYS`).

### Volume Mount

signal-cli stores registration data, cryptographic keys, and message state in `/home/.local/share/signal-cli` inside the container. This directory **must** be host-mounted for persistence. Without it, every container restart would lose the registered phone number and require re-registration.

Host path: `~/.ironcurtain/signal-data/`
Container path: `/home/.local/share/signal-cli`

### SignalContainerManager

A thin layer over `DockerManager` that adds signal-specific lifecycle semantics. Unlike agent containers (per-session, ephemeral, `--network=none`), the signal-cli container is a long-lived background service that needs network access.

**File:** `src/signal/signal-container.ts`

```typescript
/**
 * Configuration for the signal-cli Docker container.
 * Stored in user config and used by the container manager.
 */
export interface SignalContainerConfig {
  /** Docker image, pinned by digest. Default: SIGNAL_DEFAULT_IMAGE (see "Container Image") */
  readonly image: string;
  /** Host port to bind the REST API to. Default: 18080 (avoids conflict with common :8080) */
  readonly port: number;
  /** Host directory for signal-cli persistent data. Default: ~/.ironcurtain/signal-data/ */
  readonly dataDir: string;
  /** Container name for identification. Default: 'ironcurtain-signal' */
  readonly containerName: string;
}

export const SIGNAL_CONTAINER_DEFAULTS: SignalContainerConfig = {
  image: SIGNAL_DEFAULT_IMAGE, // bbernhard/signal-cli-rest-api@sha256:...
  port: 18080,
  dataDir: '', // resolved at runtime to ~/.ironcurtain/signal-data/
  containerName: 'ironcurtain-signal',
};

/**
 * Manages the signal-cli-rest-api Docker container.
 * Delegates to DockerManager for all Docker CLI operations.
 */
export interface SignalContainerManager {
  /**
   * Ensures the container is running from the configured image. Returns the
   * REST API base URL. Idempotent. Never pulls a tag (see "Container Image").
   */
  ensureRunning(): Promise<string>;

  /** Polls GET /v1/health until the REST API responds. */
  waitForHealthy(baseUrl: string, timeoutMs?: number): Promise<void>;

  /** Stops and removes the container. */
  teardown(): Promise<void>;

  /** Returns true if the container exists (running or stopped). */
  exists(): Promise<boolean>;

  /** Returns true if the container is currently running. */
  isRunning(): Promise<boolean>;
}
```

### Container Lifecycle

| Aspect | Agent Containers | signal-cli Container |
|--------|-----------------|---------------------|
| Lifetime | Per-session | Persistent across sessions |
| Network | `--network=none` | `bridge` (needs internet) |
| Ports | None | `127.0.0.1:18080:8080` |
| Capabilities | `--cap-drop=ALL` (as built, the capabilities sudo needs are added back unless `agentSudo` is false) | `--cap-drop=ALL` (as built, CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID and KILL are added back for its entrypoint) |
| Created by | `DockerAgentSession.initialize()` | `ironcurtain setup-signal` or `SignalBotDaemon.start()` |
| Stopped by | `session.close()` | a stop-signal command or explicit teardown in this design; as built, nothing in IronCurtain stops it for good (no such command was built, and the bot and daemon leave it running when they exit; `setup-signal` restarts it to load an account, and starting the bot or daemon restarts it when its data mount went stale and recreates it when it was created from another image than the configured one; `docker stop ironcurtain-signal` stops it) |
| Data persistence | Ephemeral sandbox | Host-mounted volume (registration keys) |
| Restart policy | None | `unless-stopped` in this design; none as built (the bot or daemon starts it) |

### Docker Commands (equivalent)

**Container creation:**

```bash
docker create \
  --name ironcurtain-signal \
  --network bridge \
  --add-host=host.docker.internal:host-gateway \
  --cap-drop=ALL \
  -p 127.0.0.1:18080:8080 \
  --restart=unless-stopped \
  -v ~/.ironcurtain/signal-data:/home/.local/share/signal-cli \
  -e MODE=json-rpc \
  bbernhard/signal-cli-rest-api:latest
```

Key choices:
- `--cap-drop=ALL` -- same as agent containers. signal-cli only needs outbound TCP, which does not require elevated capabilities
- `127.0.0.1:18080:8080` -- publishes on host loopback, shared by all local users. The REST bridge has no authentication; the native Linux bridge address can also expose its wildcard listener. This does not isolate the API from other host accounts.
- `MODE=json-rpc` -- enables WebSocket message receiving, the most reliable real-time delivery mechanism
- `--restart=unless-stopped` -- container survives host reboots but respects explicit `docker stop`
- As built (`createSignalContainerManager` in `src/signal/signal-container.ts`), two of these choices changed: the signal-cli-rest-api entrypoint needs CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID and KILL, which are added back after `--cap-drop=ALL`; and there is no restart policy, because Docker's restart after a host reboot left stale bind mounts, so the bot or daemon starts the container (and restarts one whose data mount went stale)
- Port 18080 -- avoids collision with development servers commonly running on 8080

**Health check:**

```bash
curl -f http://127.0.0.1:18080/v1/health
```

Returns 204 No Content when healthy.

### Implementation

The sketch below predates image pinning: the implemented `ensureRunning()`
resolves the configured image first, never pulls a tag, recreates a
container created from another image, and has no restart policy (see
"Container Image").

```typescript
export function createSignalContainerManager(
  docker: DockerManager,
  config: SignalContainerConfig,
): SignalContainerManager {
  const resolvedDataDir = config.dataDir || getSignalDataDir();

  return {
    async ensureRunning(): Promise<string> {
      const baseUrl = `http://127.0.0.1:${config.port}`;

      // Check if container already exists and is running
      if (await docker.isRunning(config.containerName)) {
        return baseUrl;
      }

      // Check if container exists but is stopped (isRunning returns
      // false for both "stopped" and "not found", so we try start
      // first and fall through to create on failure)
      try {
        await docker.start(config.containerName);
        return baseUrl;
      } catch {
        // Container does not exist -- create it below
      }

      // Create new container via DockerManager.create()
      mkdirSync(resolvedDataDir, { recursive: true });
      await docker.create({
        image: config.image,
        name: config.containerName,
        network: 'bridge',
        ports: [`127.0.0.1:${config.port}:8080`],
        restartPolicy: 'unless-stopped',
        mounts: [{
          source: resolvedDataDir,
          target: '/home/.local/share/signal-cli',
          readonly: false,
        }],
        env: { MODE: 'json-rpc' },
        command: [],
      });
      await docker.start(config.containerName);
      return baseUrl;
    },

    async waitForHealthy(baseUrl: string, timeoutMs = 30_000): Promise<void> {
      const start = Date.now();
      let delay = 500;
      while (Date.now() - start < timeoutMs) {
        try {
          const resp = await fetch(`${baseUrl}/v1/health`);
          if (resp.status === 204) return;
        } catch { /* container starting up */ }
        await sleep(delay);
        delay = Math.min(delay * 1.5, 3000);
      }
      throw new Error(
        `signal-cli container did not become healthy within ${timeoutMs}ms`
      );
    },

    async teardown(): Promise<void> {
      await docker.stop(config.containerName);
      await docker.remove(config.containerName);
    },

    async pullImage(): Promise<void> {
      await docker.pullImage(config.image);
    },

    async exists(): Promise<boolean> {
      // docker.isRunning() swallows errors and returns false for both
      // "stopped" and "not found". We need docker inspect directly
      // to distinguish. A stopped container returns Running=false but
      // does not throw. A non-existent container throws.
      // NOTE: This requires adding a containerExists() method to
      // DockerManager, or we use the try-start approach in ensureRunning()
      // which avoids needing this check altogether.
      // For now, use the same inspect approach as isRunning but check
      // for any valid response rather than specifically "true".
      return docker.containerExists(config.containerName);
    },

    async isRunning(): Promise<boolean> {
      return docker.isRunning(config.containerName);
    },
  };
}
```

## 4. Onboarding Flow

### Command: `ironcurtain setup-signal`

A new CLI subcommand provides an interactive terminal setup experience using `@clack/prompts` (consistent with `ironcurtain config` and the first-start wizard).

**File:** `src/signal/setup-signal.ts`

### UX Flow

```
$ ironcurtain setup-signal

┌  Signal Transport Setup
│
◇  Signal lets you interact with IronCurtain sessions from your
│  phone. The communication channel is end-to-end encrypted and
│  securely paired between the bot and your phone.
│
│  You'll need:
│    - Docker running on this machine
│    - A phone number for the bot (or an existing Signal account)
│    - Your own Signal phone number (to receive messages)
│
◇  Continue with setup? (Y/n)
│  > Y
│
◆  Checking Docker...
│  ✓ Docker is available
│
◆  Starting signal-cli container...
│  (when this build has no reviewed digest, or the configured tag is
│   not present locally: pull bbernhard/signal-cli-rest-api:latest,
│   show its digest, "Pin bbernhard/signal-cli-rest-api@sha256:... and
│   use it?")
│
◆  Starting signal-cli container...
│  ✓ Container started on port 18080
│  ✓ Health check passed
│
◇  How would you like to set up Signal?
│  ● Register a new phone number (dedicated bot number)
│  ○ Link as secondary device (share your existing Signal account)
│
│  [User selects "Register a new phone number"]
│
◇  Enter the phone number to register (with country code):
│  > +15551234567
│
◆  To complete registration, Signal requires a captcha.
│  Opening your browser to the captcha page...
│
│  If the browser doesn't open, visit:
│  https://signalcaptchas.org/registration/generate.html
│
│  After completing the captcha, copy the signalcaptcha:// URL
│  from your browser's address bar.
│
◇  Paste the captcha token:
│  > signalcaptcha://signal-hcaptcha.03AGdBq...
│
◆  Registering +15551234567...
│  ✓ Registration request sent
│
◇  Enter the verification code from SMS:
│  > 123-456
│
◆  Verifying...
│  ✓ Phone number verified!
│
◇  Enter YOUR Signal phone number (to receive agent messages):
│  > +15559876543
│
◆  Verifying your identity...
│  A 6-digit challenge code has been sent to your Signal app.
│
│  ┌──────────────────────────────────────────────┐
│  │  Signal message from +15551234567:           │
│  │  "IronCurtain identity verification.         │
│  │   Your challenge code is: 847293"            │
│  └──────────────────────────────────────────────┘
│
◇  Enter the challenge code from your Signal app:
│  > 847293
│
◆  Verifying...
│  ✓ Identity verified! Your Signal identity key has been recorded.
│
│  ✓ Signal transport configured successfully.
│
│  Configuration saved:
│    Bot number:       +15551234567
│    Your number:      +15559876543
│    Identity key:     05a1b2c3... (fingerprint)
│    Container:        ironcurtain-signal
│    API port:         18080
│
│  Start a session with Signal:
│    ironcurtain bot
│
└  Setup complete.
```

### Device Linking Flow (Alternative Path)

```
◇  How would you like to set up Signal?
│  ○ Register a new phone number
│  ● Link as secondary device (share your existing Signal account)
│
◆  Generating device link...
│
│  Open Signal on your phone:
│    1. Go to Settings > Linked Devices
│    2. Tap "Link New Device"
│    3. Scan this QR code:
│
│  Or open this URL in your browser:
│  http://127.0.0.1:18080/v1/qrcodelink?device_name=IronCurtain
│
◆  Waiting for device to be linked...
│  ✓ Device linked successfully!
│
│  NOTE: When linked as a secondary device, messages from the
│  bot will appear to come from your own Signal account.
│  The primary device (your phone) must remain active.
│
◇  Enter YOUR Signal phone number (registered on the linked account):
│  > +15559876543
│
◆  Verifying your identity...
│  A 6-digit challenge code has been sent to your Signal app.
│
◇  Enter the challenge code from your Signal app:
│  > 519473
│
◆  Verifying...
│  ✓ Identity verified! Your Signal identity key has been recorded.
│  ...
```

### Implementation

```typescript
/**
 * Runs the interactive Signal setup wizard.
 *
 * Steps:
 * 1. Validate Docker availability
 * 2. Pull and start signal-cli container
 * 3. Register new number or link existing account
 * 4. Configure recipient number
 * 5. Challenge-response identity verification
 * 6. Capture and store identity key
 * 7. Save config
 */
export async function runSignalSetup(): Promise<void> {
  p.intro('Signal Transport Setup');

  // Explain what's happening and what's needed
  p.note(
    'Signal lets you interact with IronCurtain sessions from your\n' +
    'phone. The communication channel is end-to-end encrypted and\n' +
    'securely paired between the bot and your phone.\n\n' +
    'You\'ll need:\n' +
    '  - Docker running on this machine\n' +
    '  - A phone number for the bot (or an existing Signal account)\n' +
    '  - Your own Signal phone number (to receive messages)',
    'What is this?',
  );

  const cont = await p.confirm({ message: 'Continue with setup?', initialValue: true });
  handleCancel(cont);
  if (!cont) { p.cancel('Setup cancelled.'); process.exit(0); }

  // Step 1: Docker check
  const docker = createDockerManager();
  await validateDocker(docker);

  // Step 2: Pull image and start container
  const containerConfig = resolveContainerConfig();
  const manager = createSignalContainerManager(docker, containerConfig);
  await pullAndStart(manager);

  // Step 3: Registration or linking
  const method = await p.select({
    message: 'How would you like to set up Signal?',
    options: [
      { value: 'register', label: 'Register a new phone number', hint: 'dedicated bot number' },
      { value: 'link', label: 'Link as secondary device', hint: 'share your existing Signal account' },
    ],
  });
  handleCancel(method);

  const baseUrl = `http://127.0.0.1:${containerConfig.port}`;
  let botNumber: string;

  if (method === 'register') {
    botNumber = await registerNewNumber(baseUrl);
  } else {
    botNumber = await linkDevice(baseUrl);
  }

  // Step 4: Recipient number
  const recipientNumber = await p.text({
    message: 'Enter YOUR Signal phone number (to receive agent messages):',
    placeholder: '+15559876543',
    validate: validatePhoneNumber,
  });
  handleCancel(recipientNumber);

  // Step 5: Challenge-response identity verification
  const identityKey = await verifyRecipientIdentity(
    baseUrl, botNumber, recipientNumber as string,
  );

  // Step 6: Save config (including identity key)
  saveUserConfig({
    signal: {
      botNumber,
      recipientNumber: recipientNumber as string,
      recipientIdentityKey: identityKey,
      container: {
        image: containerConfig.image,
        port: containerConfig.port,
      },
    },
  });

  p.outro('Setup complete. Run: ironcurtain bot');
}
```

### Registration API Calls

**Register with captcha:**

```typescript
async function registerNewNumber(baseUrl: string): Promise<string> {
  const phoneNumber = await p.text({
    message: 'Enter the phone number to register (with country code):',
    placeholder: '+15551234567',
    validate: validatePhoneNumber,
  });
  handleCancel(phoneNumber);

  // Open captcha page
  p.log.info(
    'To complete registration, Signal requires a captcha.\n' +
    'Opening your browser to the captcha page...\n\n' +
    'If the browser doesn\'t open, visit:\n' +
    'https://signalcaptchas.org/registration/generate.html\n\n' +
    'After completing the captcha, copy the signalcaptcha:// URL\n' +
    'from your browser\'s address bar.',
  );
  await openUrl('https://signalcaptchas.org/registration/generate.html');

  const captcha = await p.text({
    message: 'Paste the captcha token:',
    validate: (v) => v?.startsWith('signalcaptcha://') ? undefined : 'Must start with signalcaptcha://',
  });
  handleCancel(captcha);

  // POST /v1/register/{number}
  const registerResp = await fetch(
    `${baseUrl}/v1/register/${encodeURIComponent(phoneNumber as string)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ captcha: captcha as string }),
    },
  );
  if (!registerResp.ok) {
    const body = await registerResp.text();
    throw new Error(`Registration failed: ${registerResp.status} ${body}`);
  }

  const verifyCode = await p.text({
    message: 'Enter the verification code from SMS:',
    validate: (v) => v && /^\d{3}-?\d{3}$/.test(v) ? undefined : 'Enter 6-digit code (e.g., 123-456)',
  });
  handleCancel(verifyCode);

  const normalizedCode = (verifyCode as string).replace('-', '');

  // POST /v1/register/{number}/verify/{code}
  const verifyResp = await fetch(
    `${baseUrl}/v1/register/${encodeURIComponent(phoneNumber as string)}/verify/${normalizedCode}`,
    { method: 'POST' },
  );
  if (!verifyResp.ok) {
    const body = await verifyResp.text();
    throw new Error(`Verification failed: ${verifyResp.status} ${body}`);
  }

  p.log.success('Phone number verified!');
  return phoneNumber as string;
}
```

**Link as secondary device:**

```typescript
async function linkDevice(baseUrl: string): Promise<string> {
  // GET /v1/qrcodelink?device_name=IronCurtain
  const qrUrl = `${baseUrl}/v1/qrcodelink?device_name=IronCurtain`;

  p.log.info(
    'Open Signal on your phone:\n' +
    '  1. Go to Settings > Linked Devices\n' +
    '  2. Tap "Link New Device"\n' +
    '  3. Scan the QR code at this URL:\n\n' +
    `  ${qrUrl}\n\n` +
    'The QR code image opens in your browser.',
  );
  await openUrl(qrUrl);

  // The QR code endpoint blocks until linking succeeds or times out.
  // We poll /v1/about or /v1/devices to detect when linking completes.

  const phoneNumber = await p.text({
    message: 'Enter the phone number of the linked Signal account:',
    placeholder: '+15559876543',
    validate: validatePhoneNumber,
  });
  handleCancel(phoneNumber);

  // Verify linking succeeded by listing devices
  const devicesResp = await fetch(
    `${baseUrl}/v1/devices/${encodeURIComponent(phoneNumber as string)}`,
  );
  if (!devicesResp.ok) {
    throw new Error('Could not verify device linking. Ensure you scanned the QR code.');
  }

  p.log.success('Device linked successfully!');
  p.log.warn(
    'When linked as a secondary device, messages from the bot will\n' +
    'appear to come from your own Signal account. The primary device\n' +
    '(your phone) must remain active.',
  );

  return phoneNumber as string;
}
```

### Challenge-Response Identity Verification

After the bot number is registered and the recipient number is entered, the setup flow performs a challenge-response exchange. This serves two purposes:

1. **Proof of control**: confirms the person at the terminal actually controls the Signal account for the entered phone number
2. **Identity key capture**: records the recipient's Signal identity key so the transport can detect if it changes later (SIM swap, number reassignment, device reset)

```typescript
import { randomInt } from 'node:crypto';

/**
 * Sends a random challenge code to the recipient via Signal,
 * waits for the user to type it into the terminal, then
 * captures and returns the recipient's identity key.
 *
 * The identity key comes from signal-cli's identity endpoint
 * after a successful message exchange has occurred.
 */
async function verifyRecipientIdentity(
  baseUrl: string,
  botNumber: string,
  recipientNumber: string,
): Promise<string> {
  // Generate a 6-digit challenge code
  const challengeCode = String(randomInt(100000, 999999));

  // Send the challenge via Signal
  p.log.info('A 6-digit challenge code has been sent to your Signal app.');
  const sendResp = await fetch(`${baseUrl}/v2/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `IronCurtain identity verification.\nYour challenge code is: ${challengeCode}`,
      number: botNumber,
      recipients: [recipientNumber],
    }),
  });
  if (!sendResp.ok) {
    throw new Error(`Failed to send challenge message: ${sendResp.status}`);
  }

  // Prompt user to enter the code they received
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    const entered = await p.text({
      message: 'Enter the challenge code from your Signal app:',
      validate: (v) =>
        v && /^\d{6}$/.test(v) ? undefined : 'Enter the 6-digit code',
    });
    handleCancel(entered);

    if (entered === challengeCode) {
      break;
    }

    attempts++;
    if (attempts >= maxAttempts) {
      throw new Error(
        'Challenge verification failed after 3 attempts. ' +
        'Ensure you are reading the code from the correct Signal conversation.',
      );
    }
    p.log.warn(`Incorrect code. ${maxAttempts - attempts} attempt(s) remaining.`);
  }

  // Capture the recipient's identity key from signal-cli.
  // After a message exchange, signal-cli has the recipient's
  // identity key in its trust store.
  // GET /v1/identities/{number}/{recipient}
  const identityResp = await fetch(
    `${baseUrl}/v1/identities/${encodeURIComponent(botNumber)}/${encodeURIComponent(recipientNumber)}`,
  );
  if (!identityResp.ok) {
    throw new Error(
      'Identity key could not be retrieved. ' +
      'This may indicate signal-cli has not yet exchanged keys with the recipient.',
    );
  }

  const identities = await identityResp.json() as Array<{
    safety_number: string;
    fingerprint: string;
    added: string;
    trust_level: string;
  }>;

  if (identities.length === 0) {
    throw new Error('No identity key found for recipient after message exchange.');
  }

  // Implemented as selectRecipientIdentity() (src/signal/recipient-identity.ts):
  // the newest record for the number by `added`; its fingerprint is stored as
  // recipientIdentityKey and its account UUID, when listed, as recipientUuid.
  const identity = identities[identities.length - 1];
  const identityFingerprint = identity.fingerprint;

  p.log.success(
    `Identity verified! Signal identity key recorded.\n` +
    `  Fingerprint: ${identityFingerprint.substring(0, 20)}...`,
  );

  return identityFingerprint;
}
```

**How signal-cli exposes identity keys:**

signal-cli maintains a trust store of known identity keys for contacts. After sending/receiving a message, the recipient's identity key is available via:

- `GET /v1/identities/{number}` - lists all known identities for a registered number
- `GET /v1/identities/{number}/{recipient}` - identity for a specific contact

Each identity entry includes:
- `fingerprint` - hex-encoded identity key (the stable cryptographic identifier)
- `safety_number` - the human-readable safety number (changes when either party's key changes)
- `trust_level` - `TRUSTED_UNVERIFIED`, `TRUSTED_VERIFIED`, or `UNTRUSTED`
- `added` - timestamp when the key was first seen

The fingerprint is what we store in config and compare at runtime. If it changes, the person controlling that phone number has changed (or re-installed Signal), and we must re-verify before accepting commands.

**Which record.** The list can hold more than one record for a number (for example a second identity of the account), and a record without its number for a while. `selectRecipientIdentity()` decides, for setup and runtime alike: with a stored `recipientUuid` (the UUID signal-cli lists for the record whose key setup stored), the record listed under that UUID; without one, the newest record for the recipient's number by `added` (a millisecond timestamp or a date; the last listed when the times do not tell). Setup and `--re-trust` always select by number and store the chosen record's UUID with its key (re-trust removes a UUID the new record does not list).

**Which sender.** Verifying the recorded account's record says nothing about who sent a message: after a SIM swap or number reassignment, messages from the recipient's number come from another account, whose key signal-cli stores under that account (and trusts on first use, without `untrustedIdentity`). So with a stored `recipientUuid`, every message whose envelope names another sender account (`sourceUuid`) locks the transport like a key change (`matchSenderAccount()` gives `other`). An envelope that names no account cannot be tied to the recorded one, and the record check cannot vouch for it (it verifies the recorded account, which still holds its old key after the number moved), so it is rejected without locking (`unnamed`). signal-cli normally names the sender account of every message it delivers, so this refuses only envelopes it could not attribute; a configuration without a stored UUID is not affected. Without a stored UUID the newest-record rule catches the same case, since the new account's record is the newest for the number.

**Unlocking.** While locked, every message re-reads config.json; a new `recipientIdentityKey` or `recipientUuid` there (what `--re-trust` records) unlocks. The lock also drops the cached success of the last identity check, so the message that unlocks is checked against signal-cli with the reloaded values instead of riding a 5-minute window that vouched for the identity that just failed.

### Re-trust Flow

When the transport detects an identity key change at runtime (see Section 5), it enters a locked state. The user must re-verify via `ironcurtain setup-signal --re-trust`, which runs a new challenge-response exchange:

```
$ ironcurtain setup-signal --re-trust

┌  Signal Identity Re-verification
│
◇  The Signal identity key for +15559876543 has changed.
│  This can happen when:
│    - You re-installed Signal
│    - You switched to a new phone
│    - Someone else has taken over the phone number
│
│  To re-establish trust, a new challenge code will be sent.
│
◆  Sending challenge code to +15559876543...
│
◇  Enter the challenge code from your Signal app:
│  > 382917
│
◆  Verifying...
│  ✓ Identity re-verified. New identity key recorded.
│
│  Previous key: 05a1b2c3d4...
│  New key:      05e6f7a8b9...
│
└  Transport unlocked. Sessions will now accept messages.
```

The re-trust flow:
1. Sends a new challenge to the same recipient number.
2. User enters the code in the terminal (proves physical presence + control of both the terminal and the Signal account).
3. Fetches the new identity key from signal-cli.
4. Updates config with the new key.
5. Unlocks the transport: The active `ironcurtain bot` process detects the lock state, re-reads `~/.ironcurtain/config.json` from disk on the next incoming message, updates its in-memory key, and automatically resumes processing messages.

This ensures an attacker who obtains the phone number cannot silently take over - they would also need physical access to the IronCurtain terminal.

### Error Handling During Onboarding

| Error | Detection | Recovery |
|-------|-----------|----------|
| Docker not running | `docker info` fails | Display: "Docker is not available. Start Docker and try again." |
| Image pull failure | `docker pull` exits non-zero | Display error, suggest checking internet connection |
| Container port conflict | `docker run` fails with "port already allocated" | Prompt for alternative port or stop conflicting container |
| Captcha rejected | POST /v1/register returns 400 | Display error, offer to retry captcha |
| SMS not received | User reports no code | Suggest: retry, use voice verification (`use_voice: true`), check phone number |
| Verification code wrong | POST /v1/register/.../verify returns 400+ | Allow 3 retries before aborting |
| QR code scan timeout | Linking endpoint returns timeout | Regenerate QR code and retry |
| Challenge code wrong | User enters wrong code 3 times | Abort setup. Suggest re-running setup. |
| Identity key not available | GET /v1/identities returns empty | Retry after short delay. If still empty, warn and abort. |
| signal-cli image not pinned | The build's default digest is the placeholder, or a configured tag is not present locally | Offer to pull the current image, show its digest and pin it; abort when declined. |

## 5. Signal Transport Implementation

The implementation is split into two classes with distinct lifetimes:

1. **`SignalBotDaemon`** - Long-lived singleton that manages the WebSocket connection, identity verification, escalation state, and message routing. Owns the signal-cli connection for the entire process lifetime. Creates and destroys sessions on demand.
2. **`SignalSessionTransport`** - Lightweight `Transport` adapter for a single session. Created by the daemon when a new session starts. Its `run()` promise resolves when the session ends (budget exhaustion, `/quit`, error). The daemon then creates a fresh transport+session for the next conversation.

This mirrors how `index.ts` creates a `CliTransport` and passes it a session, but adds the daemon layer above to manage session lifecycle across the bot's indefinite runtime.

*Note: Node 22/24 provides a native global `WebSocket`. No external polyfill needed.*

### The Daemon

**File:** `src/signal/signal-bot-daemon.ts`

```typescript
import { createSession } from '../session/index.js';
import { loadUserConfig, type ResolvedUserConfig } from '../config/user-config.js';
import { loadConfig, loadGeneratedPolicy, getPackageGeneratedDir } from '../config/index.js';
import { resolveSignalConfig, type ResolvedSignalConfig } from './signal-config.js';
import type { Session, SessionMode, EscalationRequest, DiagnosticEvent } from '../session/types.js';
import type { SignalContainerManager } from './signal-container.js';
import { SignalSessionTransport } from './signal-transport.js';
import { markdownToSignal } from './markdown-to-signal.js';
import { BudgetExhaustedError } from '../session/resource-budget-tracker.js';
import * as logger from '../logger.js';

/** How often to proactively verify the recipient's identity key (ms). */
const IDENTITY_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface SignalBotDaemonOptions {
  readonly config: ResolvedSignalConfig;
  readonly containerManager: SignalContainerManager;
  readonly mode: SessionMode;
}

export class SignalBotDaemon {
  private config: ResolvedSignalConfig;
  private readonly containerManager: SignalContainerManager;
  private readonly mode: SessionMode;

  // WebSocket state
  private ws: WebSocket | null = null;
  private baseUrl: string = '';
  private closed = false;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_DELAY_MS = 30_000;
  private static readonly BASE_RECONNECT_DELAY_MS = 1_000;

  // Session state -- at most one active session at a time
  private activeSession: Session | null = null;
  private activeTransport: SignalSessionTransport | null = null;
  private messageInFlight = false;

  // Escalation state -- owned by the daemon because the daemon routes
  // "approve"/"deny" messages before they reach the transport.
  private pendingEscalationId: string | null = null;
  private escalationResolving = false;

  // Identity verification state
  private identityLocked = false;
  private lastIdentityCheckMs = 0;

  // Message deduplication for drainMissedMessages()
  private recentTimestamps = new Set<number>();

  // Resolves when the daemon should exit (shutdown() called)
  private exitResolve: (() => void) | null = null;

  constructor(options: SignalBotDaemonOptions) {
    this.config = options.config;
    this.containerManager = options.containerManager;
    this.mode = options.mode;
  }

  /**
   * Starts the daemon. Returns a promise that resolves when
   * shutdown() is called (e.g., SIGTERM/SIGINT).
   */
  async start(): Promise<void> {
    this.baseUrl = await this.containerManager.ensureRunning();
    await this.containerManager.waitForHealthy(this.baseUrl);
    await this.connectWebSocket();
    await this.sendSignalMessage('IronCurtain bot is online. Send a message to begin.');

    // Block until shutdown
    await new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  /**
   * Initiates graceful shutdown. Ends the active session,
   * closes the WebSocket, and unblocks start().
   */
  async shutdown(): Promise<void> {
    logger.info('[Signal Daemon] Shutting down...');
    this.closed = true;
    await this.sendSignalMessage('IronCurtain bot is shutting down. Goodbye.');
    await this.endCurrentSession();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.exitResolve?.();
  }

  // --- WebSocket connection ---

  private async connectWebSocket(): Promise<void> {
    const wsUrl = `ws://127.0.0.1:${this.config.container.port}/v1/receive/${encodeURIComponent(this.config.botNumber)}`;
    const isReconnect = this.reconnectAttempts > 0;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      ws.addEventListener('open', () => {
        this.reconnectAttempts = 0;

        if (isReconnect) {
          this.drainMissedMessages().catch((err) => {
            logger.info(`[Signal Daemon] Failed to drain missed messages: ${err}`);
          });
        }

        resolve();
      });

      ws.addEventListener('message', (event) => {
        this.handleIncomingMessage(event.data as string).catch((err) => {
          logger.error(`[Signal Daemon] Error handling message: ${err}`);
        });
      });

      ws.addEventListener('close', () => {
        if (!this.closed) {
          this.scheduleReconnect();
        }
      });

      ws.addEventListener('error', (err) => {
        if (this.reconnectAttempts === 0 && !this.ws) {
          reject(new Error(`WebSocket connection failed: ${String(err)}`));
        }
      });

      this.ws = ws;
    });
  }

  /**
   * Polls GET /v1/receive/{number} to drain messages missed during
   * a WebSocket disconnect. Uses timestamp-based deduplication to
   * avoid processing messages that the WebSocket already delivered.
   */
  private async drainMissedMessages(): Promise<void> {
    const url = `${this.baseUrl}/v1/receive/${encodeURIComponent(this.config.botNumber)}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const messages = await resp.json() as unknown[];
      for (const msg of messages) {
        const data = JSON.stringify(msg);
        await this.handleIncomingMessage(data);
      }
    } catch {
      // Best-effort -- new messages will arrive via WS
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.reconnectAttempts++;

    const delay = Math.min(
      SignalBotDaemon.BASE_RECONNECT_DELAY_MS * Math.pow(1.5, this.reconnectAttempts),
      SignalBotDaemon.MAX_RECONNECT_DELAY_MS,
    );

    setTimeout(() => {
      if (!this.closed) {
        this.connectWebSocket().catch(() => {
          // Retry will be scheduled by the close handler
        });
      }
    }, delay);
  }

  // --- Message routing ---

  private async handleIncomingMessage(data: string): Promise<void> {
    const envelope = parseSignalEnvelope(data);
    if (!envelope) return;

    // Authorization: only accept messages from the configured user
    if (!isAuthorizedSender(envelope, this.config.recipientNumber)) return;

    // Deduplication: skip messages we've already processed
    const ts = envelope.dataMessage?.timestamp;
    if (ts) {
      if (this.recentTimestamps.has(ts)) return;
      this.recentTimestamps.add(ts);
      // Prune old timestamps (keep last 5 minutes)
      if (this.recentTimestamps.size > 500) {
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const t of this.recentTimestamps) {
          if (t < cutoff) this.recentTimestamps.delete(t);
        }
      }
    }

    // Identity verification
    if (await this.checkIdentityChanged(envelope)) return;

    const text = envelope.dataMessage?.message;
    if (!text) return;

    // Escalation replies: approve/deny (also accept /approve, /deny)
    if (this.handleEscalationReply(text)) return;

    // Control commands: /quit, /new, /budget, /help
    if (this.handleControlCommand(text)) return;

    // Regular message -> route to session
    await this.routeToSession(text);
  }

  /**
   * Routes a user message to the active session. Creates a new
   * session if none exists. Handles BudgetExhaustedError by ending
   * the exhausted session and notifying the user.
   */
  private async routeToSession(text: string): Promise<void> {
    if (this.messageInFlight) {
      await this.sendSignalMessage('Still processing previous message, please wait...');
      return;
    }

    // Create session on demand
    if (!this.activeSession) {
      try {
        await this.startNewSession();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.sendSignalMessage(`Failed to create session: ${msg}`);
        return;
      }
    }

    this.messageInFlight = true;
    try {
      const response = await this.activeSession!.sendMessage(text);
      const styledText = markdownToSignal(response);
      await this.sendSignalMessage(styledText);
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        const status = this.activeSession!.getBudgetStatus();
        await this.sendSignalMessage(
          `Session budget exhausted: ${error.message}\n` +
          formatBudgetSummary(status) + '\n' +
          'Send a new message to start a fresh session.',
        );
        await this.endCurrentSession();
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await this.sendSignalMessage(`Error: ${message}`);
      }
    } finally {
      this.messageInFlight = false;
    }
  }

  // --- Session lifecycle ---

  /**
   * Creates a new session with a fresh SignalSessionTransport.
   * Follows the same pattern as index.ts: create transport,
   * wire callbacks, create session, start transport.
   */
  private async startNewSession(): Promise<void> {
    const transport = new SignalSessionTransport(this);
    this.activeTransport = transport;

    const config = loadConfig();

    const session = await createSession({
      config,
      mode: this.mode,
      onEscalation: transport.createEscalationHandler(),
      onEscalationExpired: transport.createEscalationExpiredHandler(),
      onDiagnostic: transport.createDiagnosticHandler(),
    });

    this.activeSession = session;

    // Start the transport in the background. When it resolves
    // (session closed/budget exhausted), clean up.
    transport.run(session).then(() => {
      // Transport exited -- session is done
      if (this.activeTransport === transport) {
        this.activeSession = null;
        this.activeTransport = null;
      }
    }).catch((err) => {
      logger.error(`[Signal Daemon] Transport error: ${err}`);
    });

    await this.sendSignalMessage('Started a new session.');
  }

  /**
   * Ends the current session and cleans up. Awaits session.close()
   * to ensure resources are released (sandbox, MCP connections, etc.).
   * Guarded against re-entrance.
   */
  async endCurrentSession(): Promise<void> {
    if (!this.activeSession) return;
    const session = this.activeSession;
    const transport = this.activeTransport;
    this.activeSession = null;
    this.activeTransport = null;
    this.pendingEscalationId = null;
    this.escalationResolving = false;

    // Close transport first (resolves run() promise), then session
    transport?.close();
    await session.close();
  }

  // --- Escalation handling ---
  //
  // Superseded: escalations are recorded and announced by
  // surfaceEscalation(label, request), and replies must quote the banner's
  // code ("approve K7Q2"). See "Escalation Banners and Replies" below for
  // the banner, delivery and reply rules.

  // --- Control commands ---

  private handleControlCommand(text: string): boolean {
    const trimmed = text.trim().toLowerCase();

    switch (trimmed) {
      case '/quit':
      case '/exit':
      case '/new':
        this.endCurrentSession().then(() => {
          this.sendSignalMessage('Session ended. Send a message to start a new one.').catch(() => {});
        }).catch(() => {});
        return true;

      case '/budget': {
        if (!this.activeSession) {
          this.sendSignalMessage('No active session.').catch(() => {});
          return true;
        }
        const status = this.activeSession.getBudgetStatus();
        this.sendSignalMessage(formatBudgetMessage(status)).catch(() => {});
        return true;
      }

      case '/help':
        this.sendSignalMessage(
          'Commands:\n' +
          '  /quit or /new - end current session\n' +
          '  /budget - show resource usage\n' +
          '  /help - show this message\n' +
          '  approve <code> - approve the escalation whose banner shows <code>\n' +
          '  deny <code> - deny it ("deny" alone denies the only pending one)\n' +
          '  details <code> - show more of its arguments',
        ).catch(() => {});
        return true;

      default:
        return false;
    }
  }

  // --- Identity verification ---

  /**
   * Checks whether the sender's Signal identity key has changed.
   *
   * Detection path 1: signal-cli flags the envelope with `untrustedIdentity`.
   * Detection path 2: periodic proactive check via GET /v1/identities.
   *   Cached with IDENTITY_CHECK_INTERVAL_MS TTL to avoid HTTP overhead
   *   on every message.
   *
   * When locked, attempts self-healing by re-reading config from disk
   * (handles the case where the user ran `--re-trust` externally).
   *
   * Returns true if the message should be rejected.
   *
   * Implemented differently in five ways (signal-bot-daemon.ts): the record
   * is chosen by selectRecipientIdentity() (stored UUID, else the newest
   * record for the number); with a stored UUID, an envelope from another
   * sender account (sourceUuid) locks at once and one that names no account
   * is rejected; no such record (or a record without a fingerprint, or an
   * unreadable list) rejects the message without locking and without
   * caching, like an API error; approve/deny replies pass `fresh` and skip
   * the TTL, so a key change that arrives without the untrustedIdentity flag
   * cannot ride a cached success; and a lock drops the cached success, while
   * a new key or UUID on disk unlocks (see "Unlocking").
   */
  private async checkIdentityChanged(envelope: SignalEnvelope): Promise<boolean> {
    // If locked, attempt self-healing via config reload
    if (this.identityLocked) {
      try {
        const freshUserConfig = await loadUserConfig();
        const freshSignal = resolveSignalConfig(freshUserConfig);
        if (freshSignal.recipientIdentityKey !== this.config.recipientIdentityKey) {
          logger.info('[Signal Daemon] Detected new identity key on disk. Unlocking.');
          this.config = freshSignal;
          this.identityLocked = false;
        }
      } catch {
        logger.error('[Signal Daemon] Failed to reload config during lock check.');
      }
      if (this.identityLocked) return true;
    }

    // Detection path 1: envelope flag (real-time)
    if (envelope.untrustedIdentity) {
      await this.lockTransport('Identity key change detected via envelope flag.');
      return true;
    }

    // Detection path 2: proactive API check (periodic, TTL-cached)
    const now = Date.now();
    if (now - this.lastIdentityCheckMs < IDENTITY_CHECK_INTERVAL_MS) {
      return false; // Within TTL, skip API call
    }
    this.lastIdentityCheckMs = now;

    try {
      const resp = await fetch(
        `${this.baseUrl}/v1/identities/${encodeURIComponent(this.config.botNumber)}` +
        `/${encodeURIComponent(this.config.recipientNumber)}`,
      );
      if (resp.ok) {
        const identities = await resp.json() as Array<{ fingerprint: string }>;
        const current = identities[identities.length - 1];
        if (current && current.fingerprint !== this.config.recipientIdentityKey) {
          await this.lockTransport(
            `Identity key mismatch.\n` +
            `  Expected: ${this.config.recipientIdentityKey.substring(0, 20)}...\n` +
            `  Received: ${current.fingerprint.substring(0, 20)}...`,
          );
          return true;
        }
      }
    } catch {
      // Fail closed: reject message when we cannot verify identity
      logger.error(
        '[Signal Daemon] Identity check API unavailable. ' +
        'Rejecting message (fail-closed). Check signal-cli container health.',
      );
      return true;
    }

    return false;
  }

  private async lockTransport(reason: string): Promise<void> {
    this.identityLocked = true;
    logger.error(
      `[Signal Daemon] LOCKED: ${reason}\n` +
      `The Signal identity key for ${this.config.recipientNumber} has changed.\n` +
      `All messages are being rejected until re-trust is completed.\n` +
      `Run: ironcurtain setup-signal --re-trust`,
    );
  }

  // --- Message sending ---

  async sendSignalMessage(text: string): Promise<void> {
    const chunks = splitMessage(text, SIGNAL_MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await this.postMessage(chunk);
    }
  }

  private async postMessage(text: string): Promise<void> {
    const body: Record<string, unknown> = {
      message: text,
      number: this.config.botNumber,
      recipients: [this.config.recipientNumber],
      text_mode: 'styled',
    };

    const resp = await fetch(`${this.baseUrl}/v2/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Signal send failed: ${resp.status} ${errBody}`);
    }
  }
}
```

### The Transport Adapter

**File:** `src/signal/signal-transport.ts`

The `SignalSessionTransport` is a thin adapter that implements the `Transport` interface for a single session's lifetime. It does not own the WebSocket or manage identity - those responsibilities belong to the daemon.

```typescript
import type { Transport } from '../session/transport.js';
import type { Session, DiagnosticEvent, EscalationRequest } from '../session/types.js';
import type { SignalBotDaemon } from './signal-bot-daemon.js';
import { formatEscalationBanner } from './format.js';

export class SignalSessionTransport implements Transport {
  private session: Session | null = null;
  private readonly daemon: SignalBotDaemon;
  private exitResolve: (() => void) | null = null;

  constructor(daemon: SignalBotDaemon) {
    this.daemon = daemon;
  }

  /**
   * Starts the transport. The returned promise resolves when
   * close() is called, which signals that the session is done.
   * This follows the same contract as CliTransport.run().
   */
  async run(session: Session): Promise<void> {
    this.session = session;
    return new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  /**
   * Signals the transport to stop. Resolves the run() promise.
   * Does NOT call daemon.endCurrentSession() -- the daemon owns
   * session lifecycle and calls this method, not the other way around.
   */
  close(): void {
    this.session = null;
    this.exitResolve?.();
    this.exitResolve = null;
  }

  // --- Callback factories (wired into SessionOptions by the daemon) ---

  createDiagnosticHandler(): (event: DiagnosticEvent) => void {
    return (event) => {
      switch (event.kind) {
        case 'tool_call':
          // Don't send every tool call -- too noisy for messaging
          break;
        case 'budget_warning':
          this.daemon.sendSignalMessage(`[Budget warning] ${event.message}`).catch(() => {});
          break;
        case 'budget_exhausted':
          this.daemon.sendSignalMessage(`[Budget exhausted] ${event.message}`).catch(() => {});
          break;
      }
    };
  }

  createEscalationHandler(): (request: EscalationRequest) => void {
    return (request) => {
      // Records the escalation and sends its coded banner.
      void this.daemon.surfaceEscalation(this.sessionLabel, request);
    };
  }

  createEscalationExpiredHandler(): () => void {
    return () => {
      // Clears it and sends "[#N] Escalation K7Q2 expired (timed out)".
      this.daemon.expireEscalation(this.sessionLabel);
    };
  }
}
```

### Signal Message Envelope

The WebSocket in `json-rpc` mode delivers JSON envelopes. The relevant fields:

```typescript
/**
 * Signal message envelope received via WebSocket.
 * Only the fields relevant to IronCurtain are typed here;
 * the full envelope has many more fields (receipts, typing
 * indicators, etc.) that we ignore.
 */
interface SignalEnvelope {
  /** Sender's phone number or UUID. */
  source?: string;
  /** Sender's phone number (may differ from source in group messages). */
  sourceNumber?: string;
  /** Whether the sender's identity key has changed since last seen by signal-cli. */
  untrustedIdentity?: boolean;
  /** The actual message content, present for data messages. */
  dataMessage?: {
    /** Message text. */
    message?: string;
    /** Timestamp of the message. */
    timestamp?: number;
    /** Group context, if this is a group message. */
    groupInfo?: { groupId: string };
  };
  /** Typing indicator events -- ignored. */
  typingMessage?: unknown;
  /** Receipt events -- ignored. */
  receiptMessage?: unknown;
}

function parseSignalEnvelope(data: string): SignalEnvelope | null {
  try {
    const parsed = JSON.parse(data);
    // json-rpc mode wraps the envelope
    const envelope = parsed.envelope ?? parsed;
    return envelope as SignalEnvelope;
  } catch {
    return null;
  }
}

function isAuthorizedSender(envelope: SignalEnvelope, recipientNumber: string): boolean {
  const sender = envelope.sourceNumber ?? envelope.source;
  if (!sender) return false;
  // Normalize: strip spaces, ensure + prefix
  return normalizePhoneNumber(sender) === normalizePhoneNumber(recipientNumber);
}
```

### Message Length Limits

Signal messages have a practical limit of approximately 2000 characters (the protocol supports more, but clients truncate or behave poorly with very long messages). The transport splits long messages at paragraph boundaries when possible, falling back to line boundaries, then hard character limits.

```typescript
const SIGNAL_MAX_MESSAGE_LENGTH = 2000;

/**
 * Splits a message into chunks respecting the max length.
 * Prefers splitting at double-newlines (paragraph breaks),
 * then single newlines, then at the hard limit.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to find a paragraph break within the limit
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIdx <= 0) {
      // Fall back to line break
      splitIdx = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIdx <= 0) {
      // Hard split at max length
      splitIdx = maxLength;
    }

    chunks.push(remaining.substring(0, splitIdx).trimEnd());
    remaining = remaining.substring(splitIdx).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
```

### Escalation Banners and Replies

Signal has no buttons, so an approval is a typed reply, and nothing ties a
typed reply to the banner it answers: it can be delayed on the phone, replayed
by the reconnect drain, or arrive just after the escalation timed out and the
agent raised a new one. The agent can also post text that looks like a banner.
The banner and the reply rules close these gaps
(`src/signal/format.ts`, `src/signal/escalation-reply.ts`,
`SignalBotDaemon.surfaceEscalation()` and `handleEscalationReply()`).

**Reply code.** Each banner carries a 4-character code derived from the
host-generated escalation ID with HMAC-SHA256 under a random per-process key,
drawn from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no 0/O, 1/I). The agent never
sees it: it is sent only to the user, and the key keeps it from being computed
from the escalation ID.

**Banner.** Two parts, both sent with `text_mode: "normal"`, so no character
of the agent's is read as styling, and a third when the agent gave a
justification:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESCALATION [#2] code K7Q2
Human approval required
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task: Refactor the parser and push the branch
You said: push it to origin
Tool: git/git_push
Reason: Remote git operations require approval
Arguments: 3 values, in the next message
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Reply "approve K7Q2" or "deny K7Q2"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

```
[#2] K7Q2 arguments (3):
path: "/home/user/repo"
remote: "origin"
content: "Lorem ipsum…" (+1,048,376 bytes not shown)
Context:
Working directory: "/home/user/repo"
Some values were cut or left out. Reply "details K7Q2" to see more.
```

```
[#2] K7Q2 Agent says (UNTRUSTED, written by the agent; it authorizes nothing): Pushing the parser refactor the user asked for.
```

The header comes first and is small and fixed in shape, so the instructions
always arrive, whatever the arguments hold. A cron job's banner names the job
(`ESCALATION [#3 cron: Nightly triage] code K7Q2`).

- Reviewer context (`trusted-process/escalation-context.ts`). The header
  shows the session's task and the human's last message (`Task:`, `You
  said:`), the human's own text, each cut to 300 code points; the last
  message is left out when it is the task itself. Both are left out when they
  would push the header past one Signal message. The agent's justification is
  attacker-controlled, so it never enters the header, where it would sit
  above the reply instructions: it is the banner's last message, its
  "untrusted" label and the escaped text (at most 500 code points) on one
  line, short enough never to be split, so the text never arrives without
  its label.

- Every agent-controlled field (tool, reason, argument names and values,
  context, job name) goes through `toDisplayText`: controls, C1 (U+0085), bidi
  and other format characters, U+2028/U+2029 and the other default-ignorable
  code points (variation selectors, Hangul fillers) become visible escapes.
  Values are JSON-quoted, one `name: value` line each; nested objects and
  arrays are flattened (`files[0].path`).
- Values that say what a call acts on are never cut: argument names ending in
  path, file, dir, source, destination, target, url, uri, remote, repo, host,
  command, cmd, script, args, to, cc, bcc, recipient(s), address(es),
  scopeValue and similar (every top-level argument the shipped tool
  annotations give a path, URL or email-address role; a test keeps it so),
  any single-line value shaped like a path, URL or `git@host:` remote, and the
  server context. They are listed first.
- Other values are cut to 200 code points with the omitted UTF-8 byte count,
  within 1,200 characters for all of them; values that do not fit are counted
  ("+N more values, B bytes, not shown"). `details <code>` sends up to 6,000
  code points per value and 12,000 in all.
- When the values that must be shown in full exceed 6,000 characters (or the
  request has more than 200 values), the banner says the escalation cannot be
  approved over Signal; it can still be denied there, and otherwise times out.

**Delivery.** Each banner message is sent with a 20 s timeout and retried
after 1 s, 2 s and 4 s. If one still fails, the escalation is denied, the
failure is logged, and a short notice is attempted. Delivery (and retrying)
stops as soon as the escalation is settled elsewhere, for example in the web
UI; nothing is denied then, and no notice is sent. An approval is accepted
only once every banner message was delivered ("still being delivered"
otherwise), and only when it was sent after that (beyond the 10 s skew
allowance below): a reply processed late, for example from the reconnect
drain, may have been written before the arguments reached the phone.

**Replies.** `approve`, `approve+`, `deny` and `details` are matched
case-insensitively, with or without a slash; `/show` and `/pending` only with
the slash (so "show tests" stays chat). None of them is ever forwarded to the
agent, even when nothing is pending (`src/signal/escalation-reply.ts`):

| Reply | Effect |
|---|---|
| `approve <code>` / `approve #N <code>` | Approves the pending escalation with that code (on session #N). |
| `approve+ <code>` / `approve+ #N <code>` | Approves it and whitelists, for the session, the pattern its banner showed (the first whitelist candidate, `whitelistSelection: 0`); the confirmation repeats the pattern. Refused when the banner offered none. |
| `approve`, `approve #N`, `approve+` | Refused: approvals need the code. Any other message that starts with `approve+` (`approve+ the plan`, `approve+K7Q2`) is refused too, never forwarded. |
| `deny <code>`, `deny #N`, `deny` | Denies that escalation; bare `deny` only when exactly one is pending. |
| `details <code>`, `/show <code>` | Sends the escalation in full: tool, reason, every value (up to 6,000 code points each), context, the whitelist pattern `approve+` would add, and the reply instructions. |
| `/pending` | Lists the escalations pending over Signal: session, code, tool, age, and whether the banner is still being delivered, the escalation is deny-only or `approve+` is offered; plus a count of escalations other clients (the web UI) hold. |

**Whitelisting.** When the proxy sends whitelist candidates, the header shows
the first one, display-escaped and in full, after the reply line
(`or "approve+ K7Q2" to approve and whitelist, for this session:` and the
pattern on its own line). It is not offered for a human-only escalation, for
one that can only be denied, or when the escaped pattern is longer than 600
characters: `approve+` never whitelists more than the user read. The pattern
is part of the header's one message: when the task and the human's last
message would push the header past it, they are left out, never the pattern
(every other header part is bounded, so the header without them always fits).
The pending escalation recorded in the `SessionManager` keeps the candidates
with the rest of the request, so the web UI lists the patterns too; it still
carries no group key, so it never joins a web UI group approval. Replies that
quote the pattern, `/show` and `/pending` are sent in normal text mode.

A code that matches no pending escalation is refused ("already approved",
"already expired (timed out)" for a recently settled one). Only escalations
whose banner went out over Signal (Signal and cron sessions) are candidates;
web sessions' escalations are decided in the web UI. A reply whose Signal
server receive time (`serverReceivedTimestamp`, or the sender's timestamp when
absent) is more than 10 s older than the escalation is refused with "Escalation
changed since that reply was sent ... Re-confirm"; an approval without any
timestamp is refused too. The same rules apply to messages drained after a
WebSocket reconnect, since they go through the same handler.

**Late approvals.** `Session.resolveEscalation()` throws `ESCALATION_EXPIRED`
when the response was written after the proxy had already timed the request
out, and `SessionManager.resolveSessionEscalation()` reports it as
`{ resolved: false, reason: 'expired' }`, so the user is told the escalation
had expired and the call was denied, never that it was approved.

## 6. Configuration Schema

### New Config Fields

Added to `~/.ironcurtain/config.json` under a `signal` key:

```typescript
/**
 * Signal transport configuration as stored in the config file.
 * All fields optional in the file; presence of the signal key
 * indicates Signal has been set up.
 */
export interface SignalConfig {
  /** The bot's registered Signal phone number (e.g., '+15551234567'). */
  botNumber?: string;
  /** The user's Signal phone number to send messages to. */
  recipientNumber?: string;
  /** The user's Signal identity key fingerprint, captured during onboarding.
   *  Used to detect identity changes (SIM swap, number reassignment). */
  recipientIdentityKey?: string;
  /** The account UUID signal-cli lists for that key, captured with it. The
   *  runtime check verifies the record under this UUID (see "Which record"). */
  recipientUuid?: string;
  /** Container configuration overrides. */
  container?: {
    /** Docker image: `<repository>@sha256:<digest>`, or a tag used only as present
     *  locally. Default: SIGNAL_DEFAULT_IMAGE (pinned by digest). */
    image?: string;
    /** Host port for REST API. Default: 18080 */
    port?: number;
  };
}

/**
 * Resolved Signal config with all fields present.
 * Only constructed when Signal transport is actually used.
 */
export interface ResolvedSignalConfig {
  readonly botNumber: string;
  readonly recipientNumber: string;
  readonly recipientIdentityKey: string;
  readonly container: {
    readonly image: string;
    readonly port: number;
    readonly dataDir: string;
    readonly containerName: string;
  };
}
```

### Changes to `user-config.ts`

The existing config system uses Zod validation, unknown-field warnings, sensitive-field protection, and default backfilling. Adding `signal` requires changes to all of these.

**1. Zod schema -- add `signal` field:**

```typescript
const signalContainerSchema = z.object({
  image: z.string().min(1).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
}).optional();

const signalSchema = z.object({
  botNumber: z.string().regex(/^\+\d{7,15}$/, 'Must be E.164 format: +<country><number>').optional(),
  recipientNumber: z.string().regex(/^\+\d{7,15}$/, 'Must be E.164 format: +<country><number>').optional(),
  recipientIdentityKey: z.string().min(1).optional(),
  container: signalContainerSchema,
}).optional();

export const userConfigSchema = z.object({
  // ... existing fields unchanged ...
  signal: signalSchema,  // NEW
});
```

Without this, `saveUserConfig({ signal: { ... } })` will fail Zod validation because the merged config object contains a field not in the schema. The existing `saveUserConfig()` validates the merged result with `userConfigSchema.safeParse(merged)` and throws on failure.

**2. `SENSITIVE_FIELDS` -- add `signal`:**

```typescript
const SENSITIVE_FIELDS = new Set([
  'anthropicApiKey', 'googleApiKey', 'openaiApiKey', 'serverCredentials', 'webSearch',
  'signal',  // Contains phone numbers and identity key fingerprints
]);
```

This prevents `backfillMissingFields()` from writing signal defaults into the config file. Signal config should only appear after the user runs `ironcurtain setup-signal`.

**3. `UserConfig` type -- automatic:**

`UserConfig` is `z.infer<typeof userConfigSchema>`, so adding `signal` to the schema automatically adds `signal?: SignalConfig` to the type.

**4. `ResolvedUserConfig` -- add optional signal field:**

```typescript
export interface ResolvedUserConfig {
  // ... existing fields unchanged ...
  /** Signal transport config. Undefined when Signal is not set up. */
  readonly signal: ResolvedSignalConfig | null;
}
```

**5. `mergeWithDefaults()` -- pass through signal config:**

```typescript
function mergeWithDefaults(config: UserConfig): ResolvedUserConfig {
  // ... existing field resolution unchanged ...
  return {
    // ... existing fields ...
    signal: resolveSignalConfig(config),
  };
}
```

**6. `USER_CONFIG_DEFAULTS` -- no change needed:**

Signal has no defaults. It is not present until the user explicitly sets it up. This is correct -- `computeMissingDefaults()` iterates `USER_CONFIG_DEFAULTS` and `signal` is not in it, so nothing gets backfilled.

### Example config.json

```json
{
  "agentModelId": "anthropic:claude-sonnet-4-6",
  "policyModelId": "anthropic:claude-sonnet-4-6",
  "escalationTimeoutSeconds": 300,
  "signal": {
    "botNumber": "+15551234567",
    "recipientNumber": "+15559876543",
    "recipientIdentityKey": "05a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1",
    "recipientUuid": "8d2a4f1e-0c3b-4e5f-9a6b-7c8d9e0f1a2b",
    "container": {
      "image": "bbernhard/signal-cli-rest-api@sha256:<digest recorded by setup-signal --update-image>",
      "port": 18080
    }
  }
}
```

### Config Resolution

```typescript
const SIGNAL_DEFAULTS = {
  image: SIGNAL_DEFAULT_IMAGE, // bbernhard/signal-cli-rest-api@sha256:... (src/signal/signal-image.ts)
  port: 18080,
  dataDir: '', // resolved to ~/.ironcurtain/signal-data/
  containerName: 'ironcurtain-signal',
};

export function resolveSignalConfig(config: UserConfig): ResolvedSignalConfig | null {
  if (!config.signal?.botNumber || !config.signal?.recipientNumber || !config.signal?.recipientIdentityKey) {
    return null;
  }

  return {
    botNumber: config.signal.botNumber,
    recipientNumber: config.signal.recipientNumber,
    recipientIdentityKey: config.signal.recipientIdentityKey,
    container: {
      image: config.signal.container?.image ?? SIGNAL_DEFAULTS.image,
      port: config.signal.container?.port ?? SIGNAL_DEFAULTS.port,
      dataDir: getSignalDataDir(),
      containerName: SIGNAL_DEFAULTS.containerName,
    },
  };
}

export function getSignalDataDir(): string {
  return resolve(getIronCurtainHome(), 'signal-data');
}
```

## 7. Markdown-to-Signal Conversion

### How signal-cli-rest-api Styled Text Works

The signal-cli-rest-api `POST /v2/send` endpoint supports a `text_mode: "styled"` option. When enabled, the message text itself contains inline markup that signal-cli parses and converts into Signal's native formatting:

| Markup | Rendering | Example |
|--------|-----------|---------|
| `**text**` | **Bold** | `**important**` |
| `*text*` | *Italic* | `*note*` |
| `` `text` `` | `Monospace` | `` `config.json` `` |
| `~text~` | ~~Strikethrough~~ | `~removed~` |
| `||text||` | Spoiler | `||secret||` |

This is a subset of Markdown. The key differences from standard Markdown:
- Strikethrough uses single tilde `~text~` (Markdown uses `~~text~~`)
- Spoilers use `||text||` (no Markdown equivalent)
- No block-level formatting (headers, code blocks, lists, blockquotes)
- No links, images, or tables

### Algorithm

The converter transforms standard Markdown into Signal's styled text subset:

1. Parse the Markdown into an AST using `marked`
2. Walk the AST, emitting Signal-compatible markup
3. Map block-level elements to plain text with structural whitespace
4. Map inline styles to Signal's markup syntax

Since Signal's markup is a near-subset of Markdown, most inline formatting passes through with minimal changes. The main work is in block-level elements (headers, code blocks, lists) that have no Signal equivalent.

**File:** `src/signal/markdown-to-signal.ts`

### Supported Mappings

| Markdown | Signal Output | Notes |
|----------|--------------|-------|
| `**bold**` or `__bold__` | `**bold**` | Direct passthrough |
| `*italic*` or `_italic_` | `*italic*` | Direct passthrough |
| `` `inline code` `` | `` `inline code` `` | Direct passthrough |
| `~~strikethrough~~` | `~strikethrough~` | Double tilde to single tilde |
| `# Heading` | `**Heading**` | Rendered as bold text + newline |
| ` ```code block``` ` | `` `code block` `` | Wrapped in single backticks (no syntax highlighting) |
| `> blockquote` | `\| quoted text` | Vertical bar prefix |
| `- list item` | `- list item` | Bullet character preserved |
| `1. list item` | `1. list item` | Numbering preserved |
| `[link text](url)` | `link text (url)` | Parenthesized URL |
| Tables | Monospace-formatted | Best-effort with backtick wrapping |
| Images | `[Image: alt text]` | Placeholder text |

### Interface

```typescript
/**
 * Converts a Markdown string to Signal-compatible styled text.
 *
 * The returned string contains Signal's inline markup syntax
 * (**bold**, *italic*, `mono`, ~strike~) and is intended to be
 * sent with `text_mode: "styled"` via the signal-cli REST API.
 *
 * Limitations:
 * - No syntax highlighting in code blocks
 * - Headers are bold text, not visually distinct sizes
 * - Tables are rendered as monospace text
 * - Images are replaced with "[Image: alt]" placeholder
 * - Nested blockquotes lose depth distinction
 */
export function markdownToSignal(markdown: string): string;
```

### Implementation Strategy

Use the `marked` library's lexer (already a dependency) to produce tokens, then walk them:

```typescript
import { marked } from 'marked';

export function markdownToSignal(markdown: string): string {
  const tokens = marked.lexer(markdown);
  const output: string[] = [];

  function emit(text: string): void {
    output.push(text);
  }

  function walkTokens(tokens: marked.Token[]): void {
    for (const token of tokens) {
      switch (token.type) {
        case 'heading':
          // No heading support in Signal -- render as bold
          emit('**');
          walkInline(token.tokens);
          emit('**\n\n');
          break;

        case 'paragraph':
          walkInline(token.tokens);
          emit('\n\n');
          break;

        case 'code':
          // No fenced code blocks in Signal -- wrap in backticks
          emit('`');
          emit(token.text);
          emit('`');
          emit('\n\n');
          break;

        case 'blockquote':
          // Must not wrap tokens in formatting asterisks
          emit('| ');
          walkTokens(token.tokens);
          break;

        case 'list':
          for (const item of token.items) {
            emit(token.ordered ? `${item.index ?? ''}. ` : '- ');
            walkTokens(item.tokens);
          }
          break;

        case 'space':
          emit('\n');
          break;

        case 'hr':
          emit('---\n\n');
          break;

        default:
          if ('text' in token && typeof token.text === 'string') {
            emit(token.text);
          }
          break;
      }
    }
  }

  function walkInline(tokens: marked.Token[] | undefined): void {
    if (!tokens) return;
    for (const token of tokens) {
      switch (token.type) {
        case 'strong':
          emit('**');
          walkInline(token.tokens);
          emit('**');
          break;

        case 'em':
          emit('*');
          walkInline(token.tokens);
          emit('*');
          break;

        case 'codespan':
          emit('`');
          emit(token.text);
          emit('`');
          break;

        case 'del':
          // Markdown ~~ -> Signal single ~
          emit('~');
          walkInline(token.tokens);
          emit('~');
          break;

        case 'link':
          walkInline(token.tokens);
          emit(` (${token.href})`);
          break;

        case 'image':
          emit(`[Image: ${token.text || 'no description'}]`);
          break;

        case 'text':
          emit(token.text);
          break;

        case 'br':
          emit('\n');
          break;

        default:
          if ('text' in token && typeof token.text === 'string') {
            emit(token.text);
          }
          break;
      }
    }
  }

  walkTokens(tokens);

  return output.join('').trimEnd();
}
```

### Message Splitting

Because styled text is now plain text with inline markup (not positional offsets), splitting is straightforward - just split at natural text boundaries. No offset recalculation needed.

Signal messages have a practical limit of approximately 2000 characters. The `splitMessage()` function splits at paragraph breaks, then line breaks, then hard character limits.

**Known limitation:** If a split falls inside a backtick-wrapped code block, the backtick pairing will break and the chunk will display raw backticks. In practice this is rare because code blocks from LLM responses are typically under 2000 characters, and the splitter prefers paragraph boundaries. A future enhancement could track backtick state and insert closing/opening backticks at split points.

### Conversion Examples

**Input:**

```markdown
## Tool Result

The file `config.json` was **successfully** written.

```json
{"key": "value"}
```
```

**Output (sent with `text_mode: "styled"`):**

```
**Tool Result**

The file `config.json` was **successfully** written.

`{"key": "value"}`
```

## 8. Error Handling

### Failure Modes and Recovery

| Failure | Detection | Recovery Strategy |
|---------|-----------|-------------------|
| **signal-cli container stops** | WebSocket `close` event | Exponential backoff reconnect (1s, 1.5s, 2.25s, ... up to 30s). After 10 failures, send nothing (container may be gone). |
| **signal-cli protocol mismatch** | Send returns 400/500, "version too old" in response | Log error. The user updates the pinned image with `ironcurtain setup-signal --update-image` (pull, review the digest, pin); starting the bridge also warns once the image is over 90 days old. |
| **signal-cli image not pinned** | `ensureRunning()` throws `SIGNAL_IMAGE_NOT_PINNED` (placeholder default digest, or a configured tag missing locally) | Signal does not start (the daemon continues in cron-only mode); the error names `ironcurtain setup-signal --update-image`. A pinned image that cannot be pulled, or a local image without the pinned digest, fails the same way. |
| **WebSocket message parse error** | JSON.parse throws | Log and skip the malformed message. Do not crash. |
| **REST API send failure** | fetch returns non-2xx | Ordinary messages: log and drop. Escalation banner messages: 20 s timeout per attempt, 3 retries after 1 s, 2 s and 4 s; if still failing, the escalation is denied and logged (the user cannot decide on a banner they did not get). |
| **Session.sendMessage() throws** | Promise rejection | Send error text to user via Signal. Do not crash the transport. |
| **Unauthorized sender** | `sourceNumber` does not match configured `recipientNumber` | Silently ignore. Do not send any response (avoids revealing the bot exists to random numbers). |
| **Identity key changed** | Envelope `untrustedIdentity` flag, an envelope `sourceUuid` other than the stored `recipientUuid`, or fingerprint mismatch against stored `recipientIdentityKey` | Lock transport immediately. Reject all messages silently (do not alert attacker). Log warning to stderr with instructions to run `ironcurtain setup-signal --re-trust`. Requires challenge-response re-verification to unlock. |
| **Identity check API unavailable** | GET /v1/identities returns error | Fail closed: reject message and log error. An attacker who compromises the signal-cli container could disable the API to bypass identity verification. Consistent with default-deny posture. |
| **Sender account not named** | With a stored `recipientUuid`, the envelope has no `sourceUuid` | Fail closed without locking: reject the message and log it. Nothing ties it to the recorded account, whose record the identity check verifies. |
| **No identity record for the recipient** | The list has no record for the stored UUID (or, without one, for the number), or the record has no fingerprint | Fail closed like an API error: reject the message and log it, without locking (signal-cli may list a record without its number for a while) and without caching, so the next message checks again. A compromised container can still return the stored fingerprint; the image pin is the control for that. |
| **Container port conflict** | Docker create fails | Clear error message during setup. Suggest alternative port. |
| **Docker not available** | `docker info` fails | Clear error message. Do not attempt to continue. |
| **Registration blocked by Signal** | Register endpoint returns 403/429 | Show error. Suggest: wait and retry, try different IP, use voice verification. |
| **Message too long after conversion** | Styled text exceeds limit | Split into chunks at paragraph/line boundaries (handled by `splitMessage`). Inline markup may be split but degrades gracefully. |

### Graceful Degradation

When the WebSocket connection is lost and reconnection is in progress, the daemon:

1. Continues attempting reconnection in the background
2. Queues outgoing messages (escalation banners, responses) up to a reasonable limit (10 messages)
3. Delivers queued messages once reconnected
4. If the queue fills, drops oldest non-escalation messages first (escalation banners have priority)
5. After reconnecting, polls `GET /v1/receive/{number}` to drain any messages that arrived during the disconnect window (see `drainMissedMessages()`)

When the signal-cli container itself is gone (not just the WebSocket):

1. After 5 consecutive reconnection failures, attempt to restart the container via `containerManager.ensureRunning()`
2. If the container restart fails, stop retrying and let the session continue (the user can check the terminal for errors)

## 9. Bot Subcommand (`ironcurtain bot`)

### Execution Model

Unlike `ironcurtain start "task"` (which runs a single task with the CLI transport and exits), `ironcurtain bot` is a long-running process that:

1. Loads the Signal config from `~/.ironcurtain/config.json`
2. Takes the Signal transport lock, `~/.ironcurtain/signal.lock` (`src/signal/signal-lock.ts`), or exits 1 naming the process that holds it: another bot, or a daemon that runs Signal. Two transports would both receive every message from the same signal-cli container and manage the same container. The daemon takes the same lock before its own Signal start and runs without Signal when it is held.
3. Resolves session mode (supports `--agent` flag for Docker mode). A `PreflightError` is printed as its message and exits 1, after the bot gives back its log claim and the lock.
4. Creates a `SignalBotDaemon` with the container manager
5. Starts the daemon, which manages WebSocket, sessions, and message routing
6. Runs indefinitely until SIGTERM/SIGINT (Ctrl+C), then releases the lock

The daemon creates sessions on demand (first message starts a session) and destroys them when they end (`/quit`, `/new`, budget exhaustion). The user never needs to restart the bot to start a new conversation.

### Entry Point

**File:** `src/signal/bot-command.ts`

```typescript
import { loadConfig } from '../config/index.js';
import { loadUserConfig } from '../config/user-config.js';
import { createDockerManager } from '../docker/docker-manager.js';
import { resolveSessionMode } from '../session/preflight.js';
import { SignalBotDaemon } from './signal-bot-daemon.js';
import { createSignalContainerManager } from './signal-container.js';
import { resolveSignalConfig } from './signal-config.js';
import * as logger from '../logger.js';
import type { AgentId } from '../docker/agent-adapter.js';

export interface BotOptions {
  /** Explicit agent selection (e.g., 'claude-code'). */
  agent?: string;
}

export async function runBot(options: BotOptions = {}): Promise<void> {
  const userConfig = await loadUserConfig();
  const signalConfig = resolveSignalConfig(userConfig);

  if (!signalConfig.botNumber || !signalConfig.recipientNumber) {
    process.stderr.write('Signal is not configured. Run: ironcurtain setup-signal\n');
    process.exit(1);
  }

  // The bot's own log. Process-wide: the bot's lines stay here while each
  // session logs to its own file under a claim of its own.
  const logClaim = logger.setup({ logFilePath: getDaemonLogPath('signal-bot'), processWide: true });

  const config = loadConfig();

  // Resolve session mode (same logic as `ironcurtain start`)
  const preflight = await resolveSessionMode({
    config,
    requestedAgent: options.agent ? (options.agent as AgentId) : undefined,
  });
  const mode = preflight.mode;

  const docker = createDockerManager();
  const containerManager = createSignalContainerManager(docker, signalConfig);

  const daemon = new SignalBotDaemon({
    config: signalConfig,
    containerManager,
    mode,
  });

  // Wire up signal handling for graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) process.exit(1); // Second signal: force exit
    shuttingDown = true;
    await daemon.shutdown();
    // The bot's own (process-wide) claim on signal-bot.log; each session
    // took and gave back a claim of its own (see src/logger.ts).
    logger.release(logClaim);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.stderr.write(`IronCurtain bot starting (mode: ${mode.kind})...\n`);
  process.stderr.write('Press Ctrl+C to stop.\n');

  await daemon.start();
}
```

### CLI Registration

The `bot` subcommand is registered alongside `start`, `config`, `setup-signal`, etc. `src/cli.ts` hands it exactly the arguments after `bot`, and `runBotCommand` parses them strictly (`parseBotArgs`): `-a`/`--agent` (as `-a X`, `--agent X` or `--agent=X`) and `-h`/`--help`. Any other option, an empty agent name or a positional argument is an error (exit 1): `bot` takes no subcommand and never starts the cron scheduler, which is `ironcurtain daemon` (see cron-mode.md, Section 8.1).

```typescript
case 'bot': {
  const { runBotCommand } = await import('./signal/bot-command.js');
  await runBotCommand(args);
  break;
}
```

`runBot` checks the Signal configuration first, then runs the V8 sandbox preflight (`ensureSandboxViable`, which `src/cli.ts` leaves to this command), so `bot --help`, an argument error and an unconfigured Signal transport never depend on isolated-vm loading.

## 10. Testing Strategy

### Unit Tests (No Docker, No Signal Account Required)

**Markdown converter tests** (`test/signal/markdown-to-signal.test.ts`):

These are pure functions with no external dependencies - the most straightforward to test.

```typescript
describe('markdownToSignal', () => {
  it('converts bold text', () => {
    const result = markdownToSignal('Hello **world**');
    expect(result).toBe('Hello **world**');
  });

  it('converts headings to bold markup', () => {
    const result = markdownToSignal('## Title\n\nBody text');
    expect(result).toMatch(/^\*\*Title\*\*/);
  });

  it('converts code blocks to backtick-wrapped text', () => {
    const result = markdownToSignal('```\ncode here\n```');
    expect(result).toContain('`code here`');
  });

  it('converts strikethrough from double to single tilde', () => {
    const result = markdownToSignal('~~removed~~');
    expect(result).toBe('~removed~');
  });

  it('handles nested styles', () => {
    const result = markdownToSignal('**bold and `code`**');
    expect(result).toContain('**bold and `code`**');
  });

  it('strips images to alt text', () => {
    const result = markdownToSignal('![alt](url)');
    expect(result).toBe('[Image: alt]');
  });

  it('converts links to text with parenthesized URL', () => {
    const result = markdownToSignal('[click here](https://example.com)');
    expect(result).toContain('click here (https://example.com)');
  });
});
```

**Message splitting tests:**

```typescript
describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('hello', 2000)).toEqual(['hello']);
  });

  it('splits at paragraph boundaries', () => {
    const text = 'A'.repeat(1500) + '\n\n' + 'B'.repeat(200);
    const chunks = splitMessage(text, 2000);
    expect(chunks).toHaveLength(2);
  });
});
```

**Escalation banner tests** (`test/signal/format.test.ts`,
`test/signal/escalation-reply.test.ts`): the header holds the code and the
instructions; markup and line/bidi controls in any field are inert; a 1 MB
argument yields a bounded banner; paths, URLs and commands are never cut;
oversized must-show values make the escalation deny-only; replies parse as
specified. `test/signal/signal-bot-daemon.test.ts` covers the reply rules
end to end, including late, wrong-code, stale and drained replies, delivery
retries and the auto-deny.

**Signal envelope parsing tests:**

```typescript
describe('parseSignalEnvelope', () => {
  it('extracts message from json-rpc envelope', () => {
    const raw = JSON.stringify({
      envelope: {
        sourceNumber: '+15551234567',
        dataMessage: { message: 'hello' },
      },
    });
    const env = parseSignalEnvelope(raw);
    expect(env?.dataMessage?.message).toBe('hello');
  });

  it('returns null for non-JSON', () => {
    expect(parseSignalEnvelope('not json')).toBeNull();
  });

  it('ignores typing indicators', () => {
    const raw = JSON.stringify({ envelope: { typingMessage: {} } });
    const env = parseSignalEnvelope(raw);
    expect(env?.dataMessage).toBeUndefined();
  });
});
```

**Authorization tests:**

```typescript
describe('isAuthorizedSender', () => {
  it('accepts matching number', () => {
    const env = { sourceNumber: '+15551234567' };
    expect(isAuthorizedSender(env, '+15551234567')).toBe(true);
  });

  it('rejects non-matching number', () => {
    const env = { sourceNumber: '+15559999999' };
    expect(isAuthorizedSender(env, '+15551234567')).toBe(false);
  });

  it('handles number normalization', () => {
    const env = { sourceNumber: '+1 555 123 4567' };
    expect(isAuthorizedSender(env, '+15551234567')).toBe(true);
  });
});
```

**Identity verification tests:**

```typescript
describe('checkIdentityChanged', () => {
  it('rejects envelope with untrustedIdentity flag', async () => {
    const daemon = createDaemonWithConfig({
      recipientIdentityKey: 'abc123',
    });
    const envelope = {
      sourceNumber: '+15551234567',
      untrustedIdentity: true,
      dataMessage: { message: 'hello' },
    };
    expect(await daemon.checkIdentityChanged(envelope)).toBe(true);
    expect(daemon.identityLocked).toBe(true);
  });

  it('rejects when fingerprint does not match stored key', async () => {
    const mockApi = createMockSignalApi({
      identities: [{ fingerprint: 'different-key' }],
    });
    const daemon = createDaemonWithConfig({
      recipientIdentityKey: 'original-key',
    });
    const envelope = { sourceNumber: '+15551234567' };
    expect(await daemon.checkIdentityChanged(envelope)).toBe(true);
  });

  it('accepts when fingerprint matches stored key', async () => {
    const mockApi = createMockSignalApi({
      identities: [{ fingerprint: 'original-key' }],
    });
    const daemon = createDaemonWithConfig({
      recipientIdentityKey: 'original-key',
    });
    const envelope = { sourceNumber: '+15551234567' };
    expect(await daemon.checkIdentityChanged(envelope)).toBe(false);
  });

  it('stays locked after first detection (all subsequent messages rejected)', async () => {
    const daemon = createDaemonWithConfig({
      recipientIdentityKey: 'abc123',
    });
    // First message triggers lock
    await daemon.checkIdentityChanged({
      sourceNumber: '+15551234567',
      untrustedIdentity: true,
    });
    // Subsequent message (even without untrustedIdentity) is still rejected
    expect(await daemon.checkIdentityChanged({
      sourceNumber: '+15551234567',
    })).toBe(true);
  });

  it('fails closed when identity API is unavailable', async () => {
    const mockApi = createMockSignalApi({ identityEndpointDown: true });
    const daemon = createDaemonWithConfig({
      recipientIdentityKey: 'original-key',
    });
    const envelope = { sourceNumber: '+15551234567' };
    // Fail closed: reject message when we cannot verify identity.
    // An attacker who compromises the signal-cli container could
    // disable the identity API to bypass verification.
    expect(await daemon.checkIdentityChanged(envelope)).toBe(true);
  });
});

describe('verifyRecipientIdentity (onboarding)', () => {
  it('succeeds when correct challenge code is entered', async () => {
    // ... test with mock API and stdin input
  });

  it('fails after 3 wrong attempts', async () => {
    // ... test with mock API and wrong codes
  });

  it('captures identity fingerprint from signal-cli API', async () => {
    // ... verify the returned fingerprint matches the mock API
  });
});
```

### Integration Tests with Mock signal-cli API

A lightweight HTTP server mocking the signal-cli REST API endpoints enables testing the full `SignalBotDaemon` without a real Signal account:

```typescript
/**
 * Mock signal-cli-rest-api for integration tests.
 * Implements just enough of the API surface to test SignalBotDaemon.
 */
class MockSignalApi {
  private server: http.Server;
  private wss: WebSocketServer;
  readonly sentMessages: Array<{ message: string; recipients: string[] }> = [];

  /** Simulates an incoming message from a user. */
  simulateIncomingMessage(from: string, text: string): void {
    for (const ws of this.wss.clients) {
      ws.send(JSON.stringify({
        envelope: {
          sourceNumber: from,
          dataMessage: { message: text, timestamp: Date.now() },
        },
      }));
    }
  }

  // Endpoints:
  // GET /v1/health -> 204
  // POST /v2/send -> 201, captures message
  // GET /v1/receive/{number} -> WebSocket upgrade
}
```

### Manual Testing Checklist

For pre-release validation with a real Signal account:

1. [ ] `ironcurtain setup-signal` - register new number path
2. [ ] `ironcurtain setup-signal` - link device path
3. [ ] Send simple text message, receive response
4. [ ] Send message triggering escalation, reply "approve <code>" (bare "approve" is refused)
5. [ ] Send message triggering escalation, reply "deny"
6. [ ] Send message triggering escalation, let it timeout
7. [ ] Long agent response (triggers message splitting)
8. [ ] Agent response with code blocks (monospace rendering)
9. [ ] Agent response with bold/italic/headers
10. [ ] /quit command
11. [ ] /budget command
12. [ ] /help command
13. [ ] Unauthorized number sends message (should be ignored)
14. [ ] Identity key change locks transport (no response sent to attacker)
15. [ ] Identity key change logged to stderr with re-trust instructions
16. [ ] `--re-trust` challenge-response flow updates stored identity key
17. [ ] Challenge-response rejects wrong code (3 attempts max)
18. [ ] Onboarding captures and stores identity key fingerprint
19. [ ] Restart signal-cli container during session (reconnection)
20. [ ] `ironcurtain bot` starts and waits for Signal messages
21. [ ] Ctrl+C / SIGTERM gracefully shuts down the bot
22. [ ] Bot sends goodbye message on shutdown

## 11. Module Structure

### New Files

```
src/signal/
  signal-bot-daemon.ts    -- SignalBotDaemon (long-lived, owns WebSocket + session lifecycle)
  signal-transport.ts     -- SignalSessionTransport (lightweight Transport adapter per session)
  signal-container.ts     -- SignalContainerManager interface + implementation
  signal-config.ts        -- SignalConfig types, resolution, validation
  setup-signal.ts         -- Interactive onboarding command
  markdown-to-signal.ts   -- Markdown-to-Signal styled text converter
  format.ts               -- formatEscalationBanner, formatBudgetMessage, formatBudgetSummary
  bot-command.ts          -- `ironcurtain bot` subcommand entry point
  index.ts                -- Public exports

test/signal/
  signal-bot-daemon.test.ts
  markdown-to-signal.test.ts
  split-message.test.ts
  mock-signal-api.ts      -- Shared mock for integration tests
```

### Dependency Graph

```
src/signal/signal-bot-daemon.ts
  depends on: session/index.ts (createSession)
              session/types.ts (Session, SessionMode, EscalationRequest, etc.)
              session/resource-budget-tracker.ts (BudgetExhaustedError)
              config/index.ts (loadConfig)
              config/user-config.ts (loadUserConfig)
              signal/signal-transport.ts (SignalSessionTransport)
              signal/signal-container.ts (SignalContainerManager)
              signal/signal-config.ts (ResolvedSignalConfig, resolveSignalConfig)
              signal/markdown-to-signal.ts (markdownToSignal)
              signal/format.ts (formatters)
              logger.ts

src/signal/signal-transport.ts
  depends on: session/transport.ts (Transport interface)
              session/types.ts (DiagnosticEvent, EscalationRequest)
              signal/signal-bot-daemon.ts (SignalBotDaemon type)
              signal/format.ts (formatEscalationBanner)

src/signal/signal-container.ts
  depends on: docker/types.ts (DockerManager interface)
              config/paths.ts (getIronCurtainHome)

src/signal/setup-signal.ts
  depends on: signal/signal-container.ts (container management)
              signal/signal-config.ts (config types)
              config/user-config.ts (saveUserConfig)
              docker/docker-manager.ts (createDockerManager)
              @clack/prompts (terminal UI)

src/signal/markdown-to-signal.ts
  depends on: marked (already a dependency)
  no IronCurtain dependencies (pure utility)

src/signal/signal-config.ts
  depends on: config/user-config.ts (UserConfig)
              config/paths.ts (getIronCurtainHome)

src/signal/bot-command.ts
  depends on: signal/signal-bot-daemon.ts (SignalBotDaemon)
              signal/signal-container.ts (createSignalContainerManager)
              signal/signal-config.ts (resolveSignalConfig)
              config/index.ts (loadConfig)
              config/user-config.ts (loadUserConfig)
              session/preflight.ts (resolveSessionMode)
              docker/docker-manager.ts (createDockerManager)
              logger.ts
```

The `markdown-to-signal.ts` module has zero internal dependencies, making it trivially testable and potentially reusable.

## 12. Future Considerations

### Deferred (Not in This Design)

1. **Group chat support** - Signal supports group messages, but IronCurtain sessions are single-user. Group support would need authorization (who can send commands?) and message routing (which session?). Not worth the complexity now.

2. **Attachment/file sharing** - signal-cli supports sending files via base64 encoding. Agent output sometimes includes files (generated code, etc.). This could be added later for specific file types.

3. **Reaction-based escalation** - Signal supports emoji reactions, and signal-cli can detect them. An alternative escalation UX: user reacts with thumbs-up to approve, thumbs-down to deny. Deferring because text-based replies are simpler and more reliable.

4. **Multiple recipient support** - Notifications to multiple phone numbers (e.g., a team). Would require changes to the authorization model.

5. **Signal username support** - Signal recently added usernames. The current design uses phone numbers exclusively. Usernames could be supported as an alternative identifier once signal-cli's API stabilizes around them.

6. **Container image pinning with hash** - Implemented: the default image is pinned by digest and never pulled by tag; updates go through `setup-signal --update-image` (see "Container Image" in section 3). The reviewed default digest itself is still to be recorded (`SIGNAL_IMAGE_PINNED_DIGEST`).

7. **Automatic signal-cli updates** - Deliberately not automatic: an update changes the component that vouches for every approval, so it stays an explicit, reviewed step (`--update-image`). Starting the bridge only warns when the pinned image is older than 90 days. A background check that merely notifies the user remains possible.

8. **Matrix transport** - The second messaging transport, for users who want self-hosted infrastructure with button-capable clients.

### Known Limitations

- **No inline buttons for escalation.** Signal has no bot API and no interactive elements. Users must type "approve <code>" (the code from the banner) or "deny". This is less discoverable than Telegram's inline keyboards but acceptable for a security-focused tool.

- **Limited text formatting.** No syntax highlighting, no tables (beyond monospace approximation), no header sizing. Code-heavy agent output will look degraded compared to terminal rendering.

- **JVM memory overhead.** The signal-cli container uses 200-400MB of RAM for the Java process. This is a permanent background cost while Signal transport is active.

- **Registration fragility.** Signal's anti-fraud measures may block registration from certain IPs or virtual numbers. The onboarding flow handles this with clear error messages but cannot prevent it.

- **Single-device constraint.** If signal-cli is registered as a primary device, using Signal on a phone with that number will de-register signal-cli. The linked-device option avoids this but has its own constraints (primary device must stay active).

- **Protocol breakage.** Signal changes its server protocol periodically. When this happens, old signal-cli versions stop working. Users must update the pinned image with `ironcurtain setup-signal --update-image`. There is no automatic detection of this failure mode beyond the general "send failed" error path and the warning for images over 90 days old.

### RV-22: authenticated bridge implementation

The current transport contract at the top of this document replaces the historical unauthenticated API and default-digest workflow. Source, credential and synthetic runtime checks are tracked separately from actual macOS Docker Desktop/Apple runtime and live Signal account qualification; those owner qualifications remain open.

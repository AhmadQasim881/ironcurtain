# Signal Messaging Transport

IronCurtain includes a Signal messaging transport that lets you interact with agent sessions from any device running the Signal app. Send tasks, receive responses, and approve escalations — all through end-to-end encrypted messages.

## Why Signal?

IronCurtain is a security-first runtime. The messaging transport should reflect that posture. We evaluated several options:

| Platform   | E2E Encryption                 | Open Protocol     | Metadata Collection     | Bot API                             |
| ---------- | ------------------------------ | ----------------- | ----------------------- | ----------------------------------- |
| **Signal** | Always on, all messages        | Yes (open-source) | Minimal (sealed sender) | No official API (we use signal-cli) |
| Telegram   | Opt-in (Secret Chats only)     | No                | Extensive               | Yes (full-featured)                 |
| Discord    | No                             | No                | Extensive               | Yes (full-featured)                 |
| Slack      | No (enterprise key management) | No                | Extensive               | Yes (full-featured)                 |
| Matrix     | Optional (varies by client)    | Yes (federated)   | Depends on homeserver   | Yes                                 |

Telegram, Discord, and Slack would have been easier to integrate — they all have official bot APIs with inline buttons, rich formatting, and webhooks. But they also collect metadata, lack default E2E encryption, and run on closed protocols. Using one of these as the primary transport for a security-focused agent runtime would undermine the project's credibility.

Signal's tradeoffs are the right ones for IronCurtain:

- **Full E2E encryption by default** — every message between you and the bot is encrypted. Signal cannot read them. Your ISP cannot read them. A compromised server cannot read them.
- **Minimal metadata** — Signal's sealed sender protocol means even Signal's servers don't know who sent a message to whom.
- **Open-source protocol** — the Signal Protocol is published, audited, and used as the basis for encryption in WhatsApp, Google Messages, and others.
- **No bot API is actually a feature** — there is no cloud-hosted bot infrastructure that could be compromised. The signal-cli process runs on _your_ machine, in a Docker container you control. Your messages never pass through a third-party bot platform.

The downside is engineering effort. Signal has no bot SDK, no webhooks, no inline buttons. We bridge the gap with [signal-cli](https://github.com/AsamK/signal-cli) running in the community-maintained [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) Docker container. Escalation approvals use text replies that quote a per-escalation code instead of buttons. Code formatting is limited to Signal's inline markup. These are acceptable tradeoffs for a tool whose users care about security.

## Prerequisites

- Docker running on the host machine
- The authenticated local bridge image, built with `npm run build:signal-bridge` (see [build instructions](docker/signal-bridge/README.md))
- A phone number for the bot (a dedicated number, or your existing Signal account via device linking)
- Your own Signal phone number (to receive messages)

## Setup

### 1. Run the setup wizard

```bash
ironcurtain setup-signal
```

The wizard walks you through:

1. **Docker validation** — confirms Docker is available
2. **Container image** — uses the locally built authenticated bridge, or an explicitly configured image carrying the same transport contract; an unmodified upstream image is refused (see [Docker Container](#docker-container))
3. **Signal registration** — either register a new phone number (requires captcha + SMS verification) or link as a secondary device on your existing Signal account
4. **Identity verification** — a challenge-response exchange proves you control the recipient phone number and captures your Signal identity key fingerprint and account UUID

All configuration is saved to `~/.ironcurtain/config.json` under the `signal` key.

### 2. Start the bot

```bash
ironcurtain bot
```

The bot starts a long-running process that:

- Connects to signal-cli via WebSocket for real-time message delivery
- Creates agent sessions on demand when you send a message
- Handles graceful shutdown on Ctrl+C / SIGTERM

You can specify which agent to use:

```bash
ironcurtain bot --agent claude-code    # Docker agent mode
ironcurtain bot --agent builtin        # Built-in Code Mode agent
```

Without `--agent`, the bot uses the same mode selection as `ironcurtain start`. `ironcurtain bot` is the Signal transport alone: it takes only `-a`/`--agent` and `--help` and refuses subcommands. For Signal together with scheduled jobs, run `ironcurtain daemon` instead (see [DAEMON.md](DAEMON.md)).

One process runs the Signal transport per IronCurtain home, because two would both receive every message from the signal-cli container. It holds `~/.ironcurtain/signal.lock` while the transport runs. A second `ironcurtain bot`, or a bot started beside a daemon that runs Signal, exits with an error naming that process before it touches the container; a daemon started while a bot runs starts without Signal and says so. To run both, start the daemon with `--no-signal`.

### 3. Send a message

Open Signal on your phone or desktop and send a message to the bot's number. The bot creates a new session and responds with the agent's output.

## Bot Commands

Send these as Signal messages to control the bot:

| Command           | Description                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `/help`           | Show available commands                                                     |
| `/new [persona]`  | Start a new session (optionally with a persona)                             |
| `/sessions`       | List active sessions                                                        |
| `/switch N`       | Switch to session #N                                                        |
| `#N <message>`    | Send to session #N without switching                                        |
| `/quit [N]`       | End a session (current or #N); the bot stays online                         |
| `/budget [N]`     | Show resource consumption (tokens, steps, cost)                             |
| `/jobs`           | List scheduled cron jobs (with the daemon)                                  |
| `/pending`        | List pending escalations with their codes                                   |
| `/show <code>`    | Show an escalation in full (same as `details <code>`)                       |
| `approve <code>`  | Approve the escalation whose banner shows `<code>`                          |
| `approve+ <code>` | Approve it and whitelist the pattern its banner shows                       |
| `deny <code>`     | Deny it (`deny` alone denies the only pending one, `deny #N` the one on #N) |

Any other message is routed to the active session as a user message. If no session exists, one is created automatically. `show` and `pending` work only with the slash.

## Escalation Handling

When the policy engine escalates a tool call, the bot sends a plain-text banner whose header carries a short code; the arguments follow in a second message:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESCALATION [#1] code K7Q2
Human approval required
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tool: filesystem/write_file
Reason: Write outside sandbox
Arguments: 1 value, in the next message
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Reply "approve K7Q2" or "deny K7Q2"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Reply `approve K7Q2` to approve (or `approve #1 K7Q2`), `approve+ K7Q2` to approve and whitelist the pattern the banner offers for the rest of the session (refused when it offers none), and `deny K7Q2`, `deny #1` or `deny` (when only one escalation is pending) to deny. `details K7Q2` (or `/show K7Q2`) shows the arguments in full. The code is derived from the escalation with a key the agent never sees, so an approval names exactly the escalation you were shown, and a look-alike banner written by an agent cannot carry a real code.

- A bare `approve`, or `approve 2` without `#` (treated as a code), is refused.
- Banners are plain text that agent output cannot style or reorder. Argument values are shown JSON-quoted; a cut value ends with `(+N bytes not shown)`.
- An escalation whose paths, URLs or commands are too long to show in full can only be denied over Signal (or decided in the web UI).
- A reply written before the escalation it would act on was raised (for example one delivered late after a reconnect) is refused with `Escalation changed since that reply was sent, so it was not applied. Re-confirm with the code in the current escalation banner.`
- An escalation that times out is denied, and the expiry is announced. An approval that arrives too late is reported as expired.

## Identity Verification

During setup, the bot sends a 6-digit challenge code to your Signal number and asks you to type it back in the terminal. This proves you control both the terminal and the Signal account. The bot also captures your Signal identity key fingerprint and your account UUID and stores them in the config.

At runtime, the bot continuously verifies your identity key:

- **Real-time detection** — signal-cli flags incoming messages when the sender's identity key has changed, and a message from another account than the recorded UUID is treated the same way
- **Periodic verification** — the bot proactively checks the identity key via the signal-cli API every 5 minutes, and freshly for every approve and deny reply
- **Fail closed** — an API error, an unreadable identity list, or no record for your number rejects the message (without locking), so the next message checks again

If a key change is detected, the bot **locks the transport** — all messages are silently rejected. This protects against SIM-swap attacks, number reassignment, or device compromises.

To unlock after a legitimate key change (new phone, Signal reinstall):

```bash
ironcurtain setup-signal --re-trust
```

This runs a new challenge-response exchange, captures the new identity key and account UUID, and updates the config. The running bot detects the config change and automatically resumes accepting messages. Configurations written by older versions have no `recipientUuid`; run `--re-trust` once to record it.

## Architecture

```
Signal App (phone/desktop)
        |
  Signal Servers (E2E encrypted)
        |
┌────────────────────────────────────────┐
│  Host Machine                          │
│                                        │
│  ironcurtain bot    signal-cli-rest-api│
│  ┌───────────────┐  ┌────────────────┐ │
│  │SignalBotDaemon│  │ Docker         │ │
│  │  WSS       ◄──┼──┤ container      │ │
│  │  HTTPS POST ──┼─►│ TLS API  :8080 │ │
│  └──────┬────────┘  └────────────────┘ │
│         │                              │
│  ┌──────▼───────┐                      │
│  │   Session    │                      │
│  │ Policy Engine│                      │
│  │  MCP Servers │                      │
│  └──────────────┘                      │
└────────────────────────────────────────┘
```

The transport is split into two components:

- **SignalBotDaemon** — long-lived process that owns the WebSocket connection, manages identity verification, and routes messages to sessions. Survives session boundaries.
- **SignalSessionTransport** — lightweight `Transport` adapter, one per session. Created when a new session starts, destroyed when it ends.

## Docker Container

Every host call uses the authenticated bridge client: setup, registration, health, identity checks, send and WebSocket receive all use HTTPS/WSS with the private certificate explicitly trusted, hostname `localhost` verified and a bearer header. Redirects and plaintext fallback are refused. The bridge checks admission before route logging on all HTTP routes and WebSocket upgrades, including health, OPTIONS and unknown routes. Its internal JSON-RPC daemon listens only on container loopback.

The signal-cli container runs as a background service that `ironcurtain bot` (or the daemon) starts and manages:

| Property       | Value                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Image          | `ironcurtain-signal-bridge:0.101-auth1`, resolved to an immutable local image ID; authentication contract label `1` required        |
| Network        | `bridge` (needs internet for Signal servers)                                                                                        |
| Port           | `127.0.0.1:18080:8080` (HTTPS/WSS with bearer admission, also enforced at the container address)                                    |
| Capabilities   | `--cap-drop=ALL`, then `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID` and `KILL` added back for its entrypoint               |
| Restart policy | None: IronCurtain starts the container when the bot or daemon starts (Docker's own restart after a reboot leaves stale bind mounts) |
| Data volume    | `~/.ironcurtain/signal-data/` → `/home/.local/share/signal-cli`                                                                     |
| Memory         | ~200-400MB (JVM-based)                                                                                                              |

The default image is a local derived image, not a published or pullable release. Build it explicitly before setup:

```bash
npm run build:signal-bridge
# Or supply the already verified source context:
npm run build:signal-bridge -- --source-dir=/absolute/verified/context
```

The [recipe and build instructions](docker/signal-bridge/README.md) pin the official 0.101 source, verify its 35 source files before patching, pin runtime and Go 1.26.11 builder images, and build the API and authentication plugin together. Without `--source-dir`, the command downloads only the pinned manifest URLs and verifies their SHA-256 checksums before Docker builds. Docker may also download the pinned base images and Go dependencies. The build does not need a Signal account.

- `signal.container.image` defaults to `ironcurtain-signal-bridge:0.101-auth1`. A missing local default fails with build instructions and is never pulled automatically. A configured tag is used only as already present locally. Every accepted image must carry `org.ironcurtain.signal-bridge-auth=1`; an unmodified upstream image is refused.
- For a separately published compatible image, a configured digest is pulled only when missing, and `ironcurtain setup-signal --update-image` can pull an update, validate the contract and show the digest for confirmation. For the local default it prints rebuild guidance instead of attempting a registry pull. Restart the bot or daemon after rebuilding. `--update-image` cannot be combined with `--re-trust`.
- The container is trusted for every message and identity answer. Source pins, image identity and the contract label do not protect against a malicious image deliberately published or labelled by someone you trust.

The bearer token, server certificate and private key live together in `~/.ironcurtain/oauth/signal-bridge/credentials.json` (`$IRONCURTAIN_HOME/oauth/signal-bridge/credentials.json`). This single atomic file is mode 0600 in a mode 0700 directory. It is mounted read-only; secret values do not enter Docker command arguments, environment values, images or query strings. Corrupt or insecure existing bundles are refused. Expired certificates, or certificates with less than one day left, renew atomically; a fingerprint of the exact bundle bytes forces owned-container recreation.

IronCurtain validates the container owner, exact data mount and full runtime profile before reuse, and stops/removes containers by their inspected immutable IDs. An owned legacy container without authentication contract `1` is stopped and removed before resolving its replacement image, so a missing or rejected image cannot leave that listener running. A foreign owner or mismatched data mount is refused untouched. An already authenticated owned container can remain protected if a replacement image is unavailable. Linux runs the bridge as the host's numeric UID/GID and does not recursively chown the data or credentials. The default container name is shared across installations, so a collision with another home is refused rather than taken over.

The authenticated image and client are implemented. Actual macOS Docker Desktop/Apple runtime and live Signal account qualification remain owner work; synthetic local checks do not establish those results.

Registration data and cryptographic keys persist in the host-mounted volume.

## Configuration

Signal config lives in `~/.ironcurtain/config.json`:

```json
{
  "signal": {
    "botNumber": "+15551234567",
    "recipientNumber": "+15559876543",
    "recipientIdentityKey": "05a1b2c3d4e5f6...",
    "recipientUuid": "a1b2c3d4-...",
    "container": {
      "image": "ironcurtain-signal-bridge:0.101-auth1",
      "port": 18080
    }
  }
}
```

| Field                   | Description                                        | Default                                 |
| ----------------------- | -------------------------------------------------- | --------------------------------------- |
| `botNumber`             | The bot's registered Signal phone number           | _(set during setup)_                    |
| `recipientNumber`       | Your Signal phone number                           | _(set during setup)_                    |
| `recipientIdentityKey`  | Your Signal identity key fingerprint               | _(captured during setup)_               |
| `recipientUuid`         | Your Signal account UUID                           | _(captured during setup)_               |
| `container.image`       | Authenticated bridge image; see build instructions | `ironcurtain-signal-bridge:0.101-auth1` |
| `container.port`        | Host loopback port for HTTPS/WSS                   | `18080`                                 |
| `maxConcurrentSessions` | Concurrent Signal sessions (1-10)                  | `3`                                     |

See also [CONFIG.md](CONFIG.md#signal).

## Text Formatting

Agent responses are converted from Markdown to Signal's styled text markup before sending. Signal supports a subset of Markdown:

| Markdown      | Signal rendering                          |
| ------------- | ----------------------------------------- |
| `**bold**`    | **Bold**                                  |
| `*italic*`    | _Italic_                                  |
| `` `code` ``  | `Monospace`                               |
| `~~strike~~`  | ~~Strikethrough~~                         |
| `# Heading`   | **Bold text** (no size distinction)       |
| Code blocks   | Backtick-wrapped (no syntax highlighting) |
| `> quote`     | `\| quoted text`                          |
| Lists         | Preserved as-is                           |
| `[text](url)` | `text (url)`                              |
| Tables        | Monospace approximation                   |

Long messages are automatically split at paragraph boundaries to stay within Signal's ~2000 character limit. Escalation banners and completion notices are always plain text.

## Troubleshooting

| Issue                          | Resolution                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Signal is not configured`     | Run `ironcurtain setup-signal` first                                                                                                     |
| Bot refused: Signal lock held  | Another bot, or the daemon, already runs Signal for this home. Stop it, or start the daemon with `--no-signal`                           |
| The bridge refuses its image   | Build the local default with `npm run build:signal-bridge`, or use a compatible image with authentication contract label `1`             |
| Container port conflict        | Change `container.port` in config or stop the conflicting service                                                                        |
| Registration blocked by Signal | Wait and retry, try a different IP, or use device linking instead                                                                        |
| Bot not responding             | Check that the signal-cli container is running: `docker ps \| grep ironcurtain-signal`                                                   |
| Identity key mismatch          | Run `ironcurtain setup-signal --re-trust` to re-verify                                                                                   |
| An approval is refused         | Quote the code from the current banner (`approve <code>`); `/pending` lists pending escalations with their codes                         |
| signal-cli protocol errors     | Rebuild the local image; for a compatible published image use `ironcurtain setup-signal --update-image`, review its digest, then restart |
| High memory usage              | The signal-cli JVM uses 200-400MB. This is normal and required while the bot is running                                                  |

## Known Limitations

- **No inline buttons** — Signal has no bot API. Escalation approvals use text replies with a code.
- **Limited formatting** — No syntax highlighting, no tables, no header sizing. Code-heavy output looks degraded compared to terminal rendering.
- **Single user** — The bot accepts messages from one phone number only. Group chat and multi-user support are not implemented.
- **JVM memory** — The signal-cli container uses 200-400MB of RAM as a permanent background cost.
- **Registration fragility** — Signal's anti-fraud measures may block registration from certain IPs or virtual numbers.
- **Protocol updates** — Signal periodically changes its server protocol, which can break old signal-cli versions. Rebuild the local image when a reviewed recipe is updated, or update a compatible published image with `ironcurtain setup-signal --update-image`.
- **Trusted bridge** — The signal-cli container is trusted for every inbound message and identity answer; the validated image identity and authentication contract cannot protect against a compromised bridge.

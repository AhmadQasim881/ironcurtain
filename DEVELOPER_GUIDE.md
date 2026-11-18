# Developer Guide: Using IronCurtain with Docker Agent Mode

This guide covers the recommended way to use IronCurtain as a security layer for AI coding agents (Claude Code, Goose, Codex). The **terminal multiplexer** (`ironcurtain mux`) gives you the full power of your agent's interactive TUI while IronCurtain enforces security policy on every tool call.

## Why the Terminal Multiplexer?

IronCurtain's Docker Agent Mode runs an external agent (Claude Code, Goose, Codex) inside a network-isolated Docker container. All external effects — LLM API calls, filesystem mutations, git operations — pass through IronCurtain's policy engine. The terminal multiplexer is the interface that ties this together into a seamless developer workflow.

**Without the mux**, PTY mode requires two terminals: one for the agent session and a separate escalation listener. The user has no way to provide trusted input — keystrokes typed into the PTY flow through the Docker container and cannot be distinguished from sandbox-injected text. This means the auto-approver is effectively disabled.

**With the mux**, everything lives in a single terminal:

- **Full agent TUI** — You see your agent's interactive interface exactly as if you ran it locally.
- **Inline escalation handling** — When a tool call needs approval, you are notified in place and decide in a floating picker. No terminal switching, no context loss.
- **Trusted input line** — Text you type in command mode is captured on the host side, _before_ it enters the container. This creates a verified channel of user intent that the auto-approver can use to make approval decisions.
- **Tab management** — Run multiple agent sessions side by side and switch between them instantly.

## Getting Started

### Prerequisites

- Node.js 24 or 26 and Docker (same as Docker Agent Mode)
- `node-pty`, an optional dependency. On Linux it is compiled during installation, which needs `python3`, `make` and `g++`; `ironcurtain doctor` reports whether it loads (see [Troubleshooting](#troubleshooting)).
- An API key for your LLM provider (or OAuth — see [OAuth Authentication](#oauth-authentication))

### Launch

```bash
ironcurtain mux
```

This opens a managed PTY tab for the configured Docker agent, enters full-screen mode, and you're immediately in the agent's TUI.

## The Two Input Modes

The mux has two input modes, toggled with **Ctrl-A**:

### PTY Mode (default)

All keystrokes flow directly to the agent inside the container. This is the normal interactive experience — you're typing into Claude Code's prompt, navigating its UI, using its slash commands. The footer shows a hint: `^A command mode`.

### Command Mode

Press **Ctrl-A** to switch to command mode. A command input line appears at the bottom of the screen. Here you can:

- **Type trusted input** — Any text that isn't a slash command is sent as trusted user input (see below).
- **Handle escalations** — `/approve N`, `/deny N`, `/approve+ N`, `/approve+dir N`, `/approve all`, `/deny all`, `/approve group N` (see [Escalation Handling](#escalation-handling)).
- **Manage tabs** — `/new` (spawn session), `/new <persona>` (spawn with persona), `/new [persona] --task-scoped <task>` (spawn with a task scope), `/tab N` (switch), `/close` (terminate).
- **Resume sessions** — `/resume` (open picker), `/resume <id>` (resume by session ID prefix).
- **View sessions** — `/sessions` shows all active sessions in a message panel that Esc, Enter or q closes.
- **Exit** — `/quit`, or `Ctrl-A` / `Escape` to return to PTY mode.

Press **Ctrl-A** again or **Escape** to return to PTY mode. Quick tab switching is available with **Alt-1** through **Alt-9** from either mode.

## Trusted Input and Auto-Approval

This is the key capability that makes the mux more than a convenience — it's a security feature.

### The Problem

In PTY mode, the agent runs inside a Docker container. When you type into the PTY, your keystrokes enter the container through a socat bridge. From IronCurtain's perspective, this input is indistinguishable from text the sandbox itself might generate. If a prompt injection caused the agent to echo "push my changes to origin" into its own input, a naive auto-approver would treat that as user authorization.

### The Solution: Host-Side Trusted Input

When you type text in **command mode** (after pressing Ctrl-A), the mux captures it on the host side — before it ever touches the container:

1. Your text is written to `user-context.json` in the session's escalation directory (which is never bind-mounted into the container).
2. The text is then forwarded to the agent's PTY as keystrokes.
3. When a tool call triggers an escalation, the auto-approver reads `user-context.json` and checks whether the trusted text clearly authorizes the action.

```
You type: "push my changes to origin"

  Host side (trusted):
    → user-context.json written with source: "mux-trusted-input"
    → Text forwarded to PTY

  Container side:
    → Claude Code receives text, decides to call git_push
    → git_push escalated by policy engine

  Auto-approver:
    → Reads user-context.json
    → Verifies source = "mux-trusted-input" (host-originated)
    → Verifies timestamp is within 120 seconds (not stale)
    → Checks that the escalated resource (the remote "origin") is named in the message
    → LLM confirms "push my changes to origin" authorizes git_push
    → Auto-approved ✓
```

### Security Guarantees

The trust model rests on Docker container isolation:

- The escalation directory is **never bind-mounted** into the container — only the host-side mux can write `user-context.json`.
- A `source` field (`"mux-trusted-input"`) is required for PTY sessions — the auto-approver rejects context without this marker.
- A **120-second staleness window** bounds the time-of-check/time-of-use (TOCTOU) gap between typing trusted input and the agent acting on it. The same window applies to the messages of every other session type.
- Before the model is asked, a deterministic check requires every escalated resource to be named in your message: the path (or its directory), the destination host, or the git remote name. The call itself reaches the model as JSON-encoded untrusted data, URLs and git remotes only as validated host names.
- The auto-approver remains **conservative** — it only approves when intent is unambiguous. Vague messages ("go ahead", "fix it") always fall through to manual review.
- The auto-approver can **never deny** — only approve or escalate. A false negative means human review, not a blocked operation.
- Some escalations are **human-only** and never reach the auto-approver: `add_proxy_domain`, calls the opt-in taint escalation or content assessment flags, bulk memory deletions, and arguments holding nested values. System-originated turns (the memory auto-save) clear the trusted context, so an escalation there goes to you.

### Enabling Auto-Approval

Auto-approval is configured in `~/.ironcurtain/config.json` (or `ironcurtain config` → Security):

```json
{
  "autoApprove": {
    "enabled": true,
    "modelId": "anthropic:claude-haiku-4-5"
  }
}
```

The mux shows a pre-flight warning if auto-approve is enabled but the required API key is missing; the session then runs with auto-approval off.

## Escalation Handling

When a tool call triggers a policy escalation:

1. The PTY session emits a **BEL character** (your terminal bell or visual flash).
2. An **escalation badge** (`[!N pending]`) appears in the tab bar.
3. A **footer banner** shows the pending count and how to open the picker.

The picker never opens on its own, so keys you were typing into the agent can never answer an escalation.

### Escalation Picker

Press **Ctrl-E** (from PTY mode) to open the **escalation picker**, a floating overlay that shows each pending escalation with its tool name, server, arguments and policy reason. Argument values are shown JSON-quoted, with control, bidi and invisible characters as `\u` escapes; `(+N hidden, v to view)`, `(values cut, v to view)` and `Escalation (truncated: v shows all)` mark content cut to fit. When multiple escalations are pending, use the arrow keys or Tab to move between them.

| Key         | Action                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `a`         | Approve the focused escalation                                                                     |
| `d`         | Deny the focused escalation                                                                        |
| `w`         | Show the exact whitelist pattern in full; `y` then approves and whitelists it (`/approve+`)        |
| `W`         | Show the directory-wide pattern; `y` then approves and whitelists it (`/approve+dir`)              |
| `D`         | Deny all pending escalations                                                                       |
| `v`         | Toggle a full-detail view of the focused escalation (arrows, PageUp/PageDown, Home, End scroll it) |
| `←` `→` Tab | Move between escalations                                                                           |
| `Esc`       | Dismiss the picker                                                                                 |

Decision keys are armed only after the focused request has been drawn in full for about one second. A key pressed earlier, or any other key, restarts that wait (the hint bar shows `wait`), and so does moving the focus. There is no approve-all key: bulk approval goes through `/approve all`. Esc, the arrow keys, Tab and `v` work at any time.

You can also resolve escalations via slash commands in command mode:

| Command             | Description                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/approve N`        | Approve escalation #N                                                                                             |
| `/deny N`           | Deny escalation #N                                                                                                |
| `/approve+ N`       | Approve #N and whitelist the exact path or domain for the rest of the session                                     |
| `/approve+dir N`    | Approve #N and whitelist its directory (recursively), when that is offered                                        |
| `/approve all`      | Open a screen listing every pending escalation; `y` approves exactly that list once every line has been on screen |
| `/approve+ all`     | The same, whitelisting each exact pattern                                                                         |
| `/approve group N`  | Open a screen listing the escalations that share #N's whitelist pattern; `y` approves exactly those               |
| `/approve+ group N` | The same, whitelisting their pattern                                                                              |
| `/deny all`         | Deny all pending escalations                                                                                      |

Any change to the pending set cancels an open confirmation screen. The agent may attach a justification to its `execute_code` call; reviewers see it marked as untrusted text, and it never reaches the auto-approver. Human-only escalations (for example `add_proxy_domain`) stay pending through `/approve all` and need `/approve N`.

After resolving, press **Ctrl-A** or **Escape** to return to PTY mode. The agent continues automatically.

### Approval Whitelisting

When you use `/approve+ N` (or `w`, then `y`, in the picker), IronCurtain derives a pattern from the approved call (tool name, server, and argument constraints) and remembers it for the rest of the session. By default the pattern binds the exact canonical path of each approved path, or the exact destination of a URL or git remote (a named remote is bound to where it resolves). A whole directory, applied recursively, is whitelisted only when you choose it explicitly with `/approve+dir N` (or `W`), one escalation at a time; it is never offered for `/`, your home directory or its ancestors, or in or around `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/.local` or the host credential stores. A pattern must constrain every escalated argument; one that would not is not offered. Future calls matching a pattern are approved without another escalation. Whitelist entries are session-scoped and never persisted to disk, and human-only escalations are never whitelisted. The escalation panel shows each pattern before you commit.

## Personas

Personas are named policy profiles that let you run the agent under different security configurations. Each persona bundles its own constitution (security rules), compiled policy, and persistent memory database under `~/.ironcurtain/personas/<name>/`.

### Creating and Managing Personas

```bash
# Create a new persona interactively
ironcurtain persona create exec-assistant

# List all personas (including directories that cannot be used, with the reason)
ironcurtain persona list

# Compile a persona's constitution into policy rules
ironcurtain persona compile exec-assistant

# Edit a persona's constitution (and its memory and broad-policy settings)
ironcurtain persona edit exec-assistant

# Set its agent model and resource limits
ironcurtain persona set exec-assistant --model anthropic:claude-haiku-4-5 --max-cost 1

# Show persona details
ironcurtain persona show exec-assistant

# Copy, rename, delete, restore
ironcurtain persona clone exec-assistant exec-strict
ironcurtain persona rename exec-strict exec-readonly
ironcurtain persona delete exec-readonly
ironcurtain persona trash restore exec-readonly
```

A persona must be compiled before it can be used in a session, and a session refuses a persona whose constitution changed since its last compile (`ironcurtain start --persona <name> --allow-stale-policy` runs the old policy once, with a warning). A compiled policy with broad access needs the persona's opt-in (`persona compile <name> --allow-broad`, or the toggle in `persona edit`). Personas can optionally restrict which MCP servers are available (the `filesystem` server is always included; `persona create --servers` refuses servers that are not configured). Deleted personas stay in the trash for `personas.trashRetentionDays` (30 days by default); `ironcurtain persona trash list|restore|purge` manages it.

### Using Personas in the Mux

In command mode, `/new` without arguments opens a **persona picker** that lists all available personas with their compilation status. You can also specify a persona directly:

```
/new exec-assistant
```

Sessions launched with a persona use that persona's compiled policy and model, and get their own isolated memory database. A persona's resource limits do not apply to mux tabs, which use the global limits.

## Session Resume

The mux can resume previous Docker agent sessions. Use `/resume` in command mode to open a **resume picker** showing all resumable sessions, or provide a session ID prefix directly:

```
/resume a3f2
```

This attaches to the existing container and reconnects the PTY, escalation handling, and audit logging.

## Memory

When a persona (or cron job) session has memory enabled, IronCurtain injects a memory MCP server into the session. The memory server provides tools for the agent to store and recall information across sessions, backed by a per-persona SQLite database at `~/.ironcurtain/personas/<name>/memory.db`.

Memory is configured in `~/.ironcurtain/config.json`:

```json
{
  "memory": {
    "enabled": true,
    "autoSave": true,
    "offlineModels": false
  }
}
```

When `autoSave` is enabled, the agent stores a summary of the session in memory when the session ends. Memory is only available for persona and cron job sessions, not ad-hoc default sessions, and not for shared-container workflows. The memory server downloads its models (about 135 MB) on first use; `ironcurtain memory prefetch` does that ahead of time. Memories that cron jobs and workflows write wait for your review before interactive sessions see them: `ironcurtain memory <persona> review`. See [CONFIG.md](CONFIG.md#memory) for the LLM settings.

## OAuth Authentication

IronCurtain supports OAuth for both LLM provider authentication and third-party MCP server credentials.

### LLM Provider OAuth

OAuth tokens for Claude Code are auto-detected from `~/.claude/.credentials.json` and preferred over API keys. The MITM proxy swaps the fake sentinel key for the real OAuth token on the host side — the real credential never enters the container. Override with `IRONCURTAIN_DOCKER_AUTH=apikey` to force API key mode.

### Third-Party OAuth (MCP Servers)

For MCP servers that require OAuth (e.g., Google Workspace), use `ironcurtain auth`:

```bash
# Import OAuth client credentials from your provider (validated before it replaces stored credentials)
ironcurtain auth import google ~/Downloads/credentials.json

# Authorize (opens browser for OAuth flow)
ironcurtain auth google

# Authorize on a headless host: prints the URL; paste back the redirected 127.0.0.1 URL
ironcurtain auth google --no-browser

# Check authorization status for all providers
ironcurtain auth status

# Revoke a stored token
ironcurtain auth revoke google
```

Tokens are stored locally and refreshed automatically. `auth revoke` deletes the stored token only when the provider confirms the revocation (or reports the token already invalid); otherwise it keeps the token, says so, and exits 1 (revoke it by hand at https://myaccount.google.com/permissions). You can request additional scopes with `--scopes`:

```bash
ironcurtain auth google --scopes gmail.send,calendar.events
```

## Proxy MCP Server

Inside Docker Agent Mode, the agent has access to a virtual `proxy` MCP server that lets it manage network access at runtime. Since the container runs with no network egress, all internet traffic goes through IronCurtain's MITM proxy which maintains a domain allowlist.

The proxy server exposes three tools:

- **`add_proxy_domain`** — Request access to an additional host: `api.example.com` (port 443) or `api.example.com:80`. The agent must provide a justification, and the request is escalated for human approval before the host is added. This escalation is human-only: never auto-approved, never whitelisted, and left pending by `/approve all`.
- **`remove_proxy_domain`** — Remove a previously approved dynamic domain from the allowlist; live tunnels to it are torn down. Auto-allowed (reduces attack surface).
- **`list_proxy_domains`** — List all currently accessible destinations as `host:port` (both built-in provider domains and dynamically added ones). Auto-allowed (read-only).

These tools go through normal policy evaluation and audit logging. Adding a domain always requires human approval via the escalation flow.

### What "passthrough" means

Dynamically added domains are fundamentally different from built-in LLM provider domains:

|                         | Provider domains                      | Passthrough domains                               |
| ----------------------- | ------------------------------------- | ------------------------------------------------- |
| **Credential handling** | Fake-to-real key swap (MITM)          | No credential injection                           |
| **Content inspection**  | Endpoint filtering, request rewriting | None                                              |
| **Supported protocols** | HTTPS only (specific API paths)       | HTTPS and `wss://` on 443; HTTP and `ws://` on 80 |
| **Persistence**         | Permanent (configured at startup)     | Session-scoped (cleared on exit)                  |

An approval covers one host on one port. On port 443 the proxy relays a raw TLS tunnel, but only after the TLS ClientHello names the approved host (clients without SNI, or with Encrypted Client Hello, cannot use approved domains). On port 80 it relays HTTP, including `ws://` upgrades, with the `Host` header pinned to the approved host. A port-443 tunnel closes after 10 minutes without traffic, a port-80 tunnel after 15 minutes.

### Security considerations

Approving a domain gives the agent **unmediated network access** to that host. Before approving:

- **Check the domain** — Is it the domain the agent actually needs, or a look-alike?
- **Consider the data** — What sandbox data could the agent exfiltrate to this domain?
- **Scope narrowly** — Approve specific domains (`api.weather.com`), not broad services

Domains are session-scoped and never persisted. A new session starts with only the built-in provider domains. See [SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md) Section 2b-i for the full threat analysis. As an opt-in alternative, `egressPolicy` lets the session's policy decide every other destination, with an allowlist and one escalation per host and port (see [CONFIG.md](CONFIG.md#security)).

### Input validation

The proxy rejects domains before they reach the policy engine:

- IP addresses in any spelling (`192.168.1.1`, `127.1`, `0x7f.1`)
- `localhost`, `*.docker.internal`, and local or metadata-scoped names (`*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, `metadata.google.internal`, ...)
- Domains exceeding 253 characters
- Invalid domain format (missing TLD, illegal characters)
- Ports other than 443 and 80

## Package Installation Proxy

IronCurtain mediates package installations (npm, PyPI, crates.io, Debian APT) inside the Docker container through a registry proxy. This provides supply-chain security by validating packages before allowing downloads:

- **Denylist** — Blocked packages are always rejected.
- **Allowlist** — Explicitly allowed packages bypass the age gate.
- **Age gate** — New package versions must age for a configurable quarantine period (default: 2 days) before they are auto-allowed. This protects against supply-chain attacks that publish malicious versions. A version whose publish time is unknown is refused.

Both lists accept glob patterns, and the denylist wins. Configure in `~/.ironcurtain/config.json` (file-only; see [CONFIG.md](CONFIG.md#security)):

```json
{
  "packageInstall": {
    "enabled": true,
    "quarantineDays": 2,
    "allowedPackages": ["lodash", "express"],
    "deniedPackages": ["malicious-pkg"]
  }
}
```

The registry proxy is read-only: it forwards only `GET` and `HEAD` requests on each registry's allowlisted routes and strips client credentials. Agents cannot publish packages or use registry accounts from a Docker session; `npm audit` and `npm whoami` fail with 403, and containers set `NPM_CONFIG_AUDIT=false` and `NPM_CONFIG_FUND=false`. Every forwarded or refused request is logged to `package-audit.jsonl`.

## Tab Management

The mux supports multiple concurrent agent sessions:

| Command                               | Description                                           |
| ------------------------------------- | ----------------------------------------------------- |
| `/new`                                | Open persona picker / spawn session                   |
| `/new <persona>`                      | Spawn session with a specific persona                 |
| `/new [persona] --task-scoped <task>` | Spawn a session whose calls outside the task escalate |
| `/resume`                             | Open resume picker for past sessions                  |
| `/resume <id>`                        | Resume a session by ID prefix                         |
| `/tab N`                              | Switch to tab N                                       |
| `/close`                              | Close the current tab                                 |
| `/close N`                            | Close tab N                                           |
| Alt-1..9                              | Quick-switch to tab 1-9 (any mode)                    |

The tab bar at the top shows all sessions. The active tab is highlighted. While escalations are pending, a `[!N pending]` badge at the right end of the tab bar counts them across all tabs.

## Workflow Example

A typical development session:

```bash
# Start the mux
ironcurtain mux

# You're now in Claude Code's TUI (PTY mode).
# Type your task directly — Claude Code processes it normally.

# Claude Code tries to git push → policy escalates.
# You hear a bell, see the badge in the tab bar and the footer banner.

# Option A: Press Ctrl-E to open the escalation picker.
# Navigate with the arrow keys; once the request has been shown for a second,
# press 'a' to approve or 'w' then 'y' to approve and whitelist.

# Option B: Press Ctrl-A to enter command mode.
/approve 1

# Option C: Trusted input (also tells the auto-approver)
# In command mode, type: push my changes to origin
# This writes trusted context AND forwards to Claude Code.
# The auto-approver sees the trusted intent and approves automatically.

# Press Ctrl-A or Escape to return to PTY mode.
```

## Legacy Raw PTY Mode

Raw PTY mode remains available for low-level debugging with a separate escalation listener, but it is not the recommended interactive workflow:

```bash
# Terminal 1 — agent session
ironcurtain start --pty

# Terminal 2 — escalation handling
ironcurtain escalation-listener
```

This workflow does not support trusted input or auto-approval for PTY sessions. Use `ironcurtain mux` for normal interactive work. In the listener, `/approve all` (and `/approve+ all`, `/approve group N`) prints every escalation it would approve and a 6-character code; typing the command again with that code (`/approve all <code>`) approves only while exactly that set is still pending.

## Keyboard Reference

| Key      | PTY Mode               | Command Mode                          |
| -------- | ---------------------- | ------------------------------------- |
| Ctrl-A   | Enter command mode     | Return to PTY mode                    |
| Ctrl-E   | Open escalation picker | —                                     |
| Escape   | —                      | Discard input, return to PTY mode     |
| Enter    | (forwarded to PTY)     | Execute command or send trusted input |
| Ctrl-C   | (forwarded to PTY)     | Clear input buffer                    |
| Alt-1..9 | Switch to tab 1-9      | Switch to tab 1-9                     |
| Ctrl-\   | Graceful shutdown      | Graceful shutdown                     |

## Troubleshooting

| Issue                            | Guidance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"node-pty not available"**     | Install the build tools (Linux: `python3`, `make`, `g++`). If `node-pty` is missing, reinstall: `npm install -g @provos/ironcurtain --allow-scripts=isolated-vm,node-pty` (`npm install` in a checkout). If it is installed but does not load, rebuild it: `npm rebuild -g node-pty --allow-scripts=node-pty --ignore-scripts=false` (`npm rebuild node-pty --ignore-scripts=false` in a checkout). Do not run `npm install node-pty`. `ironcurtain doctor` reports which case applies. |
| **"Listener already running"**   | Only one escalation-listener can run at a time (the mux does not take this lock). Check for an existing listener process; a dead process's lock at `~/.ironcurtain/escalation-listener.lock` is reclaimed automatically. While a listener runs, the mux leaves escalations of sessions it did not start to it.                                                                                                                                                                          |
| **Picker ignores my keys**       | Decision keys count only once the request has been on screen in full for about a second; any earlier key restarts the wait. Enlarge the terminal if the picker shows a "too small" notice.                                                                                                                                                                                                                                                                                              |
| **Auto-approve not working**     | Ensure `autoApprove.enabled` is `true` in config and that its model has an API key. Use command mode (Ctrl-A) to type input — PTY-mode keystrokes are untrusted. Name the resource in your message (the path, host or remote), and act within 120 seconds.                                                                                                                                                                                                                              |
| **Terminal garbled after exit**  | Run `reset` to restore normal terminal mode.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Session discovery timeout**    | Docker startup can take 10+ seconds. The mux retries discovery via registry polling. If sessions don't appear, check `docker ps` and the PTY registry at `~/.ironcurtain/pty-registry/`.                                                                                                                                                                                                                                                                                                |
| **Persona not compiled / stale** | Run `ironcurtain persona compile <name>` before launching a session with that persona. The mux warns if a selected persona has no compiled policy.                                                                                                                                                                                                                                                                                                                                      |
| **Memory not saving**            | Memory requires a persona or cron job session context. Ad-hoc sessions (no persona) and shared-container workflows do not get a memory server. Check that `memory.enabled` is `true` in config and that the persona enables memory.                                                                                                                                                                                                                                                     |

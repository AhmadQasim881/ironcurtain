# Use Case Strategy & Tracer Bullet Roadmap

> **Status (2026-11-14):** Brainstorm and roadmap record, kept for its reasoning. Most of the tracer bullets and the whole Parking Lot have shipped since it was written; the status notes below say which. [`docs/MISSING_FEATURES.md`](MISSING_FEATURES.md) is the source of truth for what is implemented and what is missing.

This document captures our analysis of which use cases IronCurtain should target and the feature sequence to get there.

## Target Use Cases

### Near-Term: Autonomous Dev/DevOps

A developer instructs IronCurtain (from their phone, via a messaging interface) to fix a bug, run tests, and push a PR — and the agent does it safely, unable to `rm -rf` or push to production without approval.

**Why this first:**

- **Architectural fit.** IronCurtain already does filesystem containment with a policy engine that prevents destructive operations. Adding `exec` and `git` tools extends this naturally. Every other use case requires fundamentally new infrastructure (OAuth, scheduling, external APIs).
- **Security story writes itself.** The two threats users fear most — accidental destruction (`rm -rf *`) and runaway loops burning API credits — map directly to defenses IronCurtain already has (structural invariants, StepLoopDetector, CallCircuitBreaker).
- **Users are the audience.** IronCurtain is a developer tool. Its first users will be developers. The "fix a bug from your phone" demo is the most visceral proof of value.
- **Stepping stone.** The infrastructure built here (multi-server onboarding, exec containment, resource budgets, messaging transport) is exactly what the Second Brain needs, without requiring OAuth or third-party API dependencies.

### North Star: "Second Brain" / Executive Assistant

A unified interface for morning briefs, inbox triage, calendar management, and proactive nudges — delivered via messaging. The agent aggregates data from email, calendar, and web, synthesizes it, and delivers actionable intelligence.

**Why not first:**

- Requires OAuth token management (Google, Gmail)
- Requires scheduling/cron infrastructure
- Requires multiple external API integrations
- Requires a messaging delivery platform

Each is a significant investment. The DevOps path builds the shared plumbing without these dependencies.

## The Cross-Cutting Security Argument

Every use case in the ecosystem has an "undesired side effect" that is fundamentally a policy enforcement problem — IronCurtain's reason for existing:

| Use Case | Threat | IronCurtain Defense |
|---|---|---|
| DevOps | `rm -rf *` | Exec sandbox containment (Tier 2) — only destroys ephemeral sandbox |
| DevOps | Infinite fix loops | StepLoopDetector + CallCircuitBreaker |
| Inbox Zero | Prompt injection via email | LLM assessment rules (TB5) |
| Content Factory | Publishing offensive content | Per-task policy (TB4) |
| Smart Home | Lateral movement from compromised agent | Sandbox containment + escalation |
| All | Runaway API costs | Resource budgets (TB2) |

## The Exec Problem and Execution Containment

Adding shell/exec capability is essential for DevOps use cases but introduces a fundamental challenge: **a general exec tool is a policy escape hatch.**

If the agent can write a file and then execute it, it achieves arbitrary code execution through indirection. The policy engine sees `run_tests(project_path: "/sandbox/repo")` — legitimate arguments — but the malicious payload is in file content the agent wrote in a previous step. The policy engine never connects the two.

This generalizes: **any tool that interprets content the agent has written is an indirect exec.** Test runners, build tools, script interpreters — all are `exec` with extra steps.

### Two Distinct Security Layers

This means IronCurtain needs two defense layers, not one:

1. **Policy inspection** (what IronCurtain does today) — structured argument checking, path containment, allow/deny/escalate. Works for tools with inspectable, semantic arguments.

2. **Execution containment** — restricting what side effects a running process can have. Filesystem scope, network blocking, resource limits. This is the OS-level sandbox model.

The policy engine catches unauthorized tool usage and enforces semantic rules ("no deletes outside sandbox"). Execution containment catches everything else — compromised MCP servers, path traversal bugs, network exfiltration, fork bombs.

### Sandboxing Landscape

Industry has converged on **OS-primitive sandboxing** for local CLI tools (not containers):

| Approach | Linux | macOS | Windows | Notes |
|---|---|---|---|---|
| **bubblewrap** (namespaces) | Yes | No | No | Used by Claude Code, Flatpak |
| **Seatbelt** (sandbox-exec) | No | Yes | No | Used by Claude Code, Codex CLI |
| **Restricted tokens + Job Objects** | No | No | Partial | Used by Codex CLI (experimental) |
| **Docker/Podman** | Yes | Via VM | Via VM | Too heavy as a dependency for CLI tools |
| **Node.js --permission** | Yes | Yes | Yes | Not a security boundary (bypassed by native addons) |
| **Wasm runtimes** | Yes | Yes | Yes | Can't run arbitrary shell/Node.js code |

### `@anthropic-ai/sandbox-runtime`

Anthropic open-sourced their sandboxing as an npm package ([`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)). Key characteristics:

- **Platforms:** Linux (bubblewrap + seccomp-bpf) and macOS (Seatbelt). No Windows yet.
- **Filesystem:** Deny-read lists + allow-write lists. Hardcoded protection for dangerous files (`.gitconfig`, `.bashrc`, `.git/`). Symlink-escape prevention.
- **Network:** Proxy-based domain filtering (HTTP proxy + SOCKS5). On Linux, `--unshare-net` creates an isolated network namespace; only socat-bridged Unix sockets reach the proxies.
- **API model:** `SandboxManager.wrapWithSandbox(command)` returns a transformed command string — the caller spawns the process. stdio passes through transparently.
- **Singleton:** One network configuration per Node.js process. Different MCP servers needing different network policies must be separate `srt` processes.
- **Status:** Research preview (Apache-2.0). APIs may change.

See "How sandbox-runtime and IronCurtain Complement Each Other" below for detailed interaction analysis.

## Tracer Bullet Sequence

Each tracer bullet is an independently shippable thin slice. Each builds infrastructure the North Star needs.

```
DevOps Use Case (immediate)          Second Brain (future)
         |                                    |
    TB0: Execution Containment ✓ ------------ |
    TB1: Multi-Server ✓ (no exec server) ---- |
    TB2: Resource Budgets ✓ ----------------- |
    TB3: Messaging Transport (Signal) ✓ ----- |
    TB4: Per-Task Policy ✓ ------------------ |
    TB5: LLM Assessment (partial) ----------- |
                                              |
                                    + OAuth/API integration ✓
                                    + Scheduling/cron ✓
                                    + Multi-agent coordination ✓
```

Status 2026-11-14 (✓ = shipped). The shell/exec server of TB1 was never built: Docker Agent Mode runs agents with a shell inside a network-isolated container instead (`src/docker/`).

### TB0: Execution Containment (sandbox-runtime Integration)

**Prerequisite for any exec capability.**

**Goal:** Integrate `@anthropic-ai/sandbox-runtime` so that MCP servers that execute opaque code run inside OS-level sandboxes. This provides the hard containment layer that makes adding exec-like tools safe.

**What this gives us:**
- Filesystem containment at the kernel level (backstop for policy engine)
- Network isolation (MCP servers can't phone home)
- Process isolation (fork bombs, resource abuse contained)
- Transparent to MCP protocol (stdio passes through sandbox wrapper)

**Integration point:** `MCPClientManager` wraps server spawn commands with `SandboxManager.wrapWithSandbox()` before creating `StdioClientTransport`. Sandbox wrapping is **opt-out per server** in `mcp-servers.json`.

**What it does NOT give us (IronCurtain still needed for):**
- Semantic tool-call decisions (allow/deny/escalate based on argument roles)
- Human-in-the-loop escalation
- Per-task policy scoping
- Audit trail of policy decisions
- Multi-role argument evaluation

#### Sandbox-by-Default with Opt-Out

Not all MCP servers benefit from OS sandboxing. Servers fall into two categories:

**Mediated servers** — every operation is a structured MCP tool call fully inspected by the policy engine. The policy engine IS the security boundary. OS sandboxing adds overhead and can conflict with dynamic features like MCP Roots (where escalation approval expands allowed directories at runtime — the sandbox's static `allowWrite` list would be stale the moment a new root is approved).

**Exec-like servers** — they run opaque code the agent may have written (test runners, build tools, script interpreters). The policy engine can inspect the tool call arguments (`run_tests(project: "/repo")`) but cannot see what happens during execution. These need OS-level containment.

Configuration in `mcp-servers.json` (as proposed at the time; status 2026-11-14: the shipped filesystem server runs `node` on the exactly pinned package in `node_modules`, never `npx`, and is sandboxed and confined to its roots, see `src/config/mcp-servers.json`):

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["@modelcontextprotocol/server-filesystem", "/sandbox"],
    "sandbox": false
  },
  "exec": {
    "command": "node",
    "args": ["./servers/exec.js"],
    "sandbox": {
      "allowWrite": ["/sandbox"],
      "denyRead": [],
      "network": false
    }
  },
  "git": {
    "command": "node",
    "args": ["./servers/git.js"],
    "sandbox": {
      "allowWrite": ["/sandbox/.git", "/sandbox"],
      "network": { "allowedDomains": ["github.com", "*.github.com"] }
    }
  }
}
```

Default when `"sandbox"` is omitted: **sandboxed** with restrictive defaults (write only to session sandbox, no network). Servers must explicitly opt out with `"sandbox": false`.

**Demo:** Agent writes a test file containing a `curl` exfiltration attempt, then calls `exec` to run `npm test`. Policy allows the exec call (the agent is permitted to run commands for this task). The test executes but `curl` fails — the network namespace is isolated. `rm -rf /` would only destroy ephemeral sandbox contents. Meanwhile, the filesystem server runs without sandbox overhead and MCP Roots expansions work dynamically.

> **Status (2026-11-14):** TB0 shipped (`src/trusted-process/sandbox-integration.ts`, `docs/designs/execution-containment.md`). Two things changed since this plan: the filesystem server is now sandboxed too, confined to its MCP roots and restarted when they change, because it was open to a symlink-swap race (`docs/designs/filesystem-server-confinement.md`); and `sandboxPolicy: "enforce"` (the default on Linux and macOS) keeps a server that needs a sandbox from starting when the sandbox tools are missing.

**Dependencies:** None. This is the new starting point.

### TB1: Multi-Server Foundation (Easy MCP Onboarding)

**From:** MISSING_FEATURES.md — "Easy MCP Server Onboarding"

**Goal:** Add new MCP servers alongside filesystem and prove the onboarding workflow.

#### Two-Tier MCP Security Model

Not all tools benefit equally from structured argument inspection. MCP servers fall into two tiers based on whether their operations are semantically inspectable:

**Tier 1: Semantic inspection (purpose-built MCPs)** — for tools where structured arguments give the policy engine real leverage. Git is the ideal example: the policy engine can distinguish `git_push` from `git_status`, require escalation for pushes, inspect the remote URL, and enforce branch restrictions. The arguments are inherently structured and meaningful.

**Tier 2: Containment-first (general exec in strict sandbox)** — for everything else. There are too many test frameworks, build systems, linters, and formatters to build individual MCPs for each (jest, vitest, pytest, go test, cargo test, make, etc.). A generic `run_tests(framework, path)` abstraction would be so thin it's basically exec with a veneer. Instead, use a general shell/exec MCP inside a strict OS sandbox: no network, filesystem restricted to the session sandbox. The sandbox IS the security boundary. If `rm -rf /` runs, it only destroys ephemeral sandbox contents.

The policy engine still adds value for exec — it's the gatekeeper that decides *whether* the agent gets to run a command at all (per-task policy can say "this task may not execute commands"), and it audits every invocation. It just doesn't pretend to understand what `npm test -- --coverage` will do internally.

The only path to persist work outside the sandbox is through Tier 1 tools (git push, filesystem write) — both of which are semantically inspectable and escalation-gated.

**New servers:**
- **git** (Tier 1) — purpose-built MCP with tools like `git_status(repo)`, `git_commit(repo, message)`, `git_push(repo, remote, branch)`. Each argument has a clear role the policy engine can evaluate. Sandboxed with selective network access to git remotes.
- **shell/exec** (Tier 2) — general command execution MCP. Sandboxed with strict containment: no network, filesystem restricted to session sandbox directory. Policy engine gates access and audits commands but relies on the sandbox for containment.
- **web fetch** (Tier 1) — HTTP requests with inspectable URL arguments. Sandboxed with selective network access to allowed domains.

**What this forces us to solve:**
- Streamlined onboarding: add config → auto-annotate tools → recompile policy → validate coverage
- Constitution updates for new tool categories and the two-tier model
- Policy engine handling multiple servers with different risk profiles
- Per-server sandbox configuration (git: selective network; exec: no network; filesystem: no sandbox)

**Demo:** Agent uses filesystem to read code, exec to run `npm test`, git to commit and push a fix — with policy requiring escalation for `git_push`, sandbox preventing network exfiltration from test execution, and `rm -rf /` inside exec only destroying ephemeral sandbox contents.

**Dependencies:** TB0 (exec containment must be in place before adding the shell/exec server).

> **Status (2026-11-14):** Implemented apart from the shell/exec server. The shipped servers are filesystem, git (`@cyanheads/git-mcp-server`), fetch (with web search), github and google-workspace (`src/config/mcp-servers.json`), and `ironcurtain mcp add|remove|list` adds a server, annotates it and recompiles the policy in one flow (`docs/designs/user-mcp-servers.md`). Command execution happens in Docker Agent Mode instead.

### TB2: Resource Budget Enforcement

**From:** MISSING_FEATURES.md — "Resource Budget Enforcement"

**Goal:** Token counting, API call limits, and wall-clock timeouts per session. Kill the agent when any budget is exhausted.

**Implementation hook:** AI SDK's `onStepFinish` callback for token tracking. Session-level budget object with configurable limits.

**What this addresses:**
- "Infinite fix loops consuming API credits" (DevOps use case)
- Morning Brief cost concerns ($0.10-$0.30/day adds up)
- Any runaway agent scenario

**Demo:** Agent hits token budget mid-task, gracefully stops, reports what it accomplished and what remains.

**Dependencies:** None (can be done in parallel with TB1).

> **Status (2026-11-14):** Implemented: tokens, steps, wall clock and estimated cost (`resourceBudget`), per turn for builtin sessions (`src/session/resource-budget-tracker.ts`) and enforced at the MITM proxy per agent container for Docker agents (`src/docker/budget-gate.ts`).

### TB3: Messaging Transport (Signal) — **IMPLEMENTED**

**From:** MISSING_FEATURES.md — "Remote Access / Messaging Integration"

**Goal:** ~~Implement a `TelegramTransport` alongside `CliTransport`.~~ Implemented as `SignalSessionTransport` with a persistent `SignalBotDaemon`.

**Why Signal over Telegram:** End-to-end encryption aligns with IronCurtain's security ethos. No centralized bot API means no third-party trust dependency for message content. The brainstorm originally proposed Telegram for simplicity, but Signal was chosen for stronger security guarantees.

**What was built:**
- **Pluggable Transport abstraction** (`src/session/transport.ts`) — `Transport` interface with `run(session)` / `close()`, used by both `CliTransport` and `SignalSessionTransport`
- **Signal bot daemon** (`src/signal/signal-bot-daemon.ts`) — persistent WebSocket listener, session lifecycle management, escalation state machine, control commands (`/quit`, `/new`, `/budget`, `/help`)
- **Signal session transport** (`src/signal/signal-transport.ts`) — ephemeral adapter implementing `Transport`, 1:1 with a Session
- **Docker-managed signal-cli** (`src/signal/signal-container.ts`) — `signal-cli-rest-api` container with health checks and persistent registration data (status 2026-11-14: no Docker restart policy; the daemon manages the container's lifecycle)
- **Markdown-to-Signal conversion** (`src/signal/markdown-to-signal.ts`) — converts agent markdown to Signal's styled text (bold, italic, monospace, strikethrough)
- **Escalation over Signal** — formatted banners with text-based approve/deny, race condition prevention, expiration handling (status 2026-11-14: a reply must name the code shown in the escalation's banner, `approve <code>`)
- **Identity verification** — fail-closed approach checking Signal identity keys to prevent SIM swap attacks, TTL-based proactive checks
- **Message splitting** — long responses split at paragraph boundaries (Signal's 2,000-char limit)
- **Interactive setup wizard** (`ironcurtain setup-signal`) — registration or device linking, captcha handling, identity key capture
- **CLI entry point** (`ironcurtain bot`) — starts the persistent daemon

**What this proved:**
- The Transport interface design works for non-CLI targets
- Escalation UX translates to messaging (text-based approve/deny, no inline buttons needed)
- Remote interaction is viable and secure with E2E encryption
- Session lifecycle can be managed remotely (create/destroy via commands)

**Demo:** Developer sends a task via Signal, receives formatted results, approves a `git push` by replying "approve" (now "approve <code>") — all E2E encrypted.

**Dependencies:** TB1 (needs exec/git servers to be useful for DevOps scenario).

### TB4: Per-Task Policy Generation

**From:** MISSING_FEATURES.md — "Per-Task Policy Generation" (highest-value missing piece)

**Goal:** When a task arrives, an LLM generates a scoped policy restricting tools and paths to what's relevant.

**Example:** "Fix the retry logic in payment-service.ts" generates:
- Allow: filesystem read/write in the repo directory, exec for `npm test` and `git` commands
- Deny: exec for anything else, filesystem outside the repo
- Escalate: `git push`, any write to config files

**Architecture:** The policy engine already supports rule-chain evaluation. Task policy is a second chain checked before the constitution.

**What this addresses:**
- Least-privilege enforcement per task
- Prevents scope creep (agent fixing a bug can't also delete SSH keys)
- Foundation for multi-agent isolation (each agent gets scoped policy)

**Demo:** Two tasks — "organize my documents" and "fix the build" — generate visibly different policy scopes. Agent attempting to exceed scope gets denied.

**Dependencies:** TB1 (needs multiple servers to make scoping meaningful).

> **Status (2026-11-14):** Implemented in two forms. Cron jobs compile a task policy that replaces the global policy (`src/cron/compile-task-policy.ts`). `ironcurtain start`, mux `/new` and `ironcurtain workflow start` accept an opt-in `--task-scoped`; unlike the "second chain checked before the constitution" above, the task scope is intersected with the session policy after it, and an out-of-scope call that the session policy allows escalates rather than being denied (`docs/designs/task-scoped-sessions.md`).

### TB5: LLM Assessment Rules (Semantic Checks)

**From:** MISSING_FEATURES.md — "LLM Assessment Rules"

**Goal:** New `assess` rule outcome triggers LLM evaluation of content. Start with two checks:
- **Intelligibility check:** Deny outbound content that appears encoded/obfuscated (anti-exfiltration)
- **Scope drift check:** Flag when agent actions diverge from the stated task

**What this enables:**
- Bridge between static rules and human escalation
- Prompt injection defense (critical for Second Brain email processing)
- Exfiltration detection (agent trying to base64-encode and write sensitive data)

**Demo:** Agent processes a file containing a hidden prompt injection attempt. Assessment rule catches it before execution.

**Dependencies:** TB4 (task context needed for scope drift detection).

> **Status (2026-11-14):** Partial. The `assess` rule outcome exists, opt-in: deterministic detectors plus an optional LLM intelligibility check examine outbound content, and content that fails escalates to a human rather than being denied (`docs/designs/outbound-content-assessment.md`). There is no scope drift check, and nothing assesses inbound content for prompt injection.

## How sandbox-runtime and IronCurtain Complement Each Other

### They Operate at Different Layers

| Aspect | IronCurtain PolicyEngine | sandbox-runtime |
|---|---|---|
| **Layer** | Application (MCP protocol) | OS (kernel syscalls) |
| **Inspects** | Structured tool call arguments (tool name, paths, roles) | Raw syscalls (file open, socket create, network connect) |
| **Granularity** | Per-tool-call with semantic understanding | Per-process (all operations get same restrictions) |
| **Enforcement** | MCP proxy intercepts JSON-RPC, evaluates, forwards or blocks | Kernel enforces (Seatbelt / bwrap namespaces / seccomp-bpf) |
| **Escalation** | Three-state: allow / deny / escalate (human-in-the-loop) | Two-state: allow / deny (no escalation concept) |
| **Bypass resistance** | MCP server could make raw syscalls to bypass | Kernel-level; no bypass from within the sandbox |

### What Each Layer Catches

**IronCurtain catches** (sandbox-runtime cannot):
- Unauthorized tool usage based on semantic context (task scope, user intent)
- Escalation-worthy operations requiring human approval
- Multi-role argument evaluation (e.g., `move_file` where source is read-path, destination is write-path)
- Policy violations before the tool call reaches the server (faster, clearer error messages)
- Audit trail with structured decision records

**sandbox-runtime catches** (IronCurtain cannot):
- Direct OS-level bypass if an MCP server is compromised
- Server-internal operations not mediated by MCP (temp files, config reads, internal network calls)
- Network exfiltration (MCP server phoning home)
- Fork/exec attacks within the MCP server process
- Symlink race conditions at the OS level (TOCTOU between policy check and actual file operation)
- The indirect-exec problem (agent writes malicious test file, then runs it)

### Integration Architecture

```
Agent (LLM)
  |
Code Mode Sandbox (V8 isolate)
  |
MCP Proxy (IronCurtain PolicyEngine — semantic allow/deny/escalate)
  |
sandbox-runtime wrapper (OS-level containment — hard filesystem/network/process boundary)
  |
MCP Servers (filesystem, git, test runner, etc.)
```

### Configuration Alignment

The two layers must be configured consistently:

- sandbox-runtime's `allowWrite` paths should be a **superset** of IronCurtain's `ALLOWED_DIRECTORY`. Otherwise, policy-allowed operations fail at the OS level with opaque EPERM errors.
- sandbox-runtime's `denyRead` should not block paths that policy-allowed read operations need.
- When policy allows a tool call but the sandbox blocks it, the MCP server gets an OS error (not a structured policy denial). The audit log shows "allowed by policy, failed in execution" — an important distinction for debugging.

### Per-Server Sandbox Profiles

Not every MCP server needs OS sandboxing. The key distinction:

- **Mediated servers** (e.g., filesystem) — every operation passes through structured MCP tool calls that the policy engine fully inspects. Sandboxing adds overhead and conflicts with dynamic features like MCP Roots (where escalation approval expands allowed directories at runtime, but the sandbox's static `allowWrite` is stale). These opt out of sandboxing.
- **Exec-like servers** (e.g., test runner, build tools) — they execute opaque code the agent may have written. Policy inspects arguments but can't see execution side effects. These need OS containment.

For sandboxed servers, each gets a tailored profile:

Status 2026-11-14: the shipped configuration differs from this table. The filesystem server is sandboxed (confined to its MCP roots), git and google-workspace are sandboxed with domain allowlists, fetch runs without `srt` (it guards its own connections, `src/servers/guarded-fetch.ts`), the github server runs in Docker, and there is no exec server.

| Server | Tier | Filesystem | Network | Sandboxed? |
|---|---|---|---|---|
| filesystem | 1 (semantic) | Policy-engine mediated | None | **No** — fully mediated, MCP Roots needs dynamic paths |
| git | 1 (semantic) | Read: repo. Write: repo + `.git/`. | Outbound to git remotes | Yes — with selective network |
| exec | 2 (containment) | Read: broad. Write: sandbox only. | **None** | Yes — strict containment |
| web fetch | 1 (semantic) | Read: none. Write: none. | Outbound to allowed domains | Yes — with selective network |

Since sandbox-runtime is a singleton per process, each sandboxed MCP server is a separate `srt`-wrapped process with its own profile. This aligns with how `MCPClientManager` already spawns each server as a separate child process. Unsandboxed servers are spawned directly as today.

## Open Questions

- ~~**Git MCP server?**~~ **Resolved: community server.** `@cyanheads/git-mcp-server`, pinned exactly in `package.json`, with IronCurtain's own annotations and a hardened git environment.
- ~~**Exec MCP server?**~~ **Resolved: not built.** Docker Agent Mode runs agents with a shell in a network-isolated container instead.
- ~~**Telegram vs Discord vs Matrix?**~~ **Resolved: Signal.** E2E encryption aligns with security ethos. Implemented via `signal-cli-rest-api` Docker container with identity verification. See `src/signal/`.
- ~~**Per-task policy granularity?**~~ **Resolved: a full compiled rule chain** from the task text, with the strict task-policy prompt (cron task policies and `--task-scoped`).
- ~~**Budget defaults?**~~ **Resolved:** 1M tokens, 200 steps, 30 minutes and $5 (`resourceBudget`; `null` disables a limit).
- **sandbox-runtime stability?** It's a "research preview" — do we vendor it, pin a version, or build our own thin wrapper over the same OS primitives?
- **Windows story?** Require WSL2 (where bubblewrap works), use Node.js `--permission` as a weaker fallback, or defer Windows support?
- **Error UX when sandbox blocks a policy-allowed call?** The agent sees an opaque OS error. Should IronCurtain detect this pattern and surface a clearer message?

## Parking Lot (Future Tracer Bullets)

These are needed for the Second Brain but not for DevOps. Status 2026-11-14: all five have shipped.

- **OAuth token lifecycle management** — Google, Gmail, GitHub tokens with refresh. Shipped: `ironcurtain auth` and `src/auth/` for third-party OAuth, with the proxy refreshing Google Workspace tokens (`src/trusted-process/token-file-refresher.ts`), and Claude OAuth for Docker agents (`src/docker/oauth-token-manager.ts`). GitHub uses a personal access token.
- **Scheduling/cron** — trigger agent runs on schedule. Shipped: `ironcurtain daemon` with cron jobs (`src/cron/`).
- **Multi-agent coordination** — multiple concurrent sessions with independent policies. Shipped: concurrent daemon and mux sessions, personas, and multi-agent workflows (`src/workflow/`).
- **Audit log analysis** — CLI reports on decisions, tools, denials, patterns. Shipped: `ironcurtain audit report` (`src/audit/`).
- **Runtime integrity checks** — constitution hash verification at startup. Shipped: `checkConstitutionFreshness()` plus load-time policy provenance and schema checks (`src/config/policy-provenance-check.ts`).

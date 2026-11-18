# Missing Features & Future Tracer Bullets

**Last verified against the code:** 2026-11-14.

This file is the source of truth for what IronCurtain implements and what is still missing. The vision documents (`docs/secure-agent-runtime-v2.md`, `docs/brainstorm-use-cases.md`) and the design docs under `docs/designs/` record intent and history. Each design doc carries a dated Status line right under its title (`**Status (YYYY-MM-DD):**` followed by Implemented, Partial, Proposal, Superseded, Historical or Reserved; `test/design-doc-status.test.ts` enforces it, together with a pointer in that line in any document under `docs/` that still names removed code), and where any of them disagrees with this file, this file wins. In a design doc marked Implemented or Partial, links and heading anchors must resolve and the `ironcurtain` commands named in code spans, shell blocks and `$` prompt lines must exist (`test/user-docs.test.ts`). Every entry below carries one status:

- **Implemented**: shipped; the pointers name the code.
- **Partial**: some of it shipped; the gaps are listed.
- **Missing**: not built.
- **Deferred**: implementation awaits an owner decision.
- **Superseded**: replaced by the approach the entry names.
- **Reserved**: scaffolding exists, but no production path selects it and nothing about it is supported.

The WP numbers identify the work packages discussed below. Remaining gaps in shipped features are listed under [Open items](#open-items-after-the-2026-11-completion-effort) at the end.

## Deeper Security

### OS-Level Execution Containment (TB0) — **Implemented**

MCP servers that ask for an OS sandbox run under `@anthropic-ai/sandbox-runtime` (`srt`): bubblewrap and seccomp on Linux, Seatbelt on macOS, one `srt` process per server with its own filesystem and network profile (`src/trusted-process/sandbox-integration.ts`). In the shipped `src/config/mcp-servers.json`, the filesystem server (confined to its MCP roots, next entry), git and google-workspace are sandboxed; fetch runs without `srt`, and the github server runs in its own Docker container. Every sandboxed server gets a baseline read-deny list: the IronCurtain home, the relays' private scratch directory, the common credential stores (`BASELINE_CREDENTIAL_DENY_READ`: SSH private keys, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.kube/config`, the Claude and Codex login files, `~/.config/gh`, `~/.git-credentials`, `~/.docker/config.json`, `~/.npmrc`), the shell startup files where API keys are often exported (`~/.bashrc`, `~/.bash_profile`, `~/.bash_login`, `~/.profile`, `~/.zshrc`, `~/.zshenv`, `~/.zprofile` and `~/.config/fish`) and a `.env` left in IronCurtain's package root. Of the stores the policy engine protects, only `~/.netrc` and the rest of `~/.ssh` (its `config`, `known_hosts` and keys under other names) stay readable to a sandboxed server whose own `denyRead` does not name them, such as git (see [Open items](#open-items-after-the-2026-11-completion-effort)). On macOS, where srt lets a sandboxed server reach the Unix sockets it is granted, only the git server is granted the ssh-agent socket.

`sandboxPolicy` (`src/config/sandbox-policy.ts`) decides what happens when the sandbox cannot be provided (bubblewrap, socat or ripgrep missing, an unsupported platform, or srt unable to start a sandbox on the host, which one srt test run per process checks). `enforce`, the default on Linux and macOS, keeps that server from starting while the others keep running; `warn` starts it without containment and says so. It is set in `~/.ironcurtain/config.json`, in `ironcurtain config`, or with `IRONCURTAIN_SANDBOX_POLICY`; `ironcurtain doctor` checks the dependencies and runs srt. `annotate-tools`, `compile-policy` and `mcp add` start servers to list their tools the way sessions do: inside srt, with their stored credentials, under the same policy (`src/trusted-process/tool-listing-launch.ts`); the OAuth-backed google-workspace server is not started there. Design: `docs/designs/execution-containment.md`.

### Filesystem Server Confinement — **Implemented**

`@modelcontextprotocol/server-filesystem` checks a path and then reopens it by name, so an agent that can rename workspace entries (Docker mode) could swap a directory for a symlink in between. The server now runs under `srt` with only its MCP roots exposed (`"confineToRoots": true`), and its relay restarts it whenever the roots change (WP-11). Under `sandboxPolicy: "warn"` with the sandbox tools missing it runs unconfined, with a warning. Code: `src/trusted-process/roots-confinement.ts`. Design: `docs/designs/filesystem-server-confinement.md`.

### Per-Task Policy — **Implemented**

Two forms exist:

1. Cron jobs: `compileTaskPolicy()` (`src/cron/compile-task-policy.ts`) compiles the job's task constitution, which the job editor can draft from the task description (`src/cron/constitution-generator.ts`). The job's policy **replaces** the global policy for its runs. A job that runs as a persona (`persona`, which excludes a task constitution) uses the persona's policy instead.
2. Opt-in `--task-scoped` for `ironcurtain start`, mux `/new` and `ironcurtain workflow start`: the task text is compiled into a task scope that the policy engine **intersects** with the session policy. A call the session policy allows but the task scope does not cover escalates (rule `task-scope-escalate`). Code: `src/trusted-process/task-scope.ts`, `src/config/task-scope-policy.ts`. Design: `docs/designs/task-scoped-sessions.md`. Nothing is task-scoped by default.

### Sequence-Aware (Taint) Policy — **Partial**

Slice 1 is implemented as an opt-in (`taintEscalation.enabled`, default off): a monotonic per-session taint flag that is set when a taint-source tool runs, after which every sink call that policy does not deny must be decided by a human, one call at a time. Code: `src/trusted-process/taint-policy.ts`. Design: `docs/designs/sequence-aware-policy.md`.

Missing: session facts as predicates in compiled rules ("files this agent did not create", "after fetching from npm"), and any data-flow tracking finer than one flag per session.

### Role-Clustered Policy Compilation — **Superseded**

Superseded by per-server compilation (`docs/designs/per-server-policy-compilation.md`): `PipelineRunner` (`src/pipeline/pipeline-runner.ts`) compiles, verifies and caches each MCP server on its own. A change to one server's tool annotations recompiles only that server. Any edit to the constitution still invalidates every server's cache, because the per-server cache key covers the whole constitution (PIP-15(a), not done).

### Outbound Content Assessment (LLM Assessment Rules) — **Partial**

A compiled rule may end in `assess`: the call is allowed subject to an assessment of its outbound-content arguments (message and comment bodies, commit messages, fetched URLs); the compiler emits it for outbound-channel tools. The assessment is opt-in (`contentAssessment.enabled`, default off): deterministic detectors look for encoded blobs, high-entropy strings, ciphertext, invisible characters and oversized transfers, and content that fails escalates to a human, never silently allowed or denied. An LLM intelligibility check sits behind its own flag (`contentAssessment.llmCheck`, default off). Code: `src/trusted-process/assessment.ts`, `src/trusted-process/outbound-rules.ts`, `src/trusted-process/assessment-config.ts`. Design: `docs/designs/outbound-content-assessment.md`.

Missing: other semantic checks ("does this contain PII?", "is this sensitive financial information?").

### Egress Through the Policy Engine — **Partial**

Slice 1 is implemented as an opt-in (`egressPolicy.enabled`): with it on, every destination of a Docker agent other than the configured providers and package registries is decided by the session's policy engine, as a call to the virtual `network/request` tool (allow, deny or escalate, audited). Without the opt-in such a destination is admitted only as an approved passthrough target (a human approved its `host:port` through `add_proxy_domain`), or, when the host process runs with the deprecated `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS`, as a raw tunnel to any unknown host. That variable prints a deprecation warning and is ignored while the opt-in is on. Code: `src/trusted-process/egress-policy.ts`, `src/docker/mitm-proxy.ts`. Design: `docs/designs/mitm-egress-policy.md`; its section 10 lists what remains (provider and registry requests are still decided by their static filters, constitutions do not compile into `network` rules yet, only ports 443 and 80).

### Loop Detection / Anomaly Monitoring — **Implemented**

Two layers. `StepLoopDetector` (`src/session/step-loop-detector.ts`) watches the builtin agent's steps: stagnation warns at 3 and blocks at 5 repeats, "stuck" (different code, same error) warns at 5 and blocks at 8, and repeated benign outcomes (`null`, `'ok'`) warn at 15 and block at 25. Its state is reset at the start of every turn, so a block lasts for the rest of that turn. `CallCircuitBreaker` (`src/trusted-process/call-circuit-breaker.ts`) is a sliding-window rate limiter owned by the `ToolCallCoordinator`, keyed per workflow fan-out lane. Design: `docs/designs/loop-detection.md`.

### Resource Budget Enforcement — **Implemented**

Limits: tokens, steps, wall clock and estimated cost (`resourceBudget` in `~/.ironcurtain/config.json`; defaults 1M tokens, 200 steps, 1800 s, $5; `null` disables one). Cron jobs start from lower defaults (500k tokens, 100 steps, 3600 s, $2; `CRON_BUDGET_DEFAULTS` in `src/cron/types.ts`) with per-job overrides, and a persona or a workflow (`settings.resourceBudget`) can set its own. Their meaning depends on the mode:

- Builtin (Code Mode) sessions: every limit is per turn. `ResourceBudgetTracker` (`src/session/resource-budget-tracker.ts`) records each step and the auto-compaction summarizer's call (its tokens and cost count toward the turn, though not as a step), stops the AI SDK loop (`stopWhen`), aborts on the wall clock and pre-checks `execute_code`; exhaustion raises `BudgetExhaustedError`. Costs use the list prices in `src/llm-metrics/pricing.ts`; a prompt past a model's unlisted long-context tier (Sonnet 4.x above 200K tokens, for one) is charged twice the listed rates, as at the MITM.
- Docker Agent Mode: the MITM proxy enforces the token and cost limits mid-turn, per agent container (one standalone, cron or PTY session, or one shared-container workflow scope across all its states and lanes), on every completion request it forwards (`src/docker/budget-gate.ts`). Batch and workflow bundles refuse completion requests outside agent turns. The wall clock bounds each turn inside the container (`src/docker/turn-timeout.ts`). Between turns, cumulative tokens, steps and cost are checked on host-observed numbers only (`src/session/budget-admission.ts`); the agent's self-reported cost is display only.

Gaps: the auto-approver's and the memory server's LLM calls are not charged to any session budget; a resumed workflow starts its bundles with fresh budgets; a hostile agent with sudo can defeat the in-container timeout, so container teardown is the hard bound.

### Docker Agent Mode — **Implemented**

External agents run in containers without direct network access: `--network none` with Unix-socket proxies on Linux Docker and Apple `container`, and an `--internal` network whose socat sidecar forwards only the proxy ports on macOS Docker Desktop (`src/docker/network-topology.ts`). IronCurtain mediates their access through host-side MITM and MCP proxies. Adapters: Claude Code, Codex and Goose (`src/docker/adapters/`). Real API keys and OAuth tokens never enter the container; sentinel keys are swapped host-side. The MITM strips provider-hosted tools (web search, web fetch, code execution, MCP connectors) from completion requests (`src/docker/request-sanitizers/`) and never bridges provider WebSockets. The session mode is explicit (`preferredMode`, default `container`; no silent fallback to builtin). The container backend is Docker or Apple `container` (`containerRuntime`). Design: `docs/designs/docker-agent-broker.md`.

### Agent Identity and Attribution — **Missing**

Apart from the fetch server's fixed `User-Agent` (`IronCurtain/<version> (AI Agent Runtime)`, which names the runtime, not the agent or the session), nothing marks the agent's outbound requests as the agent's: no `X-Agent-ID` (or equivalent) header, no agent-scoped or down-scoped credentials that the user could revoke separately, and no correlation id shared between external service logs and the audit log. MCP servers and the MITM act with the user's own credentials.

### Static Analysis of Agent Code — **Missing**

Code Mode runs the TypeScript the model writes without inspecting it first. No AST analysis, bulk-operation detection or data-flow analysis runs before execution; enforcement happens per tool call.

## Operational Confidence

### Agent Testing / Adversarial Harness — **Implemented**

A hermetic harness drives the real agent loop, and the real Code Mode isolate, policy pipeline and filesystem server, with a scripted malicious model playing a compromised agent (`test/harness/`, `test/agent-loop-real.test.ts`, `test/adversarial-e2e.integration.test.ts`; see `test/README.md`). Its scenarios cover encoded exfiltration, symlink escapes and a symlink swap during an approval wait, `.git` hook and config planting, `.env` planting, memory poisoning, protected-path reads, a human-only `add_proxy_domain`, and budget stops of an unbounded tool loop. It runs under `npm test`. CI enforces coverage floors for `src/trusted-process`, `src/sandbox` and the MITM proxy (`vitest.config.ts`), and a Linux job runs the Docker network-isolation tests (`test/network-isolation.integration.test.ts`).

Missing: evaluation against a published benchmark such as AgentDojo.

### Audit Log Analysis — **Partial**

`ironcurtain audit report` summarizes audit logs (decisions, tools, denials, escalations), `audit verify` checks the persona policy-mutation hash chain, and `audit proposals` lists constitution amendments proposed from repeated human approvals (`src/audit/`). Missing: an Audit view in the web UI.

### Runtime Integrity Checks — **Implemented**

`checkConstitutionFreshness()` (`src/config/index.ts`) warns at startup when the constitution changed since the policy was compiled. Every session start and policy hot-swap also checks the compiled policy's provenance against this IronCurtain and the tool annotations in effect (`src/config/policy-provenance-check.ts`; `policy.onStale` is `warn` by default or `refuse`), and the compiled artifacts are schema-validated on load (`src/types/policy-schema.ts`). Live MCP tool schemas are compared with the stored annotations (`src/trusted-process/schema-drift.ts`, `ironcurtain annotate-tools --check`), and arguments without an annotation are denied.

### Diagnostics and Retention — **Implemented**

`ironcurtain doctor` (`src/doctor/`) is a read-only check of the installation, credentials, sandbox dependencies, MCP servers, policy artifacts and disk usage. `ironcurtain prune` (`src/maintenance/`) removes old sessions, workflow runs, run records and dependency caches under the `retention` settings; automatic pruning is opt-in (`retention.autoPrune`). Design: `docs/designs/retention-and-prune.md`.

## Extensibility

### Easy MCP Server Onboarding — **Implemented**

`ironcurtain mcp add|remove|list` (`src/mcp/mcp-command.ts`) adds a server to `~/.ironcurtain/mcp-servers.json`, asks for its credentials, annotates it and compiles its policy in one flow. The user file is layered over the package file and validated with the package schema (`src/config/mcp-servers-overlay.ts`); it may add servers and adjust documented fields of built-ins (`env`, network domain lists), never replace a built-in's command, args or sandbox. Limit: every argument role except `none` is reserved to built-in servers, so a user server's arguments get no path, sandbox or domain checks. Design: `docs/designs/user-mcp-servers.md`.

### Web Search — **Implemented**

Multi-provider web search (Brave, Tavily, SerpAPI) through the fetch server's `web_search` tool. Providers: `src/servers/search-providers.ts`; credentials come from `serverCredentials`, set in the interactive editor or the first-start wizard.

### Multiple Permitted Directories — **Implemented**

The policy compiler emits separate rules per directory and access level (for example the sandbox read/write, Downloads read/write/delete, Documents read-only with escalation on write) from the natural-language constitution. Approved roots are added to the filesystem server only as canonical, existing, approved directories that the agent cannot write (`src/trusted-process/roots-expansion.ts`).

### Configuration Validation — **Implemented**

User config is validated with Zod and unknown keys are reported (`src/config/user-config.ts`, `src/config/unknown-config-keys.ts`); `mcp-servers.json` (package and user file) is validated strictly and a broken file stops the session with field-level errors (`src/config/mcp-servers-overlay.ts`); `compiled-policy.json`, `dynamic-lists.json` and `tool-annotations.json` are schema-validated on load (`src/types/policy-schema.ts`).

## User Experience

### Multi-Turn Conversational Agent — **Implemented**

Session-based multi-turn agent with per-session sandboxes, file-based escalation IPC, conversation history with tool-pair-safe compaction, and resume (`src/session/`). See `docs/multi-turn-session-design.md`.

### First-Start Wizard — **Implemented**

`src/config/first-start.ts` runs on the first interactive `ironcurtain start` until it completes, which it records as `"setupCompleted": true` in `config.json` (`src/config/setup-state.ts`); it never runs in the `start --pty` children of mux or the web UI, and `ironcurtain setup` runs it on demand. It explains the security model, shows the constitution, validates credentials (OAuth-aware) and offers web search setup.

### Interactive Config Editor — **Implemented**

`ironcurtain config` (`src/config/config-command.ts`, `@clack/prompts`) edits models and provider profiles, security settings, resource budgets, auto-compaction, memory, statistics, web search, server credentials, the session mode and the Docker agent settings, with diff tracking and save confirmation. Gap: no section for the `retention` block, which is edited in `config.json` directly.

### Conversation Logging — **Implemented**

`BaseTransport` (`src/session/base-transport.ts`) writes each turn's user message and reply to `interactions.jsonl` (`src/session/interaction-log.ts`), redacted like the audit log, alongside the audit log of tool calls and decisions.

### Remote Access / Messaging Integration — **Implemented**

Signal transport (`src/signal/`): `ironcurtain bot` (or `ironcurtain daemon`) runs the Signal bot with the explicitly built local `ironcurtain-signal-bridge:0.101-auth1` image. Every HTTP/WebSocket route requires TLS and bearer admission; all host clients pin the private certificate. Credentials are one atomic mode-0600 file in a 0700 `oauth/signal-bridge/` directory. Image contract/profile checks refuse unmodified upstream images and foreign or mismatched-data containers. Escalations are approved with the per-escalation code shown in their banner (`approve <code>`, `deny <code>`); there is no bare "approve". Includes fail-closed identity verification of Signal identity keys, message deduplication, Markdown-to-Signal styling, and `ironcurtain setup-signal`. Actual macOS runtime and live Signal qualification remain open below.

### Richer Escalation System — **Partial**

Implemented: escalations in the CLI, the mux picker, the escalation listener, the web UI and Signal, and for workflows through the daemon (`ironcurtain workflow escalation <id> --approve|--deny`, the web UI workflow panel); a bounded wait (`escalationTimeoutSeconds`, default 300) after which the call is denied as timed out; an optional LLM auto-approver (`src/trusted-process/auto-approver.ts`) that never decides human-only escalations; reviewer context that separates the human's last message and the task (trusted) from the agent's justification (untrusted) (`src/trusted-process/escalation-context.ts`); grouped approval of escalations that share one whitelist pattern, behind a confirmation that lists every member (`src/escalation/escalation-groups.ts`); `/approve+` whitelisting that binds the exact file by default, with a directory-wide pattern as an explicit second choice (`src/trusted-process/approval-whitelist.ts`); and amendment proposals from repeated human approvals (see Audit Log Analysis).

Missing: two-person (quorum) approval, **Deferred** (WP-122); listing and revoking whitelist patterns in a session (`/whitelist list|revoke`).

### Web UI — **Partial**

The daemon's web UI (`src/web-ui/`, `packages/web-ui/`) has a dashboard and views for sessions (a live terminal per container agent session), escalations, jobs, personas (create, edit, compile, delete), workflows (state graph, gates, escalations, artifacts, files), statistics and settings. Gaps: the browser has no view for builtin (Code Mode) sessions, which get an "unsupported session type" panel since the chat view was removed; whether to restore one or remove its unused backend, and CLI-parity management, are **Deferred** (WP-125); no views for persona clone, rename or trash; a job recompiled from the Jobs view that left some servers out (`failedServers`) is not flagged there (the CLI reports it, exit status 2); no Audit view; the workflow diff view (`workflows.diff`) of `docs/designs/workflow-web-ui-design.md` is not built.

## Scale

### Multiple Concurrent Agents — **Implemented**

The daemon runs many sessions at once (`src/session/session-manager.ts`), mux runs several sessions side by side, and workflows run many agents, including concurrent fan-out lanes. Lanes are bounded by `maxConcurrentAgentSessions` (default 4; `src/workflow/agent-slot-pool.ts`), and each lane has its own circuit-breaker window. Each session has its own sandbox, budgets and resume state; personas (`src/persona/`) give sessions their own constitutions, policies and memory. Limits: concurrent fan-out lanes in one shared container must all use one persona, since they share one coordinator and its single active policy; states of different personas may share a container scope only with `settings.allowMixedPersonas: true`, which makes the scope one trust domain (`src/workflow/validate.ts`). The evaluation-slot pool of `docs/designs/evolve-sync-parallelism-slice.md` is **Deferred** (WP-131).

### Multi-Agent Workflows — **Implemented**

FSM-driven workflows (`src/workflow/`) with agent, deterministic and human-gate states, shared containers per `containerScope`, a per-state agent harness, read-only reviewer states, the coordinator-owned `workflow_commit` tool, checkpoints, resume and snapshots. See `WORKFLOWS.md`. Gaps: mux workflow tabs and an authoring UI, **Deferred** (WP-131); persona memory in shared-container workflows (WP-68, below).

### Compilation Feedback Loop — **Implemented**

`PipelineRunner` (`src/pipeline/pipeline-runner.ts`) compiles each server, verifies it (a judge's structured approval plus a deterministic replay of the scenarios) and feeds failures back for repair, with up to 3 follow-up verifications per server. Rules that fail verification are never cached or promoted; such servers are reported in `failedServers`.

## Open Items After the 2026-11 Completion Effort

### Deferred Owner Decisions — **Deferred**

- WP-125: web UI scope (Code Mode chat in the web UI, CLI-parity management).
- WP-127: a native Linux nested-Docker profile (needs a privileged host setup step).
- WP-128: nested-Docker follow-ups (storage driver, blob cache, registry credentials, WSL ownership).
- WP-132: trustworthy deterministic workflow verdicts.
- WP-73: changing the Linux default to `agentSudo: false`. Sudo stays on by default; the opt-out exists (`agentSudo: false`, `src/docker/agent-privileges.ts`).
- WP-95: lazy installation of the memory stack. It stays bundled. The model store that downloads only pinned, hash-verified models into `~/.ironcurtain/models` was implemented, but its pins are still placeholders (see the release prerequisites below).
- WP-122: two-person (quorum) approval.
- WP-123: deterministic steering or command rewriting in the MITM for weaker models.
- WP-126: supply-chain checks in the registry proxy (persona-level model and budget overrides were implemented).
- WP-131: mux workflow tabs and the evaluation-slot pool (read-only reviewer states were implemented).

### Open Items From the P0–P2 Packages — **Partial**

Every P0–P2 package of the roadmap was implemented. These parts of them, and the larger follow-ups and residual risks they reported, are still open (smaller defects found in review are not listed one by one):

- Release prerequisites. Remaining unverified model pins fail closed. The local Signal default requires an explicit build and separate platform/account qualification:
  - Memory models (WP-95): the pins in `PINNED_MODELS` (`packages/memory-mcp-server/src/models/manifest.ts`) are `UNVERIFIED`, so the memory server refuses its default models. Until they are recorded, `memory_store` and `memory_recall` fail with `MODEL_UNPINNED` in every session that has memory, re-ranking is skipped and `ironcurtain doctor` fails its memory models check. Recording them takes `npm run pin-models -w packages/memory-mcp-server` on a trusted machine with network access, then a release of `@provos/memory-mcp-server` and a raised dependency range in the root `package.json` (now `^0.2.1`).
  - Signal bridge image (WP-86): the default is local `ironcurtain-signal-bridge:0.101-auth1` (`SIGNAL_DEFAULT_IMAGE`), not a published or pullable release. Build it with `npm run build:signal-bridge`; see [the pinned recipe](../docker/signal-bridge/README.md). Every accepted custom image requires authentication contract label `1`. The default image update command prints rebuild guidance. Actual macOS Docker Desktop/Apple runtime and live Signal account qualification remain owner work.
  - Claude Code CLI pin (WP-100): 2.1.292 (`src/docker/agent-cli-version.ts`) comes from a repository record and was not checked against npm. If it is wrong, building the Claude Code image fails until the pin is corrected or `agentCliVersions` overrides it.
- OS sandbox read baseline (WP-02, WP-40): `~/.netrc`, which the policy engine protects as a credential store, is not in the read-deny baseline every sandboxed server gets (`BASELINE_CREDENTIAL_DENY_READ` in `src/trusted-process/sandbox-integration.ts`), so a compromised git or google-workspace server can read it. git over HTTPS may take its credentials from it, and the built-in git server's `allowRead` cannot be adjusted, so denying it needs an owner decision. Shell history files remain outside the baseline. Trusted environment-file paths and configured extra protected paths are included after RV-05.
- Signal bridge qualification (RV-22): TLS and bearer admission on every HTTP/WebSocket route, the shared pinned-TLS host client, private atomic credentials and owned-container migration are implemented. Actual macOS Docker Desktop/Apple runtime and live Signal account qualification remain; see `docs/designs/signal-transport.md`. Local synthetic checks do not establish those results.
- Memory in shared-container workflows (WP-68): sessions that borrow a workflow's shared container run without persona memory, and the workflow says so. One memory server per persona, routed by the coordinator, is designed but not built (`docs/designs/per-persona-memory-optin.md` section 11).
- OS sandbox qualification: session and discovery availability checks run the srt smoke test (`resolveOsSandboxAvailability`); real macOS containment and runtime-specific behavior still require platform qualification. Tool presence alone is not the availability decision.
- Rootless Docker and user-namespace remapping are not supported as an agent profile; `agentSudo: false` needs the host UID 1000 on Linux Docker; there is no per-workflow `agentSudo` override (WP-73).
- Protected paths: destructive ancestor operations are denied (RV-27). Git tools conservatively refuse repositories containing a specific protected descendant, including protected audit/config files; selectors are left unchanged (RV-31). Concurrent changes between static inspection and Git execution remain outside an atomic guarantee; see `docs/designs/git-protected-repositories.md`.
- Dynamic lists: values newly resolved through MCP tools are written without a confirmation step, so list poisoning remains a residual risk (WP-14; `docs/designs/dynamic-lists.md`).
- Policy compilation: a constitution edit recompiles every server (PIP-15(a), above); there is no bulk recompile of every persona and job policy after an upgrade (WP-49).
- Workflows: an idle human gate is stopped resumably after `settings.gateIdleTimeoutMinutes` (default 240 when the run holds a shared container), but its containers are not released while the run waits (WP-133); a per-gate `humanOnly` flag and a scoped token for agent deciders do not exist (WP-34).
- When no daemon is running, `ironcurtain daemon run-job` runs the job in its own process without Signal or the web UI, so its escalations cannot be answered and are denied (WP-84).
- Metrics: host-side LLM calls (builtin agent, policy compilation, auto-approver, compaction) are not recorded in the LLM statistics (WP-78), and the memory server's LLM spend bypasses IronCurtain's metering (WP-94).
- Memory server: one server process per session (no daemon-owned server per persona database) and no OS sandbox for it (WP-95).
- Retention does not cover `task-policies/`, the `run/` directories of crashed bundles or `workflow-workspace-locks/`, and the legacy `workflow-deps/` cache of earlier versions is reported, never removed.
- Terminal: under the mux, OSC 10/11 colour queries and the kitty keyboard query are not answered (WP-111); `ironcurtain gc` inspects Docker unless `--runtime apple-container` or `all` is given (WP-74).
- MCP server environment: every server gets only an allowlisted environment (`src/trusted-process/child-env.ts`). Docker-based servers can forward a host variable with `-e NAME`, but other servers have no per-server `inheritEnv` list to pass one such as `PYTHONPATH` by name; such values go in the server's `env` block or its stored credentials. A Docker-based server with `DOCKER_HOST=ssh://…` does not get `SSH_AUTH_SOCK`, which only the git backend receives (WP-40).
- Registry proxy: the abbreviated npm packument is not served (WP-72).
- Nested Docker: native Linux qualification, selecting the fixed-parent transport for an inner bootstrap, and the remaining preview qualification runs (WP-99).

### IronCurtain-in-IronCurtain — **Reserved**

Developing IronCurtain inside an IronCurtain nested-Docker session has no supported or qualified path and is not scheduled; the fixed-parent outbound transport exists and is tested but no production path selects it. See `docs/designs/ironcurtain-in-ironcurtain-hermetic-slice.md` (Implementation status).

# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Behavior changes

- **MCP tool arguments have a per-call size and depth limit** — the coordinator and relay count every field, including memory tool inputs. Calls above 4,096 JSON nodes or 32 levels below the argument object are denied before backend validation. The coordinator records the denial without copying the oversized payload into the audit log.

- **Docker agents now enforce the token and cost limits** — `resourceBudget.maxTotalTokens` (default 1,000,000, cache reads and writes included) and `resourceBudget.maxEstimatedCostUsd` (default $5, estimated at API list prices whatever the credential, a Claude login included) used to bind only the builtin agent. The MITM proxy now enforces them for every Docker agent container and refuses further completion requests once one is reached: cumulatively per container (a batch session or cron run, a per-state workflow container, or a shared-container workflow scope across all its states and lanes), and over the whole life of a mux tab, web terminal or `start --pty` session. Outside an agent turn (a process left running, a deterministic workflow step) a batch or workflow container's completion requests are refused. Raise the limits, or set them to `null`, in `~/.ironcurtain/config.json` (`ironcurtain config` → Resource Limits). Batch turns also pass `maxSteps` to the agent as its turn cap (`claude --max-turns`, `GOOSE_MAX_TURNS`), and a turn that reaches `maxSessionSeconds` is stopped inside the container.
- **A `.env` in the working directory is no longer read** — move API keys to `~/.ironcurtain/.env` (`$IRONCURTAIN_HOME/.env`, `chmod 600`), name another file with `ironcurtain --env-file <path> <command>` or `IRONCURTAIN_ENV_FILE=/absolute/path`, or export them in the shell. Only credential keys load from these files (the provider API keys and the variables configured MCP servers forward with `-e`); `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `GOOGLE_API_BASE_URL` are ignored there, so set `anthropicBaseUrl`, `openaiBaseUrl` or `googleBaseUrl` in config.json or export them. A file owned by another user or writable by everyone is refused, and a one-line note names an ignored `.env`. The npm scripts no longer read the repository's `.env` either. A working-directory `.env` is no longer a protected path, so keep secrets out of a workspace an agent can read.
- **MCP servers that need an OS sandbox no longer start without one** — `sandboxPolicy` now defaults to `"enforce"` on Linux and macOS (it was `"warn"`): a server that asks for an OS sandbox (git, google-workspace and now the filesystem server) is refused, and its tools are unavailable, when sandbox-runtime cannot provide one. On Linux install bubblewrap, socat and ripgrep (`sudo apt-get install -y bubblewrap socat ripgrep`); when they are present but sandbox-runtime still cannot start a sandbox (for example under AppArmor-restricted user namespaces), `ironcurtain doctor` names the cause. To run such servers unconfined with a warning, set `"sandboxPolicy": "warn"` in config.json, under `ironcurtain config` → Security, or with `IRONCURTAIN_SANDBOX_POLICY=warn`.
- **Sandboxed MCP servers cannot read your credential stores** — every OS-sandboxed server is denied the IronCurtain home, SSH private keys at their default names (`~/.ssh/id_*`), `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.docker/config.json`, `~/.git-credentials`, `~/.npmrc`, `~/.config/gh`, `~/.kube/config`, the Claude Code, Anthropic CLI and Codex credential files and your shell startup files. The git server therefore pushes over SSH through ssh-agent (it is the only server that receives `SSH_AUTH_SOCK`), a credential helper that reads `~/.git-credentials` or the `gh` login no longer authenticates it, and npx-launched servers no longer see `~/.npmrc`. Tool calls that read or write these stores (all of `~/.ssh`, and `~/.netrc` as well) or IronCurtain's credential files are denied under every policy; `credentialProtection` in config.json adds paths or drops stores from that list.
- **MCP servers no longer inherit your environment** — relays and servers get an allowlist (home, path, locale, temporary directory, proxy and CA settings, npm, Docker and Node version-manager settings), so provider API keys and other exported tokens no longer reach any MCP server. A server of your own that needs a host variable must declare it: a docker-style `-e NAME` argument, a literal in its `env` block, or `serverCredentials` in config.json. `NODE_OPTIONS`, `NODE_PATH`, `LD_*` and `DYLD_*` reach neither MCP servers nor the `start --pty` children of mux and the web UI.
- **Persona and cron job policies fail closed** — a persona session (`start --persona`, mux, cron, workflows) is refused when the persona's constitution changed since its last compile (run `ironcurtain persona compile <name>`, or `ironcurtain start --persona <name> --allow-stale-policy` to use the old policy once) and when its compiled policy is broad without the persona's opt-in (`POLICY_TOO_BROAD`: narrow the constitution, or run `ironcurtain persona compile <name> --allow-broad`). A cron run is refused, with an error run record and a Signal notice, when the job's compiled policy is missing or older than its task constitution, and `daemon add-job` saves a job disabled until its policy compiles. A persona or job whose compiled policy is missing is refused instead of running under the package policy, and turning off a persona's broad-policy opt-in moves a policy that needed it aside until the persona is recompiled.
- **Recompile your policies after upgrading** — policies compiled by earlier versions record no provenance and are reported as possibly stale at session start and by `ironcurtain doctor` until rebuilt with `ironcurtain compile-policy`, `ironcurtain persona compile <name>` or `ironcurtain daemon recompile-job <id>` (`"policy": { "onStale": "refuse" }` refuses them instead). The first compile after the upgrade recompiles and re-verifies every server, at its LLM cost. A policy you compiled yourself has no rule for `git_remote`'s new remote-URL role, so `git_remote add` and `set-url` are denied until it is recompiled (the shipped policy asks for approval).
- **Compiled policy files are validated when loaded** — `compiled-policy.json`, `dynamic-lists.json` and `tool-annotations.json` are schema-checked and refused (`POLICY_ARTIFACT_INVALID`, `TOOL_ANNOTATIONS_INVALID`) when they hold unknown keys (including the `sideEffects` conditions of policies compiled before per-server compilation, which the engine used to ignore), a catch-all allow or escalate rule, a relative `paths.within` or missing metadata. A policy file or directory that is a symlink, owned by another user or writable by others is refused too; the error names the file and, for a mode problem, the `chmod` that fixes it. `ironcurtain doctor` lists the problems; recompile, or correct hand edits.
- **Workspaces are checked in both directions** — `start -w`, `workflow start|run --workspace` and the web UI refuse a workspace that is an ancestor of your home directory (`/home`, `/Users`), contains the IronCurtain home (for example `-w .` with `IRONCURTAIN_HOME=$PWD/.ironcurtain`), contains or lies inside the package configuration directory (so `-w .` in the IronCurtain checkout you run: develop IronCurtain from a separate checkout), is or contains the relays' scratch root `<tmpdir>/ironcurtain-<uid>` (so `-w /tmp` on Linux), or contains a protected path. Paths are compared by file identity, so symlinks and case or Unicode variants do not get around the checks.
- **Workflow definitions are validated more strictly** — a deterministic state that runs commands on the host must declare `host: true` (or run them with `container: true`), and an in-flight run is checked again on resume; unknown keys under `settings:` are errors; agent states of different personas in one shared container scope need `settings.allowMixedPersonas: true` (for an in-flight run, in its `definition.json`); a shared-container fan-out with more than one lane must use one persona; `settings.workers` and a numeric `fanOut.count` are at most 16; deterministic and guard-only agent states need an unconditional fallback transition; `dockerAgent` must be `claude-code`, `goose` or `codex`. A workflow with runtime dependencies needs `packageInstall` and cannot run with nested Docker; its dependencies are installed into per-run layers (an in-flight run gets a fresh one on resume), and `NODE_PATH` is set only for deterministic container commands, not container-wide. `workflow lint` adds warnings WF015 to WF020 (host commands, fields that have no effect, fan-outs wider than 4 lanes, a model its harness does not call natively).
- **Workflow gate decisions name the gate** — `ironcurtain workflow gate` requires `--gate-id <gateId>` (`gate.gateId` from `workflow await` or `workflow status`) and the `workflows.resolveGate` RPC requires `gateId` (`INVALID_PARAMS` otherwise); a stale id gets `GATE_MISMATCH` and an event the gate does not route gets `EVENT_NOT_ACCEPTED`. The agent-driven workflow commands (`run`, `await`, `status`, `gate`, `escalation`, `show`) report every usage error as `INVALID_USAGE` (exit 2) and a lost daemon connection as `DAEMON_DISCONNECTED` (exit 1), also during `await`, and `--ensure-daemon` reports `DAEMON_WITHOUT_WEB_UI` instead of starting a second daemon when one without the web UI runs. `workflows.artifacts` now lists files without their contents (fetch them with the new `workflows.artifactFile`, long message-log entries with `workflows.messageLogEntry`), and a reply over 8 MiB is a `RESPONSE_TOO_LARGE` error instead of a closed socket, so reload an open web UI after upgrading.
- **CLI options are parsed strictly** — `-h`/`--help` and `-v`/`--version` count only before the command (`ironcurtain --help start` prints help, `ironcurtain start -v` is an error), and other options before the command, apart from `--env-file`, are errors. `ironcurtain bot` runs only the Signal transport and refuses subcommands: use `ironcurtain daemon` for Signal plus cron jobs and for the job commands. `setup`, `config`, `customize-policy`, `escalation-listener` and `setup-signal` take `--help` and reject unknown options, and `setup` and `escalation-listener` refuse to run without a terminal.
- **Signal bridge access requires TLS and bearer admission** — setup, health, registration, identity, send and WebSocket receive use one certificate-pinned client. Build the local default `ironcurtain-signal-bridge:0.101-auth1` with `npm run build:signal-bridge` before setup; it is not a published or pullable image. Unmodified upstream images are refused; compatible custom images require authentication contract label `1`. For the local default, `setup-signal --update-image` prints rebuild guidance; for a published compatible image it shows the validated digest for confirmation. `setup-signal --re-trust` records the recipient account UUID. See [the build instructions](docker/signal-bridge/README.md).
- **Signal approvals quote the escalation's code** — each banner shows a short code: reply `approve <code>`, or `approve+ <code>` to also whitelist the pattern the banner shows; a bare `approve` is refused. `deny <code>` denies (a bare `deny` only while one escalation is pending, `deny #N` while one is pending on session N), `/pending` lists the pending escalations and `/show <code>` (or `details <code>`) shows one in full. A reply written before the escalation it names was raised is refused.
- **Escalations need a deliberate decision** — in mux an arriving escalation no longer opens the picker (it rings the bell, updates the `[!N pending]` badge and shows a banner; Ctrl-E opens it), decision keys count only about a second after an escalation is drawn, and `A` (approve all) is gone; `/approve all` and `/approve+ all` open a confirmation listing every pending escalation, and the escalation listener asks for the code it shows for that list. The web UI modal no longer takes focus: Approve is Ctrl/Cmd+Enter and Deny Ctrl/Cmd+Backspace once you click into it, enabled 750 ms after it appears. `/approve+ N` now whitelists the exact path (or domain); `/approve+dir N` (`W` in the mux picker) whitelists the directory. Several escalations can be pending in the interactive CLI: banners are numbered and a bare `/approve` works only while one is pending.
- **Auto-approval needs your message to name the resource** — with `autoApprove.enabled`, a user message authorizes auto-approval for 120 seconds in every session type, and only for an escalated resource it names (the path or its directory, the destination host, or the remote name). `add_proxy_domain` and calls whose role-bearing arguments hold nested values (and, when enabled, taint and content-assessment escalations) always need an individual human decision: they are never auto-approved, whitelisted or approved in bulk. Auto-approval is off when its model has no credentials.
- **The git server runs hardened** — only `https` and `ssh` remotes work (no `file://`, local paths, `git://` or `http://`), repository hooks and askpass programs do not run, and only your global and system credential helpers and `core.sshCommand` apply. A git call on a repository whose configuration defines include files, filter/diff/merge drivers, configured hooks or alternates, that redirects git outside the sandbox, or whose `.git` holds a link leading outside it escalates per call, and so do Code Mode writes into `.git`. Path arguments reach every server as the absolute path policy evaluated (a relative one resolves against the sandbox), and an argument the tool annotations do not list is denied (`unannotated-arguments`).
- **The filesystem server is pinned and confined to its roots** — it is an exact-pinned dependency (2026.8.31) launched with `node`, no longer fetched with `npx`, and runs under the OS sandbox confined to its MCP roots. Approving access to a file directly in your home directory, or to a directory that contains the IronCurtain home, a credential store or a temporary directory, is refused (`root-not-exposable`), and a constitution that grants a whole home directory is not exposed to the server: name subdirectories.
- **Agent CLIs are pinned** — the Claude Code image installs 2.1.292 and the Codex image 0.157.1 instead of the newest release, and agent images are built under a build-hash tag, so the first session after the upgrade builds them again. Choose other versions with `agentCliVersions` in config.json (`"latest"` or an exact version; `ironcurtain images rebuild` picks up new releases). A workflow resumed after an upgrade, a pin change or an `agentCliVersions` change starts its shared containers fresh instead of from a snapshot (the workspace carries over), and snapshots taken by earlier versions are never resumed. Codex now talks to its provider over HTTP and SSE only (WebSockets off), under a new provider id (`ironcurtain-chatgpt` for a ChatGPT login), so Codex sessions recorded by earlier versions are not listed in Codex's own resume picker.
- **Provider-hosted tools are removed for every provider** — the MITM proxy already dropped Anthropic's server tools; it now removes the tools and connectors with which a provider runs code or fetches content for the agent on every completion route it serves (also Anthropic's MCP connector and code-execution containers; OpenAI's hosted tools; Gemini `googleSearch`, `urlContext` and `codeExecution`; OpenRouter plugins and `:online`), replaces URL-sourced content with a placeholder, and refuses OpenAI's web-search and deep-research models (on OpenRouter, unless the profile maps to one). Codex runs with web search off. Web access goes through the policy-mediated fetch server.
- **MITM egress is narrower** — an `add_proxy_domain` approval grants one host on one port (443, or 80 when requested as `host:80`): port 443 is tunneled only after the TLS ClientHello names the approved host, so clients without SNI or with ECH cannot use it, and port 80 must carry HTTP for that host. Agents and tools in the container that send their own API keys to provider hosts get a 401; only the injected session credential works. Buffered provider requests are limited to 32 MiB (50 MiB for OpenAI and Codex) and larger ones get a 413, a per-session proxy limit answers 503 with `Retry-After`, idle tunnels close after 10 minutes, and a malformed CONNECT gets a 400. `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` is deprecated: it warns at every start, is ignored when `egressPolicy.enabled` is set, and its wildcard tunnels refuse IP literals and local or metadata names.
- **The package registry proxy is read-only** — inside Docker sessions the npm, PyPI, Debian and crates.io proxy serves only GET and HEAD on an allowlist of install routes and strips client credentials, so publishing, `npm login`, `npm whoami` and `npm audit` get a 403 (containers set `NPM_CONFIG_AUDIT=false`). Request paths must be canonical, Debian hosts serve only `.deb` packages and allowlisted `dists/` metadata (no `apt-get source`), a new file of an old PyPI release is quarantined like a new release, and every forwarded or refused request is recorded in `package-audit.jsonl`.
- **The policy compiler rejects broad allow rules** — a deterministic lint now runs on every compile and rejects allow rules with `*`, a public-suffix wildcard (`*.com`, `*.github.io`) or an unconstrained URL role unless `compile-policy --allow-broad-domains` or the constitution line `<!-- ironcurtain: allow-broad-domains -->` opts in (for personas, `persona compile --allow-broad`; cron jobs cannot), and it rejects write, delete and history allows across a whole home directory or broader, so name subdirectories. Persona and job rules that allow writes or moves under `/etc` fail verification. Dynamic-list domains are checked against the Public Suffix List, so values such as IP addresses, local names and public suffixes are dropped and the fetches they allowed now escalate or are denied.
- **`compile-policy --server` writes only that server** — it leaves the merged policy alone unless `--write-merged` or `--output-dir` is given. A partial failure exits 2 (1 when no policy was written) and lists the servers in `failedServers`, and per-server results are cached only after they pass verification. A job compile with failed servers exits 2 too, and `add-job` keeps such a job disabled.
- **`annotate-tools` writes a per-server overlay** — `~/.ironcurtain/generated/tool-annotations.json` now holds only the servers whose annotations differ from the shipped ones, so annotation fixes in a release reach you; an older full copy is rewritten once (backup `tool-annotations.pre-overlay.json`). `--pin` keeps your annotations for a server, `--reset` returns to the shipped ones, and a server that fails to annotate keeps its previous annotations while the run exits 1. annotate-tools, compile-policy's drift check, `mcp add` and doctor start servers the way sessions do (under the OS sandbox `sandboxPolicy` asks for, with stored `serverCredentials`); google-workspace is never started outside a session.
- **`memory.llmBaseUrl` must use https or this machine** — a plain-http `memory.llmBaseUrl` other than localhost, 127.0.0.0/8 or `[::1]` (a LAN Ollama, for example) now fails config loading. The Anthropic API key goes only to the Anthropic route (`https://api.anthropic.com/v1/`, or the `/v1/` under `anthropicBaseUrl`); another endpoint needs `memory.llmApiKey`.
- **Unattended memory writes wait for review** — memories written by cron jobs and workflow states are hidden from interactive sessions until you approve them with `ironcurtain memory <persona|job> review` (later runs of the same job, or later states of the same run, see them). Cron and workflow sessions refuse to start a memory server that predates this review quarantine, and `ironcurtain doctor` reports one. Shared-container workflows run without persona memory, and a notice names the personas affected.
- **Memory models download into `~/.ironcurtain/models`** — the memory server fetches only the pinned model files from Hugging Face on first use and checks each file's SHA-256 on install and before every load. `ironcurtain memory prefetch` downloads them ahead of time, and `"memory": { "offlineModels": true }` forbids downloads.
- **Memory tool calls changed** — IronCurtain now asks a human before a bulk `memory_forget` (by tags, query or date, or naming more than 10 ids) or a `memory_ingest` of more than 10,000 characters, and denies memory tools it does not know. In the memory server, `memory_forget` criteria intersect (ids and tags and `before` and query) and a bulk forget needs `confirm`; forgetting an ingested fact removes its source passage; `memory_recall`'s raw output is `{ notice, memories }` and all memory output is framed as untrusted notes; `memory_expand` returns at most `max_passages` (default 3); an ingest keeps at most 200 KB and 200 facts; an `as_of` more than 5 minutes ahead is refused; keyword search matches accented and non-Latin words. Its LLM calls have deadlines and a call and token budget per server process (`MEMORY_LLM_*`), its databases are upgraded in place to schema 5 after a backup instead of being rebuilt, and a database whose stored embedding model differs from the configured one refuses to open.
- **One daemon per IronCurtain home** — a second daemon refuses to start and names the pid holding `~/.ironcurtain/daemon.lock`, and the daemon refuses a home owned by another user. Job commands run in the daemon whenever one is reachable, and locally only when none is: `daemon run-job` runs in the daemon while the CLI waits and exits 1 when the run does not succeed, and `remove-job` asks for confirmation (`-f` skips it) also while the daemon runs. `ironcurtain bot` and the daemon's Signal transport hold `~/.ironcurtain/signal.lock`, so a second bot exits, and a daemon started beside a bot runs without Signal.
- **Cron escalations can be decided in the web UI** — without Signal, an escalation of a cron run now waits for a decision in the web UI, up to `escalationTimeoutSeconds`, when a browser has it open as the escalation arrives, and is denied at once otherwise. With Signal and `notifyOnEscalation: false` it is still denied at once.
- **Cron git sync runs from a daemon-owned mirror** — for a job with `gitRepo` the daemon keeps a bare mirror (`~/.ironcurtain/jobs/<id>/repo.git`) and rebuilds the workspace `.git` from it before every run, following the upstream default branch, so the agent's commits and branches do not persist and its `origin` URL carries no embedded credentials. A custom workspace an earlier version cloned into fails with `sync_error` until you empty it once. Each fetch uses only its URL's own transport, and ssh runs in batch mode, so use ssh-agent or a passphrase-less key and have the host key in `known_hosts`. A failed or timed-out sync records an error run instead of running the agent.
- **Cron runs record more and overlap less** — `last-run.md` is moved to `previous-run.md` before every run and the record keeps only what the current run wrote (sanitized and bounded); every run, setup and sync failures included, gets a record and a completion notice. `run-job` and the web UI's Run refuse a job that is already running (`JOB_ALREADY_RUNNING`), a run is refused while another job's run or a workflow holds its workspace, and a fire time missed by more than 5 minutes (the machine slept) is skipped unless `cron.catchUpMissedRuns` is set.
- **Daemon shutdown stops workflow runs resumably** — SIGINT, SIGTERM and, from a terminal, SIGHUP abort every workflow run with a terminal checkpoint within 60 s; a run paused at a gate comes back as aborted and resumable, and `workflow resume` raises the same gate again. Under nohup, a service manager or `--ensure-daemon`, SIGHUP is ignored. Keep systemd's `TimeoutStopSec` at 90 s or more.
- **Workflow runs at a gate release their containers after 4 hours** — a run that waits at a human gate while it holds a shared container is stopped resumably after `settings.gateIdleTimeoutMinutes` (default 240; `null` waits forever), with a snapshot when `snapshotOnStop` is set; `workflow resume` raises the same gate again.
- **Workflow agents commit their results through a tool** — agent states report their verdict, notes and handoff with the new `workflow.commit` tool (the coordinator's virtual `workflow` server), and the first accepted commit is final. The YAML `agent_status` block is the fallback for sessions without the tool, and a turn that commits nothing is continued (`missing_commit` in `messages.jsonl`).
- **Workflow agent sessions are capped** — `maxConcurrentAgentSessions` (default 4, at most 64) caps the workflow agent environments alive at once in the daemon or in one CLI workflow run (a shared-container scope counts once); further ones wait for a free slot, and a shared-container workflow with more scopes than the cap is refused at start.
- **Workflow resume checks what it resumes** — a run another process is executing cannot be resumed (the web UI marks it as running elsewhere); a run directory outside the home's `workflow-runs` whose definition has host deterministic states needs `--trust`; a run directory passed where its base directory belongs is refused (`WORKFLOW_INVALID_BASE_DIR`); a run whose workspace is gone is not resumed (`WORKFLOW_WORKSPACE_MISSING`: recreate the directory to resume with an empty one); run files written by a newer IronCurtain are refused (`WORKFLOW_CHECKPOINT_TOO_NEW`); workflow ids must be 1-128 characters from `A-Z`, `a-z`, `0-9`, `_` and `-`. A resumed run replays the interrupted state from its start, and the agent's prompt opens with a notice not to repeat external actions.
- **Escalation waits follow `escalationTimeoutSeconds`** — the in-process wait was always 300 s whatever the setting; now it is the configured timeout, and an expired wait is recorded as `timed-out` (a withdrawn one as `cancelled`) instead of `denied`. Escalations are withdrawn when the script or turn that raised them ends, the session closes or the policy is swapped. Workflow tool-call escalations now reach a human (the terminal prompt, `ironcurtain workflow escalation`, the web UI), never the auto-approver. Relays bound a backend tool call at 300 s, reset on progress up to 1 hour, instead of 60 s.
- **Builtin turns stop on every budget** — when a token, step or cost limit runs out, a builtin (Code Mode) turn now ends with a "Budget exhausted" error, as only the wall clock did before: Signal and web sessions end, cron records show `budget_exhausted`, and builtin workflow states fail instead of returning an empty answer. Costs use current list prices, cache writes included, overridable per model with `resourceBudget.modelPricing`; the hidden 100-step cap is gone (`maxSteps` applies, or a 1000-step safety cap when it is `null`); and the auto-compaction summary counts toward the turn's tokens and cost.
- **Resuming a running session is refused** — `ironcurtain start --resume <id>` of a builtin, batch container or PTY session that another process still runs is refused ("already in use by a running session"), and a `session-metadata.json` that exists but cannot be used refuses the resume instead of dropping the session's persona and policy.
- **`ironcurtain start` reports failure in its exit status** — it exits 1 when the task fails or a budget stops it, and 128 plus the signal number when interrupted (130 for Ctrl-C), also during setup, which now tears down what it created.
- **Configuration files are checked more strictly** — saving over a `config.json` that is not valid JSON fails and writes nothing (the file used to be replaced), and every rewrite keeps the previous file as `config.json.bak`. Unknown config fields, nested typos included, are reported on stderr with a suggestion (and still ignored), and a provider prefix within two edits of a known one (`anthropc:`) is an error in `--model` flags and workflow YAML. A `persona.json` that does not match the schema (unknown field, wrong type, missing `createdAt`, name different from its directory) is refused with the reasons; copy personas with `ironcurtain persona clone`. An invalid `~/.ironcurtain/mcp-servers.json` stops every command with field-level errors.
- **Session LLM logs record metadata only** — `observability.llmInteractionLog` (default `"metadata"`) makes the builtin agent's `llm-interactions.jsonl` and the auto-approver's `auto-approve-llm.jsonl` record timings, token usage and sizes without prompt or response text. Set it to `"full"` for transcripts, now redacted like `audit.jsonl`, or to `"off"`. Session directories are created 0700 and their logs 0600.
- **`audit.jsonl` writes a record before every dispatch** — each dispatched tool call now produces two lines with the same `requestId`: a write-ahead `dispatching` record, then the outcome. Tools that read the log should skip `dispatching` records. A call is refused when the audit log cannot be written, and every later call of that session too. Redaction now also masks provider API keys and token formats and the exact credential values IronCurtain holds, and no longer touches bare 9-digit numbers.
- **The policy-mutation log is a keyless hash chain** — `ironcurtain audit verify` checks it, and records written by earlier versions (chained with a per-process HMAC) count as legacy. Restart a daemon that was started before the upgrade, or its appends break the chain.
- **MCP server names `proxy`, `network`, `workflow` and `memory` are reserved** — an `mcp-servers.json` entry with one of these names is refused at config load. Add your own servers to `~/.ironcurtain/mcp-servers.json` (or with `ironcurtain mcp add`) rather than editing the package's file; there a built-in server can be adjusted only through its `env` and network domain lists. A user-added server's command must be an absolute path or a program on `PATH`, relative paths in its arguments no longer resolve against the directory IronCurtain was started in (servers run in a private working directory), and its arguments get only the `none` role, so policy cannot inspect them.
- **The statistics database moves to schema 2** — running an earlier IronCurtain (0.14.x) against this home afterwards disables its statistics. `ironcurtain statistics delete` retries a busy maintenance lease for about 21 s and exits non-zero if another process still holds it. Costs show `unknown` (never $0.00) when no source reported one, and `≥ $x` when only some exchanges were priced. Built-in agent ids (claude-code, codex, goose) are stored as they are; other labels stay pseudonymized.
- **Docker agent containers get process and file limits** — `--pids-limit 4096` by default (`dockerResources.pidsLimit`, minimum 16, `null` for none), no swap beyond `--memory`, and `nofile` 65536; Apple container VMs get only the memory and CPU limits. With nested Docker on Docker Desktop the session's CPU, memory and PIDs are now split, and the nested daemon gets half by default (`dockerWorkload.resources.daemonShare`, 0.1 to 0.9), so the agent itself gets less than before.
- **Nested Docker admits fewer hosts** — `dockerWorkload.enabled` can no longer be turned on outside macOS (Docker Desktop or Apple Container) and WSL2 with Docker Desktop; a native Linux Engine and Docker Desktop for Linux are refused. macOS needs Docker Desktop with cgroup v2 (OrbStack, Colima, Rancher Desktop, Podman machine and remote engines are refused), and the `images` and `packages` network modes need Docker Engine 28 or later. Admission now waits up to 60 s for another process's admission instead of failing as busy, and the Docker Desktop nested daemon image rebuilds once.
- **The first-start wizard runs until it completes** — it runs on the first interactive `ironcurtain start` until it has completed once, also when `doctor`, mux or the daemon ran first, and records `setupCompleted` in config.json (a config.json from an earlier version counts as set up). mux and the daemon print a note while setup is pending, and declining the wizard still starts the session.
- **The fetch server refuses private destinations** — `http_fetch` refuses private, loopback, link-local and metadata destinations, including names that resolve to them, unless `fetch.allowPrivateNetworks` lets a URL name a private or loopback address literally (link-local and metadata stay refused). A cross-origin redirect is returned to the agent instead of followed (same-origin ones up to 5), results are a JSON object (`status`, `url`, `redirects`, `headers`, `body`, `truncated`), and bodies are decoded by their charset.
- **`ironcurtain doctor` is read-only** — it no longer creates config.json, the sandbox directory or the V8 cache marker, and its probes run under the OS sandbox and skip images and npx packages that are not cached. `--check-api` no longer runs an OAuth refresh grant; the new `--check-refresh` does, rotating the Anthropic refresh token (credentials in the macOS Keychain are never refreshed by doctor).
- **Code Mode scripts have limits** — an `execute_code` script that writes more than 1 MiB to the console (or makes 10,000 console calls) fails, a session runs two scripts at once (four through the Docker Code Mode proxy) and queues up to 16 more, the console output and the result share the 100 KB the model sees, and closing a session mid-turn rejects that turn.
- **Host models without credentials fall back** — `--agent builtin` fails at start when the agent model has no API key, as `preferredMode: "builtin"` did. Without a key for its model, auto-compaction summarizes with the agent model, auto-approval is off (escalations go to a human) and memory runs without its LLM; each case produces a session notice.
- **Workflow resources stay within their run** — external resumes require a local definition and validated run-owned scripts/skills. Imports copy bounded regular files into a fresh destination. `workflow run-state --artifacts` stages only declared real input directories, skipping links and special entries within shared entry/depth/byte limits.
- **Memory approval requires the reviewed snapshot** — review/show prints the complete quoted payload and an `<id>@<digest>` receipt. Approval rechecks it in the write transaction; changed rows need review again, and bare ids or `approve --all` are refused. Signal requires every memory ingest/forget argument to fit its complete review; larger requests are deny-only.
- **Protected paths are checked as they resolve now** — original names, current symlink targets and resolution components stay protected; deleting a containing directory is refused. Configured extra credential paths and relocated Anthropic stores join sandbox read protection. Workspace-derived policy roots that escape the workspace are refused on load and reload.
- **Incomplete dynamic lists keep restrictive rules active** — missing, empty, legacy or partly validated lists cannot silently bypass escalation or denial. List completeness participates in verification caching. Policy evaluation bounds argument traversal and path-resolution work; legacy artifacts may require more reviews until refreshed.
- **Git refuses repositories containing protected descendants** — this includes metadata calls. Move protected audit/config stores outside the checkout and retain their file protections; use an absolute `AUDIT_LOG_PATH`. Wrap-up instructions need an explicitly tracked working directory and per-call review. Submodule metadata and named submodule configuration require review, and implicit recursion is disabled.
- **Browser reviews survive oversized requests and refresh failures** — each pending escalation is complete within its display budget or deny-only, and approval checks the original record. Independent refreshes retain other views after one RPC fails. Workflow gate Approve requires 750 ms with the same visible, focused, stationary review; content changes, movement and interrupted presses restart or invalidate approval.
- **Workflow shutdown includes final charges and checks image ownership** — closes join one teardown, terminal checkpoints include proxy settlement, and interrupted provisional usage cannot support resume under token/cost limits. External run bases cannot reclaim ownerless legacy snapshots. Dependency-tree staging is bounded by entry, depth and byte limits.
- **Terminal reviews expose the decision text** — constitution policies, diffs, questions, summaries, relay diagnostics and container errors are escaped for display. Terminal Markdown shows literal destinations. CLI JSON/JSONL escapes terminal-active and invisible characters while preserving decoded values and stored evidence.
- **Cleanup warnings outlive their sessions** — startup, provisioning and recovery findings reach diagnostics/logs even on failure, and completed jobs preserve notices. The current browser page retains twenty distinct host-file warnings until dismissed; after a full page reload, consult persisted logs. These warnings remain advisory.
- **Desktop TCP transport requires admission and TLS** — ordinary macOS Docker Desktop bundles use separate MCP/proxy credentials and a CA/server-name-verified host hop. Internal listeners are restricted to the bundle address/subnet; PTYs use native Docker exec without a published port. Rebuild base/agent images for the new MCP bridge. Credentials are restaged on resume and excluded from creation, exec and flattened-import arguments. Explicit legacy `PROXY_TCP_PORT` use now requires a token and binds only loopback.

### Features

- **Task-scoped sessions (opt-in)** — `ironcurtain start --task-scoped "task"`, mux `/new [persona] --task-scoped <task>` and `ironcurtain workflow start <name> "task" --task-scoped` compile the task into a scope that is intersected with the session policy. Calls outside it escalate (`task-scope-escalate`) and can be approved or whitelisted. Scopes are cached under `~/.ironcurtain/task-policies/`, so a rerun of the same task in the same workspace starts at once, and a resumed session keeps its scope.
- **Policy-evaluated egress (opt-in)** — with `egressPolicy.enabled`, every destination a Docker agent connects to other than a provider or registry host is decided by the session's policy engine as a `network` request: hosts matching `egressPolicy.allowedHosts` (`*`, `*.example.com`, `host`) pass, others escalate to a human once per host and port, only ports 443 and 80 and no IP literals are admitted, and every decision is audited. It replaces `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS`.
- **Taint escalation (opt-in)** — with `taintEscalation.enabled`, once a session has run a tool that brings in untrusted content, outbound tools need a human decision; unattended runs without a human route deny them. `taintEscalation.tools` reclassifies tools, and audit entries record the taint.
- **Outbound content assessment (opt-in)** — `contentAssessment.enabled` checks the message bodies, commit messages and fetched URLs of outbound calls for encoded blobs, high-entropy tokens, ciphers, hidden characters and size, and escalates suspicious content to a human; `contentAssessment.llmCheck` adds an LLM intelligibility check. Compiled allow rules of outbound tools become `assess` rules, and the new `outbound-text` argument role marks the inspected arguments.
- **Your own MCP servers** — `ironcurtain mcp add <name> ...`, `mcp remove <name>` and `mcp list` manage `~/.ironcurtain/mcp-servers.json`, which every command layers over the built-in servers; `mcp add` annotates the new server and compiles its rules, and both commands drop a reused name's rules from every compiled policy.
- **Audit reports and learned amendments** — `ironcurtain audit report` summarizes the tool-call audit logs (`--session`, `--workflow`, `--file`, `--since`, `--json`), `audit verify` checks the policy-mutation log, and `audit proposals` lists constitution amendments proposed once a human approved the same kind of call three times (recorded in `~/.ironcurtain/approval-history.jsonl`). `customize-policy` and the persona and job customizers offer them as a diff to accept; nothing is applied automatically.
- **Reviewer context and grouped approval** — escalations show the user's last message, a task summary and the agent's own `justification` (labelled untrusted, never given to the auto-approver). `/approve group N` and `/approve+ group N` in mux and the escalation listener, and Review group in the web UI, approve every pending escalation that shares a whitelist pattern after a confirmation.
- **Builtin sessions resume their conversation** — `ironcurtain start --resume <id>` restores a builtin session's conversation from `~/.ironcurtain/sessions/<id>/messages.jsonl` under the same session id, including a compaction summary that quotes your earlier messages verbatim (within its size limits); Goose and Codex sessions in Docker keep their conversations across turns and states too (Goose named sessions, Codex recorded threads).
- **Workflow additions** — `ironcurtain workflow show <id> --artifact <name>` takes `--file <path>` to read one file of the artifact, and lists the files past its 4 MiB output budget instead of printing them; `ironcurtain workflow escalation <id> --approve|--deny` decides a run's tool-call escalations; `settings.workflowBudget` (`maxTotalTokens`, `maxEstimatedCostUsd`, `maxWallClockSeconds`) caps a whole run and stops it resumably; `states.<id>.dockerAgent` picks the agent harness per state; `workspaceAccess: read-only` gives reviewer states a read-only workspace (design-and-code's review state uses it).
- **Persona lifecycle and overrides** — `ironcurtain persona clone`, `persona rename` (its compiled policy is moved aside: compile it again) and `persona trash list|restore|purge` (the web UI's deletes go to the trash and are kept for `personas.trashRetentionDays`, default 30). `persona set` gives a persona its own `agentModelId` and `resourceBudget`, which apply below a workflow's or a job's own settings; `persona show` prints them, and `persona create --servers` refuses servers that are not configured.
- **Memory curation** — `ironcurtain memory <persona|job> list|search|show|forget|export|import|stats|review` curates a persona's or job's memory, `ironcurtain memory prefetch` downloads the memory models, and recalled facts from ingested text carry `[src:<id>]` markers that `memory_expand` takes.
- **Retention and pruning** — `ironcurtain prune [--dry-run] [--json]` removes sessions and workflow runs inactive for 30 days, job run records beyond 200 per job and dependency caches unused for 14 days, as the new `retention` block in config.json sets; `retention.autoPrune` makes the daemon prune daily. `daemon.log` and `signal-bot.log` now rotate at 10 MiB, keeping three files.
- **Upgrade checks and a fuller doctor** — the version that last ran is recorded in `~/.ironcurtain/state.json`: the first command after an upgrade prints these behavior changes, `ironcurtain doctor --upgrade` checks workflow definitions, runs, snapshots and compiled policies, and a home with a newer layout is refused. doctor also checks file permissions and secret files, personas and cron jobs, every model role's credentials, OAuth logins, `node-pty`, the memory models, nested-Docker leases, policy provenance and scenario replay, and on Linux the host identity and Docker user namespace; `--check-api` round-trips every host model role.
- **Agent image management** — `ironcurtain images status`, `images rebuild [--agent <id> | --all] [--with-base]` and `images prune [--force]` show, rebuild without the layer cache, or remove superseded agent images (they are tagged by build, so `docker image prune` leaves them).
- **Agents without sudo (opt-in)** — `"agentSudo": false` runs Docker agents as UID 1000 with no-new-privileges and without the capabilities sudo needs. On Linux Docker it requires IronCurtain itself to run as UID 1000, and it is refused with Apple container and with nested Docker.
- **Statistics summaries** — `ironcurtain statistics summary [--days <n>] [--json]` and `statistics reset` (deletes every row and rotates the pseudonym key), aggregation in SQLite so the dashboard works at large row counts, grouping by routed or served model, persona and workflow, and host list-price cost estimates for exchanges on the official provider routes.
- **Nested Docker lease operations** — `ironcurtain docker-workload status`, `reconcile` and `clear <lease-id> [--force]` list, recover and retire the nested-Docker leases that can block admission.
- **Session notices on every surface** — stale policies, annotation drift, MCP servers that failed to start, host-model fallbacks and privileged files an agent left on host mounts are reported as session notices: in the CLI, as dismissible banners in the web UI, once over Signal, and in cron run records.
- **Job wizard steps** — `daemon add-job` and `edit-job` set budget overrides, a custom workspace and a persona; a persona job runs under the persona's policy and needs no task constitution.
- **Web UI additions** — workflow tool-call escalations are decided on the workflow page and counted in the Workflows badge, the New persona picker offers the configured MCP servers, a partial persona compile shows as "Compiled with failures", and past runs that another process is executing are marked as running elsewhere.
- **CLI additions** — `annotate-tools --check` (drift against the live servers, no LLM, exit 1 on drift), `--diff`, `--pin` and `--reset`; `compile-policy --force`, `--write-merged` and `--allow-broad-domains`; `refresh-lists --persona <name>` or `--job <id>`; `ironcurtain auth <provider> --no-browser` for headless hosts; `setup-signal --update-image`; `gc --runtime docker|apple-container|all`; and `--help` on every command.
- **More settings** — `fetch.allowPrivateNetworks`, `credentialProtection`, `policyVerifierModelId` (a model other than the policy model generates and judges the verification scenarios; unset, the policy model does both), `resourceBudget.modelPricing`, `snapshot.maxBytes`, `cron.maxConcurrentRuns`, `cron.catchUpMissedRuns` and `dockerResources.pidsLimit`, each described in [CONFIG.md](CONFIG.md).

### Security

- **Protected paths are harder to get around** — protected paths are matched case- and Unicode-insensitively on every filesystem and stay protected for tool calls inside the session sandbox or a workspace (a Docker agent still reaches the files of its bind-mounted workspace directly), a dangling protected link protects its missing target and every link on the way, a path that cannot be resolved is denied (`structural-unresolvable-path`), and deny messages no longer name the protected path.
- **MCP servers are contained** — the filesystem server runs confined by the OS sandbox to its MCP roots (unless `sandboxPolicy: "warn"` starts it without one), so a symlink an agent swaps in during a call can no longer redirect a write outside the roots or a read into the rest of the home directory, the temporary directories or the credential stores (other host files stay readable, and a swap can still move a call from one root to another); relays and servers run in private working directories, never the directory IronCurtain was started in; approved roots are canonical, checked again after the approval wait and verified against the server (`approved-path-changed`, `roots-verification-failed`); and the sandbox argv rewrite no longer mangles URLs, version pins or dotted literals.
- **Policy compilation is mediated and verified** — MCP-backed dynamic-list resolution runs through the security kernel again (the read-only policy, escalations denied, every call audited to `list-resolution-audit.jsonl`, one relay per named server, never the fetch server); per-server rules are cached only after they pass verification; verification passes only on the judge's structured verdict with no failing scenario, and the judge's scenario corrections count only after a replay; and the read-only policy now covers git reads and denies `http_fetch` outside known safe domains.
- **Git is judged where it really connects** — remotes are resolved in-process, push URLs and `insteadOf` rewrites included, without running git in the agent's repository; a repository's own overrides of remote URLs, proxies, TLS settings, `sshCommand` or remote helpers escalate; `domains` conditions and domain lists match the resolved destination, whitelist patterns bind a named remote to where it connected, and local clone sources and `.git` internals are judged structurally.
- **MITM proxy hardening** — strict CONNECT parsing, a loopback-only MITM listener in the macOS TCP-sidecar topology, a bearer token on the proxy's control API, leaf certificates minted only for the CONNECT host, per-bundle caps and deadlines on connections, tunnels and buffered bodies, a credential gate on provider routes, no relayed `Set-Cookie` or hop-by-hop headers, endpoint globs that cannot match encoded separators, and a separate keep-alive pool per address policy.
- **Approval surfaces show what is approved** — every agent-derived string on the mux picker, the escalation listener, the CLI banner, Signal and the web UI is escaped (control, bidi, invisible and default-ignorable characters appear as `\u` escapes) and shown in full or marked as cut (`v` in the mux picker shows the whole request). Decisions are bound to the escalation shown and gate decisions to one raise, and late approvals of expired escalations are reported as expired.
- **Whitelist patterns are narrower** — a pattern constrains every argument role that escalated (for a move, the source too when it escalated), a pattern without constraints is refused, a named remote is bound to the destination it resolved to, and a symlink swapped into a path ends the match.
- **Web UI hardening** — the server checks `Host` and the WebSocket `Origin` (also in `--web-ui-dev` mode), sends a strict CSP with `Referrer-Policy: no-referrer`, and renders agent markdown with a strict profile: raw HTML and images as text, only http(s) and mailto links clickable.
- **Host reads of agent-writable files** — the host reads workspace, artifact, result, skill, run-summary and transcript files without following links, and those and workflow definitions only as regular files, without blocking on a FIFO and within size bounds; `CLAUDE.md` seeding never follows a planted link (a directory planted there stops the next session on that state with an error); a non-directory planted at `.workflow` is moved aside; and workflow dependency layers are per run on a host-verified base, so runs can no longer poison each other's caches.
- **Memory trust model** — memory output is framed as untrusted notes, writes carry writer provenance, importance is capped at 0.8, secrets are rejected or redacted, a snapshot is kept before bulk deletions, forgetting removes the source passage and superseded copies, memories awaiting review are frozen until approved, and the Anthropic key reaches the memory LLM only on the Anthropic route.
- **Credential files and child processes** — config and credential files are written atomically and owner-only under cross-process locks; OAuth refresh write-backs keep a token the host CLI stored meanwhile; Keychain write-backs pass the token on stdin instead of argv; the relay writes the google-workspace credential file without following links and masks the values a server's `-e` arguments forward in its session log; MCP relays and servers get allowlisted environments.
- **Containers and terminals** — on Linux, the host mounts a Docker agent can write are scanned after every turn and at teardown: setuid and setgid bits on files you own are cleared, and the setuid files it cannot change and every root-owned entry are reported; raw `start --pty` and Apple container output is filtered before it reaches your terminal (no OSC 52 clipboard writes, hyperlinks, titles or text-echoing reports), and `observe` sanitizes token-stream text.
- **Daemon and transports** — the daemon's control socket is owner-only with schema-checked, size-capped requests; MCP socket transports survive malformed or oversized frames, serve one MCP server per connection and bound what they queue for a client that never reads.
- **Policy engine** — the git annotations name the arguments git-mcp-server 2.15.3 really takes, so `git_clone`'s destination (`path`, which the old annotations called `localPath`) is checked like any write path, and an argument the annotations do not list is denied; a role-bearing argument holding a nested object or array escalates to a human (`structural-nested-argument-escalate`), GitHub review-thread and sub-issue ids escalate and are never generalized into a whitelist pattern (`github-resource-id`), a matched rule with an unknown decision denies, IP literals and non-http(s) URLs escalate under the default domain gate, and local and metadata names are denied as fetch URLs.
- **Nested Docker** — a hardened watchdog supervisor launch, pinned images run by immutable ID, append-only registry pull provenance per lease, storage measured against an emergency reserve, and ownership and mode checks on the package's reviewed manifests.
- **Cron jobs** — the agent never sees URL-embedded git credentials, and the workspace `.git` is rebuilt from the daemon's mirror before every run, so hooks or config an agent planted do not survive into the next run.
- **Developer discovery uses the runtime launcher** — tool-listing scripts share sandbox and declared-credential handling instead of inheriting the complete host environment.
- **Editing and SSH socket access are narrower** — constitution editor files/backups stay in a private temporary directory, and the macOS git sandbox permits only the canonical agent socket.
- **Trust dependencies are patched and pinned** — Go pins and committed trust-runtime binaries use 1.26.11, both Go builder images have verified OCI index digests, and node-forge uses 1.4.1. Obsolete node-forge audit acceptances are removed; other reviewed acceptances remain.
- **Signal bridge credentials and migration are private** — the token, certificate and key share one atomic `oauth/signal-bridge/credentials.json` file (0600, directory 0700), mounted read-only without secret values in Docker arguments, environment values, images or query strings. Every HTTP route and WebSocket upgrade enforces admission; internal JSON-RPC binds container loopback. Container reuse checks ownership, exact data mount, image/profile and credential fingerprint. An owned legacy listener is removed before replacement-image admission; foreign or mismatched-data containers are refused untouched. Actual macOS runtime and live Signal account qualification remain owner work.
- **Install-script documentation matches project installs** — unlisted lifecycle scripts still run in ordinary project installs unless strict mode is enabled. The documentation no longer claims that they are all skipped.

### Fixes

- **Builtin sessions** — auto-compaction never separates a tool call from its result (`keepRecentMessages` is a minimum, so one more message may be kept) and backs off after a failed summary; a failed turn keeps its finished steps; the loop detector resets every turn and blocks repeated harmless results only after 25; closing a session stops the turn in flight; Anthropic requests carry four prompt-cache breakpoints.
- **Usage accounting** — Anthropic usage is counted completely (compaction, advisor and fallback attempts), partly measured exchanges count as lower bounds instead of zero, a prompt past a model's unlisted long-context tier is charged at twice the listed rates against the cost caps, the run-wide workflow ceiling counts what each bundle's budget gate charged, and the workflow "Total Tokens" figure is the run-wide total over every session, lane and resume.
- **Workflow runs** — abort stops in-flight work (sessions created after it, fan-out lanes, host commands, container commands inside the container); a cross-process run lock prevents double execution; quota exhaustion and transient upstream failures end a run resumably even when its error target is a gate; a self-transition starts a new visit; a result that matches no transition goes to the error target instead of hanging; every fan-out failure reason is reported; a damaged `checkpoint.json` falls back to `checkpoint.prev.json`; resumed runs keep their restore snapshots, and a run removes only its own snapshot images. design-and-code's plan and design gate revisions no longer use up its coding rounds, evolve enforces its round budget in a deterministic step, and the call circuit breaker counts each fan-out lane separately.
- **Cron scheduling** — daylight-saving changes are handled (a job in the spring-forward gap runs once after it), day and month combinations that never occur are rejected, runs are reserved before they start and always recorded with the run's total budget use, `add-job` and `edit-job` update a running daemon's schedule without a restart, `remove-job` cancels a run in progress, and `list-jobs` shows NOT SCHEDULED, QUEUED, INVALID and the failure streak.
- **Web terminals and the web UI** — terminals reattach after a reconnect, pending escalations expire when a PTY child exits, resize requests are bounded, escalations raised or resolved during a page refresh are no longer lost or brought back, and CLI status clients no longer reset an unattended terminal's idle timer.
- **mux** — every pending escalation is visible, terminal queries get replies, and each redraw is one synchronized frame with damage tracking.
- **Nested Docker** — host sleep, a laptop lid close or a clock step no longer ends a live session (monotonic liveness, and owner leases that record the boot id and process start ticks on Linux), an IronCurtain home reached through a symlink works, and incident recovery retries with backoff.
- **Statistics** — a failed or stalled statistics writer is restarted with backoff, records enqueued during a checkpoint are flushed, and over-limit queries return `STATISTICS_LIMIT` with guidance to choose a shorter range.
- **Policy pipeline** — a response cut off at its output cap is retried once with a larger cap, only new or changed tools go to the annotation model, pre-filter decisions are cached, a failed server's reason names the scenarios that still fail, and list overrides (`manualAdditions`, `manualRemovals`) survive `compile-policy` and `refresh-lists`. The package ships its `dynamic-lists.json`, so `refresh-lists` writes only your own entries. CLI persona compiles take the daemon's compile lock.
- **Container credentials and resume** — startup checks the selected agent and provider after confirming runtime availability. Missing gateway and Goose keys name the host setting to supply. Doctor checks the preferred container credentials. Batch and PTY resumes use the saved provider profile during preflight.
- **Setup and preflight** — the first-start wizard checks credentials the way sessions use them (a Claude login or keys saved in config.json count), the V8 sandbox preflight cache works again with a key covering platform, architecture, isolated-vm version and install path, a preflight failure prints its message instead of a stack trace, and the read-only and daemon-backed workflow commands and the daemon's job commands no longer run the V8 sandbox check.
- **Package downloads** — apt's `%2b` and `%7e` spellings are accepted in Debian package names, PyPI upload-time lookups follow the project's display-name redirect, a download that fails after its headers is aborted for the client instead of ending silently, and registry metadata reads are bounded.
- **Other fixes** — Linux Docker agent mode refuses to run as root before building images (it used to fail at container start); a relative `AUDIT_LOG_PATH` works with `-w .`; package files may be group-writable when the group is the owner's private group, so installs need no umask workaround; `ironcurtain auth revoke` keeps the stored token and exits 1 unless the provider confirms; `auth import` validates the file before replacing credentials; `workflow inspect` reports an unreadable run in place; a job's constitution generator explores a throwaway clone of its repository; container logs are captured on Apple container too; Codex turns no longer wait on refused WebSocket handshakes; and trajectory capture drops only an exchange past its capture limits instead of stopping for the rest of the session.
- **Upstream response failures** — invalid HTTP statuses or response errors return a controlled gateway failure instead of escaping the MITM request handler.
- **Batch parsing and socket framing** — Goose parsing and Code Mode framing use linear, bounded processing, with explicit combined-output and frame limits.
- **Mux overlay repaint** — approval overlays repaint after adjacent terminal damage and handle display widths conservatively.
- **Slow ownership remapping** — agent readiness allows a bounded 180 seconds, with matching integration fixture budgets.

### Dependencies

- The lockfile updates the fetch client (Undici 8.12.2), filesystem glob expansion (brace-expansion 5.0.11), root schema validation (Zod 4.6.6) and web UI build tooling (Vite 8.3.3).

- `@modelcontextprotocol/server-filesystem` 2026.8.31 is an exact-pinned runtime dependency (it was fetched with `npx`), `@cyanheads/git-mcp-server` is pinned to 2.15.3, and the GitHub MCP server image is pinned by digest (github-mcp-server v2.1.0).
- `tldts` 7.4.5 (the Public Suffix List) is a new runtime dependency.
- The agent images pin Claude Code 2.1.292 and Codex 0.157.1, and the macOS transport sidecar is built locally from a vendored Dockerfile instead of pulling `alpine/socat`.
- Code Mode runs `execute_code` through `src/sandbox/code-mode-chain.ts`, a copy of the code-mode fork's chain runner under the MPL-2.0 (file-level); the rest of IronCurtain stays Apache-2.0.
- Development installs skip the install scripts of onnxruntime-node (its CUDA download), protobufjs, esbuild and fsevents through `allowScripts`, which npm 11.19 and later enforce; elsewhere, `ONNXRUNTIME_NODE_INSTALL=skip` avoids the CUDA download.

### Internal

- The test suite is type-checked (`npm run typecheck:tests`), an adversarial and agent-loop harness runs real sandboxes and policies, coverage thresholds guard `src/trusted-process`, `src/sandbox` and the MITM proxy (`npm run test:coverage`), the test runner accepts a worker death only when every planned test still ran, and the suite no longer leaks temporary directories.
- CI covers the workspace packages, the nested relay's Go code, a packed-tarball install on Node 24 and 26, network isolation and weekly scheduled checks (image builds, Go release support, annotation drift); the Go toolchain pins are checked (`npm run check:go-toolchain`), the build-trust wrapper must rebuild byte for byte, an npm audit gate checks the production tree against a reviewed, expiring allowlist, and the release workflows run least-privilege jobs that publish a checksum-verified tarball.
- The live runtime may not import pipeline code (an ESLint rule and an import-boundary test), the unused workflow worktree manager is removed (its schema fields are ignored and linted), and the IronCurtain-in-IronCurtain scaffolding is marked reserved.
- The user, operator, security and design documentation was reconciled with the code, and tests tie key statements in the docs to the code.

## [0.14.0] - 2026-09-21

### Features

- **Opt-in nested Docker for developer sessions** — Docker Agent sessions and workflow bundles can use a private, ephemeral Docker daemon without exposing the host Docker socket. Implemented profiles cover Apple Container and Docker Desktop on macOS, plus WSL2 with Docker Desktop on amd64, including completed testing with a real non-1000 WSL coordinator. Shared admission, policy, activation, watchdog, and cleanup code uses each backend's UDS or fixed-target relay transport. This is developer-scoped functionality, not a claim of general Linux or all-agent qualification; native Linux Engine and Linux arm64 are not admitted (#406, #454, #456, #467, #471).
- **Nested image pulls and package builds** — `offline` permits explicit workspace image imports without registry access; `images` adds mediated anonymous Docker Hub/GHCR pulls; `packages` additionally permits bounded public apt/npm/PyPI/Cargo downloads through the host MITM policy engine for supported Docker/default-Buildx builds. A managed internal network connects sibling containers, including Compose services using already-built images. Persistent caches, authenticated registries/package sources, host-published ports, unsupported Compose/custom-BuildKit builds, and IronCurtain-in-IronCurtain remain out of scope. Downloads and built images remain untrusted (#443, #454, #456).
- **Persistent local LLM statistics** — content-free MITM observations record tokens, timing, routing, outcomes, and provider-reported cost metadata in a local SQLite database. Collection is enabled by default with 90-day retention, excludes prompts/completions/tool payloads, and pseudonymizes user-derived labels and private routes. Configuration and web Settings can disable collection; `ironcurtain statistics delete --before <date>` or `--all` deletes stored rows (#409).
- **Web statistics dashboard** — adds provider/model trends, calendar-day drilldowns, distributions, and a sidebar usage receipt, backed by bounded statistics queries including workflow context (#411, #412).
- **Web container-session resume** — a resume dialog discovers previous sessions and restores their terminal-backed conversations, sharing resumable-session discovery with mux and validating snapshots, ownership, and concurrent resume attempts (#445).
- **Anthropic CLI OAuth credential support** — detects the Anthropic CLI store alongside existing Claude Code credentials, honors `ANTHROPIC_CONFIG_DIR` and `XDG_CONFIG_HOME`, refreshes tokens with their issuing OAuth client, and writes rotated tokens back in the originating store's native format. Failed refresh of an older credential file no longer shadows a usable later source (#383, #387).
- **Streaming workflow watch command** — `ironcurtain workflow watch <workflowId|runDir>` replays and follows operational `messages.jsonl` records with JSON, timestamp, and event filters, while `--lines N` provides a bounded last-N snapshot for scripts. Live watches remain open across human gates and return phase-derived terminal exit codes. ID-based watches reconcile through the daemon's existing RPC/event surface while run-directory watches work from disk alone (#440).

### Fixes

- **Interactive Claude behavior and PTY lifecycle** — batch-only Claude settings no longer disable interactive agent/dispatch behavior; Apple Container PTYs use its native terminal transport. Web sessions remain tracked until observed exit, failed termination can be retried, shutdown waits for in-flight spawning, and stale PTY sockets are removed before resume (#422, #423, #445, #451).
- **Conservative resource recovery** — ambiguous PTY resources are retained until ownership and cleanup can be confirmed, and Docker reconciliation is scoped to the IronCurtain home so separate installations and test homes do not reclaim one another's sessions (#445, #453).
- **Slow upstream gateway recovery** — batch/workflow Claude sessions disable the byte-stream watchdog that could kill long self-hosted responses; terminal API errors become resumable transient failures instead of misleading missing-status errors. PTY watchdog behavior remains separate, and IronCurtain's per-turn wall-clock budget remains the backstop (#431).
- **Workflow status and resume recovery** — incomplete turns can recover through a bounded replacement conversation with workspace handoff; opt-in producer states can hand existing artifacts to their sole validator when status recovery is exhausted. Only a final valid status fence routes a turn, failed shared-container stops can retain snapshots, and resume restores checkpoints without stale lifecycle state. `maxSessionSeconds` no longer acts as a cumulative state-time limit (#438, #442).
- **Trajectory capture survives an aborted exchange** — an upstream truncation now drops only that exchange rather than disabling capture for the rest of the session. Manifests count aborted exchanges and expose genuine session-wide poisoning when it occurs (#437).
- **Statistics worker startup and retention recovery** — source-run SQLite workers bootstrap without relying on external `tsx` worker hooks, compiled runs load JavaScript directly, and timed-out retention workers recover without permanently disabling later maintenance (#426, #450).
- **Nested Docker startup and storage** — fixes Apple Container 1.2.x `/proc` visibility and overlapping host mounts, uses the staged runtime wrapper for package builds, and avoids anonymous Docker volumes inherited from agent images. WSL agent/daemon identity wiring preserves workspace ownership rather than recursively changing it (#436, #467).
- **Non-1000 Docker startup and restrictive umasks** — batch and PTY activation wait for agent UID/GID remapping and home initialization before executing commands or probing writable storage. CA certificates and daemon identity files retain their required permissions under restrictive host umasks, readiness checks reject stale markers after restart, and startup failures include bounded container-log diagnostics (#471).
- **Container-visible workspace prompts** — agents receive their actual container workspace path rather than an inaccessible host path (#444).

### Behavior changes

- **Node.js support is now limited to 24 and 26** — upgrade from Node 22 before installing this release. `isolated-vm` is pinned to 7.0.1, whose corrected engine range and prebuilt binaries cover both supported Node lines and include the upstream security fix for GHSA-864f-rcv7-6rh4. Node 22 and odd-numbered Node releases are no longer supported (#467).
- **Workflow resume goes through the daemon** — `ironcurtain workflow resume <workflowId|existingBaseDir>` preserves daemon model routing and supports `--ensure-daemon`. Scripts using the former local `--state`, `--model`, `--no-lint`, or `--strict-lint` resume options must use the explicit `workflow resume-standalone` command instead (#442).
- **Unusable MITM CA storage is replaced automatically** — instead of failing bundle startup, IronCurtain generates and atomically publishes a fresh CA for malformed, exposed, or legacy storage; valid legacy keys are rotated rather than migrated. Existing bundles retain their in-memory CA, while newly created bundles receive the replacement. First-run paths updated here request mode `0700` when creating the IronCurtain home directory (#449).
- **Nested Docker admission requirements** — Apple nested Docker requires Container CLI 1.2.1 or newer. WSL nested Docker requires the admitted Desktop/amd64 profile with cgroup v2 and a non-root coordinator UID/GID; agent users retain passwordless sudo. Ordinary sessions remain available with nesting disabled (#436, #467).

### Dependencies

- Code Mode uses the temporary `@provos/utcp-code-mode` compatibility fork (upstream 1.2.13) and a direct `isolated-vm 7.0.1` dependency, preserving the Node 24/26 native-addon requirement in published installs without relying on checkout-only overrides. Existing `@utcp/code-mode` imports are unchanged through an npm alias.
- Refreshed security-sensitive dependencies and updated Vitest/coverage to 4.1.11 through Aikido Safe Chain. IronCurtain now requires the published memory server `^0.2.1`; its Transformers `^4.3.0` dependency replaces the checkout-only sharp/adm-zip overrides with upstream ranges accepting patched releases. The lockfile selects sharp 0.35.4, ONNX Runtime 1.30.0, adm-zip 0.6.1, and devalue 5.9.2 (see [dependency security](CONTRIBUTING.md#dependency-security)).
- Bumped the memory workspace's `better-sqlite3` dependency to `^13.0.3` (#421).
- Updated DOMPurify, PostCSS, brace-expansion, fast-uri, Undici, ip-address, js-yaml, Hono, and other lockfile dependencies (#395, #396, #398, #403, #404, #407, #408, #410, #415).
- Bumped `actions/setup-node` from 6 to 7 (#384).

### Internal

- Added retained-evidence backend qualification for Apple Container, macOS Docker Desktop, and WSL/Desktop, plus deterministic nested-Docker workflow and registry integration tests. Retired exploratory nested-Docker spike harnesses in favor of maintained tests; packaged both runtime-wrapper architectures and cleaned build output before asset copying (#443, #456, #457, #460, #467).
- Serialized the isolated-vm test group to reduce macOS worker-teardown flakes while leaving the rest of the suite parallel, and improved MITM large-stream test performance and failure diagnostics (#429, #430, #433, #435).

## [0.13.0] - 2026-07-11

### Features

- **First-class OpenRouter provider profiles** — named profiles in `config.json` `modelProviders` route Docker agents (Claude Code, Codex, Goose) through openrouter.ai with a bound model map and per-profile key, with no LiteLLM sidecar (the implicit `native` profile remains the fallback). GLM prompt caching is preserved via a MITM soft `z-ai` provider pin plus stable session affinity, and billing uses the authoritative `usage.cost` reported by OpenRouter rather than the CLI self-report. A profile is selectable across three surfaces — the global `modelProviders.default`, `ironcurtain start --provider-profile <name>`, and the mux `/new` picker — and is configurable via `ironcurtain config` → Model Providers and the web UI Settings view (#361).
- **Live web terminal for Docker Agent sessions** — the Sessions view now runs real PTY-backed agent sessions through an xterm.js terminal, including terminal state serialization, reconnect/replay, trusted-input forwarding, and escalation events. The former chatbox session mode has been removed so the web UI and mux share the same interactive terminal model (#366, #368).
- **Apple container UDS isolation** — Apple `container` 1.1.0 and newer now use the same Unix-domain-socket topology as Linux Docker, with `--network none`, per-socket host/guest relays, and no host service listeners exposed on `0.0.0.0` (#371).
- **Docker resource garbage collection** — `ironcurtain gc` can inspect orphaned IronCurtain containers and networks in dry-run mode or explicitly reclaim them, using the same crash-recovery reconciler invoked during session startup (#380).

### Behavior changes

- **Node.js 26 support** — bumped the V8 sandbox dependency `isolated-vm` to 7.0.0 (via an npm `override`, since it is transitive through `@utcp/code-mode`) so Code Mode initializes on Node 26; `isolated-vm` 6.x has no Node 26 prebuild and fails to compile against Node 26's V8. Supported lines are now the even-numbered major lines **22, 24, and 26**: Node 24 and 26 install prebuilt native binaries, while Node 22 compiles `isolated-vm` from source at install (no prebuilt binary ships for it, so a C/C++ toolchain is required). Odd non-LTS lines (23, 25) run within `engines` (`>=22.0.0 <27`) but are untested — `ironcurtain doctor` reports them as a warning, not an `ok`. CI runs Node 24 and 26 on every PR and adds a Node 22 source-compile job on pushes to master (#356, #358).
- **Claude Code workflow execution** — subagents run synchronously and Claude Code's own streaming idle watchdog is disabled. IronCurtain's workflow budgets remain the timeout authority, avoiding false “Response stalled mid-stream” failures during long tool-use turns behind the MITM proxy (#372, #376).
- **Runtime-capability-based workflow snapshots** — workflow snapshot creation and cleanup now depend on the selected runtime's declared snapshot capability. Docker opts in; Apple `container` skips unsupported image commits cleanly (#369).

### Fixes

- **Crash-safe Docker network lifecycle on macOS** — Docker containers and per-bundle networks now carry owner leases and labels, and later sessions reconcile resources left by `SIGKILL` or host crashes. macOS Docker uses collision-checked `/29` allocations outside `192.168/16`, retries a different subnet when end-to-end MCP/MITM routing checks fail, and handles `SIGTERM`/`SIGHUP` with bounded shutdown escalation (#380).
- **Docker writable-storage exhaustion diagnostics** — session startup now probes the container's writable layer before reporting “Session ready,” gives targeted `docker system df` guidance for `ENOSPC`, and treats a zero-exit/no-output Claude Code turn as a hard failure without poisoning the next conversation resume (#381).
- **Debian package validation and auditing** — plain-HTTP apt traffic now passes through the same denylist validation and `package-audit.jsonl` path as HTTPS registry traffic, closing a path where denied `.deb` packages could install without an audit record (#355).
- **MITM proxy certificate generation on Node 22 / OpenSSL 3.0** — serial numbers are now always encoded as positive DER integers, eliminating intermittent `asn1 encoding routines::illegal padding` failures when generating CA or leaf certificates (#360).
- **Workflow daemon-gate startup under tsx** — detached daemon launches preserve `process.execArgv`, so `--ensure-daemon` works from the documented `tsx src/cli.ts` development entry point instead of timing out (#354).
- **MCP stdio shutdown reliability** — benign `EPIPE` and `ECONNRESET` errors on closing stdio transports no longer become unhandled worker failures (#353).

### Dependencies

- Bumped the AI SDK providers, Anthropic sandbox runtime, MCP/UTCP packages, XState, YAML, Zod, jsdom, and related production dependencies.
- Added `@xterm/addon-serialize` for terminal reconnection and refreshed the web UI dependency set.
- Refreshed TypeScript, ESLint, Prettier, tsx, lint-staged, and other development tooling.

### Internal

- Added a deterministic MITM stream-delay harness and documented the streaming-watchdog investigation (#379).
- Hardened macOS CI against benign teardown races and native dependency download failures (#374, #375).
- Added packaged README documentation for the Evolve and Vulnerability Discovery workflows and expanded agent-memory architecture notes (#373).

## [0.12.0] - 2026-06-26

### Features

- **Codex CLI agent and token-trajectory capture** - added a Docker adapter for Codex CLI alongside faithful OpenAI/Codex token trajectory capture for SFT/RL training data. `--capture-traces` is wired through mux PTY sessions and daemon-launched workflows, with trajectory reassembly/tap support and documentation for downstream training pipelines (#273, #276, #280, #288).
- **Evolve workflow** - new native workflow for iterative candidate evolution: deterministic container execution with packaged scripts, a structured deterministic result contract for verdict routing, single-round and multi-round execution, human-surface gates, final summaries, abort handling, a generic experiment harness, correctness stop conditions, resume idempotency, search-quality cognition promotion, multi-parent/selectable samplers, and synchronous N-way fan-out lanes (#292, #299, #300, #302, #303, #309, #313, #315, #323).
- **Workflow runtime and gate improvements** - workflow agents can now use daemon-driven gates, shared containers can be snapshotted and resumed across resumable stops, workflow workspace artifacts auto-refresh on lifecycle events in the web UI, and workflow dependencies are installed at runtime instead of requiring per-workflow baked images (#304, #308, #316, #318).
- **Web UI workflow and persona management** - added workflow statistics to the dashboard, hid test workflows from normal lists, added a workflow README modal, added copy-to-clipboard for workflow instructions, polished workflow pages, and introduced WebSocket-driven persona policy management (#283, #312, #340, #347).
- **Apple container runtime backend and Rust fuzzing toolchain** - added an Apple `container` runtime backend plus Rust fuzzing support for agent/container workflows (#290).
- **Cargo package proxying** - the MITM package proxy now supports Cargo/crates.io, extending the package-install mediation model beyond npm, PyPI, and apt (#348).
- **Memory MCP server 0.2.0 integration** - upgraded the bundled memory server path with atomic-fact ingest, parent-context retrieval, new memory documentation, Docker build-context handling, and the separately tagged `memory-mcp-server/v0.2.0` release (#335, #337, #339).
- **Vulnerability-discovery hardening** - discovery now better resists masked findings, lost runs, background-wait ambiguity, and hanging harness validation (#268, #281).

### Behavior changes

- **Workflow dependencies install at runtime** - workflows no longer bake a per-workflow Docker image just to include dependency files; the runtime installs them in the active workflow environment (#308).
- **Leaf subcommands parse arguments strictly** - invalid trailing or misplaced arguments are rejected earlier for CLI leaf commands (#279).
- **Builtin mode honors configured model provider** - preflight/model-provider handling now respects the configured provider when running outside Docker (#287).
- **Discussions linked from issue templates** - the GitHub issue chooser now points users toward Discussions for support and exploratory topics.

### Fixes

- **Codex provider-host WSS fallback** - provider-host WebSocket upgrade attempts are fast-rejected so Codex falls back to HTTP instead of hanging through the MITM proxy (#341).
- **Workflow teardown and gate CLI reliability** - Docker teardown is drained before CLI exit to avoid network leaks, and bad-flag errors preserve the gate CLI's JSON/exit-code contract (#311, #314).
- **Workflow harness boundedness** - vulnerability-discovery harness validation and workflow harness execution now use hard-kill bounds to avoid indefinite hangs (#268).
- **Trajectory capture robustness** - missing-terminal token streams are classified as mid-stream aborts, improving retry/recovery decisions (#289).
- **Docker UID/GID remap** - benign Linux GID collisions are handled during agent UID/GID remapping (#333).
- **Sandbox tool-error suggestions** - UTCP manual prefixes no longer leak into tool-error suggestions (#301).
- **Memory DB schema safety** - incompatible memory databases are backed up before schema rebuild, and tests run serially to avoid model-download races (#337, #339).

### Dependencies

- Bump `@provos/memory-mcp-server` to `^0.2.0`.
- Bump `undici` to `^8.5.0`.
- Bump web UI dependencies including `vite`, `dompurify`, `hono`, `ws`, `qs`, `js-yaml`, `tar`, `form-data`, and related transitive security updates.
- Bump `actions/checkout` from 6 to 7.

### Internal

- Broke a workflow runtime import cycle and added a `madge` pre-push cycle gate (#277).
- Added detailed daemon WebSocket JSON-RPC and workflow human-gate documentation.
- Marked evolve design slices as shipped and reconciled design documents with the implementation.
- Promoted mux over raw PTY in user-facing docs.

## [0.11.0] - 2026-05-18

### Features

- **Workflow web UI — the intended way to run workflows.** Opt-in Svelte 5 dashboard launched by `ironcurtain daemon --web-ui` (default `http://localhost:7400`, bearer-token auth). The Workflows panel hosts the full lifecycle: start a new run (workflow picker, model selection, workspace path, task description), watch active runs through a live state-machine graph (dagre + SVG) with per-state agent-message timeline and markdown rendering, review gates with a workspace + artifact browser, and respond to escalations through an overlay modal with inline indicators. A Past section lists completed/failed/aborted runs by scanning `~/.ironcurtain/workflow-runs/` (checkpoints are now retained on success, and historical checkpoint-less runs are reconstructed from the message log via the shared `discoverWorkflowRuns` utility). The same daemon also serves the Sessions, Escalations, and Jobs views. Multi-agent workflows can also be run through the CLI for scripting and debugging (#154, #157, #163, #200).
- **Multi-agent workflow engine** — the orchestration layer that powers the web UI: an XState v5 state machine with typed events, guards, agent/gate/deterministic states, declarative `when:` verdict conditions on transitions, per-state `maxVisits` caps with bounded-loop escalation, transition `actions:` (including `resetVisitCounts`), `freshSession` control, artifact versioning that snapshots `.v<N-1>` backups on re-entry, and crash-resume via on-disk checkpoints. Workflow definitions are now packaged as directories (`<name>/workflow.yaml`) with YAML preferred over JSON, required `description` fields surfaced in web UI tooltips and CLI inspect output, and arbitrary verdict strings for direct routing. The same engine runs identically behind the web UI (the intended interface), `mux`, and the `ironcurtain workflow start|resume|inspect|list` CLI (provided for scripting and debugging) (#159, #163, #165, #169, #188, #190).
- **Workflow shared-container mode** — opt in via `settings.sharedContainer: true` in a workflow YAML. One Docker container and one `ToolCallCoordinator` serve every agent state in the run; the orchestrator hot-swaps the active `PolicyEngine` between states via `POST /__ironcurtain/policy/load` over a per-run Unix domain control socket, and the coordinator swaps under `callMutex → policyMutex`. Audit entries are tagged with `persona` and written to a single `audit.jsonl` per run. Run artifacts consolidate under `~/.ironcurtain/workflow-runs/<id>/` with `bundle/`, `states/<stateId>.<visitCount>/`, `audit.jsonl`, and `messages.jsonl`; nothing lands under `~/.ironcurtain/sessions/` for a workflow run. The new `containerScope` primitive lets workflows split states across multiple bundles when isolation is needed. Implements Steps 4–5 of `docs/designs/workflow-container-lifecycle.md` (#184, #186, #187, #191).
- **Agent skills (SKILL.md)** — drop SKILL.md packages under `~/.ironcurtain/skills/<name>/` to make purpose-specific guidance available to every Docker session; the merged set is staged so each agent's _native_ skill discovery picks it up. Claude Code is pointed at the staging dir via `--add-dir <parent>`; Goose scans `~/.config/goose/skills/<name>/SKILL.md`. Each agent adapter declares its own `skillsContainerPath` and the Docker infrastructure issues a dedicated **read-only** bind mount at that path. Workflows ship per-state skills via `<workflow-pkg>/skills/<name>/SKILL.md` and an optional `skills: [...]` field on agent states (omit = all workflow skills, `none` sentinel = clean slate). Persona skills (`~/.ironcurtain/personas/<name>/skills/`) apply to standalone sessions. See [WORKFLOWS.md](WORKFLOWS.md#skills) (#227).
- **`ironcurtain doctor` command** — on-demand setup diagnostics that runs every health check independently and surfaces a single punch list (Node version, V8 sandbox viability, Docker availability with categorized errors, config parse, compiled policy / constitution / annotation drift, Anthropic OAuth/API-key presence and expiry, per-MCP-server env vars, and live `tools/list` against each configured server). Opt-in `--check-api` adds a 1-token round-trip and OAuth refresh validation (#206).
- **Pre-flight checks for sandbox / Docker / OAuth** — `start`, `daemon`, `bot`, and `workflow` now spawn a child Node process that imports `@utcp/code-mode` to validate the V8 sandbox before doing anything; SIGSEGV/SIGILL maps to "use Node 22–24", `NODE_MODULE_VERSION` to "npm rebuild", and missing packages to "npm install". Success is cached at `~/.ironcurtain/.preflight-ok`. Docker availability returns a tagged union with targeted messages for ENOENT, permission denied, and "Cannot connect to the Docker daemon." OAuth-only-without-Docker now fails fast with a remediation hint instead of silently dropping into builtin and later 401-ing. Mux runs the same preflight in the parent before entering fullscreen so failures surface cleanly (#203, #213, #244).
- **Configurable Docker container resources with auto-clamp and probe** — new `dockerResources: { memoryMb, cpus }` field in `~/.ironcurtain/config.json` (each independently nullable; `null` = no limit), editable via `ironcurtain config` → Docker Agent → Container resources. Values are auto-clamped against `os.cpus()` / `os.totalmem()` before reaching Docker. `ironcurtain doctor` and the first-start wizard run a real `docker run --rm --cpus N --memory Mm <image> /usr/bin/true` probe, parse Docker's stderr for rejection patterns, and suggest concrete lowered values. Necessary on small hosts (2-vCPU VMs) and on macOS Docker Desktop where `os.cpus()` over-reports vs. the VM (#247).
- **Idle-timeout watchdog for Docker pull / build** — replaces hard wall-clock timeouts on `docker pull` and `docker build` with a progress-aware idle watchdog (`spawnWithIdleTimeout`); legitimate multi-hour pulls of large base images (e.g. `devcontainers/universal`) now succeed, only true silence kills the child. A TTY-aware progress sink collapses the per-layer / per-step chunk flood into a single in-place updating status line (`docker pull  4/12 layers  2 downloading`); non-TTY stderr passes the raw transcript through (#250, #251, #260).
- **Linux UID/GID remap for agent containers** — on Linux hosts where the user's UID/GID isn't 1000, the agent container now starts as root (`--user 0:0`) with host UID/GID passed via env; the entrypoint runs `usermod`/`groupmod`/`chown` to renumber the baked `codespace` user to match the host, then drops privileges via `exec runuser -u codespace`. Fixes the "Not logged in / Please run /login" symptom on Kali, NixOS, and other non-default-UID environments where bind-mounted credential files were unwritable. macOS is unchanged. Centralized in `buildAgentUidRemap()` and shared by batch- and PTY-mode container creation (#245).
- **Per-persona / per-job memory opt-in** — `PersonaDefinition.memory?: { enabled: boolean }` and `JobDefinition.memory?: { enabled: boolean }` let users disable the memory MCP server for individual personas / cron jobs (default on). The global `userConfig.memory.enabled` kill switch still wins. `MEMORY_SERVER_NAME` was removed from the persona resolver's always-included set; the workflow orchestrator now spawns the memory relay only when at least one persona in scope opts in, closing a shared-container gap where the prompt advertised memory but the relay was absent. CLI surfaces the toggle via `persona create/edit`, `daemon add-job/edit-job`, and `ironcurtain config -> Memory` (#215).
- **Real-time LLM token stream observation** — the MITM proxy taps Anthropic/OpenAI SSE and JSON responses inside Docker agent sessions and publishes structured `TokenStreamEvent`s on a shared pub/sub bus. New `ironcurtain observe` command renders a Matrix-style data rain panel alongside formatted tool calls, results, thinking text, and assistant output by subscribing through the daemon's WebSocket. Workflow summary `totalTokens` is now accumulated from `message_end` events across all the workflow's agent sessions and displayed in the UI (#178, #211).
- **Matrix rain login page** — web UI auth screen renders a Canvas 2D Matrix rain that assembles into the "IronCurtain" wordmark (#180).
- **`IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` escape hatch** — opt-in env var makes the MITM proxy treat every unknown host as a passthrough TCP tunnel, bypassing the CONNECT allowlist for HTTPS, plain HTTP, and WebSocket upgrades. Provider/registry traffic is unchanged (TLS termination and credential swap still apply); only unknown hosts get the wildcard. Logs a `WARN` on proxy startup so the posture downgrade is visible in the audit trail (#249).
- **Sudo and apt-get inside agent containers** — Linux capabilities (SETUID, SETGID, CHOWN, FOWNER, DAC_OVERRIDE, AUDIT_WRITE) added so `sudo` works despite `--cap-drop=ALL`; `python3-pip` baked into both base images; `/etc/apt/apt.conf.d/90-ironcurtain-proxy` written into containers so `apt-get` routes through the MITM proxy; MITM plain-HTTP forwarding fixed for Debian registry hosts (#164).
- **Annotation drift warnings** — three drift-detection warnings between configured MCP servers and `tool-annotations.json` (policy-load time, MCP-connect time, and stale-on-disk). Previously such mismatches surfaced as silent per-call default-denies via the policy engine's `structural-unknown-tool` fallback (#193).
- **Ollama-style model IDs in workflow YAML** — `settings.model` and per-state `model` fields now accept opaque `name:tag` forms (e.g. `glm-5.1:cloud`) via a new `looseModelId` schema, while `~/.ironcurtain/config.json` slots stay on strict `qualifiedModelId` (#194).

### Behavior changes

- **Silent fallback to the builtin agent is gone.** `UserConfig` now carries `preferredMode: 'docker' | 'builtin'` (default `'docker'`); if `preferredMode: 'docker'` and Docker is unavailable, the session refuses to start with a remediation hint instead of silently dropping into builtin. `--agent` CLI flag continues to win over config. `ironcurtain doctor` treats declared-but-unmet preferences as failures (exit 1). Borderline-breaking for users who relied on the implicit downgrade — set `preferredMode: 'builtin'` explicitly, or pass `--agent builtin`, to keep the old behavior. Closes feedback where testers ran in builtin mode for hours without noticing (#225).
- **MCP relays only spawn for servers the policy actually references.** `extractRequiredServers(policy)` walks `rule.if.server` in the active compiled policy; unreferenced servers are dropped from `mcpServers` before relay subprocesses start. Default-deny would have rejected every call to them anyway. The workflow factory passes the per-scope union across all personas with the same `containerScope` (#208).
- **Spawn only MCP servers that successfully connect.** When every backend of an MCP proxy subprocess fails to connect (missing env var, missing OAuth, etc.), the proxy now exits non-zero instead of staying alive with an empty tool list and causing every annotated tool to be flagged by the drift check (#259).
- **Workflow definitions are directories.** Bundled workflows ship as `<name>/workflow.yaml` (with optional sibling `skills/`) rather than a single JSON file; YAML is preferred for new authoring. Custom `.json` user workflows continue to work (#169, #227).

### Fixes

- **`ironcurtain doctor` exit code + preflight cwd resolution** — `doctor` now exits non-zero when a declared `preferredMode` cannot be honored; the sandbox-viability preflight resolves `@utcp/code-mode` from the parent via `createRequire().resolve()` so running `ironcurtain` from outside the install tree (e.g. after `npm install -g`, from `~` or `/`) no longer falsely reports a missing dependency (#266).
- **Workflow agents wedged by `ScheduleWakeup`** — the schedule built-in skill's tools are stripped from `/v1/messages` request bodies for workflow agents, and conversation-history references to those tools (Claude Code's `ToolSearch` deferred-tool fetcher surfaces them as `tool_reference` entries and `<function>{...}</function>` schema blocks) are scrubbed so Anthropic doesn't 400 the next request. Closes a workflow-abort failure mode reproduced in multi-hour runs (#258, #263).
- **Per-leg state directories** — workflow forensic dirs (`states/{stateId}.{N}/`) are now keyed on a disk scan via `nextStateSlug()` rather than the FSM `visitCounts`, so resume legs of a single visit land in fresh dirs instead of overwriting the original leg's `session.log` and `session-metadata.json` (#264).
- **Per-hypothesis discovery/triage files** — `discover` and `triage` states write per-hypothesis files instead of overwriting a single shared artifact, preserving evidence across hypotheses (#264).
- **Status-block reprompt anchored on final response** — `buildStatusBlockReprompt` now tells the agent to emit `agent_status` on the **last** response only, fixing a `harness_build` failure where multi-checkpoint runs emitted intermediate blocks and a prose-only final turn that Claude Code's `-p` JSON output dropped (#254).
- **Rotate agent conversation id on upstream stall** — Claude Code mid-stream kill (exit 143 + empty output) now retries the original prompt up to 2 times with a freshly-minted agent conversation id, instead of sending a "missing status block" reprompt against a consumed session id (#195).
- **429 quota-exhaustion resilience** — workflow runs detect upstream 429s, short-circuit retries, preserve the checkpoint, and exit as aborted (not completed) so `workflow resume` accepts the run once the quota window reopens. Sustained upstream stalls (`exit=0` + `usage.output_tokens === 0` + `stop_reason === null`) are now classified as resumable transient failures via `AgentResponse.transientFailure` (#198, #210).
- **MITM token routing in shared-container workflows** — the proxy's routing `sessionId` is now mutable and flipped by the orchestrator around each `executeAgentState`; per-response `sidAtAttach`/`sidForToolResults` snapshots prevent a mid-stream flip from splitting a single SSE response across two ids (#211).
- **Deterministic-state failures forward to the next agent** — orchestrator now propagates deterministic-state errors as agent_status notes so downstream agents see the failure (#242).
- **MCP `isError` surfaces to Code Mode** — sandbox now throws on MCP `isError` so Code Mode LLMs see tool failures instead of silently consuming an error envelope (#185).
- **Docker batch mode multi-turn context** — switched from `claude -p --continue` (silently no-ops in non-interactive print mode) to `--session-id <uuid>` on first turn + `--resume <uuid>` thereafter, fixing context loss in web UI, cron, and workflow Docker sessions (#177).
- **Mux PTY session MITM bridge** — mount the bundle sockets dir so the MITM bridge is reachable (#209).
- **Web UI bad-auth-token recovery** — UI no longer wedges on a malformed bearer token; surfaces a re-auth flow (#182).
- **Web UI stuck at `waiting_human` after gate rejection** — phase tracking refreshes after a gate verdict (#173).
- **Web UI Matrix rain review fixes** — accessibility and performance polish to the login Canvas (#183).
- **Web UI markdown rendering** — use `prose-markdown` class for consistent typography (#170).
- **Web UI e2e tests** — repair after mobile drawer + gate auto-fetch changes (#212).
- **Goose PTY readiness probe** — stop spawning a doomed agent process during the readiness check (#226).
- **Shared `validatePolicyDir` helper** — `src/config/validate-policy-dir.ts` realpath-resolves candidate policy directories and enforces containment under the IronCurtain home or the package config dir; CLI flags, the `loadPolicy` RPC, and session creation all funnel through it (#207).
- **Shared `applyAllowedDirectoryToMcpArgs` helper** — single source of truth in `src/config/index.ts` for keeping `mcpServers.filesystem.args` in sync with the active `allowedDirectory`; fixes stale paths in shared-container workflow runs.
- **Audit stream errors latch** — `AuditLog` now remembers stream errors and surfaces them synchronously on the next `log()` instead of silently dropping entries.
- **Workflow run directory hardened at 0o700** — `chmodSync` enforces the mode so the control socket and audit log are protected by filesystem permissions.
- **Zero-constraint whitelist no longer blanket-approves `add_proxy_domain`** (#151).
- **Conversation state directory mounted in Docker batch mode** (#152).
- **Base-URL env vars validated** — `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_API_BASE_URL` are now `z.url()`-validated at config load (#257).
- **`npm test -- <file>` forwards the filter to vitest.**
- **Claude Code v2 telemetry and MCP marketplace endpoints** allowed through the MITM proxy.
- **Sanitize agent output** by escaping NUL bytes and truncating to 32KB.
- **Hash workflow artifact metadata, not contents** — avoids re-hashing huge artifacts on each transition.

### Dependencies

- Bump `uuid` from 13.0.0 to 14.0.0 (#233)
- Bump `axios` from 1.15.0 to 1.16.0 (#236)
- Bump `hono` from 4.12.14 to 4.12.18 (#237)
- Bump `fast-uri` from 3.1.0 to 3.1.2 (#238)
- Bump `postcss` (dev) from 8.5.6 to 8.5.14 (#235)
- Bump `actions/github-script` from 8 to 9 (#166)
- Recurring vulnerable-package upgrades.

### Internal

- **PolicyEngine + AuditLog centralized into `ToolCallCoordinator`** — the security pipeline (`tool-call-pipeline.ts`) now owns all policy/audit/circuit-breaker/whitelist state; MCP proxy server subprocesses became pure relays (#179).
- **`DockerInfrastructure` bundle with explicit lifecycle** — reframes the implicit "bag of stuff the session owns" into a typed handle with paired `createDockerInfrastructure` / `destroyDockerInfrastructure` and an `ownsInfra` flag on `DockerAgentSession`. Pure refactor, prerequisite for shared-container mode (#184).
- **Module layering rules** — guidance added to per-directory `CLAUDE.md` files; `src/pipeline/` is offline tooling that live-session runtime must not value-import. URL normalizers, list matcher, session error hierarchy, server listing, llm-logger, and misplaced constants moved to their correct layers; event bus generified; `WorkflowManager` moved out of `src/web-ui/` (#216, #217, #218, #219, #220, #221, #222, #223, #224).
- **TokenStreamBus migrated to module singleton** (#189).

## [0.10.0] - 2026-04-01

### Features

- **Custom API gateway support** — route LLM traffic through API gateways (LiteLLM, Ollama, etc.) via `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, and `GOOGLE_API_BASE_URL` environment variables or config file fields; the MITM proxy intercepts container traffic as usual but forwards upstream to the custom gateway; Code Mode passes `baseURL` directly to AI SDK providers (#148)
- **`--model` CLI flag** — override the agent model on `start` and `mux` commands (e.g., `--model jaahas/qwen3.5-uncensored:35b` for Ollama); `parseModelId()` now handles non-provider colon-separated tags; Claude Code adapter passes the model to the container via `--model` and `IRONCURTAIN_MODEL` (#148)
- **Haiku-based server pre-filter** — cheap Haiku pre-filter step during policy compilation skips servers irrelevant to the constitution, saving expensive Opus/Sonnet LLM calls; configurable via `prefilterModelId` in user config (#146)
- **Parallel server compilation** — compile all servers concurrently via `Promise.allSettled` with `p-limit` throttling (10 servers, 8 LLM calls); multi-line TTY progress display shows all servers simultaneously; adds `HTTPS_PROXY`/`HTTP_PROXY` support for AI SDK providers (#144)
- **`annotate-tools` requires explicit target** — `--server <name>` or `--all` flag required instead of always annotating everything; single-server mode merges with existing annotations; includes `--help` and server name validation (#142)
- **WebSocket and plain HTTP CONNECT tunnels** — WebSocket upgrade handling for `ws://` via `HTTP_PROXY`; passthrough CONNECT tunnels use raw TCP tunneling instead of TLS MITM, fixing plain HTTP and WebSocket connections (#139)
- **SSH agent socket in sandbox** — forward `SSH_AUTH_SOCK` into Docker containers for git operations requiring SSH keys
- **Workspace display in resume picker** — mux `/resume` picker shows the workspace directory (with `~/` shortening) when a session was started with `--workspace` (#149)
- **Enhanced Docker base images** — additional packages (`build-essential`, `cmake`, graphics/Qt libraries, common Python native deps) and passwordless sudo in arm64 image

### Fixes

- **x86_64 Dockerfile missing node-gyp** — install `node-gyp` globally in `Dockerfile.base` to match the arm64 variant; fixes Docker build failures on Windows/WSL2 (#147)
- **Stale Docker containers on resume** — clean up containers from previous sessions before starting a new one (#134)
- **Mux exited tab cleanup** — auto-remove exited tabs to restore the splash screen when all sessions end
- **Plain HTTP passthrough in MITM proxy** — fix plain HTTP connections through CONNECT tunnels for passthrough domains (#133)
- **Integration test reliability** — use local `mcp-server-filesystem` binary instead of global install

### Dependencies

- Bump `node-forge` from 1.3.3 to 1.4.0
- Bump `path-to-regexp` from 8.3.0 to 8.4.0
- Bump `picomatch` (security fix)

## [0.9.1] - 2026-03-25

### Fixes

- **macOS mux text selection** — replace X11 mouse tracking with alternate scroll mode on macOS so native text selection (Shift+drag) works in Terminal.app; scroll wheel works in command mode via arrow key mapping (#130)
- **macOS OAuth Keychain refresh** — refresh expired OAuth tokens from the macOS Keychain instead of silently falling back to API key auth; write refreshed tokens back to the Keychain via `security add-generic-password -U`; enable `OAuthTokenManager` self-refresh for Keychain-sourced credentials during long sessions (#131)

## [0.9.0] - 2026-03-24

### Features

- **Third-party OAuth onboarding** — full OAuth 2.0 flow for MCP servers with PKCE, callback server, token store with auto-refresh, interactive scope picker for Google services, `ironcurtain auth` CLI with setup guides, import, revocation, and incremental consent (#108)
- **Google Workspace MCP server integration** — credential-file rendezvous pattern (access-token-only, no refresh token in MCP server), `TokenFileRefresher` with proactive refresh, strict filesystem sandbox with `denyRead: ["~"]`, dynamic Node path discovery for nvm/volta/fnm/asdf, and new `share-permission`, `email-address`, `email-body` argument roles (#113)
- **Per-server policy compilation** — compile each MCP server independently with its own compile-verify-repair cycle, Zod-enforced server scoping to prevent cross-server rule leakage, per-server artifact caching for incremental recompilation, `--server` CLI flag for single-server debugging, annotation batching for 100+ tool servers, and point-fix repair mechanism that preserves passing rules (#118)
- **Policy-mediated MCP access for dynamic lists** — all MCP tool calls during list resolution are gated through a read-only PolicyEngine via the MCP proxy server; includes `--no-mcp` flag, compiled read-only policy covering all servers, and error surfacing for failed MCP calls (#122)
- **Escalation picker UI** — tab-per-escalation floating box overlay with single-key actions (a/d/w for approve/deny/whitelist), batch resolve-all via Shift+A/D, auto-open on new escalations with smart suppression, and narrow-terminal guards (#112, #116)
- **Ephemeral approval whitelisting** — whitelist domains, directories, or identifiers during escalation approval for session-scoped auto-approve; role-driven pattern extraction, `/approve+` syntax across CLI/mux/listener, full audit trail (#109)
- **Proxy MCP server for dynamic domains** — virtual tools (`add/remove/list_proxy_domain`) give Docker agents runtime control over MITM proxy domain allowlists via an HTTP control API on a host-only socket (#126)
- **Multiple parallel mux sessions** — per-session ownership via `muxId` replaces the global escalation-listener lock; per-session Docker networks prevent cross-session teardown; orphan detection via PID liveness checks (#110)
- **Auto-save session memory** — forced final turn after task completion prompts the agent to store session context via `memory.store`; works across all transports, configurable via `memory.autoSave` (#124)
- **Tool argument validation against input schemas** — proxy validates argument names against MCP tool `inputSchema` before forwarding, returning actionable errors with valid parameter names so the agent can self-correct (#125)
- **Scenario argument schema validation** — `inputSchema` stored on tool annotations and validated at the Zod level during scenario generation and verification, catching wrong argument names before they reach the LLM (#122)

### Fixes

- **Google Workspace token expiry** — immediate refresh check on `TokenFileRefresher.start()` and `forceRefresh()` that bypasses the 5-minute early-return threshold, preventing tokens from expiring mid-session (#123)
- **Sandbox arg resolver mangling npm packages** — skip scoped (`@org/pkg`) and versioned (`pkg@1.2.3`) specifiers when resolving relative args to absolute paths (#119)
- **Mux PTY key forwarding** — forward raw terminal-kit bytes instead of mapping key names, fixing broken Shift+Tab, F-keys, and Alt+arrow sequences (#127)
- **Claude Code WebFetch in Docker** — add `skipWebFetchPreflight` and `HTTPS_PROXY` to Docker settings so WebFetch works through the MITM proxy (#129)
- **Docker exec timeout logging** — detect and log timeout duration for docker exec calls; guard against empty Signal responses (#128)
- **Fetch server JSON responses** — return structured `{ error, status, headers, body }` JSON from `http_fetch` instead of concatenated plain text (#114, #115)
- **SSH agent forwarding** — forward `SSH_AUTH_SOCK` to the MCP server proxy process, fixing 60-second hangs on `git push`
- **Mux shutdown spinner** — exit fullscreen before showing the shutdown spinner so it is always visible on `/quit`
- **workspace:\* protocol** — replace pnpm-specific `workspace:*` with semver range for npm compatibility (#111)

### Improvements

- **Remove sideEffects from tool annotations** — the boolean was nearly useless (81/85 tools marked true); argument roles already capture security-relevant characteristics (#118)
- **Remove monolithic compilation path** — all compilation routes through `runPerServer()`, deleting ~577 lines of dead code (#122)
- **Increase Docker container resources** — bump defaults to 8 GB memory and 4 CPUs for resource-intensive workloads (#107)
- **storedAnnotations mandatory throughout pipeline** — single required code path after monolithic removal, eliminating optional guards and fallbacks (#122)

## [0.8.0] - 2026-03-15

### Features

- **Secure package installation proxy** — npm and PyPI registries are proxied through the MITM layer with metadata filtering (age-gate quarantine, allow/denylists), tarball backstop validation, and per-package audit logging; containers can now `npm install` and `pip install` packages at runtime without direct network access (#101)
- **Debian apt registry proxy** — `apt-get install` works inside Docker containers by proxying `deb.debian.org` and `security.debian.org` through the MITM proxy; GPG-signed metadata passes through unmodified, `.deb` downloads go through backstop validation (#105)
- **Memory MCP server integration** — persistent memory with semantic search, LLM summarization, and automatic compaction; integrates with personas and sessions for context-aware recall (#95, #98)
- **Persona picker in mux mode** — interactive persona selection overlay in the `/new` flow with workspace browsing pre-filled from persona defaults (#104)
- **Session resume for Docker PTY sessions** — resume previous sessions with `--resume`, conversation state persistence, snapshot validation, and session scanner UI (#94)
- **Server-namespace tool naming** — tools use `serverName__toolName` format with prefix stripping for cleaner display (#102)
- **Pre-installed Python 3.12 in Docker base images** — containers no longer need to download Python at runtime, preventing failures in network-isolated environments

### Fixes

- **PyPI sidecar file handling** — strip PEP 658/714 sidecar suffixes (`.metadata`, `.provenance`) before filename parsing in the registry proxy, fixing fail-closed denials for pip/uv metadata fetches (#105)
- **Memory context missing memories** — fix `memory_context` tool not returning memories and LLM config passthrough (#103)
- **Roots expansion race condition** — retry tool calls after roots expansion with 200ms delay when the filesystem server hasn't finished processing updated roots (#93)
- **Harden arm64 Docker base image** — expand system packages with build tools, graphics/Qt libraries, X11/XCB deps, and fonts needed for Python packages with native extensions (#105)
- Upgrade vulnerable package versions

### Improvements

- **Re-enable OS-level sandbox for git MCP server** — upgrade `@anthropic-ai/sandbox-runtime` to 0.0.42 which supports selective network access on Linux; git server now runs sandboxed with filesystem restrictions (`~/.gnupg`, `~/.aws` denied) and network limited to GitHub/GitLab domains
- Use `UV_NATIVE_TLS` in Docker base images for MITM CA trust with uv
- Shared Python install directory (`/opt/uv-python`) across users
- Use Debian Trixie base for arm64 image (GLVND transition)

## [0.7.2] - 2026-03-11

### Fixes

- **Mux command-mode input retention** — preserve the input buffer when toggling between command mode and PTY mode with Ctrl-A; previously any typed text was lost on mode switch
- **Stay in command mode after /new** — spawning a new session via `/new` (quick-spawn or directory picker) now returns to command mode instead of switching to PTY mode

## [0.7.1] - 2026-03-10

### Fixes

- **macOS PTY session networking** — reverse PTY socat direction in the sidecar so the host can reach the container's PTY socket (MCP/MITM remain container→host); skip the readiness probe for TCP since the container's socat only accepts one connection; add retry logic in `attachPty` that polls until the connection receives data; allocate dynamic host ports via `findFreePort()` to avoid collisions between concurrent PTY sessions (#89)
- **Filesystem server path in PTY sessions** — export and reuse `patchMcpServerAllowedDirectory()` so the filesystem MCP server's directory arg points to the actual session workspace instead of the stale default from `loadConfig()` (#87)
- **macOS node-pty spawn-helper** — auto-fix missing execute permission on the node-pty `spawn-helper` binary at startup; show actionable error if chmod fails (e.g., read-only npx cache)
- **MITM leaf certificate renewal** — track per-cert expiry and regenerate 1 hour before the 24-hour validity window closes, preventing "SSL certificate has expired" errors in long-running sessions (#84)
- **OAuth token endpoint** — update refresh endpoint from `console.anthropic.com` to `platform.claude.com/v1/oauth/token`
- **Sentinel triage** — widen the `since` window from 24 hours to 30 days so expired challenges are not silently filtered; use `includes()` for marker matching
- Upgrade vulnerable package versions

### Features

- **Persona system** — named profiles bundling a constitution, compiled policy, server filter, persistent workspace, and memory file under `~/.ironcurtain/personas/<name>/`; CLI commands (`persona create/list/compile/edit/delete/show`), `--persona` flag for `start`, Signal `/new [persona]`, cron `persona` field, and session metadata persistence for `--resume` (#82)
- **Auto-generate constitutions for cron jobs** — Code Mode session with read-only policy explores the workspace and MCP servers to produce a tailored constitution (#77)
- Design documents for Memory MCP Server and Session Resume

### Improvements

- Extract `isUserContextTrusted` helper from `handleCallTool` for independent testability (#86)
- Extract `formatAnnotationsSummary` to eliminate duplicate annotation-formatting logic (#81)
- Remove `extractPathsHeuristic` from policy engine; rely solely on tool annotations for path extraction (#78)
- Flatten `resolveDefaultGitRemote` with named git helpers (#75)

### Tests

- Coverage for `docker/audit-log-tailer`, `pipeline/pipeline-shared`, `pipeline/generate-with-repair`, `pipeline/list-resolver`, `cron/format-utils`, and signal formatting modules (#72, #73, #74, #80, #83, #85)

## [0.7.0] - 2026-03-06

### Features

- **Cron mode** — unified daemon with per-job policy, scheduled sessions via `ironcurtain cron add/list/remove/run`, job-specific constitutions and compiled policies (#63)
- **Daemon & cron polish** — Signal transport fixes, CLI help improvements, job management enhancements (#70)
- **Goose agent adapter** — run Goose as an external agent in Docker Agent Mode with auto-generated YAML config and provider-specific env vars (#55)
- **Conditional argument role assignment** — role specs can include conditions evaluated against tool call arguments for multi-mode tools (#60)
- **Mux bracketed paste and multiline input** — paste detection with bracketed paste sequences, multiline editing support (#57)
- **Sentinel triage workflow** — auto-close expired agent challenges via GitHub Actions

### Fixes

- Ensure PTY session cleanup on mux shutdown
- Don't auto-scroll to bottom on new mux output (#61)
- Stay in command mode after sending trusted input
- Bypass MCP SDK client-side `outputSchema` validation on error responses (#54)
- Allow workspace to contain in-package protected paths

### Improvements

- Remove duplicate image-building methods from `DockerAgentSession` (#68)
- Extract `DEFAULT_DENY_RESULT` and `ruleToResult()` in policy engine (#62)
- Extract `pushColorSgr` helper in `buildSgrSequence` (#65)
- Merge identical ESCAPE and Ctrl-C branches in `handleCommandKey` (#66)

## [0.6.0] - 2026-03-03

### Features

- **Terminal multiplexer** — `ironcurtain mux` provides a terminal multiplexer for managing multiple PTY sessions with tab management (`/new`, `/tab N`, `/close`), trusted input forwarding, workspace picker (fresh sandbox or existing directory via interactive file browser), mouse wheel scrollback, and escalation overlay for informed approve/deny decisions; uses headless xterm.js with SGR attribute rendering and resize propagation
- **Matrix-style splash screen** — mux startup shows a Matrix rain animation that forms "IronCurtain" in ASCII art with usage info; small-terminal fallback for narrow viewports (#53)
- **`--workspace` flag** — `ironcurtain start -w ./path` points the agent at an existing directory instead of a fresh sandbox; validates against root, home, `~/.ironcurtain/`, and bidirectional protected-path overlap (#51)
- **OAuth token auto-refresh in MITM proxy** — proactive refresh before token expiry and reactive 401 retry as fallback for long-running Docker PTY sessions; read-only mode on macOS to avoid rotating Keychain-sourced refresh tokens; security hardening for transfer-encoding stripping, credential injection scoping, and 0600 file permissions (#50)

### Improvements

- Graceful process shutdown — unref intervals and stdin in escalation watcher, listener, agent session, and escalation handler to prevent blocking process exit

## [0.5.1] - 2026-03-01

### Features

- **Reverse path rewriting for Docker agent sessions** — MCP server results containing host sandbox paths are now rewritten back to `/workspace` before reaching the agent, completing the symmetric path translation; `CONTAINER_WORKSPACE_DIR` extracted as a shared constant (#49)
- **Improved Docker agent system prompt** — remove bind-mount details and host path exposure, replace with clear guidance on when to use `execute_code` vs built-in tools; add attribution guidance for IronCurtain (#49)

### Fixes

- Skip MCP servers with missing environment variables instead of crashing — graceful degradation when Docker `-e VAR_NAME` forwarding references unset host env vars
- Resolve PTY size mismatch in Docker agent sessions — set initial PTY size via env vars before exec'ing Claude, add verify+retry loop with `check-pty-size.sh`, use `pgrep -x claude` for reliable process detection
- Stabilize TCP transport test on macOS — use message-flow synchronization instead of probe-based polling

## [0.5.0] - 2026-03-01

### Features

- **PTY mode for Docker agent sessions** — `ironcurtain start --pty` provides interactive terminal access to Claude Code running inside Docker, with host-side Node.js PTY proxy bridging the user's terminal to the container via UDS (Linux) or TCP (macOS), SIGWINCH forwarding, and Ctrl-\ emergency exit (#43)
- **Escalation listener TUI** — `ironcurtain escalation-listener` command with a terminal dashboard that aggregates escalations across multiple concurrent PTY sessions; approve/deny via `/approve N` and `/deny N` commands with incremental rendering to preserve input state (#43)
- **OAuth support for Docker agent sessions** — auto-detects credentials from `~/.claude/.credentials.json` (via `claude login`) or macOS Keychain and prefers them over API keys; real tokens never enter the container — a fake sentinel is swapped for the real bearer token by the MITM proxy (#47)
- `IRONCURTAIN_DOCKER_AUTH=apikey` environment variable to force API key mode when both OAuth and API key credentials are available
- **GitHub MCP server integration** — add the official GitHub MCP server as the 4th built-in server with 41 annotated tools, `github-owner` argument role with case-insensitive canonicalization, owner-scoped policy rules, and GitHub identity discovery for policy customization; graceful degradation when Docker is unavailable (#38)
- **Audit log PII/credential redaction** — masks credit cards (Luhn-validated, keeps first/last 4), US SSNs (area/group/serial validated, keeps last 4), and API keys (OpenAI, GitHub PAT, Slack, AWS) at any nesting depth; enabled by default (#16)
- **Improved MCP error messages** — extract meaningful error messages from McpError exceptions instead of opaque schema validation errors; track git server working directory and display it in escalation requests so reviewers know which repo is affected (#46)
- **Signal bot multi-session support** — managed session map with auto-incrementing labels, `#N` prefix for one-shot message routing without switching sessions, configurable max concurrent sessions, and escalation reply auto-routing with disambiguation
- **Interaction log** — JSONL logging of each conversational turn (user prompt + assistant response) to `{sessionDir}/interactions.jsonl` via new BaseTransport abstract class
- **First-start wizard safe to re-run** — loads existing config, pre-fills defaults from current settings, skips prompts for values already configured, accumulates changes atomically so cancelling mid-wizard never writes partial state (#34)
- lint-staged integration for pre-commit formatting and linting checks

### Security

- **Mount only sockets subdirectory into Docker containers** — previously the entire session directory was bind-mounted read-write, giving a compromised agent access to escalation files and audit logs; now only the `sockets/` subdirectory is mounted (#42)
- Eliminate ReDoS risk in credit card regex — replace nested quantifiers with flat pattern to avoid exponential backtracking
- Update minimatch to 10.2.4 (CVE-2026-27903)

### Fixes

- Display escalation context in listener dashboard — the TUI was not rendering the context field even though all other display paths did
- Defer session map removal until after successful close so the session remains trackable and retryable if close fails
- Spawn tsx directly instead of via npx to prevent orphaned child processes — npx's intermediate `sh -c` process doesn't forward SIGTERM, causing "close timed out" warnings in vitest

### Improvements

- Reduce test execution time from 102s to 33s by replacing fixed setTimeout delays with fake timers and event-driven polling helpers
- Upgrade production and development dependencies

### Docs

- Restructure README with PTY/escalation-listener and web search sections
- Move architecture diagrams from README into SANDBOXING.md
- Clarify audit redaction is enabled by default

## [0.4.1] - 2026-02-27

### Features

- Progressive tool disclosure for Docker agent mode — replace the full inline tool catalog (~3,150 tokens) with compact server-names-only listing (~770 tokens, 75% reduction) and on-demand `help.help()` discovery (#31)
- Protect entire `~/.ironcurtain/` directory with scoped sandbox exclusion, preventing new files (e.g. CA certs) from being unprotected (#30)

### Fixes

- Fix Docker agent web search — the MITM proxy strips server-side tools but the prompt incorrectly told the agent they would work, causing hallucinated results; now directs the agent to use the MCP `web_search` tool with concrete examples
- Fix macOS Docker Desktop connectivity via socat sidecar — containers on `--internal` networks cannot reach the host, so a sidecar bridges the internal network to host-side proxies (#32)
- Loop boilerplate tag removal in fetch server to prevent nested-tag bypass (CWE-116)
- Bound `resolveRealPath` ancestor walk with explicit depth limit

### Improvements

- Refactor MCP proxy server main function into smaller, purpose-oriented utilities
- Nix development shell via flake.nix (#29)
- Run CI on macOS in addition to Linux

### Docs

- Update SECURITY_CONCERNS to document socat sidecar isolation as equivalent to Linux `--network=none`
- Enhance CONTRIBUTING and TESTING documentation with pre-commit hook setup

## [0.4.0] - 2026-02-25

### Features

- Signal messaging transport -- run IronCurtain sessions via Signal messages (#27)
- macOS Docker Desktop support for Docker Agent Mode via TCP proxy transport, ARM64 base image, and `--internal` network egress restriction (#24, #25, #28)
- Content-Encoding filtering in MITM proxy to reject unsupported encodings

### Improvements

- Protect `.env` and user config from agent access (#23)
- Cross-platform reliability fixes for audit log tailing and sandbox path resolution
- Pin Node 22 LTS and cap engines below Node 26 (#20)

### Docs

- Design doc for TCP mode network egress restriction with macOS test plan
- Signal messaging transport design and brainstorm docs

## [0.3.1] - 2026-02-25

### Features

- Web search tool with multi-provider support (Brave, Tavily, SerpAPI)
- Web search configuration in interactive editor and first-start wizard
- CONFIG.md documenting all configuration options

### Improvements

- Strip server-side injected tools from Anthropic API requests
- Fix constitution loading to fall back to bundled user constitution base
- Thread sandbox directory path to policy verifier for accurate scenario generation
- Add `not-allow` scenario decision type for flexible handwritten scenario verification
- Fix `deepMergeConfig` to support section removal via empty object sentinel
- Improve MITM proxy request filtering for Docker Agent Mode

### Docs

- Consolidate design docs into single directory

## [0.3.0] - 2026-02-24

### Features

- TLS-terminating MITM proxy for Docker Agent Mode (#17)
- Docker agent broker with auto-mode selection (#14)
- First-start wizard for new installations (#15)
- Policy customization pipeline and default-deny model
- Prompt caching (#12)
- Add show-system-prompt script for MCP server tool listing

### Improvements

- Enable strictTypeChecked ESLint and eliminate non-null assertions (#13)

### Docs

- Update README with customize-policy workflow and current constitution
- Correct minimum Node.js requirement to 20 (not 18)

### Chores

- Add Semgrep CI and .semgrepignore for build artifacts
- Rename design docs

## [0.2.0] - 2026-02-22

### Features

- Add Readability-based article extraction to fetch server (#11)
- Allow user-local constitution override (#9)
- Improve escalation timeout handling in proxy and sandbox
- Implement escalation timeout for UTCP SDK client requests
- Add interactive configuration command and enhance user config management
- Add demo GIF and update README for enhanced visualization
- Add comprehensive review instructions for copilot

### Fixes

- Update Node.js engine requirement to >=20.19.0
- Move constitution freshness check into main
- Use tilde paths in shipped policy artifacts (#10)
- Add timeout to root expansion and use annotation-driven path filtering (#8)
- Pin marked to v15 for marked-terminal compatibility
- Trigger CI on master branch, not main
- Test on Node 22 and 24 (isolated-vm requires newer V8)

### Refactoring

- Slim RoleDefinition interface and relocate URL utilities (#7)
- Update PolicyEngine terminology and clarify evaluation phases

### Chores

- Centralize version string via `src/version.ts`
- Add GitHub Actions release workflow
- Dependency updates via Dependabot

## [0.1.0] - 2026-02-20

Initial public release.

### Features

- Secure agent runtime with trusted process mediation
- Policy engine with two-phase evaluation (structural + compiled rules)
- LLM-powered policy compilation pipeline (annotate, compile, verify)
- OS-level sandboxing for MCP servers via bubblewrap/socat
- Multi-turn interactive sessions with escalation handling
- Auto-approver for LLM-based escalation decisions
- Auto-approver with argument handling and sanitization
- Dynamic lists for policy rules (domains, emails, identifiers)
- Fetch server for HTTP GET requests
- LLM-assisted constitution customization CLI
- Resource budget management (tokens, steps, wall-clock, cost)
- Auto-compaction for message history management
- Circuit breaker for repeated tool call detection
- MCP Roots protocol integration for dynamic directory management
- ArgumentRole registry for annotation-driven argument normalization
- Multi-provider model support (Anthropic, OpenAI, Google)
- Interactive configuration command (`ironcurtain config`)
- Session logging with credential redaction

### Infrastructure

- CI pipeline with Node 22/24 matrix testing
- Code of Conduct, Contributing guidelines, Security policy

[Unreleased]: https://github.com/provos/ironcurtain/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/provos/ironcurtain/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/provos/ironcurtain/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/provos/ironcurtain/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/provos/ironcurtain/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/provos/ironcurtain/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/provos/ironcurtain/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/provos/ironcurtain/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/provos/ironcurtain/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/provos/ironcurtain/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/provos/ironcurtain/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/provos/ironcurtain/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/provos/ironcurtain/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/provos/ironcurtain/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/provos/ironcurtain/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/provos/ironcurtain/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/provos/ironcurtain/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/provos/ironcurtain/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/provos/ironcurtain/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/provos/ironcurtain/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/provos/ironcurtain/releases/tag/v0.1.0

# Configuration Reference

IronCurtain reads its settings from `~/.ironcurtain/config.json` (`$IRONCURTAIN_HOME/config.json` when
[`IRONCURTAIN_HOME`](#environment-variables) is set). Every field is optional; a missing field uses its default.
API keys, base URLs and the OS sandbox policy can also come from the environment, which then wins over the file
(see [Environment variables](#environment-variables)).

## Quick Start

```bash
# Interactive editor
ironcurtain config

# Or edit JSON directly
$EDITOR ~/.ironcurtain/config.json
```

`ironcurtain config` covers models, security, resource limits, auto-compaction, web search, model providers,
server credentials, memory, LLM statistics, container snapshots, the session mode and the Docker agent. The
remaining fields below are file-only; each table says so where it matters.

## How the file is read and written

- **Validation.** A value of the wrong type or out of range stops every command with `Invalid config in <path>`
  and the field that failed. A model ID whose provider prefix is a near miss (`anthropc:`, `opnai:`, `Google:`)
  is an error that names the provider it resembles.
- **Unknown fields.** A field the schema does not know, at any depth (for example `resourceBudget.maxStep`), is
  reported on stderr once per process, with a "did you mean" suggestion when a known field is close. It is
  otherwise ignored and kept in the file; `ironcurtain doctor` lists such fields on its `User config` line. A few
  sections are strict, so a misspelled key there is an error instead: `contentAssessment`, `policy`,
  `taintEscalation`, `egressPolicy`, `credentialProtection`, `agentCliVersions`, `dockerWorkload` and each
  `resourceBudget.modelPricing` entry.
- **Defaults written back.** Loading the file adds the missing fields of the main sections with their default
  values and says so on stderr (`Backfilled config fields: ...`). API keys, `serverCredentials`, `webSearch`,
  `modelProviders` and `signal` are never added, and neither is any setting marked "not backfilled" below.
- **Saving.** `ironcurtain config`, the web UI and the setup wizards rewrite the file atomically and owner-only
  (`0600`) under a lock (`config.json.lock`; a writer that waits more than 10 seconds fails with
  `FILE_LOCK_TIMEOUT` and writes nothing). The previous version is kept as `config.json.bak` (also `0600`; it can
  still hold a key the latest save removed). A file that is not valid JSON is never overwritten: the save fails
  with `Invalid JSON in <path>: ... Nothing was saved; fix or remove the file first.` A symlinked `config.json`
  (for example one a dotfile manager owns) stays a symlink, but the directory it points into must be writable.
- **Permissions.** The file is created `0600`. A warning is printed when it is readable by other users, since it
  may contain API keys.

| Field            | Type    | Default  | Description                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setupCompleted` | boolean | _(none)_ | Written by IronCurtain, not a setting. `true` once the first-start wizard completed; `false` when another command created the file. While it is `false` (or the file is missing), each interactive `ironcurtain start` offers the wizard first (declining it skips setup, not the task), and `mux` and `daemon` print a note. A file from before the marker existed has no field and counts as set up. Not backfilled. |

## Models

| Field                   | Type   | Default                       | Description                                                                                                                                                                                                                                                                   |
| ----------------------- | ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentModelId`          | string | `anthropic:claude-sonnet-4-6` | The agent's model: the builtin agent's, and the model Claude Code and Codex start with. A persona's `agentModelId`, a workflow's `model` or `--model` overrides it (see [Model precedence](#model-and-limit-precedence)). Format: `provider:model-name` or a bare model name. |
| `policyModelId`         | string | `anthropic:claude-sonnet-4-6` | Model for policy compilation (`compile-policy`, persona and job compiles).                                                                                                                                                                                                    |
| `policyVerifierModelId` | string | _(policy model)_              | Model that generates the test scenarios and judges the compiled rules during compilation. When unset, `policyModelId` does both. Uses the `policy` host profile binding. Not backfilled.                                                                                      |
| `prefilterModelId`      | string | `anthropic:claude-haiku-4-5`  | Cheap model that decides, before compilation, which MCP servers a constitution has guidance for. A server it skips stays default-deny.                                                                                                                                        |
| `gooseProvider`         | string | `anthropic`                   | Provider the Goose agent uses: `anthropic`, `openai` or `google`.                                                                                                                                                                                                             |
| `gooseModel`            | string | `claude-sonnet-4-20250514`    | Model the Goose agent starts with. Goose reads it once per container; a workflow state's `model` changes it only at container start.                                                                                                                                          |

Supported providers: `anthropic`, `google`, `openai`. Use the `provider:model-name` format and provide the API
key for each provider you use (see [API keys and base URLs](#api-keys-and-base-urls)):

```json
{
  "agentModelId": "anthropic:claude-sonnet-4-6",
  "policyModelId": "google:gemini-2.5-flash",
  "googleApiKey": "AIza..."
}
```

### Model and limit precedence

A session's agent model comes from the first of: `--model` on the command line, the workflow state's `model`,
the workflow's `settings.model`, the persona's `agentModelId`, and `agentModelId` above.

Resource limits are resolved field by field, highest first: a workflow's `settings.resourceBudget` or a cron
job's `budgetOverrides`, the persona's `resourceBudget`, the defaults the caller saved (a workflow run's limits
at start, the cron defaults), and `resourceBudget` below. A `null` at any layer disables that limit, and a higher
layer can set it again. Persona limits do not apply to interactive PTY sessions (mux tabs, web terminals,
`start --pty`), which use the global limits.

## Session mode and Docker agents

| Field                          | Type            | Default       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | --------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preferredMode`                | string          | `container`   | Session mode when no `--agent` is given: `container` (a Docker agent) or `builtin` (Code Mode). The legacy value `docker` means `container`. There is no silent fallback: when the preferred mode's prerequisites are missing, the session refuses to start and says why.                                                                                                                                                                                                               |
| `preferredDockerAgent`         | string          | `claude-code` | Docker agent for `container` mode: `claude-code`, `goose` or `codex`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `containerRuntime`             | string          | `auto`        | Container backend: `auto`, `docker` or `apple-container`. `auto` prefers Apple `container` when its preflight passes (Apple silicon, macOS 26+, services running) and falls back to Docker. `IRONCURTAIN_CONTAINER_RUNTIME` overrides it.                                                                                                                                                                                                                                               |
| `agentSudo`                    | boolean         | `true`        | Passwordless sudo for the agent inside its container. `false` runs the agent as numeric UID 1000 with `--security-opt no-new-privileges` and none of the file-privilege capabilities: no sudo, no `apt-get install`, no system trust store (tools rely on the trust environment variables). On Linux Docker it requires IronCurtain itself to run as UID 1000; it is refused with Apple `container` and with nested Docker. Also under `ironcurtain config` → Security. Not backfilled. |
| `agentCliVersions.claude-code` | string          | _(pinned)_    | Claude Code version for the agent image: an exact version (`2.1.292`) or `latest`. Absent uses the version this IronCurtain release pins and qualified. Changing it rebuilds the image; with `latest`, run `ironcurtain images rebuild` to pick up a new release. A CLI outside the qualified range is logged as a warning at session start. Not backfilled.                                                                                                                            |
| `agentCliVersions.codex`       | string          | _(pinned)_    | The same for the Codex CLI. Goose has no override.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `dockerResources.memoryMb`     | integer \| null | `8192`        | Container memory ceiling in MB (`--memory`, minimum 6); swap is disabled (`--memory-swap` equals `--memory`). `null` passes no limit. Clamped to the host's capacity at run time. With nested Docker it is the whole session's envelope.                                                                                                                                                                                                                                                |
| `dockerResources.cpus`         | number \| null  | `4`           | Container CPU ceiling (`--cpus`, minimum 0.01). `null` passes no limit. Clamped to the host's capacity at run time.                                                                                                                                                                                                                                                                                                                                                                     |
| `dockerResources.pidsLimit`    | integer \| null | `4096`        | Process ceiling (`--pids-limit`, minimum 16). `null` passes no limit. With nested Docker it is the session's whole PID budget (minimum 512; `null` means 4096). Agent containers also get `--ulimit nofile=65536`.                                                                                                                                                                                                                                                                      |
| `maxConcurrentAgentSessions`   | integer         | `4`           | Workflow agent environments alive at once in one process (the daemon, or one CLI workflow run), 1-64. A shared-container workflow counts once per container scope; every other workflow agent session counts once while it lives. Requests over the cap wait for a slot; a shared-container workflow with more scopes than the cap is refused at start. Read when the process starts. File-only.                                                                                        |
| `capture.enabled`              | boolean         | `false`       | Record verbatim agent-to-provider exchanges at the MITM proxy as training data. `--capture-traces` turns it on per invocation. See [TRAJECTORIES.md](TRAJECTORIES.md). Not backfilled.                                                                                                                                                                                                                                                                                                  |
| `snapshot.enabled`             | boolean         | `true`        | Kill switch for workflow container snapshots (`settings.snapshotOnStop`) and their garbage collection.                                                                                                                                                                                                                                                                                                                                                                                  |
| `snapshot.maxAgeDays`          | number \| null  | `7`           | Snapshot images older than this are removed by the sweep; `null` keeps them.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `snapshot.sweepIntervalHours`  | number          | `24`          | How often the snapshot sweep runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `snapshot.maxBytes`            | integer \| null | `null`        | Largest container to snapshot, in bytes (`ironcurtain config` asks in GiB). A larger container stops without a snapshot, and so does one whose size plus 1 GiB is more than the free space in the temporary directory or the engine's data root (twice its size when both share a filesystem); its resume starts that scope fresh.                                                                                                                                                      |

Snapshot images carry the label `ironcurtain.snapshot.owner` (a hash of the workflow runs' base directory), so
the sweep only removes images that base directory created. Unlabelled legacy images are considered only in
this IronCurtain home's own workflow-runs directory; external base directories cannot reclaim them. A run's stops apply the same ownership check, whatever its checkpoint names. With `agentSudo: false`, resume does not use a
snapshot taken while the agent had sudo, or one that does not record whether it had: that scope starts from a
fresh container, and its workspace is kept.

## Security

The coordinator and MCP relay admit up to 4,096 nodes per tool call and a nesting depth of 32. The argument object is the first node, at depth zero. These limits include every field. For policy evaluation, role-bearing arguments also have limits of 256 scalar values per argument and 1,024 per call. Resource identifiers are limited to 16 KiB per value and 256 KiB of characters in total. The limits are fixed. When a call exceeds the node or depth limit, its audit entry records the decision with an empty arguments object. Missing, empty, legacy or incompletely validated dynamic lists cannot narrow escalation/deny conditions; refreshing a list without validation loss records completeness. Legacy artifacts may require more human approvals until refreshed. Workspace-derived policy roots that resolve outside their workspace are refused; deliberately external trusted roots remain supported. Git tools refuse a repository containing a specific protected audit/config path, even for metadata operations. Set an absolute `AUDIT_LOG_PATH` outside the checkout and retain configured file protections when relocating them. Wrap-up needs explicit tracked working-directory context before per-call human approval.

| Field                                 | Type     | Default                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `escalationTimeoutSeconds`            | integer  | `300`                        | Seconds an escalated tool call waits for a decision (30-600). When it expires the call is denied and audited as `timed-out`. An `execute_code` script may run for the longer of this wait and the 300-second backend call bound (plus 15 s), plus 30 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `autoApprove.enabled`                 | boolean  | `false`                      | Let an LLM approve escalated tool calls that the user's most recent message clearly authorizes. It never denies: anything it does not approve goes to a human. A message authorizes for 120 seconds after it was sent, and every escalated resource (a path or its directory, a destination host, a git remote name) must be named in it. Human-only escalations (such as `add_proxy_domain`) never reach it, and it is off in workflows.                                                                                                                                                                                                                                                                           |
| `autoApprove.modelId`                 | string   | `anthropic:claude-haiku-4-5` | Model used for auto-approval decisions. Without a key for it, auto-approval is turned off and escalations go to a human.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `sandboxPolicy`                       | string   | _(platform)_                 | What happens to an MCP server that asks for an OS sandbox when sandbox-runtime cannot provide one (unsupported platform, `bubblewrap`, `socat` or `ripgrep` missing on Linux, or srt unable to start a sandbox on this host, which one srt test run per process checks). `enforce` (default on Linux and macOS): that server does not start, the others keep running. `warn`: it runs without OS containment and the session prints a warning. The same applies when `annotate-tools`, `compile-policy` or `mcp add` start servers to list their tools. `IRONCURTAIN_SANDBOX_POLICY`, then `SANDBOX_POLICY`, override it; an invalid value is an error. Also under `ironcurtain config` → Security. Not backfilled. |
| `policy.onStale`                      | string   | `warn`                       | A compiled policy whose provenance says it may be stale (built by another compiler or engine version, against other annotations, or before provenance was recorded): `warn` uses it with a warning, `refuse` fails session start and workflow policy hot-swaps. Also under `ironcurtain config` → Security. Not backfilled.                                                                                                                                                                                                                                                                                                                                                                                         |
| `fetch.allowPrivateNetworks`          | boolean  | `false`                      | Let `http_fetch` reach private and loopback destinations the requested URL names literally (private IP literals, `localhost`, `*.localhost`). Metadata addresses and names, link-local addresses, other local names (`.local`, `.internal`, ...) and names whose DNS answers are private stay blocked, and a redirect never changes origin. File-only; not backfilled.                                                                                                                                                                                                                                                                                                                                              |
| `credentialProtection.extraPaths`     | string[] | `[]`                         | More host paths agents can never read or write (protected paths). Each must be absolute or start with `~/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `credentialProtection.disabledStores` | string[] | `[]`                         | Credential stores to stop protecting, from: `ssh`, `aws`, `gnupg`, `gcloud`, `docker`, `git-credentials`, `netrc`, `npmrc`, `gh`, `kube`. The stores IronCurtain itself uses (`claude-code`, `anthropic-cli`, `codex`, `ironcurtain-oauth`) are always protected and cannot be listed.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `taintEscalation.enabled`             | boolean  | `false`                      | Sequence-aware escalation. Once the agent has read content other people wrote (a taint source: a web page, an email, an issue), every later call to an outbound tool (a taint sink: send, post, push, share) that policy does not deny needs a human, one call at a time, for the rest of the session. Applies to every session kind; an unattended run with no human route denies such calls. Also under `ironcurtain config` → Security. Not backfilled.                                                                                                                                                                                                                                                          |
| `taintEscalation.tools`               | object   | `{}`                         | Reclassifies tools: keys `"server/tool"` or `"server/*"`, values `source`, `sink`, `both` or `none`. The built-in classification is described in [the design](docs/designs/sequence-aware-policy.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `contentAssessment.enabled`           | boolean  | `false`                      | Check the outbound content (message bodies, commit messages, fetched URLs) of calls an `assess` rule allows and of escalated calls for encoded blobs, high-entropy tokens, ciphers, hidden characters and size. Suspicious content escalates to a human (never to the auto-approver or a whitelist); nothing is denied by it. Also under `ironcurtain config` → Security.                                                                                                                                                                                                                                                                                                                                           |
| `contentAssessment.llmCheck`          | boolean  | `false`                      | Also ask a cheap model whether content that passed the deterministic checks is intelligible as written. Only with `contentAssessment.enabled`; it can only escalate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `contentAssessment.llmModelId`        | string   | `anthropic:claude-haiku-4-5` | Model for that check (the `contentAssessment` host role).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `egressPolicy.enabled`                | boolean  | `false`                      | Docker Agent Mode: let the session's policy engine decide every destination that is not a configured LLM provider or package registry (as the virtual tool `network/request`), instead of only `add_proxy_domain` approvals. Hosts in `allowedHosts` are admitted, any other host escalates to a human once per host and port, and every decision is audited. Only ports 443 and 80; never IP literals. While it is on, `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` is ignored. File-only; not backfilled.                                                                                                                                                                                                                   |
| `egressPolicy.allowedHosts`           | string[] | `[]`                         | Host patterns admitted without asking: `*`, `*.example.com` or `registry.example.com` (multi-label names; no IP addresses, no local or metadata names).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packageInstall.enabled`              | boolean  | `true`                       | Docker Agent Mode: let the agent install packages (npm, PyPI, crates, Debian) through IronCurtain's validating registry proxy. File-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packageInstall.quarantineDays`       | integer  | `2`                          | A package version younger than this many days is refused unless it is in `allowedPackages`, and so is a version whose publish time is unknown. `0` disables the age gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packageInstall.allowedPackages`      | string[] | `[]`                         | Packages (glob patterns allowed, case-insensitive) that skip the age gate. A PyPI name is compared in its PEP 503 form (lower case, every run of `-`, `_` and `.` as one `-`) and entries are not normalized: write `typing-extensions`, not `typing_extensions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packageInstall.deniedPackages`       | string[] | `[]`                         | Packages (glob patterns allowed, case-insensitive) that are always refused; the denylist wins over the allowlist. Names are compared in their canonical, decoded form, so `g++-12` or `libstdc++6` work as written; for PyPI that is the PEP 503 form, so an entry `typing_extensions` never matches (write `typing-extensions`).                                                                                                                                                                                                                                                                                                                                                                                   |

The registry proxy is read-only: only `GET` and `HEAD` on each registry's allowlisted routes, with client
credentials stripped. Publishing, `npm audit`, `npm whoami` and other account APIs get a 403. Every forwarded or
refused request is logged to `package-audit.jsonl`.

Configured `credentialProtection.extraPaths` and the trusted environment-file paths also join every sandboxed MCP server's read-deny baseline. Effective, default and XDG Anthropic CLI credential locations are all included. The fixed OS baseline retains its own protections independently of `disabledStores`; a server can opt out of an individual credential entry only with an exact `sandbox.filesystem.allowRead` entry.

### Network destination screening

IronCurtain screens every proxy destination again after DNS resolution. Localhost, `.local`, `.internal`,
`.docker.internal`, private/link-local/metadata addresses, empty answer sets, and mixed public/private
answer sets are rejected even when a passthrough domain was approved. This prevents DNS rebinding and
SSRF into the host or VPN network. It also means internal registries and split-DNS names that resolve to
private addresses are intentionally unavailable from ordinary sessions. The fetch server's `http_fetch` applies
the same screening at connect time (see `fetch.allowPrivateNetworks` above for the one opt-in).

An approved passthrough destination is one host on one port: 443 (the default), or 80 when the agent asks for
`host:80`. Port 443 is a raw tunnel relayed only after the TLS ClientHello names the approved host; port 80 is
relayed as HTTP with the `Host` header pinned.

Agent images do not bake in a user-specific IronCurtain CA. Each ephemeral container installs the
session-mounted public CA into its system trust store at startup and also receives tool-specific trust
environment variables.

## Resource Limits

The four limits are nullable: `null` disables that limit. They and the warning threshold are edited under
`ironcurtain config` → Resource Limits, and the web UI Settings page (when the daemon was started with
`--allow-policy-mutation`; otherwise the page is read-only).

| Field                                 | Type            | Default   | Description                                                                                                                                                                                                                            |
| ------------------------------------- | --------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resourceBudget.maxTotalTokens`       | integer \| null | `1000000` | Token limit: input tokens (cache reads and writes included) plus output.                                                                                                                                                               |
| `resourceBudget.maxSteps`             | integer \| null | `200`     | Agent step limit.                                                                                                                                                                                                                      |
| `resourceBudget.maxSessionSeconds`    | number \| null  | `1800`    | Wall-clock limit of one turn, in seconds. Idle time between turns is free.                                                                                                                                                             |
| `resourceBudget.maxEstimatedCostUsd`  | number \| null  | `5.0`     | Estimated cost limit in USD, at list prices.                                                                                                                                                                                           |
| `resourceBudget.warnThresholdPercent` | integer         | `80`      | Builtin agent: emit a warning when this percentage of a limit is consumed in a turn. Docker sessions emit no budget warnings; the web UI's workflow budget panel shows "Near limit" once a limit reaches this percentage. Range: 1-99. |

What the limits apply to depends on the session:

- **Builtin agent (Code Mode):** every limit is per turn and resets when the agent returns control. Whichever
  dimension is exhausted first ends the turn with a "Budget exhausted" error; the turn stays in the history. When
  `maxSteps` is `null`, a safety cap of 1000 steps per turn still applies. An auto-compaction summary written at
  the start of a turn counts toward that turn's tokens and cost (not its steps). When the summary alone uses up a
  limit, the turn ends with that error before the agent's first model call and, having run no step, is not kept.
- **Docker agents, batch sessions** (`ironcurtain start "task"`, Signal, cron jobs): `maxSessionSeconds` bounds
  each turn inside the container. `maxTotalTokens` and `maxEstimatedCostUsd` are cumulative for the agent
  container and are enforced mid-turn by the MITM proxy, which refuses further completion requests once a limit
  is reached; the session then ends with "Budget exhausted". Tokens, steps and cost are also checked between
  turns, on what the host observed. `maxSteps` is also passed to the agent as its per-invocation turn cap
  (`claude --max-turns`, `GOOSE_MAX_TURNS`). The agent's own cost report is display-only.
- **Interactive PTY sessions** (mux tabs, web terminals, `start --pty`): one session-long token and cost
  allowance. Once it is spent, the proxy refuses completion requests and the session stays open so you can read
  and save work.
- **Workflows:** a shared-container workflow has one token and cost allowance per container scope, shared by all
  of its states and lanes. `settings.workflowBudget` adds a run-wide ceiling (see
  [WORKFLOWS.md](WORKFLOWS.md#resource-limits)).

Cost is estimated from the host's list-price table (`src/llm-metrics/pricing.ts`), or from OpenRouter's reported
cost on OpenRouter routes. A model the table does not list is priced at $10/$50 per million input/output tokens
when it is a Claude model and at $3/$15 otherwise, with a warning that names the override key. Some listed models
bill a long prompt at a higher tier the table does not list (Claude Sonnet 4, 4.5 and 4.6 and Opus 4.6 above 200K
prompt tokens, on the 1M-token context beta; Gemini 2.5, 3 and 3.1 Pro above 200K; Gemini 1.5 Pro above 128K):
cost limits charge such a request twice the listed rates, which bounds those tiers, and warn once per model. For
subscription (OAuth) traffic the figure is the API list-price equivalent, not an invoice.

`resourceBudget.modelPricing` overrides the price of a model (file-only). Keys are model IDs, normalized like the
built-in table (`anthropic:claude-opus-5-5` and `claude-opus-5-5` are the same model). An override replaces the
table entry, including any long-prompt tier and the long-context doubling:

| Field                                                        | Type   | Default          | Description                                  |
| ------------------------------------------------------------ | ------ | ---------------- | -------------------------------------------- |
| `resourceBudget.modelPricing.<model>.inputPerMillion`        | number | _(required)_     | USD per million input tokens.                |
| `resourceBudget.modelPricing.<model>.outputPerMillion`       | number | _(required)_     | USD per million output tokens.               |
| `resourceBudget.modelPricing.<model>.cacheReadPerMillion`    | number | _(input rate)_   | USD per million cache-read tokens.           |
| `resourceBudget.modelPricing.<model>.cacheWrite5mPerMillion` | number | _(1.25 x input)_ | USD per million 5-minute cache-write tokens. |
| `resourceBudget.modelPricing.<model>.cacheWrite1hPerMillion` | number | _(2 x input)_    | USD per million 1-hour cache-write tokens.   |

```json
{
  "resourceBudget": {
    "modelPricing": {
      "claude-opus-5-5": { "inputPerMillion": 5, "outputPerMillion": 25 }
    }
  }
}
```

## Nested Docker Workloads

Docker Agent sessions can expose a private Docker daemon to the agent. The capability is off unless
`dockerWorkload.enabled` is true. Configure it with `ironcurtain config` → **Docker Agent** →
**Nested Docker**, in web Settings, or with this JSON:

```json
{
  "dockerWorkload": {
    "enabled": true,
    "networkAccess": "packages"
  }
}
```

`ironcurtain config` and the web UI refuse to turn it on outside the qualified hosts below (native Linux, Docker
Engine or Docker Desktop for Linux, included). Turning it off is always allowed. If it was enabled by hand on an
unsupported host, every Docker session fails admission with a message saying to set `dockerWorkload.enabled` to
`false`.

Fresh CLI and web enablement explicitly selects `packages`, which supports mediated Docker Hub/GHCR pulls
plus fixed public apt, npm, PyPI, and Cargo downloads through a TLS-terminating MITM proxy. It does not
provide arbitrary `curl`, Git, private registries, authenticated package sources, uploads, or generic web
access. Package responses, caches, built images, and image contents remain untrusted.

Packages permits any process in this nested-Docker session to send bounded workspace or build data through
allowed package paths, permitted request metadata, and timing to fixed public repositories, and to download
untrusted content. IronCurtain does not inject credentials and rejects recognized credential fields and
request bodies. It screens the immediate peer, but a public repository may relay or hairpin elsewhere; use
Images only or Offline to remove this route.

Set `networkAccess` to `images` for mediated Docker Hub/GHCR pulls without Dockerfile `RUN` networking, or
to `offline` to use only images already available to the private runtime:

```json
{
  "dockerWorkload": {
    "enabled": true,
    "networkAccess": "offline"
  }
}
```

Docker Desktop starts each private daemon with an empty, ephemeral image store. Place a Docker image
archive in the configured session or persona host workspace before or while the offline session runs.
Inside the session, load it with `docker image load --input /workspace/images/example.tar`, then use
`docker run --pull=never` and `docker build --pull=false --network=none`. This explicit workspace import
does not contact a registry; IronCurtain does not automatically export the outer agent image into the
private daemon.

| Field                                  | Type    | Default when enabled     | Description                                                                                                                                                                                                                |
| -------------------------------------- | ------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dockerWorkload.enabled`               | boolean | `false`                  | Enable private nested Docker for Docker Agent sessions.                                                                                                                                                                    |
| `dockerWorkload.networkAccess`         | string  | Fresh enable: `packages` | `packages`, `images`, or `offline`; changes apply only to new sessions.                                                                                                                                                    |
| `dockerWorkload.resources.daemonShare` | number  | `0.5`                    | Docker Desktop: the share (0.1-0.9) of the session's CPU, memory and PID envelope given to the nested daemon, which runs dockerd, BuildKit and every inner container. The agent always keeps its minimum floor. File-only. |

The session's envelope is `dockerResources` (memory, CPUs, PIDs; see
[Session mode and Docker agents](#session-mode-and-docker-agents)), clamped to the Docker Desktop VM size that
`docker info` reports. If an ordinary Docker resource is `null`, nested Docker keeps its safe fallback instead of
inheriting an unlimited value. The setting is global for Docker Agent execution: standalone sessions and each
workflow infrastructure bundle receive their own private nested daemon when enabled.

For backward compatibility, an existing enabled block with no old or new network choice migrates to
`images`; old `imageIngress: "public-registry"` also becomes `images`, while `preloaded-only` becomes
`offline`. The superseded `networkAccess: "public"` becomes the narrower `packages` mode. A disabled block
with no prior choice remains unchanged until the first CLI or web enable, which explicitly writes
`packages`.

Older releases wrote implementation-policy fields that are still accepted, only with the values below, and are
removed on the next save. Any other value is an error that says what to change.

| Field                                    | Accepted value                      | Notes                                                                |
| ---------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `dockerWorkload.tier`                    | `developer-only`                    | Legacy; no effect.                                                   |
| `dockerWorkload.backend`                 | `auto`, `apple-container`           | Legacy; `docker` is refused (set `containerRuntime` to `docker`).    |
| `dockerWorkload.imageMode`               | `preloaded-catalog`                 | Legacy; no effect.                                                   |
| `dockerWorkload.imageIngress`            | `preloaded-only`, `public-registry` | Migrated to `networkAccess` (see above); cannot be combined with it. |
| `dockerWorkload.daemonState`             | `ephemeral`                         | Legacy; nested daemons are always ephemeral.                         |
| `dockerWorkload.hostPortPublishing`      | `false`                             | Legacy; host-published ports are not supported.                      |
| `dockerWorkload.buildEgress`             | `disabled`                          | Legacy; `ironcurtain-dockerfiles` is refused.                        |
| `dockerWorkload.acceptObservedDiskRisk`  | `true`                              | Legacy; the observed-disk policy is fixed.                           |
| `dockerWorkload.resources.memoryMb`      | _(none)_                            | Refused: use `dockerResources.memoryMb`.                             |
| `dockerWorkload.resources.cpus`          | _(none)_                            | Refused: use `dockerResources.cpus`.                                 |
| `dockerWorkload.resources.pids.desired`  | `512`                               | Any other value is refused: use `dockerResources.pidsLimit`.         |
| `dockerWorkload.resources.pids.required` | `false`                             | Required PID enforcement is not supported.                           |
| `dockerWorkload.resources.diskMb`        | `null`                              | Numeric disk limits are not supported.                               |

Nested Docker checks the resolved runtime and host/daemon facts before provisioning. All three network
modes are implemented on these developer-scoped profiles:

| Host and runtime                      | Nested-Docker requirements                                                                                                                                                                          | Workload policy transport                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| macOS, Apple silicon, Apple Container | macOS 26+ and Container CLI 1.2.1+                                                                                                                                                                  | Exact host Unix-domain sockets (UDS)              |
| macOS, Docker Desktop                 | Docker Desktop (the server must report it) with cgroup v2; Docker Engine 28 or later for `images` and `packages`. OrbStack, Colima, Rancher Desktop, Podman machine and remote engines are refused. | Fixed-target TCP relays to guarded host listeners |
| WSL2, Docker Desktop                  | Linux/amd64 daemon, cgroup v2, covered seccomp/cgroup namespace security options, non-root coordinator UID and GID; Docker Engine 28 or later for `images` and `packages`                           | Fixed-target relays to exact host UDS files       |

Run IronCurtain as your regular WSL user, not with host `sudo`; passwordless sudo remains available
inside the agent container. Native Linux Engine, non-Desktop WSL engines, and WSL arm64 are not admitted.
This restriction concerns nested Docker, not ordinary Docker Agent sessions with nesting disabled.
The selected Docker endpoint is captured for the bundle; ambient context changes cannot redirect part
of an active bundle to another daemon. Registry/package policy is shared across all admitted profiles.

The disk ceiling is observed, not a quota: IronCurtain measures what each backend reports (Apple VM image
blocks; on Docker Desktop a free-space floor of the VM disk plus the volume size the engine reports) and revokes
the session when a limit is crossed. A host sleep, laptop lid close or clock step does not end a live nested
session; a stopped (Ctrl-Z) `ironcurtain start` is cleaned up by its detached supervisor after 30 seconds without
heartbeats.

Each admitted lease keeps an owner-only, append-only record of every registry pull under
`~/.ironcurtain/docker-workload/leases/<lease-id>/evidence/registry-pull-provenance.jsonl`, kept after teardown.
The digests there are provenance, not attestation.

A lease whose recovery keeps failing blocks admission of new nested sessions. To clear it:

```bash
ironcurtain docker-workload status             # every lease; exit 1 while one blocks admission
ironcurtain docker-workload reconcile          # one exact-recovery pass
ironcurtain docker-workload clear <lease-id>   # dry run: what clearing would remove
ironcurtain docker-workload clear <lease-id> --force
```

`clear` needs the lease's recorded runtime to be running and keeps the retired record under
`~/.ironcurtain/docker-workload/cleared/`. Exit codes: 0 ok, 1 a lease still blocks admission or the clear was
refused, 2 usage error.

This opt-in developer capability intentionally does not include persistent daemon/image cache state,
private or authenticated registries and package sources, or host-published ports. Compose can run
already-built images with the managed external network below; Compose builds that bypass the supported
direct/default-Buildx package path, custom/remote BuildKit workers, and alternate Docker contexts are not
supported. Native Linux Engine and IronCurtain-in-IronCurtain are separate implementation and qualification
slices (reserved, not scheduled). Ended nested sessions are not resumable. See
[backend qualification](TESTING.md#nested-docker-release-qualification) for repeatable tests and
[the acceptance record](docs/designs/linux-nested-docker-implementation-plan.md#acceptance-record) for dated
evidence and outstanding validation.

### Connecting nested containers

An admitted session exports `IRONCURTAIN_DOCKER_NETWORK=ironcurtain`. Attach every service and
client container to that managed internal network; Docker's embedded DNS then resolves container
names and aliases:

```bash
docker run -d --name target --network "$IRONCURTAIN_DOCKER_NETWORK" <service-image>
docker run --rm --network "$IRONCURTAIN_DOCKER_NETWORK" <client-image> http://target:<port>/
```

For Compose, declare the existing managed network as the default:

```yaml
networks:
  default:
    external: true
    name: ${IRONCURTAIN_DOCKER_NETWORK}
```

The nested daemon has no default bridge. Do not use `-p`/`--publish` or `--network host`: neither
publishes an inner service to macOS. The Mac host and the agent shell cannot reach the service at
`localhost`; connect from a sibling container by its service name or network alias. IronCurtain gives
this guidance to the agent only after the nested-Docker capability is successfully admitted for the
new session. This is the supported service topology, not a security boundary: the agent has Docker
administrator authority over its bundle-local daemon.

## Auto-Compact

Controls automatic compaction of the builtin agent's conversation when it approaches the token limit.

| Field                            | Type    | Default                      | Description                                                                                                            |
| -------------------------------- | ------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `autoCompact.enabled`            | boolean | `true`                       | Enable automatic compaction.                                                                                           |
| `autoCompact.thresholdTokens`    | integer | `160000`                     | Token count at which compaction triggers.                                                                              |
| `autoCompact.keepRecentMessages` | integer | `10`                         | Minimum number of recent messages kept verbatim; one more can be kept so a tool call stays with its result.            |
| `autoCompact.summaryModelId`     | string  | `anthropic:claude-haiku-4-5` | Model that writes the summary. Without a key for it, the agent model summarizes instead (or compaction is turned off). |

Compaction splits only between steps. The summary is a user-role message that keeps the user's earlier messages
verbatim (the 50 newest, up to 4,000 characters each) and machine-written notes labelled as possibly quoting
untrusted tool output. A resumed session (`--resume`) keeps those messages verbatim at its next compaction too.
When a summarizer fails, the turn continues uncompacted, a `message_compaction_failed` diagnostic is shown, and
retries back off over 1, 2, 4, 8 and then 16 turns. The summarizer's tokens and estimated cost count toward the
turn's [resource limits](#resource-limits) and the session totals, priced for the summary model (a
`resourceBudget.modelPricing` override for it applies), whether or not it returned a usable summary.

## Audit Redaction and LLM Logs

| Field                             | Type    | Default    | Description                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auditRedaction.enabled`          | boolean | `true`     | Redact credit card numbers, dash-separated SSNs, API keys and tokens of known provider formats (Anthropic, OpenAI, OpenRouter, GitHub, Google, Slack, AWS, JWTs, bearer tokens) and the exact credential values IronCurtain holds, in `audit.jsonl`, the session transcript `interactions.jsonl` and full-detail LLM logs. `false` writes them verbatim.                                                        |
| `observability.llmInteractionLog` | string  | `metadata` | What a session records about each call it makes to an LLM itself (the builtin agent's `llm-interactions.jsonl`, the auto-approver's `auto-approve-llm.jsonl`): `off` writes no file; `metadata` records timings, token usage, finish reason, message counts, response size and tool-call count, with no text; `full` adds prompts and responses, redacted as above. Also under `ironcurtain config` → Security. |

Every entry has `timestamp`, `stepName`, `modelId`, `durationMs` and `detail` (`metadata` or `full`). Metadata
entries add `promptMessages`, `finishReason`, `responseChars`, `toolCalls` and `usage`; full entries add `prompt`,
`promptOffset`, `responseText`, `usage` and, after a compaction, a rolled-back turn or a conversation reset,
`reset: true`. Failed calls carry `error` instead of usage and response. To rebuild a full transcript, start at an
entry with `promptOffset` 0 and append the later entries. Session directories (`~/.ironcurtain/sessions/<id>/`) are
`0700` and their logs `0600`; logs are appended to across `--resume`. The compile pipeline's own
`llm-interactions.jsonl` is not governed by this setting and always has full detail.

## Local LLM Statistics

Content-free usage collection is enabled by default. Configure it with `ironcurtain config` → **LLM Statistics**, the
web UI Settings view, or JSON:

| Field                      | Type            | Default | Description                                                     |
| -------------------------- | --------------- | ------- | --------------------------------------------------------------- |
| `statistics.enabled`       | boolean         | `true`  | Collect and persist content-free LLM usage statistics locally.  |
| `statistics.retentionDays` | integer \| null | `90`    | Delete older exchanges asynchronously; `null` disables pruning. |

Restart a long-running daemon after changing these settings so its statistics runtime is reconfigured.

The database is `~/.ironcurtain/statistics/llm-usage.sqlite3`; its local HMAC pseudonymization key is
`~/.ironcurtain/statistics/identity.key`. Stored fields include token counts, timing, provider/protocol/model routing,
outcomes, refusals, and cost metadata. Prompt, completion, thinking, and tool content; HTTP bodies;
credentials; and arbitrary headers are not stored. The built-in agent ids (`claude-code`, `codex`, `goose`) and
bounded provider and model identifiers are stored as they are; other agent ids, personas, provider profiles,
workflow states and non-public routes are HMACed. The web UI and CLI show configured names for those pseudonyms;
names are never written to the database.

```bash
ironcurtain statistics summary [--days <n>] [--json]    # usage, speed and breakdowns (read-only)
ironcurtain statistics delete --before <ISO-date-or-epoch-ms>
ironcurtain statistics delete --all
ironcurtain statistics reset                            # delete everything and rotate identity.key
```

`delete` performs logical SQLite row deletion, not secure erasure: bytes may remain in free pages, WAL files,
filesystem snapshots, or backups, and it keeps `identity.key`. It retries a busy maintenance lease for about 21
seconds and then exits non-zero with a warning, so scripts should check its exit code. `reset` deletes every row,
then replaces `identity.key` so later pseudonyms cannot be linked to earlier ones, then compacts the database; it
stops before rotating the key if rows remain. Running processes switch to the new key within about 2 seconds, so
stop sessions first for a clean reset.

Token totals of Docker sessions are lower bounds when an exchange's usage was only partly measured; such totals
are shown as `≥N`, and a cost that no source reported is shown as `unknown`, never `$0.00`. Workflow terminal
checkpoints include charges settled during session and proxy teardown. An interrupted provisional checkpoint
marks usage incomplete; resume under token or cost limits is refused until complete accounting is available.

## Retention, Personas and Cron

| Field                                      | Type            | Default    | Description                                                                                                                                                                                                                                  |
| ------------------------------------------ | --------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retention.autoPrune`                      | boolean         | `false`    | Let the daemon prune at start and every `autoPruneIntervalHours`. Without it nothing is removed until `ironcurtain prune` runs.                                                                                                              |
| `retention.autoPruneIntervalHours`         | number          | `24`       | Interval of the daemon's automatic prune (at most a year).                                                                                                                                                                                   |
| `retention.sessions.maxAgeDays`            | number \| null  | `30`       | Session directories inactive for longer are removed.                                                                                                                                                                                         |
| `retention.sessions.maxBytes`              | integer \| null | `null`     | Then the oldest sessions are removed while the category is larger than this.                                                                                                                                                                 |
| `retention.workflowRuns.maxAgeDays`        | number \| null  | `30`       | Workflow run directories inactive for longer are removed, whatever their final state.                                                                                                                                                        |
| `retention.workflowRuns.maxBytes`          | integer \| null | `null`     | Then the oldest runs that can no longer be resumed are removed while the category is larger than this.                                                                                                                                       |
| `retention.jobRuns.maxRecords`             | integer \| null | `200`      | Run records kept per cron job (the newest).                                                                                                                                                                                                  |
| `retention.dependencyCaches.maxUnusedDays` | number \| null  | `14`       | Shared workflow dependency bases unused for longer are removed (rebuilt on the next run that needs them).                                                                                                                                    |
| `retention.logs.maxBytes`                  | integer \| null | `10485760` | Size at which `daemon.log` and `signal-bot.log` rotate (at least 64 KiB; `null` disables rotation).                                                                                                                                          |
| `retention.logs.maxFiles`                  | integer         | `3`        | Rotated copies kept (`.1` to `.N`, at most 20).                                                                                                                                                                                              |
| `personas.trashRetentionDays`              | integer \| null | `30`       | Days a soft-deleted persona (workspace and memory included) stays in `~/.ironcurtain/.persona-trash/` before it is purged; `null` keeps entries until `ironcurtain persona trash purge`.                                                     |
| `cron.maxConcurrentRuns`                   | integer \| null | `null`     | Most job runs the daemon starts at once (`null`: no limit). A scheduled run beyond it waits (`QUEUED` in `list-jobs`); a manual run counts but is never refused.                                                                             |
| `cron.catchUpMissedRuns`                   | boolean         | `false`    | Run a job once when the daemon reaches one of its fire times more than 5 minutes late (the machine slept, or the daemon was blocked); otherwise such a run is skipped and logged. Runs missed while the daemon was down are never caught up. |

None of these is backfilled. Prune never removes a live session or run, a run holding its `run.lock`, a
directory whose workspace something else still uses, or anything active within the last day. See
`ironcurtain prune --help` and [the design](docs/designs/retention-and-prune.md).

## Web Search

Configure a web search provider so the agent can search the web via the `web_search` tool.

| Field                      | Type   | Default  | Description                                       |
| -------------------------- | ------ | -------- | ------------------------------------------------- |
| `webSearch.provider`       | string | _(none)_ | Active provider: `brave`, `tavily`, or `serpapi`. |
| `webSearch.brave.apiKey`   | string | —        | Brave Search API key.                             |
| `webSearch.tavily.apiKey`  | string | —        | Tavily API key.                                   |
| `webSearch.serpapi.apiKey` | string | —        | SerpAPI key.                                      |

### Getting API Keys

- **Brave Search**: https://brave.com/search/api/
- **Tavily**: https://tavily.com/
- **SerpAPI**: https://serpapi.com/

## Model Providers (OpenRouter and Z.AI)

Route Docker agents (Claude Code, Codex, Goose) through named **provider profiles** for OpenRouter or direct Z.AI. Each profile binds credentials and model selection. See [MODEL_ROUTING.md](MODEL_ROUTING.md) for the quickstarts. Edit via `ironcurtain config` → **Model Providers**, or the web UI Settings view.

An implicit profile named `native` — today's canonical Anthropic / OpenAI / ChatGPT routing — is always present, cannot be redefined or deleted, and is the fallback when no default is set.

| Field                                               | Type    | Default                                                    | Description                                                                                                                                           |
| --------------------------------------------------- | ------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelProviders.default`                            | string  | `native`                                                   | Profile used when no per-session choice is made. Must name a configured profile or `native`.                                                          |
| `modelProviders.profiles`                           | object  | `{}`                                                       | User-named profiles, keyed by name. A profile named `native` is rejected (reserved).                                                                  |
| `modelProviders.profiles.<name>.type`               | string  | —                                                          | Discriminator: `openrouter`, `zai`, or `native`.                                                                                                      |
| `modelProviders.profiles.<name>.apiKey`             | string  | —                                                          | OpenRouter key (`sk-or-v1-...`) or Z.AI key. `OPENROUTER_API_KEY` / `ZAI_API_KEY` take precedence. Sensitive; masked in the editor.                   |
| `modelProviders.profiles.<name>.modelMap`           | array   | Opus → `z-ai/glm-5.3`; Sonnet/Haiku → `z-ai/glm-5.3-flash` | Ordered glob→slug rules (`match`, `model`; first match wins), matched case-insensitively against the requested model. Explicit `[]` disables mapping. |
| `modelProviders.profiles.<name>.perAgent`           | object  | —                                                          | Per-agent model override (`claude-code`, `goose`, `codex`). Wins over `modelMap` for that agent.                                                      |
| `modelProviders.profiles.<name>.providerPreference` | object  | soft z-ai pin                                              | OpenRouter only. Cache pinning passthrough (`order` / `only` / `allowFallbacks`). Replaces the D3 default when set.                                   |
| `modelProviders.profiles.<name>.sessionAffinity`    | boolean | `true`                                                     | OpenRouter only. Inject a stable top-level `session_id` for GLM cache affinity.                                                                       |
| `modelProviders.profiles.<name>.plan`               | string  | `api`                                                      | Z.AI only. `api` selects the standard Chat Completions endpoint; `coding` selects the Coding Plan endpoint. Account access must match the plan.       |
| `modelProviders.profiles.<name>.model`              | string  | `glm-5.3`                                                  | Z.AI only. Default when no model is requested; also the default Opus map target (Sonnet/Haiku map to `glm-5.3-flash`).                                |

**Defaults (per openrouter profile).** When `modelMap` is omitted it defaults to `DEFAULT_MODEL_MAP`: `*opus*` → `z-ai/glm-5.3`, and `*sonnet*` / `*haiku*` → `z-ai/glm-5.3-flash`. `sessionAffinity` defaults to `true`. When the mapped slug is `z-ai/*` and `providerPreference` is unset, the MITM injects a soft pin `provider: { order: ["z-ai"] }` for cache affinity. An openrouter profile with just `{ "type": "openrouter", "apiKey": "sk-or-v1-..." }` therefore supplies both GLM tiers with no further config. Explicit maps and per-agent overrides remain authoritative.

**`OPENROUTER_API_KEY` env.** When set, it fills `apiKey` for **every** openrouter profile and takes precedence over any per-profile config `apiKey` (share one key across profiles). A profile's config `apiKey` is used only when the env var is unset. The env value is applied at resolve time and is **never persisted** to `config.json` — editing `modelProviders` via `ironcurtain config` or the web UI strips it from the write, so the env secret is never baked into the file.

**`modelMap: []` (per-agent-only mode).** An explicit empty array is preserved (resolution uses `??`, not `||`): the glob never matches, so routing relies on `perAgent` only.

**Reach of `default`.** The global default applies to **all** Docker Agent Mode sessions — interactive (`ironcurtain mux` PTY and batch `ironcurtain start`), daemon/cron jobs, signal-bot sessions, web-UI-spawned sessions, **and workflow orchestrator bundles** (one profile per shared-container run). A **per-session override** exists only where a surface exposes it: `ironcurtain start --provider-profile <name>` and the mux `/new` profile picker. Builtin and other host roles select profiles separately through `hostModelProfiles`.

**Hard load error on a dangling default.** A hand-edited `default` naming a profile that does not exist is a **hard error at config load** (`modelProviders.default must name a configured profile or "native".`) — it does not silently fall back to `native`. The `ironcurtain config` editor and web UI re-point `default` to `native` in the same write when you delete the profile it named, so they never persist a dangling default.

**Request filtering on OpenRouter.** The proxy removes `plugins`, `web_search_options` and `models` from requests
on OpenRouter profiles and strips `:online` from the model. A web-search model (`perplexity/*`, `*-search*`,
`*deep-research*`) is forwarded only when the profile names it as a `modelMap` target or `perAgent` model;
otherwise the agent gets a 400 `IronCurtain proxy refused this request`.

```json
{
  "modelProviders": {
    "default": "glm-5.3",
    "profiles": {
      "glm-5.3": {
        "type": "openrouter",
        "apiKey": "sk-or-v1-...",
        "modelMap": [
          { "match": "*opus*", "model": "z-ai/glm-5.3" },
          { "match": "*sonnet*", "model": "z-ai/glm-5.3-flash" },
          { "match": "*haiku*", "model": "z-ai/glm-5.3-flash" }
        ],
        "perAgent": { "goose": "z-ai/glm-5.3", "codex": "z-ai/glm-5.3" },
        "providerPreference": { "order": ["z-ai"], "allowFallbacks": false },
        "sessionAffinity": true
      },
      "kimi": {
        "type": "openrouter",
        "modelMap": [{ "match": "*", "model": "moonshot/kimi-k3" }]
      }
    }
  }
}
```

Here `glm-5.3` is the default; `kimi` shares the env `OPENROUTER_API_KEY` (no per-profile `apiKey`) and uses a strict wildcard map. The explicit Goose/Codex overrides select GLM 5.3 regardless of requested tier. `native` need not be listed.

### Direct Z.AI profiles

A `zai` profile connects Claude Code, Codex, and Goose directly to Z.AI with host-side credential swapping. Configure it in `ironcurtain config` → Model Providers or the web Settings provider editor:

```json
{
  "modelProviders": {
    "profiles": {
      "glm": { "type": "zai", "plan": "api", "model": "glm-5.3" }
    }
  }
}
```

Set `ZAI_API_KEY` on the host, then select the profile with `ironcurtain start --provider-profile glm --agent claude-code "task"` (or `codex` / `goose`). The global `modelProviders.default` and mux picker also support it. Container credentials are sentinels; the real key stays on the host. Environment keys are never persisted during edits or renames.

A Z.AI profile takes `plan`, `model`, `apiKey`, `modelMap` and `perAgent` (see the table above). The model map is
applied once when selecting the client model; the proxy preserves that selected model. OpenRouter-specific
`providerPreference` and `sessionAffinity` fields do not apply to Z.AI. Codex receives a generated model catalog;
Claude Code uses its supported gateway endpoint and tier aliases. `ANTHROPIC_CUSTOM_MODEL_OPTION` is not
required.

### Named profiles for host model roles

Host models select profiles independently of container profiles. Omitted roles retain native provider resolution, even when a gateway is the default for containers. Model IDs remain configured through the existing model fields.

```json
{
  "modelProviders": {
    "profiles": { "glm": { "type": "zai", "plan": "api", "model": "glm-5.3" } }
  },
  "hostModelProfiles": {
    "agent": "glm",
    "policy": "glm",
    "prefilter": "glm",
    "summary": "glm",
    "autoApprove": "glm"
  },
  "autoApprove": { "enabled": false, "modelId": "glm-5.3" }
}
```

| Field                                 | Type   | Default  | Description                                                                                |
| ------------------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------ |
| `hostModelProfiles.agent`             | string | `native` | Profile of the builtin agent's model (`agentModelId`).                                     |
| `hostModelProfiles.policy`            | string | `native` | Profile of policy compilation and its verifier (`policyModelId`, `policyVerifierModelId`). |
| `hostModelProfiles.prefilter`         | string | `native` | Profile of the compile pre-filter (`prefilterModelId`).                                    |
| `hostModelProfiles.summary`           | string | `native` | Profile of conversation compaction (`autoCompact.summaryModelId`).                         |
| `hostModelProfiles.autoApprove`       | string | `native` | Profile of auto-approval (`autoApprove.modelId`), in both session modes.                   |
| `hostModelProfiles.contentAssessment` | string | `native` | Profile of the outbound content LLM check (`contentAssessment.llmModelId`).                |

Select bindings in `ironcurtain config` → Model Providers → Host model profiles. These bindings support `native`, OpenRouter, and Z.AI profiles. Host roles use the profile's model map, without Docker per-agent overrides. OpenRouter host requests preserve provider preferences, including strict pins and disabled fallback. Auto-approval remains disabled by default; a binding alone does not enable it. Model or output failures continue to escalate to a human.

A referenced profile cannot be deleted until its host roles are reassigned. Web profile renames migrate bindings and the default atomically, preserving stored keys. Existing profiles retain their service type; create a new profile to change service. Unknown host-profile references are configuration errors.

See [Z.AI profile design and validation](docs/designs/zai-provider-profiles.md).

## Server Credentials

Per-server environment variables, given to that server's process only.

| Field               | Type   | Default | Description                                                                                                                                                    |
| ------------------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverCredentials` | object | `{}`    | Keyed by server name, then by variable name. The server must be configured, built-in or in `~/.ironcurtain/mcp-servers.json`; a warning is printed for others. |

```json
{
  "serverCredentials": {
    "github": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxx" },
    "fetch": { "API_KEY": "key_yyyy" }
  }
}
```

`ironcurtain config` → Server Credentials (and `ironcurtain mcp add`) prompts for the variables a server declares:
a `-e NAME` argument, an empty `env` value, or an `env` key that looks like a credential. MCP relays and servers
do not inherit the host environment: provider keys exported in your shell or loaded from the trusted `.env` never
reach an MCP server. A server gets only an allowlist of basic variables, its own config's `env` block, its
`serverCredentials`, and the host variables it names with `-e NAME`. A custom server that needs another host
variable must declare it in one of those ways. The allowlist covers basic variables (`HOME`, `PATH`, `USER`, locale,
`TMPDIR`, XDG directories), outbound proxy and CA settings (`HTTP(S)_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, ...), npm configuration without credentials, Docker CLI connection settings and Node.js
version-manager roots; `SSH_AUTH_SOCK` reaches only the git server. Settings such as `GIT_SSH_COMMAND`,
`NODE_USE_SYSTEM_CA`, `LD_LIBRARY_PATH`, `MEMORY_*` or `PIP_*` no longer reach servers from the shell: move them into
the server's `env` block or a `-e` pass-through. `NODE_OPTIONS`, `NODE_PATH`, `LD_*` and `DYLD_*` are never passed,
not even with `-e`. `ironcurtain doctor` applies the same rule, so a token stored only
in `serverCredentials` is enough to start the server.

## API keys and base URLs

Provider keys come from, highest precedence first: the shell environment, the trusted credential files, and the
fields below. The credential files are `~/.ironcurtain/.env` (`$IRONCURTAIN_HOME/.env`) and one explicit file named
by `ironcurtain --env-file <path> <command>` (before the command) or `IRONCURTAIN_ENV_FILE`. A `.env` in the
current directory is never read; a one-line note says so when one exists. Only credential keys load from these
files: the provider keys below and the `-e NAME` pass-through names of the configured MCP servers (such as
`GITHUB_PERSONAL_ACCESS_TOKEN`); other keys, base URLs included, are ignored with a warning. A file owned by
another user or writable by every user is refused; a group-writable or other-readable one is used with a warning
(`chmod 600` it).

| Field              | Type   | Default  | Description                                                                                                                       |
| ------------------ | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `anthropicApiKey`  | string | _(none)_ | Anthropic API key (`ANTHROPIC_API_KEY` wins).                                                                                     |
| `googleApiKey`     | string | _(none)_ | Google AI API key (`GOOGLE_GENERATIVE_AI_API_KEY` wins).                                                                          |
| `openaiApiKey`     | string | _(none)_ | OpenAI API key (`OPENAI_API_KEY` wins).                                                                                           |
| `anthropicBaseUrl` | string | _(none)_ | Anthropic upstream endpoint, for example a LiteLLM gateway (`ANTHROPIC_BASE_URL` wins). See [MODEL_ROUTING.md](MODEL_ROUTING.md). |
| `openaiBaseUrl`    | string | _(none)_ | OpenAI upstream endpoint (`OPENAI_BASE_URL` wins).                                                                                |
| `googleBaseUrl`    | string | _(none)_ | Google upstream endpoint (`GOOGLE_API_BASE_URL` wins).                                                                            |

In Docker mode, IronCurtain auto-detects OAuth credentials from `~/.claude/.credentials.json` (created by `claude login`) and prefers them over API keys. Set `IRONCURTAIN_DOCKER_AUTH=apikey` to force API key mode.

### Routing through a non-Anthropic gateway

For OpenRouter and Z.AI, use the first-class [Model Providers](#model-providers-openrouter-and-zai) section above. For other gateways, IronCurtain talks to Anthropic via the official SDK with `x-api-key` auth; run [LiteLLM](https://docs.litellm.ai/) as a local sidecar that translates Anthropic-format requests to your target provider, then point IronCurtain at it:

```bash
export ANTHROPIC_API_KEY="<your-litellm-virtual-key>"
export ANTHROPIC_BASE_URL="http://127.0.0.1:4000"
ironcurtain mux
```

LiteLLM handles model-name translation (e.g. mapping `claude-sonnet-4-6` to your chosen OpenRouter / Bedrock / OpenAI model). One-shot `ironcurtain start "your task"` runs use the same routing when you need a scriptable check. See LiteLLM's docs for sidecar setup.

## Memory

Controls the persistent memory server. Memory is enabled per persona and per cron job (at creation, or with
`ironcurtain persona edit` / `ironcurtain daemon edit-job`); `memory.enabled` is the global kill switch.
Shared-container workflows run without persona memory.

| Field                  | Type    | Default                | Description                                                                                                                                                                                  |
| ---------------------- | ------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.enabled`       | boolean | `true`                 | Global kill switch: when `false`, no session gets a memory server, whatever the persona or job says.                                                                                         |
| `memory.autoSave`      | boolean | `true`                 | At the end of a memory-enabled session, store a summary of the session (an extra, system-originated turn of the agent).                                                                      |
| `memory.llmBaseUrl`    | string  | _(Anthropic endpoint)_ | OpenAI-compatible endpoint for the memory server's LLM work. Must use `https://`, or `http://` to this machine only (`localhost`, 127.0.0.0/8, `[::1]`); any other URL fails config loading. |
| `memory.llmApiKey`     | string  | _(see below)_          | Key for that endpoint.                                                                                                                                                                       |
| `memory.offlineModels` | boolean | `false`                | Never download the memory models: a model missing from `~/.ironcurtain/models` is an error. Fill the store first with `ironcurtain memory prefetch`.                                         |

Which key goes where: `memory.llmApiKey` goes to `memory.llmBaseUrl`, or, without one, to the Anthropic route.
Without `memory.llmApiKey`, the Anthropic API key is used only on the Anthropic route: Anthropic's
OpenAI-compatible endpoint (`https://api.anthropic.com/v1/`), or the `/v1/` endpoint under `anthropicBaseUrl` /
`ANTHROPIC_BASE_URL`. A `memory.llmBaseUrl` on another origin gets no key (a local Ollama needs none; another
provider needs `memory.llmApiKey`). Without any key the memory server runs without an LLM and uses extractive
fallbacks.

Costs and downloads:

- The memory server's embedding and re-ranking models (about 135 MB) are downloaded from Hugging Face on first use
  into `~/.ironcurtain/models`. Only pinned revisions are downloaded, and every file is checked against its SHA-256
  hash on install and before every load. `ironcurtain memory prefetch` downloads them ahead of time;
  `ironcurtain doctor` reports them under Memory models. A build whose model pins were not recorded refuses the
  models (`MODEL_UNPINNED`): the memory tools return that error, and the doctor check fails with
  `not pinned in this build`.
- The default recall format summarizes with the LLM, so every recall makes an LLM call when a key is available;
  ingestion and maintenance make more. The memory server bounds its own LLM spend per process (by default 500
  calls and 1,000,000 tokens) and its calls have timeouts. This spend is not counted against the session's
  resource limits.

Memories written by cron jobs and workflow states wait for review: interactive sessions do not see them until
they are approved with the `<id>@<digest>` receipts printed by `ironcurtain memory <persona|job> review` or `show`. Review/show prints the full quoted content, tags, source label, metadata and source passage. Approval checks each snapshot under the database write transaction; changed rows require review again, and bare ids or `approve --all` are refused. A memory waiting for review is not
merged with other memories before it is approved (approval releases exactly what the review listed), so a job
that stores the same fact on every run leaves one memory to review per run. Cron jobs and workflows with memory
refuse to start when the installed memory server predates the review quarantine; `ironcurtain doctor` reports
this under Memory. See the [memory-mcp-server README](packages/memory-mcp-server/README.md) for the server's own
settings and standalone use.

## Signal

The Signal bridge requires TLS and bearer admission on every HTTP route and WebSocket upgrade. All host clients explicitly trust its private certificate and verify `localhost`; redirects and plaintext fallback are refused. A single atomic `oauth/signal-bridge/credentials.json` under the IronCurtain home stores the token, certificate and key (file mode 0600, parent 0700). These values are not config settings and never appear in Docker arguments, environment values or query strings. Insecure or corrupt existing bundles are refused.

Build the local default with `npm run build:signal-bridge`; see [the build instructions](docker/signal-bridge/README.md). It is not a published/pullable image. Actual macOS Docker Desktop/Apple runtime and live Signal account qualification remain separate owner work.

Settings of the Signal transport (`ironcurtain bot`, and the daemon). `ironcurtain setup-signal` writes them; see
[TRANSPORT.md](TRANSPORT.md).

| Field                          | Type    | Default                                 | Description                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal.botNumber`             | string  | _(setup)_                               | The bot's Signal number, E.164 (`+15551234567`).                                                                                                                                                                                                                                                                  |
| `signal.recipientNumber`       | string  | _(setup)_                               | Your Signal number, E.164. The bot accepts messages from this account only.                                                                                                                                                                                                                                       |
| `signal.recipientIdentityKey`  | string  | _(setup)_                               | Your Signal identity key, captured at setup. A change locks the transport until `ironcurtain setup-signal --re-trust`.                                                                                                                                                                                            |
| `signal.recipientUuid`         | string  | _(setup)_                               | Your account UUID as signal-cli lists it, captured by setup and `--re-trust`.                                                                                                                                                                                                                                     |
| `signal.container.image`       | string  | `ironcurtain-signal-bridge:0.101-auth1` | Authenticated bridge image, explicitly built locally. Every image needs authentication contract label `1`. A custom published digest can be recorded by `ironcurtain setup-signal --update-image`; a configured tag is used only as already present locally. For the default, update prints rebuild instructions. |
| `signal.container.port`        | integer | `18080`                                 | Host loopback port for the authenticated HTTPS/WSS API, 1024-65535.                                                                                                                                                                                                                                               |
| `signal.maxConcurrentSessions` | integer | `3`                                     | Concurrent Signal sessions, 1-10.                                                                                                                                                                                                                                                                                 |

## Skills

User-global SKILL.md packages live under `~/.ironcurtain/skills/<name>/`. Each agent's discovery path differs (Claude Code is pointed at the staging dir via `--add-dir`; Goose scans `~/.config/goose/skills/<name>/SKILL.md`); IronCurtain bind-mounts the staged skills (read-only) at the path the active agent's native discovery walks. There's nothing to configure in `config.json` — drop a directory containing a `SKILL.md` file (with `name` and `description` frontmatter) and any supporting files, and it's automatically picked up on next session start. See [WORKFLOWS.md](WORKFLOWS.md#skills) for the layering rules and the workflow-bundled skills variant.

## Environment variables

Environment variables IronCurtain itself reads. Set them in the shell that starts IronCurtain; only the provider
keys may also come from the trusted credential files (see [API keys and base URLs](#api-keys-and-base-urls)).

| Variable                           | Description                                                                                                                                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRONCURTAIN_HOME`                 | The IronCurtain home (default `~/.ironcurtain`). Must be an absolute path; an empty value means the default. A workspace may not contain it.                                                                                                                   |
| `IRONCURTAIN_ENV_FILE`             | An extra credential file (absolute path), loaded after `$IRONCURTAIN_HOME/.env`; its values win. Same as a leading `--env-file <path>`.                                                                                                                        |
| `ANTHROPIC_API_KEY`                | Anthropic API key (or a gateway's key when `ANTHROPIC_BASE_URL` is set).                                                                                                                                                                                       |
| `GOOGLE_GENERATIVE_AI_API_KEY`     | Google AI API key.                                                                                                                                                                                                                                             |
| `OPENAI_API_KEY`                   | OpenAI API key.                                                                                                                                                                                                                                                |
| `OPENROUTER_API_KEY`               | OpenRouter key for every `openrouter` profile; never written to `config.json`.                                                                                                                                                                                 |
| `ZAI_API_KEY`                      | Z.AI key for every `zai` profile; never written to `config.json`.                                                                                                                                                                                              |
| `ANTHROPIC_BASE_URL`               | Anthropic upstream endpoint; overrides `anthropicBaseUrl`. Shell only, never from a `.env` file.                                                                                                                                                               |
| `OPENAI_BASE_URL`                  | OpenAI upstream endpoint; overrides `openaiBaseUrl`. Shell only.                                                                                                                                                                                               |
| `GOOGLE_API_BASE_URL`              | Google upstream endpoint; overrides `googleBaseUrl`. Shell only.                                                                                                                                                                                               |
| `IRONCURTAIN_SANDBOX_POLICY`       | `enforce` or `warn`; overrides `sandboxPolicy`. An invalid value is an error.                                                                                                                                                                                  |
| `SANDBOX_POLICY`                   | Same, read after `IRONCURTAIN_SANDBOX_POLICY`.                                                                                                                                                                                                                 |
| `IRONCURTAIN_CONTAINER_RUNTIME`    | `auto`, `docker` or `apple-container`; overrides `containerRuntime`.                                                                                                                                                                                           |
| `IRONCURTAIN_DOCKER_AUTH`          | `apikey` forces API-key authentication for Docker agents instead of a detected Claude OAuth login.                                                                                                                                                             |
| `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` | Deprecated. `1` or `true` makes the Docker MITM proxy tunnel every host that is not a configured provider or registry, with egress filtering disabled. A warning is printed, and it is ignored when `egressPolicy.enabled` is set. Use `egressPolicy` instead. |
| `IRONCURTAIN_WEB_UI_PORT`          | Port of the Vite dev server that `daemon --web-ui-dev` accepts as an Origin (default 5173). Development only.                                                                                                                                                  |
| `ALLOWED_DIRECTORY`                | Sandbox directory for policy evaluation when no session sandbox or `--workspace` applies (default `$IRONCURTAIN_HOME/sandbox`). A relative path is resolved against the launch directory.                                                                      |
| `AUDIT_LOG_PATH`                   | Audit log path for that fallback configuration (default `./audit.jsonl`); MCP tool calls may not touch it. A relative path, like the default, is resolved against the launch directory and does not stop `-w .`; a workspace may not contain an absolute one.  |

Docker endpoint selection follows Docker's own `DOCKER_HOST` and `DOCKER_CONTEXT`. The job wizard and persona
commands open `VISUAL`, else `EDITOR`, else `nano`.

## Example Configuration

```json
{
  "agentModelId": "anthropic:claude-sonnet-4-6",
  "policyModelId": "anthropic:claude-sonnet-4-6",
  "escalationTimeoutSeconds": 300,
  "resourceBudget": {
    "maxTotalTokens": 1000000,
    "maxSteps": 200,
    "maxSessionSeconds": 1800,
    "maxEstimatedCostUsd": 5.0,
    "warnThresholdPercent": 80
  },
  "autoCompact": {
    "enabled": true,
    "thresholdTokens": 160000,
    "keepRecentMessages": 10,
    "summaryModelId": "anthropic:claude-haiku-4-5"
  },
  "autoApprove": {
    "enabled": false,
    "modelId": "anthropic:claude-haiku-4-5"
  },
  "auditRedaction": {
    "enabled": true
  },
  "observability": {
    "llmInteractionLog": "metadata"
  },
  "webSearch": {
    "provider": "brave",
    "brave": { "apiKey": "BSA..." }
  },
  "memory": {
    "enabled": true,
    "autoSave": true
  },
  "packageInstall": {
    "enabled": true,
    "quarantineDays": 2,
    "allowedPackages": [],
    "deniedPackages": ["example-malicious-pkg"]
  }
}
```

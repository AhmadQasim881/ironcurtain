# MITM Egress Through the Policy Engine

**Status (2026-11-14):** Partial: slice 1 implemented (WP-118), opt-in. Owner decision: policy-evaluated egress ships as an opt-in; `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` stays, prints a deprecation warning, and is ignored while the opt-in is on. Section 10 lists the later slices.

## 1. Problem

The MITM proxy (`src/docker/mitm-proxy.ts`) decides on its own which destinations a Docker agent container reaches. Configured LLM providers and package registries take their dedicated, filtered paths. Everything else used to be one of two things:

- refused, unless a human approved the exact `host:port` through `add_proxy_domain` (a policy-evaluated, audited tool call), or
- tunneled raw, when the host process ran with `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS=1`: a global switch that turns egress filtering off for every unknown host, on every port, with each decision visible only as a session-log line.

So the decision for raw egress sat outside the constitution, the compiled rules, the audit trail and the escalation flow. The only practical option for build-heavy runs (Bazel, Gradle, language toolchains fetching from many mirrors) was the global switch. Workflow runs had no human channel for `add_proxy_domain` until WP-35, which made the switch look like the only option there too.

## 2. Model: the virtual `network` server

Every destination that is neither a provider nor a registry is modeled as a call to a virtual tool, `network/request`, and decided by the session's policy engine like any MCP tool call:

| Request the proxy sees | Arguments evaluated | Granularity |
| --- | --- | --- |
| `CONNECT host:port` (a tunnel) | `{ method: 'CONNECT', host, port }` | host:port |
| Absolute-form plain HTTP (`GET http://host/path` through `HTTP_PROXY`) | `{ method, host, port, path }` | path |
| `ws://` upgrade through the proxy | `{ method: 'GET', host, port, path }` | path |
| A request inside an admitted `host:80` CONNECT tunnel | `{ method, host, port: 80, path }` | path |
| A request on a TLS-terminated (nested-transport) passthrough connection | `{ method, host, port, path }` | path |

`path` is the origin-form path and query. A raw 443 tunnel is opaque, so it is judged at host:port; switching passthrough to TLS termination to see paths would break clients that pin certificates.

"Path granularity" means every readable request is a decision of its own: it is evaluated under the policy active at that moment (a workflow persona swap or a revoked approval applies to the next request, not the next connection) and audited with its method and path. In slice 1 a rule cannot tell paths apart yet: only `host` carries an argument role (`egress-host`), so a compiled rule conditions on the host (and the server and tool), never on `method`, `path` or `port` (see section 10).

The virtual server is defined in `src/trusted-process/egress-policy.ts`:

- **Annotation** (hardcoded, like the proxy tools): `host` has the new argument role `egress-host` (URL category, scoped to `network`), the other arguments `none`. Because it is a URL role, compiled `domains` conditions judge it with the usual matcher (`*`, `*.example.com`, exact names; `*` never matches an IP literal), and the structural domain gate applies. A rule written for another server's URL roles (`fetch-url`, `git-remote-url`) never applies to it.
- **No callable tool.** The server is never registered in the coordinator's tool map, so an agent cannot call `network.request` from `execute_code`; `handleToolCall` would deny it as an unknown tool. The name is reserved (`RESERVED_SERVER_NAMES`), so no `mcp-servers.json` entry can shadow it, and `extractRequiredServers` never tries to spawn a relay for it.

## 3. Configuration

```jsonc
// ~/.ironcurtain/config.json
{
  "egressPolicy": {
    "enabled": true,                                   // opt-in; default off
    "allowedHosts": ["*.npmjs.org", "github.com", "*.bazel.build"]
  }
}
```

- `enabled` (default `false`): turn policy-evaluated egress on for Docker sessions. Never backfilled into the file.
- `allowedHosts`: host patterns admitted without a human. Each is `*` (every host name), `*.domain` (the domain and every name below it) or an exact multi-label host name. IP literals, `localhost` and local or metadata-scoped names are refused at config load (`src/net/egress-host-pattern.ts`), as is any unknown key under `egressPolicy` (strict schema). Patterns are stored in canonical spelling (lowercase, no trailing dot).

The interactive editor (`ironcurtain config`) does not offer these fields yet; edit the file.

## 4. Rules and precedence

The coordinator appends the egress rules after the compiled rules of every policy it loads, so first-match-wins gives:

1. **The compiled policy's own `network` rules.** A constitution or a hand-written policy directory may allow, escalate or deny `network/request` (for example a deny for a known exfiltration host). In workflows this is the active persona's policy; `loadPolicy` re-merges the egress rules on every swap.
2. **`network-egress-allowed-hosts`**: allow when the host matches `egressPolicy.allowedHosts` (only present when the list is non-empty).
3. **`network-egress-escalate`**: escalate everything else, `humanOnly` (never the LLM auto-approver, never an `/approve+` whitelist pattern, never "approve all"), because admitting a destination opens an uninspected passthrough tunnel, the same decision as an approved `add_proxy_domain`.

A task-scoped session (`--task-scoped`, see [task-scoped-sessions.md](./task-scoped-sessions.md)) also intersects every decision with its task scope, and the coordinator appends the same two egress rules to the task scope's own rules. A destination in `allowedHosts` therefore stays admitted and every other destination stays the human-only escalation. A task compile never yields `network` rules, so a destination that only the session policy's own `network` rules admit is outside the task scope and escalates as well; the intersection never admits a destination the session policy does not.

Before policy runs, a structural screen refuses (audited, nobody asked):

- a port other than 443 or 80 (`egress-port-not-allowed`), the ports a passthrough approval can name;
- a host `validateDomain` refuses (`egress-destination-not-allowed`): IP literals in any spelling, `localhost`, `*.docker.internal` and other local or metadata names, malformed or non-canonical names;
- a malformed method or path (`egress-request-malformed`; the proxy never produces one).

The proxy keeps its own address screen (non-public literals, local names) as a second layer before it dials anything.

## 5. Escalate-once

A human decides a destination once per `host:port` per bundle:

- An approval becomes a passthrough approval in the proxy (`passthroughHosts`), exactly like an approved `add_proxy_domain`: `list_proxy_domains` shows it, `remove_proxy_domain` revokes it and tears down the tunnels opened under it, and 443 tunnels stay SNI-pinned and port-80 tunnels Host-pinned.
- A denial is remembered in the proxy (`deniedEgress`) until an explicit `add_proxy_domain` approval for the same target clears it.
- With the next request to the same target the proxy passes the remembered decision as `prior`. When policy escalates that request, the coordinator settles it with `prior` (audited as `escalationResult: approved|denied`, reason "Approved/Denied earlier in this session for host:port") instead of asking again. A prior decision never overrides a policy allow or deny; like the approval whitelist, it only discharges an escalation.
- Timeouts, cancellations, a missing escalation channel and the escalation limit are not remembered: the next request may escalate again.
- Approvals are bundle-scoped, like `add_proxy_domain` approvals: in a workflow they outlive a persona swap, but each new request is still evaluated under the new persona's policy, which can deny it.

Concurrent requests to one target are decided one at a time (a per-`host:port` queue in the proxy), so a build opening 50 parallel connections to a new mirror raises one escalation; the queued requests are decided after it, with its answer as `prior`. Different targets are decided concurrently. An escalation that ends unanswered (timeout, cancellation) settles nothing for the requests queued behind it: the next one escalates again, one at a time, including requests whose client gave up meanwhile (a socket nobody reads cannot tell a client that left).

## 6. Decision flow

1. The proxy classifies the request. Providers and registries keep their static paths and are never sent to the policy (their requests are already filtered and, for registries, audited).
2. It queues the decision on the target's `host:port` and asks the attached `EgressAuthorizer` (`ToolCallCoordinator.authorizeEgress`, reached through `DockerProxy.getEgressAuthorizer()`). Until one is attached, or when it rejects (coordinator closed, audit log lost), the request is refused: fail closed. `prepareDockerInfrastructure` attaches it right after the Code Mode proxy starts, before any container runs, and fails the session start if the coordinator offers none.
3. The coordinator admits the decision like a tool call (refused once closed or once the audit log is unavailable, held back while a policy swap quiesces), asserts the audit log is writable, runs the structural screen, then the policy engine.
4. An escalation goes through the coordinator's normal channel: the in-process `onEscalation` handler (workflow bundles: the orchestrator's human route, WP-35) or the file-IPC escalation directory (standalone sessions: the CLI prompt, mux, web UI). The human sees `network/request` with its arguments and the reason, which always states the scope ("approving admits host:port for the rest of this session"). The wait is registered as a pending escalation, so `close()` and `loadPolicy()` cancel it, and it ends at the configured `escalationTimeoutSeconds`. At most 8 egress escalations wait for a human at once per coordinator; more are refused (`egress-escalation-limit`) and not remembered.
5. The decision is written to the session audit log (one entry), then returned. The proxy records a human decision (section 5), applies its address screen, and opens the tunnel or forwards the request, or answers `403` (`Forbidden by egress policy: <reason>` for readable requests).

### No call mutex

`authorizeEgress` never takes the coordinator's call mutex. The mutex protects read-modify-write caches (approval whitelist, circuit breaker, server context) that an egress decision does not touch; policy evaluation is synchronous; and a decision must not wait behind a long backend tool call (an agent's shell `curl` while a git clone runs through `execute_code`, or another workflow lane). The proxy relays the tunnel or the response only after the decision returned, so no streamed transfer ever holds a coordinator lock. Egress decisions skip the circuit breaker on purpose: a build legitimately opens many identical connections.

## 7. Audit format

Each decision is one `AuditEntry`:

```json
{
  "serverName": "network",
  "toolName": "request",
  "arguments": { "method": "CONNECT", "host": "mirror.example.org", "port": 443 },
  "policyDecision": { "status": "allow", "rule": "network-egress-escalate", "reason": "Approved by human during escalation" },
  "escalationResult": "approved",
  "result": { "status": "success" },
  "persona": "coder"
}
```

`result.status` is `success` when the destination was admitted and `denied` otherwise; the transfer itself (bytes, response status) is not audited. There is no write-ahead `dispatching` record: the decision is the side effect being recorded, and nothing is dispatched by the coordinator. Structural refusals, prior-decision settlements, timeouts (`timed-out`) and cancellations (`cancelled`) are all audited. Audit redaction applies to the arguments as to any tool call. With taint escalation enabled (section 9), the entry of an admitted destination also carries `"taint": { "source": true }`.

## 8. `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` deprecation

- Without the opt-in the variable works as before (every unknown host tunneled, on any port), and every proxy start logs `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS is deprecated and will be removed ...` to the session log; the terminal gets the same warning once per process (a daemon starts many proxies). Only proxies with passthrough (the agent's standard listener) warn: the variable never affects an egress listener (the Docker-workload registry listener), which starts first in such a bundle and would otherwise show the wrong variant on the terminal.
- With `egressPolicy.enabled` the variable is ignored and the warning says so. `allowedHosts: ["*"]` is the closest replacement: every host name on 443/80 is admitted, each decision audited, tunnels SNI- and Host-pinned, IP literals and other ports refused.

## 9. Security properties

- Opt-in: with `egressPolicy` off, the proxy behaves exactly as before.
- Fail closed: no decider, a rejected decision, an unwritable audit log or a closed coordinator refuses the request; nothing is tunneled while a decision is pending.
- Every decision under the opt-in is audited, including structural refusals.
- Human-only: the auto-approver and the whitelist never admit a destination.
- The agent cannot call the virtual tool, cannot pass `prior` (it is set by the proxy from its own approval sets), and cannot widen ports or reach IP literals and local names.
- Pinning is unchanged: a policy-admitted 443 tunnel is relayed only when the ClientHello SNI equals the admitted host; a port-80 tunnel re-originates every request with the Host header pinned.
- Prompt storms are bounded: one escalation per target at a time, at most 8 pending per coordinator, remembered denials.
- Taint escalation ([sequence-aware-policy.md](./sequence-aware-policy.md), opt-in `taintEscalation`): an admitted destination lets content other people wrote reach the agent without an MCP call, exactly like an approved `add_proxy_domain`, so `network/request` is a taint source by default. `decideEgress` audits the decision with `taint.source` and taints the session (shared with the tool-call pipeline through the coordinator) before the decision is returned, so before the proxy opens anything; from then on every sink tool call needs a human. A resume restores it from the audit log. It is not a sink (like `http_fetch`): destinations stay gated by the egress rules. `taintEscalation.tools: { "network/request": "none" }` opts out.

## 10. Limitations and later slices

- **Providers and registries at path granularity.** Their TLS-terminated requests are still decided by the static allowlists (endpoint filtering, registry validation) rather than by `network/request` rules. Slice 2 would evaluate them too, keeping the dedicated filters.
- **Constitution compilation.** `compile-policy` does not yet know the virtual `network` server, so constitution text does not compile into `network` rules; until it does, `allowedHosts` is the way to allowlist hosts, and hand-written policy directories may carry `network` rules.
- **Ports and addresses.** Only 443 and 80 are admitted, and IP-literal destinations never are; there is no rule condition for ports yet.
- **Method and path conditions.** `method`, `path` and `port` have the role `none`, so no compiled condition (`roles`, `paths`, `domains`, `lists`) can match them: a rule admits, escalates or refuses a host, and what path granularity adds today is that each readable request is decided and audited on its own (section 2). Path-level rules need a role (or condition) for the request path first.
- **Open raw tunnels and policy swaps.** A raw tunnel admitted by a rule stays open across a workflow persona swap until it closes or idles out (10 minutes); new connections and every readable request are decided under the new policy.
- **Per-persona approval scoping.** Escalate-once approvals are bundle-scoped, like `add_proxy_domain`.
- **Interactive configuration** of `egressPolicy` in `ironcurtain config`.

## 11. Files

- `src/trusted-process/egress-policy.ts`: the virtual server (annotation, rules, structural screen) and `decideEgress`.
- `src/trusted-process/tool-call-coordinator.ts`: `egressPolicy` option, rule merging on construction and `loadPolicy` (and into a task scope), `authorizeEgress` (which hands `decideEgress` the session's taint state).
- `src/trusted-process/taint-policy.ts`: the `network` default taint profile (`request` is a source).
- `src/trusted-process/tool-call-pipeline.ts`: `waitForHumanDecision`, the human escalation wait shared by tool calls and egress decisions.
- `src/docker/mitm-proxy.ts`: `policyEvaluatedEgress`, `setEgressAuthorizer`, per-target queue, escalate-once memory, the policy paths for CONNECT, plain HTTP, `ws://`, port-80 tunnels and nested passthrough; the deprecation warning.
- `src/docker/code-mode-proxy.ts` (`getEgressAuthorizer`), `src/docker/docker-infrastructure.ts` and `src/sandbox/index.ts`: wiring.
- `src/config/user-config.ts`, `src/net/egress-host-pattern.ts`: configuration.
- `src/types/argument-roles.ts`, `src/trusted-process/domain-utils.ts`: the `egress-host` role.
- `test/mitm-egress-policy.test.ts`: rules, screen, coordinator decisions (in-process and file-IPC escalation, escalate-once, cancellation, limits, policy swap, audit failure, no call mutex), the proxy paths, and the end-to-end acceptance test (a CONNECT to an unapproved host escalates through the normal channel and is audited).
- `test/taint-policy.test.ts` ("MITM egress decisions"): admitted destinations taint the session (by rule or by a human), refused ones do not, the sink call after it needs a human, resume restores it, and the reclassification opt-out.

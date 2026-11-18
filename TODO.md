# TODO

Scratch list of ideas and chores, reconciled with the code on 2026-11-14. [`docs/MISSING_FEATURES.md`](docs/MISSING_FEATURES.md) is the source of truth for what is implemented and what is missing; an idea here that becomes a feature is tracked there.

## Open

- RV-22: qualify the authenticated Signal bridge on actual macOS Docker Desktop/Apple runtimes and with a live Signal account. TLS/bearer admission, the shared host client, private credential bundle and owned-container migration are implemented; see `docs/designs/signal-transport.md` and `docker/signal-bridge/README.md`.

- MITM should implement deterministic steering or command rewrite for weaker models that struggle with running a complex harness. see the insights from getting DeepSeekV4 to run - also see: https://github.com/DataArcTech/Bayesian-Agent
  - **Deferred by owner decision (WP-123).** Prerequisites if it is picked up: record the post-rewrite body or a rewrite diff in the exchange record (trajectory capture records the pre-rewrite body); command rewriting needs a new response-side SSE transform seam; rewriting history can break thinking-block signatures; make it opt-in per provider profile, off by default.

Other Omnigent-inspired candidates (security-aligned extensions to the trust boundary):

- Stateful / contextual policies: PolicyEngine.evaluate() judges each call on its own. Wire session state (ServerContextMap / ApprovalWhitelist / CircuitBreaker history) into rule predicates so rules can express e.g. "escalate writes to files this agent didn't create" or "require approval once the agent fetched from npm".
  - **Slice 1 done (WP-117):** an opt-in per-session taint flag (`taintEscalation`): after a taint-source tool runs, every outbound sink call needs a human. See `docs/designs/sequence-aware-policy.md`. Open: session facts as predicates in compiled rules.
- Egress-as-policy at the MITM: route raw HTTP egress through the same allow/deny/escalate engine that governs MCP tool calls instead of the endpoint allowlist and the ALLOW_ALL_HOSTS escape hatch.
  - **Slice 1 done (WP-118):** opt-in `egressPolicy`; `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` is deprecated and ignored under it. The remaining slices are in section 10 of `docs/designs/mitm-egress-policy.md`.
- Two-person / quorum approval for high-risk escalations (separation of duties), riding on the existing escalation flow. NOT general free-form multi-human steering.
  - **Deferred by owner decision (WP-122).** Grouped approval and reviewer context were implemented.
- Explicitly NOT a fit: remote/cloud execution backends (Modal/Daytona) — breaks IronCurtain's co-located trust model (host-side proxies, credentials on host); would be a trust-boundary redesign, not a feature.

Items that need the owner to say what they mean before they can be closed:

- test persona constitution and policy feature
  - Automated tests exist (`test/persona*.test.ts` and related suites cover definitions, compiles, lifecycle, overrides and sessions). Close this unless it means a manual end-to-end check.
- need to create memory for each session
  - By design, sessions without a persona or cron job run without memory (`src/memory/memory-policy.ts`: "default sessions are stateless"); memory is enabled per persona and per job. Close this unless every session should get memory.
- need to override agent loop memory with new memory system
  - Persona and job sessions already get the memory MCP server, including the builtin agent; auto-compaction still summarizes the builtin conversation itself. Clarify whether this means replacing compaction with memory recall.

## Done

- Per-state agent harness selection in workflows (WP-124): `states.<id>.dockerAgent` overrides `settings.dockerAgent`; under `sharedContainer` there is one harness per `containerScope`, so a diverse reviewer uses its own scope.
- need to compile policy for each server separately (`PipelineRunner` compiles, verifies and caches each server on its own).
- implement memory-mcp-server.md (superseded by `docs/designs/memory-mcp-server-v2.md`, implemented in `packages/memory-mcp-server/`)
- optimize utcp code mode - compress name space
- support package installation in the sandbox? YES! Should for sure pre-install uv and ruff
- implement session-resume.md
- persona mode for sessions/cron jobs
- daemon mode should connect to signal for cron escalations
- cron mode with individual constitution -> policy, e.g. triage github issues
- policy language refinement via conditional attribute roles
- cron should help to compile policy
- remove path heuristic

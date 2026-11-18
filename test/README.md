# Tests

## Running tests

```bash
# Run all tests (safe — no LLM calls by default)
npm test

# Run a single test file
npm test -- test/policy-engine.test.ts

# Run a single test by name
npm test -- -t "denies delete_file"

# Run tests that require real LLM API calls (costs money)
LLM_INTEGRATION_TEST=true npm test
```

## Test overview

### Integration tests (spawn real processes)

These tests start real MCP server child processes and need ~30s timeout.

| File                                           | What it tests                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration.test.ts`                          | `TrustedProcess` end-to-end with a real `@modelcontextprotocol/server-filesystem`. Covers policy evaluation, escalation approval/denial, root expansion, and audit logging.                                                                             |
| `sandbox-integration.test.ts`                  | OS-level sandboxing via `srt` (bubblewrap + socat). Skipped automatically when sandbox dependencies are not installed.                                                                                                                                  |
| `filesystem-server-launch.integration.test.ts` | Starting IronCurtain from a hostile working directory runs nothing planted there (`node_modules`, `.npmrc`, `tsconfig.json`), and the session uses the packaged, exact-pinned filesystem MCP server.                                                    |
| `list-resolver-mediation.integration.test.ts`  | Dynamic-list resolution through MCP is mediated by the security kernel (the read-only policy, denied escalations and the audit log), with a real relay subprocess and a fake backend: calls the policy refuses never reach the backend and are audited. |

`trusted-spawn-cwd.test.ts` checks the spawn specs without starting any process: no MCP relay or backend spawn inherits IronCurtain's working directory.

### Tests that make real LLM calls

These are gated behind `LLM_INTEGRATION_TEST=true` and require `ANTHROPIC_API_KEY` (exported, or in a `.env` at the repository root, which these files load themselves). They use Claude Haiku and cost fractions of a cent per run, but be aware they hit a live API.

| File                                          | What it tests                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `auto-approver-integration.test.ts`           | Auto-approve decision quality across ~25 scenarios against a live Haiku model.                               |
| `escalation-scenarios.test.ts` (Suite B only) | Auto-approver on escalation scenarios with live LLM. Suite A (policy engine checks) always runs and is free. |

### Unit tests (no external calls)

Everything else mocks LLM calls via `MockLanguageModelV3` from `ai/test` or `vi.mock()`. These are fast and free.

### Adversarial & agent-loop harness

The harness in `test/harness/` drives the **real** `generateText` loop (not a `vi.fn()` mock) with no network, no real LLM and no Docker:

| File                             | Role                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness/fake-provider.ts`       | A real `@ai-sdk/anthropic` model whose transport is a fake `fetch` that enforces the Messages API `tool_use`/`tool_result` pairing and tools-required rules, plus a pure, unit-testable validator. |
| `harness/malicious-model.ts`     | A scripted `MockLanguageModelV3` playing a compromised agent (reassignable per turn) with realistic `ModelMessage` shapes, which also reports the tool results the model was shown.                |
| `harness/adversarial-harness.ts` | Config builders, a mock sandbox, a scriptable escalation reviewer (denies by default; can approve, and act inside the approval wait), and an audit-log reader shared by the two suites.            |

Two suites consume it:

- `agent-loop-real.test.ts` — hermetic (mock sandbox, no isolate). Fake-provider pairing across steps and turns, compaction of a tool-bearing history (a text-only summarizer request and a split that keeps every tool pair whole, SES-5), per-step usage recording, step and token budgets ending an unbounded tool loop, the loop detector's block on the real execute path, and the structural adversarial controls (`add_proxy_domain` human-only, the memory server's trust, a planted workspace `.env`), seeded from `fixtures/escalation-scenarios.ts`. The persona memory server is no longer policy-exempt (SES-11 / DTL-9): its per-tool policy holds a bulk wipe for a human and denies an unknown tool, while a single-fact write stays an allow that the memory server contains (writer provenance, data framing).
- `adversarial-e2e.integration.test.ts` — drives the production session factory (`createSession` with a workspace), the real Code Mode isolate and a real `@modelcontextprotocol/server-filesystem` relay, with the production protected-path set (gated on `isIsolatedVmAvailable()`, serialized in `ISOLATED_VM_TESTS`): encoded exfiltration, a symlink escape, a symlink swapped during the approval wait (TOCTOU), `.git` hook/config planting, `.env` planting, memory poisoning, a protected-path read, and a console round-trip. Each scenario asserts its own audit record, the tool results the model was shown and the absence of the side effect; approved-read and in-sandbox-write controls prove the checks can see a leak and an allow. Docker Agent Mode egress containment is covered against real containers by `network-isolation.integration.test.ts` (`INTEGRATION_TEST=1`).

Both suites run under `npm test`, so CI and releases already gate on them.

## Test fixtures

`test/fixtures/test-policy.ts` provides deterministic compiled policy and tool annotations so tests don't depend on LLM-generated artifacts in `src/config/generated/`.

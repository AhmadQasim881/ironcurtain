# Testing Guide

## Quick Start

```bash
npm test                                # Root and web UI suites; environment-dependent tests may skip
npm test -w packages/memory-mcp-server  # Separate memory suite, including real model tests
npm run lint                            # Lint
npm run format:check                    # Check formatting
npm run typecheck:tests                 # Type-check the test suite (tsconfig.test.json)
npm run test:coverage                   # Full suite with coverage thresholds
```

Vitest strips types without checking them, so tests must also pass `npm run typecheck:tests`
(`tsconfig.test.json`: `src`, `test`, `examples` and `vitest.config.ts`) before a commit, next to lint
and format.

Run the memory suite separately from the full root suite on resource-constrained hosts: real model
loading competes with parallel tests for CPU and can exceed test deadlines. It needs model files in
cache or network access to download them, even though mocked LLM tests need no API key.

`npm test` runs `scripts/test.sh`. Each attempt of the root suite runs with a run ledger
(`scripts/vitest-run-ledger.ts`) and is labelled `pass`, `fail`, `flake` (a worker died after every
planned test finished and passed) or `incomplete` (a worker died and some planned test has no result).
Flakes and incomplete runs are retried; the suite fails when its last attempt is still incomplete,
because tests that never ran cannot pass. Passing arguments (`npm test -- test/foo.test.ts`) runs
only that selection, once, without the web UI suite.

## Test Categories

| Category                        | Example files                                                                                                 | Requirements                                                                                                         | Runs by default             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Unit**                        | `policy-engine.test.ts`, `argument-roles.test.ts`, `domain-utils.test.ts`                                     | None                                                                                                                 | Yes                         |
| **Component (mocked LLM)**      | `auto-approver.test.ts`, `constitution-compiler.test.ts`, `constitution-generator.test.ts`                    | None (uses `MockLanguageModelV3`)                                                                                    | Yes                         |
| **Integration (MCP servers)**   | `integration.test.ts`, `mcp-proxy-server.test.ts`, `proxy-integration.test.ts`                                | Real MCP server processes spawn; ~30s timeout                                                                        | Yes                         |
| **Agent loop and adversarial**  | `agent-loop-real.test.ts`, `adversarial-e2e.integration.test.ts`                                              | `agent-loop-real` is hermetic; the adversarial suite needs a working `isolated-vm` (see `test/README.md`)            | Yes                         |
| **Sandbox integration**         | `sandbox-integration.test.ts`                                                                                 | `bubblewrap`, `socat` and `ripgrep` installed (Linux), and user namespaces allowed                                   | Auto-skipped if unavailable |
| **Isolated VM**                 | `help-integration.test.ts`, `docker-code-mode.integration.test.ts`                                            | `isolated-vm` native module works on current Node version                                                            | Auto-skipped if unavailable |
| **LLM integration**             | `auto-approver-integration.test.ts`, `escalation-scenarios.test.ts` (Suite B), `help-llm-integration.test.ts` | `LLM_INTEGRATION_TEST=true` + `ANTHROPIC_API_KEY`                                                                    | No                          |
| **Docker integration**          | `network-isolation.integration.test.ts`                                                                       | Linux + `INTEGRATION_TEST=1` + Docker + an image (`NETWORK_ISOLATION_TEST_IMAGE`, default `ironcurtain-base:latest`) | No                          |
| **Live registry integration**   | `test/docker/registry-egress-live.integration.test.ts`                                                        | Internet access + `REGISTRY_EGRESS_LIVE_INTEGRATION=1`                                                               | No                          |
| **Nested-Docker qualification** | `scripts/qualify-backend.ts`                                                                                  | An admitted macOS or WSL2/Desktop backend, Go, agent images, and public network                                      | No                          |
| **Auth**                        | `test/auth/oauth-flow.test.ts`, `test/auth/oauth-token-store.test.ts`                                         | None                                                                                                                 | Yes                         |
| **Docker subsystem**            | `test/docker/registry-proxy.test.ts`, `test/docker/package-validator.test.ts`                                 | None                                                                                                                 | Yes                         |
| **Signal**                      | `test/signal/setup-signal.test.ts`, `test/signal/markdown-to-signal.test.ts`                                  | None                                                                                                                 | Yes                         |
| **PTY (platform-specific)**     | `pty-session.test.ts` (some cases)                                                                            | Linux + `socat`                                                                                                      | Auto-skipped on non-Linux   |

Docker integration suites that need a reachable Docker daemon skip without one; run `npm test` as a regular user with
Docker running to exercise them. Some tests assume a short `$HOME`, since Unix socket paths are limited to about 100
bytes.

## Environment Flags

### `LLM_INTEGRATION_TEST`

Gates tests that call a live LLM API. Requires a valid `ANTHROPIC_API_KEY`, exported in the environment or in a `.env`
file at the repository root (these test files load it themselves; the CLI never reads that file).

```bash
LLM_INTEGRATION_TEST=true npm test -- test/auto-approver-integration.test.ts
LLM_INTEGRATION_TEST=true npm test -- test/escalation-scenarios.test.ts
LLM_INTEGRATION_TEST=true npm test -- test/help-llm-integration.test.ts
```

### `INTEGRATION_TEST`

Gates tests that require Docker infrastructure (containers, network isolation, MITM proxies).

```bash
INTEGRATION_TEST=1 npm test -- test/network-isolation.integration.test.ts
```

The network isolation suite runs in `NETWORK_ISOLATION_TEST_IMAGE` (default `ironcurtain-base:latest`). CI builds a
small image from `test/fixtures/network-isolation/Dockerfile` for it:

```bash
docker build --build-arg TEST_UID="$(id -u)" -t ironcurtain-network-isolation-test test/fixtures/network-isolation
INTEGRATION_TEST=1 NETWORK_ISOLATION_TEST_IMAGE=ironcurtain-network-isolation-test \
  npx vitest run test/network-isolation.integration.test.ts
```

### `REGISTRY_EGRESS_LIVE_INTEGRATION`

Runs the production registry-egress policy against anonymous Docker Hub and GHCR pulls:

```bash
npm run test:registry-live
```

### Nested-Docker release qualification

Run the gate for each advertised backend from the exact release candidate on the corresponding host:

```bash
npm run qualify:apple
npm run qualify:docker-desktop
# On WSL2 with Docker Desktop (amd64):
npm run qualify:wsl-desktop
npm run test:registry-live
```

`qualify:apple` builds the current tree, rejects any skipped/pending/todo selected test, and runs the
production workflow separately in `packages`, `images`, and `offline` modes before the PTY transport
gate. `qualify:docker-desktop` applies the same no-skip rule and runs coordinator-crash recovery,
feature-off, PTY, offline, images, and packages gates. `qualify:wsl-desktop` prepares Claude Code, Goose,
and Codex images, runs the selected no-skip suite including UDS boundary and identity checks, then runs
the six direct gates plus three workflow-mode gates. The CLI/PTY/workflow live gates use Claude; image
and UID tests do not establish all-mode qualification for every adapter.

These commands create isolated runtime resources and require exact cleanup; none is part of ordinary
CI. Evidence is retained even on failure. Use `-- --report-dir <directory>` to choose a durable report
location. Default suite/direct-gate limits are 30 minutes; workflow gates use a longer budget derived
from the workflow deadline plus child-process and cleanup allowances. To override a gate's bound, append
`-- --timeout-ms <milliseconds>`; an explicit override also replaces the longer workflow budget.

Use [CONFIG.md](CONFIG.md#nested-docker-workloads) for the authoritative supported-profile and
admission requirements. The [acceptance record](docs/designs/linux-nested-docker-implementation-plan.md#acceptance-record)
holds dated results and outstanding validation; do not infer current qualification from historical runs.
The opt-in nested daemon image test builds offline, so pull `golang:1.26.11-bookworm` before running it.

#### WSL host-identity qualification

The host-identity harness runs as a real different numeric user with private temporary roots
and the existing Docker socket group. It does not create a permanent account or change
workspace ownership. Run it with host sudo and a Node executable matching the checkout's
native dependencies; container-local sudo does not grant this host permission:

```sh
sudo python3 scripts/qualify-wsl-non1000.py \
  --uid 1101 --gid 1102 \
  --node /absolute/path/to/compatible/node \
  offline images packages pty workflow recovery disabled
```

Retain its identity report separately from the default-identity run. Consult the
[acceptance record](docs/designs/linux-nested-docker-implementation-plan.md#acceptance-record)
for whether this evidence has been collected.

### Combining general-suite flags

You can set both general-suite flags simultaneously:

```bash
LLM_INTEGRATION_TEST=true INTEGRATION_TEST=1 npm test
```

## Running Specific Tests

```bash
# Single file
npm test -- test/policy-engine.test.ts

# Pattern match
npm test -- -t "denies delete_file"

# Watch mode
npm test -- --watch test/policy-engine.test.ts
```

## Coverage

`npm run test:coverage` runs the full suite with V8 coverage and fails when `src/trusted-process`, `src/sandbox` or
`src/docker/mitm-proxy.ts` drop below the thresholds in `vitest.config.ts`. The thresholds apply to the whole suite,
so a run of a few files falls below them. CI runs it on the Ubuntu / Node 24 leg.

## Writing Tests

### Conventions

- **Mocking LLMs**: Use `MockLanguageModelV3` from `ai/test` for deterministic LLM responses. See `test/auto-approver.test.ts` for examples.
- **Temp directories**: Integration tests that create temp directories should use `mkdtempSync` in `beforeAll`/`beforeEach` and `rmSync` in `afterAll`/`afterEach`. Use `/tmp/` as the base.
- **Timeouts**: Tests spawning MCP server processes or calling live APIs should set a 30s timeout: `it('...', async () => { ... }, 30_000)`.
- **Filesystem MCP server**: spawn it through `test/helpers/filesystem-server.ts`, never `npx -y`; the server is an exact-pinned dependency started with `node`.
- **Fixtures**: Shared test fixtures live in `test/fixtures/` (e.g., `test-policy.ts`, `escalation-scenarios.ts`). `test-policy.ts` also exports `objectSchema`, `argsSchema` and `withInputSchemas` for writing annotations in the stored format: each tool added to `testToolAnnotations` needs an `inputSchema` declaring exactly its arguments (`test/test-policy-fixture.test.ts` checks it).
- **Helpers**: Shared test utilities live in `test/helpers/`:
  - `isolated-vm-available.ts` — probes whether `isolated-vm` works on the current Node version (spawns a child process to avoid crashes).
  - `config-test-setup.ts` — environment isolation for config-related tests (`setupConfigEnv`/`teardownConfigEnv`), plus `seedConfig`/`readConfig` helpers.
  - `user-config.ts` — `testUserConfig(overrides)` builds a complete resolved user config for hand-built `IronCurtainConfig`s.
  - `uds-client-transport.ts` — MCP client transport over Unix domain sockets, used by integration tests.
  - `filesystem-server.ts` — spawn spec of the pinned filesystem MCP server.
  - `mock-signal-api.ts` — a fake signal-cli REST API for the real Signal bot daemon.
  - `pty-stub-bridge.ts` — a stub PTY bridge for `PtySessionManager` tests.
- **ESM imports**: Use `.js` extensions in import paths (TypeScript convention for ESM).
- **Conditional execution**: Use `describe.skipIf(condition)` or `it.skipIf(condition)` (vitest built-ins) to skip tests when prerequisites are missing. Common conditions: `!process.env.LLM_INTEGRATION_TEST`, `!process.env.INTEGRATION_TEST`, `!isIsolatedVmAvailable()`, `process.platform !== 'linux'`.
- **Isolated VM files**: a test file that instantiates a V8 isolate must be listed in `ISOLATED_VM_TESTS` in `vitest.config.ts` (those files run one at a time); `test/isolated-vm-test-inventory.test.ts` fails when one is missing.

### Test file naming

- `*.test.ts` — standard tests (unit, component, integration with mocked dependencies)
- `*.integration.test.ts` — tests requiring external infrastructure (Docker, real network)

### Test subdirectories

Tests for self-contained subsystems live in subdirectories under `test/`:

- `test/auth/` — OAuth flows, token storage, provider registry, Google scopes
- `test/docker/` — Docker-specific utilities (registry proxy, package validator)
- `test/signal/` — Signal messaging integration (formatting, setup, markdown conversion)
- `test/workflow/` — workflow engine tests
- `test/harness/` — the agent-loop test harness

See `test/README.md` for the suites that spawn real processes.

## Pre-commit Hook

See [CONTRIBUTING.md](CONTRIBUTING.md#pre-commit-hook) for hook installation, staged-file scope,
and the full validation commands required before submitting changes.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs for pushes to `master` and pull requests targeting it, except
changes that touch only top-level Markdown, `docs/`, `.claude/`, `CLAUDE.md`/`GEMINI.md` files or `LICENSE`. Its jobs:

- **ci** — Node 24 and 26 on Ubuntu and macOS: builds the memory workspace and the application, checks formatting,
  lint and import cycles, then runs `npm test` (root plus web UI suites). The Ubuntu / Node 24 leg runs
  `npm run test:coverage` and the web UI suite instead.
- **workspaces** — the web UI's `svelte-check`, lint and format check; `typecheck:scripts` and `typecheck:tests`; the
  memory server's lint, format check, build and test suite (`npm test -w packages/memory-mcp-server`).
- **dependency-audit** — `npm run check:audit` (see [CONTRIBUTING.md](CONTRIBUTING.md#dependency-security)).
- **network-isolation** — the Docker network isolation suite on Ubuntu, with the image built from
  `test/fixtures/network-isolation`.
- **package-smoke** — packs the tarball, installs it globally on Node 24 and 26 and runs the installed CLI.
- **build-trust-runtime** and **nested-relay** — the Go components: `npm run check:build-trust-runtime`, and
  `go vet` and `go test` of the nested relay.

The weekly `.github/workflows/scheduled-checks.yml` builds the images on amd64 and arm64, runs the npm audit gate,
checks that `@anthropic-ai/sandbox-runtime` is the newest release, checks Go release support
(`npm run check:go-toolchain -- --strict --releases <file>`), and runs annotation drift checks for the github and
google-workspace servers. LLM integration tests and opt-in Docker/registry/backend qualification gates are not
enabled by these jobs. Green CI therefore does not replace live backend qualification or a fresh installed-package
test.

See [dependency security guidance](CONTRIBUTING.md#dependency-security) for Safe Chain usage and the
distinction between a clean checkout audit and downstream npm installation.

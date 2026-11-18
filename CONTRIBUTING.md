# Contributing to IronCurtain

Thank you for your interest in contributing to IronCurtain! This is an early-stage research project and contributions are welcome.

## Getting Started

1. Fork and clone the repository:

   ```bash
   git clone https://github.com/provos/ironcurtain.git
   cd ironcurtain
   npm install
   ```

   IronCurtain needs Node.js 24 or 26 (`engines` in `package.json`). Building the native modules (isolated-vm, node-pty) needs Python 3 and a C/C++ toolchain (on Linux, compiling `node-pty` needs `python3`, `make` and `g++`); the Go components under `docker/` need Go 1.26 (`docker/nested-relay/go.mod` and `docker/build-trust-runtime/manifest.json` pin the exact release). With Nix, `nix develop` provides them (`flake.nix`); its Go is whatever 1.26 release the locked nixpkgs ships, while `go test` in `docker/nested-relay` needs at least the pinned release and `npm run check:build-trust-runtime` exactly that release, so update the lock (`nix flake update`) or install the pinned release when they differ.

   The root `package.json` decides which dependency install scripts run (`allowScripts`): `isolated-vm` and `node-pty` build, while `onnxruntime-node`'s install script (it only downloads optional CUDA binaries), `protobufjs`, `esbuild` and `fsevents` are skipped. npm 11.19 and later enforce this; npm older than 11.19 ignores that field, so set `ONNXRUNTIME_NODE_INSTALL=skip` for `npm install` there to avoid the CUDA download (the Nix shell and `scripts/linux-dev.sh` set it). See [docs/designs/dependency-hygiene.md](docs/designs/dependency-hygiene.md).

2. (Recommended) Install [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain) to protect against supply chain attacks during development. It intercepts package installations and validates them against a threat intelligence database in real-time:

   ```bash
   npm install -g @aikidosec/safe-chain
   safe-chain setup
   ```

3. Put your LLM API key where IronCurtain reads credentials. A `.env` in the repository is not read by the CLI or the npm scripts:

   ```bash
   mkdir -p ~/.ironcurtain
   echo "ANTHROPIC_API_KEY=sk-ant-..." >> ~/.ironcurtain/.env
   chmod 600 ~/.ironcurtain/.env
   ```

   To keep a key file elsewhere, name it explicitly: `IRONCURTAIN_ENV_FILE=$PWD/.env npm run compile-policy`, or `npx tsx src/cli.ts --env-file .env compile-policy` (`--env-file` goes before the command, so `npm run compile-policy -- --env-file .env` does not work). The LLM integration tests still load a repository `.env` themselves.

4. Install the [Git hooks](#pre-commit-hook) for staged-file checks and pre-push cycle detection:

   ```bash
   npm run setup-hooks
   ```

5. Run the tests to verify your setup:

   ```bash
   npm test
   ```

## Development Workflow

```bash
npm run build                   # TypeScript compilation + copy config assets to dist/
npm test                        # Run all tests (vitest)
npm run lint                    # Run ESLint
npm run format                  # Format code with Prettier
npm run typecheck:tests         # Type-check the tests (vitest strips types without checking them)
npx tsx src/cli.ts mux          # Recommended interactive run from source
npx tsx src/cli.ts start "task" # One-shot smoke test from source
```

Run a single test file or test by name:

```bash
npm test -- test/policy-engine.test.ts
npm test -- -t "denies delete_file"
```

See [TESTING.md](TESTING.md) for the full testing guide, including environment flags for LLM and Docker integration tests.

A running IronCurtain refuses its own package directory as a workspace, so `npx tsx src/cli.ts start -w .` from this checkout is rejected. To let an IronCurtain agent work on IronCurtain, run it from a separate checkout (or a global install) against this one.

### Project Structure

```
src/
├── config/             # Configuration loading, constitution, MCP server definitions
├── docker/             # Docker Agent Mode: containers, MITM, registry and Code Mode proxies
├── pipeline/           # Constitution -> policy compilation pipeline (offline tooling)
├── sandbox/            # V8 isolated execution environment (UTCP Code Mode)
├── session/            # Multi-turn sessions: the Code Mode agent loop (agent-session.ts), budgets, loop detection
├── trusted-process/    # Policy engine, tool-call coordinator, MCP relay, audit log, escalation
├── types/              # Shared type definitions
├── web-ui/             # Daemon web UI server (the Svelte frontend is packages/web-ui/)
└── workflow/           # Multi-agent workflow orchestrator
```

See the [README](README.md#project-structure) for the full list. The root [CLAUDE.md](CLAUDE.md) and the `CLAUDE.md` files in `src/trusted-process/`, `src/docker/`, `src/pipeline/`, `src/persona/` and `packages/web-ui/` describe the architecture module by module.

### Key Conventions

- ESM modules throughout (`.js` extensions in imports)
- TypeScript strict mode
- `stderr` for diagnostic output, `stdout` for agent responses
- Integration tests spawn real MCP server processes and need ~30s timeout

## Testing on Linux (from macOS)

IronCurtain uses different transport mechanisms on Linux (UDS + `--network=none`) vs macOS (TCP + internal bridge network). If you develop on macOS, use the provided script to test in a Linux environment via Docker-in-Docker:

```bash
# One-time setup: create a separate clone for Linux (avoids native module conflicts)
git clone git@github.com:provos/ironcurtain ~/src/ironcurtain-linux

# Launch a Linux dev shell (builds the DinD image on first run)
./scripts/linux-dev.sh

# Or run a specific command
./scripts/linux-dev.sh npm test
```

The script automatically syncs your current branch to the Linux clone, installs dependencies with Linux-native binaries, and starts a Docker daemon inside the container. Push your changes before running the script so the Linux clone can pick them up. The image provides Node.js 24: its build fails on a Node.js major that `package.json` does not allow, and an existing image with an unsupported Node.js is rebuilt automatically (native modules in the Linux clone that do not load with the new Node.js are then rebuilt in the container). API keys are forwarded as environment variables, from your shell or from `~/.ironcurtain/.env` (or `$IRONCURTAIN_ENV_FILE`); a `.env` in the repository is not read.

To rebuild the image (e.g. after changing the Dockerfile in the script):

```bash
./scripts/linux-dev.sh --rebuild
```

## Pre-commit Hook

The pre-commit hook runs `lint-staged` on matching staged files. The root `package.json`
defines the checks: formatting and lint for selected source/test files, plus the configured
web UI checks. It is not a full-repository validation gate. Install the hooks with:

```bash
npm run setup-hooks
```

This installs `.hooks/pre-commit` and `.hooks/pre-push` into `.git/hooks/`. The pre-push
hook checks import cycles; it does not run the full test suite. Run the full tests,
`npm run lint`, `npm run format:check` and `npm run typecheck:tests` before submitting a PR,
even when both hooks pass.

If the hook blocks your commit, fix the issues first:

```bash
npm run format     # Auto-fix formatting
npm run lint       # Check lint errors (fix manually)
```

## Workspace Dependencies

This project uses [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) to manage local packages under `packages/`. When the root `package.json` depends on a workspace package (e.g., `@provos/memory-mcp-server`), use a **normal semver range** like `"^0.1.3"` — **not** `"workspace:*"`.

The `workspace:*` protocol is pnpm-specific and causes `npm install -g` and `npx` to fail with `EUNSUPPORTEDPROTOCOL`. npm workspaces automatically resolves matching local packages during development, so the standard version range works for both local dev and published installs.

When publishing a new version of a workspace package, update the version range in the root `package.json` to match.

## Dependency Security

Keep Aikido Safe Chain enabled during dependency updates. Verify the shell integration with
`npm safe-chain-verify`, or invoke `aikido-npm` explicitly when aliases are not loaded. Do not
disable malware or minimum-package-age checks to obtain an update.

**npm audit gate.** `npm run check:audit` runs `npm audit` on the production dependency tree
(workspaces included) and fails on a high or critical advisory that the reviewed allowlist,
[.github/npm-audit-allowlist.json](.github/npm-audit-allowlist.json), does not accept. An entry names
one package, the advisories it accepts there (GHSA id and the severity they were reviewed at), the
reason, the review date and an expiry at most 180 days later; an expired entry, or an advisory
whose severity was raised, fails the gate again. Entries that no longer match an advisory are
reported as stale. CI runs the gate on every push and pull request and weekly. When it fails, merge
the fix, or, when the vulnerable code is not reachable, add an entry with that reachability
reasoning and a short expiry. Merge security updates within 7 days, critical ones the same week.

`@anthropic-ai/sandbox-runtime` (the OS sandbox around MCP servers) is pinned to one version, so
users get its fixes only through an IronCurtain release: bump it to the newest tested release before
each release (the weekly check fails while it is behind) and run the sandbox suites. Cut a patch
release after any web UI security fix, since the bundled web UI keeps its sanitizer until the next
release.

The memory server requires `@huggingface/transformers ^4.3.0`, whose dependency ranges
accept patched `sharp` and `adm-zip` through ONNX Runtime 1.30.0. The checkout no longer
needs overrides for these packages. When updating this chain, run the memory suite and
verify native image processing and the installer's ZIP extraction API.

Memory server 0.2.1 was published on 2026-09-20. IronCurtain now requires
`@provos/memory-mcp-server ^0.2.1` so consumers cannot resolve the older 0.2.0 dependency
graph. For future memory-server updates, test the packed memory server outside the
workspace without root overrides and publish it before the dependent IronCurtain
release. Repeat the complete IronCurtain packed-install check against the registry
version on Node 24 and 26.

Code Mode uses the temporary `@provos/utcp-code-mode` fork through an npm alias
under `@utcp/code-mode`. The fork changes upstream 1.2.13's native-addon peer range
to `isolated-vm ^7.0.1`; IronCurtain also declares `isolated-vm 7.0.1` directly so
the requirement survives publishing. Unlike a root override, these dependency
declarations apply to downstream installs. The fork's source, MPL-2.0 license,
Node 24/26 verification, and publishing instructions are at
[provos/code-mode](https://github.com/provos/code-mode/tree/ironcurtain/typescript-library).
`src/sandbox/code-mode-chain.ts` is a vendored, file-level MPL-2.0 copy of the fork's
`callToolChain`; the rest of IronCurtain stays Apache-2.0.
Remove the alias once upstream supports the required native-addon version, then
repeat the clean packed-install and sandbox integration tests on both Node lines.

**Release caveat:** a clean checkout audit does not establish a clean downstream npm install.
The repository lockfile is not published, and npm ignores overrides declared by installed
dependencies. Before claiming downstream remediation, adopt fixed parent dependencies or a
separately tested publishable pinning strategy, and validate the packed artifact in a fresh
consumer project, including the separately published memory server. Do not simply rename a
workspace-linked lockfile to a shrinkwrap. See [npm's override rules](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides).

## Releasing

Pushing a tag `v<version>` (it must equal the `version` in `package.json`) runs
`.github/workflows/release.yml`, which is split so that no job that runs dependency, build or test code holds a
credential that can publish or write:

1. **build** (read-only): installs without lifecycle scripts, runs the npm audit gate and the Go toolchain check,
   builds (failing if the rebuilt build-trust binaries differ from git), packs the tarball and records its sha256.
2. **test** (read-only): full install and the complete test suite.
3. **publish**: only `id-token: write`, behind the protected `npm-publish` Environment; no checkout and no install.
   It verifies the tarball against the build job's checksum and publishes it with provenance through npm trusted
   publishing.
4. **release-notes** (`contents: write`): creates the GitHub release.

Running the workflow by hand is a dry run (build and test only). The memory server is released the same way from a
`memory-mcp-server/v<version>` tag by `.github/workflows/release-memory-mcp-server.yml`, which has a `dry_run` input.
The toolchain is exact: Node 24.22.2 with its bundled npm 11.19.1, and Safe Chain pinned by publication date.

Owner setup: create the `npm-publish` Environment with required reviewers and deployment rules for the `v*` and
`memory-mcp-server/v*` tags (without it, GitHub creates the Environment on first use with no protection), and
optionally bind the npm trusted-publisher configuration to that Environment and protect release tags with a
ruleset.

Release checklist:

- `npm run check:go-toolchain -- --strict` passes. Strict mode requires every `golang` image under `docker/` to be
  pinned by digest; `docker/nested-relay/Dockerfile` and `docker/nested-daemon/Dockerfile` name only the tag until
  the reviewed digests are recorded.
- `@anthropic-ai/sandbox-runtime` is the newest tested release.
- The reviewed pins are recorded: the memory models (`npm run pin-models -w packages/memory-mcp-server`, which needs
  network access; until then the memory tools refuse the models with `MODEL_UNPINNED`) and the Signal bridge image
  (`SIGNAL_IMAGE_PINNED_DIGEST` in `src/signal/signal-image.ts`; until then the default image is refused and users
  must pin one with `ironcurtain setup-signal --update-image`).
- The CHANGELOG lists the release's behavior changes under `### Behavior changes` (the first command after an
  upgrade prints those bullets).

**Bumping Go.** Edit the `golang` `FROM` line (tag and digest) in `docker/nested-relay/Dockerfile` and
`docker/nested-daemon/Dockerfile`, and move `docker/nested-relay/go.mod`'s `go` line to the same release. For the
build-trust runtime, install that release, run `npm run build:build-trust-runtime`, and update the `setup-go`
`go-version` in `ci.yml` and `release.yml`. Check with `npm run check:go-toolchain`. Dependabot bumps the `FROM`
lines, but not `go.mod` or `setup-go`.

## Submitting Changes

1. Create a feature branch from `master`.
2. Make your changes. Add tests for new functionality.
3. Ensure the pre-commit hook is installed (`npm run setup-hooks`).
4. Ensure all tests pass (`npm test`), lint is clean (`npm run lint`), code is formatted (`npm run format:check`), and the tests type-check (`npm run typecheck:tests`).
5. Submit a pull request with a clear description of the change and its motivation.

## Areas Where Help is Welcome

- **Testing** -- More test scenarios, edge cases, and integration tests.
- **MCP servers** -- Adding support for new MCP servers and argument roles.
- **Constitution examples** -- Real-world constitution examples and templates.
- **Documentation** -- Improving guides, adding examples, fixing inaccuracies.
- **Security review** -- Analyzing the trust boundaries and finding gaps.

## Reporting Issues

Please open an issue on [GitHub](https://github.com/provos/ironcurtain/issues) with:

- A clear description of the problem or suggestion
- Steps to reproduce (for bugs)
- Expected vs. actual behavior

## Code of Conduct

Be respectful and constructive. This is a research project -- we're all learning.

## License

By contributing, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).

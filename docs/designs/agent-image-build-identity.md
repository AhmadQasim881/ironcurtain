# Agent image build identity and CLI version pins

**Status (2026-11-14):** Implemented (WP-100). Code: `src/docker/agent-cli-version.ts`, `src/docker/image-identity.ts`, the image-build section of `src/docker/docker-infrastructure.ts`, `src/docker/images-command.ts`, `src/workflow/container-snapshots.ts`, and `docker/Dockerfile.claude-code`, `docker/Dockerfile.codex` and `docker/Dockerfile.goose`.

## Problem

The Claude Code CLI was installed unpinned (`npm install -g @anthropic-ai/claude-code`),
and the image build hash covered only the Dockerfiles and `*.sh` files. An upgrade
without Docker changes kept a months-old CLI; one with Docker changes silently
pulled whatever CLI was current (issue #367: a minor Claude Code bump changed
subagent semantics). Images reused fixed `:latest` tags, so an installed release
and a development checkout rebuilt each other's multi-GB base on every switch.
Workflow snapshots recorded only `{image, tag}` and were resumed whenever the image
existed, so a snapshot of an old build ran its old entrypoint scripts under new
host code.

## CLI versions: pinned, qualified, overridable

- Each agent Dockerfile pins its CLI with an ARG default: `CLAUDE_CODE_VERSION`,
  `CODEX_VERSION`, `GOOSE_VERSION`. Dockerfile text is hashed, so a bump changes the
  image build hash and rebuilds the image.
- `agent-cli-version.ts` records, per agent, the build arg, the pin and the range
  qualified with this release (`minVersion`/`maxTested`); adapters expose it as
  `AgentAdapter.cliVersion`. A test ties every pin to its Dockerfile.
- Owner decision: pinned by default. `agentCliVersions` in `config.json`
  (`"claude-code"`, `"codex"`) overrides an npm-installed CLI with an exact version
  or `latest`. The value is validated (no ranges or shell metacharacters: it reaches
  the build's shell), passed as the build arg, and folded into the agent build hash,
  so changing it rebuilds the image. An override equal to the pin is the pin. With
  `latest` the hash does not move when npm publishes; `ironcurtain images rebuild`
  refreshes it. Goose installs a release binary and has no override. Manual builds
  can pass the same build arg.
- At session start, `checkAgentCliVersion` runs the adapter's `versionProbe`
  (`claude --version`, `codex --version`, `goose --version`) once per build and
  process in a throwaway `--network none` container, and logs the version; a
  version outside the qualified range is a warning naming the remedy. It never
  blocks a session. The Apple runtime has no such probe, so there the check is
  skipped (the pin still applies).

## Build tags

Every base and agent image is built under `<repository>:build-<first 16 hex of its
build hash>` with the full hash in the `ironcurtain.build-hash` label
(`image-identity.ts`). Resolution (`ensureImageBuild`):

1. A build-tagged image whose label matches is reused.
2. Otherwise an image an older IronCurtain built under `:latest` with a matching
   label is adopted (tagged, then re-checked through the new tag).
3. Otherwise the image is built under its build tag and the label is verified.
4. The moving `:latest` alias is pointed at the build (always after a rebuild).

The agent Dockerfiles take their base through `ARG IRONCURTAIN_BASE_IMAGE`, and the
build passes the exact base build tag, so a concurrent build from another checkout
cannot swap the base. Ordinary sessions create containers from the build tag
(`AgentImageResolution.imageRef`), never from `:latest`; nested-Docker resolutions
keep naming the logical image and pin an immutable ID, as before. Switching between
checkouts re-points `:latest` instead of rebuilding. A runtime without `tagImage`
keeps the old `:latest`-only behavior.

Superseded builds are not deleted automatically (another checkout may be about to
use one). `ironcurtain images prune` lists the build tags in the base and agent
repositories other than this installation's builds and the build each `:latest`
points at; `--force` removes them. This installation's builds are, per agent, the
pinned build and the one `agentCliVersions` configures, for ordinary sessions and
for nested-Docker sessions: those embed the Docker toolchain image in their base,
whose identity is part of the build hash, so prune computes them from the
toolchain image present on the engine (`findLocalDockerToolchainSource`, which
never pulls), whether or not nested Docker is enabled right now.

## Workflow snapshots

`commitContainerSnapshot` stamps `ironcurtain.build-hash` (the bundle's agent build)
and `ironcurtain.version`, and the checkpoint's `ContainerSnapshotRef` records
`agentBuildHash`, `agentSudo` (whether the bundle's agent had sudo) and
`ironcurtainVersion`. A container whose build is unknown is not
snapshotted. On resume the orchestrator never offers a snapshot without a recorded
build, and `selectResumableSnapshot` uses an offered one only when the recorded hash
equals the bundle's resolved build hash and the image, named by the immutable ID
the checkpoint records (never a tag, which could be re-pointed before the create),
still carries that label. A bundle planned with `agentSudo: false` also needs the
snapshot to record `agentSudo: false` (a missing field counts as sudo on): a
sudo-off container runs as UID 1000 alone and takes its groups from the image,
which an agent that had root in the snapshotted container could have changed.
Otherwise the scope starts from a fresh container (its workspace and dependency
layers are host mounts and carry over), the bundle reports why
(`snapshotRefusal`), and the orchestrator prints it. The comparison happens in the
bundle because only it knows the exact resolved build (nested-Docker toolchains
and CLI overrides change the hash).

`ironcurtain doctor --upgrade` predicts that decision for every resumable run
(`checkWorkflowSnapshots` in `src/doctor/upgrade-checks.ts`), applying the same
checks in the same order against the builds this installation resolves: per
agent, the pinned or `agentCliVersions` build, and its nested-Docker variant when
the toolchain image is on the engine. It lists the snapshots resume will not use
(no recorded build, not an image ID, another build, not recorded as sudo-off under
`agentSudo: false`, gone, or mislabeled), so an operator knows which scopes will
start fresh; finishing a run with the version and the `agentCliVersions` and
`agentSudo` settings that took its snapshot keeps the container.

## Operator surface

`ironcurtain images status [--agent <id>] [--probe] [--runtime <kind>]` shows the
expected base and agent builds, whether each is built, the CLI version each
installs (pinned or overridden, with the qualified range) and, with `--probe`, the
version actually baked in. `ironcurtain images rebuild [--agent <id> | --all]
[--with-base]` rebuilds without the layer cache. With nested Docker enabled, both
also cover the nested-Docker builds for the toolchain image on the engine (and say
so when it is not there yet). `ironcurtain images prune [--force]` handles
superseded builds across all agents (it refuses `--agent`).

## Limits

- The Claude Code pin (2.1.292) and its range come from the newest version this
  repository records as passing (docs/designs/zai-provider-profiles.md); the Codex
  pin from the recorded sanitizer fixtures. Each range is the single pinned version
  until another version is qualified.
- With `latest`, two images with the same build hash can carry different CLIs
  (before and after `images rebuild`); a snapshot of the earlier one is still
  resumed, since its in-container scripts match the build.
- A nested-Docker build for a Docker toolchain image no longer on the engine (an
  earlier toolchain version, or one removed by hand) counts as superseded unless
  `:latest` points at it; the next nested-Docker session pulls the toolchain and
  rebuilds.
- `images` uses the runtime's default endpoint; nested Docker on Docker Desktop
  uses the endpoint of the selected Docker context, which is the same daemon.

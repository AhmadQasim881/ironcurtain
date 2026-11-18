# Build trust runtime

This package contains the shared Linux amd64/arm64 `runc` interposer for package-mode nested Docker.
The coordinator atomically stages the architecture-selected wrapper and a schema-2 public contract,
CA certificate, CA bundle, and APT proxy configuration. It mounts that complete public generation
read-only at the top-level `/ironcurtain-build-trust` directory before releasing the agent.
No private CA key or proxy credential belongs in that directory.

The wrapper and its inputs have no executable/source SHA allowlist. Before release, the coordinator
compares the exact mounted public strings to its staging inputs, invokes the protected-input protocol,
and checks selected runc version compatibility. The wrapper checks bounded regular-file metadata,
no-follow path traversal, and effective read-only backing. `Fstatfs` ST_RDONLY on the opened file is
mandatory. Every protected regular file must also reject descriptor-bound `Fchmod` of its unchanged
mode with EROFS. This probes the same opened object and avoids pathname races, executable-text errors,
and permission errors that can precede a write-open mount check. ETXTBSY and permission-denied errors
are never accepted. Root ownership is insufficient when
agents have sudo. The generation directory itself must be mode 0755 and read-only; its mapped host UID
is not authority. A top-level mount is required because sudo can rename writable ancestors around
individual leaf mounts without SYS_ADMIN.

Real runc is always `/ironcurtain-real-runc`: Apple stages the selected image executable as a host-backed
read-only top-level leaf; Docker bakes it into the private daemon's read-only rootfs. The coordinator
owns these mount sources and the surrounding namespace/capability boundary. Mount protection must
remain effective against the admitted agent and nested-container capabilities throughout the session;
a one-time version/content probe cannot establish that boundary by itself.

The wrapper recognizes the supported embedded-BuildKit argv and OCI envelope, injects the three
read-only public files beneath `/dev/ironcurtain`, and adds `--no-new-keyring` to create/run handoffs.
No-network and host-network envelope fixtures share structural tests, without byte fingerprints.
Executor ancestors retain qualified complete owner pairs 0:0 or 65534:65534; bundle/config/rootfs checks
use descriptor-relative opens and atomic replacement. Those checks do not seal an OCI bundle against
a same-UID writer after validation. The wrapper provides build compatibility, while package proxies
and the outer network policy enforce egress.

The fixed diagnostic leaf under `/tmp` stores only one bounded reviewed failure code. Clear/read
commands and failure diagnostics are non-authoritative and cannot change admission or cleanup.

`node build.mjs --write` cross-compiles both packages, generates the common protocol/layout metadata
and records the Go release in `manifest.json`. Release packaging runs this command and fails if it
changes the committed binaries. `--check` compiles both architectures with the release
`manifest.json` records and requires the committed binaries to be byte-identical to that build, and
the protocol values to match: the build is reproducible, so a difference means a committed binary is
stale or was replaced. Both modes build in a pinned Go environment (the `go` installation found on
`PATH`, without `GOROOT`, `GOFLAGS`, a `go.env` or `go.work` file, and with Go's default `GOAMD64`,
`GOARM64`, experiments and FIPS module), so settings exported by the caller cannot change the bytes
while `go version` still names the recorded release. Another Go release may produce other bytes from
the same source, so with any other `go` `--check` fails with a toolchain mismatch. CI and release
install the recorded release (`scripts/check-go-toolchain.ts` keeps those pins in step); to move to
another release, rebuild with `--write` and update the pins in the same change. This is a build-time
reproducibility check, not an executable pin: staging checks only format and architecture. Standard
OCI descriptor hashes remain the image transport format, not a separately maintained executable pin.

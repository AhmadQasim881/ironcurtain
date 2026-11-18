# Filesystem Server Confinement (symlink-swap TOCTOU)

**Status (2026-11-14):** Implemented (WP-11): `src/trusted-process/roots-confinement.ts`.

## Problem

`@modelcontextprotocol/server-filesystem` validates a path (`fs.realpath`, then a containment check against its allowed directories) and then reopens the validated string by name: `read_text_file` calls `fs.readFile(validPath)`, `write_file` writes through `validPath`, `create_directory` runs `fs.mkdir(validPath, { recursive: true })`, and so on for every path-taking tool. Every component except the last is traversed again at use time; the `'wx'` flag and the temp-file rename protect only the last one.

In Docker Agent Mode (and in workflow shared containers) the workspace is bind-mounted read-write into the container and the agent has a shell, so a process the coordinator's call mutex never sees can rename workspace entries while calls run. Swapping a workspace directory for a symlink between the server's check and its open made the server, which ran on the host without any OS sandbox (`"sandbox": false`), read, write or create anything the host user can: `~/.ironcurtain/config.json` (server credentials), the Claude/Codex OAuth files, SSH keys, other projects, and writes to `~/.bashrc` or `~/.claude/CLAUDE.md` for persistence. The coordinator's own checks (path canonicalization, the policy engine's structural sandbox fast path) all run before the server's open, so they cannot bind it.

Impact, corrected. A successful attempt is silent: the call passes as `structural-sandbox-allow`. A mistimed attempt is not always silent. Attempts the server's own check catches, and attempts on protected paths (the IronCurtain home and the host credential stores the policy engine protects, see `src/config/credential-stores.ts`), fail with an error result or a structural deny. For other targets outside the workspace, the coordinator's pre-forward check can see the swapped state and route the call to the default `escalate-read-outside-permitted` / `escalate-write-outside-permitted` rules, a visible human prompt that blocks for up to `escalationTimeoutSeconds`; in workflows without a human the call is denied. Throughput is bounded by the execute_code → coordinator → relay path and by the call circuit breaker (identical calls), not by the race. The audit's figures (34% of direct reads, about 11% including the coordinator's checks) came from a standalone harness; through the real relay, `test/filesystem-toctou.integration.test.ts` measured 119 home-secret reads in 1,000 calls and 378 files and directories created in `$HOME` without the fix, and none with it. Builtin Code Mode is not exposed: it has no primitive that runs concurrently with a call.

## Decision

The server runs under srt (bubblewrap on Linux, Seatbelt on macOS) with a profile derived from its MCP roots, and its relay restarts it with a new profile when the roots change (owner decision, option (a)). The kernel then decides what each open reaches, so a swapped-in symlink that leads out of the roots names a path that is not there (Linux) or not permitted (macOS).

Rejected: re-checking paths on the IronCurtain side (a blind swapper still wins between the last check and the open, including `lstat`-based "no symlink" checks); a vendored server that resolves paths with `openat2(RESOLVE_BENEATH)` (needs a native helper, Linux only); running the server inside the agent container (does not fit the host relay and coordinator, and Code Mode has no container).

`mcp-servers.json` declares it with `"sandbox": { "filesystem": { "confineToRoots": true }, "network": false }`.

## The profile

`resolveSandboxConfig()` (`src/trusted-process/sandbox-integration.ts`) adds the hidden regions to the server's `denyRead`; the relay adds the roots and the program when it launches the server (`src/trusted-process/roots-confinement.ts`).

| What                                                                                                                                                  | Where it comes from          | srt entries                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------- |
| Read-containment baseline: IronCurtain home, credential stores                                                                                        | `baselineDenyRead()`         | `denyRead`                 |
| Hidden regions: `os.homedir()`, `os.tmpdir()`, `/tmp`, `/var/tmp`, `$XDG_RUNTIME_DIR`                                                                 | `confinementHiddenRegions()` | `denyRead`                 |
| Session sandbox (workspace)                                                                                                                           | always                       | `allowRead` + `allowWrite` |
| Current roots: policy `paths.within` directories, escalation-approved directories                                                                     | `confinedRootDirectories()`  | `allowRead` + `allowWrite` |
| Program: the relay's own Node.js installation, `node_modules` directories above the script, srt's package (Linux `apply-seccomp`), the shell srt runs | `resolveConfinedLaunch()`    | `allowRead`                |
| Private working directory                                                                                                                             | relay                        | `allowRead` + `allowWrite` |
| Network                                                                                                                                               | none                         | `allowedDomains: []`       |

The filesystem root is never hidden (a home directory of `/` is not hidden at all), and a program path is never re-exposed if it is a hidden region or contains one, is a per-user data directory or contains one (`~/.local/share`, `~/.local/state`, `~/.config`, `~/.cache`, the `$XDG_*_HOME` directories, `~/Library`), lies in the baseline, or is spelled with a glob character (`isSafeReadPath()`); a program that cannot be exposed does not start. An installation prefix that is not safe is narrowed to the program's `bin` directory: Node.js unpacked into `~/.local` exposes `~/.local/bin`, not the keyrings, mail and shell histories in `~/.local/share` and `~/.local/state`.

The relay locates the program itself instead of letting the shell inside the sandbox search `PATH`. `node` runs as the Node.js binary the relay itself runs on (`process.execPath`), never the `node` on `PATH`: a version manager's `node` is often a shim that cannot run confined (Volta's and mise's link `node` to one dispatcher that picks the tool by the name it was started as; asdf's and nodenv's are scripts that read version files in the hidden home directory). Any other command is resolved on `PATH`, and the command and every absolute path argument are passed in their canonical form, so a symlink in a hidden region (`~/.local/bin/node`, a `node_modules` symlink into another checkout) cannot leave the program unreachable. When the `bash` srt would run is a symlink from a hidden region (a single-user Nix profile), the relay puts the shell's real directory first on the srt process's `PATH`.

### Linux

srt builds a bubblewrap mount view: `/` read-only, a tmpfs over every hidden or denied directory, `/dev/null` over denied files, and the carve-outs bound back (roots read-write, program read-only). A path is resolved inside that namespace, so a symlink to `$HOME/...` lands in an empty tmpfs (`ENOENT`), and anything written into a tmpfs never reaches the host.

### macOS

srt generates a Seatbelt profile: `deny file-read*` for the hidden and denied paths, `allow file-read*` for the carve-outs, and an allow-list for `file-write*`. Seatbelt checks the real path of the vnode being opened, so following a symlink does not get around it. Every deny entry is also passed in its canonical spelling (`/private/tmp`, `/private/var/folders/...`). `test/roots-confinement.test.ts` evaluates the profile srt generates for the shipped entry.

### Docker Desktop and Apple `container` (virtiofs)

The workspace is shared into the container VM over virtiofs; the swap happens on the shared directory and appears on the host as an ordinary symlink. The filesystem server runs on the host under the host's profile, so the same confinement applies whatever the container runtime.

## Which roots are exposed

`confinedRootDirectories()` exposes a root only if it is an existing directory that resolves to itself (no symlink in any component) and `rootExposureRefusal()` accepts it. Refused:

- roots at or under the session sandbox: already exposed, and a separate entry for a directory the agent can rename would let it redirect what srt binds when the server restarts;
- roots in the IronCurtain home or a credential store: the baseline holds whatever the roots say;
- roots that contain the IronCurtain home or a credential store, or that contain or are a hidden region (`~` itself, `~/.config`, `/`, a temp directory);
- roots spelled with `*`, `?`, `[` or `]`: srt reads every allow entry as a pattern, so `~/Music/Album [Live]` would expose matching siblings (`~/Music/Album L`, readable on Linux, readable and writable on macOS) and not the directory itself.

The third rule is the same on both platforms but is forced by macOS: Seatbelt read denies do not restrict writes, so a write root that contains the IronCurtain home would make `~/.ironcurtain/config.json` writable, and srt re-emits a deny nested in an allowed directory after all allows, which would hide the session sandbox again. The policy roots IronCurtain ships (`~/Downloads`, `~/Documents`) are unaffected. "Credential store" means any baseline entry, so the shell startup files and a `.env` in IronCurtain's package root count too: a root that contains IronCurtain's own package directory (a directory holding a source checkout of it, say) is refused whether or not that `.env` exists. A policy area that the rule refuses (a user constitution that allows all of `~`, for example) is still a root of the server, so its own path check accepts paths there, but the profile does not expose it: such calls fail at the OS level (`ENOENT` on Linux, `EPERM` on macOS). Narrower `paths.within` directories work.

The coordinator applies the same rule before it adds a root for an approved escalation (`expandApprovedRoots()` in `tool-call-pipeline.ts`): when the server is confined and a needed root cannot be exposed, the approved call is denied with rule `root-not-exposable` and a reason naming the directory, and no root is added. Approving a file directly in the home directory (whose root would be `~`) is therefore refused for the filesystem server.

## Dynamic roots: restart

Roots are added at runtime (approved escalations), and neither bubblewrap nor Seatbelt can widen a running process. On `notifications/roots/list_changed` the relay fetches the new list, computes the directories to expose and hands them to `ConfinedBackendSupervisor`:

- unchanged set: the server is notified and re-reads its roots, as before;
- changed set: the relay writes new srt settings, starts a new srt process and server, connects a client, swaps it into its client map and closes the old server. The new server's command-line directory is the canonical workspace, so its allowed directories are always a subset of the approved set while it starts;
- tool calls that arrive during a restart wait for it, so they reach the server whose profile matches the roots; restarts of one server are serialized and each uses the newest set;
- a restart that fails stops the server (it is removed and closed): it is never left running under a profile that does not match what was approved. The coordinator's roots verification then fails and drops the connection.

The coordinator's verification (`verifyBackendRoots`) polls the restarted server's `list_allowed_directories` and gives a confined server `CONFINED_ROOTS_VERIFY_TIMEOUT_MS` (30 s) instead of the ordinary 5 s.

## Availability

The filesystem server now asks for an OS sandbox, so `sandboxPolicy` applies to it like to git (see [execution-containment.md](execution-containment.md#availability-policy-sandboxpolicy)):

- `"enforce"` (default on Linux and macOS) with bubblewrap, socat or ripgrep missing: the server is refused, its tools are unavailable, and the session notice names it;
- `"warn"`: it runs unconfined, as before this change, and the notice lists it among the servers running without OS containment;
- srt installed but unable to start a sandbox (for example a host that forbids the user namespaces bubblewrap needs): session start finds out with one srt test run per process and treats the sandbox as unavailable, so the two cases above apply, and the notice names the srt failure; `ironcurtain doctor` reports it too.

## Residual risk

- The confinement is per root set. A swap can still redirect a call between the server's roots: from the workspace into `~/Downloads`, or into `~/Documents`, which the default policy lets the agent read but not write without approval.
- Files outside the hidden regions that the host user can read stay readable: system files, other mounts (`/mnt`, `/media`, site-specific data directories), world-readable files in other users' homes. Nothing outside the roots is writable, except srt's own scratch directory `/tmp/claude`, which srt keeps writable for every sandboxed process (and, on Linux, readable).
- On macOS srt allows reading directory metadata everywhere (realpath needs it), so `get_file_info` on a swapped directory can still return its size and timestamps.
- A swap that keeps the target inside a root is indistinguishable from a legitimate call; only narrower roots help there.

Possible follow-ups: a Linux mount view that hides `/` and exposes only the runtime and the roots; read-only roots for policy areas that are only readable; per-file exposure for approvals of a single file in a broad directory.

## Testing

- `test/filesystem-toctou.integration.test.ts`: the relay with the shipped entry under real bubblewrap while a separate process swaps `<workspace>/a` for a symlink to `$HOME`; 1,000 `read_text_file`, `list_directory`, `write_file` and `create_directory` calls each (`FS_TOCTOU_CALLS` raises it) must never return the home's content or listing, or create anything in it; `~/Downloads` and a root added after approval (with a restart) keep working. Gated on Linux with a working srt, like `test/sandbox-integration.test.ts`.
- `test/roots-confinement.test.ts`: hidden regions, root selection and refusal, launch resolution, profile composition, the restart supervisor, and the macOS Seatbelt profile srt generates for the shipped entry (read and write decisions).
- `test/roots-toctou.test.ts`: the coordinator refuses roots a confined server cannot be given and allows its restart the longer verification timeout.
- `test/sandbox-policy.test.ts`: the filesystem server under `"enforce"` and `"warn"` without srt.

# Dependency hygiene and native-module installs

**Status (2026-11-14):** Implemented (WP-104; audit findings BLD-9 and BLD-10).

IronCurtain ships no lockfile: `npm install -g @provos/ironcurtain` resolves
every caret range at install time, and the web UI is frozen into
`dist/web-ui-static` when a release is built. The repository lockfile still
decides what developers and CI test, what the web UI bundle contains, and
which exact `@anthropic-ai/sandbox-runtime` users get. This document covers
the checks that keep it current and how native modules are installed.

## npm audit gate

`scripts/check-npm-audit.ts` (`npm run check:audit`) runs
`npm audit --omit=dev --audit-level=high --json` over the production tree,
workspaces included, and fails on any high or critical advisory that the
reviewed allowlist `.github/npm-audit-allowlist.json` does not accept. It runs:

- on every pull request and push (`dependency-audit` in `ci.yml`);
- weekly (`dependencies` in `scheduled-checks.yml`), because advisories are
  published without any commit;
- in the release `build` job, so no release ships an advisory nobody reviewed.

An allowlist entry names one package, maps the accepted GHSA ids to the
severity they were reviewed at, gives the reason they cannot be exploited
here, and carries `reviewed` and `expires` dates. The gate:

- accepts an advisory only in the package the entry names;
- refuses it again when its severity rises above the reviewed one;
- refuses it after `expires` (UTC), which is at most 180 days after
  `reviewed`, so an accepted advisory with an available fix gets merged rather
  than accepted indefinitely;
- reports entries whose advisory is no longer present as stale (a warning:
  the Dependabot pull request that fixes an advisory cannot edit the file);
- fails closed on a report it cannot read (npm could not reach the registry,
  an unknown report format) and on an advisory without a GHSA id;
- lists moderate and lower advisories without failing.

When the gate fails on a new advisory: merge the fix if one is in range
(Dependabot's security update), or trace the vulnerable code from IronCurtain's
entry points and add an entry whose reason says why it is unreachable, or what
is reachable and why that is acceptable until the fix lands (the `undici`
entry is an example). Keep entries for fixable advisories short-lived.

The first allowlist (2026-11-14) was reviewed against the audit of that lockfile:
42 high or critical advisories, all with a fix in range except the two zod 3
copies under `@utcp/sdk` and `@anthropic-ai/sandbox-runtime`. Two `undici`
advisories are reachable since the fetch server moved to undici's own `fetch`
(a malicious server can crash the fetch MCP server process); merge that update
first.

## Dependabot and merge cadence

`.github/dependabot.yml` keeps the weekly version-update groups and adds two
groups for security updates, which Dependabot opens as soon as an advisory
affects the lockfile:

- `web-ui-security`: the web UI's runtime dependencies (and the Svelte
  runtime). They are bundled at build time, so a merged update reaches users
  only with a release: cut a patch release after merging one.
  `test/dependency-hygiene.test.ts` keeps the group in step with
  `packages/web-ui/package.json`.
- `security`: everything else, except the pinned MCP servers, whose security
  bumps stay separate pull requests with the annotation checklist.

Cadence: merge security updates within 7 days, critical ones the same week.
The audit gate enforces the outer bound through the allowlist's expiry dates.

## sandbox-runtime

`@anthropic-ai/sandbox-runtime` is the OS sandbox around MCP servers. Its range
matches exactly one version (`^0.0.x` does; `test/dependency-hygiene.test.ts`
refuses a wider range), so users get its fixes only through an IronCurtain
release that bumps it. The weekly `dependencies` job fails while the lockfile's
version is behind the newest release, and the release build warns. Release
checklist: bump it to the newest version, run the sandbox tests
(`test/sandbox-integration.test.ts` and the OS-sandbox integration suites),
then tag.

## Install scripts

npm 11 runs dependency install scripts that no `allowScripts` entry covers,
with a notice; `--strict-allow-scripts` turns the notice into an error, and
the policy is meant to become deny-by-default. The root `package.json` decides
every install script in the development tree by bare package name (versioned
entries would change with every bump):

| Package            | Decision | Why                                                                                                             |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------- |
| `isolated-vm`      | allow    | The V8 sandbox. Prebuilt for linux-x64/arm64, darwin-arm64 and win32-x64; compiled elsewhere (Intel Macs).      |
| `node-pty`         | allow    | mux, the web UI terminal and Apple Container sessions. 1.1.0 has no Linux prebuild, so it is compiled on Linux. |
| `onnxruntime-node` | deny     | Its postinstall downloads the CUDA providers (273 MB, from NuGet); the CPU runtime ships in the package.        |
| `protobufjs`       | deny     | Its postinstall only warns about the root package's version scheme.                                             |
| `esbuild`          | deny     | Verifies or downloads the platform binary, which npm installs from the lockfile as an optional dependency.      |
| `fsevents`         | deny     | macOS-only, development-only file watching; the package ships its addon.                                        |

`test/dependency-hygiene.test.ts` fails when an installed package has an
install script without a decision, so a new one is reviewed when it arrives.

npm reads `allowScripts` only for project installs: a global install
(`npm i -g`) and `npx` ignore it. End users need the build tools wherever a
prebuild is missing (Linux: python3, make and g++ for node-pty; Intel macOS:
the Xcode Command Line Tools for isolated-vm). Under an npm configuration
that blocks unreviewed scripts they pass
`--allow-scripts=isolated-vm,node-pty`; under `--strict-allow-scripts` every
package with an install script must be listed, so installing with
`--ignore-scripts` and rebuilding node-pty afterwards is simpler. Strict mode
set in an npmrc applies to that rebuild too, and a rebuild's strict check
covers every package in the global tree, not only node-pty: it needs
`--strict-allow-scripts=false`.

## Missing node-pty

node-pty is an optional dependency: `ironcurtain start` works without it, but
mux, the web UI terminal and Apple Container interactive sessions do not.

- `ironcurtain mux --help` (and argument errors) are answered before node-pty
  is loaded.
- `src/pty/node-pty-loader.ts` holds the one remediation text, used by mux,
  `loadNodePty` (Apple Container, web UI terminal) and doctor. It depends on
  what npm left on disk:
  - Missing (`Cannot find package`): npm deletes an optional dependency whose
    install script failed, so a host without build tools ends up without
    node-pty at all, and `npm rebuild node-pty` would match nothing while
    reporting success. Install the build tools, then reinstall:
    `npm install -g @provos/ironcurtain --allow-scripts=isolated-vm,node-pty`
    (an explicit install replaces the package and installs its missing
    optional dependencies), or `npm install` in a checkout.
  - Installed but not loadable (npm skipped its install script, or the build
    is broken): a reinstall keeps the unbuilt copy, so install the build tools
    and run
    `npm rebuild -g node-pty --allow-scripts=node-pty --ignore-scripts=false`,
    or `npm rebuild node-pty --ignore-scripts=false` in a checkout.
    `--ignore-scripts=false` matters when an npmrc sets `ignore-scripts=true`:
    the rebuild would otherwise do nothing and still report success.

  Never `npm install node-pty` (a global install resolves modules from its own
  package directory) and never `npm rebuild -g @provos/ironcurtain`, which runs
  only IronCurtain's own scripts, not its dependencies'.
- `ironcurtain doctor` loads node-pty and reports it (`node-pty` in the
  Environment section): a warning with the matching remediation when it is
  not installed or cannot load, and a warning when the macOS spawn-helper lacks
  its execute bit, which doctor reports but, being read-only, does not repair.

### Linux prebuilds: evaluation

node-pty 1.1.0 (the latest stable release) ships prebuilds for darwin and
win32 only. Options, none adopted yet:

- `@lydell/node-pty`: the same API with per-platform prebuilt packages
  (linux-x64/arm64 included) as optional dependencies, so no compiler and no
  install script. It tracks the 1.2.0 beta line and is a third-party
  repackaging, which is new supply-chain trust for a module that spawns every
  session process. Candidate once it is checked against the PTY suites and
  its build provenance is reviewed.
- Vendoring N-API prebuilds of microsoft/node-pty (built in CI, shipped in the
  package and loaded through node-pty's `prebuilds/<platform>-<arch>` lookup):
  no new publisher, but IronCurtain would own a native build matrix and its
  provenance.
- Waiting for an upstream release with Linux prebuilds: no work, but the
  toolchain requirement stays until then.

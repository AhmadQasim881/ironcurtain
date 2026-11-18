# Design: Tool-Annotation Overlay

**Status (2026-11-14):** Implemented (`src/config/tool-annotations-overlay.ts`).

**Date:** 2026-11-07

## 1. Problem

Tool annotations (`tool-annotations.json`) assign a role to every tool argument, and the policy engine derives all of its path, URL and protected-path decisions from those roles. They are TCB data. IronCurtain ships reviewed annotations in `src/config/generated/` (the _package_ file).

Before this change, `annotate-tools` wrote `~/.ironcurtain/generated/tool-annotations.json` as a full snapshot: in single-server mode it copied every other server's package entry into the file. `loadConfig()` then picked the user file over the package file wholesale, so after one run no later package fix to any server's annotations reached that user, not even after `annotate-tools --all`. The annotate cache compared only `inputHash` (server name, tools/list output and prompt), and hand fixes to roles keep `inputHash` unchanged, so a refresh kept the stale copy.

## 2. File format

Both files keep the existing shape. Each server entry gains optional provenance fields (`StoredServerAnnotations` in `src/pipeline/types.ts`):

| Field               | Package file                                                    | User overlay                                         |
| ------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| `inputHash`         | as before                                                       | as before                                            |
| `contentDigest`     | sha256 of the canonical JSON of `tools`                         | same, written by `annotate-tools`                    |
| `source`            | `"package"`                                                     | `"user"` (absent on legacy entries)                  |
| `producerVersion`   | release that first shipped the entry                            | version of the `annotate-tools` run                  |
| `supersededDigests` | `contentDigest`s of earlier shipped revisions                   | not used                                             |
| `pinned`            | not used                                                        | `true` keeps the entry over a reviewed package entry |
| `serverInfo`        | `{name, version}` the annotated server reported at `initialize` | same, refreshed by every `annotate-tools` run        |

Each tool annotation may also carry `annotationKey`: the sha256 of the tool's name, description and input schema as the server listed them, plus the server's annotation prompt and role-registry version (`computeToolAnnotationKey` in `src/pipeline/tool-annotator.ts`). Only `annotate-tools` reads it (section 5); loaders and the policy engine ignore it. Entries written before it existed have none.

`contentDigest` identifies a revision of the content independently of key order and formatting. Unlike `inputHash` it changes with hand edits. The canonical JSON is `canonicalJson` in `src/policy-artifacts/canonical-json.ts` (the drift check in section 8 hashes tool input schemas with it too). Compiled policies record the same digest of the effective annotations of every server their rules reference (`provenance.annotationDigests`), and loaders flag a policy compiled against other annotations than those in effect as stale (see the "Policy Provenance" section of [per-server-policy-compilation.md](per-server-policy-compilation.md)). `serverInfo` is informational: drift reports name the release an entry was written for, but drift itself is detected by comparing schemas (section 8), never versions. It is absent for servers that report no identity, for entries written before it was recorded, and for IronCurtain's own fetch server (which reports IronCurtain's version).

## 3. Resolution (every loader)

The user file is an overlay: it holds only servers the user re-annotated. `src/config/tool-annotations-overlay.ts` (a runtime leaf) resolves it per server against the package file. The runtime loader (`loadGeneratedPolicy`, used by sessions, the sandbox coordinator, the proxy subprocess and doctor) and the pipeline loaders (`loadToolAnnotationsFile`, `loadStoredToolAnnotationsFile`, compile-policy, persona and job compilation, the customizers) all call `loadToolAnnotations(dir, packageDir)`. When `dir` differs from `packageDir`, the file in `dir` is layered over the package file:

1. no overlay entry: package entry;
2. no package entry: overlay entry (`user-only`, e.g. a custom server);
3. same content as the package entry: package entry (`identical`);
4. overlay entry pinned: overlay entry (`pinned`, warns);
5. content equals an earlier shipped revision: package entry (`superseded`);
6. same `inputHash` as the package entry: package entry (`same-input`, notes that the user's entry is ignored);
7. otherwise (annotated for other tool schemas): overlay entry (`user`; warns when the entry is legacy).

Servers absent from the overlay always come from the package, so an overlay listing one server never drops the others. A damaged or malformed annotations file throws `ToolAnnotationsFileError` (`code: 'TOOL_ANNOTATIONS_INVALID'`); policy loading fails closed instead of silently switching annotations. Both files are read like `compiled-policy.json` (`readPolicyArtifact` in `src/config/policy-artifact-read.ts`): a symlink at the file's name, anything but a regular file, a file owned by someone other than root, the current user, the package owner or the owner of the IronCurtain home, and a file another local user can write (group write only for the owner's private group) are refused with the same error, the last naming the `chmod` that fixes it. A file is missing only when nothing is at its name: a dangling symlink is refused, never treated as an absent overlay that lets the package file apply (`loadConfig` picks the user directory for it too). "Malformed" is decided by the runtime schema in `src/types/policy-schema.ts`, which checks every server entry and every tool annotation down to each argument's roles (registered roles only; conditional blocks with exactly one operator on another argument of the same tool; no tool annotated twice). The error lists each offending field (`servers.git.tools[3].args.path[0]: ...`). The loader returns the file exactly as it is on disk, so content digests and overlay rewrites are unaffected. `damagedToolAnnotationsFile` tells the two files apart for the hints in `doctor` and `annotate-tools`: a damaged overlay is removed with `annotate-tools --reset`, while a damaged shipped file needs a reinstall.

`warnOnAnnotationOverlay` prints the warnings where the annotation freshness checks run (`ironcurtain start`, `TrustedProcess`) and in `compile-policy`; `annotate-tools` prints them after each run. `doctor` reports them as the "Annotation overlay" check, listing the servers whose effective annotations diverge from the shipped ones.

## 4. Migration of legacy snapshots

Rules 3, 5 and 6 are also the migration: a legacy snapshot's copies of current or earlier package content, and its entries for the same tools as a reviewed package entry, give way to the package as soon as the new loader reads them. Genuinely divergent entries (rule 7) keep applying, with a warning. The on-disk rewrite happens on the next `annotate-tools` run of any kind (`migrateOverlay` in `src/pipeline/annotation-overlay.ts`): dropped entries are removed, kept entries are stamped `source: "user"`, and the legacy file is first copied to `tool-annotations.pre-overlay.json` (once, never overwritten). Loaders never write.

The bundled file was stamped once from its git history: every server carries the digests of all its earlier revisions, so a snapshot taken at any earlier version is recognised as a copy.

## 5. `annotate-tools`

For each connected server, with live hash `H`:

- the package entry's `inputHash` is `H` and the user has not pinned the server: adopt the reviewed package entry (no LLM call; any overlay entry for the server is removed);
- the overlay entry's `inputHash` is `H`: keep it (cached);
- otherwise: annotate with the LLM and store a stamped user entry. Tools whose `annotationKey` matches an annotation in the package entry or the user's entry (the package's first, the user's first when that entry is pinned) keep that annotation's roles and comment (the input schema recorded is the live one, which the key says is the same), if it still passes the annotator's response schema; only new and changed tools go to the LLM, at temperature 0, so the entry differs from what was in effect only where the server changed. The server's behaviour hints (`mcpHints`, which the policy lint reads, tighten-only) are not part of the key, since the LLM never sees them: every annotation written, reused or new, carries the hints of the live listing, so a server that starts marking an unchanged tool destructive is linted accordingly.

The LLM is created on first use, so a run that only adopts package entries, keeps cached ones, or keeps every tool's previous annotation (a tool removed, the list reordered) needs no model credentials.

A server whose annotation fails (an LLM or network error, schema repairs exhausted, tools left unannotated, output truncated even under the larger retry cap) is recorded as failed and keeps what was in effect for it: its user entry, or else the package entry. A failed `--pin` run pins nothing: the pin it would have put on the server's earlier user entry is taken back, so an entry the loaders ignored for the reviewed package entry does not start to override it. Tools and arguments added or changed since that entry was written stay unannotated, so the pipeline denies calls that use them. The other servers are still annotated, the overlay is written after every server (a later failure or an interrupted run keeps the results already made), and the run lists the failed servers and exits 1. A legacy file is backed up before its first rewrite. The step is `annotateServers` in `annotate.ts`, which `ironcurtain mcp add` shares: it returns the failed servers (`failed`), and `mcp add` stops when the server it added is one of them.

- `--diff` prints, per live server, the tools whose roles (or comment) differ between the annotations in effect before and after the run: added and removed tools, and per changed tool each argument's roles before and after (`src/pipeline/annotation-diff.ts`). Names and comments are rendered display-safe.

- `--pin` (with `--server`) skips the package adoption for that server and marks its entry pinned; an existing entry for the live tools is kept, otherwise the LLM annotates it (and only a successful annotation is pinned).
- `--reset [--server <name>]` removes the user's entries for one server, or the whole overlay, without connecting to MCP servers or calling the LLM. A full reset also removes a damaged file, a symlink at the overlay's name included (the link, never its target).
- `--check [--server <name>]` connects to the servers and compares the effective annotations (the package file with the overlay layered) with their live tools (section 8), without the LLM. It exits 1 when any reached server drifted or has no annotations, or when the requested server could not be started; servers it cannot start are listed as not checked.
- An overlay left with no servers is deleted, so the package annotations apply unchanged.

## 6. Maintaining the package file

`scripts/stamp-package-annotations.ts` re-stamps the bundled file after a hand edit, and with `--from <overlay> --server <name>` promotes a reviewed overlay entry into it. `stampPackageAnnotations` moves the replaced revision's `contentDigest` into `supersededDigests`, which is what lets users' stale copies of it resolve to the new entry. Copying an overlay over the package file would drop every server the overlay does not list and the whole `supersededDigests` history, so `stampPackageAnnotations` refuses entries stamped `source: "user"`.

`test/annotations-overlay.test.ts` fails when a package entry's `contentDigest` does not match its tools, and when the bundled file stops recognising (as current or superseded) any revision shipped before overlays existed: that history may only grow.

## 7. Out of scope

- Choosing between entries by the live tools/list schema at runtime. The policy engine is built before the coordinator lists tools, so the runtime cannot tell which entry matches the live server; only `annotate-tools` chooses entries against the live tools. Drift is detected (section 8) and fails closed per call: the tool-call pipeline denies any call carrying an argument the effective annotation does not classify (rule `unannotated-arguments`).

## 8. Live-schema drift detection

Every entry stores each tool's input schema as the server listed it when the entry was written. `src/trusted-process/schema-drift.ts` (a runtime leaf, no pipeline values) compares a stored entry with a live `tools/list` result:

- tools the server lists without an annotation (denied, `missing-annotation`) and annotated tools it no longer lists;
- per tool: live arguments without an `args` entry (`unannotatedArgs`, the main signal: policy cannot see them and the pipeline denies calls that carry them), annotated arguments the server no longer declares (`removedArgs`), conditional roles keyed on an argument the server no longer has or on a value outside its live enum (`brokenDiscriminators`; such roles always fall back to their default), enum changes on any argument, changes of `required`, and whether the canonical-JSON sha256 of the schema changed. The annotator's `inputHash` is not used: it also covers descriptions of other tools and the prompt text.

Drift "affects policy" when it involves an unannotated tool or argument, a removed argument, a dead condition or an enum change; changed schema text, `required` and stale annotations do not.

Where it runs:

- **Sessions.** `ToolCallCoordinator.registerTools` diffs every non-trusted server with an annotations entry as it registers, keeps the result (`getSchemaDrift()`), and writes the full report to the session log (warning level when it affects policy, information otherwise). Nothing is written to the terminal from the kernel. Sessions turn policy-affecting drift into an `annotation_drift` diagnostic (`session/annotation-drift-diagnostics.ts`): the CLI prints it after the start-up spinner and lists it under `/logs`, the web transport emits `session.diagnostic` once the session has a label and the web UI shows it in the session view, a Signal session sends it once after announcing itself, a cron run keeps it in its run record, and PTY sessions (mux and the web UI terminal) print it before attaching to the agent.
- **`doctor`.** The liveness probe returns each server's tools and identity; drift that affects policy turns the server's line into a warning naming the releases and the `annotate-tools` command.
- **`annotate-tools --check`** (section 5) and **`compile-policy`**, which warns about drifted servers before compiling (the policy is compiled from the stored annotations) and validates generated scenarios against the live schemas of the servers it reached (`liveToolSchemas`), falling back to the stored schemas for the rest; the verifier judge's probes and the scenarios the repair loop and the commit replay re-run are checked the same way. With `--no-mcp` it says that drift was not checked.
- **Tests.** `test/annotation-drift.integration.test.ts` spawns the locally installed git, filesystem and fetch servers and fails on any drift or `inputHash` mismatch, so a dependency bump cannot ship stale annotations again.

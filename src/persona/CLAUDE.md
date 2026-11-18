# Persona module (`src/persona/`)

Named profiles bundling a constitution + compiled policy under
`~/.ironcurtain/personas/<name>/`. The headless `persona-service.ts` owns all
filesystem effects for persona CRUD; the CLI (`persona-command.ts`) and the WS
dispatch (`web-ui/dispatch/persona-dispatch.ts`) both call it so behavior never
drifts between surfaces. `persona.json` is read only through
`persona-definition.ts`, which refuses (never coerces) a malformed file,
unknown fields, or a `name` that differs from the directory name
(`PERSONA_INVALID`); every path operation uses the directory name.

## Layering

Runtime value-imports from `src/pipeline` are confined to the two sanctioned
persona pipeline modules; every other persona module uses only
`import type { ... } from '../pipeline/types.js'` (the compiled-policy /
annotation shapes) or other type-only imports.

- `compile-persona-policy.ts` is the compile seam. Its only runtime caller is
  `runPersonaCompile` in `persona-compile-service.ts`, which reaches it
  EXCLUSIVELY via `await import('./compile-persona-policy.js')`. The CLI
  (`persona-command.ts`) and the web UI (`persona-compile-orchestrator.ts`)
  both compile through `runPersonaCompile`.
- `persona-customizer.ts` value-imports `pipeline/constitution-customizer` and
  `pipeline/customizer-loop`: it IS the customize-policy flow, the pipeline
  invocation the root CLAUDE.md layering exception allows. Likewise the CLI's
  dynamic import of `cron/constitution-generator.ts`.

Enforced by `test/pipeline-import-boundary.test.ts` + the ESLint
`no-restricted-imports` rule, which cover every persona module except those two,
and by `test/persona-compile-paths.test.ts` (every compile goes through
`runPersonaCompile`).

## Phase 1c policy-mutation safety (`docs/designs/web-ui-policy-persona-management.md` §7)

- **Kill switch.** Persona mutations over the web UI are gated behind the daemon
  `--allow-policy-mutation` flag (default OFF, CLI-only, not config-persisted).
  When off, every mutation method returns `POLICY_MUTATION_FORBIDDEN`; read
  methods stay ungated. Surfaced to the UI via
  `DaemonStatusDto.allowPolicyMutation`.

- **One compile path** (`persona-compile-service.ts`, `runPersonaCompile`).
  Holds the persona's cross-process compile lock (`generated/.compile.lock`),
  caps a compile at 20 minutes, passes the broad-policy validator as the
  pipeline's `validateCompiled` hook on every compile (CLI and web UI), and
  appends one audit record per compile (written, rejected as too broad, or
  failed). `persona.allowBroadPolicy` also drives the pipeline lint's
  broad-domain opt-in; a broad-domain directive in a persona constitution is
  ignored.

- **Broad-policy validator** (`broad-policy-validator.ts`). LLM-independent: it
  inspects the COMPILED rules (not the constitution text), so it defeats
  constitution prompt-injection. Unless the persona opted in, an `allow` rule
  (or `assess`, an allow subject to the outbound content assessment) is
  rejected when it has a broad wildcard in `domains.allowed` / `lists[].allowed`
  (also through a resolved `@list`; breadth is judged with the Public Suffix
  List, both its ICANN and private sections, plus curated multi-tenant cloud
  domains, `isBroadDomainPattern` in `src/types/public-suffix.ts`, so `*`,
  `*.`, `*.com`, `*.co.uk`, `*.github.io` and `*.amazonaws.com` are broad while
  `*.github.com` is not), a `paths.within` resolving outside the persona's
  workspace dir, or an unconstrained resource argument: using the stored tool
  annotations, every URL, path, identifier and email-address role the rule can
  discharge must be bounded (URL roles by a `domains` condition, path roles by
  `paths.within`, identifier and email-address roles by a `lists` condition).
  Without annotations it fails closed. `escalate` rules are never rejected;
  their breadth is reported as `ruleDelta.escalateBreadth`. Rejection ->
  `BROAD_POLICY_REJECTED` terminal `persona.compile.failed` event. The same
  findings judge a policy already on disk (`policy-breadth-check.ts`):
  `resolvePersona` refuses a broad policy without the opt-in
  (`POLICY_TOO_BROAD`), and an opt-out moves it to
  `generated/compiled-policy.revoked.json`.
- **Opt-in.** Set ONLY by `setPersonaBroadPolicyOptIn` (the gated
  `personas.setBroadPolicyOptIn`, `ironcurtain persona compile --allow-broad`,
  or the `persona edit` toggle); only `true` counts, and it is NEVER inferred
  from the constitution.

- **Stale policies fail closed.** `getPersonaPolicyState` reports whether the
  compiled policy is missing, stale (no longer matches `constitution.md`) or
  fresh, recomputed from disk on every call with the leaf helper
  `src/config/constitution-hash.ts`; `resolvePersona` refuses a missing or
  stale one (`ScopedPolicyError` with `POLICY_MISSING` / `POLICY_STALE`). Only
  the CLI's `start --allow-stale-policy` sets `allowStalePolicy`.

- **Overrides** (`persona-overrides.ts`). `agentModelId` and `resourceBudget` in
  persona.json (written by `setPersonaOverrides`) are validated when they take
  effect (`readPersonaOverrides`); a malformed value refuses the session
  (`PERSONA_OVERRIDES_INVALID`) instead of falling back to the global model or
  limits. Precedence lives in `src/session/model-budget-precedence.ts`.

- **Soft delete and trash.** `deletePersona` defaults to SOFT: it renames the
  persona dir into `~/.ironcurtain/.persona-trash/<name>-<ts>/`, which is
  OUTSIDE `getPersonasDir()`, so `scanPersonas` / `resolvePersona` (which only
  scan `personas/`) never list or resolve a tombstone. `force: true`
  hard-removes (revokes the policy). The CLI passes `force: true` to keep its
  existing "permanently delete" contract; its trash is managed with
  `ironcurtain persona trash list|restore|purge`. `persona-trash.ts` names,
  parses and lists trash entries; every change (soft delete, restore, purge,
  the retention sweep) lives in `persona-service.ts`. Entries expire after
  `personas.trashRetentionDays` (default 30, `null` keeps them): callers run
  the retention sweep (`sweepPersonaTrash`) after every move into the trash (a
  soft delete, a forced restore). A purge first renames an entry to
  `.purging-*`. Delete, rename and a forced restore hold the persona's compile
  lock.

### Audit log (`policy-mutation-audit.ts`) — honest scope

Every mutating persona-service fn (`createPersona`, `setPersonaConstitution`,
`setPersonaMemory`, `deletePersona`, `setPersonaBroadPolicyOptIn`,
`setPersonaOverrides`, `clonePersona`, `renamePersona`, `restorePersona`,
`purgePersonaTrash`) and the shared compile path append a record to
`~/.ironcurtain/audit/policy-mutation.jsonl` (mode 0600; at ~10 MB it rotates
to `.1`, older files move up to `.3` and the oldest is dropped). Records carry
a monotonic `seq`, the `prevHash` of the record before and their own SHA-256
`hash`; the chain head is persisted in `policy-mutation.head.json`, and appends
from every process are serialized by `policy-mutation.lock` (created with
O_EXCL; a lock whose holder is dead or that is older than `STALE_LOCK_MS`,
30 s, is reclaimed).
`ironcurtain audit verify` (`verifyPolicyMutationLog`) re-hashes every record
across the rotated files and checks the head, so it reports edited, removed or
reordered records and truncation. Compile records carry `outcome`, `errorCode`,
`policyRevoked` and whether the policy `broadened` (`@lists` included).
Appends are best effort: `PolicyMutationAuditLog.append` returns `undefined`
instead of throwing when the lock stays busy or a write fails, so a mutation
is never blocked by its audit record, and the log can miss one.

**What it detects:** accidental corruption, and an edit, removal, reordering or
truncation by anyone who does not also rebuild the whole chain and its head.
Once the log has rotated, records removed from its oldest end (older rotated
files, or the first lines of the oldest rotated file kept) look like rotation:
`audit verify` only notes the seq the retained chain starts at.

**What it does NOT defend:** the chain is keyless. A local user who can write
`~/.ironcurtain` can recompute a consistent chain and head, or write persona
policy files directly, bypassing the service layer entirely. The audit log is
tamper-EVIDENT against careless edits, not tamper-PROOF, and is not a substitute
for OS-level file permissions on `~/.ironcurtain`. Records from releases that
HMAC'd the chain with a per-process secret count as legacy records.

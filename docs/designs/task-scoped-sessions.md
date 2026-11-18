# Task-scoped sessions (`--task-scoped`)

**Status (2026-11-14):** Implemented for `ironcurtain start` (including `--pty`), mux `/new` and `ironcurtain workflow start`. Opt-in only: no session, cron job or workflow is ever task-scoped by default.

## Problem

A session's policy is the global constitution, a persona's or a cron job's.
It says what an agent may do in general, not what the current task needs, so
a prompt-injected or drifting agent in an interactive or one-shot session can
use every capability the broad policy grants. Cron jobs already compile a
policy from the job (`compileTaskPolicy`), but that policy _replaces_ the
global one, and nothing comparable existed for `start`, mux or workflows.

## What a task scope is

A task scope is a policy compiled from the session's task text with the
strict task-policy compiler prompt (the minimum tools, paths and domains the
task needs). The policy engine **intersects** it with the session policy
instead of replacing it:

| Session policy | Task scope                   | Result                                                                          |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| deny           | anything                     | deny (the task scope is not consulted)                                          |
| allow          | allow                        | allow (the session policy's rule is named)                                      |
| allow          | no task rule covers it       | **escalate**, rule `task-scope-escalate`                                        |
| allow          | a task rule escalates        | escalate under that task rule                                                   |
| escalate       | allow                        | the session policy's escalation, unchanged                                      |
| escalate       | escalate / not covered       | one escalation: the session policy's rule, the reason notes the task scope      |
| allow/escalate | an explicit task `deny` rule | deny (most restrictive wins; the compiler itself only emits allow and escalate) |

A task scope therefore can never allow a call the session policy does not.
An out-of-scope call escalates rather than being denied because the session
policy did allow it: a human (or the auto-approver, when enabled, judging
the user's message) may still approve it.

Evaluation details (`PolicyEngine.evaluateTaskScope`):

- The structural invariants run once, before either policy: protected paths,
  forbidden destinations, unknown tools and the introspection allow are
  final, and trusted servers (memory) skip both policies: their own
  per-tool policy (`trusted-server-policy.ts`) alone decides their calls.
- The task rules are evaluated per role, over the same roles as the session
  policy. Roles sandbox containment resolved stay allowed: the session's own
  directory is always in scope.
- The escalation names every role the task scope did not allow
  (`escalatedRoles`), joined with the session policy's, so an `/approve+`
  whitelist pattern must cover all of them, and approved paths become roots
  only for those roles. A tool without resource roles escalates with its
  roles unknown (the most restrictive behaviour for every consumer).
- The structural escalations (domain gate, `.git` writes, untrusted
  repositories) are combined after the intersection, as without a scope.
- The coordinator prepends the virtual proxy rules to the task scope, as it
  does to every session policy, so `list_proxy_domains` and
  `remove_proxy_domain` keep their decisions and `add_proxy_domain` stays a
  human-only escalation.
- A workflow agent state's coordinator offers the virtual `workflow_commit`
  tool (see [workflow-abort-handoff.md](./workflow-abort-handoff.md)); it
  prepends that tool's allow rule (`workflow-commit-allow`) to the task scope
  as well, as it does to every session policy. A task compile never yields
  `workflow` rules, so without it every state of a task-scoped workflow would
  escalate its commit as outside the task scope.
- With policy-evaluated MITM egress on (`egressPolicy`, see
  [mitm-egress-policy.md](./mitm-egress-policy.md)), the coordinator also
  appends the `network` egress rules to the task scope, as it does to every
  session policy: hosts in `egressPolicy.allowedHosts` stay admitted and
  every other destination stays a human-only escalation. A task compile never
  yields `network` rules, so a destination only the session policy's own
  `network` rules admit is outside the task scope and escalates.
- The task scope's rule directories (`paths.within`) are canonicalized once,
  when the engine is built, like the session policy's: a symlink re-pointed
  at one later does not move the scope. Its `@list` references expand
  against the scope's own lists only, and always: without a lists file a
  `@list` entry allows nothing (an argument spelled like the reference does
  not match it).
- A human approval of an escalation the task scope raised
  (`task-scope-escalate`, or one of the task policy's own rules) is not
  recorded in the approval history that proposes constitution amendments
  (`approval-whitelisting.md` §7.7): the session policy allowed that call, so
  the approval says nothing about its constitution. An escalation under a
  session-policy rule is recorded as in any session.

## Compiling a scope

`compileTaskScopePolicy()` (`src/cron/compile-task-policy.ts`) is called by
the CLI entry points only (`src/index.ts`, `src/workflow/workflow-command.ts`)
through a dynamic import of that sanctioned pipeline seam, before any
session, sandbox or orchestrator exists; the runtime layers never reach the
pipeline. `test/pipeline-import-boundary.test.ts` exempts exactly that
dynamic import of the workflow CLI command (`CLI_ENTRY_SEAM_IMPORTS`) from
its live-runtime rule: any other path from `src/workflow/` or another
runtime directory to pipeline code fails it, including a runtime module that
imports `workflow-command.ts`. The mux passes the task to its tab's child (`ironcurtain start
--pty --task-scoped -- <task>`), so the compile happens in the child's CLI
entry and shows in the tab. `/new` takes at most a persona name before
`--task-scoped` and refuses anything else (`src/mux/new-command-args.ts`): a
misspelt `--task-scope`, another case, an autocorrected em dash or a task
typed without the flag would otherwise be dropped as a stray word and spawn
an unscoped tab.

The compile is deliberately light, since it runs at session start:

1. The cheap pre-filter model selects the servers the task needs. The others
   get no rules, so every call to them escalates as out of scope.
2. Only those servers are compiled, with the task-policy prompt, and only the
   servers this installation configures are considered.
3. **No scenario generation, verification or repair**
   (`PipelineRunConfig.skipVerification`). This is safe only because of the
   intersection: a wrong or missing task rule can escalate a call the session
   policy allows, never allow one it does not. The per-server rules stay
   unverified drafts that the per-server cache never serves.
4. **The deterministic policy lint still runs**, after the compiler (rules
   that fail it go back to the compiler for a fix, at most twice) and after
   list resolution. The task text never opts the scope in to broad domain
   access (`allowBroadDomains: false`, as for a cron job's task policy), so a
   URL allow without a domains condition fails its server, which then gets
   no rules: every call to it escalates as out of scope.

If no scope can be prepared (no LLM credentials, every server failed, empty
task), the command exits; it never starts the session unscoped. In
`ironcurtain start` the compile is part of setup: an interrupt (Ctrl-C,
SIGTERM, SIGHUP) cancels it, its LLM calls included, removes its temporary
directory and exits with the signal's status before anything is started.

### Cache

Scopes are cached under `{home}/task-policies/{key}/`. The key is a SHA-256
over the trimmed task text, the directory the compile treats as the
workspace (the `--workspace`, or a fixed placeholder for a fresh sandbox,
whose path is not known yet), the protected paths, the tool annotations of
every configured server, a format version and the policy compiler epoch
(`POLICY_COMPILER_EPOCH`, see `src/policy-artifacts/provenance.ts`). A rerun
with the same inputs reuses the published scope without any LLM call;
another task, another workspace, re-annotated servers or an upgrade that
bumped the compiler epoch compile anew.

A compile runs in a private `.compile-*` directory inside the cache and is
renamed into place only when finished, so a crash or a concurrent compile of
the same task never leaves a half-written scope where a session could load
it. `task-scope.json` (`src/config/task-scope-policy.ts`) records the task,
its hash (equal to the compiled policy's `constitutionHash`), the key, the
assumed workspace and whether the compile was complete. A scope with a
server that failed to compile is used by the session it was compiled for,
with a warning, but is never reused; the next start compiles again and
replaces it.

The cache lives inside the IronCurtain home, so it is a protected path for
every agent. Entries are never evicted automatically.

## Runtime plumbing

- `SessionOptions.taskPolicyDir` carries the published directory into
  `buildSessionConfig`, which requires it to be exactly a published
  `{home}/task-policies/{key}/` directory that no other user can write
  (`validatePolicyDir`), checks it against its record (`checkTaskScopeDir`),
  sets `IronCurtainConfig.taskPolicyDir` to the canonical path and writes it
  to the session metadata. The session policy (`generatedDir`) is unchanged.
- The sandbox (and the in-process `TrustedProcess`) loads the scope with
  `loadTaskScopePolicy()` (`src/trusted-process/task-scope.ts`) from the
  canonical path only, with no fallback, through the schema-validating
  policy loader (`src/types/policy-schema.ts`: a malformed compiled policy or
  lists file refuses the session), and hands it to the
  `ToolCallCoordinator`, which passes it to every `PolicyEngine` it builds,
  including each one `loadPolicy` builds for a workflow persona.
- A resumed session (`start --resume`, mux `/resume`, PTY resume) restores
  `taskPolicyDir` from its metadata; `--task-scoped` is ignored on resume.
- A workflow run keeps the directory on its instance and in every
  checkpoint. Per-state sessions get it as `taskPolicyDir`; a shared
  container's bundle factory sets it on the bundle's config, so the bundle
  coordinator narrows every persona it loads. Resume validates it again.

Every check fails closed: a scope that is missing, outside the trusted
roots, inconsistent with its record or unreadable refuses the session, the
bundle, the workflow start or the resume. There is no override.

## Not covered

- `ironcurtain workflow run` / the daemon's `workflows.start`, web UI
  sessions (including web PTY terminals) and Signal sessions cannot request
  a task scope yet.
- Cron jobs keep their own replacement semantics (the job policy replaces
  the global policy); they are not intersected with it.
- The MCP roots a session advertises are still derived from the session
  policy, not narrowed by the task scope (calls outside the scope escalate
  anyway, and approved paths are added as roots as usual).
- The record of which scope a session or run has lives in its session
  metadata or workflow checkpoint (trusted state outside every agent's
  reach). A metadata file that no longer parses resumes the session without
  a task scope, as it already resumes it without its persona; the resume
  paths treat unreadable metadata as an old session that has none.
- The policy provenance check (`policy.onStale`) applies to the session
  policy, not to the task scope. A scope is keyed on its compile inputs and
  the compiler epoch instead, and it can only narrow the session policy.
- The cache is never pruned.

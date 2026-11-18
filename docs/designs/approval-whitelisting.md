# Design: Ephemeral Approval Whitelisting

**Status (2026-11-14):** Implemented (`src/trusted-process/approval-whitelist.ts`), stricter than first proposed: a pattern must constrain every role that escalated, `/approve+` binds the exact file (a directory-wide pattern is a separate, explicit choice, `/approve+dir`), a candidate with no constraints is never offered, and human-only escalations are never whitelisted. `/whitelist list` and `/whitelist revoke` are not implemented. Sections 3.3 to 3.6 carry 2026-11 corrections, and the direct-tool-call fallback §2.5 names no longer exists: `TrustedProcess` (`src/trusted-process/index.ts`) serves only integration tests.

**Date:** 2026-03-16
**Author:** IronCurtain Engineering

## 1. Problem Statement

When an agent works on a task, it frequently makes the same _kind_ of tool call repeatedly -- reading files from the same directory, pushing to the same git remote, fetching from the same domain. Each of these triggers an escalation that requires human approval. In a typical session, the user ends up approving 10-20 nearly identical escalations for what is conceptually the same operation with the same risk profile.

This approval fatigue has two negative consequences:

1. **Productivity loss.** The user spends more time approving than reviewing. In mux mode with multiple sessions, each session generates its own stream of escalations.

2. **Security degradation.** When every escalation feels like the same thing, users stop reading the details and rubber-stamp approvals. This defeats the purpose of human oversight.

### What we want

When a user approves an escalation, they should be able to optionally whitelist the _pattern_ behind that escalation for the remainder of the session. Future tool calls matching the same pattern should be auto-allowed without further prompting. The whitelist is ephemeral (in-memory, session-scoped) and fully audited.

### The mux mode constraint

IronCurtain has a **mux mode** (`ironcurtain mux`) where multiple PTY sessions run concurrently in a single terminal. Each session can have pending escalations at the same time. The escalation listener (both standalone and mux-integrated) assigns monotonically increasing **display numbers** to pending escalations across all sessions. The existing command syntax is:

```
/approve <N>     -- approve escalation number N
/approve all     -- approve all pending escalations
/deny <N>        -- deny escalation number N
/deny all        -- deny all pending escalations
```

The `N` in `/approve N` identifies **which pending escalation** to approve. This number is already taken and cannot be repurposed for whitelist pattern selection. Any whitelisting UX must avoid collision with this established numbering.

## 2. How Escalations Currently Work

### 2.1 Single-session mode (Code Mode / non-PTY Docker)

In `AgentSession` (Code Mode) and `DockerAgentSession` (batch Docker), the session owns one escalation directory. The flow:

1. `mcp-proxy-server.ts`'s `handleCallTool()` evaluates policy; if `escalate`, it calls `waitForEscalationDecision()`.
2. `waitForEscalationDecision()` writes `request-{id}.json` to the escalation directory and polls for `response-{id}.json`.
3. The session's escalation watcher (or `AgentSession`'s poll loop) detects the request file, fires `onEscalation`, and the transport displays a banner.
4. The user types `/approve` or `/deny`. The transport calls `session.resolveEscalation(id, decision)`, which writes `response-{id}.json`.
5. The proxy picks up the response, cleans up files, and proceeds.

**Current divergence (Flaw 3):** `AgentSession` reimplements escalation watching with its own `startEscalationWatcher()` / `pollEscalationDirectory()` / `checkEscalationExpiry()` methods and writes response files directly with `writeFileSync`. `DockerAgentSession` uses `createEscalationWatcher()`. This split means any IPC protocol extension (like whitelist support) must be implemented in two places.

In `CliTransport`, `/approve` takes an optional escalation number (`/approve 2`): each banner is numbered, and several escalations can be pending at once (`session.getPendingEscalations()`). Without a number it resolves the only pending escalation, and is refused, deciding nothing, while more than one is pending.

### 2.2 Mux mode (PTY sessions)

In mux mode, each PTY session is an independent `ironcurtain start --pty` child process. Escalations are managed by `MuxEscalationManager`, which wraps `ListenerState` from `src/escalation/listener-state.ts`.

**Key data structures:**

- `ListenerState.sessions`: `Map<string, ActiveSession>` -- active PTY sessions keyed by session ID, each with a `displayNumber`.
- `ListenerState.pendingEscalations`: `Map<number, PendingEscalation>` -- pending escalations keyed by **display number** (monotonically increasing integer starting at 1).
- `ListenerState.nextEscalationNumber`: counter for the next display number.

When an escalation arrives from any session, `addEscalation()` assigns it the next display number. When the user types `/approve 3`, the mux looks up display number 3 in `pendingEscalations`, finds the corresponding session's watcher, and calls `watcher.resolve(escalationId, decision)`.

**The display number is a global counter across all sessions.** It is NOT a session-local number, NOT a tool call counter, and NOT reusable.

### 2.3 Standalone escalation listener

`ironcurtain escalation-listener` is the non-mux equivalent. It polls the PTY registry directory for active sessions and uses the same `ListenerState` and `EscalationWatcher` modules. The `/approve N` syntax is identical.

### 2.4 Auto-approver

The auto-approver (`auto-approver.ts`) is an LLM-based intent matcher that runs in the `ToolCallCoordinator`'s pipeline in the session process. It can auto-approve escalations when the user's most recent message clearly authorizes the action. It uses `user-context.json` written by the session (or mux trusted input). The auto-approver can only return `approve` or `escalate` (never deny), and it is never consulted for a human-only escalation (invariant 10 in §3.6).

The approval whitelist is complementary to the auto-approver:

- Auto-approver: "did the user just ask for this specific action?" (intent-based, per-message)
- Whitelist: "has the user already approved this category of action?" (pattern-based, session-scoped)

### 2.5 In-process mode (TrustedProcess)

`TrustedProcess` (`src/trusted-process/index.ts`) is the in-process alternative used by integration tests (the direct-tool-call fallback it also served when this was written no longer exists; nothing under `src/` uses `TrustedProcess`). It wraps a `ToolCallCoordinator` (PolicyEngine, AuditLog, approval whitelist) around its own MCPClientManager; it has no terminal prompt of its own (the former stdin `EscalationHandler` had no callers and was removed). Escalations use a **direct callback**: `onEscalation?: EscalationPromptFn` which receives the `ToolCallRequest`, reason, and context, and returns `'approved' | 'denied'`. There is no file-based IPC in this path; escalation decisions go straight from the callback return value to the tool call flow.

The whitelist must work in this mode too. Since the callback is synchronous from the perspective of `handleToolCall()`, the whitelist check can be inserted before the callback is invoked, and the callback's return value can carry whitelist intent.

## 3. Approval Whitelisting Design

### 3.1 UX: The `/approve+` syntax

The whitelisting mechanism uses a **modifier suffix** on the existing approve command:

```
/approve 3       -- approve escalation #3 (existing behavior, unchanged)
/approve+ 3      -- approve escalation #3 AND whitelist its exact pattern (the first candidate)
/approve+dir 3   -- approve escalation #3 AND whitelist its directory-wide pattern (the second candidate, when offered)
/approve all     -- approve all pending escalations (existing, unchanged)
/approve+ all    -- approve all pending AND whitelist each exact pattern
```

The `+` suffix is a natural modifier meaning "approve plus remember." It avoids any conflict with the existing `N` argument because it modifies the command name itself, not the argument.

**Exact by default, directory-wide only on request.** `/approve+` whitelists the narrowest candidate: every path bound to the exact path that was approved. Approving a read of `~/notes/a.txt` with `/approve+` approves later reads of that file and of nothing beside it. Widening a path to its parent directory, recursively, is a second candidate that must be chosen explicitly (`/approve+dir N`, the mux picker's `W`, the second choice in the web UI and in the workflow prompts) and is labelled `(recursive)`. It is never chosen in bulk: `/approve+ all` whitelists exact patterns, and `/approve+dir all` is refused. When an escalation offers no directory-wide candidate, `/approve+dir` resolves nothing and says so, so the user decides again (section 3.3 lists when none is offered).

The deny command has no whitelist variant -- denying and remembering makes no sense in a default-deny system (unmatched patterns are already denied).

There is intentionally no `/whitelist` management command in the initial version. The whitelist is session-scoped and ephemeral -- it evaporates when the session ends. If users need to inspect active whitelist entries, that can be added later as `/whitelist list` without conflicting with existing commands.

**UX in each context:**

| Context                        | Whitelisting commands                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mux command mode               | `/approve+ N` (exact pattern) and `/approve+dir N` (directory-wide pattern); the panel shows each pattern behind its command                                                     |
| Mux escalation picker          | `w` and `W` open a confirmation showing the exact or the directory-wide pattern in full; `y` there approves and whitelists it                                                 |
| Standalone escalation listener | Same commands as mux command mode; the dashboard lists `/approve+ N: <pattern>` and `/approve+dir N: <pattern>`                                                               |
| CliTransport (single session)  | `/approve+` and `/approve+dir` (no N needed); the banner lists each pattern behind its command                                                                                 |
| Web UI and workflow prompts    | Every candidate is listed and can be selected by index (`whitelistSelection`); none is preselected                                                                             |
| Signal (bot and daemon)        | `approve+ <code>` approves the escalation whose banner shows that code and whitelists its exact pattern (the first candidate), which the banner showed in full; refused when the banner offered none (human-only, deny-only, or a pattern too long to show); there is no directory-wide variant over Signal |

### 3.2 Pattern extraction: extract once, display, then whitelist

**Critical design principle (Flaw 1 fix):** Pattern extraction happens ONCE, on the proxy side, at escalation time. The extracted candidates are included in the IPC request file so the user sees exactly what will be whitelisted. The user's selection is returned as an index into the candidates array. There is no second extraction.

The flow:

1. Policy engine returns `escalate`.
2. **Proxy extracts whitelist candidates** from the tool call's annotation and arguments, producing a `WhitelistCandidate[]` array.
3. The candidates are included in the `request-{id}.json` file as `whitelistCandidates`.
4. The session/transport reads the request file and displays the candidates to the user alongside the escalation banner.
5. When the user types `/approve+ N`, the transport writes `{ "decision": "approved", "whitelistSelection": 0 }` (index into candidates array) in the response file. `/approve+dir N` writes the index of the candidate marked `scope: "directory"` (`directoryCandidateIndex`), and writes nothing when there is none.
6. The proxy reads the response, looks up the candidate by index, and adds the pattern to its in-memory whitelist.

**Why extract on the proxy side:** The proxy has access to `ToolAnnotation` and `ArgumentRole` metadata. The session/transport does not, and should not -- it is on the other side of the IPC boundary.

**Why include candidates in the request:** This eliminates drift between what the user saw and what gets whitelisted. The proxy extracts once; the index in the response refers back to exactly the array the user was shown.

### 3.3 Pattern extraction algorithm

A whitelist candidate is derived from the **role(s) that actually caused the escalation**, not from all resource-identifier roles on the tool. The policy engine evaluates each role independently and the most restrictive result wins (deny > escalate > allow). When the winning result is `escalate`, the engine knows exactly which role(s) produced that outcome. Only those escalated roles should generate whitelist constraints.

**Why only escalated roles:** Consider `move_file` with `read-path` on source and `write-path` on destination. If the source is inside the sandbox (auto-allowed by sandbox containment) but the destination is outside (escalated by compiled rules), only the `write-path` role caused the escalation. Whitelisting a directory pattern for `read-path` would be meaningless -- that role was never the problem. (Corrected 2026-11: leaving the source unconstrained does not widen the grant to every source. A role is left out only because the policy allowed it for that call, and a later call whose source escalates is not covered, because a pattern must constrain every role that escalates the call it discharges; see section 3.5, rule 4.)

**Escalated role tracking:** The `EvaluationResult` returned by `PolicyEngine.evaluate()` is extended with an optional `escalatedRoles` field that carries the role(s) whose independent evaluation produced the `escalate` outcome. Structural escalations (e.g., `structural-domain-escalate`) also populate this field with every URL role that failed the domain gate, plus every role that compiled evaluation escalated: the gate does not skip any role of the call (its own URL roles included), and a compiled deny replaces the escalation. See section 4.1 for the type change.

**Per-call structural escalations:** Two structural escalations are never whitelisted: `structural-git-internals-escalate` (a write or delete whose path has a `.git` component) and `structural-git-repository-escalate` (a git call on a repository whose `.git` redirects outside the sandbox, or whose config sets `core.worktree` outside it, includes another file, defines a filter/diff/merge driver or a configuration-defined hook, borrows objects through `objects/info/alternates`, whose git directory holds a symbolic link leading outside the sandbox (git writes refs, reflogs, objects and `COMMIT_EDITMSG` through it), or that cannot be inspected). Both name repository state the agent can change right after an approval, so a directory pattern would approve a different `.git/config` or a re-planted driver. `requiresPerCallApproval()` (`src/trusted-process/git-structural-rules.ts`) identifies them; for such a call the pipeline neither consults existing patterns nor extracts candidates, and the approver sees no whitelist option. A local git clone source (an absolute path or `file://` URL) is resolved as `unverifiable` with `localSource` set, so it yields no `domain` candidate either; its read is covered by the engine's read-path evaluation of that path.

The extraction algorithm:

1. Receive the `EvaluationResult` from the policy engine, which includes `escalatedRoles` when `decision === 'escalate'`.
2. For each role in `escalatedRoles`, extract the canonicalized value from the tool call arguments using the annotation.
3. Group by role category and generalize:
   - **path roles** (`read-path`, `write-path`, `delete-path`): the first candidate binds the canonical path itself (a `path` constraint: only that file or directory matches). The second candidate, offered only for a call with a path, widens each path to its containing directory, recursively (a `directory` constraint, labelled `(recursive)`). The second candidate is not offered when a widened directory is the filesystem root, the home directory or one of its ancestors (a grant there covers `~/.bashrc` and every other dotfile, which matters most for `write-path`), or contains or lies inside `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/.local`, their macOS counterparts under `~/Library` (`LaunchAgents`, `Keychains`, `Application Support`, `Preferences`, `Containers`, `Group Containers`, `Cookies`; the rest of `~/Library`, such as iCloud Drive's `Mobile Documents`, holds documents and is not refused), a relocated XDG base directory (`$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_STATE_HOME`, when absolute) or a host credential store (`computeCredentialStoreProtectedPaths`, every store whatever the user opted out of). Every entry is refused on every platform; where one does not exist, that only refuses more. Both the spelled and the canonical forms of those directories are compared, so a credential directory reached through a symlink is refused too. This is a deny-side check, so both sides are folded first (`foldPathForComparison`, as for protected paths): a directory that does not exist yet keeps the caller's spelling in its canonical form, and on a case- or normalization-insensitive volume `~/.CONFIG`, or `.config` with a zero-width character in it, names `~/.config` once created.
   - **url roles** (`fetch-url`, `git-remote-url`): extract the domain, producing a "domain" constraint.
   - **identifier roles** (`github-owner`, `github-repo`): extract the exact value (case-folded). An argument naming a second repository (`issue_write`'s `parent_owner`/`parent_repo`, github-mcp-server v2) carries the same roles. Roles are matched independently, so a pattern holding two owners and two repositories would also approve the owner of one with the repository of the other: a call whose identifier role has more than one distinct value offers no candidate and is approved on its own. An owner/repo pattern approved for one repository never matches a call that also names another.
   - **opaque resource roles** (`github-resource-id`: `pull_request_review_write`'s `threadId` for `resolve_thread`/`unresolve_thread`, `sub_issue_write`'s `sub_issue_id`): no generalization exists, so no candidate is offered and each call is approved on its own. Because a pattern must constrain every escalated role, no owner/repo pattern discharges such a call either.
4. Combine into candidates that capture the server, tool, and role-specific constraints, narrowest first: the exact candidate (`scope: "exact"`, index 0, what `/approve+` selects) and, when offered, the directory-wide one (`scope: "directory"`, index 1). The URL and identifier constraints are the same in both.
5. Offer a candidate only when it discharges the very call it came from (the same check `ApprovalWhitelist.match` runs). If the exact candidate fails it, nothing is offered, so index 0 is always the exact candidate.

As implemented (2026-11), a candidate is offered only when every value of every escalated role yields a constraint. Nothing is offered for a history-rewriting role (below), for an escalated role with no value in the call, for a path that cannot be canonicalized, or for a URL whose destination is unverifiable, resolves to more than one destination, or cannot be displayed as is (`buildConstraints` in `src/trusted-process/approval-whitelist.ts`).

**Fallback when `escalatedRoles` is absent:** For defensive robustness, if `escalatedRoles` is undefined (e.g., a future structural escalation that doesn't populate the field), the extraction falls back to all resource-identifier roles. This preserves backward safety -- the candidate is overly broad rather than silently empty.

**Trusted servers never offer a pattern:** A trusted server (the memory server) has no annotation and no compiled rules; a hardcoded per-tool policy (`trusted-server-policy.ts`) judges its calls. Its only escalations, a bulk `memory_forget` and a large `memory_ingest`, are human-only, so the whitelist is never consulted and pattern extraction never runs for them. The pipeline handles them with an empty annotation (no resource arguments, so no path to capture or turn into a root).

**History-rewriting roles (Flaw 9):** Roles `write-history` and `delete-history` are excluded from whitelisting even when they appear in `escalatedRoles`. These roles represent operations that rewrite git history (rebase, reset, force-push) or delete refs (branch delete, tag delete). Approving one `git_reset` in a directory should NOT auto-approve all future resets in that directory -- each is a distinct, dangerous operation. A call whose escalated roles include a history-rewriting role offers no candidate, exact or directory-wide, and each such call is approved on its own.

### 3.4 Zero-constraint patterns and side-effectful tools (Flaw 7)

When the escalated roles have no resource-identifier arguments (or only history-rewriting roles), a candidate would have an empty `constraints` array, and such a pattern would match ANY call to that exact server/tool combination.

**Security concern:** For tools like `github/create_issue`, approving one issue creation would auto-allow ALL future issue creations. This is dangerous.

**As implemented: refused, not offered with a warning.** The first proposal still offered such a candidate, with a `warning` field that the escalation banner would show. The shipped code never offers one: `extractWhitelistCandidates()` returns no candidate when the exact pattern would have no constraint, or when an escalated value cannot be generalized, so each such call must be approved on its own. As defense in depth, `ApprovalWhitelist.add()` refuses a zero-constraint pattern (`src/trusted-process/approval-whitelist.ts`, pinned by `test/approval-whitelist.test.ts`). There is no `warning` field in the IPC types.

### 3.5 Pattern matching rules

A whitelist pattern matches a tool call when ALL of the following hold:

1. **Server name** matches exactly.
2. **Tool name** matches exactly.
3. **Every role the pattern constrains** is satisfied by the call's arguments: the call has a value for the role, and each of its values satisfies one of the pattern's constraints for that role. Constraints of one role are alternatives, one per value of the approved call (`read_multiple_files` across `d1` and `d2` gives its `read-path` one constraint per file), so a candidate always matches the call it came from and any subset of its values; constraints of different roles all apply. A value satisfies:
   - a `path` constraint when its canonical path (`resolveRealPath`: symlinks of every existing component followed) is the stored canonical path;
   - a `directory` constraint when its canonical path is the stored canonical directory or lies below it. The stored path is never resolved again: replacing an approved file or directory with a symlink afterwards ends the match instead of following it;
   - a `domain` constraint when every destination it reaches is the whitelisted one, resolved by `resolveUrlForDomainCheck` (the policy engine's resolver) at every match. A named git remote is bound to where it connects (`origin -> github.com/owner/repo`), never to its name, so re-pointing the remote ends the match; an unverifiable destination never matches;
   - an `exact` constraint when it matches exactly (case-insensitive for identifier roles).
4. **Every escalated role is constrained.** The pattern has a constraint for every role that escalated the call (`escalatedRoles`, or every resource role of the tool when those are unknown). A role the pattern does not mention was never shown to the approver: approving a move from the sandbox into `~/Documents` does not approve moving a file there from anywhere else.

The call's arguments here are the ones the policy engine evaluated (`evaluatedArguments`: an omitted remote of `git_push`/`git_pull`/`git_fetch` is `origin`), and candidates are built from the same arguments. A pattern always has at least one constraint: `ApprovalWhitelist.add()` refuses a zero-constraint pattern.

**Multiple patterns** can exist for the same server/tool. A call matches if ANY pattern matches (OR semantics across patterns). This allows whitelisting writes to both `/home/user/Documents` and `/home/user/Downloads` via two separate approvals.

### 3.6 Security invariants

1. **Only `escalate` -> `allow`.** The whitelist is consulted ONLY when the policy engine returns `escalate`. It NEVER overrides `deny` decisions. Structural denials (protected paths, unknown tools) and compiled rule denials are absolute.

2. **Ephemeral, session-scoped.** Whitelist entries live in memory only, bound to a specific proxy process. They are never persisted to disk. When the session ends, the whitelist evaporates.

3. **Full audit trail.** Every whitelist-approved call is logged to the audit log with a distinct marker (`whitelistApproved: true`, `whitelistPatternId: string`). The original escalation reason is preserved.

4. **Explicit opt-in.** Whitelisting only happens when the user types `/approve+` or `/approve+dir` (or selects a candidate in the web UI or a workflow prompt). Plain `/approve` never creates whitelist entries.

5. **Canonical paths, compared component-wise.** Path constraints compare the call's canonical path (symlinks resolved) with the stored canonical path, by equality or by directory containment on whole components, never by string prefix. This prevents symlink escape attacks.

6. **No wildcard expansion; exact paths by default.** The pattern extracted is NOT a glob, NOT a regex. The first candidate (what `/approve+` selects) binds every path exactly. The only generalizations are path -> containing directory (recursively), offered only as an explicit second candidate and never over the home directory, its ancestors or a credential directory (section 3.3), and URL -> destination.

7. **Deny takes precedence.** If a compiled rule explicitly denies a call (not default-deny), the whitelist is never consulted. The evaluation order guarantees this.

8. **Extract-once guarantee.** The pattern the user saw in the escalation banner IS the pattern that gets whitelisted. No re-extraction on the proxy side after the response is read.

9. **History roles excluded from directory generalization.** `write-history` and `delete-history` roles never produce directory-level constraints.

10. **Human-only escalations are never whitelisted.** An escalation whose `EvaluationResult.humanOnly` is set (the hardcoded `proxy-add-domain-escalate` rule: `add_proxy_domain` opens an uninspected passthrough tunnel; and the structural `structural-nested-argument-escalate`: an argument with a role holds a nested object or array, whose inner values a pattern constrained by top-level values cannot cover) is not matched against the whitelist, offers no candidate (so `/approve+` on it is a plain one-time approval, and the mux and the escalation listener say so instead of sending a whitelist selection), is never sent to the auto-approver, and is left pending by `/approve all`. See `auto-approver.md` §8.9. With taint escalation enabled, every sink call in a tainted session is human-only too, so a pattern approved earlier in the session stops discharging it once the agent has read untrusted content (`sequence-aware-policy.md`).

11. **Every escalated role is constrained.** A pattern discharges a call only when it constrains every role that escalated that call (`escalatedRoles`, or every resource role of the tool when those are unknown), so approving one role never approves another that the approver did not see (section 3.5, rule 4). The whitelist check runs on the call's `escalatedRoles`.

### 3.7 Where the whitelist lives in the evaluation pipeline

The whitelist check is a new phase in `handleCallTool()` (proxy mode) and `handleToolCall()` (in-process mode), inserted between the policy engine evaluation and the escalation flow:

```
Policy Engine evaluation
    |
    v
decision == 'deny'  ->  return denied (whitelist NOT consulted)
    |
decision == 'allow' ->  proceed to tool call
    |
decision == 'escalate'
    |
    v
Whitelist check  <----  NEW PHASE
    |
    v
match found  ->  proceed to tool call (audit: whitelistApproved=true)
    |
no match
    |
    v
Extract whitelist candidates  <----  NEW (uses escalatedRoles from evaluation)
    |
    v
Auto-approver (if enabled)
    |
    v
Human escalation (file-based IPC in proxy, callback in TrustedProcess)
    |
    v
On approved response with whitelistSelection:
  -> look up candidate by index, add to whitelist
```

This placement ensures:

- Denials are never overridden.
- The whitelist runs before the auto-approver and before human escalation, avoiding unnecessary LLM calls and user prompts.
- Candidates are extracted after the whitelist check fails (not before), avoiding wasted work on already-whitelisted calls.
- The whitelist runs in the process that has access to annotations (proxy or TrustedProcess), not in the session/transport layer.

### 3.8 Communication protocol: file-based IPC (proxy mode)

**Current request file format (`EscalationFileRequest`):**

```typescript
interface EscalationFileRequest {
  escalationId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  context?: Record<string, string>;
}
```

**Extended request file format:**

```typescript
interface EscalationFileRequest {
  escalationId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  context?: Record<string, string>;
  /** Whitelist candidates extracted from this escalation's annotation. */
  whitelistCandidates?: WhitelistCandidateIpc[];
}
```

Where `WhitelistCandidateIpc` is a JSON-serializable description of the pattern:

```typescript
interface WhitelistCandidateIpc {
  /** Human-readable summary, e.g. "Allow write_file within /home/user/Documents" */
  description: string;
  /** `exact` on the first candidate (`/approve+`), `directory` on the directory-wide one (`/approve+dir`). */
  scope?: 'exact' | 'directory';
  /** Unambiguous identity of the pattern: JSON of server, tool and the constraints (whitelistPatternKey). */
  patternKey?: string;
}
```

The full constraint details are NOT serialized into the IPC file beyond `patternKey`, an opaque identity the approval front-ends use to group pending escalations that share one pattern ("approve group", `src/escalation/escalation-groups.ts`). It is needed because the description is ambiguous: a directory name may contain the `, ` that separates constraint labels, so two different patterns can read the same. Each constraint value is a separate JSON string in the key, and the constraints are sorted, so equal keys mean equal patterns. The group pattern is the first candidate, the exact one `/approve+` selects: pending escalations are grouped only when they act on the same resources, never because they share a directory-wide candidate, which is chosen one escalation at a time and never in bulk. The constraints themselves stay in the proxy process's memory, indexed by escalation ID. The IPC file contains only the human-readable descriptions. The response carries an index back into the proxy's in-memory candidate array.

**Current response file format:**

```json
{ "decision": "approved" }
```

**Extended response file format:**

```json
{ "decision": "approved", "whitelistSelection": 0 }
```

`whitelistSelection` is the 0-based index into the `whitelistCandidates` array from the request. When absent, no pattern is whitelisted (backward compatible).

### 3.9 Communication protocol: in-process mode (TrustedProcess, Flaw 4)

`TrustedProcess.handleToolCall()` uses `EscalationPromptFn` for escalations:

```typescript
// Current:
export type EscalationPromptFn = (
  request: ToolCallRequest,
  reason: string,
  context?: Readonly<Record<string, string>>,
) => Promise<'approved' | 'denied'>;
```

**Extended:**

```typescript
/** Result from an escalation callback, optionally including whitelist selection. */
export interface EscalationResult {
  readonly decision: 'approved' | 'denied';
  /** Index into whitelistCandidates to whitelist. Absent = no whitelisting. */
  readonly whitelistSelection?: number;
}

export type EscalationPromptFn = (
  request: ToolCallRequest,
  reason: string,
  context?: Readonly<Record<string, string>>,
  /** Whitelist candidates for display to the user. */
  whitelistCandidates?: readonly WhitelistCandidateIpc[],
) => Promise<EscalationResult>;
```

**Backward compatibility:** The old return type `'approved' | 'denied'` is a string, not an `EscalationResult`. Callers of the old API (tests) need updating. To ease migration:

- The `handleToolCall` code normalizes string returns to `{ decision: string }` for any old callbacks.

(The stdin `EscalationHandler.prompt()` that this section originally migrated was never called and has been removed; the builtin CLI approves through `CliTransport`'s `/approve`, `/approve+`, `/approve+dir` and `/deny`.)

The `ApprovalWhitelist` instance in `TrustedProcess` is the same class used in proxy mode. `TrustedProcess` creates one in its constructor and uses it in `handleToolCall()`.

### 3.10 Refactoring `AgentSession` to use `EscalationWatcher` (Flaw 3)

`AgentSession` currently reimplements escalation watching inline:

- `startEscalationWatcher()` / `pollEscalationDirectory()` / `checkEscalationExpiry()` -- ~70 lines duplicating `escalation-watcher.ts`.
- `resolveEscalation()` writes response files with `writeFileSync` directly, not `atomicWriteJsonSync`, and without the stale-detection logic in `EscalationWatcher.resolve()`.

**Refactoring plan:** Replace the inline implementation with `createEscalationWatcher()`, matching `DockerAgentSession`. This consolidation means:

1. `AgentSession` gains an `escalationWatcher: EscalationWatcher | null` field (like `DockerAgentSession`).
2. `startEscalationWatcher()` is replaced by `createEscalationWatcher(this.escalationDir, events)` + `.start()`.
3. `resolveEscalation()` delegates to `this.escalationWatcher.resolve(id, decision)`.
4. `pollEscalationDirectory()`, `checkEscalationExpiry()`, `extractEscalationId()`, `seenEscalationIds` are all removed.
5. `pendingEscalation` is accessed via `this.escalationWatcher.getPending()`.

After refactoring, extending the IPC protocol for whitelisting only needs to happen in `EscalationWatcher.resolve()` -- once, not twice.

### 3.11 Widening `readEscalationResponse()` and `waitForEscalationDecision()` (Flaw 2)

**Current signatures in `mcp-proxy-server.ts`:**

```typescript
function readEscalationResponse(responsePath: string): 'approved' | 'denied' | undefined;
async function waitForEscalationDecision(
  escalationDir: string,
  request: EscalationFileRequest,
): Promise<'approved' | 'denied'>;
```

These discard any extra fields from the response JSON. The fix:

```typescript
/** Parsed escalation response with optional whitelist selection. */
interface EscalationResponseData {
  readonly decision: 'approved' | 'denied';
  readonly whitelistSelection?: number;
}

function readEscalationResponse(responsePath: string): EscalationResponseData | undefined;
async function waitForEscalationDecision(
  escalationDir: string,
  request: EscalationFileRequest,
): Promise<EscalationResponseData>;
```

The proxy holds a module-level `pendingWhitelistCandidates: Map<string, WhitelistPattern[]>` keyed by escalation ID (not on `CallToolDeps` -- it's internal mutable state acting as a side-channel between writing the escalation request and reading the response). After writing the request file with candidates, the proxy stores the full pattern objects. When the response comes back with `whitelistSelection`, it looks up the candidate by index from this map.

### 3.12 Command parsing: prefix-based, not exact match (Flaw 5)

**Current `CliTransport.handleSlashCommand()`:**

```typescript
switch (input) {
  case '/approve':
  case '/deny':
    this.handleEscalationCommand(input, session);
    return true;
  // ...
}
```

This uses exact string matching. `/approve+` does not match. The fix: parse the command prefix and extract a modifier.

```typescript
private handleSlashCommand(input: string, session: Session, onQuit: () => void): boolean {
  const [command, ...args] = input.split(/\s+/);

  // Extract modifier suffix: "/approve+" -> base="approve", modifier="+"
  const modifierMatch = command.match(/^\/(\w+)(\+)?$/);
  if (!modifierMatch) return false;
  const base = modifierMatch[1];
  const whitelist = modifierMatch[2] === '+';

  switch (base) {
    case 'quit':
    case 'exit':
      onQuit();
      return true;
    case 'logs':
      this.displayDiagnosticLog(session.getDiagnosticLog());
      return true;
    case 'budget':
      this.displayBudgetStatus(session.getBudgetStatus());
      return true;
    case 'approve':
    case 'deny':
      this.handleEscalationCommand(base, session, whitelist);
      return true;
    default:
      return false;
  }
}
```

**Mux mode (`mux-input-handler.ts`):** The mux already parses commands by splitting on whitespace and extracting the first word:

```typescript
const parts = text.slice(1).split(/\s+/);
const command = parts[0].toLowerCase();
const args = parts.slice(1);
return { kind: 'command', command, args };
```

The command `approve+` would arrive as `command = 'approve+'`. The `handleCommand()` in `mux-app.ts` uses `switch (command)` with `case 'approve':`. This needs to be updated to strip the `+` suffix:

```typescript
// In mux-app.ts handleCommand():
const whitelist = command.endsWith('+');
const baseCommand = whitelist ? command.slice(0, -1) : command;

switch (baseCommand) {
  case 'approve':
  case 'deny':
  // ... pass whitelist flag to escalationManager.resolve()
}
```

**Standalone escalation listener (`listener-command.ts`):** Same pattern. The `handleCommand()` function already splits on whitespace and lowercases the command. Apply the same `+` suffix stripping.

### 3.13 Multi-proxy per session in Docker mode (Flaw 11)

In Docker mode, each `DockerAgentSession` may spawn multiple MCP proxy processes (one per `SERVER_FILTER`). Each proxy is an independent process with its own `PolicyEngine` and its own whitelist. When the user approves an escalation from one proxy, the whitelist pattern is added to THAT proxy's memory only -- the other proxies do not see it.

This is acceptable because:

1. Each proxy serves a different MCP server (e.g., one for filesystem, one for git). Cross-server whitelisting is not meaningful.
2. The whitelist matches on `(serverName, toolName)`. A pattern whitelisted in the filesystem proxy would never match a tool call in the git proxy anyway.
3. There is no need for cross-proxy communication. The session-scoped lifetime is the session of the proxy process, which aligns with the Docker session.

**No design change needed.** The per-process whitelist naturally scopes to the right proxy.

### 3.14 `isWithinDirectory` export (Flaw 6)

`isWithinDirectory` in `policy-engine.ts` is currently a module-private function. The whitelist matching code in `approval-whitelist.ts` needs it. Two options:

**Option A (preferred):** Move `isWithinDirectory` to `src/types/argument-roles.ts` alongside `resolveRealPath` (which it depends on). Both are path-related utilities, not policy-engine-specific logic.

**Option B:** Export from `policy-engine.ts`. This creates a dependency from the whitelist module to the policy engine, which is undesirable -- the whitelist should be a peer, not a dependent.

We choose Option A.

### 3.15 Evaluation order clarification (Flaw 10)

The actual evaluation order in the code is:

1. **Structural invariants** (hardcoded in `PolicyEngine.evaluateStructuralInvariants()`):
   - Protected path check (deny)
   - Introspection tool allow
   - Filesystem sandbox containment (allow/partial)
   - Untrusted domain gate (escalate; recorded, not final: every role of the call, the gate's URL roles included, still goes through compiled rule evaluation, and a compiled deny wins)
   - Unknown tool denial (deny)

2. **Compiled rule evaluation** (`PolicyEngine.evaluateCompiledRules()`):
   - Per-role evaluation, first-match-wins per role
   - Most-restrictive-wins across roles (deny > escalate > allow)
   - Default deny if no rule matches

3. **Whitelist check** (NEW -- in `handleCallTool()` / `handleToolCall()`, not in PolicyEngine):
   - Only when evaluation returns `escalate`
   - Match against in-memory patterns

4. **Auto-approver** (existing, in proxy/TrustedProcess):
   - Only when whitelist does not match

5. **Human escalation** (existing):
   - File-based IPC (proxy) or callback (TrustedProcess)

The whitelist is NOT part of the PolicyEngine. It lives in the call handler (`handleCallTool` / `handleToolCall`), after policy evaluation, before the escalation flow. This is intentional: the PolicyEngine is a pure evaluator with no mutable state; the whitelist is mutable session state.

### 3.16 User feedback at approval time (Flaw 8)

When the user types `/approve+ N` or `/approve+dir N`, the transport should:

1. Display the candidate descriptions from the escalation request, each behind the command that selects it (`/approve+ <exact pattern>`, `/approve+dir <directory-wide pattern>`; already shown in the banner, dashboard or panel).
2. Select by command: `/approve+` the first (exact) candidate, `/approve+dir` the one marked `scope: "directory"`. The mux picker's `w` and `W` first show the chosen pattern in full on a confirmation screen, which `y` accepts. The web UI and the workflow prompts list every candidate for selection by index.
3. Display a confirmation message: `"Escalation approved. Whitelisted: <description>"` (the listener and the mux say `(whitelisted)` or `(whitelisted: directory-wide)`).

A candidate holds constraints for every escalated role of a multi-argument tool: there is one candidate per scope, not one per argument.

## 4. Type Definitions

### 4.1 Extended `EvaluationResult` (in `src/trusted-process/policy-types.ts`)

```typescript
import type { PolicyDecisionStatus } from '../types/mcp.js';
import type { ArgumentRole } from '../types/argument-roles.js';

export interface EvaluationResult {
  decision: PolicyDecisionStatus;
  rule: string;
  reason: string;
  /**
   * When decision is 'escalate', every role whose independent evaluation
   * produced an escalation. Every other resource role of the call was
   * allowed (sandbox containment or a compiled allow). The approval
   * whitelist builds a pattern's constraints from these roles and matches a
   * later call only when its pattern constrains every one of that call's
   * escalated roles; roots expansion adds roots only for these roles' paths.
   *
   * Populated by:
   * - evaluateCompiledRules(): roles whose per-role evaluation was 'escalate'.
   * - the structural domain gate: the URL roles that reached an off-allowlist
   *   or unverifiable destination, joined with the roles the compiled rules
   *   escalated for the same call (structural-domain-escalate). The gate does
   *   not skip any role: a compiled deny replaces the escalation.
   *
   * Undefined for non-escalate decisions, and when the escalated roles are
   * unknown; consumers then fall back to their most restrictive behaviour
   * (the whitelist requires every resource role to be constrained, roots
   * expansion adds no root).
   */
  escalatedRoles?: readonly ArgumentRole[];
}
```

The engine populates `escalatedRoles` in two places:

1. **`evaluateCompiledRules()`**: When iterating roles, if the most restrictive result is `escalate`, collect all roles that independently evaluated to `escalate` (there may be more than one). This is a minor bookkeeping change in the existing `for (const role of rolesToEvaluate)` loop.

2. **`evaluateStructuralInvariants()`**: When the `structural-domain-escalate` rule fires, the `EvaluationResult` includes every role from the `extractAnnotatedUrls()` entries that failed the domain allowlist check (the reason describes the first). The gate's escalation is not final: `evaluate()` still runs compiled rule evaluation for every role of the call, the gate's URL roles included. A compiled deny wins (so a git call on a repository outside every permitted directory stays denied, and so does a URL role no rule covers), and roles the compiled rules escalate are added to `escalatedRoles`.

### 4.2 Whitelist types (new file: `src/trusted-process/approval-whitelist.ts`)

```typescript
/**
 * Ephemeral approval whitelist -- session-scoped in-memory store
 * of approval patterns extracted from user-approved escalations.
 *
 * Security invariant: only converts escalate -> allow, never overrides deny.
 * Entries are never persisted to disk.
 */

import type { ArgumentRole } from '../types/argument-roles.js';
import type { ToolAnnotation } from '../pipeline/types.js';

/** Unique identifier for a whitelist entry, for audit trail linkage. */
export type WhitelistEntryId = string & { readonly __brand: 'WhitelistEntryId' };

/**
 * A constraint on a single argument role's value.
 * Discriminated union by `kind`.
 */
export type WhitelistConstraint =
  | {
      readonly kind: 'path';
      readonly role: ArgumentRole;
      /** Canonical (resolved real) path of the approved value; only this path matches. */
      readonly path: string;
    }
  | {
      readonly kind: 'directory';
      readonly role: ArgumentRole;
      /** Canonical path of the containing directory; it and everything below it match. */
      readonly directory: string;
    }
  | {
      readonly kind: 'domain';
      readonly role: ArgumentRole;
      /** Extracted domain (e.g., "github.com"). */
      readonly domain: string;
    }
  | {
      readonly kind: 'exact';
      readonly role: ArgumentRole;
      /** Exact value to match (case-insensitive for identifier roles). */
      readonly value: string;
    };

/**
 * A whitelist pattern extracted from an approved escalation.
 * Matches future calls to the same server/tool with arguments
 * satisfying all constraints.
 */
export interface WhitelistPattern {
  readonly id: WhitelistEntryId;
  readonly serverName: string;
  readonly toolName: string;
  readonly constraints: readonly WhitelistConstraint[];
  /** ISO 8601 timestamp when the pattern was created. */
  readonly createdAt: string;
  /** The escalation ID that produced this pattern (for audit linkage). */
  readonly sourceEscalationId: string;
  /** The original escalation reason (preserved for audit). */
  readonly originalReason: string;
  /** Human-readable description of the pattern. */
  readonly description: string;
}

/**
 * JSON-serializable candidate description for IPC.
 * Included in the escalation request file so the user sees
 * exactly what will be whitelisted.
 */
export interface WhitelistCandidateIpc {
  /** Human-readable summary, e.g. "Allow filesystem/write_file write-path /home/user/Documents/report.md" */
  readonly description: string;
  /**
   * `exact` on the first candidate (what `/approve+` selects), `directory` on
   * the directory-wide one (what `/approve+dir` selects, never first).
   */
  readonly scope?: 'exact' | 'directory';
  /**
   * Unambiguous identity of the pattern (whitelistPatternKey); approval
   * front-ends group pending escalations by the key of their first candidate.
   */
  readonly patternKey?: string;
}

/**
 * Result of a whitelist match check.
 */
export type WhitelistMatchResult =
  | { readonly matched: false }
  | { readonly matched: true; readonly patternId: WhitelistEntryId; readonly pattern: WhitelistPattern };

/**
 * The ephemeral whitelist store. Session-scoped, in-memory only.
 *
 * Thread safety: the proxy is single-threaded (Node.js event loop),
 * so no synchronization is needed.
 */
export interface ApprovalWhitelist {
  /**
   * Adds a pattern to the whitelist.
   * Returns the pattern ID for audit linkage.
   */
  add(pattern: Omit<WhitelistPattern, 'id'>): WhitelistEntryId;

  /**
   * Checks whether a tool call matches any whitelist pattern.
   * Returns the matching pattern if found.
   *
   * @param serverName - The MCP server name
   * @param toolName - The tool name (without server prefix)
   * @param resolvedArgs - Arguments with paths already resolved to real paths
   * @param annotation - The tool's annotation (for role extraction)
   */
  match(
    serverName: string,
    toolName: string,
    resolvedArgs: Record<string, unknown>,
    annotation: ToolAnnotation,
  ): WhitelistMatchResult;

  /** Returns all active patterns (for diagnostics/testing). */
  entries(): readonly WhitelistPattern[];

  /** Number of active patterns. */
  readonly size: number;
}
```

### 4.3 Extended escalation IPC types

```typescript
// In mcp-proxy-server.ts, extend EscalationFileRequest:

interface EscalationFileRequest {
  escalationId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  context?: Record<string, string>;
  /** Whitelist candidates extracted from this escalation's annotation. */
  whitelistCandidates?: WhitelistCandidateIpc[];
  /** Set for a human-only escalation (invariant 10); it then has no candidates. */
  humanOnly?: true;
}

// Parsed response (replaces the current 'approved' | 'denied' return):

interface EscalationResponseData {
  readonly decision: 'approved' | 'denied';
  /** Index into whitelistCandidates to whitelist. Absent = no whitelisting. */
  readonly whitelistSelection?: number;
}
```

### 4.4 Extended EscalationRequest (session/types.ts)

```typescript
// Extend the existing EscalationRequest exposed to transports:

export interface EscalationRequest {
  readonly escalationId: string;
  readonly toolName: string;
  readonly serverName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
  readonly context?: Readonly<Record<string, string>>;
  /** Whitelist candidates for display. Present when the proxy supports whitelisting. */
  readonly whitelistCandidates?: readonly WhitelistCandidateIpc[];
  /** Human-only escalation (invariant 10): approve individually, never whitelist. */
  readonly humanOnly?: boolean;
}
```

### 4.5 Extended Session.resolveEscalation()

```typescript
// In Session interface (session/types.ts):

resolveEscalation(
  escalationId: string,
  decision: 'approved' | 'denied',
  options?: { whitelistSelection?: number },
): Promise<void>;
```

### 4.6 Extended EscalationWatcher.resolve()

```typescript
// In EscalationWatcher interface (escalation-watcher.ts):

resolve(
  escalationId: string,
  decision: 'approved' | 'denied',
  options?: { whitelistSelection?: number },
): boolean;
```

### 4.7 Extended EscalationPromptFn (TrustedProcess in-process mode)

```typescript
// In src/trusted-process/index.ts:

export interface EscalationResult {
  readonly decision: 'approved' | 'denied';
  readonly whitelistSelection?: number;
}

export type EscalationPromptFn = (
  request: ToolCallRequest,
  reason: string,
  context?: Readonly<Record<string, string>>,
  whitelistCandidates?: readonly WhitelistCandidateIpc[],
  details?: { readonly humanOnly: boolean }, // invariant 10
) => Promise<EscalationResult>;
```

### 4.8 Extended audit entry

```typescript
// Additions to AuditEntry in src/types/audit.ts:
export interface AuditEntry {
  // ... existing fields ...

  /**
   * When true, the escalation was bypassed because a whitelist
   * pattern matched. The whitelistPatternId links to the original
   * approval that created the pattern.
   */
  whitelistApproved?: boolean;

  /**
   * ID of the whitelist pattern that matched, linking back to the
   * original escalation approval. Only present when whitelistApproved is true.
   */
  whitelistPatternId?: string;
}
```

### 4.9 Extended CallToolDeps (proxy mode)

```typescript
// Addition to CallToolDeps in mcp-proxy-server.ts:
export interface CallToolDeps {
  // ... existing fields ...

  /** Ephemeral approval whitelist for this session. */
  whitelist: ApprovalWhitelist;
}
```

> **Note:** `pendingWhitelistCandidates` is module-level state in the proxy process
> (`const pendingWhitelistCandidates = new Map<...>()`), not a `CallToolDeps` field.
> It is internal mutable state acting as a side-channel between writing the escalation
> request and reading the response -- putting it on `CallToolDeps` would leak
> implementation details into the interface.

## 5. Component Diagram

```
User types "/approve+ 3"
        |
        v
+------------------+     writes response-{id}.json
| MuxApp /         | --> { "decision": "approved", "whitelistSelection": 0 }
| CliTransport /   |
| Listener         |
+------------------+
                          escalation directory (per-session)
                          ~/.ironcurtain/sessions/{sid}/escalation/

                          request-{id}.json includes:
                            whitelistCandidates: [
                              { description: "Allow write_file within /home/user/Documents" }
                            ]

                               ^                    |
                               | polls              | reads
+------------------------------+--------------------v------------------+
|                     mcp-proxy-server (per-session proxy process)     |
|                                                                      |
|  handleCallTool()                                                    |
|      |                                                               |
|      v                                                               |
|  PolicyEngine.evaluate()  --> EvaluationResult { escalatedRoles }     |
|      |                                                               |
|      v  decision == 'escalate'                                       |
|      |                                                               |
|      v                                                               |
|  ApprovalWhitelist.match()  <-- check existing patterns              |
|      |                                                               |
|      +-- match found --> proceed (audit: whitelistApproved=true)     |
|      |                                                               |
|      +-- no match                                                    |
|      |                                                               |
|      v                                                               |
|  extractWhitelistCandidates(escalatedRoles)  -- only escalated roles |
|      |                                                               |
|      v                                                               |
|  Store candidates in pendingWhitelistCandidates[escalationId]        |
|      |                                                               |
|      v                                                               |
|  AutoApprover (LLM-based intent match)                               |
|      |                                                               |
|      v                                                               |
|  waitForEscalationDecision()  -- file-based IPC                      |
|      |    (candidates included in request file)                      |
|      |                                                               |
|      v  response.whitelistSelection present?                         |
|      |                                                               |
|      v                                                               |
|  Look up candidate by index from pendingWhitelistCandidates          |
|  ApprovalWhitelist.add(pattern)                                      |
|      |                                                               |
|      v                                                               |
|  proceed with tool call                                              |
+----------------------------------------------------------------------+
```

**In-process mode (TrustedProcess):**

```
TrustedProcess.handleToolCall()
    |
    v
PolicyEngine.evaluate()  --> EvaluationResult { escalatedRoles }
    |  decision == 'escalate'
    v
ApprovalWhitelist.match()
    |  no match
    v
extractWhitelistCandidates(escalatedRoles)
    |
    v
onEscalation callback (with candidates)
    |  returns EscalationResult { decision: 'approved', whitelistSelection: 0 }
    v
Look up candidate, ApprovalWhitelist.add(pattern)
    |
    v
proceed with tool call
```

## 6. Pattern Extraction Implementation

### 6.1 `extractWhitelistCandidates()` function

```typescript
/**
 * Extracts whitelist candidate patterns from an escalated tool call.
 *
 * Only generates constraints for the role(s) that caused the escalation,
 * as identified by `escalatedRoles` on the EvaluationResult. This avoids
 * generating meaningless patterns for roles that were already allowed
 * (e.g., by sandbox containment) or that matched a different compiled rule.
 *
 * Falls back to all resource-identifier roles when `escalatedRoles` is
 * undefined (defensive robustness for future structural escalation paths).
 *
 * Returns both:
 * - WhitelistPattern[] (full patterns, stored in proxy memory)
 * - WhitelistCandidateIpc[] (descriptions, serialized into IPC file)
 *
 * Returns up to two candidates, each combining all escalated-role
 * constraints, narrowest first: the exact one (paths bound exactly;
 * `/approve+`), then, for a call with a path, the directory-wide one
 * (paths widened to their parent directories, recursively; `/approve+dir`),
 * unless a widened directory is refused (section 3.3). A candidate is
 * offered only when it discharges the call it came from.
 *
 * @param serverName - The MCP server name
 * @param toolName - The tool name
 * @param args - The tool call arguments (already resolved for policy)
 * @param annotation - The tool's resolved annotation
 * @param escalatedRoles - The role(s) that caused the escalation (from EvaluationResult).
 *   When undefined, falls back to all resource-identifier roles on the annotation.
 * @param escalationId - The escalation that triggered this extraction
 * @param escalationReason - The reason for escalation
 */
function extractWhitelistCandidates(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  escalatedRoles: readonly ArgumentRole[] | undefined,
  escalationId: string,
  escalationReason: string,
): { patterns: Array<Omit<WhitelistPattern, 'id'>>; ipcs: WhitelistCandidateIpc[] };
```

### 6.2 Generalization rules by role category

These generalizations apply only to roles present in `escalatedRoles`. Roles that were allowed by sandbox containment or matched an `allow` compiled rule are not included.

| Role category | Role                                     | Generalization                                    | Rationale                                                                                                           |
| ------------- | ---------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `path`        | `read-path`, `write-path`, `delete-path` | Exact candidate: `resolveRealPath(value)`. Directory-wide candidate: `dirname(resolveRealPath(value))`, recursive, refused over `/`, the home directory, its ancestors and credential directories | Approving a write to `report.md` approves that file. That the rest of its directory is acceptable too is a separate, explicit choice. |
| `path`        | `write-history`, `delete-history`        | No candidate generated                            | History-rewriting is too dangerous for any generalization. Each operation requires individual approval.             |
| `url`         | `fetch-url`, `git-remote-url`            | `extractDomainForRole(canonicalize(value), role)` | Domain-level matches existing security boundaries.                                                                  |
| `identifier`  | `github-owner`, `github-repo`            | `value.toLowerCase()`                             | Case-insensitive exact match.                                                                                       |
| `opaque`      | `github-resource-id`                     | No candidate (never whitelisted)                  | A global GitHub ID (review thread, sub-issue) names a resource in any repository; owner/repo cannot scope it.       |

### 6.3 Human-readable descriptions

The `description` field in `WhitelistCandidateIpc` is built from the constraints, one label per constraint:

```
"Allow filesystem/write_file write-path /home/user/Documents/report.md"            -- exact (/approve+)
"Allow filesystem/write_file write-path within /home/user/Documents (recursive)"   -- directory-wide (/approve+dir)
"Allow filesystem/read_multiple_files read-path /a/x.txt, read-path /b/y.txt"      -- one role, two values: either matches
"Allow git/git_push git-remote-url origin -> github.com/owner/repo"
"Allow fetch/http_fetch fetch-url domain api.example.com"
"Allow github/create_issue github-owner=octocat, github-repo=hello-world"
```

### 6.4 Multi-argument tools

A tool may have multiple resource-identifier arguments (e.g., `move_file` has `source` with `[read-path, delete-path]` and `destination` with `[write-path]`). The pattern includes constraints only for the **escalated** roles, not all resource-identifier arguments. For example, if `move_file`'s source `read-path` and `delete-path` roles were allowed by sandbox containment but the destination `write-path` was escalated, only the `write-path` constraint appears in the candidate. Every constrained role must be satisfied for the pattern to fire.

When multiple roles escalate (e.g., both `read-path` on source and `write-path` on destination are outside the sandbox), all escalated roles generate constraints and all must be satisfied.

When one role has several values (`read_multiple_files` with files in `d1` and `d2`), the role gets one constraint per distinct value and they are alternatives: every value of that role in a later call must satisfy one of them. Requiring every value to satisfy every constraint instead would make a candidate that can never match even the call it came from. Identifier roles are the exception (section 3.3): a call with two distinct values of one identifier role offers no candidate, since owner and repository constraints are matched independently.

## 7. Security Considerations

### 7.1 Directory traversal

Path constraints compare the call's path as `resolveRealPath()` canonicalizes it (symlink-following `realpathSync` for every existing component) with the canonical path stored when the candidate was built. A whitelisted directory of `/home/user/Documents` will not match a path like `/home/user/Documents/../../etc/passwd` because it resolves to `/etc/passwd`, which is not within `/home/user/Documents`. The stored path is not resolved again at match time: if the approved file or directory is later replaced by a symlink to somewhere else, the call resolves to the link's target, which is not the stored path, so the match ends rather than following the link.

### 7.2 Pattern over-generalization

By default nothing is generalized for paths: the first candidate binds the exact path, so a single approved read of a file in the home directory or a repository root does not reach the files beside it (`~/.ssh`, `.env`). Directory-level generalization is a second, explicit choice labelled `(recursive)`. It is not offered over the filesystem root, the home directory or its ancestors, or in or around a credential or startup directory (section 3.3), where one recursive grant would cover keys and tokens or, for `write-path`, files that run code at login (`~/.bashrc`, `~/.config/autostart`, `~/.local/bin`, `~/Library/LaunchAgents`). URLs generalize to their one verified destination. History-rewriting roles are never generalized (Flaw 9).

For side-effectful tools with no resource-identifier arguments, no pattern is offered at all (section 3.4), so each call is approved on its own.

### 7.3 Whitelist cannot override deny

The evaluation order (deny check before whitelist check) ensures that even if a compromised agent tries to exploit a whitelisted pattern to access denied resources, the deny phase runs first and blocks the call.

### 7.4 Extract-once guarantee eliminates drift

The pattern displayed to the user (via `WhitelistCandidateIpc.description`) is generated from the same extraction that produces the `WhitelistPattern`. The response carries only an index, not a request to "re-extract." This eliminates any possibility of the proxy computing a different pattern than what the user saw.

### 7.5 Audit completeness

Every whitelist-approved call includes:

- `whitelistApproved: true`
- `whitelistPatternId` -- links to the original approval
- The original `policyDecision` with `status: 'escalate'` and the escalation reason

### 7.6 Interaction with auto-approver

The whitelist runs BEFORE the auto-approver. When both are enabled:

1. Policy engine returns `escalate`.
2. Whitelist check: if matched, proceed (no auto-approver call, no human prompt).
3. Auto-approver: if approved, proceed (no human prompt). Note: auto-approved calls do NOT create whitelist entries.
4. Human escalation.

A human-only escalation (invariant 10) skips steps 2 and 3 and goes straight to the human, with no whitelist candidate.

### 7.7 Cross-session approval history (policy learning)

The whitelist itself stays ephemeral (invariant 2). What outlives the session is a record of the _human_ decisions: after a human approves an escalation and the approved paths pass the post-approval (T1) check, the pipeline reports one of the call's whitelist candidates (whether or not the user chose `/approve+` or `/approve+dir`) through `CallToolDeps.onHumanApproval`, and the coordinator appends it to `~/.ironcurtain/approval-history.jsonl` (`src/audit/approval-history.ts`) under the constitution scope in effect (`global`, `persona:<name>` or `job:<id>`; a workflow coordinator moves the scope with each `loadPolicy`). The candidate reported is the generalized one: the directory-wide candidate (`scope: 'directory'`) for a call with paths, the only candidate for a call without (destinations and identifiers). Only that pattern is stored (server, tool, escalating rule, the candidate's directory / destination / identifier constraints and its description), never raw arguments: the exact candidate, whose `path` constraints are the approved values themselves, is never reported, and the history refuses a `path` constraint (`ApprovalConstraint`).

Never recorded: auto-approver decisions and whitelist matches (so neither a trickable LLM approver nor one broad pattern can feed it), escalations that offer no generalized candidate (human-only, which includes taint sinks and calls the outbound content assessment flagged; per-call git escalations; ungeneralizable values; a path whose directory-wide candidate is refused, see §3.3), escalations raised by a `structural-*` invariant (no constitution changes those), calls to the virtual `proxy` server, and, in a task-scoped session, escalations the task scope raised (`task-scope-escalate` or one of the task policy's own rules: the session policy allowed the call, so no amendment of the constitution would spare the approval).

Once a pattern has three human approvals under one scope, `ironcurtain audit proposals` lists a deterministic constitution statement for it, and the customize-policy flows (global `customize-policy`, `persona edit`, `daemon edit-job`) offer it as a diff before their LLM conversation. It is added only when the user accepts it and takes effect only after a recompile; a dismissal is recorded so the pattern needs three new approvals before it is proposed again. See `constitution-customizer.md` §11.

## 8. Integration Points (Files Changed)

### Phase 1: Core whitelist module + AgentSession refactor

**New file: `src/trusted-process/approval-whitelist.ts`**

- `ApprovalWhitelist` implementation (in-memory store, `add()`, `match()`, `entries()`).
- `extractWhitelistCandidates()` accepts `escalatedRoles` from `EvaluationResult` to scope extraction to only the role(s) that caused the escalation.
- Constraint matching for each kind (directory, domain, exact).

**Modify: `src/trusted-process/policy-types.ts`**

- Add optional `escalatedRoles?: readonly ArgumentRole[]` field to `EvaluationResult`.

**Modify: `src/trusted-process/policy-engine.ts`**

- `evaluateCompiledRules()`: collect roles that evaluated to `escalate` into `escalatedRoles` on the result.
- `evaluateStructuralInvariants()`: populate `escalatedRoles` on `structural-domain-escalate` results.
- Import `isWithinDirectory` from `argument-roles.ts` (moved out of this file).

**Move: `isWithinDirectory` from `src/trusted-process/policy-engine.ts` to `src/types/argument-roles.ts`**

- Export for use by both `policy-engine.ts` and `approval-whitelist.ts`.

**Refactor: `src/session/agent-session.ts`**

- Replace inline escalation watcher with `createEscalationWatcher()`.
- Replace `resolveEscalation()` direct `writeFileSync` with `this.escalationWatcher.resolve()`.
- Remove `pollEscalationDirectory()`, `checkEscalationExpiry()`, `extractEscalationId()`, `seenEscalationIds`, `escalationPollInterval`.
- Add `escalationWatcher: EscalationWatcher | null` field.

### Phase 2: IPC protocol extension + proxy integration

**Modify: `src/trusted-process/mcp-proxy-server.ts`**

- Extend `EscalationFileRequest` with `whitelistCandidates`.
- Widen `readEscalationResponse()` return type to `EscalationResponseData`.
- Widen `waitForEscalationDecision()` return type to `EscalationResponseData`.
- Add `ApprovalWhitelist` to `CallToolDeps`; `pendingWhitelistCandidates` is module-level state (not on `CallToolDeps` -- it's an internal side-channel, not a dependency).
- Insert whitelist check in `handleCallTool()` between policy evaluation and escalation flow.
- Pass `evaluation.escalatedRoles` to `extractWhitelistCandidates()` to scope extraction to only the causal roles.
- Store candidates in `pendingWhitelistCandidates` map.
- After reading response with `whitelistSelection`, look up candidate and add to whitelist.
- Pass whitelist audit fields to `buildAuditEntry()`.

**Modify: `src/types/audit.ts`**

- Add `whitelistApproved?: boolean` field to `AuditEntry`.
- Add `whitelistPatternId?: string` field to `AuditEntry`.

**Modify: `src/trusted-process/index.ts`**

- Add `EscalationResult` type and update `EscalationPromptFn` signature.
- Create `ApprovalWhitelist` instance in `TrustedProcess` constructor.
- Insert whitelist check in `handleToolCall()`.
- Extract candidates and pass to `onEscalation` callback.
- Handle `whitelistSelection` in callback result.

### Phase 3: Session/transport layer

**Modify: `src/escalation/escalation-watcher.ts`**

- Extend `resolve()` to accept optional `{ whitelistSelection?: number }` options.
- Write `{ decision, whitelistSelection }` when present.

**Modify: `src/session/types.ts`**

- Extend `EscalationRequest` with `whitelistCandidates`.
- Extend `Session.resolveEscalation()` with optional `options` parameter.

**Modify: `src/session/cli-transport.ts`**

- Replace exact `switch (input)` with prefix-based command parsing.
- Recognize `/approve+` as a command.
- Display whitelist candidates in escalation banner when present.
- Pass `{ whitelistSelection: 0 }` when resolving with `/approve+`.
- Display confirmation message showing whitelisted pattern description.

**Modify: `src/session/agent-session.ts`** (after Phase 1 refactor)

- Update `resolveEscalation()` to pass options through to `escalationWatcher.resolve()`.

**Modify: `src/docker/docker-agent-session.ts`**

- Update `resolveEscalation()` to pass options through to `escalationWatcher.resolve()`.

### Phase 4: Mux + escalation listener integration

**Modify: `src/mux/mux-app.ts`**

- Strip `+` suffix from command name in `handleCommand()`.
- Pass `whitelist: true` flag through to `escalationManager.resolve()`.

**Modify: `src/mux/mux-input-handler.ts`**

- No change needed. The `+` is part of the command string and passes through to `handleCommand()`.

**Modify: `src/mux/mux-escalation-manager.ts`**

- Extend `resolve()` to accept optional `whitelist: boolean` parameter.
- Pass through to `watcher.resolve()` as `{ whitelistSelection: 0 }`.

**Modify: `src/escalation/listener-command.ts`**

- Strip `+` suffix from command name in `handleCommand()`.
- Pass through to `watcher.resolve()`.

### Phase 5: Polish

- Update escalation banner in all transports to show whitelist candidates.
- Update command help text and hint bars with `/approve+` syntax.
- Update CLAUDE.md with whitelist documentation.

## 9. Testing Strategy

### 9.1 Unit tests: `approval-whitelist.test.ts`

Test the `ApprovalWhitelist` implementation in isolation:

- **Pattern matching:**
  - Path constraint matches file within whitelisted directory.
  - Path constraint rejects file outside whitelisted directory.
  - Path constraint handles symlink escape (symlinked path resolves outside directory), and does not follow an approved file or directory that is later replaced by a symlink.
  - Constraints of one role are alternatives; constraints of different roles all apply.
  - Domain constraint matches URL with whitelisted domain.
  - Domain constraint rejects URL with different domain.
  - Exact constraint matches (case-insensitive for identifiers).
  - Multi-constraint patterns require all constraints to match.
  - Empty constraints match any call to that server/tool.
  - Multiple patterns for same server/tool -- first match wins.

- **Pattern extraction:**
  - Path role in `escalatedRoles` yields the exact canonical path in the first candidate and the parent directory, labelled recursive, in the second.
  - No directory-wide candidate over `/`, the home directory, its ancestors, or in or around `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/.local`, their `~/Library` counterparts, relocated XDG base directories and the credential stores, in any spelling that folds to one of them (acceptance: `/approve+` on `~/notes/a.txt` whitelists only that file and `~/notes/b.txt` still escalates).
  - Matching canonicalizes each path value of a call once, however many constraints the pattern holds (`test/approval-whitelist-match-cost.test.ts`).
  - Every offered candidate discharges the call it came from, including one role with values in several directories.
  - An identifier role with two distinct values yields no candidate.
  - URL role in `escalatedRoles` extracts domain.
  - Identifier role in `escalatedRoles` extracts case-folded value.
  - Roles NOT in `escalatedRoles` are excluded from constraints.
  - `write-history` and `delete-history` roles produce no directory constraint even when escalated.
  - Side-effectful tool with no resource-identifier args in escalated roles gets no candidate (section 3.4).
  - Multi-argument tool with only one escalated role produces single constraint.
  - Fallback: undefined `escalatedRoles` extracts all resource-identifier roles.

- **EvaluationResult.escalatedRoles population:**
  - `evaluateCompiledRules()`: single escalated role is captured.
  - `evaluateCompiledRules()`: multiple roles escalated, all captured.
  - `evaluateCompiledRules()`: mix of allow and escalate roles, only escalate roles captured.
  - `evaluateStructuralInvariants()`: `structural-domain-escalate` captures the failing URL role.
  - Non-escalate decisions have undefined `escalatedRoles`.

- **Lifecycle:**
  - Empty whitelist matches nothing.
  - Added patterns are immediately matchable.
  - `entries()` returns all active patterns.
  - `size` reflects current count.

### 9.2 Unit tests: `AgentSession` refactor

- Verify `AgentSession.resolveEscalation()` delegates to `EscalationWatcher.resolve()`.
- Verify escalation detection works identically to before (poll, detect, fire callback).
- Verify escalation expiry detection works identically.
- Verify `getPendingEscalation()` returns `escalationWatcher.getPending()`.

### 9.3 Unit tests: IPC protocol extension

- `readEscalationResponse()` parses `whitelistSelection` field.
- `readEscalationResponse()` returns `undefined` for missing `whitelistSelection` (backward compat).
- `waitForEscalationDecision()` returns full `EscalationResponseData`.
- `EscalationWatcher.resolve()` writes `whitelistSelection` when provided.
- `EscalationWatcher.resolve()` omits field when not provided (backward compat).

### 9.4 Unit tests: extended `handleCallTool` / `handleToolCall`

- **Whitelist bypass:**
  - Escalated call with matching whitelist pattern is allowed without escalation.
  - Audit entry has `whitelistApproved: true` and `whitelistPatternId`.
  - Denied call is NOT affected by whitelist.
  - Allowed call is NOT affected by whitelist.

- **Pattern creation on approval:**
  - Response with `whitelistSelection: 0` triggers pattern addition.
  - Response without `whitelistSelection` does not create a pattern.
  - Pattern is correctly extracted from the escalation request and annotation.

- **TrustedProcess in-process mode:**
  - Whitelist check runs before `onEscalation` callback.
  - Callback receives `whitelistCandidates` parameter.
  - `EscalationResult` with `whitelistSelection` creates pattern.

### 9.5 Unit tests: command parsing

- `CliTransport`: `/approve+` recognized as approve with whitelist.
- `CliTransport`: `/approve` recognized as approve without whitelist.
- `CliTransport`: `/approve+ 3` is NOT a valid command in single-session mode (CliTransport has no N).
- Mux: `approve+` command stripped to `approve` with whitelist flag.
- Mux: `approve` command has no whitelist flag.
- Listener: same as mux.

### 9.6 Integration tests

- End-to-end: approve+ in CLI transport, verify subsequent matching call skips escalation.
- End-to-end: verify audit log contains correct whitelist fields.
- End-to-end: verify whitelist does not persist after session close and restart.
- Verify `AgentSession` and `DockerAgentSession` both work with extended `resolveEscalation()`.

## 10. Implementation Plan (Phased PRs)

### Phase 1: Core whitelist module + AgentSession refactor

**Files:**

- New: `src/trusted-process/approval-whitelist.ts`
- New: `test/approval-whitelist.test.ts`
- Modify: `src/trusted-process/policy-types.ts` (add `escalatedRoles` field to `EvaluationResult`)
- Modify: `src/trusted-process/policy-engine.ts` (populate `escalatedRoles` in `evaluateCompiledRules()` and `evaluateStructuralInvariants()`, import `isWithinDirectory` from argument-roles)
- Modify: `src/types/argument-roles.ts` (add `isWithinDirectory`)
- Modify: `src/session/agent-session.ts` (refactor to use `createEscalationWatcher()`)
- New: `test/agent-session-escalation.test.ts` (verify refactored escalation behavior)

**Dependencies:** None.

### Phase 2: IPC protocol extension + proxy/TrustedProcess integration

**Files:**

- Modify: `src/trusted-process/mcp-proxy-server.ts` (widen IPC types, whitelist check, pass `evaluation.escalatedRoles` to candidate extraction)
- Modify: `src/trusted-process/index.ts` (`EscalationResult`, whitelist in `handleToolCall`, pass escalated roles)
- Modify: `src/types/audit.ts` (add whitelist fields)
- Modify: `test/mcp-proxy-server.test.ts`
- New: `test/whitelist-integration.test.ts`

**Dependencies:** Phase 1.

### Phase 3: Session/transport layer

**Files:**

- Modify: `src/escalation/escalation-watcher.ts` (extend `resolve()`)
- Modify: `src/session/types.ts` (extend `EscalationRequest`, `Session.resolveEscalation()`)
- Modify: `src/session/cli-transport.ts` (prefix-based parsing, `/approve+`)
- Modify: `src/session/agent-session.ts` (pass options through)
- Modify: `src/docker/docker-agent-session.ts` (pass options through)

**Dependencies:** Phase 2.

### Phase 4: Mux + escalation listener integration

**Files:**

- Modify: `src/mux/mux-app.ts` (`+` suffix stripping)
- Modify: `src/mux/mux-escalation-manager.ts` (whitelist flag in `resolve()`)
- Modify: `src/escalation/listener-command.ts` (`+` suffix stripping)

**Dependencies:** Phase 3.

### Phase 5: Polish and documentation

- Escalation banner enhancements (show candidates, confirmations).
- Update command help text in all transports.
- Update CLAUDE.md.
- Performance validation (linear scan of small list, expected <1ms).

**Dependencies:** Phase 4.

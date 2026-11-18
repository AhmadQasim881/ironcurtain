# Workflow state completion and recovery

**Status (2026-11-14):** Implemented. The coordinator records workflow state results through the `workflow_commit` tool in `src/trusted-process/workflow-commit-tool.ts`.

An orchestrator-run agent state commits its result through a coordinator-owned virtual tool,
`workflow_commit(invocation, verdict, notes, handoff)` (in Code Mode: `workflow.commit({...})`),
instead of a final-response YAML block. A turn that ends without an accepted call has not
committed: the orchestrator neither parses its prose nor synthesizes a verdict from it.

**The tool** (`src/trusted-process/workflow-commit-tool.ts`). A `ToolCallCoordinator` built with
a `workflowCommit` handler registers the tool on the reserved virtual server `workflow`, merges
its hardcoded annotation (no resource roles) and allow rule (`workflow-commit-allow`, ahead of
compiled rules; the policy-evaluated egress rules, when on, still follow them) into its policy
and into its task scope (`--task-scoped`, see [task-scoped-sessions.md](./task-scoped-sessions.md)),
and keeps both across every `loadPolicy` persona swap. The pipeline bounds and checks the
arguments before policy evaluation (required `invocation` and `verdict`, a one-line verdict of at
most 200 characters, `notes` of at most 16,384 and `handoff` of at most 65,536 characters;
malformed calls are denied as `invalid-arguments`), writes the write-ahead audit record, and
hands the call to the handler in-process. Nothing reaches a backend. A commit whose caller was
cancelled (its Code Mode script ended and the agent was told it failed) is denied as
`call-cancelled` and never reaches the handler, like any other call. A refused commit comes back
to the agent as an error result it can act on in the same turn.

**Invocation binding** (`src/workflow/workflow-commit.ts`). The handler is a
`WorkflowCommitChannel`: one per shared-container bundle (created at mint, handed to
`createDockerInfrastructure`), or one per state for a state that builds its own coordinator
(builtin mode, or a Docker state that owns its container; passed as
`SessionOptions.workflow.workflowCommit`). The orchestrator opens one invocation per agent-state
invocation with a random UUID, puts the id into every prompt of that invocation (first visit,
re-visit, continuation, replacement, artifact retry), and closes it when the invocation ends. A
commit is accepted only for an open invocation that has not committed yet, and only with a
verdict the state routes on when the state has a closed verdict set; the first accepted commit
is final. A drained fan-out lane, a previous visit of the state or a turn that already ended
therefore cannot commit another invocation's result by quoting the id it was given, and a refusal
never reveals the id of the invocation that is open. The id is not a secret from code that shares
the agent's container, though: the agent CLI's transcript (the bind-mounted conversation state)
carries every prompt, so a process left running in a shared container or a sibling fan-out lane
could read and quote it. Such code is already inside the bundle's trust boundary, so the binding
guards against stale and misdirected commits, not against it.

**Protocol selection.** The coordinator calls `attach()` on the channel once it has registered
the tool. The orchestrator uses the commit-tool protocol only for an attached channel, so it
never tells an agent to call a tool its catalog lacks. Every production path attaches (the
default bundle factory, `createDockerInfrastructure` for a state's own container, the builtin
sandbox); a session factory or bundle factory that ignores the channel (test doubles) keeps the
YAML `agent_status` protocol, and so does the `workflow run-state` debugging command.

**Recovery under the commit-tool protocol** (`executeAgentState`):

- After each turn the orchestrator reads the invocation's commit. None means not committed, and
  the agent gets `buildMissingCommitReprompt`: the state has not committed, continue the work if
  any remains, commit when done. It is never told to wrap up. Up to two such continuations run in
  the live conversation (retry reason `missing_commit`), then a routing state gets one fresh
  replacement execution of the same invocation, as before.
- A commit made before the agent CLI failed (`hardFailure`) stands: nothing is re-run, and the
  conversation is rotated so a later `freshSession: false` visit does not resume it. The failed
  turn's text is logged but never handed on.
- So does a commit made before an upstream failure ended the turn (`quotaExhausted` or
  `transientFailure`, for example a 5xx on the agent's closing message), as long as every required
  output exists: the `quota_exhausted` / `transient_failure` entry is still logged, but the run is
  neither stamped nor stopped, and it moves on with the committed verdict. Without a commit, or
  with an output still missing (the turn that would write it could not run against that
  upstream), the run stops resumably as before.
- `notes` becomes the next state's `previousAgentNotes`, and `handoff` its `previousAgentOutput`
  (the final message is used when the commit carries no handoff), so a final message cut short
  after the commit loses nothing.
- The prompts tell the agent that `agent_status` YAML is not read, and map role-prompt wording
  about the status block and its fields onto the tool and its `handoff`.

### Recovery for the YAML protocol

For a state with conditional transitions, the orchestrator first requests the missing status in the current conversation. A fresh executor can then retry with the full prompt. If recovery is exhausted, a configured human-gate error edge pauses the run for review. When the workflow has no such edge, the engine preserves a resumable failed checkpoint.

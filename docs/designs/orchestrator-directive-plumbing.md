# Orchestrator Directive Plumbing

**Status (2026-11-14):** Implemented in `src/workflow/machine-builder.ts` and `src/workflow/prompt-builder.ts`.

A workflow state can pass instructions and a short summary to its successor. For example, after a design review, the reviewer can name the interface that needs a change and use the summary to explain why.

The orchestrator forwards the handoff supplied to `workflow_commit`, falling back to the latest substantive response when the state omits a handoff. The machine builder strips any status block and bounds the text before storing it in `previousAgentOutput`. It retains the notes separately. On a transition to another agent state, the prompt builder includes the preceding state name, the directive text and any notes. If both fields are empty, it omits the section.

When the same state receives a revision request, its prior response appears under **Your Previous Output**. This lets the agent revise its own work in light of the feedback. Durable outputs such as plans and designs still belong in the artifacts declared by the workflow.

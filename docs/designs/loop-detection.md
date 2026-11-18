# Design: Two-Layer Loop Detection & Circuit Breaker

**Status (2026-11-14):** Implemented: `StepLoopDetector` (`src/session/step-loop-detector.ts`, reset at the start of every turn) and `CallCircuitBreaker` (`src/trusted-process/call-circuit-breaker.ts`), owned by the `ToolCallCoordinator`, with a window per workflow fan-out lane.

**Date:** 2026-02-18
**Author:** IronCurtain Engineering

## 1. Problem Statement

Autonomous agents are prone to "infinite loops" -- repetitive behaviors where the agent executes the same actions without making progress. This can manifest as:
- **Stagnation:** Submitting the same code and getting the same result repeatedly.
- **Stuck:** Trying different approaches that all produce the same outcome.
- **Runaway sandbox code:** A single execute_code step that hammers an MCP tool in a tight loop.

The previous approach relied on a blunt `MAX_AGENT_STEPS = 10` that stops valid long-running tasks while failing to catch tight loops early.

## 2. Key Insight

The agent doesn't call tools directly -- it writes programs via `execute_code`. Each step is a compound action. This means loop detection must happen at **two levels**, each optimized for its layer:

1. **Agent level** -- analyzes steps (code + result pairs)
2. **Proxy level** -- rate-limits individual MCP tool calls within a step

## 3. Architecture

### Layer 1: StepLoopDetector (Agent Level)

Lives in `AgentSession`, analyzes each `execute_code` step after execution.

#### 2x2 Progress Matrix

For each step, the detector computes an `approachHash` (from the code) and an `outcomeHash` (from the result), then classifies via:

|                     | **New outcome** | **Repeated outcome** |
|---------------------|-----------------|----------------------|
| **New approach**    | Full progress   | Stuck                |
| **Repeated approach** | World changed | Full stagnation      |

- **Full progress / World changed**: Reset all streaks (agent is making progress)
- **Stuck**: Increment stuck streak, reset stagnation streak
- **Full stagnation**: Increment stagnation streak, reset stuck streak

#### Error and benign outcomes

A repeated outcome means different things depending on what it says. Different code that keeps failing the same way (the same error, the same denied tool call) is the loop the stuck category exists to stop. Ordinary step-by-step work also repeats outcomes: every write in a series returns `null` (UTCP turns code without a `return` into `{ result: null }`), and steps that end in `return 'ok'` all look alike. So `outcomeCarriesError()` sorts each outcome:

- **Error**: the output has a host-side `error` field, a console line starting with `[ERROR]` (an uncaught exception in the sandbox, which is how a denied or failed tool call surfaces, or `console.error`), or a result that is itself an error report (an object with a truthy `error` or `isError: true`, or text that starts like `String(error)`).
- **Benign**: everything else.

Within a stuck streak, the steps with error outcomes are counted against the `stuck` thresholds and all steps against the much higher `benignStuck` thresholds. Benign repeats are still counted, so an agent that keeps failing silently is stopped too, only later. Only the thresholds depend on the classification, so a misjudged outcome is caught sooner or later rather than never.

#### Thresholds

| Condition                           | Warn | Block |
|-------------------------------------|------|-------|
| Stagnation                          | 3    | 5     |
| Stuck (error outcomes, `stuck`)     | 5    | 8     |
| Stuck (any outcome, `benignStuck`)  | 15   | 25    |

- **Warn**: Append guidance message to the tool result (LLM sees it naturally alongside the real result). The benign-stuck warning tells the agent to return a short description of what each step changed when the steps do make progress, which also gives the detector distinct outcomes to see.
- **Block**: Set a flag preventing further code execution for the rest of the turn; the LLM should summarize and stop

#### Scope: one turn

`AgentSession.sendMessage()` calls `reset()` at the start of every turn, user or system. A block therefore lasts for the rest of the turn that caused it, and the streaks and the approach and outcome hashes behind it do not carry over either: a new request starts with a clean slate. Without the reset, one block made every later `execute_code` in an interactive (CLI, web, Signal) session return "LOOP DETECTED", however different the request. Runaway work across turns is bounded by the session's resource budget, not by this detector.

No human escalation.

### Layer 2: CallCircuitBreaker (Proxy Level)

Owned by the `ToolCallCoordinator` (`src/trusted-process/tool-call-coordinator.ts`) and applied in the security pipeline (`src/trusted-process/tool-call-pipeline.ts`); the MCP proxy server relays are pure transports. Protects against runaway sandbox code within a single step.

- **Sliding-window rate limiter**: 20 identical `(tool, argsHash)` calls within a 60-second window triggers denial
- **Per lane**: the window is kept per agent connection (the Code Mode proxy assigns each one a lane), so concurrent workflow fan-out lanes in one shared container do not trip each other; an all-lanes window caps the total at 20 × the coordinator's `maxLanes` (1 outside fan-out bundles)
- Runs **after** policy evaluation so every call is always audited
- Returns an error to sandbox code (propagates as part of the step result)

## 4. Implementation

### Files

- `src/hash.ts` -- Shared hashing utilities (`stableStringify`, `computeHash`)
- `src/session/step-loop-detector.ts` -- `StepLoopDetector` class
- `src/trusted-process/call-circuit-breaker.ts` -- `CallCircuitBreaker` class

### Integration Points

- `src/session/agent-session.ts` -- `StepLoopDetector` wraps the `execute_code` tool
- `src/trusted-process/tool-call-pipeline.ts` -- `CallCircuitBreaker` between policy allow and MCP forwarding (the coordinator in `tool-call-coordinator.ts` owns the instance; `mcp-proxy-server.ts` held it before the coordinator was centralized)
- `src/session/types.ts` -- `loop_detection` diagnostic event variant

### Sequence: Agent Step

```
User (or system) turn
  -> AgentSession.sendMessage() -> loopDetector.reset()

Agent writes code
  -> AgentSession.execute_code()
    -> Check isBlocked() -- if blocked, return error immediately
    -> Sandbox.executeCode(code, { signal, timeoutMs })
    -> truncateExecutionOutput(logs, result) -- console and result share one
       size budget, so the hash below never copies an unbounded output
    -> analyzeStep(code, result)
      -> Classify via 2x2 matrix
      -> Update streaks (stuck: count error outcomes separately)
      -> If warn: append warning to output
      -> If block: set blocked flag (until the next turn), append warning to output
    -> Return output to LLM
```

### Sequence: Proxy Tool Call

```
Sandbox MCP call
  -> PolicyEngine.evaluate()
  -> CallCircuitBreaker.check(tool, args)
    -> If over threshold: deny with error
  -> Forward to real MCP server
```

## 5. Hashing Strategy

Both layers use the same hashing:
- `stableStringify(value)`: Deterministic JSON with sorted keys; otherwise exactly `JSON.stringify` (undefined, function and symbol members omitted, `null` in arrays, `toJSON` honoured, a `TypeError` for BigInt and cycles), so its output always parses
- `computeHash(value)`: SHA-256 of `stableStringify` output

This ensures `{a:1, b:2}` and `{b:2, a:1}` produce identical hashes.

## 6. References

- OpenClaw Loop Detection (`src/agents/tool-loop-detection.ts`)
- IronCurtain policy engine (`src/trusted-process/policy-engine.ts`)

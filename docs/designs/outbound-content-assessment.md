# Design: Outbound Content Assessment (`assess` rules)

**Status (2026-11-14):** Implemented: the deterministic checks are opt-in (`contentAssessment.enabled`), and the LLM intelligibility check sits behind a separate flag (`contentAssessment.llmCheck`), default off.

**Date:** 2026-11-11

## 1. Problem

Policy rules decide _where_ a tool call may send content: which repository an agent may comment on, which sites it may fetch, which recipients it may mail. They never look at _what_ is sent. An agent that is allowed to post to a "safe" place can therefore smuggle data out through it: a base64 blob in a GitHub comment, a hex string in the query of a fetch to an allowed site, a rot13'd secret in a commit message that a human later pushes. Nothing detected that.

## 2. Overview

- A compiled rule can say `then: "assess"`: allow the call, subject to the outbound content assessment of its outbound-content arguments.
- The assessment is opt-in (`contentAssessment.enabled`, default `false`). It runs deterministic detectors (encoded blobs, high-entropy strings, ciphers, invisible characters, size). An optional LLM intelligibility check sits behind its own flag (`contentAssessment.llmCheck`, default `false`).
- A verdict maps to **allow or escalate, never deny, and never allow on error**. Content that does not pass, and an assessment that fails, escalate the call to a human; the escalation is human-only.
- Verdicts are cached per session by a keyed digest of the assessed values, and recorded on the call's audit entries.
- The compiler emits `assess` for outbound-channel tools, deterministically.

Code: `src/trusted-process/assessment.ts` (handler, cache, LLM check, verdict mapping), `src/trusted-process/assessment-detectors.ts` (detectors), `src/trusted-process/assessment-config.ts` (session setup from the user config), `src/trusted-process/outbound-rules.ts` (allow -> assess), the `assess` outcome in `src/trusted-process/policy-engine.ts`, the pipeline step in `src/trusted-process/tool-call-pipeline.ts`.

## 3. Outbound-content roles

`RoleDefinition.outboundContent` (`src/types/argument-roles.ts`) marks the roles whose values leave the machine as content other people or systems read. Only arguments with these roles are assessed.

| Role             | Kind   | Servers                  | Covers                                                                                                                      |
| ---------------- | ------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `outbound-text`  | `text` | github, google-workspace | Comment, review, issue and PR bodies and titles, repository descriptions, message subjects, share notifications, event text |
| `email-body`     | `text` | google-workspace         | Email bodies                                                                                                                |
| `commit-message` | `text` | git, github              | Commit messages and titles, annotated tag messages                                                                          |
| `fetch-url`      | `url`  | fetch                    | The host labels, credentials, path segments, query and fragment of a fetched URL                                            |

`outbound-text` is new. It is opaque and not a resource identifier, so policy evaluation, the approval whitelist and the auto-approver ignore its values. Deliberately left out: search queries (the search provider reads them, not an attacker), file contents pushed to a repository (code and lockfiles legitimately carry base64 and hashes), branch names and recipients, and custom HTTP request headers (`http_fetch.headers`). The headers argument holds an object, and any role on an argument holding an object or a nested array escalates every call that passes one to a human (`structural-nested-argument-escalate`, human-only; see [argument-role-registry.md](argument-role-registry.md)), so a role there would change decisions while the assessment is off: a fetch with an `Accept` header would need a human, and the read-only policy's dynamic-list resolution, which has no human to ask, could no longer send headers at all. The role guidance therefore keeps `outbound-text` off object arguments, and the fetch server is not offered the role.

The bundled annotations were hand-edited to assign these roles (GitHub comment/issue/PR text, GitHub commit messages, Gmail subjects, Drive share messages, calendar event text, `git_tag.message`) and re-stamped with `scripts/stamp-package-annotations.ts`; the provenance of the bundled policies was re-stamped to record them (`scripts/stamp-policy-provenance.ts`).

## 4. The `assess` outcome

`CompiledRule.then` is a `RuleOutcome`: `allow | assess | escalate` (and `deny`, which compiled rules do not use). The engine evaluates `assess` as an allow carrying `EvaluationResult.assessContent`:

- Per-role combination ranks it between allow and escalate: `deny > escalate > assess > allow`, so a call with one assessed role and one plain-allowed role is still assessed, and an escalation on any role wins.
- An unknown outcome (a hand-edited or newer policy) denies. The runtime loaders (`src/types/policy-schema.ts`) accept `assess` as a rule outcome and refuse a catch-all `assess` rule like a catch-all allow.
- Every check of what a policy grants treats `assess` as an allow (`ruleOutcomeAllows` in `src/types/policy-schema.ts`): the policy lint (`src/pipeline/policy-lint.ts`), the persona broad-policy validator and rule delta (`src/persona/`), and the list resolver's tool exposure. The pipeline converts allows before it lints and validates the merged policy, so a check that looked for `allow` alone would pass every outbound-channel allow unchecked.
- `assessContent` is settled from the call's **resolved** annotation (`settleContentAssessment`), so the runtime, not the static pass, has the last word: an allow is assessed exactly when its resolved arguments carry outbound content, however it was allowed. That keeps the flag off allows that send nothing (a whole-server `assess` rule allowing `get_me`), and puts it on allows the static pass could not convert — a sandbox-containment allow (containment is about paths and says nothing about a commit message written in the sandbox), and a plain allow of a call whose outbound role a `when` clause adds only for some modes (the static pass judges on default roles, so it would miss it).

### Compilation

The compiler model never sees `assess`; it keeps emitting allow/escalate, and its repair rounds and the verifier work with those. `applyOutboundAssessment` turns every compiled `allow` that can match a tool with an outbound-content argument (judged on the server, tool and role conditions and the tools' default roles) into `assess`:

- the pipeline applies it to every server's rules, fresh or cached, right before they are merged into `compiled-policy.json`, so the artifact shows which rules are assessed;
- the `PolicyEngine` applies it again when it loads any policy, so a policy compiled before `assess` existed (the user's, a persona's, a job's) behaves the same without a recompile.

Because an `assess` rule allows exactly like `allow` when the assessment is off, the conversion never changes a decision by itself. The bundled `generated/` and `generated-readonly/` policies were converted the same way (the fetch allows for news and development sites, and the git commit/merge/tag allows for `~/Downloads`).

## 5. When a call is assessed

With the assessment on (the coordinator holds a `ContentAssessor`), the pipeline assesses a call's outbound content, in the form the transport sends it, when:

1. the policy allowed it with `assessContent` (an `assess` rule, or a sandbox allow of outbound content); or
2. the policy escalated it. A whitelist pattern or the auto-approver could otherwise approve content no human read.

Nothing is assessed for a deny, a plain allow, a trusted server, or a call without outbound-content values.

| Policy decision  | Verdict `pass` | Verdict `flagged` or `error`                                                                                           |
| ---------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| allow (`assess`) | allow          | escalate under `content-assessment-escalate`, human-only, no escalated resource role (no whitelist candidate, no root) |
| escalate         | escalate as is | escalate under the same rule, now human-only, the finding appended to the reason                                       |

Human-only means: the auto-approver is not consulted, no whitelist pattern matches or is offered, and front-ends leave the call out of "approve all". Without an escalation handler the call is denied, like any escalation. The escalation reason names the argument and the detector's fixed phrase and counts, never the content.

The assessment acts on the policy engine's result. The sequence-aware taint escalation (`taint-policy.ts`, opt-in) is applied to the assessed result afterwards, and before anything else (the whitelist, the auto-approver, a human) looks at the decision: the intelligibility check can wait on its model, and reading the session's taint after that wait means a taint source dispatched in the meantime (a MITM egress decision takes no call mutex) still gates the call. The order costs no coverage: an allow that carries outbound content always requires the assessment, so a sink the taint escalation would gate is assessed on the policy's own allow or escalation.

## 6. Deterministic checks

`detectOutboundContent` runs over all values of one call; values of one argument are judged together, and the base64 and hex totals of all arguments once more for the whole call. All scans are linear and bounded.

| Check               | Flags                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `base64`            | Base64, base64url or base32 runs that look random (class transitions, entropy): one of 40+ characters (30 bytes), or 64+ in total                                  |
| `hex`               | Hex runs with digits and letters: one of 64+ digits (32 bytes), or 96+ in total. A 40-digit commit hash, or two, passes; a SHA-256 digest is flagged               |
| `byte-sequence`     | 32+ bytes written one by one: `de ad be ef`, `0xde, 0xad`, `\xde\xad`, `[222, 173, ...]`, or 32+ percent-escapes in the parts of a URL that do not decode to UTF-8 |
| `high-entropy`      | Whitespace-free printable ASCII tokens of 48+ characters with entropy of 5.3+ bits/char (ascii85, base91, printable ciphertext)                                    |
| `rot-n`, `reversed` | Text whose words read as common English only after a Caesar shift (rot13 included) or reversal                                                                     |
| `hidden-characters` | 16+ invisible format characters (zero-width, tags, variation selectors), ZWJ and U+FE0F excepted                                                                   |
| `size`              | Text over 32,768 characters, URLs over 2,048, or more than 262,144 characters in one call                                                                          |
| `encoded-ratio`     | The size ratio: 32+ characters of base64-like tokens making up at least half of a text (a key alone in a short message)                                            |

Calibration: on 4,550 comment-sized chunks of this repository's documentation 0.15% were flagged, all SHA-256 digests and one example key; prose in several languages, CJK text, emoji, markdown, code, stack traces, UUIDs, commit hashes and typical news, documentation and GitHub URLs pass.

## 7. LLM intelligibility check (optional)

With `contentAssessment.llmCheck` on, content that passed the deterministic checks goes to a cheap model (`contentAssessment.llmModelId`, host-model role `contentAssessment`), which answers `intelligible`, `obfuscated` or `uncertain`. Only `intelligible` passes.

- The content is JSON-encoded inside a delimited block that the system prompt declares to be untrusted data; instructions inside it are a reason to answer `obfuscated`.
- It runs only after the deterministic checks passed and can only escalate, so prompt injection can at worst make the outcome as permissive as without the check.
- Content over 16,000 characters is flagged without asking. A model error, an invalid answer, a 15 s timeout, or a model that could not be built (the session starts with a warning) is an `error` verdict, so the call escalates.
- The check runs inside the coordinator's call mutex: other tool calls of the session wait for it. That latency is the cost the owner accepted for the check.

## 8. Cache and audit

`ContentAssessor` keeps up to 512 verdicts per session (oldest evicted), keyed by an HMAC-SHA256 of the assessed values and the settings under a random per-session key. Errors are not cached. The cache survives policy hot-swaps: a verdict depends on the content and the settings, not on the policy.

Every audit entry of an assessed call carries `contentAssessment` (`src/types/audit.ts`): the verdict, the checks that ran, the findings (argument, check, fixed-phrase detail), the assessed arguments, the digest and `cached`. Never the content. The keyed digest correlates repeated content within a session but cannot be used to guess redacted content by hashing candidates.

## 9. Configuration

```json
{
  "contentAssessment": {
    "enabled": false,
    "llmCheck": false,
    "llmModelId": "anthropic:claude-haiku-4-5"
  }
}
```

The block is backfilled with these defaults and is strict (a misspelled key is an error, not a silently disabled check). `llmCheck` takes effect only with `enabled`. `ironcurtain config` -> Security toggles both and picks the model.

## 10. Limitations

- Per-call heuristics. Data spread thinly over many calls, hidden in word choice, or encoded in ways the detectors do not know passes the deterministic checks; the LLM check and human review cover more, not everything.
- File contents pushed to a repository and search queries are not assessed (see section 3).
- Only MCP tool calls are assessed. Requests an agent in Docker Agent Mode sends through the MITM proxy (provider APIs, package registries, passthrough domains) are governed by the proxy's own controls, not by this assessment.
- The bundled annotations for github and google-workspace were hand-edited without a fresh `annotate-tools` run against the live servers; their `inputHash` still reflects the previous annotation prompt, so the next `annotate-tools` run re-annotates them.
- Thresholds trade misses for false positives: a single SHA-256 digest in a message escalates, a 64-digit hex secret split into two tokens does not.
- Annotations for servers outside the bundled ones need the outbound roles from `annotate-tools` (the annotation prompt now offers `outbound-text` for github and google-workspace).
- Custom HTTP request headers are not assessed (section 3). Assessing them needs roles that address the values inside an object argument (sub-path roles), or a decision to exempt content-only roles, whose values no policy check reads, from the nested-argument escalation.

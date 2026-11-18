## Summary

<!-- What does this PR do and why? -->

## Security Impact

<!-- Required for changes to the trusted process, policy engine, sandbox, or MCP proxy. Delete this section for docs-only or test-only changes. -->

- [ ] Changes the policy evaluation logic or rule format
- [ ] Modifies the sandbox boundary or V8 isolate setup
- [ ] Adds or changes MCP server spawning, IPC, or credential handling
- [ ] Introduces new tool argument roles or path resolution logic
- [ ] Changes files under `src/docker/` or `src/trusted-process/`: I checked `docs/SECURITY_CONCERNS.md` and `SANDBOXING.md` against the change and corrected every statement it makes stale (a document's "Last verified against code" line moves only when the whole document is re-checked)
- [ ] None of the above

## Test plan

<!-- How did you verify this works? -->

- [ ] Existing tests pass (`npm test`)
- [ ] Added new tests for the change
- [ ] Manual testing (describe below)

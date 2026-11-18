#!/usr/bin/env bash
# Run the root test suite (with a bounded retry for a known teardown flake),
# then the web-ui workspace suite.
#
# When any arg is passed (e.g., `npm test -- test/foo.ts`), forward it to the
# root `vitest run`, skip the retry logic, and skip the web-ui sub-suite — a
# targeted run against a specific file is almost never intended to also run the
# unrelated web-ui tests. Use `npm run test:web-ui` to target the web-ui suite.
#
# ── Teardown-flake retry ──────────────────────────────────────────────────
# On macOS CI a vitest `forks` worker occasionally dies at end-of-run
# ("Worker exited unexpectedly" / "Tests closed successfully but something
# prevents Vite server from exiting"), failing the run even though every test
# passed. The root cause is unresolved — ruled out so far: the open-files limit
# (runners sit at 10240, not starved) and plain handle leaks (closing/unref-ing
# them didn't help). See issue #363.
#
# A worker that dies mid-file looks almost the same: vitest prints no
# "N failed", because the tests after the crash point never ran (BLD-3). So a
# worker death counts as the flake only when it is proven harmless. Each
# attempt runs with scripts/vitest-run-ledger.ts, a reporter that records every
# planned test file, the final state of every file and test, and every
# unhandled error, and scripts/classify-vitest-run.ts labels the attempt:
#
#   pass        vitest exited 0.
#   fail        a failed test or file, an unhandled error other than a worker
#               exit, or a non-zero exit with no worker death. Never retried:
#               it propagates immediately.
#   flake       workers exited unexpectedly, but every planned file and test
#               finished and none failed. Retried; if the final attempt is
#               still a flake, the run passes with a loud warning, since
#               failing a run in which every test ran and passed is worse than
#               the flake it papers over.
#   incomplete  a worker died and some planned file or test has no final
#               result (a crash mid-file or while importing), or no ledger was
#               written. Retried, but the run fails if the final attempt is
#               still incomplete: tests that never ran cannot pass.
#
# So the root suite passes only when its last attempt ran every planned test
# to completion with zero failures.
set -uo pipefail

# Targeted runs (any arg): original behavior, no retry, no web-ui sub-suite.
if [ $# -ne 0 ]; then
  exec npx vitest run "$@"
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

MAX_ATTEMPTS=3

# Naming a reporter replaces vitest's own choice (`agent` under an AI coding
# agent, otherwise `default`, plus `github-actions` on GitHub), so keep that
# choice and add the ledger reporter to it.
base_reporter=default
if node --input-type=module -e 'const { isAgent } = await import("std-env"); process.exit(isAgent ? 0 : 1);' 2>/dev/null; then
  base_reporter=agent
fi
REPORTERS=(--reporter="$base_reporter")
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  REPORTERS+=(--reporter=github-actions)
fi
REPORTERS+=(--reporter=./scripts/vitest-run-ledger.ts)

# Explicit template: BSD mktemp (macOS) can require one; harmless on GNU.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ic-vitest-run.XXXXXX")" || exit 1
trap 'rm -rf "$WORK_DIR"' EXIT

# Runs the root suite once; sets VERDICT to pass | fail | flake | incomplete.
VERDICT=""
run_root_once() {
  local log="$WORK_DIR/attempt-$1.log"
  local ledger="$WORK_DIR/attempt-$1.ledger.json"
  IC_VITEST_LEDGER="$ledger" npx vitest run "${REPORTERS[@]}" 2>&1 | tee "$log"
  local ec="${PIPESTATUS[0]}"
  if [ "$ec" -eq 0 ]; then
    VERDICT=pass
    return
  fi
  # The classifier prints the verdict on stdout and its reasons on stderr. It
  # runs from node_modules, not through npx: a wrapper on PATH (the release
  # workflow's safe-chain shims, say) may write to stdout and corrupt the
  # verdict. Anything unexpected is a failure.
  if ! VERDICT="$(./node_modules/.bin/tsx scripts/classify-vitest-run.ts --exit-code "$ec" --ledger "$ledger" --log "$log")"; then
    VERDICT=fail
  fi
  case "$VERDICT" in
    fail | flake | incomplete) ;;
    *) VERDICT=fail ;;
  esac
}

attempt=1
while :; do
  run_root_once "$attempt"
  case "$VERDICT" in
    pass)
      break
      ;;
    fail)
      exit 1
      ;;
    flake)
      if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
        echo "::warning::vitest teardown flake persisted across ${MAX_ATTEMPTS} attempts; the last attempt ran every planned test to completion with zero failures, so treating as success (see scripts/test.sh / issue #363)"
        break
      fi
      echo "::warning::vitest teardown flake on attempt ${attempt}/${MAX_ATTEMPTS} (every test finished and passed, but a worker died); retrying the root suite"
      ;;
    incomplete)
      if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
        echo "::error::vitest worker died and test results are missing on the final attempt (${attempt}/${MAX_ATTEMPTS}); tests that never ran cannot pass, so failing (see scripts/test.sh / issue #363)"
        exit 1
      fi
      echo "::warning::vitest worker died on attempt ${attempt}/${MAX_ATTEMPTS} and some tests have no result; retrying the root suite"
      ;;
  esac
  attempt=$((attempt + 1))
done

npm test -w packages/web-ui

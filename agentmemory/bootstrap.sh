#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/../toolkit/env.sh"
NODE_BIN="${AGENTMEM_NODE:-$(command -v node || true)}"
NPM_BIN="${AGENTMEM_NPM:-$(command -v npm || true)}"
PYTHON_BIN="${AGENTMEM_PYTHON:-$(command -v python3 || true)}"

[[ -n "$NODE_BIN" ]] || { printf 'Node.js 20 or newer is required.\n' >&2; exit 2; }
[[ -n "$NPM_BIN" ]] || { printf 'npm is required.\n' >&2; exit 2; }
[[ -n "$PYTHON_BIN" ]] || { printf 'Python 3.10 or newer is required.\n' >&2; exit 2; }

node_major="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 20 )) || { printf 'Node.js 20 or newer is required; found %s.\n' "$("$NODE_BIN" --version)" >&2; exit 2; }

if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'; then
  printf 'Python 3.10 or newer is required; found %s.\n' "$("$PYTHON_BIN" --version 2>&1)" >&2
  exit 2
fi

"$NPM_BIN" --prefix "$ROOT/agentmemory-dist" ci --omit=dev --omit=optional --no-audit --no-fund
if command -v uv >/dev/null 2>&1; then
  uv venv --clear --python "$PYTHON_BIN" "$ROOT/agentmem-research/.venv"
  uv pip install --python "$ROOT/agentmem-research/.venv/bin/python" \
    -e "$ROOT/agentmem-research[mcp]"
else
  "$PYTHON_BIN" -m venv --clear "$ROOT/agentmem-research/.venv"
  "$ROOT/agentmem-research/.venv/bin/python" -m pip install -e "$ROOT/agentmem-research[mcp]"
fi

printf '\nAgentMemory runtimes are ready.\n'
printf 'Node: %s\n' "$("$NODE_BIN" --version)"
printf 'Python: %s\n' "$("$ROOT/agentmem-research/.venv/bin/python" --version)"

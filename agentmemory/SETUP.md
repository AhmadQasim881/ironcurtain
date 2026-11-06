# AgentMemory Setup Guide

Two MCP servers + a background daemon + Claude Code hooks.

## Prerequisites

- Linux or macOS
- Node.js 20 or newer, with npm
- Python 3.10+
- Python's `venv` module
- Claude Code CLI only if you want the Claude hooks

## Directory Structure

```
agentmemory/
  bootstrap.sh              # installs the Node and Python dependencies
  agentmemory-dist/          # Node.js runtime (daemon + MCP + hooks + Codex plugins)
  agentmem-research/         # Python evidence/hypothesis MCP (source, no venv)
  mcp.json.template          # MCP config — copy to your project as .mcp.json
  claude-settings.json.template  # Claude hooks — merge into .claude/settings.json
  agentmemory.service.template   # Systemd unit — optional, for persistent daemon
  SETUP.md                   # This file
```

## Step 1: Bootstrap both runtimes

Run this as your normal user from the copied `agentmemory/` directory. Do not
copy an existing `node_modules/` directory or Python virtual environment from
another machine; both are recreated locally.

```bash
cd /absolute/path/to/agentmemory
./bootstrap.sh
```

The bootstrap uses the exact production dependency lock in
`agentmemory-dist/package-lock.json` and installs the Python MCP extra into
`agentmem-research/.venv`. It omits the large optional local-embedding and
language-segmentation packages. Install those exact optional dependencies only
when you need those features:

```bash
npm --prefix agentmemory-dist ci --omit=dev --no-audit --no-fund
```

Verify the install:

```bash
node agentmemory-dist/cli.mjs --version
agentmem-research/.venv/bin/python -m unittest discover \
  -s agentmem-research/tests
```

## Step 2: Start the AgentMemory daemon

```bash
# Pick where agentmemory stores its data
export AGENTMEMORY_DATA_DIR="$HOME/.agentmemory-data"

# The first start may download or configure the pinned iii engine.
node agentmemory-dist/cli.mjs

# Or install as systemd service (edit the template first):
#   - Replace WorkingDirectory, ExecStart, ExecStop paths
#   - Replace AGENTMEMORY_DATA_DIR
#   - Replace User/Group
#   - Replace /usr/bin/node if `command -v node` prints another path
sudo cp agentmemory.service.template /etc/systemd/system/agentmemory.service
sudo systemctl daemon-reload
sudo systemctl enable --now agentmemory
```

The daemon listens on port 3111.

## Step 3: Set up agentmem-research manually, if needed

The bootstrap already performs these steps. To rebuild only the Python
environment:

```bash
cd agentmem-research/
python3 -m venv --clear .venv
source .venv/bin/activate
python -m pip install -e ".[mcp]"
```

## Step 4: Configure MCP for your project

Copy `mcp.json.template` to your project root as `.mcp.json` and replace:

- `$PROJECT_DIR` → your project's absolute path
- `$INSTALL_DIR` → the absolute path to this `agentmemory/` folder
- `$NODE_BINARY` → the absolute path printed by `command -v node`
- `$HOME` → your home directory

Keep the memory database outside this tools directory when you plan to share or
version the tools. Start the daemon before connecting the `agentmemory` MCP
server.

## Step 5: Configure Claude Code hooks

Merge `claude-settings.json.template` into your project's `.claude/settings.json`.
Replace `$INSTALL_DIR` and `$HOME` with real paths.

## Step 6: Codex integration

Pre-built Codex plugins are in `agentmemory-dist/plugins/`:

- `agentmemory-codex-local/` — local memory plugin
- `agentmemory-codex-review/` — code review plugin  
- `agentmemory-codex-skills/` — skills plugin
- `.zip` bundles ready to install

The upstream Apache-2.0 license text is preserved as `LICENSE` in each unpacked
plugin directory and inside each plugin ZIP.

## What each piece does

| Component | Role |
|-----------|------|
| `bootstrap.sh` | Recreates the local Node dependencies and Python virtual environment |
| `agentmemory-dist/cli.mjs` | Background daemon — stores memories, runs on port 3111 |
| `agentmemory-dist/standalone.mjs` | MCP stdio bridge — Claude Code connects through this |
| `agentmemory-dist/hooks/` | Claude Code lifecycle hooks (session start/end, tool use tracking) |
| `agentmem-research/` | Evidence-based research MCP — hypotheses, validation, flow chains |
| Codex plugins | Install into OpenAI Codex for the same memory capabilities |

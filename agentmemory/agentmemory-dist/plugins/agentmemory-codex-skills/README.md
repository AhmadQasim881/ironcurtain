# Agent Memory skills for Codex

This package carries the 17 Agent Memory skills and no MCP server or lifecycle hooks, so it passes the public directory's skills-only upload path.

The skills call the `memory_*` tools of a running Agent Memory daemon. Install and wire it once:

```bash
npm install -g @agentmemory/agentmemory
agentmemory
agentmemory connect codex
```

`connect codex` registers the local MCP server in `~/.codex/config.toml`. Add `--with-hooks` for automatic capture (trust the hooks in Codex before expecting events). Basic keyword recall needs no model key; embeddings and model-based features are configured in `~/.agentmemory/.env`.

Source and documentation: https://github.com/rohitg00/agentmemory

/**
 * Registry of known agent adapters.
 *
 * New agents are added by implementing AgentAdapter and registering here.
 * The registry is a simple Map -- no dynamic loading or plugin system.
 *
 * One adapter instance serves every session of the process (the daemon, the
 * Signal bot and the web UI run many sessions in one process). Adapters
 * therefore take no configuration when they are created: every
 * session-specific value (provider profile, agent model, Goose provider and
 * model) is read from the per-session `IronCurtainConfig` or the
 * `buildCommand` options at call time.
 */

import type { AgentAdapter, AgentId } from './agent-adapter.js';

const registry = new Map<AgentId, AgentAdapter>();

export function registerAgent(adapter: AgentAdapter): void {
  if (registry.has(adapter.id)) {
    throw new Error(`Agent adapter already registered: ${adapter.id}`);
  }
  registry.set(adapter.id, adapter);
}

export function getAgent(id: AgentId): AgentAdapter {
  const adapter = registry.get(id);
  if (!adapter) {
    const available = [...registry.keys()].join(', ');
    throw new Error(`Unknown agent: ${id}. Available: ${available || 'none'}`);
  }
  return adapter;
}

export function listAgents(): readonly AgentAdapter[] {
  return [...registry.values()];
}

/**
 * Ensures all built-in agent adapters are registered. Safe to call
 * multiple times -- skips adapters that are already registered. Takes no
 * config: whichever caller registers first (`--list-agents`, the first-start
 * wizard, a daemon's first session) cannot fix any session's settings.
 */
export async function registerBuiltinAdapters(): Promise<void> {
  if (!registry.has('claude-code' as AgentId)) {
    const { createClaudeCodeAdapter } = await import('./adapters/claude-code.js');
    const claudeCodeAdapter = createClaudeCodeAdapter();
    registry.set(claudeCodeAdapter.id, claudeCodeAdapter);
  }

  if (!registry.has('goose' as AgentId)) {
    const { createGooseAdapter } = await import('./adapters/goose.js');
    const gooseAdapter = createGooseAdapter();
    registry.set(gooseAdapter.id, gooseAdapter);
  }

  if (!registry.has('codex' as AgentId)) {
    const { createCodexAdapter } = await import('./adapters/codex.js');
    const codexAdapter = createCodexAdapter();
    registry.set(codexAdapter.id, codexAdapter);
  }
}

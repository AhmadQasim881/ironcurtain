import "node:module";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { createHash, randomUUID } from "node:crypto";
import { isMap, isSeq, parseDocument } from "yaml";
import JSON5 from "json5";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region src/cli/connect/guidelines.ts
const START = "<!-- agentmemory:start -->";
const END = "<!-- agentmemory:end -->";
const GUIDELINE_BODY = `## Agent memory (agentmemory)

You have persistent long-term memory via the agentmemory MCP server. Tools: \`memory_recall\`, \`memory_smart_search\`, \`memory_save\`, \`memory_sessions\`.

- At the START of a task, call \`memory_recall\` (or \`memory_smart_search\`) with the task context to load relevant past decisions, fixes, and preferences before asking the user to repeat anything.
- When you learn something durable (a decision, a fix, a gotcha, a user preference, a project convention), call \`memory_save\` to persist it.
- Prefer recalling over re-deriving, and save concise reusable facts rather than transcripts.`;
function guidelineTargets(home = homedir()) {
	return {
		cursor: {
			projectPath: join(".cursor", "rules", "agentmemory.mdc"),
			format: "mdc",
			scope: "project",
			source: "https://cursor.com/docs/rules"
		},
		cline: {
			projectPath: join(".clinerules", "agentmemory.md"),
			format: "rule",
			scope: "project",
			source: "https://docs.cline.bot/customization/cline-rules"
		},
		continue: {
			projectPath: join(".continue", "rules", "00-agentmemory.md"),
			format: "rule",
			scope: "project",
			source: "https://docs.continue.dev/customize/deep-dives/rules"
		},
		zed: {
			globalPath: join(home, ".config", "zed", "AGENTS.md"),
			projectPath: "AGENTS.md",
			format: "block",
			scope: "global",
			source: "https://zed.dev/docs/ai/instructions"
		},
		warp: {
			projectPath: "AGENTS.md",
			format: "block",
			scope: "project",
			source: "https://docs.warp.dev/agent-platform/capabilities/rules"
		},
		kiro: {
			globalPath: join(home, ".kiro", "steering", "agentmemory.md"),
			projectPath: join(".kiro", "steering", "agentmemory.md"),
			format: "steering",
			scope: "global",
			source: "https://kiro.dev/docs/steering"
		},
		"gemini-cli": {
			globalPath: join(home, ".gemini", "GEMINI.md"),
			projectPath: "GEMINI.md",
			format: "block",
			scope: "global",
			source: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md"
		},
		qwen: {
			globalPath: join(home, ".qwen", "QWEN.md"),
			projectPath: "QWEN.md",
			format: "block",
			scope: "global",
			source: "https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/memory.md"
		},
		opencode: {
			globalPath: join(home, ".config", "opencode", "AGENTS.md"),
			projectPath: "AGENTS.md",
			format: "block",
			scope: "global",
			source: "https://opencode.ai/docs/rules"
		},
		droid: {
			globalPath: join(home, ".factory", "AGENTS.md"),
			projectPath: "AGENTS.md",
			format: "block",
			scope: "global",
			source: "https://docs.factory.ai/cli/configuration/agents-md"
		},
		antigravity: {
			globalPath: join(home, ".gemini", "GEMINI.md"),
			projectPath: join(".agents", "rules", "agentmemory.md"),
			format: "block",
			scope: "global",
			source: "https://antigravity.google/docs/rules-workflows"
		},
		"antigravity-cli": {
			globalPath: join(home, ".gemini", "GEMINI.md"),
			projectPath: join(".agents", "rules", "agentmemory.md"),
			format: "block",
			scope: "global",
			source: "https://antigravity.google/docs/rules-workflows"
		},
		"copilot-cli": {
			globalPath: join(home, ".copilot", "copilot-instructions.md"),
			projectPath: join(".github", "copilot-instructions.md"),
			format: "block",
			scope: "global",
			source: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions"
		}
	};
}
function renderDedicated(format) {
	if (format === "mdc") return `---\ndescription: agentmemory long-term memory usage\nalwaysApply: true\n---\n\n${GUIDELINE_BODY}\n`;
	if (format === "steering") return `---\ninclusion: always\n---\n\n${GUIDELINE_BODY}\n`;
	return `${GUIDELINE_BODY}\n`;
}
function upsertBlock$1(existing) {
	const block = `${START}\n${GUIDELINE_BODY}\n${END}`;
	const startIdx = existing.indexOf(START);
	const endIdx = existing.indexOf(END);
	if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) return existing.slice(0, startIdx) + block + existing.slice(endIdx + 24);
	if (startIdx !== -1 || endIdx !== -1) return existing;
	return `${existing}${existing.length === 0 || existing.endsWith("\n") ? "" : "\n"}${existing.length === 0 ? "" : "\n"}${block}\n`;
}
function writeGuideline(agentName, opts = { cwd: process.cwd() }) {
	const target = guidelineTargets(opts.home ?? homedir())[agentName];
	if (!target) return { kind: "no-target" };
	const path = target.globalPath ?? join(opts.cwd, target.projectPath);
	const dedicated = target.format !== "block";
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	const next = dedicated ? renderDedicated(target.format) : upsertBlock$1(existing);
	if (existing === next) return {
		kind: "unchanged",
		path,
		scope: target.scope
	};
	if (opts.dryRun) return {
		kind: "would-write",
		path,
		scope: target.scope
	};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, next, "utf8");
	return {
		kind: "written",
		path,
		scope: target.scope,
		source: target.source
	};
}
//#endregion
//#region src/cli/connect/util.ts
const AGENTMEMORY_MCP_BLOCK = {
	command: "npx",
	args: ["-y", "@agentmemory/mcp"],
	env: {
		AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
		AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
		AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}"
	}
};
const AGENTMEMORY_COPILOT_MCP_BLOCK = {
	type: "local",
	...process.platform === "win32" ? {
		command: process.env["ComSpec"] || process.env["COMSPEC"] || "cmd.exe",
		args: [
			"/d",
			"/s",
			"/c",
			"npx",
			"-y",
			"@agentmemory/mcp"
		]
	} : {
		command: "npx",
		args: ["-y", "@agentmemory/mcp"]
	},
	env: {
		AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
		AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
		AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}"
	},
	tools: ["*"]
};
function backupsDir() {
	return join(homedir(), ".agentmemory", "backups");
}
function ensureBackupsDir() {
	const dir = backupsDir();
	mkdirSync(dir, { recursive: true });
	return dir;
}
function timestampSlug() {
	return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
}
function backupFile(sourcePath, agent, ext = "json") {
	ensureBackupsDir();
	const stamp = timestampSlug();
	const target = join(backupsDir(), `${agent}-${stamp}.${ext}`);
	copyFileSync(sourcePath, target);
	return target;
}
function readJsonSafe(path) {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}
function writeJsonAtomic(path, value) {
	writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
function writeTextAtomic(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}
function logInstalled(label, target) {
	p.log.success(`${label} → wired into ${target}`);
}
function logAlreadyWired(label, target) {
	p.log.info(`${label} already wired in ${target} (use --force to re-install)`);
}
function logBackup(target) {
	p.log.info(`Backup: ${target}`);
}
//#endregion
//#region src/cli/connect/json-mcp-adapter.ts
function entryMatches$3(entry) {
	if (!entry || typeof entry !== "object") return false;
	const e = entry;
	if (e["command"] !== "npx") return false;
	return (Array.isArray(e["args"]) ? e["args"] : []).includes("@agentmemory/mcp");
}
function createJsonMcpAdapter(config) {
	const wrapperKey = config.wrapperKey ?? "mcpServers";
	return {
		name: config.name,
		displayName: config.displayName,
		category: config.category ?? "mcp",
		...config.docs !== void 0 && { docs: config.docs },
		...config.protocolNote !== void 0 && { protocolNote: config.protocolNote },
		detect() {
			return existsSync(config.detectDir);
		},
		async install(opts) {
			const existing = readJsonSafe(config.configPath);
			const next = existing ? { ...existing } : {};
			const servers = { ...next[wrapperKey] ?? {} };
			const alreadyHas = entryMatches$3(servers["agentmemory"]);
			if (alreadyHas && !opts.force) {
				logAlreadyWired(config.displayName, config.configPath);
				if (opts.withHooks && config.installHooks) {
					const hookResult = config.installHooks(opts);
					if (hookResult.kind === "skipped") p.log.warn(`${config.displayName} hooks skipped: ${hookResult.reason}.`);
				}
				return {
					kind: "already-wired",
					mutatedPath: config.configPath
				};
			}
			if (opts.dryRun) {
				p.log.info(`[dry-run] Would ${alreadyHas ? "overwrite" : "add"} ${wrapperKey}.agentmemory in ${config.configPath}`);
				if (opts.withHooks && config.installHooks) {
					const hookResult = config.installHooks(opts);
					if (hookResult.kind === "skipped") p.log.warn(`${config.displayName} hooks skipped: ${hookResult.reason}.`);
				}
				return {
					kind: "installed",
					mutatedPath: config.configPath
				};
			}
			let backupPath;
			if (existsSync(config.configPath)) {
				backupPath = backupFile(config.configPath, config.name);
				logBackup(backupPath);
			} else mkdirSync(dirname(config.configPath), { recursive: true });
			servers["agentmemory"] = {
				...AGENTMEMORY_MCP_BLOCK,
				...config.extraEntryFields ?? {}
			};
			next[wrapperKey] = servers;
			writeJsonAtomic(config.configPath, next);
			const verifyServers = readJsonSafe(config.configPath)?.[wrapperKey];
			if (!entryMatches$3(verifyServers?.["agentmemory"])) {
				p.log.error(`Verification failed: ${config.configPath} did not contain ${wrapperKey}.agentmemory after write.`);
				return {
					kind: "skipped",
					reason: "verification-failed"
				};
			}
			logInstalled(config.displayName, config.configPath);
			if (opts.withHooks && config.installHooks) {
				const hookResult = config.installHooks(opts);
				if (hookResult.kind === "skipped") p.log.warn(`${config.displayName} hooks skipped: ${hookResult.reason}. MCP wiring still applied.`);
			}
			return {
				kind: "installed",
				mutatedPath: config.configPath,
				...backupPath !== void 0 && { backupPath }
			};
		}
	};
}
//#endregion
//#region src/cli/connect/antigravity-hooks.ts
/** Tool events: `[ { matcher, hooks: [...] } ]`. */
const TOOL_EVENT_KEYS = new Set(["PreToolUse", "PostToolUse"]);
/** Lifecycle events: a flat `[ { type, command } ]` handler list. */
const LIFECYCLE_EVENT_KEYS = new Set([
	"PreInvocation",
	"PostInvocation",
	"Stop"
]);
/** Events Antigravity dispatches. Anything else in a bundle is metadata. */
const EVENT_KEYS = new Set([...TOOL_EVENT_KEYS, ...LIFECYCLE_EVENT_KEYS]);
function buildMergedAntigravityHooks(existing, pluginRoot, manifestFile = "hooks.antigravity.json") {
	const ours = JSON.parse(readFileSync(join(pluginRoot, "hooks", manifestFile), "utf-8"));
	const scriptsDir = join(pluginRoot, "scripts");
	const out = {};
	for (const [name, bundle] of Object.entries(existing ?? {})) {
		if (isAgentmemoryBundle(bundle, scriptsDir)) continue;
		out[name] = bundle;
	}
	for (const [name, bundle] of Object.entries(ours)) out[name] = resolveBundle(bundle, pluginRoot);
	return out;
}
/** True when `pluginRoot` cannot be expressed in an Antigravity `command`. */
function containsSpaces(pluginRoot) {
	return /\s/.test(pluginRoot);
}
/**
* Every handler in a bundle, across both event shapes: an entry that carries
* no `hooks` array is itself the handler.
*/
function allHandlers(bundle) {
	const out = [];
	for (const [key, value] of Object.entries(bundle)) {
		if (!EVENT_KEYS.has(key) || !Array.isArray(value)) continue;
		for (const entry of value) {
			if (!entry || typeof entry !== "object") continue;
			const nested = entry.hooks;
			if (Array.isArray(nested)) out.push(...nested);
			else out.push(entry);
		}
	}
	return out;
}
function isAgentmemoryBundle(bundle, scriptsDir) {
	if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return false;
	const normalizedScriptsDir = normalizePathForCommandMatch$1(scriptsDir);
	return allHandlers(bundle).some((handler) => normalizePathForCommandMatch$1(handler?.command ?? "").includes(normalizedScriptsDir));
}
function resolveBundle(bundle, pluginRoot) {
	const out = {};
	for (const [key, value] of Object.entries(bundle)) {
		if (!EVENT_KEYS.has(key) || !Array.isArray(value)) {
			out[key] = value;
			continue;
		}
		if (LIFECYCLE_EVENT_KEYS.has(key)) {
			out[key] = value.map((handler) => resolveHandler(handler, pluginRoot));
			continue;
		}
		out[key] = value.map((entry) => {
			const next = { hooks: entry.hooks.map((handler) => resolveHandler(handler, pluginRoot)) };
			if (entry.matcher !== void 0) next.matcher = entry.matcher;
			return next;
		});
	}
	return out;
}
function resolveHandler(handler, pluginRoot) {
	return {
		type: handler.type,
		command: handler.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => pluginRoot),
		...handler.timeout !== void 0 && { timeout: handler.timeout }
	};
}
function normalizePathForCommandMatch$1(value) {
	return value.replace(/\\/g, "/");
}
//#endregion
//#region src/cli/connect/codex-hooks.ts
/**
* Locate the bundled `plugin/` directory at runtime. Walks up from the
* module's own location looking for `plugin/scripts/` + `plugin/hooks/`,
* both shipped via the npm `files` field. Works for both `dist/cli.mjs`
* (bundled) and `src/cli/connect/codex-hooks.ts` (dev) layouts.
*/
function findPluginRoot(startUrl = import.meta.url) {
	const here = dirname(fileURLToPath(startUrl));
	let dir = here;
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(dir, "plugin", "scripts")) && existsSync(join(dir, "plugin", "hooks"))) return resolve(join(dir, "plugin"));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`agentmemory: could not locate bundled plugin/ directory (searched up from ${here})`);
}
/**
* Build the merged hooks.json content.
*
*   1. Strip every handler in `existing` whose command points under
*      `<pluginRoot>/scripts/`, and an entry only once nothing else is left
*      in it. This lets us re-install idempotently without leaving stale
*      references or dropping the user's own handlers.
*   2. Append fresh entries from the bundled Codex manifest with
*      `${CLAUDE_PLUGIN_ROOT}` rewritten to the absolute plugin path.
*      Matchers and the other handler fields from the bundled manifest are
*      preserved so PreToolUse event routing keeps working.
*/
function buildMergedHooks(existing, pluginRoot, manifestFile = "hooks.codex.json") {
	const bundledManifestPath = join(pluginRoot, "hooks", manifestFile);
	const ours = JSON.parse(readFileSync(bundledManifestPath, "utf-8"));
	const scriptsDir = join(pluginRoot, "scripts");
	const out = { hooks: {} };
	if (existing?.hooks) for (const [event, entries] of Object.entries(existing.hooks)) {
		const kept = entries.flatMap((entry) => {
			const hooks = entry.hooks.filter((handler) => !isAgentmemoryHandler(handler, scriptsDir));
			if (hooks.length === entry.hooks.length) return [entry];
			return hooks.length > 0 ? [{
				...entry,
				hooks
			}] : [];
		});
		if (kept.length > 0) out.hooks[event] = kept;
	}
	for (const [event, entries] of Object.entries(ours.hooks)) {
		const resolvedEntries = entries.map((entry) => {
			const next = { hooks: entry.hooks.map((handler) => ({
				...handler,
				command: handler.command?.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => pluginRoot)
			})) };
			if (entry.matcher !== void 0) next.matcher = entry.matcher;
			return next;
		});
		out.hooks[event] = [...out.hooks[event] ?? [], ...resolvedEntries];
	}
	return out;
}
function isAgentmemoryHandler(handler, scriptsDir) {
	return typeof handler.command === "string" && normalizePathForCommandMatch(handler.command).includes(normalizePathForCommandMatch(scriptsDir));
}
function normalizePathForCommandMatch(value) {
	return value.replace(/\\/g, "/");
}
//#endregion
//#region src/cli/connect/antigravity-cli.ts
const GEMINI_DIR = join(homedir(), ".gemini");
const ANTIGRAVITY_CLI_DIR = join(GEMINI_DIR, "antigravity-cli");
const CUSTOMIZATION_DIR$1 = join(GEMINI_DIR, "config");
const ANTIGRAVITY_CLI_HOOKS = join(CUSTOMIZATION_DIR$1, "hooks.json");
const adapter$20 = createJsonMcpAdapter({
	name: "antigravity-cli",
	displayName: "Antigravity CLI (agy)",
	detectDir: ANTIGRAVITY_CLI_DIR,
	configPath: join(CUSTOMIZATION_DIR$1, "mcp_config.json"),
	extraEntryFields: { env: {} },
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "→ Using MCP via ~/.gemini/config/mcp_config.json, shared with current Antigravity IDE versions. The `/mcp` slash command inside agy lists configured servers. Pass --with-hooks to also install the native ~/.gemini/config/hooks.json auto-capture hooks.",
	installHooks: installAntigravityCliHooks
});
/**
* Merge the bundled `plugin/hooks/hooks.antigravity.json` into
* `~/.gemini/config/hooks.json`, replacing only the bundle agentmemory owns.
*/
function installAntigravityCliHooks(opts) {
	let pluginRoot;
	try {
		pluginRoot = findPluginRoot();
	} catch (err) {
		return {
			kind: "skipped",
			reason: err instanceof Error ? err.message : String(err)
		};
	}
	if (containsSpaces(pluginRoot)) return {
		kind: "skipped",
		reason: `Antigravity CLI cannot run hook commands whose path contains spaces, and agentmemory is installed at ${pluginRoot}. Reinstall it under a space-free path to use --with-hooks; MCP works either way.`
	};
	const existing = readJsonSafe(ANTIGRAVITY_CLI_HOOKS);
	const merged = buildMergedAntigravityHooks(existing, pluginRoot);
	if (opts.dryRun) {
		p.log.info(`[dry-run] Would ${existing ? "merge" : "create"} ${ANTIGRAVITY_CLI_HOOKS} with ${Object.keys(merged).length} hook bundle(s)`);
		return {
			kind: "installed",
			mutatedPath: ANTIGRAVITY_CLI_HOOKS
		};
	}
	let backupPath;
	if (existsSync(ANTIGRAVITY_CLI_HOOKS)) {
		backupPath = backupFile(ANTIGRAVITY_CLI_HOOKS, "antigravity-cli-hooks", "json");
		logBackup(backupPath);
	} else mkdirSync(CUSTOMIZATION_DIR$1, { recursive: true });
	writeJsonAtomic(ANTIGRAVITY_CLI_HOOKS, merged);
	logInstalled("Antigravity CLI hooks", ANTIGRAVITY_CLI_HOOKS);
	p.log.info("User-scope hooks reference absolute paths under the bundled plugin/ dir. Re-run `agentmemory connect antigravity-cli --with-hooks` after upgrading agentmemory to refresh them.");
	return {
		kind: "installed",
		mutatedPath: ANTIGRAVITY_CLI_HOOKS,
		...backupPath !== void 0 && { backupPath }
	};
}
//#endregion
//#region src/cli/connect/antigravity.ts
const LEGACY_USER_DIR = platform() === "darwin" ? join(homedir(), "Library", "Application Support", "Antigravity", "User") : join(homedir(), ".config", "Antigravity", "User");
const CUSTOMIZATION_DIR = join(homedir(), ".gemini", "config");
const mcpAdapter = createJsonMcpAdapter({
	name: "antigravity",
	displayName: "Antigravity",
	detectDir: join(homedir(), ".gemini", "antigravity-ide"),
	configPath: join(CUSTOMIZATION_DIR, "mcp_config.json"),
	extraEntryFields: { env: {} },
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "→ Using MCP via ~/.gemini/config/mcp_config.json, shared by current Antigravity surfaces. Pass --with-hooks for capture through ~/.gemini/config/hooks.json.",
	installHooks: installAntigravityCliHooks
});
const adapter$19 = {
	...mcpAdapter,
	detect: () => mcpAdapter.detect() || existsSync(join(homedir(), ".gemini", "antigravity")) || existsSync(LEGACY_USER_DIR)
};
//#endregion
//#region src/cli/connect/claude-code.ts
const CLAUDE_DIR = join(homedir(), ".claude");
const CLAUDE_JSON = join(homedir(), ".claude.json");
const CLAUDE_SETTINGS = join(CLAUDE_DIR, "settings.json");
function entryMatches$2(entry) {
	if (!entry || typeof entry !== "object") return false;
	const e = entry;
	if (e["command"] !== "npx") return false;
	return (Array.isArray(e["args"]) ? e["args"] : []).includes("@agentmemory/mcp");
}
const adapter$18 = {
	name: "claude-code",
	displayName: "Claude Code",
	category: "native",
	docs: "https://github.com/rohitg00/agentmemory#claude-code-one-block-paste-it",
	protocolNote: "→ Using MCP. Hooks are also available — see https://github.com/rohitg00/agentmemory#claude-code-one-block-paste-it.",
	detect() {
		return existsSync(CLAUDE_DIR);
	},
	async install(opts) {
		const existing = readJsonSafe(CLAUDE_JSON);
		const next = existing ? { ...existing } : {};
		const servers = { ...next.mcpServers ?? {} };
		const alreadyHas = entryMatches$2(servers["agentmemory"]);
		if (alreadyHas && !opts.force) {
			logAlreadyWired("Claude Code", CLAUDE_JSON);
			if (opts.withHooks) {
				const hookResult = installClaudeHooks(opts);
				if (hookResult.kind === "skipped") p.log.warn(`Claude Code hooks fallback skipped: ${hookResult.reason}.`);
			}
			return {
				kind: "already-wired",
				mutatedPath: CLAUDE_JSON
			};
		}
		if (opts.dryRun) {
			p.log.info(`[dry-run] Would ${alreadyHas ? "overwrite" : "add"} mcpServers.agentmemory in ${CLAUDE_JSON}`);
			return {
				kind: "installed",
				mutatedPath: CLAUDE_JSON
			};
		}
		let backupPath;
		if (existsSync(CLAUDE_JSON)) {
			backupPath = backupFile(CLAUDE_JSON, "claude-code");
			logBackup(backupPath);
		} else {
			mkdirSync(CLAUDE_DIR, { recursive: true });
			writeFileSync(CLAUDE_JSON, "{}\n", "utf-8");
		}
		servers["agentmemory"] = AGENTMEMORY_MCP_BLOCK;
		next.mcpServers = servers;
		writeJsonAtomic(CLAUDE_JSON, next);
		if (!entryMatches$2(readJsonSafe(CLAUDE_JSON)?.mcpServers?.["agentmemory"])) {
			p.log.error(`Verification failed: ${CLAUDE_JSON} did not contain mcpServers.agentmemory after write.`);
			return {
				kind: "skipped",
				reason: "verification-failed"
			};
		}
		logInstalled("Claude Code", CLAUDE_JSON);
		p.log.info("Restart Claude Code (or run `/mcp` inside a session) to pick up the new server.");
		if (opts.withHooks) {
			const hookResult = installClaudeHooks(opts);
			if (hookResult.kind === "skipped") p.log.warn(`Claude Code hooks fallback skipped: ${hookResult.reason}. MCP wiring still applied.`);
		}
		return {
			kind: "installed",
			mutatedPath: CLAUDE_JSON,
			backupPath
		};
	}
};
function installClaudeHooks(opts) {
	let pluginRoot;
	try {
		pluginRoot = findPluginRoot();
	} catch (err) {
		return {
			kind: "skipped",
			reason: err instanceof Error ? err.message : String(err)
		};
	}
	const existing = readJsonSafe(CLAUDE_SETTINGS) ?? {};
	const merged = buildMergedHooks(existing.hooks ? { hooks: existing.hooks } : null, pluginRoot, "hooks.json");
	if (opts.dryRun) {
		p.log.info(`[dry-run] Would merge agentmemory hook entries into ${CLAUDE_SETTINGS} (${Object.keys(merged.hooks).length} event(s))`);
		return {
			kind: "installed",
			mutatedPath: CLAUDE_SETTINGS
		};
	}
	let backupPath;
	if (existsSync(CLAUDE_SETTINGS)) {
		backupPath = backupFile(CLAUDE_SETTINGS, "claude-settings", "json");
		logBackup(backupPath);
	} else mkdirSync(CLAUDE_DIR, { recursive: true });
	writeJsonAtomic(CLAUDE_SETTINGS, {
		...existing,
		hooks: merged.hooks
	});
	logInstalled("Claude Code hooks", CLAUDE_SETTINGS);
	p.log.info("User-scope hook entries reference absolute paths under the bundled plugin/ dir. Re-run `agentmemory connect claude-code --with-hooks` after upgrading agentmemory to refresh them.");
	return {
		kind: "installed",
		mutatedPath: CLAUDE_SETTINGS,
		...backupPath !== void 0 && { backupPath }
	};
}
//#endregion
//#region src/cli/connect/cline.ts
const adapter$17 = createJsonMcpAdapter({
	name: "cline",
	displayName: "Cline",
	detectDir: join(homedir(), ".cline"),
	configPath: join(homedir(), ".cline", "mcp.json"),
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "→ Using MCP via ~/.cline/mcp.json (CLI). VS Code users: add the same block via Cline Settings → MCP Servers → Edit JSON."
});
//#endregion
//#region src/cli/connect/copilot-cli.ts
const COPILOT_DIR = process.env["COPILOT_HOME"] || join(homedir(), ".copilot");
const COPILOT_MCP_JSON = join(COPILOT_DIR, "mcp-config.json");
function entryMatches$1(entry) {
	if (!entry || typeof entry !== "object") return false;
	return JSON.stringify(entry) === JSON.stringify(AGENTMEMORY_COPILOT_MCP_BLOCK);
}
const adapter$16 = {
	name: "copilot-cli",
	displayName: "GitHub Copilot CLI",
	category: "native",
	docs: "https://github.com/rohitg00/agentmemory#github-copilot-cli",
	protocolNote: "→ Using MCP. Install the plugin too for full hooks/skills coverage.",
	detect() {
		return existsSync(COPILOT_DIR);
	},
	async install(opts) {
		const existing = readJsonSafe(COPILOT_MCP_JSON);
		const next = existing ? { ...existing } : {};
		const servers = { ...next.mcpServers ?? {} };
		const alreadyHas = entryMatches$1(servers["agentmemory"]);
		if (alreadyHas && !opts.force) {
			logAlreadyWired("GitHub Copilot CLI", COPILOT_MCP_JSON);
			return {
				kind: "already-wired",
				mutatedPath: COPILOT_MCP_JSON
			};
		}
		if (opts.dryRun) {
			p.log.info(`[dry-run] Would ${alreadyHas ? "overwrite" : "add"} mcpServers.agentmemory in ${COPILOT_MCP_JSON}`);
			return {
				kind: "installed",
				mutatedPath: COPILOT_MCP_JSON
			};
		}
		let backupPath;
		if (existsSync(COPILOT_MCP_JSON)) {
			backupPath = backupFile(COPILOT_MCP_JSON, "copilot-cli");
			logBackup(backupPath);
		} else mkdirSync(dirname(COPILOT_MCP_JSON), { recursive: true });
		servers["agentmemory"] = AGENTMEMORY_COPILOT_MCP_BLOCK;
		next.mcpServers = servers;
		writeJsonAtomic(COPILOT_MCP_JSON, next);
		if (!entryMatches$1(readJsonSafe(COPILOT_MCP_JSON)?.mcpServers?.["agentmemory"])) {
			p.log.error(`Verification failed: ${COPILOT_MCP_JSON} did not contain mcpServers.agentmemory after write.`);
			return {
				kind: "skipped",
				reason: "verification-failed"
			};
		}
		logInstalled("GitHub Copilot CLI", COPILOT_MCP_JSON);
		p.log.info("Copilot picks up MCP servers on next launch or after `/mcp`. Install the plugin too for full hooks/skills.");
		return {
			kind: "installed",
			mutatedPath: COPILOT_MCP_JSON,
			...backupPath !== void 0 && { backupPath }
		};
	}
};
//#endregion
//#region src/cli/connect/codex.ts
const CODEX_DIR = join(homedir(), ".codex");
const CODEX_TOML = join(CODEX_DIR, "config.toml");
const CODEX_HOOKS = join(CODEX_DIR, "hooks.json");
const TOML_BLOCK = `[mcp_servers.agentmemory]
command = "npx"
args = ["-y", "@agentmemory/mcp"]

[mcp_servers.agentmemory.env]
AGENTMEMORY_URL = "http://localhost:3111"
`;
const SECTION_HEADER = "[mcp_servers.agentmemory]";
function isWiredText(toml) {
	return toml.includes(SECTION_HEADER);
}
function stripExistingBlock(toml) {
	const lines = toml.split(/\r?\n/);
	const out = [];
	let skipping = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === SECTION_HEADER || trimmed === "[mcp_servers.agentmemory.env]") {
			skipping = true;
			continue;
		}
		if (skipping && trimmed.startsWith("[") && trimmed !== "[mcp_servers.agentmemory.env]") skipping = false;
		if (!skipping) out.push(line);
	}
	return out.join("\n").replace(/\n{3,}$/, "\n\n").trimEnd() + "\n";
}
const adapter$15 = {
	name: "codex",
	displayName: "Codex CLI",
	category: "native",
	docs: "https://github.com/rohitg00/agentmemory#codex-cli-codex-plugin-platform",
	protocolNote: "→ Using MCP. Hooks ship via the Codex plugin; on Codex Desktop, also pass --with-hooks to install the global hooks.json workaround.",
	detect() {
		return existsSync(CODEX_DIR);
	},
	async install(opts) {
		const exists = existsSync(CODEX_TOML);
		const current = exists ? readFileSync(CODEX_TOML, "utf-8") : "";
		const wired = isWiredText(current);
		if (wired && !opts.force) {
			logAlreadyWired("Codex CLI", CODEX_TOML);
			return {
				kind: "already-wired",
				mutatedPath: CODEX_TOML
			};
		}
		if (opts.dryRun) {
			p.log.info(`[dry-run] Would ${wired ? "rewrite" : "append"} [mcp_servers.agentmemory] in ${CODEX_TOML}`);
			if (opts.withHooks) installCodexHooks(opts);
			return {
				kind: "installed",
				mutatedPath: CODEX_TOML
			};
		}
		let backupPath;
		if (exists) {
			backupPath = backupFile(CODEX_TOML, "codex", "toml");
			logBackup(backupPath);
		} else mkdirSync(dirname(CODEX_TOML), { recursive: true });
		const cleaned = wired ? stripExistingBlock(current) : current;
		writeFileSync(CODEX_TOML, `${cleaned}${cleaned.length === 0 || cleaned.endsWith("\n") ? "" : "\n"}${cleaned.length > 0 ? "\n" : ""}${TOML_BLOCK}`, "utf-8");
		if (!isWiredText(readFileSync(CODEX_TOML, "utf-8"))) {
			p.log.error(`Verification failed: ${CODEX_TOML} did not contain ${SECTION_HEADER} after write.`);
			return {
				kind: "skipped",
				reason: "verification-failed"
			};
		}
		logInstalled("Codex CLI", CODEX_TOML);
		p.log.info("Codex picks up MCP servers on next launch. For the deeper plugin install, run: codex plugin marketplace add rohitg00/agentmemory && codex plugin add agentmemory@agentmemory");
		if (opts.withHooks) {
			const hookResult = installCodexHooks(opts);
			if (hookResult.kind === "skipped") p.log.warn(`Codex hooks fallback skipped: ${hookResult.reason}. MCP wiring still applied.`);
		}
		return {
			kind: "installed",
			mutatedPath: CODEX_TOML,
			...backupPath !== void 0 && { backupPath }
		};
	}
};
function installCodexHooks(opts) {
	let pluginRoot;
	try {
		pluginRoot = findPluginRoot();
	} catch (err) {
		return {
			kind: "skipped",
			reason: err instanceof Error ? err.message : String(err)
		};
	}
	const existing = readJsonSafe(CODEX_HOOKS);
	const merged = buildMergedHooks(existing, pluginRoot);
	if (opts.dryRun) {
		p.log.info(`[dry-run] Would ${existing ? "merge" : "create"} ${CODEX_HOOKS} with ${Object.keys(merged.hooks).length} event(s)`);
		return {
			kind: "installed",
			mutatedPath: CODEX_HOOKS
		};
	}
	let backupPath;
	if (existsSync(CODEX_HOOKS)) {
		backupPath = backupFile(CODEX_HOOKS, "codex-hooks", "json");
		logBackup(backupPath);
	}
	writeJsonAtomic(CODEX_HOOKS, merged);
	logInstalled("Codex hooks", CODEX_HOOKS);
	p.log.warn("Codex runs only trusted hooks: launch `codex` (the TUI) once and choose \"Trust all and continue\" at the \"Hooks need review\" prompt. `codex exec` never shows the prompt, so hooks stay inert until then.");
	p.log.info("User-scope hooks reference absolute paths under the bundled plugin/ dir. Re-run `agentmemory connect codex --with-hooks` after upgrading agentmemory to refresh them, then re-approve in the TUI.");
	return {
		kind: "installed",
		mutatedPath: CODEX_HOOKS,
		...backupPath !== void 0 && { backupPath }
	};
}
//#endregion
//#region src/cli/connect/continue.ts
const CONTINUE_DIR = join(homedir(), ".continue");
const YAML_PATH = join(CONTINUE_DIR, "config.yaml");
const JSON_PATH = join(CONTINUE_DIR, "config.json");
function buildEntry() {
	return {
		name: "agentmemory",
		command: AGENTMEMORY_MCP_BLOCK.command,
		args: [...AGENTMEMORY_MCP_BLOCK.args],
		env: { ...AGENTMEMORY_MCP_BLOCK.env }
	};
}
function entryIsAgentmemory(entry) {
	if (!entry) return false;
	return entry.name === "agentmemory" && entry.args.includes("@agentmemory/mcp");
}
function renderFreshYaml() {
	const e = buildEntry();
	const envLines = Object.entries(e.env ?? {}).map(([k, v]) => `      ${k}: "${v}"`).join("\n");
	return [
		"mcpServers:",
		`  - name: ${e.name}`,
		`    command: ${e.command}`,
		"    args:",
		...e.args.map((a) => `      - "${a}"`),
		"    env:",
		envLines,
		""
	].join("\n");
}
const adapter$14 = {
	name: "continue",
	displayName: "Continue",
	category: "mcp",
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "→ Using MCP via ~/.continue/config.yaml (preferred) or config.json (legacy, only when no yaml).",
	detect() {
		return existsSync(CONTINUE_DIR);
	},
	async install(opts) {
		const yamlExists = existsSync(YAML_PATH);
		const jsonExists = existsSync(JSON_PATH);
		if (yamlExists) {
			const manual = `\nMerge this block into ~/.continue/config.yaml (the snippet already includes the top-level mcpServers key — if your config already has a mcpServers list, append the agentmemory entry to it instead of duplicating the key):\n\n${renderFreshYaml().split("\n").map((l) => l ? `  ${l}` : l).join("\n")}`;
			p.log.info(`Continue: ${YAML_PATH} already exists. Manual edit needed.${manual}`);
			return {
				kind: "stub",
				reason: "config.yaml-needs-manual-edit"
			};
		}
		if (jsonExists) {
			const existing = readJsonSafe(JSON_PATH);
			const next = existing ? { ...existing } : {};
			const servers = Array.isArray(next.mcpServers) ? [...next.mcpServers] : [];
			const idx = servers.findIndex((s) => s?.name === "agentmemory");
			const alreadyHas = idx >= 0 && entryIsAgentmemory(servers[idx]);
			if (alreadyHas && !opts.force) {
				logAlreadyWired("Continue", JSON_PATH);
				return {
					kind: "already-wired",
					mutatedPath: JSON_PATH
				};
			}
			if (opts.dryRun) {
				p.log.info(`[dry-run] Would ${alreadyHas ? "overwrite" : "add"} mcpServers[agentmemory] in ${JSON_PATH}`);
				return {
					kind: "installed",
					mutatedPath: JSON_PATH
				};
			}
			const backupPath = backupFile(JSON_PATH, "continue");
			logBackup(backupPath);
			const entry = buildEntry();
			if (idx >= 0) servers[idx] = entry;
			else servers.push(entry);
			next.mcpServers = servers;
			writeJsonAtomic(JSON_PATH, next);
			const verifyEntry = readJsonSafe(JSON_PATH)?.mcpServers?.find((s) => s?.name === "agentmemory");
			if (!entryIsAgentmemory(verifyEntry)) {
				p.log.error(`Verification failed: ${JSON_PATH} did not contain mcpServers[agentmemory] after write.`);
				return {
					kind: "skipped",
					reason: "verification-failed"
				};
			}
			logInstalled("Continue (legacy config.json)", JSON_PATH);
			return {
				kind: "installed",
				mutatedPath: JSON_PATH,
				backupPath
			};
		}
		if (opts.dryRun) {
			p.log.info(`[dry-run] Would create ${YAML_PATH} with agentmemory entry`);
			return {
				kind: "installed",
				mutatedPath: YAML_PATH
			};
		}
		mkdirSync(dirname(YAML_PATH), { recursive: true });
		writeFileSync(YAML_PATH, renderFreshYaml(), "utf-8");
		logInstalled("Continue", YAML_PATH);
		return {
			kind: "installed",
			mutatedPath: YAML_PATH
		};
	}
};
//#endregion
//#region src/cli/connect/cursor.ts
const adapter$13 = createJsonMcpAdapter({
	name: "cursor",
	displayName: "Cursor",
	detectDir: join(homedir(), ".cursor"),
	configPath: join(homedir(), ".cursor", "mcp.json"),
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "→ Using MCP (the only protocol Cursor speaks). Memory bridge runs at :3111 underneath."
});
//#endregion
//#region src/cli/connect/devin.ts
function devinDir() {
	if (platform() === "win32") {
		const appData = process.env["APPDATA"];
		if (appData) return join(appData, "devin");
	}
	const xdg = process.env["XDG_CONFIG_HOME"];
	return xdg ? join(xdg, "devin") : join(homedir(), ".config", "devin");
}
const DEVIN_DIR = devinDir();
const DEVIN_CONFIG = join(DEVIN_DIR, "config.json");
const adapter$12 = createJsonMcpAdapter({
	name: "devin",
	displayName: "Devin CLI",
	detectDir: DEVIN_DIR,
	configPath: DEVIN_CONFIG,
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "→ Using MCP via the user config. Devin CLI migrates mcpServers into mcp_config.json on newer builds. Pass --with-hooks for native auto-capture.",
	installHooks: installDevinHooks
});
function installDevinHooks(opts) {
	let pluginRoot;
	try {
		pluginRoot = findPluginRoot();
	} catch (err) {
		return {
			kind: "skipped",
			reason: err instanceof Error ? err.message : String(err)
		};
	}
	const existing = readJsonSafe(DEVIN_CONFIG) ?? {};
	const merged = buildMergedHooks(existing["hooks"] ? { hooks: existing["hooks"] } : null, pluginRoot, "hooks.devin.json");
	const next = {
		...existing,
		hooks: merged.hooks
	};
	if (opts.dryRun) {
		p.log.info(`[dry-run] Would write ${Object.keys(merged.hooks).length} hook event(s) into ${DEVIN_CONFIG}`);
		return {
			kind: "installed",
			mutatedPath: DEVIN_CONFIG
		};
	}
	let backupPath;
	if (existsSync(DEVIN_CONFIG)) {
		backupPath = backupFile(DEVIN_CONFIG, "devin-hooks", "json");
		logBackup(backupPath);
	} else mkdirSync(DEVIN_DIR, { recursive: true });
	writeJsonAtomic(DEVIN_CONFIG, next);
	logInstalled("Devin CLI hooks", DEVIN_CONFIG);
	p.log.info("Verify with `/hooks` inside devin. Re-run `agentmemory connect devin --with-hooks` after upgrading agentmemory so the plugin paths stay current.");
	return {
		kind: "installed",
		mutatedPath: DEVIN_CONFIG,
		...backupPath !== void 0 && { backupPath }
	};
}
//#endregion
//#region src/cli/connect/droid.ts
const DROID_DIR = join(homedir(), ".factory");
const DROID_HOOKS = join(DROID_DIR, "hooks.json");
const adapter$11 = createJsonMcpAdapter({
	name: "droid",
	displayName: "Droid (Factory.ai)",
	detectDir: DROID_DIR,
	configPath: join(DROID_DIR, "mcp.json"),
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "→ Using MCP via ~/.factory/mcp.json. The `/mcp` slash command inside droid lists configured servers. Pass --with-hooks to also install the native ~/.factory/hooks.json auto-capture hooks.",
	extraEntryFields: { type: "stdio" },
	installHooks: installDroidHooks
});
/**
* Merge the bundled `plugin/hooks/hooks.droid.json` into
* `~/.factory/hooks.json`. Same idempotent merge/strip-by-script-path
* behavior as the Codex and Claude Code hook installers: re-running keeps
* user-authored hook entries and only replaces the ones agentmemory owns.
*/
function installDroidHooks(opts) {
	let pluginRoot;
	try {
		pluginRoot = findPluginRoot();
	} catch (err) {
		return {
			kind: "skipped",
			reason: err instanceof Error ? err.message : String(err)
		};
	}
	const existing = readJsonSafe(DROID_HOOKS);
	const merged = buildMergedHooks(existing, pluginRoot, "hooks.droid.json");
	if (opts.dryRun) {
		p.log.info(`[dry-run] Would ${existing ? "merge" : "create"} ${DROID_HOOKS} with ${Object.keys(merged.hooks).length} event(s)`);
		return {
			kind: "installed",
			mutatedPath: DROID_HOOKS
		};
	}
	let backupPath;
	if (existsSync(DROID_HOOKS)) {
		backupPath = backupFile(DROID_HOOKS, "droid-hooks", "json");
		logBackup(backupPath);
	} else mkdirSync(DROID_DIR, { recursive: true });
	writeJsonAtomic(DROID_HOOKS, merged);
	logInstalled("Droid hooks", DROID_HOOKS);
	p.log.info("User-scope hooks reference absolute paths under the bundled plugin/ dir. Re-run `agentmemory connect droid --with-hooks` after upgrading agentmemory to refresh them.");
	return {
		kind: "installed",
		mutatedPath: DROID_HOOKS,
		...backupPath !== void 0 && { backupPath }
	};
}
//#endregion
//#region src/cli/connect/dsh.ts
function dshHome() {
	return process.env["DSH_HOME"] || join(homedir(), ".dsh");
}
const MCP_BLOCK = `- insert:
    - id: agentmemory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: agentmemory
        command: npx
        args: ['-y', '@agentmemory/mcp']
        env:
          AGENTMEMORY_URL: !!js process.env.AGENTMEMORY_URL || 'http://localhost:3111'
          AGENTMEMORY_SECRET: !!js process.env.AGENTMEMORY_SECRET || ''
`;
const MCP_MARKER = "serverName: agentmemory";
const HOOKS_MARKER = "id: agentmemory-hooks";
function hooksBlock(hooksConfigPath) {
	return `- insert:
    - id: agentmemory-hooks
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: ${JSON.stringify(hooksConfigPath)}
`;
}
function parsePatch(content) {
	const doc = parseDocument(content);
	if (doc.contents === null) doc.contents = doc.createNode([]);
	if (doc.errors.length || !isSeq(doc.contents)) throw new Error("Cannot update dsh cordis.patch.yml: expected a valid YAML sequence.");
	return {
		doc,
		operations: doc.contents
	};
}
function isManaged(entry, marker) {
	if (!isMap(entry)) return false;
	return marker === MCP_MARKER ? entry.get("name") === "@deepseek-ai/dsh-mcp-client" && entry.getIn(["config", "serverName"]) === "agentmemory" : entry.get("name") === "@deepseek-ai/dsh-hooks-claude-code" && entry.get("id") === "agentmemory-hooks";
}
function hasBlock(content, marker) {
	return parsePatch(content).operations.items.some((operation) => {
		const entries = isMap(operation) ? operation.get("insert", true) : null;
		return isSeq(entries) && entries.items.some((entry) => isManaged(entry, marker));
	});
}
function upsertBlock(content, marker, block) {
	const { doc, operations } = parsePatch(content);
	const addition = parsePatch(block).operations;
	const replacement = addition.getIn([
		0,
		"insert",
		0
	], true);
	let replaced = false;
	for (let i = 0; i < operations.items.length; i++) {
		const operation = operations.items[i];
		if (!isMap(operation)) continue;
		const entries = operation.get("insert", true);
		if (!isSeq(entries)) continue;
		let removed = false;
		for (let j = 0; j < entries.items.length; j++) {
			if (!isManaged(entries.items[j], marker)) continue;
			if (!replaced) {
				entries.set(j, replacement);
				replaced = true;
			} else {
				entries.delete(j--);
				removed = true;
			}
		}
		if (removed && entries.items.length === 0) operations.delete(i--);
	}
	if (!replaced) operations.items.push(...addition.items);
	operations.flow = false;
	return doc.toString();
}
function installHooksFile(home) {
	const hooksPath = join(home, "agentmemory.hooks.json");
	const pluginRoot = findPluginRoot();
	writeJsonAtomic(hooksPath, buildMergedHooks(readJsonSafe(hooksPath), pluginRoot, "hooks.codex.json"));
	return hooksPath;
}
const adapter$10 = {
	name: "dsh",
	displayName: "DeepSeek Harness",
	docs: "https://github.com/rohitg00/agentmemory/blob/main/docs/dsh.md",
	protocolNote: "→ Using MCP via $DSH_HOME/cordis.patch.yml (the home-level patch layer every profile loads). Tools appear as mcp__agentmemory__*. Pass --with-hooks to also wire auto-capture through Harness's Claude Code hook bridge.",
	category: "native",
	detect() {
		return existsSync(dshHome());
	},
	async install(opts) {
		const home = dshHome();
		const configPath = join(home, "cordis.patch.yml");
		const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
		const wantHooks = opts.withHooks === true;
		if (wantHooks) p.log.info(`Hooks require @deepseek-ai/dsh-hooks-claude-code and @deepseek-ai/dsh-hook-protocol in each profile, plus locally discoverable credentials. Setup: ${this.docs}`);
		const hasMcp = hasBlock(existing, MCP_MARKER);
		const hasHooks = hasBlock(existing, HOOKS_MARKER);
		if (hasMcp && (!wantHooks || hasHooks) && !opts.force) {
			logAlreadyWired(this.displayName, configPath);
			return {
				kind: "already-wired",
				mutatedPath: configPath
			};
		}
		if (opts.dryRun) {
			p.log.info(`[dry-run] Would append the agentmemory mcp-client row${wantHooks ? " and the hooks-claude-code row" : ""} to ${configPath}`);
			return {
				kind: "installed",
				mutatedPath: configPath
			};
		}
		let backupPath;
		if (existsSync(configPath)) {
			backupPath = backupFile(configPath, this.name, "yml");
			logBackup(backupPath);
		} else mkdirSync(dirname(configPath), { recursive: true });
		let next = hasMcp && !opts.force ? existing : upsertBlock(existing, MCP_MARKER, MCP_BLOCK);
		if (wantHooks && (!hasHooks || opts.force)) {
			const hooksPath = installHooksFile(home);
			next = upsertBlock(next, HOOKS_MARKER, hooksBlock(hooksPath));
			p.log.info(`Hook manifest: ${hooksPath}`);
		}
		writeTextAtomic(configPath, next);
		const written = readFileSync(configPath, "utf-8");
		if (!hasBlock(written, MCP_MARKER) || wantHooks && !hasBlock(written, HOOKS_MARKER)) {
			p.log.error(`Verification failed: ${configPath} did not contain the agentmemory rows after write.`);
			return {
				kind: "skipped",
				reason: "verification-failed"
			};
		}
		logInstalled(this.displayName, configPath);
		return {
			kind: "installed",
			mutatedPath: configPath,
			backupPath
		};
	}
};
//#endregion
//#region src/cli/connect/gemini-cli.ts
const adapter$9 = createJsonMcpAdapter({
	name: "gemini-cli",
	displayName: "Gemini CLI",
	detectDir: join(homedir(), ".gemini"),
	configPath: join(homedir(), ".gemini", "settings.json"),
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "→ Using MCP (the only protocol Gemini CLI speaks). Memory bridge runs at :3111 underneath."
});
//#endregion
//#region src/cli/connect/native-install.ts
const MANIFEST = ".agentmemory-install.json";
const digest = (content) => createHash("sha256").update(content).digest("hex");
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function nativePackageRoot() {
	return dirname(findPluginRoot());
}
function nativeUserPath(value, home) {
	return resolve(value.replace(/^~(?=$|[/\\])/, () => home));
}
function nativeMcpEntry(packageRoot) {
	const entry = join(packageRoot, "dist", "standalone.mjs");
	if (!existsSync(entry)) throw new Error("Bundled MCP runtime is missing; reinstall AgentMemory before connecting.");
	return {
		command: process.execPath,
		args: [entry],
		env: {
			AGENTMEMORY_TOOLS: "all",
			AGENTMEMORY_FORCE_PROXY: "1"
		}
	};
}
function filesUnder(dir, prefix = "") {
	const files = /* @__PURE__ */ new Map();
	for (const item of readdirSync(dir, { withFileTypes: true })) {
		if ([
			"__pycache__",
			".git",
			"node_modules",
			MANIFEST
		].includes(item.name) || item.name.endsWith(".pyc")) continue;
		const path = join(dir, item.name);
		if (item.isSymbolicLink()) throw new Error(`Native installation does not follow symbolic links: ${path}`);
		const name = join(prefix, item.name);
		if (item.isDirectory()) for (const [key, value] of filesUnder(path, name)) files.set(key, value);
		else if (item.isFile()) files.set(name, readFileSync(path));
	}
	return files;
}
function rejectSymlink(path) {
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Native installation does not replace symbolic links: ${path}`);
}
function prepareNativeBundle(source, target, label, required, force, skillsSource) {
	if (!required.every((name) => existsSync(join(source, name)))) throw new Error(`Bundled ${label} files are missing; reinstall AgentMemory before connecting.`);
	rejectSymlink(target);
	const files = filesUnder(source);
	if (skillsSource) {
		if (!["remember/SKILL.md", "recall/SKILL.md"].every((name) => existsSync(join(skillsSource, name)))) throw new Error("Bundled skills are missing; reinstall AgentMemory before connecting.");
		for (const [name, content] of filesUnder(skillsSource)) files.set(join("skills", name), content);
	}
	let previous = {};
	if (existsSync(join(target, MANIFEST))) {
		let stored;
		try {
			stored = JSON.parse(readFileSync(join(target, MANIFEST), "utf8"));
		} catch {
			stored = null;
		}
		if (!record(stored) || !record(stored.files) || !Object.values(stored.files).every((hash) => typeof hash === "string")) throw new Error(`Invalid native install manifest in ${target}; restore its backup before reconnecting.`);
		previous = stored.files;
		for (const name of Object.keys(previous)) {
			const location = relative(target, resolve(target, name));
			if (!location || location === ".." || location.startsWith(`..${sep}`) || resolve(target, name) === resolve(target, MANIFEST)) throw new Error(`Invalid native install path in ${target}.`);
		}
	}
	const installed = existsSync(target) ? filesUnder(target) : /* @__PURE__ */ new Map();
	if (!force) for (const [name, content] of installed) {
		if (!files.has(name) && !(name in previous)) continue;
		if (previous[name] ? digest(content) !== previous[name] : !files.get(name)?.equals(content)) throw new Error(`Customized ${label} file ${name} was preserved; use --force to replace it with a backup.`);
	}
	const changed = !existsSync(join(target, MANIFEST)) || [...files].some(([name, content]) => !installed.get(name)?.equals(content)) || Object.keys(previous).some((name) => !files.has(name) && installed.has(name));
	return {
		target,
		label,
		files,
		previous,
		changed
	};
}
function installNativeBundles(bundles, configPath, configText) {
	rejectSymlink(configPath);
	const transaction = randomUUID();
	const configStage = `${configPath}.stage-${transaction}`;
	const staged = [];
	let backupPath;
	try {
		for (const bundle of bundles.filter((item) => item.changed)) {
			mkdirSync(dirname(bundle.target), { recursive: true });
			const stage = `${bundle.target}.stage-${transaction}`;
			const item = {
				bundle,
				stage,
				rollback: `${bundle.target}.previous-${transaction}`,
				replaced: false,
				installed: false
			};
			staged.push(item);
			if (existsSync(bundle.target)) cpSync(bundle.target, stage, { recursive: true });
			else mkdirSync(stage);
			for (const name of Object.keys(bundle.previous)) if (!bundle.files.has(name)) rmSync(join(stage, name), { force: true });
			for (const [name, content] of bundle.files) {
				mkdirSync(dirname(join(stage, name)), { recursive: true });
				writeFileSync(join(stage, name), content);
			}
			writeFileSync(join(stage, MANIFEST), JSON.stringify({ files: Object.fromEntries([...bundle.files].map(([name, content]) => [name, digest(content)])) }) + "\n");
			if (existsSync(bundle.target)) {
				const backup = join(ensureBackupsDir(), `${bundle.label}-${transaction}`);
				cpSync(bundle.target, backup, { recursive: true });
				backupPath ??= backup;
			}
		}
		const configChanged = !existsSync(configPath) || readFileSync(configPath, "utf8") !== configText;
		if (configChanged && existsSync(configPath)) backupPath = backupFile(configPath, "native-config", "config");
		if (configChanged) {
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configStage, configText, { mode: existsSync(configPath) ? lstatSync(configPath).mode & 511 : 384 });
		}
		for (const item of staged) {
			if (existsSync(item.bundle.target)) {
				renameSync(item.bundle.target, item.rollback);
				item.replaced = true;
			}
			renameSync(item.stage, item.bundle.target);
			item.installed = true;
		}
		if (configChanged) renameSync(configStage, configPath);
	} catch (error) {
		for (const item of [...staged].reverse()) {
			if (item.installed) rmSync(item.bundle.target, {
				recursive: true,
				force: true
			});
			if (item.replaced) renameSync(item.rollback, item.bundle.target);
		}
		throw error;
	} finally {
		for (const item of staged) rmSync(item.stage, {
			recursive: true,
			force: true
		});
		rmSync(configStage, { force: true });
	}
	for (const item of staged) rmSync(item.rollback, {
		recursive: true,
		force: true
	});
	return backupPath;
}
//#endregion
//#region src/cli/connect/hermes.ts
const hermesHome = () => {
	return nativeUserPath((process.env.HERMES_HOME?.trim() || join(homedir(), `.hermes${process.env.HERMES_DATA_DIR_SUFFIX ?? ""}`)).replace(/\$(?:\{([^}]+)\}|([A-Za-z_][A-Za-z_0-9]*))/g, (match, braced, plain) => process.env[braced ?? plain] ?? match), homedir());
};
const DOCS$2 = "https://github.com/rohitg00/agentmemory/tree/main/integrations/hermes";
const stringList$1 = (value) => value === void 0 || Array.isArray(value) && value.every((item) => typeof item === "string");
const adapter$8 = {
	name: "hermes",
	displayName: "Hermes Agent",
	category: "native",
	docs: DOCS$2,
	protocolNote: "→ Installs the native memory provider and bundled skills into the active Hermes profile. Credentials stay managed by Hermes.",
	detect: () => existsSync(hermesHome()),
	async install(opts) {
		const home = hermesHome();
		const path = join(home, "config.yaml");
		const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
		const doc = parseDocument(raw);
		let existing;
		try {
			existing = doc.contents === null ? {} : doc.toJS({ maxAliasCount: 100 });
		} catch {
			existing = null;
		}
		if (doc.errors.length || !record(existing) || existing.memory !== void 0 && !record(existing.memory) || existing.plugins !== void 0 && !record(existing.plugins) || existing.mcp_servers !== void 0 && !record(existing.mcp_servers)) {
			p.log.warn(`Hermes config is not a valid YAML mapping. Left ${path} unchanged.`);
			return {
				kind: "skipped",
				reason: "invalid-config"
			};
		}
		const memory = existing.memory ?? {};
		const plugins = existing.plugins ?? {};
		const servers = existing.mcp_servers ?? {};
		if (!stringList$1(plugins.enabled) || !stringList$1(plugins.disabled) || memory.provider !== void 0 && typeof memory.provider !== "string") {
			p.log.warn(`Hermes provider or plugin settings are invalid. Left ${path} unchanged.`);
			return {
				kind: "skipped",
				reason: "invalid-config"
			};
		}
		if (servers.agentmemory !== void 0 && !record(servers.agentmemory) && !(opts.force && opts.withMcp)) {
			p.log.warn("Hermes's AgentMemory MCP entry is invalid. Repair it or use --force --with-mcp.");
			return {
				kind: "skipped",
				reason: "invalid-entry"
			};
		}
		if (memory.provider && memory.provider !== "agentmemory" && !opts.force) {
			p.log.warn("Hermes already selects another memory provider. Use --force to select AgentMemory and keep a backup.");
			return {
				kind: "skipped",
				reason: "memory-provider-conflict"
			};
		}
		if (plugins.disabled?.includes("agentmemory") && !opts.force) {
			p.log.warn("AgentMemory is disabled in this Hermes profile. Use --force to enable it.");
			return {
				kind: "skipped",
				reason: "plugin-disabled"
			};
		}
		try {
			const root = nativePackageRoot();
			const bundles = [prepareNativeBundle(join(root, "integrations", "hermes"), join(home, "plugins", "agentmemory"), "hermes-provider", ["__init__.py", "plugin.yaml"], opts.force), prepareNativeBundle(join(root, "plugin", "skills"), join(home, "skills", "agentmemory"), "hermes-skills", ["remember/SKILL.md", "recall/SKILL.md"], opts.force)];
			if (memory.provider !== "agentmemory") doc.setIn(["memory", "provider"], "agentmemory");
			const enabled = plugins.enabled ?? [];
			if (!enabled.includes("agentmemory")) doc.setIn(["plugins", "enabled"], [...enabled, "agentmemory"]);
			if (plugins.disabled?.includes("agentmemory")) doc.setIn(["plugins", "disabled"], plugins.disabled.filter((name) => name !== "agentmemory"));
			if (opts.withMcp) {
				p.log.warn("MCP exposes all AgentMemory tools against the configured backend. It does not enforce the native provider's profile scope; enable it only for a trusted, deliberately shared backend.");
				if (servers.agentmemory === void 0 || opts.force) {
					const entry = nativeMcpEntry(root);
					entry.env = {
						...entry.env,
						AGENTMEMORY_URL: "${AGENTMEMORY_URL}",
						AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET}",
						AGENTMEMORY_CREDENTIAL_MODE: "explicit"
					};
					doc.setIn(["mcp_servers", "agentmemory"], entry);
				} else p.log.info("Preserved the existing AgentMemory MCP entry. After moving the installed package, review its settings and reconnect with --with-mcp --force to refresh its runtime path.");
			}
			const configText = doc.toString();
			if (opts.dryRun) {
				p.log.info(`[dry-run] Would install the native provider and skills, then activate AgentMemory in ${path}`);
				return {
					kind: "installed",
					mutatedPath: path
				};
			}
			let backupPath;
			const unchanged = !bundles.some((bundle) => bundle.changed) && configText === raw;
			if (unchanged) logAlreadyWired(this.displayName, path);
			else {
				backupPath = installNativeBundles(bundles, path, configText);
				if (backupPath) logBackup(backupPath);
				logInstalled(this.displayName, path);
			}
			p.log.info("Authentication is not verified. Start AgentMemory, then run `hermes memory setup` in this same HERMES_HOME to set its URL and scoped secret. Verify a save and recall in a new session. Skills needing tools beyond native save, recall and search require the optional --with-mcp connection.");
			return unchanged ? {
				kind: "already-wired",
				mutatedPath: path
			} : {
				kind: "installed",
				mutatedPath: path,
				...backupPath ? { backupPath } : {}
			};
		} catch (error) {
			p.log.warn(error instanceof Error ? error.message : "Hermes installation failed; configuration was not activated.");
			return {
				kind: "skipped",
				reason: "native-install-failed"
			};
		}
	}
};
//#endregion
//#region src/cli/connect/kiro.ts
const adapter$7 = createJsonMcpAdapter({
	name: "kiro",
	displayName: "Kiro",
	detectDir: join(homedir(), ".kiro"),
	configPath: join(homedir(), ".kiro", "settings", "mcp.json"),
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "→ Using MCP via ~/.kiro/settings/mcp.json (user-level). Workspace overrides live in .kiro/settings/mcp.json."
});
//#endregion
//#region src/cli/connect/openclaw.ts
const paths = () => {
	const home = nativeUserPath(process.env.OPENCLAW_HOME?.trim() || homedir(), homedir());
	const preferred = join(home, ".openclaw");
	const legacy = join(home, ".clawdbot");
	const state = process.env.OPENCLAW_STATE_DIR?.trim() ? nativeUserPath(process.env.OPENCLAW_STATE_DIR.trim(), home) : !existsSync(preferred) && existsSync(legacy) ? legacy : preferred;
	return {
		state,
		config: process.env.OPENCLAW_CONFIG_PATH?.trim() ? nativeUserPath(process.env.OPENCLAW_CONFIG_PATH.trim(), home) : !existsSync(join(state, "openclaw.json")) && existsSync(join(state, "clawdbot.json")) ? join(state, "clawdbot.json") : join(state, "openclaw.json")
	};
};
const stringList = (value) => value === void 0 || Array.isArray(value) && value.every((item) => typeof item === "string");
const adapter$6 = {
	name: "openclaw",
	displayName: "OpenClaw",
	category: "native",
	docs: "https://github.com/rohitg00/agentmemory/tree/main/integrations/openclaw",
	protocolNote: "→ Installs native recall/capture and bundled skills into the active OpenClaw state directory. MCP tools are opt-in with --with-mcp.",
	detect: () => existsSync(paths().config) || existsSync(paths().state),
	async install(opts) {
		const { state, config: configPath } = paths();
		const raw = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
		let existing;
		try {
			existing = raw ? JSON5.parse(raw) : {};
		} catch {
			existing = null;
		}
		if (!record(existing) || [
			"mcp",
			"plugins",
			"skills"
		].some((key) => existing[key] !== void 0 && !record(existing[key]))) {
			p.log.warn(`OpenClaw config is not a valid JSON/JSON5 object. Left ${configPath} unchanged.`);
			return {
				kind: "skipped",
				reason: "invalid-config"
			};
		}
		const next = { ...existing };
		const mcp = { ...next.mcp ?? {} };
		if (mcp.servers !== void 0 && !record(mcp.servers)) return {
			kind: "skipped",
			reason: "invalid-config"
		};
		const servers = { ...mcp.servers ?? {} };
		const legacyServers = record(next.mcpServers) ? { ...next.mcpServers } : {};
		const legacy = legacyServers.agentmemory;
		const migrateLegacy = record(legacy) && legacy.command === "npx" && Array.isArray(legacy.args) && legacy.args.includes("@agentmemory/mcp");
		if (next.mcpServers !== void 0 && (!migrateLegacy || Object.keys(legacyServers).some((key) => key !== "agentmemory"))) {
			p.log.warn("OpenClaw rejects the legacy mcpServers key. Left the file unchanged; migrate custom servers with OpenClaw's native configuration tools first.");
			return {
				kind: "skipped",
				reason: "legacy-config-needs-migration"
			};
		}
		if (servers.agentmemory !== void 0 && !record(servers.agentmemory) && !(opts.force && opts.withMcp)) {
			p.log.warn("OpenClaw's AgentMemory MCP entry is invalid. Repair it or use --force --with-mcp.");
			return {
				kind: "skipped",
				reason: "invalid-entry"
			};
		}
		const plugins = { ...next.plugins ?? {} };
		const skills = { ...next.skills ?? {} };
		if (["entries", "slots"].some((key) => plugins[key] !== void 0 && !record(plugins[key])) || skills.load !== void 0 && !record(skills.load) || !stringList(plugins.allow) || !stringList(plugins.deny)) return {
			kind: "skipped",
			reason: "invalid-config"
		};
		const entries = { ...plugins.entries ?? {} };
		const slots = { ...plugins.slots ?? {} };
		if (!stringList({ ...skills.load ?? {} }.extraDirs) || entries.agentmemory !== void 0 && !record(entries.agentmemory) || slots.memory !== void 0 && typeof slots.memory !== "string") return {
			kind: "skipped",
			reason: "invalid-config"
		};
		if (slots.memory !== void 0 && slots.memory !== "agentmemory" && !opts.force) {
			p.log.warn("OpenClaw already selects another memory plugin. Use --force to select AgentMemory and keep a backup.");
			return {
				kind: "skipped",
				reason: "memory-provider-conflict"
			};
		}
		const entry = { ...entries.agentmemory ?? {} };
		if (entry.hooks !== void 0 && !record(entry.hooks)) return {
			kind: "skipped",
			reason: "invalid-config"
		};
		const hooks = { ...entry.hooks ?? {} };
		if (plugins.enabled === false || !opts.force && (entry.enabled === false || hooks.allowConversationAccess === false || plugins.deny?.includes("agentmemory"))) {
			p.log.warn("OpenClaw plugin execution or AgentMemory conversation access is disabled. Enable it explicitly before connecting, or use --force for AgentMemory's own settings.");
			return {
				kind: "skipped",
				reason: "plugin-disabled"
			};
		}
		try {
			const root = nativePackageRoot();
			const bundles = [prepareNativeBundle(join(root, "integrations", "openclaw"), join(state, "extensions", "agentmemory"), "openclaw-plugin", [
				"plugin.mjs",
				"openclaw.plugin.json",
				"package.json"
			], opts.force, join(root, "plugin", "skills"))];
			if (opts.withMcp || migrateLegacy) {
				p.log.warn("MCP exposes all AgentMemory tools against the configured backend. It does not enforce native profile scope; use it only for a trusted, deliberately shared backend.");
				if (servers.agentmemory === void 0 || opts.force) {
					const migrated = migrateLegacy && !opts.force ? { ...legacy } : {};
					const runtime = nativeMcpEntry(root);
					const env = {
						...runtime.env,
						...record(migrated.env) ? migrated.env : {}
					};
					for (const [key, value] of Object.entries(env)) {
						if (key === "AGENTMEMORY_URL" && value === "${AGENTMEMORY_URL:-http://localhost:3111}" || key === "AGENTMEMORY_SECRET" && value === "${AGENTMEMORY_SECRET:-}") delete env[key];
						if (key === "AGENTMEMORY_TOOLS" && value === "${AGENTMEMORY_TOOLS:-all}") env[key] = "all";
					}
					servers.agentmemory = {
						...migrated,
						...runtime,
						transport: "stdio",
						env
					};
				} else p.log.info("Preserved the existing AgentMemory MCP entry. After moving the installed package, review its settings and reconnect with --with-mcp --force to refresh its runtime path.");
				if (migrateLegacy) delete next.mcpServers;
				next.mcp = {
					...mcp,
					servers
				};
			}
			entries.agentmemory = {
				...entry,
				enabled: true,
				hooks: {
					...hooks,
					allowConversationAccess: true
				}
			};
			plugins.entries = entries;
			plugins.slots = {
				...slots,
				memory: "agentmemory"
			};
			if (plugins.allow !== void 0) plugins.allow = [...new Set([...plugins.allow, "agentmemory"])];
			if (plugins.deny?.includes("agentmemory")) plugins.deny = plugins.deny.filter((name) => name !== "agentmemory");
			next.plugins = plugins;
			const configText = JSON.stringify(next) === JSON.stringify(existing) ? raw : JSON.stringify(next, null, 2) + "\n";
			if (opts.dryRun) {
				p.log.info(`[dry-run] Would install native plugin and skills, then activate AgentMemory in ${configPath}`);
				return {
					kind: "installed",
					mutatedPath: configPath
				};
			}
			if (!bundles.some((bundle) => bundle.changed) && configText === raw) {
				logAlreadyWired(this.displayName, configPath);
				return {
					kind: "already-wired",
					mutatedPath: configPath
				};
			}
			const backupPath = installNativeBundles(bundles, configPath, configText);
			if (backupPath) logBackup(backupPath);
			logInstalled(this.displayName, configPath);
			p.log.info("Start AgentMemory and verify capture and recall in a new OpenClaw session. Skills that call memory tools require --with-mcp; authentication and connectivity are not yet verified.");
			return {
				kind: "installed",
				mutatedPath: configPath,
				...backupPath ? { backupPath } : {}
			};
		} catch (error) {
			p.log.warn(error instanceof Error ? error.message : "OpenClaw installation failed; configuration was not activated.");
			return {
				kind: "skipped",
				reason: "native-install-failed"
			};
		}
	}
};
//#endregion
//#region src/cli/connect/opencode.ts
const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json");
const DETECT_DIR = join(homedir(), ".config", "opencode");
const OPENCODE_ENTRY = {
	type: "local",
	command: [
		"npx",
		"-y",
		"@agentmemory/mcp"
	],
	enabled: true
};
function entryMatches(entry) {
	if (!entry || typeof entry !== "object") return false;
	const command = entry["command"];
	return Array.isArray(command) && command.includes("@agentmemory/mcp");
}
const adapter$5 = {
	name: "opencode",
	displayName: "OpenCode",
	category: "mcp",
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "Using MCP via ~/.config/opencode/opencode.json (top-level `mcp` key). For full auto-capture, also install the bundled plugin in plugin/opencode/.",
	detect() {
		return existsSync(DETECT_DIR);
	},
	async install(opts) {
		const existing = readJsonSafe(CONFIG_PATH);
		const next = existing ? { ...existing } : {};
		const existingMcp = next["mcp"];
		const mcp = existingMcp && typeof existingMcp === "object" && !Array.isArray(existingMcp) ? { ...existingMcp } : {};
		const alreadyHas = entryMatches(mcp["agentmemory"]);
		if (alreadyHas && !opts.force) {
			logAlreadyWired(this.displayName, CONFIG_PATH);
			return {
				kind: "already-wired",
				mutatedPath: CONFIG_PATH
			};
		}
		if (opts.dryRun) {
			p.log.info(`[dry-run] Would ${alreadyHas ? "overwrite" : "add"} mcp.agentmemory in ${CONFIG_PATH}`);
			return {
				kind: "installed",
				mutatedPath: CONFIG_PATH
			};
		}
		let backupPath;
		if (existsSync(CONFIG_PATH)) {
			backupPath = backupFile(CONFIG_PATH, this.name);
			logBackup(backupPath);
		} else mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		mcp["agentmemory"] = { ...OPENCODE_ENTRY };
		next["mcp"] = mcp;
		writeJsonAtomic(CONFIG_PATH, next);
		const verifyMcp = readJsonSafe(CONFIG_PATH)?.["mcp"];
		if (!entryMatches(verifyMcp?.["agentmemory"])) {
			p.log.error(`Verification failed: ${CONFIG_PATH} did not contain mcp.agentmemory after write.`);
			return {
				kind: "skipped",
				reason: "verification-failed"
			};
		}
		logInstalled(this.displayName, CONFIG_PATH);
		return {
			kind: "installed",
			mutatedPath: CONFIG_PATH,
			...backupPath !== void 0 && { backupPath }
		};
	}
};
//#endregion
//#region src/cli/connect/openhuman.ts
const OPENHUMAN_DIR = join(homedir(), ".openhuman");
const DOCS$1 = "https://github.com/tinyhumansai/openhuman";
const adapter$4 = {
	name: "openhuman",
	displayName: "OpenHuman",
	category: "native",
	docs: DOCS$1,
	protocolNote: "→ Using native hooks (REST API at :3111). MCP not required.",
	detect() {
		return existsSync(OPENHUMAN_DIR);
	},
	async install(_opts) {
		p.log.warn("OpenHuman integration is not yet automated. No `integrations/openhuman/` folder exists in the agentmemory repo today.");
		p.note([
			"OpenHuman is a Memory-trait host. The expected wiring is the REST",
			"proxy at http://localhost:3111 plus an OpenHuman-side Memory trait",
			"impl. Once integrations/openhuman/ lands in agentmemory we'll wire",
			"this up automatically.",
			"",
			`Tracking: ${DOCS$1}`
		].join("\n"), "OpenHuman manual install");
		return {
			kind: "stub",
			reason: "no-integration-folder-yet"
		};
	}
};
//#endregion
//#region src/cli/connect/pi.ts
const PI_DIR = join(homedir(), ".pi");
const PI_EXT_DIR = join(PI_DIR, "agent", "extensions", "agentmemory");
const DOCS = "https://github.com/rohitg00/agentmemory/tree/main/integrations/pi";
const EXT_FILES = ["index.ts", "security.ts"];
function findPiSourceDir() {
	let packageRoot;
	try {
		packageRoot = dirname(findPluginRoot());
	} catch {
		return null;
	}
	const dir = join(packageRoot, "integrations", "pi");
	return EXT_FILES.every((f) => existsSync(join(dir, f))) ? dir : null;
}
const adapter$3 = {
	name: "pi",
	displayName: "pi",
	category: "native",
	docs: DOCS,
	protocolNote: "→ Using native lifecycle hooks against the REST API at :3111 (recall on agent start, capture on agent end, memory tools). MCP not required.",
	detect() {
		return existsSync(PI_DIR);
	},
	async install(opts) {
		const sourceDir = findPiSourceDir();
		if (!sourceDir) {
			p.log.error("Bundled pi extension not found (integrations/pi missing from the install) — reinstall agentmemory.");
			return {
				kind: "skipped",
				reason: "bundled-extension-missing"
			};
		}
		const sources = EXT_FILES.map((f) => ({
			name: f,
			content: readFileSync(join(sourceDir, f), "utf-8"),
			target: join(PI_EXT_DIR, f)
		}));
		if (sources.every((s) => existsSync(s.target) && readFileSync(s.target, "utf-8") === s.content) && !opts.force) {
			logAlreadyWired(this.displayName, PI_EXT_DIR);
			return {
				kind: "already-wired",
				mutatedPath: PI_EXT_DIR
			};
		}
		if (opts.dryRun) {
			p.log.info(`[dry-run] Would install the pi extension (${EXT_FILES.join(", ")}) into ${PI_EXT_DIR}`);
			return {
				kind: "installed",
				mutatedPath: PI_EXT_DIR
			};
		}
		let backupPath;
		for (const s of sources) if (existsSync(s.target) && readFileSync(s.target, "utf-8") !== s.content) {
			const backup = backupFile(s.target, `${this.name}-${s.name.replace(/\.ts$/, "")}`, "ts");
			logBackup(backup);
			backupPath ??= backup;
		}
		mkdirSync(PI_EXT_DIR, { recursive: true });
		for (const s of sources) writeTextAtomic(s.target, s.content);
		if (!sources.every((s) => existsSync(s.target) && readFileSync(s.target, "utf-8") === s.content)) {
			p.log.error(`Verification failed: ${PI_EXT_DIR} does not match the bundled extension.`);
			return {
				kind: "skipped",
				reason: "verification-failed"
			};
		}
		logInstalled(this.displayName, PI_EXT_DIR);
		p.log.info("pi auto-discovers the extension on next launch; a running pi picks it up with /reload. Verify with /agentmemory-status.");
		return {
			kind: "installed",
			mutatedPath: PI_EXT_DIR,
			backupPath
		};
	}
};
//#endregion
//#region src/cli/connect/qwen.ts
const adapter$2 = createJsonMcpAdapter({
	name: "qwen",
	displayName: "Qwen Code",
	detectDir: join(homedir(), ".qwen"),
	configPath: join(homedir(), ".qwen", "settings.json"),
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "→ Using MCP via ~/.qwen/settings.json. Qwen Code's hook system can also be wired separately — see docs."
});
//#endregion
//#region src/cli/connect/warp.ts
const adapter$1 = createJsonMcpAdapter({
	name: "warp",
	displayName: "Warp",
	detectDir: join(homedir(), ".warp"),
	configPath: join(homedir(), ".warp", ".mcp.json"),
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "→ Using MCP via ~/.warp/.mcp.json. Skills auto-discover from .claude/skills/ if the Claude Code plugin is also installed."
});
//#endregion
//#region src/cli/connect/zed.ts
const zedConfigDir = join(homedir(), ".config", "zed");
const adapter = createJsonMcpAdapter({
	name: "zed",
	displayName: "Zed",
	detectDir: zedConfigDir,
	configPath: join(zedConfigDir, "settings.json"),
	wrapperKey: "context_servers",
	docs: "https://github.com/rohitg00/agentmemory#other-agents",
	protocolNote: "→ Using MCP via ~/.config/zed/settings.json (key: context_servers)."
});
//#endregion
//#region src/cli/connect/index.ts
var connect_exports = /* @__PURE__ */ __exportAll({
	ADAPTERS: () => ADAPTERS,
	knownAgents: () => knownAgents,
	resolveAdapter: () => resolveAdapter,
	runAdapter: () => runAdapter,
	runConnect: () => runConnect
});
const ADAPTERS = [
	adapter$18,
	adapter$16,
	adapter$15,
	adapter$13,
	adapter$12,
	adapter$9,
	adapter$2,
	adapter$19,
	adapter$20,
	adapter$7,
	adapter$1,
	adapter$17,
	adapter$14,
	adapter,
	adapter$11,
	adapter$10,
	adapter$5,
	adapter$6,
	adapter$8,
	adapter$3,
	adapter$4
];
function resolveAdapter(name) {
	const lower = name.toLowerCase();
	return ADAPTERS.find((a) => a.name === lower) ?? null;
}
function knownAgents() {
	return ADAPTERS.map((a) => a.name);
}
function parseFlags(args) {
	const positional = [];
	let dryRun = false;
	let force = false;
	let all = false;
	let withHooks = false;
	let withMcp = false;
	let guidelines = true;
	for (const a of args) if (a === "--dry-run") dryRun = true;
	else if (a === "--force") force = true;
	else if (a === "--all") all = true;
	else if (a === "--with-hooks") withHooks = true;
	else if (a === "--with-mcp") withMcp = true;
	else if (a === "--no-guidelines") guidelines = false;
	else if (!a.startsWith("-")) positional.push(a);
	return {
		dryRun,
		force,
		all,
		withHooks,
		withMcp,
		guidelines,
		positional
	};
}
async function runAdapter(adapter, opts) {
	if (!adapter.detect()) {
		p.log.warn(`${adapter.displayName}: not detected on this machine (skipping).${adapter.docs ? ` Docs: ${adapter.docs}` : ""}`);
		return {
			kind: "skipped",
			reason: "not-detected"
		};
	}
	p.log.step(`Wiring ${adapter.displayName}…`);
	if (adapter.protocolNote) p.log.message(adapter.protocolNote);
	try {
		const result = await adapter.install(opts);
		if (opts.guidelines !== false && (result.kind === "installed" || result.kind === "already-wired")) try {
			const g = writeGuideline(adapter.name, {
				cwd: process.cwd(),
				dryRun: opts.dryRun
			});
			if (g.kind === "written") p.log.message(`  ${pc.dim("guideline")} ${g.scope} → ${g.path} (memory auto-use)`);
			else if (g.kind === "would-write") p.log.message(`  ${pc.dim("[dry-run] guideline")} → ${g.path}`);
		} catch (gerr) {
			p.log.warn(`${adapter.displayName}: guideline not written (${gerr instanceof Error ? gerr.message : String(gerr)})`);
		}
		return result;
	} catch (err) {
		p.log.error(`${adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`);
		return {
			kind: "skipped",
			reason: "exception"
		};
	}
}
async function runConnect(args) {
	const { dryRun, force, all, withHooks, withMcp, guidelines, positional } = parseFlags(args);
	const allowWindowsAdapter = positional.length === 1 && positional[0]?.toLowerCase() === "copilot-cli";
	if (platform() === "win32" && !allowWindowsAdapter) {
		p.intro("agentmemory connect");
		p.log.warn("Windows: automated `connect` is not supported yet. See https://github.com/rohitg00/agentmemory#other-agents for manual install steps.");
		p.outro("Windows: manual install required — see docs");
		return;
	}
	const opts = {
		dryRun,
		force,
		withHooks,
		withMcp,
		guidelines
	};
	p.intro("agentmemory connect");
	if (positional.length === 0 && !all) {
		const detected = ADAPTERS.filter((a) => a.detect());
		if (detected.length === 0) {
			p.log.error("No supported agents detected on this machine.");
			p.outro(`Supported: ${knownAgents().join(", ")}`);
			process.exit(1);
		}
		const picked = await p.multiselect({
			message: "Wire agentmemory into which agents?",
			options: detected.map((a) => ({
				value: a.name,
				label: a.displayName
			})),
			required: true
		});
		if (p.isCancel(picked)) {
			p.cancel("Cancelled.");
			return;
		}
		const results = [];
		for (const name of picked) {
			const adapter = resolveAdapter(name);
			if (!adapter) continue;
			results.push({
				name,
				result: await runAdapter(adapter, opts)
			});
		}
		summarize(results);
		return;
	}
	if (all) {
		const detected = ADAPTERS.filter((a) => a.detect());
		if (detected.length === 0) {
			p.log.error("No supported agents detected on this machine.");
			process.exit(1);
		}
		const results = [];
		for (const adapter of detected) results.push({
			name: adapter.name,
			result: await runAdapter(adapter, opts)
		});
		summarize(results);
		return;
	}
	const agentName = positional[0];
	const adapter = resolveAdapter(agentName);
	if (!adapter) {
		p.log.error(`Unknown agent: ${agentName}`);
		p.outro(`Supported: ${knownAgents().join(", ")}`);
		process.exit(1);
	}
	const result = await runAdapter(adapter, opts);
	summarize([{
		name: agentName,
		result
	}]);
	if (result.kind === "skipped" && result.reason !== "not-detected") process.exit(1);
}
function summarize(results) {
	const lines = results.map(({ name, result }) => {
		switch (result.kind) {
			case "installed": return `  ${pc.green("✓")} ${pc.bold(name)}${result.mutatedPath ? ` ${pc.dim("→")} ${pc.cyan(result.mutatedPath)}` : ""}`;
			case "already-wired": return `  ${pc.green("✓")} ${pc.bold(name)} ${pc.dim("(already wired)")}`;
			case "stub": return `  ${pc.yellow("⚠")} ${pc.bold(name)} ${pc.yellow(`(manual install required: ${result.reason})`)}`;
			case "skipped": return `  ${pc.red("✗")} ${pc.bold(name)} ${pc.dim(`(skipped: ${result.reason})`)}`;
		}
	});
	p.note(lines.join("\n"), "summary");
	const stubs = results.filter((r) => r.result.kind === "stub");
	if (stubs.length > 0) p.log.info(`${stubs.length} agent(s) require manual install — see docs links above.`);
	if (results.some((r) => ![
		"hermes",
		"hermes-agent",
		"openclaw",
		"claw"
	].includes(r.name) && (r.result.kind === "installed" || r.result.kind === "already-wired"))) p.log.info("Next: install agentmemory's 17 skills into the same agent(s) so they know when to call the tools:\n  npx skills@1.7.1 add rohitg00/agentmemory -y");
	p.outro("Restart any wired agent (or open a new session) to pick up agentmemory.");
}
//#endregion
export { runAdapter as a, resolveAdapter as i, connect_exports as n, knownAgents as r, ADAPTERS as t };

//# sourceMappingURL=connect-lMnCKiNM.mjs.map
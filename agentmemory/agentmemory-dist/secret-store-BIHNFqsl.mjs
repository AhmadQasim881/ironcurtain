import { a as KV, c as generateId, r as withKeyedLock } from "./keyed-mutex-B2ARAhzY.mjs";
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import pc from "picocolors";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
//#region src/cli/engine-config.ts
const SEEDED_BUILTIN_WORKERS = [
	"http",
	"iii-http",
	"state",
	"iii-state",
	"queue",
	"iii-queue",
	"pubsub",
	"iii-pubsub",
	"cron",
	"iii-cron",
	"iii-stream",
	"iii-observability",
	"iii-worker-manager"
];
function configuredPersistDir(renderedConfig) {
	const lines = renderedConfig.split("\n");
	const block = workerBlock(lines, "configuration");
	if (!block) return null;
	for (let i = block.start + 1; i < block.end; i++) {
		const match = lines[i].trim().match(/^directory:\s*(.+?)\s*$/);
		if (match) return match[1].replace(/^(['"])(.*)\1$/, "$2");
	}
	return null;
}
const ENGINE_DEFAULT_SAVE_INTERVAL_MS = 5e3;
const ENGINE_FLUSH_MARGIN_MS = 1500;
function engineFlushWaitMs(stateBackend, configTexts) {
	if (stateBackend === "redis") return 0;
	return engineSaveIntervalMs(configTexts) + ENGINE_FLUSH_MARGIN_MS;
}
function captureDurableAfterMs(stateBackend, configTexts) {
	if (stateBackend === "redis") return ENGINE_FLUSH_MARGIN_MS;
	return engineSaveIntervalMs(configTexts) + ENGINE_FLUSH_MARGIN_MS;
}
function engineSaveIntervalMs(configTexts) {
	const intervals = [];
	for (const text of configTexts) {
		const explicit = [...text.matchAll(/save_interval_ms:\s*(\d+)/g)].map((m) => parseInt(m[1], 10));
		intervals.push(...explicit);
		if ((text.match(/store_method:\s*file_based/g)?.length ?? 0) > explicit.length) intervals.push(ENGINE_DEFAULT_SAVE_INTERVAL_MS);
	}
	return intervals.length > 0 ? Math.max(...intervals) : ENGINE_DEFAULT_SAVE_INTERVAL_MS;
}
function engineStateConfigPaths(engineCwd, runtimePath) {
	return [...persistedBuiltinConfigDirs(engineCwd, runtimePath).map((dir) => join(dir, "iii-state.yaml")), runtimePath];
}
function persistedBuiltinConfigDirs(engineCwd, configPath, renderedConfig) {
	const dirs = [
		join(engineCwd, "config"),
		join(dirname(configPath), "config"),
		join(engineCwd, "data", "configuration")
	];
	const custom = renderedConfig ? configuredPersistDir(renderedConfig) : null;
	if (custom) dirs.unshift(resolve(engineCwd, custom));
	return [...new Set(dirs)];
}
function persistedBuiltinConfigPaths(engineCwd, configPath, renderedConfig) {
	return persistedBuiltinConfigDirs(engineCwd, configPath, renderedConfig).flatMap((dir) => SEEDED_BUILTIN_WORKERS.map((id) => join(dir, `${id}.yaml`)));
}
function isPersistedBuiltinEntry(content, id) {
	return content.split("\n").find((line) => line.trim() !== "")?.trim() === `id: ${id}`;
}
function clearPersistedBuiltinConfig(engineCwd, configPath, renderedConfig) {
	const cleared = [];
	for (const path of persistedBuiltinConfigPaths(engineCwd, configPath, renderedConfig)) try {
		if (!isPersistedBuiltinEntry(readFileSync(path, "utf8"), basename(path, ".yaml"))) continue;
		rmSync(path);
		cleared.push(path);
	} catch (err) {
		if (err.code === "ENOENT") continue;
		throw new Error(`could not remove persisted engine config ${path}: ${String(err)}`);
	}
	return cleared;
}
function yamlSingleQuote(value) {
	return `'${value.replace(/'/g, "''")}'`;
}
function workerBlock(lines, name) {
	const marker = `- name: ${name}`;
	const start = lines.findIndex((line) => line.trim() === marker);
	if (start === -1) return null;
	const indent = lines[start].match(/^\s*/)?.[0] ?? "";
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith(indent) && line.trim().startsWith("- name: ")) {
			end = i;
			break;
		}
	}
	return {
		start,
		end,
		indent
	};
}
function setWorkerPort(lines, name, port) {
	let block = workerBlock(lines, name);
	if (!block && name === "iii-worker-manager") {
		const workersIndex = lines.findIndex((line) => line.trim() === "workers:");
		if (workersIndex === -1) return;
		lines.splice(workersIndex + 1, 0, "  - name: iii-worker-manager", "    config:", `      port: ${port}`, "      host: 127.0.0.1");
		return;
	}
	if (!block) return;
	const portIndex = lines.findIndex((line, index) => index > block.start && index < block.end && line.trim().startsWith("port:"));
	if (portIndex !== -1) {
		lines[portIndex] = `${lines[portIndex].match(/^\s*/)?.[0] ?? `${block.indent}    `}port: ${port}`;
		return;
	}
	const configIndex = lines.findIndex((line, index) => index > block.start && index < block.end && line.trim() === "config:");
	if (configIndex !== -1) {
		const configIndent = lines[configIndex].match(/^\s*/)?.[0] ?? `${block.indent}  `;
		lines.splice(configIndex + 1, 0, `${configIndent}  port: ${port}`);
	}
}
function setFileStoreSaveInterval(lines, workerName, override) {
	const block = workerBlock(lines, workerName);
	if (!block) return;
	const methodIndex = lines.findIndex((line, index) => index > block.start && index < block.end && line.trim() === "store_method: file_based");
	if (methodIndex === -1) return;
	const indent = lines[methodIndex].match(/^\s*/)?.[0] ?? "";
	const intervalIndex = lines.findIndex((line, index) => index > block.start && index < block.end && line.trim().startsWith("save_interval_ms:"));
	if (intervalIndex !== -1) {
		if (override === void 0) return;
		lines[intervalIndex] = `${lines[intervalIndex].match(/^\s*/)?.[0] ?? indent}save_interval_ms: ${override}`;
		return;
	}
	lines.splice(methodIndex + 1, 0, `${indent}save_interval_ms: ${override ?? 2e3}`);
}
const REDIS_URL_ENV_REF = "${AGENTMEMORY_REDIS_URL}";
const UNSAFE_REDIS_URL_CHARS = /['\u0000-\u001f\u007f]/;
function replaceKvAdapterWithRedis(lines, workerName) {
	const block = workerBlock(lines, workerName);
	if (!block) throw new Error(`AGENTMEMORY_STATE_BACKEND=redis requires a "${workerName}" worker in the engine config, but none was found.`);
	const adapterIndex = lines.findIndex((line, index) => index > block.start && index < block.end && line.trim() === "adapter:");
	if (adapterIndex === -1) throw new Error(`AGENTMEMORY_STATE_BACKEND=redis requires an "adapter:" block under the "${workerName}" worker in the engine config, but none was found.`);
	const adapterIndent = lines[adapterIndex].match(/^\s*/)?.[0] ?? "";
	let end = block.end;
	for (let i = adapterIndex + 1; i < block.end; i++) {
		const line = lines[i];
		if (line.trim() === "") continue;
		if ((line.match(/^\s*/)?.[0] ?? "").length <= adapterIndent.length) {
			end = i;
			break;
		}
	}
	const childIndent = `${adapterIndent}  `;
	const grandchildIndent = `${adapterIndent}    `;
	lines.splice(adapterIndex + 1, end - (adapterIndex + 1), `${childIndent}name: redis`, `${childIndent}config:`, `${grandchildIndent}redis_url: ${yamlSingleQuote(REDIS_URL_ENV_REF)}`);
}
function indentWidth(line) {
	return line.length - line.trimStart().length;
}
function mappingValueEnd(lines, keyIndex, limit) {
	const keyIndent = indentWidth(lines[keyIndex]);
	let end = keyIndex + 1;
	for (let i = keyIndex + 1; i < limit; i++) {
		const text = lines[i].trim();
		if (text === "" || text.startsWith("#")) continue;
		const indent = indentWidth(lines[i]);
		if (!(indent > keyIndent || indent === keyIndent && /^(-(\s|$)|[\]}])/.test(text))) break;
		end = i + 1;
	}
	return end;
}
function setManagedCorsOrigins(lines, restPort, viewerPort) {
	const block = workerBlock(lines, "iii-http");
	if (!block) return;
	const originsIndex = lines.findIndex((line, index) => index > block.start && index < block.end && line.trim().startsWith("allowed_origins:"));
	if (originsIndex === -1) return;
	const indent = lines[originsIndex].match(/^\s*/)?.[0] ?? "        ";
	const valueEnd = mappingValueEnd(lines, originsIndex, block.end);
	lines.splice(originsIndex + 1, valueEnd - originsIndex - 1);
	lines[originsIndex] = `${indent}allowed_origins: ["http://localhost:${restPort}", "http://localhost:${viewerPort}", "http://127.0.0.1:${restPort}", "http://127.0.0.1:${viewerPort}"]`;
}
function renderEngineConfig(template, options) {
	if (options.stateBackend?.kind === "redis" && !options.stateBackend.redisUrl) throw new Error("AGENTMEMORY_STATE_BACKEND=redis requires AGENTMEMORY_REDIS_URL to be set (e.g. redis://localhost:6379).");
	if (options.stateBackend?.kind === "redis" && UNSAFE_REDIS_URL_CHARS.test(options.stateBackend.redisUrl ?? "")) throw new Error("AGENTMEMORY_REDIS_URL contains a single quote or a control character, which breaks the engine config once the engine expands it. Percent-encode those characters in the URL (for example a single quote as %27).");
	const rendered = template.replace("file_path: ./data/state_store.db", `file_path: ${yamlSingleQuote(join(options.dataDir, "state_store.db"))}`).replace("file_path: ./data/stream_store", `file_path: ${yamlSingleQuote(join(options.dataDir, "stream_store"))}`);
	const usesRedis = options.stateBackend?.kind === "redis";
	const lines = rendered.split("\n");
	setFileStoreSaveInterval(lines, "iii-state", options.saveIntervalMs);
	setFileStoreSaveInterval(lines, "iii-stream", options.saveIntervalMs);
	if (options.ports) {
		setWorkerPort(lines, "iii-http", options.ports.restPort);
		setWorkerPort(lines, "iii-stream", options.ports.streamPort);
		setWorkerPort(lines, "iii-worker-manager", options.ports.enginePort);
		setManagedCorsOrigins(lines, options.ports.restPort, options.ports.viewerPort);
	}
	if (usesRedis) {
		replaceKvAdapterWithRedis(lines, "iii-state");
		replaceKvAdapterWithRedis(lines, "iii-stream");
	}
	return lines.join("\n");
}
//#endregion
//#region src/cli/engine-launch.ts
function agentmemoryHome(home) {
	return join(home, ".agentmemory");
}
function runtimeConfigPath(dataDir) {
	return join(dataDir, "iii-config.runtime.yaml");
}
function dockerProjectName(restPort) {
	return `agentmemory-${restPort}`;
}
function dockerComposeArgs(composeFile, projectName, command) {
	return [
		"compose",
		...projectName ? ["-p", projectName] : [],
		"-f",
		composeFile,
		...command
	];
}
function isBundledConfig(configPath, packageDir) {
	const resolved = resolve(configPath);
	return resolved === resolve(join(packageDir, "iii-config.yaml")) || resolved === resolve(join(packageDir, "..", "iii-config.yaml"));
}
function resolveEngineCwd(configPath, invocationCwd, home, bundledConfig = false) {
	if (bundledConfig) return agentmemoryHome(home);
	return dirname(isAbsolute(configPath) ? configPath : resolve(invocationCwd, configPath));
}
function indentation(line) {
	return line.length - line.trimStart().length;
}
function yamlScalar(value) {
	const trimmed = value.trim();
	const first = trimmed[0];
	const last = trimmed.at(-1);
	if (first === "\"" && last === "\"" || first === "'" && last === "'") return trimmed.slice(1, -1);
	return trimmed;
}
function isAgentmemoryExecCommand(line, nodeBin, workerEntry) {
	const match = line.match(/^\s*-\s+(.+?)\s*$/);
	if (!match) return false;
	const command = yamlScalar(match[1]).replaceAll("\\", "/");
	return command === `${nodeBin} ${workerEntry}`.replaceAll("\\", "/") || /^(?:node|node\.exe)\s+\.\/dist\/index\.mjs$/.test(command) || /^(?:node|node\.exe)\s+dist\/index\.mjs$/.test(command);
}
function removeAgentmemoryExecCommand(raw, nodeBin, workerEntry) {
	const lines = raw.split("\n");
	const output = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (line.trim() !== "- name: iii-exec") {
			output.push(line);
			index++;
			continue;
		}
		const blockIndent = indentation(line);
		let blockEnd = index + 1;
		while (blockEnd < lines.length) {
			const candidate = lines[blockEnd];
			if (candidate.trim() !== "") {
				const candidateIndent = indentation(candidate);
				if (candidateIndent < blockIndent || candidateIndent === blockIndent && candidate.trim().startsWith("- name: ")) break;
			}
			blockEnd++;
		}
		const block = lines.slice(index, blockEnd);
		const execIndex = block.findIndex((candidate) => candidate.trim() === "exec:");
		if (execIndex === -1) {
			output.push(...block);
			index = blockEnd;
			continue;
		}
		const execIndent = indentation(block[execIndex]);
		let execEnd = execIndex + 1;
		while (execEnd < block.length) {
			const candidate = block[execEnd];
			if (candidate.trim() !== "" && indentation(candidate) <= execIndent) break;
			execEnd++;
		}
		const beforeExec = block.slice(0, execIndex + 1);
		const execLines = block.slice(execIndex + 1, execEnd);
		const afterExec = block.slice(execEnd);
		const remainingExecLines = execLines.filter((candidate) => !isAgentmemoryExecCommand(candidate, nodeBin, workerEntry));
		const removed = remainingExecLines.length !== execLines.length;
		const hasExecCommand = remainingExecLines.some((candidate) => /^\s*-\s+/.test(candidate) && indentation(candidate) > execIndent);
		if (!removed) output.push(...block);
		else if (hasExecCommand) output.push(...beforeExec, ...remainingExecLines, ...afterExec);
		index = blockEnd;
	}
	return output.join("\n");
}
function rewriteBundledConfig(raw, home, nodeBin, workerEntry, options) {
	return removeAgentmemoryExecCommand(renderEngineConfig(raw, {
		dataDir: options?.dataDir ?? join(agentmemoryHome(home), "data"),
		...options?.ports ? { ports: options.ports } : {},
		...options?.stateBackend ? { stateBackend: options.stateBackend } : {},
		...options?.saveIntervalMs !== void 0 ? { saveIntervalMs: options.saveIntervalMs } : {}
	}), nodeBin, workerEntry);
}
function legacyDataMigrations(invocationCwd, home, resolvedDataDir = join(agentmemoryHome(home), "data")) {
	return [{
		from: join(invocationCwd, "data", "state_store.db"),
		to: join(resolvedDataDir, "state_store.db")
	}, {
		from: join(invocationCwd, "data", "stream_store"),
		to: join(resolvedDataDir, "stream_store")
	}];
}
function engineChildEnv(base, platform = process.platform) {
	const env = {
		...base,
		III_TELEMETRY_ENABLED: base["III_TELEMETRY_ENABLED"] ?? "false"
	};
	if (platform === "linux" && !base.MALLOC_ARENA_MAX) env.MALLOC_ARENA_MAX = "2";
	return env;
}
function resolveLaunchRenderFailure(stateBackendKind, err) {
	if (stateBackendKind !== "redis") return { fatal: false };
	return {
		fatal: true,
		message: `Failed to render the Redis state backend into the engine config: ${err instanceof Error ? err.message : String(err)} Refusing to start the engine, since it would silently fall back to the file (or in-memory) store instead of Redis. Fix the config or unset AGENTMEMORY_STATE_BACKEND to use the default file store.`
	};
}
const CREDENTIAL_URL_PATTERN = /:\/\/[^@\s/]*@/g;
function redactCredentialUrls(text) {
	return text.replace(CREDENTIAL_URL_PATTERN, "://***@");
}
//#endregion
//#region src/logger.ts
function fmt(level, msg, fields) {
	if (!fields || Object.keys(fields).length === 0) return `[agentmemory] ${level} ${msg}`;
	try {
		return `[agentmemory] ${level} ${msg} ${JSON.stringify(fields)}`;
	} catch {
		return `[agentmemory] ${level} ${msg}`;
	}
}
function emit(level, msg, fields) {
	try {
		const line = fmt(level, msg, fields) + "\n";
		if (level === "error" || process.env["AGENTMEMORY_MCP_STDIO__"] === "1") process.stderr.write(line);
		else process.stdout.write(line);
	} catch {}
}
const logger = {
	info(msg, fields) {
		emit("info", msg, fields);
	},
	warn(msg, fields) {
		emit("warn", msg, fields);
	},
	error(msg, fields) {
		emit("error", msg, fields);
	}
};
let bootVerbose = process.env["AGENTMEMORY_VERBOSE"] === "1" || process.env["AGENTMEMORY_VERBOSE"] === "true";
const bootBuffer = [];
function setBootVerbose(enabled) {
	bootVerbose = enabled;
}
function bootLog(msg) {
	if (bootVerbose) {
		try {
			process.stderr.write(`[agentmemory] ${msg}\n`);
		} catch {}
		return;
	}
	if (bootBuffer.length < 500) bootBuffer.push(msg);
}
function bootWarn(msg) {
	try {
		process.stderr.write(`[agentmemory] warn ${msg}\n`);
	} catch {}
}
//#endregion
//#region src/config.ts
function safeParseInt(value, fallback) {
	if (!value) return fallback;
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}
const MAX_IMPORT_OBS_PER_SESSION = 5e3;
const DATA_DIR = join(homedir(), ".agentmemory");
const ENV_FILE = join(DATA_DIR, ".env");
let warnPremiumModelShown = false;
let providerNoticeShown = false;
let obsCapImportCeilingWarned = false;
function writeProviderNoticeOnce(text) {
	if (providerNoticeShown) return;
	providerNoticeShown = true;
	process.stderr.write(text);
}
let envFileCache;
function loadEnvFile() {
	if (envFileCache) return envFileCache;
	if (!existsSync(ENV_FILE)) {
		envFileCache = {};
		return envFileCache;
	}
	const content = readFileSync(ENV_FILE, "utf-8");
	const vars = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let val = trimmed.slice(eqIdx + 1).trim();
		const quoteChar = val[0] === "\"" || val[0] === "'" ? val[0] : "";
		if (quoteChar) {
			const closeIdx = val.indexOf(quoteChar, 1);
			if (closeIdx !== -1) val = val.slice(1, closeIdx);
		} else {
			const hashIdx = val.indexOf(" #");
			if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
		}
		vars[key] = val;
	}
	envFileCache = vars;
	return envFileCache;
}
function hasRealValue(v) {
	return typeof v === "string" && v.trim().length > 0;
}
function hydrateProcessEnvFromFile() {
	for (const [k, v] of Object.entries(loadEnvFile())) if (process.env[k] === void 0) process.env[k] = v;
}
function warnIfPremiumModel(env, envName, model) {
	if (warnPremiumModelShown || !/sonnet|opus|gpt-5\.\d+-sol|gpt-4o(?!.*mini)|gpt-4-turbo/i.test(model) || env["AGENTMEMORY_SUPPRESS_COST_WARNING"] === "1" || env["AGENTMEMORY_SUPPRESS_COST_WARNING"] === "true") return;
	warnPremiumModelShown = true;
	process.stderr.write(`[agentmemory] ${envName}=${model} is in the premium tier. Background compression on this model can cost $5+/day under active use. Cheaper alternatives with comparable quality for memory compression: deepseek/deepseek-v4-flash-0731, deepseek/deepseek-v4-pro, qwen/qwen3-coder. See README "Cost-aware model selection" for the full table. Set AGENTMEMORY_SUPPRESS_COST_WARNING=1 to silence.\n`);
}
function detectProvider(env) {
	const maxTokens = parseInt(env["MAX_TOKENS"] || "4096", 10);
	if (hasRealValue(env["OPENAI_API_KEY"]) && env["OPENAI_API_KEY_FOR_LLM"] !== "false") {
		const model = env["OPENAI_MODEL"] || "gpt-5.6-luna";
		warnIfPremiumModel(env, "OPENAI_MODEL", model);
		return {
			provider: "openai",
			model,
			maxTokens,
			baseURL: env["OPENAI_BASE_URL"]
		};
	}
	if (hasRealValue(env["MINIMAX_API_KEY"])) return {
		provider: "minimax",
		model: env["MINIMAX_MODEL"] || "MiniMax-M3",
		maxTokens
	};
	if (hasRealValue(env["ANTHROPIC_API_KEY"])) return {
		provider: "anthropic",
		model: env["ANTHROPIC_MODEL"] || "claude-sonnet-5",
		maxTokens,
		baseURL: env["ANTHROPIC_BASE_URL"]
	};
	if (hasRealValue(env["GEMINI_API_KEY"]) || hasRealValue(env["GOOGLE_API_KEY"])) {
		if (!hasRealValue(env["GEMINI_API_KEY"]) && hasRealValue(env["GOOGLE_API_KEY"])) process.stderr.write("[agentmemory] GOOGLE_API_KEY detected — treating as GEMINI_API_KEY. Set GEMINI_API_KEY in ~/.agentmemory/.env to silence this warning.\n");
		return {
			provider: "gemini",
			model: env["GEMINI_MODEL"] || "gemini-3.7-flash",
			maxTokens
		};
	}
	if (hasRealValue(env["OPENROUTER_API_KEY"])) {
		const model = env["OPENROUTER_MODEL"] || "anthropic/claude-sonnet-5";
		warnIfPremiumModel(env, "OPENROUTER_MODEL", model);
		return {
			provider: "openrouter",
			model,
			maxTokens
		};
	}
	if (!(env["AGENTMEMORY_ALLOW_AGENT_SDK"] === "true")) {
		writeProviderNoticeOnce(pc.dim("[agentmemory] No LLM provider key set — running zero-LLM: no LLM compression or summaries; search uses BM25 plus any configured embedding provider. Set EMBEDDING_PROVIDER=local for on-device semantic embeddings if none is configured. Set ANTHROPIC_API_KEY (or GEMINI/OPENAI/OPENROUTER/MINIMAX) in ~/.agentmemory/.env for LLM compression and summaries. Agent-SDK fallback stays off by default to avoid a Stop-hook recursion loop; opt in with AGENTMEMORY_AUTO_COMPRESS=true + AGENTMEMORY_ALLOW_AGENT_SDK=true.\n"));
		return {
			provider: "noop",
			model: "noop",
			maxTokens
		};
	}
	writeProviderNoticeOnce("[agentmemory] WARNING: agent-sdk fallback enabled via AGENTMEMORY_ALLOW_AGENT_SDK=true. This spawns @anthropic-ai/claude-agent-sdk child sessions that can trigger the Stop-hook recursion loop. A SDK-child env marker is set to block re-entry, but prefer setting a real API key in ~/.agentmemory/.env instead.\n");
	return {
		provider: "agent-sdk",
		model: "claude-sonnet-5",
		maxTokens
	};
}
function loadConfig() {
	const env = getMergedEnv();
	const provider = detectProvider(env);
	const restPort = parseInt(env["III_REST_PORT"] || "3111", 10) || 3111;
	const streamsPort = parseInt(env["III_STREAM_PORT"] || env["III_STREAMS_PORT"] || "", 10) || restPort + 1;
	const viewerPort = parseInt(env["III_VIEWER_PORT"] || "", 10) || restPort + 2;
	const engineUrl = env["III_ENGINE_URL"] || `ws://localhost:${parseInt(env["III_ENGINE_PORT"] || "", 10) || restPort + 46023}`;
	const maxObservationsPerSession = safeParseInt(env["MAX_OBS_PER_SESSION"], 500);
	if (!obsCapImportCeilingWarned && (maxObservationsPerSession === 0 || maxObservationsPerSession > 5e3)) {
		obsCapImportCeilingWarned = true;
		const capDesc = maxObservationsPerSession === 0 ? "uncapped (0)" : String(maxObservationsPerSession);
		process.stderr.write(`[agentmemory] WARNING: MAX_OBS_PER_SESSION is ${capDesc}, above the ${MAX_IMPORT_OBS_PER_SESSION}-per-session import ceiling (MAX_IMPORT_OBS_PER_SESSION). Sessions past that ceiling make every mem::export -> mem::import restore fail wholesale. Keep MAX_OBS_PER_SESSION at or below ${MAX_IMPORT_OBS_PER_SESSION} if you rely on export/import backups.\n`);
	}
	return {
		engineUrl,
		restPort,
		streamsPort,
		viewerPort,
		provider,
		tokenBudget: safeParseInt(env["TOKEN_BUDGET"], 2e3),
		maxObservationsPerSession,
		compressionModel: provider.model,
		dataDir: DATA_DIR
	};
}
function getMergedEnv(overrides) {
	return {
		...loadEnvFile(),
		...process.env,
		...overrides
	};
}
function getEnvVar(key) {
	return getMergedEnv()[key];
}
function isSessionSweepEnabled() {
	return getMergedEnv()["AGENTMEMORY_SESSION_SWEEP_ENABLED"] !== "false";
}
function getSessionSweepStaleHours() {
	const raw = getMergedEnv()["AGENTMEMORY_SESSION_SWEEP_STALE_HOURS"];
	if (!raw || !/^\d+$/.test(raw.trim())) return 24;
	const parsed = parseInt(raw.trim(), 10);
	return parsed > 0 ? parsed : 24;
}
function getFinalizeIdleMs() {
	const raw = getMergedEnv()["AGENTMEMORY_FINALIZE_IDLE_MS"];
	if (!raw || !/^\d+$/.test(raw.trim())) return 12e4;
	return parseInt(raw.trim(), 10);
}
function isGraphCompactOnBootEnabled() {
	return getMergedEnv()["AGENTMEMORY_GRAPH_COMPACT_ON_BOOT"] !== "false";
}
function isDropStaleIndexEnabled() {
	return getMergedEnv()["AGENTMEMORY_DROP_STALE_INDEX"] === "true";
}
const VALID_STATE_BACKENDS = new Set(["file", "redis"]);
function getStateBackend() {
	const raw = (getMergedEnv()["AGENTMEMORY_STATE_BACKEND"] || "").trim().toLowerCase();
	if (!raw) return "file";
	if (!VALID_STATE_BACKENDS.has(raw)) throw new Error(`AGENTMEMORY_STATE_BACKEND="${raw}" is not a recognized state backend. Use "file" (the default) or "redis", or unset it to keep the default file store.`);
	return raw;
}
function getRedisUrl() {
	const value = getMergedEnv()["AGENTMEMORY_REDIS_URL"];
	return hasRealValue(value) ? value.trim() : void 0;
}
function getAuditRetentionMonths() {
	return safeParseInt(getMergedEnv()["AGENTMEMORY_AUDIT_RETENTION_MONTHS"], 0);
}
function getAuditMigrateMaxBytes() {
	return safeParseInt(getMergedEnv()["AGENTMEMORY_AUDIT_MIGRATE_MAX_BYTES"], 32 * 1024 * 1024);
}
function detectLlmProviderKind(env = getMergedEnv()) {
	if (hasRealValue(env["ANTHROPIC_API_KEY"]) || hasRealValue(env["GEMINI_API_KEY"]) || hasRealValue(env["GOOGLE_API_KEY"]) || hasRealValue(env["OPENROUTER_API_KEY"]) || hasRealValue(env["MINIMAX_API_KEY"]) || hasRealValue(env["OPENAI_API_KEY"]) && env["OPENAI_API_KEY_FOR_LLM"] !== "false" || env["AGENTMEMORY_ALLOW_AGENT_SDK"] === "true") return "llm";
	return "noop";
}
function describeLlmRoute(provider) {
	if (provider.provider === "noop") return null;
	const parts = [provider.provider, provider.model];
	if (provider.baseURL) try {
		parts.push(new URL(provider.baseURL).host);
	} catch {
		parts.push("custom base URL");
	}
	return parts.join(" · ");
}
function loadEmbeddingConfig() {
	const env = getMergedEnv();
	let bm25Weight = parseFloat(env["BM25_WEIGHT"] || "0.4");
	let vectorWeight = parseFloat(env["VECTOR_WEIGHT"] || "0.6");
	bm25Weight = isNaN(bm25Weight) || bm25Weight < 0 ? .4 : Math.min(bm25Weight, 1);
	vectorWeight = isNaN(vectorWeight) || vectorWeight < 0 ? .6 : Math.min(vectorWeight, 1);
	return {
		provider: env["EMBEDDING_PROVIDER"] || void 0,
		bm25Weight,
		vectorWeight
	};
}
function detectEmbeddingProvider(env) {
	const source = env ?? getMergedEnv();
	const forced = source["EMBEDDING_PROVIDER"];
	if (forced) return forced;
	if (source["GEMINI_API_KEY"]) return "gemini";
	if (source["OPENAI_API_KEY"] || source["OPENAI_EMBEDDING_API_KEY"]) return "openai";
	if (source["VOYAGE_API_KEY"]) return "voyage";
	if (source["COHERE_API_KEY"]) return "cohere";
	if (source["OPENROUTER_API_KEY"]) return "openrouter";
	return null;
}
function loadClaudeBridgeConfig() {
	const env = getMergedEnv();
	const enabled = env["CLAUDE_MEMORY_BRIDGE"] === "true";
	const projectPath = env["CLAUDE_PROJECT_PATH"] || "";
	const lineBudget = safeParseInt(env["CLAUDE_MEMORY_LINE_BUDGET"], 200);
	let memoryFilePath = "";
	if (enabled && projectPath) {
		const safePath = projectPath.replace(/[/\\]/g, "-");
		memoryFilePath = join(homedir(), ".claude", "projects", safePath, "memory", "MEMORY.md");
	}
	return {
		enabled,
		projectPath,
		memoryFilePath,
		lineBudget
	};
}
function loadTeamConfig() {
	const env = getMergedEnv();
	const teamId = env["TEAM_ID"];
	const userId = env["USER_ID"];
	if (!teamId || !userId) return null;
	return {
		teamId,
		userId,
		mode: env["TEAM_MODE"] === "shared" ? "shared" : "private"
	};
}
function loadAgentScope() {
	const env = getMergedEnv();
	const raw = env["AGENT_ID"];
	if (!raw) return null;
	const agentId = raw.trim().slice(0, 128);
	if (!agentId) return null;
	return {
		agentId,
		mode: env["AGENTMEMORY_AGENT_SCOPE"] === "isolated" ? "isolated" : "shared"
	};
}
function getAgentId() {
	return loadAgentScope()?.agentId;
}
function isAgentScopeIsolated() {
	return loadAgentScope()?.mode === "isolated";
}
const SNAPSHOT_INTERVAL_DEFAULT_SECONDS = 3600;
const MIN_SNAPSHOT_INTERVAL_SECONDS = 1;
function loadSnapshotConfig() {
	const env = getMergedEnv();
	const rawInterval = safeParseInt(env["SNAPSHOT_INTERVAL"], SNAPSHOT_INTERVAL_DEFAULT_SECONDS);
	const interval = rawInterval >= MIN_SNAPSHOT_INTERVAL_SECONDS ? rawInterval : SNAPSHOT_INTERVAL_DEFAULT_SECONDS;
	return {
		enabled: env["SNAPSHOT_ENABLED"] === "true",
		interval,
		dir: env["SNAPSHOT_DIR"] || join(homedir(), ".agentmemory", "snapshots")
	};
}
function isGraphExtractionEnabled() {
	return getMergedEnv()["GRAPH_EXTRACTION_ENABLED"] === "true";
}
const FOLLOWUP_WINDOW_DEFAULT_SECONDS = 30;
function getFollowupWindowSeconds() {
	return safeParseInt(getMergedEnv()["AGENTMEMORY_FOLLOWUP_WINDOW_SECONDS"], FOLLOWUP_WINDOW_DEFAULT_SECONDS);
}
const VIEWER_STREAM_MAX_DEFAULT = 500;
const VIEWER_STREAM_MAX_FLOOR = 200;
function parseExactInt(value, fallback) {
	if (!value) return fallback;
	const trimmed = value.trim();
	if (!/^-?\d+$/.test(trimmed)) return fallback;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) ? parsed : fallback;
}
function getViewerStreamMax() {
	const parsed = parseExactInt(getMergedEnv()["AGENTMEMORY_VIEWER_STREAM_MAX"], VIEWER_STREAM_MAX_DEFAULT);
	if (parsed < 0) return VIEWER_STREAM_MAX_DEFAULT;
	return Math.max(parsed, VIEWER_STREAM_MAX_FLOOR);
}
function isConsolidationEnabled() {
	const env = getMergedEnv();
	const explicit = env["CONSOLIDATION_ENABLED"];
	if (explicit === "false" || explicit === "0") return false;
	if (explicit === "true" || explicit === "1") return true;
	if ((env["AGENTMEMORY_PROVIDER"] || "").toLowerCase() === "noop") return false;
	return detectLlmProviderKind(env) === "llm";
}
function isAutoCompressEnabled() {
	return getMergedEnv()["AGENTMEMORY_AUTO_COMPRESS"] === "true";
}
function isContextInjectionEnabled() {
	return getMergedEnv()["AGENTMEMORY_INJECT_CONTEXT"] === "true";
}
const CONSOLIDATION_INTERVAL_DEFAULT_MS = 72e5;
function getConsolidationIntervalMs() {
	const raw = parseInt(process.env.CONSOLIDATION_INTERVAL_MS || String(72e5), 10);
	return Number.isFinite(raw) && raw > 0 ? raw : CONSOLIDATION_INTERVAL_DEFAULT_MS;
}
function getConsolidationDecayDays() {
	return safeParseInt(getMergedEnv()["CONSOLIDATION_DECAY_DAYS"], 30);
}
const CONSOLIDATION_COOLDOWN_DEFAULT_MS = 3e5;
function getConsolidationCooldownMs() {
	const raw = safeParseInt(getMergedEnv()["AGENTMEMORY_CONSOLIDATION_COOLDOWN_MS"], CONSOLIDATION_COOLDOWN_DEFAULT_MS);
	return raw >= 0 ? raw : CONSOLIDATION_COOLDOWN_DEFAULT_MS;
}
const INDEX_SAVE_INTERVAL_DEFAULT_MS = 6e5;
function getIndexSaveIntervalMs() {
	const raw = safeParseInt(getMergedEnv()["AGENTMEMORY_INDEX_SAVE_INTERVAL_MS"], INDEX_SAVE_INTERVAL_DEFAULT_MS);
	return raw > 0 ? raw : INDEX_SAVE_INTERVAL_DEFAULT_MS;
}
function getStateSaveIntervalMs() {
	const raw = safeParseInt(getMergedEnv()["AGENTMEMORY_STATE_SAVE_INTERVAL_MS"], 0);
	return raw > 0 ? raw : void 0;
}
function getVectorBucketSize() {
	const raw = safeParseInt(getMergedEnv()["AGENTMEMORY_VECTOR_BUCKET_SIZE"], 500);
	return raw > 0 ? raw : 500;
}
function getVectorBackfillMax() {
	const raw = safeParseInt(getMergedEnv()["AGENTMEMORY_VECTOR_BACKFILL_MAX"], 500);
	return raw > 0 ? raw : 500;
}
function isVectorBackfillAllEnabled() {
	return getMergedEnv()["AGENTMEMORY_VECTOR_BACKFILL"] === "all";
}
function getStandalonePersistPath() {
	return getMergedEnv()["STANDALONE_PERSIST_PATH"] || join(homedir(), ".agentmemory", "standalone.json");
}
const VALID_PROVIDERS = new Set([
	"anthropic",
	"gemini",
	"openrouter",
	"agent-sdk",
	"minimax",
	"openai"
]);
function loadFallbackConfig() {
	const env = getMergedEnv();
	const raw = env["FALLBACK_PROVIDERS"] || "";
	const allowAgentSdk = env["AGENTMEMORY_ALLOW_AGENT_SDK"] === "true";
	return { providers: raw.split(",").map((p) => p.trim()).filter((p) => Boolean(p) && VALID_PROVIDERS.has(p)).filter((p) => {
		if (p === "agent-sdk" && !allowAgentSdk) {
			process.stderr.write("[agentmemory] Ignoring FALLBACK_PROVIDERS entry 'agent-sdk' (AGENTMEMORY_ALLOW_AGENT_SDK is not 'true'). The agent-sdk fallback can spawn Claude Agent SDK child sessions that trigger the Stop-hook recursion loop. Opt in explicitly with AGENTMEMORY_ALLOW_AGENT_SDK=true if this is intentional.\n");
			return false;
		}
		return true;
	}) };
}
//#endregion
//#region src/version.ts
const VERSION = "0.9.30";
const III_PINNED_VERSION = "0.22.1";
//#endregion
//#region src/mcp/tools-registry.ts
const CORE_TOOLS = [
	{
		name: "memory_recall",
		description: "Search stored memories and session observations for relevant context. Use when you need to recall what happened in previous sessions, find past decisions, or look up how a file was modified before.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Search query (keywords, file names, concepts)"
				},
				limit: {
					type: "number",
					description: "Max results to return (default 10)"
				},
				format: {
					type: "string",
					description: "Result format: full, compact, or narrative (default full)"
				},
				token_budget: {
					type: "number",
					description: "Optional estimated content token budget; response includes truncation and recovery metadata"
				},
				targetLayer: {
					type: "string",
					enum: [
						"all",
						"memory",
						"observation"
					],
					description: "Search all indexed layers (default), durable memories, or raw observations before ranking"
				},
				project: {
					type: "string",
					description: "Filter by project path"
				},
				cwd: {
					type: "string",
					description: "Filter by session working directory"
				},
				agentId: {
					type: "string",
					description: "Filter by owning agent; '*' reads across agents"
				}
			},
			required: ["query"]
		}
	},
	{
		name: "memory_compress_file",
		description: "Compress a markdown file to reduce token usage while preserving headings, URLs, and code blocks. Creates a .original.md backup before writing.",
		inputSchema: {
			type: "object",
			properties: { filePath: {
				type: "string",
				description: "Path to the markdown file to compress"
			} },
			required: ["filePath"]
		}
	},
	{
		name: "memory_save",
		description: "Explicitly save an important insight, decision, or pattern to long-term memory.",
		inputSchema: {
			type: "object",
			properties: {
				content: {
					type: "string",
					description: "The insight or decision to remember"
				},
				type: {
					type: "string",
					description: "Memory type: pattern, preference, architecture, bug, workflow, or fact"
				},
				concepts: {
					type: "string",
					description: "Comma-separated key concepts"
				},
				files: {
					type: "string",
					description: "Comma-separated relevant file paths"
				},
				project: {
					type: "string",
					description: "Stable canonical project identifier this memory belongs to (e.g. a slug, UUID, or registry key). Must match the value used when the session was started. Do not use filesystem paths or ad-hoc display names — those change across machines and will silently break project scoping."
				},
				agentId: {
					type: "string",
					description: "Agent identity to scope this memory to. When set, agent-scoped recall and search only surface it for the same agentId. Omit for shared memory."
				}
			},
			required: ["content"]
		}
	},
	{
		name: "memory_file_history",
		description: "Get past observations about specific files.",
		inputSchema: {
			type: "object",
			properties: {
				files: {
					type: "string",
					description: "Comma-separated file paths"
				},
				sessionId: {
					type: "string",
					description: "Current session ID to exclude"
				}
			},
			required: ["files"]
		}
	},
	{
		name: "memory_patterns",
		description: "Detect recurring patterns across sessions.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "Project path to analyze"
				},
				limit: {
					type: "integer",
					description: "Most recent sessions to scan (default 50, max 500)"
				}
			}
		}
	},
	{
		name: "memory_sessions",
		description: "List recent sessions with status, observation counts, summaries and a continuation cursor. Filters apply before pagination; retain them when requesting the next page.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "Exact project identifier used when sessions were started"
				},
				agentId: {
					type: "string",
					description: "Filter by owning agent; '*' reads across agents"
				},
				limit: {
					type: "integer",
					description: "Page size (default 20, max 100)"
				},
				cursor: {
					type: "string",
					description: "nextCursor from the previous page; omit for the first page"
				}
			}
		}
	},
	{
		name: "memory_smart_search",
		description: "Hybrid semantic+keyword search with progressive disclosure. Pass query to search, or expandIds to recover full results.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Search query"
				},
				expandIds: {
					type: "string",
					description: "Comma-separated memory or observation IDs to expand; query is optional when provided"
				},
				limit: {
					type: "number",
					description: "Max results (default 10)"
				},
				targetLayer: {
					type: "string",
					enum: [
						"all",
						"memory",
						"observation"
					],
					description: "Search all indexed layers (default), durable memories, or raw observations before ranking"
				},
				project: {
					type: "string",
					description: "Filter by project path"
				},
				agentId: {
					type: "string",
					description: "Filter by owning agent; '*' reads across agents"
				},
				includeLessons: {
					type: "boolean",
					description: "Include lesson matches when targetLayer is all (default true)"
				}
			}
		}
	},
	{
		name: "memory_vision_search",
		description: "Cross-modal image search via CLIP embeddings. Pass queryText to find screenshots matching a description, or queryImageBase64/queryImageRef to find similar images. Requires AGENTMEMORY_IMAGE_EMBEDDINGS=true.",
		inputSchema: {
			type: "object",
			properties: {
				queryText: {
					type: "string",
					description: "Text query (e.g. 'login form with error banner')"
				},
				queryImageRef: {
					type: "string",
					description: "Absolute path to a stored image to match against"
				},
				queryImageBase64: {
					type: "string",
					description: "Raw base64 image bytes or data URL"
				},
				topK: {
					type: "number",
					description: "Max results (default 10, max 50)"
				},
				sessionId: {
					type: "string",
					description: "Filter to a single session"
				}
			}
		}
	},
	{
		name: "memory_timeline",
		description: "Chronological observations around an anchor point.",
		inputSchema: {
			type: "object",
			properties: {
				anchor: {
					type: "string",
					description: "Anchor point: ISO date or keyword"
				},
				project: {
					type: "string",
					description: "Filter by project path"
				},
				before: {
					type: "number",
					description: "Observations before anchor (default 5)"
				},
				after: {
					type: "number",
					description: "Observations after anchor (default 5)"
				}
			},
			required: ["anchor"]
		}
	},
	{
		name: "memory_profile",
		description: "User/project profile with top concepts and file patterns.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "Project path"
				},
				refresh: {
					type: "string",
					description: "Set to 'true' to force rebuild"
				}
			},
			required: ["project"]
		}
	},
	{
		name: "memory_export",
		description: "Export memory data as JSON. Past the transport size limit the export is refused, so use the paging arguments on a large store.",
		inputSchema: {
			type: "object",
			properties: {
				maxSessions: {
					type: "number",
					description: "Sessions per page (with their observations)"
				},
				offset: {
					type: "number",
					description: "Session offset"
				},
				collectionLimit: {
					type: "number",
					description: "Rows per page for memories, summaries, graphNodes, lessons and the other top-level collections; access logs follow the memories on the page. Sessions and their observations are paged only by maxSessions and offset, so pass collections to leave them out of each page"
				},
				collectionOffset: {
					type: "number",
					description: "Row offset for the top-level collections"
				},
				collections: {
					type: "string",
					description: "Comma-separated collections to return, e.g. memories,lessons. Sessions and their observations come back only when the list names sessions, access logs only together with memories. Unknown names are ignored. Omit for everything. A paged or selected export cannot be imported with strategy replace."
				}
			}
		}
	},
	{
		name: "memory_relations",
		description: "Query the memory relationship graph.",
		inputSchema: {
			type: "object",
			properties: {
				memoryId: {
					type: "string",
					description: "Memory ID to find relations for"
				},
				maxHops: {
					type: "number",
					description: "Max traversal depth (default 2)"
				},
				minConfidence: {
					type: "number",
					description: "Min confidence (0-1, default 0)"
				}
			},
			required: ["memoryId"]
		}
	},
	{
		name: "memory_commit_lookup",
		description: "Look up the agent session(s) that produced a specific git commit, given its SHA. Returns the commit metadata and linked sessions.",
		inputSchema: {
			type: "object",
			properties: { sha: {
				type: "string",
				description: "Full git commit SHA"
			} },
			required: ["sha"]
		}
	},
	{
		name: "memory_commits",
		description: "List recent commits linked to agent sessions, optionally filtered by branch or repo.",
		inputSchema: {
			type: "object",
			properties: {
				branch: {
					type: "string",
					description: "Filter by branch name"
				},
				repo: {
					type: "string",
					description: "Filter by remote URL"
				},
				limit: {
					type: "number",
					description: "Max results (default 100, max 500)"
				}
			}
		}
	}
];
const V040_TOOLS = [
	{
		name: "memory_claude_bridge_sync",
		description: "Sync memory state to/from Claude Code's native MEMORY.md file.",
		inputSchema: {
			type: "object",
			properties: { direction: {
				type: "string",
				description: "'read' to import from MEMORY.md, 'write' to export to MEMORY.md"
			} },
			required: ["direction"]
		}
	},
	{
		name: "memory_graph_query",
		description: "Query the knowledge graph for entities and relationships.",
		inputSchema: {
			type: "object",
			properties: {
				startNodeId: {
					type: "string",
					description: "Starting node ID for traversal"
				},
				nodeType: {
					type: "string",
					description: "Filter by node type"
				},
				maxDepth: {
					type: "number",
					description: "Max BFS depth (default 3, max 5)"
				},
				query: {
					type: "string",
					description: "Search nodes by name"
				}
			}
		}
	},
	{
		name: "memory_consolidate",
		description: "Run the 4-tier memory consolidation pipeline (working -> episodic -> semantic -> procedural).",
		inputSchema: {
			type: "object",
			properties: { tier: {
				type: "string",
				description: "Target tier: episodic, semantic, or procedural"
			} }
		}
	},
	{
		name: "memory_team_share",
		description: "Share a memory or observation with team members.",
		inputSchema: {
			type: "object",
			properties: {
				itemId: {
					type: "string",
					description: "ID of memory or observation to share"
				},
				itemType: {
					type: "string",
					description: "Type: observation, memory, or pattern"
				}
			},
			required: ["itemId", "itemType"]
		}
	},
	{
		name: "memory_team_feed",
		description: "Get recent shared items from all team members.",
		inputSchema: {
			type: "object",
			properties: { limit: {
				type: "number",
				description: "Max items (default 20)"
			} }
		}
	},
	{
		name: "memory_audit",
		description: "View the audit trail of memory operations.",
		inputSchema: {
			type: "object",
			properties: {
				operation: {
					type: "string",
					description: "Filter by operation type"
				},
				limit: {
					type: "number",
					description: "Max entries (default 50)"
				}
			}
		}
	},
	{
		name: "memory_governance_delete",
		description: "Delete specific memories with audit trail.",
		inputSchema: {
			type: "object",
			properties: {
				memoryIds: {
					type: "string",
					description: "Comma-separated memory IDs to delete"
				},
				reason: {
					type: "string",
					description: "Reason for deletion"
				}
			},
			required: ["memoryIds"]
		}
	},
	{
		name: "memory_snapshot_create",
		description: "Create a git-versioned snapshot of current memory state.",
		inputSchema: {
			type: "object",
			properties: { message: {
				type: "string",
				description: "Snapshot description"
			} }
		}
	}
];
const V050_TOOLS = [
	{
		name: "memory_action_create",
		description: "Create an actionable work item with typed dependencies. Actions track what agents need to do and how work items relate to each other.",
		inputSchema: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description: "Action title"
				},
				description: {
					type: "string",
					description: "Detailed description of the work"
				},
				priority: {
					type: "number",
					description: "Priority 1-10 (10 highest)"
				},
				project: {
					type: "string",
					description: "Project path"
				},
				tags: {
					type: "string",
					description: "Comma-separated tags"
				},
				parentId: {
					type: "string",
					description: "Parent action ID for hierarchical actions"
				},
				requires: {
					type: "string",
					description: "Comma-separated action IDs that must complete before this"
				}
			},
			required: ["title"]
		}
	},
	{
		name: "memory_action_update",
		description: "Update an action's status, priority, or details. Set status to 'done' to complete it and unblock dependent actions.",
		inputSchema: {
			type: "object",
			properties: {
				actionId: {
					type: "string",
					description: "Action ID to update"
				},
				status: {
					type: "string",
					description: "New status: pending, active, done, blocked, cancelled"
				},
				result: {
					type: "string",
					description: "Outcome description (when completing)"
				},
				priority: {
					type: "number",
					description: "New priority 1-10"
				}
			},
			required: ["actionId"]
		}
	},
	{
		name: "memory_frontier",
		description: "Get all unblocked actions ranked by priority and urgency. Returns the frontier of actionable work with no unsatisfied dependencies.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "Filter by project"
				},
				agentId: {
					type: "string",
					description: "Agent ID to check lease conflicts"
				},
				limit: {
					type: "number",
					description: "Max results (default 20)"
				}
			}
		}
	},
	{
		name: "memory_next",
		description: "Get the single most important next action to work on. Combines dependency resolution, priority, and recency into a score.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "Filter by project"
				},
				agentId: {
					type: "string",
					description: "Current agent ID"
				}
			}
		}
	},
	{
		name: "memory_lease",
		description: "Acquire, release, or renew an exclusive lease on an action. Prevents multiple agents from working on the same thing.",
		inputSchema: {
			type: "object",
			properties: {
				actionId: {
					type: "string",
					description: "Action ID"
				},
				agentId: {
					type: "string",
					description: "Agent claiming the action"
				},
				operation: {
					type: "string",
					description: "acquire, release, or renew"
				},
				result: {
					type: "string",
					description: "Result when releasing (marks action done)"
				},
				ttlMs: {
					type: "number",
					description: "Lease duration in ms (default 10min, max 1hr)"
				}
			},
			required: [
				"actionId",
				"agentId",
				"operation"
			]
		}
	},
	{
		name: "memory_routine_run",
		description: "Instantiate a frozen workflow routine, creating actions for each step with proper dependencies.",
		inputSchema: {
			type: "object",
			properties: {
				routineId: {
					type: "string",
					description: "Routine template ID"
				},
				project: {
					type: "string",
					description: "Project context"
				},
				initiatedBy: {
					type: "string",
					description: "Agent starting the run"
				}
			},
			required: ["routineId"]
		}
	},
	{
		name: "memory_signal_send",
		description: "Send a message to another agent or broadcast. Supports threading, typed messages, and TTL expiration.",
		inputSchema: {
			type: "object",
			properties: {
				from: {
					type: "string",
					description: "Sender agent ID"
				},
				to: {
					type: "string",
					description: "Recipient agent ID (omit for broadcast)"
				},
				content: {
					type: "string",
					description: "Message content"
				},
				type: {
					type: "string",
					description: "Message type: info, request, response, alert, handoff"
				},
				replyTo: {
					type: "string",
					description: "Signal ID to reply to (auto-threads)"
				}
			},
			required: ["from", "content"]
		}
	},
	{
		name: "memory_signal_read",
		description: "Read messages for an agent. Marks delivered messages as read.",
		inputSchema: {
			type: "object",
			properties: {
				agentId: {
					type: "string",
					description: "Agent to read messages for"
				},
				unreadOnly: {
					type: "string",
					description: "Set to 'true' for unread only"
				},
				threadId: {
					type: "string",
					description: "Filter by conversation thread"
				},
				limit: {
					type: "number",
					description: "Max messages (default 50)"
				}
			},
			required: ["agentId"]
		}
	},
	{
		name: "memory_checkpoint",
		description: "Create or resolve an external checkpoint (CI result, approval, deploy status) that gates action progress.",
		inputSchema: {
			type: "object",
			properties: {
				operation: {
					type: "string",
					description: "create, resolve, or list"
				},
				name: {
					type: "string",
					description: "Checkpoint name (for create)"
				},
				checkpointId: {
					type: "string",
					description: "Checkpoint ID (for resolve)"
				},
				status: {
					type: "string",
					description: "passed or failed (for resolve)"
				},
				type: {
					type: "string",
					description: "Checkpoint type: ci, approval, deploy, external, timer"
				},
				linkedActionIds: {
					type: "string",
					description: "Comma-separated action IDs this checkpoint gates (for create)"
				}
			},
			required: ["operation"]
		}
	},
	{
		name: "memory_mesh_sync",
		description: "Sync memories and actions with peer agentmemory instances for multi-agent collaboration.",
		inputSchema: {
			type: "object",
			properties: {
				peerId: {
					type: "string",
					description: "Specific peer ID (omit for all)"
				},
				direction: {
					type: "string",
					description: "push, pull, or both (default both)"
				}
			}
		}
	}
];
const V051_TOOLS = [
	{
		name: "memory_sentinel_create",
		description: "Create an event-driven sentinel that watches for conditions (webhook, timer, threshold, pattern, approval) and auto-unblocks gated actions when triggered.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "Sentinel name"
				},
				type: {
					type: "string",
					description: "Type: webhook, timer, threshold, pattern, approval, custom"
				},
				config: {
					type: "string",
					description: "JSON config (timer: {durationMs}, threshold: {metric,operator,value}, pattern: {pattern}, webhook: {path})"
				},
				linkedActionIds: {
					type: "string",
					description: "Comma-separated action IDs to gate"
				},
				expiresInMs: {
					type: "number",
					description: "Auto-expire after ms"
				}
			},
			required: ["name", "type"]
		}
	},
	{
		name: "memory_sentinel_trigger",
		description: "Externally fire a sentinel, providing an optional result payload. Unblocks any gated actions.",
		inputSchema: {
			type: "object",
			properties: {
				sentinelId: {
					type: "string",
					description: "Sentinel ID to trigger"
				},
				result: {
					type: "string",
					description: "JSON result payload"
				}
			},
			required: ["sentinelId"]
		}
	},
	{
		name: "memory_sketch_create",
		description: "Create an ephemeral action graph for exploratory work. Auto-expires after TTL. Can be promoted to permanent actions or discarded.",
		inputSchema: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description: "Sketch title"
				},
				description: {
					type: "string",
					description: "What this sketch explores"
				},
				expiresInMs: {
					type: "number",
					description: "TTL in ms (default 1 hour)"
				},
				project: {
					type: "string",
					description: "Project context"
				}
			},
			required: ["title"]
		}
	},
	{
		name: "memory_sketch_promote",
		description: "Promote a sketch's ephemeral actions to permanent actions. Makes the exploratory work official.",
		inputSchema: {
			type: "object",
			properties: {
				sketchId: {
					type: "string",
					description: "Sketch ID to promote"
				},
				project: {
					type: "string",
					description: "Override project for promoted actions"
				}
			},
			required: ["sketchId"]
		}
	},
	{
		name: "memory_crystallize",
		description: "Compress completed action chains into compact crystal digests using LLM summarization. Extracts narrative, key outcomes, files affected, and lessons.",
		inputSchema: {
			type: "object",
			properties: {
				actionIds: {
					type: "string",
					description: "Comma-separated completed action IDs to crystallize"
				},
				project: {
					type: "string",
					description: "Project context"
				},
				sessionId: {
					type: "string",
					description: "Session context"
				}
			},
			required: ["actionIds"]
		}
	},
	{
		name: "memory_diagnose",
		description: "Run health checks across all subsystems (actions, leases, sentinels, sketches, signals, sessions, memories, mesh). Identifies stuck, orphaned, and inconsistent state.",
		inputSchema: {
			type: "object",
			properties: { categories: {
				type: "string",
				description: "Comma-separated categories to check (default all)"
			} }
		}
	},
	{
		name: "memory_heal",
		description: "Auto-fix all fixable issues found by diagnostics. Unblocks stuck actions, expires stale leases, cleans up orphaned data.",
		inputSchema: {
			type: "object",
			properties: {
				categories: {
					type: "string",
					description: "Comma-separated categories to heal (default all)"
				},
				dryRun: {
					type: "string",
					description: "Set to 'true' for dry run (report but don't fix)"
				}
			}
		}
	},
	{
		name: "memory_facet_tag",
		description: "Attach a structured tag (dimension:value) to an action, memory, or observation for multi-dimensional categorization.",
		inputSchema: {
			type: "object",
			properties: {
				targetId: {
					type: "string",
					description: "ID of the target to tag"
				},
				targetType: {
					type: "string",
					description: "Type: action, memory, or observation"
				},
				dimension: {
					type: "string",
					description: "Tag dimension (e.g., priority, team, status)"
				},
				value: {
					type: "string",
					description: "Tag value (e.g., urgent, backend, reviewed)"
				}
			},
			required: [
				"targetId",
				"targetType",
				"dimension",
				"value"
			]
		}
	},
	{
		name: "memory_facet_query",
		description: "Query targets by facet tags with AND/OR logic. Find all actions tagged priority:urgent AND team:backend.",
		inputSchema: {
			type: "object",
			properties: {
				matchAll: {
					type: "string",
					description: "Comma-separated dimension:value pairs (AND logic)"
				},
				matchAny: {
					type: "string",
					description: "Comma-separated dimension:value pairs (OR logic)"
				},
				targetType: {
					type: "string",
					description: "Filter by type: action, memory, or observation"
				}
			}
		}
	}
];
const V061_TOOLS = [{
	name: "memory_verify",
	description: "Verify a memory or observation by tracing its citation chain back to source observations and session context. Returns provenance information including confidence scores.",
	inputSchema: {
		type: "object",
		properties: { id: {
			type: "string",
			description: "Memory ID or observation ID to verify"
		} },
		required: ["id"]
	}
}];
const V070_TOOLS = [
	{
		name: "memory_lesson_save",
		description: "Save a lesson learned from this session. Lessons have confidence scores that strengthen when reinforced and decay when not used. Duplicate content auto-strengthens the existing lesson.",
		inputSchema: {
			type: "object",
			properties: {
				content: {
					type: "string",
					description: "The lesson learned (what worked, what to avoid, when to use X approach)"
				},
				context: {
					type: "string",
					description: "When/where this lesson applies"
				},
				confidence: {
					type: "number",
					description: "Initial confidence 0.0-1.0 (default 0.5)"
				},
				project: {
					type: "string",
					description: "Project this lesson is about"
				},
				tags: {
					type: "string",
					description: "Comma-separated tags"
				}
			},
			required: ["content"]
		}
	},
	{
		name: "memory_lesson_recall",
		description: "Search lessons by query. Returns lessons sorted by confidence and recency. Use to check what the agent has learned before making decisions.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Search query"
				},
				project: {
					type: "string",
					description: "Filter by project"
				},
				minConfidence: {
					type: "number",
					description: "Minimum confidence threshold (default 0.1)"
				},
				limit: {
					type: "number",
					description: "Max results (default 10)"
				}
			},
			required: ["query"]
		}
	},
	{
		name: "memory_lesson_delete",
		description: "Soft-delete a lesson by id. Deleted lessons are excluded from recall and list; re-saving the same content creates a fresh lesson.",
		inputSchema: {
			type: "object",
			properties: { lessonId: {
				type: "string",
				description: "The lesson id (lsn_...)"
			} },
			required: ["lessonId"]
		}
	},
	{
		name: "memory_obsidian_export",
		description: "Export memories, lessons, and crystals as Obsidian-compatible Markdown files with YAML frontmatter and wikilinks for graph view.",
		inputSchema: {
			type: "object",
			properties: {
				vaultDir: {
					type: "string",
					description: "Output directory (default ~/.agentmemory/vault/)"
				},
				types: {
					type: "string",
					description: "Comma-separated types to export: memories,lessons,crystals,sessions (default all)"
				}
			}
		}
	}
];
const V073_TOOLS = [{
	name: "memory_reflect",
	description: "Traverse the knowledge graph, group related memories by concept clusters, and synthesize higher-order insights via LLM. Returns new and reinforced insights.",
	inputSchema: {
		type: "object",
		properties: {
			project: {
				type: "string",
				description: "Filter by project"
			},
			maxClusters: {
				type: "number",
				description: "Max concept clusters to process (default 10, max 20)"
			}
		}
	}
}, {
	name: "memory_insight_list",
	description: "List synthesized insights — higher-order observations derived from patterns across memories, lessons, and crystals.",
	inputSchema: {
		type: "object",
		properties: {
			project: {
				type: "string",
				description: "Filter by project"
			},
			minConfidence: {
				type: "number",
				description: "Minimum confidence threshold (default 0)"
			},
			limit: {
				type: "number",
				description: "Max results (default 50)"
			}
		}
	}
}];
const V010_SLOTS_TOOLS = [
	{
		name: "memory_slot_list",
		description: "List all memory slots (pinned + project + global). Slots are editable, size-limited memory units the agent can read and modify across sessions.",
		inputSchema: {
			type: "object",
			properties: {}
		}
	},
	{
		name: "memory_slot_get",
		description: "Read a single slot by label.",
		inputSchema: {
			type: "object",
			properties: { label: {
				type: "string",
				description: "Slot label (e.g. 'persona', 'pending_items')"
			} },
			required: ["label"]
		}
	},
	{
		name: "memory_slot_create",
		description: "Create a new slot. Reject if a slot with the same label already exists.",
		inputSchema: {
			type: "object",
			properties: {
				label: {
					type: "string",
					description: "Slot label — lowercase, starts with letter, [a-z0-9_]"
				},
				content: {
					type: "string",
					description: "Initial content (default empty)"
				},
				sizeLimit: {
					type: "number",
					description: "Max chars (default 2000, hard cap 20000)"
				},
				description: {
					type: "string",
					description: "What this slot is for"
				},
				pinned: {
					type: "string",
					description: "'false' to exclude from context injection; default true"
				},
				scope: {
					type: "string",
					description: "'project' (default) or 'global' (shared across projects)"
				}
			},
			required: ["label"]
		}
	},
	{
		name: "memory_slot_append",
		description: "Append text to an existing slot. Fails with 413 if the append would exceed the slot's sizeLimit — agent must compact via memory_slot_replace first.",
		inputSchema: {
			type: "object",
			properties: {
				label: {
					type: "string",
					description: "Slot label"
				},
				text: {
					type: "string",
					description: "Text to append"
				}
			},
			required: ["label", "text"]
		}
	},
	{
		name: "memory_slot_replace",
		description: "Replace slot content in place. Fails if content exceeds sizeLimit.",
		inputSchema: {
			type: "object",
			properties: {
				label: {
					type: "string",
					description: "Slot label"
				},
				content: {
					type: "string",
					description: "New full content"
				}
			},
			required: ["label", "content"]
		}
	},
	{
		name: "memory_slot_delete",
		description: "Delete a slot. Seeded default slots can be deleted unless marked readOnly.",
		inputSchema: {
			type: "object",
			properties: { label: {
				type: "string",
				description: "Slot label"
			} },
			required: ["label"]
		}
	}
];
const EVIDENCE_TOOLS = [
	{
		name: "evidence_register_snapshot",
		description: "Register a Firefox repository snapshot pinned to a full commit. Dirty trees require a SHA-256 patch digest.",
		inputSchema: {
			type: "object",
			properties: {
				repoId: {
					type: "string",
					description: "Stable repository identifier, normally firefox"
				},
				commitId: {
					type: "string",
					description: "Full 40-64 character hexadecimal commit"
				},
				dirty: {
					type: "boolean",
					description: "Whether the working tree is dirty"
				},
				patchDigest: {
					type: "string",
					description: "SHA-256 of the dirty patch"
				},
				treeDigest: {
					type: "string",
					description: "Optional SHA-256 tree digest"
				},
				scope: {
					type: "string",
					description: "Research scope or component"
				},
				platform: {
					type: "string",
					description: "Build platform identity"
				},
				indexId: {
					type: "string",
					description: "Semantic/source index identity"
				},
				idempotencyKey: {
					type: "string",
					description: "Retry-safe mutation key"
				}
			},
			required: ["repoId", "commitId"]
		}
	},
	{
		name: "evidence_record_source",
		description: "Record an exact, case-sensitive source reference scoped to one repository snapshot.",
		inputSchema: {
			type: "object",
			properties: {
				snapshotId: {
					type: "string",
					description: "Evidence snapshot ID"
				},
				path: {
					type: "string",
					description: "Repository-relative source path"
				},
				startLine: {
					type: "number",
					description: "First line, or 0 if unknown"
				},
				endLine: {
					type: "number",
					description: "Last line, or 0 if unknown"
				},
				symbolId: {
					type: "string",
					description: "Stable symbol identity"
				},
				language: {
					type: "string",
					description: "Source language"
				},
				excerpt: {
					type: "string",
					description: "Bounded source excerpt"
				},
				idempotencyKey: {
					type: "string",
					description: "Retry-safe mutation key"
				}
			},
			required: ["snapshotId", "path"]
		}
	},
	{
		name: "evidence_record_value",
		description: "Create a revision-scoped value identity used as a node in the explicit flow graph.",
		inputSchema: {
			type: "object",
			properties: {
				snapshotId: {
					type: "string",
					description: "Evidence snapshot ID"
				},
				path: {
					type: "string",
					description: "Repository-relative source path"
				},
				valueName: {
					type: "string",
					description: "Value or expression name"
				},
				role: {
					type: "string",
					enum: [
						"source",
						"sink",
						"transform",
						"param",
						"return",
						"field",
						"value"
					],
					description: "Flow role"
				},
				symbolId: {
					type: "string",
					description: "Stable symbol identity"
				},
				startLine: {
					type: "number",
					description: "First line"
				},
				endLine: {
					type: "number",
					description: "Last line"
				},
				sinkType: {
					type: "string",
					description: "Sink classification, only for sink role"
				},
				language: {
					type: "string",
					description: "Source language"
				},
				idempotencyKey: {
					type: "string",
					description: "Retry-safe mutation key"
				}
			},
			required: [
				"snapshotId",
				"path",
				"valueName"
			]
		}
	},
	{
		name: "evidence_record",
		description: "Record agent-asserted analysis evidence. Raw content is integrity-addressed; projections are redacted and bounded. MCP callers cannot mint verified trust.",
		inputSchema: {
			type: "object",
			properties: {
				snapshotId: {
					type: "string",
					description: "Evidence snapshot ID"
				},
				kind: {
					type: "string",
					enum: [
						"static_analysis",
						"dataflow",
						"crash",
						"test",
						"source_excerpt",
						"build",
						"fuzz"
					],
					description: "Evidence kind"
				},
				raw: {
					type: "string",
					description: "Raw evidence or log content"
				},
				projection: {
					type: "string",
					description: "Searchable summary"
				},
				status: {
					type: "string",
					description: "Requested status; reproduced is fail-closed for MCP callers"
				},
				tool: {
					type: "string",
					description: "Tool name as metadata only"
				},
				toolVersion: {
					type: "string",
					description: "Tool version"
				},
				queryId: {
					type: "string",
					description: "Query or rule identity"
				},
				valueIdentityId: {
					type: "string",
					description: "Related value identity"
				},
				dependenciesJson: {
					type: "string",
					description: "JSON array of {kind,key} dependencies"
				},
				idempotencyKey: {
					type: "string",
					description: "Retry-safe mutation key"
				}
			},
			required: ["snapshotId"]
		}
	},
	{
		name: "evidence_link_flow",
		description: "Link one explicit source-to-destination transition in a single snapshot. Shared names or semantic similarity never create an edge.",
		inputSchema: {
			type: "object",
			properties: {
				snapshotId: {
					type: "string",
					description: "Evidence snapshot ID"
				},
				srcVid: {
					type: "string",
					description: "Source value identity"
				},
				dstVid: {
					type: "string",
					description: "Destination value identity"
				},
				kind: {
					type: "string",
					enum: [
						"intraprocedural",
						"interprocedural",
						"field",
						"return",
						"alias"
					],
					description: "Transition kind"
				},
				status: {
					type: "string",
					description: "Requested status; demonstrated is fail-closed for MCP callers"
				},
				evidenceId: {
					type: "string",
					description: "Compatible evidence record"
				},
				callerSymbol: {
					type: "string",
					description: "Caller symbol"
				},
				calleeSymbol: {
					type: "string",
					description: "Callee symbol"
				},
				argIndex: {
					type: "number",
					description: "Argument index"
				},
				paramName: {
					type: "string",
					description: "Parameter name"
				},
				idempotencyKey: {
					type: "string",
					description: "Retry-safe mutation key"
				}
			},
			required: [
				"snapshotId",
				"srcVid",
				"dstVid"
			]
		}
	},
	{
		name: "evidence_record_hypothesis",
		description: "Record a falsifiable research hypothesis with optional explicit supporting record IDs.",
		inputSchema: {
			type: "object",
			properties: {
				snapshotId: {
					type: "string",
					description: "Optional evidence snapshot ID"
				},
				statement: {
					type: "string",
					description: "Falsifiable hypothesis"
				},
				invariant: {
					type: "string",
					description: "Expected security invariant"
				},
				scope: {
					type: "string",
					description: "Affected scope"
				},
				nextAction: {
					type: "string",
					description: "Next validation action"
				},
				supportingEvidenceIds: {
					type: "string",
					description: "Comma-separated supporting evidence IDs"
				},
				supportingFlowEdgeIds: {
					type: "string",
					description: "Comma-separated supporting flow IDs"
				},
				idempotencyKey: {
					type: "string",
					description: "Retry-safe mutation key"
				}
			},
			required: ["statement"]
		}
	},
	{
		name: "evidence_record_counter",
		description: "Attach explicit counter-evidence to a hypothesis without deleting its history.",
		inputSchema: {
			type: "object",
			properties: {
				hypothesisId: {
					type: "string",
					description: "Hypothesis ID"
				},
				evidenceId: {
					type: "string",
					description: "Contradicting evidence ID"
				},
				flowEdgeId: {
					type: "string",
					description: "Contradicting flow edge ID"
				},
				rationale: {
					type: "string",
					description: "Why the record contradicts the hypothesis"
				},
				idempotencyKey: {
					type: "string",
					description: "Retry-safe mutation key"
				}
			},
			required: ["hypothesisId"]
		}
	},
	{
		name: "evidence_record_validation",
		description: "Record a build, test, repro, or fuzz validation. Public callers cannot self-assert a passed verified run.",
		inputSchema: {
			type: "object",
			properties: {
				snapshotId: {
					type: "string",
					description: "Optional evidence snapshot ID"
				},
				hypothesisId: {
					type: "string",
					description: "Optional hypothesis ID"
				},
				kind: {
					type: "string",
					enum: [
						"test",
						"build",
						"repro",
						"fuzz"
					],
					description: "Validation kind"
				},
				status: {
					type: "string",
					description: "not_run, running, passed, failed, or inconclusive"
				},
				logs: {
					type: "string",
					description: "Raw validation log"
				},
				repeatSummary: {
					type: "string",
					description: "Repeatability summary"
				},
				buildDigest: {
					type: "string",
					description: "SHA-256 build identity"
				},
				configDigest: {
					type: "string",
					description: "SHA-256 configuration identity"
				},
				dependenciesJson: {
					type: "string",
					description: "JSON array of {kind,key} dependencies"
				},
				idempotencyKey: {
					type: "string",
					description: "Retry-safe mutation key"
				}
			}
		}
	},
	{
		name: "evidence_query",
		description: "Query evidence with exact-snapshot results separated from stale or historical results.",
		inputSchema: {
			type: "object",
			properties: {
				snapshotId: {
					type: "string",
					description: "Optional current snapshot ID"
				},
				text: {
					type: "string",
					description: "Bounded text query"
				},
				kind: {
					type: "string",
					description: "Evidence kind filter"
				},
				status: {
					type: "string",
					description: "Evidence status filter"
				},
				path: {
					type: "string",
					description: "Exact path filter"
				},
				symbolId: {
					type: "string",
					description: "Exact symbol filter"
				},
				limit: {
					type: "number",
					description: "1-200 results"
				},
				offset: {
					type: "number",
					description: "Result offset"
				}
			}
		}
	},
	{
		name: "evidence_review_chain",
		description: "Review explicit flow chains and report every missing, weak, or guard-blocked transition.",
		inputSchema: {
			type: "object",
			properties: {
				snapshotId: {
					type: "string",
					description: "Evidence snapshot ID"
				},
				goal: {
					type: "string",
					description: "Optional sink/goal filter"
				}
			},
			required: ["snapshotId"]
		}
	},
	{
		name: "evidence_claim_coverage",
		description: "Show direct, dynamic, modeled, and contradicting support for one hypothesis.",
		inputSchema: {
			type: "object",
			properties: { hypothesisId: {
				type: "string",
				description: "Hypothesis ID"
			} },
			required: ["hypothesisId"]
		}
	},
	{
		name: "evidence_reclassify_sink",
		description: "Append-only sink reclassification. Historical identities and evidence remain unchanged; successor flows are downgraded for review.",
		inputSchema: {
			type: "object",
			properties: {
				valueIdentityId: {
					type: "string",
					description: "Current sink identity"
				},
				newSinkType: {
					type: "string",
					description: "Replacement sink classification"
				},
				reason: {
					type: "string",
					description: "Reclassification reason"
				},
				idempotencyKey: {
					type: "string",
					description: "Retry-safe mutation key"
				}
			},
			required: ["valueIdentityId", "newSinkType"]
		}
	},
	{
		name: "evidence_invalidate_paths",
		description: "Mark records transitively dependent on changed source paths stale while preserving history.",
		inputSchema: {
			type: "object",
			properties: {
				snapshotId: {
					type: "string",
					description: "Original snapshot ID"
				},
				changedPaths: {
					type: "string",
					description: "Comma-separated repository paths"
				},
				reason: {
					type: "string",
					description: "Invalidation reason"
				},
				newSnapshotId: {
					type: "string",
					description: "Optional replacement snapshot"
				},
				idempotencyKey: {
					type: "string",
					description: "Retry-safe mutation key"
				}
			},
			required: ["snapshotId", "changedPaths"]
		}
	},
	{
		name: "evidence_invalidate_dependencies",
		description: "Invalidate records affected by paths, headers, generated inputs, build flags, analysis models, boundary models, or configs.",
		inputSchema: {
			type: "object",
			properties: {
				snapshotId: {
					type: "string",
					description: "Original snapshot ID"
				},
				changesJson: {
					type: "string",
					description: "JSON array of {kind,key} changes"
				},
				reason: {
					type: "string",
					description: "Invalidation reason"
				},
				newSnapshotId: {
					type: "string",
					description: "Optional replacement snapshot"
				},
				idempotencyKey: {
					type: "string",
					description: "Retry-safe mutation key"
				}
			},
			required: ["snapshotId", "changesJson"]
		}
	},
	{
		name: "evidence_export_bundle",
		description: "Export a verified, bounded Firefox evidence bundle. Missing/corrupt artifacts fail closed; raw artifact contents and internal severity are omitted from MCP output.",
		inputSchema: {
			type: "object",
			properties: {
				snapshotId: {
					type: "string",
					description: "Evidence snapshot ID"
				},
				limit: {
					type: "number",
					description: "Rows per collection, 1-200"
				}
			},
			required: ["snapshotId"]
		}
	}
];
const ESSENTIAL_TOOLS = new Set([
	"memory_save",
	"memory_recall",
	"memory_consolidate",
	"memory_smart_search",
	"memory_sessions",
	"memory_diagnose",
	"memory_lesson_save",
	"memory_reflect"
]);
function getAllTools() {
	return [
		...CORE_TOOLS,
		...V040_TOOLS,
		...V050_TOOLS,
		...V051_TOOLS,
		...V061_TOOLS,
		...V070_TOOLS,
		...V073_TOOLS,
		...V010_SLOTS_TOOLS,
		...EVIDENCE_TOOLS
	];
}
function getVisibleTools() {
	if ((process.env["AGENTMEMORY_TOOLS"] || "all") === "core") return getAllTools().filter((t) => ESSENTIAL_TOOLS.has(t.name));
	return getAllTools();
}
//#endregion
//#region src/functions/audit.ts
const AUDIT_MIGRATE_FUNCTION_ID = "mem::audit-migrate";
const AUDIT_MIGRATION_COPY_CONCURRENCY = 32;
const AUDIT_MIGRATION_DELETE_CONCURRENCY = 8;
const AUDIT_MONTHS_LOCK = KV.auditMonths;
const AUDIT_MIGRATION_LOCK = "mem:audit:migration-lock";
const AUDIT_MIGRATION_STATE_KEY = "migration";
const AUDIT_MIGRATION_DELETE_WAIT_INTERVALS = 2;
const STATE_STORE_DIR_NAME = "state_store.db";
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function encodeStateIndexSegment(index) {
	let out = "";
	for (const byte of Buffer.from(index, "utf8")) {
		const ch = String.fromCharCode(byte);
		out += /^[A-Za-z0-9\-_.]$/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}
function legacyAuditStateFilePath(dataDir) {
	return join(dataDir, STATE_STORE_DIR_NAME, `${encodeStateIndexSegment(KV.audit)}.bin`);
}
async function probeLegacyAuditFile() {
	const dataDir = getEnvVar("AGENTMEMORY_DATA_DIR");
	if (!dataDir) return {
		safe: false,
		reason: "unreadable"
	};
	const storeDir = join(dataDir, STATE_STORE_DIR_NAME);
	try {
		await stat(storeDir);
	} catch {
		return {
			safe: false,
			reason: "unreadable"
		};
	}
	let fileStat;
	try {
		fileStat = await stat(legacyAuditStateFilePath(dataDir));
	} catch (err) {
		if (err.code === "ENOENT") return {
			safe: true,
			empty: true
		};
		return {
			safe: false,
			reason: "unreadable"
		};
	}
	if (fileStat.size > getAuditMigrateMaxBytes()) return {
		safe: false,
		reason: "too-large",
		sizeBytes: fileStat.size
	};
	return {
		safe: true,
		empty: false,
		sizeBytes: fileStat.size
	};
}
async function probeLegacyAuditScope(kv) {
	let rows;
	try {
		rows = await kv.list(KV.audit);
	} catch {
		return {
			safe: false,
			reason: "unreadable"
		};
	}
	if (!Array.isArray(rows) || rows.length === 0) return {
		safe: true,
		empty: true
	};
	const sizeBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
	if (sizeBytes > getAuditMigrateMaxBytes()) return {
		safe: false,
		reason: "too-large",
		sizeBytes
	};
	return {
		safe: true,
		empty: false,
		sizeBytes
	};
}
async function auditMigrationDeleteDelayMs() {
	const dataDir = getEnvVar("AGENTMEMORY_DATA_DIR");
	if (!dataDir) return ENGINE_DEFAULT_SAVE_INTERVAL_MS * AUDIT_MIGRATION_DELETE_WAIT_INTERVALS;
	const configTexts = [];
	for (const path of engineStateConfigPaths(join(homedir(), ".agentmemory"), runtimeConfigPath(dataDir))) try {
		configTexts.push(await readFile(path, "utf-8"));
	} catch {}
	return engineSaveIntervalMs(configTexts) * AUDIT_MIGRATION_DELETE_WAIT_INTERVALS;
}
async function readAuditMigrationState(kv) {
	return kv.get(KV.auditMonths, AUDIT_MIGRATION_STATE_KEY);
}
async function writeAuditMigrationState(kv, state) {
	await kv.set(KV.auditMonths, AUDIT_MIGRATION_STATE_KEY, state);
}
function auditMonthOf(timestamp) {
	const parsed = new Date(timestamp);
	return (Number.isNaN(parsed.getTime()) ? (/* @__PURE__ */ new Date()).toISOString() : parsed.toISOString()).slice(0, 7);
}
function monthStartMs(month) {
	const [year, mon] = month.split("-").map(Number);
	return Date.UTC(year, mon - 1, 1);
}
function monthEndMs(month) {
	const [year, mon] = month.split("-").map(Number);
	return Date.UTC(year, mon, 1) - 1;
}
function monthNMonthsAgo(count) {
	const now = /* @__PURE__ */ new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - count, 1)).toISOString().slice(0, 7);
}
async function readAuditMonthIndex(kv) {
	return (await kv.get(KV.auditMonths, "index"))?.months ?? [];
}
async function markAuditMonth(kv, month) {
	await withKeyedLock(AUDIT_MONTHS_LOCK, async () => {
		const months = await readAuditMonthIndex(kv);
		if (months.includes(month)) return;
		const next = [...months, month].sort();
		await kv.set(KV.auditMonths, "index", { months: next });
	});
}
async function listAuditMonthsDesc(kv) {
	return [...await readAuditMonthIndex(kv)].sort().reverse();
}
let auditRecordedListener = null;
function setAuditRecordedListener(listener) {
	auditRecordedListener = listener;
}
async function recordAudit(kv, operation, functionId, targetIds, details = {}, qualityScore, userId) {
	const entry = {
		id: generateId("aud"),
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		operation,
		userId,
		functionId,
		targetIds,
		details,
		qualityScore
	};
	const month = auditMonthOf(entry.timestamp);
	await kv.set(KV.auditMonth(month), entry.id, entry);
	await markAuditMonth(kv, month);
	try {
		auditRecordedListener?.(entry);
	} catch {}
	return entry;
}
async function safeAudit(kv, operation, functionId, targetIds, details = {}, qualityScore, userId) {
	try {
		await recordAudit(kv, operation, functionId, targetIds, details, qualityScore, userId);
	} catch (err) {
		try {
			logger.warn("audit write failed", {
				functionId,
				operation,
				targetIds,
				error: err instanceof Error ? err.message : String(err)
			});
		} catch {}
	}
}
async function queryAudit(kv, filter) {
	const limit = filter?.limit || 100;
	let fromMs;
	if (filter?.dateFrom) {
		fromMs = new Date(filter.dateFrom).getTime();
		if (Number.isNaN(fromMs)) throw new Error(`Invalid dateFrom: ${filter.dateFrom}`);
	}
	const query = filter?.query?.trim().toLowerCase();
	let toMs;
	if (filter?.dateTo) {
		toMs = new Date(filter.dateTo).getTime();
		if (Number.isNaN(toMs)) throw new Error(`Invalid dateTo: ${filter.dateTo}`);
	}
	const matches = (entry) => {
		if (filter?.operation && entry.operation !== filter.operation) return false;
		const t = new Date(entry.timestamp).getTime();
		if (fromMs !== void 0 && t < fromMs) return false;
		if (toMs !== void 0 && t > toMs) return false;
		if (query && ![entry.functionId, ...entry.targetIds || []].some((v) => String(v || "").toLowerCase().includes(query))) return false;
		return true;
	};
	const seenIds = /* @__PURE__ */ new Set();
	const collected = [];
	const addIfNew = (row) => {
		if (seenIds.has(row.id)) return;
		seenIds.add(row.id);
		if (matches(row)) collected.push(row);
	};
	const months = await listAuditMonthsDesc(kv);
	for (const month of months) {
		if (collected.length >= limit) break;
		if (toMs !== void 0 && monthStartMs(month) > toMs) continue;
		if (fromMs !== void 0 && monthEndMs(month) < fromMs) break;
		const rows = await kv.list(KV.auditMonth(month));
		for (const row of rows) addIfNew(row);
	}
	let legacyFrozen = false;
	let legacyFrozenBytes;
	if (collected.length < limit) {
		const migrationState = await readAuditMigrationState(kv);
		if (migrationState?.safeToListLegacy) {
			const legacyRows = await kv.list(KV.audit);
			for (const row of legacyRows) addIfNew(row);
		} else if (migrationState?.status === "too-large" || migrationState?.status === "unreadable") {
			legacyFrozen = true;
			legacyFrozenBytes = migrationState.legacySizeBytes;
		}
	}
	collected.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
	return {
		entries: collected.slice(0, limit),
		legacyFrozen,
		legacyFrozenBytes
	};
}
async function inParallel(items, concurrency, work) {
	let next = 0;
	const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (next < items.length) {
			const item = items[next++];
			await work(item);
		}
	});
	await Promise.all(runners);
}
async function startAuditMigration(kv, deps = {}) {
	const onRedis = kv.backend === "redis";
	const runProbe = deps.probe ?? (onRedis ? () => probeLegacyAuditScope(kv) : probeLegacyAuditFile);
	const runDeleteDelayMs = deps.deleteDelayMs ?? (onRedis ? async () => 0 : auditMigrationDeleteDelayMs);
	const marker = await readAuditMigrationState(kv);
	if (marker?.status === "done") return;
	const probe = await runProbe();
	if (probe.safe && probe.empty) {
		await writeAuditMigrationState(kv, {
			status: "done",
			safeToListLegacy: true,
			legacySizeBytes: 0,
			migrated: marker?.migrated ?? 0,
			purged: marker?.purged ?? 0,
			summaryWritten: marker?.summaryWritten ?? true,
			checkedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		return;
	}
	if (!probe.safe) {
		await writeAuditMigrationState(kv, {
			status: probe.reason,
			safeToListLegacy: false,
			legacySizeBytes: probe.reason === "too-large" ? probe.sizeBytes : marker?.legacySizeBytes,
			migrated: marker?.migrated ?? 0,
			purged: marker?.purged ?? 0,
			summaryWritten: marker?.summaryWritten ?? false,
			checkedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		logger.warn("legacy audit log left frozen; migration only reads it locally and under a size cap", {
			reason: probe.reason,
			sizeBytes: probe.reason === "too-large" ? probe.sizeBytes : void 0
		});
		return;
	}
	let migrated = marker?.migrated ?? 0;
	let purged = marker?.purged ?? 0;
	if (marker?.status !== "copied") {
		let legacy;
		try {
			legacy = await kv.list(KV.audit);
		} catch (err) {
			logger.warn("audit migration could not read the legacy audit log", { error: err instanceof Error ? err.message : String(err) });
			return;
		}
		if (legacy.length === 0) {
			await writeAuditMigrationState(kv, {
				status: "done",
				safeToListLegacy: true,
				legacySizeBytes: 0,
				migrated,
				purged,
				summaryWritten: marker?.summaryWritten ?? true,
				checkedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			return;
		}
		const seen = /* @__PURE__ */ new Set();
		const deduped = legacy.filter((entry) => {
			if (seen.has(entry.id)) return false;
			seen.add(entry.id);
			return true;
		});
		const kept = deduped.filter((entry) => entry.operation !== "index_persist");
		purged = deduped.length - kept.length;
		migrated = kept.length;
		try {
			const months = /* @__PURE__ */ new Set();
			await inParallel(kept, AUDIT_MIGRATION_COPY_CONCURRENCY, async (entry) => {
				const month = auditMonthOf(entry.timestamp);
				await kv.set(KV.auditMonth(month), entry.id, entry);
				months.add(month);
			});
			for (const month of months) await markAuditMonth(kv, month);
		} catch (err) {
			logger.warn("audit migration stopped before finishing the copy pass; it resumes on the next boot", { error: err instanceof Error ? err.message : String(err) });
			return;
		}
		await writeAuditMigrationState(kv, {
			status: "copied",
			safeToListLegacy: false,
			legacySizeBytes: probe.sizeBytes,
			migrated,
			purged,
			summaryWritten: false,
			checkedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
	}
	await sleep(await runDeleteDelayMs());
	let remaining;
	try {
		remaining = await kv.list(KV.audit);
	} catch (err) {
		logger.warn("audit migration could not re-read the legacy audit log before deleting; it resumes on the next boot", { error: err instanceof Error ? err.message : String(err) });
		return;
	}
	try {
		await inParallel(remaining.slice().reverse(), AUDIT_MIGRATION_DELETE_CONCURRENCY, async (entry) => {
			await kv.delete(KV.audit, entry.id);
		});
	} catch (err) {
		logger.warn("audit migration stopped before finishing the delete pass; it resumes on the next boot", { error: err instanceof Error ? err.message : String(err) });
		return;
	}
	await withKeyedLock(AUDIT_MIGRATION_LOCK, async () => {
		if ((await readAuditMigrationState(kv))?.summaryWritten) return;
		if (purged > 0) await safeAudit(kv, "audit_migrate", AUDIT_MIGRATE_FUNCTION_ID, [], {
			reason: "index_persist rows predate opt-in auditing",
			purged,
			migrated
		});
		await writeAuditMigrationState(kv, {
			status: "done",
			safeToListLegacy: true,
			legacySizeBytes: 0,
			migrated,
			purged,
			summaryWritten: true,
			checkedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
	});
	logger.info("audit log moved to monthly scopes", {
		migrated,
		purged
	});
}
async function runAuditRetentionSweep(kv, retentionMonths) {
	if (!Number.isFinite(retentionMonths) || retentionMonths <= 0) return {
		droppedMonths: [],
		droppedRows: 0
	};
	const months = await readAuditMonthIndex(kv);
	const cutoff = monthNMonthsAgo(retentionMonths);
	const toDrop = months.filter((month) => month < cutoff).sort();
	if (toDrop.length === 0) return {
		droppedMonths: [],
		droppedRows: 0
	};
	let droppedRows = 0;
	for (const month of toDrop) {
		const rows = await kv.list(KV.auditMonth(month));
		for (const row of rows.slice().reverse()) {
			await kv.delete(KV.auditMonth(month), row.id);
			droppedRows++;
		}
	}
	await withKeyedLock(AUDIT_MONTHS_LOCK, async () => {
		const remaining = (await readAuditMonthIndex(kv)).filter((month) => !toDrop.includes(month)).sort();
		await kv.set(KV.auditMonths, "index", { months: remaining });
	});
	return {
		droppedMonths: toDrop,
		droppedRows
	};
}
//#endregion
//#region src/state/search-layer.ts
function isSearchLayer(value) {
	return value === "all" || value === "memory" || value === "observation";
}
function isSearchResultLayer(value) {
	return value === "memory" || value === "observation" || value === "lesson" || value === "insight";
}
function getSearchResultLayer(obsId, sessionId) {
	if (obsId.startsWith("mem_")) return "memory";
	if (sessionId === "lesson" || obsId.startsWith("lsn_")) return "lesson";
	if (sessionId === "insight" || obsId.startsWith("ins_")) return "insight";
	return "observation";
}
function matchesSearchLayer(obsId, sessionId, targetLayer = "all", layer) {
	return targetLayer === "all" || (layer ?? getSearchResultLayer(obsId, sessionId)) === targetLayer;
}
//#endregion
//#region src/state/memory-utils.ts
function memoryToObservation(memory) {
	return {
		id: memory.id,
		sessionId: memory.sessionIds?.[0] ?? "memory",
		timestamp: memory.createdAt,
		type: "decision",
		title: memory.title,
		facts: [memory.content],
		narrative: memory.content,
		concepts: memory.concepts,
		files: memory.files,
		importance: memory.strength,
		...memory.agentId ? { agentId: memory.agentId } : {}
	};
}
function lessonToObservation(l) {
	return {
		id: l.id,
		sessionId: "lesson",
		timestamp: l.createdAt,
		type: "decision",
		title: l.content.slice(0, 120),
		facts: [l.content],
		narrative: l.context || "",
		concepts: l.tags,
		files: [],
		importance: l.confidence
	};
}
//#endregion
//#region src/functions/recall-response.ts
function estimateTokens(value) {
	return Math.max(1, Math.ceil(JSON.stringify(value).length / 3));
}
function prefix(text, length) {
	let end = Math.min(length, text.length);
	if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
	return text.slice(0, end);
}
function fitText(text, budget, makeResult) {
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (estimateTokens(makeResult(prefix(text, middle))) <= budget) low = middle;
		else high = middle - 1;
	}
	return makeResult(prefix(text, low));
}
function formatResult(result, format) {
	if (format === "full") return result;
	const observation = result.observation;
	const compact = {
		obsId: observation.id,
		sessionId: result.sessionId,
		title: observation.title,
		type: observation.type,
		score: result.score,
		timestamp: observation.timestamp,
		...result.layer !== void 0 && { layer: result.layer }
	};
	if (format === "compact") return compact;
	const { type: _type, ...narrative } = compact;
	return {
		...narrative,
		narrative: observation.narrative
	};
}
function clipResult(result, format, budget) {
	const observation = result.observation;
	const layer = result.layer !== void 0 ? { layer: result.layer } : {};
	if (format === "compact") {
		const base = {
			obsId: observation.id,
			sessionId: result.sessionId,
			title: "",
			type: observation.type,
			score: result.score,
			timestamp: observation.timestamp,
			...layer,
			content_truncated: true
		};
		const minimum = estimateTokens(base);
		if (minimum > budget) return { minimum };
		return {
			result: fitText(observation.title, budget, (title) => ({
				...base,
				title
			})),
			minimum
		};
	}
	const makeResult = (title, narrative) => {
		if (format === "narrative") return {
			obsId: observation.id,
			sessionId: result.sessionId,
			title,
			narrative,
			score: result.score,
			timestamp: observation.timestamp,
			...layer,
			content_truncated: true
		};
		return {
			observation: {
				id: observation.id,
				sessionId: observation.sessionId,
				timestamp: observation.timestamp,
				type: observation.type,
				title,
				facts: [],
				narrative,
				concepts: [],
				files: [],
				importance: observation.importance,
				...observation.confidence !== void 0 && { confidence: observation.confidence },
				...observation.agentId !== void 0 && { agentId: observation.agentId },
				...observation.origin && { origin: {
					channel: observation.origin.channel,
					capturedAt: observation.origin.capturedAt
				} }
			},
			score: result.score,
			sessionId: result.sessionId,
			...layer,
			content_truncated: true
		};
	};
	const minimum = estimateTokens(makeResult("", ""));
	if (minimum > budget) return { minimum };
	const titleResult = fitText(prefix(observation.title, 120), budget, (title) => makeResult(title, ""));
	const title = "observation" in titleResult ? titleResult.observation.title : titleResult.title;
	return {
		result: fitText(observation.narrative || observation.facts.join("\n"), budget, (text) => makeResult(title, text)),
		minimum
	};
}
function buildRecallResponse(results, format, tokenBudget) {
	const selected = [];
	let used = 0;
	let clipped = false;
	let minimumBudget;
	for (const result of results) {
		const formatted = formatResult(result, format);
		const tokens = estimateTokens(formatted);
		if (tokenBudget === void 0 || used + tokens <= tokenBudget) {
			selected.push(formatted);
			used += tokens;
			continue;
		}
		if (selected.length === 0) {
			const preview = clipResult(result, format, tokenBudget);
			if (preview.result) {
				selected.push(preview.result);
				used = estimateTokens(preview.result);
				clipped = true;
				continue;
			} else minimumBudget = Math.min(preview.minimum, tokens);
		}
		break;
	}
	const excluded = results.slice(selected.length);
	const metadata = {
		tokens_used: used,
		tokens_budget: tokenBudget,
		truncated: clipped || excluded.length > 0,
		matched_count: results.length,
		excluded_by_budget: excluded.length,
		excluded_results: excluded.slice(0, 10).map((result) => ({
			obsId: result.observation.id,
			sessionId: result.sessionId,
			title: prefix(result.observation.title, 120)
		})),
		excluded_results_truncated: excluded.length > 10,
		...minimumBudget !== void 0 && { minimum_budget: minimumBudget }
	};
	if (format === "narrative") {
		const narrativeResults = selected;
		return {
			...metadata,
			format,
			results: narrativeResults,
			text: narrativeResults.map((result, index) => `${index + 1}. ${result.title}\n${result.narrative}`).join("\n\n")
		};
	}
	if (format === "compact") return {
		...metadata,
		format,
		results: selected
	};
	return {
		...metadata,
		format,
		results: selected
	};
}
//#endregion
//#region src/secret-store.ts
const SECRET_KEY = "AGENTMEMORY_SECRET";
function agentmemoryHomeDir() {
	return join(homedir(), ".agentmemory");
}
function secretFilePath() {
	return join(agentmemoryHomeDir(), "secret");
}
function usable(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("${") && trimmed.endsWith("}")) return "";
	return trimmed;
}
function unquote(value) {
	const quote = value[0];
	if ((quote === "\"" || quote === "'") && value.length > 1) {
		const close = value.indexOf(quote, 1);
		if (close !== -1) return value.slice(1, close);
	}
	const hash = value.indexOf(" #");
	return hash === -1 ? value : value.slice(0, hash).trim();
}
function readEnvFileSecret() {
	let content;
	try {
		content = readFileSync(join(agentmemoryHomeDir(), ".env"), "utf-8");
	} catch {
		return "";
	}
	if (typeof content !== "string") return "";
	let found = "";
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		if (trimmed.slice(0, eq).replace(/^export\s+/, "").trim() !== SECRET_KEY) continue;
		found = usable(unquote(trimmed.slice(eq + 1).trim()));
	}
	return found;
}
function readStoredSecret() {
	try {
		return usable(readFileSync(secretFilePath(), "utf-8"));
	} catch {
		return "";
	}
}
function explicitSecret(env = process.env) {
	return usable(env[SECRET_KEY]) || readEnvFileSecret();
}
function isLoopbackUrl(url) {
	let hostname;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	const bare = hostname.replace(/^\[|\]$/g, "");
	return bare === "localhost" || bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare);
}
function resolveClientSecret(baseUrl, env = process.env) {
	const fromEnv = usable(env[SECRET_KEY]);
	if (fromEnv) return fromEnv;
	if (env.AGENTMEMORY_CREDENTIAL_MODE === "explicit") return "";
	if (!isLoopbackUrl(baseUrl)) return "";
	return readEnvFileSecret() || readStoredSecret();
}
function ensureServerSecret(env = process.env) {
	const configured = explicitSecret(env);
	if (configured) return {
		secret: configured,
		source: "env"
	};
	const stored = readStoredSecret();
	if (stored) return {
		secret: stored,
		source: "file"
	};
	const generated = randomBytes(32).toString("hex");
	const path = secretFilePath();
	mkdirSync(agentmemoryHomeDir(), {
		recursive: true,
		mode: 448
	});
	const staging = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	const fd = openSync(staging, "wx", 384);
	try {
		writeSync(fd, `${generated}\n`);
	} finally {
		closeSync(fd);
	}
	try {
		chmodSync(staging, 384);
		linkSync(staging, path);
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
		const raced = readStoredSecret();
		if (!raced) throw err;
		return {
			secret: raced,
			source: "file"
		};
	} finally {
		try {
			unlinkSync(staging);
		} catch {}
	}
	return {
		secret: generated,
		source: "generated"
	};
}
function bearerHeaders(baseUrl, env = process.env) {
	const secret = resolveClientSecret(baseUrl, env);
	return secret ? { Authorization: `Bearer ${secret}` } : {};
}
//#endregion
export { isGraphExtractionEnabled as $, getAuditRetentionMonths as A, getStandalonePersistPath as B, III_PINNED_VERSION as C, clearPersistedBuiltinConfig as Ct, detectEmbeddingProvider as D, describeLlmRoute as E, renderEngineConfig as Et, getFinalizeIdleMs as F, getViewerStreamMax as G, getStateSaveIntervalMs as H, getFollowupWindowSeconds as I, isAutoCompressEnabled as J, hydrateProcessEnvFromFile as K, getIndexSaveIntervalMs as L, getConsolidationDecayDays as M, getConsolidationIntervalMs as N, detectLlmProviderKind as O, getEnvVar as P, isGraphCompactOnBootEnabled as Q, getRedisUrl as R, getVisibleTools as S, captureDurableAfterMs as St, MAX_IMPORT_OBS_PER_SESSION as T, engineStateConfigPaths as Tt, getVectorBackfillMax as U, getStateBackend as V, getVectorBucketSize as W, isContextInjectionEnabled as X, isConsolidationEnabled as Y, isDropStaleIndexEnabled as Z, safeAudit as _, redactCredentialUrls as _t, secretFilePath as a, loadFallbackConfig as at, ESSENTIAL_TOOLS as b, rewriteBundledConfig as bt, memoryToObservation as c, bootLog as ct, isSearchResultLayer as d, setBootVerbose as dt, isSessionSweepEnabled as et, matchesSearchLayer as f, dockerComposeArgs as ft, runAuditRetentionSweep as g, legacyDataMigrations as gt, recordAudit as h, isBundledConfig as ht, resolveClientSecret as i, loadEmbeddingConfig as it, getConsolidationCooldownMs as j, getAgentId as k, getSearchResultLayer as l, bootWarn as lt, queryAudit as m, engineChildEnv as mt, ensureServerSecret as n, loadClaudeBridgeConfig as nt, buildRecallResponse as o, loadSnapshotConfig as ot, AUDIT_MIGRATION_STATE_KEY as p, dockerProjectName as pt, isAgentScopeIsolated as q, explicitSecret as r, loadConfig as rt, lessonToObservation as s, loadTeamConfig as st, bearerHeaders as t, isVectorBackfillAllEnabled as tt, isSearchLayer as u, logger as ut, setAuditRecordedListener as v, resolveEngineCwd as vt, VERSION as w, engineFlushWaitMs as wt, getAllTools as x, runtimeConfigPath as xt, startAuditMigration as y, resolveLaunchRenderFailure as yt, getSessionSweepStaleHours as z };

//# sourceMappingURL=secret-store-BIHNFqsl.mjs.map
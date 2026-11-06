#!/usr/bin/env node
import { a as runAdapter, i as resolveAdapter, r as knownAgents, t as ADAPTERS } from "./connect-lMnCKiNM.mjs";
import { c as generateId } from "./keyed-mutex-B2ARAhzY.mjs";
import { C as III_PINNED_VERSION, Ct as clearPersistedBuiltinConfig, Et as renderEngineConfig, H as getStateSaveIntervalMs, K as hydrateProcessEnvFromFile, R as getRedisUrl, Tt as engineStateConfigPaths, V as getStateBackend, _t as redactCredentialUrls, b as ESSENTIAL_TOOLS, bt as rewriteBundledConfig, dt as setBootVerbose, ft as dockerComposeArgs, gt as legacyDataMigrations, ht as isBundledConfig, i as resolveClientSecret, mt as engineChildEnv, pt as dockerProjectName, t as bearerHeaders, vt as resolveEngineCwd, w as VERSION, wt as engineFlushWaitMs, x as getAllTools, xt as runtimeConfigPath, yt as resolveLaunchRenderFailure } from "./secret-store-BIHNFqsl.mjs";
import { $ as CURL_AUTH_HEADER, $t as registerStartupCleanup, Bt as parseSentMark, Gt as spoolSummary, Ht as retainSent, Qt as SHUTDOWN_HARD_EXIT_MS, Xt as resolveDataDir, en as runStartupCleanup, nn as runtimeMetadataPath, t as parseCompressionScope, zt as drainSpool } from "./compression-recovery-BaKdcC6y.mjs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, constants, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { createHash } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
//#region src/cli/doctor-diagnostics.ts
/** Common placeholder values shipped in .env.example. */
const PLACEHOLDER_VALUES = new Set([
	"",
	"your-key-here",
	"sk-ant-...",
	"sk-...",
	"changeme",
	"todo",
	"xxx"
]);
const PROVIDER_KEY_NAMES = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"OPENROUTER_API_KEY",
	"MINIMAX_API_KEY"
];
function parseEnvFile(content) {
	const out = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (value.startsWith("\"") && value.endsWith("\"") || value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
		out[key] = value;
	}
	return out;
}
/** Returns the list of provider keys that look real (non-placeholder). */
function realProviderKeys(env) {
	return PROVIDER_KEY_NAMES.filter((k) => {
		const v = (env[k] ?? "").trim();
		if (!v) return false;
		if (PLACEHOLDER_VALUES.has(v.toLowerCase())) return false;
		if (/^x+$/i.test(v.replace(/[-_]/g, ""))) return false;
		return true;
	});
}
/** Returns the list of provider key NAMES that exist but are placeholders. */
function placeholderProviderKeys(env) {
	return PROVIDER_KEY_NAMES.filter((k) => {
		const v = (env[k] ?? "").trim();
		if (!v) return false;
		if (PLACEHOLDER_VALUES.has(v.toLowerCase())) return true;
		if (/^x+$/i.test(v.replace(/[-_]/g, ""))) return true;
		return false;
	});
}
function buildDiagnostics(effects) {
	return [
		{
			id: "env-missing",
			message: "~/.agentmemory/.env is missing.",
			fixPreview: "Copy .env.example into ~/.agentmemory/.env (your keys file).",
			moreInfo: "agentmemory reads provider API keys (Anthropic, OpenAI, Gemini, …) from ~/.agentmemory/.env. Without this file the daemon falls back to BM25-only search and no LLM-backed enrichment runs.",
			check: async () => ({
				ok: effects.envFileExists(),
				detail: effects.envFileExists() ? void 0 : "no env file"
			}),
			fix: () => effects.runInit()
		},
		{
			id: "no-llm-provider-key",
			message: "No LLM provider API key found in ~/.agentmemory/.env.",
			fixPreview: "Open ~/.agentmemory/.env in $EDITOR and paste your key, then re-check.",
			moreInfo: "Set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, MINIMAX_API_KEY. The daemon picks the first that resolves to a real (non-placeholder) value at startup.",
			check: async () => {
				if (!effects.envFileExists()) return {
					ok: false,
					detail: "env file missing (run env-missing fix first)"
				};
				const real = realProviderKeys(effects.readEnvFile());
				return {
					ok: real.length > 0,
					detail: real.length > 0 ? `found: ${real.join(", ")}` : "no provider key set"
				};
			},
			fix: (ctx) => effects.openEditor(ctx.envPath)
		},
		{
			id: "engine-version-mismatch",
			message: "iii binary on PATH doesn't match the version agentmemory pins to.",
			fixPreview: "Re-run the iii installer for the pinned version and restart the engine.",
			moreInfo: "agentmemory pins the iii engine to a specific release because newer engines use a different worker model. Running a mismatched binary surfaces as EPIPE reconnect loops and empty search results.",
			check: async (ctx) => {
				const bin = effects.findIiiBinary();
				if (!bin) return {
					ok: false,
					detail: "iii not on PATH"
				};
				const v = effects.iiiBinaryVersion(bin);
				if (!v) return {
					ok: false,
					detail: "iii on PATH but --version failed"
				};
				return {
					ok: v === ctx.pinnedVersion,
					detail: `${v} (pinned ${ctx.pinnedVersion})`
				};
			},
			fix: async () => {
				const r = await effects.runIiiInstaller();
				if (!r.ok) return r;
				await effects.runStop();
				return effects.runStart();
			}
		},
		{
			id: "viewer-unreachable",
			message: "Viewer port not reachable.",
			fixPreview: "Stop the engine, restart it, and retry the viewer probe.",
			moreInfo: "The viewer is served on REST port + 2 (default 3113). If it never came up the most common cause is port collision; a sibling PR ships auto-bump for this case. If that lands first this check just verifies; otherwise restart the engine to retry binding.",
			check: async () => ({
				ok: await effects.viewerReachable(),
				detail: void 0
			}),
			fix: async () => {
				const stopped = await effects.runStop();
				if (!stopped.ok) return stopped;
				return effects.runStart();
			}
		},
		{
			id: "stale-pidfile",
			message: "Stale pidfile: pid recorded but the process is gone.",
			fixPreview: "Clear ~/.agentmemory/iii.pid + engine-state.json, then restart.",
			moreInfo: "When the engine crashes hard (kill -9, OOM, host reboot) the pidfile sticks around. agentmemory refuses to start a second engine on top of a stale pid, so this state must be cleared explicitly.",
			check: async () => {
				if (!effects.pidfileExists()) return {
					ok: true,
					detail: "no pidfile"
				};
				const alive = effects.pidfilePidIsAlive();
				if (alive === null) return {
					ok: true,
					detail: "pidfile unreadable"
				};
				return {
					ok: alive,
					detail: alive ? "pid is alive" : "pid is gone"
				};
			},
			fix: async () => {
				effects.clearEnginePidAndState();
				return effects.runStart();
			}
		},
		{
			id: "env-placeholder-keys",
			message: "~/.agentmemory/.env contains placeholder/empty API keys.",
			fixPreview: "Open ~/.agentmemory/.env in $EDITOR to paste real values.",
			moreInfo: "Lines like ANTHROPIC_API_KEY=sk-ant-... or =your-key-here are treated as absent. The daemon will fall back to BM25-only search. Replace placeholders with real keys or comment the line out.",
			check: async () => {
				if (!effects.envFileExists()) return {
					ok: true,
					detail: "env file missing (handled by env-missing)"
				};
				const placeholders = placeholderProviderKeys(effects.readEnvFile());
				return {
					ok: placeholders.length === 0,
					detail: placeholders.length === 0 ? void 0 : `placeholder: ${placeholders.join(", ")}`
				};
			},
			fix: (ctx) => effects.openEditor(ctx.envPath)
		},
		{
			id: "iii-on-path-not-local-bin",
			message: "iii is on PATH but not at agentmemory's private install path.",
			fixPreview: "Install the pinned version to ~/.agentmemory/bin — won't touch your PATH.",
			moreInfo: "agentmemory installs its pinned engine to ~/.agentmemory/bin/iii so a user-managed iii on PATH (homebrew, cargo, manual install) stays untouched. When agentmemory needs the pin and PATH doesn't have it, it falls back to the private install. If neither exists, run the installer.",
			manualOnly: true,
			check: async () => {
				const bin = effects.findIiiBinary();
				if (!bin) return {
					ok: true,
					detail: "iii not on PATH (handled elsewhere)"
				};
				const localBin = effects.localBinIiiPath();
				return {
					ok: bin === localBin,
					detail: bin === localBin ? void 0 : `iii at: ${bin}`
				};
			},
			fix: async () => effects.runIiiInstaller().then((r) => ({
				ok: r.ok,
				message: r.message ?? "Installer wrote to ~/.agentmemory/bin/iii. Your PATH wasn't modified."
			}))
		}
	];
}
/**
* Dry-run output: each failing check's fix preview, prefixed by the diagnostic
* message. Pure function so we can snapshot-test the format.
*/
function dryRunPlan(ctx, results) {
	const lines = [];
	let n = 0;
	for (const { diagnostic, status } of results) {
		if (status.ok) continue;
		n++;
		lines.push(`${n}. [${diagnostic.id}] ${diagnostic.message}`);
		lines.push(`   would fix: ${diagnostic.fixPreview}`);
		if (status.detail) lines.push(`   detail: ${status.detail}`);
	}
	if (lines.length === 0) lines.push(`All checks passing for ${ctx.baseUrl} — no fixes to run.`);
	return lines;
}
//#endregion
//#region src/cli/remove-plan.ts
function pidfilePath(runtimeDir) {
	return join(runtimeDir, "iii.pid");
}
function workerPidfilePath$1(runtimeDir) {
	return join(runtimeDir, "worker.pid");
}
function enginePath(runtimeDir) {
	return join(runtimeDir, "engine-state.json");
}
function envPath(home) {
	return join(home, ".agentmemory", ".env");
}
function preferencesPath(home) {
	return join(home, ".agentmemory", "preferences.json");
}
function backupsDir(home) {
	return join(home, ".agentmemory", "backups");
}
function iiiBinFile() {
	return process.platform === "win32" ? "iii.exe" : "iii";
}
function legacyLocalBinIii(home) {
	return join(home, ".local", "bin", iiiBinFile());
}
function privateIiiBin(home) {
	return join(home, ".agentmemory", "bin", iiiBinFile());
}
function safeSize(path) {
	try {
		return statSync(path).size;
	} catch {
		return -1;
	}
}
function pathExists(path) {
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}
/**
* Build the destruction plan for `agentmemory remove`.
*
* Plan items are returned regardless of whether `applicable` is true — the
* caller can decide whether to skip-and-log or hide entirely. This keeps
* the structure stable for tests.
*/
function buildRemovePlan(ctx, options) {
	const { home, runtimeDir, dataDir, pinnedVersion, localBinIiiVersion, connectManifest } = ctx;
	const plan = [];
	plan.push({
		id: "stop-engine",
		description: "Stop running iii-engine (if any) cleanly",
		path: null,
		alwaysAsk: false,
		applicable: pathExists(pidfilePath(runtimeDir)) || pathExists(workerPidfilePath$1(runtimeDir)) || pathExists(enginePath(runtimeDir)),
		sizeBytes: -1
	});
	plan.push({
		id: "pidfile",
		description: "Delete pidfile",
		path: pidfilePath(runtimeDir),
		alwaysAsk: false,
		applicable: pathExists(pidfilePath(runtimeDir)),
		sizeBytes: safeSize(pidfilePath(runtimeDir))
	});
	plan.push({
		id: "worker-pidfile",
		description: "Delete worker pidfile",
		path: workerPidfilePath$1(runtimeDir),
		alwaysAsk: false,
		applicable: pathExists(workerPidfilePath$1(runtimeDir)),
		sizeBytes: safeSize(workerPidfilePath$1(runtimeDir))
	});
	plan.push({
		id: "engine-state",
		description: "Delete engine-state.json",
		path: enginePath(runtimeDir),
		alwaysAsk: false,
		applicable: !options.preserveRuntimeState && pathExists(enginePath(runtimeDir)),
		sizeBytes: safeSize(enginePath(runtimeDir))
	});
	plan.push({
		id: "env",
		description: "Delete .env (your API keys) — will ask separately",
		path: envPath(home),
		alwaysAsk: true,
		applicable: !options.keepData && pathExists(envPath(home)),
		sizeBytes: safeSize(envPath(home))
	});
	plan.push({
		id: "preferences",
		description: "Delete preferences.json",
		path: preferencesPath(home),
		alwaysAsk: false,
		applicable: !options.keepData && pathExists(preferencesPath(home)),
		sizeBytes: safeSize(preferencesPath(home))
	});
	plan.push({
		id: "backups",
		description: "Delete backups/ directory (connect manifest + backups)",
		path: backupsDir(home),
		alwaysAsk: false,
		applicable: !options.keepData && pathExists(backupsDir(home)),
		sizeBytes: -1
	});
	plan.push({
		id: "runtime-config",
		description: "Delete generated iii-config.runtime.yaml",
		path: runtimeConfigPath(dataDir),
		alwaysAsk: false,
		applicable: pathExists(runtimeConfigPath(dataDir)),
		sizeBytes: safeSize(runtimeConfigPath(dataDir))
	});
	if (connectManifest?.installed?.length) for (const entry of connectManifest.installed) plan.push({
		id: `connect:${entry.target}`,
		description: `Remove agent connection (${entry.agent ?? "unknown"})`,
		path: entry.target,
		alwaysAsk: false,
		applicable: pathExists(entry.target),
		sizeBytes: safeSize(entry.target)
	});
	const privIii = privateIiiBin(home);
	if (pathExists(privIii)) plan.push({
		id: "private-bin-iii",
		description: `Delete ~/.agentmemory/bin/iii (agentmemory's private install)`,
		path: privIii,
		alwaysAsk: false,
		applicable: true,
		sizeBytes: safeSize(privIii)
	});
	const legacyIii = legacyLocalBinIii(home);
	if (pathExists(legacyIii)) {
		const matches = localBinIiiVersion === pinnedVersion;
		plan.push({
			id: "legacy-local-bin-iii",
			description: matches ? `Delete ~/.local/bin/iii (legacy install location, matches pinned v${pinnedVersion})` : `Delete ~/.local/bin/iii (legacy install location, version ${localBinIiiVersion ?? "unknown"} != pinned v${pinnedVersion}) — will ask`,
			path: legacyIii,
			alwaysAsk: !matches,
			applicable: true,
			sizeBytes: safeSize(legacyIii)
		});
	}
	plan.push({
		id: "data-dir",
		description: `Delete memory data directory (${dataDir}) — will ask separately`,
		path: dataDir,
		alwaysAsk: true,
		applicable: !options.keepData && pathExists(dataDir),
		sizeBytes: -1
	});
	return plan;
}
/** Format a plan for the user — one line per item. */
function formatPlan(plan) {
	return plan.filter((p) => p.applicable).map((p, i) => {
		const tag = p.alwaysAsk ? " [asks]" : "";
		const sz = p.sizeBytes > 0 ? ` (${humanBytes(p.sizeBytes)})` : "";
		return `  ${i + 1}. ${p.description}${tag}${sz}${p.path ? `\n     ${p.path}` : ""}`;
	}).join("\n");
}
function humanBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
//#endregion
//#region src/cli/ready-hint.ts
const DEFAULT_REST_PORT = 3111;
function portFlagSuffix(restPort, instance) {
	if (instance > 0 && restPort === DEFAULT_REST_PORT + instance * 100) return ` --instance ${instance}`;
	return restPort === DEFAULT_REST_PORT ? "" : ` --port ${restPort}`;
}
const III_INSTALL_SPAWN_TIMEOUT_MS = 345 * 1e3;
const III_RELEASE_SHA256 = { "0.22.1": {
	"iii-aarch64-apple-darwin.tar.gz": "2b309019b909a896cae874dc947e2cdf877b4f3c51dd026b79850af858517fa4",
	"iii-x86_64-apple-darwin.tar.gz": "6d33940db2d3ad6a9aef9837aa5b89bf5c5e4acd0679e8178fec258af229d7e1",
	"iii-x86_64-unknown-linux-gnu.tar.gz": "34d4bd2ec1873e6114bb836be7db9cb3f410d0d63353d240917f0bc9c30df13b",
	"iii-aarch64-unknown-linux-gnu.tar.gz": "87efc60210c1580ef2e11b13c679a4dad91917a9d80f737c5ba7e3475b3ca413",
	"iii-armv7-unknown-linux-gnueabihf.tar.gz": "af5dfc45149678c647e5adaca55c055428eebfa73d65884b052c30c98abcfd19",
	"iii-x86_64-pc-windows-msvc.zip": "d862bf7cf1e864f3290c8a6fc17c308c6ecac097cb2666e4a739efc0040aae96",
	"iii-aarch64-pc-windows-msvc.zip": "4777a48cee3fc1a742daee929e3d943df09e4ddd3357d27a33d31c9dc9e520ac"
} };
function expectedIiiSha256(version, asset, checksums = III_RELEASE_SHA256) {
	return checksums[version]?.[asset] ?? null;
}
function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function curlTimeoutFlags() {
	return `--connect-timeout 15 --max-time 300`;
}
function iiiArchivePath(binDir) {
	return join(binDir, ".iii-download.tar.gz");
}
function iiiDownloadShellCommand() {
	return `mkdir -p "$2" && rm -f "$3" && if curl -fsSL ${curlTimeoutFlags()} -o "$3" "$1"; then :; else code=$?; rm -f "$3"; exit $code; fi`;
}
function iiiExtractShellCommand() {
	return "if tar -xzf \"$1\" -C \"$2\"; then rm -f \"$1\"; else code=$?; rm -f \"$1\"; exit $code; fi && chmod +x \"$3\"";
}
function iiiManualInstallCommand(releaseUrl, binDir, binPath, sha256) {
	return `mkdir -p "${binDir}" && archive="$(mktemp "${binDir}/.iii-download.XXXXXX")" && { curl -fL --connect-timeout 15 -o "$archive" "${releaseUrl}"${sha256 ? ` && printf '%s  %s\\n' "${sha256}" "$archive" | { sha256sum -c - 2>/dev/null || shasum -a 256 -c -; }` : ""} && tar -xzf "$archive" -C "${binDir}"; code=$?; rm -f "$archive"; (exit $code); } && chmod +x "${binPath}"`;
}
function describeInstallFailure(result) {
	if (result.error?.code === "ETIMEDOUT") return `timed out after ${Math.round(III_INSTALL_SPAWN_TIMEOUT_MS / 1e3)} s`;
	const output = (result.stderr || result.stdout || "").toString().trim();
	if (output) return output;
	if (result.status === 28) return `download timed out (no connection within 15 s or not finished within 300 s)`;
	if (result.signal) return `installer stopped by ${result.signal}`;
	if (result.error) return result.error.message;
	return `installer exited with status ${result.status ?? "unknown"}`;
}
function installIiiArchive(opts) {
	const expected = expectedIiiSha256(opts.version, opts.asset, opts.checksums);
	if (!expected) return {
		ok: false,
		reason: "no-checksum",
		detail: `no pinned SHA-256 for ${opts.asset} in iii v${opts.version}, so the download cannot be verified`
	};
	const run = (script, args) => spawnSync(opts.sh, [
		"-c",
		script,
		"sh",
		...args
	], {
		stdio: "pipe",
		encoding: "utf-8",
		timeout: III_INSTALL_SPAWN_TIMEOUT_MS,
		env: opts.env ?? process.env
	});
	const archive = iiiArchivePath(opts.binDir);
	const download = run(iiiDownloadShellCommand(), [
		opts.releaseUrl,
		opts.binDir,
		archive
	]);
	if (download.status !== 0) return {
		ok: false,
		reason: "download",
		detail: describeInstallFailure(download)
	};
	let actual;
	try {
		actual = sha256File(archive);
	} catch (err) {
		rmSync(archive, { force: true });
		return {
			ok: false,
			reason: "download",
			detail: err instanceof Error ? err.message : String(err)
		};
	}
	if (actual !== expected) {
		rmSync(archive, { force: true });
		return {
			ok: false,
			reason: "checksum",
			detail: `SHA-256 mismatch for ${opts.asset}: expected ${expected}, got ${actual}. The download was deleted and nothing was installed`
		};
	}
	const extract = run(iiiExtractShellCommand(), [
		archive,
		opts.binDir,
		opts.binPath
	]);
	if (extract.status !== 0) return {
		ok: false,
		reason: "extract",
		detail: describeInstallFailure(extract)
	};
	return { ok: true };
}
//#endregion
//#region src/cli/startup-stderr.ts
function createStartupStderrCapture(maxBytes = 16 * 1024) {
	const chunks = [];
	let capturedBytes = 0;
	return {
		append(chunk) {
			if (capturedBytes >= maxBytes) return;
			const slice = chunk.subarray(0, maxBytes - capturedBytes);
			chunks.push(slice);
			capturedBytes += slice.length;
		},
		text() {
			return Buffer.concat(chunks).toString("utf8");
		}
	};
}
//#endregion
//#region src/cli/readiness.ts
const DEFAULT_ENGINE_TIMEOUT_MS = 12e4;
const DEFAULT_WORKER_TIMEOUT_MS = 3e5;
const MAX_STARTUP_TIMEOUT_MS = 36e5;
function startupTimeouts(env = process.env) {
	const parse = (key, fallback) => {
		const raw = env[key];
		if (raw === void 0) return fallback;
		const value = Number(raw);
		if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 36e5) throw new Error(`${key} must be an integer between 1 and ${MAX_STARTUP_TIMEOUT_MS} milliseconds.`);
		return value;
	};
	const ownership = env.AGENTMEMORY_ENGINE_MANAGES_WORKER;
	if (ownership !== void 0 && ownership !== "true" && ownership !== "false") throw new Error("AGENTMEMORY_ENGINE_MANAGES_WORKER must be true or false.");
	return {
		engineMs: parse("AGENTMEMORY_ENGINE_READY_TIMEOUT_MS", DEFAULT_ENGINE_TIMEOUT_MS),
		workerMs: parse("AGENTMEMORY_READY_TIMEOUT_MS", DEFAULT_WORKER_TIMEOUT_MS),
		engineManagesWorker: ownership === void 0 ? void 0 : ownership === "true"
	};
}
function configStartsAgentmemoryWorker(raw, workerEntry, engineCwd) {
	const lines = raw.split(/\r?\n/);
	let workerIndent;
	let execIndent;
	for (const line of lines) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const indent = line.length - line.trimStart().length;
		if (workerIndent !== void 0 && indent <= workerIndent) {
			workerIndent = void 0;
			execIndent = void 0;
		}
		if (/^\s*-\s+name:\s*(?:iii-exec|"iii-exec"|'iii-exec')(?:\s+#.*)?\s*$/.test(line)) {
			workerIndent = indent;
			continue;
		}
		if (workerIndent === void 0) continue;
		if (execIndent !== void 0 && indent <= execIndent) execIndent = void 0;
		if (/^\s*exec:\s*(?:#.*)?$/.test(line)) {
			execIndent = indent;
			continue;
		}
		if (execIndent === void 0) continue;
		const scalar = line.match(/^\s*-\s+(.+)$/)?.[1]?.trim();
		if (!scalar) continue;
		const quoted = scalar.match(/^(["'])(.*?)\1(?:\s+#.*)?$/);
		const tokens = (quoted ? quoted[2] : scalar).match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((token) => token.replace(/^("|')(.*)\1$/, "$2").replaceAll("\\", "/"));
		if (!tokens) continue;
		const comment = tokens.findIndex((token) => token.startsWith("#"));
		if (comment !== -1) tokens.splice(comment);
		const runtime = tokens[0]?.split("/").at(-1);
		if (runtime !== "node" && runtime !== "node.exe" && runtime !== "tsx") continue;
		if (runtime !== "tsx") while (tokens[1] && /^(?:--max[-_]old[-_]space[-_]size=\d+|--enable-source-maps|--no-warnings)$/.test(tokens[1])) tokens.splice(1, 1);
		const entry = tokens.length === 2 ? tokens[1] : tokens.length === 4 && tokens[1] === "--import" && tokens[2] === "tsx" ? tokens[3] : void 0;
		if (entry === workerEntry.replaceAll("\\", "/")) return true;
		if (entry === "dist/index.mjs" || entry === "./dist/index.mjs" || entry === "src/index.ts" || entry === "./src/index.ts") {
			if (engineCwd === void 0) return true;
			try {
				if (statSync(join(engineCwd, entry)).isFile()) return true;
			} catch {}
		}
	}
	return false;
}
function startupTimeoutMessage(kind, timeoutMs) {
	const name = kind === "engine" ? "iii-engine" : "agentmemory worker";
	const variable = kind === "engine" ? "AGENTMEMORY_ENGINE_READY_TIMEOUT_MS" : "AGENTMEMORY_READY_TIMEOUT_MS";
	return `${name} did not become ready within ${timeoutMs / 1e3}s. Set ${variable} to allow more startup time.`;
}
function startupDeadline(timeoutMs) {
	const deadline = performance.now() + timeoutMs;
	return { remaining: () => Math.max(0, deadline - performance.now()) };
}
async function withinStartupDeadline(deadline, work, maximumMs = Infinity) {
	const remaining = Math.min(deadline.remaining(), maximumMs);
	if (remaining <= 0) return { completed: false };
	const controller = new AbortController();
	let timer;
	const expired = new Promise((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve({ completed: false });
		}, Math.ceil(remaining));
	});
	try {
		const result = await Promise.race([Promise.resolve().then(() => work(controller.signal)).then((value) => ({
			completed: true,
			value
		})), expired]);
		return deadline.remaining() > 0 ? result : { completed: false };
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}
async function waitForReadiness(deadline, probe, options = {}) {
	while (deadline.remaining() > 0 && !options.stopped?.()) {
		const result = await withinStartupDeadline(deadline, probe, 2e3).catch(() => ({ completed: false }));
		if (options.stopped?.()) return false;
		if (result.completed && result.value) return true;
		const remaining = deadline.remaining();
		if (remaining <= 0) break;
		await new Promise((resolve) => setTimeout(resolve, Math.min(options.intervalMs ?? 250, remaining)));
	}
	return false;
}
async function probeEngine(base, signal) {
	(await fetch(`${base}/`, { signal })).body?.cancel().catch(() => {});
	return true;
}
async function probeWorker(base, signal, onViewerPort) {
	const response = await fetch(`${base}/agentmemory/livez`, { signal });
	if (!response.ok) {
		response.body?.cancel().catch(() => {});
		return false;
	}
	const data = await response.json();
	if (!data || typeof data !== "object" || Array.isArray(data)) return false;
	const { viewerPort, viewerSkipped } = data;
	if (typeof viewerPort === "number" && Number.isInteger(viewerPort) && viewerPort > 0 && viewerPort <= 65535) {
		onViewerPort?.(viewerPort);
		return true;
	}
	return viewerSkipped === true;
}
async function startWorkerAndWait(options) {
	const deadline = startupDeadline(options.timeoutMs);
	if (options.stopped?.()) return false;
	if (!options.hasLiveWorker() && !options.engineStartsWorker()) {
		if (!(await withinStartupDeadline(deadline, () => options.startWorker())).completed) return false;
	}
	return waitForReadiness(deadline, options.probe, { stopped: options.stopped });
}
//#endregion
//#region src/cli/console.ts
const GLOBAL_VALUE_FLAGS = new Set([
	"--port",
	"--instance",
	"--data-dir",
	"--tools"
]);
const GLOBAL_BOOLEAN_FLAGS = new Set([
	"--verbose",
	"-v",
	"--no-engine"
]);
function defaultConsolePort(viewerPort) {
	return viewerPort + 1;
}
function readPort(raw, flag) {
	const port = raw === void 0 ? NaN : Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${flag} needs a port between 1 and 65535`);
	return port;
}
function parseConsoleArgs(tail, fallbackPort) {
	let consolePort = fallbackPort;
	const extraArgs = [];
	for (let i = 0; i < tail.length; i++) {
		const arg = tail[i];
		if (arg === "--console-port") {
			consolePort = readPort(tail[i + 1], arg);
			i++;
			continue;
		}
		if (arg.startsWith("--console-port=")) {
			consolePort = readPort(arg.slice(15), "--console-port");
			continue;
		}
		if (GLOBAL_VALUE_FLAGS.has(arg)) {
			i++;
			continue;
		}
		if ([...GLOBAL_VALUE_FLAGS].some((flag) => arg.startsWith(`${flag}=`))) continue;
		if (GLOBAL_BOOLEAN_FLAGS.has(arg)) continue;
		extraArgs.push(arg);
	}
	return {
		consolePort,
		extraArgs
	};
}
function consoleArgs(launch) {
	return [
		"console",
		"--port",
		String(launch.consolePort),
		"--engine-port",
		String(launch.restPort),
		"--ws-port",
		String(launch.streamPort),
		"--bridge-port",
		String(launch.enginePort),
		...launch.extraArgs
	];
}
//#endregion
//#region src/cli/process-state.ts
function processStatIsRunning(stat) {
	return !stat.trimStart().startsWith("Z");
}
//#endregion
//#region src/cli/splash.ts
const IS_COLOR_TTY = !!process.stdout.isTTY && !process.env["NO_COLOR"];
function accent(s) {
	return IS_COLOR_TTY ? `\x1b[38;5;208m${s}\x1b[0m` : s;
}
function dim(s) {
	return IS_COLOR_TTY ? `\x1b[2m${s}\x1b[22m` : s;
}
function bold(s) {
	return IS_COLOR_TTY ? `\x1b[1m${s}\x1b[22m` : s;
}
function getTerminalWidth() {
	const w = process.stdout.columns;
	return typeof w === "number" && w > 0 ? w : 80;
}
const TAGLINE = "Persistent memory for AI coding agents";
function fullBanner(version) {
	const lines = ["", ...[
		"                        _                                             ",
		"  __ _  __ _  ___ _ __ | |_ _ __ ___   ___ _ __ ___   ___  _ __ _   _ ",
		" / _` |/ _` |/ _ \\ '_ \\| __| '_ ` _ \\ / _ \\ '_ ` _ \\ / _ \\| '__| | | |",
		"| (_| | (_| |  __/ | | | |_| | | | | |  __/ | | | | | (_) | |  | |_| |",
		" \\__,_|\\__, |\\___|_| |_|\\__|_| |_| |_|\\___|_| |_| |_|\\___/|_|   \\__, |",
		"       |___/                                                    |___/ "
	].map((line) => "  " + accent(line))];
	lines.push("");
	lines.push("  " + bold(TAGLINE) + "  " + dim(`v${version}`));
	lines.push("");
	return lines.join("\n");
}
function compactBanner(version) {
	return [
		"",
		"  " + bold(accent("agentmemory")),
		"  " + dim(`v${version} · ${TAGLINE}`),
		""
	].join("\n");
}
function minimalBanner(version) {
	return `${accent("agentmemory")} ${dim(`v${version}`)}`;
}
function renderSplash(version) {
	const width = getTerminalWidth();
	let out;
	if (width >= 120) out = fullBanner(version);
	else if (width >= 80) out = compactBanner(version);
	else out = minimalBanner(version);
	process.stdout.write(out + "\n");
}
//#endregion
//#region src/cli/preferences.ts
const DEFAULTS = {
	schemaVersion: 1,
	lastAgent: null,
	lastAgents: [],
	lastProvider: null,
	skipSplash: false,
	skipNpxHint: false,
	skipGlobalInstall: false,
	firstRunAt: null,
	injectContextChosen: false
};
function prefsDir() {
	return join(homedir(), ".agentmemory");
}
function prefsPath() {
	return join(prefsDir(), "preferences.json");
}
function readPrefs() {
	try {
		if (!existsSync(prefsPath())) return { ...DEFAULTS };
		const raw = readFileSync(prefsPath(), "utf-8");
		const parsed = JSON.parse(raw);
		return {
			...DEFAULTS,
			...parsed,
			schemaVersion: 1
		};
	} catch {
		return { ...DEFAULTS };
	}
}
function writePrefs(p) {
	try {
		mkdirSync(prefsDir(), { recursive: true });
		const next = {
			...readPrefs(),
			...p,
			schemaVersion: 1
		};
		const target = prefsPath();
		const tmp = target + ".tmp";
		const fd = openSync(tmp, "w", 384);
		try {
			writeSync(fd, JSON.stringify(next, null, 2) + "\n");
			try {
				fsyncSync(fd);
			} catch {}
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, target);
	} catch {}
}
function resetPrefs() {
	try {
		unlinkSync(prefsPath());
	} catch {}
}
function isFirstRun() {
	if (!existsSync(prefsPath())) return true;
	return readPrefs().firstRunAt === null;
}
//#endregion
//#region src/cli/onboarding.ts
const __dirname$1 = dirname(fileURLToPath(import.meta.url));
const AGENT_GLYPH = {
	"claude-code": "⟁",
	"copilot-cli": "◈",
	codex: "◎",
	cursor: "◫",
	"gemini-cli": "✦",
	opencode: "⬡"
};
const PROVIDERS = [
	{
		value: "anthropic",
		label: "Anthropic — claude",
		envKey: "ANTHROPIC_API_KEY"
	},
	{
		value: "openai",
		label: "OpenAI — gpt",
		envKey: "OPENAI_API_KEY"
	},
	{
		value: "gemini",
		label: "Google — gemini",
		envKey: "GEMINI_API_KEY"
	},
	{
		value: "openrouter",
		label: "OpenRouter — multi-model",
		envKey: "OPENROUTER_API_KEY"
	},
	{
		value: "minimax",
		label: "MiniMax — MiniMax-M3",
		envKey: "MINIMAX_API_KEY"
	},
	{
		value: "skip",
		label: "Skip — BM25-only mode (no LLM key)",
		envKey: null
	}
];
const PROVIDER_COST_HINTS = {
	anthropic: "rough cost: a fast Haiku-class model keeps compress/consolidate at fractions of a cent per session.",
	openai: "rough cost: a mini-class model keeps compress/consolidate at fractions of a cent per session.",
	gemini: "rough cost: a Flash-class model keeps compress/consolidate at fractions of a cent per session.",
	openrouter: "rough cost: pick a small model; spend tracks your chosen model's per-token price.",
	minimax: "rough cost: scales with the MiniMax model price per token."
};
function buildAgentOptions() {
	const options = ADAPTERS.map((a) => ({
		value: a.name,
		label: `${AGENT_GLYPH[a.name] ?? "◇"} ${a.displayName}`,
		hint: a.category === "native" ? "native plugin" : "MCP server"
	}));
	return [...options.filter((o) => o.hint === "native plugin"), ...options.filter((o) => o.hint === "MCP server")];
}
function getInitialAgentValues(env = process.env) {
	if (env["COPILOT_CLI"] === "1" || env["COPILOT_AGENT_SESSION_ID"]) return ["copilot-cli"];
	return ["claude-code"];
}
function findEnvExample$1() {
	const candidates = [
		join(__dirname$1, "..", "..", ".env.example"),
		join(__dirname$1, "..", ".env.example"),
		join(__dirname$1, ".env.example"),
		join(process.cwd(), ".env.example")
	];
	for (const c of candidates) if (existsSync(c)) return c;
	return null;
}
async function seedEnvFile(provider) {
	const target = join(homedir(), ".agentmemory", ".env");
	await mkdir(dirname(target), { recursive: true });
	const template = findEnvExample$1();
	if (template && !existsSync(target)) try {
		await copyFile(template, target, constants.COPYFILE_EXCL);
	} catch (err) {
		if (err?.code !== "EEXIST") return null;
	}
	else if (!template && !existsSync(target)) {
		const lines = [
			"# agentmemory environment — uncomment what you need",
			"# AGENTMEMORY_URL=http://localhost:3111",
			""
		];
		const envKey = PROVIDERS.find((x) => x.value === provider)?.envKey;
		if (envKey) lines.push(`# ${envKey}=`);
		writeFileSync(target, lines.join("\n"), { mode: 384 });
	}
	return target;
}
function shouldSkipInteractiveOnboarding() {
	const ci = process.env["CI"];
	return process.stdin.isTTY !== true || process.stdout.isTTY !== true || ci !== void 0 && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
}
function writeDefaultOnboardingPrefs() {
	writePrefs({
		lastAgent: null,
		lastAgents: [],
		lastProvider: null,
		skipSplash: true,
		firstRunAt: (/* @__PURE__ */ new Date()).toISOString()
	});
	return {
		agents: [],
		provider: null
	};
}
async function runOnboarding() {
	if (shouldSkipInteractiveOnboarding()) return writeDefaultOnboardingPrefs();
	p.note([
		"Welcome to agentmemory.",
		"",
		"Persistent memory for your AI coding agents. We'll pick which",
		"agents to wire up and which provider (if any) handles compression",
		"and consolidation. Either step can be changed later in ~/.agentmemory/.env."
	].join("\n"), "first-run setup");
	const agentsPicked = await p.multiselect({
		message: "Which agents will use agentmemory? (space to toggle, enter to confirm)",
		options: buildAgentOptions(),
		required: false,
		initialValues: getInitialAgentValues()
	});
	if (p.isCancel(agentsPicked)) {
		p.cancel("Setup cancelled. Re-run any time with: agentmemory --reset");
		process.exit(0);
	}
	if ((agentsPicked ?? []).length > 0) p.note([
		"━ how this works ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
		"All selected agents share the same memory at :3111.",
		"A memory saved by Claude Code is visible to Copilot + Codex + Cursor instantly.",
		"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	].join("\n"));
	const providerPicked = await p.select({
		message: "Which LLM provider should agentmemory use for compress/consolidate?",
		options: PROVIDERS.map(({ value, label }) => ({
			value,
			label
		})),
		initialValue: "anthropic"
	});
	if (p.isCancel(providerPicked)) {
		p.cancel("Setup cancelled. Re-run any time with: agentmemory --reset");
		process.exit(0);
	}
	const provider = providerPicked === "skip" ? null : providerPicked;
	const agents = agentsPicked ?? [];
	if (provider) {
		const hint = PROVIDER_COST_HINTS[provider];
		if (hint) p.log.info(hint);
	}
	const envPath = await seedEnvFile(provider);
	await maybePromptContextInjection(envPath);
	writePrefs({
		lastAgent: agents[0] ?? null,
		lastAgents: agents,
		lastProvider: provider,
		skipSplash: true,
		firstRunAt: (/* @__PURE__ */ new Date()).toISOString()
	});
	const lines = [`✓ Saved preferences to ${join(homedir(), ".agentmemory", "preferences.json")}`];
	if (envPath) lines.push(`✓ Wrote ${envPath} (edit to add your API key)`);
	else lines.push(`! Could not write ~/.agentmemory/.env — run \`agentmemory init\` after this completes.`);
	if (provider) {
		const envKey = PROVIDERS.find((x) => x.value === provider)?.envKey;
		if (envKey) lines.push(`  Uncomment ${envKey}= in that file to enable ${provider}.`);
	} else lines.push("  No provider chosen — agentmemory will run in BM25-only mode.");
	p.note(lines.join("\n"), "ready");
	if (agents.length > 0) await wireSelectedAgents(agents);
	return {
		agents,
		provider
	};
}
function enableInjectContextInEnv(envPath) {
	if (!envPath || !existsSync(envPath)) return false;
	try {
		const current = readFileSync(envPath, "utf-8");
		if (/^\s*AGENTMEMORY_INJECT_CONTEXT\s*=\s*true\b/m.test(current)) return true;
		appendFileSync(envPath, `${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}AGENTMEMORY_INJECT_CONTEXT=true\n`, { mode: 384 });
		return true;
	} catch {
		return false;
	}
}
async function maybePromptContextInjection(envPath) {
	if (readPrefs().injectContextChosen) return;
	const enable = await p.confirm({
		message: "Enable automatic context injection so the agent recalls past sessions without being asked? [y/N]",
		initialValue: false
	});
	if (p.isCancel(enable)) {
		p.cancel("Setup cancelled. Re-run any time with: agentmemory --reset");
		process.exit(0);
	}
	p.log.info("Cost note: injection spends session tokens proportional to tool-call frequency. Default is off.");
	writePrefs({ injectContextChosen: true });
	if (enable === true) if (enableInjectContextInEnv(envPath)) p.log.success("Context injection enabled (AGENTMEMORY_INJECT_CONTEXT=true).");
	else p.log.warn("Could not update ~/.agentmemory/.env. Set AGENTMEMORY_INJECT_CONTEXT=true there to enable it.");
	else p.log.info("Context injection left off. Set AGENTMEMORY_INJECT_CONTEXT=true later to enable.");
}
async function wireSelectedAgents(agents) {
	p.note("Wire selected agents now?", "next step");
	const confirmed = await p.confirm({
		message: "Run `agentmemory connect <agent>` for each selected agent now? [Y/n]",
		initialValue: true
	});
	if (p.isCancel(confirmed) || confirmed === false) {
		const cmds = agents.map((a) => `  agentmemory connect ${a}`);
		p.note(["Wire later with:", ...cmds].join("\n"), "later");
		return;
	}
	const wired = [];
	const manual = [];
	const failed = [];
	for (const name of agents) {
		const adapter = resolveAdapter(name);
		if (!adapter) {
			failed.push({
				name,
				reason: "no adapter available"
			});
			p.log.warn(`Wiring ${name}… no adapter available (skipped).`);
			continue;
		}
		p.log.step(`Wiring ${name}...`);
		let result;
		try {
			result = await runAdapter(adapter, {
				dryRun: false,
				force: false
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			failed.push({
				name,
				reason
			});
			p.log.error(`${name}: ${reason}`);
			continue;
		}
		switch (result.kind) {
			case "installed":
			case "already-wired":
				wired.push(name);
				break;
			case "stub":
				manual.push({
					name,
					docs: adapter.docs
				});
				break;
			case "skipped":
				failed.push({
					name,
					reason: result.reason
				});
				break;
		}
	}
	const summary = [];
	if (wired.length > 0) summary.push(`Wired: ${wired.join(", ")}.`);
	if (manual.length > 0 || failed.length > 0) {
		const parts = [];
		for (const m of manual) parts.push(`${m.name} (manual install required${m.docs ? ` — see ${m.docs}` : ""})`);
		for (const f of failed) parts.push(`${f.name} (${f.reason})`);
		summary.push(`Skipped/failed: ${parts.join(", ")}.`);
	}
	if (summary.length === 0) summary.push("No agents were wired.");
	p.note(summary.join("\n"), "wire summary");
}
//#endregion
//#region src/cli/capture.ts
function headers(secret) {
	const h = { "Content-Type": "application/json" };
	if (secret) h["Authorization"] = `Bearer ${secret}`;
	return h;
}
function classify(status) {
	if (status === 200) return "duplicate";
	if (status >= 200 && status < 300) return "delivered";
	if (status === 408 || status === 429 || status >= 500) return "retry";
	return "rejected";
}
async function serverCapture(base, secret) {
	try {
		const res = await fetch(`${base}/agentmemory/capture?limit=20`, {
			headers: headers(secret),
			signal: AbortSignal.timeout(5e3)
		});
		if (!res.ok) return { error: `HTTP ${res.status}` };
		return await res.json();
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
async function runCaptureCommand(options) {
	const log = options.log ?? ((line) => console.log(line));
	const json = options.args.includes("--json");
	const drain = options.args.includes("--drain");
	const output = {};
	if (drain) output["drain"] = await drainSpool(options.base, async (record) => {
		const res = await fetch(`${options.base}/agentmemory/observe`, {
			method: "POST",
			headers: headers(options.secret),
			body: JSON.stringify({
				...record.body,
				eventId: record.eventId
			}),
			signal: AbortSignal.timeout(1e4)
		});
		const text = await res.text().catch(() => "");
		const outcome = classify(res.status);
		if (outcome === "delivered" || outcome === "duplicate") {
			let mark = null;
			try {
				mark = parseSentMark(JSON.parse(text));
			} catch {}
			if (mark) retainSent(options.base, record.eventId, record.body, mark);
		}
		return outcome;
	});
	output["spool"] = spoolSummary(options.base);
	output["server"] = await serverCapture(options.base, options.secret);
	if (json) {
		log(JSON.stringify(output, null, 2));
		return 0;
	}
	const spool = output["spool"];
	if (drain) {
		const d = output["drain"];
		log(d.skipped ? `Drain skipped: ${d.skipped === "locked" ? "another drain is running" : "nothing to send"}` : `Drained ${d.claimed}: ${d.delivered} stored, ${d.duplicates} already stored, ${d.rejected} rejected, ${d.expired} expired, ${d.remaining} still waiting${d.error ? ` (${d.error})` : ""}`);
	}
	log(`Local spool: ${spool.enabled ? `${spool.records} waiting, ${spool.bytes} bytes` : "off (AGENTMEMORY_CAPTURE_SPOOL=false)"}`);
	log(`  file: ${spool.path}`);
	log(`  limits: ${spool.maxBytes} bytes, ${spool.maxAgeHours} h`);
	log(`  totals: ${spool.stats.spooled} spooled, ${spool.stats.delivered} delivered, ${spool.stats.duplicates} duplicates, ${spool.stats.dropped} dropped, ${spool.stats.expired} expired`);
	if (spool.stats.lastDrainAt) log(`  last drain: ${spool.stats.lastDrainAt}`);
	if (spool.stats.lastDropAt) log(`  last drop: ${spool.stats.lastDropAt} (${spool.stats.lastDropReason ?? "unknown"})`);
	const server = output["server"];
	if (server.error) {
		log(`Server: unreachable at ${options.base} (${server.error})`);
		return 0;
	}
	const inbox = server.capture?.inbox;
	log(`Server inbox: ${inbox ? `${inbox.pending} pending, ${inbox.retrying} retrying, ${inbox.dead} dead letters` : "unknown"}`);
	if (inbox?.lastError) log(`  last error: ${inbox.lastError}`);
	for (const item of server.items ?? []) log(`  ${item.status.padEnd(8)} ${item.eventId} attempts=${item.attempts} ${item.preview ?? ""}`);
	if (inbox && inbox.dead > 0) log(`Retry dead letters: curl -X POST ${options.base}/agentmemory/capture/retry ${CURL_AUTH_HEADER} -H "Content-Type: application/json" -d '{"all":true}'`);
	return 0;
}
//#endregion
//#region src/cli/compression.ts
async function runCompressionCommand(options) {
	const log = options.log ?? console.log;
	const json = options.args.includes("--json");
	try {
		const input = {};
		let retry = false;
		let dryRun = false;
		const valueFlags = {
			"--session": "sessionId",
			"--project": "project",
			"--agent-id": "agentId",
			"--limit": "limit",
			"--cursor": "cursor"
		};
		for (let i = 0; i < options.args.length; i++) {
			const flag = options.args[i];
			if (flag === "--json") continue;
			if (flag === "--retry") {
				retry = true;
				continue;
			}
			if (flag === "--dry-run") {
				dryRun = true;
				continue;
			}
			if (flag.startsWith("--port=") || flag.startsWith("--instance=")) {
				if (!flag.slice(flag.indexOf("=") + 1)) throw new Error(`Missing value for ${flag.split("=")[0]}`);
				continue;
			}
			if (flag === "--port" || flag === "--instance") {
				if (!options.args[++i] || options.args[i].startsWith("--")) throw new Error(`Missing value for ${flag}`);
				continue;
			}
			const name = valueFlags[flag];
			if (!name) throw new Error(`Unknown compression option: ${flag}`);
			if (input[name] !== void 0) throw new Error(`Duplicate option: ${flag}`);
			const value = options.args[++i];
			if (value === void 0 || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
			input[name] = value;
		}
		if (retry && dryRun) throw new Error("Use either --retry or --dry-run");
		const scope = parseCompressionScope(input);
		const headers = { "Content-Type": "application/json" };
		if (options.secret) headers.Authorization = `Bearer ${options.secret}`;
		const query = new URLSearchParams(Object.entries(scope).filter(([, value]) => value !== void 0).map(([key, value]) => [key, String(value)]));
		const response = await fetch(`${options.base}/agentmemory/compression${retry ? "/retry" : `?${query}`}`, {
			method: retry ? "POST" : "GET",
			headers,
			...retry ? { body: JSON.stringify(scope) } : {},
			signal: AbortSignal.timeout(retry ? 12e4 : 1e4)
		});
		if (!response.ok) throw new Error(`Compression endpoint returned HTTP ${response.status}`);
		const result = await response.json();
		if (typeof result.success !== "boolean" || !Array.isArray(result.items)) throw new Error("Invalid compression response");
		if (json) log(JSON.stringify(result, null, 2));
		else {
			log(retry ? `Compression: ${result.recovered ?? 0} recovered, ${result.failed ?? 0} failed, ${result.attempted ?? 0} attempted` : `Compression: ${result.items.length} pending or failed observations (inspection only)`);
			if (result.error === "cursor_stale") log("Compression cursor changed. Restart without --cursor.");
			for (const item of result.items) log(`${item.sessionId}/${item.observationId}: ${item.outcome ?? item.status}${item.error ? ` (${item.error})` : ""}${item.error === "source_unavailable" ? " [source unavailable]" : ""}`);
			if (result.nextCursor) log(`Continue with --cursor ${result.nextCursor}`);
			if (!retry && result.items.some((item) => item.retryable)) log("Use --retry to send retained, privacy-filtered source to the configured model. Model usage may incur costs.");
		}
		return result.success ? 0 : 1;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Compression request failed";
		log(json ? JSON.stringify({
			success: false,
			error: message
		}) : `Compression: ${message}`);
		return 1;
	}
}
//#endregion
//#region src/cli/graph-index.ts
const VALUE_FLAGS = new Set([
	"--port",
	"--instance",
	"--data-dir",
	"--tools"
]);
async function runGraphIndexCommand(options) {
	const log = options.log ?? console.log;
	const json = options.args.includes("--json");
	const output = (value) => {
		if (json) {
			log(JSON.stringify(value, null, 2));
			return;
		}
		if (value.error) {
			log(String(value.error));
			return;
		}
		log(`Graph index: ${value.state ?? "unknown"}`);
		if (value.jobId) log(`Job: ${value.jobId}, processed ${value.processed ?? 0} of ${value.total ?? "unknown"}`);
		if (value.action) log(String(value.action));
	};
	let command;
	let allowLegacyScan = false;
	try {
		for (let i = 0; i < options.args.length; i++) {
			const arg = options.args[i];
			if (arg === "--json") continue;
			if (arg === "--allow-legacy-scan") {
				allowLegacyScan = true;
				continue;
			}
			if (VALUE_FLAGS.has(arg)) {
				if (!options.args[++i] || options.args[i].startsWith("--")) throw new Error(`Missing value for ${arg}`);
				continue;
			}
			if ([...VALUE_FLAGS].some((flag) => arg.startsWith(`${flag}=`) && arg.length > flag.length + 1)) continue;
			if (arg === "--verbose" || arg === "-v") continue;
			if (!command && [
				"status",
				"migrate",
				"resume"
			].includes(arg)) {
				command = arg;
				continue;
			}
			throw new Error(`Unknown graph-index argument: ${arg}`);
		}
		command ??= "status";
		if (command === "status" && allowLegacyScan) throw new Error("status does not accept --allow-legacy-scan");
		if (command === "migrate" && !allowLegacyScan) throw new Error("Migration requires --allow-legacy-scan. Initial discovery reads each complete legacy graph scope and can use substantial memory; run it during maintenance.");
	} catch (error) {
		output({ error: error instanceof Error ? error.message : String(error) });
		return 2;
	}
	try {
		const headers = { Accept: "application/json" };
		if (options.secret) headers.Authorization = `Bearer ${options.secret}`;
		if (command !== "status") headers["Content-Type"] = "application/json";
		const response = await fetch(`${options.base}/agentmemory/graph/index${command === "status" ? "" : `/${command}`}`, {
			method: command === "status" ? "GET" : "POST",
			headers,
			...command === "status" ? {} : { body: JSON.stringify({ allowLegacyScan }) },
			signal: AbortSignal.timeout(1e4)
		});
		const value = await response.json();
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Server returned an invalid graph-index response");
		output({
			...value,
			...!response.ok ? { httpStatus: response.status } : {}
		});
		return response.ok ? 0 : 1;
	} catch (error) {
		output({ error: error instanceof Error ? error.message : String(error) });
		return 1;
	}
}
//#endregion
//#region src/cli.ts
const c = {
	url: pc.cyan,
	ok: pc.green,
	warn: pc.yellow,
	err: pc.red,
	cmd: (s) => pc.bold(pc.cyan(s)),
	label: pc.bold,
	dim: pc.dim,
	accent: (s) => pc.bold(pc.yellow(s))
};
const ALL_TOOLS_COUNT = getAllTools().length;
const CORE_TOOLS_COUNT = getAllTools().filter((t) => ESSENTIAL_TOOLS.has(t.name)).length;
const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const IS_WINDOWS = platform() === "win32";
const IS_VERBOSE = args.includes("--verbose") || args.includes("-v") || process.env["AGENTMEMORY_VERBOSE"] === "1" || process.env["AGENTMEMORY_VERBOSE"] === "true";
setBootVerbose(IS_VERBOSE);
const IS_RESET = args.includes("--reset");
hydrateProcessEnvFromFile();
if (args.includes("--version") || args.includes("-V")) {
	process.stdout.write(`${VERSION}\n`);
	process.exit(0);
}
const IIPINNED_DEFAULT_VERSION = III_PINNED_VERSION;
const IIPINNED_VERSION = process.env["AGENTMEMORY_III_VERSION"] || IIPINNED_DEFAULT_VERSION;
const IIIENGINE_INSTALL_CMD = `curl -fsSL https://install.iii.dev/iii/main/install.sh | VERSION=${IIPINNED_VERSION} sh`;
function iiiReleaseAsset() {
	const p = platform();
	const a = process.arch;
	if (p === "darwin" && a === "arm64") return "iii-aarch64-apple-darwin.tar.gz";
	if (p === "darwin" && a === "x64") return "iii-x86_64-apple-darwin.tar.gz";
	if (p === "linux" && a === "x64") return "iii-x86_64-unknown-linux-gnu.tar.gz";
	if (p === "linux" && a === "arm64") return "iii-aarch64-unknown-linux-gnu.tar.gz";
	if (p === "linux" && a === "arm") return "iii-armv7-unknown-linux-gnueabihf.tar.gz";
	if (p === "win32" && a === "x64") return "iii-x86_64-pc-windows-msvc.zip";
	if (p === "win32" && a === "arm64") return "iii-aarch64-pc-windows-msvc.zip";
	return null;
}
function iiiReleaseUrl() {
	const asset = iiiReleaseAsset();
	if (!asset) return null;
	return `https://github.com/iii-hq/iii/releases/download/iii/v${IIPINNED_VERSION}/${asset}`;
}
function vlog(msg) {
	if (IS_VERBOSE) p.log.info(`[verbose] ${msg}`);
}
function wrapList(items, indent, width = 78) {
	const lines = [];
	let line = "";
	for (const item of items) {
		const joined = line ? `${line}, ${item}` : item;
		if (line && indent + joined.length > width) {
			lines.push(`${line},`);
			line = item;
		} else line = joined;
	}
	lines.push(line);
	return lines.join(`\n${" ".repeat(indent)}`);
}
if (args.includes("--help") || args.includes("-h")) {
	console.log(`
agentmemory — persistent memory for AI coding agents

Usage: agentmemory [command] [options]

Commands:
  (default)          Start agentmemory worker
  init               Copy bundled .env.example to ~/.agentmemory/.env if absent
  connect [agent]    Wire agentmemory into an installed agent
                     (${wrapList(knownAgents(), 21)}).
                     No arg = interactive picker. --all wires every detected agent.
                     --dry-run shows what would change. --force re-installs.
  status             Show connection status, memory count, flags, and health
  console            Launch the iii web console for this engine (workers, functions,
                     triggers, queues, traces). --console-port N, default viewer+1
  doctor             Interactive diagnostic + fixer. [F]ix · [S]kip · [?]more · [Q]uit
                     --all: apply every fix without prompting (CI)
                     --dry-run: show what each fix would do, don't execute
  remove             Cleanly uninstall agentmemory (pidfile, state, .env, binaries).
                     --force: skip confirmations · --keep-data: keep memory data
  demo [--serve]     Seed sample sessions and show recall in action.
                     --serve boots the server, runs the demo, and stops it
                     in one command (no second terminal).
  upgrade            Upgrade local deps + iii runtime (best effort)
  stop [--force]     Stop the running iii-engine started by this CLI.
                     --force bypasses the Docker-heuristic guard and signals
                     whatever pidfile+lsof report on the REST port (use when
                     the engine was started natively but state file is missing).
  mcp                Start standalone MCP shim — opt-in surface for MCP-only clients
                     (Cursor, Gemini CLI, etc). REST always available at :3111.
  capture [--drain]  Show capture health: the local offline spool and the server
                     inbox (pending, retrying, dead letters). --drain sends
                     spooled observations now. --json for machine output.
  compression        Inspect pending or failed observation compression.
                     --session <id> or --project <name> selects the scope.
                     --agent-id <id> narrows it; --limit <N> bounds the batch.
                     --retry explicitly retries compression; --json for machine output.
  graph-index       Inspect bounded graph index status. --json for machine output.
                     migrate --allow-legacy-scan explicitly scans legacy graph data.
                     resume continues a sealed migration without another full scan.
  import-jsonl [p]   Import Claude Code JSONL transcripts (default: ~/.claude/projects)
                     --max-files <N> | --max-files=<N>: override scan cap (default 200, max 1000;
                     out-of-range is rejected; for trees >1000 files, batch by subdirectory)

Options:
  --help, -h         Show this help
  --verbose, -v      Show engine stderr, boot log, and diagnostic info
  --reset            Wipe ~/.agentmemory/preferences.json and re-run onboarding
  --tools all|core   Tool visibility (default: all = ${ALL_TOOLS_COUNT} tools; core = ${CORE_TOOLS_COUNT} essentials)
  --no-engine        Skip auto-starting iii-engine
  --port <N>         Override REST port (default: 3111). Streams (N+1), viewer
                     (N+2), and iii engine (N+46023) auto-derive from N so a
                     single flag relocates the whole quartet.
  --instance <N>     Shortcut for --port (3111 + N*100) to run multiple
                     daemons side-by-side without env gymnastics.
                     --instance 1 -> 3211/3212/3213/49234, etc. (max N=50)
  --data-dir <path>  Store iii-engine state outside the current repo

Environment:
  AGENTMEMORY_URL              Full REST base URL (e.g. http://localhost:3111).
                               Honored by status, doctor, and MCP shim commands.
  AGENTMEMORY_DATA_DIR         State directory fallback when --data-dir is not set.
  AGENTMEMORY_USE_DOCKER=1     Prefer the bundled docker-compose path over the
                               native iii-engine binary on first run.
  AGENTMEMORY_III_VERSION      Override pinned iii-engine version (default ${IIPINNED_VERSION}).
  AGENTMEMORY_III_CONFIG       Engine config to start from (default: ./iii-config.yaml,
                               then ~/.agentmemory/iii-config.yaml, then the bundled
                               loopback-only config).
  AGENTMEMORY_ENGINE_READY_TIMEOUT_MS
                               Engine readiness deadline in milliseconds (default 120000).
  AGENTMEMORY_READY_TIMEOUT_MS
                               Worker readiness deadline in milliseconds (default 300000).
                               Both deadlines accept integers from 1 through 3600000.
  AGENTMEMORY_ENGINE_MANAGES_WORKER
                               true for custom engine-managed worker wrappers; false
                               for CLI-managed workers. Unset detects direct worker commands.
  AGENTMEMORY_FOLLOWUP_WINDOW_SECONDS
                               Window (seconds) for the smart-search follow-up diagnostic
                               (default 30). Long values overcount, short values undercount.

Quick start:
  npx @agentmemory/agentmemory          # start with local iii-engine or Docker
  npx @agentmemory/agentmemory demo     # see semantic recall in 30 seconds
  npx @agentmemory/agentmemory doctor   # diagnose config + feature flags
  npx @agentmemory/agentmemory status   # health + memory count + flags
  npx @agentmemory/agentmemory upgrade  # upgrade agentmemory + iii runtime
  npx @agentmemory/agentmemory mcp      # standalone MCP server (no engine)
  npx @agentmemory/mcp                  # same as above (shim package)
`);
	process.exit(0);
}
const toolsIdx = args.indexOf("--tools");
if (toolsIdx !== -1 && args[toolsIdx + 1]) {
	const toolsMode = args[toolsIdx + 1];
	if (toolsMode !== "all" && toolsMode !== "core") p.log.warn(`Unknown --tools value "${toolsMode}" (valid: all, core); falling back to all.`);
	process.env["AGENTMEMORY_TOOLS"] = toolsMode;
}
const URL_CLIENT_COMMANDS = new Set([
	"status",
	"doctor",
	"mcp",
	"capture",
	"compression",
	"graph-index"
]);
let hasExplicitLocalPortOverride = false;
let selectedInstance = 0;
function cliArgValue(name) {
	const inline = args.find((arg) => arg.startsWith(`${name}=`));
	if (inline) return inline.slice(name.length + 1);
	const index = args.indexOf(name);
	return index === -1 ? void 0 : args[index + 1];
}
const portValue = cliArgValue("--port");
if (portValue) {
	process.env["III_REST_PORT"] = portValue;
	hasExplicitLocalPortOverride = true;
}
const instanceValue = cliArgValue("--instance");
if (args.some((arg) => arg === "--instance" || arg.startsWith("--instance="))) {
	if (instanceValue === void 0 || !/^\d+$/.test(instanceValue)) {
		p.log.error("--instance must be an integer between 0 and 50.");
		process.exit(1);
	}
	const n = Number(instanceValue);
	if (!Number.isInteger(n) || n > 50) {
		p.log.error("--instance must be an integer between 0 and 50.");
		process.exit(1);
	}
	selectedInstance = n;
	const base = 3111 + n * 100;
	if (!hasExplicitLocalPortOverride) process.env["III_REST_PORT"] = String(base);
	hasExplicitLocalPortOverride = true;
}
const restPort = parseInt(process.env["III_REST_PORT"] || "3111", 10);
if (Number.isFinite(restPort) && restPort > 0) {
	process.env["III_STREAM_PORT"] ??= process.env["III_STREAMS_PORT"] ?? String(restPort + 1);
	process.env["III_VIEWER_PORT"] ??= String(restPort + 2);
	const configuredEngineUrl = process.env["III_ENGINE_URL"];
	if (configuredEngineUrl) try {
		const parsedEnginePort = new URL(configuredEngineUrl).port;
		if (parsedEnginePort) process.env["III_ENGINE_PORT"] = parsedEnginePort;
	} catch {}
	else process.env["III_ENGINE_PORT"] ??= String(restPort + 46023);
	process.env["AGENTMEMORY_METRICS_PORT"] ??= String(restPort + 6353);
}
const dataDirResolution = resolveDataDir({ args });
process.env["AGENTMEMORY_DATA_DIR"] = dataDirResolution.dataDir;
process.env["AGENTMEMORY_RUNTIME_DIR"] = selectedInstance > 0 ? dataDirResolution.dataDir : join(homedir(), ".agentmemory");
const skipEngine = args.includes("--no-engine");
function shouldUseAgentmemoryUrl() {
	return !hasExplicitLocalPortOverride && URL_CLIENT_COMMANDS.has(args[0] ?? "");
}
function getRestPort() {
	const url = shouldUseAgentmemoryUrl() ? process.env["AGENTMEMORY_URL"] : void 0;
	if (url) try {
		const parsed = new URL(url).port;
		if (parsed) return parseInt(parsed, 10);
	} catch {}
	return parseInt(process.env["III_REST_PORT"] || "3111", 10) || 3111;
}
function getBaseUrl() {
	const url = shouldUseAgentmemoryUrl() ? process.env["AGENTMEMORY_URL"] : void 0;
	if (url) return url.replace(/\/+$/, "");
	return `http://localhost:${getRestPort()}`;
}
function getConfiguredViewerPort() {
	return parseInt(process.env["III_VIEWER_PORT"] || "", 10) || getRestPort() + 2;
}
let discoveredViewerPort = null;
async function discoverViewerPort() {
	if (discoveredViewerPort !== null) return;
	try {
		const res = await fetch(`${getBaseUrl()}/agentmemory/livez`, { signal: AbortSignal.timeout(1e3) });
		if (res.ok) {
			const data = await res.json();
			if (typeof data.viewerPort === "number") discoveredViewerPort = data.viewerPort;
		}
	} catch {}
}
function getViewerUrl() {
	const envUrl = process.env["AGENTMEMORY_VIEWER_URL"];
	if (envUrl) return envUrl.replace(/\/+$/, "");
	if (discoveredViewerPort !== null) try {
		const u = new URL(getBaseUrl());
		return `${u.protocol}//${u.hostname}:${discoveredViewerPort}`;
	} catch {
		return `http://localhost:${discoveredViewerPort}`;
	}
	try {
		const u = new URL(getBaseUrl());
		const vPort = getConfiguredViewerPort();
		return `${u.protocol}//${u.hostname}:${vPort}`;
	} catch {
		return `http://localhost:${getConfiguredViewerPort()}`;
	}
}
function getStreamPort() {
	return parseInt(process.env["III_STREAM_PORT"] || "", 10) || parseInt(process.env["III_STREAMS_PORT"] || "", 10) || getRestPort() + 1;
}
function getEnginePort() {
	const url = process.env["III_ENGINE_URL"];
	if (url) try {
		const parsed = new URL(url).port;
		if (parsed) return parseInt(parsed, 10);
	} catch {}
	const explicit = parseInt(process.env["III_ENGINE_PORT"] || "", 10);
	if (explicit) return explicit;
	return getRestPort() + 46023;
}
async function isEngineRunning() {
	const result = await withinStartupDeadline(startupDeadline(2e3), (signal) => probeEngine(getBaseUrl(), signal)).catch(() => null);
	return result?.completed === true && result.value;
}
async function isAgentmemoryReady() {
	const result = await withinStartupDeadline(startupDeadline(2e3), workerReadinessProbe).catch(() => null);
	return result?.completed === true && result.value;
}
function workerReadinessProbe(signal) {
	return probeWorker(getBaseUrl(), signal, (port) => {
		discoveredViewerPort = port;
	});
}
function findIiiConfig() {
	const envPath = process.env["AGENTMEMORY_III_CONFIG"];
	const candidates = [
		...envPath ? [envPath] : [],
		join(process.cwd(), "iii-config.yaml"),
		join(homedir(), ".agentmemory", "iii-config.yaml"),
		join(__dirname, "iii-config.yaml"),
		join(__dirname, "..", "iii-config.yaml")
	];
	for (const c of candidates) if (existsSync(c)) return resolve(c);
	return "";
}
function warnIfRelocatedDataDir() {
	if (!dataDirResolution.relocatedFrom) return;
	try {
		mkdirSync(dataDirResolution.dataDir, { recursive: true });
		const marker = join(dataDirResolution.dataDir, ".cwd-relocation-warning");
		if (existsSync(marker)) return;
		p.log.warn(`Default data dir ${dataDirResolution.relocatedFrom} is inside a git worktree; using ${dataDirResolution.dataDir} instead.`);
		writeFileSync(marker, (/* @__PURE__ */ new Date()).toISOString());
	} catch {
		p.log.warn(`Default data dir ${dataDirResolution.relocatedFrom} is inside a git worktree; using ${dataDirResolution.dataDir} instead.`);
	}
}
function whichBinary(name) {
	const cmd = IS_WINDOWS ? "where" : "which";
	try {
		return execFileSync(cmd, [name], {
			encoding: "utf-8",
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		}).split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? null;
	} catch {
		return null;
	}
}
function agentmemoryBinDir() {
	if (IS_WINDOWS) {
		const userProfile = process.env["USERPROFILE"];
		if (!userProfile) return join(homedir(), ".agentmemory", "bin");
		return join(userProfile, ".agentmemory", "bin");
	}
	return join(homedir(), ".agentmemory", "bin");
}
function privateIiiPath() {
	return join(agentmemoryBinDir(), IS_WINDOWS ? "iii.exe" : "iii");
}
function fallbackIiiPaths() {
	if (IS_WINDOWS) {
		const userProfile = process.env["USERPROFILE"];
		const paths = [privateIiiPath()];
		if (userProfile) paths.push(join(userProfile, ".local", "bin", "iii.exe"), join(userProfile, "bin", "iii.exe"));
		return paths;
	}
	const home = process.env["HOME"];
	const paths = [privateIiiPath()];
	if (home) paths.push(join(home, ".local", "bin", "iii"));
	paths.push("/usr/local/bin/iii");
	return paths;
}
function iiiBinVersion(binPath) {
	try {
		const match = execFileSync(binPath, ["--version"], {
			encoding: "utf-8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 3e3
		}).match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}
function resolveCompatibleIii(iiiBinPath) {
	if (!iiiBinPath) return null;
	const detected = iiiBinVersion(iiiBinPath);
	if (detected && detected === IIPINNED_VERSION) return iiiBinPath;
	const privatePath = privateIiiPath();
	if (iiiBinPath !== privatePath && existsSync(privatePath)) {
		if (iiiBinVersion(privatePath) === IIPINNED_VERSION) {
			vlog(`iii at ${iiiBinPath} ${detected ? `v${detected} mismatches pin` : "probe failed"} v${IIPINNED_VERSION}; using private install at ${privatePath}.`);
			return privatePath;
		}
	}
	return null;
}
function enginePidfilePath() {
	return runtimeMetadataPath("iii.pid");
}
function engineStatePath() {
	return runtimeMetadataPath("engine-state.json");
}
function writeEnginePidfile(pid) {
	try {
		const pidPath = enginePidfilePath();
		mkdirSync(dirname(pidPath), { recursive: true });
		writeFileSync(pidPath, `${pid}\n`, { encoding: "utf-8" });
	} catch (err) {
		vlog(`writeEnginePidfile: ${err instanceof Error ? err.message : String(err)}`);
	}
}
function readEnginePidfile() {
	try {
		const pidStr = readFileSync(enginePidfilePath(), "utf-8").trim();
		const pid = parseInt(pidStr, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}
function clearEnginePidfile() {
	try {
		unlinkSync(enginePidfilePath());
	} catch {}
}
function workerPidfilePath() {
	return runtimeMetadataPath("worker.pid");
}
function readWorkerPidfile() {
	try {
		const pidStr = readFileSync(workerPidfilePath(), "utf-8").trim();
		const pid = parseInt(pidStr, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}
function clearWorkerPidfile() {
	try {
		unlinkSync(workerPidfilePath());
	} catch {}
}
function writeEngineState(state) {
	try {
		const statePath = engineStatePath();
		mkdirSync(dirname(statePath), { recursive: true });
		const normalized = state.kind === "docker" && state.schemaVersion === 2 ? {
			...state,
			restPort: state.restPort ?? getRestPort(),
			dataDir: state.dataDir ?? dataDirResolution.dataDir
		} : {
			...state,
			restPort: state.restPort ?? getRestPort()
		};
		writeFileSync(statePath, `${JSON.stringify(normalized)}\n`, { encoding: "utf-8" });
	} catch (err) {
		vlog(`writeEngineState: ${err instanceof Error ? err.message : String(err)}`);
	}
}
function readEngineState() {
	try {
		const raw = readFileSync(engineStatePath(), "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && (parsed.kind === "native" || parsed.kind === "docker")) return parsed;
		return null;
	} catch {
		return null;
	}
}
function clearEngineState() {
	try {
		unlinkSync(engineStatePath());
	} catch {}
}
function engineStateRestPort(state) {
	if (state.restPort && Number.isFinite(state.restPort)) return state.restPort;
	if (state.kind === "docker") {
		const projectPort = state.projectName?.match(/^agentmemory-(\d+)$/)?.[1];
		if (projectPort) return parseInt(projectPort, 10);
		return 3111;
	}
	try {
		const configuredPort = (readFileSync(state.configPath, "utf-8").match(/- name:\s*(?:iii-)?http([\s\S]*?)(?=\n\s*- name:|$)/)?.[1])?.match(/\n\s*port:\s*(\d+)/)?.[1];
		if (configuredPort) return parseInt(configuredPort, 10);
	} catch {}
	return 3111;
}
async function startWorkerForEngineState(background = false) {
	const timeoutMs = startupTimeouts().workerMs;
	startupWorkerFailure = null;
	if (!await startWorkerAndWait({
		timeoutMs,
		hasLiveWorker: () => {
			const workerPid = readWorkerPidfile();
			return Boolean(workerPid && pidAlive(workerPid));
		},
		engineStartsWorker: configuredEngineMayStartWorker,
		startWorker: async () => {
			if (background) {
				const builtEntry = join(__dirname, "index.mjs");
				const workerArgs = existsSync(builtEntry) ? [builtEntry] : [
					"--import",
					"tsx",
					join(__dirname, "index.ts")
				];
				const child = spawn(process.execPath, workerArgs, {
					detached: true,
					stdio: "ignore",
					windowsHide: true,
					env: { ...process.env }
				});
				spawnedStartupWorker = child;
				child.on("error", (error) => {
					if (spawnedStartupWorker === child) startupWorkerFailure = error;
				});
				child.on("exit", (code, signal) => {
					if (spawnedStartupWorker === child) startupWorkerFailure = /* @__PURE__ */ new Error(`agentmemory worker exited during startup (${signal ?? code}).`);
				});
				child.unref();
			} else {
				importedStartupWorker = true;
				await import("./src-DBZ2n_Kw.mjs");
			}
		},
		probe: workerReadinessProbe,
		stopped: () => startupInterrupted || engineStartupFailed() || startupWorkerFailure !== null
	})) {
		if (startupWorkerFailure) throw startupWorkerFailure;
		if (engineStartupFailed()) throw new Error("iii-engine exited before the agentmemory worker became ready.");
		throw new Error(startupTimeoutMessage("worker", timeoutMs));
	}
	finishStartup();
}
function configuredEngineMayStartWorker() {
	const explicit = startupTimeouts().engineManagesWorker;
	if (explicit !== void 0) return explicit;
	const state = readEngineState();
	if (state?.kind !== "native" || state.attached) return false;
	try {
		return configStartsAgentmemoryWorker(readFileSync(state.configPath, "utf-8"), join(__dirname, "index.mjs"), state.cwd);
	} catch {
		return false;
	}
}
function discoverComposeFile() {
	return [
		join(__dirname, "..", "docker-compose.yml"),
		join(__dirname, "docker-compose.yml"),
		join(process.cwd(), "docker-compose.yml")
	].find((c) => existsSync(c)) ?? null;
}
function sameDockerMountSource(type, left, right) {
	return type === "bind" ? resolve(left) === resolve(right) : left === right;
}
function inspectDockerContainer(dockerBin, containerId, state, ownerPort) {
	const result = spawnSync(dockerBin, ["inspect", containerId], {
		encoding: "utf-8",
		stdio: [
			"ignore",
			"pipe",
			"ignore"
		],
		maxBuffer: 1024 * 1024,
		timeout: 5e3,
		killSignal: "SIGKILL"
	});
	if (result.status !== 0) return {
		status: "unavailable",
		reason: `docker inspect failed for ${containerId}`
	};
	let record;
	try {
		record = JSON.parse(result.stdout)[0] ?? {};
	} catch {
		return {
			status: "unavailable",
			reason: `docker inspect returned invalid JSON for ${containerId}`
		};
	}
	const image = record.Config?.Image ?? "";
	const expectedImage = `iiidev/iii:${state.engineVersion ?? IIPINNED_VERSION}`;
	if (image !== expectedImage) return {
		status: "unavailable",
		reason: `saved container uses ${image || "an unknown image"}, expected ${expectedImage}`
	};
	const labels = record.Config?.Labels ?? {};
	const projectName = labels["com.docker.compose.project"] ?? "";
	if (labels["com.docker.compose.service"] !== "iii-engine" || !projectName) return {
		status: "unavailable",
		reason: "saved container is not the iii-engine service of a Compose project"
	};
	if (state.projectName && state.projectName !== projectName) return {
		status: "unavailable",
		reason: `saved Docker project ${state.projectName} does not match container project ${projectName}`
	};
	if (state.schemaVersion === 2 && projectName !== dockerProjectName(ownerPort)) return {
		status: "unavailable",
		reason: `Docker project ${projectName} does not match REST port ${ownerPort}`
	};
	if (!(record.HostConfig?.PortBindings?.[`${ownerPort}/tcp`] ?? []).some((binding) => binding.HostPort === String(ownerPort))) return {
		status: "unavailable",
		reason: `saved container does not publish REST port ${ownerPort}`
	};
	const dataMount = record.Mounts?.find((mount) => mount.Destination === "/data");
	const dataMountType = dataMount?.Type;
	const dataMountSource = dataMountType === "volume" ? dataMount?.Name ?? dataMount?.Source ?? "" : dataMount?.Source ?? "";
	if (dataMountType !== "bind" && dataMountType !== "volume" || !dataMountSource) return {
		status: "unavailable",
		reason: "saved container has no verifiable /data bind or volume mount"
	};
	if (state.dataMountType && state.dataMountType !== dataMountType) return {
		status: "unavailable",
		reason: `saved /data mount type ${state.dataMountType} changed to ${dataMountType}`
	};
	if (state.dataMountSource && !sameDockerMountSource(dataMountType, state.dataMountSource, dataMountSource)) return {
		status: "unavailable",
		reason: "saved container /data mount source changed"
	};
	if (!state.dataMountSource) {
		if (dataMountType === "bind" && resolve(dataMountSource) !== resolve(dataDirResolution.dataDir)) return {
			status: "unavailable",
			reason: `container /data bind ${dataMountSource} does not match ${dataDirResolution.dataDir}`
		};
		if (dataMountType === "volume" && dataDirResolution.source !== "default") return {
			status: "unavailable",
			reason: "legacy container uses a named volume but this invocation selects an explicit data directory"
		};
	}
	if (state.dataDir && resolve(state.dataDir) !== resolve(dataDirResolution.dataDir)) return {
		status: "unavailable",
		reason: `saved data directory ${state.dataDir} does not match ${dataDirResolution.dataDir}`
	};
	return {
		status: record.State?.Running ? "running" : "stopped",
		composeFile: existsSync(state.composeFile) ? state.composeFile : discoverComposeFile() ?? state.composeFile,
		projectName,
		containerId: record.Id ?? containerId,
		dataMountType,
		dataMountSource,
		preserveContainer: state.preserveContainer === true || state.schemaVersion !== 2 && dataMountType === "volume"
	};
}
function inspectOwnedDockerEngine(state) {
	if (state.kind !== "docker") return {
		status: "unavailable",
		reason: "engine state is not Docker"
	};
	const ownerPort = engineStateRestPort(state);
	if (state.schemaVersion === 2 && state.projectName !== dockerProjectName(ownerPort)) return {
		status: "unavailable",
		reason: `saved Docker project ${state.projectName} does not match REST port ${ownerPort}`
	};
	const dockerBin = whichBinary("docker");
	if (!dockerBin) return {
		status: "unavailable",
		reason: "docker is not on PATH"
	};
	const discoveryFailures = [];
	if (state.containerId) {
		const direct = inspectDockerContainer(dockerBin, state.containerId, state, ownerPort);
		if (direct.status !== "unavailable") return direct;
		if (state.preserveContainer) return direct;
		discoveryFailures.push(direct.reason);
	}
	const composeFile = existsSync(state.composeFile) ? state.composeFile : discoverComposeFile() ?? state.composeFile;
	const candidateIds = /* @__PURE__ */ new Set();
	try {
		if (existsSync(composeFile)) {
			const composeText = readFileSync(composeFile, "utf-8");
			if (!/^\s+iii-engine:/m.test(composeText)) return {
				status: "unavailable",
				reason: `${composeFile} does not define iii-engine`
			};
			const psResult = spawnSync(dockerBin, dockerComposeArgs(composeFile, state.projectName, [
				"ps",
				"-q",
				"--all",
				"iii-engine"
			]), {
				encoding: "utf-8",
				stdio: [
					"ignore",
					"pipe",
					"ignore"
				],
				timeout: 5e3,
				killSignal: "SIGKILL"
			});
			if (psResult.status === 0) {
				for (const id of (psResult.stdout ?? "").trim().split(/\s+/)) if (id) candidateIds.add(id);
			} else discoveryFailures.push(`docker compose ps failed for project ${state.projectName ?? "<default>"}`);
		}
		const scanResult = spawnSync(dockerBin, [
			"ps",
			"-aq",
			"--filter",
			"label=com.docker.compose.service=iii-engine",
			"--filter",
			`ancestor=iiidev/iii:${state.engineVersion ?? IIPINNED_VERSION}`,
			...state.projectName ? ["--filter", `label=com.docker.compose.project=${state.projectName}`] : []
		], {
			encoding: "utf-8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 5e3,
			killSignal: "SIGKILL"
		});
		if (scanResult.status === 0) {
			for (const id of (scanResult.stdout ?? "").trim().split(/\s+/)) if (id) candidateIds.add(id);
		} else discoveryFailures.push("docker container scan failed");
		const matches = [];
		for (const containerId of candidateIds) {
			const inspected = inspectDockerContainer(dockerBin, containerId, state, ownerPort);
			if (inspected.status === "running" || inspected.status === "stopped") {
				if (!matches.some((match) => (match.status === "running" || match.status === "stopped") && match.containerId === inspected.containerId)) matches.push(inspected);
			} else if (inspected.status === "unavailable") discoveryFailures.push(inspected.reason);
		}
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) return {
			status: "unavailable",
			reason: `multiple Docker iii-engine containers match REST port ${ownerPort}`
		};
		if (discoveryFailures.length > 0) return {
			status: "unavailable",
			reason: [...new Set(discoveryFailures)].join("; ")
		};
		if (state.schemaVersion !== 2 || state.preserveContainer) return {
			status: "unavailable",
			reason: `legacy Docker ownership exists for REST port ${ownerPort}, but no unique container can be verified`
		};
		return {
			status: "missing",
			composeFile,
			projectName: state.projectName
		};
	} catch (err) {
		return {
			status: "unavailable",
			reason: err instanceof Error ? err.message : String(err)
		};
	}
}
function persistDockerInspection(state, inspection) {
	if (inspection.status !== "running" && inspection.status !== "stopped") return state;
	const resolved = {
		...state,
		composeFile: inspection.composeFile,
		projectName: inspection.projectName,
		containerId: inspection.containerId,
		dataMountType: inspection.dataMountType,
		dataMountSource: inspection.dataMountSource,
		preserveContainer: inspection.preserveContainer
	};
	writeEngineState(resolved);
	return resolved;
}
async function assertRuntimePortOwnership() {
	const state = readEngineState();
	if (!state) return;
	const ownerPort = engineStateRestPort(state);
	const requestedPort = getRestPort();
	if (ownerPort === requestedPort) return;
	if (state.kind === "docker") {
		const inspection = inspectOwnedDockerEngine(state);
		if (inspection.status === "unavailable") {
			p.log.error(`The data directory contains Docker ownership for REST port ${ownerPort}, but it cannot be verified: ${inspection.reason}. Refusing to overwrite its lifecycle state.`);
			process.exit(1);
		}
		if (inspection.status === "running" || inspection.status === "stopped") {
			persistDockerInspection(state, inspection);
			p.log.error(`The canonical lifecycle state is owned by a ${inspection.status} Docker engine on REST port ${ownerPort}. Refusing to reuse it for port ${requestedPort}. Use the original port, or use --instance <N> for an isolated daemon.`);
			process.exit(1);
		}
		p.log.error(`The canonical lifecycle state still records a Docker engine for REST port ${ownerPort}, but its container is missing. Refusing to overwrite that ownership from port ${requestedPort}. Re-run \`agentmemory stop\` with the original port to reconcile it.`);
		process.exit(1);
	}
	const enginePid = readEnginePidfile();
	const workerPid = readWorkerPidfile();
	let active = Boolean(enginePid && pidAlive(enginePid) && !isForeignPortHolder(pidCommand(enginePid)) || workerPid && pidAlive(workerPid));
	if (!active) try {
		await fetch(`http://127.0.0.1:${ownerPort}/`, { signal: AbortSignal.timeout(750) });
		active = true;
	} catch {}
	if (active) {
		p.log.error(`The canonical lifecycle state is owned by a live agentmemory engine on REST port ${ownerPort}. Refusing to reuse it for port ${requestedPort}. Use the original port, or use --instance <N> for an isolated daemon.`);
		process.exit(1);
	}
	clearEnginePidfile();
	clearWorkerPidfile();
	clearEngineState();
}
function configureDockerHostUser() {
	if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return;
	const hostUid = String(process.getuid());
	const hostGid = String(process.getgid());
	process.env["AGENTMEMORY_DOCKER_UID"] ??= hostUid;
	process.env["AGENTMEMORY_DOCKER_GID"] ??= hostGid;
	if (process.env["AGENTMEMORY_DOCKER_UID"] === hostUid && process.env["AGENTMEMORY_DOCKER_GID"] === hostGid) process.env["AGENTMEMORY_DOCKER_SKIP_CHOWN"] ??= "1";
}
function isInvokedViaNpx() {
	if (process.env["npm_lifecycle_event"] === "npx") return true;
	if ((process.argv[1] ?? "").includes("_npx")) return true;
	const ua = process.env["npm_config_user_agent"] ?? "";
	if (ua.startsWith("npm/") || ua.includes(" npm/")) return true;
	return false;
}
async function maybeOfferGlobalInstall() {
	if (!isInvokedViaNpx()) return;
	if (!process.stdin.isTTY) return;
	if (process.env["CI"]) return;
	const prefs = readPrefs();
	if (prefs.skipGlobalInstall || prefs.skipNpxHint) return;
	const answer = await p.confirm({
		message: "Install agentmemory globally so the bare `agentmemory` command works in any shell? [Y/n]",
		initialValue: true
	});
	if (p.isCancel(answer)) return;
	if (answer === false) {
		writePrefs({ skipGlobalInstall: true });
		p.log.info("Skipped. Re-run via `npx @agentmemory/agentmemory` or install later with: npm install -g @agentmemory/agentmemory");
		return;
	}
	const npmBin = whichBinary("npm");
	if (!npmBin) {
		p.log.warn("npm not found on PATH. Install manually: npm install -g @agentmemory/agentmemory");
		return;
	}
	if (runCommand(npmBin, [
		"install",
		"-g",
		`@agentmemory/agentmemory@0.9.30`
	], { label: `Installing @agentmemory/agentmemory@0.9.30 globally` })) {
		p.log.success("Installed globally. `agentmemory stop` etc. will now work in new shells.");
		writePrefs({ skipGlobalInstall: true });
	} else p.log.warn("Global install failed. Try manually: npm install -g @agentmemory/agentmemory");
}
function adoptRunningEngine() {
	try {
		const existingState = readEngineState();
		const existingPid = readEnginePidfile();
		if (existingState && existingPid) return;
		const enginePid = findEnginePidsByPort(getRestPort())[0];
		if (enginePid) {
			const comm = pidCommand(enginePid);
			if (isForeignPortHolder(comm)) {
				vlog(`adoptRunningEngine: refusing to adopt pid ${enginePid} (${comm}) — not the iii engine binary`);
				return;
			}
		}
		if (enginePid && !existingPid) writeEnginePidfile(enginePid);
		if (!existingState) writeEngineState({
			kind: "native",
			configPath: findIiiConfig() || "",
			attached: true
		});
		if (enginePid && !existingPid) p.log.info(c.ok(`Attached to existing iii-engine (pid ${enginePid})`));
	} catch (err) {
		vlog(`adoptRunningEngine: ${err instanceof Error ? err.message : String(err)}`);
	}
}
async function runIiiInstaller() {
	const releaseUrl = iiiReleaseUrl();
	const asset = iiiReleaseAsset();
	const isZipAsset = asset?.endsWith(".zip") === true;
	if (!releaseUrl) {
		p.log.warn(`iii-engine binary not available for ${platform()}/${process.arch}. Use Docker (\`docker pull iiidev/iii:${IIPINNED_VERSION}\`) or download manually from https://github.com/iii-hq/iii/releases/tag/iii%2Fv${IIPINNED_VERSION}.`);
		return {
			ok: false,
			binPath: null
		};
	}
	if (IS_WINDOWS || isZipAsset) {
		p.log.info(`Auto-install unavailable on ${platform()} — ${asset} isn't tar-compatible. Install manually:\n  1. Download ${releaseUrl}\n     Its SHA-256 must be ${expectedIiiSha256(IIPINNED_VERSION, asset ?? "") ?? `the value in ${releaseUrl.replace(/\.zip$/, ".sha256")}`}\n  2. Extract iii.exe and place it on PATH (e.g. %USERPROFILE%\\.local\\bin)\nOr use Docker: docker pull iiidev/iii:${IIPINNED_VERSION}`);
		return {
			ok: false,
			binPath: null
		};
	}
	const shBin = whichBinary("sh");
	const curlBin = whichBinary("curl");
	const tarBin = whichBinary("tar");
	if (!shBin || !curlBin || !tarBin) {
		const missing = [
			!shBin && "sh",
			!curlBin && "curl",
			!tarBin && "tar"
		].filter(Boolean).join(", ");
		p.log.warn(`${missing} not found. Cannot auto-install iii-engine.`);
		return {
			ok: false,
			binPath: null
		};
	}
	const binDir = agentmemoryBinDir();
	const binPath = privateIiiPath();
	const label = `Installing iii-engine v${IIPINNED_VERSION} (pinned)`;
	const spinner = p.spinner();
	spinner.start(label);
	const outcome = installIiiArchive({
		sh: shBin,
		releaseUrl,
		version: IIPINNED_VERSION,
		asset: asset ?? "",
		binDir,
		binPath
	});
	if (!outcome.ok) {
		spinner.stop(`${label} ${pc.red("✗")}`);
		const sha256 = expectedIiiSha256(IIPINNED_VERSION, asset ?? "");
		const heading = outcome.reason === "checksum" ? "iii-engine download failed verification" : outcome.reason === "no-checksum" ? "iii-engine auto-install skipped" : "iii-engine download failed";
		const checksumHint = sha256 ? "" : `Compare the archive against ${releaseUrl.replace(/\.(tar\.gz|zip)$/, ".sha256")} before extracting.\n`;
		p.log.warn(`${heading}: ${outcome.detail.slice(0, 300)}\nInstall it manually, then re-run agentmemory:\n  ${iiiManualInstallCommand(releaseUrl, binDir, binPath, sha256)}\n` + checksumHint + `Or use Docker: docker pull iiidev/iii:${IIPINNED_VERSION}`);
		return {
			ok: false,
			binPath: null
		};
	}
	spinner.stop(`${label} ${pc.green("✓")}`);
	return {
		ok: true,
		binPath
	};
}
let startupFailure = null;
let activeStartupStderr = createStartupStderrCapture();
let spawnedNativeEngine = null;
let importedStartupWorker = false;
let spawnedStartupWorker = null;
let startupWorkerFailure = null;
let spawnedDockerCommand = null;
let startedDockerEngine = null;
let engineReadinessDeadline = null;
let startupInterrupted = false;
let finishStartup = () => {};
function beginStartup() {
	finishStartup();
	startupInterrupted = false;
	const unregister = registerStartupCleanup(cleanupFailedStartup);
	const interrupt = async (exitCode) => {
		startupInterrupted = true;
		process.exit(await runStartupCleanup(exitCode).catch(() => exitCode));
	};
	const onInterrupt = () => {
		interrupt(130);
	};
	const onTerminate = () => {
		interrupt(143);
	};
	process.on("SIGINT", onInterrupt);
	process.on("SIGTERM", onTerminate);
	finishStartup = () => {
		process.off("SIGINT", onInterrupt);
		process.off("SIGTERM", onTerminate);
		unregister();
		finishStartup = () => {};
	};
}
function engineStartupFailed() {
	return startupFailure?.kind === "engine-crashed" || startupFailure?.kind === "docker-crashed";
}
async function cleanupFailedStartup() {
	engineReadinessDeadline = null;
	if (importedStartupWorker && readWorkerPidfile() === process.pid) clearWorkerPidfile();
	const worker = spawnedStartupWorker;
	spawnedStartupWorker = null;
	if (worker && typeof worker.pid === "number") {
		if (worker.exitCode === null && worker.signalCode === null && !await signalAndWait(worker.pid, "SIGTERM", 3e3)) {
			p.log.warn(`Started worker pid ${worker.pid} survived shutdown; lifecycle state was preserved.`);
			return;
		}
		if (readWorkerPidfile() === worker.pid) clearWorkerPidfile();
	}
	const dockerCommand = spawnedDockerCommand;
	spawnedDockerCommand = null;
	if (dockerCommand && typeof dockerCommand.pid === "number" && dockerCommand.exitCode === null && dockerCommand.signalCode === null) await signalAndWait(dockerCommand.pid, "SIGTERM", 1e3);
	const dockerState = startedDockerEngine;
	startedDockerEngine = null;
	if (dockerState) {
		const inspection = inspectOwnedDockerEngine(dockerState);
		if (inspection.status === "running" || inspection.status === "stopped") {
			persistDockerInspection(dockerState, inspection);
			const dockerBin = whichBinary("docker");
			if (inspection.status === "running" && dockerBin) runCommand(dockerBin, [
				"stop",
				"--time",
				"10",
				inspection.containerId
			], {
				label: "Stopping the Docker container started by this invocation",
				timeoutMs: 15e3
			});
		} else p.log.warn("Docker startup ownership could not be verified for cleanup; project state was preserved for `agentmemory stop`.");
	}
	const child = spawnedNativeEngine;
	spawnedNativeEngine = null;
	if (!child || typeof child.pid !== "number") return;
	if (!IS_WINDOWS) try {
		process.kill(-child.pid, "SIGTERM");
	} catch {}
	if (child.exitCode === null && child.signalCode === null) {
		if (!await signalAndWait(child.pid, "SIGTERM", 3e3)) {
			p.log.warn(`Started engine pid ${child.pid} survived shutdown; lifecycle state was preserved.`);
			return;
		}
	}
	if (readEnginePidfile() === child.pid) {
		clearEnginePidfile();
		clearEngineState();
	}
}
function printCapturedStartupStderr() {
	const stderr = redactCredentialUrls(activeStartupStderr.text().trim());
	if (IS_VERBOSE && stderr) p.note(stderr, "engine stderr");
}
function printDockerStartupLogs() {
	const state = readEngineState();
	if (state?.kind !== "docker") return;
	const inspection = inspectOwnedDockerEngine(state);
	if (inspection.status !== "running" && inspection.status !== "stopped") return;
	const dockerBin = whichBinary("docker");
	if (!dockerBin) return;
	const result = spawnSync(dockerBin, [
		"logs",
		"--tail",
		"80",
		inspection.containerId
	], {
		encoding: "utf-8",
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		timeout: 5e3,
		killSignal: "SIGKILL",
		maxBuffer: 64 * 1024
	});
	const output = redactCredentialUrls(`${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
	if (output) p.note(output.slice(-16 * 1024), "docker engine logs");
}
function spawnEngineBackground(bin, spawnArgs, label, cwd) {
	vlog(`spawn: ${bin} ${spawnArgs.join(" ")}${cwd ? ` (cwd: ${cwd})` : ""}`);
	activeStartupStderr = createStartupStderrCapture();
	startupFailure = null;
	engineReadinessDeadline = startupDeadline(startupTimeouts().engineMs);
	const child = spawn(bin, spawnArgs, {
		detached: true,
		stdio: [
			"ignore",
			"ignore",
			"pipe"
		],
		windowsHide: true,
		env: engineChildEnv(process.env),
		...cwd ? { cwd } : {}
	});
	const isDocker = label.includes("Docker");
	if (isDocker) spawnedDockerCommand = child;
	if (!isDocker) {
		spawnedNativeEngine = child;
		if (typeof child.pid === "number") writeEnginePidfile(child.pid);
	}
	child.on("error", (error) => {
		if ((isDocker ? spawnedDockerCommand : spawnedNativeEngine) !== child) return;
		startupFailure = {
			kind: isDocker ? "docker-crashed" : "engine-crashed",
			stderr: redactCredentialUrls(error.message),
			binary: bin
		};
		if (!isDocker && spawnedNativeEngine === child) {
			clearEnginePidfile();
			clearEngineState();
		}
	});
	child.stderr?.on("data", (chunk) => {
		if ((isDocker ? spawnedDockerCommand : spawnedNativeEngine) !== child) return;
		activeStartupStderr.append(chunk);
	});
	child.stderr?.unref?.();
	child.on("exit", (code, signal) => {
		if ((isDocker ? spawnedDockerCommand : spawnedNativeEngine) !== child) return;
		if (!isDocker || code !== null && code !== 0 || code === null && signal !== null) {
			const stderr = redactCredentialUrls(activeStartupStderr.text());
			startupFailure = {
				kind: isDocker ? "docker-crashed" : "engine-crashed",
				stderr: stderr.trim() || (signal ? `process killed by signal ${signal}` : `process exited with code ${code}`),
				binary: bin
			};
			vlog(`engine exited early: code=${code} signal=${signal}`);
			if (IS_VERBOSE && stderr.trim()) p.log.error(`engine stderr:\n${stderr}`);
			if (!isDocker && readEnginePidfile() === child.pid) {
				clearEnginePidfile();
				clearEngineState();
			}
		}
	});
	child.unref();
	return child;
}
function prepareEngineLaunch(configPath) {
	const home = homedir();
	const bundledConfig = isBundledConfig(configPath, __dirname);
	const cwd = resolveEngineCwd(configPath, process.cwd(), home, bundledConfig);
	const stateBackendKind = getStateBackend();
	try {
		mkdirSync(cwd, { recursive: true });
	} catch (err) {
		const failure = resolveLaunchRenderFailure(stateBackendKind, err);
		if (failure.fatal) {
			p.log.error(failure.message);
			process.exit(1);
		}
		return {
			configPath,
			cwd: process.cwd()
		};
	}
	try {
		const rawConfig = readFileSync(configPath, "utf-8");
		const options = {
			dataDir: dataDirResolution.dataDir,
			ports: {
				restPort: getRestPort(),
				streamPort: getStreamPort(),
				viewerPort: getConfiguredViewerPort(),
				enginePort: getEnginePort()
			},
			stateBackend: {
				kind: stateBackendKind,
				redisUrl: getRedisUrl()
			},
			saveIntervalMs: getStateSaveIntervalMs()
		};
		const rewritten = bundledConfig ? rewriteBundledConfig(rawConfig, home, process.execPath, join(__dirname, "index.mjs"), options) : renderEngineConfig(rawConfig, options);
		const runtimePath = runtimeConfigPath(dataDirResolution.dataDir);
		mkdirSync(dirname(runtimePath), { recursive: true });
		writeFileSync(runtimePath, rewritten, "utf-8");
		try {
			const cleared = clearPersistedBuiltinConfig(cwd, runtimePath, rewritten);
			if (cleared.length > 0) vlog(`cleared ${cleared.length} persisted builtin config entries so the rendered runtime config seeds the engine again`);
		} catch (err) {
			p.log.error(`${String(err instanceof Error ? err.message : err)}. The engine would ignore the rendered runtime config and keep its previously persisted ports and timeouts. Fix the permissions on that file and run agentmemory start again.`);
			process.exit(1);
		}
		if (selectedInstance === 0 && dataDirResolution.source === "default") {
			for (const m of legacyDataMigrations(process.cwd(), home, dataDirResolution.dataDir)) if (existsSync(m.from) && !existsSync(m.to)) try {
				mkdirSync(dirname(m.to), { recursive: true });
				cpSync(m.from, m.to, { recursive: true });
				p.log.info(`Copied existing data: ${m.from} -> ${m.to}`);
			} catch (err) {
				vlog(`data copy failed for ${m.from}: ${String(err)}`);
			}
		}
		return {
			configPath: runtimePath,
			cwd
		};
	} catch (err) {
		const failure = resolveLaunchRenderFailure(stateBackendKind, err);
		if (failure.fatal) {
			p.log.error(failure.message);
			process.exit(1);
		}
		vlog(`runtime config generation failed, using bundled config verbatim: ${String(err)}`);
		return {
			configPath,
			cwd
		};
	}
}
function startIiiBin(iiiBin, configPath) {
	const s = p.spinner();
	s.start(`Starting iii-engine: ${iiiBin}`);
	const launch = prepareEngineLaunch(configPath);
	writeEngineState({
		kind: "native",
		configPath: launch.configPath,
		cwd: launch.cwd,
		binPath: iiiBin
	});
	spawnEngineBackground(iiiBin, [
		"--config",
		launch.configPath,
		"--no-update-check"
	], "iii-engine", launch.cwd);
	s.stop(c.ok("iii-engine process started"));
	return true;
}
function pickCompatibleIii(candidates) {
	for (const c of candidates) {
		if (!c) continue;
		const resolved = resolveCompatibleIii(c);
		if (resolved) return resolved;
	}
	return null;
}
function warnIfDockerIgnoresStateBackend(stateBackendKind) {
	if (stateBackendKind !== "redis") return;
	p.log.warn("AGENTMEMORY_STATE_BACKEND=redis is not applied on the Docker path: docker-compose.yml mounts iii-config.docker.yaml read-only, so this start will not render it. Edit iii-config.docker.yaml by hand to point iii-state/iii-stream at redis (see README \"Storage backend\"), or it keeps using the file store. docker-compose.yml passes AGENTMEMORY_REDIS_URL into the engine container, so redis_url: '${AGENTMEMORY_REDIS_URL}' works in that file.");
}
async function startEngine() {
	startupFailure = null;
	engineReadinessDeadline = null;
	let stateBackendKind;
	try {
		stateBackendKind = getStateBackend();
	} catch (err) {
		p.log.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	if (stateBackendKind === "redis" && !getRedisUrl()) {
		p.log.error("AGENTMEMORY_STATE_BACKEND=redis requires AGENTMEMORY_REDIS_URL to be set (e.g. redis://localhost:6379). Set both in ~/.agentmemory/.env, or unset AGENTMEMORY_STATE_BACKEND to keep the default file store.");
		process.exit(1);
	}
	await assertRuntimePortOwnership();
	const persistedState = readEngineState();
	if (persistedState?.kind === "docker") {
		warnIfDockerIgnoresStateBackend(stateBackendKind);
		const inspection = inspectOwnedDockerEngine(persistedState);
		if (inspection.status === "unavailable" || inspection.status === "missing") {
			const detail = inspection.status === "unavailable" ? inspection.reason : "container is missing";
			p.log.error(`A saved Docker engine owns this lifecycle state, but it cannot be resumed safely (${detail}). Run \`agentmemory stop\` to reconcile that project before starting another engine.`);
			return false;
		}
		persistDockerInspection(persistedState, inspection);
		if (inspection.status === "running") return true;
		const dockerBin = whichBinary("docker");
		if (!dockerBin) return false;
		startedDockerEngine = persistDockerInspection(persistedState, inspection);
		engineReadinessDeadline = startupDeadline(startupTimeouts().engineMs);
		return runCommand(dockerBin, ["start", inspection.containerId], {
			label: `Restarting owned Docker container ${inspection.containerId}`,
			timeoutMs: startupTimeouts().engineMs
		});
	}
	const configPath = findIiiConfig();
	warnIfRelocatedDataDir();
	const pathIii = whichBinary("iii");
	vlog(`iii binary: ${pathIii ?? "(not on PATH)"}, config: ${configPath || "(not found)"}`);
	const dockerBin = whichBinary("docker");
	const composeFile = [
		join(__dirname, "..", "docker-compose.yml"),
		join(__dirname, "docker-compose.yml"),
		join(process.cwd(), "docker-compose.yml")
	].find((c) => existsSync(c));
	const dockerOptIn = process.env["AGENTMEMORY_USE_DOCKER"] === "1" || process.env["AGENTMEMORY_USE_DOCKER"] === "true";
	const fallbacks = fallbackIiiPaths().filter((p) => existsSync(p));
	for (const f of fallbacks) vlog(`fallback iii at ${f} reports version: ${iiiBinVersion(f) ?? "unknown"}`);
	let iiiBin = pickCompatibleIii([pathIii, ...fallbacks]);
	if (iiiBin && configPath && !(dockerOptIn && dockerBin && composeFile)) {
		if (iiiBin !== pathIii) {
			p.log.info(`Using iii at: ${c.dim(iiiBin)} (v${c.accent(IIPINNED_VERSION)})`);
			process.env["PATH"] = `${dirname(iiiBin)}${delimiter}${process.env["PATH"] ?? ""}`;
		}
		return startIiiBin(iiiBin, configPath);
	}
	if (pathIii && !iiiBin) vlog(`iii on PATH is v${iiiBinVersion(pathIii) ?? "unknown"}, pin is v${IIPINNED_VERSION}. Will install pinned engine to ${privateIiiPath()}.`);
	if (!configPath) {
		startupFailure = { kind: "no-engine" };
		return false;
	}
	vlog(`docker binary: ${dockerBin ?? "(not on PATH)"}`);
	mkdirSync(dataDirResolution.dataDir, { recursive: true });
	vlog(`docker-compose.yml: ${composeFile ?? "(not found)"}`);
	const interactive = !!process.stdin.isTTY && !process.env["CI"];
	let choice;
	const pathIiiMismatch = pathIii !== null && resolveCompatibleIii(pathIii) === null;
	if (dockerOptIn && dockerBin && composeFile) choice = "docker";
	else if (pathIiiMismatch) {
		choice = "install";
		const detected = iiiBinVersion(pathIii);
		p.log.info(`iii on PATH is v${detected ?? "unknown"} but agentmemory pins v${IIPINNED_VERSION}. Installing pinned engine to ~/.agentmemory/bin (leaves your existing iii untouched).`);
	} else if (!interactive) {
		choice = "install";
		p.log.info("Non-interactive environment detected — auto-installing iii-engine.");
	} else {
		p.log.warn(`iii-engine binary not found locally.`);
		const options = [{
			value: "install",
			label: `Install iii v${IIPINNED_VERSION} to ~/.agentmemory/bin (~6MB, ~5s)`,
			hint: "recommended"
		}];
		if (dockerBin && composeFile) options.push({
			value: "docker",
			label: "Use Docker compose",
			hint: "advanced"
		});
		options.push({
			value: "manual",
			label: "Show manual install steps and exit"
		});
		const picked = await p.select({
			message: "How would you like to start iii-engine?",
			options,
			initialValue: "install"
		});
		if (p.isCancel(picked)) {
			startupFailure = { kind: "no-engine" };
			return false;
		}
		choice = picked;
	}
	if (choice === "manual") {
		startupFailure = { kind: "no-engine" };
		return false;
	}
	if (choice === "install") {
		const result = await runIiiInstaller();
		if (result.ok && result.binPath) {
			process.env["PATH"] = `${dirname(result.binPath)}${delimiter}${process.env["PATH"] ?? ""}`;
			iiiBin = result.binPath;
			return startIiiBin(iiiBin, configPath);
		}
		if (dockerBin && composeFile && interactive) {
			const fallback = await p.confirm({
				message: "Auto-install failed. Try Docker compose instead?",
				initialValue: true
			});
			if (p.isCancel(fallback) || fallback !== true) {
				startupFailure = { kind: "no-engine" };
				return false;
			}
			choice = "docker";
		} else {
			startupFailure = { kind: "no-engine" };
			return false;
		}
	}
	if (choice === "docker" && dockerBin && composeFile) {
		warnIfDockerIgnoresStateBackend(stateBackendKind);
		const s = p.spinner();
		s.start("Starting iii-engine via Docker...");
		configureDockerHostUser();
		const projectName = dockerProjectName(getRestPort());
		const dockerState = {
			kind: "docker",
			schemaVersion: 2,
			composeFile,
			projectName,
			engineVersion: IIPINNED_VERSION,
			dataMountType: "bind",
			dataMountSource: dataDirResolution.dataDir,
			preserveContainer: false
		};
		const previous = inspectOwnedDockerEngine(dockerState);
		if (previous.status === "missing" || previous.status === "stopped") startedDockerEngine = previous.status === "stopped" ? persistDockerInspection(dockerState, previous) : dockerState;
		writeEngineState(dockerState);
		spawnEngineBackground(dockerBin, dockerComposeArgs(composeFile, projectName, ["up", "-d"]), "iii-engine via Docker");
		s.stop("Docker compose started");
		return true;
	}
	if (!composeFile && dockerBin) startupFailure = { kind: "no-docker-compose" };
	else startupFailure = { kind: "no-engine" };
	return false;
}
async function waitForEngine(timeoutMs = startupTimeouts().engineMs) {
	return waitForReadiness(engineReadinessDeadline ?? startupDeadline(timeoutMs), (signal) => probeEngine(getBaseUrl(), signal), {
		intervalMs: 500,
		stopped: () => startupInterrupted || engineStartupFailed()
	});
}
async function waitForPersistedNativeEngine() {
	const state = readEngineState();
	const pid = readEnginePidfile();
	if (state?.kind !== "native" || !pid || !pidAlive(pid) || isForeignPortHolder(pidCommand(pid))) return false;
	if (!await waitForEngine()) throw new Error(startupTimeoutMessage("engine", startupTimeouts().engineMs));
	return true;
}
async function reconcilePersistedDockerEngine() {
	const state = readEngineState();
	if (state?.kind !== "docker") return false;
	const inspection = inspectOwnedDockerEngine(state);
	if (inspection.status === "unavailable") {
		p.log.error(`The saved Docker engine cannot be verified: ${inspection.reason}. Refusing to overwrite its lifecycle state. Run \`agentmemory stop\` after restoring Docker/compose access.`);
		process.exit(1);
	}
	if (inspection.status === "missing") {
		p.log.error("The saved Docker project no longer has an iii-engine container. Run `agentmemory stop` to remove its stale project state, then start agentmemory again.");
		process.exit(1);
	}
	persistDockerInspection(state, inspection);
	if (inspection.status === "stopped") {
		startedDockerEngine = persistDockerInspection(state, inspection);
		engineReadinessDeadline = startupDeadline(startupTimeouts().engineMs);
		const dockerBin = whichBinary("docker");
		if (!dockerBin || !runCommand(dockerBin, ["start", inspection.containerId], {
			label: `Restarting owned Docker container ${inspection.containerId}`,
			timeoutMs: startupTimeouts().engineMs
		})) throw new Error("The owned Docker container could not be restarted; lifecycle state was preserved.");
	}
	if (!await waitForEngine()) {
		printDockerStartupLogs();
		throw new Error(`${startupTimeoutMessage("engine", startupTimeouts().engineMs)} Docker ownership state was preserved.`);
	}
	await startWorkerForEngineState();
	await maybeOfferGlobalInstall();
	printReadyHint();
	return true;
}
function installInstructions() {
	const releaseUrl = iiiReleaseUrl();
	if (IS_WINDOWS) {
		const asset = iiiReleaseAsset() ?? "";
		const sha256 = expectedIiiSha256(IIPINNED_VERSION, asset);
		const verify = sha256 ? `     Verify before extracting: (Get-FileHash .\\${asset}).Hash must be ${sha256.toUpperCase()}` : `     Verify before extracting against the matching .sha256 file on the release page`;
		return [
			`agentmemory needs iii-engine v${IIPINNED_VERSION}. Pick one:`,
			"",
			"  A) Download the prebuilt Windows binary:",
			`     1. Open https://github.com/iii-hq/iii/releases/tag/iii%2Fv${IIPINNED_VERSION}`,
			`     2. Download iii-x86_64-pc-windows-msvc.zip (or iii-aarch64-pc-windows-msvc.zip on ARM)`,
			verify,
			"     3. Extract iii.exe to %USERPROFILE%\\.local\\bin\\iii.exe (or add to PATH)",
			"     4. Re-run: npx @agentmemory/agentmemory",
			"",
			`  B) Docker: docker pull iiidev/iii:${IIPINNED_VERSION}`,
			"     Re-run with AGENTMEMORY_USE_DOCKER=1 npx @agentmemory/agentmemory",
			"",
			"Or skip the engine entirely (standalone MCP):  npx @agentmemory/agentmemory mcp",
			"",
			"Docs: https://iii.dev/docs"
		];
	}
	const linuxInstall = releaseUrl ? `  A) ${iiiManualInstallCommand(releaseUrl, agentmemoryBinDir(), privateIiiPath(), expectedIiiSha256(IIPINNED_VERSION, iiiReleaseAsset() ?? ""))}` : `  A) Manual download: https://github.com/iii-hq/iii/releases/tag/iii%2Fv${IIPINNED_VERSION}`;
	return [
		`agentmemory needs iii-engine v${IIPINNED_VERSION}. Pick one:`,
		"",
		linuxInstall,
		"     Then re-run: npx @agentmemory/agentmemory",
		"",
		`  B) Docker: docker pull iiidev/iii:${IIPINNED_VERSION}`,
		"     Re-run with AGENTMEMORY_USE_DOCKER=1 npx @agentmemory/agentmemory",
		"",
		"Or skip the engine entirely (standalone MCP):  npx @agentmemory/agentmemory mcp",
		"",
		"Docs: https://iii.dev/docs"
	];
}
function portInUseDiagnostic(port) {
	return IS_WINDOWS ? `  netstat -ano | findstr :${port}` : `  lsof -i :${port}   # or: ss -tlnp | grep :${port}`;
}
function getEngineHost() {
	const envKeys = shouldUseAgentmemoryUrl() ? ["III_ENGINE_URL", "AGENTMEMORY_URL"] : ["III_ENGINE_URL"];
	for (const envKey of envKeys) {
		const raw = process.env[envKey];
		if (!raw) continue;
		try {
			const parsed = new URL(raw);
			if (parsed.hostname) return parsed.hostname;
		} catch {}
	}
	return "localhost";
}
function printReadyHint() {
	const restUrl = getBaseUrl();
	const viewerUrl = getViewerUrl();
	const engineHost = getEngineHost();
	const streamUrl = `ws://${engineHost}:${getStreamPort()}`;
	const engineUrl = `ws://${engineHost}:${getEnginePort()}`;
	const invocation = isInvokedViaNpx() ? "npx @agentmemory/agentmemory" : "agentmemory";
	const consolePort = defaultConsolePort(getConfiguredViewerPort());
	const portFlags = portFlagSuffix(getRestPort(), selectedInstance);
	const consoleLine = `${c.label("iii console")}  ${c.cmd(`${invocation} console${portFlags}`)}  ${c.dim(`(serves on :${consolePort}; first run downloads the console next to the pinned iii)`)}`;
	const lines = [
		`${c.label("REST API")}     ${c.url(restUrl)}`,
		`${c.label("Viewer")}       ${c.url(viewerUrl)}`,
		`${c.label("Streams")}      ${c.url(streamUrl)}`,
		`${c.label("Engine")}       ${c.url(engineUrl)}`,
		consoleLine
	];
	p.note(lines.join("\n"), `agentmemory v${c.accent(VERSION)}`);
	const demoCommand = `${invocation} demo${portFlags}`;
	process.stdout.write(`\n${c.dim("Try:")} ${c.cmd(demoCommand)}\n`);
}
async function main() {
	startupTimeouts();
	await assertRuntimePortOwnership();
	try {
		if ((await fetch(`${getBaseUrl()}/agentmemory/livez`, { signal: AbortSignal.timeout(1500) })).ok) {
			p.log.error(`agentmemory is already running on port ${getRestPort()}. Starting a second instance here would corrupt the running daemon's REST routing. Use the REST API (or the MCP tools) against the running instance, run a different --instance, or stop it first with \`agentmemory stop\`.`);
			process.exit(1);
		}
	} catch {}
	if (IS_RESET) resetPrefs();
	const firstRun = isFirstRun();
	const prefs = readPrefs();
	if (firstRun || IS_RESET || IS_VERBOSE || !prefs.skipSplash) renderSplash(VERSION);
	if (firstRun || IS_RESET) await runOnboarding();
	beginStartup();
	if (skipEngine) {
		if (IS_VERBOSE) p.log.info("Skipping engine check (--no-engine)");
		await startWorkerForEngineState();
		await maybeOfferGlobalInstall();
		printReadyHint();
		return;
	}
	if (await reconcilePersistedDockerEngine()) return;
	if (await isEngineRunning() || await waitForPersistedNativeEngine()) {
		if (IS_VERBOSE) p.log.success("iii-engine is running");
		const persisted = readEngineState();
		const attachedBin = (persisted?.kind === "native" && persisted.binPath && existsSync(persisted.binPath) ? persisted.binPath : null) ?? whichBinary("iii") ?? fallbackIiiPaths().find((p) => existsSync(p)) ?? null;
		const detected = attachedBin ? iiiBinVersion(attachedBin) : null;
		if (detected === IIPINNED_VERSION) {
			adoptRunningEngine();
			await startWorkerForEngineState();
			await maybeOfferGlobalInstall();
			printReadyHint();
			return;
		}
		const detectedLabel = detected ? `v${detected}` : "an unverified version";
		const base = isInvokedViaNpx() ? "npx @agentmemory/agentmemory" : "agentmemory";
		p.log.error(`Another iii-engine (${detectedLabel}) is running on port ${getEnginePort()}, and agentmemory needs its own pinned v${IIPINNED_VERSION}.`);
		p.note([
			`agentmemory only supports iii-engine v${IIPINNED_VERSION}. It will not adopt or change the running engine (${detectedLabel}).`,
			"",
			c.label("Switch to the pinned engine in two steps:"),
			"",
			`  1. Stop the running engine:`,
			`       ${c.cmd(`${base} stop --force`)}`,
			`     ${c.dim(`(or stop your own iii however you started it — agentmemory leaves your global iii untouched)`)}`,
			"",
			`  2. Start agentmemory. It downloads and runs the pinned`,
			`     v${IIPINNED_VERSION} into ~/.agentmemory/bin automatically:`,
			`       ${c.cmd(base)}`,
			"",
			c.dim(`Step 2 needs no manual install. To install iii v${IIPINNED_VERSION} yourself (replaces your global iii), curl:`),
			`     ${c.cmd(IIIENGINE_INSTALL_CMD)}`,
			`     ${c.dim("or download the release:")} ${c.url(`https://github.com/iii-hq/iii/releases/tag/iii%2Fv${IIPINNED_VERSION}`)}`
		].join("\n"), "engine conflict");
		process.exit(1);
	}
	if (!await startEngine()) {
		p.log.error("Could not start iii-engine.");
		const lines = installInstructions();
		if (startupFailure?.kind === "no-docker-compose") lines.unshift("Docker is installed but docker-compose.yml is missing from this", "install. Re-install with: npm install -g @agentmemory/agentmemory", "");
		p.note(lines.join("\n"), "Setup required");
		throw new Error("iii-engine could not be started.");
	}
	const s = p.spinner();
	s.start("Waiting for iii-engine to be ready...");
	if (!await waitForEngine()) {
		const port = getRestPort();
		s.stop(startupTimeoutMessage("engine", startupTimeouts().engineMs));
		printDockerStartupLogs();
		if (startupFailure?.kind === "engine-crashed" || startupFailure?.kind === "docker-crashed") {
			p.log.error("The iii-engine process crashed on startup.");
			if (startupFailure.binary) p.log.info(`Binary: ${startupFailure.binary}`);
			if (startupFailure.stderr) p.note(startupFailure.stderr, "engine stderr");
			else p.log.info("No stderr was captured. Re-run with --verbose for more detail.");
			p.note([
				"Common causes:",
				`  - iii-engine version mismatch — reinstall the pinned v${IIPINNED_VERSION} binary`,
				"    (sh script on macOS/Linux, GitHub release zip on Windows)",
				"  - Docker Desktop not running (if you're using the Docker path)",
				"  - Port already in use (see below)",
				"",
				"See https://iii.dev/docs for current install instructions."
			].join("\n"), "Troubleshooting");
		} else {
			p.log.error("The engine process started but the REST API never responded.");
			printCapturedStartupStderr();
			p.note([
				`Check whether port ${port} is already bound by another process:`,
				portInUseDiagnostic(port),
				"",
				"If it is, free the port or override: agentmemory --port <N>",
				"",
				"If it isn't, a firewall may be blocking 127.0.0.1:" + port + ".",
				"Re-run with --verbose to see engine stderr."
			].join("\n"), "Troubleshooting");
		}
		throw new Error(engineStartupFailed() ? "iii-engine failed during startup." : startupTimeoutMessage("engine", startupTimeouts().engineMs));
	}
	s.stop(c.ok("iii-engine is ready"));
	await startWorkerForEngineState();
	await maybeOfferGlobalInstall();
	printReadyHint();
	writePrefs({ skipSplash: true });
}
async function apiFetch(base, path, timeoutMs = 5e3) {
	try {
		const headers = bearerHeaders(base);
		return await (await fetch(`${base}/agentmemory/${path}`, {
			signal: AbortSignal.timeout(timeoutMs),
			headers
		})).json();
	} catch {
		return null;
	}
}
async function runStatus() {
	getRestPort();
	const base = getBaseUrl();
	p.intro("agentmemory status");
	if (!await isEngineRunning()) {
		p.log.error(`Not running — no response at ${base}`);
		p.log.info("Start with: npx @agentmemory/agentmemory");
		process.exit(1);
	}
	try {
		const [healthRes, sessionsRes, graphRes, memoriesRes, flagsRes, followupRes] = await Promise.all([
			apiFetch(base, "health"),
			apiFetch(base, "sessions"),
			apiFetch(base, "graph/stats"),
			apiFetch(base, "memories?count=true"),
			apiFetch(base, "config/flags"),
			apiFetch(base, "diagnostics/followup")
		]);
		if (typeof healthRes?.viewerPort === "number") discoveredViewerPort = healthRes.viewerPort;
		const h = healthRes?.health;
		const status = healthRes?.status || "unknown";
		const version = healthRes?.version || "?";
		const sessionList = Array.isArray(sessionsRes?.sessions) ? sessionsRes.sessions : [];
		const sessions = sessionList.length;
		const nodes = graphRes?.available === false ? "unknown" : graphRes?.totalNodes ?? graphRes?.nodes ?? graphRes?.nodeCount ?? "unknown";
		const edges = graphRes?.available === false ? "unknown" : graphRes?.totalEdges ?? graphRes?.edges ?? graphRes?.edgeCount ?? "unknown";
		const cb = healthRes?.circuitBreaker?.state || "closed";
		const heapMB = h?.memory ? Math.round(h.memory.heapUsed / 1048576) : 0;
		const uptime = h?.uptimeSeconds ? Math.round(h.uptimeSeconds) : 0;
		const obsCount = sessionList.reduce((sum, s) => sum + (Number(s?.observationCount) || 0), 0);
		const memCount = Number(memoriesRes?.latestCount ?? memoriesRes?.total ?? 0) || 0;
		const estFullTokens = obsCount * 80;
		const estInjectedTokens = Math.min(obsCount, 50) * 38;
		const tokensSaved = estFullTokens - estInjectedTokens;
		const pctSaved = estFullTokens > 0 ? Math.round(tokensSaved / estFullTokens * 100) : 0;
		p.log.success(`Connected — v${version} at ${base}`);
		const lines = [
			`Health:       ${status === "healthy" ? pc.green("✓ healthy") : pc.yellow(status)}`,
			`Sessions:     ${sessions}`,
			`Observations: ${obsCount}`,
			`Memories:     ${memCount}`,
			`Graph:        ${nodes} nodes, ${edges} edges`,
			`Circuit:      ${cb}`,
			`Heap:         ${heapMB} MB`,
			`Uptime:       ${uptime}s`,
			`Viewer:       ${c.url(getViewerUrl())}`
		];
		if (obsCount > 0) {
			lines.push("");
			lines.push(`Token savings: ~${tokensSaved.toLocaleString()} tokens saved (${pctSaved}% reduction)`);
			lines.push(`  Full context: ~${estFullTokens.toLocaleString()} tokens`);
			lines.push(`  Injected:     ~${estInjectedTokens.toLocaleString()} tokens`);
		}
		if (flagsRes) {
			const provider = flagsRes.provider === "llm" ? pc.green("✓ llm") : pc.yellow("✗ noop (no key)");
			const embed = flagsRes.embeddingProvider === "embeddings" ? pc.green("✓ embeddings") : pc.dim("bm25-only");
			const flagRows = (flagsRes.flags || []).map((f) => `  ${f.enabled ? pc.green("✓") : pc.dim("✗")} ${pc.bold(f.key.padEnd(32))} ${f.label}`);
			lines.push("");
			lines.push(`Provider:     ${provider}`);
			lines.push(`Embeddings:   ${embed}`);
			lines.push(`Flags:`);
			flagRows.forEach((r) => lines.push(r));
		}
		if (followupRes && Number.isFinite(followupRes.agentInitiatedSearches)) {
			const total = Number(followupRes.agentInitiatedSearches) || 0;
			const hits = Number(followupRes.followupWithinWindow) || 0;
			const pct = total > 0 ? Math.round(hits / total * 100) : 0;
			lines.push("");
			lines.push(`Followup rate: ${hits}/${total} (${pct}%) within ${followupRes.windowSeconds}s — directional, may overcount on refinement`);
		}
		p.note(lines.join("\n"), "agentmemory");
	} catch (err) {
		p.log.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
function formatChecks(checks) {
	return checks.map((c) => `${c.ok ? pc.green("✓") : pc.red("✗")} ${c.name}${c.hint ? `\n   ${c.hint}` : ""}`).join("\n");
}
function findLatestDebugLog(debugDir) {
	const latestLink = join(debugDir, "latest");
	try {
		if (existsSync(latestLink)) {
			const target = readlinkSync(latestLink);
			const resolved = target.startsWith("/") ? target : join(debugDir, target);
			if (existsSync(resolved)) return resolved;
		}
	} catch {}
	try {
		const newest = readdirSync(debugDir).filter((f) => f.endsWith(".txt")).map((f) => ({
			f,
			m: statSync(join(debugDir, f)).mtimeMs
		})).sort((a, b) => b.m - a.m)[0];
		if (newest) return join(debugDir, newest.f);
	} catch {}
}
function checkClaudeCodeHooks() {
	const debugDir = join(homedir(), ".claude", "debug");
	if (!existsSync(debugDir)) return { state: "no-cc-dir" };
	const logPath = findLatestDebugLog(debugDir);
	if (!logPath) return { state: "no-debug-log" };
	let content;
	try {
		content = readFileSync(logPath, "utf8");
	} catch {
		return { state: "no-debug-log" };
	}
	const match = content.match(/Loaded hooks from standard location for plugin agentmemory:\s*(\S+)/);
	if (match) return {
		state: "loaded",
		manifestPath: match[1]
	};
	if (content.includes("Loading hooks from plugin: agentmemory")) return { state: "loaded" };
	return { state: "not-loaded" };
}
function buildDoctorContext() {
	return {
		baseUrl: getBaseUrl(),
		viewerUrl: getViewerUrl(),
		envPath: join(homedir(), ".agentmemory", ".env"),
		pidfilePath: enginePidfilePath(),
		enginePath: engineStatePath(),
		pinnedVersion: IIPINNED_VERSION
	};
}
function buildDoctorEffects() {
	return {
		envFileExists: () => existsSync(join(homedir(), ".agentmemory", ".env")),
		readEnvFile: () => {
			try {
				return parseEnvFile(readFileSync(join(homedir(), ".agentmemory", ".env"), "utf-8"));
			} catch {
				return {};
			}
		},
		pidfileExists: () => existsSync(enginePidfilePath()),
		pidfilePidIsAlive: () => {
			const pid = readEnginePidfile();
			if (pid === null) return null;
			return pidAlive(pid);
		},
		findIiiBinary: () => whichBinary("iii"),
		localBinIiiPath: () => privateIiiPath(),
		iiiBinaryVersion: (binPath) => iiiBinVersion(binPath),
		viewerReachable: async (timeoutMs = 2e3) => {
			try {
				await discoverViewerPort();
				return (await fetch(getViewerUrl(), { signal: AbortSignal.timeout(timeoutMs) })).ok;
			} catch {
				return false;
			}
		},
		runInit: async () => {
			try {
				await runInit();
				return {
					ok: true,
					message: "Wrote ~/.agentmemory/.env"
				};
			} catch (err) {
				return {
					ok: false,
					message: err instanceof Error ? err.message : String(err)
				};
			}
		},
		openEditor: async (path) => {
			const editor = process.env["EDITOR"] || process.env["VISUAL"] || "nano";
			p.log.info(`Opening ${path} in ${editor}…`);
			try {
				const result = spawnSync(editor, [path], { stdio: "inherit" });
				if (result.error) return {
					ok: false,
					message: `Failed to launch ${editor}: ${result.error.message}`
				};
				if ((result.status ?? 0) !== 0) return {
					ok: false,
					message: `${editor} exited with code ${result.status}`
				};
				return {
					ok: true,
					message: `Saved ${path}`
				};
			} catch (err) {
				return {
					ok: false,
					message: err instanceof Error ? err.message : String(err)
				};
			}
		},
		runIiiInstaller: async () => {
			const r = await runIiiInstaller();
			return {
				ok: r.ok,
				message: r.ok ? `Installed iii v${IIPINNED_VERSION} to ${r.binPath}` : "iii installer failed (see warnings above)"
			};
		},
		runStop: async () => {
			try {
				startupTimeouts();
				const portPids = findEnginePidsByPort(getRestPort());
				const pidfilePid = readEnginePidfile();
				if (portPids.length === 0 && pidfilePid === null) {
					clearEnginePidfile();
					clearEngineState();
					return {
						ok: true,
						message: "Nothing to stop."
					};
				}
				const candidates = /* @__PURE__ */ new Set();
				if (pidfilePid) candidates.add(pidfilePid);
				for (const pid of portPids) candidates.add(pid);
				let allStopped = true;
				for (const pid of candidates) if (!await signalAndWait(pid, "SIGTERM", 3e3)) allStopped = false;
				clearEnginePidfile();
				clearEngineState();
				return {
					ok: allStopped,
					message: allStopped ? "Engine stopped." : "Some engine pids survived."
				};
			} catch (err) {
				return {
					ok: false,
					message: err instanceof Error ? err.message : String(err)
				};
			}
		},
		runStart: async () => {
			try {
				startupTimeouts();
				beginStartup();
				if (!await startEngine()) throw new Error("iii-engine could not be started.");
				if (!await waitForEngine()) throw new Error(startupTimeoutMessage("engine", startupTimeouts().engineMs));
				await startWorkerForEngineState(true);
				return {
					ok: true,
					message: "Engine and agentmemory worker ready"
				};
			} catch (err) {
				await runStartupCleanup(1);
				finishStartup();
				return {
					ok: false,
					message: err instanceof Error ? err.message : String(err)
				};
			}
		},
		clearEnginePidAndState: () => {
			clearEnginePidfile();
			clearEngineState();
		}
	};
}
async function passiveServerChecks() {
	const base = getBaseUrl();
	const checks = [];
	const serverUp = await isEngineRunning();
	checks.push({
		name: "Server reachable",
		ok: serverUp,
		hint: serverUp ? void 0 : `Start with: npx @agentmemory/agentmemory (tried ${base})`
	});
	if (!serverUp) return checks;
	const [health, flags, graph] = await Promise.all([
		apiFetch(base, "health", 3e3),
		apiFetch(base, "config/flags", 3e3),
		apiFetch(base, "graph/stats", 3e3)
	]);
	const hasLlm = flags?.provider === "llm";
	const hasEmbed = flags?.embeddingProvider === "embeddings";
	const graphNodeCount = graph?.available === false ? null : graph?.totalNodes ?? graph?.nodes ?? graph?.nodeCount ?? null;
	const graphHas = typeof graphNodeCount === "number" && graphNodeCount > 0;
	checks.push({
		name: "Health status",
		ok: health?.status === "healthy",
		hint: health?.status === "healthy" ? void 0 : `Status: ${health?.status || "unknown"}`
	}, {
		name: "LLM provider",
		ok: hasLlm,
		hint: hasLlm ? void 0 : "set ANTHROPIC_API_KEY (or GEMINI/OPENROUTER/MINIMAX) in ~/.agentmemory/.env"
	}, {
		name: "Embedding provider",
		ok: hasEmbed,
		hint: hasEmbed ? void 0 : "Running BM25-only. Set EMBEDDING_PROVIDER=local for on-device semantic search, or add OPENAI_API_KEY / VOYAGE_API_KEY / COHERE_API_KEY / OLLAMA_HOST"
	});
	for (const f of flags?.flags || []) checks.push({
		name: f.label,
		ok: f.enabled,
		hint: f.enabled ? void 0 : f.enableHow
	});
	const cc = checkClaudeCodeHooks();
	const ccCheck = (() => {
		switch (cc.state) {
			case "loaded": return {
				ok: true,
				hint: cc.manifestPath ? `manifest: ${cc.manifestPath}` : void 0
			};
			case "not-loaded": return {
				ok: false,
				hint: "Plugin enabled but hooks not loaded by Claude Code. Try: /plugin uninstall agentmemory@agentmemory && /plugin install agentmemory@agentmemory, then restart the session."
			};
			case "no-debug-log": return {
				ok: false,
				hint: "Cannot verify — no Claude Code debug log found. Run once with `claude --debug -p \"x\"`, then re-run doctor."
			};
			case "no-cc-dir": return;
		}
	})();
	if (ccCheck) checks.push({
		name: "Claude Code plugin hooks registered",
		...ccCheck
	});
	checks.push({
		name: "Knowledge graph populated",
		ok: graphHas,
		hint: graphHas ? void 0 : graphNodeCount === null ? "Graph counts are unavailable. Run agentmemory graph-index status." : "Graph is empty. Run a session with GRAPH_EXTRACTION_ENABLED=true."
	});
	return checks;
}
async function askFixAction(d) {
	const choice = await p.select({
		message: `[${d.id}] ${d.message}`,
		options: [
			{
				value: "fix",
				label: "F  Fix",
				hint: d.fixPreview
			},
			{
				value: "skip",
				label: "S  Skip"
			},
			{
				value: "more",
				label: "?  More info"
			},
			{
				value: "quit",
				label: "Q  Quit doctor"
			}
		],
		initialValue: "fix"
	});
	if (p.isCancel(choice)) return "quit";
	return choice;
}
async function applyFixWithReport(d, ctx, dryRun) {
	if (dryRun) {
		p.log.info(`[dry-run] would: ${d.fixPreview}`);
		return {
			ok: true,
			message: "(dry-run)"
		};
	}
	const result = await d.fix(ctx);
	if (result.ok) p.log.success(result.message ?? `${d.id} fixed.`);
	else p.log.error(result.message ?? `${d.id} fix failed.`);
	return result;
}
async function runDoctor() {
	p.intro("agentmemory doctor");
	const applyAll = args.includes("--all");
	const dryRun = args.includes("--dry-run");
	if (applyAll && dryRun) {
		p.log.error("Cannot combine --all and --dry-run.");
		process.exit(2);
	}
	const passive = await passiveServerChecks();
	const passivePassed = passive.filter((c) => c.ok).length;
	p.note(formatChecks(passive), `server: ${passivePassed}/${passive.length} passing`);
	const ctx = buildDoctorContext();
	const diagnostics = buildDiagnostics(buildDoctorEffects());
	if (dryRun) {
		const results = [];
		for (const d of diagnostics) results.push({
			diagnostic: d,
			status: await d.check(ctx)
		});
		const lines = dryRunPlan(ctx, results);
		p.note(lines.join("\n"), "dry-run plan");
		p.outro("Dry-run complete. Re-run without --dry-run to apply.");
		return;
	}
	let failed = 0;
	let fixed = 0;
	let skipped = 0;
	let quit = false;
	for (const d of diagnostics) {
		if (quit) {
			skipped++;
			continue;
		}
		const status = await d.check(ctx);
		if (status.ok) {
			p.log.success(`${d.id} ✓${status.detail ? ` (${status.detail})` : ""}`);
			continue;
		}
		failed++;
		p.log.warn(`${d.id} ✗ ${status.detail ?? ""}`.trim());
		p.log.info(`why: ${d.fixPreview}`);
		if (d.manualOnly) p.log.info(`(manual fix only — see "${d.id}" docs)`);
		if (applyAll) {
			if ((await applyFixWithReport(d, ctx, false)).ok) fixed++;
			if (!(await d.check(ctx)).ok) p.log.warn(`${d.id} still failing after fix.`);
			continue;
		}
		while (true) {
			const action = await askFixAction(d);
			if (action === "fix") {
				if ((await applyFixWithReport(d, ctx, false)).ok) {
					const after = await d.check(ctx);
					if (after.ok) fixed++;
					else p.log.warn(`${d.id} still failing after fix: ${after.detail ?? ""}`);
				}
				break;
			}
			if (action === "skip") {
				skipped++;
				break;
			}
			if (action === "more") {
				p.note(d.moreInfo, `[${d.id}] more info`);
				continue;
			}
			if (action === "quit") {
				quit = true;
				break;
			}
		}
	}
	const summary = `${diagnostics.length} checks · ${failed} failing · ${fixed} fixed · ${skipped} skipped`;
	if (quit) {
		p.outro(`Quit early. ${summary}`);
		process.exit(1);
	}
	if (failed === 0) {
		p.outro("All diagnostics passing. agentmemory is healthy.");
		return;
	}
	if (failed - fixed === 0) {
		p.outro(`All fixes applied. ${summary}`);
		return;
	}
	p.outro(summary);
	process.exit(1);
}
function buildDemoSessions() {
	return [
		{
			id: generateId("demo"),
			title: "Session 1: JWT auth setup",
			observations: [
				{
					toolName: "Write",
					toolInput: { file_path: "src/middleware/auth.ts" },
					toolOutput: "Created JWT middleware using jose library. Tokens expire after 30 days. Chose jose over jsonwebtoken for Edge compatibility."
				},
				{
					toolName: "Write",
					toolInput: { file_path: "test/auth.test.ts" },
					toolOutput: "Added token validation tests covering expired, malformed, and valid cases."
				},
				{
					toolName: "Bash",
					toolInput: { command: "npm test" },
					toolOutput: "All 12 auth tests passing."
				}
			]
		},
		{
			id: generateId("demo"),
			title: "Session 2: Database migration debugging",
			observations: [{
				toolName: "Read",
				toolInput: { file_path: "prisma/schema.prisma" },
				toolOutput: "Found N+1 query issue in user relations. Need to add include on posts query."
			}, {
				toolName: "Edit",
				toolInput: { file_path: "src/api/users.ts" },
				toolOutput: "Fixed N+1 by adding Prisma include. Query time dropped from 450ms to 28ms."
			}]
		},
		{
			id: generateId("demo"),
			title: "Session 3: Rate limiting",
			observations: [{
				toolName: "Write",
				toolInput: { file_path: "src/middleware/ratelimit.ts" },
				toolOutput: "Added rate limiting middleware with 100 req/min default. Uses in-memory store for dev, Redis for prod."
			}]
		}
	];
}
async function postJson(url, body, timeoutMs = 5e3) {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...bearerHeaders(url)
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (!res.ok) return null;
		return await res.json().catch(() => null);
	} catch {
		return null;
	}
}
async function postJsonStrict(url, body, timeoutMs = 5e3) {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...bearerHeaders(url)
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!res.ok) {
		const errBody = await res.text().catch(() => "");
		const suffix = errBody ? ` — ${errBody.slice(0, 200)}` : "";
		throw new Error(`POST ${url} failed: ${res.status} ${res.statusText}${suffix}`);
	}
	return await res.json().catch(() => null);
}
async function seedDemoSession(base, project, session) {
	await postJsonStrict(`${base}/agentmemory/session/start`, {
		sessionId: session.id,
		project,
		cwd: project
	});
	let stored = 0;
	for (const obs of session.observations) {
		const url = `${base}/agentmemory/observe`;
		const payload = {
			hookType: "post_tool_use",
			sessionId: session.id,
			project,
			cwd: project,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: {
				tool_name: obs.toolName,
				tool_input: obs.toolInput,
				tool_output: obs.toolOutput
			}
		};
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...bearerHeaders(url)
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(5e3)
			});
			if (res.ok) stored++;
			else {
				const body = await res.text().catch(() => "");
				p.log.warn(`observe failed for ${obs.toolName}: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 160)}` : ""}`);
			}
		} catch (err) {
			p.log.warn(`observe request failed for ${obs.toolName}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	await postJsonStrict(`${base}/agentmemory/session/end`, {
		sessionId: session.id,
		final: true
	});
	return stored;
}
async function runDemoSearch(base, query) {
	const items = (await postJson(`${base}/agentmemory/smart-search`, {
		query,
		limit: 5
	}, 1e4))?.results ?? [];
	return {
		query,
		hits: items.length,
		topTitle: items[0]?.title ?? "(no results)"
	};
}
function findEnvExample() {
	const candidates = [
		join(__dirname, "..", ".env.example"),
		join(__dirname, ".env.example"),
		join(process.cwd(), ".env.example")
	];
	for (const c of candidates) if (existsSync(c)) return c;
	return null;
}
async function runInit() {
	p.intro("agentmemory init");
	const target = join(homedir(), ".agentmemory", ".env");
	const template = findEnvExample();
	if (!template) {
		p.log.error("Could not locate .env.example in the package. Re-install with: npm i -g @agentmemory/agentmemory");
		process.exit(1);
	}
	const dir = dirname(target);
	const { mkdir, copyFile } = await import("node:fs/promises");
	const { constants: fsConstants } = await import("node:fs");
	try {
		await mkdir(dir, { recursive: true });
		await copyFile(template, target, fsConstants.COPYFILE_EXCL);
	} catch (err) {
		if (err?.code === "EEXIST") {
			p.log.warn(`${target} already exists — leaving it untouched.`);
			p.log.info(`Compare against the latest template: diff ${target} ${template}`);
			p.outro("Nothing changed.");
			return;
		}
		p.log.error(`Failed to copy template: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
	p.log.success(`Wrote ${target}`);
	p.note([
		"All keys are commented out by default. Uncomment the ones you want.",
		"",
		"Common next steps:",
		"  1. Pick an LLM provider key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / etc.)",
		"  2. Run `npx @agentmemory/agentmemory doctor` to verify the daemon sees them",
		"  3. Run `npx @agentmemory/agentmemory` to start the worker"
	].join("\n"), "Next steps");
	p.outro(`Edit ${target} and you're set.`);
}
async function startServerForDemo() {
	startupTimeouts();
	await assertRuntimePortOwnership();
	if (await isAgentmemoryReady()) return async () => {};
	beginStartup();
	const startedEngine = !skipEngine && !(await isEngineRunning() || await waitForPersistedNativeEngine());
	if (startedEngine) {
		if (!await startEngine()) {
			p.log.error("Could not start iii-engine for the demo.");
			p.note(installInstructions().join("\n"), "Setup required");
			throw new Error("iii-engine could not be started for the demo.");
		}
		if (!await waitForEngine()) {
			printCapturedStartupStderr();
			printDockerStartupLogs();
			throw new Error(startupTimeoutMessage("engine", startupTimeouts().engineMs));
		}
	}
	await startWorkerForEngineState();
	return async () => {
		if (importedStartupWorker && readWorkerPidfile() === process.pid) clearWorkerPidfile();
		if (startedEngine) await cleanupFailedStartup();
	};
}
async function runDemo() {
	const port = getRestPort();
	const base = `http://localhost:${port}`;
	p.intro("agentmemory demo");
	const serve = args.includes("--serve");
	let teardown = async () => {};
	if (serve) teardown = await startServerForDemo();
	else if (!await isAgentmemoryReady()) {
		p.log.error(`agentmemory worker not reachable on port ${port} (livez probe failed). Something may be on the port but it isn't serving /agentmemory/*.`);
		p.log.info("Start it with: npx @agentmemory/agentmemory");
		p.log.info("Or run a one-command demo with: npx @agentmemory/agentmemory demo --serve");
		process.exit(1);
	}
	try {
		await runDemoBody(base);
	} finally {
		await teardown();
	}
	if (serve) process.exit(0);
}
async function runDemoBody(base) {
	const demoProject = "/tmp/agentmemory-demo";
	const sessions = buildDemoSessions();
	const sSeed = p.spinner();
	sSeed.start("Seeding 3 demo sessions with realistic observations...");
	let totalObs = 0;
	for (const session of sessions) totalObs += await seedDemoSession(base, demoProject, session);
	sSeed.stop(`Seeded ${totalObs} observations across ${sessions.length} sessions`);
	const queries = [
		"jwt auth middleware",
		"database performance optimization",
		"rate limiting"
	];
	const sQuery = p.spinner();
	sQuery.start(`Running ${queries.length} smart-search queries...`);
	const results = [];
	for (const query of queries) results.push(await runDemoSearch(base, query));
	sQuery.stop("Search complete");
	const semanticHits = results.find((r) => r.query === "database performance optimization")?.hits ?? 0;
	const lines = [
		`Project:       ${demoProject}`,
		`Sessions:      ${sessions.length} seeded (${totalObs} observations)`,
		"",
		c.label("Search results:"),
		...results.flatMap((r) => [`  ${c.label(`"${r.query}"`)}`, `    ${c.dim("→")} ${c.ok(`${r.hits} hit(s)`)}, top: ${r.topTitle.slice(0, 60)}`]),
		"",
		...semanticHits > 0 ? [c.accent(`Notice: searching "database performance optimization"`), c.accent(`found the N+1 query fix — keyword matching can't do that.`)] : [
			c.dim(`Note: "database performance optimization" found nothing —`),
			c.dim(`set EMBEDDING_PROVIDER=local for on-device semantic recall,`),
			c.dim(`or add an embedding API key in ~/.agentmemory/.env.`)
		],
		"",
		`Viewer:        ${c.url(getViewerUrl())}`,
		`Clean up with: ${c.dim(`curl -X DELETE "${base}/agentmemory/sessions?project=${demoProject}"`)}`
	];
	p.note(lines.join("\n"), "demo complete");
	p.log.success("agentmemory is working. Point your agent at it and get back to coding.");
}
function runCommand(command, commandArgs, options = { label: "command" }) {
	const spinner = p.spinner();
	spinner.start(options.label);
	const result = spawnSync(command, commandArgs, {
		cwd: options.cwd || process.cwd(),
		stdio: "pipe",
		encoding: "utf-8",
		...options.timeoutMs !== void 0 ? {
			timeout: options.timeoutMs,
			killSignal: "SIGKILL"
		} : {}
	});
	if (result.status === 0) {
		spinner.stop(`${options.label} ${pc.green("✓")}`);
		return true;
	}
	const stderr = (result.stderr || "").toString().trim();
	const stdout = (result.stdout || "").toString().trim();
	const msg = stderr || stdout || "unknown error";
	if (options.optional) {
		spinner.stop(`${options.label} (skipped)`);
		p.log.warn(msg.slice(0, 300));
		return false;
	}
	spinner.stop(`${options.label} ${pc.red("✗")}`);
	p.log.error(msg.slice(0, 300));
	return false;
}
async function runUpgrade() {
	p.intro("agentmemory upgrade");
	const cwd = process.cwd();
	const hasPackageJson = existsSync(join(cwd, "package.json"));
	const hasPnpmLock = existsSync(join(cwd, "pnpm-lock.yaml"));
	const pnpmBin = whichBinary("pnpm");
	const npmBin = whichBinary("npm");
	const dockerBin = whichBinary("docker");
	p.log.info(`Working directory: ${cwd}`);
	const requireSuccess = (ok, label) => {
		if (!ok) {
			p.log.error(`Upgrade aborted: ${label} failed.`);
			process.exit(1);
		}
	};
	if (hasPackageJson) if (!!pnpmBin && hasPnpmLock && pnpmBin) {
		requireSuccess(runCommand(pnpmBin, ["install"], { label: "Refreshing dependencies (pnpm install)" }), "pnpm install");
		runCommand(pnpmBin, [
			"up",
			`iii-sdk@${IIPINNED_DEFAULT_VERSION}`,
			`@iii-dev/helpers@${IIPINNED_DEFAULT_VERSION}`
		], {
			label: `Pinning iii-sdk and @iii-dev/helpers at ${IIPINNED_DEFAULT_VERSION}`,
			optional: true
		});
	} else if (npmBin) {
		requireSuccess(runCommand(npmBin, ["install"], { label: "Refreshing dependencies (npm install)" }), "npm install");
		runCommand(npmBin, [
			"install",
			`iii-sdk@${IIPINNED_DEFAULT_VERSION}`,
			`@iii-dev/helpers@${IIPINNED_DEFAULT_VERSION}`
		], {
			label: `Pinning iii-sdk and @iii-dev/helpers at ${IIPINNED_DEFAULT_VERSION}`,
			optional: true
		});
	} else p.log.warn("No package manager found (pnpm/npm). Skipping JS dependency upgrade.");
	else p.log.warn("No package.json in current directory. Skipping JS dependency upgrade.");
	const upgradeEngine = await p.confirm({
		message: "Re-run the iii-engine install script (curl | sh)?",
		initialValue: true
	});
	if (p.isCancel(upgradeEngine)) {
		p.cancel("Cancelled.");
		return process.exit(0);
	}
	if (upgradeEngine === true) await runIiiInstaller();
	else p.log.info("Skipped iii-engine installer.");
	if (dockerBin) runCommand(dockerBin, ["pull", `iiidev/iii:${IIPINNED_VERSION}`], {
		label: `Pulling iii Docker image v${IIPINNED_VERSION} (pinned)`,
		optional: true
	});
	else p.log.info("Docker not found. Skipping Docker image refresh.");
	p.note([
		"Upgrade flow completed.",
		"",
		"Recommended next steps:",
		"  1) agentmemory status",
		"  2) npm/pnpm test",
		"  3) restart agentmemory process"
	].join("\n"), "agentmemory upgrade");
}
function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		if (!IS_WINDOWS) try {
			const stat = execFileSync("ps", [
				"-p",
				String(pid),
				"-o",
				"stat="
			], {
				encoding: "utf-8",
				stdio: [
					"ignore",
					"pipe",
					"ignore"
				]
			});
			if (stat.trim() && !processStatIsRunning(stat)) return false;
		} catch {}
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}
async function signalAndWait(pid, initialSignal, timeoutMs) {
	try {
		process.kill(pid, initialSignal);
	} catch (err) {
		const code = err?.code;
		if (code === "ESRCH") return true;
		if (code === "EPERM") {
			p.log.warn(`No permission to signal pid ${pid}. Try: kill ${pid}`);
			return false;
		}
		vlog(`${initialSignal} ${pid}: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	if (!pidAlive(pid)) return true;
	try {
		process.kill(pid, "SIGKILL");
	} catch (err) {
		if (err?.code === "ESRCH") return true;
		vlog(`SIGKILL ${pid}: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
	await new Promise((r) => setTimeout(r, 200));
	return !pidAlive(pid);
}
async function waitForEngineFlush() {
	let stateBackend = "file";
	try {
		stateBackend = getStateBackend();
	} catch {}
	const runtimePath = runtimeConfigPath(dataDirResolution.dataDir);
	const configTexts = [];
	for (const path of engineStateConfigPaths(join(homedir(), ".agentmemory"), runtimePath)) try {
		configTexts.push(readFileSync(path, "utf-8"));
	} catch {}
	const waitMs = engineFlushWaitMs(stateBackend, configTexts);
	if (waitMs <= 0) return;
	const s = p.spinner();
	s.start(`Waiting ${(waitMs / 1e3).toFixed(1)}s for iii-engine to write state to disk...`);
	await new Promise((r) => setTimeout(r, waitMs));
	s.stop("iii-engine state flush window passed");
}
async function stopWorkerPid(pid, graceMs) {
	const s = p.spinner();
	s.start(`Stopping agentmemory worker (pid ${pid})... [flushing state]`);
	const ok = await signalAndWait(pid, "SIGTERM", graceMs);
	s.stop(ok ? `Stopped worker pid ${pid}` : `Failed to stop worker pid ${pid}`);
	return ok;
}
async function stopNativeEngineForRemoval() {
	const port = getRestPort();
	const workerPid = readWorkerPidfile();
	const enginePids = new Set(findEnginePidsByPort(port));
	const pidfilePid = readEnginePidfile();
	if (pidfilePid) enginePids.add(pidfilePid);
	if (workerPid) enginePids.delete(workerPid);
	const foreign = [...enginePids].map((pid) => ({
		pid,
		comm: pidCommand(pid)
	})).filter(({ comm }) => isForeignPortHolder(comm));
	if (foreign.length > 0) return {
		ok: false,
		reason: `refusing to signal non-iii process(es): ${foreign.map(({ pid, comm }) => `${pid} (${comm})`).join(", ")}`
	};
	if (workerPid) {
		if (!await stopWorkerPid(workerPid, 5e3)) return {
			ok: false,
			reason: `worker pid ${workerPid} could not be stopped; no engine or files were removed`
		};
		clearWorkerPidfile();
	}
	for (const pid of enginePids) {
		const s = p.spinner();
		s.start(`Stopping iii-engine (pid ${pid})...`);
		const ok = await signalAndWait(pid, "SIGTERM", 3e3);
		s.stop(ok ? `Stopped pid ${pid}` : `Failed to stop pid ${pid}`);
		if (!ok) return {
			ok: false,
			reason: `engine pid ${pid} survived shutdown; lifecycle state and files were preserved`
		};
	}
	clearEnginePidfile();
	clearEngineState();
	clearWorkerPidfile();
	return {
		ok: true,
		stoppedEnginePids: enginePids.size
	};
}
function pidCommand(pid) {
	if (IS_WINDOWS) return "";
	try {
		return execFileSync("ps", [
			"-p",
			String(pid),
			"-o",
			"comm="
		], {
			encoding: "utf-8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		}).trim();
	} catch {
		return "";
	}
}
function isForeignPortHolder(comm) {
	if (!comm) return false;
	const base = comm.split("/").pop() || comm;
	return base !== "iii" && !base.startsWith("iii-");
}
function findEnginePidsByPort(port) {
	if (IS_WINDOWS) return [];
	const lsof = whichBinary("lsof");
	if (!lsof) return [];
	const selfPid = process.pid;
	try {
		return execFileSync(lsof, [
			"-i",
			`:${port}`,
			"-sTCP:LISTEN",
			"-t"
		], {
			encoding: "utf-8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		}).split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 0 && n !== selfPid);
	} catch (err) {
		vlog(`lsof :${port}: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}
async function stopDockerEngine(state, port, suppressOutro = false) {
	const dockerBin = whichBinary("docker");
	if (!dockerBin) {
		p.log.error("Engine was started via Docker, but `docker` is no longer on PATH. Lifecycle state was preserved.");
		process.exit(1);
	}
	const inspection = inspectOwnedDockerEngine(state);
	if (inspection.status === "unavailable") {
		p.log.error(`The saved Docker engine cannot be verified: ${inspection.reason}. Refusing to stop or clear ownership state.`);
		process.exit(1);
	}
	const resolvedState = persistDockerInspection(state, inspection);
	const workerPid = readWorkerPidfile();
	if (workerPid && !await stopWorkerPid(workerPid, 5e3)) {
		p.log.error("The agentmemory worker could not be stopped; Docker ownership state was preserved.");
		process.exit(1);
	}
	clearWorkerPidfile();
	if (inspection.status === "running" || inspection.status === "stopped") {
		if (inspection.status === "running" && !runCommand(dockerBin, [
			"stop",
			"--time",
			"10",
			inspection.containerId
		], { label: `Stopping preserved Docker container ${inspection.containerId}` })) {
			p.log.error("The Docker container could not be stopped; ownership state was preserved.");
			process.exit(1);
		}
		clearEnginePidfile();
		writeEngineState(resolvedState);
		if (!suppressOutro) p.outro("Stopped. The validated Docker container and data mount were preserved for a lossless restart.");
		return;
	}
	const projectName = inspection.projectName ?? resolvedState.projectName;
	if (!projectName) {
		p.log.error("No verified Docker Compose project name is available. Refusing an unscoped stop.");
		process.exit(1);
	}
	const effectiveComposeFile = existsSync(inspection.composeFile) ? inspection.composeFile : discoverComposeFile();
	if (!effectiveComposeFile) {
		p.log.error("No agentmemory compose file is available. Docker ownership state was preserved.");
		process.exit(1);
	}
	const composeText = readFileSync(effectiveComposeFile, "utf-8");
	const ownServices = ["iii-engine", "iii-init"].filter((service) => new RegExp(`^\\s+${service}:`, "m").test(composeText));
	if (ownServices.length === 0) {
		p.log.error(`${effectiveComposeFile} does not define iii-engine or iii-init. Refusing an unscoped stop.`);
		process.exit(1);
	}
	const composeCommand = ["docker", ...dockerComposeArgs(effectiveComposeFile, projectName, [])].join(" ");
	if (runCommand(dockerBin, dockerComposeArgs(effectiveComposeFile, projectName, [
		"rm",
		"-s",
		"-f",
		...ownServices
	]), { label: `${composeCommand} rm -s -f ${ownServices.join(" ")}` })) {
		clearEnginePidfile();
		clearEngineState();
	} else {
		p.log.error(`docker compose rm failed. The engine may still be running on :${port}. Inspect with:\n  ${composeCommand} ps`);
		process.exit(1);
	}
	if (!suppressOutro) p.outro("Stopped. Memories persisted to disk; restart anytime with: npx @agentmemory/agentmemory");
}
async function runStop() {
	await assertRuntimePortOwnership();
	p.intro("agentmemory stop");
	const port = getRestPort();
	const state = readEngineState();
	const running = await isEngineRunning();
	const force = args.includes("--force");
	if (state?.kind === "docker") {
		if (!running) p.log.info(`No engine responding on port ${port}.`);
		await stopDockerEngine(state, port);
		return;
	}
	const portPids = findEnginePidsByPort(port);
	const pidfilePid = readEnginePidfile();
	const workerPid = readWorkerPidfile();
	if (!running) {
		if (portPids.length === 0 && pidfilePid === null && workerPid === null) {
			clearEnginePidfile();
			clearEngineState();
			clearWorkerPidfile();
			p.outro("Nothing to stop.");
			return;
		}
		if (workerPid !== null && portPids.length === 0 && pidfilePid === null) {
			const s = p.spinner();
			s.start(`Stopping orphaned agentmemory worker (pid ${workerPid})...`);
			const ok = await signalAndWait(workerPid, "SIGTERM", SHUTDOWN_HARD_EXIT_MS + 1e3);
			s.stop(ok ? `Stopped worker pid ${workerPid}` : `Failed to stop worker pid ${workerPid}`);
			clearEnginePidfile();
			clearEngineState();
			clearWorkerPidfile();
			if (!ok) {
				p.log.error(`Worker pid ${workerPid} survived SIGKILL. Investigate with \`ps\`.`);
				process.exit(1);
			}
			p.outro("Stopped orphaned worker. Memories persisted to disk.");
			return;
		}
		const survivors = new Set(portPids);
		if (pidfilePid) survivors.add(pidfilePid);
		if (workerPid) survivors.add(workerPid);
		p.log.warn(`Engine not responding on :${port}, but ${survivors.size} process(es) still hold the port or pidfile: ${[...survivors].join(", ")}`);
		p.log.info(`Preserving ~/.agentmemory/iii.pid + worker.pid. Investigate before manual cleanup:\n  ps -p ${[...survivors].join(",")} -o pid,ppid,comm,etime\n  ${IS_WINDOWS ? "netstat -ano | findstr :" + port : "lsof -i :" + port}`);
		process.exit(1);
	}
	if (!state) {
		const compose = discoverComposeFile();
		if (compose && pidfilePid === null) if (force) p.log.warn(`--force: bypassing Docker-heuristic guard. Falling back to native pidfile + lsof on :${port}.`);
		else {
			p.log.error(`Engine is running on :${port} but no pidfile or state file is present. It may have been started via Docker compose by a different shell. Refusing to signal host PIDs.\n\nStop it with:\n  docker compose -f ${compose} down\n\nOr re-run with --force to signal whatever lsof finds on :${port}, or AGENTMEMORY_USE_DOCKER=1 to record state next time.`);
			process.exit(1);
		}
	}
	const candidates = /* @__PURE__ */ new Set();
	if (pidfilePid) candidates.add(pidfilePid);
	for (const pid of portPids) candidates.add(pid);
	const workerCandidates = /* @__PURE__ */ new Set();
	if (workerPid) workerCandidates.add(workerPid);
	if (candidates.size === 0 && workerCandidates.size === 0) {
		p.log.error(`Could not locate engine process. Try:\n  ${IS_WINDOWS ? "netstat -ano | findstr :" + port : "lsof -i :" + port + " -t | xargs kill -9"}`);
		process.exit(1);
	}
	let allStopped = true;
	for (const pid of workerCandidates) if (!await stopWorkerPid(pid, 9e3)) allStopped = false;
	if (workerCandidates.size > 0 && [...candidates].some((pid) => !workerCandidates.has(pid))) await waitForEngineFlush();
	const skippedForeign = [];
	for (const pid of candidates) {
		if (workerCandidates.has(pid)) continue;
		const comm = pidCommand(pid);
		if (!force && isForeignPortHolder(comm)) {
			skippedForeign.push({
				pid,
				comm
			});
			continue;
		}
		const s = p.spinner();
		s.start(`Stopping iii-engine (pid ${pid})...`);
		const ok = await signalAndWait(pid, "SIGTERM", 3e3);
		s.stop(ok ? `Stopped pid ${pid}` : `Failed to stop pid ${pid}`);
		if (!ok) allStopped = false;
	}
	clearEnginePidfile();
	clearEngineState();
	clearWorkerPidfile();
	if (skippedForeign.length > 0) {
		const list = skippedForeign.map((sf) => `  pid ${sf.pid}  ${sf.comm}`).join("\n");
		p.log.error(`Refused to signal process(es) holding :${port} that are not the iii engine:\n${list}\n\nIf the engine runs in Docker, stop it there:\n  docker compose ps && docker compose rm -s -f <service>\n\nOr re-run with --force to signal them anyway.`);
		process.exit(1);
	}
	if (!allStopped) {
		p.log.error("One or more processes survived SIGKILL. Investigate with `ps`.");
		process.exit(1);
	}
	p.outro("Stopped. Memories persisted to disk; restart anytime with: npx @agentmemory/agentmemory");
}
async function runMcp() {
	await import("./standalone-BovYdgLL.mjs");
}
async function runConnectCmd() {
	const { runConnect } = await import("./connect-lMnCKiNM.mjs").then((n) => n.n);
	await runConnect(args.slice(1));
}
async function runImportJsonl() {
	const VALUE_FLAGS = new Set([
		"--port",
		"--tools",
		"--data-dir"
	]);
	let maxFiles;
	const tail = args.slice(1);
	const positional = [];
	for (let i = 0; i < tail.length; i++) {
		const a = tail[i];
		if (a === "--max-files") {
			const raw = tail[i + 1];
			const parsed = raw !== void 0 ? parseInt(raw, 10) : NaN;
			if (Number.isInteger(parsed) && parsed > 0) maxFiles = parsed;
			else if (raw !== void 0) p.log.warn(`Ignoring --max-files ${raw}: expected a positive integer.`);
			i++;
			continue;
		}
		if (a.startsWith("--max-files=")) {
			const raw = a.slice(12);
			const parsed = parseInt(raw, 10);
			if (Number.isInteger(parsed) && parsed > 0) maxFiles = parsed;
			else p.log.warn(`Ignoring --max-files=${raw}: expected a positive integer.`);
			continue;
		}
		if (VALUE_FLAGS.has(a)) {
			i++;
			continue;
		}
		if (a.startsWith("-")) continue;
		positional.push(a);
	}
	const pathArg = positional[0];
	const port = getRestPort();
	const base = `http://localhost:${port}`;
	let probeOk = false;
	let probeDetail = "";
	try {
		const probe = await fetch(`${base}/agentmemory/livez`, { signal: AbortSignal.timeout(2e3) });
		probeOk = probe.ok;
		if (!probeOk) {
			const probeBody = await probe.text().catch(() => "");
			probeDetail = `reachable but unhealthy (HTTP ${probe.status}${probeBody ? `: ${probeBody.slice(0, 200)}` : ""})`;
		}
	} catch (err) {
		probeOk = false;
		probeDetail = `unreachable (${err instanceof Error ? err.message : String(err)})`;
	}
	if (!probeOk) {
		p.log.error(`agentmemory livez probe failed on port ${port}: ${probeDetail}. Start it with \`npx @agentmemory/agentmemory\` in another terminal, then re-run this command.`);
		process.exit(1);
	}
	const body = {};
	if (pathArg) body["path"] = resolve(pathArg.startsWith("~") ? join(homedir(), pathArg.slice(1)) : pathArg);
	if (maxFiles !== void 0) body["maxFiles"] = maxFiles;
	const headers = {
		"content-type": "application/json",
		...bearerHeaders(base)
	};
	p.log.info(`Importing JSONL from ${pathArg || "~/.claude/projects"}…`);
	const spinner = p.spinner();
	spinner.start("scanning files");
	try {
		const res = await fetch(`${base}/agentmemory/replay/import-jsonl`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(12e4)
		});
		const text = await res.text();
		let json = {};
		if (text.length > 0) try {
			json = JSON.parse(text);
		} catch {
			spinner.stop("failed");
			p.log.error(`server returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
			process.exit(1);
		}
		if (!res.ok || json.success !== true) {
			spinner.stop("failed");
			const detail = json.error || (text.length === 0 ? "empty response body" : json.success === void 0 ? `HTTP ${res.status} (response missing success field)` : `HTTP ${res.status}`);
			if (res.status === 401) p.log.error(`${detail}. Set AGENTMEMORY_SECRET to match the server's secret and re-run.`);
			else if (res.status === 404) p.log.error(`${detail}. The running agentmemory server does not expose /agentmemory/replay/import-jsonl — upgrade to v0.8.13 or later.`);
			else p.log.error(detail);
			process.exit(1);
		}
		spinner.stop(`imported ${json.imported ?? 0} file(s), ${json.observations ?? 0} observation(s) across ${json.sessionIds?.length || 0} session(s)`);
		if (json.truncated) {
			const cap = json.maxFiles ?? 200;
			const upper = json.maxFilesUpperBound ?? 1e3;
			const discovered = json.discovered ?? 0;
			const baseMsg = `Hit the ${cap}-file scan cap; ${discovered - (json.imported ?? 0)} of ${json.traversalCapped ? `${discovered}+ (traversal halted at safety cap)` : String(discovered)} discovered file(s) were skipped.`;
			if (discovered > upper || json.traversalCapped) p.log.warn(`${baseMsg} Tree exceeds the server's --max-files limit of ${upper}; batch by subdirectory (run import-jsonl once per project under ~/.claude/projects).`);
			else {
				const suggested = Math.min(Math.max((discovered || cap) + 100, cap * 2), upper);
				p.log.warn(`${baseMsg} Re-run with --max-files=${suggested} (max ${upper}) or batch by subdirectory.`);
			}
		}
		if (json.sessionIds && json.sessionIds.length > 0) p.log.info(`View at ${getViewerUrl()} → Replay tab`);
	} catch (err) {
		spinner.stop("failed");
		if (err instanceof Error && err.name === "TimeoutError") p.log.error("import timed out after 2 minutes");
		else p.log.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
function loadConnectManifest(home) {
	const path = join(home, ".agentmemory", "backups", "connect-manifest.json");
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed?.installed)) return { installed: parsed.installed };
		return null;
	} catch {
		return null;
	}
}
function probeLocalBinIiiVersion(home) {
	const path = legacyLocalBinIii(home);
	if (!existsSync(path)) return null;
	return iiiBinVersion(path);
}
function safeDelete(path) {
	try {
		if (!existsSync(path)) return {
			ok: true,
			message: `not present (${path})`
		};
		if (statSync(path).isDirectory()) rmSync(path, {
			recursive: true,
			force: true
		});
		else unlinkSync(path);
		return {
			ok: true,
			message: `deleted ${path}`
		};
	} catch (err) {
		return {
			ok: false,
			message: `failed ${path}: ${err instanceof Error ? err.message : String(err)}`
		};
	}
}
async function runRemove() {
	if (selectedInstance !== 0) {
		p.intro("agentmemory remove");
		p.log.error(`remove is a global uninstall and cannot target instance ${selectedInstance}. Stop that daemon with \`agentmemory stop --instance ${selectedInstance}\`, then run \`agentmemory remove\` without --instance when you intend to uninstall shared assets.`);
		process.exit(1);
	}
	await assertRuntimePortOwnership();
	p.intro("agentmemory remove");
	const force = args.includes("--force");
	const keepData = args.includes("--keep-data");
	const ownedState = readEngineState();
	if (ownedState?.kind === "docker") {
		const inspection = inspectOwnedDockerEngine(ownedState);
		if (inspection.status === "running" || inspection.status === "stopped") {
			persistDockerInspection(ownedState, inspection);
			if (!keepData) {
				p.log.error(`Docker-backed removal requires --keep-data so the validated ${inspection.dataMountType} data mount (${inspection.dataMountSource}) and its recovery metadata remain usable. Re-run \`agentmemory remove --keep-data\`; destructive Docker data deletion is intentionally not automated.`);
				process.exit(1);
			}
		} else {
			const detail = inspection.status === "unavailable" ? inspection.reason : "the owned container is missing";
			p.log.error(`remove cannot safely reconcile the saved Docker ownership (${detail}). Lifecycle state was preserved for manual recovery.`);
			process.exit(1);
		}
	}
	const home = homedir();
	const connectManifest = loadConnectManifest(home);
	const localBinIiiVersion = probeLocalBinIiiVersion(home);
	const options = {
		force,
		keepData,
		preserveRuntimeState: ownedState?.kind === "docker"
	};
	const plan = buildRemovePlan({
		home,
		runtimeDir: dirname(engineStatePath()),
		dataDir: dataDirResolution.dataDir,
		pinnedVersion: IIPINNED_VERSION,
		localBinIiiVersion,
		connectManifest
	}, options);
	if (plan.filter((it) => it.applicable).length === 0) {
		p.outro("Nothing to remove. agentmemory is already gone.");
		return;
	}
	p.note(formatPlan(plan), "destruction plan");
	if (!force) {
		const proceed = await p.confirm({
			message: "Proceed with these deletions?",
			initialValue: false
		});
		if (p.isCancel(proceed) || proceed !== true) {
			p.cancel("Cancelled. Nothing was deleted.");
			return;
		}
		const sure = await p.confirm({
			message: "This is irreversible. Continue?",
			initialValue: false
		});
		if (p.isCancel(sure) || sure !== true) {
			p.cancel("Cancelled. Nothing was deleted.");
			return;
		}
	}
	for (const item of plan) {
		if (!item.applicable) continue;
		if (item.alwaysAsk) {
			const ok = await p.confirm({
				message: `${item.description} — really delete${item.path ? ` ${item.path}` : ""}?`,
				initialValue: false
			});
			if (p.isCancel(ok) || ok !== true) {
				p.log.info(`skipped: ${item.id}`);
				continue;
			}
		}
		if (item.id === "stop-engine") {
			if (ownedState?.kind === "docker") {
				await stopDockerEngine(ownedState, getRestPort(), true);
				p.log.success("stopped Docker engine; container, data mount, and recovery state preserved");
				continue;
			}
			const stopped = await stopNativeEngineForRemoval();
			if (!stopped.ok) {
				p.log.error(`Removal aborted: ${stopped.reason}.`);
				process.exit(1);
			}
			p.log.success(stopped.stoppedEnginePids > 0 ? `stopped engine (${stopped.stoppedEnginePids} pid${stopped.stoppedEnginePids === 1 ? "" : "s"})` : "no engine running");
			continue;
		}
		if (!item.path) continue;
		const r = safeDelete(item.path);
		if (r.ok) p.log.success(r.message);
		else p.log.error(r.message);
	}
	p.outro("Done. agentmemory cleanly removed. The npm package itself: npm uninstall -g @agentmemory/agentmemory");
}
async function runConsole() {
	const iiiBin = pickCompatibleIii([whichBinary("iii"), ...fallbackIiiPaths().filter((candidate) => existsSync(candidate))]);
	if (!iiiBin) {
		p.log.error(`No iii v${IIPINNED_VERSION} found. Start agentmemory once so it installs the pinned engine into ${privateIiiPath()}, then run this again.`);
		process.exit(1);
	}
	let parsed;
	try {
		parsed = parseConsoleArgs(args.slice(1), defaultConsolePort(getConfiguredViewerPort()));
	} catch (err) {
		p.log.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
	const launch = {
		iiiBin,
		consolePort: parsed.consolePort,
		restPort: getRestPort(),
		streamPort: getStreamPort(),
		enginePort: getEnginePort(),
		extraArgs: parsed.extraArgs
	};
	if (!await isEngineRunning()) p.log.warn(`No engine responding on port ${launch.restPort}. The console starts anyway and connects once agentmemory is up.`);
	p.log.info(`iii console: http://127.0.0.1:${launch.consolePort} (engine REST ${launch.restPort}, streams ${launch.streamPort}, bridge ${launch.enginePort}). The first run downloads the console binary next to the pinned iii.`);
	const child = spawn(iiiBin, consoleArgs(launch), {
		stdio: "inherit",
		detached: true
	});
	const forward = (signal) => {
		try {
			process.kill(-child.pid, signal);
		} catch {
			child.kill(signal);
		}
	};
	for (const signal of [
		"SIGINT",
		"SIGTERM",
		"SIGHUP"
	]) process.on(signal, () => forward(signal));
	const code = await new Promise((resolve) => {
		child.on("exit", (status, signal) => resolve(status ?? (signal ? 1 : 0)));
		child.on("error", (err) => {
			p.log.error(err.message);
			resolve(1);
		});
	});
	process.exit(code);
}
async function runCapture() {
	const code = await runCaptureCommand({
		base: getBaseUrl(),
		args: args.slice(1),
		secret: resolveClientSecret(getBaseUrl())
	});
	process.exit(code);
}
async function runCompression() {
	const base = getBaseUrl();
	const code = await runCompressionCommand({
		base,
		args: args.slice(1),
		secret: resolveClientSecret(base)
	});
	process.exit(code);
}
async function runGraphIndex() {
	const base = getBaseUrl();
	process.exit(await runGraphIndexCommand({
		base,
		args: args.slice(1),
		secret: resolveClientSecret(base)
	}));
}
const commands = {
	init: runInit,
	connect: runConnectCmd,
	status: runStatus,
	console: runConsole,
	doctor: runDoctor,
	demo: runDemo,
	upgrade: runUpgrade,
	stop: runStop,
	remove: runRemove,
	mcp: runMcp,
	"import-jsonl": runImportJsonl,
	capture: runCapture,
	compression: runCompression,
	"graph-index": runGraphIndex
};
const first = args[0] ?? "";
async function unknownCommand() {
	p.log.error(`Unknown command: ${first}. Supported: ${Object.keys(commands).join(", ")}. Run \`agentmemory\` with no arguments to start the memory server, or \`agentmemory --help\` for usage.`);
	process.exit(1);
}
(commands[first] ?? (first && !first.startsWith("-") ? unknownCommand : main))().catch(async (err) => {
	p.log.error(err instanceof Error ? err.message : String(err));
	const exitCode = await runStartupCleanup(1).catch(() => 1);
	process.exit(exitCode);
});
//#endregion
export { discoverViewerPort };

//# sourceMappingURL=cli.mjs.map
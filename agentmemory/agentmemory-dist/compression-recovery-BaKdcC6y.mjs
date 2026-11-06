import { a as KV, c as generateId, d as segmentCjk, n as isKeyedLockHeld, o as STREAM, r as withKeyedLock, s as fingerprintId, t as afterKeyedLock, u as hasCjk } from "./keyed-mutex-B2ARAhzY.mjs";
import { $ as isGraphExtractionEnabled, U as getVectorBackfillMax, _ as safeAudit, c as memoryToObservation, d as isSearchResultLayer, f as matchesSearchLayer, h as recordAudit, k as getAgentId, l as getSearchResultLayer, o as buildRecallResponse, q as isAgentScopeIsolated, tt as isVectorBackfillAllEnabled, u as isSearchLayer, ut as logger } from "./secret-store-BIHNFqsl.mjs";
import { i as isManagedImagePath } from "./image-store-BsN4vyjr.mjs";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, platform } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { TriggerAction } from "iii-sdk";
import { z } from "zod";
//#region src/runtime-paths.ts
function runtimeMetadataPath(name, options = {}) {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	return join(env["AGENTMEMORY_RUNTIME_DIR"] ? resolve(env["AGENTMEMORY_RUNTIME_DIR"]) : join(home, ".agentmemory"), name);
}
//#endregion
//#region src/shutdown.ts
const SHUTDOWN_FLUSH_TIMEOUT_MS = 4e3;
const SHUTDOWN_HARD_EXIT_MS = 8e3;
const STARTUP_CLEANUP = Symbol.for("@agentmemory/startup-cleanup");
const startupGlobal = globalThis;
function registerStartupCleanup(cleanup) {
	const state = { cleanup };
	startupGlobal[STARTUP_CLEANUP] = state;
	return () => {
		if (startupGlobal[STARTUP_CLEANUP] === state) delete startupGlobal[STARTUP_CLEANUP];
	};
}
async function runStartupCleanup(exitCode) {
	const state = startupGlobal[STARTUP_CLEANUP];
	if (!state) return exitCode;
	state.exitCode ??= exitCode;
	state.pending ??= Promise.resolve().then(state.cleanup);
	await state.pending;
	return state.exitCode;
}
async function settleWithin(work, ms) {
	let timer;
	const expiry = new Promise((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([work.then(() => true), expiry]);
	} finally {
		clearTimeout(timer);
	}
}
//#endregion
//#region src/cli-data-dir.ts
function argValue(args, name) {
	const equals = `${name}=`;
	const inline = args.find((arg) => arg.startsWith(equals));
	if (inline) return inline.slice(equals.length);
	const idx = args.indexOf(name);
	if (idx !== -1) return args[idx + 1];
}
function expandHome(pathValue, home) {
	if (pathValue === "~") return home;
	if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) return join(home, pathValue.slice(2));
	return pathValue;
}
function absoluteDataDir(pathValue, cwd, home) {
	const expanded = expandHome(pathValue, home);
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
function platformDefaultDataDir(env, home, nodePlatform, useXdg = true) {
	if (nodePlatform === "darwin") return join(home, "Library", "Application Support", "agentmemory");
	if (nodePlatform === "win32") {
		const appData = env["APPDATA"];
		return appData ? join(appData, "agentmemory") : join(home, ".agentmemory");
	}
	const xdgDataHome = env["XDG_DATA_HOME"];
	if (useXdg && xdgDataHome && isAbsolute(xdgDataHome)) return join(xdgDataHome, "agentmemory");
	return join(home, ".local", "share", "agentmemory");
}
function nearestGitParent(pathValue) {
	let current = pathValue;
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return void 0;
		current = parent;
	}
}
function isWithin(parent, child) {
	const pathFromParent = relative(parent, child);
	return pathFromParent === "" || pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent);
}
function resolveDataDir(options = {}) {
	const args = options.args ?? process.argv.slice(2);
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const home = options.home ?? homedir();
	const nodePlatform = options.platform ?? platform();
	const parsedInstance = parseInt(argValue(args, "--instance") ?? "0", 10);
	const instance = parsedInstance > 0 && parsedInstance <= 50 ? parsedInstance : 0;
	const forInstance = (dataDir) => instance ? join(dataDir, `instance-${instance}`) : dataDir;
	const flagValue = argValue(args, "--data-dir");
	if (flagValue) return {
		dataDir: forInstance(absoluteDataDir(flagValue, cwd, home)),
		source: "flag"
	};
	const envValue = env["AGENTMEMORY_DATA_DIR"];
	if (envValue) return {
		dataDir: forInstance(absoluteDataDir(envValue, cwd, home)),
		source: "env"
	};
	const legacyDir = resolve(cwd, "data");
	const hasLegacyStore = existsSync(join(legacyDir, "state_store.db")) || existsSync(join(legacyDir, "iii-config.yaml"));
	if (instance === 0 && hasLegacyStore) return {
		dataDir: legacyDir,
		source: "default"
	};
	const defaultDir = platformDefaultDataDir(env, home, nodePlatform);
	const gitParent = nearestGitParent(cwd);
	if (gitParent && isWithin(gitParent, defaultDir)) {
		const relocated = platformDefaultDataDir(env, home, nodePlatform, false);
		if (relocated !== defaultDir) return {
			dataDir: forInstance(relocated),
			source: "default",
			relocatedFrom: defaultDir
		};
	}
	return {
		dataDir: forInstance(defaultDir),
		source: "default"
	};
}
//#endregion
//#region src/functions/privacy.ts
const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;
const SECRET_PATTERN_SOURCES = [
	/(?:api[_-]?key|secret|token|password|credential|auth)[\s]*[=:]\s*["']?[A-Za-z0-9_\-/.+]{20,}["']?/gi,
	/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
	/(?<![\p{L}\p{N}\p{M}_])sk-proj-[A-Za-z0-9\-_]{20,}/gu,
	/(?<![\p{L}\p{N}\p{M}_])(?:sk|pk|rk|ak)-[A-Za-z0-9][A-Za-z0-9\-_]{19,}/gu,
	/(?<![\p{L}\p{N}\p{M}_])sk-ant-[A-Za-z0-9\-_]{20,}/gu,
	/gh[pus]_[A-Za-z0-9]{36,}/g,
	/github_pat_[A-Za-z0-9_]{22,}/g,
	/xoxb-[A-Za-z0-9\-]+/g,
	/AKIA[0-9A-Z]{16}/g,
	/AIza[A-Za-z0-9\-_]{35}/g,
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	/npm_[A-Za-z0-9]{36}/g,
	/glpat-[A-Za-z0-9\-_]{20,}/g,
	/dop_v1_[A-Za-z0-9]{64}/g
];
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:"'<>]*:[^\s/?#@"'<>]+@/gi;
function stripPrivateData(input) {
	let result = input.replace(PRIVATE_TAG_RE, "[REDACTED]");
	result = result.replace(new RegExp(PRIVATE_KEY_BLOCK_RE.source, PRIVATE_KEY_BLOCK_RE.flags), "[REDACTED_SECRET]");
	result = result.replace(new RegExp(URL_CREDENTIALS_RE.source, URL_CREDENTIALS_RE.flags), "$1[REDACTED_SECRET]@");
	for (const source of SECRET_PATTERN_SOURCES) {
		const pattern = new RegExp(source.source, source.flags);
		result = result.replace(pattern, "[REDACTED_SECRET]");
	}
	return result;
}
function scrubRecord(value, options = {}) {
	if (typeof value === "string") return stripPrivateData(value);
	if (Array.isArray(value)) return value.map((item) => scrubRecord(item, options));
	if (value !== null && typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return value;
		const entries = Object.entries(value).map(([key, item]) => [options.scrubKeys ? stripPrivateData(key) : key, item]);
		const reserved = new Set(entries.map(([key]) => key));
		const used = /* @__PURE__ */ new Set();
		return Object.fromEntries(entries.map(([key, item]) => {
			let unique = key;
			if (used.has(unique)) {
				let suffix = 2;
				do
					unique = `${key}_${suffix++}`;
				while (reserved.has(unique) || used.has(unique));
			}
			used.add(unique);
			return [unique, scrubRecord(item, options)];
		}));
	}
	return value;
}
const SCRUBBED_WRITE_FUNCTIONS = new Set([
	"mem::remember",
	"mem::evolve",
	"mem::slot-create",
	"mem::slot-append",
	"mem::slot-replace",
	"mem::lesson-save",
	"mem::action-create",
	"mem::action-update",
	"mem::sketch-create",
	"mem::sketch-add",
	"mem::import",
	"mem::mesh-receive",
	"mem::team-share",
	"mem::signal-send",
	"mem::routine-create",
	"mem::checkpoint-create",
	"mem::checkpoint-resolve",
	"mem::sentinel-create",
	"mem::sentinel-trigger",
	"mem::core-add",
	"mem::facet-tag"
]);
function withWriteScrubbing(sdk) {
	return new Proxy(sdk, { get(target, prop) {
		const value = Reflect.get(target, prop, target);
		if (typeof value !== "function") return value;
		if (prop !== "registerFunction") return value.bind(target);
		const register = value;
		return (id, handler, ...rest) => {
			if (!SCRUBBED_WRITE_FUNCTIONS.has(id) || typeof handler !== "function") return register.call(target, id, handler, ...rest);
			const original = handler;
			const scrubbed = (data, ...args) => original(scrubRecord(data), ...args);
			return register.call(target, id, scrubbed, ...rest);
		};
	} });
}
function registerPrivacyFunction(sdk) {
	sdk.registerFunction("mem::privacy", async (data) => {
		if (!data || typeof data.input !== "string") return {
			output: "",
			error: "invalid input: expected string field 'input'"
		};
		return { output: stripPrivateData(data.input) };
	});
}
//#endregion
//#region src/capture/spool.ts
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MIN_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_AGE_HOURS = 168;
const LOCK_STALE_MS = 1e4;
const DRAIN_LOCK_STALE_MS = 12e4;
const ORPHAN_CLAIM_MS = 12e4;
const LOCK_WAIT_MS = 500;
const IMAGE_PLACEHOLDER = "[image dropped from capture spool]";
const BOOT_ID_RE = /^[A-Za-z0-9]{8,64}$/;
const SENT_FILE_RE = /^([A-Za-z0-9]{8,64})-(\d+)\.jsonl$/;
const SENT_BUCKET_MS = 1e3;
const MAX_DURABLE_AFTER_MS = 10 * 6e4;
function emptyStats() {
	return {
		spooled: 0,
		dropped: 0,
		droppedBytes: 0,
		expired: 0,
		delivered: 0,
		duplicates: 0,
		rejected: 0
	};
}
function positiveInt(raw, fallback) {
	if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
	const n = parseInt(raw.trim(), 10);
	return n > 0 ? n : fallback;
}
function spoolPolicy(env = process.env) {
	const maxBytes = Math.max(MIN_MAX_BYTES, positiveInt(env["AGENTMEMORY_CAPTURE_SPOOL_MAX_BYTES"], DEFAULT_MAX_BYTES));
	const maxAgeHours = positiveInt(env["AGENTMEMORY_CAPTURE_SPOOL_MAX_AGE_HOURS"], DEFAULT_MAX_AGE_HOURS);
	return {
		enabled: env["AGENTMEMORY_CAPTURE_SPOOL"] !== "false",
		maxBytes,
		maxAgeMs: maxAgeHours * 36e5,
		maxRecordBytes: Math.min(256 * 1024, Math.floor(maxBytes / 4))
	};
}
function spoolDir(env = process.env) {
	const explicit = env["AGENTMEMORY_CAPTURE_SPOOL_DIR"];
	if (explicit && explicit.trim()) return resolve(explicit.trim());
	return join(resolveDataDir({
		args: [],
		env
	}).dataDir, "capture-spool");
}
const LOOPBACK = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"[::1]",
	"0.0.0.0"
]);
function spoolTargetName(url) {
	try {
		const u = new URL(url);
		return `${LOOPBACK.has(u.hostname) ? "local" : u.hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "_")}-${u.port || (u.protocol === "https:" ? "443" : "80")}`;
	} catch {
		return "local-3111";
	}
}
function spoolPaths(url, dir = spoolDir()) {
	const name = spoolTargetName(url);
	return {
		dir,
		name,
		file: join(dir, `${name}.jsonl`),
		lock: join(dir, `${name}.lock`),
		drainLock: join(dir, `${name}.drain.lock`),
		stats: join(dir, `${name}.stats.json`)
	};
}
function ensureDir(dir) {
	mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	try {
		chmodSync(dir, 448);
	} catch {}
}
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function tryLock(path, staleMs) {
	try {
		const fd = openSync(path, "wx", 384);
		writeSync(fd, `${process.pid}\n`);
		closeSync(fd);
		return true;
	} catch (err) {
		if (err.code !== "EEXIST") return false;
		try {
			if (Date.now() - statSync(path).mtimeMs > staleMs) unlinkSync(path);
		} catch {}
		return false;
	}
}
function releaseLock(path) {
	try {
		unlinkSync(path);
	} catch {}
}
function withLock(path, fn, waitMs = LOCK_WAIT_MS) {
	const deadline = Date.now() + waitMs;
	let locked = tryLock(path, LOCK_STALE_MS);
	while (!locked && Date.now() < deadline) {
		sleepSync(5);
		locked = tryLock(path, LOCK_STALE_MS);
	}
	try {
		return fn(locked);
	} finally {
		if (locked) releaseLock(path);
	}
}
function readSpoolStats(paths) {
	try {
		const parsed = JSON.parse(readFileSync(paths.stats, "utf-8"));
		return {
			...emptyStats(),
			...parsed
		};
	} catch {
		return emptyStats();
	}
}
function writeStats(paths, patch) {
	try {
		const stats = readSpoolStats(paths);
		patch(stats);
		const tmp = `${paths.stats}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(stats), { mode: 384 });
		renameSync(tmp, paths.stats);
	} catch {}
}
function fileSize(path) {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}
function withoutImage(body) {
	const data = body["data"];
	if (!data || typeof data !== "object" || Array.isArray(data)) return body;
	const d = data;
	if (d["image_data"] === void 0) return body;
	return {
		...body,
		data: {
			...d,
			image_data: IMAGE_PLACEHOLDER
		}
	};
}
function parseLines(text) {
	const records = [];
	let corrupt = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line);
			if (rec && typeof rec.eventId === "string" && rec.body && typeof rec.body === "object") records.push(rec);
			else corrupt++;
		} catch {
			corrupt++;
		}
	}
	return {
		records,
		corrupt
	};
}
function isExpired(rec, policy, now) {
	const at = Date.parse(rec.spooledAt);
	return Number.isFinite(at) && now - at > policy.maxAgeMs;
}
function serialize(records) {
	return records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
}
function rewriteLocked(paths, records) {
	const tmp = `${paths.file}.${process.pid}.tmp`;
	const fd = openSync(tmp, "w", 384);
	try {
		writeSync(fd, serialize(records));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, paths.file);
}
function listSent(paths) {
	const segments = [];
	let entries;
	try {
		entries = readdirSync(paths.dir);
	} catch {
		return segments;
	}
	const prefix = `${paths.name}.sent-`;
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const match = entry.slice(prefix.length).match(SENT_FILE_RE);
		if (!match) continue;
		const file = join(paths.dir, entry);
		segments.push({
			file,
			bootId: match[1],
			dueAt: Number(match[2]),
			bytes: fileSize(file)
		});
	}
	return segments;
}
function sentBytes(paths) {
	return listSent(paths).reduce((n, s) => n + s.bytes, 0);
}
function parseSentMark(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const bootId = body["bootId"];
	const after = body["durableAfterMs"];
	if (typeof bootId !== "string" || !BOOT_ID_RE.test(bootId)) return null;
	if (typeof after !== "number" || !Number.isFinite(after) || after < 0) return null;
	return {
		bootId,
		durableAfterMs: Math.min(Math.ceil(after), MAX_DURABLE_AFTER_MS)
	};
}
function retainSent(url, eventId, body, mark, options = {}) {
	const policy = options.policy ?? spoolPolicy();
	if (!policy.enabled || !BOOT_ID_RE.test(mark.bootId)) return false;
	const paths = spoolPaths(url, options.dir);
	const now = options.now ?? Date.now();
	try {
		ensureDir(paths.dir);
		const record = {
			v: 1,
			eventId,
			spooledAt: new Date(now).toISOString(),
			reason: "sent",
			attempts: 0,
			body: scrubRecord(JSON.parse(JSON.stringify(body)), { scrubKeys: true }),
			bootId: mark.bootId
		};
		let line = JSON.stringify(record) + "\n";
		if (Buffer.byteLength(line) > policy.maxRecordBytes) {
			record.body = withoutImage(record.body);
			line = JSON.stringify(record) + "\n";
		}
		const bytes = Buffer.byteLength(line);
		if (bytes > policy.maxRecordBytes) return false;
		const dueAt = Math.ceil((now + mark.durableAfterMs) / SENT_BUCKET_MS) * SENT_BUCKET_MS;
		const file = join(paths.dir, `${paths.name}.sent-${mark.bootId}-${dueAt}.jsonl`);
		return withLock(paths.lock, () => {
			if (fileSize(paths.file) + sentBytes(paths) + bytes > policy.maxBytes) return false;
			const fd = openSync(file, "a", 384);
			try {
				writeSync(fd, line);
			} finally {
				closeSync(fd);
			}
			return true;
		});
	} catch {
		return false;
	}
}
function reconcileSent(url, bootId, options = {}) {
	const result = {
		released: 0,
		requeued: 0
	};
	if (!(options.policy ?? spoolPolicy()).enabled) return result;
	const paths = spoolPaths(url, options.dir);
	const now = options.now ?? Date.now();
	for (const seg of listSent(paths)) {
		if (seg.bootId === bootId) {
			if (seg.dueAt > now) continue;
			try {
				unlinkSync(seg.file);
				result.released++;
			} catch {}
			continue;
		}
		const target = join(paths.dir, `${paths.name}.draining-${process.pid}-${now}-${result.requeued}.jsonl`);
		try {
			renameSync(seg.file, target);
		} catch {
			continue;
		}
		try {
			utimesSync(target, 0, 0);
		} catch {}
		result.requeued++;
	}
	return result;
}
function claimFiles(paths) {
	const claimed = [];
	try {
		const prefix = `${paths.name}.draining-`;
		for (const entry of readdirSync(paths.dir)) {
			if (!entry.startsWith(prefix) || !entry.endsWith(".jsonl")) continue;
			const full = join(paths.dir, entry);
			try {
				if (Date.now() - statSync(full).mtimeMs > ORPHAN_CLAIM_MS) claimed.push(full);
			} catch {}
		}
	} catch {}
	if (fileSize(paths.file) > 0) {
		const target = join(paths.dir, `${paths.name}.draining-${process.pid}-${Date.now()}.jsonl`);
		withLock(paths.lock, (locked) => {
			if (!locked) return;
			try {
				renameSync(paths.file, target);
				claimed.push(target);
			} catch {}
		});
	}
	return claimed;
}
function requeueLocked(paths, leftover) {
	if (leftover.length === 0) return;
	const existing = existsSync(paths.file) ? parseLines(readFileSync(paths.file, "utf-8")).records : [];
	rewriteLocked(paths, [...leftover, ...existing]);
}
function requeueUnlocked(paths, leftover) {
	if (leftover.length === 0) return;
	const target = join(paths.dir, `${paths.name}.draining-${process.pid}-${Date.now()}-requeue.jsonl`);
	const fd = openSync(target, "wx", 384);
	try {
		writeSync(fd, serialize(leftover));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		utimesSync(target, 0, 0);
	} catch {}
}
async function drainSpool(url, send, options = {}) {
	const policy = options.policy ?? spoolPolicy();
	const result = {
		claimed: 0,
		delivered: 0,
		duplicates: 0,
		rejected: 0,
		expired: 0,
		corrupt: 0,
		remaining: 0
	};
	const paths = spoolPaths(url, options.dir);
	if (!existsSync(paths.dir)) return {
		...result,
		skipped: "empty"
	};
	try {
		ensureDir(paths.dir);
	} catch {}
	if (!tryLock(paths.drainLock, DRAIN_LOCK_STALE_MS)) return {
		...result,
		skipped: "locked"
	};
	try {
		const files = claimFiles(paths);
		if (files.length === 0) return {
			...result,
			skipped: "empty"
		};
		const records = [];
		for (const file of files) try {
			const parsed = parseLines(readFileSync(file, "utf-8"));
			records.push(...parsed.records);
			result.corrupt += parsed.corrupt;
		} catch {}
		result.claimed = records.length;
		const seen = /* @__PURE__ */ new Set();
		const now = Date.now();
		const deadline = options.deadlineMs ? now + options.deadlineMs : Number.POSITIVE_INFINITY;
		const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;
		const leftover = [];
		let stopped = false;
		let processed = 0;
		for (const rec of records) {
			if (seen.has(rec.eventId)) {
				result.duplicates++;
				continue;
			}
			seen.add(rec.eventId);
			if (isExpired(rec, policy, now)) {
				result.expired++;
				continue;
			}
			if (stopped || processed >= maxRecords || Date.now() > deadline) {
				leftover.push(rec);
				continue;
			}
			processed++;
			let outcome;
			try {
				outcome = await send(rec);
			} catch (err) {
				outcome = "retry";
				result.error = err instanceof Error ? err.message : String(err);
			}
			if (outcome === "delivered") result.delivered++;
			else if (outcome === "duplicate") result.duplicates++;
			else if (outcome === "rejected") result.rejected++;
			else {
				stopped = true;
				leftover.push({
					...rec,
					attempts: (rec.attempts ?? 0) + 1
				});
			}
		}
		result.remaining = leftover.length;
		withLock(paths.lock, (locked) => locked ? requeueLocked(paths, leftover) : requeueUnlocked(paths, leftover), 2e3);
		for (const file of files) try {
			unlinkSync(file);
		} catch {}
		writeStats(paths, (s) => {
			s.delivered += result.delivered;
			s.duplicates += result.duplicates;
			s.rejected += result.rejected;
			s.expired += result.expired;
			s.lastDrainAt = (/* @__PURE__ */ new Date()).toISOString();
			s.lastDrainDelivered = result.delivered;
			s.lastDrainDuplicates = result.duplicates;
			s.lastDrainRejected = result.rejected;
			s.lastDrainRemaining = result.remaining;
			if (result.error) s.lastDrainError = result.error;
			else delete s.lastDrainError;
		});
		return result;
	} finally {
		releaseLock(paths.drainLock);
	}
}
function spoolSummary(url, options = {}) {
	const policy = options.policy ?? spoolPolicy();
	const paths = spoolPaths(url, options.dir);
	let records = 0;
	let bytes = 0;
	let oldestAt = null;
	const files = [];
	if (existsSync(paths.file)) files.push(paths.file);
	try {
		for (const entry of readdirSync(paths.dir)) if (entry.startsWith(`${paths.name}.draining-`) && entry.endsWith(".jsonl")) files.push(join(paths.dir, entry));
	} catch {}
	for (const file of files) try {
		const text = readFileSync(file, "utf-8");
		bytes += Buffer.byteLength(text);
		for (const rec of parseLines(text).records) {
			records++;
			if (!oldestAt || rec.spooledAt < oldestAt) oldestAt = rec.spooledAt;
		}
	} catch {}
	let retained = 0;
	let retainedBytes = 0;
	for (const seg of listSent(paths)) try {
		const text = readFileSync(seg.file, "utf-8");
		retainedBytes += Buffer.byteLength(text);
		retained += parseLines(text).records.length;
	} catch {}
	return {
		enabled: policy.enabled,
		path: paths.file,
		records,
		bytes,
		oldestAt,
		retained,
		retainedBytes,
		maxBytes: policy.maxBytes,
		maxAgeHours: Math.round(policy.maxAgeMs / 36e5),
		stats: readSpoolStats(paths)
	};
}
//#endregion
//#region src/state/graph-generation.ts
const CONTROL_SCOPE = KV.graphControl;
const CONTROL_KEY$1 = "generation";
const GRAPH_SCOPES = new Set([
	KV.graphNodes,
	KV.graphEdges,
	KV.graphEdgeHistory,
	KV.graphSnapshot,
	KV.graphNameIndex,
	KV.graphEdgeKey,
	KV.graphNodeDegree,
	KV.graphMembership,
	KV.graphRetrievalControl,
	KV.graphRetrievalData,
	KV.graphIndexMigration,
	KV.graphIndexManifest
]);
const pinned = new AsyncLocalStorage();
const views = /* @__PURE__ */ new WeakMap();
let onGraphChange = null;
function setGraphGenerationListener(listener) {
	onGraphChange = listener;
}
async function notifyGraphGenerationChange(kv, scope, key) {
	if (!onGraphChange) return;
	const kind = scope === CONTROL_SCOPE && key === CONTROL_KEY$1 ? "reset" : scope.startsWith(`${KV.graphSnapshot}:generation:`) ? "snapshot" : scope.startsWith(`${KV.graphNodes}:generation:`) ? "nodes" : scope.startsWith(`${KV.graphEdges}:generation:`) ? "edges" : void 0;
	if (!kind) return;
	if (afterKeyedLock("graph:persist", () => notifyGraphGenerationChange(kv, scope, key), scope)) return;
	if (kind !== "reset" && afterKeyedLock(`graph:retrieval:${scope.slice(scope.lastIndexOf(":generation:") + 12)}`, () => notifyGraphGenerationChange(kv, scope, key), scope)) return;
	if (afterKeyedLock("graph:viewer-events", () => notifyGraphGenerationChange(kv, scope, key), scope)) return;
	try {
		const current = await generation(kv);
		if (kind !== "reset" && !scope.endsWith(`:generation:${current}`)) return;
		await pinned.exit(() => onGraphChange(kind));
	} catch {}
}
async function isLegacyGraphState(kv) {
	return await generation(kv) === null;
}
async function getGraphGeneration(kv) {
	const view = views.get(kv);
	if (view) return view.id;
	const context = pinned.getStore();
	return context?.kv === kv ? context.generation : generation(kv);
}
function pinGraphStateGeneration(kv, id) {
	return graphView(views.get(kv)?.target ?? kv, id);
}
async function generation(kv) {
	const value = await kv.get(CONTROL_SCOPE, CONTROL_KEY$1);
	if (value === null || value === void 0) return null;
	if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid graph generation");
	return value;
}
function physicalScope(scope, id) {
	return id !== null && GRAPH_SCOPES.has(scope) ? `${scope}:generation:${id}` : scope;
}
/** Used by StateKV so every graph consumer respects reset, including fallback reads. */
async function resolveGraphScope(kv, scope) {
	if (!GRAPH_SCOPES.has(scope)) return scope;
	const context = pinned.getStore();
	return physicalScope(scope, context?.kv === kv ? context.generation : await generation(kv));
}
/** Pin an operation before any awaits: late writes remain in its original generation. */
async function pinGraphState(kv) {
	if (views.has(kv)) return kv;
	return graphView(kv, await generation(kv));
}
function graphView(kv, id) {
	const methods = new Set([
		"get",
		"set",
		"update",
		"delete",
		"list"
	]);
	const view = new Proxy(kv, { get(target, property, receiver) {
		const value = Reflect.get(target, property, receiver);
		if (typeof property !== "string" || !methods.has(property)) return value;
		return (scope, ...args) => pinned.run({
			kv: target,
			generation: id
		}, () => value.call(target, physicalScope(scope, id), ...args));
	} });
	views.set(view, {
		target: kv,
		id
	});
	return view;
}
/** Initialize first, publish last; failures cannot expose a half-reset graph. */
async function resetGraphGeneration(kv, snapshot) {
	const id = randomUUID();
	await kv.set(physicalScope(KV.graphSnapshot, id), "current", snapshot);
	await initializeGraphIndex(graphView(kv, id), { status: "ready" });
	await kv.set(CONTROL_SCOPE, CONTROL_KEY$1, id);
}
async function replaceGraphGeneration(kv, initialize) {
	const pinnedState = await pinGraphState(kv);
	const { target, id: previous } = views.get(pinnedState);
	const id = randomUUID();
	const fresh = graphView(target, id);
	await initializeGraphIndex(fresh, { status: "ready" });
	const result = await initialize(fresh);
	if (await generation(target) === previous) await target.set(CONTROL_SCOPE, CONTROL_KEY$1, id);
	return result;
}
//#endregion
//#region src/state/graph-consistency.ts
const recovering = new AsyncLocalStorage();
const checks = /* @__PURE__ */ new WeakMap();
const scopes = [
	KV.graphNodes,
	KV.graphEdges,
	KV.graphEdgeHistory,
	KV.graphSnapshot,
	KV.graphNameIndex,
	KV.graphEdgeKey,
	KV.graphNodeDegree,
	KV.graphMembership
];
function snapshotScope(scope) {
	for (const logical of scopes) {
		if (scope === logical) return KV.graphSnapshot;
		if (scope.startsWith(`${logical}:generation:`)) return KV.graphSnapshot + scope.slice(logical.length);
	}
	return null;
}
function withoutGraphRecovery(fn) {
	return recovering.run(true, fn);
}
function noteGraphSnapshotWrite(kv, scope, key) {
	if (key === "current" && (scope === KV.graphSnapshot || scope.startsWith(`${KV.graphSnapshot}:generation:`))) checks.get(kv)?.delete(scope);
}
function snapshotCheck(kv, scope) {
	let entries = checks.get(kv);
	if (!entries) checks.set(kv, entries = /* @__PURE__ */ new Map());
	let check = entries.get(scope);
	if (!check) {
		if (entries.size >= 64) entries.clear();
		check = { clean: false };
		entries.set(scope, check);
	}
	return check;
}
function markChecked(kv, scope, check) {
	if (checks.get(kv)?.get(scope) === check) check.clean = true;
}
async function ensureGraphConsistency(kv, scope) {
	if (recovering.getStore()) return;
	const snapshot = snapshotScope(scope);
	if (!snapshot) return;
	const check = snapshotCheck(kv, snapshot);
	if (check.clean) return;
	const recover = () => withoutGraphRecovery(async () => {
		const recoveryCheck = snapshotCheck(kv, snapshot);
		const current = await kv.get(snapshot, "current");
		const pending = current?.pendingMutation;
		if (pending) {
			if (!current.dirty || !Array.isArray(pending.writes) || pending.snapshot?.version !== 1 || pending.snapshot.pendingMutation) throw new Error("Invalid graph reconciliation journal");
			const suffix = snapshot.slice(KV.graphSnapshot.length);
			for (const write of pending.writes) {
				if (!write || typeof write !== "object") throw new Error("Invalid graph reconciliation write");
				if (!scopes.includes(write.scope) || write.scope === KV.graphSnapshot || typeof write.key !== "string") throw new Error("Invalid graph reconciliation write");
			}
			for (const write of pending.writes) if (write.value === null) await kv.delete(write.scope + suffix, write.key);
			else await kv.set(write.scope + suffix, write.key, write.value);
			await kv.set(snapshot, "current", pending.snapshot);
		}
		markChecked(kv, snapshot, recoveryCheck);
	});
	if (isKeyedLockHeld("graph:persist")) return recover();
	if (!(await withoutGraphRecovery(() => kv.get(snapshot, "current")))?.pendingMutation) {
		markChecked(kv, snapshot, check);
		return;
	}
	await withKeyedLock("graph:persist", recover);
}
//#endregion
//#region src/state/graph-retrieval-index.ts
const GRAPH_INDEX_MAX_ID_BYTES = 1024;
const MAX_CONTROL_BYTES = 8 * 1024;
const MAX_PROJECTION_BYTES = 16 * 1024;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_POSTINGS = 192;
const CONTROL_KEY = "current";
var GraphIndexError = class extends Error {};
const bytes$1 = (value) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validId = (value) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 1024;
const finiteCount = (value) => Number.isSafeInteger(value) && value >= 0;
const boundedOption = (value, fallback, max) => Number.isFinite(value) ? Math.min(max, Math.max(1, Math.floor(value))) : fallback;
const graphLock = (fn) => isKeyedLockHeld("graph:persist") ? fn() : withKeyedLock("graph:persist", fn);
async function lock(state, fn) {
	const key = `graph:retrieval:${await getGraphGeneration(state) ?? "legacy"}`;
	return isKeyedLockHeld(key) ? fn() : withKeyedLock(key, fn);
}
const WAIT_FOR_BATCH = Symbol("graph index batch");
const NODE_TYPES = new Set([
	"file",
	"function",
	"concept",
	"error",
	"decision",
	"pattern",
	"library",
	"person",
	"project",
	"preference",
	"location",
	"organization",
	"event"
]);
const EDGE_TYPES = new Set([
	"uses",
	"imports",
	"modifies",
	"causes",
	"fixes",
	"depends_on",
	"related_to",
	"works_at",
	"prefers",
	"blocked_by",
	"caused_by",
	"optimizes_for",
	"rejected",
	"avoids",
	"located_in",
	"succeeded_by"
]);
const normalizeGraphIndexText = (value) => value.normalize("NFKC").toLowerCase();
const graphEdgeLookupKey = (edge) => JSON.stringify([
	edge.sourceNodeId,
	edge.targetNodeId,
	edge.type
]);
const token = (kind, value) => hash(`${kind}\0${kind === "name" || kind === "character" ? normalizeGraphIndexText(value) : value}`);
const recordKey = (buildId, kind, id) => `${buildId}:record:${kind}:${hash(id)}`;
const rootKey = (buildId, posting) => `${buildId}:root:${posting}`;
const entryKey = (buildId, posting, id) => `${buildId}:entry:${posting}:${id}`;
const countKey = (kind) => kind === "node" ? "nodes" : kind === "edge" ? "edges" : "historyEdges";
function validateControl(value) {
	if (bytes$1(value) > MAX_CONTROL_BYTES || value.schema !== 2 || typeof value.buildId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.buildId) || ![
		"building",
		"ready",
		"paused"
	].includes(value.status) || ![
		value.revision,
		value.nodes,
		value.edges,
		value.historyEdges,
		value.incompleteRecords,
		value.otherTypes
	].every(finiteCount) || !value.nodesByType || !value.edgesByType || Object.entries(value.nodesByType).some(([type, count]) => !NODE_TYPES.has(type) && type !== "other" || !finiteCount(count)) || Object.entries(value.edgesByType).some(([type, count]) => !EDGE_TYPES.has(type) && type !== "other" || !finiteCount(count)) || value.batchPending !== void 0 && typeof value.batchPending !== "boolean" || value.pending && (![
		"node",
		"edge",
		"history"
	].includes(value.pending.kind) || !validId(value.pending.id))) throw new GraphIndexError("Invalid graph retrieval index control; run explicit graph-index migration");
}
async function getGraphIndexStatus(state) {
	const value = await state.get(KV.graphRetrievalControl, CONTROL_KEY);
	if (value !== null && value !== void 0) validateControl(value);
	return value ?? null;
}
async function initializeGraphIndex(state, options) {
	const kv = await pinGraphState(state);
	return lock(kv, async () => {
		const value = {
			schema: 2,
			buildId: options.buildId ?? randomUUID(),
			status: options.status,
			revision: 0,
			nodes: 0,
			edges: 0,
			historyEdges: 0,
			incompleteRecords: 0,
			nodesByType: {},
			edgesByType: {},
			otherTypes: 0,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		validateControl(value);
		if ((await kv.get(KV.graphRetrievalControl, CONTROL_KEY))?.buildId === value.buildId) throw new GraphIndexError("A graph index rebuild requires a new build ID");
		await kv.set(KV.graphRetrievalControl, CONTROL_KEY, value);
		return value;
	});
}
function project(kind, id, input) {
	if (input === null || input === void 0) return null;
	const source = input;
	if (!source || typeof source !== "object" || Array.isArray(source) || !validId(id) || source.id !== id) return {
		row: null,
		postings: [],
		incomplete: true
	};
	if (source.stale === true) return {
		row: null,
		postings: [],
		incomplete: false
	};
	let incomplete = false;
	const text = (value, max = 512) => {
		if (typeof value !== "string") {
			incomplete = true;
			return "";
		}
		const result = Array.from(value.slice(0, max * 2)).slice(0, max).join("");
		if (result !== value) incomplete = true;
		return result;
	};
	const ids = [];
	if (!Array.isArray(source.sourceObservationIds)) incomplete = true;
	else for (const value of source.sourceObservationIds.slice(0, 512)) {
		if (!validId(value)) {
			incomplete = true;
			continue;
		}
		if (ids.includes(value)) continue;
		if (ids.length >= 128) {
			incomplete = true;
			break;
		}
		ids.push(value);
	}
	if (Array.isArray(source.sourceObservationIds) && source.sourceObservationIds.length > 512) incomplete = true;
	const common = {
		id,
		type: text(source.type, 64),
		sourceObservationIds: ids,
		createdAt: text(source.createdAt, 64)
	};
	let row;
	if (kind === "node") {
		const properties = {};
		if (!source.properties || typeof source.properties !== "object" || Array.isArray(source.properties)) incomplete = true;
		else for (const key in source.properties) {
			if (!Object.hasOwn(source.properties, key)) continue;
			if (Object.keys(properties).length >= 32) {
				incomplete = true;
				break;
			}
			const value = source.properties[key];
			if (key.length > 128) {
				incomplete = true;
				continue;
			}
			if (typeof value === "string") Object.defineProperty(properties, key, {
				value: text(value),
				enumerable: true,
				writable: true,
				configurable: true
			});
			else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) Object.defineProperty(properties, key, {
				value,
				enumerable: true,
				writable: true,
				configurable: true
			});
			else incomplete = true;
		}
		const aliases = Array.isArray(source.aliases) ? source.aliases.slice(0, 16).filter((v) => typeof v === "string").map((v) => text(v)) : [];
		if (Array.isArray(source.aliases) && aliases.length !== source.aliases.length) incomplete = true;
		row = {
			...common,
			type: common.type,
			name: text(source.name),
			properties,
			...aliases.length ? { aliases } : {},
			...typeof source.updatedAt === "string" ? { updatedAt: text(source.updatedAt, 64) } : {}
		};
	} else {
		if (!validId(source.sourceNodeId) || !validId(source.targetNodeId)) return {
			row: null,
			postings: [],
			incomplete: true
		};
		const edge = {
			...common,
			type: common.type,
			sourceNodeId: source.sourceNodeId,
			targetNodeId: source.targetNodeId,
			weight: typeof source.weight === "number" && Number.isFinite(source.weight) ? source.weight : 0
		};
		if (edge.weight !== source.weight) incomplete = true;
		for (const key of [
			"tcommit",
			"tvalid",
			"tvalidEnd",
			"supersededBy"
		]) if (typeof source[key] === "string") edge[key] = text(source[key], key === "supersededBy" ? 1024 : 64);
		if (typeof source.version === "number" && Number.isFinite(source.version)) edge.version = source.version;
		if (typeof source.isLatest === "boolean") edge.isLatest = source.isLatest;
		if (source.context && typeof source.context === "object" && !Array.isArray(source.context)) {
			const context = source.context;
			edge.context = {};
			for (const key of ["reasoning", "sentiment"]) if (typeof context[key] === "string") edge.context[key] = text(context[key]);
			if (typeof context.confidence === "number" && Number.isFinite(context.confidence)) edge.context.confidence = context.confidence;
			if (context.alternatives !== void 0 || context.situationalFactors !== void 0) incomplete = true;
		}
		row = edge;
	}
	while (bytes$1(row) > MAX_PROJECTION_BYTES - 64) {
		incomplete = true;
		if ("properties" in row && Object.keys(row.properties).length) delete row.properties[Object.keys(row.properties).at(-1)];
		else if ("aliases" in row && row.aliases?.length) row.aliases.pop();
		else if ("context" in row && row.context) delete row.context;
		else if (row.sourceObservationIds.length) row.sourceObservationIds.pop();
		else return {
			row: null,
			postings: [],
			incomplete: true
		};
	}
	const postings = new Set([token(countKey(kind), "")]);
	if (kind === "node") {
		const node = row;
		for (const value of [node.name, ...node.aliases ?? []]) postings.add(token("name", value));
		const searchable = [
			node.name,
			...node.aliases ?? [],
			...Object.values(node.properties).filter((v) => typeof v === "string")
		];
		const characters = new Set(searchable.flatMap((value) => Array.from(normalizeGraphIndexText(value))));
		for (const character of characters) {
			if (postings.size >= MAX_POSTINGS - row.sourceObservationIds.length) {
				incomplete = true;
				break;
			}
			postings.add(token("character", character));
		}
		for (const observationId of row.sourceObservationIds) postings.add(token("observation", observationId));
	} else {
		const edge = row;
		for (const nodeId of [edge.sourceNodeId, edge.targetNodeId]) postings.add(token(kind === "history" ? "history" : "adjacency", nodeId));
		if (kind === "edge") {
			if (edge.isLatest !== false) postings.add(token("edgeKey", graphEdgeLookupKey(edge)));
			for (const observationId of row.sourceObservationIds) postings.add(token("edgeObservation", observationId));
		}
	}
	if (incomplete) row.indexIncomplete = true;
	return {
		row,
		postings: [...postings],
		incomplete
	};
}
function validateRecord(value) {
	if (bytes$1(value) > 32768 || !Array.isArray(value.postings) || value.postings.length > MAX_POSTINGS || value.postings.some((p) => !/^[a-f0-9]{64}$/.test(p)) || typeof value.incomplete !== "boolean") throw new GraphIndexError("Invalid graph retrieval record");
}
async function planRecord(kv, control, kind, id, input) {
	const writes = /* @__PURE__ */ new Map();
	const read = async (key) => writes.has(key) ? writes.get(key) : kv.get(KV.graphRetrievalData, key);
	const put = (key, value) => {
		if (bytes$1(value) > 32768) throw new GraphIndexError("Graph retrieval index write exceeds record budget");
		writes.set(key, value);
	};
	const key = recordKey(control.buildId, kind, id);
	const before = await read(key);
	if (before) validateRecord(before);
	const after = project(kind, id, input);
	if (after) validateRecord(after);
	const memberId = hash(id);
	const editPosting = async (posting, add) => {
		const rootId = rootKey(control.buildId, posting), itemId = entryKey(control.buildId, posting, memberId);
		const root = await read(rootId) ?? {
			head: null,
			count: 0
		};
		const saved = await read(itemId);
		if (!finiteCount(root.count) || root.head !== null && !/^[a-f0-9]{64}$/.test(root.head)) throw new GraphIndexError("Invalid graph posting root");
		if (add) {
			if (saved) return;
			if (root.head) {
				const headId = entryKey(control.buildId, posting, root.head), head = await read(headId);
				if (!head) throw new GraphIndexError("Missing graph posting head");
				put(headId, {
					...head,
					previous: memberId
				});
			}
			put(itemId, {
				id,
				previous: null,
				next: root.head
			});
			put(rootId, {
				head: memberId,
				count: root.count + 1
			});
		} else {
			if (!saved) return;
			if (saved.previous) {
				const previousId = entryKey(control.buildId, posting, saved.previous), previous = await read(previousId);
				if (!previous) throw new GraphIndexError("Missing previous graph posting entry");
				put(previousId, {
					...previous,
					next: saved.next
				});
			} else {
				if (root.head !== memberId) throw new GraphIndexError("Invalid graph posting head link");
				root.head = saved.next;
			}
			if (saved.next) {
				const nextId = entryKey(control.buildId, posting, saved.next), next = await read(nextId);
				if (!next) throw new GraphIndexError("Missing next graph posting entry");
				put(nextId, {
					...next,
					previous: saved.previous
				});
			}
			put(itemId, null);
			put(rootId, {
				head: root.head,
				count: Math.max(0, root.count - 1)
			});
		}
	};
	const oldPostings = new Set(before?.postings ?? []), newPostings = new Set(after?.postings ?? []);
	for (const posting of oldPostings) if (!newPostings.has(posting)) await editPosting(posting, false);
	for (const posting of newPostings) if (!oldPostings.has(posting)) await editPosting(posting, true);
	put(key, after);
	const { pending: _, ...clean } = control;
	const next = {
		...clean,
		revision: control.revision + 1,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	const counted = (row) => Boolean(row && (kind !== "edge" || row.isLatest !== false));
	next[countKey(kind)] += Number(counted(after?.row)) - Number(counted(before?.row));
	next.incompleteRecords += Number(Boolean(after?.incomplete)) - Number(Boolean(before?.incomplete));
	if (kind !== "history") {
		const field = kind === "node" ? "nodesByType" : "edgesByType";
		const known = kind === "node" ? NODE_TYPES : EDGE_TYPES;
		next[field] = { ...control[field] };
		for (const [row, amount] of [[before?.row, -1], [after?.row, 1]]) {
			if (!row || !counted(row)) continue;
			const type = known.has(row.type) ? row.type : "other";
			next[field][type] = (next[field][type] ?? 0) + amount;
			if (!next[field][type]) delete next[field][type];
			if (type === "other") next.otherTypes += amount;
		}
	}
	validateControl(next);
	const journal = {
		schema: 1,
		buildId: control.buildId,
		revision: control.revision,
		writes: [...writes].map(([key, value]) => ({
			key,
			value
		})),
		next
	};
	if (bytes$1(journal) > MAX_JOURNAL_BYTES) throw new GraphIndexError("Graph retrieval index journal exceeds payload budget");
	return journal;
}
async function applyJournal(kv, control, journal) {
	if (journal.schema !== 1 || journal.buildId !== control.buildId || journal.revision !== control.revision || !Array.isArray(journal.writes) || journal.writes.length > 2048 || bytes$1(journal) > MAX_JOURNAL_BYTES || journal.next.buildId !== control.buildId || journal.next.revision !== control.revision + 1 || journal.next.pending) throw new GraphIndexError("Invalid graph retrieval recovery journal");
	validateControl(journal.next);
	for (const write of journal.writes) if (!write || typeof write.key !== "string" || !write.key.startsWith(`${control.buildId}:`) || write.key.length > 512 || bytes$1(write.value) > 32768) throw new GraphIndexError("Invalid graph retrieval recovery write");
	for (const write of journal.writes) if (write.value === null) await kv.delete(KV.graphRetrievalData, write.key);
	else await kv.set(KV.graphRetrievalData, write.key, write.value);
	await kv.set(KV.graphRetrievalControl, CONTROL_KEY, journal.next);
}
async function reconcilePending(kv, control, input) {
	if (!control.pending) return;
	const journalKey = `journal:${control.buildId}`;
	const saved = await kv.get(KV.graphRetrievalControl, journalKey);
	if (saved?.buildId === control.buildId && saved.revision === control.revision) return applyJournal(kv, control, saved);
	const { kind, id } = control.pending;
	const scope = kind === "node" ? KV.graphNodes : kind === "edge" ? KV.graphEdges : KV.graphEdgeHistory;
	const journal = await planRecord(kv, control, kind, id, input === void 0 ? await withoutGraphRecovery(() => kv.get(scope, id)) : input);
	await kv.set(KV.graphRetrievalControl, journalKey, journal);
	await applyJournal(kv, control, journal);
}
async function recoverGraphIndex(state, options = {}) {
	const kv = await pinGraphState(state);
	await graphLock(() => lock(kv, async () => {
		let control = await getGraphIndexStatus(kv);
		if (control?.batchPending && options.allowSnapshotRecovery) {
			const snapshot = await withoutGraphRecovery(() => kv.get(KV.graphSnapshot, "current"));
			if (snapshot?.pendingMutation) {
				const generation = await getGraphGeneration(kv);
				const scope = generation === null ? KV.graphSnapshot : `${KV.graphSnapshot}:generation:${generation}`;
				noteGraphSnapshotWrite(kv, scope, "current");
				await ensureGraphConsistency(kv, scope);
			} else if (snapshot && !snapshot.dirty) {
				const { batchPending: _, ...clean } = control;
				await kv.set(KV.graphRetrievalControl, CONTROL_KEY, {
					...clean,
					revision: clean.revision + 1
				});
			}
			control = await getGraphIndexStatus(kv);
		}
		if (control?.pending) await reconcilePending(kv, control);
	}));
}
async function reconcileGraphIndexRecord(state, kind, id, row, options = {}) {
	const kv = await pinGraphState(state);
	await lock(kv, async () => {
		let control = await getGraphIndexStatus(kv);
		if (!control) throw new GraphIndexError("Graph retrieval index must be initialized explicitly");
		if (control.status === "paused") throw new GraphIndexError("Graph retrieval index is paused; run explicit migration");
		if (control.pending) {
			await reconcilePending(kv, control);
			control = await getGraphIndexStatus(kv);
		}
		if (!validId(id)) throw new GraphIndexError("Graph record ID exceeds index migration budget");
		control = {
			...control,
			pending: {
				kind,
				id
			}
		};
		await kv.set(KV.graphRetrievalControl, CONTROL_KEY, control);
		await reconcilePending(kv, control, options.readCanonical ? void 0 : row);
	});
}
async function mutateIndexedGraphRecord(state, kind, id, transform) {
	const kv = await pinGraphState(state);
	return graphLock(() => lock(kv, async () => {
		const control = await getGraphIndexStatus(kv);
		if (!control || control.status !== "ready" || control.pending || control.batchPending) throw new GraphIndexError("Graph index is unavailable; retry the graph mutation after recovery");
		const scope = kind === "node" ? KV.graphNodes : kind === "edge" ? KV.graphEdges : KV.graphEdgeHistory;
		const next = transform(await withoutGraphRecovery(() => kv.get(scope, id)));
		if (next === void 0) return false;
		if (next === null) await withoutGraphRecovery(() => kv.delete(scope, id));
		else await withoutGraphRecovery(() => kv.set(scope, id, next));
		return true;
	}));
}
async function finishGraphIndexBuild(state, buildId) {
	const kv = await pinGraphState(state);
	return lock(kv, async () => {
		const current = await getGraphIndexStatus(kv);
		if (!current || current.buildId !== buildId || current.status === "paused" || current.pending || current.batchPending) throw new GraphIndexError("Graph index build is incomplete or superseded");
		const next = {
			...current,
			status: "ready",
			revision: current.revision + 1,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await kv.set(KV.graphRetrievalControl, CONTROL_KEY, next);
		return next;
	});
}
function canonicalScope(scope) {
	for (const [base, kind] of [
		[KV.graphNodes, "node"],
		[KV.graphEdges, "edge"],
		[KV.graphEdgeHistory, "history"]
	]) {
		if (scope === base) return {
			kind,
			generation: null
		};
		if (scope.startsWith(`${base}:generation:`)) return {
			kind,
			generation: scope.slice(base.length + 12)
		};
	}
	return null;
}
async function withGraphIndexMutation(state, scope, id, mutate) {
	const location = canonicalScope(scope);
	if (!location) return mutate();
	const kv = pinGraphStateGeneration(state, location.generation);
	const run = () => lock(kv, async () => {
		let control = await getGraphIndexStatus(kv);
		if (!control || control.status === "paused") return mutate();
		if (control.batchPending && !isKeyedLockHeld("graph:persist")) throw WAIT_FOR_BATCH;
		if (control.pending) {
			await reconcilePending(kv, control);
			control = await getGraphIndexStatus(kv);
		}
		if (!validId(id)) {
			await kv.set(KV.graphRetrievalControl, CONTROL_KEY, {
				...control,
				status: "paused",
				error: "Graph record ID exceeds bounded recovery budget",
				revision: control.revision + 1
			});
			return mutate();
		}
		control = {
			...control,
			pending: {
				kind: location.kind,
				id
			}
		};
		await kv.set(KV.graphRetrievalControl, CONTROL_KEY, control);
		const result = await mutate();
		await reconcilePending(kv, control);
		return result;
	});
	try {
		return await run();
	} catch (error) {
		if (error !== WAIT_FOR_BATCH) throw error;
		return graphLock(run);
	}
}
async function withGraphSnapshotIndexBarrier(state, scope, key, value, mutate) {
	if (key !== "current" || !(scope === KV.graphSnapshot || scope.startsWith(`${KV.graphSnapshot}:generation:`))) return mutate();
	const kv = pinGraphStateGeneration(state, scope === KV.graphSnapshot ? null : scope.slice(KV.graphSnapshot.length + 12));
	return graphLock(() => lock(kv, async () => {
		const control = await getGraphIndexStatus(kv);
		if (!control) return mutate();
		const snapshot = value;
		const dirty = !snapshot || typeof snapshot !== "object" || snapshot.version !== 1 || snapshot.dirty !== false || Boolean(snapshot.pendingMutation);
		if (dirty && !control.batchPending) await kv.set(KV.graphRetrievalControl, CONTROL_KEY, {
			...control,
			batchPending: true
		});
		const result = await mutate();
		if (!dirty) {
			const after = await getGraphIndexStatus(kv);
			if (after?.batchPending && !after.pending) {
				const { batchPending: _, ...clean } = after;
				await kv.set(KV.graphRetrievalControl, CONTROL_KEY, {
					...clean,
					revision: clean.revision + 1,
					updatedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
			}
		}
		return result;
	}));
}
async function withGraphSnapshotUnknownMutation(state, scope, key, mutate) {
	if (key !== "current" || !(scope === KV.graphSnapshot || scope.startsWith(`${KV.graphSnapshot}:generation:`))) return mutate();
	return graphLock(async () => {
		const result = await withGraphSnapshotIndexBarrier(state, scope, key, { dirty: true }, mutate);
		return withGraphSnapshotIndexBarrier(state, scope, key, await withoutGraphRecovery(() => state.get(scope, key)), async () => result);
	});
}
var GraphIndexReader = class {
	status;
	exhausted = false;
	reads = 2;
	readBytes;
	active = 0;
	waiting = [];
	cache = /* @__PURE__ */ new Map();
	maxReads;
	maxBytes;
	maxConcurrent;
	constructor(state, generation, status, options) {
		this.state = state;
		this.generation = generation;
		this.options = options;
		this.status = status;
		this.readBytes = bytes$1(status);
		this.maxReads = boundedOption(options.maxReads, 512, 4096);
		this.maxBytes = boundedOption(options.maxBytes, 2 * 1024 * 1024, 16 * 1024 * 1024);
		this.maxConcurrent = boundedOption(options.maxConcurrent, 4, 8);
	}
	get remainingReads() {
		return Math.max(0, this.maxReads - this.reads - 2);
	}
	async read(scope, key) {
		if (scope !== KV.graphRetrievalData) return this.readFresh(scope, key);
		const cached = this.cache.get(key);
		if (cached) return cached;
		const pending = this.readFresh(scope, key);
		if (!this.exhausted) this.cache.set(key, pending);
		return pending;
	}
	async readFresh(scope, key) {
		if (this.options.signal?.aborted || this.exhausted || this.remainingReads === 0 || this.readBytes >= this.maxBytes) {
			this.exhausted = true;
			return null;
		}
		this.reads++;
		if (this.active >= this.maxConcurrent) await new Promise((resolve) => this.waiting.push(resolve));
		else this.active++;
		try {
			if (this.options.signal?.aborted || this.exhausted) {
				this.exhausted = true;
				return null;
			}
			const value = await this.state.get(scope, key);
			const size = bytes$1(value);
			this.readBytes += size;
			if (this.readBytes > this.maxBytes || this.options.signal?.aborted) {
				this.exhausted = true;
				return null;
			}
			if (scope === KV.graphRetrievalData && size > 32768) throw new GraphIndexError("Graph retrieval record exceeds payload budget");
			return value;
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.active--;
		}
	}
	async record(kind, id) {
		if (!validId(id)) {
			this.exhausted = true;
			return null;
		}
		const value = await this.read(KV.graphRetrievalData, recordKey(this.status.buildId, kind, id));
		if (value) validateRecord(value);
		return value;
	}
	async getNode(id) {
		return (await this.record("node", id))?.row ?? null;
	}
	async getEdge(id) {
		return (await this.record("edge", id))?.row ?? null;
	}
	async getHistoryEdge(id) {
		return (await this.record("history", id))?.row ?? null;
	}
	async posting(kind, key = "", options = {}) {
		const posting = token(kind, key), root = await this.read(KV.graphRetrievalData, rootKey(this.status.buildId, posting));
		const inventoryCount = key === "" && (kind === "nodes" || kind === "edges" || kind === "historyEdges") ? this.status[kind] : void 0;
		if (!root) {
			if (!this.exhausted && inventoryCount) throw new GraphIndexError("Missing graph inventory root");
			return {
				ids: [],
				cursor: null,
				total: 0
			};
		}
		if (!finiteCount(root.count) || root.head !== null && !/^[a-f0-9]{64}$/.test(root.head) || root.count === 0 !== (root.head === null)) throw new GraphIndexError("Invalid graph posting root");
		if (inventoryCount !== void 0 && (kind === "edges" ? root.count < inventoryCount : root.count !== inventoryCount)) throw new GraphIndexError("Graph inventory count does not match index control");
		const prefix = `${this.status.buildId}.${this.status.revision}.${posting}.`;
		if (options.cursor && (!options.cursor.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(options.cursor.slice(prefix.length)))) throw new GraphIndexError("Invalid or expired graph posting cursor");
		let current = options.cursor ? options.cursor.slice(prefix.length) : root.head;
		const limit = boundedOption(options.limit, 64, 128), ids = [], seen = /* @__PURE__ */ new Set();
		while (current && ids.length < limit) {
			if (seen.has(current)) throw new GraphIndexError("Cyclic graph posting entry");
			seen.add(current);
			const value = await this.read(KV.graphRetrievalData, entryKey(this.status.buildId, posting, current));
			if (!value) {
				if (this.exhausted) break;
				throw new GraphIndexError("Missing graph posting entry");
			}
			if (!validId(value.id) || hash(value.id) !== current || value.next !== null && !/^[a-f0-9]{64}$/.test(value.next)) throw new GraphIndexError("Invalid graph posting entry");
			ids.push(value.id);
			current = value.next;
		}
		return {
			ids,
			cursor: current ? `${prefix}${current}` : null,
			total: root.count
		};
	}
	async finish() {
		if (this.options.signal?.aborted || this.reads + 2 > this.maxReads) return false;
		this.reads += 2;
		const current = await getGraphIndexStatus(this.state);
		const generation = await this.state.get(KV.graphControl, "generation");
		if ((generation ?? null) !== this.generation) return false;
		this.readBytes += bytes$1(generation) + bytes$1(current);
		if (this.readBytes > this.maxBytes) {
			this.exhausted = true;
			return false;
		}
		return Boolean(current && current.status === "ready" && !current.pending && !current.batchPending && current.buildId === this.status.buildId && current.revision === this.status.revision);
	}
};
async function createGraphIndexReader(state, options = {}) {
	if (options.signal?.aborted) return null;
	const kv = await pinGraphState(state), generation = await getGraphGeneration(kv), status = await getGraphIndexStatus(kv);
	if (!status || status.status !== "ready" || status.pending || status.batchPending) return null;
	return new GraphIndexReader(kv, generation, status, options);
}
//#endregion
//#region src/functions/graph-index-query.ts
async function queryGraphIndex(state, data) {
	const integer = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	const limit = Math.max(1, Math.min(integer(data.limit, 500), 500));
	const offset = Math.max(0, integer(data.offset, 0));
	const maxDepth = Math.max(0, Math.min(integer(data.maxDepth, 3), 5));
	const empty = (warning) => ({
		nodes: [],
		edges: [],
		depth: 0,
		totalNodes: 0,
		totalEdges: 0,
		truncated: true,
		limit,
		offset,
		warning
	});
	try {
		const reader = await createGraphIndexReader(state, {
			maxReads: 2048,
			maxBytes: 4 * 1024 * 1024
		});
		if (!reader) return empty("Graph index is unavailable. Run agentmemory graph-index status; legacy stores require an explicit migration.");
		const nodes = [];
		const edges = /* @__PURE__ */ new Map();
		let truncated = reader.status.incompleteRecords > 0;
		let fullyScanned = false;
		let depth = 0;
		const query = data.query ? normalizeGraphIndexText(data.query) : "";
		const matches = (node) => (!data.nodeType || node.type === data.nodeType) && (!query || normalizeGraphIndexText(node.name).includes(query) || Object.values(node.properties ?? {}).some((value) => typeof value === "string" && normalizeGraphIndexText(value).includes(query)));
		if (data.startNodeId && !query) {
			const queue = [{
				id: data.startNodeId,
				depth: 0
			}];
			const queued = new Set([data.startNodeId]);
			const visited = /* @__PURE__ */ new Set();
			for (let head = 0; head < queue.length && !reader.exhausted; head++) {
				const item = queue[head];
				if (visited.has(item.id) || item.depth > maxDepth) continue;
				visited.add(item.id);
				const node = await reader.getNode(item.id);
				if (!node || node.stale) continue;
				depth = Math.max(depth, item.depth);
				if (matches(node)) nodes.push(node);
				let cursor;
				do {
					const page = await reader.posting("adjacency", item.id, {
						cursor,
						limit: 64
					});
					for (const id of page.ids) {
						const edge = await reader.getEdge(id);
						if (!edge || edge.stale || edge.isLatest === false) continue;
						edges.set(edge.id, edge);
						const next = edge.sourceNodeId === item.id ? edge.targetNodeId : edge.sourceNodeId;
						if (item.depth < maxDepth && !queued.has(next)) if (queue.length < 512) {
							queue.push({
								id: next,
								depth: item.depth + 1
							});
							queued.add(next);
						} else truncated = true;
					}
					cursor = page.cursor ?? void 0;
				} while (cursor && !reader.exhausted);
				if (cursor) truncated = true;
			}
			fullyScanned = !reader.exhausted && !truncated;
		} else {
			let cursor;
			do {
				const page = await reader.posting(query ? "character" : "nodes", query ? Array.from(query)[0] : "", {
					cursor,
					limit: 64
				});
				for (const id of page.ids) {
					const node = await reader.getNode(id);
					if (node && !node.stale && matches(node)) nodes.push(node);
				}
				cursor = page.cursor ?? void 0;
				fullyScanned = !cursor && !reader.exhausted;
			} while (cursor && nodes.length < offset + limit && !reader.exhausted);
			if (cursor) truncated = true;
		}
		const pageNodes = nodes.slice(offset, offset + limit);
		const ids = new Set(pageNodes.map((node) => node.id));
		if (!data.startNodeId || query) for (const node of pageNodes) {
			let cursor;
			do {
				const page = await reader.posting("adjacency", node.id, {
					cursor,
					limit: 64
				});
				for (const id of page.ids) {
					if (edges.has(id)) continue;
					const edge = await reader.getEdge(id);
					if (edge && !edge.stale && edge.isLatest !== false && ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId)) edges.set(id, edge);
				}
				cursor = page.cursor ?? void 0;
			} while (cursor && !reader.exhausted);
			if (cursor || reader.exhausted) {
				truncated = true;
				break;
			}
		}
		if (!await reader.finish()) return empty("Graph changed during the query. Retry to read a consistent index revision.");
		const pageEdges = [...edges.values()].filter((edge) => ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId));
		const allNodes = !query && !data.startNodeId && !data.nodeType;
		truncated ||= reader.exhausted || !fullyScanned || nodes.length > pageNodes.length;
		return {
			nodes: pageNodes,
			edges: pageEdges,
			depth: data.startNodeId && !query ? maxDepth : depth,
			totalNodes: allNodes ? reader.status.nodes : nodes.length,
			totalEdges: allNodes ? reader.status.edges : pageEdges.length,
			truncated,
			limit,
			offset,
			fromSnapshot: false,
			...truncated ? { warning: "Graph response is bounded. Filtered counts describe examined records; some nodes, edges or oversized fields may be omitted." } : {}
		};
	} catch {
		return empty("Graph index could not be read consistently. Run agentmemory graph-index status before retrying.");
	}
}
//#endregion
//#region src/prompts/graph-extraction.ts
const GRAPH_EXTRACTION_SYSTEM = `You are a knowledge graph extraction engine. Given a compressed observation from a coding session, extract entities and relationships.

Output format (XML):
<entities>
  <entity type="file|function|concept|error|decision|pattern|library|person" name="exact name">
    <property key="key">value</property>
  </entity>
</entities>
<relationships>
  <relationship type="uses|imports|modifies|causes|fixes|depends_on|related_to" source="entity name" target="entity name" weight="0.1-1.0"/>
</relationships>

Rules:
- Extract concrete entities only (real file paths, function names, library names)
- Use the most specific type available
- Weight relationships by how strong/direct the connection is
- If no entities found, output empty tags`;
function buildGraphExtractionPrompt(observations) {
	return `Extract entities and relationships from these observations:\n\n${observations.map((o, i) => `[${i + 1}] Type: ${o.type}\nTitle: ${o.title}\nNarrative: ${o.narrative}\nConcepts: ${(o.concepts ?? []).join(", ")}\nFiles: ${(o.files ?? []).join(", ")}`).join("\n\n")}${process.env.AGENTMEMORY_LLM_NOTHINK === "1" ? "\n/no_think" : ""}`;
}
//#endregion
//#region src/functions/graph.ts
const SNAPSHOT_TOP_NODES = 500;
const SNAPSHOT_KEY = "current";
const LIVE_ENUMERATION_BUDGET_MS = 6e3;
function withTimeout(p, ms, label) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(/* @__PURE__ */ new Error(`${label}: exceeded ${ms}ms budget`)), ms);
		p.then((v) => {
			clearTimeout(t);
			resolve(v);
		}, (err) => {
			clearTimeout(t);
			reject(err);
		});
	});
}
function emptySnapshot() {
	return {
		version: 1,
		topNodes: [],
		topEdges: [],
		topDegrees: {},
		stats: {
			totalNodes: 0,
			totalEdges: 0,
			nodesByType: {},
			edgesByType: {}
		},
		updatedAt: (/* @__PURE__ */ new Date(0)).toISOString(),
		dirty: true
	};
}
async function readSnapshot(kv) {
	try {
		const snap = await kv.get(KV.graphSnapshot, SNAPSHOT_KEY);
		if (snap && typeof snap === "object" && snap.version === 1) return snap;
		return null;
	} catch (err) {
		logger.warn("Graph snapshot read failed", { error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}
async function readSnapshotStrict(kv) {
	let raw;
	try {
		raw = await kv.get(KV.graphSnapshot, SNAPSHOT_KEY);
	} catch (err) {
		logger.warn("Graph snapshot read failed, retrying once", { error: err instanceof Error ? err.message : String(err) });
		raw = await kv.get(KV.graphSnapshot, SNAPSHOT_KEY);
	}
	if (raw === null || raw === void 0) return null;
	if (typeof raw === "object" && raw.version === 1) return raw;
	throw new Error(`Graph snapshot has unknown schema version: ${JSON.stringify(raw.version)}`);
}
function buildSnapshotFromArrays(nodes, edges) {
	const liveNodes = nodes.filter((n) => !n.stale);
	const liveEdges = edges.filter((e) => !e.stale);
	const degree = /* @__PURE__ */ new Map();
	for (const e of liveEdges) {
		degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
		degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
	}
	const ranked = [...liveNodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, SNAPSHOT_TOP_NODES);
	const rankedIds = new Set(ranked.map((n) => n.id));
	const topEdges = liveEdges.filter((e) => rankedIds.has(e.sourceNodeId) && rankedIds.has(e.targetNodeId));
	const topDegrees = {};
	for (const n of ranked) topDegrees[n.id] = degree.get(n.id) ?? 0;
	const nodesByType = {};
	for (const n of liveNodes) nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
	const edgesByType = {};
	for (const e of liveEdges) edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
	return {
		version: 1,
		topNodes: ranked,
		topEdges,
		topDegrees,
		stats: {
			totalNodes: liveNodes.length,
			totalEdges: liveEdges.length,
			nodesByType,
			edgesByType
		},
		updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		dirty: false
	};
}
const REBUILD_SAFE_NODE_CEILING = 25e3;
function nameIndexKey(type, name) {
	return `${type}|${name}`;
}
function edgeIndexKey(sourceNodeId, targetNodeId, type) {
	return `${sourceNodeId}|${targetNodeId}|${type}`;
}
async function applyDegreeDelta(kv, snap, nodeId, delta) {
	const prev = await kv.get(KV.graphNodeDegree, nodeId) ?? 0;
	const next = Math.max(0, prev + delta);
	await kv.set(KV.graphNodeDegree, nodeId, next);
	if (snap.topNodes.findIndex((n) => n.id === nodeId) !== -1) {
		snap.topDegrees[nodeId] = next;
		snap.topNodes.sort((a, b) => (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0));
		return next;
	}
	if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
		const node = await kv.get(KV.graphNodes, nodeId);
		if (node && !node.stale) {
			snap.topNodes.push(node);
			snap.topDegrees[node.id] = next;
			snap.topNodes.sort((a, b) => (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0));
		}
		return next;
	}
	const tailEntry = snap.topNodes[snap.topNodes.length - 1];
	if (!tailEntry) return next;
	if (next > (snap.topDegrees[tailEntry.id] ?? 0)) {
		const node = await kv.get(KV.graphNodes, nodeId);
		if (node && !node.stale) {
			const evicted = snap.topNodes.pop();
			if (evicted) delete snap.topDegrees[evicted.id];
			snap.topNodes.push(node);
			snap.topDegrees[node.id] = next;
			snap.topNodes.sort((a, b) => (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0));
		}
	}
	return next;
}
function snapshotPushEdgeIfBothInTop(snap, edge) {
	const topIds = new Set(snap.topNodes.map((n) => n.id));
	if (topIds.has(edge.sourceNodeId) && topIds.has(edge.targetNodeId)) {
		if (!snap.topEdges.find((e) => e.id === edge.id)) snap.topEdges.push(edge);
	}
}
function boundSources(existing, incoming) {
	const merged = new Set(existing);
	for (const id of incoming) {
		merged.delete(id);
		merged.add(id);
	}
	return [...merged].slice(-32);
}
function mergeNode(existing, incoming, capturedAt) {
	return {
		...existing,
		sourceObservationIds: boundSources(existing.sourceObservationIds ?? [], incoming.sourceObservationIds ?? []),
		properties: {
			...existing.properties,
			...incoming.properties
		},
		updatedAt: capturedAt
	};
}
function mergeEdge(existing, incoming) {
	return {
		...existing,
		sourceObservationIds: boundSources(existing.sourceObservationIds ?? [], incoming.sourceObservationIds ?? [])
	};
}
function parseAttrs(raw) {
	const attrs = {};
	const attrRegex = /([A-Za-z_][\w:-]*)="([^"]*)"/g;
	let m;
	while ((m = attrRegex.exec(raw)) !== null) attrs[m[1]] = m[2];
	return attrs;
}
function parseGraphXml(xml, observationIds) {
	const nodes = [];
	const edges = [];
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const entitySelfClose = /<entity\b([^>]*?)\/>/g;
	const entityWithBody = /<entity\b([^>]*[^/])>([\s\S]*?)<\/entity>/g;
	const addEntity = (rawAttrs, propsBlock = "") => {
		const attrs = parseAttrs(rawAttrs);
		const type = attrs["type"];
		const name = attrs["name"];
		if (!type || !name) return;
		const properties = {};
		const propRegex = /<property\s+key="([^"]+)">([^<]*)<\/property>/g;
		let propMatch;
		while ((propMatch = propRegex.exec(propsBlock)) !== null) properties[propMatch[1]] = propMatch[2];
		nodes.push({
			id: generateId("gn"),
			type,
			name,
			properties,
			sourceObservationIds: observationIds,
			createdAt: now
		});
	};
	let match;
	while ((match = entitySelfClose.exec(xml)) !== null) addEntity(match[1]);
	while ((match = entityWithBody.exec(xml)) !== null) addEntity(match[1], match[2]);
	const relRegex = /<relationship\b([^>]*?)\/>/g;
	while ((match = relRegex.exec(xml)) !== null) {
		const attrs = parseAttrs(match[1]);
		const type = attrs["type"];
		const sourceName = attrs["source"];
		const targetName = attrs["target"];
		if (!type || !sourceName || !targetName) continue;
		const parsedWeight = parseFloat(attrs["weight"] ?? "");
		const weight = Number.isFinite(parsedWeight) ? parsedWeight : .5;
		const sourceNode = nodes.find((n) => n.name === sourceName);
		const targetNode = nodes.find((n) => n.name === targetName);
		if (!sourceNode || !targetNode) continue;
		edges.push({
			id: generateId("ge"),
			type,
			sourceNodeId: sourceNode.id,
			targetNodeId: targetNode.id,
			weight: Math.max(0, Math.min(1, weight)),
			sourceObservationIds: observationIds,
			createdAt: now
		});
	}
	return {
		nodes,
		edges
	};
}
const HEURISTIC_EDGE_WEIGHT = .4;
const MAX_HEURISTIC_EDGES_PER_OBS = 12;
function extractGraphHeuristics(observations) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const nodes = [];
	const nodeByKey = /* @__PURE__ */ new Map();
	const edges = [];
	const edgeByPair = /* @__PURE__ */ new Map();
	const nodeFor = (type, name, obsId) => {
		const trimmed = name.trim();
		if (!trimmed) return null;
		const key = `${type}\u0000${trimmed.toLowerCase()}`;
		let node = nodeByKey.get(key);
		if (!node) {
			node = {
				id: generateId("gn"),
				type,
				name: trimmed,
				properties: {},
				sourceObservationIds: [obsId],
				createdAt: now
			};
			nodeByKey.set(key, node);
			nodes.push(node);
		} else if (!node.sourceObservationIds.includes(obsId)) node.sourceObservationIds.push(obsId);
		return node;
	};
	for (const obs of observations) {
		let budget = MAX_HEURISTIC_EDGES_PER_OBS;
		const link = (a, b) => {
			if (!a || !b || a.id === b.id) return;
			const pair = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
			const existing = edgeByPair.get(pair);
			if (existing) {
				if (!existing.sourceObservationIds.includes(obs.id)) existing.sourceObservationIds.push(obs.id);
				return;
			}
			if (budget <= 0) return;
			budget -= 1;
			const edge = {
				id: generateId("ge"),
				type: "related_to",
				sourceNodeId: a.id,
				targetNodeId: b.id,
				weight: HEURISTIC_EDGE_WEIGHT,
				sourceObservationIds: [obs.id],
				createdAt: now
			};
			edgeByPair.set(pair, edge);
			edges.push(edge);
		};
		const fileNodes = (obs.files ?? []).map((f) => nodeFor("file", f, obs.id));
		const conceptNodes = (obs.concepts ?? []).map((c) => nodeFor("concept", c, obs.id));
		for (const concept of conceptNodes) for (const file of fileNodes) link(concept, file);
		for (let i = 0; i + 1 < conceptNodes.length; i++) link(conceptNodes[i], conceptNodes[i + 1]);
		for (let i = 0; i + 1 < fileNodes.length; i++) link(fileNodes[i], fileNodes[i + 1]);
	}
	return {
		nodes,
		edges
	};
}
async function persistGraphDelta(kv, rawNodes, rawEdges) {
	kv = await pinGraphState(kv);
	const nodes = rawNodes.map((node) => scrubRecord(node));
	const edges = rawEdges.map((edge) => scrubRecord(edge));
	return withKeyedLock("graph:persist", async () => {
		const snap = await readSnapshotStrict(kv) ?? emptySnapshot();
		const legacyResetAt = await isLegacyGraphState(kv) ? snap.resetAt : void 0;
		const capturedAt = (/* @__PURE__ */ new Date()).toISOString();
		let newNodeCount = 0;
		let newEdgeCount = 0;
		let snapMutated = false;
		const newEdgesForTopCheck = [];
		const idRemap = /* @__PURE__ */ new Map();
		for (const node of nodes) {
			const indexKey = nameIndexKey(node.type, node.name);
			const existingId = await kv.get(KV.graphNameIndex, indexKey);
			let existing = null;
			if (existingId) {
				existing = await kv.get(KV.graphNodes, existingId);
				if (existing && legacyResetAt && typeof existing.createdAt === "string" && existing.createdAt < legacyResetAt) existing = null;
			}
			if (existing) {
				idRemap.set(node.id, existing.id);
				const merged = mergeNode(existing, node, capturedAt);
				await kv.set(KV.graphNodes, existing.id, merged);
				const topIdx = snap.topNodes.findIndex((n) => n.id === existing.id);
				if (topIdx !== -1) {
					snap.topNodes[topIdx] = merged;
					snapMutated = true;
				}
			} else {
				node.sourceObservationIds = boundSources([], node.sourceObservationIds ?? []);
				await kv.set(KV.graphNodes, node.id, node);
				await kv.set(KV.graphNameIndex, indexKey, node.id);
				await kv.set(KV.graphNodeDegree, node.id, 0);
				snap.stats.totalNodes += 1;
				snap.stats.nodesByType[node.type] = (snap.stats.nodesByType[node.type] ?? 0) + 1;
				newNodeCount += 1;
				if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
					snap.topNodes.push(node);
					snap.topDegrees[node.id] = 0;
				}
			}
		}
		for (const rawEdge of edges) {
			const edge = {
				...rawEdge,
				sourceNodeId: idRemap.get(rawEdge.sourceNodeId) ?? rawEdge.sourceNodeId,
				targetNodeId: idRemap.get(rawEdge.targetNodeId) ?? rawEdge.targetNodeId
			};
			const eKey = edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type);
			const existingId = await kv.get(KV.graphEdgeKey, eKey);
			let existing = null;
			if (existingId) {
				existing = await kv.get(KV.graphEdges, existingId);
				if (existing && legacyResetAt && typeof existing.createdAt === "string" && existing.createdAt < legacyResetAt) existing = null;
			}
			if (existing) {
				const merged = mergeEdge(existing, edge);
				await kv.set(KV.graphEdges, existing.id, merged);
				const topIdx = snap.topEdges.findIndex((e) => e.id === existing.id);
				if (topIdx !== -1) {
					snap.topEdges[topIdx] = merged;
					snapMutated = true;
				}
			} else {
				edge.sourceObservationIds = boundSources([], edge.sourceObservationIds ?? []);
				await kv.set(KV.graphEdges, edge.id, edge);
				await kv.set(KV.graphEdgeKey, eKey, edge.id);
				snap.stats.totalEdges += 1;
				snap.stats.edgesByType[edge.type] = (snap.stats.edgesByType[edge.type] ?? 0) + 1;
				newEdgeCount += 1;
				await applyDegreeDelta(kv, snap, edge.sourceNodeId, 1);
				await applyDegreeDelta(kv, snap, edge.targetNodeId, 1);
				newEdgesForTopCheck.push(edge);
			}
		}
		for (const edge of newEdgesForTopCheck) snapshotPushEdgeIfBothInTop(snap, edge);
		if (newNodeCount > 0 || newEdgeCount > 0 || snapMutated) {
			snap.updatedAt = capturedAt;
			snap.dirty = false;
			await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
		}
		return {
			newNodeCount,
			newEdgeCount
		};
	});
}
const COMPACT_SCOPES = [
	"nodes",
	"edges",
	"history",
	"snapshot"
];
async function compactGraphProvenance(kv, opts = {}) {
	kv = await pinGraphState(kv);
	const { scope } = opts;
	if (scope !== void 0 && !COMPACT_SCOPES.includes(scope)) throw new Error(`unknown compact scope: ${String(scope)}`);
	const offset = opts.offset ?? 0;
	const dryRun = opts.dryRun === true;
	const limit = opts.limit ?? Number.POSITIVE_INFINITY;
	if (!Number.isInteger(offset) || offset < 0) throw new Error(`compact offset must be a non-negative integer: ${String(opts.offset)}`);
	if (!(limit === Number.POSITIVE_INFINITY || Number.isInteger(limit) && limit > 0)) throw new Error(`compact limit must be a positive integer: ${String(opts.limit)}`);
	const result = {
		nodesScanned: 0,
		nodesTrimmed: 0,
		edgesScanned: 0,
		edgesTrimmed: 0,
		historyScanned: 0,
		historyTrimmed: 0,
		idsRemoved: 0,
		snapshotTrimmed: false,
		nextOffset: null
	};
	const trimScope = async (listIds, recordScope) => {
		const allIds = [...new Set(await listIds())].filter((id) => typeof id === "string").sort();
		const end = Math.min(allIds.length, offset + limit);
		result.total = allIds.length;
		result.nextOffset = end < allIds.length ? end : null;
		let scanned = 0;
		let trimmed = 0;
		for (const id of allIds.slice(offset, end)) await withKeyedLock("graph:persist", async () => {
			const record = await kv.get(recordScope, id);
			if (!record) return;
			scanned += 1;
			const sources = record.sourceObservationIds ?? [];
			if (sources.length <= 32) return;
			const bounded = boundSources([], sources);
			result.idsRemoved += sources.length - bounded.length;
			if (!dryRun) await kv.set(recordScope, id, {
				...record,
				sourceObservationIds: bounded
			});
			trimmed += 1;
		});
		return {
			scanned,
			trimmed
		};
	};
	const trimSnapshot = () => withKeyedLock("graph:persist", async () => {
		const snap = await readSnapshot(kv);
		if (!snap) return;
		const trimList = (list) => list.map((r) => {
			const sources = r.sourceObservationIds ?? [];
			if (sources.length <= 32) return r;
			result.snapshotTrimmed = true;
			return {
				...r,
				sourceObservationIds: boundSources([], sources)
			};
		});
		const topNodes = trimList(snap.topNodes);
		const topEdges = trimList(snap.topEdges);
		if (result.snapshotTrimmed && !dryRun) await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, {
			...snap,
			topNodes,
			topEdges
		});
	});
	if (scope === void 0 || scope === "nodes") {
		const n = await trimScope(() => kv.list(KV.graphNameIndex), KV.graphNodes);
		result.nodesScanned = n.scanned;
		result.nodesTrimmed = n.trimmed;
	}
	if (scope === void 0 || scope === "edges") {
		const e = await trimScope(() => kv.list(KV.graphEdgeKey), KV.graphEdges);
		result.edgesScanned = e.scanned;
		result.edgesTrimmed = e.trimmed;
	}
	if (scope === void 0 || scope === "history") {
		const h = await trimScope(async () => (await kv.list(KV.graphEdgeHistory)).map((r) => r?.id), KV.graphEdgeHistory);
		result.historyScanned = h.scanned;
		result.historyTrimmed = h.trimmed;
	}
	if (scope === void 0 || scope === "snapshot") await trimSnapshot();
	if (scope === void 0) {
		delete result.total;
		result.nextOffset = null;
	}
	return result;
}
function registerGraphFunction(sdk, state, provider) {
	const kv = state;
	sdk.registerFunction("mem::graph-extract", async (data) => {
		const kv = await pinGraphState(state);
		if (!data.observations || data.observations.length === 0) return {
			success: false,
			error: "No observations provided"
		};
		const obsIds = data.observations.map((o) => o.id);
		let nodes = [];
		let edges = [];
		try {
			const heuristic = extractGraphHeuristics(data.observations);
			nodes = heuristic.nodes;
			edges = heuristic.edges;
		} catch (err) {
			logger.warn("heuristic graph extraction failed", { error: err instanceof Error ? err.message : String(err) });
		}
		const llmEnabled = isGraphExtractionEnabled() && !provider.name.includes("noop");
		let llmError;
		if (llmEnabled) {
			const prompt = buildGraphExtractionPrompt(data.observations.map((o) => ({
				title: o.title,
				narrative: o.narrative,
				concepts: o.concepts,
				files: o.files,
				type: o.type
			})));
			try {
				const parsed = parseGraphXml(await provider.compress(GRAPH_EXTRACTION_SYSTEM, prompt), obsIds);
				nodes = nodes.concat(parsed.nodes);
				edges = edges.concat(parsed.edges);
			} catch (err) {
				llmError = err instanceof Error ? err.message : String(err);
				logger.error("LLM graph extraction failed", { error: llmError });
			}
		}
		if (nodes.length === 0 && edges.length === 0) return llmError ? {
			success: false,
			error: llmError
		} : {
			success: true,
			nodesAdded: 0,
			edgesAdded: 0
		};
		try {
			const { newNodeCount, newEdgeCount } = await persistGraphDelta(kv, nodes, edges);
			await recordAudit(kv, "observe", "mem::graph-extract", obsIds, {
				nodesExtracted: nodes.length,
				edgesExtracted: edges.length
			});
			logger.info("Graph extraction complete", {
				nodes: nodes.length,
				edges: edges.length,
				newNodes: newNodeCount,
				newEdges: newEdgeCount,
				llm: llmEnabled && !llmError
			});
			return {
				success: true,
				nodesAdded: nodes.length,
				edgesAdded: edges.length
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("Graph extraction failed", { error: msg });
			return {
				success: false,
				error: msg
			};
		}
	});
	sdk.registerFunction("mem::graph-query", async (data) => {
		return queryGraphIndex(state, data);
	});
	sdk.registerFunction("mem::graph-stats", async () => {
		const index = await getGraphIndexStatus(await pinGraphState(state));
		if (!index || index.status !== "ready" || index.pending || index.batchPending) return {
			totalNodes: null,
			totalEdges: null,
			nodesByType: {},
			edgesByType: {},
			fromSnapshot: false,
			fromIndex: false,
			available: false,
			coverage: "unknown",
			warning: "Graph index counts are unavailable. Run agentmemory graph-index status; legacy stores require an explicit migration."
		};
		return {
			totalNodes: index.nodes,
			totalEdges: index.edges,
			nodesByType: index.nodesByType,
			edgesByType: index.edgesByType,
			fromSnapshot: false,
			fromIndex: true,
			available: true,
			coverage: index.incompleteRecords ? "partial" : "complete",
			updatedAt: index.updatedAt,
			...index.incompleteRecords || index.otherTypes ? { warning: "Counts describe indexed live records; oversized projections may be incomplete and unrecognized types are grouped under other." } : {}
		};
	});
	sdk.registerFunction("mem::graph-snapshot-rebuild", async (data) => {
		const kv = await pinGraphState(state);
		const started = Date.now();
		const forceRebuild = data?.force === true;
		try {
			if (!await readSnapshot(kv) && !forceRebuild) {
				logger.warn("Graph snapshot rebuild refused: no prior snapshot", { hint: "legacy corpus or empty store" });
				return {
					success: false,
					legacyCorpus: true,
					error: "No prior snapshot found. Rebuild would call kv.list on KV.graphNodes/Edges, which heartbeat-crashes the worker on corpora past the iii state response budget (~25K nodes). Either (a) call POST /agentmemory/graph/reset to drop into incremental-only mode and rebuild from new extracts, or (b) re-send with `force: true` if you're certain the corpus is small."
				};
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn("Graph snapshot pre-flight read failed", { error: msg });
		}
		try {
			const outcome = await withKeyedLock("graph:persist", async () => {
				const [nodes, edges] = await withTimeout(Promise.all([kv.list(KV.graphNodes), kv.list(KV.graphEdges)]), LIVE_ENUMERATION_BUDGET_MS, "graph-snapshot-rebuild enumeration");
				if (nodes.length > REBUILD_SAFE_NODE_CEILING) return { tooLargeNodeCount: nodes.length };
				const liveNodes = nodes.filter((n) => !n.stale);
				const liveEdges = edges.filter((e) => !e.stale);
				const degree = /* @__PURE__ */ new Map();
				for (const e of liveEdges) {
					degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
					degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
				}
				const BATCH_SIZE = 100;
				for (let i = 0; i < liveNodes.length; i += BATCH_SIZE) {
					const batch = liveNodes.slice(i, i + BATCH_SIZE);
					await Promise.all(batch.flatMap((n) => [kv.set(KV.graphNameIndex, nameIndexKey(n.type, n.name), n.id), kv.set(KV.graphNodeDegree, n.id, degree.get(n.id) ?? 0)]));
				}
				for (let i = 0; i < liveEdges.length; i += BATCH_SIZE) {
					const batch = liveEdges.slice(i, i + BATCH_SIZE);
					await Promise.all(batch.map((e) => kv.set(KV.graphEdgeKey, edgeIndexKey(e.sourceNodeId, e.targetNodeId, e.type), e.id)));
				}
				const rebuilt = buildSnapshotFromArrays(nodes, edges);
				await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, rebuilt);
				return { snap: rebuilt };
			});
			if ("tooLargeNodeCount" in outcome) {
				const totalNodes = outcome.tooLargeNodeCount;
				logger.warn("Graph snapshot rebuild aborted: corpus too large", {
					totalNodes,
					ceiling: REBUILD_SAFE_NODE_CEILING
				});
				return {
					success: false,
					tooLarge: true,
					totalNodes,
					ceiling: REBUILD_SAFE_NODE_CEILING,
					error: `Corpus has ${totalNodes} graph nodes; safe-rebuild ceiling is ${REBUILD_SAFE_NODE_CEILING}. Run POST /agentmemory/graph/reset to wipe and let future extracts rebuild incrementally.`
				};
			}
			const { snap } = outcome;
			const tookMs = Date.now() - started;
			logger.info("Graph snapshot rebuilt", {
				totalNodes: snap.stats.totalNodes,
				totalEdges: snap.stats.totalEdges,
				topNodes: snap.topNodes.length,
				topEdges: snap.topEdges.length,
				tookMs
			});
			return {
				success: true,
				...snap.stats,
				topNodes: snap.topNodes.length,
				topEdges: snap.topEdges.length,
				updatedAt: snap.updatedAt,
				tookMs
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("Graph snapshot rebuild failed", { error: msg });
			return {
				success: false,
				error: msg
			};
		}
	});
	sdk.registerFunction("mem::graph-compact", async (data) => {
		const kv = await pinGraphState(state);
		const started = Date.now();
		try {
			const result = await compactGraphProvenance(kv, data ?? {});
			const tookMs = Date.now() - started;
			logger.info("Graph provenance compacted", {
				...result,
				tookMs
			});
			if (result.idsRemoved > 0) await safeAudit(kv, "graph_compact", "mem::graph-compact", [], {
				scope: data?.scope ?? "all",
				offset: data?.offset,
				limit: data?.limit,
				nodesTrimmed: result.nodesTrimmed,
				edgesTrimmed: result.edgesTrimmed,
				historyTrimmed: result.historyTrimmed,
				idsRemoved: result.idsRemoved,
				snapshotTrimmed: result.snapshotTrimmed
			});
			return {
				success: true,
				...result,
				tookMs
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("Graph provenance compaction failed", { error: msg });
			return {
				success: false,
				error: msg
			};
		}
	});
	sdk.registerFunction("mem::graph-reset", async () => {
		const started = Date.now();
		const resetSnapshot = {
			...emptySnapshot(),
			resetAt: (/* @__PURE__ */ new Date()).toISOString(),
			updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			dirty: false
		};
		await withKeyedLock("graph:persist", () => resetGraphGeneration(kv, resetSnapshot));
		const counts = { [KV.graphSnapshot]: 1 };
		const tookMs = Date.now() - started;
		logger.info("Graph state reset", {
			counts,
			tookMs
		});
		return {
			success: true,
			cleared: counts,
			resetMode: "generation",
			physicalStorageRetained: true,
			message: "The active graph is empty. Previous graph storage is retained; this operation does not reclaim disk space.",
			tookMs
		};
	});
}
const GRAPH_COMPACT_BOOT_KEY = `graph-compact-on-boot:v1`;
const GRAPH_COMPACT_BOOT_FUNCTION_ID = "mem::graph-compact-on-boot";
const GRAPH_COMPACT_BOOT_DELAY_MS = 3e3;
const SLICED_SCOPES = [
	"nodes",
	"edges",
	"history"
];
const DEFAULT_SLICE_SIZE = 100;
const DEFAULT_PAUSE_MS = 200;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2e3;
let current = { state: "pending" };
let running = null;
function getGraphCompactBootStatus() {
	return { ...current };
}
function setGraphCompactBootDisabled() {
	current = { state: "off" };
}
function statusFrom(p) {
	return {
		state: p.status,
		phase: p.phase,
		processed: p.offset,
		total: p.phaseTotal,
		scanned: p.scanned,
		trimmed: p.trimmed,
		idsRemoved: p.idsRemoved,
		startedAt: p.startedAt,
		completedAt: p.completedAt,
		error: p.error
	};
}
function isResumable(p) {
	return !!p && p.version === 1 && p.cap === 32 && (p.phase === "snapshot" || SLICED_SCOPES.includes(p.phase)) && Number.isInteger(p.offset) && p.offset >= 0;
}
function storedPlan(p, phase) {
	const plan = p.pending;
	if (!plan || plan.phase !== phase || plan.offset !== p.offset) return null;
	return [
		plan.scanned,
		plan.trimmed,
		plan.idsRemoved
	].every((n) => Number.isInteger(n) && n >= 0) ? plan : null;
}
function scannedOf(scope, r) {
	if (scope === "nodes") return [r.nodesScanned, r.nodesTrimmed];
	if (scope === "edges") return [r.edgesScanned, r.edgesTrimmed];
	return [r.historyScanned, r.historyTrimmed];
}
function describeGraphCompactBoot(s) {
	if (s.state === "off") return "off (AGENTMEMORY_GRAPH_COMPACT_ON_BOOT=false)";
	if (s.state === "pending") return "pending";
	if (s.state === "deferred") return "deferred (legacy scan requires explicit maintenance)";
	const where = s.phase === "snapshot" || s.total === null || s.total === void 0 ? `${s.phase ?? "nodes"}` : `${s.phase} ${s.processed ?? 0} of ${s.total}`;
	if (s.state === "running") return `running, ${where}`;
	if (s.state === "failed") return `failed at ${where}: ${s.error ?? "unknown error"}`;
	return `done, ${s.trimmed ?? 0} records trimmed, ${s.idsRemoved ?? 0} ids removed`;
}
function runGraphCompactOnBoot(kv, opts = {}) {
	if (opts.allowLegacyScan !== true) {
		current = { state: "deferred" };
		return Promise.resolve(getGraphCompactBootStatus());
	}
	if (running) return running;
	running = runOnce(kv, opts).finally(() => {
		running = null;
	});
	return running;
}
async function runOnce(kv, opts) {
	const sliceSize = opts.sliceSize ?? DEFAULT_SLICE_SIZE;
	const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS;
	const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const log = opts.log ?? (() => {});
	const warn = opts.warn ?? log;
	const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const now = opts.now ?? (() => /* @__PURE__ */ new Date());
	const attempt = async (fn) => {
		let lastErr;
		for (let i = 1; i <= maxAttempts; i++) try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (i < maxAttempts) await sleep(retryDelayMs * i);
		}
		throw lastErr;
	};
	let progress = null;
	const save = async () => {
		if (!progress) return;
		progress.updatedAt = now().toISOString();
		current = statusFrom(progress);
		await attempt(() => kv.set(KV.config, GRAPH_COMPACT_BOOT_KEY, progress));
	};
	try {
		const stored = await attempt(() => kv.get(KV.config, GRAPH_COMPACT_BOOT_KEY));
		if (isResumable(stored) && stored.status === "done") {
			current = statusFrom(stored);
			return getGraphCompactBootStatus();
		}
		const startedAt = now().toISOString();
		if (isResumable(stored)) {
			progress = {
				...stored,
				status: "running",
				error: void 0
			};
			log(`Graph provenance compaction: resuming in the background at ${progress.phase} ${progress.offset}`);
		} else {
			progress = {
				version: 1,
				cap: 32,
				status: "running",
				phase: "nodes",
				offset: 0,
				phaseTotal: null,
				scanned: 0,
				trimmed: 0,
				idsRemoved: 0,
				startedAt,
				updatedAt: startedAt
			};
			log(`Graph provenance compaction: started in the background (cap 32 ids per record)`);
		}
		await save();
		const p = progress;
		for (const scope of SLICED_SCOPES) {
			if (p.phase === "snapshot") break;
			if (SLICED_SCOPES.indexOf(p.phase) > SLICED_SCOPES.indexOf(scope)) continue;
			p.phase = scope;
			let phaseTrimmed = 0;
			let phaseScanned = 0;
			for (;;) {
				const slice = {
					scope,
					offset: p.offset,
					limit: sliceSize
				};
				let plan = storedPlan(p, scope);
				if (!plan) {
					const r = await attempt(() => compactGraphProvenance(kv, {
						...slice,
						dryRun: true
					}));
					const [scanned, trimmed] = scannedOf(scope, r);
					plan = {
						phase: scope,
						offset: p.offset,
						scanned,
						trimmed,
						idsRemoved: r.idsRemoved,
						nextOffset: r.nextOffset,
						total: r.total ?? null
					};
					if (plan.trimmed > 0) {
						p.pending = plan;
						await save();
					}
				}
				if (plan.trimmed > 0) await attempt(() => compactGraphProvenance(kv, slice));
				phaseScanned += plan.scanned;
				phaseTrimmed += plan.trimmed;
				p.scanned += plan.scanned;
				p.trimmed += plan.trimmed;
				p.idsRemoved += plan.idsRemoved;
				p.pending = void 0;
				p.phaseTotal = plan.total;
				p.offset = plan.nextOffset ?? p.phaseTotal ?? p.offset;
				await save();
				if (plan.nextOffset === null) break;
				if (pauseMs > 0) await sleep(pauseMs);
			}
			log(`Graph provenance compaction: ${scope} done (${phaseScanned} checked, ${phaseTrimmed} trimmed)`);
			p.phase = SLICED_SCOPES[SLICED_SCOPES.indexOf(scope) + 1] ?? "snapshot";
			p.offset = 0;
			p.phaseTotal = null;
			await save();
		}
		let snapPlan = storedPlan(p, "snapshot");
		if (!snapPlan) {
			const dry = await attempt(() => compactGraphProvenance(kv, {
				scope: "snapshot",
				dryRun: true
			}));
			snapPlan = {
				phase: "snapshot",
				offset: p.offset,
				scanned: 0,
				trimmed: dry.snapshotTrimmed ? 1 : 0,
				idsRemoved: 0,
				nextOffset: null,
				total: null
			};
			if (snapPlan.trimmed > 0) {
				p.pending = snapPlan;
				await save();
			}
		}
		if (snapPlan.trimmed > 0) await attempt(() => compactGraphProvenance(kv, { scope: "snapshot" }));
		const snapshotTrimmed = snapPlan.trimmed > 0;
		p.trimmed += snapPlan.trimmed;
		p.pending = void 0;
		p.status = "done";
		p.completedAt = now().toISOString();
		await save();
		if (p.idsRemoved > 0) await safeAudit(kv, "graph_compact", GRAPH_COMPACT_BOOT_FUNCTION_ID, [], {
			trigger: "boot",
			recordsTrimmed: p.trimmed,
			idsRemoved: p.idsRemoved,
			snapshotTrimmed
		});
		log(`Graph provenance compaction: done (${p.scanned} records checked, ${p.trimmed} trimmed, ${p.idsRemoved} ids removed)`);
		return getGraphCompactBootStatus();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (progress) {
			progress.status = "failed";
			progress.error = msg;
			current = statusFrom(progress);
			try {
				await kv.set(KV.config, GRAPH_COMPACT_BOOT_KEY, {
					...progress,
					updatedAt: now().toISOString()
				});
			} catch {}
		} else current = {
			state: "failed",
			error: msg
		};
		warn(`Graph provenance compaction failed (${describeGraphCompactBoot(current)}). It resumes on the next start; to run it now, POST /agentmemory/graph/compact.`);
		return getGraphCompactBootStatus();
	}
}
//#endregion
//#region src/functions/status.ts
const FAILURE_RATE_THRESHOLD = .2;
const FAILURE_MIN_CALLS = 5;
const GRAPH_SNAPSHOT_STALE_SECONDS = 1440 * 60;
const LEVEL_RANK = {
	ok: 0,
	info: 1,
	warn: 2,
	error: 3
};
const FUNCTION_FIXES = {
	"mem::summarize": "Summaries come from your LLM provider. Check the provider key, model name and rate limits in ~/.agentmemory/.env, then look for provider errors in the server log.",
	"mem::compress": "Compression calls your LLM provider. Check the provider key and model, or set AGENTMEMORY_AUTO_COMPRESS=false to use zero-LLM compression.",
	"mem::graph-extract": "Graph extraction calls your LLM provider. Check the provider key and model, or set GRAPH_EXTRACTION_ENABLED=false."
};
const LLM_KEY_FIX = "Add one LLM provider key (for example ANTHROPIC_API_KEY or OPENAI_API_KEY) to ~/.agentmemory/.env and restart.";
const OFF_WITHOUT_LLM = [
	"session summaries",
	"consolidation into semantic facts and procedures",
	"typed graph extraction",
	"LLM observation compression",
	"skill extraction from finished sessions"
];
const BM25_EXPLAINER = "The keyword index holds observations, memories and lessons, so its total is larger than the observation count.";
function describeHealthAlert(slug) {
	let m;
	if (m = /^memory_(warn|critical)_(\d+)%_rss(\d+)mb$/.exec(slug)) return {
		level: m[1] === "critical" ? "error" : "warn",
		message: `Memory ${m[1] === "critical" ? "critically high" : "high"}: ${m[2]}% of the heap limit in use, process memory ${m[3]} MB.`,
		fix: "Restart agentmemory to release memory. If it climbs back, raise the limit with NODE_OPTIONS=--max-old-space-size=4096."
	};
	if (m = /^cpu_(warn|critical)_(\d+)%$/.exec(slug)) return {
		level: m[1] === "critical" ? "error" : "warn",
		message: `CPU ${m[1] === "critical" ? "critically high" : "high"}: ${m[2]}%.`,
		fix: "Usually a burst of observations or a rebuild. If it stays high with no agent running, check the server log for a loop."
	};
	if (m = /^event_loop_lag_(warn|critical)_(\d+)ms$/.exec(slug)) return {
		level: m[1] === "critical" ? "error" : "warn",
		message: `The worker is ${m[2]} ms behind on its work (event loop delay), so requests answer slowly.`,
		fix: "It usually clears after an import or index rebuild finishes. If it persists, restart agentmemory."
	};
	if (slug === "stream_relay_down") return {
		level: "warn",
		message: "Live updates are not reaching the viewer: the engine stopped relaying stream events, which happens after Redis restarts or drops the connection. Data is still saved.",
		fix: "Restart agentmemory (npx @agentmemory/agentmemory stop, then start) so the engine subscribes to Redis again, then reload the viewer."
	};
	if (slug === "connection_reconnecting") return {
		level: "warn",
		message: "The connection to the iii engine dropped and is reconnecting.",
		fix: "Wait a few seconds. If it does not recover, check that the engine is running with npx @agentmemory/agentmemory status."
	};
	if (m = /^connection_(.+)$/.exec(slug)) return {
		level: "error",
		message: `The connection to the iii engine is ${m[1]}, so nothing can be stored or searched.`,
		fix: "Restart agentmemory. Run npx @agentmemory/agentmemory doctor if the engine does not start."
	};
	return {
		level: "warn",
		message: slug,
		fix: "Look for this alert in the server log."
	};
}
function isOffWithoutLlm(functionId, providerKind) {
	return providerKind === "noop" && functionId in FUNCTION_FIXES;
}
function markLlmFunctions(metrics, providerKind) {
	return metrics.map((m) => ({
		...m,
		offWithoutLlm: isOffWithoutLlm(m.functionId, providerKind)
	}));
}
function secondsBetween(later, earlierIso) {
	if (!earlierIso) return null;
	const earlier = Date.parse(earlierIso);
	if (Number.isNaN(earlier)) return null;
	return Math.max(0, Math.round((later.getTime() - earlier) / 1e3));
}
function describeBackfillState(state) {
	if (state === "waiting-for-opt-in") return "paused, waiting for opt-in";
	if (state === "paused") return "paused, retried on the next start";
	return state;
}
function vectorBackfillFix(state) {
	if (state === "waiting-for-opt-in") return "Backfill is paused. Set AGENTMEMORY_VECTOR_BACKFILL=all and restart to opt in. This calls the embedding provider and is capped per boot by AGENTMEMORY_VECTOR_BACKFILL_MAX.";
	if (state === "running") return "Backfill is running in the background in batches of AGENTMEMORY_VECTOR_BACKFILL_MAX with a short pause between batches. If agentmemory stops first, it continues on the next start. Check the server log for embedding provider errors if progress stops.";
	if (state === "paused") return "Backfill stopped because the embedding provider did not return vectors. Search still works by keyword. Check the embedding provider key and the server log; the remaining documents are retried on the next start.";
	return "Backfill is not running. Check the server log and embedding provider configuration. A full backfill requires AGENTMEMORY_VECTOR_BACKFILL=all and a restart, and can consume embedding provider tokens.";
}
function evaluateStatus(input) {
	const problems = [];
	if (!input.health) problems.push({
		level: "info",
		code: "health-check-unavailable",
		message: "The health monitor has no snapshot yet or did not answer in time, so its state was not checked.",
		fix: "The monitor writes a snapshot every 30 seconds after start. Wait a minute; if this stays, check the server log."
	});
	const healthStatus = input.health?.status;
	const alerts = input.health?.alerts ?? [];
	if (alerts.length === 0 && healthStatus === "critical") problems.push({
		level: "error",
		code: "health-critical",
		message: "The health monitor reports a critical state.",
		fix: "Check the server log, then restart agentmemory."
	});
	else if (alerts.length === 0 && healthStatus === "degraded") problems.push({
		level: "warn",
		code: "health-degraded",
		message: "The health monitor reports a degraded state.",
		fix: "Check the server log for the cause."
	});
	const described = alerts.map(describeHealthAlert);
	if (healthStatus !== "critical") for (const d of described) d.level = "warn";
	else if (described.length && !described.some((d) => d.level === "error")) described[0].level = "error";
	for (const d of described) problems.push({
		level: d.level,
		code: "health-alert",
		message: d.message,
		fix: d.fix
	});
	if (input.circuitBreaker?.state === "open") problems.push({
		level: "error",
		code: "provider-circuit-open",
		message: `LLM provider calls are paused after ${input.circuitBreaker.failures ?? 0} consecutive failures.`,
		fix: "Check the provider key and model in ~/.agentmemory/.env. Calls resume automatically once the provider answers again."
	});
	if (input.provider === "noop") problems.push({
		level: "info",
		code: "no-llm-provider",
		message: "No LLM provider is configured, so summaries, consolidation and graph extraction stay off. Search still works.",
		fix: LLM_KEY_FIX
	});
	const noLlm = input.provider === "noop";
	const functions = markLlmFunctions(input.functionMetrics, input.provider).map((m) => ({
		...m,
		failureRate: m.totalCalls > 0 ? m.failureCount / m.totalCalls : 0
	}));
	for (const fn of functions) {
		if (fn.offWithoutLlm) continue;
		if (fn.totalCalls < FAILURE_MIN_CALLS || fn.failureRate < FAILURE_RATE_THRESHOLD) continue;
		problems.push({
			level: "warn",
			code: "function-failing",
			message: `${fn.functionId} failed ${fn.failureCount} of ${fn.totalCalls} calls (${Math.round(fn.failureRate * 100)}%).`,
			fix: FUNCTION_FIXES[fn.functionId] ?? "Look for this function id in the server log to see the error."
		});
	}
	const missingObservations = input.index.missingObservations;
	if (!input.index.keywordRebuildRunning && missingObservations !== null && missingObservations > 0) problems.push({
		level: "warn",
		code: "index-missing-observations",
		message: `${missingObservations} stored observations are not in the search index, so search cannot find them.`,
		fix: "Restart agentmemory: the boot reconcile re-indexes observations missing from the snapshot."
	});
	if (input.index.keywordRebuildRunning) problems.push({
		level: "info",
		code: "keyword-index-rebuilding",
		message: "The keyword index is still rebuilding from stored data, so the check for observations missing from search waits until it finishes.",
		fix: "No action needed. The check runs on the next health update after the rebuild."
	});
	else if (missingObservations === null) problems.push({
		level: "info",
		code: "index-check-unavailable",
		message: "The session store did not answer in time, so the search index was not checked for missing observations.",
		fix: "The check runs again on the next health update. If it keeps timing out, the store is overloaded: check the server log."
	});
	if (input.index.bm25Incomplete) problems.push({
		level: "error",
		code: "bm25-rebuild-incomplete",
		message: "The keyword index could not load every session at boot, so some observations are missing from search until the next successful rebuild.",
		fix: "Check the server log for the session listing failure. Restarting or the next cold-start search retries automatically."
	});
	if (input.index.pendingVectorBackfill > 0) problems.push({
		level: "info",
		code: "index-vector-backfill-pending",
		message: `${input.index.pendingVectorBackfill} documents are waiting for a vector embedding.`,
		fix: vectorBackfillFix(input.index.vectorBackfillState)
	});
	const persistence = input.indexPersistence ?? null;
	const vectorLeg = persistence?.vector ?? null;
	if (persistence && vectorLeg) {
		if (vectorLeg.lastError) problems.push({
			level: "error",
			code: "index-save-failing",
			message: `The vector index could not be saved: ${vectorLeg.lastError}. Search keeps working from memory, but vectors added since the last save are lost on restart.`,
			fix: "Check the server log for the failing state write. The next save retries automatically."
		});
		const dirtyAge = secondsBetween(input.now, vectorLeg.dirtySince ?? void 0);
		if (!vectorLeg.lastError && dirtyAge !== null && dirtyAge * 1e3 > 2 * persistence.saveIntervalMs) problems.push({
			level: "warn",
			code: "index-save-stale",
			message: `The vector index has unsaved changes from ${formatDuration(dirtyAge)} ago.`,
			fix: "After the first checkpoint, saves are batched by AGENTMEMORY_INDEX_SAVE_INTERVAL_MS. Check the server log for save errors or a save that never finishes."
		});
	}
	if (persistence?.pendingLogError) problems.push({
		level: "warn",
		code: "index-pending-log-failing",
		message: `New vectors could not be written to the pending vector log: ${persistence.pendingLogError}. They are still kept by the next index save, but a crash before then means they are embedded again at the next start.`,
		fix: "Check the server log for the failing state write. Each new vector retries the log write."
	});
	if (persistence?.vectorCountShortfall) {
		const { expected, loaded } = persistence.vectorCountShortfall;
		problems.push({
			level: "warn",
			code: "index-vector-count-shortfall",
			message: `Only ${loaded} of ${expected} vectors loaded from the last save.`,
			fix: vectorBackfillFix(input.index.vectorBackfillState)
		});
	}
	let graph = null;
	if (input.graph) {
		const ageSeconds = secondsBetween(input.now, input.graph.updatedAt);
		graph = {
			...input.graph,
			ageSeconds,
			extractionEnabled: input.graphExtractionEnabled
		};
		if (input.graphExtractionEnabled && !input.graph.fromSnapshot && !input.graph.fromIndex && !input.graphIndex) problems.push({
			level: "warn",
			code: "graph-no-snapshot",
			message: "Graph extraction is on but no graph snapshot exists, so graph counts are unavailable.",
			fix: "Use Rebuild Graph in the viewer, or POST /agentmemory/graph/snapshot-rebuild."
		});
		else if (!input.graph.fromIndex && input.graph.fromSnapshot && ageSeconds !== null && ageSeconds > GRAPH_SNAPSHOT_STALE_SECONDS) {
			const age = ageSeconds >= 2 * 86400 ? `${Math.floor(ageSeconds / 86400)} days` : `${Math.round(ageSeconds / 3600)} hours`;
			problems.push({
				level: "info",
				code: "graph-snapshot-stale",
				message: `The graph snapshot is ${age} old, so dashboard graph counts can lag the live graph.`,
				fix: "POST /agentmemory/graph/snapshot-rebuild refreshes it."
			});
		}
		if (input.graph.dirty) problems.push({
			level: "info",
			code: "graph-snapshot-dirty",
			message: "The graph snapshot was read while a write was in flight; counts are eventually consistent.",
			fix: "No action needed: the next graph write settles the counts."
		});
	}
	const graphIndex = input.graphIndex ?? null;
	if (input.graphIndex === null || graphIndex?.state === "unavailable") problems.push({
		level: "info",
		code: "graph-index-unavailable",
		message: "The bounded graph index could not be checked. Keyword and vector search remain available.",
		fix: "Run agentmemory graph-index status and check the state store."
	});
	else if (graphIndex && !graphIndex.ready) problems.push({
		level: graphIndex.state === "paused" ? "warn" : "info",
		code: "graph-index-not-ready",
		message: `Graph retrieval is unavailable while its index is ${graphIndex.state}. Keyword search, vector search and capture remain available.`,
		fix: graphIndex.action
	});
	else if (graphIndex?.coverage === "partial") problems.push({
		level: "warn",
		code: "graph-index-partial",
		message: `${graphIndex.incompleteRecords ?? "Some"} graph records exceed index limits; graph retrieval has partial coverage.`,
		fix: graphIndex.action
	});
	const compaction = input.graphCompaction ?? null;
	if (compaction?.state === "running") problems.push({
		level: "info",
		code: "graph-compaction-running",
		message: `Oversized graph provenance is being trimmed in the background (${describeGraphCompactBoot(compaction)}). Search and capture keep working.`,
		fix: "No action needed. It runs once, resumes after a restart and stops by itself. AGENTMEMORY_GRAPH_COMPACT_ON_BOOT=false turns it off."
	});
	else if (compaction?.state === "failed") problems.push({
		level: "warn",
		code: "graph-compaction-failed",
		message: `The one-time graph provenance compaction stopped: ${compaction.error ?? "unknown error"}. Graph search can stay slow until it finishes.`,
		fix: `It resumes on the next start. To run it now: ${graphCompactCommand(input.ports.rest)}`
	});
	if (input.auditLegacy?.status === "too-large" || input.auditLegacy?.status === "unreadable") {
		const size = input.auditLegacy.sizeBytes;
		const sizeText = typeof size === "number" ? ` (${Math.round(size / (1024 * 1024))} MiB)` : "";
		problems.push({
			level: "info",
			code: "audit-legacy-frozen",
			message: `An older audit log${sizeText} was left in place instead of being migrated into monthly scopes, so it is no longer rewritten but its rows do not show up in audit queries.`,
			fix: input.stateBackend === "redis" ? "Safe to ignore. To remove it, run redis-cli -u \"$AGENTMEMORY_REDIS_URL\" DEL state:mem:audit, then restart agentmemory." : "Safe to ignore. To remove it, stop agentmemory, delete mem%3Aaudit.bin from the state store directory, then start it again."
		});
	}
	if (input.capture === null) problems.push({
		level: "info",
		code: "capture-check-unavailable",
		message: "The capture inbox did not answer in time, so capture was not checked.",
		fix: "The check runs again on the next status request. If it keeps timing out, the state store is overloaded: check the server log."
	});
	problems.push(...captureProblems(input.capture ?? null, input.now, input.ports.rest));
	if (input.stateStore && !input.stateStore.ok) problems.push({
		level: "error",
		code: "state-store-unreachable",
		message: input.stateBackend === "redis" ? "The state store is not answering: the engine cannot reach Redis, so nothing is being saved or read." : "The state store is not answering: the engine did not complete a state read in time, so nothing is being saved or read.",
		fix: input.stateBackend === "redis" ? "Check that Redis is running and reachable at AGENTMEMORY_REDIS_URL (redis-cli -u \"$AGENTMEMORY_REDIS_URL\" ping should answer PONG). Once Redis is back, restart agentmemory: the engine does not resume the live viewer stream after a Redis restart." : "Check the server log for engine errors, then restart agentmemory."
	});
	const status = problems.reduce((worst, p) => LEVEL_RANK[p.level] > LEVEL_RANK[worst] ? p.level : worst, "ok");
	return {
		status,
		headline: statusHeadline(status, problems),
		checkedAt: input.now.toISOString(),
		service: {
			version: input.version,
			engineVersion: input.engineVersion,
			uptimeSeconds: input.uptimeSeconds,
			stateBackend: input.stateBackend,
			stateStore: input.stateStore ?? null,
			ports: input.ports
		},
		health: input.health,
		provider: {
			llm: input.provider,
			route: input.provider === "noop" ? null : input.llmRoute ?? null,
			embeddings: input.embeddingProvider,
			circuitBreaker: input.circuitBreaker,
			offWithoutLlm: noLlm ? OFF_WITHOUT_LLM : []
		},
		index: {
			...input.index,
			breakdown: indexBreakdown(input.index)
		},
		indexPersistence: persistence,
		graph,
		graphCompaction: compaction,
		graphIndex,
		capture: input.capture ?? null,
		observeDedup: input.observeDedup ?? null,
		functions,
		flags: input.flags.map((flag) => flag.enabled && flag.needsLlm && noLlm ? {
			...flag,
			inactiveReason: "needs an LLM provider, none is configured"
		} : flag),
		problems
	};
}
const RECENT_DROP_MS = 1440 * 60 * 1e3;
const CURL_AUTH_HEADER = "-H \"Authorization: Bearer ${AGENTMEMORY_SECRET:-$(cat ~/.agentmemory/secret)}\"";
function captureRestBase(restPort) {
	return `http://localhost:${restPort ?? 3111}/agentmemory`;
}
function captureProblems(capture, now, restPort) {
	if (!capture) return [];
	const problems = [];
	const base = captureRestBase(restPort);
	const inbox = capture.inbox;
	if (inbox && inbox.dead > 0) {
		const sessionCap = inbox.lastError?.startsWith("Session observation limit reached") ?? false;
		const listAndRetry = `List them with curl -s ${CURL_AUTH_HEADER} '${base}/capture?status=dead'. After fixing the cause, retry them with curl -X POST ${base}/capture/retry ${CURL_AUTH_HEADER} -H "Content-Type: application/json" -d '{"all":true}'.`;
		problems.push({
			level: "warn",
			code: "capture-dead-letters",
			message: `${plural(inbox.dead, "captured observation")} could not be stored and ${inbox.dead === 1 ? "is parked as a dead letter" : "are parked as dead letters"}${inbox.lastError ? `: ${inbox.lastError}` : "."}`,
			fix: sessionCap ? `The session reached its MAX_OBS_PER_SESSION cap, so a retry is refused again until the cap is raised. Raise MAX_OBS_PER_SESSION in ~/.agentmemory/.env (0 = no cap) and restart agentmemory. ${listAndRetry}` : listAndRetry
		});
	}
	if (inbox && inbox.retrying + inbox.pending > 0) problems.push({
		level: "info",
		code: "capture-retrying",
		message: `${plural(inbox.retrying + inbox.pending, "accepted observation")} ${inbox.retrying + inbox.pending === 1 ? "is" : "are"} waiting to be stored${inbox.lastError ? ` after a failure: ${inbox.lastError}` : ""}.`,
		fix: `No action needed: the server retries every ${Math.round(capture.policy.retryIntervalMs / 1e3)} s with backoff, up to ${capture.policy.maxAttempts} attempts, and again after a restart.`
	});
	const waiting = capture.spool.reduce((n, s) => n + s.records, 0);
	if (waiting > 0) problems.push({
		level: "info",
		code: "capture-spool-waiting",
		message: `${plural(waiting, "observation")} captured while the server was unreachable ${waiting === 1 ? "is" : "are"} waiting in the local capture spool.`,
		fix: `They are sent on the next hook call and at every start. To send them now: npx @agentmemory/agentmemory capture --drain, or curl -X POST ${base}/capture/drain ${CURL_AUTH_HEADER}.`
	});
	let dropped = 0;
	let latest = null;
	for (const spool of capture.spool) {
		dropped += spool.stats.dropped;
		const lastDrop = spool.stats.lastDropAt ? Date.parse(spool.stats.lastDropAt) : NaN;
		if (Number.isFinite(lastDrop) && (!latest || lastDrop > latest.at)) latest = {
			at: lastDrop,
			reason: spool.stats.lastDropReason ?? "unknown",
			maxBytes: spool.maxBytes,
			maxAgeHours: spool.maxAgeHours
		};
	}
	if (latest && now.getTime() - latest.at < RECENT_DROP_MS) problems.push({
		level: "warn",
		code: "capture-spool-dropped",
		message: `The local capture spool dropped ${plural(dropped, "observation")} in total (latest reason: ${latest.reason}), so those tool calls are not in memory.`,
		fix: `The spool holds at most ${Math.round(latest.maxBytes / 1024)} KiB for ${latest.maxAgeHours} hours. Raise AGENTMEMORY_CAPTURE_SPOOL_MAX_BYTES, keep agentmemory running while agents work, or check that AGENTMEMORY_CAPTURE_SPOOL is not false.`
	});
	return problems;
}
function statusHeadline(status, problems) {
	if (status === "ok") return "Every check passed. Capture, search and the stream are working.";
	if (status === "info") return `Working normally. ${plural(problems.length, "note")} below about features that are off or checks that did not run.`;
	const worst = problems.find((p) => p.level === status) ?? problems[0];
	const rest = problems.length - 1;
	return `${status === "error" ? "Not working correctly" : "Working, but needs attention"}: ${worst.message}${rest > 0 ? ` (${plural(rest, "more item")} below.)` : ""}`;
}
function indexBreakdown(idx) {
	if (idx.memoriesIndexed === void 0 && idx.lessonsIndexed === void 0) return null;
	const lessons = idx.lessonsIndexed ?? 0;
	return {
		observations: Math.max(0, idx.observationsIndexed - lessons),
		memories: idx.memoriesIndexed ?? 0,
		lessons
	};
}
function plural(count, word) {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}
function documentBreakdown(idx) {
	const b = idx.breakdown;
	if (!b) return String(idx.bm25Documents);
	const parts = [
		plural(b.observations, "observation"),
		`${b.memories} ${b.memories === 1 ? "memory" : "memories"}`,
		plural(b.lessons, "lesson")
	];
	return `${idx.bm25Documents} (${parts.join(", ")})`;
}
function flagState(flag) {
	if (!flag.enabled) return "off";
	if (flag.inactiveReason) return `on, inactive: ${flag.inactiveReason}`;
	return "on";
}
function flagHowTo(flag) {
	if (!flag.enabled) return flag.enableHow;
	if (flag.inactiveReason) return LLM_KEY_FIX;
	return `Set ${flag.key}=false and restart to turn it off.`;
}
function processHealth(report) {
	const status = report.health?.status;
	if (!status) return "no data yet";
	if (status === "healthy" && report.status !== "ok") return "healthy (memory, CPU and engine checks only; the badge at the top covers every problem on this page)";
	return status;
}
function escapeHtml(value) {
	return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatDuration(seconds) {
	if (seconds === null) return "unknown";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d`;
}
function row(label, value) {
	return `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`;
}
function legSummary(report, leg) {
	if (leg.lastError) return `failing: ${leg.lastError}`;
	const saved = leg.lastSavedAt ? `saved ${formatDuration(secondsBetween(new Date(report.checkedAt), leg.lastSavedAt))} ago` : "not saved since start";
	return leg.dirtySince ? `${saved}, unsaved changes pending` : saved;
}
const PENDING_LOG_EXPLAINER = "Every new or removed vector is also written right away to this small log. After a crash or force-kill it is replayed at start, so vectors are not lost and nothing is embedded twice. Each index save empties it.";
function indexPersistenceRows(report) {
	const persistence = report.indexPersistence;
	if (!persistence) return "";
	let rows = row("BM25 index", "rebuilt from stored content at boot");
	if (persistence.vector) {
		rows += row("Vector save", escapeHtml(legSummary(report, persistence.vector)));
		rows += row("Vector storage", escapeHtml(`${plural(persistence.buckets, "bucket")}, ${plural(persistence.pendingChanges, "unsaved change")}`));
		if (persistence.pendingLog !== void 0) rows += row("Pending vector log", escapeHtml(plural(persistence.pendingLog, "vector change")) + `<p class="note">${escapeHtml(PENDING_LOG_EXPLAINER)}</p>`);
	}
	return rows;
}
function describeCaptureSpool(capture) {
	const records = capture.spool.reduce((n, s) => n + s.records, 0);
	const bytes = capture.spool.reduce((n, s) => n + s.bytes, 0);
	if (!capture.spool.some((s) => s.enabled)) return "off (AGENTMEMORY_CAPTURE_SPOOL=false)";
	const retained = capture.spool.reduce((n, s) => n + (s.retained ?? 0), 0);
	const held = retained > 0 ? `, ${retained} sent and kept until saved` : "";
	return records === 0 ? `empty${held}` : `${plural(records, "observation")} waiting, ${Math.ceil(bytes / 1024)} KiB${held}`;
}
function captureRows(report) {
	const capture = report.capture;
	if (!capture) return row("Capture", "not reported");
	const inbox = capture.inbox;
	const since = capture.sinceStart;
	let rows = row("Inbox", escapeHtml(inbox ? `${inbox.pending} pending · ${inbox.retrying} retrying · ${inbox.dead} dead letters` : "not checked") + "<p class=\"note\">Every accepted observation is written here first and removed once it is stored, so a failure or restart retries it instead of losing it.</p>");
	rows += row("Since start", escapeHtml(`${since.accepted} accepted · ${since.completed} stored · ${since.duplicates} duplicates skipped · ${since.recovered} recovered by retry · ${since.deadLettered} dead`));
	rows += row("Local spool", escapeHtml(describeCaptureSpool(capture)) + `<p class="note">Hooks write here when the server is unreachable, and keep each accepted observation here until the server has saved it to disk. ${escapeHtml(capture.spool.map((s) => s.path).join(", "))}</p>`);
	const drained = capture.spool.map((s) => s.stats.lastDrainAt).filter(Boolean).sort().pop();
	if (drained) rows += row("Last spool drain", escapeHtml(`${formatDuration(secondsBetween(new Date(report.checkedAt), drained))} ago`));
	rows += row("Duplicate protection", escapeHtml(`event ids kept ${capture.policy.dedupRetentionHours} h, retries up to ${plural(capture.policy.maxAttempts, "attempt")}`));
	return rows;
}
function mb(bytes) {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}
function processRows(report) {
	const h = report.health;
	let rows = row("Process health", escapeHtml(processHealth(report)));
	if (h?.memory) {
		const limit = h.memory.heapLimit || h.memory.heapTotal;
		const pct = limit > 0 ? Math.round(h.memory.heapUsed / limit * 100) : 0;
		rows += row("Heap", escapeHtml(`${mb(h.memory.heapUsed)} of ${mb(limit)} (${pct}%)`) + "<p class=\"note\">JavaScript memory in use against the most it may grow to. Only a concern above 80% while RSS is also over 512 MB.</p>");
		rows += row("RSS", escapeHtml(mb(h.memory.rss)) + "<p class=\"note\">Everything the process holds from the operating system, including code and buffers.</p>");
	}
	if (typeof h?.eventLoopLagMs === "number") rows += row("Event loop delay", escapeHtml(`${h.eventLoopLagMs.toFixed(1)} ms`) + "<p class=\"note\">How far behind the worker is. Under 100 ms is fine; above that requests answer slowly.</p>");
	return rows;
}
function renderStatusHtml(report, styleNonce, options = {}) {
	const viewerUrl = options.viewerUrl ?? "/agentmemory/viewer#health";
	const problems = report.problems.length ? report.problems.map((p) => `<li class="p ${p.level}"><span class="lvl">${p.level}</span><div><p>${escapeHtml(p.message)}</p>` + (p.fix ? `<p class="fix">${escapeHtml(p.fix)}</p>` : "") + `</div></li>`).join("") : `<li class="p ok"><span class="lvl">ok</span><div><p>No problems found.</p></div></li>`;
	const functions = report.functions.length ? report.functions.slice().sort((a, b) => b.totalCalls - a.totalCalls).map((f) => `<tr${!f.offWithoutLlm && f.failureRate >= FAILURE_RATE_THRESHOLD && f.totalCalls >= FAILURE_MIN_CALLS ? " class=\"bad\"" : ""}><td>${escapeHtml(f.functionId)}</td><td>${f.totalCalls}</td><td>${f.offWithoutLlm ? "-" : f.failureCount}</td><td>${f.offWithoutLlm ? "off, no LLM provider" : `${Math.round(f.failureRate * 100)}%`}</td><td>${Math.round(f.avgLatencyMs)} ms</td></tr>`).join("") : `<tr><td colspan="5">No function calls recorded yet.</td></tr>`;
	const flags = report.flags.map((f) => `<tr><td>${escapeHtml(f.label)}</td><td><code>${escapeHtml(f.key)}</code></td><td${f.inactiveReason ? " class=\"warn\"" : ""}>${escapeHtml(flagState(f))}</td><td>${escapeHtml(flagHowTo(f))}</td></tr>`).join("");
	const idx = report.index;
	const graph = report.graph;
	const ports = report.service.ports;
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentmemory status</title>
<style nonce="${escapeHtml(styleNonce)}">
:root{--bg:#F9F9F7;--bg-alt:#F0F0EC;--ink:#111111;--ink-muted:#666666;--line:#D4D4CF;--rule:#111111;--ok:#2D6A4F;--info:#1D4E89;--warn:#B8860B;--error:#CC0000;--font-display:'Playfair Display',Georgia,'Times New Roman',serif;--font-body:'Lora',Georgia,serif;--font-ui:'Inter',-apple-system,system-ui,sans-serif;--font-mono:'JetBrains Mono','SF Mono','Fira Code',ui-monospace,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121316;--bg-alt:#1a1c20;--ink:#eef0f3;--ink-muted:#94979d;--line:#26282c;--rule:#c9cbd1;--ok:#4ade80;--info:#93c5fd;--warn:#fbbf24;--error:#f2555a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 var(--font-body)}
main{max-width:960px;margin:0 auto;padding:32px 16px 64px}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;border-bottom:3px double var(--rule);padding-bottom:12px;margin-bottom:24px}
h1{font:700 26px/1.2 var(--font-display);margin:0}h2{font:600 11px/1.4 var(--font-ui);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-muted);margin:32px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--rule)}
.badge{font:700 11px/1.4 var(--font-ui);text-transform:uppercase;letter-spacing:.08em;padding:2px 8px;border:1.5px solid currentColor}
.ok{color:var(--ok)}.info{color:var(--info)}.warn{color:var(--warn)}.error{color:var(--error)}
.meta{color:var(--ink-muted);font:12px/1.4 var(--font-ui);margin-left:auto}
ul.problems{list-style:none;padding:0;margin:0}
li.p{display:grid;grid-template-columns:64px 1fr;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}
li.p p{margin:0;color:var(--ink)}li.p .fix{color:var(--ink-muted);margin-top:4px;font-size:13px}
.lvl{font:700 11px/1.4 var(--font-ui);text-transform:uppercase;letter-spacing:.08em;padding-top:2px}
table{width:100%;border-collapse:collapse;font:13px/1.5 var(--font-ui)}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th{color:var(--ink-muted);font-weight:500;width:220px}
table.list th{width:auto;font-size:11px;text-transform:uppercase;letter-spacing:.06em;overflow-wrap:normal}table.list td{overflow-wrap:break-word}table.list td code{overflow-wrap:break-word;word-break:normal}tr.bad td{color:var(--error)}
tr:nth-child(even) td{background:var(--bg-alt)}
code{font:12px var(--font-mono);overflow-wrap:anywhere}
.lead{font:600 16px/1.45 var(--font-body);margin:0 0 8px}.live{font:13px/1.5 var(--font-ui);color:var(--ink-muted);margin:0 0 8px}
.note{margin:2px 0 0;color:var(--ink-muted);font-size:12px}
a{color:inherit}
@media (max-width:640px){th{width:110px}table.list{table-layout:fixed}table.list th,table.list td{padding:6px 4px;font-size:12px}}
</style></head><body><main>
<header><h1>agentmemory</h1><span class="badge ${report.status}">${report.status}</span>
<span class="meta">v${escapeHtml(report.service.version)} · engine ${escapeHtml(report.service.engineVersion)} · checked ${escapeHtml(report.checkedAt)} · <a href="?format=json">json</a></span></header>
<p class="lead ${report.status}">${escapeHtml(report.headline)}</p>
<p class="live">A snapshot from when this page loaded. <a href="${escapeHtml(viewerUrl)}">Open the live version in the viewer &rarr;</a> From a terminal: <code>curl -s ${escapeHtml(CURL_AUTH_HEADER)} ${ports.rest ? `http://localhost:${escapeHtml(ports.rest)}` : ""}/agentmemory/status</code> returns this report as JSON.</p>
<h2>Problems</h2><ul class="problems">${problems}</ul>
<h2>Engine and connection</h2><table>
${row("Engine connection", escapeHtml(report.health?.connectionState ?? "unknown"))}
${row("Uptime", escapeHtml(formatDuration(report.service.uptimeSeconds)))}
${row("State backend", escapeHtml(report.service.stateBackend))}
${row("REST port", escapeHtml(ports.rest ?? "unknown"))}
${row("Streams port", escapeHtml(ports.streams ?? "unknown"))}
${row("Viewer port", escapeHtml(ports.viewer ?? "not running"))}
</table>
<h2>LLM and embeddings</h2><table>
${row("LLM", escapeHtml(report.provider.llm === "noop" ? "none configured" : report.provider.route ?? report.provider.llm))}
${report.provider.offWithoutLlm.length ? row("Off without an LLM", escapeHtml(report.provider.offWithoutLlm.join(", ")) + `<p class="note">${escapeHtml(LLM_KEY_FIX)}</p>`) : ""}
${row("Embeddings", escapeHtml(report.provider.embeddings === "none" ? "none (keyword search only)" : report.provider.embeddings))}
${row("Circuit breaker", escapeHtml(report.provider.circuitBreaker ? `${report.provider.circuitBreaker.state ?? "unknown"} (${report.provider.circuitBreaker.failures ?? 0} failures)` : "not in use"))}
</table>
<h2>Search index</h2><table>
${row("Keyword index (BM25)", escapeHtml(documentBreakdown(idx)) + `<p class="note">${escapeHtml(BM25_EXPLAINER)}</p>`)}
${row("Vector documents", escapeHtml(idx.vectorDocuments ?? "vector search off"))}
${row("Observations searchable", escapeHtml(idx.breakdown ? idx.breakdown.observations : idx.observationsIndexed))}
${row("Missing from index", escapeHtml(idx.missingObservations ?? "not checked"))}
${row("Sessions", escapeHtml(idx.sessions ?? "unknown"))}
${row("Keyword index rebuild", idx.bm25Incomplete ? "<span class=\"warn\">incomplete</span>" : "complete")}
${row("Pending vector backfill", escapeHtml(idx.pendingVectorBackfill))}
${idx.vectorBackfillState ? row("Vector backfill", escapeHtml(describeBackfillState(idx.vectorBackfillState))) : ""}
${indexPersistenceRows(report)}
</table>
<h2>Capture</h2><table>
${captureRows(report)}
${report.observeDedup ? row("Repeats skipped", escapeHtml(`${report.observeDedup.skippedSinceStart} since start`) + `<p class="note">${escapeHtml(`A tool call with the same input and the same output as one stored in the last ${formatDuration(report.observeDedup.windowSeconds)} is skipped when the hook sends no event id.`)}</p>`) : ""}
</table>
<h2>Knowledge graph</h2><table>
${graph ? row("Extraction", graph.extractionEnabled ? "on" : "off") + row("Nodes / edges", escapeHtml(`${graph.totalNodes ?? "unknown"} / ${graph.totalEdges ?? "unknown"}`)) + row(graph.fromIndex ? "Count source" : "Snapshot age", escapeHtml(graph.fromIndex ? "maintained index" : graph.fromSnapshot ? formatDuration(graph.ageSeconds) : "no snapshot")) : row("Graph", "unavailable")}
${report.graphCompaction ? row("Provenance compaction", escapeHtml(describeGraphCompactBoot(report.graphCompaction))) : ""}
${report.graphIndex ? row("Retrieval index", escapeHtml(`${report.graphIndex.state}, ${report.graphIndex.coverage} coverage`)) : ""}
</table>
<h2>Features</h2><table class="list"><tr><th>Feature</th><th>Setting</th><th>State</th><th>How to change</th></tr>${flags}</table>
<h2>Process</h2><table>
${processRows(report)}
</table>
<h2>Functions</h2><table class="list"><tr><th>Function</th><th>Calls</th><th>Failed</th><th>Failure rate</th><th>Avg latency</th></tr>${functions}</table>
<h2>More</h2><p>Environment checks (keys, engine binary, stale pid files) run on your machine with <code>npx @agentmemory/agentmemory doctor</code>. JSON: <code>GET /agentmemory/status</code> with <code>Accept: application/json</code>, or add <code>?format=json</code>.</p>
</main></body></html>`;
}
function graphCompactCommand(restPort) {
	return `curl -X POST http://localhost:${restPort ?? 3111}/agentmemory/graph/compact ${CURL_AUTH_HEADER} -H "Content-Type: application/json" -d '{}'`;
}
const UNINDEXED_SCAN_REUSE_MS = 3e4;
function singleFlight(run, reuseMs, now = Date.now) {
	let current = null;
	return () => {
		if (current && (current.settledAt === null || now() - current.settledAt < reuseMs)) return current.promise;
		const entry = {
			promise: run(),
			settledAt: null
		};
		entry.promise.then(() => {
			entry.settledAt = now();
		}, () => {
			if (current === entry) current = null;
		});
		current = entry;
		return entry.promise;
	};
}
function prefersHtml(accept, format) {
	if (format === "json") return false;
	if (format === "html") return true;
	if (!accept) return false;
	return /\btext\/html\b/.test(accept);
}
//#endregion
//#region src/prompts/compression.ts
const COMPRESSION_SYSTEM = `You are a memory compression engine for an AI coding agent. Your job is to extract the essential information from a tool usage observation and compress it into structured data.

Output EXACTLY this XML format with no additional text:

<observation>
  <type>one of: file_read, file_write, file_edit, command_run, search, web_fetch, conversation, error, decision, discovery, subagent, notification, task, other</type>
  <title>Short descriptive title (max 80 chars)</title>
  <subtitle>One-line context (optional)</subtitle>
  <facts>
    <fact>Specific factual detail 1</fact>
    <fact>Specific factual detail 2</fact>
  </facts>
  <narrative>2-3 sentence summary of what happened and why it matters</narrative>
  <concepts>
    <concept>technical concept or pattern</concept>
  </concepts>
  <files>
    <file>path/to/file</file>
  </files>
  <importance>1-10 scale, 10 being critical architectural decision</importance>
</observation>

Rules:
- Escape &, <, and > inside text as &amp;, &lt;, and &gt;. Use only the tags shown, with no attributes or nested tags inside text fields.
- Be concise but preserve ALL technically relevant details
- File paths must be exact
- Importance: 1-3 for routine reads, 4-6 for edits/commands, 7-9 for architectural decisions, 10 for breaking changes
- Concepts should be reusable search terms (e.g., "React hooks", "SQL migration", "auth middleware")
- Strip any secrets, tokens, or credentials from the output`;
function buildCompressionPrompt(observation) {
	const parts = [`Timestamp: ${observation.timestamp}`, `Hook: ${observation.hookType}`];
	if (observation.toolName) parts.push(`Tool: ${observation.toolName}`);
	if (observation.toolInput) {
		const input = typeof observation.toolInput === "string" ? observation.toolInput : JSON.stringify(observation.toolInput, null, 2);
		parts.push(`Input:\n${truncate$1(input, 4e3)}`);
	}
	if (observation.toolOutput) {
		const output = typeof observation.toolOutput === "string" ? observation.toolOutput : JSON.stringify(observation.toolOutput, null, 2);
		parts.push(`Output:\n${truncate$1(output, 4e3)}`);
	}
	if (observation.userPrompt) parts.push(`User prompt:\n${truncate$1(observation.userPrompt, 2e3)}`);
	if (observation.assistantResponse) parts.push(`Assistant response:\n${truncate$1(observation.assistantResponse, 4e3)}`);
	return parts.join("\n\n");
}
function truncate$1(s, max) {
	return s.length > max ? s.slice(0, max) + "\n[...truncated]" : s;
}
//#endregion
//#region src/prompts/vision.ts
const VISION_DESCRIPTION_PROMPT = `Describe what this image shows in the context of software development. Extract:
- What type of image this is (screenshot, diagram, mockup, terminal output, error, etc.)
- Key entities visible (files, components, UI elements, error messages)
- Relationships or flow shown
- Any decisions, errors, or state visible
- Text content visible in the image

Be concise but preserve all technically relevant details. Output plain text, no XML.`;
//#endregion
//#region src/prompts/compression-output.ts
function elements(xml) {
	const result = [];
	let remaining = xml.trim();
	while (remaining) {
		const match = /^<([a-z][a-z0-9_-]*)\s*(?:\/>|>([\s\S]*?)<\/\1\s*>)/.exec(remaining);
		if (!match) return null;
		result.push({
			name: match[1],
			content: match[2] ?? ""
		});
		remaining = remaining.slice(match[0].length).trim();
	}
	return result;
}
function xmlText(content) {
	if (content.includes("<") || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(content)) return null;
	const entities = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: "\"",
		apos: "'"
	};
	let valid = true;
	const text = content.replace(/&([^;]+);/g, (_, entity) => {
		if (entity in entities) return entities[entity];
		const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
		if (!(code === 9 || code === 10 || code === 13 || code >= 32 && code <= 55295 || code >= 57344 && code <= 65533 || code >= 65536 && code <= 1114111)) {
			valid = false;
			return "";
		}
		return String.fromCodePoint(code);
	});
	return valid && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? text.trim() : null;
}
const SCALARS = new Set([
	"type",
	"title",
	"subtitle",
	"narrative",
	"importance"
]);
const LISTS = {
	facts: "fact",
	concepts: "concept",
	files: "file"
};
function parseCompressionXml(response) {
	let xml = response.trim();
	xml = xml.replace(/^<(think|thought)>[\s\S]*?<\/\1>\s*/, "");
	const fenced = /^```(?:xml)?\s*\n([\s\S]*?)\n```$/i.exec(xml);
	if (fenced) xml = fenced[1].trim();
	const roots = elements(xml);
	if (!roots || roots.length !== 1 || roots[0].name !== "observation") return null;
	const fields = elements(roots[0].content);
	if (!fields) return null;
	const seen = /* @__PURE__ */ new Set();
	const scalars = {};
	const lists = {
		facts: [],
		concepts: [],
		files: []
	};
	for (const field of fields) {
		if (seen.has(field.name)) return null;
		seen.add(field.name);
		if (SCALARS.has(field.name)) {
			const text = xmlText(field.content);
			if (text === null) return null;
			scalars[field.name] = text;
		} else if (Object.hasOwn(LISTS, field.name)) {
			const children = elements(field.content);
			if (!children) return null;
			for (const child of children) {
				if (child.name !== LISTS[field.name]) return null;
				const text = xmlText(child.content);
				if (text === null || !text) return null;
				lists[field.name].push(text);
			}
		} else return null;
	}
	return {
		type: scalars.type ?? "",
		title: scalars.title ?? "",
		subtitle: scalars.subtitle || void 0,
		facts: lists.facts,
		narrative: scalars.narrative ?? "",
		concepts: lists.concepts,
		files: lists.files,
		importance: /^\d+$/.test(scalars.importance ?? "") ? Number(scalars.importance) : NaN
	};
}
//#endregion
//#region src/state/stemmer.ts
const step2map = {
	ational: "ate",
	tional: "tion",
	enci: "ence",
	anci: "ance",
	izer: "ize",
	iser: "ise",
	abli: "able",
	alli: "al",
	entli: "ent",
	eli: "e",
	ousli: "ous",
	ization: "ize",
	isation: "ise",
	ation: "ate",
	ator: "ate",
	alism: "al",
	iveness: "ive",
	fulness: "ful",
	ousness: "ous",
	aliti: "al",
	iviti: "ive",
	biliti: "ble"
};
const step3map = {
	icate: "ic",
	ative: "",
	alize: "al",
	alise: "al",
	iciti: "ic",
	ical: "ic",
	ful: "",
	ness: ""
};
function hasVowel(s) {
	return /[aeiou]/.test(s);
}
function measure(s) {
	const m = s.replace(/[^aeiouy]+/g, "C").replace(/[aeiouy]+/g, "V").match(/VC/g);
	return m ? m.length : 0;
}
function endsDoubleConsonant(s) {
	return s.length >= 2 && s[s.length - 1] === s[s.length - 2] && !/[aeiou]/.test(s[s.length - 1]);
}
function endsCVC(s) {
	if (s.length < 3) return false;
	const c1 = s[s.length - 3], v = s[s.length - 2], c2 = s[s.length - 1];
	return !/[aeiou]/.test(c1) && /[aeiou]/.test(v) && !/[aeiouwxy]/.test(c2);
}
function stem(word) {
	if (word.length <= 2) return word;
	let w = word;
	if (w.endsWith("sses")) w = w.slice(0, -2);
	else if (w.endsWith("ies")) w = w.slice(0, -2);
	else if (!w.endsWith("ss") && w.endsWith("s")) w = w.slice(0, -1);
	if (w.endsWith("eed")) {
		if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
	} else if (w.endsWith("ed") && hasVowel(w.slice(0, -2))) {
		w = w.slice(0, -2);
		if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
		else if (endsDoubleConsonant(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
		else if (measure(w) === 1 && endsCVC(w)) w += "e";
	} else if (w.endsWith("ing") && hasVowel(w.slice(0, -3))) {
		w = w.slice(0, -3);
		if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
		else if (endsDoubleConsonant(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
		else if (measure(w) === 1 && endsCVC(w)) w += "e";
	}
	if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + "i";
	for (const [suffix, replacement] of Object.entries(step2map)) if (w.endsWith(suffix)) {
		const base = w.slice(0, -suffix.length);
		if (measure(base) > 0) w = base + replacement;
		break;
	}
	for (const [suffix, replacement] of Object.entries(step3map)) if (w.endsWith(suffix)) {
		const base = w.slice(0, -suffix.length);
		if (measure(base) > 0) w = base + replacement;
		break;
	}
	if (w.endsWith("al") || w.endsWith("ance") || w.endsWith("ence") || w.endsWith("er") || w.endsWith("ic") || w.endsWith("able") || w.endsWith("ible") || w.endsWith("ant") || w.endsWith("ement") || w.endsWith("ment") || w.endsWith("ent") || w.endsWith("tion") || w.endsWith("sion") || w.endsWith("ou") || w.endsWith("ism") || w.endsWith("ate") || w.endsWith("iti") || w.endsWith("ous") || w.endsWith("ive") || w.endsWith("ize") || w.endsWith("ise")) {
		const suffixLen = w.match(/(ement|ment|tion|sion|ance|ence|able|ible|ism|ate|iti|ous|ive|ize|ise|ant|ent|al|er|ic|ou)$/)?.[0]?.length ?? 0;
		if (suffixLen > 0) {
			const base = w.slice(0, -suffixLen);
			if (measure(base) > 1) w = base;
		}
	}
	if (w.endsWith("e")) {
		const base = w.slice(0, -1);
		if (measure(base) > 1 || measure(base) === 1 && !endsCVC(base)) w = base;
	}
	if (endsDoubleConsonant(w) && w.endsWith("l") && measure(w.slice(0, -1)) > 1) w = w.slice(0, -1);
	return w;
}
//#endregion
//#region src/state/synonyms.ts
const SYNONYM_GROUPS = [
	[
		"auth",
		"authentication",
		"authn",
		"authenticating"
	],
	[
		"authz",
		"authorization",
		"authorizing"
	],
	[
		"db",
		"database",
		"datastore"
	],
	[
		"perf",
		"performance",
		"latency",
		"throughput",
		"slow",
		"bottleneck"
	],
	[
		"optim",
		"optimization",
		"optimizing",
		"optimise",
		"query-optimization"
	],
	[
		"k8s",
		"kubernetes",
		"kube"
	],
	[
		"config",
		"configuration",
		"configuring",
		"setup"
	],
	[
		"deps",
		"dependencies",
		"dependency"
	],
	["env", "environment"],
	["fn", "function"],
	[
		"impl",
		"implementation",
		"implementing"
	],
	[
		"msg",
		"message",
		"messaging"
	],
	["repo", "repository"],
	["req", "request"],
	["res", "response"],
	["ts", "typescript"],
	["js", "javascript"],
	[
		"pg",
		"postgres",
		"postgresql"
	],
	[
		"err",
		"error",
		"errors"
	],
	[
		"api",
		"endpoint",
		"endpoints"
	],
	["ci", "continuous-integration"],
	["cd", "continuous-deployment"],
	[
		"test",
		"testing",
		"tests"
	],
	[
		"doc",
		"documentation",
		"docs"
	],
	["infra", "infrastructure"],
	[
		"deploy",
		"deployment",
		"deploying"
	],
	[
		"cache",
		"caching",
		"cached"
	],
	[
		"log",
		"logging",
		"logs"
	],
	["monitor", "monitoring"],
	["observe", "observability"],
	[
		"sec",
		"security",
		"secure"
	],
	[
		"validate",
		"validation",
		"validating"
	],
	[
		"migrate",
		"migration",
		"migrations"
	],
	["debug", "debugging"],
	[
		"container",
		"containerization",
		"docker"
	],
	[
		"crash",
		"crashloop",
		"crashloopbackoff"
	],
	[
		"webhook",
		"webhooks",
		"callback"
	],
	["middleware", "mw"],
	["paginate", "pagination"],
	["serialize", "serialization"],
	["encrypt", "encryption"],
	["hash", "hashing"]
];
const synonymMap = /* @__PURE__ */ new Map();
for (const group of SYNONYM_GROUPS) {
	const stemmed = group.map((t) => stem(t.toLowerCase()));
	for (const s of stemmed) {
		if (!synonymMap.has(s)) synonymMap.set(s, /* @__PURE__ */ new Set());
		for (const other of stemmed) if (other !== s) synonymMap.get(s).add(other);
	}
}
function getSynonyms(stemmedTerm) {
	const syns = synonymMap.get(stemmedTerm);
	return syns ? [...syns] : [];
}
//#endregion
//#region src/state/search-index.ts
var SearchIndex = class SearchIndex {
	entries = /* @__PURE__ */ new Map();
	invertedIndex = /* @__PURE__ */ new Map();
	docTermCounts = /* @__PURE__ */ new Map();
	totalDocLength = 0;
	sortedTerms = null;
	revisionGeneration = {};
	absentRevisions = /* @__PURE__ */ new Map();
	k1 = 1.2;
	b = .75;
	add(obs, layer = "observation") {
		this.invalidateAbsentRevision(obs.id);
		if (this.entries.has(obs.id)) this.remove(obs.id);
		const terms = this.extractTerms(obs);
		const termFreq = /* @__PURE__ */ new Map();
		let termCount = 0;
		for (const term of terms) {
			termFreq.set(term, (termFreq.get(term) || 0) + 1);
			termCount++;
		}
		this.entries.set(obs.id, {
			obsId: obs.id,
			sessionId: obs.sessionId,
			termCount,
			layer,
			timestamp: obs.timestamp
		});
		this.docTermCounts.set(obs.id, termFreq);
		this.totalDocLength += termCount;
		for (const term of termFreq.keys()) {
			if (!this.invertedIndex.has(term)) this.invertedIndex.set(term, /* @__PURE__ */ new Set());
			this.invertedIndex.get(term).add(obs.id);
		}
		this.sortedTerms = null;
	}
	watchRevision(id) {
		const generation = this.revisionGeneration;
		const entry = this.entries.get(id);
		if (entry) return {
			isCurrent: () => this.revisionGeneration === generation && this.entries.get(id) === entry,
			release: () => {}
		};
		let slot = this.absentRevisions.get(id);
		if (!slot) {
			slot = {
				token: {},
				readers: 0
			};
			this.absentRevisions.set(id, slot);
		}
		slot.readers++;
		const token = slot.token;
		let released = false;
		return {
			isCurrent: () => !released && this.revisionGeneration === generation && this.entries.get(id) === void 0 && slot.token === token,
			release: () => {
				if (released) return;
				released = true;
				slot.readers--;
				if (slot.readers === 0 && this.absentRevisions.get(id) === slot) this.absentRevisions.delete(id);
			}
		};
	}
	invalidateAbsentRevision(id) {
		const slot = this.absentRevisions.get(id);
		if (slot) slot.token = {};
	}
	invalidateRevision(id) {
		this.invalidateAbsentRevision(id);
		const entry = this.entries.get(id);
		if (entry) this.entries.set(id, { ...entry });
	}
	has(id) {
		return this.entries.has(id);
	}
	sessionOf(id) {
		return this.entries.get(id)?.sessionId;
	}
	layerOf(id) {
		return this.entries.get(id)?.layer;
	}
	countMissingDocuments(hasDocument, since, activeIds) {
		const cutoff = typeof since === "string" ? Date.parse(since) : NaN;
		let missing = 0;
		for (const entry of this.entries.values()) {
			if (entry.layer !== "observation" && entry.layer !== "memory") continue;
			if (Number.isFinite(cutoff) && !(Date.parse(entry.timestamp ?? "") > cutoff) && !activeIds?.has(entry.obsId)) continue;
			if (!hasDocument(entry.obsId)) missing++;
		}
		return missing;
	}
	observationCountsBySession() {
		const counts = /* @__PURE__ */ new Map();
		for (const entry of this.entries.values()) {
			if (entry.layer !== "observation") continue;
			counts.set(entry.sessionId, (counts.get(entry.sessionId) ?? 0) + 1);
		}
		return counts;
	}
	documentKindCounts() {
		let memories = 0;
		let lessons = 0;
		for (const entry of this.entries.values()) if (entry.layer === "memory") memories++;
		else if (entry.layer === "lesson") lessons++;
		return {
			memories,
			lessons
		};
	}
	remove(id) {
		this.invalidateAbsentRevision(id);
		const entry = this.entries.get(id);
		if (!entry) return;
		const termFreq = this.docTermCounts.get(id);
		if (termFreq) {
			for (const term of termFreq.keys()) {
				const postingList = this.invertedIndex.get(term);
				if (postingList) {
					postingList.delete(id);
					if (postingList.size === 0) this.invertedIndex.delete(term);
				}
			}
			this.docTermCounts.delete(id);
		}
		this.totalDocLength = Math.max(0, this.totalDocLength - entry.termCount);
		this.entries.delete(id);
		this.sortedTerms = null;
	}
	search(query, limit = 20, targetLayer = "all") {
		const rawTerms = this.tokenize(query.toLowerCase());
		if (rawTerms.length === 0) return [];
		const N = this.entries.size;
		if (N === 0) return [];
		const avgDocLen = this.totalDocLength / N;
		const queryTerms = [];
		const seen = /* @__PURE__ */ new Set();
		for (const term of rawTerms) {
			if (!seen.has(term)) {
				seen.add(term);
				queryTerms.push({
					term,
					weight: 1
				});
			}
			for (const syn of getSynonyms(term)) if (!seen.has(syn)) {
				seen.add(syn);
				queryTerms.push({
					term: syn,
					weight: .7
				});
			}
		}
		const scores = /* @__PURE__ */ new Map();
		const sorted = this.getSortedTerms();
		for (const { term, weight } of queryTerms) {
			const matchingDocs = this.invertedIndex.get(term);
			if (matchingDocs) {
				const df = matchingDocs.size;
				const idf = Math.log((N - df + .5) / (df + .5) + 1);
				for (const obsId of matchingDocs) {
					const entry = this.entries.get(obsId);
					if (!matchesSearchLayer(obsId, entry.sessionId, targetLayer, entry.layer)) continue;
					const tf = this.docTermCounts.get(obsId)?.get(term) || 0;
					const docLen = entry.termCount;
					const bm25Score = idf * (tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen)))) * weight;
					scores.set(obsId, (scores.get(obsId) || 0) + bm25Score);
				}
			}
			const prefixScores = /* @__PURE__ */ new Map();
			const startIdx = this.lowerBound(sorted, term);
			for (let si = startIdx; si < sorted.length; si++) {
				const indexTerm = sorted[si];
				if (!indexTerm.startsWith(term)) break;
				if (indexTerm === term) continue;
				const obsIds = this.invertedIndex.get(indexTerm);
				const prefixDf = obsIds.size;
				const prefixIdf = Math.log((N - prefixDf + .5) / (prefixDf + .5) + 1) * .5;
				for (const obsId of obsIds) {
					if (matchingDocs?.has(obsId)) continue;
					const entry = this.entries.get(obsId);
					if (!matchesSearchLayer(obsId, entry.sessionId, targetLayer, entry.layer)) continue;
					const tf = this.docTermCounts.get(obsId)?.get(indexTerm) || 0;
					const docLen = entry.termCount;
					const score = prefixIdf * (tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen)))) * weight;
					prefixScores.set(obsId, Math.max(prefixScores.get(obsId) ?? 0, score));
				}
			}
			for (const [obsId, score] of prefixScores) scores.set(obsId, (scores.get(obsId) ?? 0) + score);
		}
		return Array.from(scores.entries()).map(([obsId, score]) => {
			return {
				obsId,
				sessionId: this.entries.get(obsId).sessionId,
				score
			};
		}).sort((a, b) => b.score - a.score).slice(0, limit);
	}
	get size() {
		return this.entries.size;
	}
	clear() {
		this.revisionGeneration = {};
		this.absentRevisions.clear();
		this.entries.clear();
		this.invertedIndex.clear();
		this.docTermCounts.clear();
		this.totalDocLength = 0;
		this.sortedTerms = null;
	}
	restoreFrom(other) {
		this.revisionGeneration = {};
		this.absentRevisions.clear();
		this.entries = new Map(Array.from(other.entries.entries()).map(([k, v]) => [k, { ...v }]));
		this.invertedIndex = new Map(Array.from(other.invertedIndex.entries()).map(([k, v]) => [k, new Set(v)]));
		this.docTermCounts = new Map(Array.from(other.docTermCounts.entries()).map(([k, v]) => [k, new Map(v)]));
		this.totalDocLength = other.totalDocLength;
		this.sortedTerms = null;
	}
	serialize() {
		const entries = Array.from(this.entries.entries());
		const inverted = Array.from(this.invertedIndex.entries()).map(([term, ids]) => [term, Array.from(ids)]);
		const docTerms = Array.from(this.docTermCounts.entries()).map(([id, counts]) => [id, Array.from(counts.entries())]);
		return JSON.stringify({
			v: 3,
			entries,
			inverted,
			docTerms,
			totalDocLength: this.totalDocLength
		});
	}
	static deserialize(json) {
		try {
			const idx = new SearchIndex();
			const data = JSON.parse(json);
			if (!data?.entries || !data?.inverted || !data?.docTerms) return idx;
			for (const [key, val] of data.entries) idx.entries.set(key, {
				...val,
				layer: isSearchResultLayer(val.layer) ? val.layer : getSearchResultLayer(key, val.sessionId)
			});
			for (const [term, ids] of data.inverted) idx.invertedIndex.set(term, new Set(ids));
			for (const [id, counts] of data.docTerms) idx.docTermCounts.set(id, new Map(counts));
			const rawLen = Number(data.totalDocLength);
			idx.totalDocLength = Number.isFinite(rawLen) && rawLen >= 0 ? Math.floor(rawLen) : 0;
			return idx;
		} catch {
			return new SearchIndex();
		}
	}
	extractTerms(obs) {
		const parts = [
			obs.title,
			obs.subtitle || "",
			obs.narrative,
			...obs.facts,
			...obs.concepts,
			...obs.files,
			obs.type
		];
		return this.tokenize(parts.join(" ").toLowerCase());
	}
	tokenize(text) {
		const cleaned = text.replace(/[^\p{L}\p{N}\s/.\\-_]/gu, " ");
		const out = [];
		for (const raw of cleaned.split(/\s+/)) {
			if (raw.length < 2) continue;
			if (hasCjk(raw)) {
				for (const seg of segmentCjk(raw)) if (seg.length >= 1) out.push(seg);
			} else out.push(stem(raw));
		}
		return out;
	}
	getSortedTerms() {
		if (!this.sortedTerms) this.sortedTerms = Array.from(this.invertedIndex.keys()).sort();
		return this.sortedTerms;
	}
	lowerBound(arr, target) {
		let lo = 0;
		let hi = arr.length;
		while (lo < hi) {
			const mid = lo + hi >>> 1;
			if (arr[mid] < target) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}
};
//#endregion
//#region src/functions/access-tracker.ts
const RECENT_CAP = 20;
function emptyAccessLog(memoryId) {
	return {
		memoryId,
		count: 0,
		lastAt: "",
		recent: []
	};
}
function normalizeAccessLog(raw) {
	const r = raw ?? {};
	const rawCount = typeof r.count === "number" && Number.isFinite(r.count) ? r.count : 0;
	const count = Math.max(0, Math.floor(rawCount));
	const rawRecent = Array.isArray(r.recent) ? r.recent.filter((x) => typeof x === "number" && Number.isFinite(x)) : [];
	const recent = rawRecent.length > RECENT_CAP ? rawRecent.slice(-RECENT_CAP) : rawRecent;
	return {
		memoryId: typeof r.memoryId === "string" ? r.memoryId : "",
		count: Math.max(count, recent.length),
		lastAt: typeof r.lastAt === "string" ? r.lastAt : "",
		recent
	};
}
async function getAccessLog(kv, memoryId) {
	try {
		const raw = await kv.get(KV.accessLog, memoryId);
		if (!raw) return emptyAccessLog(memoryId);
		const normalized = normalizeAccessLog(raw);
		if (!normalized.memoryId) normalized.memoryId = memoryId;
		return normalized;
	} catch {
		return emptyAccessLog(memoryId);
	}
}
async function recordAccess(kv, memoryId, timestampMs) {
	if (!memoryId) return;
	const ts = timestampMs ?? Date.now();
	try {
		await withKeyedLock(`mem:access:${memoryId}`, async () => {
			const existing = await getAccessLog(kv, memoryId);
			existing.count += 1;
			existing.lastAt = new Date(ts).toISOString();
			existing.recent.push(ts);
			if (existing.recent.length > RECENT_CAP) existing.recent = existing.recent.slice(-RECENT_CAP);
			await kv.set(KV.accessLog, memoryId, existing);
		});
	} catch (err) {
		try {
			logger.warn("recordAccess failed", {
				memoryId,
				error: err instanceof Error ? err.message : String(err)
			});
		} catch {}
	}
}
async function recordAccessBatch(kv, memoryIds, timestampMs) {
	if (!memoryIds || memoryIds.length === 0) return;
	const ts = timestampMs ?? Date.now();
	const unique = Array.from(new Set(memoryIds.filter(Boolean)));
	await Promise.allSettled(unique.map((id) => recordAccess(kv, id, ts)));
}
async function deleteAccessLog(kv, memoryId) {
	if (!memoryId) return;
	try {
		await withKeyedLock(`mem:access:${memoryId}`, async () => {
			await kv.delete(KV.accessLog, memoryId);
		});
	} catch {}
}
//#endregion
//#region src/functions/observation-source.ts
const OBSERVATION_SOURCE_MAX_BYTES = 16 * 1024;
function sanitize(value) {
	if (typeof value === "string") return stripPrivateData(value);
	if (Array.isArray(value)) return value.map(sanitize);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [stripPrivateData(key), sanitize(entry)]));
	return value;
}
function bytes(value) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function prefixWithinBytes(text, budget) {
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (bytes(text.slice(0, mid)) <= budget) low = mid;
		else high = mid - 1;
	}
	if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
	return text.slice(0, low);
}
function createObservationSource(raw, previous, maxBytes = OBSERVATION_SOURCE_MAX_BYTES) {
	const fields = {
		toolName: raw.toolName,
		toolInput: raw.toolInput,
		toolOutput: raw.toolOutput,
		userPrompt: raw.userPrompt,
		assistantResponse: raw.assistantResponse
	};
	if (Object.values(fields).every((value) => value === void 0)) fields.payload = raw.raw;
	const retained = sanitize(fields);
	const hookType = prefixWithinBytes(stripPrivateData(raw.hookType), 128);
	const dropped = raw.assistantResponseBytes === void 0 ? 0 : Math.max(0, raw.assistantResponseBytes - Buffer.byteLength(raw.assistantResponse ?? "", "utf8"));
	const originalBytes = Math.max(bytes({
		hookType: raw.hookType,
		...retained
	}) + dropped, previous?.originalBytes ?? 0);
	const full = {
		hookType,
		originalBytes,
		truncated: previous?.truncated === true || hookType !== raw.hookType || dropped > 0,
		...retained
	};
	if (bytes(full) <= maxBytes) return full;
	const bounded = {
		hookType,
		originalBytes,
		truncated: true
	};
	for (const [key, value] of Object.entries(retained)) {
		if (value === void 0) continue;
		if (bytes({
			...bounded,
			[key]: value
		}) <= maxBytes) {
			Object.assign(bounded, { [key]: value });
			continue;
		}
		const budget = maxBytes - bytes({
			...bounded,
			[key]: ""
		}) + 2;
		if (budget >= 2) {
			const text = typeof value === "string" ? value : JSON.stringify(value);
			Object.assign(bounded, { [key]: prefixWithinBytes(text, budget) });
		}
		break;
	}
	return bounded;
}
function normalizeObservationSource(value, maxBytes = OBSERVATION_SOURCE_MAX_BYTES) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
	const source = value;
	if (typeof source.hookType !== "string" || !source.hookType) return void 0;
	return createObservationSource({
		id: "",
		sessionId: "",
		timestamp: "",
		hookType: source.hookType,
		toolName: typeof source.toolName === "string" ? source.toolName : void 0,
		toolInput: source.toolInput,
		toolOutput: source.toolOutput,
		userPrompt: typeof source.userPrompt === "string" ? source.userPrompt : void 0,
		assistantResponse: typeof source.assistantResponse === "string" ? source.assistantResponse : void 0,
		raw: source.payload
	}, {
		originalBytes: Number.isSafeInteger(source.originalBytes) && source.originalBytes >= 0 ? source.originalBytes : 0,
		truncated: source.truncated === true
	}, maxBytes);
}
function withoutObservationSource(observation) {
	const { source: _source, ...summary } = observation;
	return summary;
}
function rawFromObservationSource(observation) {
	const source = observation.source;
	if (!source || typeof source.hookType !== "string") return null;
	return {
		id: observation.id,
		sessionId: observation.sessionId,
		timestamp: observation.timestamp,
		hookType: source.hookType,
		toolName: source.toolName,
		toolInput: source.toolInput,
		toolOutput: source.toolOutput,
		userPrompt: source.userPrompt,
		assistantResponse: source.assistantResponse,
		raw: source.payload ?? {},
		modality: observation.modality,
		imageData: observation.imageRef ?? observation.imageData,
		agentId: observation.agentId,
		origin: observation.origin
	};
}
//#endregion
//#region src/functions/search.ts
let index = null;
let vectorIndex = null;
let currentEmbeddingProvider = null;
let hybridRanker = null;
function setHybridRanker(fn) {
	hybridRanker = fn;
}
let rebuildPromise = null;
let memoryIndexReady = false;
function isMemoryIndexReady() {
	return memoryIndexReady;
}
let bm25RebuildIncomplete = false;
function isBm25RebuildIncomplete() {
	return bm25RebuildIncomplete;
}
let keywordRebuildPending = false;
let keywordRebuildsRunning = 0;
let keywordRebuildEpoch = 0;
function getKeywordRebuildEpoch() {
	return keywordRebuildEpoch;
}
function markKeywordRebuildPending() {
	keywordRebuildPending = true;
}
function isKeywordRebuildInProgress() {
	return keywordRebuildPending || keywordRebuildsRunning > 0;
}
let pendingVectorBackfill = 0;
let vectorBackfillState = "idle";
function getVectorBackfillState() {
	return vectorBackfillState;
}
function setVectorBackfillState(state) {
	vectorBackfillState = state;
}
function getPendingVectorBackfillCount() {
	return pendingVectorBackfill;
}
function setPendingVectorBackfillCount(n) {
	pendingVectorBackfill = Math.max(0, n);
}
function getSearchIndex() {
	if (!index) index = new SearchIndex();
	return index;
}
function setVectorIndex(idx) {
	vectorIndex = idx;
}
function getVectorIndex() {
	return vectorIndex;
}
function setEmbeddingProvider(provider) {
	currentEmbeddingProvider = provider;
}
function getEmbeddingProvider() {
	return currentEmbeddingProvider;
}
const RANK_FUSION_K = 60;
async function rankMemoryIds(query, limit) {
	const fetchLimit = Math.max(limit * 4, 50);
	const keyword = getSearchIndex().search(query, fetchLimit, "memory");
	let semantic = [];
	if (vectorIndex && vectorIndex.size > 0 && currentEmbeddingProvider) try {
		const embedding = await currentEmbeddingProvider.embed(query);
		semantic = vectorIndex.search(embedding, fetchLimit, "memory", (id) => getSearchIndex().layerOf(id));
	} catch (err) {
		logger.warn("memory vector ranking failed, using keyword ranking", { error: err instanceof Error ? err.message : String(err) });
	}
	const scores = /* @__PURE__ */ new Map();
	const addRanks = (hits) => {
		hits.forEach((hit, rank) => {
			scores.set(hit.obsId, (scores.get(hit.obsId) ?? 0) + 1 / (RANK_FUSION_K + rank + 1));
		});
	};
	addRanks(keyword);
	addRanks(semantic);
	return {
		ids: Array.from(scores.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id),
		mode: semantic.length > 0 ? "hybrid" : "keyword"
	};
}
function vectorIndexRemove(id) {
	getSearchIndex().invalidateRevision(id);
	vectorIndex?.remove(id);
}
let indexPersistence = null;
function setIndexPersistence(p) {
	indexPersistence = p;
}
function getIndexPersistenceStatus() {
	return indexPersistence?.status?.() ?? null;
}
function scheduleIndexSave() {
	indexPersistence?.scheduleSave();
}
async function flushIndexSave() {
	await indexPersistence?.save();
}
const EMBED_MAX_CHARS = 16e3;
function clipEmbedInput(text) {
	if (text.length <= EMBED_MAX_CHARS) return text;
	return text.slice(0, EMBED_MAX_CHARS);
}
async function vectorIndexAddGuarded(id, sessionId, text, context, commit) {
	const vi = vectorIndex;
	const ep = currentEmbeddingProvider;
	if (!vi || !ep) return false;
	const revision = getSearchIndex().watchRevision(id);
	const previous = vi.get(id);
	const isCurrent = () => vectorIndex === vi && currentEmbeddingProvider === ep && revision.isCurrent() && vi.get(id) === previous;
	try {
		let embedding;
		try {
			embedding = await ep.embed(clipEmbedInput(text));
		} catch (err) {
			logger.warn("vector-index add: embed failed — skipping", {
				kind: context.kind,
				id: context.logId,
				provider: ep.name,
				error: err instanceof Error ? err.message : String(err)
			});
			return false;
		}
		if (!isCurrent()) return false;
		if (embedding.length !== ep.dimensions) {
			logger.warn("vector-index add: dimension mismatch — skipping", {
				kind: context.kind,
				id: context.logId,
				provider: ep.name,
				expected: ep.dimensions,
				received: embedding.length
			});
			return false;
		}
		if (commit) try {
			const committed = await commit(embedding, isCurrent);
			if (committed) scheduleIndexSave();
			return committed;
		} catch (err) {
			logger.warn("vector-index add: commit failed — skipping", {
				kind: context.kind,
				id: context.logId,
				provider: ep.name,
				error: err instanceof Error ? err.message : String(err)
			});
			return false;
		}
		vi.add(id, sessionId, embedding);
		scheduleIndexSave();
		return true;
	} finally {
		revision.release();
	}
}
async function vectorIndexAddBatchGuarded(items) {
	const vi = vectorIndex;
	const ep = currentEmbeddingProvider;
	if (!vi || !ep || items.length === 0) return {
		ok: 0,
		fail: 0,
		skipped: 0
	};
	const keyword = getSearchIndex();
	const guarded = items.map((item) => ({
		item,
		revision: item.revision ?? keyword.watchRevision(item.id),
		previous: vi.get(item.id)
	}));
	const isCurrent = (job) => vectorIndex === vi && currentEmbeddingProvider === ep && job.revision.isCurrent() && vi.get(job.item.id) === job.previous;
	try {
		const active = guarded.filter(isCurrent);
		let skipped = items.length - active.length;
		if (!active.length) return {
			ok: 0,
			fail: 0,
			skipped
		};
		const failedBatch = () => {
			const fail = active.filter(isCurrent).length;
			return {
				ok: 0,
				fail,
				skipped: items.length - fail
			};
		};
		let embeddings;
		try {
			embeddings = await ep.embedBatch(active.map(({ item }) => clipEmbedInput(item.text)));
		} catch (err) {
			logger.warn("vector-index add batch: embed failed — skipping batch", {
				batchSize: active.length,
				provider: ep.name,
				error: err instanceof Error ? err.message : String(err)
			});
			return failedBatch();
		}
		if (embeddings.length !== active.length) {
			logger.warn("vector-index add batch: provider returned wrong length — skipping batch", {
				batchSize: active.length,
				returned: embeddings.length,
				provider: ep.name
			});
			return failedBatch();
		}
		let ok = 0;
		let fail = 0;
		for (let i = 0; i < active.length; i++) {
			const job = active[i];
			if (!isCurrent(job)) {
				skipped++;
				continue;
			}
			const item = job.item;
			const embedding = embeddings[i];
			if (embedding.length !== ep.dimensions) {
				logger.warn("vector-index add batch: dimension mismatch — skipping item", {
					kind: item.context.kind,
					id: item.context.logId,
					provider: ep.name,
					expected: ep.dimensions,
					received: embedding.length
				});
				fail++;
				continue;
			}
			try {
				vi.add(item.id, item.sessionId, embedding);
				ok++;
			} catch (err) {
				logger.warn("vector-index add batch: index write failed — skipping item", {
					kind: item.context.kind,
					id: item.context.logId,
					error: err instanceof Error ? err.message : String(err)
				});
				fail++;
			}
		}
		return {
			ok,
			fail,
			skipped
		};
	} finally {
		for (const job of guarded) if (!job.item.revision) job.revision.release();
	}
}
const DEFAULT_REBUILD_EMBED_BATCH = 32;
function getRebuildEmbedBatchSize() {
	const raw = process.env.REBUILD_EMBED_BATCH_SIZE;
	if (!raw) return DEFAULT_REBUILD_EMBED_BATCH;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_REBUILD_EMBED_BATCH;
}
async function indexRecords(observations, memories) {
	const idx = getSearchIndex();
	const vectorEnabled = Boolean(vectorIndex && currentEmbeddingProvider);
	const batchSize = getRebuildEmbedBatchSize();
	const revisions = /* @__PURE__ */ new Map();
	let count = 0;
	for (const memory of memories) {
		if (memory.isLatest === false || !memory.title || !memory.content) continue;
		idx.add(memoryToObservation(memory), "memory");
		if (vectorEnabled) revisions.set(memory, idx.watchRevision(memory.id));
		count++;
	}
	for (const obs of observations) {
		if (!obs.title || !obs.narrative) continue;
		idx.add(obs);
		if (vectorEnabled) revisions.set(obs, idx.watchRevision(obs.id));
		count++;
	}
	if (count > 0) scheduleIndexSave();
	const pending = [];
	const flush = async () => {
		if (pending.length === 0) return;
		await vectorIndexAddBatchGuarded(pending);
		pending.length = 0;
	};
	const enqueue = async (job) => {
		pending.push(job);
		if (pending.length >= batchSize) await flush();
	};
	try {
		for (const memory of memories) {
			const revision = revisions.get(memory);
			if (!revision?.isCurrent()) continue;
			await enqueue({
				id: memory.id,
				revision,
				sessionId: memory.sessionIds?.[0] ?? "memory",
				text: memory.title + " " + memory.content,
				context: {
					kind: "memory",
					logId: memory.id
				}
			});
		}
		for (const obs of observations) {
			const revision = revisions.get(obs);
			if (!revision?.isCurrent()) continue;
			await enqueue({
				id: obs.id,
				revision,
				sessionId: obs.sessionId,
				text: obs.title + " " + obs.narrative,
				context: {
					kind: "observation",
					logId: obs.id
				}
			});
		}
		await flush();
		if (count > 0 && vectorEnabled) scheduleIndexSave();
	} finally {
		for (const revision of revisions.values()) revision.release();
	}
	return count;
}
async function findUnindexedObservations(kv) {
	const idx = getSearchIndex();
	const sessions = await kv.list(KV.sessions);
	const indexed = idx.observationCountsBySession();
	const missing = [];
	for (const session of sessions) {
		const known = session.observationCount ?? 0;
		if (known > 0 && known <= (indexed.get(session.id) ?? 0)) continue;
		const observations = await kv.list(KV.observations(session.id));
		for (const obs of observations) {
			if (!obs.title || !obs.narrative || idx.has(obs.id)) continue;
			missing.push(obs);
		}
	}
	return {
		sessions: sessions.length,
		missing
	};
}
const SESSIONS_LIST_RETRY_ATTEMPTS = 3;
const SESSIONS_LIST_RETRY_BASE_MS = 250;
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
async function listSessionsWithRetry(kv) {
	let lastErr;
	for (let attempt = 0; attempt < SESSIONS_LIST_RETRY_ATTEMPTS; attempt++) try {
		return await kv.list(KV.sessions);
	} catch (err) {
		lastErr = err;
		if (attempt < SESSIONS_LIST_RETRY_ATTEMPTS - 1) await delay(SESSIONS_LIST_RETRY_BASE_MS * (attempt + 1));
	}
	logger.warn("rebuildKeywordIndex: failed to load sessions after retries", {
		attempts: SESSIONS_LIST_RETRY_ATTEMPTS,
		error: lastErr instanceof Error ? lastErr.message : String(lastErr)
	});
	return null;
}
async function rebuildKeywordIndex(kv, vectorBackfillSince) {
	keywordRebuildsRunning++;
	try {
		return await runKeywordRebuild(kv, vectorBackfillSince);
	} finally {
		keywordRebuildsRunning--;
		keywordRebuildPending = false;
		keywordRebuildEpoch++;
	}
}
async function runKeywordRebuild(kv, vectorBackfillSince) {
	const idx = getSearchIndex();
	idx.clear();
	memoryIndexReady = false;
	bm25RebuildIncomplete = false;
	const vi = vectorIndex;
	const backfillEligible = Boolean(vi && currentEmbeddingProvider) && vectorBackfillSince !== void 0;
	const wholeStoreBackfill = vectorBackfillSince === null;
	const backfillGated = backfillEligible && wholeStoreBackfill && !isVectorBackfillAllEnabled();
	const backfillActive = backfillEligible && !backfillGated;
	const cutoff = typeof vectorBackfillSince === "string" ? Date.parse(vectorBackfillSince) : NaN;
	const backfillCap = backfillActive ? getVectorBackfillMax() : 0;
	const vectorJobs = [];
	let fullBackfillPending = 0;
	const consider = (id, sessionId, text, timestamp, kind) => {
		if (!backfillEligible || vi?.has(id)) return;
		if (!Number.isNaN(cutoff) && !(Date.parse(timestamp ?? "") > cutoff)) return;
		if (backfillGated || wholeStoreBackfill && vectorJobs.length >= backfillCap) {
			fullBackfillPending++;
			return;
		}
		if (!backfillActive) return;
		vectorJobs.push({
			id,
			sessionId,
			text,
			revision: idx.watchRevision(id),
			context: {
				kind,
				logId: id
			}
		});
	};
	let documents = 0;
	let memoriesLoaded = false;
	try {
		const memories = await kv.list(KV.memories);
		memoriesLoaded = true;
		for (const memory of memories) {
			if (memory.isLatest === false) continue;
			if (!memory.title || !memory.content) continue;
			idx.add(memoryToObservation(memory), "memory");
			consider(memory.id, memory.sessionIds?.[0] ?? "memory", memory.title + " " + memory.content, memory.createdAt, "memory");
			documents++;
		}
	} catch (err) {
		logger.warn("rebuildKeywordIndex: failed to load memories", { error: err instanceof Error ? err.message : String(err) });
	}
	const sessions = await listSessionsWithRetry(kv);
	if (sessions === null) {
		bm25RebuildIncomplete = true;
		if (memoriesLoaded) memoryIndexReady = true;
		return {
			documents,
			vectorJobs,
			fullBackfillPending
		};
	}
	const failedSessions = [];
	for (let batch = 0; batch < sessions.length; batch += 10) {
		const chunk = sessions.slice(batch, batch + 10);
		const results = await Promise.all(chunk.map(async (s) => {
			try {
				return await kv.list(KV.observations(s.id));
			} catch {
				failedSessions.push(s.id);
				return [];
			}
		}));
		for (const obs of results.flat()) {
			if (!obs.title || !obs.narrative) continue;
			idx.add(obs);
			consider(obs.id, obs.sessionId, obs.title + " " + obs.narrative, obs.timestamp, "observation");
			documents++;
		}
	}
	if (failedSessions.length > 0) {
		bm25RebuildIncomplete = true;
		logger.warn("rebuildKeywordIndex: failed to load observations for sessions", { failedSessions });
	}
	if (memoriesLoaded) memoryIndexReady = true;
	return {
		documents,
		vectorJobs,
		fullBackfillPending
	};
}
const BACKFILL_SAVE_EVERY_BATCHES = 10;
const VECTOR_BACKLOG_PAUSE_MS = 1e3;
async function embedBackfillJobs(jobs, remainingAfter) {
	const batchSize = getRebuildEmbedBatchSize();
	const initialVector = vectorIndex;
	const initialProvider = currentEmbeddingProvider;
	let ok = 0;
	let fail = 0;
	let skipped = 0;
	let batchesSinceSave = 0;
	setPendingVectorBackfillCount(remainingAfter + jobs.length);
	for (let offset = 0; offset < jobs.length; offset += batchSize) {
		if (vectorIndex !== initialVector || currentEmbeddingProvider !== initialProvider) break;
		const result = await vectorIndexAddBatchGuarded(jobs.slice(offset, offset + batchSize));
		ok += result.ok;
		fail += result.fail;
		skipped += result.skipped;
		setPendingVectorBackfillCount(remainingAfter + fail + jobs.length - Math.min(jobs.length, offset + batchSize));
		batchesSinceSave++;
		if (batchesSinceSave >= BACKFILL_SAVE_EVERY_BATCHES) {
			await flushIndexSave();
			batchesSinceSave = 0;
		}
	}
	if (ok > 0) await flushIndexSave();
	return {
		ok,
		fail,
		skipped
	};
}
async function backfillVectorBacklog(jobs, options = {}) {
	const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : getVectorBackfillMax();
	const pauseMs = options.pauseMs ?? VECTOR_BACKLOG_PAUSE_MS;
	const deferred = options.remainingAfter ?? 0;
	const initialVector = vectorIndex;
	const initialProvider = currentEmbeddingProvider;
	const replaced = () => vectorIndex !== initialVector || currentEmbeddingProvider !== initialProvider;
	const countRemaining = () => options.remainingCount?.() ?? deferred + jobs.filter((job) => !vectorIndex?.has(job.id) && (!job.revision || getSearchIndex().has(job.id))).length;
	const interrupted = () => {
		const remaining = countRemaining();
		setPendingVectorBackfillCount(remaining);
		return {
			added,
			failed,
			remaining,
			complete: false
		};
	};
	let added = 0;
	let failed = 0;
	for (let offset = 0; offset < jobs.length; offset += batchSize) {
		if (offset > 0 && pauseMs > 0) await delay(pauseMs);
		if (replaced()) return interrupted();
		const after = deferred + failed + Math.max(0, jobs.length - offset - batchSize);
		const batch = jobs.slice(offset, offset + batchSize).filter((job) => !vectorIndex?.has(job.id) && (!job.revision || job.revision.isCurrent()));
		if (batch.length === 0) {
			setPendingVectorBackfillCount(after);
			continue;
		}
		const result = await embedBackfillJobs(batch, after);
		added += result.ok;
		failed += result.fail;
		if (replaced()) return interrupted();
		if (result.ok === 0 && (result.fail > 0 || result.skipped === 0)) {
			const remaining = countRemaining();
			setPendingVectorBackfillCount(remaining);
			return {
				added,
				failed,
				remaining,
				complete: false
			};
		}
	}
	const remaining = countRemaining();
	setPendingVectorBackfillCount(remaining);
	return {
		added,
		failed,
		remaining,
		complete: remaining === 0
	};
}
function registerSearchFunction(sdk, kv) {
	sdk.registerFunction("mem::search", async (data) => {
		const idx = getSearchIndex();
		if (typeof data?.query !== "string" || !data.query.trim()) throw new Error("mem::search: query must be a non-empty string");
		const query = data.query.trim();
		if (data.targetLayer !== void 0 && !isSearchLayer(data.targetLayer)) throw new Error("mem::search: targetLayer must be one of 'all', 'memory', or 'observation'");
		const targetLayer = data.targetLayer ?? "all";
		const MAX_LIMIT = 100;
		let effectiveLimit = 20;
		if (data.limit !== void 0) {
			if (!Number.isInteger(data.limit) || data.limit < 1) throw new Error("mem::search: limit must be a positive integer");
			effectiveLimit = Math.min(data.limit, MAX_LIMIT);
		}
		const projectFilter = typeof data.project === "string" && data.project.trim().length > 0 ? data.project.trim() : void 0;
		const cwdFilter = typeof data.cwd === "string" && data.cwd.trim().length > 0 ? data.cwd.trim() : void 0;
		const isolated = isAgentScopeIsolated();
		const explicitAgentId = typeof data.agentId === "string" && data.agentId.trim().length > 0 ? data.agentId.trim() : void 0;
		const wildcardAgent = explicitAgentId === "*";
		const envAgentId = isolated ? getAgentId() : void 0;
		const filterAgentId = wildcardAgent ? void 0 : explicitAgentId ?? envAgentId;
		if (isolated && !wildcardAgent && !explicitAgentId && !envAgentId) throw new Error("mem::search: AGENTMEMORY_AGENT_SCOPE=isolated is set but no agent id is available (env AGENT_ID unset and no explicit agentId in the call). Refusing to read cross-agent rows. Pass agentId: \"*\" to opt in to a wildcard read.");
		const format = typeof data.format === "string" ? data.format : "full";
		if (![
			"full",
			"compact",
			"narrative"
		].includes(format)) throw new Error("mem::search: format must be one of 'full', 'compact', or 'narrative'");
		let tokenBudget;
		if (data.token_budget !== void 0) {
			if (!Number.isInteger(data.token_budget) || data.token_budget < 1) throw new Error("mem::search: token_budget must be a positive integer");
			tokenBudget = data.token_budget;
		}
		if (idx.size === 0) {
			if (!rebuildPromise) rebuildPromise = rebuildKeywordIndex(kv).then((result) => {
				logger.info("Search index rebuilt", { entries: result.documents });
				return result.documents;
			}).catch((err) => {
				logger.warn("Index rebuild failed", { error: err instanceof Error ? err.message : String(err) });
				return 0;
			}).finally(() => {
				rebuildPromise = null;
			});
			await rebuildPromise;
		}
		const filtering = !!(projectFilter || cwdFilter || filterAgentId);
		const fetchLimit = filtering ? Math.max(effectiveLimit * 10, 100) : effectiveLimit;
		let results;
		const authorizeGraph = async (record, sessionId, read) => {
			if (filterAgentId !== void 0 && record.agentId !== filterAgentId) return false;
			const memoryProject = "content" in record ? record.project : void 0;
			if (projectFilter && memoryProject !== void 0 && memoryProject !== projectFilter) return false;
			if (cwdFilter || projectFilter && memoryProject === void 0) {
				const session = await read(KV.sessions, sessionId);
				if (!session) return false;
				if (cwdFilter && session.cwd !== cwdFilter) return false;
				if (projectFilter && memoryProject === void 0 && session.project !== projectFilter) return false;
			}
			return true;
		};
		if (hybridRanker) try {
			results = (await hybridRanker(query, fetchLimit, targetLayer, authorizeGraph)).map((r) => ({
				obsId: r.observation.id,
				sessionId: r.sessionId,
				score: r.combinedScore,
				observation: r.observation,
				layer: r.layer
			}));
		} catch (err) {
			logger.warn("hybrid ranking failed, falling back to keyword search", { error: err instanceof Error ? err.message : String(err) });
			results = idx.search(query, fetchLimit, targetLayer);
		}
		else results = idx.search(query, fetchLimit, targetLayer);
		const sessionCache = /* @__PURE__ */ new Map();
		const loadSession = async (sessionId) => {
			if (sessionCache.has(sessionId)) return sessionCache.get(sessionId);
			const s = await kv.get(KV.sessions, sessionId);
			sessionCache.set(sessionId, s ?? null);
			return s ?? null;
		};
		const memoryProjectCache = /* @__PURE__ */ new Map();
		const loadMemoryProject = async (obsId) => {
			if (memoryProjectCache.has(obsId)) return memoryProjectCache.get(obsId);
			const proj = (await kv.get(KV.memories, obsId))?.project ?? null;
			memoryProjectCache.set(obsId, proj);
			return proj;
		};
		const earlyCap = filterAgentId ? fetchLimit : effectiveLimit;
		const candidates = [];
		for (const r of results) {
			if (candidates.length >= earlyCap) break;
			const layer = r.layer ?? idx.layerOf(r.obsId) ?? getSearchResultLayer(r.obsId, r.sessionId);
			if (!matchesSearchLayer(r.obsId, r.sessionId, targetLayer, layer)) continue;
			if (filtering) {
				const memoryProject = projectFilter && layer === "memory" ? await loadMemoryProject(r.obsId) : null;
				if (projectFilter && memoryProject !== null && memoryProject !== projectFilter) continue;
				const session = await loadSession(r.sessionId);
				if (session) {
					if (projectFilter && memoryProject === null && session.project !== projectFilter) continue;
					if (cwdFilter && session.cwd !== cwdFilter) continue;
				}
			}
			candidates.push(r);
		}
		const obsResults = await Promise.all(candidates.map(async (r) => {
			if (r.observation) return {
				observation: r.observation,
				layer: r.layer ?? idx.layerOf(r.obsId) ?? getSearchResultLayer(r.obsId, r.sessionId)
			};
			const obs = await kv.get(KV.observations(r.sessionId), r.obsId).catch(() => null);
			if (obs) return {
				observation: obs,
				layer: "observation"
			};
			const mem = await kv.get(KV.memories, r.obsId).catch(() => null);
			return mem ? {
				observation: memoryToObservation(mem),
				layer: "memory"
			} : null;
		}));
		const enriched = [];
		for (let i = 0; i < candidates.length; i++) {
			const resolved = obsResults[i];
			if (!resolved) continue;
			const obs = resolved.observation;
			if (!matchesSearchLayer(obs.id, obs.sessionId, targetLayer, resolved.layer)) continue;
			if (filterAgentId !== void 0 && obs.agentId !== filterAgentId) continue;
			if (enriched.length >= effectiveLimit) break;
			enriched.push({
				observation: withoutObservationSource(obs),
				layer: resolved.layer,
				score: candidates[i].score,
				sessionId: candidates[i].sessionId
			});
		}
		const response = buildRecallResponse(enriched, format, tokenBudget);
		recordAccessBatch(kv, enriched.slice(0, response.results.length).map((result) => result.observation.id));
		logger.info("Search completed", {
			query,
			results: response.results.length,
			hasProjectFilter: !!projectFilter,
			hasCwdFilter: !!cwdFilter
		});
		return response;
	});
}
//#endregion
//#region src/eval/schemas.ts
const HookTypeEnum = z.enum([
	"session_start",
	"prompt_submit",
	"pre_tool_use",
	"post_tool_use",
	"post_tool_failure",
	"pre_compact",
	"subagent_start",
	"subagent_stop",
	"notification",
	"task_completed",
	"stop",
	"session_end"
]);
const ObservationTypeEnum = z.enum([
	"file_read",
	"file_write",
	"file_edit",
	"command_run",
	"search",
	"web_fetch",
	"conversation",
	"error",
	"decision",
	"discovery",
	"subagent",
	"notification",
	"task",
	"image",
	"other"
]);
z.object({
	hookType: HookTypeEnum,
	sessionId: z.string().min(1),
	project: z.string().min(1),
	cwd: z.string().min(1),
	timestamp: z.string().min(1),
	data: z.unknown()
});
const CompressOutputSchema = z.object({
	type: ObservationTypeEnum,
	title: z.string().min(1).max(120),
	subtitle: z.string().optional(),
	facts: z.array(z.string()).min(1),
	narrative: z.string().min(10),
	concepts: z.array(z.string()),
	files: z.array(z.string()),
	importance: z.number().int().min(1).max(10)
});
const SummaryOutputSchema = z.object({
	title: z.string().min(1),
	narrative: z.string().min(20),
	keyDecisions: z.array(z.string()),
	filesModified: z.array(z.string()),
	concepts: z.array(z.string())
});
z.object({
	query: z.string().min(1),
	limit: z.number().int().positive().optional()
});
z.object({
	sessionId: z.string().min(1),
	project: z.string().min(1),
	budget: z.number().positive().optional()
});
z.object({
	content: z.string().min(1),
	type: z.enum([
		"pattern",
		"preference",
		"architecture",
		"bug",
		"workflow",
		"fact"
	]).optional(),
	concepts: z.array(z.string()).optional(),
	files: z.array(z.string()).optional()
});
z.object({
	query: z.string().optional(),
	expandIds: z.array(z.string()).optional(),
	limit: z.number().int().positive().optional()
});
z.object({
	anchor: z.string().min(1),
	project: z.string().optional(),
	before: z.number().int().nonnegative().optional(),
	after: z.number().int().nonnegative().optional()
});
z.object({
	project: z.string().min(1),
	refresh: z.boolean().optional()
});
z.object({
	sourceId: z.string().min(1),
	targetId: z.string().min(1),
	type: z.enum([
		"supersedes",
		"extends",
		"derives",
		"contradicts",
		"related"
	])
});
z.object({
	memoryId: z.string().min(1),
	newContent: z.string().min(1),
	newTitle: z.string().optional()
});
z.object({
	exportData: z.object({
		version: z.union([z.literal("0.3.0"), z.literal("0.4.0")]),
		exportedAt: z.string(),
		sessions: z.array(z.unknown()),
		observations: z.record(z.string(), z.array(z.unknown())),
		memories: z.array(z.unknown()),
		summaries: z.array(z.unknown()),
		profiles: z.array(z.unknown()).optional()
	}),
	strategy: z.enum([
		"merge",
		"replace",
		"skip"
	]).optional()
});
//#endregion
//#region src/eval/validator.ts
function validateInput(schema, data, functionId) {
	const parsed = schema.safeParse(data);
	if (parsed.success) return {
		valid: true,
		data: parsed.data
	};
	return {
		valid: false,
		result: {
			valid: false,
			errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
			qualityScore: 0,
			latencyMs: 0,
			functionId
		}
	};
}
function validateOutput(schema, data, functionId) {
	return validateInput(schema, data, functionId);
}
//#endregion
//#region src/eval/quality.ts
function scoreCompression(obs) {
	let score = 0;
	if (obs.facts && obs.facts.length > 0) score += 25;
	if (obs.facts && obs.facts.length >= 3) score += 10;
	if (obs.narrative && obs.narrative.length >= 20) score += 20;
	if (obs.narrative && obs.narrative.length >= 50) score += 5;
	if (obs.title && obs.title.length >= 5 && obs.title.length <= 120) score += 15;
	if (obs.concepts && obs.concepts.length > 0) score += 15;
	if (obs.importance && obs.importance >= 1 && obs.importance <= 10) score += 10;
	return Math.min(100, score);
}
function scoreSummary(summary) {
	let score = 0;
	if (summary.title && summary.title.length >= 5) score += 20;
	if (summary.narrative && summary.narrative.length >= 20) score += 25;
	if (summary.narrative && summary.narrative.length >= 100) score += 5;
	if (summary.keyDecisions && summary.keyDecisions.length > 0) score += 20;
	if (summary.filesModified && summary.filesModified.length > 0) score += 15;
	if (summary.concepts && summary.concepts.length > 0) score += 15;
	return Math.min(100, score);
}
//#endregion
//#region src/eval/self-correct.ts
const STRICTER_SUFFIX = `

IMPORTANT: Your previous response was invalid. Please ensure your output strictly follows the required XML format. Every required field must be present with valid values.`;
async function compressWithRetry(provider, systemPrompt, userPrompt, validator, maxRetries = 1) {
	let result = validator(await provider.compress(systemPrompt, userPrompt));
	if (result.valid) return {
		...result,
		retried: false
	};
	let retried = false;
	for (let i = 0; i < maxRetries; i++) {
		retried = true;
		result = validator(await provider.compress(systemPrompt + STRICTER_SUFFIX, userPrompt));
		if (result.valid) return {
			...result,
			retried
		};
	}
	return {
		...result,
		retried
	};
}
//#endregion
//#region src/state/frame-guard.ts
const SAFE_PAYLOAD_BYTES = 15 * 1024 * 1024;
function payloadByteLength(payload) {
	return Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
}
function oversizedPayloadError(bytes, hint) {
	return {
		success: false,
		error: `Response is ${(bytes / (1024 * 1024)).toFixed(1)} MiB, over the ~${SAFE_PAYLOAD_BYTES / (1024 * 1024)} MiB engine transport frame limit; ${hint}`,
		oversized: true,
		bytes,
		limitBytes: SAFE_PAYLOAD_BYTES
	};
}
function checkPayloadFrameSize(payload, hint) {
	const bytes = payloadByteLength(payload);
	if (bytes <= 15728640) return null;
	return oversizedPayloadError(bytes, hint);
}
//#endregion
//#region src/functions/observation-source-budget.ts
const SESSION_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
function budgetLiveObservationSource(observation, existing) {
	const planned = budgetImportedObservationSources([observation], existing);
	return planned.success ? planned.observations[0] : withoutObservationSource(observation);
}
function budgetImportedObservationSources(incoming, existing = [], strategy = "merge") {
	const existingById = new Map(existing.map((row) => [row.id, row]));
	const rows = incoming.map((row) => ({
		...row,
		source: normalizeObservationSource(row.source)
	}));
	const written = rows.filter((row) => strategy !== "skip" || !existingById.has(row.id));
	const replacedIds = new Set(written.map((row) => row.id));
	const kept = strategy === "replace" ? [] : existing.filter((row) => !replacedIds.has(row.id));
	const envelope = {
		message_type: "invocation_result",
		invocation_id: "00000000-0000-0000-0000-000000000000",
		result: [...kept, ...written.map(withoutObservationSource)]
	};
	const oversized = checkPayloadFrameSize(envelope, "observation summaries already exceed one session response; split the import into smaller sessions");
	if (oversized) return oversized;
	const existingSourceBytes = kept.reduce((sum, row) => sum + (row.source ? payloadByteLength(row.source) + 10 : 0), 0);
	const sourceRows = written.filter((row) => row.source !== void 0);
	const available = Math.max(0, Math.min(SESSION_SOURCE_MAX_BYTES - existingSourceBytes, SAFE_PAYLOAD_BYTES - payloadByteLength(envelope) - 64 * 1024));
	const perSource = sourceRows.reduce((sum, row) => sum + payloadByteLength(row.source) + 10, 0) <= available ? OBSERVATION_SOURCE_MAX_BYTES : Math.min(OBSERVATION_SOURCE_MAX_BYTES, Math.floor(available / Math.max(1, sourceRows.length)) - 10);
	let sourceTruncated = 0;
	let sourceOmitted = 0;
	for (const row of sourceRows) {
		const source = row.source;
		if (payloadByteLength({
			hookType: source.hookType,
			originalBytes: source.originalBytes,
			truncated: true
		}) > perSource) {
			delete row.source;
			sourceOmitted++;
			continue;
		}
		row.source = normalizeObservationSource(source, perSource);
		if (row.source?.truncated) sourceTruncated++;
	}
	return {
		success: true,
		observations: rows,
		sourceTruncated,
		sourceOmitted
	};
}
//#endregion
//#region src/functions/compress-synthetic.ts
function inferType(toolName, hookType) {
	if (hookType === "post_tool_failure") return "error";
	if (hookType === "prompt_submit") return "conversation";
	if (hookType === "subagent_stop" || hookType === "task_completed") return "subagent";
	if (hookType === "notification") return "notification";
	if (!toolName) return "other";
	const n = toolName.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
	const hasWord = (word) => new RegExp(`(^|_)${word}(_|$)`).test(n) || n === word || n.endsWith(word) || n.startsWith(word);
	if ([
		"fetch",
		"http",
		"web"
	].some(hasWord)) return "web_fetch";
	if ([
		"grep",
		"search",
		"glob",
		"find"
	].some(hasWord)) return "search";
	if ([
		"bash",
		"shell",
		"exec",
		"run"
	].some(hasWord)) return "command_run";
	if ([
		"edit",
		"update",
		"patch",
		"replace"
	].some(hasWord)) return "file_edit";
	if (["write", "create"].some(hasWord)) return "file_write";
	if (["read", "view"].some(hasWord)) return "file_read";
	if (["task", "agent"].some(hasWord)) return "subagent";
	return "other";
}
const SEARCH_TOOL_PATTERN = /grep|glob|search|find|^ls$|list/i;
function extractFiles(toolName, input) {
	if (!input || typeof input !== "object") return [];
	const o = input;
	const keys = toolName !== void 0 && SEARCH_TOOL_PATTERN.test(toolName) || typeof o["pattern"] === "string" || typeof o["query"] === "string" ? [
		"file_path",
		"filepath",
		"filePath",
		"notebook_path"
	] : [
		"file_path",
		"filepath",
		"path",
		"filePath",
		"file",
		"notebook_path"
	];
	const out = /* @__PURE__ */ new Set();
	for (const key of keys) {
		const v = o[key];
		if (typeof v === "string" && v.length > 0 && v.length < 512) out.add(v);
	}
	return [...out];
}
function stringifyForNarrative(v) {
	if (v == null) return "";
	if (typeof v === "string") return v;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}
function truncate(s, n) {
	if (s.length <= n) return s;
	const end = /[\uD800-\uDBFF]/.test(s[n - 2]) ? n - 2 : n - 1;
	return s.slice(0, end) + "…";
}
function keepEnds(s, n) {
	if (s.length <= n) return s;
	let head = Math.ceil((n - 1) / 2);
	let tail = s.length - (n - 1 - head);
	if (/[\uD800-\uDBFF]/.test(s[head - 1])) head--;
	if (/[\uDC00-\uDFFF]/.test(s[tail])) tail++;
	return s.slice(0, head) + "…" + s.slice(tail);
}
function buildSyntheticCompression(raw) {
	const toolName = raw.toolName ?? raw.hookType;
	const inputStr = stringifyForNarrative(raw.toolInput);
	const outputStr = stringifyForNarrative(raw.toolOutput);
	const promptStr = raw.userPrompt ?? "";
	const responseStr = keepEnds(raw.assistantResponse ?? "", 400);
	const source = createObservationSource(raw);
	const narrativeParts = [
		promptStr,
		inputStr,
		outputStr,
		responseStr
	].filter((s) => s.length > 0);
	const payload = source.payload;
	if (narrativeParts.length === 0 && payload != null && (typeof payload !== "object" || Object.keys(payload).length > 0)) narrativeParts.push(stringifyForNarrative(payload));
	const result = {
		id: raw.id,
		sessionId: raw.sessionId,
		timestamp: raw.timestamp,
		compressedAt: (/* @__PURE__ */ new Date()).toISOString(),
		type: inferType(toolName, raw.hookType),
		title: truncate(toolName || "observation", 80),
		subtitle: inputStr ? truncate(inputStr, 120) : void 0,
		facts: [],
		narrative: truncate(narrativeParts.join(" | "), 400),
		concepts: [],
		files: extractFiles(raw.toolName, raw.toolInput),
		importance: 5,
		confidence: .3,
		source
	};
	if (raw.modality) result.modality = raw.modality;
	if (raw.imageData) result.imageData = raw.imageData;
	if (raw.agentId) result.agentId = raw.agentId;
	if (raw.origin) result.origin = raw.origin;
	if (raw.captureKey) result.captureKey = raw.captureKey;
	return result;
}
//#endregion
//#region src/capture/event-id.ts
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
function isValidEventId(value) {
	return typeof value === "string" && EVENT_ID_RE.test(value);
}
function stableStringify(value) {
	if (value === void 0) return "null";
	if (value === null || typeof value !== "object") {
		const encoded = JSON.stringify(value);
		return encoded === void 0 ? "null" : encoded;
	}
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value;
	return `{${Object.keys(obj).filter((k) => obj[k] !== void 0).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
//#endregion
//#region src/functions/compression-state.ts
function pendingCompression(attempts = 0) {
	return {
		status: "pending",
		revision: randomUUID(),
		attempts
	};
}
function observationRevision(observation) {
	return fingerprintId("compression", stableStringify(observation));
}
function needsCompression(observation) {
	return "title" in observation ? observation.compression?.status === "pending" || observation.compression?.status === "failed" : typeof observation.hookType === "string" && Boolean(observation.hookType);
}
function compressionRaw(observation) {
	const raw = "title" in observation ? rawFromObservationSource(observation) : observation;
	if (!raw || !raw.id || !raw.sessionId || !raw.timestamp || !raw.hookType) return null;
	return [
		raw.toolInput,
		raw.toolOutput,
		raw.userPrompt,
		raw.assistantResponse,
		raw.raw,
		raw.imageData
	].some((value) => {
		if (value === void 0 || value === null) return false;
		if (typeof value === "string") return value.trim().length > 0;
		if (typeof value === "object") return Object.keys(value).length > 0;
		return true;
	}) ? scrubRecord({
		...raw,
		captureKey: observation.captureKey
	}) : null;
}
async function markCompressionDispatchFailed(kv, observation) {
	await withKeyedLock(`obs:${observation.sessionId}`, async () => {
		const current = await kv.get(KV.observations(observation.sessionId), observation.id);
		if (!current?.compression || current.compression.revision !== observation.compression?.revision) return;
		if (current.compression.status !== "pending" || current.compression.attempts !== 0) return;
		await kv.set(KV.observations(current.sessionId), current.id, {
			...current,
			compression: {
				...current.compression,
				status: "failed",
				error: "dispatch_failed"
			}
		});
	});
}
//#endregion
//#region src/functions/compress.ts
const COMPRESSION_TIMEOUT_MS = 6e4;
const activeByStore = /* @__PURE__ */ new WeakMap();
function compressionInFlight(kv, sessionId, observationId) {
	return activeByStore.get(kv)?.has(JSON.stringify([sessionId, observationId])) ?? false;
}
function indexObservation(observation) {
	getSearchIndex().add(observation);
	scheduleIndexSave();
}
function registerCompressFunction(sdk, kv, provider, metricsStore) {
	const active = activeByStore.get(kv) ?? /* @__PURE__ */ new Map();
	activeByStore.set(kv, active);
	async function matchesScope(data, row) {
		if (!data.scope) return true;
		const session = await kv.get(KV.sessions, data.sessionId);
		return Boolean(session && (!data.scope.project || session.project === data.scope.project) && (!data.scope.agentId || (row.agentId ?? session.agentId) === data.scope.agentId));
	}
	async function compress(data, attempt, deadline) {
		const { sessionId, observationId } = data;
		const startMs = Date.now();
		async function bounded(work) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("compression_timeout");
			let timer;
			try {
				return await Promise.race([work(), new Promise((_, reject) => {
					timer = setTimeout(() => reject(/* @__PURE__ */ new Error("compression_timeout")), remaining);
				})]);
			} finally {
				clearTimeout(timer);
			}
		}
		const prepared = await withKeyedLock(`obs:${sessionId}`, async () => {
			const stored = await kv.get(KV.observations(sessionId), observationId);
			if (!stored || typeof stored !== "object" || stored.id !== observationId || stored.sessionId !== sessionId) return null;
			if (!await matchesScope(data, stored)) return { skipped: true };
			if (data.expectedRevision && observationRevision(stored) !== data.expectedRevision) return { skipped: true };
			if (!needsCompression(stored) && !data.raw) return { skipped: true };
			const rows = await kv.list(KV.observations(sessionId));
			const fallback = "title" in stored ? stored : budgetLiveObservationSource(buildSyntheticCompression(scrubRecord(stored)), rows);
			const raw = compressionRaw(fallback);
			if (!raw && !("title" in stored)) return { unavailable: true };
			const compression = {
				...pendingCompression((stored.compression?.attempts ?? 0) + (raw ? 1 : 0)),
				...raw ? { lastAttemptAt: (/* @__PURE__ */ new Date()).toISOString() } : {
					status: "failed",
					error: "source_unavailable"
				}
			};
			const claimed = {
				...stored,
				compression
			};
			await kv.set(KV.observations(sessionId), observationId, claimed);
			attempt.revisions.add(observationRevision(stored));
			attempt.revisions.add(observationRevision(claimed));
			if ("title" in claimed) indexObservation(claimed);
			return {
				raw,
				claimed,
				fallback,
				revision: observationRevision(claimed)
			};
		});
		if (!prepared) return {
			success: false,
			error: "observation_not_found",
			skipped: true,
			retryable: false
		};
		if ("skipped" in prepared) return {
			success: true,
			skipped: true
		};
		if ("unavailable" in prepared || !prepared.raw) return {
			success: false,
			error: "source_unavailable",
			retryable: false
		};
		const { raw, claimed, fallback, revision } = prepared;
		async function fail(error) {
			const changed = await withKeyedLock(`obs:${sessionId}`, async () => {
				const current = await kv.get(KV.observations(sessionId), observationId);
				if (!current || observationRevision(current) !== revision) return true;
				const failed = {
					...claimed,
					compression: {
						...claimed.compression,
						status: "failed",
						error
					}
				};
				await kv.set(KV.observations(sessionId), observationId, failed);
				attempt.resultRevision = observationRevision(failed);
				attempt.revisions.add(attempt.resultRevision);
				return false;
			});
			await metricsStore?.record("mem::compress", Date.now() - startMs, false).catch(() => {});
			return changed ? {
				success: false,
				error: "observation_changed",
				skipped: true,
				retryable: false
			} : {
				success: false,
				error,
				retryable: true,
				...fallback.source?.truncated ? { sourceTruncated: true } : {}
			};
		}
		try {
			let imageDescription;
			if ((raw.modality === "image" || raw.modality === "mixed") && raw.imageData && provider.describeImage) try {
				let base64Data = raw.imageData;
				let mimeType = "image/png";
				if (!raw.imageData.startsWith("/9j/") && !raw.imageData.startsWith("iVBOR")) {
					if (!isManagedImagePath(raw.imageData)) throw new Error(`Refusing to read image outside managed store: ${raw.imageData}`);
					base64Data = readFileSync(raw.imageData).toString("base64");
					if (raw.imageData.endsWith(".jpg") || raw.imageData.endsWith(".jpeg")) mimeType = "image/jpeg";
					else if (raw.imageData.endsWith(".webp")) mimeType = "image/webp";
					else if (raw.imageData.endsWith(".gif")) mimeType = "image/gif";
				}
				imageDescription = await bounded(() => provider.describeImage(base64Data, mimeType, VISION_DESCRIPTION_PROMPT));
				logger.info("Image described by vision model", { obsId: observationId });
			} catch {
				logger.warn("Vision model call failed, falling back to text-only compression", { obsId: observationId });
			}
			const retainedOutput = raw.toolOutput ?? (raw.raw && Object.keys(Object(raw.raw)).length > 0 ? raw.raw : void 0);
			const prompt = buildCompressionPrompt({
				hookType: raw.hookType,
				toolName: raw.toolName,
				toolInput: raw.toolInput,
				toolOutput: imageDescription ? `[Image Description]: ${imageDescription}\n\n${retainedOutput ?? ""}` : retainedOutput,
				userPrompt: raw.userPrompt,
				assistantResponse: raw.assistantResponse,
				timestamp: raw.timestamp
			});
			const validator = (response) => {
				const parsed = parseCompressionXml(response);
				if (!parsed) return {
					valid: false,
					errors: ["xml_parse_failed"]
				};
				const result = validateOutput(CompressOutputSchema, scrubRecord(parsed), "mem::compress");
				return result.valid ? result : {
					valid: false,
					errors: result.result.errors
				};
			};
			const result = await compressWithRetry({
				...provider,
				compress: (system, user) => bounded(() => provider.compress(system, user))
			}, COMPRESSION_SYSTEM, prompt, validator, 1);
			if (!result.valid) return fail(result.errors?.includes("xml_parse_failed") ? "parse_failed" : "validation_failed");
			const qualityScore = scoreCompression(result.data);
			const candidate = {
				...fallback,
				...result.data,
				compressedAt: (/* @__PURE__ */ new Date()).toISOString(),
				confidence: qualityScore / 100,
				compression: {
					...claimed.compression,
					status: "complete"
				},
				...raw.imageData ? { imageRef: raw.imageData } : {},
				...imageDescription ? { imageDescription: stripPrivateData(imageDescription) } : {}
			};
			const compressed = await withKeyedLock(`obs:${sessionId}`, async () => {
				const current = await kv.get(KV.observations(sessionId), observationId);
				if (!current || observationRevision(current) !== revision || !await matchesScope(data, current)) return null;
				const bounded = budgetLiveObservationSource(candidate, await kv.list(KV.observations(sessionId)));
				await kv.set(KV.observations(sessionId), observationId, bounded);
				attempt.resultRevision = observationRevision(bounded);
				attempt.revisions.add(attempt.resultRevision);
				indexObservation(bounded);
				return bounded;
			});
			if (!compressed) return {
				success: false,
				error: "observation_changed",
				skipped: true,
				retryable: false
			};
			const committedRevision = observationRevision(compressed);
			await bounded(() => vectorIndexAddGuarded(observationId, sessionId, compressed.title + " " + compressed.narrative, {
				kind: "observation",
				logId: observationId
			}, (embedding, isCurrent) => withKeyedLock(`obs:${sessionId}`, async () => {
				const current = await kv.get(KV.observations(sessionId), observationId);
				if (!isCurrent() || !current || observationRevision(current) !== committedRevision) return false;
				getVectorIndex()?.add(observationId, sessionId, embedding);
				return true;
			}))).catch(() => {});
			if (!await withKeyedLock(`obs:${sessionId}`, async () => {
				const current = await kv.get(KV.observations(sessionId), observationId);
				if (!current || observationRevision(current) !== committedRevision || !await matchesScope(data, current)) return false;
				await sdk.trigger({
					function_id: "stream::send",
					payload: {
						stream_name: STREAM.name,
						group_id: STREAM.viewerGroup,
						id: `compressed-${observationId}`,
						type: "compressed_observation",
						data: {
							type: "compressed",
							observation: withoutObservationSource(compressed),
							sessionId
						}
					},
					action: TriggerAction.Void()
				}).catch(() => {});
				return true;
			})) return {
				success: false,
				error: "observation_changed",
				skipped: true,
				retryable: false
			};
			await metricsStore?.record("mem::compress", Date.now() - startMs, true, qualityScore).catch(() => {});
			return {
				success: true,
				compressed: withoutObservationSource(compressed),
				qualityScore,
				...compressed.source?.truncated ? { sourceTruncated: true } : {}
			};
		} catch {
			logger.warn("Observation retained for compression retry", {
				observationId,
				sessionId
			});
			return fail("compression_failed");
		}
	}
	async function dispatch(data, deadline) {
		const key = JSON.stringify([data.sessionId, data.observationId]);
		const existing = active.get(key);
		if (existing) {
			const changed = {
				success: false,
				error: "observation_changed",
				skipped: true,
				retryable: false
			};
			const requestedRevision = await withKeyedLock(`obs:${data.sessionId}`, async () => {
				const current = await kv.get(KV.observations(data.sessionId), data.observationId);
				if (!current || current.id !== data.observationId || current.sessionId !== data.sessionId || !await matchesScope(data, current)) return null;
				const revision = observationRevision(current);
				if (data.expectedRevision && data.expectedRevision !== revision && !existing.attempt.revisions.has(data.expectedRevision)) return null;
				return data.expectedRevision ?? revision;
			});
			if (!requestedRevision) return changed;
			let timer;
			const result = await Promise.race([existing.promise, new Promise((resolve) => {
				timer = setTimeout(() => resolve({
					success: false,
					error: "compression_timeout",
					retryable: true
				}), Math.max(0, deadline - Date.now()));
			})]).finally(() => clearTimeout(timer));
			if (result.error === "compression_timeout") return result;
			return await withKeyedLock(`obs:${data.sessionId}`, async () => {
				const current = await kv.get(KV.observations(data.sessionId), data.observationId);
				if (!current || current.id !== data.observationId || current.sessionId !== data.sessionId || !await matchesScope(data, current)) return changed;
				const revision = observationRevision(current);
				if (revision === existing.attempt.resultRevision && existing.attempt.revisions.has(requestedRevision)) return result;
				return revision === requestedRevision && (needsCompression(current) || data.raw) ? null : changed;
			}) ?? dispatch({
				...data,
				expectedRevision: requestedRevision
			}, deadline);
		}
		if (Date.now() >= deadline) return {
			success: false,
			error: "compression_timeout",
			retryable: true
		};
		const attempt = { revisions: /* @__PURE__ */ new Set() };
		const task = {
			attempt,
			promise: compress(data, attempt, deadline).finally(() => {
				if (active.get(key) === task) active.delete(key);
			})
		};
		active.set(key, task);
		return task.promise;
	}
	sdk.registerFunction("mem::compress", (data) => {
		if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim() || typeof data.observationId !== "string" || !data.observationId.trim()) return Promise.resolve({
			success: false,
			error: "invalid_observation_identity",
			retryable: false
		});
		if (data.raw !== void 0 && (!data.raw || typeof data.raw.hookType !== "string" || !data.raw.hookType)) return Promise.resolve({
			success: false,
			error: "invalid_raw_observation"
		});
		return dispatch(data, Date.now() + COMPRESSION_TIMEOUT_MS);
	});
	registerCompressionRecovery(sdk, kv);
}
//#endregion
//#region src/functions/compression-recovery.ts
const MAX_CURSOR_LENGTH = 32 * 1024;
function parseCompressionScope(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an object");
	const data = input;
	if (Object.keys(data).some((key) => ![
		"sessionId",
		"project",
		"agentId",
		"limit",
		"cursor"
	].includes(key))) throw new Error("Unknown compression option");
	const scope = { limit: 10 };
	for (const key of [
		"sessionId",
		"project",
		"agentId",
		"cursor"
	]) {
		const value = data[key];
		if (value === void 0 || key === "cursor" && value === "") continue;
		if (typeof value !== "string" || !value.trim() || value.length > (key === "cursor" ? MAX_CURSOR_LENGTH : 1024)) throw new Error(`Invalid ${key}`);
		scope[key] = value;
	}
	if (!scope.sessionId && !scope.project) throw new Error("Specify sessionId or project");
	if (data.limit !== void 0) {
		if (typeof data.limit !== "number" && typeof data.limit !== "string" || !/^\d+$/.test(String(data.limit))) throw new Error("limit must be an integer from 1 to 100");
		scope.limit = Number(data.limit);
		if (!Number.isSafeInteger(scope.limit) || scope.limit < 1 || scope.limit > 100) throw new Error("limit must be an integer from 1 to 100");
	}
	readCursor(scope);
	return scope;
}
function scopeKey(scope) {
	return fingerprintId("compression-scope", JSON.stringify([
		scope.sessionId,
		scope.project,
		scope.agentId
	]));
}
function writeCursor(scope, sessionId, observationId) {
	const encode = (parts) => Buffer.from(JSON.stringify(parts)).toString("base64url");
	const cursor = encode([
		scopeKey(scope),
		sessionId,
		observationId
	]);
	return cursor.length <= MAX_CURSOR_LENGTH ? cursor : encode([
		scopeKey(scope),
		fingerprintId("session", sessionId),
		observationId ? fingerprintId("observation", observationId) : "",
		"hash"
	]);
}
function readCursor(scope) {
	if (!scope.cursor) return null;
	try {
		const value = JSON.parse(Buffer.from(scope.cursor, "base64url").toString("utf8"));
		if (!Array.isArray(value) || ![3, 4].includes(value.length) || value[0] !== scopeKey(scope) || typeof value[1] !== "string" || typeof value[2] !== "string") throw new Error();
		const hashed = value.length === 4;
		if (hashed && (value[3] !== "hash" || !/^session_[a-f0-9]{16}$/.test(value[1]) || value[2] !== "" && !/^observation_[a-f0-9]{16}$/.test(value[2]))) throw new Error();
		return {
			sessionId: value[1],
			observationId: value[2],
			hashed
		};
	} catch {
		throw new Error("Invalid cursor for this compression scope");
	}
}
function registerCompressionRecovery(sdk, kv) {
	async function run(input, retry) {
		const request = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : input;
		if (request && typeof request === "object") delete request._caller_worker_id;
		const scope = parseCompressionScope(request);
		const after = readCursor(scope);
		const eligible = (scope.sessionId ? [await kv.get(KV.sessions, scope.sessionId)].filter((s) => Boolean(s)) : await kv.list(KV.sessions)).filter((s) => typeof s.id === "string" && (!scope.project || s.project === scope.project)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
		let anchorRows;
		if (after?.hashed) {
			const anchors = eligible.filter((session) => fingerprintId("session", session.id) === after.sessionId);
			let observationId = after.observationId ? void 0 : "";
			if (anchors.length === 1 && after.observationId) {
				const rows = await kv.list(KV.observations(anchors[0].id));
				anchorRows = {
					sessionId: anchors[0].id,
					rows
				};
				const matches = rows.filter((row) => row && typeof row.id === "string" && fingerprintId("observation", row.id) === after.observationId);
				if (matches.length === 1) observationId = matches[0].id;
			}
			if (anchors.length !== 1 || observationId === void 0) return {
				success: false,
				dryRun: !retry,
				error: "cursor_stale",
				items: [],
				attempted: 0,
				recovered: 0,
				failed: 0,
				scannedSessions: 0,
				scannedObservations: 0
			};
			after.sessionId = anchors[0].id;
			after.observationId = observationId;
		}
		const items = [];
		let scannedSessions = 0;
		let scannedObservations = 0;
		let attempted = 0;
		let recovered = 0;
		let failed = 0;
		let nextCursor;
		let stop = false;
		const startedAt = Date.now();
		for (const session of eligible) {
			if (after && session.id < after.sessionId) continue;
			if (scannedSessions >= 20) {
				nextCursor = writeCursor(scope, session.id, "");
				break;
			}
			scannedSessions++;
			const rows = (anchorRows?.sessionId === session.id ? anchorRows.rows : await kv.list(KV.observations(session.id))).filter((row) => row && typeof row === "object" && typeof row.id === "string").sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
			for (const row of rows) {
				if (after && session.id === after.sessionId && row.id <= after.observationId) continue;
				scannedObservations++;
				nextCursor = writeCursor(scope, session.id, row.id);
				if (row.sessionId === session.id && needsCompression(row) && (!scope.agentId || (row.agentId ?? session.agentId) === scope.agentId)) {
					const source = compressionRaw(row);
					const metadata = row.compression;
					const item = {
						sessionId: session.id,
						observationId: row.id,
						status: metadata?.status ?? "raw",
						attempts: metadata?.attempts ?? 0,
						retryable: Boolean(source),
						truncated: "source" in row ? Boolean(row.source?.truncated) : false,
						inFlight: compressionInFlight(kv, session.id, row.id),
						error: !source ? "source_unavailable" : metadata?.error,
						outcome: void 0
					};
					items.push(item);
					if (retry && source) {
						attempted++;
						let result;
						try {
							result = await sdk.trigger({
								function_id: "mem::compress",
								payload: {
									sessionId: session.id,
									observationId: row.id,
									expectedRevision: observationRevision(row),
									scope: {
										project: scope.project,
										agentId: scope.agentId
									}
								}
							});
						} catch {
							result = {
								success: false,
								error: "compression_failed"
							};
						}
						if (!result || typeof result.success !== "boolean") result = {
							success: false,
							error: "compression_failed"
						};
						item.truncated = result.sourceTruncated ?? item.truncated;
						item.retryable = result.retryable ?? item.retryable;
						if (result.success && !result.skipped) {
							recovered++;
							item.outcome = "recovered";
							item.error = void 0;
						} else if (result.skipped) {
							item.outcome = "changed";
							item.error = result.error;
						} else {
							failed++;
							item.outcome = "failed";
							item.error = result.error ?? "compression_failed";
							stop = true;
						}
					}
				}
				if (stop || items.length >= scope.limit || scannedObservations >= 1e3 || Date.now() - startedAt >= 3e4) {
					stop = true;
					break;
				}
			}
			if (stop) break;
			nextCursor = void 0;
		}
		const result = {
			success: failed === 0,
			dryRun: !retry,
			items,
			attempted,
			recovered,
			failed,
			scannedSessions,
			scannedObservations,
			...nextCursor ? { nextCursor } : {}
		};
		const oversized = checkPayloadFrameSize(result, "lower limit or select one session for compression recovery");
		if (retry && attempted > 0) await safeAudit(kv, "compress", "mem::compression-retry", oversized ? [] : items.filter((i) => i.outcome === "recovered").map((i) => i.observationId), {
			sessionId: scope.sessionId,
			project: scope.project,
			agentId: scope.agentId,
			attempted,
			recovered,
			failed
		});
		return oversized ?? result;
	}
	sdk.registerFunction("mem::compression-status", (input) => run(input, false));
	sdk.registerFunction("mem::compression-retry", (input) => run(input, true));
}
//#endregion
export { CURL_AUTH_HEADER as $, registerStartupCleanup as $t, isBm25RebuildIncomplete as A, withoutGraphRecovery as At, setIndexPersistence as B, parseSentMark as Bt, getIndexPersistenceStatus as C, reconcileGraphIndexRecord as Ct, getVectorBackfillState as D, withGraphSnapshotUnknownMutation as Dt, getSearchIndex as E, withGraphSnapshotIndexBarrier as Et, rebuildKeywordIndex as F, pinGraphStateGeneration as Ft, vectorIndexRemove as G, spoolSummary as Gt, setVectorBackfillState as H, retainSent as Ht, registerSearchFunction as I, replaceGraphGeneration as It, deleteAccessLog as J, stripPrivateData as Jt, rawFromObservationSource as K, registerPrivacyFunction as Kt, scheduleIndexSave as L, resolveGraphScope as Lt, isMemoryIndexReady as M, isLegacyGraphState as Mt, markKeywordRebuildPending as N, notifyGraphGenerationChange as Nt, getVectorIndex as O, ensureGraphConsistency as Ot, rankMemoryIds as P, pinGraphState as Pt, SearchIndex as Q, SHUTDOWN_HARD_EXIT_MS as Qt, setEmbeddingProvider as R, setGraphGenerationListener as Rt, getEmbeddingProvider as S, normalizeGraphIndexText as St, getPendingVectorBackfillCount as T, withGraphIndexMutation as Tt, setVectorIndex as U, spoolDir as Ut, setPendingVectorBackfillCount as V, reconcileSent as Vt, vectorIndexAddGuarded as W, spoolPolicy as Wt, normalizeAccessLog as X, resolveDataDir as Xt, emptyAccessLog as Y, withWriteScrubbing as Yt, recordAccessBatch as Z, SHUTDOWN_FLUSH_TIMEOUT_MS as Zt, validateOutput as _, finishGraphIndexBuild as _t, markCompressionDispatchFailed as a, singleFlight as at, findUnindexedObservations as b, initializeGraphIndex as bt, isValidEventId as c, runGraphCompactOnBoot as ct, budgetLiveObservationSource as d, boundSources as dt, runStartupCleanup as en, UNINDEXED_SCAN_REUSE_MS as et, SAFE_PAYLOAD_BYTES as f, persistGraphDelta as ft, scoreSummary as g, createGraphIndexReader as gt, payloadByteLength as h, GraphIndexError as ht, compressionRaw as i, renderStatusHtml as it, isKeywordRebuildInProgress as j, getGraphGeneration as jt, indexRecords as k, noteGraphSnapshotWrite as kt, buildSyntheticCompression as l, setGraphCompactBootDisabled as lt, oversizedPayloadError as m, GRAPH_INDEX_MAX_ID_BYTES as mt, compressionInFlight as n, runtimeMetadataPath as nn, markLlmFunctions as nt, needsCompression as o, GRAPH_COMPACT_BOOT_DELAY_MS as ot, checkPayloadFrameSize as p, registerGraphFunction as pt, withoutObservationSource as q, scrubRecord as qt, registerCompressFunction as r, prefersHtml as rt, pendingCompression as s, getGraphCompactBootStatus as st, parseCompressionScope as t, settleWithin as tn, evaluateStatus as tt, budgetImportedObservationSources as u, COMPACT_SCOPES as ut, SummaryOutputSchema as v, getGraphIndexStatus as vt, getKeywordRebuildEpoch as w, recoverGraphIndex as wt, flushIndexSave as x, mutateIndexedGraphRecord as xt, backfillVectorBacklog as y, graphEdgeLookupKey as yt, setHybridRanker as z, drainSpool as zt };

//# sourceMappingURL=compression-recovery-BaKdcC6y.mjs.map
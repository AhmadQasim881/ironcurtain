import { c as generateId } from "./keyed-mutex-B2ARAhzY.mjs";
import { B as getStandalonePersistPath, c as memoryToObservation, i as resolveClientSecret, k as getAgentId, m as queryAudit, o as buildRecallResponse, q as isAgentScopeIsolated, u as isSearchLayer, w as VERSION, x as getAllTools } from "./secret-store-BIHNFqsl.mjs";
import { a as pageAfterCursor, c as sortByKeyDesc, n as parseSearchExpansionIds, t as parseSessionArguments } from "./session-arguments-zxsbbd8y.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
//#region src/mcp/in-memory-kv.ts
var InMemoryKV = class {
	store = /* @__PURE__ */ new Map();
	constructor(persistPath) {
		this.persistPath = persistPath;
		if (persistPath && existsSync(persistPath)) try {
			const data = JSON.parse(readFileSync(persistPath, "utf-8"));
			for (const [scope, entries] of Object.entries(data)) {
				const map = /* @__PURE__ */ new Map();
				for (const [key, value] of Object.entries(entries)) map.set(key, value);
				this.store.set(scope, map);
			}
		} catch {}
	}
	async get(scope, key) {
		return this.store.get(scope)?.get(key) ?? null;
	}
	async set(scope, key, data) {
		if (!this.store.has(scope)) this.store.set(scope, /* @__PURE__ */ new Map());
		this.store.get(scope).set(key, data);
		return data;
	}
	async delete(scope, key) {
		this.store.get(scope)?.delete(key);
	}
	async list(scope) {
		const entries = this.store.get(scope);
		return entries ? Array.from(entries.values()) : [];
	}
	persist() {
		if (!this.persistPath) return false;
		try {
			const dir = dirname(this.persistPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			const data = {};
			for (const [scope, entries] of this.store) data[scope] = Object.fromEntries(entries);
			writeFileSync(this.persistPath, JSON.stringify(data), "utf-8");
			return true;
		} catch (err) {
			process.stderr.write(`[@agentmemory/mcp] Persist failed: ${err instanceof Error ? err.message : String(err)}\n`);
			return false;
		}
	}
};
//#endregion
//#region src/mcp/transport.ts
let activeStdioTransports = 0;
var JsonRpcError = class extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "JsonRpcError";
	}
};
function isNotification(req) {
	return req.id === void 0 || req.id === null;
}
function isValidId(id) {
	return id === void 0 || id === null || typeof id === "string" || typeof id === "number";
}
async function processLine(line, handler, writeOut, writeErr = (msg) => process.stderr.write(msg)) {
	const trimmed = line.trim();
	if (!trimmed) return;
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		writeOut({
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32700,
				message: "Parse error"
			}
		});
		return;
	}
	const request = parsed;
	const rawId = request?.id;
	if (!request || typeof request !== "object" || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
		if (typeof rawId === "string" || typeof rawId === "number") writeOut({
			jsonrpc: "2.0",
			id: rawId,
			error: {
				code: -32600,
				message: "Invalid Request"
			}
		});
		return;
	}
	if (!isValidId(rawId)) {
		writeOut({
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32600,
				message: "Invalid Request: id must be string, number, or null"
			}
		});
		return;
	}
	const notification = isNotification(request);
	try {
		const result = await handler(request.method, request.params || {});
		if (notification) return;
		writeOut({
			jsonrpc: "2.0",
			id: request.id,
			result
		});
	} catch (err) {
		if (notification) {
			writeErr(`[mcp-transport] notification handler error for ${request.method}: ${err instanceof Error ? err.message : String(err)}\n`);
			return;
		}
		writeOut({
			jsonrpc: "2.0",
			id: request.id,
			error: {
				code: err instanceof JsonRpcError ? err.code : -32603,
				message: err instanceof Error ? err.message : String(err)
			}
		});
	}
}
function findHeaderEnd(buffer) {
	const crlf = buffer.indexOf("\r\n\r\n");
	const lf = buffer.indexOf("\n\n");
	if (crlf === -1 && lf === -1) return null;
	if (crlf !== -1 && (lf === -1 || crlf <= lf)) return {
		headerEnd: crlf,
		bodyStart: crlf + 4
	};
	return {
		headerEnd: lf,
		bodyStart: lf + 2
	};
}
function parseContentLength(header) {
	for (const line of header.split(/\r?\n/)) {
		const match = line.match(/^content-length:\s*(\d+)\s*$/i);
		if (match) return Number(match[1]);
	}
	return null;
}
function formatResponse(response, framed) {
	const body = JSON.stringify(response);
	if (!framed) return `${body}\n`;
	const bytes = Buffer.from(body, "utf8");
	return [Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`, "ascii"), bytes];
}
function createMessageParser(onMessage, writeErr = (msg) => process.stderr.write(msg)) {
	let buffer = Buffer.alloc(0);
	let framed = false;
	function processBuffer() {
		while (buffer.length > 0) {
			if (buffer[0] === 10 || buffer[0] === 13) {
				buffer = buffer.subarray(1);
				continue;
			}
			const preview = buffer.toString("ascii", 0, Math.min(buffer.length, 32));
			if (/^content-length:/i.test(preview)) {
				const header = findHeaderEnd(buffer);
				if (!header) return;
				const contentLength = parseContentLength(buffer.subarray(0, header.headerEnd).toString("ascii"));
				if (contentLength === null) {
					writeErr("[mcp-transport] missing Content-Length header\n");
					buffer = buffer.subarray(header.bodyStart);
					continue;
				}
				const messageEnd = header.bodyStart + contentLength;
				if (buffer.length < messageEnd) return;
				framed = true;
				const message = buffer.subarray(header.bodyStart, messageEnd).toString("utf8");
				buffer = buffer.subarray(messageEnd);
				onMessage(message);
				continue;
			}
			const newline = buffer.indexOf(10);
			if (newline === -1) return;
			const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
			buffer = buffer.subarray(newline + 1);
			onMessage(line);
		}
	}
	return {
		push(chunk) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
			buffer = Buffer.concat([buffer, bytes]);
			processBuffer();
		},
		isFramed() {
			return framed;
		}
	};
}
function createStdioTransport(handler) {
	let parser = null;
	let queue = Promise.resolve();
	let active = false;
	const writeResponse = (response) => {
		const formatted = formatResponse(response, parser?.isFramed() ?? false);
		if (typeof formatted === "string") {
			process.stdout.write(formatted);
			return;
		}
		for (const chunk of formatted) process.stdout.write(chunk);
	};
	const onData = (chunk) => parser?.push(chunk);
	return {
		start() {
			if (active) return;
			active = true;
			activeStdioTransports += 1;
			process.env["AGENTMEMORY_MCP_STDIO__"] = "1";
			parser = createMessageParser((message) => {
				queue = queue.then(() => processLine(message, handler, writeResponse));
				queue.catch((err) => {
					process.stderr.write(`[mcp-transport] request processing failed: ${err instanceof Error ? err.message : String(err)}\n`);
				});
			});
			process.stdin.on("data", onData);
		},
		stop() {
			process.stdin.off("data", onData);
			if (active) {
				active = false;
				activeStdioTransports -= 1;
				if (activeStdioTransports === 0) delete process.env["AGENTMEMORY_MCP_STDIO__"];
			}
			parser = null;
		}
	};
}
//#endregion
//#region src/mcp/rest-proxy.ts
const DEFAULT_URL = "http://localhost:3111";
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2e3;
const CALL_TIMEOUT_MS = 15e3;
const LOCAL_MODE_TTL_MS = 3e4;
function probeTimeoutMs() {
	const raw = process.env["AGENTMEMORY_PROBE_TIMEOUT_MS"];
	if (!raw) return DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
}
function isProxyRequired() {
	const raw = process.env["AGENTMEMORY_FORCE_PROXY"];
	return raw === "1" || raw === "true";
}
var ProxyCallError = class extends Error {
	status;
	body;
	constructor(message, status, body) {
		super(message);
		this.name = "ProxyCallError";
		this.status = status;
		this.body = body;
	}
};
let cached = null;
let cachedUrl = null;
let cachedAt = 0;
let probeInFlight = null;
function resolveEnvOrEmpty(name) {
	const raw = process.env[name];
	if (!raw) return "";
	if (raw.startsWith("${") && raw.endsWith("}")) return "";
	return raw;
}
function baseUrl() {
	const value = resolveEnvOrEmpty("AGENTMEMORY_URL") || DEFAULT_URL;
	try {
		const parsed = new URL(value);
		if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /[?#\s]/.test(value)) throw new Error();
		return value.replace(/\/+$/, "");
	} catch {
		throw new Error("AGENTMEMORY_URL must be an HTTP(S) URL without credentials, query, or fragment");
	}
}
function authHeader(url) {
	const secret = resolveClientSecret(url);
	return secret ? { authorization: `Bearer ${secret}` } : {};
}
const defaultLivezProbe = async (url, timeoutMs, headers) => {
	const res = await fetch(`${url}/agentmemory/livez`, {
		method: "GET",
		headers,
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "error"
	});
	return {
		ok: res.ok,
		status: res.status,
		statusText: res.statusText
	};
};
let livezProbe = defaultLivezProbe;
async function probe(url) {
	const timeout = probeTimeoutMs();
	try {
		const res = await livezProbe(url, timeout, authHeader(url));
		if (!res.ok) process.stderr.write(`[@agentmemory/mcp] livez probe ${url}/agentmemory/livez -> ${res.status ?? "?"} ${res.statusText ?? ""}; falling back to local InMemoryKV (set AGENTMEMORY_FORCE_PROXY=1 to skip the probe)\n`);
		return res.ok;
	} catch (err) {
		process.stderr.write(`[@agentmemory/mcp] livez probe ${url}/agentmemory/livez failed in ${timeout}ms: ${err instanceof Error ? err.message : String(err)}; falling back to local InMemoryKV (set AGENTMEMORY_FORCE_PROXY=1 to skip the probe, or raise AGENTMEMORY_PROBE_TIMEOUT_MS)\n`);
		return false;
	}
}
function invalidateHandle() {
	cached = null;
	cachedUrl = null;
	cachedAt = 0;
}
async function resolveHandle() {
	const now = Date.now();
	const url = baseUrl();
	if (cached && (cachedUrl !== url || cached.mode === "local" && isProxyRequired())) invalidateHandle();
	if (cached) if (cached.mode === "local" && now - cachedAt >= LOCAL_MODE_TTL_MS) {
		cached = null;
		cachedAt = 0;
	} else return cached;
	const skipProbe = isProxyRequired();
	if (probeInFlight?.url === url && probeInFlight.forceProxy === skipProbe) return probeInFlight.promise;
	const pending = (async () => {
		const up = skipProbe ? true : await probe(url);
		if (baseUrl() !== url || isProxyRequired() !== skipProbe) return resolveHandle();
		if (skipProbe) process.stderr.write(`[@agentmemory/mcp] AGENTMEMORY_FORCE_PROXY set; skipping livez probe and trusting ${url}\n`);
		if (up) {
			const handle = {
				mode: "proxy",
				baseUrl: url,
				call: async (path, init) => {
					if (baseUrl() !== url) throw new Error("AgentMemory endpoint changed; resolve a new proxy handle before retrying.");
					const res = await fetch(`${url}${path}`, {
						...init,
						headers: {
							"content-type": "application/json",
							...authHeader(url),
							...init?.headers
						},
						signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
						redirect: "error"
					});
					if (!res.ok) {
						const errText = await res.text().catch(() => "");
						let errBody = void 0;
						if (errText) try {
							errBody = JSON.parse(errText);
						} catch {
							errBody = void 0;
						}
						throw new ProxyCallError(`${init?.method || "GET"} ${path} -> ${res.status} ${res.statusText}`, res.status, errBody);
					}
					const text = await res.text();
					return text ? JSON.parse(text) : null;
				}
			};
			cached = handle;
			cachedUrl = url;
			cachedAt = Date.now();
			return handle;
		}
		const local = { mode: "local" };
		cached = local;
		cachedUrl = url;
		cachedAt = Date.now();
		return local;
	})();
	probeInFlight = {
		url,
		forceProxy: skipProbe,
		promise: pending
	};
	try {
		return await pending;
	} finally {
		if (probeInFlight?.promise === pending) probeInFlight = null;
	}
}
//#endregion
//#region src/mcp/standalone.ts
const IMPLEMENTED_TOOLS = new Set([
	"memory_save",
	"memory_recall",
	"memory_smart_search",
	"memory_sessions",
	"memory_export",
	"memory_audit",
	"memory_governance_delete"
]);
const SUPPORTED_PROTOCOL_VERSIONS = [
	"2025-11-25",
	"2025-06-18",
	"2025-03-26",
	"2024-11-05"
];
const SERVER_INFO = {
	name: "agentmemory",
	version: VERSION
};
const kv = new InMemoryKV(getStandalonePersistPath());
let modeAnnounced = false;
function displayAgentmemoryUrl() {
	const raw = process.env["AGENTMEMORY_URL"];
	if (!raw || raw.startsWith("${") && raw.endsWith("}")) return "http://localhost:3111";
	return raw;
}
function announceMode(handle) {
	if (modeAnnounced) return;
	modeAnnounced = true;
	if (handle.mode === "proxy") process.stderr.write(`[@agentmemory/mcp] proxying to agentmemory server at ${handle.baseUrl}\n`);
	else {
		const fullToolCount = getAllTools().length;
		process.stderr.write(`[@agentmemory/mcp] no server reachable at ${displayAgentmemoryUrl()}; running reduced LOCAL FALLBACK with ${IMPLEMENTED_TOOLS.size} of ${fullToolCount} tools. Start 'npx @agentmemory/agentmemory' (and point AGENTMEMORY_URL at it) to unlock all ${fullToolCount} tools.\n`);
	}
}
function normalizeList(value) {
	if (!value) return [];
	if (Array.isArray(value)) return value.map((v) => typeof v === "string" ? v.trim() : "").filter((v) => v.length > 0);
	if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
	return [];
}
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
function parseLimit(raw, fallback = DEFAULT_LIMIT) {
	if (typeof raw !== "number" && typeof raw !== "string") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(Math.floor(n), MAX_LIMIT);
}
function textResponse(payload, pretty = false) {
	return { content: [{
		type: "text",
		text: JSON.stringify(payload, null, pretty ? 2 : 0)
	}] };
}
function isAuthenticationError(error) {
	return error instanceof ProxyCallError && (error.status === 401 || error.status === 403);
}
function validate(toolName, args) {
	if (!IMPLEMENTED_TOOLS.has(toolName)) throw new Error(`Unknown tool: ${toolName}`);
	const v = { tool: toolName };
	switch (toolName) {
		case "memory_save": {
			const content = args["content"];
			if (typeof content !== "string" || !content.trim()) throw new Error("content is required");
			v.content = content;
			v.type = args["type"] || "fact";
			v.concepts = normalizeList(args["concepts"]);
			v.files = normalizeList(args["files"]);
			if (typeof args["project"] === "string" && args["project"].trim()) v.project = args["project"].trim();
			if (typeof args["agentId"] === "string" && args["agentId"].trim()) v.agentId = args["agentId"].trim();
			return v;
		}
		case "memory_recall":
		case "memory_smart_search": {
			if (args.targetLayer !== void 0 && !isSearchLayer(args.targetLayer)) throw new Error("targetLayer must be one of: all, memory, observation");
			v.targetLayer = args.targetLayer ?? "all";
			for (const field of [
				"project",
				"cwd",
				"agentId",
				"sessionId",
				"source"
			]) {
				if (args[field] !== void 0 && typeof args[field] !== "string") throw new Error(`${field} must be a string`);
				if (typeof args[field] === "string" && args[field].trim()) v[field] = args[field].trim();
			}
			if (toolName === "memory_smart_search") {
				v.expandIds = parseSearchExpansionIds(args.expandIds);
				if (typeof args.includeLessons === "boolean") v.includeLessons = args.includeLessons;
			}
			const query = args["query"];
			if (typeof query !== "string" || !query.trim()) {
				if (!v.expandIds?.length) throw new Error("query is required unless expandIds is provided");
			} else v.query = query.trim();
			v.limit = parseLimit(args["limit"]);
			if (toolName === "memory_recall") {
				const format = typeof args.format === "string" ? args.format.trim().toLowerCase() : args.format ?? "full";
				if (format !== "full" && format !== "compact" && format !== "narrative") throw new Error("format must be one of: full, compact, narrative");
				v.format = format;
				if (args.token_budget !== void 0) {
					const budget = typeof args.token_budget === "string" ? Number(args.token_budget) : args.token_budget;
					if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 1) throw new Error("token_budget must be a positive integer");
					v.tokenBudget = budget;
				}
			}
			return v;
		}
		case "memory_sessions":
			v.sessionQuery = parseSessionArguments(args);
			return v;
		case "memory_governance_delete": {
			const ids = normalizeList(args["memoryIds"]);
			if (ids.length === 0) throw new Error("memoryIds is required");
			v.memoryIds = ids;
			v.reason = args["reason"] || "plugin skill request";
			return v;
		}
		case "memory_export": {
			const query = new URLSearchParams();
			for (const key of [
				"maxSessions",
				"offset",
				"collectionLimit",
				"collectionOffset"
			]) {
				const n = Number(args[key]);
				const min = key === "maxSessions" || key === "collectionLimit" ? 1 : 0;
				if (args[key] !== void 0 && Number.isInteger(n) && n >= min) query.set(key, String(n));
			}
			if (typeof args["collections"] === "string") query.set("collections", args["collections"]);
			v.exportQuery = query.toString();
			return v;
		}
		case "memory_audit":
			v.limit = parseLimit(args["limit"], 50);
			return v;
		default: throw new Error(`Unknown tool: ${toolName}`);
	}
}
async function handleProxy(v, handle) {
	switch (v.tool) {
		case "memory_save": return textResponse(await handle.call("/agentmemory/remember", {
			method: "POST",
			body: JSON.stringify({
				content: v.content,
				type: v.type,
				concepts: v.concepts,
				files: v.files,
				...v.project !== void 0 && { project: v.project },
				...v.agentId !== void 0 && { agentId: v.agentId }
			})
		}));
		case "memory_recall": {
			const body = {
				query: v.query,
				limit: v.limit,
				format: v.format ?? "full",
				targetLayer: v.targetLayer,
				project: v.project,
				cwd: v.cwd,
				agentId: v.agentId
			};
			if (v.tokenBudget != null) body["token_budget"] = v.tokenBudget;
			return textResponse(await handle.call("/agentmemory/search", {
				method: "POST",
				body: JSON.stringify(body)
			}), true);
		}
		case "memory_smart_search": {
			const body = {
				query: v.query,
				limit: v.limit,
				targetLayer: v.targetLayer,
				project: v.project,
				agentId: v.agentId,
				expandIds: v.expandIds,
				sessionId: v.sessionId,
				source: v.source,
				includeLessons: v.includeLessons
			};
			return textResponse(await handle.call("/agentmemory/smart-search", {
				method: "POST",
				body: JSON.stringify(body)
			}), true);
		}
		case "memory_sessions": return textResponse(await handle.call(`/agentmemory/sessions?${new URLSearchParams(v.sessionQuery)}`, { method: "GET" }), true);
		case "memory_governance_delete": return textResponse(await handle.call("/agentmemory/governance/memories", {
			method: "DELETE",
			body: JSON.stringify({
				memoryIds: v.memoryIds,
				reason: v.reason
			})
		}));
		case "memory_export": try {
			return textResponse(await handle.call(`/agentmemory/export${v.exportQuery ? `?${v.exportQuery}` : ""}`, { method: "GET" }), true);
		} catch (err) {
			if (err instanceof ProxyCallError && err.status === 413 && err.body != null && typeof err.body === "object" && err.body.oversized === true) return textResponse(err.body, true);
			throw err;
		}
		case "memory_audit": return textResponse(await handle.call(`/agentmemory/audit?limit=${v.limit}`, { method: "GET" }), true);
		default: throw new Error(`Unknown tool: ${v.tool}`);
	}
}
function localFallbackNotice(persisted) {
	const store = persisted ? "the local fallback file, which the server does not read" : "this process's in-memory fallback store, which is lost when the process exits";
	return {
		storage: "local",
		warning: `agentmemory server at ${displayAgentmemoryUrl()} did not confirm this call, so it ran against ${store}.`
	};
}
async function handleLocal(v, kvInstance) {
	switch (v.tool) {
		case "memory_save": {
			const id = generateId("mem");
			const isoNow = (/* @__PURE__ */ new Date()).toISOString();
			await kvInstance.set("mem:memories", id, {
				id,
				type: v.type,
				title: (v.content || "").slice(0, 80),
				content: v.content,
				concepts: v.concepts,
				files: v.files,
				createdAt: isoNow,
				updatedAt: isoNow,
				strength: 7,
				version: 1,
				isLatest: true,
				sessionIds: [],
				...v.project !== void 0 && { project: v.project },
				...(v.agentId ?? getAgentId()) !== void 0 && { agentId: v.agentId ?? getAgentId() }
			});
			return textResponse({
				saved: id,
				...localFallbackNotice(kvInstance.persist())
			});
		}
		case "memory_recall":
		case "memory_smart_search": {
			const isolated = isAgentScopeIsolated();
			const agentId = v.agentId === "*" ? void 0 : v.agentId ?? (isolated ? getAgentId() : void 0);
			if (isolated && v.agentId !== "*" && !agentId) throw new Error("AGENTMEMORY_AGENT_SCOPE=isolated requires an agentId; pass '*' to read across agents");
			const query = (v.query || "").toLowerCase();
			const limit = v.limit ?? DEFAULT_LIMIT;
			const all = v.targetLayer === "observation" ? [] : await kvInstance.list("mem:memories");
			const sessions = v.project || v.cwd ? await kvInstance.list("mem:sessions") : [];
			const sessionsById = new Map(sessions.map((session) => [session.id, session]));
			const scoped = all.filter((memory) => {
				if (memory.isLatest === false || agentId && memory.agentId !== agentId) return false;
				const linkedSessions = (memory.sessionIds ?? []).map((id) => sessionsById.get(id));
				if (v.project && (memory.project ? memory.project !== v.project : !linkedSessions.some((session) => session?.project === v.project))) return false;
				if (v.cwd && !linkedSessions.some((session) => session?.cwd === v.cwd)) return false;
				return true;
			});
			if (v.tool === "memory_smart_search" && v.expandIds?.length) {
				const ids = v.expandIds.map((entry) => typeof entry === "string" ? entry : entry.obsId);
				const byId = new Map(scoped.map((memory) => [memory.id, memory]));
				const eligible = ids.filter((id) => byId.has(id));
				return textResponse({
					mode: "expanded",
					results: eligible.slice(0, 20).map((id) => {
						const observation = memoryToObservation(byId.get(id));
						return {
							obsId: id,
							sessionId: observation.sessionId,
							observation,
							layer: "memory"
						};
					}),
					truncated: eligible.length > 20
				}, true);
			}
			const results = scoped.filter((memory) => {
				const text = [
					memory.title,
					memory.content,
					...memory.files ?? [],
					...memory.concepts ?? [],
					...memory.sessionIds ?? [],
					memory.id
				].join(" ").toLowerCase();
				return query.split(/\s+/).every((word) => text.includes(word));
			}).slice(0, limit);
			if (v.tool === "memory_recall") return textResponse(buildRecallResponse(results.map((memory) => {
				const observation = memoryToObservation(memory);
				return {
					sessionId: observation.sessionId,
					observation,
					score: 1,
					layer: "memory"
				};
			}), v.format ?? "full", v.tokenBudget), true);
			return textResponse({
				mode: "compact",
				results: results.map((memory) => ({
					...memory,
					obsId: memory.id,
					sessionId: memory.sessionIds?.[0] ?? "memory",
					layer: "memory"
				}))
			}, true);
		}
		case "memory_sessions": {
			const query = v.sessionQuery;
			const agentId = query.agentId === "*" ? void 0 : query.agentId ?? (isAgentScopeIsolated() ? getAgentId() : void 0);
			const sessions = (await kvInstance.list("mem:sessions")).filter((session) => session && typeof session.id === "string" && session.id.length > 0).filter((session) => !query.project || session.project === query.project).filter((session) => !agentId || session.agentId === agentId);
			const key = (session) => session.startedAt || "";
			const { page, nextCursor } = pageAfterCursor(sortByKeyDesc(sessions, key, (session) => session.id), key, (session) => session.id, query.cursor, Number(query.limit));
			return textResponse({
				sessions: await Promise.all(page.map(async (session) => {
					const summary = await kvInstance.get("mem:summaries", session.id);
					return summary ? {
						...session,
						summary
					} : session;
				})),
				nextCursor
			}, true);
		}
		case "memory_governance_delete": {
			let deleted = 0;
			for (const id of v.memoryIds || []) if (await kvInstance.get("mem:memories", id)) {
				await kvInstance.delete("mem:memories", id);
				deleted++;
			}
			const persisted = kvInstance.persist();
			return textResponse({
				deleted,
				requested: (v.memoryIds || []).length,
				reason: v.reason,
				...localFallbackNotice(persisted)
			});
		}
		case "memory_export": return textResponse({
			version: VERSION,
			memories: await kvInstance.list("mem:memories"),
			sessions: await kvInstance.list("mem:sessions")
		}, true);
		case "memory_audit": return textResponse(await queryAudit(kvInstance, { limit: v.limit ?? 50 }), true);
		default: throw new Error(`Unknown tool: ${v.tool}`);
	}
}
async function handleProxyGeneric(toolName, args, handle) {
	const result = await handle.call("/agentmemory/mcp/call", {
		method: "POST",
		body: JSON.stringify({
			name: toolName,
			arguments: args
		})
	});
	if (result && Array.isArray(result.content)) return { content: result.content };
	return textResponse(result, true);
}
async function handleToolCall(toolName, args, kvInstance = kv) {
	const handle = await resolveHandle();
	announceMode(handle);
	if (!IMPLEMENTED_TOOLS.has(toolName)) {
		if (handle.mode === "proxy") try {
			return await handleProxyGeneric(toolName, args, handle);
		} catch (err) {
			process.stderr.write(`[@agentmemory/mcp] proxy call failed for ${toolName}: ${err instanceof Error ? err.message : String(err)}\n`);
			invalidateHandle();
			throw err;
		}
		throw new Error(`Unknown tool: ${toolName} (local fallback supports only ${[...IMPLEMENTED_TOOLS].join(", ")}; start an agentmemory server and set AGENTMEMORY_URL to use the full tool set)`);
	}
	const validated = validate(toolName, args);
	if (handle.mode === "proxy") try {
		return await handleProxy(validated, handle);
	} catch (err) {
		if (toolName === "memory_sessions" || isAuthenticationError(err) || isProxyRequired()) {
			invalidateHandle();
			throw err;
		}
		process.stderr.write(`[@agentmemory/mcp] proxy call failed for ${toolName}: ${err instanceof Error ? err.message : String(err)}; invalidating handle and falling back to local KV\n`);
		invalidateHandle();
	}
	return handleLocal(validated, kvInstance);
}
async function handleToolsList() {
	const debug = process.env["AGENTMEMORY_DEBUG"] === "1" || process.env["AGENTMEMORY_DEBUG"] === "true";
	const handle = await resolveHandle();
	announceMode(handle);
	if (debug) process.stderr.write(`[@agentmemory/mcp] tools/list: handle.mode=${handle.mode}${handle.mode === "proxy" ? ` baseUrl=${handle.baseUrl}` : ""}\n`);
	if (handle.mode === "proxy") try {
		const remote = await handle.call("/agentmemory/mcp/tools", { method: "GET" });
		if (debug) {
			const shape = remote === null ? "null" : typeof remote !== "object" ? typeof remote : `keys=${Object.keys(remote).join(",")} toolsType=${Array.isArray(remote.tools) ? `array(len=${remote.tools.length})` : typeof remote.tools}`;
			process.stderr.write(`[@agentmemory/mcp] tools/list: remote response shape: ${shape}\n`);
		}
		if (remote && Array.isArray(remote.tools)) {
			if (debug) process.stderr.write(`[@agentmemory/mcp] tools/list: returning ${remote.tools.length} tools from server\n`);
			return { tools: remote.tools };
		}
		if (isProxyRequired()) throw new Error("AgentMemory returned an invalid tool inventory");
		process.stderr.write(`[@agentmemory/mcp] tools/list: server returned unexpected shape (no .tools array); falling back to local IMPLEMENTED_TOOLS list. Set AGENTMEMORY_DEBUG=1 to inspect response.\n`);
	} catch (err) {
		invalidateHandle();
		if (isAuthenticationError(err) || isProxyRequired()) throw err;
		process.stderr.write(`[@agentmemory/mcp] tools/list proxy failed: ${err instanceof Error ? err.message : String(err)}; falling back to local list\n`);
	}
	const fallback = getAllTools().filter((t) => IMPLEMENTED_TOOLS.has(t.name));
	if (debug) process.stderr.write(`[@agentmemory/mcp] tools/list: returning ${fallback.length} local fallback tools (${fallback.map((t) => t.name).join(",")})\n`);
	return { tools: fallback };
}
const transport = createStdioTransport(async (method, params) => {
	switch (method) {
		case "initialize": {
			const requested = params?.protocolVersion;
			return {
				protocolVersion: typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: {
					name: SERVER_INFO.name,
					version: SERVER_INFO.version
				}
			};
		}
		case "notifications/initialized": return {};
		case "tools/list": return handleToolsList();
		case "tools/call": {
			const toolName = params.name;
			const toolArgs = params.arguments || {};
			try {
				return await handleToolCall(toolName, toolArgs);
			} catch (err) {
				return {
					content: [{
						type: "text",
						text: `Error: ${err instanceof Error ? err.message : String(err)}`
					}],
					isError: true
				};
			}
		}
		default: throw new Error(`Unknown method: ${method}`);
	}
});
process.stderr.write(`[@agentmemory/mcp] Standalone MCP server v${SERVER_INFO.version} starting...\n`);
transport.start();
process.on("SIGINT", () => {
	kv.persist();
	process.exit(0);
});
process.on("SIGTERM", () => {
	kv.persist();
	process.exit(0);
});
//#endregion
export {};

//# sourceMappingURL=standalone-BovYdgLL.mjs.map
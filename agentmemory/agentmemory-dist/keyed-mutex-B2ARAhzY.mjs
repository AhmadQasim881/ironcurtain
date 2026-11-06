import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/state/cjk-segmenter.ts
const cjkRequire = createRequire(import.meta.url);
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL_RE = /\p{Script=Hangul}/u;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const HANGUL_BLOCK_RE = /[가-힯]+/g;
const hintShown = /* @__PURE__ */ new Set();
function hasCjk(text) {
	return CJK_RE.test(text);
}
function showHintOnce(key, message) {
	if (hintShown.has(key)) return;
	hintShown.add(key);
	if (typeof process !== "undefined" && process.stderr?.write) process.stderr.write(`agentmemory: ${message}\n`);
}
let jiebaInstance = null;
let jiebaLoaded = false;
function getJieba() {
	if (jiebaLoaded) return jiebaInstance;
	jiebaLoaded = true;
	try {
		const mod = cjkRequire("@node-rs/jieba");
		try {
			const dictMod = cjkRequire("@node-rs/jieba/dict");
			jiebaInstance = mod.Jieba.withDict(dictMod.dict);
		} catch {
			jiebaInstance = new mod.Jieba();
		}
		return jiebaInstance;
	} catch {
		showHintOnce("jieba", "install @node-rs/jieba to improve Chinese search; falling back to whole-string tokenization");
		return null;
	}
}
let jaSegmenterInstance = null;
let jaSegmenterLoaded = false;
function getJaSegmenter() {
	if (jaSegmenterLoaded) return jaSegmenterInstance;
	jaSegmenterLoaded = true;
	try {
		jaSegmenterInstance = new (cjkRequire("tiny-segmenter"))();
		return jaSegmenterInstance;
	} catch {
		showHintOnce("tiny-segmenter", "install tiny-segmenter to improve Japanese search; falling back to whole-string tokenization");
		return null;
	}
}
function cleanTokens(tokens) {
	const out = [];
	for (const t of tokens) {
		const trimmed = t.trim();
		if (trimmed) out.push(trimmed);
	}
	return out;
}
function segmentHan(text) {
	const j = getJieba();
	if (!j) return [text];
	try {
		return cleanTokens(j.cut(text, true));
	} catch {
		return [text];
	}
}
function segmentKana(text) {
	const s = getJaSegmenter();
	if (!s) return [text];
	try {
		return cleanTokens(s.segment(text));
	} catch {
		return [text];
	}
}
function segmentHangul(text) {
	const out = [];
	for (const m of text.matchAll(HANGUL_BLOCK_RE)) if (m[0]) out.push(m[0]);
	return out;
}
function segmentCjk(text) {
	if (!hasCjk(text)) return [text];
	const out = [];
	let cursor = 0;
	for (const m of text.matchAll(CJK_RUN_RE)) {
		const start = m.index ?? 0;
		const run = m[0];
		const end = start + run.length;
		if (start > cursor) {
			const piece = text.slice(cursor, start).trim();
			if (piece) out.push(piece);
		}
		if (HANGUL_RE.test(run)) out.push(...segmentHangul(run));
		else if (KANA_RE.test(run)) out.push(...segmentKana(run));
		else out.push(...segmentHan(run));
		cursor = end;
	}
	if (cursor < text.length) {
		const trailing = text.slice(cursor).trim();
		if (trailing) out.push(trailing);
	}
	return out;
}
//#endregion
//#region src/state/schema.ts
const KV = {
	sessions: "mem:sessions",
	observations: (sessionId) => `mem:obs:${sessionId}`,
	memories: "mem:memories",
	summaries: "mem:summaries",
	summaryRepairs: "mem:summary:repairs",
	config: "mem:config",
	metrics: "mem:metrics",
	health: "mem:health",
	embeddings: (obsId) => `mem:emb:${obsId}`,
	bm25Index: "mem:index:bm25",
	vectorPendingLog: "mem:index:vec-pending",
	relations: "mem:relations",
	profiles: "mem:profiles",
	claudeBridge: "mem:claude-bridge",
	graphNodes: "mem:graph:nodes",
	graphControl: "mem:graph:control",
	graphEdges: "mem:graph:edges",
	graphSnapshot: "mem:graph:snapshot",
	graphNameIndex: "mem:graph:name-index",
	graphEdgeKey: "mem:graph:edge-key",
	graphNodeDegree: "mem:graph:node-degree",
	graphMembership: "mem:graph:membership",
	graphRetrievalControl: "mem:graph:retrieval-control",
	graphRetrievalData: "mem:graph:retrieval-data",
	graphIndexMigration: "mem:graph:index-migration",
	graphIndexManifest: "mem:graph:index-manifest",
	semantic: "mem:semantic",
	procedural: "mem:procedural",
	teamShared: (teamId) => `mem:team:${teamId}:shared`,
	teamUsers: (teamId, userId) => `mem:team:${teamId}:users:${userId}`,
	teamProfile: (teamId) => `mem:team:${teamId}:profile`,
	audit: "mem:audit",
	auditMonth: (month) => `mem:audit:${month}`,
	auditMonths: "mem:audit:months",
	actions: "mem:actions",
	actionEdges: "mem:action-edges",
	leases: "mem:leases",
	routines: "mem:routines",
	routineRuns: "mem:routine-runs",
	signals: "mem:signals",
	checkpoints: "mem:checkpoints",
	mesh: "mem:mesh",
	sketches: "mem:sketches",
	facets: "mem:facets",
	sentinels: "mem:sentinels",
	crystals: "mem:crystals",
	lessons: "mem:lessons",
	insights: "mem:insights",
	graphEdgeHistory: "mem:graph:edge-history",
	enrichedChunks: (sessionId) => `mem:enriched:${sessionId}`,
	latentEmbeddings: (obsId) => `mem:latent:${obsId}`,
	retentionScores: "mem:retention",
	accessLog: "mem:access",
	imageRefs: "mem:image-refs",
	imageEmbeddings: "mem:image-embeddings",
	slots: "mem:slots",
	globalSlots: "mem:slots:global",
	state: "mem:state",
	commits: "mem:commits",
	recentSearches: "mem:recent-searches",
	projectSessionsIndex: "mem:idx:project-sessions",
	obsSessionIndex: (shard) => `mem:idx:obs:${shard}`,
	captureInbox: "mem:capture:inbox",
	captureEvents: (shard) => `mem:capture:events:${shard}`,
	capturePrompts: "mem:capture:prompts",
	evidenceSnapshots: "mem:evidence:snapshots",
	evidenceSourceRefs: "mem:evidence:source-refs",
	evidenceValues: "mem:evidence:values",
	evidenceFlows: "mem:evidence:flows",
	evidenceGuards: "mem:evidence:guards",
	evidenceRecords: "mem:evidence:records",
	evidenceArtifacts: "mem:evidence:artifacts",
	evidenceHypotheses: "mem:evidence:hypotheses",
	evidenceLinks: "mem:evidence:links",
	evidenceValidationRuns: "mem:evidence:validation-runs",
	evidenceFindings: "mem:evidence:findings",
	evidenceDependencies: "mem:evidence:dependencies",
	evidenceLifecycle: "mem:evidence:lifecycle",
	evidenceIdempotency: "mem:evidence:idempotency"
};
const STREAM = {
	name: "mem-live",
	viewerGroup: "viewer"
};
function generateId(prefix) {
	return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
function fingerprintId(prefix, content) {
	return `${prefix}_${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}
function jaccardTokens(text) {
	if (!hasCjk(text)) return new Set(text.split(/\s+/).filter((t) => t.length > 2));
	const tokens = /* @__PURE__ */ new Set();
	for (const raw of text.split(/\s+/)) {
		if (!raw) continue;
		if (hasCjk(raw)) {
			for (const seg of segmentCjk(raw)) if (seg) tokens.add(seg);
			const chars = Array.from(raw);
			if (chars.length === 1) tokens.add(chars[0]);
			else for (let i = 0; i < chars.length - 1; i++) tokens.add(chars[i] + chars[i + 1]);
		} else if (raw.length > 2) tokens.add(raw);
	}
	return tokens;
}
function jaccardSimilarity(a, b) {
	const na = a.normalize("NFC");
	const nb = b.normalize("NFC");
	const setA = jaccardTokens(na);
	const setB = jaccardTokens(nb);
	if (setA.size === 0 || setB.size === 0) return na.trim().replace(/\s+/g, " ") === nb.trim().replace(/\s+/g, " ") ? 1 : 0;
	let intersection = 0;
	for (const word of setA) if (setB.has(word)) intersection++;
	return intersection / (setA.size + setB.size - intersection);
}
//#endregion
//#region src/state/keyed-mutex.ts
const held = new AsyncLocalStorage();
function heldContext(key) {
	for (let frame = held.getStore(); frame; frame = frame.parent) if (frame.key === key) return frame.context;
}
function isKeyedLockHeld(key) {
	return heldContext(key)?.active ?? false;
}
function afterKeyedLock(key, fn, taskKey) {
	const context = heldContext(key);
	if (!context?.active) return false;
	context.after.set(taskKey ?? Symbol(), fn);
	return true;
}
const locks = /* @__PURE__ */ new Map();
function withKeyedLock(key, fn) {
	const prev = locks.get(key) ?? Promise.resolve();
	const context = {
		active: true,
		after: /* @__PURE__ */ new Map()
	};
	const run = () => held.run({
		key,
		context,
		parent: held.getStore()
	}, fn);
	const next = prev.then(run, run);
	const cleanup = next.then(() => {
		context.active = false;
	}, () => {
		context.active = false;
	});
	locks.set(key, cleanup);
	cleanup.then(() => {
		if (locks.get(key) === cleanup) locks.delete(key);
	});
	const flush = async () => {
		await cleanup;
		const errors = [];
		for (const notify of context.after.values()) try {
			await notify();
		} catch (error) {
			errors.push(error);
		}
		return errors;
	};
	return next.then(async (value) => {
		const errors = await flush();
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Deferred lock callbacks failed");
		return value;
	}, async (error) => {
		await flush();
		throw error;
	});
}
function withKeyedLocks(keys, fn) {
	const ordered = [...new Set(keys)].sort();
	const acquire = (index) => index === ordered.length ? fn() : withKeyedLock(ordered[index], () => acquire(index + 1));
	return acquire(0);
}
//#endregion
export { KV as a, generateId as c, segmentCjk as d, withKeyedLocks as i, jaccardSimilarity as l, isKeyedLockHeld as n, STREAM as o, withKeyedLock as r, fingerprintId as s, afterKeyedLock as t, hasCjk as u };

//# sourceMappingURL=keyed-mutex-B2ARAhzY.mjs.map
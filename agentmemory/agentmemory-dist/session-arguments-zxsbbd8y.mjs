function firstParam(params, name) {
	const raw = params?.[name];
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function parseListQuery(params) {
	const rawLimit = firstParam(params, "limit");
	const parsedLimit = rawLimit === void 0 ? NaN : Number(rawLimit);
	return {
		limit: Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.min(Math.floor(parsedLimit), 500) : void 0,
		cursor: firstParam(params, "cursor"),
		project: firstParam(params, "project"),
		type: firstParam(params, "type"),
		status: firstParam(params, "status"),
		q: firstParam(params, "q")
	};
}
function encodeCursor(position) {
	return Buffer.from(JSON.stringify(position), "utf-8").toString("base64url");
}
function decodeCursor(cursor) {
	if (!cursor) return null;
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
		if (!parsed || typeof parsed !== "object") return null;
		const position = {};
		if (typeof parsed.key === "string") position.key = parsed.key;
		if (typeof parsed.id === "string") position.id = parsed.id;
		if (Number.isInteger(parsed.offset) && parsed.offset >= 0) position.offset = parsed.offset;
		return position;
	} catch {
		return null;
	}
}
function compareDesc(aKey, aId, bKey, bId) {
	if (aKey !== bKey) return aKey < bKey ? 1 : -1;
	if (aId === bId) return 0;
	return aId < bId ? 1 : -1;
}
function sortByKeyDesc(items, keyOf, idOf) {
	return items.sort((a, b) => compareDesc(keyOf(a), idOf(a), keyOf(b), idOf(b)));
}
function pageAfterCursor(sortedDesc, keyOf, idOf, cursor, limit) {
	const position = decodeCursor(cursor);
	let start = 0;
	if (position?.key !== void 0 && position.id !== void 0) {
		const { key, id } = position;
		start = sortedDesc.findIndex((item) => compareDesc(keyOf(item), idOf(item), key, id) > 0);
		if (start < 0) start = sortedDesc.length;
	}
	const page = sortedDesc.slice(start, start + limit);
	const last = page[page.length - 1];
	return {
		page,
		nextCursor: last !== void 0 && start + limit < sortedDesc.length ? encodeCursor({
			key: keyOf(last),
			id: idOf(last)
		}) : null
	};
}
function pageByOffset(ordered, cursor, limit) {
	const start = decodeCursor(cursor)?.offset ?? 0;
	return {
		page: ordered.slice(start, start + limit),
		nextCursor: start + limit < ordered.length ? encodeCursor({ offset: start + limit }) : null
	};
}
function matchesText(q, ...fields) {
	if (!q) return true;
	const needle = q.toLowerCase();
	return fields.some((field) => typeof field === "string" && field.toLowerCase().includes(needle));
}
//#endregion
//#region src/mcp/search-arguments.ts
function parseSearchExpansionIds(value) {
	return (typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : []).flatMap((entry) => {
		if (typeof entry === "string") return entry.trim() ? [entry.trim()] : [];
		if (!entry || typeof entry !== "object" || typeof entry.obsId !== "string" || !entry.obsId.trim()) return [];
		const obsId = entry.obsId.trim();
		return typeof entry.sessionId === "string" && entry.sessionId.trim() ? [{
			obsId,
			sessionId: entry.sessionId.trim()
		}] : [obsId];
	});
}
//#endregion
//#region src/mcp/session-arguments.ts
function parseSessionArguments(args) {
	const limit = args.limit === void 0 ? 20 : args.limit;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
	const query = { limit: String(Math.min(limit, 100)) };
	for (const field of [
		"project",
		"agentId",
		"cursor"
	]) {
		if (args[field] === void 0) continue;
		if (field === "cursor" && typeof args[field] === "string" && !args[field].trim()) continue;
		if (typeof args[field] !== "string" || !args[field].trim()) throw new Error(`${field} must be a non-empty string`);
		query[field] = args[field].trim();
	}
	if (query.cursor) {
		const position = decodeCursor(query.cursor);
		if (!position || typeof position.key !== "string" || typeof position.id !== "string") throw new Error("cursor must be a session continuation token");
	}
	return query;
}
//#endregion
export { pageAfterCursor as a, sortByKeyDesc as c, matchesText as i, parseSearchExpansionIds as n, pageByOffset as o, encodeCursor as r, parseListQuery as s, parseSessionArguments as t };

//# sourceMappingURL=session-arguments-zxsbbd8y.mjs.map
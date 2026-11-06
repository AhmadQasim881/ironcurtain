#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import "picocolors";
import { AsyncLocalStorage } from "node:async_hooks";
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
const ENV_FILE = join(join(homedir(), ".agentmemory"), ".env");
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
function getMergedEnv(overrides) {
	return {
		...loadEnvFile(),
		...process.env,
		...overrides
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
function getStandalonePersistPath() {
	return getMergedEnv()["STANDALONE_PERSIST_PATH"] || join(homedir(), ".agentmemory", "standalone.json");
}
//#endregion
//#region src/state/search-layer.ts
function isSearchLayer(value) {
	return value === "all" || value === "memory" || value === "observation";
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
//#region src/state/list-query.ts
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
//#region src/version.ts
const VERSION = "0.9.30";
createRequire(import.meta.url);
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
function generateId(prefix) {
	return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
process.env["AGENTMEMORY_VERBOSE"] === "1" || process.env["AGENTMEMORY_VERBOSE"];
new AsyncLocalStorage();
KV.auditMonths;
const AUDIT_MIGRATION_STATE_KEY = "migration";
async function readAuditMigrationState(kv) {
	return kv.get(KV.auditMonths, AUDIT_MIGRATION_STATE_KEY);
}
function monthStartMs(month) {
	const [year, mon] = month.split("-").map(Number);
	return Date.UTC(year, mon - 1, 1);
}
function monthEndMs(month) {
	const [year, mon] = month.split("-").map(Number);
	return Date.UTC(year, mon, 1) - 1;
}
async function readAuditMonthIndex(kv) {
	return (await kv.get(KV.auditMonths, "index"))?.months ?? [];
}
async function listAuditMonthsDesc(kv) {
	return [...await readAuditMonthIndex(kv)].sort().reverse();
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
export { handleToolCall, handleToolsList };

//# sourceMappingURL=standalone.mjs.map
"""
agentmem.research_mcp — Firefox research MCP server (Claude Desktop / Claude Code).

A THIN adapter: transport only. Each tool forwards to agentmem.research_tools,
which owns validation, stable error codes, idempotency, and result bounding, which
in turn calls agentmem.research (storage). Storage/analysis logic never lives in
the transport layer. Tools return the structured envelope as JSON text.

Config (environment):
    AGENTMEM_DB      path to the SQLite research database (default ./research.db)
    AGENTMEM_ACTOR   actor id recorded in provenance/audit (default 'mcp')

Run (stdio):  AGENTMEM_DB=/path/firefox.db python -m agentmem.research_mcp

STDOUT IS THE TRANSPORT — diagnostics go to stderr only.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from typing import Optional

from .research import ResearchMemory
from .research_tools import ResearchTools

try:                                                       # mcp >= 2
    from mcp.server.mcpserver import MCPServer as _Server
except ModuleNotFoundError:                                # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server      # type: ignore

_INSTRUCTIONS = (
    "Revision-aware, evidence-based memory for authorized Firefox source-code security "
    "research. Register a repository snapshot first; every code fact is scoped to it. Record "
    "scoped value identities and EXPLICIT flow transitions (never rely on shared variable "
    "names), analysis evidence, hypotheses + counter-evidence, and validation runs. Use "
    "review_chain to see which transitions are demonstrated and which are missing, and "
    "query_history for revision-aware recall. "
    "Caller-supplied MCP records are agent assertions: verified trust and demonstrated status "
    "are derived only from separately attested backend provenance. Results use stable error "
    "codes (INVALID_ARGUMENT, NOT_FOUND, REVISION_MISMATCH, STALE_EVIDENCE, CONFLICT, "
    "BACKEND_UNAVAILABLE, RESOURCE_LIMIT); mutations accept an idempotency_key.")

mcp = _Server("agentmem-firefox-research", instructions=_INSTRUCTIONS)
_LOCK = threading.Lock()
_TOOLS: Optional[ResearchTools] = None


def _tools() -> ResearchTools:
    global _TOOLS
    if _TOOLS is None:
        db = os.environ.get("AGENTMEM_DB", "research.db")
        actor = os.environ.get("AGENTMEM_ACTOR", "mcp")
        _TOOLS = ResearchTools(ResearchMemory(db, actor=actor, check_same_thread=False))
    return _TOOLS


def _j(envelope) -> str:
    return json.dumps(envelope, ensure_ascii=False, default=str)


@mcp.tool(description="Register (or return) a repository snapshot: repo_id + full commit_id, "
                      "optional dirty/patch_digest/scope. Every code fact references a snapshot.")
def register_repository_snapshot(repo_id: str, commit_id: str, dirty: bool = False,
                                 patch_digest: str = "", scope: str = "",
                                 tree_digest: str = "", platform: str = "", index_id: str = "",
                                 idempotency_key: str = "") -> str:
    with _LOCK:
        return _j(_tools().register_repository_snapshot(
            repo_id, commit_id, dirty, patch_digest, scope, idempotency_key,
            tree_digest=tree_digest, platform=platform, index_id=index_id))


@mcp.tool(description="Record an exact, revision-scoped source reference (path is case-sensitive).")
def record_source_reference(snapshot_id: int, path: str, start_line: int = 0, end_line: int = 0,
                            symbol_id: str = "", language: str = "", excerpt: str = "",
                            idempotency_key: str = "") -> str:
    with _LOCK:
        return _j(_tools().record_source_reference(snapshot_id, path, start_line, end_line,
                                                   symbol_id, language, excerpt or None,
                                                   idempotency_key))


@mcp.tool(description="Record a scoped value identity (a flow-graph node): path, value_name, role "
                      "(source|sink|transform|param|return|field|value), symbol, range, sink_type.")
def record_value_identity(snapshot_id: int, path: str, value_name: str, role: str = "value",
                          symbol_id: str = "", start_line: int = 0, end_line: int = 0,
                          sink_type: str = "", language: str = "", idempotency_key: str = "") -> str:
    with _LOCK:
        return _j(_tools().record_value_identity(snapshot_id, path, value_name, role, symbol_id,
                                                 start_line, end_line, sink_type, language,
                                                 idempotency_key))


@mcp.tool(description="Record an agent-asserted analysis observation (raw bytes preserved as an "
                      "immutable artifact; a bounded sanitized/redacted projection stored for "
                      "search). The caller cannot assign verified trust or reproduced status.")
def record_analysis_evidence(snapshot_id: int, kind: str = "static_analysis", raw: str = "",
                             projection: str = "", status: str = "observed", tool: str = "",
                             query_id: str = "", tool_version: str = "",
                             value_identity_id: int = 0, idempotency_key: str = "") -> str:
    with _LOCK:
        return _j(_tools().record_analysis_evidence(
            snapshot_id=snapshot_id, kind=kind, raw=raw or None, projection=projection or None,
            status=status, tool=tool, query_id=query_id, tool_version=tool_version,
            value_identity_id=value_identity_id or None, idempotency_key=idempotency_key))


@mcp.tool(description="Link an EXPLICIT, agent-asserted flow transition between two value "
                      "identities in one snapshot. Requests for supported/demonstrated are "
                      "fail-closed unless compatible attested evidence already exists.")
def link_flow_transition(snapshot_id: int, src_vid: int, dst_vid: int, kind: str = "interprocedural",
                         status: str = "hypothesis", evidence_id: int = 0,
                         caller_symbol: str = "", callee_symbol: str = "",
                         arg_index: int = -1, param_name: str = "", idempotency_key: str = "") -> str:
    with _LOCK:
        return _j(_tools().link_flow_transition(
            snapshot_id=snapshot_id, src_vid=src_vid, dst_vid=dst_vid, kind=kind,
            status=status, evidence_id=evidence_id or None, caller_symbol=caller_symbol,
            callee_symbol=callee_symbol, arg_index=arg_index if arg_index >= 0 else None,
            param_name=param_name, idempotency_key=idempotency_key))


@mcp.tool(description="Record a hypothesis (statement + optional invariant/scope/next_action).")
def record_hypothesis(statement: str, snapshot_id: int = 0, invariant: str = "", scope: str = "",
                      next_action: str = "", idempotency_key: str = "") -> str:
    with _LOCK:
        return _j(_tools().record_hypothesis(snapshot_id or None, statement, invariant, scope,
                                             next_action, idempotency_key))


@mcp.tool(description="Attach counter-evidence (a 'contradicts' link) to a hypothesis.")
def record_counter_evidence(hypothesis_id: int, evidence_id: int = 0, flow_edge_id: int = 0,
                            rationale: str = "", idempotency_key: str = "") -> str:
    with _LOCK:
        return _j(_tools().record_counter_evidence(hypothesis_id, evidence_id or None,
                                                   flow_edge_id or None, rationale,
                                                   idempotency_key))


@mcp.tool(description="Record a validation run (test|build|repro|fuzz) with status and optional logs.")
def record_validation_run(snapshot_id: int = 0, kind: str = "test", status: str = "not_run",
                          hypothesis_id: int = 0, logs: str = "", repeat_summary: str = "",
                          idempotency_key: str = "") -> str:
    with _LOCK:
        return _j(_tools().record_validation_run(snapshot_id or None, kind, status,
                                                 hypothesis_id or None, logs or None,
                                                 repeat_summary, idempotency_key))


@mcp.tool(description="Revision-aware recall of evidence. Exact-revision matches first; "
                      "other-revision rows returned in 'historical' labelled stale.")
def query_history(snapshot_id: int = 0, text: str = "", kind: str = "", status: str = "",
                  path: str = "", symbol_id: str = "", limit: int = 20, offset: int = 0) -> str:
    with _LOCK:
        return _j(_tools().query_history(snapshot_id or None, text, kind, status, path, symbol_id,
                                         limit, offset))


@mcp.tool(description="Evaluate chains for a snapshot and report the EXACT missing/weak "
                      "transitions. A chain is 'demonstrated' only if every step is demonstrated.")
def review_chain(snapshot_id: int, goal: str = "") -> str:
    with _LOCK:
        return _j(_tools().review_chain(snapshot_id, goal))


@mcp.tool(description="Claim-coverage view for a hypothesis: classify its supporting evidence as "
                      "direct / dynamic / modeled, and report if it is uncovered or has counter-evidence.")
def claim_coverage(hypothesis_id: int) -> str:
    with _LOCK:
        return _j(_tools().claim_coverage(hypothesis_id))


@mcp.tool(description="Append-only reclassification of a sink's type; retracts/stales the chain "
                      "derived from the old classification.")
def reclassify_sink(value_identity_id: int, new_sink_type: str, reason: str = "",
                    idempotency_key: str = "") -> str:
    with _LOCK:
        return _j(_tools().reclassify_sink(value_identity_id, new_sink_type, reason,
                                           idempotency_key))


@mcp.tool(description="Active dependency invalidation: given changed source paths, mark the "
                      "snapshot's dependent identities/evidence/hypotheses/findings stale and "
                      "retract chains through changed code (history preserved).")
def invalidate_changed_paths(snapshot_id: int, changed_paths: list, reason: str = "source changed",
                             new_snapshot_id: int = 0, idempotency_key: str = "") -> str:
    with _LOCK:
        return _j(_tools().invalidate_changed_paths(snapshot_id, changed_paths, reason,
                                                    new_snapshot_id, idempotency_key))


@mcp.tool(description="Invalidate claims affected by changed headers, generated inputs, build "
                      "flags, analysis-model versions, boundary models, configs, or paths. "
                      "History is retained and every transition is lifecycle-audited.")
def invalidate_dependency_inputs(snapshot_id: int, changes: list,
                                 reason: str = "research input changed",
                                 new_snapshot_id: int = 0,
                                 idempotency_key: str = "") -> str:
    with _LOCK:
        return _j(_tools().invalidate_dependency_inputs(
            snapshot_id, changes, reason, new_snapshot_id, idempotency_key))


@mcp.tool(description="Export a bounded review preview for a snapshot (snapshot identity, "
                      "chains, redacted evidence previews, findings; public severity omitted). "
                      "Use ResearchMemory.export_bundle_to_dir for a complete verified bundle.")
def export_evidence_bundle(snapshot_id: int, limit: int = 100) -> str:
    with _LOCK:
        return _j(_tools().export_evidence_bundle(snapshot_id, limit))


def main() -> None:
    print(f"[agentmem-firefox-research] db={os.environ.get('AGENTMEM_DB', 'research.db')}",
          file=sys.stderr, flush=True)
    mcp.run()


if __name__ == "__main__":
    main()

"""
agentmem.research_tools — the transport-independent contract layer for the
Firefox research MCP.

This is deliberately separate from both storage (ResearchMemory) and MCP
transport (research_mcp). Every operation returns a structured envelope with a
STABLE error code, validates its inputs, bounds its results, and supports an
idempotency key so a duplicate call cannot create duplicate evidence. The MCP
server is a thin adapter over these methods; tests exercise this layer directly.

Envelope:
    {"ok": true,  "data": {...}}
    {"ok": false, "error": {"code": "<CODE>", "message": "..."}}
"""
from __future__ import annotations

import json
import sqlite3
import time
from typing import Optional

from .research import ResearchMemory

# stable error codes (part of the contract)
INVALID_ARGUMENT = "INVALID_ARGUMENT"
NOT_FOUND = "NOT_FOUND"
REVISION_MISMATCH = "REVISION_MISMATCH"
STALE_EVIDENCE = "STALE_EVIDENCE"
CONFLICT = "CONFLICT"
BACKEND_UNAVAILABLE = "BACKEND_UNAVAILABLE"
RESOURCE_LIMIT = "RESOURCE_LIMIT"

CODES = {INVALID_ARGUMENT, NOT_FOUND, REVISION_MISMATCH, STALE_EVIDENCE,
         CONFLICT, BACKEND_UNAVAILABLE, RESOURCE_LIMIT}

MAX_LIMIT = 200
MAX_OFFSET = 1_000_000
MAX_QUERY_CHARS = 4096
MAX_INPUT_CHARS = 8 * 1024 * 1024
MAX_FIELD_CHARS = 16_384
MAX_PATH_CHARS = 4096
MAX_LIST_ITEMS = 10_000


def _ok(data) -> dict:
    return {"ok": True, "data": data}


def _err(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message}}


def _classify(exc: ValueError) -> str:
    """Map a ResearchMemory ValueError to a stable error code by its message."""
    msg = str(exc).lower()
    if "single snapshot" in msg or "revision" in msg or "cross-snapshot" in msg:
        return REVISION_MISMATCH
    if "unknown" in msg or "nonexistent" in msg or "not the current version" in msg:
        return NOT_FOUND
    return INVALID_ARGUMENT


def _oversized(value: Optional[str], maximum: int = MAX_FIELD_CHARS) -> bool:
    return value is not None and len(value) > maximum


class ResearchTools:
    def __init__(self, mem: ResearchMemory):
        self.m = mem
        self.conn = mem.conn

    # ---- idempotency ----------------------------------------------------- #
    @staticmethod
    def _payload_hash(payload) -> str:
        import hashlib
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()

    def _idem_lookup(self, key: str, op: str, payload=None):
        """Replay only when the SAME key is reused for the SAME op AND the SAME
        arguments. A key reused for a different op, or the same op with different
        arguments, is a CONFLICT — not a silent replay of the first result."""
        if not key:
            return None
        row = self.conn.execute(
            "SELECT op,result_kind,result_id,payload_hash,result_json "
            "FROM idempotency_keys WHERE key=?",
            (key,)).fetchone()
        if row is None:
            return None
        if row["op"] != op:
            return _err(CONFLICT, f"idempotency key already used for a different op ({row['op']})")
        ph = self._payload_hash(payload) if payload is not None else None
        if ph is not None and row["payload_hash"] not in (None, ph):
            return _err(CONFLICT, "idempotency key reused with different arguments")
        if "result_json" in row.keys() and row["result_json"]:
            data = json.loads(row["result_json"])
            data["idempotent_replay"] = True
            return _ok(data)
        return _ok({row["result_kind"]: row["result_id"], "idempotent_replay": True})

    def _idem_store(self, key: str, op: str, data: dict, payload=None) -> None:
        if not key:
            return
        ph = self._payload_hash(payload) if payload is not None else None
        result_kind, result_id = None, None
        if len(data) == 1:
            result_kind, result_id = next(iter(data.items()))
            if not isinstance(result_id, int):
                result_kind, result_id = None, None
        self.conn.execute(
            "INSERT INTO idempotency_keys(key,op,result_kind,result_id,payload_hash,result_json,"
            "created_ts) VALUES(?,?,?,?,?,?,?)",
            (key, op, result_kind, result_id, ph,
             json.dumps(data, sort_keys=True, default=str), time.time()))

    def _mutate(self, key: str, op: str, payload: dict, callback) -> dict:
        """Execute mutation + idempotency reservation atomically.

        The MCP transport serializes calls, but this transaction also protects CLI
        and direct contract-layer users from concurrent duplicate writes.
        """
        if len(key) > 256:
            return _err(RESOURCE_LIMIT, "idempotency_key exceeds 256 characters")
        try:
            with self.m.store.transaction():
                replay = self._idem_lookup(key, op, payload)
                if replay is not None:
                    return replay
                data = callback()
                self._idem_store(key, op, data, payload)
                return _ok(data)
        except ValueError as e:
            return _err(_classify(e), str(e))
        except sqlite3.IntegrityError as e:
            return _err(CONFLICT, f"integrity conflict: {e}")
        except sqlite3.Error as e:
            return _err(BACKEND_UNAVAILABLE, f"storage backend error: {e}")
        except OSError as e:
            return _err(BACKEND_UNAVAILABLE, f"artifact backend error: {e}")

    # ---- snapshots / source -------------------------------------------- #
    def register_repository_snapshot(self, repo_id: str = "", commit_id: str = "",
                                     dirty: bool = False, patch_digest: str = "",
                                     scope: str = "", idempotency_key: str = "",
                                     tree_digest: str = "", platform: str = "",
                                     index_id: str = "") -> dict:
        if not repo_id or not commit_id:
            return _err(INVALID_ARGUMENT, "repo_id and commit_id are required")
        if not (40 <= len(commit_id) <= 64 and all(c in "0123456789abcdefABCDEF" for c in commit_id)):
            return _err(INVALID_ARGUMENT, "commit_id must be a full 40-64 character hex revision")
        if any(_oversized(v) for v in (repo_id, scope, platform, index_id)):
            return _err(RESOURCE_LIMIT, "snapshot metadata field exceeds the size limit")
        payload = {k: v for k, v in locals().items() if k not in ("self", "idempotency_key")}
        return self._mutate(
            idempotency_key, "register_repository_snapshot", payload,
            lambda: {"snapshot_id": self.m.register_snapshot(
                repo_id, commit_id, dirty, patch_digest, scope, tree_digest=tree_digest,
                platform=platform, index_id=index_id)})

    def record_source_reference(self, snapshot_id: int = 0, path: str = "", start_line: int = 0,
                                end_line: int = 0, symbol_id: str = "", language: str = "",
                                excerpt: Optional[str] = None, idempotency_key: str = "") -> dict:
        if not path:
            return _err(INVALID_ARGUMENT, "path is required")
        if _oversized(path, MAX_PATH_CHARS) or any(
                _oversized(v) for v in (symbol_id, language)):
            return _err(RESOURCE_LIMIT, "source-reference field exceeds the size limit")
        if _oversized(excerpt, MAX_INPUT_CHARS):
            return _err(RESOURCE_LIMIT, "source excerpt exceeds the input-size limit")
        if start_line and end_line and end_line < start_line:
            return _err(INVALID_ARGUMENT, "end_line precedes start_line")
        payload = {k: v for k, v in locals().items() if k not in ("self", "idempotency_key")}
        return self._mutate(
            idempotency_key, "record_source_reference", payload,
            lambda: {"source_ref_id": self.m.add_source_ref(
                snapshot_id, path, start_line=start_line, end_line=end_line,
                symbol_id=symbol_id, language=language, excerpt=excerpt)})

    def record_value_identity(self, snapshot_id: int = 0, path: str = "", value_name: str = "",
                              role: str = "value", symbol_id: str = "", start_line: int = 0,
                              end_line: int = 0, sink_type: str = "", language: str = "",
                              idempotency_key: str = "") -> dict:
        if not path or not value_name:
            return _err(INVALID_ARGUMENT, "path and value_name are required")
        if _oversized(path, MAX_PATH_CHARS) or any(
                _oversized(v) for v in (value_name, role, symbol_id, sink_type, language)):
            return _err(RESOURCE_LIMIT, "value-identity field exceeds the size limit")
        payload = {k: v for k, v in locals().items() if k not in ("self", "idempotency_key")}
        return self._mutate(
            idempotency_key, "record_value_identity", payload,
            lambda: {"value_identity_id": self.m.add_value_identity(
                snapshot_id, path, value_name, role=role, symbol_id=symbol_id,
                start_line=start_line, end_line=end_line, sink_type=sink_type,
                language=language)})

    # ---- evidence / hypotheses / flow ---------------------------------- #
    def record_analysis_evidence(self, snapshot_id: int = 0, kind: str = "static_analysis",
                                 raw: Optional[str] = None, projection: Optional[str] = None,
                                 status: str = "observed", trust: str = "agent_asserted",
                                 tool: str = "", query_id: str = "", tool_version: str = "",
                                 value_identity_id: Optional[int] = None,
                                 idempotency_key: str = "") -> dict:
        if raw is None and projection is None:
            return _err(INVALID_ARGUMENT, "evidence needs raw or projection")
        if raw is not None and len(raw) > MAX_INPUT_CHARS:
            return _err(RESOURCE_LIMIT, "raw evidence exceeds the input-size limit")
        if projection is not None and len(projection) > MAX_INPUT_CHARS:
            return _err(RESOURCE_LIMIT, "evidence projection exceeds the input-size limit")
        if any(_oversized(v) for v in (kind, status, trust, tool, query_id, tool_version)):
            return _err(RESOURCE_LIMIT, "evidence metadata field exceeds the size limit")
        payload = {k: v for k, v in locals().items() if k not in ("self", "idempotency_key")}

        def create():
            # MCP input is an agent assertion. Tool names are metadata, not an
            # authority to self-assign tool_verified trust.
            prov = self.m.add_provenance(snapshot_id, tool=tool, tool_version=tool_version,
                                         query_id=query_id, actor=tool or self.m.actor,
                                         actor_kind="agent", trust="agent_asserted")
            eid = self.m.add_evidence(snapshot_id, kind, raw=raw, projection=projection,
                                      status=status, trust="agent_asserted", provenance_id=prov,
                                      value_identity_id=value_identity_id)
            stored = self.m.get_evidence(eid)
            return {"evidence_id": eid, "stored_status": stored["status"],
                    "stored_trust": stored["trust"]}

        return self._mutate(idempotency_key, "record_analysis_evidence", payload, create)

    def record_hypothesis(self, snapshot_id: Optional[int] = None, statement: str = "",
                          invariant: str = "", scope: str = "", next_action: str = "",
                          idempotency_key: str = "") -> dict:
        if not statement:
            return _err(INVALID_ARGUMENT, "statement is required")
        if any(_oversized(v) for v in (statement, invariant, scope, next_action)):
            return _err(RESOURCE_LIMIT, "hypothesis field exceeds the size limit")
        payload = {k: v for k, v in locals().items() if k not in ("self", "idempotency_key")}
        return self._mutate(
            idempotency_key, "record_hypothesis", payload,
            lambda: {"hypothesis_id": self.m.add_hypothesis(
                snapshot_id, statement, invariant=invariant, scope=scope,
                next_action=next_action)})

    def record_counter_evidence(self, hypothesis_id: int = 0, evidence_id: Optional[int] = None,
                                flow_edge_id: Optional[int] = None, rationale: str = "",
                                idempotency_key: str = "") -> dict:
        if _oversized(rationale):
            return _err(RESOURCE_LIMIT, "rationale exceeds the size limit")
        payload = {k: v for k, v in locals().items() if k not in ("self", "idempotency_key")}
        return self._mutate(
            idempotency_key, "record_counter_evidence", payload,
            lambda: {"link_id": self.m.link_evidence(
                hypothesis_id, "contradicts", evidence_id=evidence_id,
                flow_edge_id=flow_edge_id, rationale=rationale)})

    def link_flow_transition(self, snapshot_id: int = 0, src_vid: int = 0, dst_vid: int = 0,
                             kind: str = "interprocedural", status: str = "hypothesis",
                             trust: str = "agent_asserted", evidence_id: Optional[int] = None,
                             caller_symbol: str = "", callee_symbol: str = "",
                             arg_index: Optional[int] = None, param_name: str = "",
                             idempotency_key: str = "") -> dict:
        if any(_oversized(v) for v in (
                kind, status, trust, caller_symbol, callee_symbol, param_name)):
            return _err(RESOURCE_LIMIT, "flow-transition field exceeds the size limit")
        payload = {k: v for k, v in locals().items() if k not in ("self", "idempotency_key")}

        def create():
            eid = self.m.add_flow_edge(snapshot_id, src_vid, dst_vid, kind=kind, status=status,
                                       trust="agent_asserted", evidence_id=evidence_id,
                                       caller_symbol=caller_symbol, callee_symbol=callee_symbol,
                                       arg_index=arg_index, param_name=param_name)
            row = self.conn.execute(
                "SELECT status,trust FROM flow_edges WHERE id=?", (eid,)).fetchone()
            return {"flow_edge_id": eid, "stored_status": row["status"],
                    "stored_trust": row["trust"]}

        return self._mutate(idempotency_key, "link_flow_transition", payload, create)

    def record_validation_run(self, snapshot_id: Optional[int] = None, kind: str = "test",
                              status: str = "not_run", hypothesis_id: Optional[int] = None,
                              logs: Optional[str] = None, repeat_summary: str = "",
                              idempotency_key: str = "") -> dict:
        if logs is not None and len(logs) > MAX_INPUT_CHARS:
            return _err(RESOURCE_LIMIT, "validation logs exceed the input-size limit")
        if any(_oversized(v) for v in (kind, status, repeat_summary)):
            return _err(RESOURCE_LIMIT, "validation metadata field exceeds the size limit")
        payload = {k: v for k, v in locals().items() if k not in ("self", "idempotency_key")}

        def create():
            vid = self.m.add_validation_run(snapshot_id, kind=kind, status=status,
                                            hypothesis_id=hypothesis_id, logs=logs,
                                            repeat_summary=repeat_summary)
            stored = self.conn.execute(
                "SELECT status FROM validation_runs WHERE id=?", (vid,)).fetchone()
            return {"validation_run_id": vid, "stored_status": stored["status"]}

        return self._mutate(idempotency_key, "record_validation_run", payload, create)

    # ---- retrieval / review -------------------------------------------- #
    def query_history(self, snapshot_id: Optional[int] = None, text: str = "", kind: str = "",
                      status: str = "", path: str = "", symbol_id: str = "",
                      limit: int = 20, offset: int = 0) -> dict:
        if isinstance(limit, bool) or not isinstance(limit, int) \
                or isinstance(offset, bool) or not isinstance(offset, int):
            return _err(INVALID_ARGUMENT, "limit and offset must be integers")
        if not 1 <= limit <= MAX_LIMIT:
            return _err(RESOURCE_LIMIT, f"limit must be between 1 and {MAX_LIMIT}")
        if not 0 <= offset <= MAX_OFFSET:
            return _err(RESOURCE_LIMIT, f"offset must be between 0 and {MAX_OFFSET}")
        if len(text) > MAX_QUERY_CHARS:
            return _err(RESOURCE_LIMIT, f"text query exceeds {MAX_QUERY_CHARS} characters")
        if any(_oversized(v) for v in (kind, status, path, symbol_id)):
            return _err(RESOURCE_LIMIT, "query filter exceeds the size limit")
        try:
            hits = self.m.search_evidence(snapshot_id=snapshot_id, text=text or None,
                                          kind=kind or None, status=status or None,
                                          path=path or None, symbol_id=symbol_id or None,
                                          limit=limit, offset=offset)
        except ValueError as e:
            return _err(_classify(e), str(e))
        except sqlite3.Error as e:
            return _err(BACKEND_UNAVAILABLE, f"storage backend error: {e}")
        stale = [h for h in hits if h["stale"]]
        current = [h for h in hits if not h["stale"]]
        return _ok({"current": current, "historical": stale,
                    "text_backend": self.m.text_search_backend()})

    def review_chain(self, snapshot_id: int = 0, goal: str = "") -> dict:
        """Evaluate chains and report the EXACT missing/weak transitions (gaps). A
        chain is only 'demonstrated' when every required transition is demonstrated."""
        if _oversized(goal):
            return _err(RESOURCE_LIMIT, "goal exceeds the size limit")
        try:
            chains = self.m.chains(snapshot_id, goal=goal or None)
        except ValueError as e:
            return _err(_classify(e), str(e))
        reviewed, established, unresolved, contradicted = [], [], [], []
        for c in chains:
            gaps = [s for s in c["steps"] if s["status"] != "demonstrated" or s["guard_blocked"]]
            boundary_gaps = self.m.chain_boundary_gaps(snapshot_id, c["steps"])
            # a composed chain is 'demonstrated' only if EVERY transition is
            # demonstrated AND no unproven trust-boundary crossing remains.
            demonstrated = (c["status"] == "demonstrated" and not gaps and not boundary_gaps)
            if demonstrated:
                assessment_status, impact_state = "demonstrated", "demonstrated"
            elif c["status"] == "blocked":
                assessment_status, impact_state = "contradicted", "unproven"
            elif c["status"] == "supported" and not boundary_gaps:
                assessment_status, impact_state = "supported", "suspected"
            else:
                assessment_status, impact_state = "unresolved", "unproven"
            item = {
                "goal": c["goal"], "status": assessment_status,
                "transition_status": c["status"], "severity": c["severity"],
                "impact_state": impact_state, "narrative": c["narrative"],
                "demonstrated": demonstrated,
                "missing_transitions": [
                    {"flow_edge_id": g["flow_edge_id"], "status": g["status"],
                     "guard_blocked": g["guard_blocked"]} for g in gaps],
                "boundary_gaps": boundary_gaps,
            }
            reviewed.append(item)
            if demonstrated:
                established.append(item)
            elif assessment_status == "contradicted":
                contradicted.append(item)
            else:
                unresolved.append(item)
        return _ok({"chains": reviewed, "established": established,
                    "unresolved": unresolved, "contradicted": contradicted,
                    "limitations": (["trust-domain or boundary evidence is incomplete"]
                                    if any(c["boundary_gaps"] for c in reviewed) else [])})

    def claim_coverage(self, hypothesis_id: int = 0) -> dict:
        try:
            return _ok(self.m.claim_coverage(hypothesis_id))
        except ValueError as e:
            return _err(_classify(e), str(e))

    def reclassify_sink(self, value_identity_id: int = 0, new_sink_type: str = "",
                        reason: str = "", idempotency_key: str = "") -> dict:
        if not new_sink_type:
            return _err(INVALID_ARGUMENT, "new_sink_type is required")
        if any(_oversized(v) for v in (new_sink_type, reason)):
            return _err(RESOURCE_LIMIT, "reclassification field exceeds the size limit")
        payload = {k: v for k, v in locals().items() if k not in ("self", "idempotency_key")}
        return self._mutate(
            idempotency_key, "reclassify_sink", payload,
            lambda: {"new_value_identity_id": self.m.reclassify_sink(
                value_identity_id, new_sink_type, reason=reason)})

    def invalidate_changed_paths(self, snapshot_id: int = 0, changed_paths=None,
                                 reason: str = "source changed", new_snapshot_id: int = 0,
                                 idempotency_key: str = "") -> dict:
        if not changed_paths:
            return _err(INVALID_ARGUMENT, "changed_paths is required")
        if isinstance(changed_paths, str):
            changed_paths = [p.strip() for p in changed_paths.split(",") if p.strip()]
        if len(changed_paths) > MAX_LIST_ITEMS:
            return _err(RESOURCE_LIMIT, f"changed_paths exceeds {MAX_LIST_ITEMS} items")
        if any(not isinstance(p, str) or _oversized(p, MAX_PATH_CHARS) for p in changed_paths):
            return _err(RESOURCE_LIMIT, "changed path exceeds the size limit")
        payload = {"snapshot_id": snapshot_id, "changed_paths": changed_paths,
                   "reason": reason, "new_snapshot_id": new_snapshot_id}
        return self._mutate(
            idempotency_key, "invalidate_changed_paths", payload,
            lambda: self.m.invalidate_changed_paths(
                snapshot_id, changed_paths, reason, new_snapshot_id or None))

    def invalidate_dependency_inputs(self, snapshot_id: int = 0, changes=None,
                                     reason: str = "research input changed",
                                     new_snapshot_id: int = 0,
                                     idempotency_key: str = "") -> dict:
        if not changes:
            return _err(INVALID_ARGUMENT, "changes is required")
        if isinstance(changes, dict):
            item_count = sum(1 if isinstance(v, str) else len(v or []) for v in changes.values())
        else:
            item_count = len(changes)
        if item_count > MAX_LIST_ITEMS:
            return _err(RESOURCE_LIMIT, f"changes exceeds {MAX_LIST_ITEMS} items")
        if _oversized(reason):
            return _err(RESOURCE_LIMIT, "reason exceeds the size limit")
        payload = {"snapshot_id": snapshot_id, "changes": changes,
                   "reason": reason, "new_snapshot_id": new_snapshot_id}
        return self._mutate(
            idempotency_key, "invalidate_dependency_inputs", payload,
            lambda: self.m.invalidate_dependency_inputs(
                snapshot_id, changes, reason, new_snapshot_id or None))

    def export_evidence_bundle(self, snapshot_id: int = 0, limit: int = 100) -> dict:
        if isinstance(limit, bool) or not isinstance(limit, int):
            return _err(INVALID_ARGUMENT, "limit must be an integer")
        if not 1 <= limit <= MAX_LIMIT:
            return _err(RESOURCE_LIMIT, f"limit must be between 1 and {MAX_LIMIT}")
        try:
            snap = self.m.get_snapshot(snapshot_id)
            if snap is None:
                return _err(NOT_FOUND, f"unknown snapshot {snapshot_id}")
            chains = self.m.chains(snapshot_id)
            for chain in chains:
                chain.pop("severity", None)
            evidence = self.m.search_evidence(snapshot_id=snapshot_id, limit=limit)
            findings = [dict(r) for r in self.conn.execute(
                "SELECT id,fingerprint,title,status,impact_state FROM findings "
                "WHERE snapshot_id=? LIMIT ?", (snapshot_id, limit)).fetchall()]
        except ValueError as e:
            return _err(_classify(e), str(e))
        return _ok({"snapshot": {"id": snap["id"], "repo_id": snap["repo_id"],
                                 "commit_id": snap["commit_id"], "dirty": bool(snap["dirty"]),
                                 "scope": snap["scope"]},
                    "chains": chains, "evidence": evidence, "findings": findings})

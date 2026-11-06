"""
agentmem.research — revision-aware, evidence-based source-code research memory.

This is the reliable replacement for the first-generation code-review profile.
Its core rule: **a code-flow relationship is an explicit, provenance-bearing
record, never an inference from two values sharing a variable name.**

The flow graph has two node/edge types:

  * `value_identities` — a *scoped* value: (snapshot, case-sensitive path,
    qualified symbol, source range, value name, role). A local `data` in function
    A and a local `data` in function B are DIFFERENT identities (different
    `vid_key`), so they never connect by name.
  * `flow_edges` — an explicit transition recorded by an analysis tool, by exact
    source review, or as a labelled hypothesis. Interprocedural edges carry the
    callsite, caller/callee symbols, the argument→parameter mapping, and the
    return→receiver mapping. A chain may traverse ONLY these edges.

`guards` model sanitizers/validators as evidence-backed transitions attached to a
specific flow edge. An active guard with no bypass/incomplete record blocks that
edge from contributing to a confirmed chain.

A research chain's status is the **weakest** transition on it (a chain is never
stronger than its least-supported step), and an active guard caps a step at
`blocked`. Everything is snapshot-scoped; cross-revision records are labelled
`stale`/`revision-mismatch` and never silently presented as current.
"""
from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import time
from typing import Optional

from . import config
from .profiles import _CR_GOAL_SEVERITY, _SINK_GOAL
from .security import SecretsVault, project_text
from .store import Store

# research trust ranking extends the engine's with human review (strongest) and a
# reproduced-under-controlled-conditions tier. Higher may assert stronger states.
_TRUST_RANK = {**config.TRUST_RANK, "human_verified": 4, "reproduced": 4}


def _trust_rank(trust: str) -> int:
    return _TRUST_RANK.get(trust, 0)

# demonstrated-ness ordering for flow-edge status; a chain is the WEAKEST step.
FLOW_STATUSES = ("rejected", "blocked", "hypothesis", "supported", "demonstrated")
_FLOW_RANK = {s: i for i, s in enumerate(FLOW_STATUSES)}
_RANK_FLOW = {i: s for s, i in _FLOW_RANK.items()}

# trust levels that may ASSERT a demonstrated/reproduced relationship. Untrusted
# repository text, raw LLM output, and arbitrary agent assertions cannot (task 4).
_STRONG_TRUST = {"tool_verified", "human_verified"}
_ALL_TRUST = set(_TRUST_RANK)
_HEX_DIGEST = re.compile(r"^[0-9a-fA-F]{64}$")

EVIDENCE_STATUSES = ("observed", "supported", "reproduced", "rejected", "stale")
HYPOTHESIS_STATUSES = ("open", "supported", "rejected", "superseded")
VALIDATION_STATUSES = ("not_run", "passed", "failed", "inconclusive", "intermittent")
FINDING_STATUSES = ("draft", "in_review", "accepted", "duplicate", "closed")

_MAX_PATH_DEPTH = 24          # bound chain-search path length
_MAX_FANOUT = 64              # bound per-node expansion (dense flow graphs)
_MAX_CHAIN_RESULTS = 500      # hard cap on materialized chains per call (prevents blowup)
_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024


def _digest(*parts: str) -> str:
    return hashlib.sha256("||".join(parts).encode("utf-8")).hexdigest()


def vid_key(path: str, symbol_id: str, value_name: str,
            start_line: int, end_line: int, role: str) -> str:
    """Canonical scoped-identity key. Path is CASE-SENSITIVE on purpose: `Foo.cpp`
    and `foo.cpp` are distinct identities on a case-sensitive repository."""
    return "|".join(["vid", path or "", symbol_id or "", value_name or "",
                     f"{int(start_line or 0)}-{int(end_line or 0)}", role or "value"])


class ResearchMemory:
    """Facade over the research-evidence tables (built on the same Store/SQLite
    connection and artifact store as the web engine, migrated to schema v2)."""

    def __init__(self, path: str = "research.db", actor: str = "agent",
                 session: str = "", check_same_thread: bool = True):
        self.store = Store(path, check_same_thread=check_same_thread)
        self.conn = self.store.conn
        # ResearchMemory used to omit the vault initialized by Memory, which meant
        # research projections were sanitized but never secret-redacted.
        self.vault = SecretsVault(self.store)
        self.store.vault = self.vault
        self.actor = actor
        self.session = session

    def close(self) -> None:
        self.store.close()

    def __enter__(self) -> "ResearchMemory":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---- snapshots ------------------------------------------------------- #
    def register_snapshot(self, repo_id: str, commit_id: str, dirty: bool = False,
                          patch_digest: str = "", scope: str = "", tree_digest: str = "",
                          manifest_artifact_id: Optional[int] = None, platform: str = "",
                          index_id: str = "") -> int:
        """Register (or return) a repository snapshot. Its identity folds in the
        dirty state + patch digest + scope, so a patched run is a DIFFERENT
        snapshot than the clean commit."""
        if not repo_id or not commit_id:
            raise ValueError("snapshot requires repo_id and commit_id")
        if not (40 <= len(commit_id) <= 64 and all(
                char in "0123456789abcdefABCDEF" for char in commit_id)):
            raise ValueError("commit_id must be a full 40-64 character hex revision")
        if dirty and not patch_digest:
            raise ValueError("dirty snapshots require patch_digest")
        if patch_digest and not _HEX_DIGEST.fullmatch(patch_digest):
            raise ValueError("patch_digest must be a full SHA-256 hex digest")
        if tree_digest and not _HEX_DIGEST.fullmatch(tree_digest):
            raise ValueError("tree_digest must be a full SHA-256 hex digest")
        if manifest_artifact_id is not None and self.store.artifact_row(manifest_artifact_id) is None:
            raise ValueError(f"unknown manifest artifact {manifest_artifact_id}")
        uid = _digest(repo_id, commit_id, str(int(dirty)), patch_digest or "", scope or "",
                      tree_digest or "", str(manifest_artifact_id or ""), platform or "",
                      index_id or "")[:24]
        row = self.conn.execute("SELECT id FROM snapshots WHERE snapshot_uid=?", (uid,)).fetchone()
        if row is not None:
            return row["id"]
        with self.store.transaction():
            cur = self.conn.execute(
                "INSERT INTO snapshots(snapshot_uid,repo_id,commit_id,dirty,patch_digest,"
                "scope,created_ts,meta_json,tree_digest,manifest_artifact_id,platform,index_id) "
                "VALUES(?,?,?,?,?,?,?,'{}',?,?,?,?)",
                (uid, repo_id, commit_id, int(dirty), patch_digest or None, scope or None,
                 time.time(), tree_digest or None, manifest_artifact_id, platform or None,
                 index_id or None))
            sid = cur.lastrowid
            self.store.add_audit("register_snapshot", "snapshots", sid, actor=self.actor,
                                 session=self.session, new_state=uid)
        return sid

    def get_snapshot(self, snapshot_id: int) -> Optional[dict]:
        r = self.conn.execute("SELECT * FROM snapshots WHERE id=?", (snapshot_id,)).fetchone()
        return dict(r) if r else None

    def _require_snapshot(self, snapshot_id: int) -> None:
        if self.conn.execute("SELECT 1 FROM snapshots WHERE id=?", (snapshot_id,)).fetchone() is None:
            raise ValueError(f"unknown snapshot {snapshot_id}")

    def _require_scoped(self, table: str, row_id: Optional[int], snapshot_id: int,
                        label: str, nullable: bool = True) -> Optional[dict]:
        """Resolve a snapshot-scoped foreign reference and reject cross-revision
        relationships. Ordinary SQLite foreign keys only prove existence; research
        integrity also requires both ends to name the same snapshot."""
        if row_id is None:
            if nullable:
                return None
            raise ValueError(f"{label} is required")
        row = self.conn.execute(
            f"SELECT * FROM {table} WHERE id=?", (row_id,)).fetchone()
        if row is None:
            raise ValueError(f"unknown {label} {row_id}")
        data = dict(row)
        if data.get("snapshot_id") != snapshot_id:
            raise ValueError(
                f"cross-snapshot {label} {row_id}: expected snapshot {snapshot_id}, "
                f"got {data.get('snapshot_id')}")
        return data

    def _effective_trust(self, snapshot_id: int, requested: str,
                         provenance_id: Optional[int]) -> tuple[str, Optional[dict]]:
        """Trust is derived from compatible provenance. A bare caller assertion
        cannot mint ``tool_verified``/``human_verified`` simply by spelling it."""
        if requested not in _ALL_TRUST:
            raise ValueError(f"invalid trust level: {requested}")
        prov = self._require_scoped("provenance", provenance_id, snapshot_id,
                                    "provenance") if provenance_id is not None else None
        if prov is None:
            if requested in _STRONG_TRUST:
                return "agent_asserted", None
            return requested, None
        p_trust = prov.get("trust") or "agent_asserted"
        if p_trust not in _ALL_TRUST:
            p_trust = "agent_asserted"
        # A record cannot claim more trust than its provenance.
        return min((requested, p_trust), key=_trust_rank), prov

    def _record_lifecycle(self, entity_table: str, entity_id: int, version: int,
                          old_state: str, new_state: str, rationale: str = "",
                          evidence_ids=None) -> int:
        cur = self.conn.execute(
            "INSERT INTO research_lifecycle_events(entity_table,entity_id,entity_version,"
            "old_state,new_state,rationale,actor,session,evidence_json,created_ts) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (entity_table, entity_id, version, old_state or None, new_state,
             rationale or None, self.actor, self.session,
             json.dumps(sorted(set(evidence_ids or []))), time.time()))
        return cur.lastrowid

    @staticmethod
    def _validate_repo_path(path: str) -> str:
        if not path or "\\" in path or path.startswith("/"):
            raise ValueError("path must be a non-empty repository-relative POSIX path")
        normalized = posixpath.normpath(path)
        if normalized in (".", "..") or normalized.startswith("../") or normalized != path:
            raise ValueError("path must be normalized and may not traverse outside the repository")
        return path

    @staticmethod
    def _validate_range(start_line: int, end_line: int, start_col: int = 0,
                        end_col: int = 0) -> None:
        if min(start_line, end_line, start_col, end_col) < 0:
            raise ValueError("source positions cannot be negative")
        if start_line and end_line and end_line < start_line:
            raise ValueError("end_line precedes start_line")
        if start_line == end_line and start_col and end_col and end_col < start_col:
            raise ValueError("end_col precedes start_col")

    # ---- provenance ------------------------------------------------------ #
    def add_provenance(self, snapshot_id: Optional[int] = None, tool: str = "",
                       tool_version: str = "", actor: str = "", actor_kind: str = "agent",
                       trust: str = "agent_asserted", query_id: str = "",
                       config_digest: str = "", raw_artifact_id: Optional[int] = None) -> int:
        if snapshot_id is not None:
            self._require_snapshot(snapshot_id)
        if trust not in _ALL_TRUST:
            raise ValueError(f"invalid trust level: {trust}")
        if actor_kind not in ("human", "agent", "tool", "import", "worker"):
            raise ValueError(f"invalid actor_kind: {actor_kind}")
        if trust == "human_verified" and actor_kind != "human":
            raise ValueError("human_verified provenance requires actor_kind='human'")
        if trust == "tool_verified" and actor_kind not in ("tool", "worker", "import"):
            raise ValueError("tool_verified provenance requires a tool/worker/import actor")
        if raw_artifact_id is not None and self.store.artifact_row(raw_artifact_id) is None:
            raise ValueError(f"unknown raw artifact {raw_artifact_id}")
        cur = self.conn.execute(
            "INSERT INTO provenance(snapshot_id,tool,tool_version,query_id,actor,actor_kind,"
            "trust,config_digest,raw_artifact_id,ts,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?,'{}')",
            (snapshot_id, tool or None, tool_version or None, query_id or None,
             actor or self.actor, actor_kind, trust, config_digest or None,
             raw_artifact_id, time.time()))
        return cur.lastrowid

    # ---- source references ---------------------------------------------- #
    def add_source_ref(self, snapshot_id: int, path: str, start_line: int = 0,
                       end_line: int = 0, start_col: int = 0, end_col: int = 0,
                       symbol_id: str = "", language: str = "",
                       excerpt: Optional[str] = None, file_digest: str = "") -> int:
        self._require_snapshot(snapshot_id)
        self._validate_repo_path(path)
        self._validate_range(start_line, end_line, start_col, end_col)
        if file_digest and not _HEX_DIGEST.fullmatch(file_digest):
            raise ValueError("file_digest must be a full SHA-256 hex digest")
        art_id, digest = None, None
        if excerpt is not None:
            size = len(excerpt.encode("utf-8") if isinstance(excerpt, str) else bytes(excerpt))
            if size > _MAX_ARTIFACT_BYTES:
                raise ValueError(
                    f"source excerpt exceeds maximum size of {_MAX_ARTIFACT_BYTES} bytes")
            info = self.store.put_artifact(excerpt, media_type="text/plain",
                                           producing_run="source_excerpt")
            art_id, digest = info["id"], info["sha256"]
        with self.store.transaction():
            cur = self.conn.execute(
                "INSERT INTO source_refs(snapshot_id,path,start_line,start_col,end_line,"
                "end_col,symbol_id,language,excerpt_artifact_id,excerpt_digest,created_ts,"
                "meta_json,file_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,'{}',?)",
                (snapshot_id, path, start_line, start_col, end_line, end_col,
                 symbol_id or None, language or None, art_id, digest, time.time(),
                 file_digest or None))
            return cur.lastrowid

    # ---- value identities (flow-graph nodes) ----------------------------- #
    def add_value_identity(self, snapshot_id: int, path: str, value_name: str,
                           role: str = "value", symbol_id: str = "", start_line: int = 0,
                           end_line: int = 0, sink_type: str = "", language: str = "",
                           tool: str = "", run_id: str = "",
                           source_ref_id: Optional[int] = None,
                           provenance_id: Optional[int] = None,
                           status: str = "observed") -> int:
        """Record a scoped value identity (the node a flow edge connects). Dedupes
        on (snapshot, vid_key) current version; path is case-sensitive."""
        self._require_snapshot(snapshot_id)
        self._validate_repo_path(path)
        self._validate_range(start_line, end_line)
        if role not in ("source", "sink", "transform", "param", "return", "field", "value"):
            raise ValueError(f"invalid value-identity role: {role}")
        if status not in ("observed", "supported", "rejected", "stale"):
            raise ValueError(f"invalid value-identity status: {status}")
        if role != "sink" and sink_type:
            raise ValueError("sink_type is valid only for role='sink'")
        self._require_scoped("source_refs", source_ref_id, snapshot_id, "source reference") \
            if source_ref_id is not None else None
        _effective, _ = self._effective_trust(snapshot_id, "agent_asserted", provenance_id)
        key = vid_key(path, symbol_id, value_name, start_line, end_line, role)
        row = self.conn.execute(
            "SELECT id FROM value_identities WHERE snapshot_id=? AND vid_key=? AND valid_to IS NULL",
            (snapshot_id, key)).fetchone()
        if row is not None:
            return row["id"]
        now = time.time()
        with self.store.transaction():
            cur = self.conn.execute(
                "INSERT INTO value_identities(snapshot_id,vid_key,path,symbol_id,value_name,"
                "start_line,end_line,role,sink_type,language,tool,run_id,source_ref_id,"
                "provenance_id,status,version,valid_from,valid_to,created_ts,meta_json) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,NULL,?,'{}')",
                (snapshot_id, key, path, symbol_id or None, value_name, start_line, end_line,
                 role, sink_type or None, language or None, tool or None, run_id or None,
                 source_ref_id, provenance_id, status, now, now))
            vid = cur.lastrowid
            self.store.add_audit("add_value_identity", "value_identities", vid,
                                 actor=self.actor, session=self.session, new_state=role)
        return vid

    def get_value_identity(self, vid: int) -> Optional[dict]:
        r = self.conn.execute("SELECT * FROM value_identities WHERE id=?", (vid,)).fetchone()
        return dict(r) if r else None

    # ---- explicit flow edges -------------------------------------------- #
    def add_flow_edge(self, snapshot_id: int, src_vid: int, dst_vid: int,
                      kind: str = "intraprocedural", status: str = "hypothesis",
                      callsite_path: str = "", callsite_line: int = 0,
                      caller_symbol: str = "", callee_symbol: str = "",
                      arg_index: Optional[int] = None, param_name: str = "",
                      return_to: str = "", field_id: str = "",
                      confidence: float = 0.5, trust: str = "agent_asserted",
                      provenance_id: Optional[int] = None,
                      evidence_id: Optional[int] = None) -> int:
        """Record an explicit flow transition between two scoped value identities.
        Both identities must exist and belong to the SAME snapshot (a chain may not
        cross revisions). `status` is capped: only strong-trust provenance may
        assert 'demonstrated' (otherwise it is lowered to 'supported')."""
        self._require_snapshot(snapshot_id)
        if status not in _FLOW_RANK:
            raise ValueError(f"invalid flow status: {status}")
        if kind not in ("intraprocedural", "interprocedural", "field", "return", "alias"):
            raise ValueError(f"invalid flow kind: {kind}")
        if not 0.0 <= float(confidence) <= 1.0:
            raise ValueError("confidence must be between 0 and 1")
        src = self.get_value_identity(src_vid)
        dst = self.get_value_identity(dst_vid)
        if src is None or dst is None:
            raise ValueError("flow edge references a nonexistent value identity")
        if src["snapshot_id"] != snapshot_id or dst["snapshot_id"] != snapshot_id:
            raise ValueError("flow edge must stay within a single snapshot (revision)")
        ev = self._require_scoped("evidence", evidence_id, snapshot_id, "evidence") \
            if evidence_id is not None else None
        trust, prov = self._effective_trust(snapshot_id, trust, provenance_id)
        # A supported edge needs compatible evidence or strong provenance. A
        # demonstrated edge additionally needs reproduced evidence. This prevents
        # callers from minting a strong transition by supplying a trust string.
        if status == "supported" and ev is None and trust not in _STRONG_TRUST:
            status = "hypothesis"
        if status == "demonstrated":
            demonstrated_ok = (
                ev is not None and ev.get("status") == "reproduced"
                and trust in _STRONG_TRUST and prov is not None
                and ev.get("provenance_id") == provenance_id
                and _trust_rank(ev.get("trust") or "") >= _trust_rank("tool_verified")
            )
            if not demonstrated_ok:
                status = "supported" if ev is not None and trust in _STRONG_TRUST else "hypothesis"
        now = time.time()
        with self.store.transaction():
            cur = self.conn.execute(
                "INSERT INTO flow_edges(snapshot_id,src_vid,dst_vid,kind,callsite_path,"
                "callsite_line,caller_symbol,callee_symbol,arg_index,param_name,return_to,"
                "field_id,status,confidence,trust,provenance_id,evidence_id,version,"
                "valid_from,valid_to,created_ts,meta_json) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,NULL,?,'{}')",
                (snapshot_id, src_vid, dst_vid, kind, callsite_path or None, callsite_line or None,
                 caller_symbol or None, callee_symbol or None, arg_index, param_name or None,
                 return_to or None, field_id or None, status, confidence, trust,
                 provenance_id, evidence_id, now, now))
            eid = cur.lastrowid
            self.store.add_audit("add_flow_edge", "flow_edges", eid, actor=self.actor,
                                 session=self.session, new_state=status)
        return eid

    # ---- guards / sanitizers -------------------------------------------- #
    def add_guard(self, snapshot_id: int, flow_edge_id: Optional[int] = None,
                  in_vid: Optional[int] = None, out_vid: Optional[int] = None,
                  guard_symbol: str = "", path: str = "", start_line: int = 0,
                  end_line: int = 0, condition: str = "", transformation: str = "",
                  kind: str = "sanitizer", limits: str = "", status: str = "active",
                  provenance_id: Optional[int] = None,
                  evidence_id: Optional[int] = None) -> int:
        """Record an evidence-backed sanitizer/guard attached to a specific flow
        edge. An `active` guard with no bypass/incomplete record prevents that edge
        from contributing to a confirmed/demonstrated chain."""
        self._require_snapshot(snapshot_id)
        if status not in ("active", "bypassed", "incomplete", "rejected"):
            raise ValueError(f"invalid guard status: {status}")
        if path:
            self._validate_repo_path(path)
        self._validate_range(start_line, end_line)
        if flow_edge_id is None and in_vid is None:
            raise ValueError("guard requires flow_edge_id or in_vid")
        self._require_scoped("flow_edges", flow_edge_id, snapshot_id, "flow edge") \
            if flow_edge_id is not None else None
        self._require_scoped("value_identities", in_vid, snapshot_id, "input value identity") \
            if in_vid is not None else None
        self._require_scoped("value_identities", out_vid, snapshot_id, "output value identity") \
            if out_vid is not None else None
        ev = self._require_scoped("evidence", evidence_id, snapshot_id, "evidence") \
            if evidence_id is not None else None
        effective_trust, prov = self._effective_trust(
            snapshot_id, (ev or {}).get("trust") or "agent_asserted", provenance_id)
        if status in ("bypassed", "incomplete"):
            if (ev is None or ev.get("status") not in ("supported", "reproduced")
                    or prov is None or effective_trust not in _STRONG_TRUST):
                raise ValueError(
                    "a bypassed/incomplete guard requires compatible strong evidence and provenance")
            if ev.get("provenance_id") != provenance_id:
                raise ValueError("guard evidence and provenance must describe the same attestation")
        now = time.time()
        with self.store.transaction():
            cur = self.conn.execute(
                "INSERT INTO guards(snapshot_id,in_vid,out_vid,flow_edge_id,guard_symbol,path,"
                "start_line,end_line,condition,transformation,kind,limits,status,provenance_id,"
                "evidence_id,version,valid_from,valid_to,created_ts,meta_json) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,NULL,?,'{}')",
                (snapshot_id, in_vid, out_vid, flow_edge_id, guard_symbol or None, path or None,
                 start_line or None, end_line or None, condition or None, transformation or None,
                 kind, limits or None, status, provenance_id, evidence_id, now, now))
            gid = cur.lastrowid
            self.store.add_audit("add_guard", "guards", gid, actor=self.actor,
                                 session=self.session, new_state=status)
        return gid

    def _edge_is_guard_blocked(self, flow_edge_id: int,
                               snapshot_id: Optional[int] = None) -> bool:
        """An edge is blocked by a guard iff it has an ACTIVE guard and no
        bypassed/incomplete guard (which would show taint still flows). The
        optional snapshot filter is defense in depth against a cross-snapshot
        guard reattaching to this edge."""
        if snapshot_id is None:
            rows = self.conn.execute(
                "SELECT status FROM guards WHERE flow_edge_id=? AND valid_to IS NULL",
                (flow_edge_id,)).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT status FROM guards WHERE flow_edge_id=? AND snapshot_id=? "
                "AND valid_to IS NULL", (flow_edge_id, snapshot_id)).fetchall()
        if not rows:
            return False
        statuses = {r["status"] for r in rows}
        if statuses & {"bypassed", "incomplete"}:
            return False                      # separate evidence shows the guard is defeated/partial
        return "active" in statuses

    # ---- evidence -------------------------------------------------------- #
    def _gate_evidence_status(self, status: str, trust: str,
                              has_provenance: bool = False) -> str:
        """Untrusted/weak provenance can never independently reach a strong status.
        'reproduced' needs strong trust; 'supported' needs better than target_derived."""
        rank = _trust_rank(trust)
        if status in ("supported", "reproduced") and not has_provenance:
            return "observed"
        if status == "reproduced" and trust not in _STRONG_TRUST:
            status = "observed"
        if status == "supported" and rank < _TRUST_RANK["agent_asserted"]:
            status = "observed"
        return status

    def add_evidence(self, snapshot_id: int, kind: str, raw=None,
                     projection: Optional[str] = None, status: str = "observed",
                     trust: str = "agent_asserted", provenance_id: Optional[int] = None,
                     obs_id: Optional[int] = None, value_identity_id: Optional[int] = None,
                     source_ref_id: Optional[int] = None, flow_edge_id: Optional[int] = None,
                     validation_run_id: Optional[int] = None,
                     media_type: str = "text/plain") -> int:
        """Record an evidence item. Raw bytes/text are preserved verbatim as an
        immutable artifact; a bounded, sanitized, secret-redacted projection is
        stored for prompts/search. Referenced ids must exist. The status is gated by
        trust so untrusted evidence cannot self-promote to supported/reproduced."""
        self._require_snapshot(snapshot_id)
        if status not in EVIDENCE_STATUSES:
            raise ValueError(f"invalid evidence status: {status}")
        if obs_id is not None and self.store.observation(obs_id) is None:
            raise ValueError(f"unknown observation id {obs_id}")
        if value_identity_id is not None and self.get_value_identity(value_identity_id) is None:
            raise ValueError(f"unknown value identity {value_identity_id}")
        self._require_scoped("value_identities", value_identity_id, snapshot_id,
                             "value identity") if value_identity_id is not None else None
        self._require_scoped("source_refs", source_ref_id, snapshot_id,
                             "source reference") if source_ref_id is not None else None
        self._require_scoped("flow_edges", flow_edge_id, snapshot_id,
                             "flow edge") if flow_edge_id is not None else None
        self._require_scoped("validation_runs", validation_run_id, snapshot_id,
                             "validation run") if validation_run_id is not None else None
        trust, prov = self._effective_trust(snapshot_id, trust, provenance_id)
        status = self._gate_evidence_status(status, trust, has_provenance=prov is not None)

        art_id, truncated = None, 0
        display_text = projection
        if raw is not None:
            raw_bytes = raw.encode("utf-8") if isinstance(raw, str) else bytes(raw)
            if len(raw_bytes) > _MAX_ARTIFACT_BYTES:
                raise ValueError(
                    f"artifact exceeds maximum size of {_MAX_ARTIFACT_BYTES} bytes")
            info = self.store.put_artifact(raw, media_type=media_type,
                                           producing_run=f"evidence:{kind}")
            art_id = info["id"]
            if display_text is None:
                display_text = raw_bytes.decode("utf-8", "replace")
        # Always sanitize + secret-redact the final projection, including a caller-
        # supplied projection accompanying raw evidence.
        if display_text is not None:
            projection, tr = project_text(display_text, vault=self.vault)
            truncated = int(tr)
        now = time.time()
        with self.store.transaction():
            cur = self.conn.execute(
                "INSERT INTO evidence(snapshot_id,kind,value_identity_id,source_ref_id,"
                "flow_edge_id,artifact_id,projection,projection_truncated,status,trust,"
                "provenance_id,obs_id,version,valid_from,valid_to,created_ts,meta_json) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,NULL,?,'{}')",
                (snapshot_id, kind, value_identity_id, source_ref_id, flow_edge_id, art_id,
                 projection, truncated, status, trust, provenance_id, obs_id, now, now))
            eid = cur.lastrowid
            if validation_run_id is not None:
                self.conn.execute(
                    "UPDATE evidence SET validation_run_id=? WHERE id=?",
                    (validation_run_id, eid))
            if self.store.fts_enabled and projection:
                self.conn.execute(
                    "INSERT INTO evidence_fts(text,evidence_id,snapshot_id,kind) VALUES(?,?,?,?)",
                    (projection, eid, snapshot_id, kind))
            self.store.add_audit("add_evidence", "evidence", eid, actor=self.actor,
                                 session=self.session, new_state=status)
        return eid

    def get_evidence(self, evidence_id: int) -> Optional[dict]:
        r = self.conn.execute("SELECT * FROM evidence WHERE id=?", (evidence_id,)).fetchone()
        return dict(r) if r else None

    def set_evidence_status(self, evidence_id: int, status: str, trust: Optional[str] = None,
                            reason: str = "", expected_version: Optional[int] = None) -> str:
        ev = self.get_evidence(evidence_id)
        if ev is None:
            raise ValueError(f"unknown evidence {evidence_id}")
        if status not in EVIDENCE_STATUSES:
            raise ValueError(f"invalid evidence status: {status}")
        if expected_version is not None and ev["version"] != expected_version:
            raise ValueError(
                f"version conflict for evidence {evidence_id}: expected {expected_version}, "
                f"found {ev['version']}")
        effective_trust, prov = self._effective_trust(
            ev["snapshot_id"], trust or ev["trust"], ev["provenance_id"])
        status = self._gate_evidence_status(
            status, effective_trust, has_provenance=prov is not None)
        new_version = (ev["version"] or 1) + 1
        with self.store.transaction():
            self.conn.execute(
                "UPDATE evidence SET status=?,trust=?,version=? WHERE id=?",
                (status, effective_trust, new_version, evidence_id))
            # keep the text index in sync: a rejected/stale item must not keep
            # surfacing as a live free-text hit (it remains findable by status).
            if self.store.fts_enabled:
                if status in ("rejected", "stale"):
                    self.conn.execute("DELETE FROM evidence_fts WHERE evidence_id=?", (evidence_id,))
                elif ev["status"] in ("rejected", "stale") and ev["projection"]:
                    self.conn.execute(
                        "INSERT INTO evidence_fts(text,evidence_id,snapshot_id,kind) VALUES(?,?,?,?)",
                        (ev["projection"], evidence_id, ev["snapshot_id"], ev["kind"]))
            self.store.add_audit("set_evidence_status", "evidence", evidence_id,
                                 actor=self.actor, session=self.session,
                                 old_state=ev["status"], new_state=status, rationale=reason)
            self._record_lifecycle("evidence", evidence_id, new_version, ev["status"],
                                   status, reason, [evidence_id])
        return status

    # ---- hypotheses ------------------------------------------------------ #
    def add_hypothesis(self, snapshot_id: Optional[int], statement: str, invariant: str = "",
                       scope: str = "", status: str = "open", next_action: str = "",
                       trust: str = "agent_asserted", provenance_id: Optional[int] = None) -> int:
        if status not in HYPOTHESIS_STATUSES:
            raise ValueError(f"invalid hypothesis status: {status}")
        if not statement.strip():
            raise ValueError("hypothesis statement is required")
        if snapshot_id is not None:
            self._require_snapshot(snapshot_id)
            trust, prov = self._effective_trust(snapshot_id, trust, provenance_id)
            if status == "supported" and (prov is None or trust not in _STRONG_TRUST):
                status = "open"
        now = time.time()
        with self.store.transaction():
            cur = self.conn.execute(
                "INSERT INTO hypotheses(snapshot_id,statement,invariant,scope,status,"
                "next_action,trust,provenance_id,version,valid_from,valid_to,created_ts,"
                "meta_json) VALUES(?,?,?,?,?,?,?,?,1,?,NULL,?,'{}')",
                (snapshot_id, statement, invariant or None, scope or None, status,
                 next_action or None, trust, provenance_id, now, now))
            hid = cur.lastrowid
            self.store.add_audit("add_hypothesis", "hypotheses", hid, actor=self.actor,
                                 session=self.session, new_state=status)
        return hid

    def get_hypothesis(self, hypothesis_id: int) -> Optional[dict]:
        r = self.conn.execute("SELECT * FROM hypotheses WHERE id=?", (hypothesis_id,)).fetchone()
        return dict(r) if r else None

    def link_evidence(self, hypothesis_id: int, relation: str, evidence_id: Optional[int] = None,
                      flow_edge_id: Optional[int] = None, validation_run_id: Optional[int] = None,
                      actor: str = "", rationale: str = "") -> int:
        """Link evidence/a flow edge/a validation run to a hypothesis with a typed
        relation (supports|contradicts|tests|requires|crosses_boundary). The target
        must exist — a link can never cite a nonexistent record."""
        if self.get_hypothesis(hypothesis_id) is None:
            raise ValueError(f"unknown hypothesis {hypothesis_id}")
        hyp = self.get_hypothesis(hypothesis_id)
        if relation not in ("supports", "contradicts", "tests", "requires", "crosses_boundary"):
            raise ValueError(f"invalid relation: {relation}")
        if evidence_id is not None and self.get_evidence(evidence_id) is None:
            raise ValueError(f"unknown evidence {evidence_id}")
        if flow_edge_id is not None and self.conn.execute(
                "SELECT 1 FROM flow_edges WHERE id=?", (flow_edge_id,)).fetchone() is None:
            raise ValueError(f"unknown flow edge {flow_edge_id}")
        if validation_run_id is not None and self.conn.execute(
                "SELECT 1 FROM validation_runs WHERE id=?", (validation_run_id,)).fetchone() is None:
            raise ValueError(f"unknown validation run {validation_run_id}")
        if evidence_id is None and flow_edge_id is None and validation_run_id is None:
            raise ValueError("link_evidence needs an evidence, flow_edge, or validation_run id")
        if hyp["snapshot_id"] is not None:
            if evidence_id is not None:
                self._require_scoped("evidence", evidence_id, hyp["snapshot_id"], "evidence")
            if flow_edge_id is not None:
                self._require_scoped("flow_edges", flow_edge_id, hyp["snapshot_id"], "flow edge")
            if validation_run_id is not None:
                self._require_scoped("validation_runs", validation_run_id, hyp["snapshot_id"],
                                     "validation run")
        cur = self.conn.execute(
            "INSERT INTO hypothesis_evidence(hypothesis_id,evidence_id,flow_edge_id,"
            "validation_run_id,relation,actor,rationale,created_ts) VALUES(?,?,?,?,?,?,?,?)",
            (hypothesis_id, evidence_id, flow_edge_id, validation_run_id, relation,
             actor or self.actor, rationale or None, time.time()))
        return cur.lastrowid

    def counter_evidence(self, hypothesis_id: int) -> list[dict]:
        """Counter-evidence stays visible: all 'contradicts' links for a hypothesis."""
        rows = self.conn.execute(
            "SELECT * FROM hypothesis_evidence WHERE hypothesis_id=? AND relation='contradicts'",
            (hypothesis_id,)).fetchall()
        return [dict(r) for r in rows]

    def consensus_promote(self, hypothesis_id: int, evidence_ids: list,
                          rationale: str = "") -> dict:
        """Promote a hypothesis open -> supported ONLY when real, independent,
        acceptably-trusted evidence corroborates it. Consensus can establish at
        most 'supported' — never 'demonstrated'/'reproduced' (those require a
        validation run or strong direct evidence). Returns {promoted, status, reason}."""
        hyp = self.get_hypothesis(hypothesis_id)
        if hyp is None:
            raise ValueError(f"unknown hypothesis {hypothesis_id}")
        evs = []
        for eid in dict.fromkeys(evidence_ids):
            e = self.get_evidence(eid)
            if e is None:
                raise ValueError(f"unknown evidence {eid}")     # no fabricated consensus
            evs.append(e)
        # compatible snapshot/scope
        snaps = {e["snapshot_id"] for e in evs}
        if hyp["snapshot_id"] is not None:
            snaps.add(hyp["snapshot_id"])
        if len(snaps) != 1:
            return {"promoted": False, "status": hyp["status"],
                    "reason": "evidence spans incompatible snapshots/scopes"}
        acceptable = [e for e in evs if e["provenance_id"] is not None
                      and _trust_rank(e["trust"]) >= _TRUST_RANK["agent_asserted"]
                      and e["status"] in ("supported", "reproduced", "observed")
                      and e["valid_to"] is None]
        # Independence is evaluated only across acceptable evidence. Previously an
        # unrelated untrusted record could contribute the second actor.
        actors = set()
        for e in acceptable:
            r = self.conn.execute(
                "SELECT actor,tool,config_digest FROM provenance WHERE id=?",
                (e["provenance_id"],)).fetchone()
            if r is not None:
                actors.add((r["actor"], r["tool"], r["config_digest"]))
        if len(acceptable) < 2 or len(actors) < 2:
            return {"promoted": False, "status": hyp["status"],
                    "reason": "need >=2 acceptably-trusted evidence records from independent provenance"}
        with self.store.transaction():
            for e in evs:
                self.conn.execute(
                    "INSERT INTO hypothesis_evidence(hypothesis_id,evidence_id,relation,actor,"
                    "rationale,created_ts) VALUES(?,?,'supports',?,?,?)",
                    (hypothesis_id, e["id"], self.actor, rationale or "consensus", time.time()))
            new_version = (hyp["version"] or 1) + 1
            self.conn.execute(
                "UPDATE hypotheses SET status='supported',version=? WHERE id=?",
                (new_version, hypothesis_id))
            self.store.add_audit("consensus_promote", "hypotheses", hypothesis_id,
                                 actor=self.actor, session=self.session,
                                 old_state=hyp["status"], new_state="supported",
                                 rationale=rationale or "consensus")
            self._record_lifecycle("hypotheses", hypothesis_id, new_version, hyp["status"],
                                   "supported", rationale or "consensus",
                                   [e["id"] for e in acceptable])
        return {"promoted": True, "status": "supported", "reason": "independent corroboration"}

    # ---- validation runs ------------------------------------------------- #
    def add_validation_run(self, snapshot_id: Optional[int], kind: str = "test",
                           status: str = "not_run", hypothesis_id: Optional[int] = None,
                           build_manifest_digest: str = "", config_digest: str = "",
                           logs=None, repeat_summary: str = "",
                           provenance_id: Optional[int] = None) -> int:
        if status not in VALIDATION_STATUSES:
            raise ValueError(f"invalid validation status: {status}")
        if kind not in ("test", "build", "repro", "fuzz", "analysis"):
            raise ValueError(f"invalid validation kind: {kind}")
        if repeat_summary and repeat_summary not in (
                "observed_once", "repeatable", "intermittent", "not_reproduced"):
            raise ValueError(f"invalid repeat_summary: {repeat_summary}")
        if build_manifest_digest and not _HEX_DIGEST.fullmatch(build_manifest_digest):
            raise ValueError("build_manifest_digest must be a full SHA-256 hex digest")
        if config_digest and not _HEX_DIGEST.fullmatch(config_digest):
            raise ValueError("config_digest must be a full SHA-256 hex digest")
        prov = None
        if snapshot_id is not None:
            self._require_snapshot(snapshot_id)
            _trust, prov = self._effective_trust(
                snapshot_id, "tool_verified" if provenance_id else "agent_asserted",
                provenance_id)
        if hypothesis_id is not None:
            hyp = self.get_hypothesis(hypothesis_id)
            if hyp is None:
                raise ValueError(f"unknown hypothesis {hypothesis_id}")
            if snapshot_id is None or hyp["snapshot_id"] != snapshot_id:
                raise ValueError("validation run and hypothesis must use a single snapshot")
        # Passed is a strong assertion. Without compatible strong provenance it is
        # retained as an inconclusive caller report, never as validated fact.
        if status == "passed" and (prov is None or prov.get("trust") not in _STRONG_TRUST):
            status = "inconclusive"
        art_id = None
        if logs is not None:
            size = len(logs.encode("utf-8") if isinstance(logs, str) else bytes(logs))
            if size > _MAX_ARTIFACT_BYTES:
                raise ValueError(
                    f"validation logs exceed maximum size of {_MAX_ARTIFACT_BYTES} bytes")
            art_id = self.store.put_artifact(logs, media_type="text/plain",
                                             producing_run=f"validation:{kind}")["id"]
        now = time.time()
        with self.store.transaction():
            cur = self.conn.execute(
                "INSERT INTO validation_runs(snapshot_id,hypothesis_id,kind,status,"
                "build_manifest_digest,config_digest,artifact_id,repeat_summary,provenance_id,"
                "created_ts,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?,'{}')",
                (snapshot_id, hypothesis_id, kind, status, build_manifest_digest or None,
                 config_digest or None, art_id, repeat_summary or None, provenance_id, now))
            vid = cur.lastrowid
            self.store.add_audit("add_validation_run", "validation_runs", vid,
                                 actor=self.actor, session=self.session, new_state=status)
        return vid

    # ---- findings -------------------------------------------------------- #
    def _impact_is_backed(self, snapshot_id: Optional[int], hypothesis_id: Optional[int]) -> bool:
        """True iff a 'demonstrated' impact is actually supported by evidence: a
        demonstrated chain linked to THIS hypothesis, or a repeatable, attested
        validation run under the same snapshot/configuration."""
        if snapshot_id is None or hypothesis_id is None:
            return False
        hyp = self.get_hypothesis(hypothesis_id)
        if hyp is None or hyp["snapshot_id"] != snapshot_id:
            return False
        linked_edges = {r["flow_edge_id"] for r in self.conn.execute(
            "SELECT flow_edge_id FROM hypothesis_evidence WHERE hypothesis_id=? "
            "AND relation='supports' AND flow_edge_id IS NOT NULL",
            (hypothesis_id,)).fetchall()}
        for chain in self.chains(snapshot_id):
            step_ids = {s["flow_edge_id"] for s in chain["steps"]}
            if (chain["status"] == "demonstrated" and step_ids
                    and step_ids.issubset(linked_edges)
                    and not self.chain_boundary_gaps(snapshot_id, chain["steps"])):
                return True
        rows = self.conn.execute(
            "SELECT vr.*,p.trust AS provenance_trust FROM validation_runs vr "
            "LEFT JOIN provenance p ON p.id=vr.provenance_id "
            "WHERE vr.hypothesis_id=? AND vr.snapshot_id=? AND vr.status='passed'",
            (hypothesis_id, snapshot_id)).fetchall()
        for row in rows:
            if (row["provenance_trust"] in _STRONG_TRUST
                    and row["build_manifest_digest"] and row["config_digest"]
                    and row["repeat_summary"] == "repeatable"):
                return True
        return False

    def _finding_fingerprint(self, snapshot_id, symbols, sink_class, root_cause, title,
                             hypothesis_id) -> str:
        """A stable defect fingerprint from the AFFECTED SYMBOLS + sink class + a
        normalized root cause — not the report title. If no symbols are supplied,
        derive them from the finding's hypothesis (the symbols on its linked flow
        edges / value identities), so two reports of the same underlying defect
        collapse even when their titles differ."""
        syms = set(symbols or [])
        if not syms and hypothesis_id is not None:
            for r in self.conn.execute(
                    "SELECT DISTINCT v.symbol_id AS s FROM hypothesis_evidence he "
                    "JOIN flow_edges fe ON fe.id=he.flow_edge_id "
                    "JOIN value_identities v ON v.id IN (fe.src_vid, fe.dst_vid) "
                    "WHERE he.hypothesis_id=? AND v.symbol_id IS NOT NULL", (hypothesis_id,)).fetchall():
                if r["s"]:
                    syms.add(r["s"])
        norm_rc = " ".join((root_cause or title or "").lower().split())
        return _digest(str(snapshot_id), "|".join(sorted(syms)), sink_class or "", norm_rc)

    def add_finding(self, snapshot_id: Optional[int], title: str, root_cause: str = "",
                    severity: str = "", status: str = "draft", impact_state: str = "unproven",
                    hypothesis_id: Optional[int] = None, fingerprint: str = "",
                    symbols: Optional[list] = None, sink_class: str = "",
                    provenance_id: Optional[int] = None) -> int:
        """Record a finding. Deduped on a defect FINGERPRINT (affected symbols + sink
        class + normalized root cause), not the report title. impact_state is
        separate from the finding's review lifecycle and defaults to 'unproven'."""
        if status not in FINDING_STATUSES:
            raise ValueError(f"invalid finding status: {status}")
        if impact_state not in ("unproven", "suspected", "demonstrated"):
            raise ValueError(f"invalid impact_state: {impact_state}")
        if snapshot_id is not None:
            self._require_snapshot(snapshot_id)
        if hypothesis_id is not None:
            hyp = self.get_hypothesis(hypothesis_id)
            if hyp is None:
                raise ValueError(f"unknown hypothesis {hypothesis_id}")
            if hyp["snapshot_id"] != snapshot_id:
                raise ValueError("finding and hypothesis must use a single snapshot")
        if provenance_id is not None:
            if snapshot_id is None:
                raise ValueError("a provenance-backed finding requires a snapshot")
            self._require_scoped("provenance", provenance_id, snapshot_id, "provenance")
        # gate: 'demonstrated' impact requires real backing evidence — a demonstrated
        # chain in this snapshot or a passed validation on the finding's hypothesis.
        # Without it, impact is at most 'suspected' (an assertion is not a demonstration).
        if impact_state == "demonstrated" and not self._impact_is_backed(snapshot_id, hypothesis_id):
            impact_state = "suspected"
        fp = fingerprint or self._finding_fingerprint(snapshot_id, symbols, sink_class,
                                                      root_cause, title, hypothesis_id)
        existing = self.conn.execute("SELECT id FROM findings WHERE fingerprint=?", (fp,)).fetchone()
        if existing is not None:
            return existing["id"]
        now = time.time()
        with self.store.transaction():
            cur = self.conn.execute(
                "INSERT INTO findings(snapshot_id,fingerprint,title,root_cause,status,severity,"
                "impact_state,hypothesis_id,provenance_id,version,valid_from,valid_to,created_ts,"
                "meta_json) VALUES(?,?,?,?,?,?,?,?,?,1,?,NULL,?,'{}')",
                (snapshot_id, fp, title, root_cause or None, status, severity or None,
                 impact_state, hypothesis_id, provenance_id, now, now))
            fid = cur.lastrowid
            self.store.add_audit("add_finding", "findings", fid, actor=self.actor,
                                 session=self.session, new_state=f"{status}/{impact_state}")
        return fid

    # ---- append-only reclassification ----------------------------------- #
    def reclassify_sink(self, vid_id: int, new_sink_type: str, reason: str = "") -> int:
        """Append-only reclassification of a sink's type. Closes the old value
        identity version, creates a new version with the new sink_type, and
        re-points the current flow edges onto it as FRESH 'hypothesis' edges — the
        prior status/trust/evidence are NOT carried over, so a reclassified sink
        must be re-established under its new semantics. Historical evidence is
        preserved (closed + superseded, never repointed); any dependent
        'demonstrated' finding is downgraded to 'suspected'; an audit event is
        recorded. Returns the new vid."""
        v = self.get_value_identity(vid_id)
        if v is None:
            raise ValueError(f"unknown value identity {vid_id}")
        if v["role"] != "sink":
            raise ValueError("reclassify_sink applies only to a sink value identity")
        if v["valid_to"] is not None:
            raise ValueError("value identity is not the current version")
        now = time.time()
        with self.store.transaction():
            self.conn.execute("UPDATE value_identities SET valid_to=? WHERE id=?", (now, vid_id))
            cur = self.conn.execute(
                "INSERT INTO value_identities(snapshot_id,vid_key,path,symbol_id,value_name,"
                "start_line,end_line,role,sink_type,language,tool,run_id,source_ref_id,"
                "provenance_id,status,version,valid_from,valid_to,created_ts,meta_json) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,'{}')",
                (v["snapshot_id"], v["vid_key"], v["path"], v["symbol_id"], v["value_name"],
                 v["start_line"], v["end_line"], v["role"], new_sink_type, v["language"],
                 v["tool"], v["run_id"], v["source_ref_id"], v["provenance_id"], v["status"],
                 (v["version"] or 1) + 1, now, now))
            new_vid = cur.lastrowid
            # re-point current flow edges that touch the old vid onto the new version
            edges = self.conn.execute(
                "SELECT * FROM flow_edges WHERE valid_to IS NULL AND (src_vid=? OR dst_vid=?)",
                (vid_id, vid_id)).fetchall()
            for e in edges:
                self.conn.execute("UPDATE flow_edges SET valid_to=? WHERE id=?", (now, e["id"]))
                src = new_vid if e["src_vid"] == vid_id else e["src_vid"]
                dst = new_vid if e["dst_vid"] == vid_id else e["dst_vid"]
                ne = self.conn.execute(
                    "INSERT INTO flow_edges(snapshot_id,src_vid,dst_vid,kind,callsite_path,"
                    "callsite_line,caller_symbol,callee_symbol,arg_index,param_name,return_to,"
                    "field_id,status,confidence,trust,provenance_id,evidence_id,version,"
                    "valid_from,valid_to,created_ts,meta_json) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,'{}')",
                    (e["snapshot_id"], src, dst, e["kind"], e["callsite_path"], e["callsite_line"],
                     e["caller_symbol"], e["callee_symbol"], e["arg_index"], e["param_name"],
                     e["return_to"], e["field_id"], "hypothesis", e["confidence"], "agent_asserted",
                     None, None, (e["version"] or 1) + 1, now, now))
                self.conn.execute("UPDATE flow_edges SET superseded_by=? WHERE id=?",
                                  (ne.lastrowid, e["id"]))
                # Never rewrite which transition historical evidence supported.
                # Close the old evidence version and create a superseding version
                # attached to the new edge.
                old_evidence = self.conn.execute(
                    "SELECT * FROM evidence WHERE flow_edge_id=? AND valid_to IS NULL",
                    (e["id"],)).fetchall()
                for old_ev in old_evidence:
                    stale_version = (old_ev["version"] or 1) + 1
                    self.conn.execute(
                        "UPDATE evidence SET valid_to=?,status='stale',stale_reason=?,version=? "
                        "WHERE id=?",
                        (now, "flow edge superseded by sink reclassification", stale_version,
                         old_ev["id"]))
                    if self.store.fts_enabled:
                        self.conn.execute(
                            "DELETE FROM evidence_fts WHERE evidence_id=?", (old_ev["id"],))
                    new_ev = self.conn.execute(
                        "INSERT INTO evidence(snapshot_id,kind,value_identity_id,source_ref_id,"
                        "flow_edge_id,artifact_id,projection,projection_truncated,status,trust,"
                        "provenance_id,obs_id,stale_reason,version,valid_from,valid_to,created_ts,"
                        "meta_json,validation_run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)",
                        (old_ev["snapshot_id"], old_ev["kind"], old_ev["value_identity_id"],
                         old_ev["source_ref_id"], ne.lastrowid, old_ev["artifact_id"],
                         old_ev["projection"], old_ev["projection_truncated"], old_ev["status"],
                         old_ev["trust"], old_ev["provenance_id"], old_ev["obs_id"], None,
                         (old_ev["version"] or 1) + 1, now, now, old_ev["meta_json"],
                         old_ev["validation_run_id"])).lastrowid
                    self.conn.execute(
                        "UPDATE evidence SET superseded_by=? WHERE id=?",
                        (new_ev, old_ev["id"]))
                    if self.store.fts_enabled and old_ev["projection"]:
                        self.conn.execute(
                            "INSERT INTO evidence_fts(text,evidence_id,snapshot_id,kind) "
                            "VALUES(?,?,?,?)", (old_ev["projection"], new_ev,
                                                old_ev["snapshot_id"], old_ev["kind"]))
                    self._record_lifecycle(
                        "evidence", old_ev["id"], stale_version,
                        old_ev["status"], "stale",
                        "flow edge superseded by sink reclassification", [old_ev["id"]])
            # stale any materialized research chains that referenced the closed edges
            self.conn.execute(
                "UPDATE research_chains SET status='stale' WHERE id IN ("
                "SELECT DISTINCT chain_id FROM research_chain_steps WHERE flow_edge_id IN ("
                "SELECT id FROM flow_edges WHERE valid_to=?))", (now,))
            # A reclassified sink invalidates any 'demonstrated' finding whose impact
            # rested on the pre-reclassification edges; downgrade it to 'suspected'.
            old_edge_ids = [e["id"] for e in edges]
            if old_edge_ids:
                marks = ",".join("?" * len(old_edge_ids))
                hyp_ids = {r["hypothesis_id"] for r in self.conn.execute(
                    f"SELECT DISTINCT hypothesis_id FROM hypothesis_evidence "
                    f"WHERE flow_edge_id IN ({marks})", tuple(old_edge_ids)).fetchall()
                    if r["hypothesis_id"] is not None}
                for hid in hyp_ids:
                    if self._impact_is_backed(v["snapshot_id"], hid):
                        continue
                    for fr in self.conn.execute(
                            "SELECT id,version FROM findings WHERE hypothesis_id=? "
                            "AND impact_state='demonstrated'", (hid,)).fetchall():
                        fver = (fr["version"] or 1) + 1
                        self.conn.execute(
                            "UPDATE findings SET impact_state='suspected',version=? WHERE id=?",
                            (fver, fr["id"]))
                        self.store.add_audit("stale_finding_impact", "findings", fr["id"],
                                             actor=self.actor, session=self.session,
                                             old_state="demonstrated", new_state="suspected",
                                             rationale="sink reclassified")
                        self._record_lifecycle("findings", fr["id"], fver, "demonstrated",
                                               "suspected", "sink reclassified", [])
            self.store.add_audit("reclassify_sink", "value_identities", vid_id, actor=self.actor,
                                 session=self.session, old_state=v["sink_type"] or "",
                                 new_state=new_sink_type, rationale=reason)
        return new_vid

    # ---- cross-revision staleness --------------------------------------- #
    def evidence_for(self, snapshot_id: int, include_historical: bool = False,
                     limit: int = 200) -> dict:
        """Current evidence for a snapshot. Evidence from OTHER revisions is never
        returned as current: with include_historical=True it is returned in a
        separate list, each row labelled stale + revision_mismatch. Both lists are
        bounded by `limit` (no unbounded scan)."""
        self._require_snapshot(snapshot_id)
        cur = [dict(r) for r in self.conn.execute(
            "SELECT * FROM evidence WHERE snapshot_id=? AND valid_to IS NULL ORDER BY id LIMIT ?",
            (snapshot_id, limit)).fetchall()]
        for e in cur:
            e["stale"], e["revision_mismatch"] = False, False
        result = {"current": cur, "historical": []}
        if include_historical:
            hist = [dict(r) for r in self.conn.execute(
                "SELECT * FROM evidence WHERE (snapshot_id IS NULL OR snapshot_id!=?) "
                "AND valid_to IS NULL ORDER BY id LIMIT ?", (snapshot_id, limit)).fetchall()]
            for e in hist:
                e["stale"], e["revision_mismatch"] = True, True
                e["stale_reason"] = e.get("stale_reason") or "recorded against a different revision"
            result["historical"] = hist
        return result

    _DEPENDENCY_KINDS = {
        "path", "header", "generated_input", "build_flag", "analysis_model",
        "boundary_model", "config",
    }
    _DEPENDENCY_TARGETS = {"value_identities", "flow_edges", "evidence", "hypotheses"}

    def add_dependency(self, snapshot_id: int, input_kind: str, input_key: str,
                       dependent_table: str, dependent_id: int) -> int:
        """Record why a claim exists so changes beyond its direct source path can
        invalidate it. The target set is intentionally small and stateful: graph
        nodes/edges, evidence, and hypotheses."""
        self._require_snapshot(snapshot_id)
        if input_kind not in self._DEPENDENCY_KINDS:
            raise ValueError(f"invalid dependency input kind: {input_kind}")
        if not input_key or len(input_key) > 4096:
            raise ValueError("dependency input_key must contain 1-4096 characters")
        if input_kind in ("path", "header", "generated_input"):
            self._validate_repo_path(input_key)
        if dependent_table not in self._DEPENDENCY_TARGETS:
            raise ValueError(f"invalid dependency target table: {dependent_table}")
        self._require_scoped(dependent_table, dependent_id, snapshot_id,
                             "dependency target", nullable=False)
        with self.store.transaction():
            self.conn.execute(
                "INSERT OR IGNORE INTO research_dependencies(snapshot_id,input_kind,input_key,"
                "dependent_table,dependent_id,created_ts) VALUES(?,?,?,?,?,?)",
                (snapshot_id, input_kind, input_key, dependent_table, dependent_id, time.time()))
            row = self.conn.execute(
                "SELECT id FROM research_dependencies WHERE snapshot_id=? AND input_kind=? "
                "AND input_key=? AND dependent_table=? AND dependent_id=?",
                (snapshot_id, input_kind, input_key, dependent_table, dependent_id)).fetchone()
        return row["id"]

    def invalidate_dependency_inputs(self, snapshot_id: int, changes,
                                     reason: str = "research input changed",
                                     new_snapshot_id: Optional[int] = None) -> dict:
        """Invalidate the transitive claim set for changed research inputs.

        ``changes`` accepts ``{kind: [key, ...]}`` or a list of ``(kind, key)``
        pairs. Exact source paths also discover their identities/source references
        without requiring dependency rows. All state changes are versioned and
        lifecycle-audited; history is retained.
        """
        self._require_snapshot(snapshot_id)
        if new_snapshot_id is not None:
            newer = self.get_snapshot(new_snapshot_id)
            older = self.get_snapshot(snapshot_id)
            if newer is None:
                raise ValueError(f"unknown snapshot {new_snapshot_id}")
            if newer["repo_id"] != older["repo_id"]:
                raise ValueError("superseding snapshot must belong to the same repository")
        raw_pairs = []
        if isinstance(changes, dict):
            for kind, keys in changes.items():
                keys = [keys] if isinstance(keys, str) else list(keys or [])
                raw_pairs.extend((kind, key) for key in keys)
        else:
            for item in changes or []:
                if isinstance(item, dict):
                    raw_pairs.append((item.get("kind"), item.get("key")))
                else:
                    if not isinstance(item, (list, tuple)) or len(item) != 2:
                        raise ValueError("each dependency change must contain kind and key")
                    raw_pairs.append((item[0], item[1]))
        if not raw_pairs:
            raise ValueError("at least one dependency change is required")
        if len(raw_pairs) > 10_000:
            raise ValueError("too many dependency changes (maximum 10000)")
        pairs, seen = [], set()
        for kind, key in raw_pairs:
            if kind not in self._DEPENDENCY_KINDS:
                raise ValueError(f"invalid dependency input kind: {kind}")
            if not isinstance(key, str) or not key or len(key) > 4096:
                raise ValueError("dependency keys must contain 1-4096 characters")
            if kind in ("path", "header", "generated_input"):
                self._validate_repo_path(key)
            if (kind, key) not in seen:
                seen.add((kind, key))
                pairs.append((kind, key))

        targets = {name: set() for name in self._DEPENDENCY_TARGETS}
        for kind, key in pairs:
            for row in self.conn.execute(
                    "SELECT dependent_table,dependent_id FROM research_dependencies "
                    "WHERE snapshot_id=? AND input_kind=? AND input_key=?",
                    (snapshot_id, kind, key)).fetchall():
                targets[row["dependent_table"]].add(row["dependent_id"])

        paths = {key for kind, key in pairs if kind == "path"}
        if paths:
            marks = ",".join("?" * len(paths))
            targets["value_identities"].update(r["id"] for r in self.conn.execute(
                f"SELECT id FROM value_identities WHERE snapshot_id=? AND valid_to IS NULL "
                f"AND path IN ({marks})", (snapshot_id, *paths)).fetchall())
            targets["evidence"].update(r["id"] for r in self.conn.execute(
                f"SELECT e.id FROM evidence e JOIN source_refs s ON s.id=e.source_ref_id "
                f"WHERE e.snapshot_id=? AND e.valid_to IS NULL AND s.path IN ({marks})",
                (snapshot_id, *paths)).fetchall())

        vids = targets["value_identities"]
        if vids:
            marks = ",".join("?" * len(vids))
            targets["flow_edges"].update(r["id"] for r in self.conn.execute(
                f"SELECT id FROM flow_edges WHERE snapshot_id=? AND valid_to IS NULL "
                f"AND (src_vid IN ({marks}) OR dst_vid IN ({marks}))",
                (snapshot_id, *vids, *vids)).fetchall())
            targets["evidence"].update(r["id"] for r in self.conn.execute(
                f"SELECT id FROM evidence WHERE snapshot_id=? AND valid_to IS NULL "
                f"AND value_identity_id IN ({marks})", (snapshot_id, *vids)).fetchall())
        edges = targets["flow_edges"]
        if edges:
            marks = ",".join("?" * len(edges))
            targets["evidence"].update(r["id"] for r in self.conn.execute(
                f"SELECT id FROM evidence WHERE snapshot_id=? AND valid_to IS NULL "
                f"AND (flow_edge_id IN ({marks}) OR id IN (SELECT evidence_id FROM flow_edges "
                f"WHERE id IN ({marks}) AND evidence_id IS NOT NULL))",
                (snapshot_id, *edges, *edges)).fetchall())

        evidence_ids = targets["evidence"]
        clauses, args = [], []
        if evidence_ids:
            marks = ",".join("?" * len(evidence_ids))
            clauses.append(f"he.evidence_id IN ({marks})")
            args.extend(evidence_ids)
        if edges:
            marks = ",".join("?" * len(edges))
            clauses.append(f"he.flow_edge_id IN ({marks})")
            args.extend(edges)
        if clauses:
            targets["hypotheses"].update(r["hid"] for r in self.conn.execute(
                "SELECT DISTINCT he.hypothesis_id AS hid FROM hypothesis_evidence he "
                "JOIN hypotheses h ON h.id=he.hypothesis_id WHERE he.relation='supports' "
                f"AND h.snapshot_id=? AND ({' OR '.join(clauses)})",
                (snapshot_id, *args)).fetchall())

        note = reason + (f" (superseded by snapshot {new_snapshot_id})" if new_snapshot_id else "")
        counts = {"identities": 0, "flow_edges": 0, "evidence": 0,
                  "hypotheses": 0, "findings": 0, "dependency_matches": sum(
                      len(v) for v in targets.values())}
        with self.store.transaction():
            for vid in sorted(vids):
                old = self.get_value_identity(vid)
                if old is None or old["status"] == "stale" or old["valid_to"] is not None:
                    continue
                version = (old["version"] or 1) + 1
                self.conn.execute(
                    "UPDATE value_identities SET status='stale',version=? WHERE id=?",
                    (version, vid))
                self.store.add_audit("stale_value_identity", "value_identities", vid,
                                     actor=self.actor, session=self.session,
                                     old_state=old["status"], new_state="stale", rationale=note)
                self._record_lifecycle("value_identities", vid, version, old["status"],
                                       "stale", note)
                counts["identities"] += 1

            now = time.time()
            for edge_id in sorted(edges):
                old = self.conn.execute(
                    "SELECT * FROM flow_edges WHERE id=?", (edge_id,)).fetchone()
                if old is None or old["valid_to"] is not None:
                    continue
                version = (old["version"] or 1) + 1
                self.conn.execute(
                    "UPDATE flow_edges SET valid_to=?,version=? WHERE id=?",
                    (now, version, edge_id))
                self.store.add_audit("stale_flow_edge", "flow_edges", edge_id,
                                     actor=self.actor, session=self.session,
                                     old_state=old["status"], new_state="stale", rationale=note)
                self._record_lifecycle("flow_edges", edge_id, version, old["status"],
                                       "stale", note)
                counts["flow_edges"] += 1

            staled_ev = []
            for eid in sorted(evidence_ids):
                old = self.get_evidence(eid)
                if old is None or old["status"] == "stale" or old["valid_to"] is not None:
                    continue
                version = (old["version"] or 1) + 1
                self.conn.execute(
                    "UPDATE evidence SET status='stale',stale_reason=?,version=? WHERE id=?",
                    (note, version, eid))
                if self.store.fts_enabled:
                    self.conn.execute("DELETE FROM evidence_fts WHERE evidence_id=?", (eid,))
                self.store.add_audit("stale_evidence", "evidence", eid, actor=self.actor,
                                     session=self.session, old_state=old["status"],
                                     new_state="stale", rationale=note)
                self._record_lifecycle("evidence", eid, version, old["status"],
                                       "stale", note, [eid])
                staled_ev.append(eid)
                counts["evidence"] += 1

            for hid in sorted(targets["hypotheses"]):
                old = self.get_hypothesis(hid)
                if old is None:
                    continue
                if old["status"] == "supported":
                    version = (old["version"] or 1) + 1
                    self.conn.execute(
                        "UPDATE hypotheses SET status='open',version=? WHERE id=?", (version, hid))
                    self.store.add_audit("stale_hypothesis", "hypotheses", hid,
                                         actor=self.actor, session=self.session,
                                         old_state="supported", new_state="open", rationale=note)
                    self._record_lifecycle("hypotheses", hid, version, "supported", "open",
                                           note, staled_ev)
                    counts["hypotheses"] += 1
                for finding in self.conn.execute(
                        "SELECT id,version FROM findings WHERE hypothesis_id=? "
                        "AND impact_state='demonstrated'", (hid,)).fetchall():
                    version = (finding["version"] or 1) + 1
                    self.conn.execute(
                        "UPDATE findings SET impact_state='suspected',version=? WHERE id=?",
                        (version, finding["id"]))
                    self.store.add_audit("stale_finding_impact", "findings", finding["id"],
                                         actor=self.actor, session=self.session,
                                         old_state="demonstrated", new_state="suspected",
                                         rationale=note)
                    self._record_lifecycle("findings", finding["id"], version,
                                           "demonstrated", "suspected", note, staled_ev)
                    counts["findings"] += 1
        return counts

    def invalidate_changed_paths(self, snapshot_id: int, changed_paths,
                                 reason: str = "source changed",
                                 new_snapshot_id: Optional[int] = None) -> dict:
        """Compatibility wrapper for exact, case-sensitive source-path changes."""
        paths = list(dict.fromkeys(changed_paths or []))
        if not paths:
            return {"identities": 0, "flow_edges": 0, "evidence": 0,
                    "hypotheses": 0, "findings": 0, "dependency_matches": 0}
        return self.invalidate_dependency_inputs(
            snapshot_id, {"path": paths}, reason=reason, new_snapshot_id=new_snapshot_id)

    # ---- disclosure-grade evidence bundle ------------------------------- #
    def export_bundle_to_dir(self, snapshot_id: int, dest_dir: str) -> dict:
        """Write a self-contained, independently reviewable evidence bundle for a
        snapshot: a manifest.json (snapshot identity, chains, findings, evidence
        metadata each with its artifact SHA-256) plus the referenced raw artifacts
        copied by digest into artifacts/. Each artifact is re-verified on copy, so a
        reviewer can confirm the evidence resolves to its bytes. Returns a summary."""
        snap = self.get_snapshot(snapshot_id)
        if snap is None:
            raise ValueError(f"unknown snapshot {snapshot_id}")
        if os.path.exists(dest_dir):
            raise ValueError("bundle destination already exists; refusing to merge or overwrite it")
        os.makedirs(os.path.join(dest_dir, "artifacts"), exist_ok=True)

        def rows(sql: str, args=(snapshot_id,)) -> list[dict]:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

        evidence = rows("SELECT * FROM evidence WHERE snapshot_id=? ORDER BY id")
        findings = rows(
            "SELECT id,snapshot_id,fingerprint,title,root_cause,status,impact_state,"
            "hypothesis_id,provenance_id,version,valid_from,valid_to,created_ts,meta_json "
            "FROM findings WHERE snapshot_id=? ORDER BY id")
        hypotheses = rows("SELECT * FROM hypotheses WHERE snapshot_id=? ORDER BY id")
        hypothesis_ids = [h["id"] for h in hypotheses]
        if hypothesis_ids:
            marks = ",".join("?" * len(hypothesis_ids))
            hypothesis_links = rows(
                f"SELECT * FROM hypothesis_evidence WHERE hypothesis_id IN ({marks}) ORDER BY id",
                tuple(hypothesis_ids))
        else:
            hypothesis_links = []
        records = {
            "source_refs": rows("SELECT * FROM source_refs WHERE snapshot_id=? ORDER BY id"),
            "provenance": rows("SELECT * FROM provenance WHERE snapshot_id=? ORDER BY id"),
            "value_identities": rows(
                "SELECT * FROM value_identities WHERE snapshot_id=? ORDER BY id"),
            "flow_edges": rows("SELECT * FROM flow_edges WHERE snapshot_id=? ORDER BY id"),
            "guards": rows("SELECT * FROM guards WHERE snapshot_id=? ORDER BY id"),
            "validation_runs": rows(
                "SELECT * FROM validation_runs WHERE snapshot_id=? ORDER BY id"),
            "code_symbols": rows("SELECT * FROM code_symbols WHERE snapshot_id=? ORDER BY id"),
            "symbol_relations": rows(
                "SELECT * FROM symbol_relations WHERE snapshot_id=? ORDER BY id"),
            "boundaries": rows("SELECT * FROM boundaries WHERE snapshot_id=? ORDER BY id"),
            "research_dependencies": rows(
                "SELECT * FROM research_dependencies WHERE snapshot_id=? ORDER BY id"),
        }
        relevant_ids = {
            "evidence": {r["id"] for r in evidence},
            "hypotheses": set(hypothesis_ids),
            "findings": {r["id"] for r in findings},
            **{name: {r["id"] for r in rs} for name, rs in records.items()
               if rs and "id" in rs[0]},
        }
        lifecycle = [dict(r) for r in self.conn.execute(
            "SELECT * FROM research_lifecycle_events ORDER BY id").fetchall()
            if r["entity_table"] in relevant_ids
            and r["entity_id"] in relevant_ids[r["entity_table"]]]
        audit = [dict(r) for r in self.conn.execute(
            "SELECT * FROM audit_events ORDER BY id").fetchall()
            if r["affected_table"] in relevant_ids
            and r["affected_id"] in relevant_ids[r["affected_table"]]]

        # Collect every artifact transitively referenced by the bundle. Missing or
        # corrupt artifacts are fatal; a partial bundle must never look complete.
        art_ids: set[int] = set()
        if snap.get("manifest_artifact_id"):
            art_ids.add(snap["manifest_artifact_id"])
        for r in evidence:
            if r.get("artifact_id"):
                art_ids.add(r["artifact_id"])
        for r in records["source_refs"]:
            if r.get("excerpt_artifact_id"):
                art_ids.add(r["excerpt_artifact_id"])
        for r in records["validation_runs"]:
            if r.get("artifact_id"):
                art_ids.add(r["artifact_id"])
        for r in records["provenance"]:
            if r.get("raw_artifact_id"):
                art_ids.add(r["raw_artifact_id"])
        artifacts, by_id = [], {}
        for aid in sorted(art_ids):
            row = self.store.artifact_row(aid)
            if row is None:
                raise ValueError(f"bundle is incomplete: missing artifact row {aid}")
            data = self.store.get_artifact_bytes(aid, verify=True)
            if data is None:
                raise ValueError(
                    f"bundle is incomplete: artifact {aid}/{row['sha256']} has no blob")
            path = os.path.join(dest_dir, "artifacts", row["sha256"])
            tmp = path + ".tmp"
            with open(tmp, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
            by_id[aid] = row["sha256"]
            artifacts.append({"artifact_id": aid, "sha256": row["sha256"],
                              "media_type": row["media_type"], "size": row["size"],
                              "retention": row["retention"]})
        for e in evidence:
            e["artifact_sha256"] = by_id.get(e.get("artifact_id"))

        disclosure_chains = self.chains(snapshot_id)
        for chain in disclosure_chains:
            chain.pop("severity", None)
        manifest = {
            "agentmem_bundle": 2, "created_ts": time.time(),
            "snapshot": {k: snap.get(k) for k in (
                "id", "snapshot_uid", "repo_id", "commit_id", "dirty", "patch_digest",
                "scope", "tree_digest", "manifest_artifact_id", "platform", "index_id")},
            "assessment": {"chains": disclosure_chains,
                           "internal_severity_omitted_from_disclosure": True},
            "findings": findings, "hypotheses": hypotheses,
            "hypothesis_evidence": hypothesis_links, "evidence": evidence,
            **records, "lifecycle_events": lifecycle, "audit_events": audit,
            "artifacts": artifacts,
        }
        encoded = json.dumps(
            manifest, indent=2, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
        manifest_digest = hashlib.sha256(encoded).hexdigest()
        manifest_path = os.path.join(dest_dir, "manifest.json")
        tmp_manifest = manifest_path + ".tmp"
        with open(tmp_manifest, "wb") as fh:
            fh.write(encoded)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_manifest, manifest_path)
        return {"dest_dir": dest_dir, "manifest_sha256": manifest_digest,
                "evidence": len(evidence), "findings": len(findings),
                "chains": len(manifest["assessment"]["chains"]),
                "artifacts": len(artifacts)}

    # ---- claim coverage + boundary composition -------------------------- #
    def claim_coverage(self, hypothesis_id: int) -> dict:
        """Classify a hypothesis's SUPPORTING links by evidence strength: 'direct'
        (source excerpt / static-analysis / dataflow / value-identity evidence),
        'dynamic' (a validation run, or crash/test evidence), or 'modeled' (only a
        flow edge, no backing evidence). Reports whether the hypothesis is
        uncovered (no supporting evidence at all) and whether counter-evidence
        exists. This is the "which statements have real evidence" view."""
        h = self.get_hypothesis(hypothesis_id)
        if h is None:
            raise ValueError(f"unknown hypothesis {hypothesis_id}")
        cov = {"direct": 0, "dynamic": 0, "modeled": 0}
        claims, has_counter = [], False
        for l in self.conn.execute(
                "SELECT * FROM hypothesis_evidence WHERE hypothesis_id=?", (hypothesis_id,)).fetchall():
            rel = l["relation"]
            if rel == "contradicts":
                has_counter = True
            kind = "modeled"
            if l["validation_run_id"] is not None:
                kind = "dynamic"
            elif l["evidence_id"] is not None:
                e = self.get_evidence(l["evidence_id"])
                ek = (e or {}).get("kind") or ""
                if ek in ("crash", "test"):
                    kind = "dynamic"
                elif ek in ("source_excerpt", "static_analysis", "dataflow") \
                        or (e and (e["source_ref_id"] or e["value_identity_id"])):
                    kind = "direct"
                else:
                    kind = "modeled"
            elif l["flow_edge_id"] is not None:
                kind = "modeled"
            if rel in ("supports", "tests", "requires"):
                cov[kind] += 1
            claims.append({"relation": rel, "kind": kind, "evidence_id": l["evidence_id"],
                           "flow_edge_id": l["flow_edge_id"], "validation_run_id": l["validation_run_id"]})
        return {"hypothesis_id": hypothesis_id, "status": h["status"], "claims": claims,
                "coverage": cov, "uncovered": sum(cov.values()) == 0,
                "has_counter_evidence": has_counter}

    def chain_boundary_gaps(self, snapshot_id: int, steps: list) -> list:
        """Trust/process-boundary composition check: consecutive chain steps whose
        symbols sit in DIFFERENT trust domains (from code_symbols) with no explicit
        'crosses_boundary' symbol relation recorded between them. Individually
        demonstrated transitions can still be incompatible when composed — a
        boundary crossing must be shown, not assumed."""
        if not steps:
            return []
        vid_seq = [steps[0]["src_vid"]] + [s["dst_vid"] for s in steps]
        syms, doms = {}, {}
        for vid in set(vid_seq):
            v = self.get_value_identity(vid)
            sym = v.get("symbol_id") if v else None
            syms[vid] = sym
            doms[vid] = None
            if sym:
                r = self.conn.execute(
                    "SELECT trust_domain FROM code_symbols WHERE snapshot_id=? AND symbol_id=?",
                    (snapshot_id, sym)).fetchone()
                doms[vid] = r["trust_domain"] if r else None
        gaps = []
        for i in range(len(vid_seq) - 1):
            a, b = vid_seq[i], vid_seq[i + 1]
            da, db = doms.get(a), doms.get(b)
            if not da or not db:
                gaps.append({"from_domain": da, "to_domain": db,
                             "from_symbol": syms[a], "to_symbol": syms[b],
                             "reason": "unknown_trust_domain"})
            elif da != db:
                covered = self.conn.execute(
                    "SELECT 1 FROM symbol_relations sr "
                    "JOIN evidence e ON e.id=sr.evidence_id "
                    "JOIN provenance p ON p.id=sr.provenance_id "
                    "WHERE sr.snapshot_id=? AND sr.relation='crosses_boundary' "
                    "AND sr.src_symbol=? AND sr.dst_symbol=? AND sr.boundary_id IS NOT NULL "
                    "AND sr.status='demonstrated' AND e.status='reproduced' "
                    "AND e.snapshot_id=? AND p.snapshot_id=? "
                    "AND p.trust IN ('tool_verified','human_verified')",
                    (snapshot_id, syms[a], syms[b], snapshot_id, snapshot_id)).fetchone()
                if not covered:
                    gaps.append({"from_domain": da, "to_domain": db,
                                 "from_symbol": syms[a], "to_symbol": syms[b],
                                 "reason": "unproven_boundary_crossing"})
        return gaps

    # ---- Firefox record model (external-analyzer evidence) -------------- #
    def add_boundary(self, snapshot_id: int, name: str, kind: str = "process",
                     description: str = "", status: str = "modeled",
                     provenance_id: Optional[int] = None,
                     evidence_id: Optional[int] = None) -> int:
        """Register a trust/process/sandbox/origin/principal boundary. Deduped on
        (snapshot, name). A defect in a sandboxed domain does not by itself cross a
        boundary — crossings must be recorded explicitly as evidence."""
        self._require_snapshot(snapshot_id)
        if kind not in ("process", "sandbox", "privilege", "origin", "principal", "ipc"):
            raise ValueError(f"invalid boundary kind: {kind}")
        if status not in ("modeled", "supported", "demonstrated", "rejected", "stale"):
            raise ValueError(f"invalid boundary status: {status}")
        ev = self._require_scoped("evidence", evidence_id, snapshot_id, "evidence") \
            if evidence_id is not None else None
        effective_trust, prov = self._effective_trust(
            snapshot_id, (ev or {}).get("trust") or "agent_asserted", provenance_id)
        if status == "demonstrated" and not (
                ev and ev.get("status") == "reproduced" and prov
                and effective_trust in _STRONG_TRUST
                and ev.get("provenance_id") == provenance_id):
            status = "supported" if ev and prov else "modeled"
        row = self.conn.execute(
            "SELECT id FROM boundaries WHERE snapshot_id=? AND name=?", (snapshot_id, name)).fetchone()
        if row is not None:
            return row["id"]
        with self.store.transaction():
            cur = self.conn.execute(
                "INSERT INTO boundaries(snapshot_id,name,kind,description,created_ts,meta_json,"
                "status,provenance_id,evidence_id) VALUES(?,?,?,?,?,'{}',?,?,?)",
                (snapshot_id, name, kind, description or None, time.time(), status,
                 provenance_id, evidence_id))
            bid = cur.lastrowid
            self.store.add_audit("add_boundary", "boundaries", bid, actor=self.actor,
                                 session=self.session, new_state=f"{kind}:{name}")
        return bid

    def register_symbol(self, snapshot_id: int, symbol_id: str, qualified_name: str = "",
                        language: str = "", kind: str = "function", path: str = "",
                        start_line: int = 0, end_line: int = 0, trust_domain: str = "",
                        provenance_id: Optional[int] = None) -> int:
        """Register a code symbol (C++/Rust/JS/WebIDL/IPDL) produced by an external
        index. Deduped on (snapshot, symbol_id); path is case-sensitive."""
        self._require_snapshot(snapshot_id)
        if not symbol_id:
            raise ValueError("symbol_id is required")
        if path:
            self._validate_repo_path(path)
        self._validate_range(start_line, end_line)
        if provenance_id is not None:
            self._require_scoped("provenance", provenance_id, snapshot_id, "provenance")
        row = self.conn.execute(
            "SELECT id FROM code_symbols WHERE snapshot_id=? AND symbol_id=?",
            (snapshot_id, symbol_id)).fetchone()
        if row is not None:
            return row["id"]
        with self.store.transaction():
            cur = self.conn.execute(
                "INSERT INTO code_symbols(snapshot_id,symbol_id,qualified_name,language,kind,"
                "path,start_line,end_line,trust_domain,provenance_id,created_ts,meta_json) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,'{}')",
                (snapshot_id, symbol_id, qualified_name or None, language or None, kind,
                 path or None, start_line or None, end_line or None, trust_domain or None,
                 provenance_id, time.time()))
            sid = cur.lastrowid
            self.store.add_audit("register_symbol", "code_symbols", sid, actor=self.actor,
                                 session=self.session, new_state=symbol_id)
        return sid

    def link_symbols(self, snapshot_id: int, src_symbol: str, dst_symbol: str,
                     relation: str = "calls", dispatch: str = "direct",
                     callsite_path: str = "", callsite_line: int = 0,
                     boundary_id: Optional[int] = None, confidence: float = 0.5,
                     provenance_id: Optional[int] = None, status: str = "hypothesis",
                     evidence_id: Optional[int] = None) -> int:
        """Record a directed symbol relationship (calls|inherits|implements|binds|
        crosses_boundary). `dispatch` preserves call uncertainty (a virtual/pointer
        target is possible, not an observed execution)."""
        self._require_snapshot(snapshot_id)
        if relation not in ("calls", "inherits", "implements", "binds", "crosses_boundary"):
            raise ValueError(f"invalid symbol relation: {relation}")
        if not src_symbol or not dst_symbol:
            raise ValueError("symbol relation requires src_symbol and dst_symbol")
        if status not in _FLOW_RANK:
            raise ValueError(f"invalid relation status: {status}")
        if not 0.0 <= float(confidence) <= 1.0:
            raise ValueError("confidence must be between 0 and 1")
        if callsite_path:
            self._validate_repo_path(callsite_path)
        boundary = self._require_scoped("boundaries", boundary_id, snapshot_id, "boundary") \
            if boundary_id is not None else None
        ev = self._require_scoped("evidence", evidence_id, snapshot_id, "evidence") \
            if evidence_id is not None else None
        trust, prov = self._effective_trust(
            snapshot_id, (ev or {}).get("trust") or "agent_asserted", provenance_id)
        if relation == "crosses_boundary":
            if boundary is None:
                raise ValueError("crosses_boundary relation requires boundary_id")
            # Boundary demonstrations are stronger than ordinary graph edges.
            if status == "demonstrated" and not (
                    ev and ev.get("status") == "reproduced" and prov
                    and trust in _STRONG_TRUST
                    and ev.get("provenance_id") == provenance_id):
                status = "supported" if ev and prov else "hypothesis"
        cur = self.conn.execute(
            "INSERT INTO symbol_relations(snapshot_id,src_symbol,dst_symbol,relation,dispatch,"
            "callsite_path,callsite_line,boundary_id,confidence,provenance_id,created_ts,meta_json,"
            "status,evidence_id) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,'{}',?,?)",
            (snapshot_id, src_symbol, dst_symbol, relation, dispatch, callsite_path or None,
             callsite_line or None, boundary_id, confidence, provenance_id, time.time(), status,
             evidence_id))
        return cur.lastrowid

    def callees(self, snapshot_id: int, symbol: str, limit: int = 100) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM symbol_relations WHERE snapshot_id=? AND src_symbol=? AND relation='calls' "
            "ORDER BY id LIMIT ?", (snapshot_id, symbol, limit)).fetchall()
        return [dict(r) for r in rows]

    def callers(self, snapshot_id: int, symbol: str, limit: int = 100) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM symbol_relations WHERE snapshot_id=? AND dst_symbol=? AND relation='calls' "
            "ORDER BY id LIMIT ?", (snapshot_id, symbol, limit)).fetchall()
        return [dict(r) for r in rows]

    def record_analysis_result(self, snapshot_id: int, tool: str, raw: str,
                               query_id: str = "", tool_version: str = "",
                               value_identity_id: Optional[int] = None,
                               status: str = "observed", trust: str = "tool_verified",
                               media_type: str = "application/sarif+json") -> dict:
        """Convenience: record an external static-analysis result as provenance +
        an immutable raw artifact + an evidence row (kind='static_analysis'). The
        raw output is preserved verbatim; the evidence projection is bounded."""
        with self.store.transaction():
            prov = self.add_provenance(snapshot_id, tool=tool, tool_version=tool_version,
                                       query_id=query_id, actor=tool, actor_kind="tool", trust=trust)
            eid = self.add_evidence(snapshot_id, "static_analysis", raw=raw, status=status,
                                    trust=trust, provenance_id=prov,
                                    value_identity_id=value_identity_id, media_type=media_type)
        return {"provenance_id": prov, "evidence_id": eid}

    def record_crash_artifact(self, snapshot_id: int, raw_log: str, kind: str = "crash",
                             validation_run_id: Optional[int] = None,
                             trust: str = "tool_verified") -> int:
        """Record a crash/sanitizer log as an immutable artifact + evidence. A
        parsed crash does not set finding severity or prove exploitability."""
        provenance_id = None
        if validation_run_id is not None:
            vr = self._require_scoped(
                "validation_runs", validation_run_id, snapshot_id, "validation run")
            provenance_id = vr.get("provenance_id")
        return self.add_evidence(snapshot_id, kind, raw=raw_log, status="observed",
                                 trust=trust, provenance_id=provenance_id,
                                 validation_run_id=validation_run_id,
                                 flow_edge_id=None, media_type="text/plain")

    # ---- audit ----------------------------------------------------------- #
    def audit_log(self, affected_table: Optional[str] = None, limit: int = 200) -> list[dict]:
        if affected_table:
            rows = self.conn.execute(
                "SELECT * FROM audit_events WHERE affected_table=? ORDER BY id DESC LIMIT ?",
                (affected_table, limit)).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM audit_events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    # ---- retrieval (SQL-side filter + paginate + rank; no N+1) ---------- #
    def text_search_backend(self) -> str:
        """Which text-search backend is active: 'fts5' when the SQLite build has
        FTS5, else a documented 'like' fallback (never silently disabled)."""
        return "fts5" if self.store.fts_enabled else "like"

    def search_evidence(self, snapshot_id: Optional[int] = None, text: Optional[str] = None,
                        kind: Optional[str] = None, status: Optional[str] = None,
                        path: Optional[str] = None, symbol_id: Optional[str] = None,
                        since_ts: Optional[float] = None, limit: int = 20, offset: int = 0,
                        preview_chars: int = 200, revision: str = "any") -> list[dict]:
        """Structured + textual evidence retrieval. ALL filtering, ranking and
        pagination happen in ONE SQL statement (no per-row lookups), so a bounded
        limit issues a constant number of statements regardless of store size.
        Free-text works WITHOUT embeddings (FTS5 MATCH, or a LIKE fallback). When a
        snapshot is given, exact-revision matches rank first and rows from other
        revisions are labelled stale + revision_mismatch. `revision='current'`
        hard-filters to the given snapshot (no other-revision rows at all).
        Returns stable ids and a bounded preview — never the raw artifact."""
        if snapshot_id is not None:
            self._require_snapshot(snapshot_id)
        if revision not in ("any", "current"):
            raise ValueError("revision must be 'any' or 'current'")
        if not 1 <= int(limit) <= 200:
            raise ValueError("limit must be between 1 and 200")
        if not 0 <= int(offset) <= 1_000_000:
            raise ValueError("offset must be between 0 and 1000000")
        if not 1 <= int(preview_chars) <= 4000:
            raise ValueError("preview_chars must be between 1 and 4000")
        if text is not None and len(text) > 4096:
            raise ValueError("text query exceeds 4096 characters")
        joins, where, args = "", ["e.valid_to IS NULL"], []
        if revision == "current" and snapshot_id is not None:
            where.append("e.snapshot_id=?"); args.append(snapshot_id)
        if text:
            if self.store.fts_enabled:
                joins += " JOIN evidence_fts f ON f.evidence_id = e.id"
                where.append("evidence_fts MATCH ?")
                # Treat user text as a literal phrase, not as executable FTS5
                # syntax. This also makes unmatched quotes harmless.
                args.append('"' + text.replace('"', '""') + '"')
            else:                                   # documented LIKE fallback
                where.append("e.projection LIKE ?")
                args.append(f"%{text}%")
        if path or symbol_id:
            joins += " JOIN value_identities v ON v.id = e.value_identity_id"
            if path:
                where.append("v.path=?"); args.append(path)
            if symbol_id:
                where.append("v.symbol_id=?"); args.append(symbol_id)
        if kind:
            where.append("e.kind=?"); args.append(kind)
        if status:
            where.append("e.status=?"); args.append(status)
        if since_ts is not None:
            where.append("e.created_ts>=?"); args.append(since_ts)

        order_prefix, order_args = "", []
        if snapshot_id is not None:
            order_prefix = "CASE WHEN e.snapshot_id=? THEN 0 ELSE 1 END, "
            order_args = [snapshot_id]
        sql = (f"SELECT e.id,e.snapshot_id,e.kind,e.status,e.artifact_id,e.created_ts,"
               f"e.projection_truncated,substr(e.projection,1,?) AS preview "
               f"FROM evidence e{joins} WHERE {' AND '.join(where)} "
               f"ORDER BY {order_prefix}e.created_ts DESC, e.id DESC LIMIT ? OFFSET ?")
        params = [preview_chars, *args, *order_args, limit, offset]
        rows = self.conn.execute(sql, params).fetchall()
        out = []
        for r in rows:
            stale = snapshot_id is not None and r["snapshot_id"] != snapshot_id
            out.append({"evidence_id": r["id"], "snapshot_id": r["snapshot_id"],
                        "kind": r["kind"], "status": r["status"],
                        "artifact_id": r["artifact_id"], "created_ts": r["created_ts"],
                        "preview": r["preview"], "truncated": bool(r["projection_truncated"]),
                        "stale": stale, "revision_mismatch": stale})
        return out

    # ---- chain composition (explicit edges only) ------------------------ #
    def _current_edges(self, snapshot_id: int) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM flow_edges WHERE snapshot_id=? AND valid_to IS NULL "
            "AND status!='rejected'", (snapshot_id,)).fetchall()
        return [dict(r) for r in rows]

    def chains(self, snapshot_id: int, goal: Optional[str] = None) -> list[dict]:
        """Compose chains from explicit flow edges: every source→…→sink path over
        current, non-rejected edges within this snapshot. A chain's status is the
        WEAKEST transition on it (and an active guard caps a step at 'blocked'), so
        a chain can never be stronger than its least-supported step."""
        self._require_snapshot(snapshot_id)
        # exclude identities that have been staled (source changed) or rejected, so a
        # chain through changed/disproven code is retracted, not silently kept.
        vids = {r["id"]: dict(r) for r in self.conn.execute(
            "SELECT * FROM value_identities WHERE snapshot_id=? AND valid_to IS NULL "
            "AND status NOT IN ('stale','rejected')", (snapshot_id,)).fetchall()}
        # an edge is traversable only if BOTH endpoints are live (a staled middle
        # node must break the chain, not be routed through).
        by_src: dict[int, list[dict]] = {}
        for e in self._current_edges(snapshot_id):
            if e["src_vid"] in vids and e["dst_vid"] in vids:
                by_src.setdefault(e["src_vid"], []).append(e)
        sources = [v for v in vids.values() if v["role"] == "source"]

        out, seen_keys = [], set()

        def label(v: dict) -> str:
            loc = f"{v['path']}:{v['start_line']}" if v.get("start_line") else v["path"]
            return f"{v['role']}({v.get('value_name') or ''}@{v.get('symbol_id') or '?'}) {loc}"

        def walk(vid: int, path_edges: list[dict], visited: set):
            # bounded search: cap path length, per-node fan-out, and total results,
            # so a dense flow graph cannot cause exponential blowup.
            if len(path_edges) > _MAX_PATH_DEPTH or len(out) >= _MAX_CHAIN_RESULTS:
                return
            v = vids.get(vid)
            if v is not None and v["role"] == "sink" and path_edges:
                _emit(path_edges, v)
            for e in by_src.get(vid, [])[:_MAX_FANOUT]:
                if e["dst_vid"] in visited or len(out) >= _MAX_CHAIN_RESULTS:
                    continue
                walk(e["dst_vid"], path_edges + [e], visited | {e["dst_vid"]})

        def _emit(path_edges: list[dict], sink_v: dict):
            key = tuple(e["id"] for e in path_edges)
            if key in seen_keys:
                return
            seen_keys.add(key)
            # weakest-link status; an active guard caps a step at 'blocked'
            ranks = []
            steps = []
            for e in path_edges:
                r = _FLOW_RANK[e["status"]]
                guarded = self._edge_is_guard_blocked(e["id"], snapshot_id)
                if guarded:
                    r = min(r, _FLOW_RANK["blocked"])
                ranks.append(r)
                steps.append({"flow_edge_id": e["id"], "src_vid": e["src_vid"],
                              "dst_vid": e["dst_vid"], "status": e["status"],
                              "guard_blocked": guarded, "kind": e["kind"]})
            status = _RANK_FLOW[min(ranks)] if ranks else "hypothesis"
            sink_type = sink_v.get("sink_type") or "generic"
            g = _SINK_GOAL.get(sink_type, "injection")
            if goal is not None and g != goal:
                return
            sev = _CR_GOAL_SEVERITY.get(g, 5)
            src_v = vids.get(path_edges[0]["src_vid"], {})
            narrative = " -> ".join([label(src_v)] + [label(vids.get(e["dst_vid"], {})) for e in path_edges])
            impact = "demonstrated" if status == "demonstrated" else (
                "suspected" if status in ("supported",) else "unproven")
            dedup = _digest(str(snapshot_id), *[str(e["id"]) for e in path_edges])
            out.append({"snapshot_id": snapshot_id, "goal": g, "severity": sev,
                        "status": status, "impact_state": impact,
                        "narrative": f"{narrative}  ==>  {g.upper()} [{status}]",
                        "steps": steps, "dedup_key": dedup})

        for s in sources:
            walk(s["id"], [], {s["id"]})
        out.sort(key=lambda c: (_FLOW_RANK[c["status"]], c["severity"]), reverse=True)
        return out

"""v7 hardening regression tests (follow-up to the schema-v6 integrity work):

  D2  a DB-level trigger backstop rejects a cross-snapshot reference even on a
      raw INSERT that bypasses the _require_scoped service layer;
  D6  sink reclassification resets the successor edge to a fresh 'hypothesis'
      (no verdict/trust/evidence carried forward) and downgrades any dependent
      'demonstrated' finding to 'suspected';
  D5  limit/offset that are not integers return a stable INVALID_ARGUMENT
      envelope at the contract layer instead of raising TypeError.

Stdlib unittest; each test uses its own temp DB.
"""
import os
import sqlite3
import tempfile
import unittest

from agentmem import ResearchMemory
from agentmem.research_tools import ResearchTools

HEX1 = "a" * 40
HEX2 = "b" * 40


class _Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="am_v7_")
        self.m = ResearchMemory(os.path.join(self.d, "r.db"), actor="tester")
        self.t = ResearchTools(self.m)

    def tearDown(self):
        self.m.close()


class TestSnapshotDbBackstop(_Base):
    def test_raw_cross_snapshot_guard_insert_is_rejected_by_the_db(self):
        s1 = self.m.register_snapshot("firefox", HEX1)
        s2 = self.m.register_snapshot("firefox", HEX2)
        a = self.m.add_value_identity(s1, "a.cpp", "v", role="source")
        b = self.m.add_value_identity(s1, "b.cpp", "w", role="sink", sink_type="buffer")
        e1 = self.m.add_flow_edge(s1, a, b)
        # raw INSERT bypassing the service layer: a snapshot-2 guard on a snapshot-1 edge
        with self.assertRaises(sqlite3.Error) as cm:
            self.m.conn.execute(
                "INSERT INTO guards(snapshot_id,flow_edge_id,kind,status,version,"
                "valid_from,created_ts,meta_json) VALUES(?,?,?,?,?,?,?,'{}')",
                (s2, e1, "sanitizer", "active", 1, 0.0, 0.0))
        self.assertIn("cross-snapshot", str(cm.exception).lower())

    def test_raw_cross_snapshot_evidence_and_flow_edge_rejected(self):
        s1 = self.m.register_snapshot("firefox", HEX1)
        s2 = self.m.register_snapshot("firefox", HEX2)
        a1 = self.m.add_value_identity(s1, "a.cpp", "v", role="source")
        e1 = self.m.add_flow_edge(s1, a1,
                                  self.m.add_value_identity(s1, "b.cpp", "w", role="sink",
                                                            sink_type="buffer"))
        with self.assertRaises(sqlite3.Error):   # s2 evidence pointing at an s1 edge
            self.m.conn.execute(
                "INSERT INTO evidence(snapshot_id,kind,flow_edge_id,status,trust,version,"
                "valid_from,created_ts,meta_json) VALUES(?,?,?,?,?,?,?,?,'{}')",
                (s2, "note", e1, "observed", "agent_asserted", 1, 0.0, 0.0))
        a2 = self.m.add_value_identity(s2, "a.cpp", "v", role="source")
        with self.assertRaises(sqlite3.Error):   # s1 edge referencing an s2 value identity
            self.m.conn.execute(
                "INSERT INTO flow_edges(snapshot_id,src_vid,dst_vid,kind,status,confidence,"
                "trust,version,valid_from,created_ts,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?,'{}')",
                (s1, a2, a1, "interprocedural", "hypothesis", 0.5, "agent_asserted", 1, 0.0, 0.0))

    def test_legit_same_snapshot_raw_insert_not_blocked(self):
        s1 = self.m.register_snapshot("firefox", HEX1)
        a = self.m.add_value_identity(s1, "a.cpp", "v", role="source")
        e1 = self.m.add_flow_edge(s1, a, self.m.add_value_identity(
            s1, "b.cpp", "w", role="sink", sink_type="buffer"))
        # same-snapshot guard: the trigger must NOT fire (no over-blocking)
        self.m.conn.execute(
            "INSERT INTO guards(snapshot_id,flow_edge_id,kind,status,version,"
            "valid_from,created_ts,meta_json) VALUES(?,?,?,?,?,?,?,'{}')",
            (s1, e1, "sanitizer", "active", 1, 0.0, 0.0))
        self.assertEqual(self.m.conn.execute(
            "SELECT COUNT(*) c FROM guards WHERE flow_edge_id=?", (e1,)).fetchone()["c"], 1)


class TestReclassifyResetsVerdict(_Base):
    def _demonstrated(self, s):
        """Build a genuinely demonstrated single-edge chain + backed finding."""
        p = self.m.add_provenance(s, tool="codeql", actor_kind="tool", trust="tool_verified")
        self.m.register_symbol(s, "cpp:Src", language="cpp", kind="function",
                               path="f.cpp", trust_domain="content")
        self.m.register_symbol(s, "cpp:Sink", language="cpp", kind="function",
                               path="f.cpp", trust_domain="content")
        src = self.m.add_value_identity(s, "f.cpp", "x", role="source", symbol_id="cpp:Src")
        sink = self.m.add_value_identity(s, "f.cpp", "q", role="sink", sink_type="buffer",
                                         symbol_id="cpp:Sink")
        ev = self.m.add_evidence(s, "dataflow", raw="reproduced path", status="reproduced",
                                 trust="tool_verified", provenance_id=p)
        edge = self.m.add_flow_edge(s, src, sink, status="demonstrated", trust="tool_verified",
                                    provenance_id=p, evidence_id=ev)
        h = self.m.add_hypothesis(s, "x reaches sink")
        self.m.link_evidence(h, "supports", flow_edge_id=edge)
        return src, sink, edge, h

    def test_reclassify_resets_edge_and_downgrades_finding(self):
        s = self.m.register_snapshot("firefox", HEX1)
        src, sink, edge, h = self._demonstrated(s)
        # precondition: the edge is demonstrated and the finding is demonstrated-backed
        self.assertEqual(self.m.conn.execute(
            "SELECT status FROM flow_edges WHERE id=?", (edge,)).fetchone()["status"], "demonstrated")
        f = self.m.add_finding(s, "OOB", impact_state="demonstrated", hypothesis_id=h)
        self.assertEqual(self.m.conn.execute(
            "SELECT impact_state FROM findings WHERE id=?", (f,)).fetchone()["impact_state"],
            "demonstrated")
        # reclassify the sink -> successor edge must be a fresh hypothesis, finding downgraded
        self.m.reclassify_sink(sink, "log", reason="actually a log sink")
        new_edge = self.m.conn.execute(
            "SELECT id,status,trust,evidence_id FROM flow_edges WHERE src_vid=? "
            "AND valid_to IS NULL", (src,)).fetchone()
        self.assertEqual(new_edge["status"], "hypothesis")        # no verdict carried forward
        self.assertEqual(new_edge["trust"], "agent_asserted")
        self.assertIsNone(new_edge["evidence_id"])
        self.assertEqual(self.m.conn.execute(
            "SELECT impact_state FROM findings WHERE id=?", (f,)).fetchone()["impact_state"],
            "suspected")                                          # dependent finding downgraded
        old = self.m.conn.execute(
            "SELECT status,valid_to FROM flow_edges WHERE id=?", (edge,)).fetchone()
        self.assertIsNotNone(old["valid_to"])                     # old edge closed, history kept


class TestLimitIntCoercion(_Base):
    def test_non_integer_limit_offset_return_envelope_not_typeerror(self):
        s = self.m.register_snapshot("firefox", HEX1)
        for bad in ("5", None, 1.5):
            r = self.t.query_history(snapshot_id=s, limit=bad)
            self.assertFalse(r["ok"])
            self.assertEqual(r["error"]["code"], "INVALID_ARGUMENT")
        r = self.t.query_history(snapshot_id=s, limit=10, offset="0")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "INVALID_ARGUMENT")
        rb = self.t.export_evidence_bundle(snapshot_id=s, limit=1.5)
        self.assertFalse(rb["ok"])
        self.assertEqual(rb["error"]["code"], "INVALID_ARGUMENT")
        # a valid integer limit still works
        self.assertTrue(self.t.query_history(snapshot_id=s, limit=10)["ok"])


if __name__ == "__main__":
    unittest.main()

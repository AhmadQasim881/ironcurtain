"""
agentmem.migrations — schema versioning and safe forward migrations.

The base `schema.sql` (v1: web + first-generation code-review tables) is applied
on every open with `CREATE ... IF NOT EXISTS`. On top of that, `migrate()` brings
a database up to `CURRENT_SCHEMA_VERSION` by applying ordered, additive forward
steps and recording the version in `kv_meta`.

Guarantees:
  * Migrations are **additive** — they create new tables/indexes and never drop or
    rewrite v1 data, so an existing database migrates without data loss.
  * A database whose recorded version is **newer** than this library supports is
    refused with a clear backup/upgrade instruction (never silently downgraded).

To add a future migration: bump CURRENT_SCHEMA_VERSION, add a `_migrate_to_N`
function, and register it in `_STEPS`.
"""
from __future__ import annotations

import os
import sqlite3

CURRENT_SCHEMA_VERSION = 7

_RESEARCH_SQL = os.path.join(os.path.dirname(__file__), "schema_research.sql")
_FIREFOX_SQL = os.path.join(os.path.dirname(__file__), "schema_firefox.sql")

# kv_meta keys written by migrations
_K_VERSION = "schema_version"
_K_FTS = "fts5_enabled"


def get_version(conn: sqlite3.Connection) -> int:
    """The database's recorded schema version. A database that predates versioning
    (has the v1 tables but no recorded version) is treated as v1."""
    row = conn.execute("SELECT value FROM kv_meta WHERE key=?", (_K_VERSION,)).fetchone()
    if row is not None:
        return int(row[0] if not isinstance(row, sqlite3.Row) else row["value"])
    return 1


def _set_version(conn: sqlite3.Connection, v: int) -> None:
    conn.execute(
        "INSERT INTO kv_meta(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (_K_VERSION, str(v)))


def fts5_available(conn: sqlite3.Connection) -> bool:
    """True if this SQLite build has the FTS5 extension (used for text search)."""
    try:
        conn.execute("CREATE VIRTUAL TABLE temp._agentmem_fts_probe USING fts5(x)")
        conn.execute("DROP TABLE temp._agentmem_fts_probe")
        return True
    except sqlite3.Error:
        return False


def fts5_enabled(conn: sqlite3.Connection) -> bool:
    row = conn.execute("SELECT value FROM kv_meta WHERE key=?", (_K_FTS,)).fetchone()
    return bool(row) and str(row[0] if not isinstance(row, sqlite3.Row) else row["value"]) == "1"


def migrate(conn: sqlite3.Connection) -> int:
    """Bring `conn` up to CURRENT_SCHEMA_VERSION. Returns the resulting version.
    Raises RuntimeError if the database is newer than this library supports."""
    v = get_version(conn)
    if v > CURRENT_SCHEMA_VERSION:
        raise RuntimeError(
            f"agentmem: database schema version {v} is newer than this library "
            f"supports (max {CURRENT_SCHEMA_VERSION}). Back up the database file "
            f"and upgrade agentmem, or open it with a matching agentmem version. "
            f"Refusing to open it to avoid data loss.")
    for target in range(v + 1, CURRENT_SCHEMA_VERSION + 1):
        _STEPS[target](conn)
        _set_version(conn, target)
    conn.commit()
    return CURRENT_SCHEMA_VERSION


def _migrate_to_2(conn: sqlite3.Connection) -> None:
    """v1 -> v2: add the revision-aware research-evidence tables (additive)."""
    with open(_RESEARCH_SQL, encoding="utf-8") as fh:
        conn.executescript(fh.read())
    # Optional FTS5 text index over evidence projections. Created only when the
    # SQLite build supports it; retrieval degrades to a documented LIKE fallback
    # otherwise (recorded so the retrieval layer can report capability honestly).
    has_fts = fts5_available(conn)
    if has_fts:
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5("
            "text, evidence_id UNINDEXED, snapshot_id UNINDEXED, kind UNINDEXED)")
    conn.execute(
        "INSERT INTO kv_meta(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (_K_FTS, "1" if has_fts else "0"))


def _migrate_to_3(conn: sqlite3.Connection) -> None:
    """v2 -> v3: add the Firefox research record model (symbols, call/inheritance
    relations, trust boundaries). Additive."""
    with open(_FIREFOX_SQL, encoding="utf-8") as fh:
        conn.executescript(fh.read())


def _migrate_to_4(conn: sqlite3.Connection) -> None:
    """v3 -> v4: true idempotency — store a payload hash so a key reused with
    different arguments conflicts instead of silently replaying. Additive column."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(idempotency_keys)").fetchall()}
    if "payload_hash" not in cols:
        conn.execute("ALTER TABLE idempotency_keys ADD COLUMN payload_hash TEXT")


def _add_column(conn: sqlite3.Connection, table: str, definition: str) -> None:
    """Add one column when upgrading an existing database.

    SQLite has no portable ``ADD COLUMN IF NOT EXISTS`` on all supported
    versions, so migrations inspect the table first. ``definition`` is a
    constant owned by this module, never user input.
    """
    name = definition.split()[0]
    cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if name not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {definition}")


def _migrate_to_5(conn: sqlite3.Connection) -> None:
    """v4 -> v5: harden research integrity and lifecycle tracking.

    The added fields make trust-boundary evidence explicit, preserve full
    idempotent responses, retain supersession links, and provide an immutable
    lifecycle-event stream for every status transition.
    """
    _add_column(conn, "snapshots", "tree_digest TEXT")
    _add_column(conn, "snapshots", "manifest_artifact_id INTEGER REFERENCES artifacts(id)")
    _add_column(conn, "snapshots", "platform TEXT")
    _add_column(conn, "snapshots", "index_id TEXT")
    _add_column(conn, "source_refs", "file_digest TEXT")
    _add_column(conn, "evidence", "superseded_by INTEGER REFERENCES evidence(id)")
    _add_column(conn, "evidence", "validation_run_id INTEGER REFERENCES validation_runs(id)")
    _add_column(conn, "symbol_relations", "status TEXT NOT NULL DEFAULT 'hypothesis'")
    _add_column(conn, "symbol_relations", "evidence_id INTEGER REFERENCES evidence(id)")
    _add_column(conn, "boundaries", "status TEXT NOT NULL DEFAULT 'modeled'")
    _add_column(conn, "boundaries", "provenance_id INTEGER REFERENCES provenance(id)")
    _add_column(conn, "boundaries", "evidence_id INTEGER REFERENCES evidence(id)")
    _add_column(conn, "idempotency_keys", "result_json TEXT")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS research_lifecycle_events (
          id              INTEGER PRIMARY KEY,
          entity_table    TEXT NOT NULL,
          entity_id       INTEGER NOT NULL,
          entity_version  INTEGER NOT NULL,
          old_state       TEXT,
          new_state       TEXT NOT NULL,
          rationale       TEXT,
          actor           TEXT,
          session         TEXT,
          evidence_json   TEXT NOT NULL DEFAULT '[]',
          created_ts      REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_lifecycle_entity
          ON research_lifecycle_events(entity_table, entity_id, id);
        """
    )


def _migrate_to_6(conn: sqlite3.Connection) -> None:
    """v5 -> v6: explicit dependency edges for non-source invalidation.

    Generated inputs, build flags, analysis-model versions, headers, and boundary
    models can now invalidate the claims that depend on them instead of relying
    only on exact source-file paths.
    """
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS research_dependencies (
          id               INTEGER PRIMARY KEY,
          snapshot_id      INTEGER NOT NULL REFERENCES snapshots(id),
          input_kind       TEXT NOT NULL,
          input_key        TEXT NOT NULL,
          dependent_table  TEXT NOT NULL,
          dependent_id     INTEGER NOT NULL,
          created_ts       REAL NOT NULL,
          UNIQUE(snapshot_id,input_kind,input_key,dependent_table,dependent_id)
        );
        CREATE INDEX IF NOT EXISTS ix_research_dependencies_input
          ON research_dependencies(snapshot_id,input_kind,input_key);
        CREATE INDEX IF NOT EXISTS ix_research_dependencies_target
          ON research_dependencies(dependent_table,dependent_id);
        """
    )


def _migrate_to_7(conn: sqlite3.Connection) -> None:
    """v6 -> v7: DB-level fail-closed backstop for revision (snapshot) isolation.

    ``_require_scoped`` enforces single-snapshot references at the service layer;
    these BEFORE INSERT triggers enforce the same invariant at the database, so a
    direct-SQL writer (or a future code path that forgets the check) cannot attach
    a cross-snapshot evidence / guard / flow edge. On the normal path the service
    layer raises first; the triggers are defense in depth. A NULL reference or a
    NULL-snapshot parent is left to the service layer (the trigger only fires on a
    concrete snapshot mismatch)."""
    conn.executescript(
        """
        CREATE TRIGGER IF NOT EXISTS trg_flow_edges_snapshot BEFORE INSERT ON flow_edges BEGIN
          SELECT CASE WHEN NEW.src_vid IS NOT NULL AND
            (SELECT snapshot_id FROM value_identities WHERE id=NEW.src_vid) <> NEW.snapshot_id
            THEN RAISE(ABORT,'cross-snapshot src_vid on flow_edges') END;
          SELECT CASE WHEN NEW.dst_vid IS NOT NULL AND
            (SELECT snapshot_id FROM value_identities WHERE id=NEW.dst_vid) <> NEW.snapshot_id
            THEN RAISE(ABORT,'cross-snapshot dst_vid on flow_edges') END;
          SELECT CASE WHEN NEW.evidence_id IS NOT NULL AND
            (SELECT snapshot_id FROM evidence WHERE id=NEW.evidence_id) <> NEW.snapshot_id
            THEN RAISE(ABORT,'cross-snapshot evidence on flow_edges') END;
          SELECT CASE WHEN NEW.provenance_id IS NOT NULL AND
            (SELECT snapshot_id FROM provenance WHERE id=NEW.provenance_id) <> NEW.snapshot_id
            THEN RAISE(ABORT,'cross-snapshot provenance on flow_edges') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_evidence_snapshot BEFORE INSERT ON evidence BEGIN
          SELECT CASE WHEN NEW.value_identity_id IS NOT NULL AND
            (SELECT snapshot_id FROM value_identities WHERE id=NEW.value_identity_id) <> NEW.snapshot_id
            THEN RAISE(ABORT,'cross-snapshot value_identity on evidence') END;
          SELECT CASE WHEN NEW.source_ref_id IS NOT NULL AND
            (SELECT snapshot_id FROM source_refs WHERE id=NEW.source_ref_id) <> NEW.snapshot_id
            THEN RAISE(ABORT,'cross-snapshot source_ref on evidence') END;
          SELECT CASE WHEN NEW.flow_edge_id IS NOT NULL AND
            (SELECT snapshot_id FROM flow_edges WHERE id=NEW.flow_edge_id) <> NEW.snapshot_id
            THEN RAISE(ABORT,'cross-snapshot flow_edge on evidence') END;
          SELECT CASE WHEN NEW.provenance_id IS NOT NULL AND
            (SELECT snapshot_id FROM provenance WHERE id=NEW.provenance_id) <> NEW.snapshot_id
            THEN RAISE(ABORT,'cross-snapshot provenance on evidence') END;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_guards_snapshot BEFORE INSERT ON guards BEGIN
          SELECT CASE WHEN NEW.flow_edge_id IS NOT NULL AND
            (SELECT snapshot_id FROM flow_edges WHERE id=NEW.flow_edge_id) <> NEW.snapshot_id
            THEN RAISE(ABORT,'cross-snapshot flow_edge on guards') END;
          SELECT CASE WHEN NEW.in_vid IS NOT NULL AND
            (SELECT snapshot_id FROM value_identities WHERE id=NEW.in_vid) <> NEW.snapshot_id
            THEN RAISE(ABORT,'cross-snapshot in_vid on guards') END;
          SELECT CASE WHEN NEW.out_vid IS NOT NULL AND
            (SELECT snapshot_id FROM value_identities WHERE id=NEW.out_vid) <> NEW.snapshot_id
            THEN RAISE(ABORT,'cross-snapshot out_vid on guards') END;
          SELECT CASE WHEN NEW.evidence_id IS NOT NULL AND
            (SELECT snapshot_id FROM evidence WHERE id=NEW.evidence_id) <> NEW.snapshot_id
            THEN RAISE(ABORT,'cross-snapshot evidence on guards') END;
        END;
        """
    )


_STEPS = {
    2: _migrate_to_2,
    3: _migrate_to_3,
    4: _migrate_to_4,
    5: _migrate_to_5,
    6: _migrate_to_6,
    7: _migrate_to_7,
}

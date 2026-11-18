import type { DatabaseSync } from 'node:sqlite';

import { SQLITE_BUSY_TIMEOUT_MS, withSqliteBusyRetry } from './sqlite-busy-retry.js';
import { LLM_METRICS_SCHEMA_INCOMPATIBLE } from './storage-errors.js';

export const LLM_METRICS_SCHEMA_VERSION = 2;

export type LlmMetricsSchemaRole = 'writer' | 'reader';

/**
 * A database schema this process must not use: newer than it supports without
 * a compatibility range that admits it. Persistence latches off on it instead
 * of restarting, because no restart of this binary can repair it.
 */
export class LlmMetricsSchemaIncompatibleError extends Error {
  readonly code = LLM_METRICS_SCHEMA_INCOMPATIBLE;

  constructor(message: string) {
    super(message);
    this.name = 'LlmMetricsSchemaIncompatibleError';
  }
}

/**
 * Compatibility range of the current schema, rewritten by every migration in
 * the same transaction as its DDL. An older binary that finds a newer
 * `user_version` keeps using the database only while its own schema version is
 * at least the minimum stored for its role, because only the newer binary can
 * know whether its migration was additive. The table is created by the first
 * migration a binary with this contract runs, so databases migrated before it
 * existed simply lack it until their next migration.
 */
const COMPATIBILITY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS llm_metrics_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  ) STRICT;
`;

const COMPATIBILITY_KEYS: Readonly<Record<LlmMetricsSchemaRole, string>> = {
  writer: 'min_writer_schema',
  reader: 'min_reader_schema',
};

/**
 * The first metrics schema is intentionally column-oriented. Request and
 * response payloads never cross this boundary, and there is no catch-all JSON
 * column that could accidentally retain content.
 */
const MIGRATION_1 = `
  CREATE TABLE IF NOT EXISTS llm_process_runs (
    process_run_id TEXT PRIMARY KEY,
    started_at_ms INTEGER NOT NULL,
    last_checkpoint_at_ms INTEGER NOT NULL,
    observed_count INTEGER NOT NULL DEFAULT 0,
    finalized_count INTEGER NOT NULL DEFAULT 0,
    enqueued_count INTEGER NOT NULL DEFAULT 0,
    clean_ended_at_ms INTEGER
  ) STRICT;

  CREATE TABLE IF NOT EXISTS llm_exchanges (
    ingestion_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id TEXT NOT NULL UNIQUE,
    schema_version INTEGER NOT NULL,
    completed_at_ms INTEGER NOT NULL,
    request_received_at_ms INTEGER NOT NULL,

    session_id TEXT,
    turn_id TEXT,
    agent_conversation_id TEXT,
    bundle_id TEXT,
    workflow_run_id TEXT,
    state_id TEXT,
    persona_id TEXT,
    attribution_quality TEXT NOT NULL,

    agent_name TEXT,
    logical_provider TEXT NOT NULL,
    provider_profile_id TEXT,
    protocol TEXT NOT NULL,
    gateway_kind TEXT NOT NULL,
    client_route_id TEXT,
    upstream_route_id TEXT,

    requested_model TEXT,
    requested_model_source TEXT NOT NULL,
    forwarded_model TEXT,
    forwarded_model_source TEXT NOT NULL,
    response_model TEXT,
    response_model_source TEXT NOT NULL,
    served_model TEXT,
    served_model_source TEXT NOT NULL,
    served_provider TEXT,
    served_provider_source TEXT NOT NULL,

    provider_request_id TEXT,
    provider_response_id TEXT,
    gateway_generation_id TEXT,

    streaming INTEGER,
    requested_service_tier TEXT,
    actual_service_tier TEXT,
    reasoning_mode TEXT,
    reasoning_effort TEXT,
    thinking_budget_tokens INTEGER,
    speed_mode TEXT,

    response_status_code INTEGER,
    termination_category TEXT NOT NULL,
    provider_stop_reason TEXT,
    refusal INTEGER,
    refusal_category TEXT,
    outcome_source TEXT NOT NULL,

    input_tokens_reported INTEGER,
    input_tokens_total INTEGER,
    input_tokens_uncached INTEGER,
    cache_read_input_tokens INTEGER,
    cache_write_input_tokens INTEGER,
    tool_use_input_tokens INTEGER,
    output_tokens_reported INTEGER,
    output_token_semantics TEXT NOT NULL,
    output_tokens_total INTEGER,
    thinking_tokens INTEGER,
    non_thinking_output_tokens INTEGER,
    provider_total_tokens INTEGER,
    canonical_total_tokens INTEGER,
    cost_usd REAL,
    usage_source TEXT,
    usage_completeness TEXT NOT NULL,
    usage_semantics_version INTEGER NOT NULL,
    input_measurement_provenance TEXT NOT NULL,
    output_measurement_provenance TEXT NOT NULL,
    thinking_measurement_provenance TEXT NOT NULL,
    non_thinking_measurement_provenance TEXT NOT NULL,

    request_body_complete_offset_ms REAL,
    response_headers_offset_ms REAL,
    first_upstream_body_byte_offset_ms REAL,
    first_protocol_event_offset_ms REAL,
    first_reasoning_offset_ms REAL,
    last_reasoning_offset_ms REAL,
    first_output_offset_ms REAL,
    last_output_offset_ms REAL,
    protocol_terminal_offset_ms REAL,
    upstream_response_end_offset_ms REAL,
    client_delivery_end_offset_ms REAL,
    client_delivery_status TEXT NOT NULL,

    quality_flags_json TEXT NOT NULL,
    process_run_id TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS llm_transport_attempts (
    exchange_id TEXT NOT NULL REFERENCES llm_exchanges(exchange_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    started_offset_ms REAL NOT NULL,
    ended_offset_ms REAL,
    status_code INTEGER,
    outcome TEXT NOT NULL,
    PRIMARY KEY (exchange_id, ordinal)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS llm_gateway_route_attempts (
    exchange_id TEXT NOT NULL REFERENCES llm_exchanges(exchange_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    provider TEXT,
    model TEXT,
    status_code INTEGER,
    selected INTEGER,
    source TEXT NOT NULL,
    PRIMARY KEY (exchange_id, ordinal)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS llm_maintenance_leases (
    lease_name TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS llm_exchanges_completed_idx
    ON llm_exchanges (completed_at_ms DESC, exchange_id DESC);
  CREATE INDEX IF NOT EXISTS llm_exchanges_session_idx
    ON llm_exchanges (session_id, completed_at_ms DESC, exchange_id DESC);
  CREATE INDEX IF NOT EXISTS llm_exchanges_provider_model_idx
    ON llm_exchanges (logical_provider, served_model, completed_at_ms DESC);
  CREATE INDEX IF NOT EXISTS llm_exchanges_protocol_idx
    ON llm_exchanges (protocol, completed_at_ms DESC);
  CREATE INDEX IF NOT EXISTS llm_exchanges_process_run_idx
    ON llm_exchanges (process_run_id);
`;

/**
 * Host-side cost (schema 2), additive only: `cost_usd` keeps its meaning (the
 * cost a gateway reported) and the host's list-price estimate gets its own
 * column, qualified by where the exchange's cost comes from and the price
 * table version behind an estimate. Rows written before have NULL in all
 * three; their `cost_usd`, when set, was always gateway-reported.
 *
 * Its compatibility range stays at schema 1: the three columns are nullable,
 * a schema-1 INSERT names its columns and leaves them NULL, which readers
 * already interpret as a row without a host estimate (a non-NULL `cost_usd`
 * with no `cost_source` reads as gateway-reported), and a schema-1 reader
 * never selects them.
 */
const MIGRATION_2 = `
  ALTER TABLE llm_exchanges ADD COLUMN estimated_cost_usd REAL;
  ALTER TABLE llm_exchanges ADD COLUMN cost_source TEXT;
  ALTER TABLE llm_exchanges ADD COLUMN pricing_version TEXT;
`;

interface LlmMetricsMigration {
  readonly sql: string;
  /**
   * Oldest writer and reader schema versions that still work correctly against
   * the schema this migration produces. An additive migration (new tables or
   * indexes, or nullable/defaulted columns that older INSERTs, which name their
   * columns explicitly, may omit) keeps the previous values. A migration that
   * changes the shape or meaning of existing data raises them to its own
   * version, or moves to a new table family instead.
   */
  readonly minWriterSchema: number;
  readonly minReaderSchema: number;
}

const MIGRATIONS: Readonly<Partial<Record<number, LlmMetricsMigration>>> = {
  1: { sql: MIGRATION_1, minWriterSchema: 1, minReaderSchema: 1 },
  2: { sql: MIGRATION_2, minWriterSchema: 1, minReaderSchema: 1 },
};

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
  const value = row?.user_version;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid SQLite user_version');
  }
  return value;
}

/** The stored minimum for a role, or null when the database declares none. */
function readCompatibilityMinimum(database: DatabaseSync, role: LlmMetricsSchemaRole): number | null {
  const table = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'llm_metrics_meta'")
    .get();
  if (table === undefined) return null;
  const value: unknown = database
    .prepare('SELECT value FROM llm_metrics_meta WHERE key = ?')
    .get(COMPATIBILITY_KEYS[role])?.value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function assertNewerSchemaCompatible(database: DatabaseSync, version: number, role: LlmMetricsSchemaRole): void {
  const minimum = readCompatibilityMinimum(database, role);
  if (minimum !== null && minimum <= LLM_METRICS_SCHEMA_VERSION) return;
  throw new LlmMetricsSchemaIncompatibleError(
    minimum === null
      ? `LLM metrics database schema ${version} is newer than ${role} schema ${LLM_METRICS_SCHEMA_VERSION} ` +
          'and declares no compatible range'
      : `LLM metrics database schema ${version} requires ${role} schema ${minimum} or newer; ` +
          `this ${role} supports schema ${LLM_METRICS_SCHEMA_VERSION}`,
  );
}

/**
 * Checks that this process may use the database in `role` and returns its
 * schema version. A newer schema is accepted when its stored compatibility
 * range admits this process's schema version; without one it is refused. The
 * writer runs this before every batch and maintenance step, the reader when it
 * opens, so a migration by another process is noticed without a restart.
 */
export function assertLlmMetricsSchemaCompatible(database: DatabaseSync, role: LlmMetricsSchemaRole): number {
  const version = readUserVersion(database);
  if (version === LLM_METRICS_SCHEMA_VERSION) return version;
  if (version < LLM_METRICS_SCHEMA_VERSION) {
    throw new Error(
      `LLM metrics database schema ${version} is older than ${role} schema ${LLM_METRICS_SCHEMA_VERSION}`,
    );
  }
  assertNewerSchemaCompatible(database, version, role);
  return version;
}

/**
 * Applies additive migrations while holding SQLite's cross-process write lock
 * and returns the database's schema version. The version is re-read after
 * BEGIN IMMEDIATE so concurrent starters cannot both apply the same migration.
 * A newer schema is used without rewriting it when its compatibility range
 * admits this writer; otherwise it is refused unchanged. `targetVersion`
 * (default: the current schema) lets tests build a database at an older
 * schema.
 */
export function migrateLlmMetricsDatabase(
  database: DatabaseSync,
  targetVersion: number = LLM_METRICS_SCHEMA_VERSION,
): number {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1 || targetVersion > LLM_METRICS_SCHEMA_VERSION) {
    throw new Error(`Unsupported LLM metrics target schema ${targetVersion}`);
  }
  database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);

  let version = readUserVersion(database);
  if (version > LLM_METRICS_SCHEMA_VERSION) {
    assertNewerSchemaCompatible(database, version, 'writer');
    return version;
  }

  while (version < targetVersion) {
    version = withSqliteBusyRetry(() => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const lockedVersion = readUserVersion(database);
        if (lockedVersion > LLM_METRICS_SCHEMA_VERSION) {
          assertNewerSchemaCompatible(database, lockedVersion, 'writer');
          database.exec('COMMIT');
          return lockedVersion;
        }
        if (lockedVersion >= targetVersion) {
          database.exec('COMMIT');
          return lockedVersion;
        }

        const nextVersion = lockedVersion + 1;
        const migration = MIGRATIONS[nextVersion];
        if (migration === undefined) throw new Error(`Missing LLM metrics migration ${nextVersion}`);
        database.exec(migration.sql);
        database.exec(COMPATIBILITY_TABLE_SQL);
        const writeMinimum = database.prepare(
          'INSERT INTO llm_metrics_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        );
        writeMinimum.run(COMPATIBILITY_KEYS.writer, migration.minWriterSchema);
        writeMinimum.run(COMPATIBILITY_KEYS.reader, migration.minReaderSchema);
        database.exec(`PRAGMA user_version = ${nextVersion}`);
        database.exec('COMMIT');
        return nextVersion;
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // Preserve the migration error; BEGIN may not have acquired the lock.
        }
        throw error;
      }
    });
  }

  return version;
}

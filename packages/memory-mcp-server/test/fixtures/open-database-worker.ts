/**
 * One "server process" for the concurrent-open tests (migrations.test.ts): waits until
 * the shared start time, opens the memory database (which upgrades a stale schema), then
 * writes a marker row into it. A rebuild by another process after this one wrote its
 * marker would drop the marker, which the test detects.
 *
 * argv: <dbPath> <startAtEpochMs> <workerId>
 */
import { initDatabase } from '../../src/storage/database.js';

const [dbPath, startAt, workerId] = process.argv.slice(2);

const wait = Number(startAt) - Date.now();
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

const db = initDatabase(dbPath, 'test-model');
try {
  db.prepare(`INSERT INTO schema_meta (key, value) VALUES (?, 'present')`).run(`marker-${workerId}`);
} finally {
  db.close();
}
process.stdout.write(`opened ${workerId}\n`);

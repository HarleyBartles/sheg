import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { baselineMigration } from '../../src/infrastructure/sqlite/schema.js';

export async function seedReleasedV030Store(dataRoot: string): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  const database = new DatabaseSync(path.join(dataRoot, 'runs.sqlite'));
  try {
    const migration = baselineMigration();
    for (const statement of migration.sql.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) database.exec(statement);
    database.exec('PRAGMA user_version = 9');
    const fingerprint = createHash('sha256').update(JSON.stringify(database.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name`).all())).digest('hex');
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    database.prepare('INSERT INTO schema_migrations (version, migration_id, checksum, schema_fingerprint, applied_at) VALUES (9, ?, ?, ?, ?)')
      .run(migration.id, checksum, fingerprint, '2026-10-05T00:00:00.000Z');
    database.exec(await readFile(new URL('../fixtures/datastore/released-v0.3.0-run.sql', import.meta.url), 'utf8'));
  } finally { database.close(); }
}

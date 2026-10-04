-- Apply this schema-version addition to the complete source-owned schema-v7.sql fixture.
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL);
INSERT INTO schema_migrations (version, migration_id, applied_at) VALUES (8, 'schema-v7-to-v8-ledger', '2026-10-04T00:00:00.000Z');
PRAGMA user_version = 8;

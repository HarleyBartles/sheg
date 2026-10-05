import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { DatabaseSync } from 'node:sqlite';
import { openInitializedDatabase } from './schema.js';

export type SqliteConnection = {
  client: DatabaseSync;
  orm: NodeSQLiteDatabase;
  close(): void;
};

export function writeTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* Keep the operation error as the useful failure. */ }
    throw error;
  }
}

export function readTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* Keep the operation error as the useful failure. */ }
    throw error;
  }
}

export function openSqliteConnection(databasePath: string, dataRoot: string): SqliteConnection {
  const client = openInitializedDatabase(databasePath, dataRoot);
  const orm = drizzle({ client });
  let closed = false;
  return {
    client,
    orm,
    close() {
      if (closed) return;
      client.close();
      closed = true;
    },
  };
}

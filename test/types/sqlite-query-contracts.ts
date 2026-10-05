import { eq } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { runs } from '../../src/infrastructure/sqlite/tables.js';

export function compileSqliteQueryContracts(database: NodeSQLiteDatabase): void {
  database.select({ runId: runs.runId }).from(runs).where(eq(runs.runId, 'run-id'));

  // @ts-expect-error The declared schema has no column with this name.
  database.select({ missing: runs.missingColumn });

  // @ts-expect-error A run identity is text and cannot accept an integer.
  database.insert(runs).values({ runId: 42 });
}

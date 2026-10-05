import { and, eq, gt, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { runs } from '../tables.js';

export function chargeReservedAttempt(database: NodeSQLiteDatabase, runId: string, chargedCalls: number): boolean {
  return database.update(runs).set({
    usedCalls: sql`${runs.usedCalls} + ${chargedCalls}`,
    reservedCalls: sql`${runs.reservedCalls} - 1`,
  }).where(and(eq(runs.runId, runId), gt(runs.reservedCalls, 0)))
    .returning({ runId: runs.runId }).all().length === 1;
}

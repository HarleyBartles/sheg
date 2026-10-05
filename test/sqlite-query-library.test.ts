import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { z } from 'zod';
import { createSqliteQuery } from '../src/infrastructure/sqlite/query-library.js';

test('named query rejects malformed raw projections at its runtime boundary', () => {
  const query = createSqliteQuery('load-journey-worker-turn', z.tuple([z.string(), z.string(), z.string(), z.string()]), z.array(z.object({ request_json: z.string() })));
  const malformedDatabase = {
    prepare(sql: string) {
      assert.match(sql, /FROM runs/);
      return { all: () => [{ wrong_projection: true }] };
    },
  } as unknown as DatabaseSync;
  assert.throws(() => query.all(malformedDatabase, 'run-id', 'run-id', 'evaluation-id', 'respondent-id'), { code: 'data_integrity_error' });
});

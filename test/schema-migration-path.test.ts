import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSequentialMigrationPath } from '../src/infrastructure/schema-migration-path.js';

test('migration paths require an explicit one-version step for every predecessor', () => {
  assert.equal(hasSequentialMigrationPath(7, 9, [
    { fromVersion: 7, toVersion: 8 },
    { fromVersion: 8, toVersion: 9 },
  ]), true);
  assert.equal(hasSequentialMigrationPath(7, 10, [
    { fromVersion: 7, toVersion: 8 },
    { fromVersion: 8, toVersion: 10 },
  ]), false);
  assert.equal(hasSequentialMigrationPath(7, 10, [
    { fromVersion: 7, toVersion: 8 },
    { fromVersion: 9, toVersion: 10 },
  ]), false);
});

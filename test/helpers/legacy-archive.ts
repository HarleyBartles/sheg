import type { AttemptSnapshot } from '../../src/infrastructure/legacy/run-archive.js';

export function emptyAttemptSnapshot(maxCalls: number): AttemptSnapshot {
  return { maxCalls, usedCalls: 0, reservedCalls: 0, remainingCalls: maxCalls };
}

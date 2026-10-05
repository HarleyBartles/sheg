import type { SQLOutputValue } from 'node:sqlite';
import { RunStoreError } from '../../application/run-store.js';

export type DatabaseRow = Record<string, SQLOutputValue>;

export function asText(value: SQLOutputValue | undefined, label: string): string {
  if (typeof value !== 'string') throw new RunStoreError('data_integrity_error', `Stored ${label} is not text.`);
  return value;
}

export function asNullableText(value: SQLOutputValue | undefined, label: string): string | null {
  if (value === null) return null;
  return asText(value, label);
}

export function asNumber(value: SQLOutputValue | undefined, label: string): number {
  if (typeof value !== 'number' && typeof value !== 'bigint') throw new RunStoreError('data_integrity_error', `Stored ${label} is not numeric.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RunStoreError('data_integrity_error', `Stored ${label} is outside the safe integer range.`);
  return number;
}


export function parseJson<T>(value: SQLOutputValue | undefined, label: string): T {
  try { return JSON.parse(asText(value, label)) as T; }
  catch (error) {
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError('data_integrity_error', `Stored ${label} is not valid JSON.`, { cause: error });
  }
}


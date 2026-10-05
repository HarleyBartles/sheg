import type { SQLOutputValue } from 'node:sqlite';
import type { ZodType } from 'zod';
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


export function parseJson(value: SQLOutputValue | undefined, label: string): unknown {
  try { return JSON.parse(asText(value, label)) as unknown; }
  catch (error) {
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError('data_integrity_error', `Stored ${label} is not valid JSON.`, { cause: error });
  }
}

export function parseStored<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RunStoreError('data_integrity_error', `Stored ${label} is invalid.`, { cause: parsed.error });
  return parsed.data;
}

export function parseJsonRecord(value: SQLOutputValue | undefined, label: string): Record<string, unknown> {
  const parsed: unknown = parseJson(value, label);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new RunStoreError('data_integrity_error', `Stored ${label} is not an object.`);
  return parsed as Record<string, unknown>;
}


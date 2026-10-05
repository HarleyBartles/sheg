import { RunStoreError } from '../../application/run-store.js';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T>(value: string, label: string): T {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('Cursor must be an object.');
    return parsed as T;
  }
  catch (error) { throw new RunStoreError('invalid_cursor', `The ${label} cursor is invalid.`, { cause: error }); }
}

export function pageSize(limit: number | undefined): number {
  const size = limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw new RunStoreError('invalid_page_size', `Page size must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return size;
}


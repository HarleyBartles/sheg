import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { ZodType } from 'zod';
import { RunStoreError } from '../../application/run-store.js';

export type QueryRow = Record<string, SQLOutputValue>;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export function createSqliteQuery<Parameters extends SQLInputValue[], Row>(
  name: string,
  parametersSchema: ZodType<Parameters>,
  rowsSchema: ZodType<Row[]>,
) {
  const assetPath = path.join(moduleDirectory, 'queries', `${name}.sql`);
  let sql: string;
  try { sql = readFileSync(assetPath, 'utf8'); }
  catch (error) { throw new RunStoreError('storage_query_unavailable', `The stored query asset ${name} is unavailable.`, { cause: error }); }
  return {
    all(database: DatabaseSync, ...parameters: Parameters): Row[] {
      const boundParameters = parametersSchema.safeParse(parameters);
      if (!boundParameters.success) throw new RunStoreError('invalid_query', `Parameters for stored query ${name} are invalid.`, { cause: boundParameters.error });
      const raw: unknown = database.prepare(sql).all(...boundParameters.data);
      const decoded = rowsSchema.safeParse(raw);
      if (!decoded.success) throw new RunStoreError('data_integrity_error', `Rows returned by stored query ${name} are invalid.`, { cause: decoded.error });
      return decoded.data;
    },
  };
}

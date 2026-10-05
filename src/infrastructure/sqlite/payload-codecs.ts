import { z } from 'zod';
import { RunStoreError } from '../../application/run-store.js';

const envelopeSchema = z.object({
  formatVersion: z.number().int(),
  kind: z.string().min(1),
  value: z.unknown(),
}).strict();

export function encodeStoredPayload<T>(kind: string, value: T, schema: z.ZodType<T>): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RunStoreError('invalid_stored_payload', `Cannot store an invalid ${kind} payload.`);
  return JSON.stringify({ formatVersion: 1, kind, value: parsed.data });
}

export function decodeStoredPayload<T>(json: string, kind: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try { raw = JSON.parse(json) as unknown; }
  catch (error) { throw new RunStoreError('data_integrity_error', `The stored ${kind} payload is not valid JSON.`, { cause: error }); }
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success || envelope.data.kind !== kind) throw new RunStoreError('data_integrity_error', `The stored ${kind} payload has an invalid envelope.`);
  if (envelope.data.formatVersion !== 1) throw new RunStoreError('unsupported_payload_version', `Sheg cannot read unsupported stored ${kind} format version ${envelope.data.formatVersion}.`);
  const parsed = schema.safeParse(envelope.data.value);
  if (!parsed.success) throw new RunStoreError('data_integrity_error', `The stored ${kind} payload has an invalid stored ${kind} value.`);
  return parsed.data;
}

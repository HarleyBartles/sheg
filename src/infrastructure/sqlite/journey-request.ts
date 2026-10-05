import { RunStoreError } from '../../application/run-store.js';
import { hashCanonical } from '../identity.js';
import { runRequestSchema, type ParsedInlineJourneyRequest } from '../../domain/run/request.js';
import { asText, parseJson, type DatabaseRow } from './rows.js';

export type StoredJourneyIdentity = {
  request: ParsedInlineJourneyRequest;
  compilerFingerprint: string;
  requestFingerprint: string;
};

export function storedJourneyIdentity(row: DatabaseRow): StoredJourneyIdentity {
  const stored = parseJson<unknown>(row.request_json, 'request');
  if (typeof stored !== 'object' || stored === null || !('request' in stored) || !('requestFingerprint' in stored) || !('compilerFingerprint' in stored)) {
    throw new RunStoreError('data_integrity_error', 'Stored journey request has an invalid shape.');
  }
  const parsedRequest = runRequestSchema.safeParse(stored.request);
  const requestFingerprint = asText(stored.requestFingerprint as string, 'request fingerprint');
  const compilerFingerprint = asText(stored.compilerFingerprint as string, 'compiler fingerprint');
  if (!parsedRequest.success || parsedRequest.data.kind !== 'journey' || requestFingerprint !== asText(row.request_fingerprint, 'request fingerprint') ||
      hashCanonical({ request: parsedRequest.data, compilerFingerprint }) !== requestFingerprint) {
    throw new RunStoreError('data_integrity_error', 'Stored journey request or fingerprint is invalid.');
  }
  return { request: parsedRequest.data, compilerFingerprint, requestFingerprint };
}

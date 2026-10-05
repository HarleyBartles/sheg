import { RunStoreError } from '../../application/run-store.js';
import { hashCanonical } from '../identity.js';
import { runRequestSchema, type ParsedInlineJourneyRequest } from '../../domain/run/request.js';
import { asText, parseJsonRecord } from './rows.js';

export type StoredJourneyIdentity = {
  request: ParsedInlineJourneyRequest;
  compilerFingerprint: string;
  requestFingerprint: string;
};

export function storedJourneyIdentity(row: Record<string, unknown>): StoredJourneyIdentity {
  const stored = parseJsonRecord(row.request_json, 'request');
  if (!('request' in stored) || !('requestFingerprint' in stored) || !('compilerFingerprint' in stored)) {
    throw new RunStoreError('data_integrity_error', 'Stored journey request has an invalid shape.');
  }
  const parsedRequest = runRequestSchema.safeParse(stored.request);
  if (typeof stored.requestFingerprint !== 'string' || typeof stored.compilerFingerprint !== 'string') throw new RunStoreError('data_integrity_error', 'Stored journey request identity is invalid.');
  const requestFingerprint = asText(stored.requestFingerprint, 'request fingerprint');
  const compilerFingerprint = asText(stored.compilerFingerprint, 'compiler fingerprint');
  if (!parsedRequest.success || parsedRequest.data.kind !== 'journey' || requestFingerprint !== asText(row.request_fingerprint, 'request fingerprint') ||
      hashCanonical({ request: parsedRequest.data, compilerFingerprint }) !== requestFingerprint) {
    throw new RunStoreError('data_integrity_error', 'Stored journey request or fingerprint is invalid.');
  }
  return { request: parsedRequest.data, compilerFingerprint, requestFingerprint };
}

import { hashCanonical } from '../infrastructure/identity.js';
import type { ProviderSelectionPolicySnapshot } from '../domain/run/lifecycle.js';
import type { ParsedRunRequest } from '../domain/run/request.js';

export function providerSelectionFingerprint(request: ParsedRunRequest, snapshot: ProviderSelectionPolicySnapshot): string {
  const requestInputs = { ...request };
  delete requestInputs.expectedSelectionFingerprint;
  return `r${snapshot.catalogueRevision}-${hashCanonical({ policyVersion: snapshot.version, request: requestInputs, snapshot })}`;
}

export function providerSelectionFingerprintRevision(fingerprint: string): number | undefined {
  const match = /^r(\d+)-[a-f\d]{64}$/i.exec(fingerprint);
  return match ? Number(match[1]) : undefined;
}

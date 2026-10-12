import { hashCanonical } from '../infrastructure/identity.js';
import type { ProviderSelectionPolicySnapshot } from '../domain/run/lifecycle.js';
import type { ParsedRunRequest } from '../domain/run/request.js';

export function providerSelectionFingerprint(request: ParsedRunRequest, snapshot: ProviderSelectionPolicySnapshot): string {
  const requestInputs = { ...request };
  delete requestInputs.expectedSelectionFingerprint;
  return hashCanonical({ policyVersion: snapshot.version, request: requestInputs, snapshot });
}

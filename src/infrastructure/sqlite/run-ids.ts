import { RunStoreError } from '../../application/run-store.js';

export function validateRunIds(runIds: string[]): void {
  if (!Array.isArray(runIds) || runIds.length < 1 || runIds.length > 200 || runIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) || new Set(runIds).size !== runIds.length) {
    throw new RunStoreError('invalid_run_selection', 'Select between 1 and 200 unique run IDs.');
  }
}

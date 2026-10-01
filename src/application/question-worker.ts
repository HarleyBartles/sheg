import { setInterval, clearInterval } from 'node:timers';
import type { RunStore } from '../infrastructure/run-store.js';
import { JevCallError } from '../providers/jev.js';
import { LayaCallError } from '../providers/laya.js';
import type { ProviderFactory } from './run-service.js';

const HEARTBEAT_MS = 2_000;
export async function executeQuestionRun(store: RunStore, runId: string, providerFactory: ProviderFactory): Promise<void> {
  const claim = store.claim(runId, Date.now(), process.pid);
  if (!claim) return;
  const heartbeat = setInterval(() => {
    try {
      if (!store.heartbeat(claim, Date.now())) clearInterval(heartbeat);
    } catch { clearInterval(heartbeat); }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const prepared = store.getRequest(runId);
    const provider = providerFactory(prepared.request.provider);
    while (true) {
      if (!store.heartbeat(claim, Date.now())) return;
      const reservation = store.reserveNext(claim, Date.now());
      if (!reservation) break;
      try {
        const result = await provider.decide(reservation.evaluation.packet, 1);
        store.settle(claim, reservation.attemptId, { kind: 'answered', result });
      } catch (error) {
        const scope = error instanceof JevCallError || error instanceof LayaCallError ? error.failureScope : 'evaluation';
        const code = scope === 'run' ? 'provider_unavailable' : 'decision_failed';
        const message = scope === 'run' ? 'Provider authentication or service access failed.' : 'The respondent evaluation did not produce a valid answer.';
        store.settle(claim, reservation.attemptId, { kind: 'failed', code, message, scope });
        if (scope === 'run') break;
      }
    }
    store.finish(claim);
  } catch {
    try { store.failRun(claim, 'worker_failed', 'The run worker stopped unexpectedly.'); } catch { /* Expired ownership is reconciled by a later read. */ }
  } finally {
    clearInterval(heartbeat);
  }
}


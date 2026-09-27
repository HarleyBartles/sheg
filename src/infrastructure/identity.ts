import { createHash } from 'node:crypto';
import type { StudyManifest } from '../domain/study/study.js';
import type { FrozenCohort } from '../domain/respondents/cohort.js';

export type ExecutionProvider =
  | { kind: 'jev'; model: string; keyEnv?: string; endpoint?: string; timeoutMs?: number }
  | { kind: 'laya'; checkpoint: string; contextLimit: number; headLimit: number; tokenizerSha256: string; precision?: string; baseUrl?: string; timeoutMs?: number };

export function stimulusFingerprint(
  study: StudyManifest,
  cohort: FrozenCohort,
  promptContractHash: string,
): string {
  if (!promptContractHash) throw new TypeError('Prompt contract hash is required.');
  return hashCanonical({ version: 1, study, cohort, promptContractHash });
}

export function executionFingerprint(stimulus: string, provider: ExecutionProvider): string {
  if (!/^[a-f\d]{64}$/i.test(stimulus)) throw new TypeError('Stimulus fingerprint must be a SHA-256 hex digest.');
  let decisionSettings: Record<string, string | number | undefined>;
  if (provider.kind === 'jev') {
    decisionSettings = { kind: provider.kind, model: requireText(provider.model, 'Jev model') };
  } else {
    decisionSettings = {
      kind: provider.kind,
      checkpoint: requireText(provider.checkpoint, 'Laya checkpoint'),
      contextLimit: requirePositiveInteger(provider.contextLimit, 'Laya context limit'),
      headLimit: requirePositiveInteger(provider.headLimit, 'Laya head limit'),
      tokenizerSha256: requireText(provider.tokenizerSha256, 'Laya tokenizer SHA-256'),
      ...(provider.precision === undefined ? {} : { precision: provider.precision }),
    };
  }
  return hashCanonical({ version: 1, stimulus, provider: decisionSettings });
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Fingerprint input contains a nonfinite number.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => {
      if (object[key] === undefined) throw new TypeError(`Fingerprint input contains undefined at ${key}.`);
      return [key, canonicalize(object[key])];
    }));
  }
  throw new TypeError('Fingerprint input must contain only JSON values.');
}

function requireText(value: string, label: string): string {
  if (!value.trim()) throw new TypeError(`${label} is required.`);
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

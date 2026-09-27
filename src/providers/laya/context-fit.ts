import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DecisionRequest } from '../../domain/decision/decision.js';
import type { ProviderContextFit } from '../../domain/decision/provider.js';
import type { LayaConfig } from '../laya.js';
import { buildSequence, renderOptions, serializeState, type InternalQ } from './vendor/sequence.js';
import { encodeWithData, parseTokenizerJson, type TokenizerData, type TokenizerLike } from './vendor/tokenizer.js';

export const LAYA_TS_SOURCE_REVISION = 'ec8409e542941bb4bb649d5fec00d4cec96ae024';
export const LAYA_MEASUREMENT_METHOD = `laya-ts@${LAYA_TS_SOURCE_REVISION}`;

const tokenizerCache = new Map<string, { signature: string; loaded: Promise<{ data: TokenizerData; sha256: string }> }>();

async function tokenizerPromise(config: LayaConfig): Promise<{ data: TokenizerData; sha256: string }> {
  const absolutePath = path.resolve(config.tokenizerJsonPath);
  const key = `${absolutePath}:${config.tokenizerSha256.toLowerCase()}`;
  const metadata = await stat(absolutePath, { bigint: true });
  const signature = `${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
  const existing = tokenizerCache.get(key);
  if (existing?.signature === signature) return existing.loaded;
  const loaded = (async () => {
    const bytes = await readFile(absolutePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== config.tokenizerSha256.toLowerCase()) throw new Error('tokenizer-checksum-mismatch');
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new Error('tokenizer-json-invalid');
    }
    const data = parseTokenizerJson(raw);
    if (!data) throw new Error('tokenizer-json-unsupported');
    return { data, sha256 };
  })();
  tokenizerCache.set(key, { signature, loaded });
  return loaded;
}

function unavailable(config: LayaConfig, reason: string, details: Record<string, number | string> = {}): ProviderContextFit {
  return {
    provider: 'laya', status: 'unavailable', method: LAYA_MEASUREMENT_METHOD, modelIdentity: config.checkpoint,
    tokenCount: 'measured', tokens: 0, contextLimit: config.contextLimit, headroomTokens: 0,
    effectiveLimit: config.contextLimit, details, reason,
  };
}

function tokenizerLike(data: TokenizerData): TokenizerLike {
  return {
    clsId: data.ids.cls,
    sepId: data.ids.sep,
    maskId: data.ids.mask,
    padId: data.ids.pad,
    maskToken: data.maskToken,
    encode: (text) => encodeWithData(data, text),
  };
}

export async function measureLayaContext(request: DecisionRequest, config: LayaConfig): Promise<ProviderContextFit> {
  if (!/^[a-f\d]{64}$/i.test(config.tokenizerSha256)) return unavailable(config, 'tokenizer-checksum-invalid');
  let loaded: { data: TokenizerData; sha256: string };
  try {
    loaded = await tokenizerPromise(config);
  } catch (error) {
    return unavailable(config, error instanceof Error ? error.message : 'tokenizer-load-failed');
  }

  const tokenizer = tokenizerLike(loaded.data);
  const question: InternalQ = { t: 'choice', ins: request.question.instructions, crit: request.question.options };
  const fullHead = buildSequence(tokenizer, '', question, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const configuredHead = buildSequence(tokenizer, '', question, Number.MAX_SAFE_INTEGER, config.headLimit);
  const options = renderOptions(question);
  const optionTokenLengths = options.map((option) => tokenizer.encode(` ${option.split(tokenizer.maskToken).join(' ')}`).length);
  const fullState = tokenizer.encode(serializeState(request.state).split(tokenizer.maskToken).join(' '));
  const stateBudget = config.contextLimit - fullHead.ids.length;
  const tokens = fullHead.ids.length + fullState.length;
  const details = {
    tokenizerSha256: loaded.sha256,
    headTokens: fullHead.ids.length,
    headLimit: config.headLimit,
    stateTokens: fullState.length,
    stateBudget: Math.max(0, stateBudget),
    optionTokenLengths: optionTokenLengths.join(','),
  };
  let reason: string | undefined;
  if (optionTokenLengths.some((length) => length > 48)) reason = 'option-would-be-truncated';
  else if (JSON.stringify(fullHead.ids) !== JSON.stringify(configuredHead.ids)) reason = 'instructions-or-options-would-be-truncated';
  else if (fullHead.ids.length > config.contextLimit) reason = 'question-head-exceeds-context';
  else if (fullState.length > stateBudget) reason = 'state-would-be-truncated';

  return {
    provider: 'laya',
    status: reason === undefined ? 'fits' : 'overflow',
    method: LAYA_MEASUREMENT_METHOD,
    modelIdentity: config.checkpoint,
    tokenCount: 'measured',
    tokens,
    contextLimit: config.contextLimit,
    headroomTokens: 0,
    effectiveLimit: config.contextLimit,
    details,
    ...(reason === undefined ? {} : { reason }),
  };
}

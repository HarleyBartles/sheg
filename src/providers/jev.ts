import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { decisionRequestSchema, type DecisionProvider, type DecisionRequest, type DecisionResult } from '../domain/decision/contract.js';
import { DecisionError, validateDecision } from '../domain/decision/validate.js';

export type JevConfig = {
  kind: 'jev';
  model: string;
  keyEnv: string;
  endpoint: string;
  timeoutMs: number;
};

export class JevCallError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly chargeStatus: 'not_billed' | 'unknown' | 'billed',
    readonly chargeUsd?: number,
  ) {
    super(message);
    this.name = 'JevCallError';
  }
}

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string().min(1),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1).optional(),
}).passthrough();

const wireResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cost: z.number().finite().nonnegative().optional(),
  }).passthrough(),
}).passthrough();

const retryableStatuses = new Set([429, 500, 502, 503, 524, 529]);

export class JevProvider implements DecisionProvider {
  constructor(
    private readonly config: JevConfig,
    private readonly fetchRequest: typeof fetch = fetch,
  ) {
    if (config.kind !== 'jev' || !config.model || !config.keyEnv || !config.endpoint ||
        !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1) {
      throw new TypeError('Jev configuration requires a model, key environment name, endpoint, and positive timeout.');
    }
  }

  async decide(request: DecisionRequest, maxAttempts: number): Promise<DecisionResult> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new JevCallError('Jev call limit must be a positive integer.', 0, 'not_billed');
    }
    const parsedRequest = decisionRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new JevCallError('Jev decision request is invalid.', 0, 'not_billed');
    }
    const apiKey = process.env[this.config.keyEnv];
    if (!apiKey) {
      throw new JevCallError(`Jev API key environment variable ${this.config.keyEnv} is not set.`, 0, 'not_billed');
    }

    const { question } = parsedRequest.data;
    const body = JSON.stringify({
      model: this.config.model,
      state: parsedRequest.data.state,
      questions: {
        [question.id]: {
          type: 'choice',
          instructions: question.instructions,
          criteria: question.criteria,
        },
      },
    });
    const startedAt = performance.now();
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts += 1;
      let response: Response;
      try {
        response = await this.fetchRequest(this.config.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
      } catch {
        if (attempts < maxAttempts) {
          await wait(retryDelayMs(attempts));
          continue;
        }
        throw new JevCallError('Jev request failed at the transport boundary; billing is unknown.', attempts, 'unknown');
      }

      if (!response.ok) {
        if (retryableStatuses.has(response.status) && attempts < maxAttempts) {
          await wait(retryDelayMs(attempts));
          continue;
        }
        throw new JevCallError(`Jev request failed with HTTP ${response.status}; billing is unknown.`, attempts, 'unknown');
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new JevCallError('Jev returned an unreadable response; billing is unknown.', attempts, 'unknown');
      }

      const parsedResponse = wireResponseSchema.safeParse(payload);
      if (!parsedResponse.success) {
        throw new JevCallError('Jev response is missing required identity or usage fields; billing is unknown.', attempts, 'unknown');
      }
      const answer = choiceAnswerSchema.safeParse(parsedResponse.data.answers[question.id]);
      if (!answer.success) {
        throw new JevCallError(`Jev response does not contain a valid choice answer for ${question.id}; billing is unknown.`, attempts, 'unknown');
      }
      const cost = parsedResponse.data.usage.cost;
      if (cost === undefined) {
        throw new JevCallError('Jev response did not report usage cost; billing is unknown.', attempts, 'unknown');
      }

      const result: DecisionResult = {
        choice: answer.data.choice,
        probabilities: answer.data.probabilities,
        ...(answer.data.confidence === undefined ? {} : { confidence: answer.data.confidence }),
        attempts,
        provider: 'jev',
        model: parsedResponse.data.model,
        latencyMs: performance.now() - startedAt,
        usage: {
          ...(parsedResponse.data.usage.input_tokens === undefined ? {} : { inputTokens: parsedResponse.data.usage.input_tokens }),
          ...(parsedResponse.data.usage.output_tokens === undefined ? {} : { outputTokens: parsedResponse.data.usage.output_tokens }),
        },
        chargeStatus: 'billed',
        chargeUsd: cost,
      };

      try {
        return validateDecision(request, result, { maxAttempts, provider: 'jev' });
      } catch (error) {
        if (error instanceof DecisionError) {
          throw new JevCallError('Jev response failed decision validation; the reported charge is retained.', attempts, 'billed', cost);
        }
        throw error;
      }
    }

    throw new JevCallError('Jev call limit reached without a response.', attempts, 'unknown');
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(50 * 2 ** (attempt - 1), 1_000);
}

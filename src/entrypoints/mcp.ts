import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRunService, RunServiceError, type RunService } from '../application/run-service.js';
import { resolveDataRoot } from '../infrastructure/data-root.js';
import { openRunStore, RunStoreError } from '../infrastructure/run-store.js';
import { DetachedWorkerLauncher } from '../infrastructure/worker-launcher.js';
import { assertProviderReady, createProvider } from '../providers/factory.js';
import { runEvidenceQuerySchema, runListQuerySchema, runRequestSchema } from '../domain/run/request.js';

const runListSchema = runListQuerySchema;
const runDeleteSchema = z.object({ runIds: z.array(z.string().uuid()).min(1).max(200).refine((ids) => new Set(ids).size === ids.length, 'Run IDs must be unique.'), dryRun: z.boolean().default(false) }).strict();
const runGetSchema = z.discriminatedUnion('view', [
  z.object({ runId: z.string().uuid(), view: z.literal('status') }).strict(),
  z.object({ runId: z.string().uuid(), view: z.literal('request') }).strict(),
  z.object({ runId: z.string().uuid(), view: z.literal('journey') }).strict(),
  z.object({ runId: z.string().uuid(), view: z.literal('answers'), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
  z.object({ runId: z.string().uuid(), view: z.literal('attempts'), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
]);

export function createPollingServer(service: RunService = createDefaultRunService()): McpServer {
  const server = new McpServer({ name: 'sheg', version: '0.3.0' }, { instructions: 'Submit typed question groups, finite journeys, or follow-on requests built from recorded evidence, then recall machine-readable run evidence by run ID. Questions in one group share the same frozen respondent state and never see sibling answers. Inspect before starting. Reads never start or resume work.' });
  server.registerTool('run_inspect', { description: 'Validate a direct typed request, finite respondent journey, or follow-on selection and measure provider context fit without inference or run creation. Independent questions in one group share one frozen state; fit entries identify planned question groups and the minimum physical-call count.', inputSchema: z.object({ request: runRequestSchema }).strict() }, async ({ request }) => safeResult(() => service.inspect(request)));
  server.registerTool('run_start', { description: 'Accept a direct respondent request, finite journey, or follow-on selection as a durable run and return its identity immediately. Multiple independent Choice, Score, or Noul questions share each respondent context and remain separate answers. Sheg batches or splits provider calls within the run-wide physical-attempt limit. For a follow-on, use run_query evaluationId/contextId handles and, when a mapped Choice selection supplies selectedMaterial, pass its materialId in context.materialIds to reuse that exact offered candidate. Use a fresh submission ID; retrying the same ID and request returns the same run.', inputSchema: z.object({ submissionId: z.string().uuid(), request: runRequestSchema }).strict() }, async ({ submissionId, request }) => safeResult(() => service.start(submissionId, request)));
  server.registerTool('run_list', { description: 'Find durable runs in this local Sheg data directory using optional status, label, time, material, and cursor filters.', inputSchema: runListSchema }, async (query) => safeResult(() => service.list(query)));
  server.registerTool('run_query', { description: 'Query typed answers and route outcomes in one run. Results identify per-question evaluation IDs, their shared respondent context, and provider execution evidence for follow-on requests. A Choice answer explicitly linked to a material option also returns selectedMaterial with materialId, exact text, author-supplied sourceId/sourceSha256, and Sheg-computed textSha256; pass materialId in a follow-on context.materialIds to reuse it. Unlinked options, including no-fit, have no selectedMaterial. sourceComplete distinguishes a finished source from matches so far.', inputSchema: runEvidenceQuerySchema }, async (query) => safeResult(() => service.queryEvidence(query)));
  server.registerTool('run_get', { description: 'Retrieve one view of a run: status, frozen request and question groups, paginated per-question answers, physical attempts including uncertain or failed calls, or reached journey contexts and routes. Discovery never launches or resumes work.', inputSchema: runGetSchema }, async (input) => safeResult(() => {
    if (input.view === 'status') return service.getStatus(input.runId);
    if (input.view === 'request') return service.getRequest(input.runId);
    if (input.view === 'journey') return service.getJourneyRun(input.runId);
    if (input.view === 'answers') return service.answers(input.runId, input.cursor, input.limit);
    return service.attempts(input.runId, input.cursor, input.limit);
  }));
  server.registerTool('run_cancel', { description: 'Request cancellation of a run. Any already dispatched physical provider request is allowed to settle; all valid returned sibling answers are retained and later requests are stopped.', inputSchema: z.object({ runId: z.string().uuid() }).strict() }, async ({ runId }) => safeResult(() => service.cancel(runId)));
  server.registerTool('run_resume', { description: 'Explicitly resume eligible interrupted work or retryable partial question failures under the same run ID, saved request, and remaining provider-call allowance. Completed answers are preserved and only unanswered questions are dispatched. Reads never resume work.', inputSchema: z.object({ runId: z.string().uuid() }).strict() }, async ({ runId }) => safeResult(() => service.resume(runId)));
  server.registerTool('run_delete', { description: 'Preview or delete an explicit selection of terminal runs. Preview first when unsure. Active runs must be cancelled and polled to a terminal state before deletion.', inputSchema: runDeleteSchema }, async ({ runIds, dryRun }) => safeResult(() => dryRun ? service.previewDelete(runIds) : service.deleteRuns(runIds)));
  server.registerTool('run_storage', { description: 'Inspect Sheg-managed local datastore health or ask Sheg to optimize it. No file paths or SQL are exposed.', inputSchema: z.object({ operation: z.enum(['inspect', 'optimize']) }).strict() }, async ({ operation }) => safeResult(() => {
    if (operation === 'inspect') return service.storageInfo();
    service.optimizeStorage();
    return { optimized: true };
  }));
  return server;
}

function createDefaultRunService(): RunService {
  const dataRoot = resolveDataRoot(process.env, process.platform, os.homedir());
  const store = openRunStore(dataRoot);
  return createRunService(store, dataRoot, createProvider, new DetachedWorkerLauncher(), { assertProviderReady });
}

async function safeResult(operation: () => unknown | Promise<unknown>) {
  try { return jsonResult(await operation()); }
  catch (error) {
    const code = error instanceof RunServiceError || error instanceof RunStoreError ? error.code : 'internal_error';
    const message = error instanceof RunServiceError || error instanceof RunStoreError ? error.message : 'The Sheg operation failed.';
    const result = { error: { code, message } };
    return { ...jsonResult(result), isError: true };
  }
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) serveStdio(() => createPollingServer(), { onerror: (error) => process.stderr.write(`${error.message}\n`) });

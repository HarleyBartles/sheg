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
import { inlineRunRequestSchema } from '../domain/run/request.js';
import type { RunStatus } from '../domain/run/lifecycle.js';

const statusSchema = z.enum(['prepared', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const runListSchema = z.object({ status: statusSchema.optional(), label: z.string().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).strict();
const runGetSchema = z.discriminatedUnion('view', [
  z.object({ runId: z.string().uuid(), view: z.literal('status') }).strict(),
  z.object({ runId: z.string().uuid(), view: z.literal('request') }).strict(),
  z.object({ runId: z.string().uuid(), view: z.literal('answers'), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
]);

export function createPollingServer(service: RunService = createDefaultRunService()): McpServer {
  const server = new McpServer({ name: 'sheg', version: '0.3.0' }, { instructions: 'Submit typed respondent requests, then recall machine-readable run evidence by run ID. Inspect before starting. Reads never start or resume work.' });
  server.registerTool('run_inspect', { description: 'Validate a direct typed respondent request and measure context fit without inference, persistence, or worker launch.', inputSchema: z.object({ request: inlineRunRequestSchema }).strict() }, async ({ request }) => safeResult(() => service.inspect(request)));
  server.registerTool('run_start', { description: 'Accept a direct respondent request as a durable run and return its identity immediately. Use a fresh submission ID; retrying the same ID and request returns the same run.', inputSchema: z.object({ submissionId: z.string().uuid(), request: inlineRunRequestSchema }).strict() }, async ({ submissionId, request }) => safeResult(() => service.start(submissionId, request)));
  server.registerTool('run_list', { description: 'Find durable runs in this local Sheg data directory using optional status, label, and cursor filters.', inputSchema: runListSchema }, async (query) => safeResult(() => service.list(query as { status?: RunStatus; label?: string; cursor?: string; limit?: number })));
  server.registerTool('run_get', { description: 'Retrieve exactly one view of a run: status, the frozen request, or paginated respondent answers. Discovery never launches or resumes work.', inputSchema: runGetSchema }, async (input) => safeResult(() => {
    if (input.view === 'status') return service.getStatus(input.runId);
    if (input.view === 'request') return service.getRequest(input.runId);
    return service.answers(input.runId, input.cursor, input.limit);
  }));
  server.registerTool('run_cancel', { description: 'Request cancellation of a run. Any already dispatched respondent call is allowed to settle and its answer is retained.', inputSchema: z.object({ runId: z.string().uuid() }).strict() }, async ({ runId }) => safeResult(() => service.cancel(runId)));
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

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RunServiceError, type RunService } from '../application/run-service.js';
import { RunStoreError } from '../infrastructure/run-store.js';
import { createRunRuntime } from '../infrastructure/run-runtime.js';
import { dispatchRunGet, resetConfirmation, runStorageSchema, runDeleteSchema, runGetSchema } from '../application/run-operations.js';
import { runEvidenceQuerySchema, runListQuerySchema, runRequestSchema } from '../domain/run/request.js';
import { productVersion } from '../infrastructure/product-identity.js';
import { ImageAssetError, ImageGetRequestSchema, ImageImportRequestSchema, ScaleRequestSchema, type ImageSource } from '../domain/assets/image.js';
import type { StaticImageCodec } from '../infrastructure/images/codecs.js';
import { manageProviderCredential, providerCredentialRequestSchema, ProviderCredentialOperationError, type ProviderCredentialStore } from '../application/provider-credentials.js';
import { providerSettingsOperationSchema } from '../application/provider-settings.js';
import { WindowsCredentialStore } from '../infrastructure/credentials/windows.js';

const runListSchema = runListQuerySchema;
export function createPollingServer(service?: RunService, dataRoot?: string, imageCodec?: StaticImageCodec, credentialStore: ProviderCredentialStore = new WindowsCredentialStore()): McpServer {
  const runtime = createRunRuntime(dataRoot, service, imageCodec === undefined ? {} : { imageCodec });
  const server = new McpServer({ name: 'sheg', version: productVersion }, { instructions: 'Submit typed question groups, finite journeys, or follow-on requests built from recorded evidence, then recall machine-readable run evidence by run ID. Questions in one group share the same frozen respondent state and never see sibling answers. A journey fork gives every respondent who reaches its settled boundary one isolated branch per authored condition; matching comparisonKey tasks appear as complete or incomplete pairs in run_get view journey. Use run_inspect when a fit preview would help; run_start validates admission itself. Reads never start or resume work.' });
  server.registerTool('provider_credential', { description: 'Check, set up, or remove a provider API key in Windows Credential Manager. Setup reads the secret through Sheg secure input; secrets are never accepted as tool input or returned. Clef always uses its fixed Cloudflare credential target.', inputSchema: providerCredentialRequestSchema }, async (input) => safeResult(() => manageProviderCredential(input, credentialStore)));
  server.registerTool('provider_settings', { description: 'Read or replace the enabled provider catalogue and preference order using an expected revision. Settings contain provider configuration only; API keys remain in Windows Credential Manager and are never accepted or returned here.', inputSchema: providerSettingsOperationSchema }, async (input) => safeResult(() => runtime.service.providerSettings(input)));
  server.registerTool('run_inspect', { description: 'Validate a direct typed request, finite respondent journey, or follow-on selection and measure provider context fit without inference or run creation. Journey fit is measured for initial respondent inputs; each later reached turn is checked immediately before inference and may stop only that respondent if it does not fit. Inspection shows initial automatic provider choices and marks later journey units whose reached context is not yet known. A matched fork waits for its upstream cohort to settle, then sends each arrived respondent through every authored condition with isolated histories. Matching comparisonKey questions use one common provider/model when automatic selection is enabled. Independent questions in one group share one frozen state; fit entries identify measured inputs and the minimum physical-call count.', inputSchema: z.object({ request: runRequestSchema }).strict() }, async ({ request }) => safeResult(() => runtime.service.inspect(request)));
  server.registerTool('run_start', { description: 'Accept a direct respondent request, finite journey, or follow-on selection as a durable run and return its identity immediately. Multiple independent Choice, Score, or Noul questions share each respondent context and remain separate answers. A matched fork runs every reached respondent through each authored condition; give equivalent condition questions the same comparisonKey. Sheg batches or splits provider calls within the run-wide physical-attempt limit and uses one common provider/model across a matched key when automatic selection is enabled. For a follow-on, use run_query evaluationId/contextId handles and, when a mapped Choice selection supplies selectedMaterial, pass its materialId in context.materialIds to reuse that exact offered text candidate. To reuse an image, reference its materialId in context.materialIds and bind it to the follow-on pixel question; image choices are never returned as text selectedMaterial. Use a fresh submission ID; retrying the same ID and request returns the same run.', inputSchema: z.object({ submissionId: z.string().uuid(), request: runRequestSchema }).strict() }, async ({ submissionId, request }) => safeResult(() => runtime.service.start(submissionId, request)));
  server.registerTool('run_list', { description: 'Find durable runs in this local Sheg data directory using optional status, label, time, material, and cursor filters.', inputSchema: runListSchema }, async (query) => safeResult(() => runtime.service.list(query)));
  server.registerTool('run_query', { description: 'Query typed answers and route outcomes in one run. Results identify per-question evaluation IDs, their shared respondent context, and provider execution evidence for follow-on requests. A Choice answer explicitly linked to a material option also returns selectedMaterial with materialId, exact text, author-supplied sourceId/sourceSha256, and Sheg-computed textSha256; pass materialId in a follow-on context.materialIds to reuse it. Unlinked options, including no-fit, have no selectedMaterial. sourceComplete means the run reached completed; lifecycle explains whether execution is active, stopped, or complete and whether explicit resume is currently eligible. coverage describes the whole run; matchedCoverage describes only rows matching these query criteria, including represented respondents and mapped selected materials. Call totals do not measure input diversity.', inputSchema: runEvidenceQuerySchema }, async (query) => safeResult(() => runtime.service.queryEvidence(query)));
  server.registerTool('run_get', { description: 'Retrieve run status, frozen request, bounded exact context detail by evaluationId/contextId, paginated answers or physical attempts, or journey contexts and routes. The journey view includes fork cohorts and comparisonKey pair evidence with each condition status, exact packet/provider evidence, and total, complete, and incomplete pair counts. Discovery never launches or resumes work.', inputSchema: runGetSchema }, async (input) => safeResult(() => {
    return dispatchRunGet(input, runtime.service);
  }));
  server.registerTool('run_cancel', { description: 'Request cancellation of a run. Any already dispatched physical provider request is allowed to settle; all valid returned sibling answers are retained and later requests are stopped.', inputSchema: z.object({ runId: z.string().uuid() }).strict() }, async ({ runId }) => safeResult(() => runtime.service.cancel(runId)));
  server.registerTool('run_resume', { description: 'Explicitly resume eligible interrupted work, retryable partial question failures, or respondent-local failures in eligible partial journeys under the same run ID, saved request, and original call allowance. Completed answers and reached journey paths are preserved; only eligible failed work is retried. Reads never resume work.', inputSchema: z.object({ runId: z.string().uuid() }).strict() }, async ({ runId }) => safeResult(() => runtime.service.resume(runId)));
  server.registerTool('run_delete', { description: 'Preview or delete an explicit selection of terminal runs. Preview first when unsure. Active runs must be cancelled and polled to a terminal state before deletion.', inputSchema: runDeleteSchema }, async ({ runIds, dryRun }) => safeResult(() => dryRun ? runtime.service.previewDelete(runIds) : runtime.service.deleteRuns(runIds)));
  server.registerTool('run_storage', { description: `Inspect datastore compatibility and recovery state or optimize a healthy datastore. When recovery is required, explicitly reset only after reviewing status and setting confirmation to ${resetConfirmation}; Sheg preserves the original database files before replacing the active store. No credentials or SQL are exposed.`, inputSchema: runStorageSchema }, async (input) => safeResult(() => runtime.storage(input)));
  server.registerTool('image_import', { description: 'Import and validate exact image bytes into Sheg asset custody. Provide either an absolute local path with its expected SHA-256 or a saved asset reference. No model is called.', inputSchema: ImageImportRequestSchema }, async ({ source }) => safeResult(() => {
    requireAbsoluteMcpSource(source);
    return runtime.image.import(source);
  }));
  server.registerTool('image_scale', { description: 'Create a proportional static image candidate from a verified local image or saved asset. maxBytes applies only to image bytes, not model context fit. No crop, format change, quality control or model call is performed.', inputSchema: ScaleRequestSchema }, async (request) => safeResult(() => {
    requireAbsoluteMcpSource(request.source);
    return runtime.image.scale(request);
  }));
  server.registerTool('image_get', { description: 'Read saved image metadata without processing or exporting it. Set export true to write or reuse a digest-named local preview under Sheg storage.', inputSchema: ImageGetRequestSchema }, async ({ assetId, export: includePreview }) => safeResult(() => includePreview ? runtime.image.export(assetId) : { asset: runtime.image.get(assetId) }));
  const close = server.close.bind(server);
  server.close = async () => {
    runtime.close();
    await close();
  };
  return server;
}

async function safeResult(operation: () => unknown | Promise<unknown>) {
  try { return jsonResult(await operation()); }
  catch (error) {
    const code = error instanceof RunServiceError || error instanceof RunStoreError || error instanceof ImageAssetError || error instanceof ProviderCredentialOperationError ? error.code : 'internal_error';
    const message = error instanceof RunServiceError || error instanceof RunStoreError || error instanceof ImageAssetError || error instanceof ProviderCredentialOperationError ? error.message : 'The Sheg operation failed.';
    const result = { error: { code, message } };
    return { ...jsonResult(result), isError: true };
  }
}

function requireAbsoluteMcpSource(source: ImageSource): void {
  if ('path' in source && !path.isAbsolute(source.path)) throw new ImageAssetError('image_source_path_invalid', 'MCP image file sources must use an absolute path.');
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) serveStdio(() => createPollingServer(), { onerror: (error) => process.stderr.write(`${error.message}\n`) });

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { traceStudy } from '../domain/journey/trace.js';
import { loadStudy } from '../infrastructure/study-loader.js';
import { RunManager, checkStudy, type RunConfig } from '../application/run-manager.js';
import { compareReports, compareRunReports, getReport } from '../application/reports.js';
import { preflightStudy, preflightInputSchema, type StudyPreflightInput } from '../application/preflight.js';
import { previewStudy } from '../application/study-preview.js';
import { measurePacketBatch, packetSizingInputSchema, type PacketSizingInput } from '../application/packet-sizing.js';
import { decisionValueSchema } from '../domain/decision/decision.js';

const configSchema = z.object({
  manifestPath: z.string(), cohortPath: z.string(), outputDirectory: z.string(), maxCalls: z.number().int().positive(),
  maxUsd: z.number().positive().optional(), maxPerCallUsd: z.number().positive().optional(), concurrency: z.number().int().positive().max(64).default(1),
  provider: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('jev'), model: z.string(), keyEnv: z.string(), endpoint: z.string().url(), timeoutMs: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal('laya'), baseUrl: z.string().url(), checkpoint: z.string(), contextLimit: z.number().int().positive(), headLimit: z.number().int().positive(), tokenizerJsonPath: z.string().min(1), tokenizerSha256: z.string().regex(/^[a-f\d]{64}$/i), precision: z.string().optional(), timeoutMs: z.number().int().positive() }).strict(),
  ]),
}).strict();

export function createPollingServer(manager = new RunManager()): McpServer {
  const server = new McpServer({ name: 'sheg', version: '0.1.0' }, { instructions: 'Polling decisions are simulations. Check and trace do not contact a provider. Hosted runs require explicit call and spend caps. Reports describe simulated responses, not readership or publication outcomes.' });
  server.registerTool('poll_capabilities', { description: 'Describe Sheg task types, journey and history controls, cohort inputs, provider constraints, and comparison behavior in semantic terms before study authoring.', inputSchema: {} }, async () => jsonResult(capabilityCatalog));
  server.registerTool('poll_preview', { description: 'Preview every branch from the manifest, including authored stimulus and question wording, choices and destinations, shared continuations, each route’s prior choices, and the stimulus IDs in scope at each question. Requires no cohort or inference-provider call. Rejects previews above 10,000 route contexts instead of returning a partial result.', inputSchema: { manifestPath: z.string().min(1) } }, async ({ manifestPath }) => jsonResult(await previewStudy(manifestPath)));
  server.registerTool('poll_check', { description: 'Validate a manifest, frozen cohort, sources, and explicit provider config without provider calls. Return deterministic minimum/maximum reachable decision-call counts, whether maxCalls covers the maximum, and for Jev a configured spend ceiling, not a predicted charge.', inputSchema: { config: configSchema } }, async ({ config }) => {
    const checked = await checkStudy(config as RunConfig);
    return jsonResult({ valid: true, respondentCount: checked.study.respondents.length, armCount: checked.study.manifest.arms.length, sourceHashes: checked.study.sources.map((source) => source.sha256), stimulusFingerprint: checked.stimulusFingerprint, executionFingerprint: checked.executionFingerprint, runBounds: checked.runBounds });
  });
  server.registerTool('poll_preflight', { description: 'Measure every reachable decision packet for a frozen cohort or maximum valid profile envelope against configured providers without inference calls or run creation.', inputSchema: preflightInputSchema.shape }, async (input) => jsonResult(await preflightStudy(input as StudyPreflightInput)));
  server.registerTool('poll_measure_packets', {
    description: 'Measure complete respondent decision packets for draft variants without inference calls. In paired mode, same-index values from multi-valued dimensions form each case; singleton dimensions broadcast, and multi-valued dimensions must have the same length or validation fails (for example, 3 profiles with 2 task drafts). Cartesian mode measures every combination (3 profiles by 2 tasks produces 6 cases). Returns each case and provider-specific largest case, measured or estimated tokens, headroom, fit status, and provider reason.',
    inputSchema: packetSizingInputSchema.shape,
  }, async (input) => jsonResult(await measurePacketBatch(input as PacketSizingInput)));
  server.registerTool('poll_trace', { description: 'Trace scripted Choice option IDs or typed Choice, Score, and Noul responses through one frozen respondent and study arm without provider calls. Supply exactly one of choices or responses.', inputSchema: { manifestPath: z.string(), cohortPath: z.string(), armId: z.string(), respondentId: z.string(), choices: z.array(z.string()).optional(), responses: z.array(decisionValueSchema).optional() } }, async ({ manifestPath, cohortPath, armId, respondentId, choices, responses }) => {
    if ((choices === undefined) === (responses === undefined)) throw new Error('Supply exactly one of choices or responses.');
    const study = await loadStudy(manifestPath, cohortPath);
    const profile = study.respondents.find((respondent) => respondent.id === respondentId);
    const arm = study.manifest.arms.find((candidate) => candidate.id === armId);
    if (!profile || !arm) throw new Error('Arm or respondent ID is not in the study inputs.');
    return jsonResult(await traceStudy(arm, profile, choices ?? responses!));
  });
  server.registerTool('poll_start', { description: 'Start a durable polling run. Returns immediately with its run ID.', inputSchema: { config: configSchema } }, async ({ config }) => jsonResult(await manager.startRun(config as RunConfig)));
  server.registerTool('poll_status', { description: 'Read run status and recover abandoned running state.', inputSchema: { outputDirectory: z.string(), runId: z.string().uuid() } }, async ({ outputDirectory, runId }) => jsonResult(await manager.runStatus(outputDirectory, runId)));
  server.registerTool('poll_cancel', { description: 'Request cancellation and wait for in-flight decisions to settle.', inputSchema: { outputDirectory: z.string(), runId: z.string().uuid() } }, async ({ outputDirectory, runId }) => jsonResult(await manager.cancelRun(outputDirectory, runId)));
  server.registerTool('poll_reconcile', { description: 'Record the user-verified total provider charge for uncertain Jev calls in a stopped run, then clear its billing block.', inputSchema: { outputDirectory: z.string(), runId: z.string().uuid(), unpricedUsd: z.number().finite().nonnegative() } }, async ({ outputDirectory, runId, unpricedUsd }) => jsonResult(await manager.reconcileRun(outputDirectory, runId, unpricedUsd)));
  server.registerTool('poll_resume', { description: 'Resume a partial run after validating the frozen inputs and execution fingerprint.', inputSchema: { outputDirectory: z.string(), runId: z.string().uuid() } }, async ({ outputDirectory, runId }) => jsonResult(await manager.resumeRun(outputDirectory, runId)));
  server.registerTool('poll_report', { description: 'Build a JSON-safe report from the durable checkpoint.', inputSchema: { outputDirectory: z.string(), runId: z.string().uuid() } }, async ({ outputDirectory, runId }) => jsonResult(await getReport(outputDirectory, runId)));
  server.registerTool('poll_compare', { description: 'Compare two arms from one durable run by matched respondent and task comparison keys.', inputSchema: { outputDirectory: z.string(), runId: z.string().uuid(), leftArmId: z.string(), rightArmId: z.string() } }, async ({ outputDirectory, runId, leftArmId, rightArmId }) => jsonResult(compareReports(await getReport(outputDirectory, runId), leftArmId, rightArmId)));
  server.registerTool('poll_compare_runs', { description: 'Compare selected arms from two independent runs over the exact same frozen respondent cohort. Only tasks with the same comparisonKey, occurrence, type, and authored meaning are pooled. Descriptive simulated responses only.', inputSchema: { leftOutputDirectory: z.string(), leftRunId: z.string().uuid(), leftArmId: z.string(), rightOutputDirectory: z.string(), rightRunId: z.string().uuid(), rightArmId: z.string() } }, async ({ leftOutputDirectory, leftRunId, leftArmId, rightOutputDirectory, rightRunId, rightArmId }) => jsonResult(compareRunReports(await getReport(leftOutputDirectory, leftRunId), leftArmId, await getReport(rightOutputDirectory, rightRunId), rightArmId)));
  return server;
}

function jsonResult(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> }; }

const capabilityCatalog = {
  tasks: [
    { type: 'choice', meaning: 'Select one stable option ID.', evidence: ['selected option', 'option probabilities', 'optional confidence'], routing: 'Option ID transitions.' },
    { type: 'score', meaning: 'Rate against an ordered rubric of at least two levels.', evidence: ['expected score from level 0 through the final level', 'per-level probabilities', 'rubric legend'], routing: 'Explicit non-overlapping intervals covering the full rubric score range.' },
    { type: 'noul', meaning: 'Judge whether a proposition is true.', evidence: ['P(true) from 0 through 1'], routing: 'Explicit non-overlapping intervals covering [0, 1].' },
  ],
  journeys: {
    shapes: ['single task', 'ordered sequence', 'finite acyclic graph with conditional routes'],
    responseHistory: { default: 'include', choices: ['include', 'omit'], scope: 'Per task. Omission removes prior responses but retains stimulus exposure context.' },
    eligibility: 'Graph routes independently determine which respondents reach later tasks. Each respondent sees only their own history.',
  },
  cohort: { input: 'Ordered frozen respondent profiles, optionally created from archetypes and declared variations.', profileFields: ['intent', 'context', 'desired_outcome', 'engagement_cues', 'friction_cues'] },
  stimulus: { ownership: 'The agent and human choose editorial cuts and preserve authored text.', shegSupport: 'Provider and token-size guidance plus exact packet preflight; no inferred editorial boundaries or silent rewriting.' },
  providers: {
    jev: { typedTasks: ['choice', 'score', 'noul'], preflight: 'Token estimate is supported only for the configured typesafe/jev-1.13 model.' },
    laya: { typedTasks: ['choice', 'score', 'noul'], preflight: 'Uses the configured local checkpoint tokenizer and context limits. The deployed service revision must match the documented System One wire contract.' },
    enforcement: 'Provider and task compatibility is measured or rejected before inference when possible; unknown fit is never reported as fit.',
  },
  comparison: {
    withinRun: 'Compare selected arms by respondent, comparisonKey, and occurrence.',
    crossRun: 'Compare selected arms from separate runs only when the exact ordered frozen cohort matches. Typed results are comparable only when task type and authored meanings align. The result includes source, stimulus, task, provider, run-status, completion, and declared profile-group differences.',
    profileGroups: 'Declared archetype and variation groups include their denominators and response coverage.',
    limitation: 'Comparisons describe simulated model responses; they do not establish human readership, statistical significance, or causal lift.',
  },
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) serveStdio(() => createPollingServer(), { onerror: (error) => process.stderr.write(`${error.message}\n`) });

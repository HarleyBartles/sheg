import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRespondents } from '../domain/respondents/cohort.js';
import { traceStudy } from '../domain/journey/trace.js';
import { loadStudy } from '../domain/study/load-study.js';
import { RunManager, checkStudy, type RunConfig } from '../application/jobs.js';
import { compareReports, getReport } from '../application/reports.js';

const configSchema = z.object({
  manifestPath: z.string(), cohortPath: z.string(), outputDirectory: z.string(), maxCalls: z.number().int().positive(),
  maxUsd: z.number().positive().optional(), maxPerCallUsd: z.number().positive().optional(), concurrency: z.number().int().positive().max(64).default(1),
  provider: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('jev'), model: z.string(), keyEnv: z.string(), endpoint: z.string().url(), timeoutMs: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal('laya'), baseUrl: z.string().url(), checkpoint: z.string(), contextLimit: z.number().int().positive(), precision: z.string().optional(), timeoutMs: z.number().int().positive() }).strict(),
  ]),
}).strict();

export function createPollingServer(manager = new RunManager()): McpServer {
  const server = new McpServer({ name: 'system-one-polling', version: '0.1.0' }, { instructions: 'Polling decisions are simulations. Check and trace do not contact a provider. Hosted runs require explicit call and spend caps. Reports describe simulated responses, not readership or publication outcomes.' });
  server.registerTool('poll_check', { description: 'Validate a manifest, frozen cohort, sources, and explicit provider config without provider calls.', inputSchema: { config: configSchema } }, async ({ config }) => {
    const checked = await checkStudy(config as RunConfig);
    return jsonResult({ valid: true, respondentCount: checked.study.respondents.length, armCount: checked.study.manifest.arms.length, sourceHashes: checked.study.sources.map((source) => source.sha256), stimulusFingerprint: checked.stimulusFingerprint, executionFingerprint: checked.executionFingerprint });
  });
  server.registerTool('poll_trace', { description: 'Trace scripted option IDs through one frozen respondent and study arm without provider calls.', inputSchema: { manifestPath: z.string(), cohortPath: z.string(), armId: z.string(), respondentId: z.string(), choices: z.array(z.string()) } }, async ({ manifestPath, cohortPath, armId, respondentId, choices }) => {
    const study = await loadStudy(manifestPath, cohortPath);
    const cohort = loadRespondents(JSON.parse(await readFile(cohortPath, 'utf8')));
    const profile = cohort.find((respondent) => respondent.id === respondentId);
    const arm = study.manifest.arms.find((candidate) => candidate.id === armId);
    if (!profile || !arm) throw new Error('Arm or respondent ID is not in the study inputs.');
    return jsonResult(await traceStudy(arm, profile, choices));
  });
  server.registerTool('poll_start', { description: 'Start a durable polling run. Returns immediately with its run ID.', inputSchema: { config: configSchema } }, async ({ config }) => jsonResult(await manager.startRun(config as RunConfig)));
  server.registerTool('poll_status', { description: 'Read run status and recover abandoned running state.', inputSchema: { outputDirectory: z.string(), runId: z.string().uuid() } }, async ({ outputDirectory, runId }) => jsonResult(await manager.runStatus(outputDirectory, runId)));
  server.registerTool('poll_cancel', { description: 'Request cancellation and wait for in-flight decisions to settle.', inputSchema: { outputDirectory: z.string(), runId: z.string().uuid() } }, async ({ outputDirectory, runId }) => jsonResult(await manager.cancelRun(outputDirectory, runId)));
  server.registerTool('poll_resume', { description: 'Resume a partial run after validating the frozen inputs and execution fingerprint.', inputSchema: { outputDirectory: z.string(), runId: z.string().uuid() } }, async ({ outputDirectory, runId }) => jsonResult(await manager.resumeRun(outputDirectory, runId)));
  server.registerTool('poll_report', { description: 'Build a JSON-safe report from the durable checkpoint.', inputSchema: { outputDirectory: z.string(), runId: z.string().uuid() } }, async ({ outputDirectory, runId }) => jsonResult(await getReport(outputDirectory, runId)));
  server.registerTool('poll_compare', { description: 'Compare two arms from one durable run by matched respondent and task comparison keys.', inputSchema: { outputDirectory: z.string(), runId: z.string().uuid(), leftArmId: z.string(), rightArmId: z.string() } }, async ({ outputDirectory, runId, leftArmId, rightArmId }) => jsonResult(compareReports(await getReport(outputDirectory, runId), leftArmId, rightArmId)));
  return server;
}

function jsonResult(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> }; }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) serveStdio(() => createPollingServer(), { onerror: (error) => process.stderr.write(`${error.message}\n`) });

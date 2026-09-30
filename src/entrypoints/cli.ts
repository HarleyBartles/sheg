import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { traceStudy } from '../domain/journey/trace.js';
import { loadStudy } from '../infrastructure/study-loader.js';
import { RunManager, checkStudy, type RunConfig } from '../application/run-manager.js';
import { compareReports, compareRunReports, getReport } from '../application/reports.js';
import { preflightStudy, type PreflightProviderConfig } from '../application/preflight.js';
import { decisionValueSchema, type DecisionValue } from '../domain/decision/decision.js';

const manager = new RunManager();

export async function runCli(args: readonly string[], io = { out: (value: string) => process.stdout.write(`${value}\n`), error: (value: string) => process.stderr.write(`${value}\n`) }, runManager = manager): Promise<number> {
  try {
    const [command, ...rest] = args;
    const options = parseArgs(rest);
    let result: unknown;
    if (command === '--help' || command === 'help' || command === undefined) { io.out(helpText); return 0; }
    if (command === 'preflight') {
      if (options.mode !== undefined && options.mode !== 'frozen-cohort' && options.mode !== 'maximum-profile') {
        throw new Error('Preflight --mode must be frozen-cohort or maximum-profile.');
      }
      const providers = JSON.parse(await readFile(required(options, 'providers'), 'utf8')) as PreflightProviderConfig[];
      const mode = options.mode === 'maximum-profile' ? 'maximum-profile' : 'frozen-cohort';
      result = await preflightStudy({ manifestPath: path.resolve(required(options, 'manifest')), ...(options.cohort === undefined ? {} : { cohortPath: path.resolve(options.cohort) }), mode, providers });
    }
    else if (command === 'check' || command === 'start') {
      const config = JSON.parse(await readFile(required(options, 'config'), 'utf8')) as RunConfig;
      result = command === 'check' ? await checkStudy(config).then(({ study, stimulusFingerprint, executionFingerprint }) => ({ valid: true, respondentCount: study.respondents.length, armCount: study.manifest.arms.length, sourceHashes: study.sources.map((source) => source.sha256), stimulusFingerprint, executionFingerprint })) : await runManager.startRun(config);
    } else if (command === 'trace') {
      const manifestPath = path.resolve(required(options, 'manifest'));
      const cohortPath = path.resolve(required(options, 'cohort'));
      const study = await loadStudy(manifestPath, cohortPath);
      const profile = study.respondents.find((respondent) => respondent.id === required(options, 'respondent'));
      if (!profile) throw new Error('Respondent ID is not in the frozen cohort.');
      if ((options.choices === undefined) === (options.responses === undefined)) {
        throw new Error('Trace requires exactly one of --choices or --responses.');
      }
      const scripted: readonly string[] | readonly DecisionValue[] = options.responses === undefined
        ? required(options, 'choices').split(',').filter(Boolean)
        : parseResponses(options.responses);
      const arm = study.manifest.arms.find((candidate) => candidate.id === required(options, 'arm'));
      if (!arm) throw new Error('Arm ID is not in the study.');
      result = await traceStudy(arm, profile, scripted);
    } else if (command === 'status') result = await runManager.runStatus(required(options, 'output'), required(options, 'run-id'));
    else if (command === 'cancel') result = await runManager.cancelRun(required(options, 'output'), required(options, 'run-id'));
    else if (command === 'reconcile') result = await runManager.reconcileRun(required(options, 'output'), required(options, 'run-id'), Number(required(options, 'unpriced-usd')));
    else if (command === 'resume') result = await runManager.resumeRun(required(options, 'output'), required(options, 'run-id'));
    else if (command === 'report') result = await getReport(required(options, 'output'), required(options, 'run-id'));
    else if (command === 'compare') {
      const report = await getReport(required(options, 'output'), required(options, 'run-id'));
      result = compareReports(report, required(options, 'left-arm'), required(options, 'right-arm'));
    } else if (command === 'compare-runs') {
      const left = await getReport(required(options, 'left-output'), required(options, 'left-run-id'));
      const right = await getReport(required(options, 'right-output'), required(options, 'right-run-id'));
      result = compareRunReports(left, required(options, 'left-arm'), right, required(options, 'right-arm'));
    } else throw new Error(`Unknown command: ${command}`);
    io.out(JSON.stringify(result));
    return 0;
  } catch (error) {
    io.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
    return 1;
  }
}

const helpText = `sheg <command>
Commands:
  preflight --manifest <json> [--cohort <json>] [--mode frozen-cohort|maximum-profile] --providers <json-file>
  check --config <json>                         Validate study and provider configuration
  trace --manifest <json> --cohort <json> --arm <id> --respondent <id> (--choices <a,b,...> | --responses <json-array>)
  start --config <json>                         Start a durable run
  status|cancel|resume --output <dir> --run-id <id>
  reconcile --output <dir> --run-id <id> --unpriced-usd <amount>
  report --output <dir> --run-id <id>
  compare --output <dir> --run-id <id> --left-arm <id> --right-arm <id>
  compare-runs --left-output <dir> --left-run-id <id> --left-arm <id> --right-output <dir> --right-run-id <id> --right-arm <id>`;

function parseArgs(args: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith('--')) throw new Error(`Expected an option, got ${key ?? 'end of input'}.`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Option ${key} requires a value.`);
    options[key.slice(2)] = value;
  }
  return options;
}

function required(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) throw new Error(`Missing --${key}.`);
  return value;
}

function parseResponses(value: string): DecisionValue[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('--responses must be a JSON array of typed response values.'); }
  if (!Array.isArray(parsed)) throw new Error('--responses must be a JSON array of typed response values.');
  return parsed.map((response, index) => {
    const result = decisionValueSchema.safeParse(response);
    if (!result.success) throw new Error(`--responses[${index}] is not a valid typed response.`);
    return result.data;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}

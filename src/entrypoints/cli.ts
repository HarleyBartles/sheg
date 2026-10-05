import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { traceStudy } from '../domain/journey/trace.js';
import { loadStudy } from '../infrastructure/study-loader.js';
import { preflightStudy, type PreflightProviderConfig } from '../application/preflight.js';
import { decisionValueSchema, type DecisionValue } from '../domain/decision/decision.js';
import { runEvidenceQuerySchema, runListQuerySchema, runRequestSchema } from '../domain/run/request.js';
import { dispatchRunGet, runDeleteSchema, runGetSchema, runStorageSchema, type StorageOperation } from '../application/run-operations.js';
import { createRunRuntime } from '../infrastructure/run-runtime.js';
import { RunServiceError } from '../application/run-service.js';
import { WindowsCredentialStore } from '../infrastructure/credentials/windows.js';
import { RunStoreError } from '../infrastructure/run-store.js';
import type { RunService } from '../application/run-service.js';

type CliIo = { out(value: string): unknown; error(value: string): unknown };
const outputIo: CliIo = { out: (value) => process.stdout.write(`${value}\n`), error: (value) => process.stderr.write(`${value}\n`) };

export async function runCli(args: readonly string[], io: CliIo = outputIo, service?: RunService): Promise<number> {
  const [command, ...rest] = args;
  if (command === '--help' || command === 'help' || command === undefined) { io.out(helpText); return 0; }
  try {
    const options = parseArgs(rest);
    validateOptions(command, options);
    if (command === 'preflight') {
      const mode = options.mode ?? 'frozen-cohort';
      if (mode !== 'frozen-cohort' && mode !== 'maximum-profile') throw new CliInputError('Preflight mode must be frozen-cohort or maximum-profile.');
      const providers = await readJson<PreflightProviderConfig[]>(required(options, 'providers'));
      const result = await preflightStudy({ manifestPath: path.resolve(required(options, 'manifest')), ...(options.cohort === undefined ? {} : { cohortPath: path.resolve(options.cohort) }), mode, providers }, { credentialStore: new WindowsCredentialStore() });
      io.out(JSON.stringify(result));
      return 0;
    }
    if (command === 'trace') {
      const result = await trace(options);
      io.out(JSON.stringify(result));
      return 0;
    }
    const runtime = createRunRuntime(options['data-root'] === undefined ? undefined : path.resolve(options['data-root']), service);
    try {
      const result = await durableOperation(command ?? '', options, runtime.service, runtime.storage);
      io.out(JSON.stringify(result));
      return 0;
    } finally { runtime.close(); }
  } catch (error) {
    const result = error instanceof CliInputError || error instanceof RunServiceError || error instanceof RunStoreError
      ? { error: error.message }
      : { error: 'The Sheg command failed. Check the command arguments and local datastore.' };
    io.error(JSON.stringify(result));
    return 1;
  }
}

class CliInputError extends Error {}

async function durableOperation(command: string, options: Record<string, string>, service: RunService, storage: (input: StorageOperation) => Promise<unknown>): Promise<unknown> {
  if (command === 'inspect') return service.inspect(await readRequest(options));
  if (command === 'start') return service.start(uuid(required(options, 'submission-id')), await readRequest(options));
  if (command === 'list') return service.list(runListQuerySchema.parse(await readJson(required(options, 'query'))));
  if (command === 'query') return service.queryEvidence(runEvidenceQuerySchema.parse(await readJson(required(options, 'query'))));
  if (command === 'get') {
    const input = runGetSchema.parse(await readJson(required(options, 'request')));
    return dispatchRunGet(input, service);
  }
  if (command === 'cancel') return service.cancel(uuid(required(options, 'run-id')));
  if (command === 'resume') return service.resume(uuid(required(options, 'run-id')));
  if (command === 'delete') {
    const input = runDeleteSchema.parse(await readJson(required(options, 'request')));
    return input.dryRun ? service.previewDelete(input.runIds) : service.deleteRuns(input.runIds);
  }
  if (command === 'storage') return storage(runStorageSchema.parse(await readJson(required(options, 'request'))));
  throw new CliInputError(`Unknown command: ${command}`);
}

async function readRequest(options: Record<string, string>) {
  const parsed = runRequestSchema.safeParse(await readJson(required(options, 'request')));
  if (!parsed.success) throw new CliInputError(`Request is invalid: ${parsed.error.issues.map(({ path: issuePath }) => issuePath.join('.') || 'request').join(', ')}.`);
  return parsed.data;
}

async function readJson<T = unknown>(file: string): Promise<T> {
  try { return JSON.parse(await readFile(path.resolve(file), 'utf8')) as T; }
  catch { throw new CliInputError('The specified JSON file is missing or invalid.'); }
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new CliInputError('A valid run or submission UUID is required.');
  return value;
}

async function trace(options: Record<string, string>) {
  const manifestPath = path.resolve(required(options, 'manifest'));
  const cohortPath = path.resolve(required(options, 'cohort'));
  const study = await loadStudy(manifestPath, cohortPath);
  const respondentId = required(options, 'respondent');
  const profile = study.respondents.find((respondent) => respondent.id === respondentId);
  if (!profile) throw new CliInputError('Respondent ID is not in the frozen cohort.');
  if ((options.choices === undefined) === (options.responses === undefined)) throw new CliInputError('Trace requires exactly one of --choices or --responses.');
  const scripted: readonly string[] | readonly DecisionValue[] = options.responses === undefined ? required(options, 'choices').split(',').filter(Boolean) : parseResponses(options.responses);
  const arm = study.manifest.arms.find((candidate) => candidate.id === required(options, 'arm'));
  if (!arm) throw new CliInputError('Arm ID is not in the study.');
  return traceStudy(arm, profile, scripted);
}

function parseArgs(args: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith('--')) throw new CliInputError(`Expected an option, got ${flag ?? 'end of input'}.`);
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) throw new CliInputError(`Option --${key} was supplied more than once.`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new CliInputError(`Option --${key} requires a value.`);
    options[key] = value;
  }
  return options;
}

function validateOptions(command: string | undefined, options: Record<string, string>): void {
  const commands: Record<string, readonly string[]> = {
    preflight: ['manifest', 'cohort', 'providers', 'mode'],
    trace: ['manifest', 'cohort', 'arm', 'respondent', 'choices', 'responses'],
    inspect: ['request', 'data-root'], start: ['request', 'submission-id', 'data-root'],
    list: ['query', 'data-root'], query: ['query', 'data-root'], get: ['request', 'data-root'],
    cancel: ['run-id', 'data-root'], resume: ['run-id', 'data-root'], delete: ['request', 'data-root'], storage: ['request', 'data-root'],
  };
  const allowed = commands[command ?? ''];
  if (!allowed) throw new CliInputError(`Unknown command: ${command ?? ''}`);
  const unexpected = Object.keys(options).find((key) => !allowed.includes(key));
  if (unexpected) throw new CliInputError(`Option --${unexpected} is not supported by ${command}.`);
}

function required(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) throw new CliInputError(`Missing --${key}.`);
  return value;
}

function parseResponses(value: string): DecisionValue[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new CliInputError('--responses must be a JSON array of typed response values.'); }
  if (!Array.isArray(parsed)) throw new CliInputError('--responses must be a JSON array of typed response values.');
  return parsed.map((response, index) => {
    const result = decisionValueSchema.safeParse(response);
    if (!result.success) throw new CliInputError(`--responses[${index}] is not a valid typed response.`);
    return result.data;
  });
}

const helpText = `sheg <command>
Commands:
  inspect --request <json-file>                 Validate a durable request without inference
  start --request <json-file> --submission-id <uuid>  Accept a durable run
  list --query <json-file>                      Find durable runs
  query --query <json-file>                     Query exact durable evidence
  get --request <json-file>                     Read status, request, context, answers, attempts or journey
  cancel|resume --run-id <uuid>                 Cancel or explicitly resume an eligible run
  delete --request <json-file>                  Preview or delete selected terminal runs
  storage --request <json-file>                 Inspect, optimize or explicitly reset the datastore
  trace --manifest <json> --cohort <json> --arm <id> --respondent <id> (--choices <a,b> | --responses <json>)
  preflight --manifest <json> [--cohort <json>] --providers <json-file> [--mode frozen-cohort|maximum-profile]
  Use --data-root <dir> with durable commands to select the datastore.`;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await runCli(process.argv.slice(2));

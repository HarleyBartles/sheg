import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProfiles } from '../domain/readers/profile.js';
import { traceStudy } from '../domain/journey/trace.js';
import { loadStudy } from '../domain/study/load-study.js';
import { RunManager, checkStudy, type RunConfig } from '../application/jobs.js';
import { compareReports, getReport, pollingReportSchema } from '../application/reports.js';

const manager = new RunManager();

export async function runCli(args: readonly string[], io = { out: (value: string) => process.stdout.write(`${value}\n`), error: (value: string) => process.stderr.write(`${value}\n`) }): Promise<number> {
  try {
    const [command, ...rest] = args;
    const options = parseArgs(rest);
    let result: unknown;
    if (command === '--help' || command === 'help' || command === undefined) { io.out(helpText); return 0; }
    if (command === 'check' || command === 'start') {
      const config = JSON.parse(await readFile(required(options, 'config'), 'utf8')) as RunConfig;
      result = command === 'check' ? await checkStudy(config).then(({ study, stimulusFingerprint, executionFingerprint }) => ({ valid: true, readerCount: study.profiles.length, sourceHashes: study.sources.map((source) => source.sha256), stimulusFingerprint, executionFingerprint })) : await manager.startRun(config);
    } else if (command === 'trace') {
      const manifestPath = path.resolve(required(options, 'manifest'));
      const cohortPath = path.resolve(required(options, 'cohort'));
      const study = await loadStudy(manifestPath, cohortPath);
      const profile = loadProfiles(JSON.parse(await readFile(cohortPath, 'utf8'))).find((reader) => reader.id === required(options, 'reader'));
      if (!profile) throw new Error('Reader ID is not in the frozen cohort.');
      const choices = required(options, 'choices').split(',').filter(Boolean);
      result = await traceStudy(study.manifest, profile, choices);
    } else if (command === 'status') result = await manager.runStatus(required(options, 'output'), required(options, 'run-id'));
    else if (command === 'cancel') result = await manager.cancelRun(required(options, 'output'), required(options, 'run-id'));
    else if (command === 'resume') result = await manager.resumeRun(required(options, 'output'), required(options, 'run-id'));
    else if (command === 'report') result = await getReport(required(options, 'output'), required(options, 'run-id'));
    else if (command === 'compare') {
      const left = pollingReportSchema.parse(JSON.parse(await readFile(required(options, 'left'), 'utf8')));
      const right = pollingReportSchema.parse(JSON.parse(await readFile(required(options, 'right'), 'utf8')));
      result = compareReports(left, right);
    } else throw new Error(`Unknown command: ${command}`);
    io.out(JSON.stringify(result));
    return 0;
  } catch (error) {
    io.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
    return 1;
  }
}

const helpText = `system-one-polling <command>
Commands:
  check --config <json>                         Validate study and provider configuration
  trace --manifest <json> --cohort <json> --reader <id> --choices <a,b,...>
  start --config <json>                         Start a durable run
  status|cancel|resume --output <dir> --run-id <id>
  report --output <dir> --run-id <id>
  compare --left <report.json> --right <report.json>`;

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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCampaign, campaignManifestSchema, type CampaignConfig } from './contracts.js';
import { createCodexAdapter } from './codex-adapter.js';
import { runCampaign } from './runner.js';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Expected a value after ${name}.`);
  return value;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`Missing required option ${name}.`);
  return value;
}

function assertOutsideRepository(output: string): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const relative = path.relative(repoRoot, output);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`Campaign output must be off-repository: ${output}`);
  }
}

export async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === 'prepare') {
    const configPath = path.resolve(required(rest, '--config'));
    const output = path.resolve(required(rest, '--output'));
    assertOutsideRepository(output);
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as CampaignConfig;
    const manifest = prepareCampaign(config, output);
    process.stdout.write(`${JSON.stringify({ prepared: true, campaignId: manifest.campaignId, output }, null, 2)}\n`);
    return;
  }
  if (command === 'status') {
    const directory = path.resolve(required(rest, '--campaign'));
    const manifest = campaignManifestSchema.parse(JSON.parse(readFileSync(path.join(directory, 'campaign.json'), 'utf8')));
    const journalPath = path.join(directory, 'attempts.jsonl');
    const entries = existsSync(journalPath) ? readFileSync(journalPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { type: string; trialId?: string }) : [];
    process.stdout.write(`${JSON.stringify({ campaignId: manifest.campaignId, trialCount: manifest.trials.length + entries.filter((entry) => entry.type === 'trial-added').length, journalEntries: entries.length }, null, 2)}\n`);
    return;
  }
  if (command === 'run' || command === 'resume') {
    const directory = path.resolve(required(rest, '--campaign'));
    if (option(rest, '--backend') !== 'codex') throw new Error('Live campaign execution requires explicit --backend codex.');
    const concurrencyValue = option(rest, '--concurrency');
    const concurrency = concurrencyValue === undefined ? undefined : Number(concurrencyValue);
    if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) throw new Error('--concurrency must be a positive integer.');
    const result = await runCampaign(directory, createCodexAdapter(), concurrency === undefined ? {} : { concurrency });
    process.stdout.write(`${JSON.stringify({ command, campaignId: JSON.parse(readFileSync(path.join(directory, 'campaign.json'), 'utf8')).campaignId, ...result }, null, 2)}\n`);
    return;
  }
  throw new Error('Usage: skill:campaign -- prepare --config <file> --output <off-repo-dir> | status --campaign <dir> | run|resume --campaign <dir> --backend codex [--concurrency N]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

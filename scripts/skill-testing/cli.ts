import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCampaign, campaignManifestSchema, type CampaignConfig } from './contracts.js';
import { createCodexAdapter } from './codex-adapter.js';
import { runCampaign } from './runner.js';
import { compareCampaigns, gradeBlindComparisons, gradeCampaign, writeCampaignReport } from './report.js';
import { calibrationAgreement, type CriterionGrade } from './graders.js';
import { selectScenarios, type ScenarioSelection } from '../skill-scenario.js';

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

function commaValues(args: string[], name: string): string[] | undefined {
  const value = option(args, name);
  return value?.split(',').map((item) => item.trim()).filter(Boolean);
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
  if (command === 'select') {
    const ownerSkill = option(rest, '--owner') as ScenarioSelection['ownerSkill'];
    if (ownerSkill && !['study-design', 'stimulus-response-polling'].includes(ownerSkill)) throw new Error('--owner must be study-design or stimulus-response-polling.');
    const tags = commaValues(rest, '--tag');
    const guidancePaths = commaValues(rest, '--guidance-path');
    const selected = selectScenarios({
      ...(ownerSkill ? { ownerSkill } : {}),
      ...(tags ? { tags } : {}),
      ...(guidancePaths ? { guidancePaths } : {}),
      includeSharedSafeguards: rest.includes('--include-shared'),
    });
    process.stdout.write(`${JSON.stringify(selected.map(({ id, version, ownerSkill: owner, tags: scenarioTags, referencePaths }) => ({ id, version, ownerSkill: owner, tags: scenarioTags, referencePaths })), null, 2)}\n`);
    return;
  }
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
  if (command === 'grade') {
    const directory = path.resolve(required(rest, '--campaign'));
    if (option(rest, '--backend') !== 'codex') throw new Error('Semantic evaluation requires explicit --backend codex.');
    const graded = await gradeCampaign(directory, createCodexAdapter());
    const report = writeCampaignReport(directory);
    process.stdout.write(`${JSON.stringify({ command, campaignId: report.manifest.campaignId, graded, summary: report.summary }, null, 2)}\n`);
    return;
  }
  if (command === 'report') {
    const directory = path.resolve(required(rest, '--campaign'));
    const report = writeCampaignReport(directory);
    process.stdout.write(`${JSON.stringify({ command, campaignId: report.manifest.campaignId, summary: report.summary }, null, 2)}\n`);
    return;
  }
  if (command === 'compare') {
    if (option(rest, '--backend') !== 'codex') throw new Error('Blind comparison requires explicit --backend codex.');
    const baseline = path.resolve(required(rest, '--baseline'));
    const candidate = path.resolve(required(rest, '--candidate'));
    const comparison = compareCampaigns(baseline, candidate);
    const judgments = await gradeBlindComparisons(baseline, candidate, createCodexAdapter());
    process.stdout.write(`${JSON.stringify({ baseline: comparison.baseline.summary, candidate: comparison.candidate.summary, criterionChanges: comparison.criterionChanges, comparisons: judgments.length }, null, 2)}\n`);
    return;
  }
  if (command === 'calibrate') {
    const reference = JSON.parse(readFileSync(path.resolve(required(rest, '--reference')), 'utf8')) as CriterionGrade[];
    const observed = JSON.parse(readFileSync(path.resolve(required(rest, '--observed')), 'utf8')) as CriterionGrade[];
    const result = calibrationAgreement(reference, observed);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  throw new Error('Usage: skill:campaign -- select (--owner <skill> | --tag <tag,...> | --guidance-path <path,...>) [--include-shared] | prepare --config <file> --output <off-repo-dir> | status|report --campaign <dir> | grade --campaign <dir> --backend codex | compare --baseline <dir> --candidate <dir> --backend codex | calibrate --reference <file> --observed <file> | run|resume --campaign <dir> --backend codex [--concurrency N]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

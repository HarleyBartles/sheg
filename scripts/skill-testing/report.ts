import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { assertComparableManifests, campaignManifestSchema, type CampaignManifest } from './contracts.js';
import { extractShegToolCalls, gradeTrial, type TrialGrade } from './graders.js';
import type { CampaignAdapter } from './runner.js';

type Entry = { type: string; trialId?: string; attemptId?: string; armId?: string; repetition?: number };
type TrialRecord = { trialId: string; armId: string; repetition: number; status: 'captured' | 'runtime-error' | 'interrupted' | 'not-run'; grade?: TrialGrade; outputPath?: string; responseExcerpt?: string; settings: Record<string, unknown>; evaluatorSettings?: Record<string, unknown> };
type Report = { manifest: CampaignManifest; trials: TrialRecord[]; comparisons: unknown[]; summary: Record<string, unknown> };
function segment(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, '-'); }
function esc(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
function readManifest(root: string): CampaignManifest { return campaignManifestSchema.parse(JSON.parse(readFileSync(path.join(root, 'campaign.json'), 'utf8'))); }

function allTrials(manifest: CampaignManifest, entries: Entry[]): CampaignManifest['trials'] {
  const additions = entries.filter((entry) => entry.type === 'trial-added' && entry.trialId && entry.armId && entry.repetition).map((entry) => ({ trialId: entry.trialId!, armId: entry.armId!, repetition: entry.repetition!, attempts: [`${entry.trialId}:attempt-001`] }));
  return [...manifest.trials, ...additions];
}

export async function gradeCampaign(directory: string, adapter: CampaignAdapter): Promise<number> {
  const root = path.resolve(directory);
  const manifest = readManifest(root);
  const journalPath = path.join(root, 'attempts.jsonl');
  const entries: Entry[] = existsSync(journalPath) ? readFileSync(journalPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Entry) : [];
  let graded = 0;
  for (const trial of allTrials(manifest, entries)) {
    const capture = entries.findLast((entry) => entry.trialId === trial.trialId && entry.type === 'output-captured');
    if (!capture?.attemptId) continue;
    const attemptRoot = path.join(root, 'attempts', segment(trial.trialId), segment(capture.attemptId));
    const evaluatorRoot = path.join(attemptRoot, 'evaluator');
    const resultPath = path.join(evaluatorRoot, 'result.json');
    if (existsSync(resultPath)) continue;
    mkdirSync(path.join(evaluatorRoot, 'scratch'), { recursive: true });
    const rawEvents = readFileSync(path.join(attemptRoot, 'raw-events.jsonl'), 'utf8');
    const rawFinal = readFileSync(path.join(attemptRoot, 'raw-final-message.txt'), 'utf8');
    const prompt = [
      'Judge this Sheg agent output independently against the frozen criteria. Do not infer an arm, version, or expected result from the output path.',
      'Return only JSON with scenarioId, criterionResults (criterionId, result: pass|fail|uncertain, evidence), and notes as one string. Use this shape: {"scenarioId":"...","criterionResults":[{"criterionId":"...","result":"pass","evidence":"..."}],"notes":"..."}. Cite observed output for each criterion.',
      `scenarioId: ${manifest.scenarioId}`,
      `\n## User request\n${manifest.evaluationBasis.userRequest}`,
      ...(manifest.workflowTurns ? [`\n## Ordered workflow turns and hidden checkpoint expectations\n${JSON.stringify(manifest.workflowTurns, null, 2)}`] : []),
      `\n## Controlled evidence\n${JSON.stringify(manifest.evaluationBasis.controlledEvidence, null, 2)}`,
      `\n## Private evaluation criteria\n${JSON.stringify(manifest.evaluationBasis.criteria, null, 2)}`,
      `\n## Prohibited claims\n${JSON.stringify(manifest.evaluationBasis.prohibitedClaims, null, 2)}`,
      `\n## Raw actor events and final output\n${JSON.stringify({ rawEvents, rawFinalMessage: rawFinal }, null, 2)}`,
    ].join('\n');
    let evaluatorError: string | undefined;
    let semantic: unknown;
    try {
      const run = await adapter.execute({ prompt, cwd: path.join(evaluatorRoot, 'scratch'), timeoutMs: manifest.timeoutMs, requestedSettings: manifest.execution });
      if (run.status !== 'completed') evaluatorError = `Evaluator ended with ${run.status} (exit ${String(run.exitCode)}).`;
      else { try { semantic = JSON.parse(run.rawFinalMessage) as unknown; } catch { evaluatorError = 'Evaluator output was not valid JSON.'; } }
      writeFileSync(path.join(evaluatorRoot, 'raw-events.jsonl'), run.rawEvents);
      writeFileSync(path.join(evaluatorRoot, 'raw-final-message.txt'), run.rawFinalMessage);
      writeFileSync(path.join(evaluatorRoot, 'raw-stderr.txt'), run.rawStderr);
      writeFileSync(resultPath, `${JSON.stringify({ status: run.status, requestedSettings: manifest.execution, observedSettings: run.observedSettings, sessionId: run.sessionId }, null, 2)}\n`);
    } catch (error) { evaluatorError = error instanceof Error ? error.message : String(error); }
    const actorValue = manifest.suite === 'workflow'
      ? { scenarioId: manifest.scenarioId, scenarioVersion: manifest.scenarioVersion, actions: [], finalResponse: rawFinal || 'No final response was captured.', uncertainties: [] }
      : (() => { try { return JSON.parse(rawFinal) as unknown; } catch { return rawFinal; } })();
    const expectedTools = manifest.workflowTurns?.flatMap((turn) => turn.expectedTools) ?? [];
    const grade = gradeTrial(manifest.scenarioId, actorValue, evaluatorError ? undefined : semantic, manifest.evaluationBasis.criteria, manifest.suite, expectedTools, extractShegToolCalls(rawEvents));
    if (evaluatorError) grade.semantic = { result: 'uncertain', criteria: [], error: evaluatorError };
    writeFileSync(path.join(evaluatorRoot, 'grade.json'), `${JSON.stringify(grade, null, 2)}\n`);
    appendFileSync(path.join(root, 'grades.jsonl'), `${JSON.stringify({ trialId: trial.trialId, attemptId: capture.attemptId, gradePath: path.relative(root, path.join(evaluatorRoot, 'grade.json')).replaceAll('\\', '/') })}\n`);
    graded += 1;
  }
  return graded;
}

export function collectCampaignReport(directory: string): Report {
  const root = path.resolve(directory);
  const manifest = readManifest(root);
  const journalPath = path.join(root, 'attempts.jsonl');
  const entries: Entry[] = existsSync(journalPath) ? readFileSync(journalPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Entry) : [];
  const trials = allTrials(manifest, entries).map((trial): TrialRecord => {
    const rows = entries.filter((entry) => entry.trialId === trial.trialId);
    const captured = rows.findLast((entry) => entry.type === 'output-captured');
    const status = captured ? 'captured' : rows.some((entry) => entry.type === 'runtime-error') ? 'runtime-error' : rows.some((entry) => entry.type === 'attempt-interrupted') ? 'interrupted' : 'not-run';
    if (!captured?.attemptId) return { trialId: trial.trialId, armId: trial.armId, repetition: trial.repetition, status, settings: {} };
    const attemptRoot = path.join(root, 'attempts', segment(trial.trialId), segment(captured.attemptId));
    const finalPath = path.join(attemptRoot, 'raw-final-message.txt');
    const resultPath = path.join(attemptRoot, 'result.json');
    const finalText = readFileSync(finalPath, 'utf8');
    const rawEvents = readFileSync(path.join(attemptRoot, 'raw-events.jsonl'), 'utf8');
    let parsed: unknown = null;
    if (manifest.suite === 'workflow') parsed = { scenarioId: manifest.scenarioId, scenarioVersion: manifest.scenarioVersion, actions: [], finalResponse: finalText || 'No final response was captured.', uncertainties: [] };
    else try { parsed = JSON.parse(finalText) as unknown; } catch { /* Malformed raw output stays preserved and grades as an actor contract failure. */ }
    const evaluatorGradePath = path.join(attemptRoot, 'evaluator', 'grade.json');
    const semanticGrade = existsSync(evaluatorGradePath) ? (JSON.parse(readFileSync(evaluatorGradePath, 'utf8')) as TrialGrade).semantic : undefined;
    const expectedTools = manifest.workflowTurns?.flatMap((turn) => turn.expectedTools) ?? [];
    const grade = gradeTrial(manifest.scenarioId, parsed, undefined, manifest.evaluationBasis.criteria, manifest.suite, expectedTools, extractShegToolCalls(rawEvents));
    if (semanticGrade) grade.semantic = semanticGrade;
    const responseExcerpt = parsed && typeof parsed === 'object' && 'finalResponse' in parsed && typeof parsed.finalResponse === 'string' ? parsed.finalResponse : finalText;
    const settings = existsSync(resultPath) ? (JSON.parse(readFileSync(resultPath, 'utf8')) as { observedSettings?: Record<string, unknown> }).observedSettings ?? {} : {};
    const evaluatorResultPath = path.join(attemptRoot, 'evaluator', 'result.json');
    const evaluatorSettings = existsSync(evaluatorResultPath) ? (JSON.parse(readFileSync(evaluatorResultPath, 'utf8')) as { observedSettings?: Record<string, unknown> }).observedSettings ?? {} : undefined;
    return { trialId: trial.trialId, armId: trial.armId, repetition: trial.repetition, status, grade, outputPath: path.relative(root, finalPath).replaceAll('\\', '/'), responseExcerpt, settings, ...(evaluatorSettings ? { evaluatorSettings } : {}) };
  });
  const comparisonsRoot = path.join(root, 'comparisons');
  const comparisons = existsSync(comparisonsRoot) ? readdirSync(comparisonsRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).flatMap((item) => {
    const file = path.join(comparisonsRoot, item.name, 'comparison.json');
    return existsSync(file) ? [JSON.parse(readFileSync(file, 'utf8')) as unknown] : [];
  }) : [];
  const captured = trials.filter((trial) => trial.status === 'captured');
  const criterionCounts = Object.fromEntries(manifest.evaluationBasis.criteria.map(({ id }) => [id, {
    pass: captured.filter((trial) => trial.grade?.semantic.criteria.find((grade) => grade.criterionId === id)?.result === 'pass').length,
    fail: captured.filter((trial) => trial.grade?.semantic.criteria.find((grade) => grade.criterionId === id)?.result === 'fail').length,
    uncertain: captured.filter((trial) => trial.grade?.semantic.criteria.find((grade) => grade.criterionId === id)?.result === 'uncertain').length,
  }]));
  const summary = {
    campaignId: manifest.campaignId, scenarioId: manifest.scenarioId, scenarioVersion: manifest.scenarioVersion,
    suite: manifest.suite, classification: manifest.classification, sampleSize: trials.length,
    completeTrialPasses: captured.filter((trial) => trial.grade?.actorContract.result === 'pass' && trial.grade.deterministic.result !== 'fail' && trial.grade.semantic.result === 'pass').length,
    semanticPasses: captured.filter((trial) => trial.grade?.semantic.result === 'pass').length,
    semanticFailures: captured.filter((trial) => trial.grade?.semantic.result === 'fail').length,
    semanticUncertain: captured.filter((trial) => trial.grade?.semantic.result === 'uncertain').length,
    actorContractFailures: captured.filter((trial) => trial.grade?.actorContract.result === 'fail').length,
    deterministicFailures: captured.filter((trial) => trial.grade?.deterministic.result === 'fail').length,
    semanticNotRun: captured.filter((trial) => trial.grade?.semantic.result === 'not-run').length, runtimeErrors: trials.filter((trial) => trial.status === 'runtime-error').length,
    interrupted: trials.filter((trial) => trial.status === 'interrupted').length,
    comparisonPairs: comparisons.length,
    comparisonDisputedPairs: comparisons.filter((item) => typeof item === 'object' && item !== null && 'disagreements' in item && Array.isArray(item.disagreements) && item.disagreements.length > 0).length,
    humanAdjudicationPending: comparisons.filter((item) => typeof item === 'object' && item !== null && 'humanAdjudication' in item && item.humanAdjudication === null).length,
    missingObservedModel: captured.filter((trial) => typeof trial.settings.model !== 'string').length,
    missingObservedEvaluatorModel: captured.filter((trial) => typeof trial.evaluatorSettings?.model !== 'string').length,
    usageAndTiming: 'unavailable unless captured by the execution adapter',
    guidanceHashes: Object.fromEntries(manifest.arms.map((arm) => [arm.id, arm.skillReferenceHashes])),
    criterionCounts,
  };
  return { manifest, trials, comparisons, summary };
}

export function compareCampaigns(baselineDirectory: string, candidateDirectory: string): { baseline: Report; candidate: Report; criterionChanges: Array<{ criterionId: string; baseline: { pass: number; fail: number; uncertain: number }; candidate: { pass: number; fail: number; uncertain: number }; delta: { pass: number; fail: number; uncertain: number } }> } {
  const baseline = collectCampaignReport(baselineDirectory);
  const candidate = collectCampaignReport(candidateDirectory);
  assertComparableManifests(baseline.manifest, candidate.manifest);
  const baselineCounts = baseline.summary.criterionCounts as Record<string, { pass: number; fail: number; uncertain: number }>;
  const candidateCounts = candidate.summary.criterionCounts as Record<string, { pass: number; fail: number; uncertain: number }>;
  const criterionChanges = baseline.manifest.evaluationBasis.criteria.map(({ id }) => {
    const before = baselineCounts[id] ?? { pass: 0, fail: 0, uncertain: 0 };
    const after = candidateCounts[id] ?? { pass: 0, fail: 0, uncertain: 0 };
    return { criterionId: id, baseline: before, candidate: after, delta: { pass: after.pass - before.pass, fail: after.fail - before.fail, uncertain: after.uncertain - before.uncertain } };
  });
  return { baseline, candidate, criterionChanges };
}

const comparisonGradeSchema = z.object({
  criterionResults: z.array(z.object({ criterionId: z.string(), preferred: z.enum(['A', 'B', 'tie', 'uncertain']), evidence: z.string().min(1) }).strict()),
  notes: z.string(),
}).strict();

export async function gradeBlindComparisons(baselineDirectory: string, candidateDirectory: string, adapter: CampaignAdapter): Promise<unknown[]> {
  const { baseline, candidate } = compareCampaigns(baselineDirectory, candidateDirectory);
  const baseRoot = path.resolve(baselineDirectory);
  const candidateRoot = path.resolve(candidateDirectory);
  const criteria = candidate.manifest.evaluationBasis.criteria;
  const outcomes: unknown[] = [];
  for (const baselineTrial of baseline.trials.filter((trial) => trial.status === 'captured')) {
    const candidateTrial = candidate.trials.find((trial) => trial.status === 'captured' && trial.repetition === baselineTrial.repetition);
    if (!candidateTrial || !baselineTrial.outputPath || !candidateTrial.outputPath) continue;
    const pairSeed = `${baseline.manifest.basis.requestSha256}:${baselineTrial.repetition}`;
    const mappingHash = createHash('sha256').update(pairSeed).digest('hex');
    const mapping = Number.parseInt(mappingHash[0]!, 16) < 8 ? { baseline: 'A', candidate: 'B' } as const : { baseline: 'B', candidate: 'A' } as const;
    const rawFor = (root: string, trial: TrialRecord) => {
      const finalPath = path.resolve(root, trial.outputPath!);
      const eventPath = path.join(path.dirname(finalPath), 'raw-events.jsonl');
      return { final: readFileSync(finalPath, 'utf8'), events: readFileSync(eventPath, 'utf8') };
    };
    const baselineRaw = rawFor(baseRoot, baselineTrial);
    const candidateRaw = rawFor(candidateRoot, candidateTrial);
    const labeled = { A: mapping.baseline === 'A' ? baselineRaw : candidateRaw, B: mapping.baseline === 'B' ? baselineRaw : candidateRaw };
    const prompts = [
      { order: 'A-then-B', pair: [{ label: 'A', raw: labeled.A }, { label: 'B', raw: labeled.B }] },
      { order: 'B-then-A', pair: [{ label: 'B', raw: labeled.B }, { label: 'A', raw: labeled.A }] },
    ].map(({ order, pair }) => ({ order, prompt: [
      'Compare two anonymized Sheg agent outputs against the frozen evidence and criteria. Do not infer which is newer or better from position or style. Prefer the output that is more correct and useful for each criterion; use tie or uncertain when evidence does not support a preference.',
      'Return only JSON with criterionResults (criterionId, preferred: A|B|tie|uncertain, evidence) and notes as one string.',
      `Scenario: ${candidate.manifest.scenarioId} v${candidate.manifest.scenarioVersion}`,
      `\n## User request\n${candidate.manifest.evaluationBasis.userRequest}`,
      ...(candidate.manifest.workflowTurns ? [`\n## Ordered workflow turns\n${JSON.stringify(candidate.manifest.workflowTurns, null, 2)}`] : []),
      `\n## Controlled evidence\n${JSON.stringify(candidate.manifest.evaluationBasis.controlledEvidence, null, 2)}`,
      `\n## Criteria\n${JSON.stringify(criteria, null, 2)}`,
      ...pair.map(({ label, raw }) => `\n## Output ${label}\n${JSON.stringify(raw, null, 2)}`),
    ].join('\n') }));
    const judgments: Array<{ order: string; raw: string; parsed: z.infer<typeof comparisonGradeSchema> | null; error?: string; promptSha256: string }> = [];
    for (const [index, prompt] of prompts.entries()) {
      const work = path.join(candidateRoot, 'comparisons', segment(baselineTrial.trialId), `judge-${index + 1}`);
      mkdirSync(work, { recursive: true });
      try {
        const result = await adapter.execute({ prompt: prompt.prompt, cwd: work, timeoutMs: candidate.manifest.timeoutMs, requestedSettings: candidate.manifest.execution });
        let parsed: z.infer<typeof comparisonGradeSchema> | null = null;
        if (result.status === 'completed') {
          try {
            const candidateGrade = comparisonGradeSchema.parse(JSON.parse(result.rawFinalMessage) as unknown);
            if (candidateGrade.criterionResults.length !== criteria.length || criteria.some((criterion) => !candidateGrade.criterionResults.some((grade) => grade.criterionId === criterion.id))) throw new Error('Comparison criteria do not match the frozen rubric.');
            parsed = candidateGrade;
          } catch (error) { judgments.push({ order: prompt.order, raw: result.rawFinalMessage, parsed: null, error: error instanceof Error ? error.message : String(error), promptSha256: createHash('sha256').update(prompt.prompt).digest('hex') }); continue; }
        }
        judgments.push({ order: prompt.order, raw: result.rawFinalMessage, parsed, ...(result.status !== 'completed' ? { error: `Judge ended with ${result.status}.` } : {}), promptSha256: createHash('sha256').update(prompt.prompt).digest('hex') });
      } catch (error) { judgments.push({ order: prompt.order, raw: '', parsed: null, error: error instanceof Error ? error.message : String(error), promptSha256: createHash('sha256').update(prompt.prompt).digest('hex') }); }
    }
    const first = judgments[0]?.parsed;
    const second = judgments[1]?.parsed;
    const disagreements = first && second ? criteria.filter((criterion) => first.criterionResults.find((grade) => grade.criterionId === criterion.id)?.preferred !== second.criterionResults.find((grade) => grade.criterionId === criterion.id)?.preferred).map(({ id }) => id) : criteria.map(({ id }) => id);
    const comparison = { repetition: baselineTrial.repetition, labelMapping: mapping, judgments, disagreements, humanAdjudication: null };
    writeFileSync(path.join(candidateRoot, 'comparisons', segment(baselineTrial.trialId), 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
    outcomes.push(comparison);
  }
  return outcomes;
}

export function renderCampaignReport(report: Report): { json: string; markdown: string; html: string } {
  const json = `${JSON.stringify({ summary: report.summary, trials: report.trials, comparisons: report.comparisons }, null, 2)}\n`;
  const rows = report.trials.map((trial) => `| ${trial.armId} | ${trial.trialId} | ${trial.status} | ${trial.grade?.actorContract.result ?? 'n/a'} | ${trial.grade?.deterministic.result ?? 'n/a'} | ${trial.grade?.semantic.result ?? 'not run'} | ${esc(trial.responseExcerpt ?? '')} | ${trial.outputPath ? `[raw output](${trial.outputPath})` : ''} |`).join('\n');
  const comparisonRows = report.comparisons.map((item) => {
    const value = item as { repetition?: number; disagreements?: string[]; humanAdjudication?: unknown };
    return `| ${String(value.repetition)} | ${(value.disagreements ?? []).join(', ') || 'none'} | ${value.humanAdjudication === null ? 'pending' : 'recorded'} |`;
  }).join('\n');
  const markdown = `# Skill campaign ${report.manifest.campaignId}\n\nScenario: ${report.manifest.scenarioId} v${report.manifest.scenarioVersion}. Suite: ${report.manifest.suite}. Classification: ${report.manifest.classification}.\n\nSample size: ${report.trials.length}; complete trial passes: ${String(report.summary.completeTrialPasses)}; runtime errors: ${String(report.summary.runtimeErrors)}; interrupted: ${String(report.summary.interrupted)}. Semantic grades come from separate Codex evaluation runs. Usage and timing: ${String(report.summary.usageAndTiming)}.\n\n| Arm | Trial | Status | Actor contract | Deterministic | Semantic | Response | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows}\n\n## Blind comparisons\n\n| Repetition | Disputed criteria | Human adjudication |\n| --- | --- | --- |\n${comparisonRows}\n`;
  const htmlRows = report.trials.map((trial) => `<tr><td>${esc(trial.armId)}</td><td>${esc(trial.trialId)}</td><td>${esc(trial.status)}</td><td>${esc(trial.grade?.actorContract.result ?? 'n/a')}</td><td>${esc(trial.grade?.deterministic.result ?? 'n/a')}</td><td>${esc(trial.grade?.semantic.result ?? 'not run')}</td><td>${esc(trial.responseExcerpt ?? '')}</td><td>${trial.outputPath ? `<a href="${esc(trial.outputPath)}">raw output</a>` : ''}</td></tr>`).join('');
  const comparisonHtml = report.comparisons.map((item) => {
    const value = item as { repetition?: number; disagreements?: string[]; humanAdjudication?: unknown };
    return `<tr><td>${String(value.repetition)}</td><td>${esc((value.disagreements ?? []).join(', ') || 'none')}</td><td>${value.humanAdjudication === null ? 'pending' : 'recorded'}</td></tr>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(report.manifest.campaignId)}</title><h1>Skill campaign ${esc(report.manifest.campaignId)}</h1><p>Scenario ${esc(report.manifest.scenarioId)} v${report.manifest.scenarioVersion}; suite ${esc(report.manifest.suite)}; sample ${report.trials.length}; complete passes ${String(report.summary.completeTrialPasses)}; runtime errors ${String(report.summary.runtimeErrors)}; semantic grades use separate Codex evaluation runs.</p><table><thead><tr><th>Arm</th><th>Trial</th><th>Status</th><th>Actor contract</th><th>Deterministic</th><th>Semantic</th><th>Response</th><th>Evidence</th></tr></thead><tbody>${htmlRows}</tbody></table><h2>Blind comparisons</h2><table><thead><tr><th>Repetition</th><th>Disputed criteria</th><th>Human adjudication</th></tr></thead><tbody>${comparisonHtml}</tbody></table><pre>${esc(JSON.stringify(report.summary, null, 2))}</pre>`;
  return { json, markdown, html };
}

export function writeCampaignReport(directory: string): Report {
  const root = path.resolve(directory);
  const report = collectCampaignReport(root);
  const rendered = renderCampaignReport(report);
  writeFileSync(path.join(root, 'report.json'), rendered.json);
  writeFileSync(path.join(root, 'report.md'), rendered.markdown);
  writeFileSync(path.join(root, 'report.html'), rendered.html);
  return report;
}

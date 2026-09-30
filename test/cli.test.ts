import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/entrypoints/cli.js';

test('CLI help lists all supported workflow commands', async () => {
  const lines: string[] = [];
  const status = await runCli(['--help'], { out: (text) => { lines.push(text); return true; }, error: (text) => { lines.push(text); return true; } });
  assert.equal(status, 0);
  for (const command of ['check', 'preflight', 'trace', 'start', 'status', 'cancel', 'resume', 'report', 'compare', 'compare-runs']) assert.match(lines[0] ?? '', new RegExp(command));
});

test('CLI check validates explicit provider config without key or network', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polling-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'run.json');
  await writeFile(configPath, JSON.stringify({
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), outputDirectory: directory,
    maxCalls: 10,
    provider: { kind: 'jev', route: 'typesafe', model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions', timeoutMs: 5000 },
  }));
  const output: string[] = []; const errors: string[] = [];
  const status = await runCli(['check', '--config', configPath], { out: (text) => { output.push(text); return true; }, error: (text) => { errors.push(text); return true; } });
  assert.equal(status, 0, errors.join('\n'));
  assert.equal(JSON.parse(output[0] ?? '{}').valid, true);
  assert.equal(JSON.parse(output[0] ?? '{}').runBounds.maximumCallsConfigured, 10);
  assert.equal(JSON.parse(output[0] ?? '{}').runBounds.maximumCallsSufficient, true);
  assert.ok(JSON.parse(output[0] ?? '{}').runBounds.maximumDecisionCalls > 0);
  assert.equal(errors.length, 0);
});

test('CLI preflight reports incomplete fit evidence for variable response histories without provider calls', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polling-preflight-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const providersPath = path.join(directory, 'providers.json');
  await writeFile(providersPath, JSON.stringify([{ kind: 'jev', model: 'typesafe/jev-1.13', endpoint: 'https://openrouter.ai/api/alpha/decisions', timeoutMs: 1000 }]));
  const output: string[] = []; const errors: string[] = [];
  const status = await runCli(['preflight', '--manifest', path.resolve('test/fixtures/article.json'), '--cohort', path.resolve('test/fixtures/cohort.json'), '--providers', providersPath], {
    out: (text) => { output.push(text); return true; }, error: (text) => { errors.push(text); return true; },
  });
  assert.equal(status, 0, errors.join('\n'));
  const result = JSON.parse(output[0] ?? '{}') as { providers: Array<{ status: string; packetCount: number; incompleteReason?: string }> };
  assert.equal(result.providers[0]?.status, 'unverified');
  assert.match(result.providers[0]?.incompleteReason ?? '', /response history/i);
  assert.ok((result.providers[0]?.packetCount ?? 0) > 0);
});

test('CLI preflight rejects an unknown mode instead of selecting frozen-cohort', async () => {
  const errors: string[] = [];
  const status = await runCli(['preflight', '--mode', 'maximum-profiles', '--manifest', 'study.json', '--providers', 'providers.json'], {
    out: () => true, error: (value) => { errors.push(value); return true; },
  });
  assert.equal(status, 1);
  assert.match(errors[0] ?? '', /mode/i);
});

test('CLI scripted trace is keyless and uses the shared graph runner', async () => {
  const output: string[] = [];
  const status = await runCli(['trace', '--manifest', path.resolve('test/fixtures/article.json'), '--cohort', path.resolve('test/fixtures/cohort.json'), '--arm', 'original', '--respondent', 'curious-outside-reader', '--choices', 'continue,continue'], {
    out: (text) => { output.push(text); return true; }, error: (text) => { output.push(text); return true; },
  });
  assert.equal(status, 0);
  assert.equal(JSON.parse(output[0] ?? '{}').outcome, 'completed');
});

test('CLI trace accepts typed response JSON while preserving the Choice trace path', async () => {
  const output: string[] = [];
  const status = await runCli(['trace', '--manifest', path.resolve('test/fixtures/article.json'), '--cohort', path.resolve('test/fixtures/cohort.json'), '--arm', 'original', '--respondent', 'curious-outside-reader', '--responses', JSON.stringify([{ type: 'choice', choice: 'continue' }, { type: 'choice', choice: 'continue' }])], {
    out: (text) => { output.push(text); return true; }, error: (text) => { output.push(text); return true; },
  });
  assert.equal(status, 0);
  assert.equal(JSON.parse(output[0] ?? '{}').outcome, 'completed');
});

test('CLI trace rejects missing or conflicting scripted response forms', async () => {
  for (const options of [[], ['--choices', 'continue', '--responses', '[]']]) {
    const errors: string[] = [];
    const status = await runCli(['trace', '--manifest', path.resolve('test/fixtures/article.json'), '--cohort', path.resolve('test/fixtures/cohort.json'), '--arm', 'original', '--respondent', 'curious-outside-reader', ...options], {
      out: () => true, error: (text) => { errors.push(text); return true; },
    });
    assert.equal(status, 1);
    assert.match(errors[0] ?? '', /exactly one/i);
  }
});

test('CLI returns a bounded JSON error without stack or secret details', async () => {
  const errors: string[] = [];
  const status = await runCli(['status', '--output', 'missing', '--run-id', 'not-a-uuid'], { out: () => true, error: (text) => { errors.push(text); return true; } });
  assert.equal(status, 1);
  assert.deepEqual(Object.keys(JSON.parse(errors[0] ?? '{}')), ['error']);
  assert.doesNotMatch(errors[0] ?? '', /stack|undefined|POLL_TEST_MISSING_KEY/);
});

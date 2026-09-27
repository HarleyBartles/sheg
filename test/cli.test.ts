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
  for (const command of ['check', 'preflight', 'trace', 'start', 'status', 'cancel', 'reconcile', 'resume', 'report', 'compare']) assert.match(lines[0] ?? '', new RegExp(command));
});

test('CLI check validates explicit provider config without key or network', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polling-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'run.json');
  await writeFile(configPath, JSON.stringify({
    manifestPath: path.resolve('test/fixtures/article.json'), cohortPath: path.resolve('test/fixtures/cohort.json'), outputDirectory: directory,
    maxCalls: 10, maxUsd: 1, maxPerCallUsd: 0.1,
    provider: { kind: 'jev', model: 'jev-latest', keyEnv: 'POLL_TEST_MISSING_KEY', endpoint: 'https://api.typesafe.ai/v1/alpha/decisions', timeoutMs: 5000 },
  }));
  const output: string[] = []; const errors: string[] = [];
  const status = await runCli(['check', '--config', configPath], { out: (text) => { output.push(text); return true; }, error: (text) => { errors.push(text); return true; } });
  assert.equal(status, 0, errors.join('\n'));
  assert.equal(JSON.parse(output[0] ?? '{}').valid, true);
  assert.equal(errors.length, 0);
});

test('CLI preflight reports fit for every packet without provider calls', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polling-preflight-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const providersPath = path.join(directory, 'providers.json');
  await writeFile(providersPath, JSON.stringify([{ kind: 'jev', model: 'typesafe/jev-1.13', keyEnv: 'UNSET', endpoint: 'https://example.invalid/decisions', timeoutMs: 1000 }]));
  const output: string[] = []; const errors: string[] = [];
  const status = await runCli(['preflight', '--manifest', path.resolve('test/fixtures/article.json'), '--cohort', path.resolve('test/fixtures/cohort.json'), '--providers', providersPath], {
    out: (text) => { output.push(text); return true; }, error: (text) => { errors.push(text); return true; },
  });
  assert.equal(status, 0, errors.join('\n'));
  const result = JSON.parse(output[0] ?? '{}') as { providers: Array<{ status: string; packetCount: number }> };
  assert.equal(result.providers[0]?.status, 'fit');
  assert.ok((result.providers[0]?.packetCount ?? 0) > 0);
});

test('CLI scripted trace is keyless and uses the shared graph runner', async () => {
  const output: string[] = [];
  const status = await runCli(['trace', '--manifest', path.resolve('test/fixtures/article.json'), '--cohort', path.resolve('test/fixtures/cohort.json'), '--arm', 'original', '--respondent', 'curious-outside-reader', '--choices', 'continue,continue'], {
    out: (text) => { output.push(text); return true; }, error: (text) => { output.push(text); return true; },
  });
  assert.equal(status, 0);
  assert.equal(JSON.parse(output[0] ?? '{}').outcome, 'completed');
});

test('CLI returns a bounded JSON error without stack or secret details', async () => {
  const errors: string[] = [];
  const status = await runCli(['status', '--output', 'missing', '--run-id', 'not-a-uuid'], { out: () => true, error: (text) => { errors.push(text); return true; } });
  assert.equal(status, 1);
  assert.deepEqual(Object.keys(JSON.parse(errors[0] ?? '{}')), ['error']);
  assert.doesNotMatch(errors[0] ?? '', /stack|undefined|POLL_TEST_MISSING_KEY/);
});

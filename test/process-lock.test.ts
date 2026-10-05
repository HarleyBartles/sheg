import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, rename as renameFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { ProcessLock, ProcessLockError } from '../src/infrastructure/process-lock.js';

async function tempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polling-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) throw new Error('Child lock owner has no stdout pipe.');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Child lock owner did not start.')), 15_000);
    const onData = (chunk: string) => { if (chunk.includes('READY')) finish(); };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`Child exited before readiness (${code ?? signal}).`));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error); else resolve();
    };
    stdout.setEncoding('utf8').on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}
test('process lock rejects a second owner and releases only its own lock', async (t) => {
  const directory = await tempDirectory(t);
  const lock = await ProcessLock.acquire(directory, 'run-123');
  await assert.rejects(ProcessLock.acquire(directory, 'run-123'), ProcessLockError);
  await lock.release();
  const replacement = await ProcessLock.acquire(directory, 'run-123');
  await replacement.release();
});

test('simultaneous contenders publish one complete ownership record', async (t) => {
  const directory = await tempDirectory(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => ProcessLock.acquire(directory, 'run-contended')));
  const owners = results.filter((result): result is PromiseFulfilledResult<ProcessLock> => result.status === 'fulfilled');
  assert.equal(owners.length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 7);
  const persisted = JSON.parse(await readFile(path.join(directory, 'run-contended.lock'), 'utf8')) as { pid: number; token: string };
  assert.equal(persisted.pid, process.pid);
  assert.match(persisted.token, /^[a-f\d-]{36}$/i);
  await owners[0]!.value.release();
});

test('a killed child process leaves reclaimable stale ownership', async (t) => {
  const directory = await tempDirectory(t);
  const moduleUrl = pathToFileURL(path.resolve('src/infrastructure/process-lock.ts')).href;
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    'const { ProcessLock } = await import(process.env.POLL_LOCK_MODULE); await ProcessLock.acquire(process.env.POLL_LOCK_DIR, "run-child"); console.log("READY"); setInterval(() => {}, 1000);',
  ], { cwd: process.cwd(), env: { ...process.env, POLL_LOCK_MODULE: moduleUrl, POLL_LOCK_DIR: directory }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await waitForReady(child);
    await terminate(child, 'SIGKILL');
  } finally { await terminate(child, 'SIGKILL'); }
  const recovered = await ProcessLock.acquire(directory, 'run-child');
  await recovered.release();
});

test('a delayed stale-lock reclaimer cannot remove a replacement live lock', async (t) => {
  const directory = await tempDirectory(t);
  const lockPath = path.join(directory, 'run-race.lock');
  await writeFile(lockPath, `${JSON.stringify({ pid: 2147483647, token: 'stale-owner' })}\n`);

  let announceRename!: () => void;
  const renameRequested = new Promise<void>((resolve) => { announceRename = resolve; });
  let resumeRename!: () => void;
  const renameGate = new Promise<void>((resolve) => { resumeRename = resolve; });
  let announceClaim!: () => void;
  const claimMoved = new Promise<void>((resolve) => { announceClaim = resolve; });
  let resumeClaim!: () => void;
  const claimGate = new Promise<void>((resolve) => { resumeClaim = resolve; });
  let parked = false;
  const delayedRename: typeof renameFile = async (source, destination): Promise<void> => {
    if (!parked) {
      parked = true;
      announceRename();
      await renameGate;
    }
    await renameFile(source, destination);
  };

  const delayedReclaimer = ProcessLock.acquire(directory, 'run-race', {
    rename: delayedRename,
    afterStaleRename: async () => { announceClaim(); await claimGate; },
  });
  await renameRequested;
  const winningOwner = await ProcessLock.acquire(directory, 'run-race');
  const winningRecord = await readFile(lockPath, 'utf8');
  resumeRename();
  await claimMoved;

  await assert.rejects(ProcessLock.acquire(directory, 'run-race'), ProcessLockError);
  assert.equal(await readFile(lockPath, 'utf8'), winningRecord);
  resumeClaim();
  await assert.rejects(delayedReclaimer, ProcessLockError);
  assert.equal(await readFile(lockPath, 'utf8'), winningRecord);
  await assert.rejects(ProcessLock.acquire(directory, 'run-race'), ProcessLockError);
  await winningOwner.release();
});

test('a live second process retains exclusive run ownership', async (t) => {
  const directory = await tempDirectory(t);
  const moduleUrl = pathToFileURL(path.resolve('src/infrastructure/process-lock.ts')).href;
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    'const { ProcessLock } = await import(process.env.POLL_LOCK_MODULE); await ProcessLock.acquire(process.env.POLL_LOCK_DIR, "run-live"); console.log("READY"); setInterval(() => {}, 1000);',
  ], { cwd: process.cwd(), env: { ...process.env, POLL_LOCK_MODULE: moduleUrl, POLL_LOCK_DIR: directory }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await waitForReady(child);
    await assert.rejects(ProcessLock.acquire(directory, 'run-live'), ProcessLockError);
  } finally {
    await terminate(child, 'SIGTERM');
  }
});

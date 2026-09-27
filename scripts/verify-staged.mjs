import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args, cwd) {
  const windowsNpm = process.platform === 'win32' && command === 'npm';
  const result = spawnSync(windowsNpm ? process.env.ComSpec ?? 'cmd.exe' : command, windowsNpm ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args, {
    cwd,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
}

const root = process.cwd();
const temporaryRoot = await realpath(os.tmpdir());
const snapshot = await mkdtemp(path.join(temporaryRoot, 'sheg-staged-'));
try {
  run('git', ['checkout-index', '--all', `--prefix=${snapshot}${path.sep}`], root);
  run('npm', ['ci'], snapshot);
  run('npm', ['run', 'verify'], snapshot);
} finally {
  const resolved = await realpath(snapshot);
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('sheg-staged-')) {
    throw new Error(`Refusing to remove unexpected snapshot path: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

import { spawnSync } from 'node:child_process';

const python = process.platform === 'win32' ? 'py' : 'python3';
const prefix = process.platform === 'win32' ? ['-3'] : [];
const result = spawnSync(python, [...prefix, 'scripts/package-plugin.py', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Unable to run the Python 3 packaging utility: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

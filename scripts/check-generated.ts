import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const generatedDirectories = ['dist', 'skills/stimulus-response-polling/assets', 'plugins/sheg'];
const generatedFiles = ['package-lock.json', 'plugin.json'];

async function removeBuild(directory: string, temporaryRoot: string): Promise<void> {
  const resolved = await realpath(directory);
  if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('sheg-generated-')) {
    throw new Error(`Refusing to remove unexpected build path: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

async function snapshot(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const generated of generatedDirectories) {
    const absoluteDirectory = path.join(directory, generated);
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const absolutePath = path.join(entry.parentPath, entry.name);
      files.set(path.relative(directory, absolutePath), await readFile(absolutePath));
    }
  }
  for (const file of generatedFiles) {
    try { files.set(file, await readFile(path.join(directory, file))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return files;
}

const before = await snapshot(root);
const temporaryRoot = await realpath(os.tmpdir());
const buildRoot = await mkdtemp(path.join(temporaryRoot, 'sheg-generated-'));
try {
  for (const input of ['src', 'scripts', 'skills', 'migrations', 'licenses', 'package.json', 'package-lock.json', 'plugin.template.json', 'LICENSE', 'mcp.json', 'tsconfig.json']) {
    await cp(path.join(root, input), path.join(buildRoot, input), { recursive: true });
  }
  await symlink(path.join(root, 'node_modules'), path.join(buildRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const script of ['generate-contracts.ts', 'build.ts']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', `scripts/${script}`], { cwd: buildRoot, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Disposable generation failed (${script}):\n${result.stderr}`);
  }
  const after = await snapshot(buildRoot);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (file) => !before.get(file)?.equals(after.get(file) ?? Buffer.alloc(0)) || !after.has(file),
  );
  if (changed.length > 0) {
    throw new Error(`Generated files differ from the checked-in build:\n${changed.sort().join('\n')}\nRun npm run contracts:build and npm run build, then recheck.`);
  }
} finally {
  await removeBuild(buildRoot, temporaryRoot);
}

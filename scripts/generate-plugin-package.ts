import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const authoredFiles = ['LICENSE', 'mcp.json', 'plugin.json'] as const;
const authoredDirectories = ['dist', 'skills'] as const;

export async function generatePluginPackage(repositoryRoot = path.resolve('.')): Promise<void> {
  const root = path.resolve(repositoryRoot);
  const packageParent = path.join(root, 'plugins');
  const destination = path.join(root, 'plugins', 'sheg');
  ensureContained(root, destination);
  const parentMetadata = await lstatIfExists(packageParent);
  if (parentMetadata?.isSymbolicLink() || (parentMetadata && !parentMetadata.isDirectory())) {
    throw new Error('Generated plugin parent must be a directory and cannot be a symlink.');
  }
  await mkdir(packageParent, { recursive: true });

  const packageSource = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (packageSource.name !== 'sheg' || typeof packageSource.version !== 'string' || packageSource.version.length === 0) {
    throw new Error('Root package.json must define the Sheg name and product version.');
  }

  const files: string[] = [...authoredFiles];
  for (const directory of authoredDirectories) {
    await requireDirectory(path.join(root, directory), `${directory}/`);
    files.push(...await collectFiles(root, directory, directory === 'skills'));
  }
  for (const relative of authoredFiles) await requireFile(path.join(root, relative), relative);

  const current = await lstatIfExists(destination);
  if (current?.isSymbolicLink() || (current && !current.isDirectory())) {
    throw new Error('Generated plugin destination must be a directory and cannot be a symlink.');
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const relative of files.sort()) {
    const source = path.join(root, relative);
    const target = path.join(destination, relative);
    ensureContained(root, source);
    ensureContained(destination, target);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(source));
  }
  await writeFile(path.join(destination, 'package.json'), `${JSON.stringify({ name: packageSource.name, version: packageSource.version, type: 'module' }, null, 2)}\n`);
}

async function collectFiles(root: string, relativeDirectory: string, excludeTests: boolean): Promise<string[]> {
  const result: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    const absolute = path.join(root, relative);
    ensureContained(root, absolute);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(relative, entry.name);
      if (excludeTests && entry.isDirectory() && entry.name === 'tests') continue;
      const childPath = path.join(root, child);
      if (entry.isSymbolicLink()) throw new Error(`Plugin package inputs cannot be symlinks: ${child.replaceAll(path.sep, '/')}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) result.push(child);
      else throw new Error(`Plugin package input is not a regular file: ${child.replaceAll(path.sep, '/')}`);
      const metadata = await lstat(childPath);
      if (metadata.isSymbolicLink()) throw new Error(`Plugin package inputs cannot be symlinks: ${child.replaceAll(path.sep, '/')}`);
    }
  };
  await visit(relativeDirectory);
  return result;
}

async function requireFile(file: string, label: string): Promise<void> {
  const metadata = await lstatIfExists(file);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`Required plugin package input is missing or unsafe: ${label}`);
}

async function requireDirectory(directory: string, label: string): Promise<void> {
  const metadata = await lstatIfExists(directory);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Required plugin package directory is missing or unsafe: ${label}`);
}

async function lstatIfExists(file: string) {
  try { return await lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function ensureContained(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Plugin package path escapes its root: ${target}`);
  }
}

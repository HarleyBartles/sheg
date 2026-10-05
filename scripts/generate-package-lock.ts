import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

export async function syncPackageLockVersion(repositoryRoot: string): Promise<void> {
  const [packageText, lockText] = await Promise.all([
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
  ]);
  const packageManifest = object(JSON.parse(packageText) as unknown);
  const lockfile = object(JSON.parse(lockText) as unknown);
  const packages = object(lockfile?.packages);
  const rootPackage = object(packages?.['']);
  const version = packageManifest?.version;
  if (typeof version !== 'string' || version.length === 0) throw new Error('package.json must declare the Sheg product version.');
  if (!lockfile || !packages || !rootPackage) throw new Error('package-lock.json must declare its root package entry.');

  const updated = {
    ...lockfile,
    version,
    packages: { ...packages, '': { ...rootPackage, version } },
  };
  await writeFile(path.join(repositoryRoot, 'package-lock.json'), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
}

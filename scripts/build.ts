import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { respondentArchetypeGroups } from '../src/domain/respondents/archetype-catalogue.js';
import { syncPackageLockVersion } from './generate-package-lock.js';
import { syncPluginManifest } from './generate-plugin-manifest.js';
import { generatePluginPackage } from './generate-plugin-package.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

export async function buildPlugin(outputDirectory = path.join(repositoryRoot, 'dist')): Promise<void> {
  await syncPackageLockVersion(repositoryRoot);
  await syncPluginManifest(repositoryRoot);
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  await rm(resolvedOutputDirectory, { recursive: true, force: true });
  await mkdir(resolvedOutputDirectory, { recursive: true });
  await build({
    entryPoints: [
      path.join(repositoryRoot, 'src/entrypoints/cli.ts'),
      path.join(repositoryRoot, 'src/entrypoints/mcp.ts'),
      path.join(repositoryRoot, 'src/entrypoints/worker.ts'),
    ],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    outbase: path.join(repositoryRoot, 'src/entrypoints'),
    outdir: resolvedOutputDirectory,
  });

  const credentialDirectory = path.join(resolvedOutputDirectory, 'credentials');
  await mkdir(credentialDirectory, { recursive: true });
  await cp(
    path.join(repositoryRoot, 'src/infrastructure/sqlite/queries'),
    path.join(resolvedOutputDirectory, 'queries'),
    { recursive: true },
  );
  await cp(
    path.join(repositoryRoot, 'src/infrastructure/credentials/windows-credential.ps1'),
    path.join(credentialDirectory, 'windows-credential.ps1'),
  );

  const migrationDirectory = path.join(resolvedOutputDirectory, 'migrations/0000_baseline_v9');
  await mkdir(migrationDirectory, { recursive: true });
  await cp(
    path.join(repositoryRoot, 'migrations/0000_baseline_v9/migration.sql'),
    path.join(migrationDirectory, 'migration.sql'),
  );
  await cp(
    path.join(repositoryRoot, 'licenses/drizzle-orm-Apache-2.0.txt'),
    path.join(resolvedOutputDirectory, 'licenses/drizzle-orm-Apache-2.0.txt'),
  );
  await cp(
    path.join(repositoryRoot, 'licenses/THIRD-PARTY-NOTICES.md'),
    path.join(resolvedOutputDirectory, 'licenses/THIRD-PARTY-NOTICES.md'),
  );

  const dataDirectory = path.join(resolvedOutputDirectory, 'data/respondent-archetypes');
  await mkdir(dataDirectory, { recursive: true });
  for (const group of respondentArchetypeGroups) {
    await cp(
      path.join(repositoryRoot, 'src/domain/respondents/archetype-groups', group.filename),
      path.join(dataDirectory, group.filename),
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPlugin();
  await generatePluginPackage(repositoryRoot);
}

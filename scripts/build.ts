import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { respondentArchetypeGroups } from '../src/domain/respondents/archetype-catalogue.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

export async function buildPlugin(outputDirectory = path.join(repositoryRoot, 'dist')): Promise<void> {
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

  const dataDirectory = path.join(resolvedOutputDirectory, 'data/respondent-archetypes');
  await mkdir(dataDirectory, { recursive: true });
  for (const group of respondentArchetypeGroups) {
    await cp(
      path.join(repositoryRoot, 'src/domain/respondents/archetype-groups', group.filename),
      path.join(dataDirectory, group.filename),
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildPlugin();

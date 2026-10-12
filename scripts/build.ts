import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { respondentArchetypeGroups } from '../src/domain/respondents/archetype-catalogue.js';
import { codecAssetNames } from '../src/infrastructure/images/codec-assets.js';
import { MIGRATION_ASSET_DIRECTORIES } from '../src/infrastructure/sqlite/schema.js';
import { syncPackageLockVersion } from './generate-package-lock.js';
import { syncPluginManifest } from './generate-plugin-manifest.js';
import { generatePluginPackage } from './generate-plugin-package.js';

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
    // Keep dependency labels stable when disposable checks link node_modules.
    preserveSymlinks: true,
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

  for (const directory of MIGRATION_ASSET_DIRECTORIES) {
    const migrationDirectory = path.join(resolvedOutputDirectory, 'migrations', directory);
    await mkdir(migrationDirectory, { recursive: true });
    await cp(path.join(repositoryRoot, 'migrations', directory, 'migration.sql'), path.join(migrationDirectory, 'migration.sql'));
  }
  await cp(
    path.join(repositoryRoot, 'licenses/drizzle-orm-Apache-2.0.txt'),
    path.join(resolvedOutputDirectory, 'licenses/drizzle-orm-Apache-2.0.txt'),
  );
  await cp(
    path.join(repositoryRoot, 'licenses/THIRD-PARTY-NOTICES.md'),
    path.join(resolvedOutputDirectory, 'licenses/THIRD-PARTY-NOTICES.md'),
  );

  const codecAssetDirectory = path.join(resolvedOutputDirectory, 'codec-assets');
  await mkdir(codecAssetDirectory, { recursive: true });
  const codecSources: Record<string, string> = {
    'squoosh_png_bg.wasm': 'node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm',
    'mozjpeg_dec.wasm': 'node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm',
    'mozjpeg_enc.wasm': 'node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm',
    'webp_dec.wasm': 'node_modules/@jsquash/webp/codec/dec/webp_dec.wasm',
    'webp_enc_simd.wasm': 'node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm',
    'squoosh_resize_bg.wasm': 'node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm',
  };
  for (const name of codecAssetNames) {
    const source = codecSources[name];
    if (!source) throw new Error(`No build-owned image codec asset source for ${name}.`);
    await cp(path.join(repositoryRoot, source), path.join(codecAssetDirectory, name));
  }
  for (const [packageName, notices] of Object.entries({
    png: ['LICENSE', 'codec/LICENSE.codec.md'],
    jpeg: ['LICENSE', 'codec/LICENSE.codec.md'],
    webp: ['LICENSE', 'codec/LICENSE.codec.md'],
    resize: ['LICENSE'],
  })) {
    for (const notice of notices) {
      const target = path.join(resolvedOutputDirectory, 'licenses', 'jsquash', packageName, path.basename(notice));
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(repositoryRoot, 'node_modules', '@jsquash', packageName, notice), target);
    }
  }

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
  await syncPackageLockVersion(repositoryRoot);
  await syncPluginManifest(repositoryRoot);
  await buildPlugin();
  await generatePluginPackage(repositoryRoot);
}

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type PluginTemplate = Record<string, unknown> & { name: string };
type PackageIdentity = { version: string };

export function createPluginManifest(template: PluginTemplate, packageIdentity: PackageIdentity): Record<string, unknown> {
  if (!template.name || typeof template.name !== 'string') throw new Error('The plugin template must declare a name.');
  if (!/^\d+\.\d+\.\d+(?:-(?:dev|rc)\.\d+)?$/.test(packageIdentity.version)) {
    throw new Error('package.json must declare a supported stable or prerelease version.');
  }
  if (Object.hasOwn(template, 'version')) throw new Error('The plugin template must not declare a version.');
  return Object.fromEntries(Object.entries(template).flatMap(([key, value]) => key === 'name'
    ? [['name', value], ['version', packageIdentity.version]]
    : [[key, value]]));
}

export async function syncPluginManifest(repositoryRoot: string): Promise<void> {
  const [templateText, packageText] = await Promise.all([
    readFile(path.join(repositoryRoot, 'plugin.template.json'), 'utf8'),
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  ]);
  const template = JSON.parse(templateText) as PluginTemplate;
  const packageIdentity = JSON.parse(packageText) as PackageIdentity;
  const manifest = createPluginManifest(template, packageIdentity);
  await writeFile(path.join(repositoryRoot, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

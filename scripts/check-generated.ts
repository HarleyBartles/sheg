import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from './build.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const generatedDirectories = ['dist', 'skills/stimulus-response-polling/assets'];
const generatedFiles = ['plugin.json'];

async function snapshot(): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const directory of generatedDirectories) {
    const absoluteDirectory = path.join(root, directory);
    for (const entry of await readdir(absoluteDirectory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const absolutePath = path.join(entry.parentPath, entry.name);
      files.set(path.relative(root, absolutePath), await readFile(absolutePath));
    }
  }
  for (const file of generatedFiles) files.set(file, await readFile(path.join(root, file)));
  return files;
}

const before = await snapshot();
await import('./generate-contracts.js');
await buildPlugin();
const after = await snapshot();
const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
  (file) => !before.get(file)?.equals(after.get(file) ?? Buffer.alloc(0)) || !after.has(file),
);
if (changed.length > 0) {
  throw new Error(`Generated files differ from the checked-in build:\n${changed.sort().join('\n')}`);
}

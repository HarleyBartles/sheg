import { cp, mkdir } from 'node:fs/promises';

const source = new URL('../src/domain/readers/reader-archetypes.json', import.meta.url);
const target = new URL('../dist/data/reader-archetypes.json', import.meta.url);
await mkdir(new URL('../dist/data/', import.meta.url), { recursive: true });
await cp(source, target, { force: true });

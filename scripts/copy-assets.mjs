import { cp, mkdir, rm } from 'node:fs/promises';

const source = new URL('../src/domain/readers/reader-archetypes.json', import.meta.url);
const target = new URL('../dist/data/reader-archetypes.json', import.meta.url);
const obsoleteTarget = new URL('../dist/skills/simulated-reader-polling/assets/reader-archetypes.json', import.meta.url);
await mkdir(new URL('../dist/data/', import.meta.url), { recursive: true });
await cp(source, target, { force: true });
await rm(obsoleteTarget, { force: true });

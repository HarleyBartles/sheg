import { cp, mkdir } from 'node:fs/promises';

const source = new URL('../skills/simulated-reader-polling/assets/', import.meta.url);
const target = new URL('../dist/skills/simulated-reader-polling/assets/', import.meta.url);
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });

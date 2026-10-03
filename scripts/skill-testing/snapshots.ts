import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export interface GuidanceSnapshot {
  skillMarkdown: string;
  references: Record<string, string>;
  hashes: Record<string, string>;
  description: string;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function containedFile(root: string, relative: string): string {
  const referencesRoot = path.resolve(root, 'references');
  const resolved = path.resolve(root, relative);
  const relativePath = path.relative(referencesRoot, resolved);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Guidance reference escapes its references directory: ${relative}`);
  }
  const realRoot = realpathSync(referencesRoot);
  const realFile = realpathSync(resolved);
  const realRelative = path.relative(realRoot, realFile);
  if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`Guidance reference resolves outside its references directory: ${relative}`);
  }
  if (!statSync(realFile).isFile()) throw new Error(`Guidance reference is not a file: ${relative}`);
  return realFile;
}

export function readGuidanceSnapshot(guidanceRoot: string, referencePaths: string[]): GuidanceSnapshot {
  const root = path.resolve(guidanceRoot);
  const skillMarkdown = readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const references: Record<string, string> = {};
  const hashes: Record<string, string> = { 'SKILL.md': sha256(skillMarkdown) };
  for (const reference of [...new Set(referencePaths)].sort()) {
    const text = readFileSync(containedFile(root, reference), 'utf8');
    references[reference] = text;
    hashes[reference] = sha256(text);
  }
  const description = /^description:\s*(.+)$/m.exec(skillMarkdown)?.[1]?.trim();
  if (!description) throw new Error(`Skill description is missing from ${path.join(root, 'SKILL.md')}`);
  return { skillMarkdown, references, hashes, description };
}

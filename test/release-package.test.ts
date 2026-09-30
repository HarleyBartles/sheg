import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const wrapper = path.join(repositoryRoot, 'scripts/package-plugin.mjs');
const python = process.platform === 'win32' ? ['py', ['-3']] as const : ['python3', []] as const;
const packageManifest = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
  version: string;
};
const releaseTag = `v${packageManifest.version}`;
const [major, minor, patch] = packageManifest.version.split('.');
const mismatchedTag = `v${major}.${minor}.${Number(patch) + 1}`;

function runPackage(args: string[]): string {
  return execFileSync(process.execPath, [wrapper, ...args], { cwd: repositoryRoot, encoding: 'utf8' });
}

function runPackageResult(args: string[]) {
  return spawnSync(process.execPath, [wrapper, ...args], { cwd: repositoryRoot, encoding: 'utf8' });
}

function listArchive(archivePath: string): string[] {
  const [command, prefix] = python;
  const result = execFileSync(command, [...prefix, 'scripts/package-plugin.py', '--list', archivePath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return JSON.parse(result) as string[];
}

test('release package validates tags against private package and plugin versions', () => {
  assert.match(runPackage(['--tag', releaseTag, '--validate-only']), new RegExp(`OK ${releaseTag}`));
  const mismatch = runPackageResult(['--tag', mismatchedTag, '--validate-only']);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, new RegExp(`release tag version .* does not match manifest version ${packageManifest.version}`));
  const malformed = runPackageResult(['--tag', 'v0.01.0', '--validate-only']);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /invalid release tag/);
});

test('release package contains plugin runtime inputs and is byte-for-byte reproducible', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'sheg-release-'));
  try {
    const first = path.join(temporaryDirectory, 'first.zip');
    const second = path.join(temporaryDirectory, 'second.zip');
    runPackage(['--tag', releaseTag, '--output', first]);
    runPackage(['--tag', releaseTag, '--output', second]);

    const firstHash = createHash('sha256').update(readFileSync(first)).digest('hex');
    const secondHash = createHash('sha256').update(readFileSync(second)).digest('hex');
    assert.equal(firstHash, secondHash);

    const files = listArchive(first);
    for (const required of [
      'LICENSE',
      'package.json',
      'plugin.json',
      'mcp.json',
      '.agents/plugins/marketplace.json',
      'skills/stimulus-response-polling/SKILL.md',
      'skills/study-design/SKILL.md',
      'dist/mcp.js',
      'dist/cli.js',
    ]) {
      assert.ok(files.includes(required), `archive should contain ${required}`);
    }
    assert.ok(files.every((file) => !file.startsWith('node_modules/')));
    assert.ok(files.every((file) => !file.startsWith('src/')));
    assert.ok(files.every((file) => !file.startsWith('test/')));
    assert.ok(files.every((file) => !file.endsWith('.ts')));

    const extractedDirectory = path.join(temporaryDirectory, 'extracted');
    const [pythonCommand, pythonPrefix] = python;
    execFileSync(
      pythonCommand,
      [
        ...pythonPrefix,
        '-c',
        'import pathlib,sys,zipfile; pathlib.Path(sys.argv[2]).mkdir(); zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
        first,
        extractedDirectory,
      ],
      { cwd: repositoryRoot },
    );
    const cliHelp = execFileSync(process.execPath, [path.join(extractedDirectory, 'dist/cli.js'), '--help'], {
      cwd: extractedDirectory,
      encoding: 'utf8',
    });
    assert.match(cliHelp, /sheg <command>/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

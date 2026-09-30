import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const wrapper = path.join(repositoryRoot, 'scripts/package-plugin.mjs');
const python = process.platform === 'win32' ? ['py', ['-3']] as const : ['python3', []] as const;
const isolatedGitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);
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

test('release validation rejects a stale npm lockfile root version', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'sheg-release-lock-'));
  try {
    const scriptDirectory = path.join(temporaryDirectory, 'scripts');
    const scriptPath = path.join(scriptDirectory, 'package-plugin.py');
    const packageVersion = '0.1.0';
    const packageManifest = { name: 'sheg', version: packageVersion, private: true };
    const pluginManifest = { version: packageVersion };
    const lockfile = {
      name: 'sheg',
      version: packageVersion,
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'sheg', version: packageVersion } },
    };
    const [pythonCommand, pythonPrefix] = python;
    const runFixture = () => spawnSync(pythonCommand, [...pythonPrefix, scriptPath, '--tag', `v${packageVersion}`, '--validate-only'], {
      encoding: 'utf8',
    });

    mkdirSync(scriptDirectory);
    copyFileSync(path.join(repositoryRoot, 'scripts/package-plugin.py'), scriptPath);
    writeFileSync(path.join(temporaryDirectory, 'package.json'), JSON.stringify(packageManifest));
    writeFileSync(path.join(temporaryDirectory, 'plugin.json'), JSON.stringify(pluginManifest));
    writeFileSync(path.join(temporaryDirectory, 'package-lock.json'), JSON.stringify(lockfile));
    assert.equal(runFixture().status, 0);

    lockfile.packages[''].version = '0.0.9';
    writeFileSync(path.join(temporaryDirectory, 'package-lock.json'), JSON.stringify(lockfile));
    const staleLockfile = runFixture();
    assert.notEqual(staleLockfile.status, 0);
    assert.match(staleLockfile.stderr, /package-lock\.json/);

    lockfile.packages[''].version = packageVersion;
    lockfile.version = '0.0.9';
    writeFileSync(path.join(temporaryDirectory, 'package-lock.json'), JSON.stringify(lockfile));
    const staleLockfileSummary = runFixture();
    assert.notEqual(staleLockfileSummary.status, 0);
    assert.match(staleLockfileSummary.stderr, /package-lock\.json/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('release validation rejects a tag retargeted away from its triggering commit', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'sheg-release-ref-'));
  try {
    const scriptDirectory = path.join(temporaryDirectory, 'scripts');
    const scriptPath = path.join(scriptDirectory, 'package-plugin.py');
    const packageVersion = '0.1.0';
    const lockfile = {
      name: 'sheg',
      version: packageVersion,
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'sheg', version: packageVersion } },
    };
    mkdirSync(scriptDirectory);
    copyFileSync(path.join(repositoryRoot, 'scripts/package-plugin.py'), scriptPath);
    writeFileSync(path.join(temporaryDirectory, 'package.json'), JSON.stringify({
      name: 'sheg', version: packageVersion, private: true,
    }));
    writeFileSync(path.join(temporaryDirectory, 'plugin.json'), JSON.stringify({ version: packageVersion }));
    writeFileSync(path.join(temporaryDirectory, 'package-lock.json'), JSON.stringify(lockfile));
    writeFileSync(path.join(temporaryDirectory, 'source.txt'), 'first release source');
    execFileSync('git', ['init', '--initial-branch=main'], {
      cwd: temporaryDirectory,
      env: isolatedGitEnv,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Sheg Test'], { cwd: temporaryDirectory, env: isolatedGitEnv });
    execFileSync('git', ['config', 'user.email', 'sheg-test@example.invalid'], {
      cwd: temporaryDirectory,
      env: isolatedGitEnv,
    });
    execFileSync('git', ['add', '.'], { cwd: temporaryDirectory, env: isolatedGitEnv });
    execFileSync('git', ['commit', '-m', 'release source'], {
      cwd: temporaryDirectory,
      env: isolatedGitEnv,
      stdio: 'ignore',
    });
    const triggeringCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: temporaryDirectory,
      env: isolatedGitEnv,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['tag', '-a', `v${packageVersion}`, '-m', 'release tag'], {
      cwd: temporaryDirectory,
      env: isolatedGitEnv,
    });

    const [pythonCommand, pythonPrefix] = python;
    const runValidation = (commit: string) => spawnSync(
      pythonCommand,
      [...pythonPrefix, scriptPath, '--tag', `v${packageVersion}`, '--commit', commit, '--validate-only'],
      { cwd: temporaryDirectory, encoding: 'utf8', env: isolatedGitEnv },
    );
    assert.equal(runValidation(triggeringCommit).status, 0);

    writeFileSync(path.join(temporaryDirectory, 'source.txt'), 'retargeted release source');
    execFileSync('git', ['add', 'source.txt'], { cwd: temporaryDirectory, env: isolatedGitEnv });
    execFileSync('git', ['commit', '-m', 'retarget release tag'], {
      cwd: temporaryDirectory,
      env: isolatedGitEnv,
      stdio: 'ignore',
    });
    execFileSync('git', ['tag', '--force', '-a', `v${packageVersion}`, '-m', 'retargeted release tag'], {
      cwd: temporaryDirectory,
      env: isolatedGitEnv,
      stdio: 'ignore',
    });

    const retargetedTag = runValidation(triggeringCommit);
    assert.notEqual(retargetedTag.status, 0);
    assert.match(retargetedTag.stderr, /resolves to .* not triggering commit/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
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

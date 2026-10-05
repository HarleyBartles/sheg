import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const contractPath = path.join(root, '.agents/contracts/operating-standards.json');
const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as {
  standards: Array<{ id: string; source_repository: string; commit: string; definition_path: string; certification: string }>;
};
const requiredStandardIds = ['unslop', 'playbook-composition', 'runbook-composition'];
assert.deepEqual(contract.standards.map((standard) => standard.id).sort(), requiredStandardIds.sort());
for (const standard of contract.standards) {
  assert.match(standard.source_repository, /^https:\/\//);
  assert.match(standard.commit, /^[a-f\d]{40}$/i);
  assert.ok(standard.definition_path.startsWith('skills/') && !standard.definition_path.includes('..'));
  assert.ok(existsSync(path.resolve(path.dirname(contractPath), standard.certification)), `Missing certification for ${standard.id}.`);
}

const guidancePaths = [
  'AGENTS.md',
  'README.md',
  '.agents/doctrine/repo-runbook-policy.md',
  '.agents/contracts/standards-certification.md',
  '.agents/runbooks/implementing.md',
  '.agents/runbooks/pr.md',
  '.agents/playbooks/gitflow-branch-and-release.md',
  '.agents/playbooks/semver-version-alignment.md',
  '.agents/playbooks/source-quality.md',
  '.agents/unslop/boundary-drift.md',
  '.agents/unslop/single-owner-and-reuse.md',
];
const guidance = new Map(guidancePaths.map((relativePath) => [relativePath, readFileSync(path.join(root, relativePath), 'utf8')]));
for (const relativePath of guidancePaths) checkLocalLinks(relativePath, guidance.get(relativePath)!);

const rootAgent = guidance.get('AGENTS.md')!;
assert.match(rootAgent, /\.agents\/contracts\/operating-standards\.json/);
assert.match(rootAgent, /\.agents\/contracts\/standards-certification\.md/);
const policy = guidance.get('.agents/doctrine/repo-runbook-policy.md')!;
assert.match(policy, /\.agents\/runbooks\/implementing\.md/);
assert.match(policy, /\.agents\/runbooks\/pr\.md/);
assert.match(policy, /\.agents\/playbooks\/source-quality\.md/);
for (const runbookPath of ['.agents/runbooks/implementing.md', '.agents/runbooks/pr.md']) {
  assert.match(guidance.get(runbookPath)!, /\.\.\/playbooks\/source-quality\.md/);
}
const sourceQuality = guidance.get('.agents/playbooks/source-quality.md')!;
assert.match(sourceQuality, /\.\.\/unslop\/boundary-drift\.md/);
assert.match(sourceQuality, /\.\.\/unslop\/single-owner-and-reuse\.md/);

function checkLocalLinks(relativePath: string, markdown: string): void {
  for (const [, rawTarget] of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = (rawTarget ?? '').trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0]!;
    if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    const resolved = path.resolve(root, path.dirname(relativePath), decodeURIComponent(target));
    assert.ok(existsSync(resolved), `${relativePath} links to missing path ${target}.`);
  }
}

process.stdout.write('Agent guidance subscriptions and local routes are valid.\n');

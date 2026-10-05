import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

const playbookPaths = readdirSync(path.join(root, '.agents/playbooks'))
  .filter((name) => name.endsWith('.md'))
  .map((name) => `.agents/playbooks/${name}`);
const runbookPaths = ['.agents/runbooks/implementing.md', '.agents/runbooks/pr.md'];
const playbookSections = ['Applicability', 'Method', 'Constraints', 'Verification', 'References and routing', 'Maintenance'];
const guidancePaths = [
  'AGENTS.md',
  'README.md',
  '.agents/doctrine/repo-runbook-policy.md',
  '.agents/contracts/standards-certification.md',
  '.agents/runbooks/implementing.md',
  '.agents/runbooks/pr.md',
  ...playbookPaths,
  '.agents/unslop/boundary-drift.md',
  '.agents/unslop/single-owner-and-reuse.md',
];
const guidance = new Map(guidancePaths.map((relativePath) => [relativePath, readFileSync(path.join(root, relativePath), 'utf8')]));
for (const relativePath of guidancePaths) checkLocalLinks(relativePath, guidance.get(relativePath)!);

const rootAgent = guidance.get('AGENTS.md')!;
assert.match(rootAgent, /\.agents\/contracts\/operating-standards\.json/);
assert.match(rootAgent, /\.agents\/contracts\/standards-certification\.md/);
const policy = guidance.get('.agents/doctrine/repo-runbook-policy.md')!;
const inventoriedPlaybooks = [...policy.matchAll(/`(\.agents\/playbooks\/[^`]+\.md)`/g)].map((match) => match[1]!);
assert.deepEqual(inventoriedPlaybooks.sort(), [...playbookPaths].sort(), 'The workflow inventory must match the actual playbooks.');
for (const playbookPath of playbookPaths) {
  const markdown = guidance.get(playbookPath)!;
  assert.equal([...markdown.matchAll(/^# .+\r?$/gm)].length, 1, `${playbookPath} must have one concern title.`);
  const sections = [...markdown.matchAll(/^## (.+)\r?$/gm)];
  assert.deepEqual(sections.map((match) => match[1]), playbookSections, `${playbookPath} must follow the Sheg playbook layout.`);
  for (let index = 0; index < sections.length; index += 1) {
    const start = sections[index]!.index! + sections[index]![0].length;
    const end = sections[index + 1]?.index ?? markdown.length;
    const body = markdown.slice(start, end).trim();
    assert.ok(body.length > 0 && !/^(?:None\.?|TBD|TODO)$/i.test(body), `${playbookPath}: ${playbookSections[index]} must contain guidance.`);
  }
  assert.ok(policy.includes(playbookPath), `${playbookPath} is missing from the workflow inventory.`);
  const stages = runbookPaths.filter((runbookPath) => markdown.includes(`../runbooks/${path.basename(runbookPath)}`));
  const inboundStages = runbookPaths.filter((runbookPath) => guidance.get(runbookPath)!.includes(`../playbooks/${path.basename(playbookPath)}`));
  assert.deepEqual(stages, inboundStages, `${playbookPath} stage links must match its inbound routes.`);
  assert.ok(stages.length > 0, `${playbookPath} must link to its applicable lifecycle stage.`);
  for (const runbookPath of stages) {
    assert.ok(guidance.get(runbookPath)!.includes(`../playbooks/${path.basename(playbookPath)}`), `${runbookPath} must route to ${playbookPath}.`);
  }
}
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

process.stdout.write('Agent guidance subscriptions, Sheg playbook structure, and local routes are valid.\n');

import { RunManager } from '../application/jobs.js';

const [outputDirectory, runId] = process.argv.slice(2);
if (!outputDirectory || !runId) throw new Error('Usage: worker <output-directory> <run-id>');
const manager = new RunManager();
await manager.resumeRun(outputDirectory, runId);
let status = await manager.runStatus(outputDirectory, runId);
while (status.status === 'running') {
  await new Promise((resolve) => setTimeout(resolve, 250));
  status = await manager.runStatus(outputDirectory, runId);
}
process.stdout.write(`${JSON.stringify(status)}\n`);

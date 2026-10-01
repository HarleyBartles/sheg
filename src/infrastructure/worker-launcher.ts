import { spawn } from 'node:child_process';
import path from 'node:path';
import type { WorkerLauncher } from '../application/run-service.js';

export class DetachedWorkerLauncher implements WorkerLauncher {
  constructor(private readonly workerPath = path.join(path.dirname(path.resolve(process.argv[1] ?? process.execPath)), 'worker.js')) {}

  async launch(dataRoot: string, runId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [this.workerPath, dataRoot, runId], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
      });
      child.once('error', () => reject(new Error('Worker process could not be started.')));
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
}

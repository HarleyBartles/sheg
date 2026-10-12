import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JevRoute } from '../../providers/jev/config.js';

export type CredentialRoute = JevRoute | 'clef';

export type CredentialAvailability = 'available' | 'missing' | 'malformed' | 'unavailable';
export type CredentialStoreErrorCode = 'credential_malformed' | 'credential_missing' | 'credential_unavailable';

export class CredentialStoreError extends Error {
  constructor(readonly code: CredentialStoreErrorCode, readonly route: CredentialRoute) {
    const routeLabel = route === 'clef' ? 'Cloudflare Clef' : route;
    const message = code === 'credential_malformed'
      ? `The ${routeLabel} secure credential is present but uses an unsupported encoding. Sheg can read UTF-8 or UTF-16LE credentials; re-enter it with Sheg's credential setup.`
      : code === 'credential_missing'
        ? `The ${routeLabel} secure credential is missing.`
        : `The ${routeLabel} secure credential is unavailable.`;
    super(message);
    this.name = 'CredentialStoreError';
  }
}

export type WindowsCredentialStoreOptions = {
  helperPath?: string;
  credentialTargets?: Partial<Record<CredentialRoute, string>>;
  run?: (args: string[], interactive?: boolean) => Promise<{ code: number; stdout: string; stderr: string }>;
};

const defaultTargets: Record<CredentialRoute, string> = {
  typesafe: 'Sheg/Jev/TypeSafe',
  openrouter: 'Sheg/Jev/OpenRouter',
  clef: 'Sheg/Clef/Cloudflare',
};

export class WindowsCredentialStore {
  private readonly targets: Record<CredentialRoute, string>;
  private readonly helperPath: string;
  private readonly run: NonNullable<WindowsCredentialStoreOptions['run']>;

  constructor(options: WindowsCredentialStoreOptions = {}) {
    this.targets = { ...defaultTargets, ...options.credentialTargets };
    for (const [route, target] of Object.entries(options.credentialTargets ?? {})) {
      if (!/^Sheg\/Test\/[0-9a-f-]{36}$/i.test(target)) throw new Error(`The ${route} credential target is fixed and cannot be redirected.`);
    }
    this.helperPath = options.helperPath ?? locateHelper();
    this.run = options.run ?? ((args, interactive) => runPowerShell(this.helperPath, args, interactive));
  }

  async availability(route: CredentialRoute): Promise<CredentialAvailability> {
    try {
      const result = await this.run(this.arguments('Status', route));
      if (result.code === 0 && result.stdout.trim() === 'AVAILABLE') return 'available';
      if (result.code === 3 && result.stdout.trim() === 'MISSING') return 'missing';
      if (result.code === 4 && result.stdout.trim() === 'MALFORMED') return 'malformed';
      return 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  async readForAuthentication(route: CredentialRoute): Promise<string> {
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await this.run(this.arguments('Read', route));
    } catch {
      throw new CredentialStoreError('credential_unavailable', route);
    }
    const key = result.stdout.replace(/\r?\n$/, '');
    if (result.code === 4 && result.stdout.trim() === 'MALFORMED') throw new CredentialStoreError('credential_malformed', route);
    if (result.code !== 0 || !key) throw new CredentialStoreError('credential_unavailable', route);
    return key;
  }

  async setup(route: CredentialRoute): Promise<void> {
    const result = await this.run(this.arguments('Setup', route), true);
    if (result.code !== 0) throw new Error(`The ${route} secure credential could not be saved.`);
  }

  async remove(route: CredentialRoute): Promise<void> {
    const result = await this.run(this.arguments('Remove', route));
    if (result.code !== 0 && result.code !== 3) throw new Error(`The ${route} secure credential could not be removed.`);
  }

  private arguments(operation: string, route: CredentialRoute): string[] {
    return ['-Operation', operation, '-TargetName', this.targets[route]];
  }
}

function locateHelper(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDirectory, 'windows-credential.ps1'),
    path.join(moduleDirectory, 'credentials', 'windows-credential.ps1'),
  ];
  const helper = candidates.find(existsSync);
  if (!helper) throw new Error('The Windows credential helper is unavailable.');
  return helper;
}

async function runPowerShell(helperPath: string, args: string[], interactive = false): Promise<{ code: number; stdout: string; stderr: string }> {
  if (process.platform !== 'win32') throw new Error('Windows secure credentials are unavailable on this platform.');
  const childArgs = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
  ];
  if (interactive) childArgs.splice(2, 1);
  childArgs.push(helperPath, ...args);
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']
    .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name] as string]]));
  return new Promise((resolve, reject) => {
    const child = nodeSpawn('powershell.exe', childArgs, {
      windowsHide: !interactive,
      shell: false,
      stdio: interactive ? ['inherit', 'inherit', 'ignore'] : ['ignore', 'pipe', 'ignore'],
      env,
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let settled = false;
    const finish = (error?: Error, code = 1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout, stderr: '' });
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Credential helper timed out.')); }, interactive ? 300_000 : 10_000);
    if (!interactive) child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 16_384) { child.kill(); finish(new Error('Credential helper output exceeded its limit.')); }
    });
    child.once('error', () => finish(new Error('Credential helper could not start.')));
    child.once('close', (code) => finish(undefined, code ?? 1));
  });
}

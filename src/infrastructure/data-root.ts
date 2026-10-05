import path from 'node:path';

type PathApi = typeof path.win32 | typeof path.posix;

function pathsFor(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

function requiredAbsolute(value: string | undefined, name: string, paths: PathApi, allowMissing = false): string | undefined {
  if (value === undefined && allowMissing) return undefined;
  if (value === undefined || value.length === 0) throw new TypeError(`${name} must not be empty.`);
  if (!paths.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path.`);
  return paths.normalize(value);
}

export function resolveDataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  const paths = pathsFor(platform);
  const explicit = env.SHEG_DATA_DIR;
  if (explicit !== undefined) return requiredAbsolute(explicit, 'SHEG_DATA_DIR', paths)!;

  const absoluteHome = requiredAbsolute(home, 'Home directory', paths)!;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    const base = local === undefined ? paths.join(absoluteHome, 'AppData', 'Local') : requiredAbsolute(local, 'LOCALAPPDATA', paths)!;
    return paths.join(base, 'Sheg');
  }
  if (platform === 'darwin') return paths.join(absoluteHome, 'Library', 'Application Support', 'Sheg');

  const xdg = env.XDG_DATA_HOME;
  const base = xdg === undefined ? paths.join(absoluteHome, '.local', 'share') : requiredAbsolute(xdg, 'XDG_DATA_HOME', paths)!;
  return paths.join(base, 'sheg');
}

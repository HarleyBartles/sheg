import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageAssetError, type ImageMetadata } from '../../domain/assets/image.js';

export async function exportImageAsset(root: string, asset: ImageMetadata, bytes: Uint8Array): Promise<{ asset: ImageMetadata; path: string }> {
  if (!path.isAbsolute(root)) throw new ImageAssetError('image_export_failed', 'The image preview directory must be absolute.');
  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  if (expectedHash !== asset.sha256 || bytes.byteLength !== asset.bytes) throw new ImageAssetError('image_digest_mismatch', 'Stored image bytes do not match their metadata.');
  const rootPath = path.resolve(root);
  const directory = path.join(rootPath, 'asset-previews');
  const target = path.join(directory, `${asset.sha256}.${asset.format === 'jpeg' ? 'jpg' : asset.format}`);
  const temporary = path.join(directory, `.${asset.sha256}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    const [realRoot, realDirectory] = await Promise.all([realpath(rootPath), realpath(directory)]);
    if (realDirectory !== path.join(realRoot, 'asset-previews')) throw new Error('preview directory resolves outside the data root');
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('preview target is not a regular file');
      const current = await readFile(target);
      const currentHash = createHash('sha256').update(current).digest('hex');
      if (currentHash === asset.sha256 && current.byteLength === asset.bytes) return { asset, path: target };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
    return { asset, path: target };
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new ImageAssetError('image_export_failed', 'The image preview could not be safely written under Sheg storage.');
  }
}

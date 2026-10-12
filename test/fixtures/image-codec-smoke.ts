import { readFile, writeFile } from 'node:fs/promises';
import { createStaticImageCodec } from '../../src/infrastructure/images/codecs.js';

const [assetDirectory, inputPath, outputPath] = process.argv.slice(2);
if (!assetDirectory || !inputPath || !outputPath) throw new Error('asset directory, input and output paths are required');
try {
  const codec = createStaticImageCodec(assetDirectory);
  const image = await codec.decode(await readFile(inputPath));
  const scaled = await codec.scale(image, 40, 20);
  const encoded = await codec.encode(scaled);
  const verified = await codec.decode(encoded);
  await writeFile(outputPath, encoded);
  process.stdout.write(JSON.stringify({ width: verified.width, height: verified.height, format: verified.format }));
} catch (error) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : 'unknown';
  process.stdout.write(JSON.stringify({ code }));
  process.exitCode = 1;
}

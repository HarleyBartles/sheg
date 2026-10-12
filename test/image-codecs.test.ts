import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createStaticImageCodec } from '../src/infrastructure/images/codecs.js';

const fixture = (name: string) => readFile(new URL(`./fixtures/images/${name}`, import.meta.url));
const codec = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sheg-codec-'));
  const root = fileURLToPath(new URL('../node_modules/@jsquash/', import.meta.url));
  const assets = [
    ['png/codec/pkg/squoosh_png_bg.wasm', 'squoosh_png_bg.wasm'],
    ['jpeg/codec/dec/mozjpeg_dec.wasm', 'mozjpeg_dec.wasm'],
    ['jpeg/codec/enc/mozjpeg_enc.wasm', 'mozjpeg_enc.wasm'],
    ['webp/codec/dec/webp_dec.wasm', 'webp_dec.wasm'],
    ['webp/codec/enc/webp_enc_simd.wasm', 'webp_enc_simd.wasm'],
    ['resize/lib/resize/pkg/squoosh_resize_bg.wasm', 'squoosh_resize_bg.wasm'],
  ];
  await Promise.all(assets.map(([source, target]) => cp(path.join(root, source!), path.join(directory, target!))));
  return { codec: createStaticImageCodec(directory), dispose: () => rm(directory, { recursive: true, force: true }) };
};

function assertCornerColors(data: Uint8ClampedArray, width: number, height: number): void {
  const samples = [[5, 5, [255, 0, 0]], [width - 6, 5, [0, 255, 0]], [5, height - 6, [0, 0, 255]], [width - 6, height - 6, [255, 255, 0]]] as const;
  for (const [x, y, expected] of samples) {
    const offset = (y * width + x) * 4;
    for (let channel = 0; channel < 3; channel += 1) assert.ok(Math.abs(data[offset + channel]! - expected[channel]!) < 20);
  }
}

test('decodes, proportionally scales and re-encodes PNG while retaining every corner and transparency', async () => {
  const local = await codec();
  const source = await local.codec.decode(await fixture('four-corners-transparent.png'));
  assert.deepEqual([source.width, source.height, source.format], [80, 40, 'png']);
  assert.equal(source.data[(20 * 80 + 40) * 4 + 3], 0);
  const scaled = await local.codec.scale(source, 40, 20);
  assert.deepEqual([scaled.width, scaled.height], [40, 20]);
  assertCornerColors(scaled.data, scaled.width, scaled.height);
  const candidate = await local.codec.decode(await local.codec.encode(scaled));
  assert.equal(candidate.format, 'png');
  assertCornerColors(candidate.data, candidate.width, candidate.height);
  await local.dispose();
});

test('decodes JPEG and WebP through local codecs and rejects truncated content', async () => {
  const local = await codec();
  for (const format of ['jpeg', 'webp'] as const) {
    const image = await local.codec.decode(await fixture(`four-corners.${format}`));
    assert.deepEqual([image.width, image.height, image.format], [80, 40, format]);
    if (format === 'webp') assert.equal(image.data[(20 * 80 + 40) * 4 + 3], 0);
    const encoded = await local.codec.encode(await local.codec.scale(image, 40, 20));
    assert.equal((await local.codec.decode(encoded)).format, format);
  }
  await assert.rejects(local.codec.decode(Buffer.from('not an image')), { code: 'image_format_unsupported' });
  await local.dispose();
});

test('rejects animated WebP before decode', async () => {
  const local = await codec();
  await assert.rejects(local.codec.decode(await fixture('animated.webp')), { code: 'image_animation_unsupported' });
  await local.dispose();
});

test('rejects truncated containers and applies JPEG display orientation', async () => {
  const local = await codec();
  await assert.rejects(local.codec.decode(await fixture('truncated.png')), { code: 'image_decode_failed' });
  const jpeg = await fixture('four-corners.jpeg');
  const [truncated, intact] = await Promise.allSettled([
    local.codec.decode(jpeg.subarray(0, jpeg.length - 100)),
    local.codec.decode(jpeg),
  ]);
  assert.equal(truncated.status, 'rejected');
  if (truncated.status === 'rejected') assert.equal(truncated.reason.code, 'image_decode_failed');
  assert.equal(intact.status, 'fulfilled');
  const oriented = await local.codec.decode(await fixture('orientation-6.jpeg'));
  assert.deepEqual([oriented.width, oriented.height, oriented.orientation], [40, 80, 6]);
  await local.dispose();
});

test('codec refuses non-proportional dimensions and never upscales', async () => {
  const local = await codec();
  const image = await local.codec.decode(await fixture('four-corners-transparent.png'));
  await assert.rejects(local.codec.scale(image, 40, 40), { code: 'image_scale_target_unreachable' });
  await assert.rejects(local.codec.scale(image, 120, 60), { code: 'image_scale_target_unreachable' });
  await local.dispose();
});

test('unsupported image formats return a distinct bounded diagnostic', async () => {
  const local = await codec();
  await assert.rejects(local.codec.decode(Buffer.from('GIF89a')), { code: 'image_format_unsupported' });
  await local.dispose();
});

test('rejects oversized sources and dimensions before decoding', async () => {
  const local = await codec();
  const tooManyPixels = Buffer.from(await fixture('four-corners-transparent.png'));
  tooManyPixels.writeUInt32BE(5_000, 16);
  tooManyPixels.writeUInt32BE(5_000, 20);
  await assert.rejects(local.codec.decode(tooManyPixels), { code: 'image_source_limit' });
  await assert.rejects(local.codec.decode(Buffer.alloc(16 * 1024 * 1024 + 1)), { code: 'image_source_limit' });
  await local.dispose();
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngDecode, { init as initPngDecode } from '@jsquash/png/decode.js';
import pngEncode, { init as initPngEncode } from '@jsquash/png/encode.js';
import jpegDecode, { init as initJpegDecode } from '@jsquash/jpeg/decode.js';
import jpegEncode, { init as initJpegEncode } from '@jsquash/jpeg/encode.js';
import webpDecode, { init as initWebpDecode } from '@jsquash/webp/decode.js';
import webpEncode, { init as initWebpEncode } from '@jsquash/webp/encode.js';
import resize, { initResize } from '@jsquash/resize';
import { ImageAssetError } from '../../domain/assets/image.js';
import { codecAssetNames } from './codec-assets.js';

export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type DecodedImage = { data: Uint8ClampedArray; width: number; height: number; format: ImageFormat; orientation: number };
export class ImageCodecError extends ImageAssetError {}

let activeJpegDecoderWarnings: string[] | undefined;
let jpegDecodeQueue = Promise.resolve();

async function decodeCompleteJpeg(bytes: ArrayBuffer): Promise<ImageDataValue> {
  const previous = jpegDecodeQueue;
  let release!: () => void;
  jpegDecodeQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const warnings: string[] = [];
    activeJpegDecoderWarnings = warnings;
    const decoded = await jpegDecode(bytes as never) as unknown as ImageDataValue;
    if (warnings.length > 0) throw new Error('JPEG decoder reported an incomplete or corrupt stream');
    return decoded;
  } finally {
    activeJpegDecoderWarnings = undefined;
    release();
  }
}

const MAX_ENCODED_BYTES = 16 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const WASM = {
  png: codecAssetNames[0], jpegDecode: codecAssetNames[1], jpegEncode: codecAssetNames[2],
  webpDecode: codecAssetNames[3], webpEncode: codecAssetNames[4], resize: codecAssetNames[5],
} as const;
const compileWasm = (bytes: Uint8Array): Promise<object> =>
  (globalThis as unknown as { WebAssembly: { compile(input: Uint8Array): Promise<object> } }).WebAssembly.compile(bytes);

type ImageDataValue = { data: Uint8ClampedArray; width: number; height: number };
const initJpegDecoder = initJpegDecode as unknown as (module: WebAssembly.Module, overrides: { printErr: (message: string) => void }) => Promise<void>;
export type StaticImageCodec = {
  decode(bytes: Uint8Array): Promise<DecodedImage>;
  scale(image: DecodedImage, width: number, height: number): Promise<DecodedImage>;
  encode(image: DecodedImage): Promise<Uint8Array>;
};

function readPngHeader(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value)) throw new Error('invalid PNG');
  let offset = 8;
  let width = 0; let height = 0; let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('truncated PNG');
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (type === 'IHDR') { width = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 8).getUint32(0); height = new DataView(bytes.buffer, bytes.byteOffset + offset + 12, 4).getUint32(0); }
    if (type === 'acTL') throw new ImageCodecError('image_animation_unsupported', 'Animated images are not supported.');
    if (type === 'IEND') { ended = length === 0 && end === bytes.length; break; }
    offset = end;
  }
  if (!ended || width < 1 || height < 1) throw new Error('invalid PNG container');
  return { width, height };
}

function readJpegHeader(bytes: Uint8Array): { width: number; height: number; orientation: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('invalid JPEG');
  let width = 0; let height = 0; let orientation = 1; let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('invalid JPEG segment');
    const marker = bytes[offset + 1]!; offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) throw new Error('truncated JPEG');
    const start = offset + 2; const end = offset + length;
    if (marker === 0xe1 && end - start >= 14 && String.fromCharCode(...bytes.subarray(start, start + 6)) === 'Exif\0\0') {
      const tiff = start + 6; const little = bytes[tiff] === 0x49;
      const u16 = (at: number) => new DataView(bytes.buffer, bytes.byteOffset + at, 2).getUint16(0, little);
      const u32 = (at: number) => new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, little);
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 <= end) for (let i = 0; i < u16(ifd); i += 1) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > end) break;
        if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) orientation = u16(entry + 8);
      }
    }
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
      height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!; width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
    }
    offset = end;
  }
  if (width < 1 || height < 1 || orientation < 1 || orientation > 8) throw new Error('invalid JPEG dimensions');
  return { width, height, orientation };
}

function readWebpHeader(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 30 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP' || new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true) + 8 !== bytes.length) throw new Error('invalid WebP');
  let width = 0; let height = 0; let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const end = offset + 8 + length + (length % 2);
    if (end > bytes.length) throw new Error('truncated WebP');
    if (type === 'ANIM' || type === 'ANMF') throw new ImageCodecError('image_animation_unsupported', 'Animated images are not supported.');
    const data = offset + 8;
    if (type === 'VP8X' && length >= 10) {
      if ((bytes[data]! & 2) !== 0) throw new ImageCodecError('image_animation_unsupported', 'Animated images are not supported.');
      width = 1 + bytes[data + 4]! + (bytes[data + 5]! << 8) + (bytes[data + 6]! << 16);
      height = 1 + bytes[data + 7]! + (bytes[data + 8]! << 8) + (bytes[data + 9]! << 16);
    } else if (type === 'VP8 ' && length >= 10) {
      width = (bytes[data + 6]! | (bytes[data + 7]! << 8)) & 0x3fff; height = (bytes[data + 8]! | (bytes[data + 9]! << 8)) & 0x3fff;
    } else if (type === 'VP8L' && length >= 5) {
      width = 1 + bytes[data + 1]! + ((bytes[data + 2]! & 0x3f) << 8);
      height = 1 + (bytes[data + 2]! >> 6) + (bytes[data + 3]! << 2) + ((bytes[data + 4]! & 0x0f) << 10);
    }
    offset = end;
  }
  if (offset !== bytes.length || width < 1 || height < 1) throw new Error('invalid WebP dimensions');
  return { width, height };
}

function sniff(bytes: Uint8Array): { format: ImageFormat; width: number; height: number; orientation: number } {
  if (bytes[0] === 137 && bytes[1] === 80) return { format: 'png', ...readPngHeader(bytes), orientation: 1 };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { format: 'jpeg', ...readJpegHeader(bytes) };
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return { format: 'webp', ...readWebpHeader(bytes), orientation: 1 };
  throw new ImageCodecError('image_format_unsupported', 'Only static PNG, JPEG, and WebP images are supported.');
}

function view(image: ImageDataValue): Omit<DecodedImage, 'format' | 'orientation'> {
  return { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
}

function orient(image: ImageDataValue, orientation: number): ImageDataValue {
  if (orientation === 1) return image;
  const swapsAxes = orientation >= 5;
  const width = swapsAxes ? image.height : image.width;
  const height = swapsAxes ? image.width : image.height;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    const target = orientation === 2 ? [image.width - 1 - x, y]
      : orientation === 3 ? [image.width - 1 - x, image.height - 1 - y]
        : orientation === 4 ? [x, image.height - 1 - y]
          : orientation === 5 ? [y, x]
            : orientation === 6 ? [image.height - 1 - y, x]
              : orientation === 7 ? [image.height - 1 - y, image.width - 1 - x]
                : [y, image.width - 1 - x];
    const sourceOffset = (y * image.width + x) * 4;
    const targetOffset = (target[1]! * width + target[0]!) * 4;
    data.set(image.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
  }
  return { data, width, height };
}

export function createStaticImageCodec(assetDirectory = fileURLToPath(new URL('./codec-assets/', import.meta.url))): StaticImageCodec {
  const asset = (name: string) => readFile(path.join(assetDirectory, name));
  let initialized: Promise<void> | undefined;
  async function initialize(): Promise<void> {
    if (!initialized) initialized = (async () => {
      const [png, jpegDec, jpegEnc, webpDec, webpEnc, resizeWasm] = await Promise.all(Object.values(WASM).map(asset));
      await initPngDecode(await compileWasm(png!) as never);
      await initPngEncode(await compileWasm(png!) as never);
      await initJpegDecoder(await compileWasm(jpegDec!) as WebAssembly.Module, { printErr: (message) => activeJpegDecoderWarnings?.push(message) });
      await initJpegEncode(await compileWasm(jpegEnc!) as never);
      await initWebpDecode(await compileWasm(webpDec!) as never);
      await initWebpEncode(await compileWasm(webpEnc!) as never);
      await initResize(await compileWasm(resizeWasm!) as never);
    })();
    try { await initialized; } catch { throw new ImageCodecError('image_codec_unavailable', 'The local image codec assets could not be loaded. Reinstall or rebuild Sheg.'); }
  }
  return {
    async decode(input) {
      try {
        if (input.byteLength > MAX_ENCODED_BYTES) throw new ImageCodecError('image_source_limit', 'The image exceeds the 16 MiB encoded image limit.');
        const bytes = new Uint8Array(input);
        const header = sniff(bytes);
        if (header.width * header.height > MAX_PIXELS) throw new ImageCodecError('image_source_limit', 'The image exceeds the 16 megapixel image limit.');
        await initialize();
        const imageBuffer = Uint8Array.from(bytes).buffer;
        let decoded: ImageDataValue;
        if (header.format === 'jpeg') {
          decoded = await decodeCompleteJpeg(imageBuffer);
        } else {
          decoded = header.format === 'png' ? await pngDecode(bytes as never) as unknown as ImageDataValue
            : await webpDecode(imageBuffer as never) as unknown as ImageDataValue;
        }
        const display = orient(decoded, header.orientation);
        const image = view(display);
        if (image.width !== (header.orientation >= 5 && header.orientation <= 8 ? header.height : header.width) || image.height !== (header.orientation >= 5 && header.orientation <= 8 ? header.width : header.height) || image.data.length !== image.width * image.height * 4) throw new Error('decoded dimensions mismatch');
        return { ...image, format: header.format, orientation: header.orientation };
      } catch (error) {
        if (error instanceof ImageCodecError) throw error;
        throw new ImageCodecError('image_decode_failed', 'The file is not a complete, supported static PNG, JPEG, or WebP image.');
      }
    },
    async scale(image, width, height) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new ImageCodecError('image_scale_target_unreachable', 'The requested image dimensions cannot be produced without changing its proportions.');
      const factor = Math.min(width / image.width, height / image.height);
      const expectedWidth = Math.max(1, Math.floor(image.width * factor));
      const expectedHeight = Math.max(1, Math.floor(image.height * factor));
      if (factor > 1 || Math.abs(width - expectedWidth) > 1 || Math.abs(height - expectedHeight) > 1) throw new ImageCodecError('image_scale_target_unreachable', 'The requested image dimensions cannot be produced without changing its proportions or enlarging the source.');
      await initialize();
      const scaled = await resize({ data: image.data, width: image.width, height: image.height } as never, { width, height, method: 'lanczos3', fitMethod: 'stretch' });
      const result = view(scaled);
      return { ...result, format: image.format, orientation: 1 };
    },
    async encode(image) {
      await initialize();
      const data = { data: image.data, width: image.width, height: image.height } as never;
      try {
        const bytes = image.format === 'png' ? await pngEncode(data) : image.format === 'jpeg' ? await jpegEncode(data, { quality: 90 }) : await webpEncode(data, { quality: 90, lossless: 0 });
        return new Uint8Array(bytes);
      } catch { throw new ImageCodecError('image_decode_failed', 'The image could not be encoded by the local codec.'); }
    },
  };
}


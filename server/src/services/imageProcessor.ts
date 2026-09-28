import { stat } from 'node:fs/promises';
import sharp, { type Metadata, type Sharp, type SharpOptions } from 'sharp';
import type { ProcessingLimits } from '../config/env.js';
import { HttpError, unprocessable, unsupportedMediaType } from '../lib/errors.js';
import { computeOutputSize, rotatedSize, type Size } from './geometry.js';
import { sniffFile, type InputFormat } from './imageSniffer.js';
import type { OutputFormat, ProcessOptions } from './processOptions.js';
import { DeadlineExceededError, encodeToTargetSize, type RawImage } from './targetSize.js';

// Never keep decoded pixels in libvips' operation cache between requests:
// it is a privacy leak across users and unbounded memory under load.
sharp.cache(false);

export const MIME_TYPES: Record<OutputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

export const FILE_EXTENSIONS: Record<OutputFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };

export interface ProcessRequest {
  filePath: string;
  options: ProcessOptions;
  limits: ProcessingLimits;
  timeoutSeconds: number;
}

export interface ProcessResult {
  buffer: Buffer;
  format: OutputFormat;
  width: number;
  height: number;
  /** Encoder quality used; null for lossless output. */
  quality: number | null;
  /** null when no target size was requested. */
  targetMet: boolean | null;
  downscaled: boolean;
  input: { format: InputFormat; width: number; height: number; bytes: number };
  durationMs: number;
}

const ALPHA_CAPABLE: ReadonlySet<OutputFormat> = new Set(['png', 'webp', 'avif']);

export function resolveOutputFormat(requested: ProcessOptions['format'], input: InputFormat, hasAlpha: boolean): OutputFormat {
  if (requested !== 'original') return requested;
  if (input === 'jpeg' || input === 'png' || input === 'webp' || input === 'avif') return input;
  // GIF and TIFF are input-only; pick the closest modern equivalent.
  return hasAlpha ? 'png' : 'jpeg';
}

/** Applies the encoder for `format`. `quality: null` requests lossless (PNG only). */
function applyEncoder(pipeline: Sharp, format: OutputFormat, quality: number | null): Sharp {
  switch (format) {
    case 'jpeg': {
      const q = quality ?? 90;
      // mozjpeg: trellis quantisation + optimised progressive scans (≈10–15% smaller at equal quality).
      return pipeline.jpeg({ quality: q, mozjpeg: true, chromaSubsampling: q >= 90 ? '4:4:4' : '4:2:0' });
    }
    case 'webp':
      return pipeline.webp({ quality: quality ?? 90, effort: 4, smartSubsample: true });
    case 'avif':
      return pipeline.avif({ quality: quality ?? 60, effort: 3 });
    case 'png':
      return quality === null
        ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
        : // libimagequant palette quantisation; quality bounds the allowed error.
          pipeline.png({ palette: true, quality, effort: 7, compressionLevel: 9, dither: 1 });
  }
}

function secondsLeft(deadline: number): number {
  return Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
}

/** Translates decoder/encoder failures into client-facing errors where appropriate. */
function mapSharpError(err: unknown): unknown {
  if (err instanceof HttpError) return err;
  if (err instanceof DeadlineExceededError) {
    return new HttpError(503, 'processing_timeout', 'Processing took too long. Try smaller dimensions or a larger target size.');
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/pixel limit/i.test(message)) {
    return new HttpError(413, 'image_too_large', 'The image has too many pixels to process.');
  }
  if (/timeout/i.test(message)) {
    return new HttpError(503, 'processing_timeout', 'Processing took too long. Try smaller dimensions or a larger target size.');
  }
  // libvips loader failures (truncated/corrupt data). Parameter errors are
  // deliberately not matched: those are our bugs and must surface as 500s.
  if (/(unsupported image format|corrupt|premature end|truncat|read error|bad seek|vipsjpeg|(jpeg|png|webp|heif|gif|tiff)load)/i.test(message)) {
    return unprocessable('invalid_image', 'The file could not be decoded as a valid image.');
  }
  return err;
}

async function toRaw(pipeline: Sharp, deadline: number): Promise<RawImage> {
  const { data, info } = await pipeline
    .timeout({ seconds: secondsLeft(deadline) })
    // Raw buffers carry no colour profile, so normalise CMYK/greyscale/16-bit to 8-bit sRGB(A) here.
    .toColourspace('srgb')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

const fromRaw = (img: RawImage) => sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels } });

export async function processImage(req: ProcessRequest): Promise<ProcessResult> {
  const started = performance.now();
  const deadline = Date.now() + req.timeoutSeconds * 1000;
  try {
    return await run(req, deadline, started);
  } catch (err) {
    throw mapSharpError(err);
  }
}

async function run({ filePath, options, limits }: ProcessRequest, deadline: number, started: number): Promise<ProcessResult> {
  // 1. Trust nothing the client said about the file: identify it by content.
  const sniffed = await sniffFile(filePath);
  if (!sniffed) {
    throw unsupportedMediaType('Unsupported file type. Upload a JPEG, PNG, WebP, AVIF, GIF or TIFF image.');
  }

  const inputOptions: SharpOptions = {
    limitInputPixels: limits.maxInputPixels,
    failOn: 'error',
    sequentialRead: true,
    pages: 1, // first frame only for animated GIF/WebP and multi-page TIFF
  };

  // 2. Header-only decode: dimensions, alpha, orientation. Cheap and bounded.
  let meta: Metadata;
  try {
    meta = await sharp(filePath, inputOptions).metadata();
  } catch (err) {
    // The pixel limit is enforced from the header, so bombs surface here.
    const mapped = mapSharpError(err);
    throw mapped instanceof HttpError ? mapped : unprocessable('invalid_image', 'The file could not be decoded as a valid image.');
  }
  const decoded = meta.format === 'heif' ? (meta.compression === 'av1' ? 'avif' : 'heic') : meta.format;
  if (decoded !== sniffed) {
    throw unsupportedMediaType('The file contents do not match a supported image format.');
  }
  const source: Size = { width: meta.autoOrient.width, height: meta.autoOrient.height };
  if (source.width * source.height > limits.maxInputPixels) {
    throw new HttpError(413, 'image_too_large', 'The image has too many pixels to process.');
  }

  // 3. Validate geometry against the real image before touching pixel data.
  const oriented = rotatedSize(source, options.rotate);
  const { crop } = options;
  if (crop && (crop.left + crop.width > oriented.width || crop.top + crop.height > oriented.height)) {
    throw unprocessable('crop_out_of_bounds', `The crop region must lie within the ${oriented.width}×${oriented.height} image.`);
  }
  const region: Size = crop ? { width: crop.width, height: crop.height } : oriented;
  const planned = computeOutputSize(region, options.resize);
  if (
    planned.width > limits.maxOutputDimension ||
    planned.height > limits.maxOutputDimension ||
    planned.width * planned.height > limits.maxOutputPixels
  ) {
    throw unprocessable(
      'output_too_large',
      `The output would be ${planned.width}×${planned.height}; the limit is ${limits.maxOutputDimension}px per side and ${limits.maxOutputPixels.toLocaleString('en-US')} pixels.`,
    );
  }

  const format = resolveOutputFormat(options.format, sniffed, meta.hasAlpha ?? false);
  const transparent = options.background === 'transparent';
  const fill = transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : options.background;
  const opaqueFill = transparent ? '#ffffff' : options.background;

  // 4. Geometry. EXIF auto-orient composes correctly with one explicit rotation
  //    inside a single pipeline, but sharp orders flips relative to extract()
  //    inconsistently, so user flips are materialised in their own pass first.
  let pipeline: Sharp;
  if (options.flipH || options.flipV) {
    const rotated = await toRaw(sharp(filePath, { ...inputOptions, autoOrient: true }).rotate(options.rotate), deadline);
    const mirrored = await toRaw(fromRaw(rotated).flip(options.flipV).flop(options.flipH), deadline);
    pipeline = fromRaw(mirrored);
  } else {
    pipeline = sharp(filePath, { ...inputOptions, autoOrient: true });
    if (options.rotate !== 0) pipeline = pipeline.rotate(options.rotate);
  }

  if (crop) pipeline = pipeline.extract(crop);

  if (options.resize) {
    const { width, height, fit, position, withoutEnlargement } = options.resize;
    // Content-aware strategies only exist for `cover`; other fits always centre.
    const strategy = fit === 'cover' && position !== 'center' ? sharp.strategy[position] : 'centre';
    pipeline = pipeline.resize({
      width,
      height,
      fit,
      position: strategy,
      background: ALPHA_CAPABLE.has(format) ? fill : opaqueFill,
      withoutEnlargement,
      kernel: sharp.kernel.lanczos3,
    });
  }

  if (!ALPHA_CAPABLE.has(format)) pipeline = pipeline.flatten({ background: opaqueFill });

  const input = { format: sniffed, width: source.width, height: source.height, bytes: (await stat(filePath)).size };

  // 5. Encode.
  if (options.targetSizeBytes === undefined) {
    const quality = format === 'png' ? null : options.quality;
    const { data, info } = await applyEncoder(pipeline, format, quality)
      .timeout({ seconds: secondsLeft(deadline) })
      .toBuffer({ resolveWithObject: true });
    return {
      buffer: data,
      format,
      width: info.width,
      height: info.height,
      quality,
      targetMet: null,
      downscaled: false,
      input,
      durationMs: Math.round(performance.now() - started),
    };
  }

  // Decode + transform once, then re-encode the in-memory pixels per attempt.
  const prepared = await toRaw(pipeline, deadline);
  const fit = await encodeToTargetSize({
    source: prepared,
    targetBytes: options.targetSizeBytes,
    maxQuality: options.quality,
    allowDownscale: options.allowDownscale,
    tryLosslessFirst: format === 'png',
    deadline,
    encode: (img, quality) => applyEncoder(fromRaw(img), format, quality).timeout({ seconds: secondsLeft(deadline) }).toBuffer(),
    resample: (img, width, height) =>
      toRaw(fromRaw(img).resize({ width, height, fit: 'fill', kernel: sharp.kernel.lanczos3 }), deadline),
  });

  return {
    buffer: fit.buffer,
    format,
    width: fit.width,
    height: fit.height,
    quality: fit.quality,
    targetMet: fit.targetMet,
    downscaled: fit.downscaled,
    input,
    durationMs: Math.round(performance.now() - started),
  };
}

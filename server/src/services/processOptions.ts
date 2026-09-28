import { z } from 'zod';
import type { ProcessingLimits } from '../config/env.js';
import { badRequest, unprocessable } from '../lib/errors.js';

export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const FIT_MODES = ['cover', 'contain', 'fill', 'inside', 'outside'] as const;
export type FitMode = (typeof FIT_MODES)[number];

export const POSITIONS = ['center', 'attention', 'entropy'] as const;

export const TARGET_SIZE_MIN_BYTES = 1024;
export const TARGET_SIZE_MAX_BYTES = 200 * 1024 * 1024;

/** Upper bound on the raw `options` field, well above any legitimate payload. */
const MAX_OPTIONS_JSON_BYTES = 4096;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function createProcessOptionsSchema(limits: ProcessingLimits) {
  const dimension = z.number().int().min(1).max(limits.maxOutputDimension);
  const coordinate = z.number().int().min(0).max(0x3fff * 4);
  const extent = z.number().int().min(1).max(0x3fff * 4);

  return z.strictObject({
    /** Region to keep, in pixels of the oriented + rotated + flipped image. */
    crop: z.strictObject({ left: coordinate, top: coordinate, width: extent, height: extent }).optional(),
    /** Clockwise rotation, applied after EXIF auto-orientation. */
    rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    /** Mirror left↔right, applied after rotation (i.e. in the frame the user sees). */
    flipH: z.boolean().default(false),
    /** Mirror top↔bottom, applied after rotation. */
    flipV: z.boolean().default(false),
    resize: z
      .strictObject({
        width: dimension.optional(),
        height: dimension.optional(),
        fit: z.enum(FIT_MODES).default('inside'),
        position: z.enum(POSITIONS).default('center'),
        withoutEnlargement: z.boolean().default(false),
      })
      .refine((r) => r.width !== undefined || r.height !== undefined, {
        message: 'resize requires width, height, or both',
      })
      .optional(),
    format: z.enum(['original', ...OUTPUT_FORMATS]).default('original'),
    /** Encoder quality 1–100 for JPEG/WebP/AVIF. PNG is lossless unless a target size forces quantisation. */
    quality: z.number().int().min(1).max(100).default(82),
    targetSizeBytes: z.number().int().min(TARGET_SIZE_MIN_BYTES).max(TARGET_SIZE_MAX_BYTES).optional(),
    /** When a target size cannot be met by quality alone, allow reducing pixel dimensions. */
    allowDownscale: z.boolean().default(true),
    /** Fill for letterboxing (`fit: contain`) and for flattening transparency into JPEG. */
    background: z.union([z.string().regex(HEX_COLOR, 'must be #rrggbb'), z.literal('transparent')]).default('#ffffff'),
  });
}

export type ProcessOptions = z.infer<ReturnType<typeof createProcessOptionsSchema>>;
export type ResizeOptions = NonNullable<ProcessOptions['resize']>;
export type CropRegion = NonNullable<ProcessOptions['crop']>;

/** Parses the multipart `options` field (a JSON string) into validated options. */
export function parseProcessOptions(raw: unknown, schema: ReturnType<typeof createProcessOptionsSchema>): ProcessOptions {
  let value: unknown = {};
  if (raw !== undefined && raw !== '') {
    if (typeof raw !== 'string') throw badRequest('invalid_options', 'The "options" field must be a JSON string.');
    if (Buffer.byteLength(raw) > MAX_OPTIONS_JSON_BYTES) {
      throw badRequest('invalid_options', 'The "options" field is too large.');
    }
    try {
      value = JSON.parse(raw);
    } catch {
      throw badRequest('invalid_options', 'The "options" field is not valid JSON.');
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw unprocessable(
      'validation_failed',
      'One or more processing options are invalid.',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

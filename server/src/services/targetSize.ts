/**
 * Finds the highest-quality encoding that fits under a byte budget.
 *
 * Strategy (per attempt, at the current pixel dimensions):
 *   1. Encode at the requested quality. If it fits, stop — never degrade an
 *      image that already meets the budget.
 *   2. Encode at the quality floor. If even that is too big, quality alone
 *      cannot help at this size.
 *   3. Otherwise binary-search the integer quality range for the highest
 *      value that fits (≈6 encodes for a 40-point range).
 *
 * When quality alone cannot meet the budget and downscaling is allowed, the
 * image is shrunk by √(budget / smallest) — encoded size scales roughly with
 * pixel area — and the search repeats. Each downscale resamples from the
 * full-resolution source to avoid compounding blur. Quality is kept at or
 * above a floor while downscaling is still possible, because a smaller sharp
 * image looks better than a larger smeared one.
 *
 * Only buffers that were actually measured under the budget are reported as
 * `targetMet`; the size model is used for choosing steps, never for claims.
 */

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

/** `quality: null` means lossless (used for the PNG first pass). */
export type Encoder = (image: RawImage, quality: number | null) => Promise<Buffer>;
export type Resampler = (source: RawImage, width: number, height: number) => Promise<RawImage>;

export interface TargetSizeInput {
  source: RawImage;
  targetBytes: number;
  maxQuality: number;
  allowDownscale: boolean;
  /** Formats with a meaningful lossless mode (PNG) try it before quantising. */
  tryLosslessFirst: boolean;
  encode: Encoder;
  resample: Resampler;
  /** Epoch ms after which the search stops and returns its best effort. */
  deadline: number;
}

export interface TargetSizeResult {
  buffer: Buffer;
  width: number;
  height: number;
  quality: number | null;
  targetMet: boolean;
  downscaled: boolean;
  encodeCount: number;
}

/** Floor used while downscaling is still an option. */
export const QUALITY_FLOOR_WITH_DOWNSCALE = 40;
const MAX_DOWNSCALE_STEPS = 8;
const MIN_DIMENSION = 16;
const STEP_SAFETY = 0.93;

export class DeadlineExceededError extends Error {
  constructor() {
    super('target size search exceeded its deadline');
    this.name = 'DeadlineExceededError';
  }
}

interface Candidate {
  buffer: Buffer;
  quality: number | null;
}

export async function encodeToTargetSize(input: TargetSizeInput): Promise<TargetSizeResult> {
  const { source, targetBytes, allowDownscale, encode, resample, deadline } = input;
  const maxQuality = Math.max(1, Math.min(100, input.maxQuality));
  let encodeCount = 0;

  const run = async (image: RawImage, quality: number | null): Promise<Candidate> => {
    if (Date.now() > deadline) throw new DeadlineExceededError();
    encodeCount++;
    return { buffer: await encode(image, quality), quality };
  };

  const fits = (c: Candidate) => c.buffer.length <= targetBytes;

  /** Returns the best fitting candidate, or the smallest non-fitting one. */
  const searchQuality = async (image: RawImage, floor: number): Promise<{ fit: boolean; best: Candidate }> => {
    if (input.tryLosslessFirst) {
      const lossless = await run(image, null);
      if (fits(lossless)) return { fit: true, best: lossless };
    }
    const top = await run(image, maxQuality);
    if (fits(top)) return { fit: true, best: top };
    const lo = Math.min(floor, maxQuality);
    if (lo === maxQuality) return { fit: false, best: top };
    const bottom = await run(image, lo);
    if (!fits(bottom)) return { fit: false, best: bottom };

    // Invariant: quality `good` fits, quality `bad` does not.
    let good = bottom;
    let goodQ = lo;
    let badQ = maxQuality;
    while (badQ - goodQ > 1) {
      const mid = Math.floor((goodQ + badQ) / 2);
      const c = await run(image, mid);
      if (fits(c)) {
        good = c;
        goodQ = mid;
      } else {
        badQ = mid;
      }
    }
    return { fit: true, best: good };
  };

  let current = source;
  let downscaled = false;
  let smallest: { candidate: Candidate; image: RawImage } | undefined;

  for (let step = 0; ; step++) {
    // Both sides > MIN_DIMENSION and scale ≤ 0.9 guarantee each step strictly shrinks.
    const canShrink =
      allowDownscale && step < MAX_DOWNSCALE_STEPS && current.width > MIN_DIMENSION && current.height > MIN_DIMENSION;
    // On the last possible attempt, search all the way down to quality 1.
    const floor = canShrink ? QUALITY_FLOOR_WITH_DOWNSCALE : 1;

    const { fit, best } = await searchQuality(current, floor);
    if (fit) return result(best, current, true, downscaled, encodeCount);
    if (!smallest || best.buffer.length < smallest.candidate.buffer.length) {
      smallest = { candidate: best, image: current };
    }
    if (!canShrink) break;

    const scale = Math.min(0.9, Math.max(0.2, Math.sqrt(targetBytes / best.buffer.length) * STEP_SAFETY));
    const width = Math.max(MIN_DIMENSION, Math.floor(current.width * scale));
    const height = Math.max(MIN_DIMENSION, Math.floor(current.height * scale));
    current = await resample(source, width, height);
    downscaled = true;
  }

  // Budget unreachable: return the smallest encoding we measured, flagged as such.
  const fallback = smallest as { candidate: Candidate; image: RawImage };
  return result(fallback.candidate, fallback.image, false, downscaled, encodeCount);
}

function result(c: Candidate, image: RawImage, targetMet: boolean, downscaled: boolean, encodeCount: number) {
  return {
    buffer: c.buffer,
    width: image.width,
    height: image.height,
    quality: c.quality,
    targetMet,
    downscaled,
    encodeCount,
  };
}

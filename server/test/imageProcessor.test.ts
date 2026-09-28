import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { HttpError } from '../src/lib/errors.js';
import { processImage } from '../src/services/imageProcessor.js';
import { createProcessOptionsSchema, type ProcessOptions } from '../src/services/processOptions.js';
import { BLUE, closeTo, GREEN, photoLike, pixelAt, quadrantImage, RED, ScratchDir, testConfig, YELLOW, type RGB } from './helpers.js';

const config = testConfig();
const schema = createProcessOptionsSchema(config.limits);
const scratch = new ScratchDir();

const run = (filePath: string, options: Record<string, unknown> = {}, limits = config.limits) =>
  processImage({ filePath, options: schema.parse(options) as ProcessOptions, limits, timeoutSeconds: 30 });

let quadPng = '';
beforeAll(async () => {
  await scratch.setup();
  quadPng = await scratch.write('quad.png', await (await quadrantImage(64, 32)).png().toBuffer());
});
afterAll(() => scratch.cleanup());

/** Reference model of the documented semantics: rotate clockwise, then mirror in the rotated frame. */
type Grid = [[RGB, RGB], [RGB, RGB]];
function transformGrid(g: Grid, rotate: number, flipH: boolean, flipV: boolean): Grid {
  let out: Grid = g;
  for (let i = 0; i < rotate / 90; i++) {
    const [[tl, tr], [bl, br]] = out;
    out = [
      [bl, tl],
      [br, tr],
    ];
  }
  if (flipH) out = [[out[0][1], out[0][0]], [out[1][1], out[1][0]]];
  if (flipV) out = [out[1], out[0]];
  return out;
}

async function corners(buf: Buffer): Promise<Grid> {
  const { width, height } = await sharp(buf).metadata();
  return [
    [await pixelAt(buf, 2, 2), await pixelAt(buf, width - 3, 2)],
    [await pixelAt(buf, 2, height - 3), await pixelAt(buf, width - 3, height - 3)],
  ];
}

const SOURCE_GRID: Grid = [
  [RED, GREEN],
  [BLUE, YELLOW],
];

describe('geometry semantics', () => {
  const combos = [0, 90, 180, 270].flatMap((rotate) =>
    [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ].map(([flipH, flipV]) => ({ rotate, flipH: flipH!, flipV: flipV! })),
  );

  it.each(combos)('rotate=$rotate flipH=$flipH flipV=$flipV', async ({ rotate, flipH, flipV }) => {
    const r = await run(quadPng, { rotate, flipH, flipV, format: 'png' });
    const quarter = rotate % 180 === 90;
    expect([r.width, r.height]).toEqual(quarter ? [32, 64] : [64, 32]);

    const expected = transformGrid(SOURCE_GRID, rotate, flipH, flipV);
    const actual = await corners(r.buffer);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) expect(closeTo(actual[y]![x]!, expected[y]![x]!, 5)).toBe(true);

    // The crop is expressed in the transformed frame: the top-left quarter must be one solid colour.
    const cropped = await run(quadPng, {
      rotate,
      flipH,
      flipV,
      format: 'png',
      crop: { left: 0, top: 0, width: r.width / 2, height: r.height / 2 },
    });
    const c = await corners(cropped.buffer);
    for (const px of c.flat()) expect(closeTo(px, expected[0][0], 5)).toBe(true);
  });

  it('honours EXIF orientation before cropping', async () => {
    // Orientation 6 = displayed rotated 90° clockwise.
    const stored = await (await quadrantImage(64, 32)).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
    const file = await scratch.write('exif6.jpg', stored);
    const r = await run(file, { format: 'png' });
    expect([r.width, r.height]).toEqual([32, 64]);
    expect(r.input).toMatchObject({ width: 32, height: 64, format: 'jpeg' });
    const expected = transformGrid(SOURCE_GRID, 90, false, false);
    expect(closeTo(await pixelAt(r.buffer, 2, 2), expected[0][0])).toBe(true);

    const cropped = await run(file, { format: 'png', crop: { left: 16, top: 32, width: 16, height: 32 } });
    expect(closeTo(await pixelAt(cropped.buffer, 8, 16), expected[1][1])).toBe(true);
  });

  it('rejects a crop outside the transformed bounds', async () => {
    // 64×32 rotated 90° is 32×64, so left=40 is out of range even though it fits the stored image.
    await expect(run(quadPng, { rotate: 90, crop: { left: 40, top: 0, width: 10, height: 10 } })).rejects.toMatchObject({
      status: 422,
      code: 'crop_out_of_bounds',
    });
  });
});

describe('resize and formats', () => {
  let photo = '';
  let alphaPng = '';
  beforeAll(async () => {
    photo = await scratch.write('photo.jpg', await photoLike(800, 600).jpeg({ quality: 95 }).toBuffer());
    alphaPng = await scratch.write('alpha.png', await photoLike(200, 100, 4).png().toBuffer());
  });

  it('resizes with aspect preserved and keeps the source format by default', async () => {
    const r = await run(photo, { resize: { width: 400 } });
    expect(r).toMatchObject({ format: 'jpeg', width: 400, height: 300, quality: 82, targetMet: null });
    expect((await sharp(r.buffer).metadata()).format).toBe('jpeg');
  });

  it('strips metadata (EXIF/GPS) from output', async () => {
    const withExif = await photoLike(100, 100)
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret-owner', Artist: 'someone' } })
      .toBuffer();
    const file = await scratch.write('exif.jpg', withExif);
    expect((await sharp(file).metadata()).exif).toBeDefined();
    const r = await run(file);
    const meta = await sharp(r.buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(r.buffer.includes(Buffer.from('secret-owner'))).toBe(false);
  });

  it.each(['jpeg', 'png', 'webp', 'avif'] as const)('converts to %s', async (format) => {
    const r = await run(photo, { format, resize: { width: 160 } });
    expect(r.format).toBe(format);
    const meta = await sharp(r.buffer).metadata();
    expect(meta.format).toBe(format === 'avif' ? 'heif' : format);
    expect(meta.width).toBe(160);
  });

  it('flattens transparency onto the background colour for JPEG', async () => {
    const r = await run(alphaPng, { format: 'jpeg', background: '#ff00ff' });
    expect(closeTo(await pixelAt(r.buffer, 190, 50), [255, 0, 255], 20)).toBe(true);
  });

  it('keeps transparency for WebP and letterboxes with a transparent background', async () => {
    const r = await run(alphaPng, { format: 'webp', background: 'transparent', resize: { width: 100, height: 100, fit: 'contain' } });
    const { data, info } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBe(0); // top-left is letterbox → transparent
  });

  it('maps GIF/TIFF "original" output to a web format', async () => {
    const gif = await scratch.write('a.gif', await photoLike(50, 50).gif().toBuffer());
    const tiff = await scratch.write('a.tiff', await photoLike(50, 50).tiff().toBuffer());
    expect((await run(gif)).format).toBe('jpeg');
    expect((await run(tiff)).format).toBe('jpeg');
  });

  it('converts CMYK identically on the raw (flip/target) path and the direct path', async () => {
    const cmyk = await scratch.write('cmyk.jpg', await (await quadrantImage(64, 32)).toColourspace('cmyk').jpeg({ quality: 95 }).toBuffer());
    expect((await sharp(cmyk).metadata()).space).toBe('cmyk');
    const direct = await run(cmyk, { format: 'png' });
    // Flip forces the raw geometry pass; target size forces raw re-encoding.
    const viaRaw = await run(cmyk, { flipH: true, format: 'png', targetSizeBytes: 50_000 });
    const directTopRight = await pixelAt(direct.buffer, 61, 2);
    expect(closeTo(await pixelAt(viaRaw.buffer, 2, 2), directTopRight, 3)).toBe(true);
    // And it really is RGB now, not CMYK bytes reinterpreted as RGBA.
    expect((await sharp(viaRaw.buffer).metadata()).space).toBe('srgb');
  });

  it('uses content-aware cropping for cover + attention', async () => {
    const r = await run(photo, { resize: { width: 100, height: 100, fit: 'cover', position: 'attention' } });
    expect([r.width, r.height]).toEqual([100, 100]);
  });

  it('refuses outputs beyond the configured limits', async () => {
    await expect(
      run(photo, { resize: { width: 5000, height: 5000, fit: 'fill' } }, { ...config.limits, maxOutputPixels: 10_000_000 }),
    ).rejects.toMatchObject({ status: 422, code: 'output_too_large' });
  });
});

describe('target file size', () => {
  let photo = '';
  beforeAll(async () => {
    photo = await scratch.write('big.png', await photoLike(1200, 900).png().toBuffer());
  });

  it.each(['jpeg', 'webp', 'avif'] as const)('meets a %s budget by quality alone when that is possible', async (format) => {
    // Calibrate: whatever q=60 produces is, by construction, reachable without downscaling.
    const target = (await run(photo, { format, quality: 60 })).buffer.length;
    const r = await run(photo, { format, quality: 90, targetSizeBytes: target });
    expect(r.targetMet).toBe(true);
    expect(r.downscaled).toBe(false);
    expect(r.buffer.length).toBeLessThanOrEqual(target);
    expect(r.quality).toBeGreaterThanOrEqual(58); // highest fitting quality, not merely any
    expect(r.quality).toBeLessThan(90);
    expect([r.width, r.height]).toEqual([1200, 900]);
  });

  it('downscales when quality alone cannot reach the budget', async () => {
    const r = await run(photo, { format: 'jpeg', quality: 90, targetSizeBytes: 8_000 });
    expect(r.targetMet).toBe(true);
    expect(r.downscaled).toBe(true);
    expect(r.buffer.length).toBeLessThanOrEqual(8_000);
    expect(r.width / r.height).toBeCloseTo(1200 / 900, 1);
  });

  it('reports failure honestly when downscaling is disallowed', async () => {
    const r = await run(photo, { format: 'jpeg', targetSizeBytes: 2_000, allowDownscale: false });
    expect(r.targetMet).toBe(false);
    expect(r.quality).toBe(1);
    expect([r.width, r.height]).toEqual([1200, 900]);
  });

  it('quantises PNG only when lossless does not fit', async () => {
    const small = await scratch.write('flat.png', await sharp({ create: { width: 300, height: 300, channels: 3, background: '#3366cc' } }).png().toBuffer());
    const lossless = await run(small, { format: 'png', targetSizeBytes: 50_000 });
    expect(lossless).toMatchObject({ quality: null, targetMet: true });

    const quantised = await run(photo, { format: 'png', targetSizeBytes: 400_000 });
    expect(quantised.targetMet).toBe(true);
    expect(quantised.buffer.length).toBeLessThanOrEqual(400_000);
    expect(quantised.quality).not.toBeNull();
  });
});

describe('hostile and invalid input', () => {
  const expectHttp = async (p: Promise<unknown>, status: number, code?: string) => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    if (code) expect((err as HttpError).code).toBe(code);
  };

  it('rejects SVG even with an image extension', async () => {
    const f = await scratch.write('evil.png', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
    await expectHttp(run(f), 415, 'unsupported_media_type');
  });

  it('rejects arbitrary bytes', async () => {
    await expectHttp(run(await scratch.write('x.jpg', Buffer.from('MZ\x90\x00 not an image'))), 415);
  });

  it('rejects a truncated image', async () => {
    const full = await photoLike(400, 300).jpeg().toBuffer();
    await expectHttp(run(await scratch.write('trunc.jpg', full.subarray(0, full.length / 3))), 422, 'invalid_image');
  });

  it('rejects a PNG header followed by garbage', async () => {
    const f = await scratch.write('garbage.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]));
    await expectHttp(run(f), 422, 'invalid_image');
  });

  it('rejects decompression bombs by pixel count before decoding', async () => {
    // 8000×8000 of a flat colour compresses to a tiny PNG but is 64 MP decoded.
    const bomb = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: '#000' } }).png().toBuffer();
    expect(bomb.length).toBeLessThan(1_000_000);
    const f = await scratch.write('bomb.png', bomb);
    await expectHttp(run(f, {}, { ...config.limits, maxInputPixels: 10_000_000 }), 413, 'image_too_large');
  });
});

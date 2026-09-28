import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { HttpError } from '../src/lib/errors.js';
import { Semaphore } from '../src/lib/semaphore.js';
import { downloadName } from '../src/middleware/upload.js';
import { computeOutputSize, rotatedSize } from '../src/services/geometry.js';
import { sniffImageType } from '../src/services/imageSniffer.js';
import { createProcessOptionsSchema, parseProcessOptions } from '../src/services/processOptions.js';
import { encodeToTargetSize, QUALITY_FLOOR_WITH_DOWNSCALE, type RawImage } from '../src/services/targetSize.js';
import { photoLike, testConfig } from './helpers.js';

describe('sniffImageType', () => {
  const b = (...bytes: number[]) => Buffer.from(bytes);
  const s = (str: string) => Buffer.from(str, 'latin1');

  it.each([
    ['jpeg', b(0xff, 0xd8, 0xff, 0xe0, 0, 0)],
    ['png', b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)],
    ['gif', s('GIF89a....')],
    ['gif', s('GIF87a....')],
    ['webp', s('RIFF\x00\x00\x00\x00WEBPVP8 ')],
    ['tiff', b(0x49, 0x49, 0x2a, 0x00, 8, 0)],
    ['tiff', b(0x4d, 0x4d, 0x00, 0x2a, 0, 8)],
    ['avif', s('\x00\x00\x00\x1cftypavif\x00\x00\x00\x00')],
  ])('detects %s', (expected, header) => {
    expect(sniffImageType(header)).toBe(expected);
  });

  it.each([
    ['svg', s('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['xml-prefixed svg', s('<?xml version="1.0"?><svg>')],
    ['heic', s('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00')],
    ['pdf', s('%PDF-1.7')],
    ['html', s('<!doctype html>')],
    ['empty', Buffer.alloc(0)],
    ['truncated png', b(0x89, 0x50, 0x4e)],
    ['riff but not webp', s('RIFF\x00\x00\x00\x00WAVEfmt ')],
  ])('rejects %s', (_name, header) => {
    expect(sniffImageType(header)).toBeNull();
  });
});

describe('computeOutputSize matches sharp', () => {
  const source = { width: 400, height: 300 };
  const cases = [
    { width: 200 },
    { height: 150 },
    { width: 200, height: 200, fit: 'inside' as const },
    { width: 200, height: 200, fit: 'outside' as const },
    { width: 200, height: 200, fit: 'cover' as const },
    { width: 200, height: 200, fit: 'contain' as const },
    { width: 123, height: 77, fit: 'fill' as const },
    { width: 800, fit: 'inside' as const, withoutEnlargement: true },
    { width: 800, height: 800, fit: 'inside' as const, withoutEnlargement: true },
    { width: 800, height: 800, fit: 'cover' as const, withoutEnlargement: true },
    { width: 800, height: 100, fit: 'contain' as const, withoutEnlargement: true },
    { width: 800, height: 800, fit: 'contain' as const, withoutEnlargement: true },
    { width: 800, height: 100, fit: 'cover' as const, withoutEnlargement: true },
    { width: 100, height: 800, fit: 'fill' as const, withoutEnlargement: true },
    { width: 800, height: 100, fit: 'outside' as const, withoutEnlargement: true },
    { width: 300, height: 200, fit: 'outside' as const, withoutEnlargement: true },
    { width: 333, height: 111, fit: 'inside' as const },
  ];

  it.each(cases)('%o', async (spec) => {
    const img = sharp({ create: { width: source.width, height: source.height, channels: 3, background: '#888' } });
    const { info } = await img
      .resize({ width: spec.width, height: spec.height, fit: spec.fit ?? 'inside', withoutEnlargement: spec.withoutEnlargement })
      .png()
      .toBuffer({ resolveWithObject: true });
    expect(computeOutputSize(source, { fit: 'inside', ...spec })).toEqual({ width: info.width, height: info.height });
  });

  it('swaps dimensions for quarter turns only', () => {
    expect(rotatedSize({ width: 4, height: 3 }, 90)).toEqual({ width: 3, height: 4 });
    expect(rotatedSize({ width: 4, height: 3 }, 180)).toEqual({ width: 4, height: 3 });
    expect(rotatedSize({ width: 4, height: 3 }, 270)).toEqual({ width: 3, height: 4 });
  });
});

describe('parseProcessOptions', () => {
  const schema = createProcessOptionsSchema(testConfig().limits);

  it('applies safe defaults for an empty payload', () => {
    expect(parseProcessOptions(undefined, schema)).toMatchObject({
      rotate: 0,
      flipH: false,
      flipV: false,
      format: 'original',
      quality: 82,
      allowDownscale: true,
      background: '#ffffff',
    });
  });

  it('rejects malformed JSON with 400', () => {
    expect(() => parseProcessOptions('{nope', schema)).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it('rejects oversized payloads with 400', () => {
    expect(() => parseProcessOptions(JSON.stringify({ pad: 'x'.repeat(5000) }), schema)).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });

  it.each([
    [{ unknownKey: 1 }, 'unknown keys (strict schema)'],
    [{ rotate: 45 }, 'non-right-angle rotation'],
    [{ quality: 0 }, 'quality below 1'],
    [{ quality: 101 }, 'quality above 100'],
    [{ resize: { fit: 'cover' } }, 'resize without dimensions'],
    [{ resize: { width: 999_999 } }, 'width beyond the output limit'],
    [{ crop: { left: -1, top: 0, width: 10, height: 10 } }, 'negative crop origin'],
    [{ crop: { left: 0, top: 0, width: 0, height: 10 } }, 'zero-size crop'],
    [{ format: 'svg' }, 'non-allowlisted output format'],
    [{ background: 'red; drop table' }, 'non-hex background'],
    [{ targetSizeBytes: 10 }, 'target size below minimum'],
    [{ resize: { width: 10.5 } }, 'fractional pixels'],
    [{ __proto__: { polluted: true }, rotate: '90' }, 'string where number expected'],
  ])('rejects %o (%s) with 422', (value, _reason) => {
    try {
      parseProcessOptions(JSON.stringify(value), schema);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(422);
      expect((err as HttpError).details).toBeInstanceOf(Array);
    }
  });
});

describe('loadConfig', () => {
  it('uses secure defaults', () => {
    const c = loadConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.corsOrigins).toEqual([]);
    expect(c.trustProxy).toBe('loopback');
    expect(c.limits.maxUploadBytes).toBe(25 * 1024 * 1024);
  });

  it('refuses TRUST_PROXY=true', () => {
    expect(() => loadConfig({ TRUST_PROXY: 'true' })).toThrow(ConfigError);
  });

  it('refuses CORS origins with paths or wildcards', () => {
    expect(() => loadConfig({ CORS_ORIGINS: 'https://a.example.com/path' })).toThrow(ConfigError);
    expect(() => loadConfig({ CORS_ORIGINS: '*' })).toThrow(ConfigError);
    expect(loadConfig({ CORS_ORIGINS: 'https://a.example.com, http://localhost:5173' }).corsOrigins).toEqual([
      'https://a.example.com',
      'http://localhost:5173',
    ]);
  });

  it('refuses short origin-verify secrets and never echoes values', () => {
    try {
      loadConfig({ ORIGIN_VERIFY_SECRET: 'hunter2' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('ORIGIN_VERIFY_SECRET');
      expect((err as Error).message).not.toContain('hunter2');
    }
  });
});

describe('Semaphore', () => {
  it('limits concurrency and sheds load beyond the queue', async () => {
    const sem = new Semaphore(1, 1);
    let release!: () => void;
    const blocker = sem.run(() => new Promise<void>((r) => (release = r)));
    const queued = sem.run(async () => 'queued');
    await expect(sem.run(async () => 'rejected')).rejects.toMatchObject({ status: 503, code: 'server_busy' });
    expect(sem.stats).toMatchObject({ active: 1, queued: 1 });
    release();
    await blocker;
    await expect(queued).resolves.toBe('queued');
    expect(sem.stats).toMatchObject({ active: 0, queued: 0 });
  });

  it('releases the slot when a task throws', async () => {
    const sem = new Semaphore(1, 0);
    await expect(sem.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('downloadName', () => {
  it.each([
    ['holiday photo.JPG', 'jpg', 'holiday-photo-processed.jpg'],
    ['../../etc/passwd', 'png', 'passwd-processed.png'],
    // "/" inside the name is a path separator, so only the final segment survives.
    ['<script>alert(1)</script>.png', 'webp', 'script-processed.webp'],
    ['C:\\Users\\me\\cat<>|?.png', 'png', 'cat-processed.png'],
    ['résumé.png', 'png', 'resume-processed.png'],
    [undefined, 'avif', 'image-processed.avif'],
    ['...', 'jpg', 'image-processed.jpg'],
  ])('%s → %s', (input, ext, expected) => {
    expect(downloadName(input, ext)).toBe(expected);
  });
});

describe('encodeToTargetSize (model encoder)', () => {
  // Size model: bytes ∝ pixels × (quality + 10). Monotonic in both, like real codecs.
  const source: RawImage = { data: Buffer.alloc(0), width: 1000, height: 1000, channels: 3 };
  const encode = async (img: RawImage, q: number | null) =>
    Buffer.alloc(Math.round((img.width * img.height * ((q ?? 120) + 10)) / 1000));
  const resample = async (_src: RawImage, width: number, height: number): Promise<RawImage> => ({ ...source, width, height });
  const base = { source, encode, resample, tryLosslessFirst: false, deadline: Date.now() + 60_000 };

  it('keeps the requested quality when it already fits', async () => {
    const r = await encodeToTargetSize({ ...base, targetBytes: 1_000_000, maxQuality: 80, allowDownscale: true });
    expect(r).toMatchObject({ quality: 80, targetMet: true, downscaled: false, width: 1000 });
    expect(r.encodeCount).toBe(1);
  });

  it('finds the highest quality that fits', async () => {
    // q + 10 ≤ 60 → q ≤ 50
    const r = await encodeToTargetSize({ ...base, targetBytes: 60_000, maxQuality: 90, allowDownscale: true });
    expect(r).toMatchObject({ quality: 50, targetMet: true, downscaled: false });
    expect(r.buffer.length).toBeLessThanOrEqual(60_000);
  });

  it('downscales instead of dropping below the quality floor', async () => {
    const r = await encodeToTargetSize({ ...base, targetBytes: 20_000, maxQuality: 90, allowDownscale: true });
    expect(r.targetMet).toBe(true);
    expect(r.downscaled).toBe(true);
    expect(r.quality).toBeGreaterThanOrEqual(QUALITY_FLOOR_WITH_DOWNSCALE);
    expect(r.width).toBeLessThan(1000);
    expect(r.buffer.length).toBeLessThanOrEqual(20_000);
  });

  it('drops quality all the way when downscaling is not allowed', async () => {
    // q + 10 ≤ 15 → q ≤ 5
    const r = await encodeToTargetSize({ ...base, targetBytes: 15_000, maxQuality: 90, allowDownscale: false });
    expect(r).toMatchObject({ quality: 5, targetMet: true, downscaled: false, width: 1000 });
  });

  it('reports an unreachable budget honestly with the smallest result', async () => {
    const r = await encodeToTargetSize({ ...base, targetBytes: 5_000, maxQuality: 90, allowDownscale: false });
    expect(r).toMatchObject({ quality: 1, targetMet: false, width: 1000 });
    expect(r.buffer.length).toBe(11_000);
  });

  it('tries lossless first when requested', async () => {
    const r = await encodeToTargetSize({ ...base, tryLosslessFirst: true, targetBytes: 200_000, maxQuality: 90, allowDownscale: true });
    expect(r).toMatchObject({ quality: null, targetMet: true, encodeCount: 1 });
  });

  it('stops at the deadline', async () => {
    await expect(
      encodeToTargetSize({ ...base, deadline: Date.now() - 1, targetBytes: 1, maxQuality: 90, allowDownscale: true }),
    ).rejects.toThrow(/deadline/);
  });
});

describe('photoLike helper sanity', () => {
  it('produces an image whose JPEG size depends on quality', async () => {
    const img = photoLike(200, 150);
    const lo = await img.clone().jpeg({ quality: 20 }).toBuffer();
    const hi = await img.clone().jpeg({ quality: 95 }).toBuffer();
    expect(hi.length).toBeGreaterThan(lo.length * 2);
  });
});

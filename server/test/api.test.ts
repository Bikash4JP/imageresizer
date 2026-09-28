import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { createFeedbackService } from '../src/services/feedback/service.js';
import { TempStore } from '../src/services/tempStore.js';
import { photoLike, silentLogger, testConfig } from './helpers.js';

const SECRET = 'x'.repeat(40);

async function makeApp(overrides: Record<string, string> = {}) {
  const config = testConfig(overrides);
  const tempStore = new TempStore(config.temp.dir, config.temp.maxAgeMs, silentLogger);
  await tempStore.init();
  const feedback = await createFeedbackService(config.feedback, silentLogger);
  return { app: createApp(config, { logger: silentLogger, tempStore, feedback }), tempStore, config };
}

/** supertest resolves before the server's 'close' event; give cleanup a tick to run. */
const settle = () => new Promise((r) => setTimeout(r, 150));

let jpeg: Buffer;
beforeAll(async () => {
  jpeg = await photoLike(640, 480).jpeg({ quality: 90 }).toBuffer();
});

describe('POST /api/v1/images/process', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeEach(async () => {
    ctx = await makeApp();
  });

  it('returns the processed image with descriptive headers', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/images/process')
      .attach('file', jpeg, { filename: 'My Photo.jpg', contentType: 'image/jpeg' })
      .field('options', JSON.stringify({ resize: { width: 320 }, format: 'webp', quality: 75 }))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['content-disposition']).toBe('attachment; filename="My-Photo-processed.webp"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers).toMatchObject({
      'x-output-width': '320',
      'x-output-height': '240',
      'x-output-format': 'webp',
      'x-output-quality': '75',
      'x-target-met': 'n/a',
      'x-input-width': '640',
      'x-input-format': 'jpeg',
    });
    expect(Number(res.headers['x-output-bytes'])).toBe((res.body as Buffer).length);
    const meta = await sharp(res.body as Buffer).metadata();
    expect([meta.format, meta.width]).toEqual(['webp', 320]);
  });

  it('deletes the upload workspace after responding (success and failure)', async () => {
    await request(ctx.app).post('/api/v1/images/process').attach('file', jpeg, 'a.jpg').expect(200);
    await request(ctx.app).post('/api/v1/images/process').attach('file', Buffer.from('not an image'), 'b.jpg').expect(415);
    await request(ctx.app)
      .post('/api/v1/images/process')
      .attach('file', jpeg, 'c.jpg')
      .field('options', '{"rotate": 45}')
      .expect(422);
    await settle();
    expect(ctx.tempStore.activeCount).toBe(0);
    expect((await readdir(ctx.config.temp.dir)).filter((n) => n.startsWith('req-'))).toEqual([]);
  });

  it('never uses the client filename on disk', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/images/process')
      .attach('file', jpeg, { filename: '../../../../etc/cron.d/evil.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="evil-processed.jpg"');
  });

  it('returns problem+json with field-level errors on invalid options', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/images/process')
      .attach('file', jpeg, 'a.jpg')
      .field('options', JSON.stringify({ quality: 500, resize: { fit: 'stretch', width: 10 } }));
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 422, code: 'validation_failed' });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    const paths = (res.body.errors as Array<{ path: string }>).map((e) => e.path).sort();
    expect(paths).toEqual(['quality', 'resize.fit']);
  });

  it('requires a file', async () => {
    const res = await request(ctx.app).post('/api/v1/images/process').field('options', '{}');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('file_required');
  });

  it('rejects more than one file', async () => {
    const res = await request(ctx.app).post('/api/v1/images/process').attach('file', jpeg, 'a.jpg').attach('file', jpeg, 'b.jpg');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_upload');
  });

  it('rejects files in unexpected fields', async () => {
    const res = await request(ctx.app).post('/api/v1/images/process').attach('image', jpeg, 'a.jpg');
    expect(res.status).toBe(400);
  });

  it('rejects non-image declared types before writing to disk', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/images/process')
      .attach('file', Buffer.from('#!/bin/sh\nrm -rf /'), { filename: 'x.sh', contentType: 'application/x-sh' });
    expect(res.status).toBe(415);
  });

  it('enforces the upload size limit with 413', async () => {
    const small = await makeApp({ MAX_UPLOAD_MB: '1' });
    const big = await photoLike(1500, 1500).png().toBuffer();
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const res = await request(small.app).post('/api/v1/images/process').attach('file', big, 'big.png');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('file_too_large');
    await settle();
    expect(small.tempStore.activeCount).toBe(0);
  });

  it('rate limits per client with 429 and standard headers', async () => {
    const limited = await makeApp({ RATE_LIMIT_MAX: '2' });
    await request(limited.app).post('/api/v1/images/process').attach('file', jpeg, 'a.jpg').expect(200);
    await request(limited.app).post('/api/v1/images/process').attach('file', jpeg, 'a.jpg').expect(200);
    const res = await request(limited.app).post('/api/v1/images/process').attach('file', jpeg, 'a.jpg');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.headers['ratelimit-policy']).toBeDefined();
  });

  it('meets a target size and reports it', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/images/process')
      .attach('file', jpeg, 'a.jpg')
      .field('options', JSON.stringify({ format: 'jpeg', targetSizeBytes: 20_000 }));
    expect(res.status).toBe(200);
    expect(res.headers['x-target-met']).toBe('true');
    expect(Number(res.headers['x-output-bytes'])).toBeLessThanOrEqual(20_000);
  });
});

describe('meta endpoints and cross-cutting security', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    ctx = await makeApp();
  });

  it('GET /health', async () => {
    const res = await request(ctx.app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /ready', async () => {
    const res = await request(ctx.app).get('/api/v1/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready', active: 0, queued: 0 });
  });

  it('GET /capabilities exposes limits, not secrets', async () => {
    const res = await request(ctx.app).get('/api/v1/capabilities');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ maxUploadBytes: 25 * 1024 * 1024, outputFormats: ['jpeg', 'png', 'webp', 'avif'] });
    expect(JSON.stringify(res.body)).not.toMatch(/secret|temp|dir/i);
  });

  it('sets hardened headers on API responses', async () => {
    const res = await request(ctx.app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores malformed inbound request ids', async () => {
    const res = await request(ctx.app).get('/api/v1/health').set('X-Request-Id', '<script>');
    expect(res.headers['x-request-id']).not.toContain('<');
  });

  it('returns problem+json 404 for unknown API routes', async () => {
    const res = await request(ctx.app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('does not reflect disallowed CORS origins', async () => {
    const res = await request(ctx.app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await request(ctx.app).options('/api/v1/images/process').set('Origin', 'https://evil.example');
    expect(pre.status).toBe(403);
  });

  it('allows configured CORS origins and exposes result headers', async () => {
    const withCors = await makeApp({ CORS_ORIGINS: 'https://app.example.com' });
    const pre = await request(withCors.app)
      .options('/api/v1/images/process')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const res = await request(withCors.app).get('/api/v1/health').set('Origin', 'https://app.example.com');
    expect(res.headers['access-control-expose-headers']).toContain('X-Output-Bytes');
    expect(res.headers.vary).toContain('Origin');
  });

  it('requires the CloudFront origin-verify header when configured', async () => {
    const guarded = await makeApp({ ORIGIN_VERIFY_SECRET: SECRET });
    expect((await request(guarded.app).get('/api/v1/capabilities')).status).toBe(403);
    expect((await request(guarded.app).get('/api/v1/capabilities').set('X-Origin-Verify', 'y'.repeat(40))).status).toBe(403);
    expect((await request(guarded.app).get('/api/v1/capabilities').set('X-Origin-Verify', SECRET)).status).toBe(200);
    // Health checks from the instance's own proxy are exempt.
    expect((await request(guarded.app).get('/api/v1/health')).status).toBe(200);
  });

  it('accepts both current and previous secrets during a rotation', async () => {
    const next = 'n'.repeat(40);
    const rotating = await makeApp({ ORIGIN_VERIFY_SECRET: next, ORIGIN_VERIFY_SECRET_PREVIOUS: SECRET });
    expect((await request(rotating.app).get('/api/v1/capabilities').set('X-Origin-Verify', SECRET)).status).toBe(200);
    expect((await request(rotating.app).get('/api/v1/capabilities').set('X-Origin-Verify', next)).status).toBe(200);
    expect((await request(rotating.app).get('/api/v1/capabilities').set('X-Origin-Verify', 'z'.repeat(40))).status).toBe(403);
  });
});

describe('static SPA hosting (optional)', () => {
  it('serves index.html with a strict CSP and caches fingerprinted assets', async () => {
    const base = testConfig();
    const dir = path.join(base.temp.dir, '..', `spa-${process.pid}`);
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
    await writeFile(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    await writeFile(path.join(dir, '.env'), 'SECRET=1');
    try {
      const { app } = await makeApp({ STATIC_DIR: dir });
      const index = await request(app).get('/some/client/route');
      expect(index.status).toBe(200);
      expect(index.headers['content-security-policy']).toContain("script-src 'self'");
      expect(index.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(index.headers['cache-control']).toBe('no-cache');
      const asset = await request(app).get('/assets/app-abc123.js');
      expect(asset.headers['cache-control']).toContain('immutable');
      // Dotfiles are never served; the SPA fallback answers instead.
      const dot = await request(app).get('/.env');
      expect(dot.text).not.toContain('SECRET');
      // API 404s stay JSON even with the SPA fallback mounted.
      expect((await request(app).get('/api/v1/missing')).headers['content-type']).toMatch(/problem\+json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('TempStore', () => {
  it('purges leftovers on init and sweeps expired workspaces', async () => {
    const config = testConfig({ TEMP_DIR: path.join(testConfig().temp.dir, '..', `ts-${process.pid}`) });
    const store = new TempStore(config.temp.dir, 60_000, silentLogger);
    await mkdir(path.join(config.temp.dir, 'req-stale'), { recursive: true });
    await store.init();
    expect(await readdir(config.temp.dir)).toEqual([]);

    const fresh = await store.createWorkspace();
    const old = await store.createWorkspace();
    const past = new Date(Date.now() - 120_000);
    await utimes(old, past, past);
    expect(await store.sweep()).toBe(1);
    expect(await readdir(config.temp.dir)).toEqual([path.basename(fresh)]);
    await store.purgeAll();
    await rm(config.temp.dir, { recursive: true, force: true });
  });

  it('refuses to delete paths outside its root', async () => {
    const config = testConfig();
    const store = new TempStore(config.temp.dir, 60_000, silentLogger);
    await expect(store.release(path.resolve(config.temp.dir, '..'))).rejects.toThrow(/outside/);
    await expect(store.release(path.join(config.temp.dir, 'not-a-workspace'))).rejects.toThrow(/outside/);
  });
});

afterAll(async () => {
  await rm(testConfig().temp.dir, { recursive: true, force: true });
});

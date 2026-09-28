import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/services/adminAuth.js';
import { createFeedbackService } from '../src/services/feedback/service.js';
import { TempStore } from '../src/services/tempStore.js';
import { silentLogger, testConfig } from './helpers.js';

const PASSWORD = 'correct horse battery';
let passwordHash = '';
beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

async function makeApp(overrides: Record<string, string> = {}, withAdmin = true) {
  const config = testConfig({
    ...(withAdmin ? { ADMIN_PASSWORD_HASH: passwordHash, ADMIN_SESSION_SECRET: 's'.repeat(40) } : {}),
    ...overrides,
  });
  const tempStore = new TempStore(config.temp.dir, config.temp.maxAgeMs, silentLogger);
  const feedback = await createFeedbackService(config.feedback, silentLogger);
  return { app: createApp(config, { logger: silentLogger, tempStore, feedback }), feedback };
}

async function signIn(app: Awaited<ReturnType<typeof makeApp>>['app']) {
  const res = await request(app).post('/api/v1/admin/login').send({ password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]!;
  return cookie.split(';')[0]!;
}

describe('public feedback API', () => {
  it('accepts a rating and shows it on the wall', async () => {
    const { app } = await makeApp();
    const res = await request(app).post('/api/v1/feedback').send({ rating: 5, comment: 'Brilliant crop tool', name: 'Asha' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ received: true, status: 'published' });
    expect(res.headers['cache-control']).toBe('no-store');

    const wall = await request(app).get('/api/v1/feedback');
    expect(wall.status).toBe(200);
    expect(wall.body).toMatchObject({ enabled: true, summary: { average: 5, count: 1 } });
    expect(wall.body.items).toEqual([expect.objectContaining({ comment: 'Brilliant crop tool', name: 'Asha', rating: 5 })]);
  });

  it('holds comments with links and answers honeypots identically', async () => {
    const { app } = await makeApp();
    const held = await request(app).post('/api/v1/feedback').send({ rating: 5, comment: 'go to cheap.xyz' });
    const bot = await request(app).post('/api/v1/feedback').send({ rating: 5, comment: 'hi', website: 'x' });
    expect(held.body).toEqual({ received: true, status: 'pending' });
    expect(bot.status).toBe(201);
    expect(bot.body).toEqual(held.body);
    expect((await request(app).get('/api/v1/feedback')).body.items).toEqual([]);
  });

  it('validates input with field-level problems', async () => {
    const { app } = await makeApp();
    const res = await request(app).post('/api/v1/feedback').send({ rating: 9 });
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.body.errors[0].path).toBe('rating');
  });

  it('only accepts JSON bodies of bounded size', async () => {
    const { app } = await makeApp();
    const form = await request(app).post('/api/v1/feedback').type('form').send('rating=5');
    expect(form.status).toBe(415);
    const broken = await request(app).post('/api/v1/feedback').set('Content-Type', 'application/json').send('{"rating":');
    expect(broken.status).toBe(400);
    const huge = await request(app).post('/api/v1/feedback').send({ rating: 5, comment: 'x'.repeat(10_000) });
    expect(huge.status).toBe(413);
  });

  it('rate limits submissions per client', async () => {
    const { app } = await makeApp({ FEEDBACK_RATE_LIMIT_MAX: '2' });
    for (let i = 0; i < 2; i++) expect((await request(app).post('/api/v1/feedback').send({ rating: 4 })).status).toBe(201);
    const limited = await request(app).post('/api/v1/feedback').send({ rating: 4 });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate_limited');
  });
});

describe('admin API', () => {
  it('does not exist unless configured', async () => {
    const { app } = await makeApp({}, false);
    expect((await request(app).post('/api/v1/admin/login').send({ password: PASSWORD })).status).toBe(404);
    expect((await request(app).get('/api/v1/admin/session')).status).toBe(404);
  });

  it('rejects wrong passwords and unauthenticated access', async () => {
    const { app } = await makeApp();
    const bad = await request(app).post('/api/v1/admin/login').send({ password: 'nope' });
    expect(bad.status).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();
    expect((await request(app).get('/api/v1/admin/overview')).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/overview').set('Cookie', 'ir_admin=v1.zzzzzz.forged')).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/session')).body).toEqual({ authenticated: false });
  });

  it('issues an HttpOnly, SameSite=Strict session cookie', async () => {
    const { app } = await makeApp();
    const res = await request(app).post('/api/v1/admin/login').send({ password: PASSWORD });
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]!;
    expect(cookie).toMatch(/^ir_admin=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('uses a __Host- Secure cookie in production', async () => {
    const { app } = await makeApp({ NODE_ENV: 'production', FEEDBACK_STORE: 'memory' });
    const res = await request(app).post('/api/v1/admin/login').send({ password: PASSWORD });
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]!;
    expect(cookie).toMatch(/^__Host-ir_admin=/);
    expect(cookie).toMatch(/Secure/);
  });

  it('refuses cross-site requests even with a valid session', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);
    const res = await request(app).put('/api/v1/admin/settings').set('Cookie', cookie).set('Sec-Fetch-Site', 'cross-site').send({ wallEnabled: false });
    expect(res.status).toBe(403);
  });

  it('moderates: approve, hide, delete, and toggle the whole wall', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);
    const admin = (req: request.Test) => req.set('Cookie', cookie).set('Sec-Fetch-Site', 'same-origin');

    await request(app).post('/api/v1/feedback').send({ rating: 5, comment: 'Visible one' });
    await request(app).post('/api/v1/feedback').send({ rating: 3, comment: 'contact me at a@b.com' });

    const overview = await admin(request(app).get('/api/v1/admin/overview'));
    expect(overview.body).toMatchObject({ settings: { wallEnabled: true }, counts: { published: 1, pending: 1, hidden: 0 }, summary: { count: 2, average: 4 } });

    const pending = await admin(request(app).get('/api/v1/admin/feedback?status=pending'));
    const pendingId = pending.body.items[0].id as string;
    const approved = await admin(request(app).patch(`/api/v1/admin/feedback/${pendingId}`)).send({ status: 'published' });
    expect(approved.body.status).toBe('published');
    expect((await request(app).get('/api/v1/feedback')).body.items).toHaveLength(2);

    const hidden = await admin(request(app).patch(`/api/v1/admin/feedback/${pendingId}`)).send({ status: 'hidden' });
    expect(hidden.status).toBe(200);
    expect((await request(app).get('/api/v1/feedback')).body.items.map((i: { comment: string }) => i.comment)).toEqual(['Visible one']);

    expect((await admin(request(app).delete(`/api/v1/admin/feedback/${pendingId}`))).status).toBe(204);
    expect((await admin(request(app).delete(`/api/v1/admin/feedback/${pendingId}`))).status).toBe(404);
    expect((await admin(request(app).patch('/api/v1/admin/feedback/..%2F..%2Fetc')).send({ status: 'hidden' })).status).toBe(404);

    const off = await admin(request(app).put('/api/v1/admin/settings')).send({ wallEnabled: false });
    expect(off.body).toEqual({ wallEnabled: false });
    expect((await request(app).get('/api/v1/feedback')).body).toEqual({ enabled: false });

    const invalid = await admin(request(app).patch(`/api/v1/admin/feedback/${pendingId}`)).send({ status: 'deleted' });
    expect(invalid.status).toBe(422);
  });

  it('signs out', async () => {
    const { app } = await makeApp();
    await signIn(app);
    const out = await request(app).post('/api/v1/admin/logout');
    expect(([] as string[]).concat(out.headers['set-cookie'] ?? [])[0]).toMatch(/ir_admin=;/);
  });

  it('throttles repeated failed sign-ins', async () => {
    const { app } = await makeApp();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await request(app).post('/api/v1/admin/login').send({ password: `wrong-${i}` })).status;
    expect(last).toBe(429);
  });
});

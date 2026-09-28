import express, { Router, type RequestHandler, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AdminConfig } from '../config/env.js';
import { HttpError, unprocessable } from '../lib/errors.js';
import { createSessionToken, readCookie, verifyPassword, verifySessionToken } from '../services/adminAuth.js';
import { FEEDBACK_ID } from '../services/feedback/sanitize.js';
import type { FeedbackService } from '../services/feedback/service.js';
import { FEEDBACK_STATUSES, InvalidCursorError } from '../services/feedback/types.js';

/**
 * Admin area for moderating feedback. Mounted only when ADMIN_PASSWORD_HASH
 * and ADMIN_SESSION_SECRET are configured; otherwise every /admin route 404s.
 *
 * Session: HMAC-signed token in an HttpOnly, SameSite=Strict cookie
 * (`__Host-` prefixed + Secure in production). CSRF: SameSite=Strict, JSON-only
 * bodies (cross-site JSON requires a CORS preflight, which the API never
 * grants for /admin), and Fetch Metadata rejection of cross-site requests.
 */
export function adminRouter(admin: AdminConfig, feedback: FeedbackService, isProduction: boolean): Router {
  const router = Router();
  const cookieName = isProduction ? '__Host-ir_admin' : 'ir_admin';
  const ttlMs = admin.sessionHours * 60 * 60 * 1000;

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') {
      return next(new HttpError(403, 'forbidden', 'Cross-site requests to the admin area are refused.'));
    }
    next();
  });

  const json = express.json({ limit: '2kb', strict: true });

  const setSession = (res: Response, token: string, maxAgeMs: number) => {
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: maxAgeMs,
    });
  };

  const requireSession: RequestHandler = (req, _res, next) => {
    const token = readCookie(req.headers.cookie, cookieName);
    if (!verifySessionToken(token, admin.sessionSecret)) {
      return next(new HttpError(401, 'unauthorized', 'Please sign in to the admin area.'));
    }
    next();
  };

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new HttpError(429, 'rate_limited', 'Too many sign-in attempts. Please wait 15 minutes and try again.'));
    },
  });

  const loginSchema = z.strictObject({ password: z.string().min(1).max(1024) });

  router.post('/login', loginLimiter, json, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw unprocessable('validation_failed', 'Enter the admin password.');
    if (!(await verifyPassword(parsed.data.password, admin.passwordHash))) {
      req.log.warn('admin sign-in failed');
      throw new HttpError(401, 'invalid_credentials', 'That password is not correct.');
    }
    req.log.info('admin signed in');
    setSession(res, createSessionToken(admin.sessionSecret, ttlMs), ttlMs);
    res.json({ authenticated: true, expiresInSeconds: Math.floor(ttlMs / 1000) });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(cookieName, { httpOnly: true, secure: isProduction, sameSite: 'strict', path: '/' });
    res.json({ authenticated: false });
  });

  router.get('/session', (req, res) => {
    res.json({ authenticated: verifySessionToken(readCookie(req.headers.cookie, cookieName), admin.sessionSecret) });
  });

  router.get('/overview', requireSession, async (_req, res) => {
    res.json(await feedback.overview());
  });

  const listQuery = z.object({
    status: z.enum(FEEDBACK_STATUSES).default('published'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(512).optional(),
  });

  router.get('/feedback', requireSession, async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw unprocessable('validation_failed', 'Invalid list parameters.');
    try {
      res.json(await feedback.store.list(parsed.data.status, parsed.data.limit, parsed.data.cursor));
    } catch (err) {
      if (err instanceof InvalidCursorError) throw unprocessable('invalid_cursor', 'The page cursor is invalid.');
      throw err;
    }
  });

  const idParam = (id: unknown): string => {
    if (typeof id !== 'string' || !FEEDBACK_ID.test(id)) throw new HttpError(404, 'not_found', 'Feedback not found.');
    return id;
  };

  const statusBody = z.strictObject({ status: z.enum(FEEDBACK_STATUSES) });

  router.patch('/feedback/:id', requireSession, json, async (req, res) => {
    const id = idParam(req.params.id);
    const parsed = statusBody.safeParse(req.body);
    if (!parsed.success) throw unprocessable('validation_failed', 'Status must be published, pending or hidden.');
    const updated = await feedback.setStatus(id, parsed.data.status);
    if (!updated) throw new HttpError(404, 'not_found', 'Feedback not found.');
    req.log.info({ feedbackId: id, status: updated.status }, 'feedback moderated');
    res.json(updated);
  });

  router.delete('/feedback/:id', requireSession, async (req, res) => {
    const id = idParam(req.params.id);
    if (!(await feedback.delete(id))) throw new HttpError(404, 'not_found', 'Feedback not found.');
    req.log.info({ feedbackId: id }, 'feedback deleted');
    res.status(204).end();
  });

  const settingsBody = z.strictObject({ wallEnabled: z.boolean() });

  router.put('/settings', requireSession, json, async (req, res) => {
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) throw unprocessable('validation_failed', 'wallEnabled must be true or false.');
    const settings = await feedback.updateSettings(parsed.data);
    req.log.info({ settings }, 'site settings updated');
    res.json(settings);
  });

  return router;
}

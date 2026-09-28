import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from '../config/env.js';
import { HttpError } from '../lib/errors.js';
import type { FeedbackService } from '../services/feedback/service.js';

/**
 * Public feedback endpoints: read the review wall, submit a rating.
 * Submissions are rate limited per client IP, validated strictly, cleaned of
 * invisible/control characters, and screened for links/contact details.
 */
export function feedbackRouter(config: AppConfig, feedback: FeedbackService): Router {
  const router = Router();

  router.get('/feedback', async (_req, res) => {
    const view = await feedback.publicView();
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json(view);
  });

  const submitLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: config.feedback.rateLimitPerHour,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new HttpError(429, 'rate_limited', 'Thanks! You have already sent feedback recently. Please try again later.'));
    },
  });

  router.post('/feedback', submitLimiter, express.json({ limit: '4kb', strict: true }), async (req, res) => {
    if (!req.is('application/json')) {
      throw new HttpError(415, 'unsupported_media_type', 'Send feedback as application/json.');
    }
    const result = await feedback.submit(req.body);
    if (result.accepted) req.log.info({ feedbackId: result.id, status: result.status }, 'feedback received');
    else req.log.warn('feedback honeypot triggered');
    res.setHeader('Cache-Control', 'no-store');
    // Honeypot hits get the same shape as a held comment, so bots learn nothing.
    res.status(201).json({ received: true, status: result.status ?? 'pending' });
  });

  return router;
}

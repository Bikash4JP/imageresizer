import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import helmet from 'helmet';
import { HttpError } from '../lib/errors.js';

/** Response headers the SPA reads from a successful /process call. */
export const EXPOSED_HEADERS = [
  'Content-Disposition',
  'X-Request-Id',
  'X-Output-Width',
  'X-Output-Height',
  'X-Output-Bytes',
  'X-Output-Format',
  'X-Output-Quality',
  'X-Target-Met',
  'X-Downscaled',
  'X-Input-Width',
  'X-Input-Height',
  'X-Input-Bytes',
  'X-Input-Format',
  'X-Processing-Time-Ms',
] as const;

/** API responses are JSON or image bytes and never need to run script or be framed. */
export const apiHelmet = (isProduction: boolean) =>
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    strictTransportSecurity: isProduction ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });

/**
 * Policy for the SPA shell when the API also serves the built client
 * (single-host deployments and local e2e). CloudFront applies the equivalent
 * via a response-headers policy in the S3 deployment.
 */
export const spaHelmet = (isProduction: boolean, apiOrigins: readonly string[] = []) =>
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", ...apiOrigins],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(isProduction ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: isProduction ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

/**
 * Minimal, allowlist-only CORS. Same-origin deployments (CloudFront routing
 * /api/* to EC2) need no CORS at all, so the default allowlist is empty.
 */
export function cors(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    res.vary('Origin');
    if (!origin || !allowed.has(origin)) {
      if (req.method === 'OPTIONS' && origin) {
        next(new HttpError(403, 'origin_not_allowed', 'This origin is not allowed to call the API.'));
        return;
      }
      next();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS.join(', '));
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * When the API sits behind CloudFront, CloudFront injects a shared secret
 * header. Requests that reach the origin without it bypassed the CDN (and its
 * WAF/rate limits) and are rejected. Health checks from the local load
 * balancer / nginx are exempt.
 *
 * Several secrets may be accepted at once so the value can be rotated without
 * downtime (instances accept old + new while CloudFront switches over).
 */
export function originVerify(secrets: readonly string[], exemptPaths: readonly string[]): RequestHandler {
  if (secrets.length === 0) return (_req, _res, next) => next();
  const expected = secrets.map((s) => Buffer.from(s));
  return (req, _res, next) => {
    if (exemptPaths.includes(req.path)) return next();
    const provided = Buffer.from(String(req.headers['x-origin-verify'] ?? ''));
    // Compare against every candidate (no early exit) to keep timing uniform.
    let ok = false;
    for (const candidate of expected) {
      if (provided.length === candidate.length && timingSafeEqual(provided, candidate)) ok = true;
    }
    if (!ok) return next(new HttpError(403, 'forbidden', 'Direct origin access is not allowed.'));
    next();
  };
}

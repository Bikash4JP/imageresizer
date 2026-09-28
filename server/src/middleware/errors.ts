import type { ErrorRequestHandler, RequestHandler } from 'express';
import { HttpError } from '../lib/errors.js';

/**
 * Errors are returned as RFC 9457 problem details. Internal errors are logged
 * with the request id and returned without any stack or message detail.
 */
export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, 'not_found', `No route for ${req.method} ${req.path}.`));
};

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const requestId = String(req.id ?? '');
  let http: HttpError;

  if (err instanceof HttpError) {
    http = err;
  } else if (isBodyParserError(err)) {
    http = new HttpError(err.status, 'invalid_request', 'The request body could not be parsed.');
  } else {
    req.log?.error({ err }, 'unhandled error');
    http = new HttpError(500, 'internal_error', 'An unexpected error occurred. Please try again.');
  }

  if (http.status >= 500 && err instanceof HttpError) req.log?.warn({ code: http.code }, http.message);

  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const [k, v] of Object.entries(http.headers ?? {})) res.setHeader(k, v);
  res
    .status(http.status)
    .type('application/problem+json')
    .setHeader('Cache-Control', 'no-store')
    .json({
      type: `urn:image-resizer:problem:${http.code}`,
      title: http.message,
      status: http.status,
      code: http.code,
      ...(http.details !== undefined ? { errors: http.details } : {}),
      requestId,
    });
};

function isBodyParserError(err: unknown): err is { status: number } {
  return typeof err === 'object' && err !== null && 'type' in err && 'status' in err && typeof err.status === 'number' && err.status < 500;
}

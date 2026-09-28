/**
 * Errors that are safe to show to API clients. Anything that is not an
 * HttpError is treated as an internal failure and reported generically.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);

export const unprocessable = (code: string, message: string, details?: unknown) =>
  new HttpError(422, code, message, details);

export const unsupportedMediaType = (message: string) => new HttpError(415, 'unsupported_media_type', message);

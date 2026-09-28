import { pino, type Logger } from 'pino';
import type { AppConfig } from '../config/env.js';

export type { Logger };

/**
 * Structured JSON logs. Anything that could carry credentials or user data is
 * redacted; image contents and original filenames are never logged.
 */
export function createLogger(config: Pick<AppConfig, 'logLevel' | 'prettyLogs'>): Logger {
  return pino({
    level: config.logLevel,
    base: { service: 'image-resizer' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-origin-verify"]',
        'res.headers["set-cookie"]',
      ],
      censor: '[redacted]',
    },
    ...(config.prettyLogs ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}

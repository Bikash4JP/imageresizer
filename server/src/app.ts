import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from './config/env.js';
import type { Logger } from './lib/logger.js';
import { Semaphore } from './lib/semaphore.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { apiHelmet, cors, originVerify, spaHelmet } from './middleware/security.js';
import { adminRouter } from './routes/admin.js';
import { apiRouter } from './routes/api.js';
import { feedbackRouter } from './routes/feedback.js';
import type { FeedbackService } from './services/feedback/service.js';
import type { TempStore } from './services/tempStore.js';

const REQUEST_ID = /^[\w-]{8,64}$/;

export interface AppDeps {
  logger: Logger;
  tempStore: TempStore;
  feedback: FeedbackService;
  semaphore?: Semaphore;
}

export function createApp(config: AppConfig, deps: AppDeps): Express {
  const app = express();
  const semaphore = deps.semaphore ?? new Semaphore(config.processing.concurrency, config.processing.queueLimit);

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.use(
    pinoHttp({
      logger: deps.logger,
      // Accept an upstream id (CloudFront/nginx) only if it is well-formed; never echo arbitrary input.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(
    '/api/v1',
    apiHelmet(config.isProduction),
    cors(config.corsOrigins),
    originVerify(config.originVerifySecrets, ['/health', '/ready']),
    apiRouter(config, { tempStore: deps.tempStore, semaphore }),
    feedbackRouter(config, deps.feedback),
    ...(config.admin ? [express.Router().use('/admin', adminRouter(config.admin, deps.feedback, config.isProduction))] : []),
    notFound,
  );

  if (config.staticDir) {
    const root = config.staticDir;
    app.use(spaHelmet(config.isProduction, config.corsOrigins));
    app.use(
      express.static(root, {
        index: false,
        dotfiles: 'ignore',
        setHeaders: (res, filePath) => {
          // Vite fingerprints everything under /assets, so it can be cached forever.
          const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
          res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(root, 'index.html'));
    });
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

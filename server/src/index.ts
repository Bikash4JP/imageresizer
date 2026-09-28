import { createServer } from 'node:http';
import sharp from 'sharp';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createFeedbackService } from './services/feedback/service.js';
import { TempStore } from './services/tempStore.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config);
  const tempStore = new TempStore(config.temp.dir, config.temp.maxAgeMs, logger);
  await tempStore.init();
  tempStore.startJanitor();

  const feedback = await createFeedbackService(config.feedback, logger);
  if (!config.admin) logger.warn('admin area disabled: set ADMIN_PASSWORD_HASH and ADMIN_SESSION_SECRET to enable it');

  const app = createApp(config, { logger, tempStore, feedback });
  const server = createServer(app);
  // Bound slow-loris style abuse while still allowing large uploads on slow links.
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;

  server.listen(config.port, config.host, () => {
    logger.info(
      {
        host: config.host,
        port: config.port,
        env: config.env,
        concurrency: config.processing.concurrency,
        libvips: sharp.versions.vips,
        staticDir: config.staticDir ?? null,
      },
      'image-resizer API listening',
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down: draining in-flight requests');
    const force = setTimeout(() => {
      logger.error('forced exit after drain timeout');
      process.exit(1);
    }, 30_000);
    force.unref();
    server.close(async () => {
      tempStore.stopJanitor();
      await tempStore.purgeAll();
      logger.info('shutdown complete');
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    shutdown('unhandledRejection');
  });
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err);
  process.exit(1);
});

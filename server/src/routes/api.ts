import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from '../config/env.js';
import { HttpError } from '../lib/errors.js';
import type { Semaphore } from '../lib/semaphore.js';
import { downloadName, singleImageUpload, workspace } from '../middleware/upload.js';
import { FILE_EXTENSIONS, MIME_TYPES, processImage } from '../services/imageProcessor.js';
import { INPUT_FORMATS } from '../services/imageSniffer.js';
import {
  createProcessOptionsSchema,
  FIT_MODES,
  OUTPUT_FORMATS,
  parseProcessOptions,
  POSITIONS,
  TARGET_SIZE_MAX_BYTES,
  TARGET_SIZE_MIN_BYTES,
} from '../services/processOptions.js';
import type { TempStore } from '../services/tempStore.js';

const VERSION = process.env.npm_package_version ?? '1.0.0';

export function apiRouter(config: AppConfig, deps: { tempStore: TempStore; semaphore: Semaphore }): Router {
  const router = Router();
  const schema = createProcessOptionsSchema(config.limits);
  const startedAt = Date.now();

  /** Liveness: the process is up and the event loop is responsive. */
  router.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok', version: VERSION, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  });

  /** Readiness: report load so a load balancer can steer traffic away when saturated. */
  router.get('/ready', (_req, res) => {
    const { active, queued, concurrency } = deps.semaphore.stats;
    const saturated = queued >= config.processing.queueLimit;
    res.setHeader('Cache-Control', 'no-store');
    res.status(saturated ? 503 : 200).json({ status: saturated ? 'saturated' : 'ready', active, queued, concurrency });
  });

  /** Limits and formats, so the client never hard-codes server policy. */
  router.get('/capabilities', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      maxUploadBytes: config.limits.maxUploadBytes,
      maxInputPixels: config.limits.maxInputPixels,
      maxOutputDimension: config.limits.maxOutputDimension,
      maxOutputPixels: config.limits.maxOutputPixels,
      inputFormats: INPUT_FORMATS,
      outputFormats: OUTPUT_FORMATS,
      fitModes: FIT_MODES,
      positions: POSITIONS,
      targetSize: { minBytes: TARGET_SIZE_MIN_BYTES, maxBytes: TARGET_SIZE_MAX_BYTES },
    });
  });

  const processLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // express-rate-limit has already set RateLimit/Retry-After headers by this point.
    handler: (_req, _res, next) => {
      next(new HttpError(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.'));
    },
  });

  router.post(
    '/images/process',
    processLimiter,
    workspace(deps.tempStore),
    singleImageUpload(config.limits.maxUploadBytes),
    async (req, res) => {
      if (!req.file) throw new HttpError(400, 'file_required', 'Attach an image in the "file" field.');
      const options = parseProcessOptions((req.body as Record<string, unknown> | undefined)?.options, schema);

      const result = await deps.semaphore.run(() =>
        processImage({
          filePath: req.file!.path,
          options,
          limits: config.limits,
          timeoutSeconds: config.processing.timeoutSeconds,
        }),
      );

      req.log.info(
        {
          inputFormat: result.input.format,
          inputBytes: result.input.bytes,
          outputFormat: result.format,
          outputBytes: result.buffer.length,
          targetMet: result.targetMet,
          durationMs: result.durationMs,
        },
        'image processed',
      );

      // attachment() infers Content-Type from the extension, so it goes first and is then pinned explicitly.
      res.attachment(downloadName(req.file.originalname, FILE_EXTENSIONS[result.format]));
      res.set({
        'Content-Type': MIME_TYPES[result.format],
        'Content-Length': String(result.buffer.length),
        'Cache-Control': 'no-store',
        'X-Output-Width': String(result.width),
        'X-Output-Height': String(result.height),
        'X-Output-Bytes': String(result.buffer.length),
        'X-Output-Format': result.format,
        'X-Output-Quality': result.quality === null ? 'lossless' : String(result.quality),
        'X-Target-Met': result.targetMet === null ? 'n/a' : String(result.targetMet),
        'X-Downscaled': String(result.downscaled),
        'X-Input-Width': String(result.input.width),
        'X-Input-Height': String(result.input.height),
        'X-Input-Bytes': String(result.input.bytes),
        'X-Input-Format': result.input.format,
        'X-Processing-Time-Ms': String(result.durationMs),
      });
      res.end(result.buffer);
    },
  );

  return router;
}

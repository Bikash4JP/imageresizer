import type { RequestHandler } from 'express';
import multer from 'multer';
import { HttpError } from '../lib/errors.js';
import type { TempStore } from '../services/tempStore.js';

/**
 * Allocates a private scratch directory for this request and guarantees it is
 * deleted once the response has been fully sent — or the client disconnects.
 * `close` fires in both cases, after `finish` on success.
 */
export function workspace(store: TempStore): RequestHandler {
  return (req, res, next) => {
    store.createWorkspace().then((dir) => {
      req.workspace = dir;
      res.once('close', () => {
        void store.release(dir);
      });
      next();
    }, next);
  };
}

const UPLOAD_FIELD = 'file';

/**
 * Streams the single allowed file to disk inside the request workspace under
 * a fixed name. The client filename is never used to build a path, so path
 * traversal via crafted names is impossible. Multipart structure is bounded
 * tightly to limit parser abuse.
 */
export function singleImageUpload(maxBytes: number): RequestHandler {
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        if (!req.workspace) return cb(new Error('workspace middleware must run before upload'), '');
        cb(null, req.workspace);
      },
      filename: (_req, _file, cb) => cb(null, 'input'),
    }),
    limits: {
      fileSize: maxBytes,
      files: 1,
      fields: 2,
      fieldSize: 8 * 1024,
      parts: 3,
      headerPairs: 50,
    },
    fileFilter: (_req, file, cb) => {
      // Declared MIME types are advisory only; real validation is by magic bytes.
      // This just rejects obviously wrong uploads before they hit the disk.
      const declared = file.mimetype.toLowerCase();
      if (declared.startsWith('image/') || declared === 'application/octet-stream' || declared === '') {
        cb(null, true);
        return;
      }
      cb(new HttpError(415, 'unsupported_media_type', 'Only image files can be uploaded.'));
    },
  }).single(UPLOAD_FIELD);

  return (req, res, next) => {
    upload(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        switch (err.code) {
          case 'LIMIT_FILE_SIZE':
            return next(
              new HttpError(413, 'file_too_large', `The file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB upload limit.`),
            );
          case 'LIMIT_UNEXPECTED_FILE':
          case 'LIMIT_FILE_COUNT':
            return next(new HttpError(400, 'invalid_upload', `Upload exactly one file in the "${UPLOAD_FIELD}" field.`));
          default:
            return next(new HttpError(400, 'invalid_upload', 'The multipart request is malformed or exceeds structural limits.'));
        }
      }
      next(err);
    });
  };
}

/** Safe download name: ASCII word characters only, derived from the original stem. */
export function downloadName(original: string | undefined, extension: string): string {
  // Split on both separators explicitly: path.parse only knows the host OS's.
  const base = (original ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .normalize('NFKD')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${stem || 'image'}-processed.${extension}`;
}

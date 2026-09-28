import type { FitMode, Rect, Rotation } from './geometry';

/**
 * API base. Empty means same-origin (`/api/v1`), which is how production runs
 * behind CloudFront and how the Vite dev proxy works. Only set
 * VITE_API_BASE_URL for split-origin deployments (the API must then list this
 * app's origin in CORS_ORIGINS). It is a public URL, never a secret: every
 * VITE_* variable is compiled into the JavaScript bundle.
 */
export const API_BASE = `${(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')}/api/v1`;

export type OutputFormat = 'jpeg' | 'png' | 'webp' | 'avif';
export type Position = 'center' | 'attention' | 'entropy';

export interface Capabilities {
  maxUploadBytes: number;
  maxInputPixels: number;
  maxOutputDimension: number;
  maxOutputPixels: number;
  inputFormats: string[];
  outputFormats: OutputFormat[];
  targetSize: { minBytes: number; maxBytes: number };
}

/** Used until /capabilities responds (or if it cannot be reached). Mirrors server defaults. */
export const DEFAULT_CAPABILITIES: Capabilities = {
  maxUploadBytes: 25 * 1024 * 1024,
  maxInputPixels: 50_000_000,
  maxOutputDimension: 10_000,
  maxOutputPixels: 50_000_000,
  inputFormats: ['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif'],
  outputFormats: ['jpeg', 'png', 'webp', 'avif'],
  targetSize: { minBytes: 1024, maxBytes: 200 * 1024 * 1024 },
};

export interface ProcessOptions {
  crop?: Rect;
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
  resize?: { width?: number; height?: number; fit: FitMode; position: Position; withoutEnlargement: boolean };
  format: 'original' | OutputFormat;
  quality: number;
  targetSizeBytes?: number;
  allowDownscale: boolean;
  background: string;
}

export interface ProcessResult {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
  bytes: number;
  format: OutputFormat;
  quality: number | null;
  targetMet: boolean | null;
  downscaled: boolean;
  input: { width: number; height: number; bytes: number; format: string };
  durationMs: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Array<{ path: string; message: string }>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function fetchCapabilities(signal?: AbortSignal): Promise<Capabilities> {
  const res = await fetch(`${API_BASE}/capabilities`, { signal, credentials: 'omit' });
  if (!res.ok) throw new ApiError('Could not load server capabilities.', res.status, 'capabilities_failed');
  return { ...DEFAULT_CAPABILITIES, ...((await res.json()) as Partial<Capabilities>) };
}

export interface ProcessHandlers {
  onUploadProgress?: (fraction: number) => void;
  /** Fires once the request body is fully sent and the server is working. */
  onProcessing?: () => void;
  signal?: AbortSignal;
}

export function processImage(file: File, options: ProcessOptions, handlers: ProcessHandlers = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('options', JSON.stringify(options));
    form.append('file', file, file.name);

    xhr.open('POST', `${API_BASE}/images/process`);
    xhr.responseType = 'blob';
    xhr.withCredentials = false;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) handlers.onUploadProgress?.(e.loaded / e.total);
    };
    xhr.upload.onload = () => handlers.onProcessing?.();

    const abort = () => xhr.abort();
    handlers.signal?.addEventListener('abort', abort, { once: true });
    const done = () => handlers.signal?.removeEventListener('abort', abort);

    xhr.onabort = () => {
      done();
      reject(new DOMException('Processing was cancelled.', 'AbortError'));
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError('Network error — check your connection and try again.', 0, 'network_error'));
    };
    xhr.ontimeout = xhr.onerror;

    xhr.onload = async () => {
      done();
      const blob = xhr.response as Blob;
      if (xhr.status !== 200) {
        reject(await toApiError(xhr.status, blob, xhr.getResponseHeader('X-Request-Id') ?? undefined));
        return;
      }
      const h = (name: string) => xhr.getResponseHeader(name) ?? '';
      const quality = h('X-Output-Quality');
      const target = h('X-Target-Met');
      resolve({
        blob,
        filename: filenameFrom(h('Content-Disposition')) ?? `image.${blob.type.split('/')[1] ?? 'bin'}`,
        width: Number(h('X-Output-Width')),
        height: Number(h('X-Output-Height')),
        bytes: blob.size,
        format: h('X-Output-Format') as OutputFormat,
        quality: quality === 'lossless' || quality === '' ? null : Number(quality),
        targetMet: target === 'true' ? true : target === 'false' ? false : null,
        downscaled: h('X-Downscaled') === 'true',
        input: {
          width: Number(h('X-Input-Width')),
          height: Number(h('X-Input-Height')),
          bytes: Number(h('X-Input-Bytes')),
          format: h('X-Input-Format'),
        },
        durationMs: Number(h('X-Processing-Time-Ms')),
      });
    };

    xhr.send(form);
  });
}

async function toApiError(status: number, body: Blob, requestId?: string): Promise<ApiError> {
  try {
    const problem = JSON.parse(await body.text()) as { title?: string; code?: string; errors?: ApiError['details']; requestId?: string };
    return new ApiError(problem.title ?? `Request failed (${status}).`, status, problem.code ?? 'error', problem.errors, problem.requestId ?? requestId);
  } catch {
    const fallback =
      status === 413 ? 'The file is too large for the server.' : status >= 500 ? 'The server could not process this image.' : `Request failed (${status}).`;
    return new ApiError(fallback, status, 'error', undefined, requestId);
  }
}

function filenameFrom(disposition: string): string | undefined {
  const match = /filename="([^"]+)"/.exec(disposition);
  return match?.[1];
}

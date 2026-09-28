import type { SourceImage } from '../state';
import { processImage, type Capabilities } from './api';

export class LoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadError';
  }
}

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/tiff', '']);

async function decode(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

/**
 * Prepares a file for editing. Browsers decode most formats natively (with
 * EXIF orientation applied). For formats they cannot decode — typically TIFF —
 * the server renders a downscaled WebP proxy, and reports the true oriented
 * dimensions so crop coordinates still map to full resolution.
 */
export async function loadSource(file: File, caps: Capabilities, signal?: AbortSignal): Promise<SourceImage> {
  if (!ACCEPTED_TYPES.has(file.type) && !file.type.startsWith('image/')) {
    throw new LoadError(`“${file.name}” is not an image file.`);
  }
  if (file.size > caps.maxUploadBytes) {
    throw new LoadError(`This file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${Math.round(caps.maxUploadBytes / 1024 / 1024)} MB.`);
  }

  const localUrl = URL.createObjectURL(file);
  let source: SourceImage;
  try {
    const element = await decode(localUrl);
    source = { file, element, previewUrl: localUrl, width: element.naturalWidth, height: element.naturalHeight, proxied: false };
  } catch {
    URL.revokeObjectURL(localUrl);
    const proxy = await processImage(
      file,
      {
        rotate: 0,
        flipH: false,
        flipV: false,
        resize: { width: 2048, height: 2048, fit: 'inside', position: 'center', withoutEnlargement: true },
        format: 'webp',
        quality: 80,
        allowDownscale: true,
        background: '#ffffff',
      },
      { signal },
    );
    const proxyUrl = URL.createObjectURL(proxy.blob);
    try {
      const element = await decode(proxyUrl);
      source = { file, element, previewUrl: proxyUrl, width: proxy.input.width, height: proxy.input.height, proxied: true };
    } catch {
      URL.revokeObjectURL(proxyUrl);
      throw new LoadError('This image could not be previewed.');
    }
  }

  if (source.width * source.height > caps.maxInputPixels) {
    URL.revokeObjectURL(source.previewUrl);
    throw new LoadError(
      `This image is ${((source.width * source.height) / 1_000_000).toFixed(1)} MP; the limit is ${Math.round(caps.maxInputPixels / 1_000_000)} MP.`,
    );
  }
  return source;
}

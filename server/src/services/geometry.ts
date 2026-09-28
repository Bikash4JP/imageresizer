import type { FitMode } from './processOptions.js';

/**
 * Predicts the output dimensions sharp will produce for a resize. Used as a
 * pre-flight guard so oversized outputs are rejected before any pixels are
 * decoded. Kept in sync with client/src/lib/geometry.ts (the UI shows the same
 * estimate).
 */
export interface Size {
  width: number;
  height: number;
}

export interface ResizeSpec {
  width?: number | undefined;
  height?: number | undefined;
  fit: FitMode;
  withoutEnlargement?: boolean | undefined;
}

const clampScale = (scale: number, withoutEnlargement: boolean | undefined) =>
  withoutEnlargement ? Math.min(1, scale) : scale;

export function computeOutputSize(source: Size, resize: ResizeSpec | undefined): Size {
  if (!resize || (resize.width === undefined && resize.height === undefined)) return { ...source };
  const { width, height, fit, withoutEnlargement } = resize;
  const round = (n: number) => Math.max(1, Math.round(n));

  if (width !== undefined && height === undefined) {
    const s = clampScale(width / source.width, withoutEnlargement);
    return { width: round(source.width * s), height: round(source.height * s) };
  }
  if (height !== undefined && width === undefined) {
    const s = clampScale(height / source.height, withoutEnlargement);
    return { width: round(source.width * s), height: round(source.height * s) };
  }

  const w = width as number;
  const h = height as number;
  switch (fit) {
    case 'inside':
    case 'outside': {
      const pick = fit === 'inside' ? Math.min : Math.max;
      const s = clampScale(pick(w / source.width, h / source.height), withoutEnlargement);
      return { width: round(source.width * s), height: round(source.height * s) };
    }
    case 'contain':
      // The canvas is always the requested size; withoutEnlargement only stops the content growing.
      return { width: w, height: h };
    case 'cover':
    case 'fill':
      // sharp clamps each side to the source independently (measured against sharp 0.35).
      return withoutEnlargement
        ? { width: Math.min(w, source.width), height: Math.min(h, source.height) }
        : { width: w, height: h };
  }
}

/** Dimensions after a clockwise rotation by a multiple of 90°. */
export function rotatedSize(size: Size, rotate: number): Size {
  return rotate % 180 === 90 ? { width: size.height, height: size.width } : { ...size };
}

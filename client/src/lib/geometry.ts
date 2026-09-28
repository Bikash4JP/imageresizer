export type FitMode = 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
export type Rotation = 0 | 90 | 180 | 270;

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  left: number;
  top: number;
}

export interface ResizeSpec {
  width?: number | undefined;
  height?: number | undefined;
  fit: FitMode;
  withoutEnlargement?: boolean | undefined;
}

/**
 * Mirrors server/src/services/geometry.ts so the UI can show the exact output
 * size before uploading. Both implementations are tested against the same cases.
 */
export function computeOutputSize(source: Size, resize: ResizeSpec | undefined): Size {
  if (!resize || (resize.width === undefined && resize.height === undefined)) return { ...source };
  const { width, height, fit, withoutEnlargement } = resize;
  const round = (n: number) => Math.max(1, Math.round(n));
  const clamp = (s: number) => (withoutEnlargement ? Math.min(1, s) : s);

  if (width !== undefined && height === undefined) {
    const s = clamp(width / source.width);
    return { width: round(source.width * s), height: round(source.height * s) };
  }
  if (height !== undefined && width === undefined) {
    const s = clamp(height / source.height);
    return { width: round(source.width * s), height: round(source.height * s) };
  }
  const w = width as number;
  const h = height as number;
  switch (fit) {
    case 'inside':
    case 'outside': {
      const pick = fit === 'inside' ? Math.min : Math.max;
      const s = clamp(pick(w / source.width, h / source.height));
      return { width: round(source.width * s), height: round(source.height * s) };
    }
    case 'contain':
      return { width: w, height: h };
    case 'cover':
    case 'fill':
      return withoutEnlargement
        ? { width: Math.min(w, source.width), height: Math.min(h, source.height) }
        : { width: w, height: h };
  }
}

export function rotatedSize(size: Size, rotate: Rotation): Size {
  return rotate % 180 === 90 ? { width: size.height, height: size.width } : { ...size };
}

export const fullRect = (bounds: Size): Rect => ({ left: 0, top: 0, width: bounds.width, height: bounds.height });

/** Largest rect with the given aspect (w/h) that fits in `bounds`, centred on `center`. */
export function fitAspect(bounds: Size, aspect: number, center?: { x: number; y: number }): Rect {
  let width = bounds.width;
  let height = Math.round(width / aspect);
  if (height > bounds.height) {
    height = bounds.height;
    width = Math.round(height * aspect);
  }
  width = Math.max(1, Math.min(width, bounds.width));
  height = Math.max(1, Math.min(height, bounds.height));
  const cx = center?.x ?? bounds.width / 2;
  const cy = center?.y ?? bounds.height / 2;
  return clampRect({ left: Math.round(cx - width / 2), top: Math.round(cy - height / 2), width, height }, bounds);
}

/** Shifts (never shrinks, unless larger than bounds) a rect so it lies inside `bounds`. Integer output. */
export function clampRect(rect: Rect, bounds: Size): Rect {
  const width = Math.max(1, Math.min(Math.round(rect.width), bounds.width));
  const height = Math.max(1, Math.min(Math.round(rect.height), bounds.height));
  const left = Math.min(Math.max(0, Math.round(rect.left)), bounds.width - width);
  const top = Math.min(Math.max(0, Math.round(rect.top)), bounds.height - height);
  return { left, top, width, height };
}

/**
 * Maps a crop rect through the same transform the image undergoes, so the
 * user's selection follows the picture when they rotate or mirror it.
 * `bounds` is the frame *before* the operation.
 */
export function rotateRectClockwise(rect: Rect, bounds: Size): Rect {
  return { left: bounds.height - rect.top - rect.height, top: rect.left, width: rect.height, height: rect.width };
}
export function rotateRectCounterClockwise(rect: Rect, bounds: Size): Rect {
  return { left: rect.top, top: bounds.width - rect.left - rect.width, width: rect.height, height: rect.width };
}
export function flipRectHorizontal(rect: Rect, bounds: Size): Rect {
  return { ...rect, left: bounds.width - rect.left - rect.width };
}
export function flipRectVertical(rect: Rect, bounds: Size): Rect {
  return { ...rect, top: bounds.height - rect.top - rect.height };
}

export interface Edges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

/**
 * Resizes `start` by dragging the given edges by (dx, dy) image pixels, keeping
 * the opposite edges anchored, respecting `bounds`, `minSize` and an optional
 * aspect ratio. With an aspect ratio, side handles grow the other axis
 * symmetrically about the centre.
 */
export function resizeRect(start: Rect, edges: Edges, dx: number, dy: number, bounds: Size, aspect: number | null, minSize = 8): Rect {
  const min = Math.min(minSize, bounds.width, bounds.height);
  let l = start.left;
  let t = start.top;
  let r = start.left + start.width;
  let b = start.top + start.height;

  if (edges.left) l = Math.min(Math.max(0, l + dx), r - min);
  if (edges.right) r = Math.max(Math.min(bounds.width, r + dx), l + min);
  if (edges.top) t = Math.min(Math.max(0, t + dy), b - min);
  if (edges.bottom) b = Math.max(Math.min(bounds.height, b + dy), t + min);

  if (aspect === null) return clampRect({ left: l, top: t, width: r - l, height: b - t }, bounds);

  let w = r - l;
  let h = b - t;
  const horizontal = !!(edges.left || edges.right);
  const vertical = !!(edges.top || edges.bottom);

  if (horizontal && vertical) {
    // Corner: the axis whose *change* is larger (in height units) drives the other.
    // Comparing changes, not sizes, lets a corner shrink as well as grow.
    const dw = (w - start.width) / aspect;
    const dh = h - start.height;
    if (Math.abs(dw) >= Math.abs(dh)) h = w / aspect;
    else w = h * aspect;
  } else if (horizontal) {
    h = w / aspect;
  } else {
    w = h * aspect;
  }

  // Space available from the anchor, in each direction.
  const anchorX = edges.left ? r : edges.right ? l : (l + r) / 2;
  const anchorY = edges.top ? b : edges.bottom ? t : (t + b) / 2;
  const maxW = edges.left ? anchorX : edges.right ? bounds.width - anchorX : 2 * Math.min(anchorX, bounds.width - anchorX);
  const maxH = edges.top ? anchorY : edges.bottom ? bounds.height - anchorY : 2 * Math.min(anchorY, bounds.height - anchorY);
  const scale = Math.min(1, maxW / w, maxH / h);
  w *= scale;
  h *= scale;
  if (w < min || h < min) {
    const grow = Math.max(min / w, min / h);
    w *= grow;
    h *= grow;
  }

  const left = edges.left ? anchorX - w : edges.right ? anchorX : anchorX - w / 2;
  const top = edges.top ? anchorY - h : edges.bottom ? anchorY : anchorY - h / 2;
  return clampRect({ left, top, width: w, height: h }, bounds);
}

export function moveRect(start: Rect, dx: number, dy: number, bounds: Size): Rect {
  return clampRect({ ...start, left: start.left + dx, top: start.top + dy }, bounds);
}

export function aspectOf(size: Size): number {
  return size.width / size.height;
}

/** Greatest-common-divisor ratio label, e.g. 1920×1080 → "16:9". Falls back to a decimal. */
export function ratioLabel(size: Size): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(size.width, size.height);
  const w = size.width / g;
  const h = size.height / g;
  return w <= 50 && h <= 50 ? `${w}:${h}` : `${(size.width / size.height).toFixed(2)}:1`;
}

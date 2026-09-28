import { describe, expect, it } from 'vitest';
import {
  clampRect,
  computeOutputSize,
  fitAspect,
  flipRectHorizontal,
  flipRectVertical,
  moveRect,
  ratioLabel,
  resizeRect,
  rotateRectClockwise,
  rotateRectCounterClockwise,
  type Rect,
} from './geometry';
import { formatBytes, formatDelta, toBytes } from './format';

describe('computeOutputSize (parity with server; values measured from sharp 0.35)', () => {
  const src = { width: 400, height: 300 };
  it.each([
    [{ width: 200, fit: 'inside' as const }, { width: 200, height: 150 }],
    [{ height: 150, fit: 'inside' as const }, { width: 200, height: 150 }],
    [{ width: 200, height: 200, fit: 'inside' as const }, { width: 200, height: 150 }],
    [{ width: 200, height: 200, fit: 'outside' as const }, { width: 267, height: 200 }],
    [{ width: 200, height: 200, fit: 'cover' as const }, { width: 200, height: 200 }],
    [{ width: 800, height: 100, fit: 'contain' as const, withoutEnlargement: true }, { width: 800, height: 100 }],
    [{ width: 800, height: 100, fit: 'cover' as const, withoutEnlargement: true }, { width: 400, height: 100 }],
    [{ width: 100, height: 800, fit: 'fill' as const, withoutEnlargement: true }, { width: 100, height: 300 }],
    [{ width: 800, height: 100, fit: 'outside' as const, withoutEnlargement: true }, { width: 400, height: 300 }],
    [{ width: 300, height: 200, fit: 'outside' as const, withoutEnlargement: true }, { width: 300, height: 225 }],
    [{ width: 800, fit: 'inside' as const, withoutEnlargement: true }, { width: 400, height: 300 }],
  ])('%o → %o', (spec, expected) => {
    expect(computeOutputSize(src, spec)).toEqual(expected);
  });
});

describe('crop rect transforms', () => {
  const bounds = { width: 100, height: 60 };
  const r: Rect = { left: 10, top: 5, width: 30, height: 20 };

  it('rotating clockwise four times is the identity', () => {
    let rect = r;
    let b = bounds;
    for (let i = 0; i < 4; i++) {
      rect = rotateRectClockwise(rect, b);
      b = { width: b.height, height: b.width };
    }
    expect(rect).toEqual(r);
  });

  it('clockwise then counter-clockwise is the identity', () => {
    const rotated = rotateRectClockwise(r, bounds);
    expect(rotated).toEqual({ left: 35, top: 10, width: 20, height: 30 });
    expect(rotateRectCounterClockwise(rotated, { width: 60, height: 100 })).toEqual(r);
  });

  it('flips are involutions', () => {
    expect(flipRectHorizontal(flipRectHorizontal(r, bounds), bounds)).toEqual(r);
    expect(flipRectVertical(flipRectVertical(r, bounds), bounds)).toEqual(r);
    expect(flipRectHorizontal(r, bounds).left).toBe(60);
  });
});

describe('fitAspect / clampRect / moveRect', () => {
  it('finds the largest centred rect for an aspect', () => {
    expect(fitAspect({ width: 400, height: 300 }, 1)).toEqual({ left: 50, top: 0, width: 300, height: 300 });
    expect(fitAspect({ width: 400, height: 300 }, 16 / 9)).toEqual({ left: 0, top: 38, width: 400, height: 225 });
  });

  it('keeps rects inside bounds', () => {
    expect(clampRect({ left: -5, top: 290, width: 50, height: 50 }, { width: 400, height: 300 })).toEqual({
      left: 0,
      top: 250,
      width: 50,
      height: 50,
    });
    expect(moveRect({ left: 10, top: 10, width: 50, height: 50 }, 1000, -1000, { width: 400, height: 300 })).toEqual({
      left: 350,
      top: 0,
      width: 50,
      height: 50,
    });
  });
});

describe('resizeRect', () => {
  const bounds = { width: 400, height: 300 };
  const start: Rect = { left: 100, top: 100, width: 100, height: 100 };

  it('free resize anchors the opposite edge', () => {
    expect(resizeRect(start, { right: true, bottom: true }, 50, 20, bounds, null)).toEqual({ left: 100, top: 100, width: 150, height: 120 });
    expect(resizeRect(start, { left: true }, -30, 0, bounds, null)).toEqual({ left: 70, top: 100, width: 130, height: 100 });
  });

  it('never inverts below the minimum size', () => {
    const r = resizeRect(start, { left: true }, 500, 0, bounds, null, 8);
    expect(r.width).toBe(8);
    expect(r.left + r.width).toBe(200);
  });

  it('stops at image bounds', () => {
    expect(resizeRect(start, { right: true }, 10_000, 0, bounds, null)).toMatchObject({ left: 100, width: 300 });
  });

  it('maintains aspect ratio from a corner, anchored at the opposite corner', () => {
    const r = resizeRect(start, { right: true, bottom: true }, 60, 0, bounds, 1);
    expect(r).toEqual({ left: 100, top: 100, width: 160, height: 160 });
  });

  it('shrinks from a corner when only one axis moves', () => {
    const full: Rect = { left: 0, top: 0, width: 400, height: 225 };
    const r = resizeRect(full, { right: true, bottom: true }, -40, 0, { width: 400, height: 300 }, 16 / 9);
    expect(r).toEqual({ left: 0, top: 0, width: 360, height: 203 });
  });

  it('shrinks from a corner on a diagonal drag inward', () => {
    const r = resizeRect(start, { left: true, top: true }, 30, 10, bounds, 1);
    expect(r).toEqual({ left: 130, top: 130, width: 70, height: 70 });
  });

  it('maintains aspect ratio from a side handle, growing symmetrically', () => {
    const r = resizeRect(start, { right: true }, 20, 0, bounds, 1);
    expect(r).toEqual({ left: 100, top: 90, width: 120, height: 120 });
  });

  it('shrinks proportionally when aspect growth would leave the image', () => {
    const r = resizeRect(start, { right: true, bottom: true }, 1000, 1000, bounds, 2);
    expect(r.width / r.height).toBeCloseTo(2, 1);
    expect(r.left + r.width).toBeLessThanOrEqual(400);
    expect(r.top + r.height).toBeLessThanOrEqual(300);
  });
});

describe('formatting', () => {
  it('formats sizes and deltas', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatDelta(1000, 400)).toBe('−60%');
    expect(formatDelta(1000, 1100)).toBe('+10%');
    expect(toBytes(1.5, 'MB')).toBe(1_572_864);
    expect(ratioLabel({ width: 1920, height: 1080 })).toBe('16:9');
    expect(ratioLabel({ width: 1001, height: 997 })).toBe('1.00:1');
  });
});

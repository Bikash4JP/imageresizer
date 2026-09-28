import { describe, expect, it } from 'vitest';
import { estimatedOutputOf, initialState, reducer, toProcessOptions, type Action, type EditorState, type SourceImage } from './state';

const source = (width: number, height: number): SourceImage => ({
  file: { name: 'x.jpg', type: 'image/jpeg', size: 1000 } as File,
  element: {} as HTMLImageElement,
  previewUrl: 'blob:x',
  width,
  height,
  proxied: false,
});

const apply = (actions: Action[], s: EditorState = initialState) => actions.reduce(reducer, s);
const loaded = (w = 400, h = 300) => apply([{ type: 'load', source: source(w, h) }]);

/** Model of the server's documented semantics: rotate clockwise, then mirror in the rotated frame. */
type Grid = string[][];
const rotateGrid = (g: Grid): Grid => g[0]!.map((_, x) => g.map((row) => row[x]!).reverse());
const flipH = (g: Grid): Grid => g.map((row) => [...row].reverse());
const flipV = (g: Grid): Grid => [...g].reverse();
function display(s: EditorState): Grid {
  let g: Grid = [
    ['a', 'b', 'c'],
    ['d', 'e', 'f'],
  ];
  for (let i = 0; i < s.rotate / 90; i++) g = rotateGrid(g);
  if (s.flipH) g = flipH(g);
  if (s.flipV) g = flipV(g);
  return g;
}

describe('rotate/flip keep "what you see" consistent', () => {
  const starts: Action[][] = [[], [{ type: 'flip', axis: 'h' }], [{ type: 'flip', axis: 'v' }], [{ type: 'flip', axis: 'h' }, { type: 'flip', axis: 'v' }], [{ type: 'rotate', direction: 'cw' }, { type: 'flip', axis: 'h' }]];

  it.each(starts.map((a, i) => [i, a] as const))('rotate cw rotates the visible image clockwise (start %i)', (_i, actions) => {
    const before = apply(actions, loaded());
    const after = reducer(before, { type: 'rotate', direction: 'cw' });
    expect(display(after)).toEqual(rotateGrid(display(before)));
  });

  it.each(starts.map((a, i) => [i, a] as const))('rotate ccw undoes rotate cw (start %i)', (_i, actions) => {
    const before = apply(actions, loaded());
    const after = apply([{ type: 'rotate', direction: 'cw' }, { type: 'rotate', direction: 'ccw' }], before);
    expect(display(after)).toEqual(display(before));
    expect(after.crop.rect).toEqual(before.crop.rect);
  });
});

describe('crop', () => {
  it('follows the image through a rotation', () => {
    const s = apply([{ type: 'cropEnabled', enabled: true }, { type: 'cropRect', rect: { left: 10, top: 20, width: 100, height: 50 } }], loaded(400, 300));
    const r = reducer(s, { type: 'rotate', direction: 'cw' });
    // 400×300 → 300×400: the top-left region moves to the top-right.
    expect(r.crop.rect).toEqual({ left: 230, top: 10, width: 50, height: 100 });
  });

  it('snaps to the largest centred rect for a preset', () => {
    const s = apply([{ type: 'cropEnabled', enabled: true }, { type: 'aspect', aspectId: '1:1' }], loaded(400, 300));
    expect(s.crop.rect).toEqual({ left: 50, top: 0, width: 300, height: 300 });
    expect(toProcessOptions(s).crop).toEqual({ left: 50, top: 0, width: 300, height: 300 });
  });

  it('omits a full-frame crop from the request', () => {
    const s = apply([{ type: 'cropEnabled', enabled: true }], loaded());
    expect(toProcessOptions(s).crop).toBeUndefined();
  });
});

describe('resize', () => {
  it('locked resize sends only the edited dimension and derives the other', () => {
    const s = apply([{ type: 'resize', patch: { enabled: true } }, { type: 'resizeDimension', dimension: 'height', value: 150 }], loaded(400, 300));
    expect(s.resize).toMatchObject({ width: 200, height: 150, driver: 'height' });
    expect(toProcessOptions(s).resize).toEqual({ height: 150, fit: 'inside', position: 'center', withoutEnlargement: false });
    expect(estimatedOutputOf(s)).toEqual({ width: 200, height: 150 });
  });

  it('unlocked resize sends both dimensions and the fit', () => {
    const s = apply(
      [
        { type: 'resize', patch: { enabled: true, lock: false, fit: 'cover', position: 'attention' } },
        { type: 'resizeDimension', dimension: 'width', value: 100 },
        { type: 'resizeDimension', dimension: 'height', value: 100 },
      ],
      loaded(400, 300),
    );
    expect(toProcessOptions(s).resize).toEqual({ width: 100, height: 100, fit: 'cover', position: 'attention', withoutEnlargement: false });
  });

  it('percentage scales the cropped region', () => {
    const s = apply(
      [
        { type: 'cropEnabled', enabled: true },
        { type: 'cropRect', rect: { left: 0, top: 0, width: 200, height: 100 } },
        { type: 'resize', patch: { enabled: true, mode: 'percent', percent: 50 } },
      ],
      loaded(400, 300),
    );
    expect(estimatedOutputOf(s)).toEqual({ width: 100, height: 50 });
  });
});

describe('output options', () => {
  it('converts the target size and transparent background', () => {
    const s = apply([{ type: 'output', patch: { targetEnabled: true, targetValue: 1.5, targetUnit: 'MB', transparent: true } }], loaded());
    const o = toProcessOptions(s);
    expect(o.targetSizeBytes).toBe(1_572_864);
    expect(o.background).toBe('transparent');
  });

  it('keeps output preferences when a new image is opened', () => {
    const s = apply([{ type: 'output', patch: { format: 'webp', quality: 70 } }, { type: 'load', source: source(10, 10) }], loaded());
    expect(s.output).toMatchObject({ format: 'webp', quality: 70 });
    expect(s.rotate).toBe(0);
  });
});

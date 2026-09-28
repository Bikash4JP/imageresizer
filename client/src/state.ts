import type { OutputFormat, Position, ProcessOptions } from './lib/api';
import type { SizeUnit } from './lib/format';
import { toBytes } from './lib/format';
import {
  computeOutputSize,
  fitAspect,
  flipRectHorizontal,
  flipRectVertical,
  fullRect,
  rotatedSize,
  rotateRectClockwise,
  rotateRectCounterClockwise,
  type FitMode,
  type Rect,
  type ResizeSpec,
  type Rotation,
  type Size,
} from './lib/geometry';

export interface SourceImage {
  file: File;
  /** Decoded preview (the file itself, or a server-rendered proxy for formats the browser cannot decode). */
  element: HTMLImageElement;
  previewUrl: string;
  /** Full-resolution size after EXIF orientation. */
  width: number;
  height: number;
  proxied: boolean;
}

export const ASPECT_PRESETS = [
  { id: 'free', label: 'Free', ratio: null },
  { id: 'original', label: 'Original', ratio: 'original' },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '5:4', label: '5:4', ratio: 5 / 4 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
] as const;
export type AspectId = (typeof ASPECT_PRESETS)[number]['id'];

export interface EditorState {
  source: SourceImage | null;
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
  crop: { enabled: boolean; rect: Rect; aspectId: AspectId; portrait: boolean };
  resize: {
    enabled: boolean;
    mode: 'pixels' | 'percent';
    lock: boolean;
    /** With the lock on, only the dimension the user last edited is sent; the other follows. */
    driver: 'width' | 'height';
    width: number;
    height: number;
    percent: number;
    fit: FitMode;
    position: Position;
    withoutEnlargement: boolean;
  };
  output: {
    format: 'original' | OutputFormat;
    quality: number;
    targetEnabled: boolean;
    targetValue: number;
    targetUnit: SizeUnit;
    allowDownscale: boolean;
    background: string;
    transparent: boolean;
  };
}

export const initialState: EditorState = {
  source: null,
  rotate: 0,
  flipH: false,
  flipV: false,
  crop: { enabled: false, rect: { left: 0, top: 0, width: 1, height: 1 }, aspectId: 'free', portrait: false },
  resize: {
    enabled: false,
    mode: 'pixels',
    lock: true,
    driver: 'width',
    width: 1,
    height: 1,
    percent: 50,
    fit: 'cover',
    position: 'center',
    withoutEnlargement: false,
  },
  output: {
    format: 'original',
    quality: 82,
    targetEnabled: false,
    targetValue: 200,
    targetUnit: 'KB',
    allowDownscale: true,
    background: '#ffffff',
    transparent: false,
  },
};

export type Action =
  | { type: 'load'; source: SourceImage }
  | { type: 'clear' }
  | { type: 'rotate'; direction: 'cw' | 'ccw' }
  | { type: 'flip'; axis: 'h' | 'v' }
  | { type: 'resetTransform' }
  | { type: 'cropEnabled'; enabled: boolean }
  | { type: 'cropRect'; rect: Rect }
  | { type: 'aspect'; aspectId: AspectId }
  | { type: 'aspectOrientation'; portrait: boolean }
  | { type: 'resize'; patch: Partial<EditorState['resize']> }
  | { type: 'resizeDimension'; dimension: 'width' | 'height'; value: number }
  | { type: 'output'; patch: Partial<EditorState['output']> };

export const frameOf = (s: EditorState): Size =>
  s.source ? rotatedSize({ width: s.source.width, height: s.source.height }, s.rotate) : { width: 1, height: 1 };

export const regionOf = (s: EditorState): Size => (s.crop.enabled ? s.crop.rect : frameOf(s));

/** The effective crop aspect ratio (w/h), or null for free-form. */
export function aspectRatioOf(s: EditorState): number | null {
  const preset = ASPECT_PRESETS.find((p) => p.id === s.crop.aspectId);
  if (!preset || preset.ratio === null) return null;
  if (preset.ratio === 'original') {
    const f = frameOf(s);
    return f.width / f.height;
  }
  return s.crop.portrait ? 1 / preset.ratio : preset.ratio;
}

function withAspectRect(s: EditorState): EditorState {
  const ratio = aspectRatioOf(s);
  if (ratio === null) return s;
  const r = s.crop.rect;
  const rect = fitAspect(frameOf(s), ratio, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  return { ...s, crop: { ...s.crop, rect } };
}

/** Keep resize numbers meaningful when the region they scale changes. */
function syncResize(s: EditorState): EditorState {
  const region = regionOf(s);
  return { ...s, resize: { ...s.resize, width: region.width, height: region.height } };
}

export function reducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'load': {
      const next: EditorState = {
        ...initialState,
        output: state.output, // output preferences carry across images
        source: action.source,
      };
      const frame = frameOf(next);
      return syncResize({ ...next, crop: { ...initialState.crop, rect: fullRect(frame) } });
    }
    case 'clear':
      return { ...initialState, output: state.output };
    case 'rotate': {
      const before = frameOf(state);
      const rect =
        action.direction === 'cw' ? rotateRectClockwise(state.crop.rect, before) : rotateRectCounterClockwise(state.crop.rect, before);
      const rotate = ((state.rotate + (action.direction === 'cw' ? 90 : 270)) % 360) as Rotation;
      // Output = flip(rotate(image)). Rotating what the user *sees* by 90° means
      // R90·Fh = Fv·R90, so the mirror axes swap. (A no-op when both or neither are set.)
      const next = {
        ...state,
        rotate,
        flipH: state.flipV,
        flipV: state.flipH,
        crop: { ...state.crop, rect, portrait: !state.crop.portrait },
      };
      return syncResize(next);
    }
    case 'flip': {
      const frame = frameOf(state);
      const rect = action.axis === 'h' ? flipRectHorizontal(state.crop.rect, frame) : flipRectVertical(state.crop.rect, frame);
      return {
        ...state,
        flipH: action.axis === 'h' ? !state.flipH : state.flipH,
        flipV: action.axis === 'v' ? !state.flipV : state.flipV,
        crop: { ...state.crop, rect },
      };
    }
    case 'resetTransform': {
      const next: EditorState = { ...state, rotate: 0, flipH: false, flipV: false };
      return syncResize({ ...next, crop: { ...next.crop, rect: fullRect(frameOf(next)), portrait: false } });
    }
    case 'cropEnabled': {
      const next = { ...state, crop: { ...state.crop, enabled: action.enabled, rect: fullRect(frameOf(state)) } };
      return syncResize(action.enabled ? withAspectRect(next) : next);
    }
    case 'cropRect':
      return syncResize({ ...state, crop: { ...state.crop, rect: action.rect } });
    case 'aspect': {
      const frame = frameOf(state);
      const portrait = action.aspectId === 'free' || action.aspectId === 'original' || action.aspectId === '1:1'
        ? false
        : frame.height > frame.width;
      return syncResize(withAspectRect({ ...state, crop: { ...state.crop, aspectId: action.aspectId, portrait } }));
    }
    case 'aspectOrientation':
      return syncResize(withAspectRect({ ...state, crop: { ...state.crop, portrait: action.portrait } }));
    case 'resize': {
      const next = { ...state, resize: { ...state.resize, ...action.patch } };
      return action.patch.enabled ? syncResize(next) : next;
    }
    case 'resizeDimension': {
      const region = regionOf(state);
      const value = Math.max(1, Math.round(action.value));
      if (!state.resize.lock) return { ...state, resize: { ...state.resize, [action.dimension]: value } };
      const other = action.dimension === 'width'
        ? Math.max(1, Math.round((value * region.height) / region.width))
        : Math.max(1, Math.round((value * region.width) / region.height));
      return {
        ...state,
        resize: {
          ...state.resize,
          driver: action.dimension,
          width: action.dimension === 'width' ? value : other,
          height: action.dimension === 'height' ? value : other,
        },
      };
    }
    case 'output':
      return { ...state, output: { ...state.output, ...action.patch } };
  }
}

export function resizeSpecOf(s: EditorState): ResizeSpec | undefined {
  const r = s.resize;
  if (!r.enabled) return undefined;
  const region = regionOf(s);
  if (r.mode === 'percent') {
    return { width: Math.max(1, Math.round((region.width * r.percent) / 100)), fit: 'inside' };
  }
  if (r.lock) return { [r.driver]: r[r.driver], fit: 'inside', withoutEnlargement: r.withoutEnlargement };
  return { width: r.width, height: r.height, fit: r.fit, withoutEnlargement: r.withoutEnlargement };
}

export const estimatedOutputOf = (s: EditorState): Size => computeOutputSize(regionOf(s), resizeSpecOf(s));

export function toProcessOptions(s: EditorState): ProcessOptions {
  const spec = resizeSpecOf(s);
  const o = s.output;
  const frame = frameOf(s);
  const cropIsFull = s.crop.rect.left === 0 && s.crop.rect.top === 0 && s.crop.rect.width === frame.width && s.crop.rect.height === frame.height;
  return {
    ...(s.crop.enabled && !cropIsFull ? { crop: s.crop.rect } : {}),
    rotate: s.rotate,
    flipH: s.flipH,
    flipV: s.flipV,
    ...(spec
      ? {
          resize: {
            ...(spec.width !== undefined ? { width: spec.width } : {}),
            ...(spec.height !== undefined ? { height: spec.height } : {}),
            fit: spec.fit,
            position: s.resize.position,
            withoutEnlargement: !!spec.withoutEnlargement,
          },
        }
      : {}),
    format: o.format,
    quality: o.quality,
    ...(o.targetEnabled ? { targetSizeBytes: toBytes(o.targetValue, o.targetUnit) } : {}),
    allowDownscale: o.allowDownscale,
    background: o.transparent ? 'transparent' : o.background,
  };
}

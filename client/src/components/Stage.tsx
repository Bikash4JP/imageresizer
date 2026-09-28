import { useEffect, useRef, type Dispatch } from 'react';
import { formatBytes, formatDimensions, formatMegapixels } from '../lib/format';
import { rotatedSize } from '../lib/geometry';
import { aspectRatioOf, frameOf, type Action, type EditorState, type SourceImage } from '../state';
import { CropOverlay } from './CropOverlay';
import { CloseIcon, UploadIcon } from './icons';

/** Long-side cap for the on-screen preview; the server always works at full resolution. */
const PREVIEW_MAX_SIDE = 2048;

/**
 * Draws the source with the same semantics the API uses: rotate clockwise,
 * then mirror within the rotated frame. Canvas transforms apply last-first,
 * so the mirror is set up before the rotation.
 */
function drawPreview(canvas: HTMLCanvasElement, source: SourceImage, rotate: EditorState['rotate'], flipH: boolean, flipV: boolean) {
  const frame = rotatedSize(source, rotate);
  const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(frame.width, frame.height));
  const cw = Math.max(1, Math.round(frame.width * scale));
  const ch = Math.max(1, Math.round(frame.height * scale));
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.translate(flipH ? cw : 0, flipV ? ch : 0);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  const sw = source.width * scale;
  const sh = source.height * scale;
  ctx.drawImage(source.element, -sw / 2, -sh / 2, sw, sh);
}

interface StageProps {
  state: EditorState;
  dispatch: Dispatch<Action>;
  onReplace: () => void;
  onRemove: () => void;
}

export function Stage({ state, dispatch, onReplace, onRemove }: StageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const { source, rotate, flipH, flipV } = state;

  useEffect(() => {
    if (canvasRef.current && source) drawPreview(canvasRef.current, source, rotate, flipH, flipV);
  }, [source, rotate, flipH, flipV]);

  if (!source) return null;
  const frame = frameOf(state);
  const transformDesc = [rotate ? `rotated ${rotate}°` : '', flipH ? 'mirrored horizontally' : '', flipV ? 'mirrored vertically' : '']
    .filter(Boolean)
    .join(', ');
  const typeLabel = (source.file.type.split('/')[1] ?? 'image').toUpperCase();

  return (
    <section className="card" aria-label="Image preview">
      <div className="stage">
        <div className="canvas-frame" ref={frameRef}>
          <p className="visually-hidden">
            Preview of {source.file.name}, {formatDimensions(frame.width, frame.height)} pixels{transformDesc ? `, ${transformDesc}` : ''}.
          </p>
          <canvas ref={canvasRef} aria-hidden="true" />
          {state.crop.enabled ? (
            <CropOverlay
              rect={state.crop.rect}
              frame={frame}
              aspect={aspectRatioOf(state)}
              frameRef={frameRef}
              onChange={(rect) => dispatch({ type: 'cropRect', rect })}
            />
          ) : null}
        </div>
      </div>
      <div className="stage-bar">
        <div className="file-meta">
          <span className="file-name" title={source.file.name}>
            {source.file.name}
          </span>
          <span className="meta-sep" aria-hidden="true" />
          <span className="num">{formatDimensions(source.width, source.height)} px</span>
          <span className="meta-sep" aria-hidden="true" />
          <span className="num">{formatMegapixels(source.width, source.height)}</span>
          <span className="meta-sep" aria-hidden="true" />
          <span className="num">{formatBytes(source.file.size)}</span>
          <span className="meta-sep" aria-hidden="true" />
          <span>{typeLabel}</span>
        </div>
        <div className="toolbar">
          <button type="button" className="btn btn-sm" onClick={onReplace}>
            <UploadIcon size={14} />
            Replace
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRemove}>
            <CloseIcon size={14} />
            Remove
          </button>
        </div>
      </div>
    </section>
  );
}

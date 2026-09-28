import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { formatDimensions } from '../lib/format';
import { moveRect, resizeRect, type Edges, type Rect, type Size } from '../lib/geometry';

const HANDLES: ReadonlyArray<{ id: string; edges: Edges; x: number; y: number }> = [
  { id: 'nw', edges: { top: true, left: true }, x: 0, y: 0 },
  { id: 'n', edges: { top: true }, x: 50, y: 0 },
  { id: 'ne', edges: { top: true, right: true }, x: 100, y: 0 },
  { id: 'e', edges: { right: true }, x: 100, y: 50 },
  { id: 'se', edges: { bottom: true, right: true }, x: 100, y: 100 },
  { id: 's', edges: { bottom: true }, x: 50, y: 100 },
  { id: 'sw', edges: { bottom: true, left: true }, x: 0, y: 100 },
  { id: 'w', edges: { left: true }, x: 0, y: 50 },
];

interface DragState {
  mode: 'move' | Edges;
  startX: number;
  startY: number;
  start: Rect;
  /** Image pixels per CSS pixel at drag start. */
  scale: number;
  pointerId: number;
}

interface CropOverlayProps {
  rect: Rect;
  frame: Size;
  aspect: number | null;
  onChange: (rect: Rect) => void;
  frameRef: RefObject<HTMLDivElement | null>;
}

const pct = (v: number, total: number) => `${(v / total) * 100}%`;

/**
 * Pointer-driven crop selection with a full keyboard alternative. Numeric
 * X/Y/W/H fields in the Crop panel provide a third, non-drag path (WCAG 2.5.7).
 */
export function CropOverlay({ rect, frame, aspect, onChange, frameRef }: CropOverlayProps) {
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const begin = (e: PointerEvent<HTMLElement>, mode: DragState['mode']) => {
    if (e.button !== 0 || !frameRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const box = frameRef.current.getBoundingClientRect();
    drag.current = { mode, startX: e.clientX, startY: e.clientY, start: rect, scale: frame.width / box.width, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = (e.clientX - d.startX) * d.scale;
    const dy = (e.clientY - d.startY) * d.scale;
    onChange(d.mode === 'move' ? moveRect(d.start, dx, dy, frame) : resizeRect(d.start, d.mode, dx, dy, frame, aspect));
  };

  const end = (e: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!dir) return;
    e.preventDefault();
    // One step ≈ 0.5% of the image's long side, so keyboard use scales with resolution.
    const unit = Math.max(1, Math.round(Math.max(frame.width, frame.height) / 200));
    const step = unit * (e.shiftKey ? 10 : 1);
    const [sx, sy] = dir as [number, number];
    const next = e.altKey
      ? resizeRect(rect, { right: true, bottom: true }, sx * step, sy * step, frame, aspect)
      : moveRect(rect, sx * step, sy * step, frame);
    onChange(next);
    setAnnouncement(`${e.altKey ? 'Crop size' : 'Crop position'}: ${next.left}, ${next.top}; ${formatDimensions(next.width, next.height)} pixels`);
  };

  const position = {
    left: pct(rect.left, frame.width),
    top: pct(rect.top, frame.height),
    width: pct(rect.width, frame.width),
    height: pct(rect.height, frame.height),
  };

  return (
    <>
      <div className="crop-mask" aria-hidden="true">
        <div className="crop-mask-hole" style={position} />
      </div>
      {/*
        ARIA has no 2-D positioning widget. role="application" makes screen readers
        switch to focus mode so the arrow keys reach this handler; instructions are
        linked via aria-describedby. jsx-a11y classes "application" as
        non-interactive, hence the two scoped suppressions.
      */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        className="crop-box"
        style={position}
        data-dragging={dragging}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="application"
        aria-roledescription="crop selection"
        aria-label={`Crop selection, ${formatDimensions(rect.width, rect.height)} pixels at ${rect.left}, ${rect.top}`}
        aria-describedby="crop-instructions"
        onPointerDown={(e) => begin(e, 'move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKeyDown}
      >
        <div className="crop-grid" />
        {HANDLES.map((h) => (
          <div
            key={h.id}
            className="crop-handle"
            data-edge={h.id}
            style={{ left: `${h.x}%`, top: `${h.y}%` }}
            aria-hidden="true"
            onPointerDown={(e) => begin(e, h.edges)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
        ))}
        {dragging ? <span className="crop-size-badge num">{formatDimensions(rect.width, rect.height)}</span> : null}
      </div>
      <p id="crop-instructions" className="visually-hidden">
        Use arrow keys to move the selection. Hold Shift for larger steps. Hold Alt with arrow keys to resize from the bottom-right corner.
        Exact values can be entered in the Crop panel.
      </p>
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

import type { Dispatch } from 'react';
import type { Capabilities, OutputFormat } from '../lib/api';
import { clampRect, ratioLabel, type FitMode, type Rect } from '../lib/geometry';
import { ASPECT_PRESETS, aspectRatioOf, frameOf, regionOf, type Action, type AspectId, type EditorState } from '../state';
import {
  FlipHIcon,
  FlipVIcon,
  LandscapeIcon,
  LinkIcon,
  PortraitIcon,
  ResetIcon,
  RotateCcwIcon,
  RotateCwIcon,
  UnlinkIcon,
} from './icons';
import { Checkbox, NumberField, Section, Segmented, Switch } from './ui';

interface PanelProps {
  state: EditorState;
  dispatch: Dispatch<Action>;
}

/* ----------------------------------------------------------- transform */

export function TransformSection({ state, dispatch }: PanelProps) {
  const changed = state.rotate !== 0 || state.flipH || state.flipV;
  return (
    <Section
      title="Transform"
      action={
        changed ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'resetTransform' })}>
            <ResetIcon size={14} />
            Reset
          </button>
        ) : null
      }
    >
      <div className="toolbar" role="toolbar" aria-label="Rotate and flip">
        <button type="button" className="icon-btn" aria-label="Rotate 90° counter-clockwise" title="Rotate left" onClick={() => dispatch({ type: 'rotate', direction: 'ccw' })}>
          <RotateCcwIcon />
        </button>
        <button type="button" className="icon-btn" aria-label="Rotate 90° clockwise" title="Rotate right" onClick={() => dispatch({ type: 'rotate', direction: 'cw' })}>
          <RotateCwIcon />
        </button>
        <button type="button" className="icon-btn" aria-label="Flip horizontally" title="Flip horizontal" aria-pressed={state.flipH} onClick={() => dispatch({ type: 'flip', axis: 'h' })}>
          <FlipHIcon />
        </button>
        <button type="button" className="icon-btn" aria-label="Flip vertically" title="Flip vertical" aria-pressed={state.flipV} onClick={() => dispatch({ type: 'flip', axis: 'v' })}>
          <FlipVIcon />
        </button>
        <span className="field-hint push-end num" aria-live="polite">
          {state.rotate}°
        </span>
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- crop */

export function CropSection({ state, dispatch }: PanelProps) {
  const frame = frameOf(state);
  const { rect, aspectId, portrait, enabled } = state.crop;
  const ratio = aspectRatioOf(state);
  const orientable = aspectId !== 'free' && aspectId !== 'original' && aspectId !== '1:1';

  const commit = (patch: Partial<Rect>, changed: 'x' | 'y' | 'w' | 'h') => {
    let next = { ...rect, ...patch };
    if (ratio !== null && changed === 'w') next.height = Math.round(next.width / ratio);
    if (ratio !== null && changed === 'h') next.width = Math.round(next.height * ratio);
    if (ratio !== null && (next.width > frame.width || next.height > frame.height)) {
      const s = Math.min(frame.width / next.width, frame.height / next.height);
      next = { ...next, width: Math.floor(next.width * s), height: Math.floor(next.height * s) };
    }
    dispatch({ type: 'cropRect', rect: clampRect(next, frame) });
  };

  return (
    <Section title="Crop" action={<Switch label="Enable crop" hideLabel checked={enabled} onChange={(v) => dispatch({ type: 'cropEnabled', enabled: v })} />}>
      {enabled ? (
        <>
          <Segmented<AspectId>
            legend="Aspect ratio"
            wrap
            value={aspectId}
            options={ASPECT_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            onChange={(id) => dispatch({ type: 'aspect', aspectId: id })}
          />
          {orientable ? (
            <div className="toolbar" role="group" aria-label="Crop orientation">
              <button type="button" className="icon-btn" aria-label="Landscape" title="Landscape" aria-pressed={!portrait} onClick={() => dispatch({ type: 'aspectOrientation', portrait: false })}>
                <LandscapeIcon />
              </button>
              <button type="button" className="icon-btn" aria-label="Portrait" title="Portrait" aria-pressed={portrait} onClick={() => dispatch({ type: 'aspectOrientation', portrait: true })}>
                <PortraitIcon />
              </button>
            </div>
          ) : null}
          <div className="grid-2">
            <NumberField label="X" value={rect.left} min={0} max={frame.width - rect.width} suffix="px" onCommit={(v) => commit({ left: v }, 'x')} />
            <NumberField label="Y" value={rect.top} min={0} max={frame.height - rect.height} suffix="px" onCommit={(v) => commit({ top: v }, 'y')} />
            <NumberField label="Width" value={rect.width} min={1} max={frame.width} suffix="px" onCommit={(v) => commit({ width: v }, 'w')} />
            <NumberField label="Height" value={rect.height} min={1} max={frame.height} suffix="px" onCommit={(v) => commit({ height: v }, 'h')} />
          </div>
          <p className="field-hint">
            Selection {ratioLabel(rect)}. Drag the box or handles, or focus the box and use the arrow keys (Shift = larger steps, Alt = resize).
          </p>
        </>
      ) : null}
    </Section>
  );
}

/* -------------------------------------------------------------- resize */

const FIT_OPTIONS: ReadonlyArray<{ value: FitMode; label: string; hint: string }> = [
  { value: 'cover', label: 'Cover', hint: 'Fills the exact size, trimming overflow.' },
  { value: 'contain', label: 'Contain', hint: 'Fits the whole image, padding with the background colour.' },
  { value: 'fill', label: 'Stretch', hint: 'Forces the exact size, distorting the aspect ratio.' },
  { value: 'inside', label: 'Fit within', hint: 'Keeps the aspect ratio; neither side exceeds the box.' },
];

export function ResizeSection({ state, dispatch, capabilities }: PanelProps & { capabilities: Capabilities }) {
  const r = state.resize;
  const region = regionOf(state);
  const maxDim = capabilities.maxOutputDimension;
  const fitHint = FIT_OPTIONS.find((f) => f.value === r.fit)?.hint;

  return (
    <Section title="Resize" action={<Switch label="Enable resize" hideLabel checked={r.enabled} onChange={(v) => dispatch({ type: 'resize', patch: { enabled: v } })} />}>
      {r.enabled ? (
        <>
          <Segmented<'pixels' | 'percent'>
            legend="Resize by"
            hideLegend
            value={r.mode}
            options={[
              { value: 'pixels', label: 'Pixels' },
              { value: 'percent', label: 'Percentage' },
            ]}
            onChange={(mode) => dispatch({ type: 'resize', patch: { mode } })}
          />
          {r.mode === 'pixels' ? (
            <>
              <div className="row">
                <NumberField label="Width" value={r.width} min={1} max={maxDim} suffix="px" onCommit={(v) => dispatch({ type: 'resizeDimension', dimension: 'width', value: v })} />
                <button
                  type="button"
                  className="icon-btn lock-btn"
                  aria-pressed={r.lock}
                  aria-label="Lock aspect ratio"
                  title={r.lock ? 'Aspect ratio locked' : 'Aspect ratio unlocked'}
                  onClick={() => dispatch({ type: 'resize', patch: { lock: !r.lock } })}
                >
                  {r.lock ? <LinkIcon /> : <UnlinkIcon />}
                </button>
                <NumberField label="Height" value={r.height} min={1} max={maxDim} suffix="px" onCommit={(v) => dispatch({ type: 'resizeDimension', dimension: 'height', value: v })} />
              </div>
              {!r.lock ? (
                <>
                  <div className="field">
                    <Segmented<FitMode>
                      legend="Fit"
                      value={r.fit}
                      options={FIT_OPTIONS.map((f) => ({ value: f.value, label: f.label }))}
                      onChange={(fit) => dispatch({ type: 'resize', patch: { fit } })}
                    />
                    <p className="field-hint">{fitHint}</p>
                  </div>
                  {r.fit === 'cover' ? (
                    <Segmented
                      legend="Keep in frame"
                      value={r.position}
                      options={[
                        { value: 'center', label: 'Centre' },
                        { value: 'attention', label: 'Subject', title: 'Focus on the most salient region (faces, skin, saturated colour)' },
                        { value: 'entropy', label: 'Detail', title: 'Keep the most detailed region' },
                      ]}
                      onChange={(position) => dispatch({ type: 'resize', patch: { position } })}
                    />
                  ) : null}
                </>
              ) : null}
              <Checkbox
                label="Don’t enlarge"
                description="Leave images that are already smaller than the target at their size."
                checked={r.withoutEnlargement}
                onChange={(v) => dispatch({ type: 'resize', patch: { withoutEnlargement: v } })}
              />
            </>
          ) : (
            <div className="field">
              <label className="field-label" htmlFor="resize-percent">
                Scale
              </label>
              <div className="range-row">
                <input
                  id="resize-percent"
                  className="range"
                  type="range"
                  min={1}
                  max={400}
                  value={r.percent}
                  aria-valuetext={`${r.percent} percent, ${Math.round((region.width * r.percent) / 100)} by ${Math.round((region.height * r.percent) / 100)} pixels`}
                  onChange={(e) => dispatch({ type: 'resize', patch: { percent: Number(e.target.value) } })}
                />
                <span className="range-value num" aria-hidden="true">
                  {r.percent}%
                </span>
              </div>
            </div>
          )}
        </>
      ) : null}
    </Section>
  );
}

/* -------------------------------------------------------------- output */

const FORMAT_OPTIONS: ReadonlyArray<{ value: 'original' | OutputFormat; label: string }> = [
  { value: 'original', label: 'Original' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WebP' },
  { value: 'avif', label: 'AVIF' },
];

/** Mirrors the server's resolution of `format: "original"`. */
export function effectiveFormat(state: EditorState): OutputFormat {
  const f = state.output.format;
  if (f !== 'original') return f;
  const t = state.source?.file.type ?? '';
  if (t === 'image/png') return 'png';
  if (t === 'image/webp') return 'webp';
  if (t === 'image/avif') return 'avif';
  if (t === 'image/gif') return 'png';
  return 'jpeg';
}

export function OutputSection({ state, dispatch, capabilities }: PanelProps & { capabilities: Capabilities }) {
  const o = state.output;
  const format = effectiveFormat(state);
  const lossless = format === 'png';
  const supportsAlpha = format !== 'jpeg';
  const set = (patch: Partial<EditorState['output']>) => dispatch({ type: 'output', patch });
  const unitMax = o.targetUnit === 'MB' ? Math.floor(capabilities.targetSize.maxBytes / 1024 / 1024) : 1024 * 100;
  const unitMin = o.targetUnit === 'MB' ? 1 : Math.ceil(capabilities.targetSize.minBytes / 1024);

  return (
    <Section title="Output">
      <Segmented legend="Format" value={o.format} options={FORMAT_OPTIONS} onChange={(format) => set({ format })} />

      <div className="field">
        <label className="field-label" htmlFor="quality">
          Quality
        </label>
        <div className="range-row">
          <input
            id="quality"
            className="range"
            type="range"
            min={1}
            max={100}
            value={o.quality}
            disabled={lossless}
            aria-describedby="quality-hint"
            onChange={(e) => set({ quality: Number(e.target.value) })}
          />
          <span className="range-value num" aria-hidden="true">
            {lossless ? '—' : o.quality}
          </span>
        </div>
        <p id="quality-hint" className="field-hint">
          {lossless
            ? 'PNG is lossless. A target size may reduce it to a colour palette.'
            : o.targetEnabled
              ? 'Upper limit — quality is lowered only as far as needed to meet the target.'
              : format === 'avif'
                ? 'AVIF looks good at lower values; 50–65 is typical.'
                : '75–85 balances size and fidelity for photos.'}
        </p>
      </div>

      <div className="field">
        <div className="section-head">
          <span className="field-label" id="target-label">
            Target file size
          </span>
          <Switch label="Limit file size" hideLabel checked={o.targetEnabled} onChange={(v) => set({ targetEnabled: v })} />
        </div>
        {o.targetEnabled ? (
          <div className="stack">
            <div className="row">
              <NumberField label="Maximum size" hideLabel value={o.targetValue} min={unitMin} max={unitMax} onCommit={(v) => set({ targetValue: v })} />
              <div className="field unit-field">
                <label htmlFor="target-unit" className="visually-hidden">
                  Unit
                </label>
                <select id="target-unit" className="select" value={o.targetUnit} onChange={(e) => set({ targetUnit: e.target.value as 'KB' | 'MB' })}>
                  <option value="KB">KB</option>
                  <option value="MB">MB</option>
                </select>
              </div>
            </div>
            <Checkbox
              label="Allow smaller dimensions"
              description="If quality alone can’t reach the target, scale the image down rather than over-compress it."
              checked={o.allowDownscale}
              onChange={(v) => set({ allowDownscale: v })}
            />
          </div>
        ) : null}
      </div>

      <div className="field">
        <span className="field-label" id="bg-label">
          Background
        </span>
        <div className="row row-center">
          <input
            type="color"
            className="color-input"
            aria-labelledby="bg-label"
            value={o.background}
            disabled={o.transparent && supportsAlpha}
            onChange={(e) => set({ background: e.target.value })}
          />
          <span className="num field-hint" aria-hidden="true">
            {o.transparent && supportsAlpha ? 'transparent' : o.background.toUpperCase()}
          </span>
          <span className="push-end">
            <Checkbox label="Transparent" checked={o.transparent && supportsAlpha} disabled={!supportsAlpha} onChange={(v) => set({ transparent: v })} />
          </span>
        </div>
        <p className="field-hint">
          {supportsAlpha ? 'Used for padding when the fit is “Contain”.' : 'JPEG has no transparency: transparent areas and padding use this colour.'}
        </p>
      </div>
    </Section>
  );
}

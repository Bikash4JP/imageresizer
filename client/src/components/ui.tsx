import { useId, useState, type ReactNode } from 'react';
import { AlertIcon } from './icons';

export function Section({ title, action, children, id }: { title: string; action?: ReactNode; children?: ReactNode; id?: string }) {
  const headingId = useId();
  return (
    <section className="section" aria-labelledby={headingId} id={id}>
      <div className="section-head">
        <h2 className="section-title" id={headingId}>
          {title}
        </h2>
        {action}
      </div>
      {children ? <div className="section-body">{children}</div> : null}
    </section>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  hint?: string;
  /** Visually hide the label (it is still announced). */
  hideLabel?: boolean;
}

/**
 * Numeric input that lets people type freely and only commits on blur/Enter,
 * clamping into range and explaining the range when input was out of bounds.
 */
export function NumberField({ label, value, onCommit, min, max, step = 1, suffix, disabled, hint, hideLabel }: NumberFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  // Re-sync the draft when the value changes from outside (e.g. dragging the crop box).
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setText(String(value));
  }

  const commit = () => {
    const parsed = Number(text);
    if (text.trim() === '' || !Number.isFinite(parsed)) {
      setText(String(value));
      setError(null);
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed / step) * step));
    setError(clamped !== parsed ? `Adjusted to the allowed range ${min.toLocaleString()}–${max.toLocaleString()}.` : null);
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field">
      <label htmlFor={id} className={hideLabel ? 'visually-hidden' : 'field-label'}>
        {label}
      </label>
      <div className="input-wrap">
        <input
          id={id}
          className={`input num${suffix ? ' has-suffix' : ''}`}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={text}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
        {suffix ? (
          <span className="input-suffix" aria-hidden="true">
            {suffix}
          </span>
        ) : null}
      </div>
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field-error" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface SegmentedProps<T extends string> {
  legend: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; disabled?: boolean; title?: string }>;
  onChange: (value: T) => void;
  hideLegend?: boolean;
  wrap?: boolean;
  disabled?: boolean;
}

/** A radio group styled as a segmented control; arrow keys move between options natively. */
export function Segmented<T extends string>({ legend, value, options, onChange, hideLegend, wrap, disabled }: SegmentedProps<T>) {
  const name = useId();
  return (
    <fieldset className="field fieldset" disabled={disabled}>
      <legend className={hideLegend ? 'visually-hidden' : 'field-label legend'}>{legend}</legend>
      <div className={`segmented${wrap ? ' wrap' : ''}`}>
        {options.map((o) => (
          <label key={o.value} className="segment" title={o.title}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Switch({ label, checked, onChange, disabled, hideLabel }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hideLabel?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true" />
      <span className={hideLabel ? 'visually-hidden' : undefined}>{label}</span>
    </label>
  );
}

export function Checkbox({ label, description, checked, onChange, disabled }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
}

export function ErrorAlert({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="alert alert-error" role="alert">
      <AlertIcon />
      <div className="alert-body">
        <p className="alert-title">{title}</p>
        {children}
      </div>
    </div>
  );
}

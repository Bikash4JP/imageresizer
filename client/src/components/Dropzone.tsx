import { useState, type DragEvent, type ReactNode } from 'react';
import type { Capabilities } from '../lib/api';
import { formatBytes } from '../lib/format';
import { UploadIcon } from './icons';

interface DropzoneProps {
  capabilities: Capabilities;
  onFile: (file: File) => void;
  onBrowse: () => void;
  busy: boolean;
  children?: ReactNode;
}

const FORMAT_LABELS: Record<string, string> = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', avif: 'AVIF', gif: 'GIF', tiff: 'TIFF' };

export function Dropzone({ capabilities, onFile, onBrowse, busy, children }: DropzoneProps) {
  const [active, setActive] = useState(false);
  const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.userAgent);
  const formats = capabilities.inputFormats.map((f) => FORMAT_LABELS[f] ?? f.toUpperCase());

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setActive(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };

  return (
    // Drag-and-drop is a pointer-only enhancement; keyboard and assistive-tech
    // users open files with the "Choose image" button or by pasting.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      className="dropzone"
      data-active={active}
      aria-labelledby="dropzone-title"
      onDragEnter={(e) => {
        e.preventDefault();
        setActive(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(false);
      }}
      onDrop={onDrop}
    >
      <div className="dropzone-inner">
        <div className="dropzone-icon" aria-hidden="true">
          <UploadIcon size={26} />
        </div>
        <h2 id="dropzone-title">Drop an image to get started</h2>
        <p>
          Resize, crop, rotate and convert with precise control — then compress to an exact file size.
        </p>
        <button type="button" className="btn btn-primary" onClick={onBrowse} disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : <UploadIcon size={16} />}
          {busy ? 'Opening…' : 'Choose image'}
        </button>
        <p className="dropzone-hint">
          or paste with <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd> + <kbd>V</kbd>
        </p>
        <p className="dropzone-hint">
          {formats.join(', ')} · up to {formatBytes(capabilities.maxUploadBytes)} · {Math.round(capabilities.maxInputPixels / 1_000_000)} MP
        </p>
        {children}
      </div>
    </section>
  );
}

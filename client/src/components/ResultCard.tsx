import { forwardRef } from 'react';
import type { ProcessResult } from '../lib/api';
import { formatBytes, formatDelta, formatDimensions } from '../lib/format';
import { AlertIcon, CheckIcon, DownloadIcon } from './icons';

export interface ResultView extends ProcessResult {
  url: string;
  optionsKey: string;
  targetBytes?: number | undefined;
}

interface ResultCardProps {
  result: ResultView;
  stale: boolean;
  onDismiss: () => void;
  onDownload?: () => void;
}

export const ResultCard = forwardRef<HTMLHeadingElement, ResultCardProps>(function ResultCard({ result, stale, onDismiss, onDownload }, headingRef) {
  const saved = result.input.bytes - result.bytes;
  return (
    <section className="card result" aria-labelledby="result-title">
      <div className="result-thumb">
        <img src={result.url} alt={`Processed result, ${formatDimensions(result.width, result.height)} pixels`} />
      </div>
      <div>
        <div className="result-head">
          <h2 className="result-title" id="result-title" ref={headingRef} tabIndex={-1}>
            Ready to download
          </h2>
          {result.targetMet === true ? (
            <span className="badge badge-success">
              <CheckIcon size={14} />
              Target met
            </span>
          ) : result.targetMet === false ? (
            <span className="badge badge-warning">
              <AlertIcon size={14} />
              Target not reachable
            </span>
          ) : null}
        </div>

        <dl className="stats">
          <div className="stat">
            <dt>Dimensions</dt>
            <dd>{formatDimensions(result.width, result.height)}</dd>
          </div>
          <div className="stat">
            <dt>File size</dt>
            <dd>
              {formatBytes(result.bytes)}
              <small>{formatDelta(result.input.bytes, result.bytes)}</small>
            </dd>
          </div>
          <div className="stat">
            <dt>Format</dt>
            <dd>
              {result.format.toUpperCase()}
              <small>{result.quality === null ? 'lossless' : `q${result.quality}`}</small>
            </dd>
          </div>
          <div className="stat">
            <dt>Processed in</dt>
            <dd>{(result.durationMs / 1000).toFixed(2)} s</dd>
          </div>
        </dl>

        {result.targetMet === false ? (
          <p className="stale-note" role="note">
            The smallest possible encoding is {formatBytes(result.bytes)}
            {result.targetBytes ? `, above the ${formatBytes(result.targetBytes)} target` : ''}. Allow smaller dimensions or choose AVIF/WebP to go further.
          </p>
        ) : result.downscaled ? (
          <p className="field-hint" role="note">
            Dimensions were reduced to meet the target size.
          </p>
        ) : saved > 0 ? (
          <p className="field-hint">Saved {formatBytes(saved)} compared with the original.</p>
        ) : null}

        {stale ? (
          <p className="stale-note" role="status">
            Settings have changed since this result was produced — process again to apply them.
          </p>
        ) : null}

        <div className="result-actions">
          <a className="btn btn-primary" href={result.url} download={result.filename} onClick={onDownload}>
            <DownloadIcon size={16} />
            Download {result.format.toUpperCase()} · {formatBytes(result.bytes)}
          </a>
          <button type="button" className="btn" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </section>
  );
});

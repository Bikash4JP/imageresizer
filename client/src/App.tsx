import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { CropSection, effectiveFormat, OutputSection, ResizeSection, TransformSection } from './components/Panels';
import { Dropzone } from './components/Dropzone';
import { FeedbackPrompt } from './components/FeedbackPrompt';
import { LogoIcon, MonitorIcon, MoonIcon, SunIcon } from './components/icons';
import { ResultCard, type ResultView } from './components/ResultCard';
import { ReviewWall } from './components/ReviewWall';
import { Stage } from './components/Stage';
import { ErrorAlert } from './components/ui';
import { useTheme } from './hooks/useTheme';
import { ApiError, DEFAULT_CAPABILITIES, fetchCapabilities, processImage, type Capabilities } from './lib/api';
import { shouldAskForFeedback } from './lib/feedbackApi';
import { formatBytes, formatDimensions, toBytes } from './lib/format';
import { loadSource, LoadError } from './lib/loadImage';
import { estimatedOutputOf, initialState, reducer, toProcessOptions } from './state';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/gif,image/tiff,.jpg,.jpeg,.png,.webp,.avif,.gif,.tif,.tiff';

type Job = { phase: 'uploading' | 'processing'; progress: number };

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [caps, setCaps] = useState<Capabilities>(DEFAULT_CAPABILITIES);
  const [apiDown, setApiDown] = useState(false);
  const [opening, setOpening] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<ResultView | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [askFeedback, setAskFeedback] = useState(false);
  const [reviewsVersion, setReviewsVersion] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const { theme, cycle } = useTheme();

  useEffect(() => {
    const ac = new AbortController();
    fetchCapabilities(ac.signal).then(
      (c) => {
        setCaps(c);
        setApiDown(false);
      },
      () => {
        if (!ac.signal.aborted) setApiDown(true);
      },
    );
    return () => ac.abort();
  }, []);

  // Object URLs pin decoded image memory until revoked.
  useEffect(() => {
    const url = state.source?.previewUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [state.source]);
  useEffect(() => {
    const url = result?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [result]);
  const openFile = useCallback(
    async (file: File) => {
      setLoadError(null);
      setError(null);
      setOpening(true);
      try {
        const source = await loadSource(file, caps);
        dispatch({ type: 'load', source });
        setResult(null);
        setAnnouncement(`Opened ${file.name}, ${source.width} by ${source.height} pixels.`);
      } catch (e) {
        setLoadError(e instanceof LoadError || e instanceof ApiError ? e.message : 'This file could not be opened.');
      } finally {
        setOpening(false);
      }
    },
    [caps],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      if (file) {
        e.preventDefault();
        void openFile(file);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [openFile]);

  const options = useMemo(() => (state.source ? toProcessOptions(state) : null), [state]);
  const optionsKey = options ? JSON.stringify(options) : '';
  const estimate = estimatedOutputOf(state);
  const format = effectiveFormat(state);

  const blocker = useMemo((): string | null => {
    if (!state.source) return null;
    if (estimate.width > caps.maxOutputDimension || estimate.height > caps.maxOutputDimension) {
      return `The output would be ${formatDimensions(estimate.width, estimate.height)} px; each side is limited to ${caps.maxOutputDimension.toLocaleString()} px.`;
    }
    if (estimate.width * estimate.height > caps.maxOutputPixels) {
      return `The output would exceed ${Math.round(caps.maxOutputPixels / 1_000_000)} megapixels.`;
    }
    if (state.output.targetEnabled) {
      const bytes = toBytes(state.output.targetValue, state.output.targetUnit);
      if (bytes < caps.targetSize.minBytes) return `The target size must be at least ${formatBytes(caps.targetSize.minBytes)}.`;
      if (bytes > caps.targetSize.maxBytes) return `The target size can be at most ${formatBytes(caps.targetSize.maxBytes)}.`;
    }
    return null;
  }, [state.source, state.output, estimate, caps]);

  const run = useCallback(async () => {
    if (!state.source || !options || job || blocker) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setError(null);
    setJob({ phase: 'uploading', progress: 0 });
    setAnnouncement('Uploading image…');
    try {
      const res = await processImage(state.source.file, options, {
        signal: ac.signal,
        onUploadProgress: (p) => setJob({ phase: 'uploading', progress: p }),
        onProcessing: () => {
          setJob({ phase: 'processing', progress: 1 });
          setAnnouncement('Processing on the server…');
        },
      });
      setResult({ ...res, url: URL.createObjectURL(res.blob), optionsKey, targetBytes: options.targetSizeBytes });
      setAnnouncement(
        `Done: ${res.format.toUpperCase()}, ${res.width} by ${res.height} pixels, ${formatBytes(res.bytes)}.${res.targetMet === false ? ' The target size could not be reached.' : ''}`,
      );
      requestAnimationFrame(() => resultHeading.current?.focus());
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setAnnouncement('Processing cancelled.');
      } else {
        setError(e instanceof ApiError ? e : new ApiError('Something went wrong while processing.', 0, 'unknown'));
      }
    } finally {
      abortRef.current = null;
      setJob(null);
    }
  }, [state.source, options, optionsKey, job, blocker]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void run();
      } else if (e.key === 'Escape' && abortRef.current) {
        abortRef.current.abort();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run]);

  const browse = () => fileInput.current?.click();
  const ThemeIcon = theme === 'light' ? SunIcon : theme === 'dark' ? MoonIcon : MonitorIcon;
  const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.userAgent);

  return (
    <>
      <a href="#editor" className="skip-link">
        Skip to editor
      </a>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <LogoIcon size={18} />
          </span>
          <span className="brand-name">Resizer</span>
          <span className="brand-tag">Precise image resizing &amp; compression</span>
        </div>
        <div className="header-actions">
          <button type="button" className="icon-btn plain" onClick={cycle} aria-label={`Colour theme: ${theme}. Switch theme`} title={`Theme: ${theme}`}>
            <ThemeIcon />
          </button>
        </div>
      </header>

      <main id="editor" tabIndex={-1}>
        <h1 className="visually-hidden">Image resizer</h1>
        <div className="workspace">
        <div className="main-column">
          {state.source ? (
            <Stage
              state={state}
              dispatch={dispatch}
              onReplace={browse}
              onRemove={() => {
                abortRef.current?.abort();
                dispatch({ type: 'clear' });
                setResult(null);
                setError(null);
                setAnnouncement('Image removed.');
              }}
            />
          ) : (
            <Dropzone capabilities={caps} onFile={(f) => void openFile(f)} onBrowse={browse} busy={opening} />
          )}
          {loadError ? <ErrorAlert title="Couldn’t open that file">{loadError}</ErrorAlert> : null}
          {result ? (
            <ResultCard
              ref={resultHeading}
              result={result}
              stale={result.optionsKey !== optionsKey}
              onDismiss={() => setResult(null)}
              onDownload={() => {
                if (!askFeedback && shouldAskForFeedback()) {
                  setAskFeedback(true);
                  setAnnouncement('Download started. If you have a moment, a short feedback form is below the result.');
                }
              }}
            />
          ) : null}
          {askFeedback ? (
            <FeedbackPrompt onClose={() => setAskFeedback(false)} onSubmitted={() => setReviewsVersion((v) => v + 1)} />
          ) : null}
        </div>

        <aside className="card panel" aria-label="Image settings">
          <div className="panel-body">
            <fieldset disabled={!state.source || job !== null}>
              <legend className="visually-hidden">Image settings</legend>
              <TransformSection state={state} dispatch={dispatch} />
              <CropSection state={state} dispatch={dispatch} />
              <ResizeSection state={state} dispatch={dispatch} capabilities={caps} />
              <OutputSection state={state} dispatch={dispatch} capabilities={caps} />
            </fieldset>
          </div>

          <div className="panel-footer">
            {state.source ? (
              <p className="summary">
                <span>Output</span>
                <strong className="num">
                  {formatDimensions(estimate.width, estimate.height)} px · {format.toUpperCase()}
                </strong>
              </p>
            ) : null}
            {apiDown ? (
              <ErrorAlert title="Processing server unreachable">
                <p>Check your connection. You can still prepare settings; processing will fail until the server responds.</p>
              </ErrorAlert>
            ) : null}
            {blocker ? (
              <div className="alert alert-warning" role="status">
                <div className="alert-body">{blocker}</div>
              </div>
            ) : null}
            {error ? (
              <ErrorAlert title={error.message}>
                {error.details?.length ? (
                  <ul>
                    {error.details.map((d) => (
                      <li key={d.path}>
                        <code>{d.path}</code>: {d.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {error.requestId ? <p className="field-hint">Reference: {error.requestId}</p> : null}
              </ErrorAlert>
            ) : null}
            {job ? (
              <div className="progress">
                <div className="summary">
                  <span id="progress-label">{job.phase === 'uploading' ? 'Uploading' : 'Processing'}</span>
                  {job.phase === 'uploading' ? <span className="num">{Math.round(job.progress * 100)}%</span> : null}
                </div>
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-labelledby="progress-label"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  {...(job.phase === 'uploading' ? { 'aria-valuenow': Math.round(job.progress * 100) } : {})}
                >
                  <div className="progress-fill" data-indeterminate={job.phase === 'processing'} style={{ width: `${Math.round(job.progress * 100)}%` }} />
                </div>
              </div>
            ) : null}
            {job ? (
              <button type="button" className="btn btn-block" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-block"
                disabled={!state.source || blocker !== null}
                onClick={() => void run()}
                aria-keyshortcuts={isMac ? 'Meta+Enter' : 'Control+Enter'}
              >
                Process image
              </button>
            )}
          </div>
        </aside>
        </div>
        <ReviewWall refreshKey={reviewsVersion} />
      </main>

      <footer className="app-footer">
        <p>
          Uploads are processed in memory on the server and deleted as soon as the response is sent. Metadata (EXIF, GPS) is stripped from every output.
        </p>
      </footer>

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void openFile(file);
        }}
      />
      <div className="visually-hidden" aria-live="polite" role="status">
        {announcement}
      </div>
    </>
  );
}

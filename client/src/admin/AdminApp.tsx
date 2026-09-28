import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LogoIcon, MonitorIcon, MoonIcon, SunIcon } from '../components/icons';
import { Stars } from '../components/Stars';
import { ErrorAlert, Segmented, Switch } from '../components/ui';
import { useTheme } from '../hooks/useTheme';
import { ApiError } from '../lib/api';
import {
  adminDelete,
  adminList,
  adminLogin,
  adminLogout,
  adminOverview,
  adminSession,
  adminSetStatus,
  adminUpdateSettings,
  relativeTime,
  type AdminFeedback,
  type AdminOverview,
  type FeedbackStatus,
} from '../lib/feedbackApi';

type Phase = 'checking' | 'signed-out' | 'signed-in' | 'unavailable';

const errorOf = (err: unknown) => (err instanceof ApiError ? err : new ApiError('Something went wrong.', 0, 'unknown'));

function useNoIndex() {
  useEffect(() => {
    document.title = 'Admin — Resizer';
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

export default function AdminApp() {
  useNoIndex();
  const { theme, cycle } = useTheme();
  const [phase, setPhase] = useState<Phase>('checking');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    adminSession().then(
      (s) => setPhase(s.authenticated ? 'signed-in' : 'signed-out'),
      (err: unknown) => setPhase(errorOf(err).status === 404 ? 'unavailable' : 'signed-out'),
    );
  }, []);

  const expired = useCallback(() => {
    setNotice('Your session has ended. Please sign in again.');
    setPhase('signed-out');
  }, []);

  const ThemeIcon = theme === 'light' ? SunIcon : theme === 'dark' ? MoonIcon : MonitorIcon;

  return (
    <>
      <a href="#admin-main" className="skip-link">
        Skip to content
      </a>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <LogoIcon size={18} />
          </span>
          <span className="brand-name">Resizer</span>
          <span className="brand-tag">Admin</span>
        </div>
        <div className="header-actions">
          <a className="btn btn-sm btn-ghost" href="/">
            Open site
          </a>
          {phase === 'signed-in' ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void adminLogout().finally(() => {
                  setNotice('You have signed out.');
                  setPhase('signed-out');
                });
              }}
            >
              Sign out
            </button>
          ) : null}
          <button type="button" className="icon-btn plain" onClick={cycle} aria-label={`Colour theme: ${theme}. Switch theme`}>
            <ThemeIcon />
          </button>
        </div>
      </header>
      <main id="admin-main" className="admin" tabIndex={-1}>
        {phase === 'checking' ? <p className="field-hint">Loading…</p> : null}
        {phase === 'unavailable' ? (
          <div className="card admin-card">
            <h1 className="admin-title">Admin area not enabled</h1>
            <p className="field-hint">
              Set <code>ADMIN_PASSWORD_HASH</code> and <code>ADMIN_SESSION_SECRET</code> on the server (see <code>server/.env.example</code>) and restart it.
            </p>
          </div>
        ) : null}
        {phase === 'signed-out' ? (
          <Login
            notice={notice}
            onSignedIn={() => {
              setNotice(null);
              setPhase('signed-in');
            }}
          />
        ) : null}
        {phase === 'signed-in' ? <Dashboard onExpired={expired} /> : null}
      </main>
    </>
  );
}

function Login({ notice, onSignedIn }: { notice: string | null; onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminLogin(password);
      setPassword('');
      onSignedIn();
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card admin-card admin-login" onSubmit={submit}>
      <h1 className="admin-title">Sign in</h1>
      <p className="field-hint">Manage reviews and what visitors see.</p>
      {notice ? (
        <p className="field-hint" role="status">
          {notice}
        </p>
      ) : null}
      <div className="field">
        <label className="field-label" htmlFor="admin-password">
          Password
        </label>
        <input
          id="admin-password"
          className="input"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error ? <ErrorAlert title={error.message} /> : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

const STATUS_LABEL: Record<FeedbackStatus, string> = { published: 'Published', pending: 'Pending review', hidden: 'Hidden' };

function Dashboard({ onExpired }: { onExpired: () => void }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [tab, setTab] = useState<FeedbackStatus>('published');
  const [items, setItems] = useState<AdminFeedback[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const guard = useCallback(
    (err: unknown) => {
      const e = errorOf(err);
      if (e.status === 401) onExpired();
      else setError(e);
    },
    [onExpired],
  );

  const refreshOverview = useCallback(() => adminOverview().then(setOverview, guard), [guard]);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  // First page of the selected tab. State is only set from the async callbacks.
  useEffect(() => {
    let current = true;
    adminList(tab).then(
      (page) => {
        if (!current) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setLoading(false);
      },
      (err: unknown) => {
        if (!current) return;
        guard(err);
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [tab, guard]);

  const selectTab = (next: FeedbackStatus) => {
    setTab(next);
    setItems([]);
    setCursor(undefined);
    setError(null);
    setLoading(true);
  };

  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await adminList(tab, cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      guard(err);
    } finally {
      setLoading(false);
    }
  };

  const act = async (item: AdminFeedback, action: FeedbackStatus | 'delete') => {
    if (action === 'delete' && !window.confirm('Delete this review permanently? Its rating will also be removed from the average.')) return;
    try {
      if (action === 'delete') await adminDelete(item.id);
      else await adminSetStatus(item.id, action);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setAnnouncement(action === 'delete' ? 'Review deleted.' : `Review moved to ${STATUS_LABEL[action]}.`);
      void refreshOverview();
    } catch (err) {
      guard(err);
    }
  };

  // Optimistic: the switch flips immediately and reverts if saving fails.
  const toggleWall = async (enabled: boolean) => {
    setOverview((o) => (o ? { ...o, settings: { ...o.settings, wallEnabled: enabled } } : o));
    try {
      const settings = await adminUpdateSettings(enabled);
      setOverview((o) => (o ? { ...o, settings } : o));
      setAnnouncement(enabled ? 'Reviews are now shown on the website.' : 'Reviews are now hidden from the website.');
    } catch (err) {
      setOverview((o) => (o ? { ...o, settings: { ...o.settings, wallEnabled: !enabled } } : o));
      guard(err);
    }
  };

  const counts = overview?.counts;

  return (
    <div className="admin-dashboard">
      <h1 className="admin-title">Reviews</h1>

      <div className="admin-stats">
        <div className="card admin-stat">
          <p className="stat-label">Average rating</p>
          <p className="admin-stat-value num">{overview ? overview.summary.average.toFixed(1) : '—'}</p>
          {overview ? <Stars value={overview.summary.average} size={16} /> : null}
        </div>
        <div className="card admin-stat">
          <p className="stat-label">Ratings</p>
          <p className="admin-stat-value num">{overview?.summary.count ?? '—'}</p>
        </div>
        <div className="card admin-stat">
          <p className="stat-label">Published</p>
          <p className="admin-stat-value num">{counts?.published ?? '—'}</p>
        </div>
        <div className="card admin-stat" data-attention={!!counts?.pending}>
          <p className="stat-label">Pending review</p>
          <p className="admin-stat-value num">{counts?.pending ?? '—'}</p>
        </div>
      </div>

      <div className="card admin-card admin-visibility">
        <div>
          <h2 className="admin-subtitle">Show reviews on the website</h2>
          <p className="field-hint">
            Turns the scrolling review section on or off for all visitors. Feedback is still collected while it is off.
          </p>
        </div>
        <Switch label="Show reviews on the website" hideLabel checked={overview?.settings.wallEnabled ?? true} disabled={!overview} onChange={(v) => void toggleWall(v)} />
      </div>

      <Segmented<FeedbackStatus>
        legend="Show reviews that are"
        value={tab}
        onChange={selectTab}
        options={(['published', 'pending', 'hidden'] as const).map((s) => ({
          value: s,
          label: `${STATUS_LABEL[s]}${counts ? ` (${counts[s]})` : ''}`,
        }))}
      />

      {error ? <ErrorAlert title={error.message} /> : null}

      <ul className="admin-list" aria-busy={loading}>
        {items.map((item) => (
          <li key={item.id} className="card admin-item">
            <div className="admin-item-head">
              <Stars value={item.rating} size={15} />
              <span className="field-hint">
                {item.name || 'Anonymous'} · <time dateTime={item.createdAt}>{relativeTime(item.createdAt)}</time>
              </span>
            </div>
            <p className="admin-item-text">{item.comment || <em className="field-hint">Rating only, no comment</em>}</p>
            <div className="admin-item-actions">
              {item.status !== 'published' ? (
                <button type="button" className="btn btn-sm" onClick={() => void act(item, 'published')}>
                  {item.status === 'pending' ? 'Approve' : 'Show'}
                </button>
              ) : null}
              {item.status !== 'hidden' ? (
                <button type="button" className="btn btn-sm" onClick={() => void act(item, 'hidden')}>
                  Hide
                </button>
              ) : null}
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void act(item, 'delete')}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!loading && items.length === 0 ? <p className="reviews-empty">No {STATUS_LABEL[tab].toLowerCase()} reviews.</p> : null}
      {cursor ? (
        <button type="button" className="btn" disabled={loading} onClick={() => void loadMore()}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}

      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

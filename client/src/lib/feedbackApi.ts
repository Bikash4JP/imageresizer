import { API_BASE, ApiError } from './api';

export type FeedbackStatus = 'published' | 'pending' | 'hidden';

export interface ReviewItem {
  id: string;
  rating: number;
  comment: string;
  name: string;
  createdAt: string;
}

export interface RatingSummary {
  average: number;
  count: number;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

export type PublicFeedback = { enabled: false } | { enabled: true; summary: RatingSummary; items: ReviewItem[] };

export interface AdminFeedback extends ReviewItem {
  status: FeedbackStatus;
  updatedAt: string;
}

export interface AdminOverview {
  settings: { wallEnabled: boolean };
  summary: RatingSummary;
  counts: Record<FeedbackStatus, number>;
}

async function problem(res: Response): Promise<ApiError> {
  try {
    const p = (await res.json()) as { title?: string; code?: string; errors?: ApiError['details']; requestId?: string };
    return new ApiError(p.title ?? `Request failed (${res.status}).`, res.status, p.code ?? 'error', p.errors, p.requestId);
  } catch {
    return new ApiError(`Request failed (${res.status}).`, res.status, 'error');
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: init.body ? { 'Content-Type': 'application/json', ...init.headers } : init.headers,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('Network error — check your connection and try again.', 0, 'network_error');
  }
  if (!res.ok) throw await problem(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const json = (body: unknown) => JSON.stringify(body);

// ---------------------------------------------------------------- public

export const getPublicFeedback = (signal?: AbortSignal) => call<PublicFeedback>('/feedback', { signal, cache: 'no-cache' });

export const submitFeedback = (input: { rating: number; comment: string; name: string; website: string }) =>
  call<{ received: true; status: FeedbackStatus }>('/feedback', { method: 'POST', body: json(input) });

// ----------------------------------------------------------------- admin

export const adminSession = () => call<{ authenticated: boolean }>('/admin/session', { cache: 'no-store' });
export const adminLogin = (password: string) => call<{ authenticated: true }>('/admin/login', { method: 'POST', body: json({ password }) });
export const adminLogout = () => call<{ authenticated: false }>('/admin/logout', { method: 'POST' });
export const adminOverview = () => call<AdminOverview>('/admin/overview', { cache: 'no-store' });

export const adminList = (status: FeedbackStatus, cursor?: string) =>
  call<{ items: AdminFeedback[]; nextCursor?: string }>(
    `/admin/feedback?${new URLSearchParams({ status, limit: '25', ...(cursor ? { cursor } : {}) })}`,
    { cache: 'no-store' },
  );

export const adminSetStatus = (id: string, status: FeedbackStatus) =>
  call<AdminFeedback>(`/admin/feedback/${encodeURIComponent(id)}`, { method: 'PATCH', body: json({ status }) });

export const adminDelete = (id: string) => call<void>(`/admin/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const adminUpdateSettings = (wallEnabled: boolean) =>
  call<{ wallEnabled: boolean }>('/admin/settings', { method: 'PUT', body: json({ wallEnabled }) });

// --------------------------------------------------------------- helpers

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, 'second');
}

export const RATING_LABELS = ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'] as const;

// -------------------------------------------------- "ask once" preference

const ASK_KEY = 'image-resizer:feedback';
const DAY = 86_400_000;

/** Whether to show the post-download prompt: not after a recent submission (30 d) or dismissal (7 d). */
export function shouldAskForFeedback(now = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(ASK_KEY);
    if (!raw) return true;
    const { at, kind } = JSON.parse(raw) as { at: number; kind: 'submitted' | 'dismissed' };
    return now - at > (kind === 'submitted' ? 30 : 7) * DAY;
  } catch {
    return true;
  }
}

export function rememberFeedback(kind: 'submitted' | 'dismissed', now = Date.now()): void {
  try {
    localStorage.setItem(ASK_KEY, JSON.stringify({ at: now, kind }));
  } catch {
    /* storage unavailable: we may ask again next time, which is harmless */
  }
}

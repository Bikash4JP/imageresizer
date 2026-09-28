export const FEEDBACK_STATUSES = ['published', 'pending', 'hidden'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export interface Feedback {
  /** Time-sortable: newer ids sort after older ones. */
  id: string;
  rating: number;
  comment: string;
  name: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RatingStats {
  count: number;
  sum: number;
  /** Count of ratings per star value 1–5. */
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

export interface SiteSettings {
  /** Master switch for the public review wall. */
  wallEnabled: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export const DEFAULT_SETTINGS: SiteSettings = { wallEnabled: true };

export const emptyStats = (): RatingStats => ({ count: 0, sum: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid pagination cursor');
    this.name = 'InvalidCursorError';
  }
}

/**
 * Persistence for feedback. Ratings statistics are maintained incrementally
 * (create adds, delete subtracts) so the public summary is O(1). Hiding an
 * item changes only its visibility, never the statistics.
 */
export interface FeedbackStore {
  init(): Promise<void>;
  create(item: Feedback): Promise<void>;
  get(id: string): Promise<Feedback | null>;
  /** Newest first. */
  list(status: FeedbackStatus, limit: number, cursor?: string): Promise<Page<Feedback>>;
  setStatus(id: string, status: FeedbackStatus, updatedAt: string): Promise<Feedback | null>;
  delete(id: string): Promise<boolean>;
  countByStatus(): Promise<Record<FeedbackStatus, number>>;
  stats(): Promise<RatingStats>;
  getSettings(): Promise<SiteSettings>;
  updateSettings(patch: Partial<SiteSettings>): Promise<SiteSettings>;
}

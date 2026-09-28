import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FEEDBACK_ID } from './sanitize.js';
import {
  DEFAULT_SETTINGS,
  emptyStats,
  InvalidCursorError,
  type Feedback,
  type FeedbackStatus,
  type FeedbackStore,
  type Page,
  type RatingStats,
  type SiteSettings,
} from './types.js';

type Star = keyof RatingStats['distribution'];
const star = (rating: number) => String(rating) as Star;

/** In-process store for tests (and the base of the file store). */
export class MemoryFeedbackStore implements FeedbackStore {
  protected items = new Map<string, Feedback>();
  protected ratingStats: RatingStats = emptyStats();
  protected settings: SiteSettings = { ...DEFAULT_SETTINGS };

  async init(): Promise<void> {}

  async create(item: Feedback): Promise<void> {
    if (this.items.has(item.id)) throw new Error('duplicate feedback id');
    this.items.set(item.id, { ...item });
    this.ratingStats.count += 1;
    this.ratingStats.sum += item.rating;
    this.ratingStats.distribution[star(item.rating)] += 1;
    await this.persist();
  }

  async get(id: string): Promise<Feedback | null> {
    const item = this.items.get(id);
    return item ? { ...item } : null;
  }

  async list(status: FeedbackStatus, limit: number, cursor?: string): Promise<Page<Feedback>> {
    if (cursor !== undefined && !FEEDBACK_ID.test(cursor)) throw new InvalidCursorError();
    const matching = [...this.items.values()]
      .filter((f) => f.status === status && (cursor === undefined || f.id < cursor))
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    const items = matching.slice(0, limit).map((f) => ({ ...f }));
    const last = items.at(-1);
    return matching.length > limit && last ? { items, nextCursor: last.id } : { items };
  }

  async setStatus(id: string, status: FeedbackStatus, updatedAt: string): Promise<Feedback | null> {
    const item = this.items.get(id);
    if (!item) return null;
    item.status = status;
    item.updatedAt = updatedAt;
    await this.persist();
    return { ...item };
  }

  async delete(id: string): Promise<boolean> {
    const item = this.items.get(id);
    if (!item) return false;
    this.items.delete(id);
    this.ratingStats.count -= 1;
    this.ratingStats.sum -= item.rating;
    this.ratingStats.distribution[star(item.rating)] -= 1;
    await this.persist();
    return true;
  }

  async countByStatus(): Promise<Record<FeedbackStatus, number>> {
    const counts: Record<FeedbackStatus, number> = { published: 0, pending: 0, hidden: 0 };
    for (const f of this.items.values()) counts[f.status] += 1;
    return counts;
  }

  async stats(): Promise<RatingStats> {
    return structuredClone(this.ratingStats);
  }

  async getSettings(): Promise<SiteSettings> {
    return { ...this.settings };
  }

  async updateSettings(patch: Partial<SiteSettings>): Promise<SiteSettings> {
    this.settings = { ...this.settings, ...patch };
    await this.persist();
    return { ...this.settings };
  }

  protected async persist(): Promise<void> {}
}

interface Snapshot {
  version: 1;
  items: Feedback[];
  stats: RatingStats;
  settings: SiteSettings;
}

/**
 * Local-development store: the memory store, snapshotted to a JSON file after
 * every change (atomic write via rename). Not for production — use DynamoDB.
 */
export class FileFeedbackStore extends MemoryFeedbackStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    super();
  }

  override async init(): Promise<void> {
    try {
      const snap = JSON.parse(await readFile(this.file, 'utf8')) as Snapshot;
      this.items = new Map(snap.items.map((f) => [f.id, f]));
      this.ratingStats = snap.stats;
      this.settings = { ...DEFAULT_SETTINGS, ...snap.settings };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  protected override persist(): Promise<void> {
    const snap: Snapshot = { version: 1, items: [...this.items.values()], stats: this.ratingStats, settings: this.settings };
    const data = JSON.stringify(snap, null, 2);
    // Serialise writes so snapshots land in order.
    this.writes = this.writes.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.writes;
  }
}

import { z } from 'zod';
import type { FeedbackConfig } from '../../config/env.js';
import type { Logger } from '../../lib/logger.js';
import { unprocessable } from '../../lib/errors.js';
import { DynamoFeedbackStore } from './dynamoStore.js';
import { FileFeedbackStore, MemoryFeedbackStore } from './memoryStore.js';
import { cleanText, needsReview, newFeedbackId } from './sanitize.js';
import type { Feedback, FeedbackStatus, FeedbackStore, RatingStats, SiteSettings } from './types.js';

export const COMMENT_MAX = 500;
export const NAME_MAX = 40;
const WALL_SIZE = 40;
const PUBLIC_CACHE_MS = 30_000;

const cleaned = (max: number) =>
  z
    .string()
    .max(max * 2) // raw bound before cleaning, so huge payloads are rejected cheaply
    .transform(cleanText)
    .refine((s) => s.length <= max, { message: `must be at most ${max} characters` });

export const submissionSchema = z.strictObject({
  rating: z.number().int().min(1).max(5),
  comment: cleaned(COMMENT_MAX).default(''),
  name: cleaned(NAME_MAX).default(''),
  /** Honeypot: invisible to people, filled in by naive bots. */
  website: z.string().max(200).optional(),
});

export type Submission = z.infer<typeof submissionSchema>;

export interface PublicItem {
  id: string;
  rating: number;
  comment: string;
  name: string;
  createdAt: string;
}

export interface PublicSummary {
  average: number;
  count: number;
  distribution: RatingStats['distribution'];
}

export type PublicFeedback = { enabled: false } | { enabled: true; summary: PublicSummary; items: PublicItem[] };

export function summarise(stats: RatingStats): PublicSummary {
  return {
    average: stats.count > 0 ? Math.round((stats.sum / stats.count) * 10) / 10 : 0,
    count: stats.count,
    distribution: stats.distribution,
  };
}

export class FeedbackService {
  private cache: { at: number; value: PublicFeedback } | undefined;

  constructor(
    readonly store: FeedbackStore,
    private readonly moderation: FeedbackConfig['moderation'],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Stores a submission. Returns `accepted: false` for honeypot hits: the bot
   * receives the same success response, so it learns nothing.
   */
  async submit(input: unknown): Promise<{ accepted: boolean; id?: string; status?: FeedbackStatus }> {
    const parsed = submissionSchema.safeParse(input);
    if (!parsed.success) {
      throw unprocessable(
        'validation_failed',
        'Please check your feedback and try again.',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const { rating, comment, name, website } = parsed.data;
    if (website) return { accepted: false };

    const status: FeedbackStatus =
      this.moderation === 'manual' || needsReview(`${comment} ${name}`) ? 'pending' : 'published';
    const now = this.clock();
    const item: Feedback = {
      id: newFeedbackId(now.getTime()),
      rating,
      comment,
      name,
      status,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.store.create(item);
    this.invalidate();
    return { accepted: true, id: item.id, status };
  }

  /** What the public site shows. Cached briefly so page views don't each hit the database. */
  async publicView(): Promise<PublicFeedback> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < PUBLIC_CACHE_MS) return this.cache.value;
    const settings = await this.store.getSettings();
    let value: PublicFeedback;
    if (!settings.wallEnabled) {
      value = { enabled: false };
    } else {
      const [stats, page] = await Promise.all([this.store.stats(), this.store.list('published', WALL_SIZE * 2)]);
      const items = page.items
        .filter((f) => f.comment.length > 0)
        .slice(0, WALL_SIZE)
        .map(({ id, rating, comment, name, createdAt }) => ({ id, rating, comment, name, createdAt }));
      value = { enabled: true, summary: summarise(stats), items };
    }
    this.cache = { at: now, value };
    return value;
  }

  async overview(): Promise<{ settings: SiteSettings; summary: PublicSummary; counts: Record<FeedbackStatus, number> }> {
    const [settings, stats, counts] = await Promise.all([this.store.getSettings(), this.store.stats(), this.store.countByStatus()]);
    return { settings, summary: summarise(stats), counts };
  }

  async setStatus(id: string, status: FeedbackStatus): Promise<Feedback | null> {
    const updated = await this.store.setStatus(id, status, this.clock().toISOString());
    this.invalidate();
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.store.delete(id);
    this.invalidate();
    return deleted;
  }

  async updateSettings(patch: Partial<SiteSettings>): Promise<SiteSettings> {
    const settings = await this.store.updateSettings(patch);
    this.invalidate();
    return settings;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

export async function createFeedbackService(config: FeedbackConfig, logger: Logger): Promise<FeedbackService> {
  const store: FeedbackStore =
    config.store === 'dynamodb'
      ? new DynamoFeedbackStore(config.table as string)
      : config.store === 'file'
        ? new FileFeedbackStore(config.file)
        : new MemoryFeedbackStore();
  await store.init();
  logger.info({ store: config.store, moderation: config.moderation }, 'feedback store ready');
  return new FeedbackService(store, config.moderation);
}

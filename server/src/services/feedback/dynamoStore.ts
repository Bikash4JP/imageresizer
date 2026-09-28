import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import {
  DEFAULT_SETTINGS,
  emptyStats,
  FEEDBACK_STATUSES,
  InvalidCursorError,
  type Feedback,
  type FeedbackStatus,
  type FeedbackStore,
  type Page,
  type RatingStats,
  type SiteSettings,
} from './types.js';

/**
 * Single-table DynamoDB layout (table `pk`/`sk`, GSI `gsi1` = `gsi1pk`/`gsi1sk`):
 *
 *   pk=FEEDBACK  sk=<id>        feedback item; gsi1pk=STATUS#<status>, gsi1sk=<id>
 *   pk=STATS     sk=RATINGS     count, sum, r1..r5 (maintained transactionally)
 *   pk=SETTINGS  sk=SITE        wallEnabled
 *
 * Listing by status is a GSI query, newest first because ids are time-sortable.
 * Feedback volume is small and write-rate-limited, so a single partition for
 * items is well within DynamoDB's per-partition throughput.
 */
const FEEDBACK_PK = 'FEEDBACK';
const STATS_KEY = { pk: 'STATS', sk: 'RATINGS' };
const SETTINGS_KEY = { pk: 'SETTINGS', sk: 'SITE' };
const GSI = 'gsi1';
const statusKey = (s: FeedbackStatus) => `STATUS#${s}`;

/** Picks only the public fields, so internal keys (pk/sk/gsi*) never leave the store. */
function toFeedback(item: Record<string, unknown>): Feedback {
  return {
    id: String(item.id),
    rating: Number(item.rating),
    comment: String(item.comment ?? ''),
    name: String(item.name ?? ''),
    status: item.status as FeedbackStatus,
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
}

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key)).toString('base64url') : undefined;
}

function decodeCursor(cursor: string | undefined, status: FeedbackStatus): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined;
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    const keys = Object.keys(key).sort().join(',');
    // Only accept exactly the key shape this query produces, for this status.
    if (keys !== 'gsi1pk,gsi1sk,pk,sk' || key.gsi1pk !== statusKey(status) || key.pk !== FEEDBACK_PK) throw new Error();
    if (Object.values(key).some((v) => typeof v !== 'string' || v.length > 64)) throw new Error();
    return key;
  } catch {
    throw new InvalidCursorError();
  }
}

export class DynamoFeedbackStore implements FeedbackStore {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async init(): Promise<void> {
    // Fail fast at boot if the table is unreachable or permissions are wrong.
    await this.doc.send(new GetCommand({ TableName: this.table, Key: SETTINGS_KEY }));
  }

  async create(item: Feedback): Promise<void> {
    const star = `r${item.rating}`;
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: { ...item, pk: FEEDBACK_PK, sk: item.id, gsi1pk: statusKey(item.status), gsi1sk: item.id },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: this.table,
              Key: STATS_KEY,
              UpdateExpression: 'ADD #count :one, #sum :rating, #star :one',
              ExpressionAttributeNames: { '#count': 'count', '#sum': 'sum', '#star': star },
              ExpressionAttributeValues: { ':one': 1, ':rating': item.rating },
            },
          },
        ],
      }),
    );
  }

  async get(id: string): Promise<Feedback | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: FEEDBACK_PK, sk: id } }));
    return res.Item ? toFeedback(res.Item) : null;
  }

  async list(status: FeedbackStatus, limit: number, cursor?: string): Promise<Page<Feedback>> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: GSI,
        KeyConditionExpression: 'gsi1pk = :p',
        ExpressionAttributeValues: { ':p': statusKey(status) },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: decodeCursor(cursor, status),
      }),
    );
    const items = (res.Items ?? []).map(toFeedback);
    const nextCursor = encodeCursor(res.LastEvaluatedKey);
    return nextCursor ? { items, nextCursor } : { items };
  }

  async setStatus(id: string, status: FeedbackStatus, updatedAt: string): Promise<Feedback | null> {
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: FEEDBACK_PK, sk: id },
          UpdateExpression: 'SET #status = :s, gsi1pk = :g, updatedAt = :u',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':s': status, ':g': statusKey(status), ':u': updatedAt },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return res.Attributes ? toFeedback(res.Attributes) : null;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.table,
                Key: { pk: FEEDBACK_PK, sk: id },
                ConditionExpression: 'attribute_exists(pk)',
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: STATS_KEY,
                UpdateExpression: 'ADD #count :minusOne, #sum :minusRating, #star :minusOne',
                ExpressionAttributeNames: { '#count': 'count', '#sum': 'sum', '#star': `r${existing.rating}` },
                ExpressionAttributeValues: { ':minusOne': -1, ':minusRating': -existing.rating },
              },
            },
          ],
        }),
      );
      return true;
    } catch (err) {
      // Lost a race with a concurrent delete: the condition on the item failed.
      if (err instanceof TransactionCanceledException) return false;
      throw err;
    }
  }

  async countByStatus(): Promise<Record<FeedbackStatus, number>> {
    const counts: Record<FeedbackStatus, number> = { published: 0, pending: 0, hidden: 0 };
    for (const status of FEEDBACK_STATUSES) {
      let start: Record<string, unknown> | undefined;
      do {
        const res: QueryCommandOutput = await this.doc.send(
          new QueryCommand({
            TableName: this.table,
            IndexName: GSI,
            KeyConditionExpression: 'gsi1pk = :p',
            ExpressionAttributeValues: { ':p': statusKey(status) },
            Select: 'COUNT',
            ExclusiveStartKey: start,
          }),
        );
        counts[status] += res.Count ?? 0;
        start = res.LastEvaluatedKey;
      } while (start);
    }
    return counts;
  }

  async stats(): Promise<RatingStats> {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: STATS_KEY }));
    const s = emptyStats();
    if (!res.Item) return s;
    const n = (k: string) => Number(res.Item?.[k] ?? 0);
    s.count = n('count');
    s.sum = n('sum');
    for (const k of ['1', '2', '3', '4', '5'] as const) s.distribution[k] = n(`r${k}`);
    return s;
  }

  async getSettings(): Promise<SiteSettings> {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: SETTINGS_KEY }));
    return { ...DEFAULT_SETTINGS, ...(res.Item ? { wallEnabled: res.Item.wallEnabled !== false } : {}) };
  }

  async updateSettings(patch: Partial<SiteSettings>): Promise<SiteSettings> {
    const next = { ...(await this.getSettings()), ...patch };
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...SETTINGS_KEY, ...next } }));
    return next;
  }
}

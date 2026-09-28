import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import {
  createSessionToken,
  hashPassword,
  readCookie,
  verifyPassword,
  verifySessionToken,
} from '../src/services/adminAuth.js';
import { DynamoFeedbackStore } from '../src/services/feedback/dynamoStore.js';
import { FileFeedbackStore, MemoryFeedbackStore } from '../src/services/feedback/memoryStore.js';
import { cleanText, FEEDBACK_ID, needsReview, newFeedbackId } from '../src/services/feedback/sanitize.js';
import { FeedbackService } from '../src/services/feedback/service.js';
import { InvalidCursorError, type Feedback, type FeedbackStore } from '../src/services/feedback/types.js';

const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT;

describe('text cleaning and screening', () => {
  it('strips invisible, bidi-override and control characters and collapses whitespace', () => {
    const cp = (...codes: number[]) => String.fromCodePoint(...codes);
    // zero-width space, right-to-left override, pop-directional-formatting
    const input = ['  Great', cp(0x200b), ' tool!', cp(0x202e), ' evil', cp(0x202c), ' ', cp(0x0a, 0x0a, 0x09), ' works  '].join('');
    expect(cleanText(input)).toBe('Great tool! evil works');
    // "e" + combining acute accent normalises to the single code point U+00E9.
    expect(cleanText('e' + cp(0x301))).toBe(cp(0xe9));
    expect(cleanText(['a', cp(0xfeff), 'b', cp(0x2066), 'c', cp(0x85), 'd'].join(''))).toBe('abcd');
    expect(cleanText(cp(0x00, 0x07) + 'bell')).toBe('bell');
  });

  it.each([
    ['visit https://spam.example now', true],
    ['check www.cheap-pills.biz', true],
    ['buy at pills.xyz', true],
    ['mail me: someone@example.com', true],
    ['call +61 400 123 456', true],
    ['Really fast and easy, 5 stars', false],
    ['Resized 3 photos in 10 seconds. Love the 16:9 crop!', false],
    ['Version 2.0 is great', false],
  ])('needsReview(%j) → %s', (text, expected) => {
    expect(needsReview(text)).toBe(expected);
  });

  it('generates time-sortable, well-formed ids', () => {
    const a = newFeedbackId(1_700_000_000_000);
    const b = newFeedbackId(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(FEEDBACK_ID.test(a)).toBe(true);
    expect(newFeedbackId(5)).not.toBe(newFeedbackId(5));
  });
});

describe('admin auth primitives', () => {
  let hash: string;
  beforeAll(async () => {
    hash = await hashPassword('correct horse battery');
  });

  it('hashes with scrypt in a shell-safe format and verifies', async () => {
    expect(hash).toMatch(/^scrypt:32768:8:1:[\w-]+:[\w-]+$/);
    expect(hash).not.toContain('$');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterY', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('correct horse battery')).not.toBe(hash);
  });

  it('rejects short passwords and malformed or weakened stored hashes', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 12/);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('correct horse battery', hash.replace(':32768:', ':1024:'))).toBe(false);
  });

  it('accepts only its config format', () => {
    const base = { NODE_ENV: 'test', ADMIN_SESSION_SECRET: 's'.repeat(32) };
    expect(loadConfig({ ...base, ADMIN_PASSWORD_HASH: hash }).admin).not.toBeNull();
    expect(() => loadConfig({ ...base, ADMIN_PASSWORD_HASH: 'plaintext-password' })).toThrow(/admin:hash-password/);
    expect(() => loadConfig({ NODE_ENV: 'test', ADMIN_PASSWORD_HASH: hash })).toThrow(/set both/);
    expect(loadConfig({ NODE_ENV: 'test' }).admin).toBeNull();
  });

  it('signs sessions and rejects tampering, other secrets and expiry', () => {
    const secret = 'k'.repeat(40);
    const now = 1_800_000_000_000;
    const token = createSessionToken(secret, 60_000, now);
    expect(verifySessionToken(token, secret, now + 59_000)).toBe(true);
    expect(verifySessionToken(token, secret, now + 61_000)).toBe(false);
    expect(verifySessionToken(token, 'o'.repeat(40), now)).toBe(false);
    const [v, exp, mac] = token.split('.') as [string, string, string];
    const extended = `${v}.${(parseInt(exp, 36) + 10_000_000).toString(36)}.${mac}`;
    expect(verifySessionToken(extended, secret, now)).toBe(false);
    expect(verifySessionToken(undefined, secret, now)).toBe(false);
    expect(verifySessionToken('garbage', secret, now)).toBe(false);
  });

  it('parses cookies', () => {
    expect(readCookie('a=1; ir_admin=tok.en; b=2', 'ir_admin')).toBe('tok.en');
    expect(readCookie('xir_admin=nope', 'ir_admin')).toBeUndefined();
    expect(readCookie(undefined, 'ir_admin')).toBeUndefined();
  });
});

function feedbackItem(overrides: Partial<Feedback> & { id: string }): Feedback {
  return {
    rating: 5,
    comment: 'Great',
    name: '',
    status: 'published',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

const ids = Array.from({ length: 7 }, (_, i) => newFeedbackId(1_800_000_000_000 + i * 1000));

/** One behavioural contract, run against every store implementation. */
function storeContract(name: string, make: () => Promise<FeedbackStore>, enabled = true) {
  describe.skipIf(!enabled)(`FeedbackStore contract: ${name}`, () => {
    let store: FeedbackStore;
    beforeEach(async () => {
      store = await make();
      await store.init();
    });

    it('creates, reads and rejects duplicate ids', async () => {
      await store.create(feedbackItem({ id: ids[0]!, comment: 'Hello', name: 'Asha' }));
      expect(await store.get(ids[0]!)).toMatchObject({ id: ids[0], comment: 'Hello', name: 'Asha', rating: 5 });
      expect(await store.get(ids[1]!)).toBeNull();
      await expect(store.create(feedbackItem({ id: ids[0]! }))).rejects.toThrow();
      // The failed duplicate must not have counted towards the statistics.
      expect((await store.stats()).count).toBe(1);
    });

    it('lists by status newest first, with cursor pagination', async () => {
      for (const id of ids.slice(0, 5)) await store.create(feedbackItem({ id }));
      await store.create(feedbackItem({ id: ids[5]!, status: 'pending' }));
      const first = await store.list('published', 2);
      expect(first.items.map((f) => f.id)).toEqual([ids[4], ids[3]]);
      expect(first.nextCursor).toBeTruthy();
      const second = await store.list('published', 2, first.nextCursor);
      expect(second.items.map((f) => f.id)).toEqual([ids[2], ids[1]]);
      const third = await store.list('published', 2, second.nextCursor);
      expect(third.items.map((f) => f.id)).toEqual([ids[0]]);
      expect(third.nextCursor).toBeUndefined();
      expect((await store.list('pending', 10)).items.map((f) => f.id)).toEqual([ids[5]]);
      expect((await store.list('hidden', 10)).items).toEqual([]);
    });

    it('rejects forged cursors', async () => {
      await expect(store.list('published', 2, 'bm90LWEtY3Vyc29y')).rejects.toBeInstanceOf(InvalidCursorError);
    });

    it('moves items between statuses without touching statistics', async () => {
      await store.create(feedbackItem({ id: ids[0]!, rating: 2 }));
      const updated = await store.setStatus(ids[0]!, 'hidden', '2026-09-29T00:00:00.000Z');
      expect(updated).toMatchObject({ status: 'hidden', updatedAt: '2026-09-29T00:00:00.000Z' });
      expect((await store.list('published', 10)).items).toEqual([]);
      expect((await store.list('hidden', 10)).items.map((f) => f.id)).toEqual([ids[0]]);
      expect(await store.countByStatus()).toEqual({ published: 0, pending: 0, hidden: 1 });
      expect((await store.stats()).count).toBe(1);
      expect(await store.setStatus(ids[6]!, 'hidden', 'x')).toBeNull();
    });

    it('maintains rating statistics across create and delete', async () => {
      await store.create(feedbackItem({ id: ids[0]!, rating: 5 }));
      await store.create(feedbackItem({ id: ids[1]!, rating: 4 }));
      await store.create(feedbackItem({ id: ids[2]!, rating: 1, status: 'hidden' }));
      expect(await store.stats()).toEqual({ count: 3, sum: 10, distribution: { 1: 1, 2: 0, 3: 0, 4: 1, 5: 1 } });
      expect(await store.delete(ids[2]!)).toBe(true);
      expect(await store.delete(ids[2]!)).toBe(false);
      expect(await store.stats()).toEqual({ count: 2, sum: 9, distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 } });
    });

    it('defaults and updates site settings', async () => {
      expect(await store.getSettings()).toEqual({ wallEnabled: true });
      expect(await store.updateSettings({ wallEnabled: false })).toEqual({ wallEnabled: false });
      expect(await store.getSettings()).toEqual({ wallEnabled: false });
    });
  });
}

storeContract('memory', async () => new MemoryFeedbackStore());

let scratch = '';
beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'ir-feedback-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});
let fileCounter = 0;
storeContract('file', async () => new FileFeedbackStore(path.join(scratch, `store-${fileCounter++}.json`)));

describe('FileFeedbackStore persistence', () => {
  it('survives a restart', async () => {
    const file = path.join(scratch, 'persist.json');
    const a = new FileFeedbackStore(file);
    await a.init();
    await a.create(feedbackItem({ id: ids[0]!, rating: 3, comment: 'Saved' }));
    await a.updateSettings({ wallEnabled: false });
    const b = new FileFeedbackStore(file);
    await b.init();
    expect(await b.get(ids[0]!)).toMatchObject({ comment: 'Saved' });
    expect((await b.stats()).sum).toBe(3);
    expect(await b.getSettings()).toEqual({ wallEnabled: false });
  });
});

// Real DynamoDB semantics (transactions, GSI queries, conditions) via DynamoDB Local:
//   docker run -d -p 127.0.0.1:8000:8000 amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -inMemory
//   DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm test -w server
const ddb = DYNAMODB_ENDPOINT
  ? new DynamoDBClient({
      endpoint: DYNAMODB_ENDPOINT,
      region: 'ap-southeast-2',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    })
  : undefined;
let tableCounter = 0;
const tables: string[] = [];

/** Mirrors the table defined in infra/aws/cloudformation (single-server.yaml / compute.yaml). */
async function createTable(client: DynamoDBClient, name: string) {
  await client.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
}

storeContract(
  'dynamodb (DynamoDB Local)',
  async () => {
    const name = `feedback-test-${process.pid}-${tableCounter++}`;
    await createTable(ddb!, name);
    tables.push(name);
    return new DynamoFeedbackStore(name, ddb);
  },
  !!ddb,
);

afterAll(async () => {
  for (const t of tables) await ddb?.send(new DeleteTableCommand({ TableName: t })).catch(() => undefined);
});

describe('FeedbackService', () => {
  let store: MemoryFeedbackStore;
  let t = 1_800_000_000_000;
  const clock = () => new Date((t += 1000));

  beforeEach(() => {
    store = new MemoryFeedbackStore();
  });

  it('publishes clean feedback immediately under auto moderation', async () => {
    const svc = new FeedbackService(store, 'auto', clock);
    const r = await svc.submit({ rating: 5, comment: '  Super   fast! ', name: 'Asha' });
    expect(r).toMatchObject({ accepted: true, status: 'published' });
    expect(await store.get(r.id!)).toMatchObject({ comment: 'Super fast!', name: 'Asha', rating: 5 });
  });

  it('holds comments with links or contact details for review, even under auto moderation', async () => {
    const svc = new FeedbackService(store, 'auto', clock);
    expect((await svc.submit({ rating: 5, comment: 'Best tool, see www.spam.biz' })).status).toBe('pending');
    expect((await svc.submit({ rating: 5, comment: 'ok', name: 'me@x.io' })).status).toBe('pending');
  });

  it('holds everything under manual moderation', async () => {
    const svc = new FeedbackService(store, 'manual', clock);
    expect((await svc.submit({ rating: 4, comment: 'Nice' })).status).toBe('pending');
  });

  it('silently drops honeypot submissions', async () => {
    const svc = new FeedbackService(store, 'auto', clock);
    expect(await svc.submit({ rating: 5, comment: 'hi', website: 'http://bot' })).toEqual({ accepted: false });
    expect((await store.stats()).count).toBe(0);
  });

  it.each([
    [{ rating: 0 }, 'rating'],
    [{ rating: 6 }, 'rating'],
    [{ rating: 4.5 }, 'rating'],
    [{ rating: '5' }, 'rating'],
    [{}, 'rating'],
    [{ rating: 5, comment: 'x'.repeat(501) }, 'comment'],
    [{ rating: 5, name: 'n'.repeat(41) }, 'name'],
    [{ rating: 5, extra: true }, ''],
  ])('rejects %j', async (input, pathPrefix) => {
    const svc = new FeedbackService(store, 'auto', clock);
    await expect(svc.submit(input)).rejects.toMatchObject({ status: 422, code: 'validation_failed' });
    await svc.submit(input).catch((err: { details: Array<{ path: string }> }) => {
      expect(err.details.some((d) => d.path.startsWith(pathPrefix))).toBe(true);
    });
  });

  it('allows rating-only feedback but keeps it off the wall', async () => {
    const svc = new FeedbackService(store, 'auto', clock);
    await svc.submit({ rating: 4 });
    const view = await svc.publicView();
    expect(view).toMatchObject({ enabled: true, summary: { count: 1, average: 4 } });
    expect(view.enabled && view.items).toEqual([]);
  });

  it('builds the public wall: published comments only, newest first, rounded average, no internal fields', async () => {
    const svc = new FeedbackService(store, 'auto', clock);
    await svc.submit({ rating: 5, comment: 'First' });
    await svc.submit({ rating: 4, comment: 'Second', name: 'Ben' });
    const held = await svc.submit({ rating: 1, comment: 'see spam.xyz' });
    const view = await svc.publicView();
    if (!view.enabled) throw new Error('expected enabled');
    expect(view.items.map((i) => i.comment)).toEqual(['Second', 'First']);
    expect(Object.keys(view.items[0]!).sort()).toEqual(['comment', 'createdAt', 'id', 'name', 'rating']);
    expect(view.summary).toMatchObject({ count: 3, average: 3.3 });

    // Moderation is reflected immediately (cache invalidated).
    await svc.setStatus(held.id!, 'published');
    const after = await svc.publicView();
    expect(after.enabled && after.items.map((i) => i.comment)).toEqual(['see spam.xyz', 'Second', 'First']);
  });

  it('hides the whole wall when disabled', async () => {
    const svc = new FeedbackService(store, 'auto', clock);
    await svc.submit({ rating: 5, comment: 'Hi' });
    await svc.updateSettings({ wallEnabled: false });
    expect(await svc.publicView()).toEqual({ enabled: false });
    await svc.updateSettings({ wallEnabled: true });
    expect((await svc.publicView()).enabled).toBe(true);
  });
});

describe('feedback configuration', () => {
  it('picks a store per environment and requires table + region for DynamoDB', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).feedback.store).toBe('memory');
    expect(loadConfig({ NODE_ENV: 'development' }).feedback.store).toBe('file');
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/FEEDBACK_TABLE[\s\S]*AWS_REGION/);
    const prod = loadConfig({ NODE_ENV: 'production', FEEDBACK_TABLE: 'image-resizer-feedback', AWS_REGION: 'ap-southeast-2' });
    expect(prod.feedback).toMatchObject({ store: 'dynamodb', table: 'image-resizer-feedback', moderation: 'auto' });
    expect(() => loadConfig({ FEEDBACK_TABLE: 'bad name!' })).toThrow(/FEEDBACK_TABLE/);
  });
});

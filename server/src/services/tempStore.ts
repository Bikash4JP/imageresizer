import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../lib/logger.js';

const PREFIX = 'req-';

/**
 * Per-request scratch directories for uploaded files.
 *
 * Deletion is layered so that no upload outlives its request:
 *  1. `release()` is called when the HTTP response closes (success, error or
 *     client abort).
 *  2. A janitor sweeps any workspace older than `maxAgeMs` — this covers
 *     crashes, or Windows file locks that made step 1 fail.
 *  3. `init()` purges the whole root on boot, clearing leftovers from a
 *     previous process that died mid-request.
 *
 * Processed output is never written here; it is encoded in memory and
 * streamed straight back to the client.
 */
export class TempStore {
  private janitor: NodeJS.Timeout | undefined;
  private readonly live = new Set<string>();

  constructor(
    readonly root: string,
    private readonly maxAgeMs: number,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const removed = await this.sweep(0);
    if (removed > 0) this.logger.warn({ removed }, 'purged stale temp workspaces from a previous run');
  }

  async createWorkspace(): Promise<string> {
    const dir = await mkdtemp(path.join(this.root, PREFIX));
    this.live.add(dir);
    return dir;
  }

  async release(dir: string): Promise<void> {
    // Guard against ever deleting something outside our root.
    if (path.dirname(dir) !== this.root || !path.basename(dir).startsWith(PREFIX)) {
      throw new Error('refusing to remove a path outside the temp root');
    }
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      this.live.delete(dir);
    } catch (err) {
      // Left for the janitor; the directory is still inside our private root.
      this.logger.warn({ err }, 'temp workspace removal deferred to janitor');
    }
  }

  get activeCount(): number {
    return this.live.size;
  }

  /** Deletes workspaces older than `olderThanMs`. Returns how many were removed. */
  async sweep(olderThanMs = this.maxAgeMs): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const name of entries) {
      if (!name.startsWith(PREFIX)) continue;
      const dir = path.join(this.root, name);
      try {
        const info = await stat(dir);
        if (olderThanMs > 0 && info.mtimeMs > cutoff) continue;
        await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        this.live.delete(dir);
        removed++;
      } catch (err) {
        this.logger.warn({ err }, 'janitor could not remove temp workspace');
      }
    }
    return removed;
  }

  startJanitor(intervalMs = Math.max(10_000, Math.floor(this.maxAgeMs / 2))): void {
    this.stopJanitor();
    this.janitor = setInterval(() => {
      this.sweep().then(
        (removed) => {
          if (removed > 0) this.logger.warn({ removed }, 'janitor removed expired temp workspaces');
        },
        (err: unknown) => this.logger.error({ err }, 'janitor sweep failed'),
      );
    }, intervalMs);
    this.janitor.unref();
  }

  stopJanitor(): void {
    if (this.janitor) clearInterval(this.janitor);
    this.janitor = undefined;
  }

  /** Removes every workspace; used on graceful shutdown. */
  async purgeAll(): Promise<void> {
    await this.sweep(0);
  }
}

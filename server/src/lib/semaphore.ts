import { HttpError } from './errors.js';

/**
 * Bounded-concurrency gate for CPU-heavy work. Image encoding saturates cores,
 * so running more jobs than `concurrency` only adds memory pressure; excess
 * jobs wait in a FIFO queue, and once the queue is full we shed load with 503
 * instead of letting latency and memory grow without bound.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly queueLimit: number,
  ) {}

  get stats() {
    return { active: this.active, queued: this.waiters.length, concurrency: this.concurrency };
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.queueLimit) {
      return Promise.reject(
        new HttpError(503, 'server_busy', 'The server is busy processing other images. Please retry shortly.', undefined, {
          'Retry-After': '5',
        }),
      );
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }
}

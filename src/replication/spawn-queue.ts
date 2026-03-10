/**
 * Spawn Queue — Sequential spawn scheduling with backpressure.
 *
 * Child spawns are long-running operations (4-7 minutes) that require coordination.
 * This queue ensures:
 * - Only one spawn executes at a time (prevents TOCTOU race on maxChildren checks)
 * - Pending spawns wait in strict order
 * - Backpressure rejection when queue exceeds maxQueueDepth
 *
 * Initialization: Must call initSpawnQueue() once at agent startup (in loop.ts)
 * before any spawn_child tool execution.
 */

import { createLogger } from "../observability/logger.js";

const logger = createLogger("spawn-queue");

export interface SpawnQueueConfig {
  /** Milliseconds to delay between completed and next pending spawn. Default: 5_000. */
  spawnStaggerMs: number;
  /** Maximum pending spawns before rejecting with backpressure. Default: 2. */
  maxQueueDepth: number;
}

const DEFAULT_CONFIG: SpawnQueueConfig = {
  spawnStaggerMs: 5_000,
  maxQueueDepth: 2,
};

/**
 * Sequential queue for child spawns.
 * Spawns execute one at a time with configurable stagger delay.
 */
export class SpawnQueue {
  private executing = false;
  private pending: Array<{
    fn: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];

  constructor(private readonly config: SpawnQueueConfig) {}

  /**
   * Enqueue a spawn operation.
   * Returns immediately if executing is false, otherwise queues and waits.
   * Throws if queue depth exceeds config.maxQueueDepth (backpressure).
   */
  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending.length >= this.config.maxQueueDepth) {
      throw new Error(
        `[SPAWN_QUEUE] Backpressure: ${this.pending.length} spawns already queued (max ${this.config.maxQueueDepth}). Try again later.`,
      );
    }
    if (!this.executing) {
      return this.execute(fn);
    }
    logger.info(
      `[SPAWN_QUEUE] Queuing spawn (${this.pending.length + 1} pending, stagger: ${this.config.spawnStaggerMs}ms)`,
    );
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
    });
  }

  /**
   * Execute a spawn immediately and drain the next pending spawn after stagger delay.
   */
  private async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.executing = true;
    try {
      return await fn();
    } finally {
      // Apply stagger delay before draining the next pending spawn
      if (this.config.spawnStaggerMs > 0 && this.pending.length > 0) {
        await new Promise((r) => setTimeout(r, this.config.spawnStaggerMs));
      }
      this.executing = false;
      this.drainNext();
    }
  }

  /**
   * If a spawn is pending and not currently executing, start the next spawn.
   */
  private drainNext(): void {
    if (this.pending.length > 0 && !this.executing) {
      const next = this.pending.shift()!;
      this.execute(next.fn).then(next.resolve, next.reject);
    }
  }

  /**
   * Queue statistics for monitoring/debugging.
   */
  get stats(): { executing: boolean; queued: number } {
    return { executing: this.executing, queued: this.pending.length };
  }
}

// Module-level singleton
let _queue: SpawnQueue | null = null;

/**
 * Initialize the spawn queue singleton.
 * Called once at agent startup (in loop.ts) with full config.
 * Must be called before any getSpawnQueue() call.
 */
export function initSpawnQueue(config?: Partial<SpawnQueueConfig>): SpawnQueue {
  _queue = new SpawnQueue({ ...DEFAULT_CONFIG, ...config });
  return _queue;
}

/**
 * Get the initialized spawn queue singleton.
 * Throws if initSpawnQueue() was not called first.
 */
export function getSpawnQueue(): SpawnQueue {
  if (!_queue) {
    throw new Error("[SPAWN_QUEUE] Not initialized. initSpawnQueue() must be called at startup.");
  }
  return _queue;
}

/**
 * Reset the singleton — for tests only.
 * Call in test teardown to ensure clean state between test cases.
 */
export function _resetSpawnQueue(): void {
  _queue = null;
}

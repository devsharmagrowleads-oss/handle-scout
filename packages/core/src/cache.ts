interface Entry<T> {
  value: T;
  expires: number;
}

/** Small in-memory TTL cache that also de-duplicates identical in-flight lookups. */
export class MemoryCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
  }

  /**
   * Return the cached value, join an identical lookup already in flight, or run `load`.
   * The result is stored only when `shouldCache` says so (unknown results are not kept).
   */
  async resolve(
    key: string,
    load: () => Promise<T>,
    shouldCache: (value: T) => boolean = () => true,
  ): Promise<{ value: T; cached: boolean }> {
    const hit = this.get(key);
    if (hit !== undefined) return { value: hit, cached: true };

    const pending = this.inflight.get(key);
    if (pending) return { value: await pending, cached: true };

    const promise = load();
    this.inflight.set(key, promise);
    try {
      const value = await promise;
      if (shouldCache(value)) this.set(key, value);
      return { value, cached: false };
    } finally {
      this.inflight.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

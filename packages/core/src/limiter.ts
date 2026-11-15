export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** A minimal promise pool: at most `max` tasks run at once, the rest queue in order. */
export function createLimiter(max: number): Limiter {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: (() => void)[] = [];

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      // The finishing task hands its slot straight to us, so `active` is not touched.
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      active++;
    }
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * Global limit plus a smaller per-host limit, so one slow or rate-limiting site
 * cannot be hammered while the overall run stays fast.
 */
export function createHostLimiter(globalMax: number, perHostMax: number) {
  const global = createLimiter(globalMax);
  const hosts = new Map<string, Limiter>();

  return function run<T>(host: string, task: () => Promise<T>): Promise<T> {
    let hostLimiter = hosts.get(host);
    if (!hostLimiter) {
      hostLimiter = createLimiter(perHostMax);
      hosts.set(host, hostLimiter);
    }
    return hostLimiter(() => global(task));
  };
}

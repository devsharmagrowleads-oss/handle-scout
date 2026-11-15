import type { FetchLike } from './types.js';

/**
 * A realistic, generic browser User-Agent. It deliberately carries no project
 * contact, e-mail address or anything else that identifies the person running it.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface HttpResponse {
  status: number;
  body: string;
  url: string;
  attempts: number;
}

export interface RequestOptions {
  fetch?: FetchLike;
  method?: 'GET' | 'HEAD' | 'POST';
  /** Request body (POST only). */
  body?: string;
  headers?: Record<string, string>;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Extra attempts after the first one. */
  retries?: number;
  /** Base delay for exponential backoff. */
  backoffMs?: number;
  userAgent?: string;
  /** Skip downloading the body when only the status code matters. */
  readBody?: boolean;
  maxBodyBytes?: number;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly code: 'timeout' | 'network' | 'aborted',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (received >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return out + decoder.decode();
}

/**
 * GET/HEAD/POST with a per-attempt timeout and retries (exponential backoff + jitter)
 * on network errors, timeouts, HTTP 429 and 5xx. If retries run out on a retryable
 * status, the last response is returned so the caller can report it honestly.
 */
export async function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  const {
    fetch: fetchImpl = globalThis.fetch as FetchLike,
    method = 'GET',
    body: requestBody,
    headers = {},
    timeoutMs = 10_000,
    retries = 2,
    backoffMs = 400,
    userAgent = DEFAULT_USER_AGENT,
    readBody = true,
    maxBodyBytes = 3_000_000,
    signal,
  } = options;

  let lastError: HttpError | undefined;
  let lastResponse: HttpResponse | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new HttpError('Check was cancelled', 'aborted');
    if (attempt > 0) {
      const delay = backoffMs * 2 ** (attempt - 1);
      await sleep(delay + Math.random() * delay * 0.25, signal);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetchImpl(url, {
        method,
        body: method === 'POST' ? requestBody : undefined,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...headers,
        },
      });
      let body = '';
      if (readBody && method !== 'HEAD') body = await readLimited(res, maxBodyBytes);
      else await res.body?.cancel().catch(() => undefined);

      lastResponse = { status: res.status, body, url: res.url || url, attempts: attempt + 1 };
      lastError = undefined;
      if (!RETRY_STATUSES.has(res.status)) return lastResponse;
    } catch (err) {
      if (signal?.aborted) throw new HttpError('Check was cancelled', 'aborted');
      lastError = timedOut
        ? new HttpError(`Timed out after ${timeoutMs} ms`, 'timeout')
        : new HttpError(`Network error: ${describe(err)}`, 'network');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  if (lastResponse && !lastError) return lastResponse;
  if (lastError) throw lastError;
  return lastResponse!;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ?? cause?.message ?? err.message;
  }
  return String(err);
}

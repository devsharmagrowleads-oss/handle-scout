import {
  MAX_INPUT_LENGTH,
  parseName,
  porkbunFromEnv,
  scout,
  toMarkdown,
  type Mode,
  type ScoutEvent,
} from '@handle-scout/core';

// Checks use node:dns and long-lived outbound requests, so this must run on Node, per request.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Events sent to the browser, one JSON object per line (NDJSON). */
export type StreamEvent = ScoutEvent | { type: 'export'; markdown: string } | { type: 'error'; message: string };

// Optional registrar confirmation. The key is read on the server only and is never sent
// to the browser. One instance per server process, so concurrent checks share batches.
const domainProvider = porkbunFromEnv();

// A deliberately small in-memory limiter. It protects a single instance from being used
// as a free scanning proxy; a public deployment should put a real limiter in front.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5_000) {
    for (const [k, times] of hits) if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  }
  return false;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const name = (params.get('name') ?? '').slice(0, MAX_INPUT_LENGTH + 1);
  const modeParam = params.get('mode') ?? 'auto';
  const onlyParam = params.get('only') ?? 'all';

  if (!['auto', 'personal', 'brand'].includes(modeParam)) {
    return json(400, { error: 'mode must be auto, personal or brand.' });
  }
  if (!['all', 'domains', 'socials'].includes(onlyParam)) {
    return json(400, { error: 'only must be all, domains or socials.' });
  }
  try {
    parseName(name);
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : 'Invalid name.' });
  }

  const client = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (rateLimited(client)) {
    return json(429, { error: 'Too many checks in a short time. Wait a minute and try again.' }, { 'Retry-After': '60' });
  }

  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort(), { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (event: StreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false; // the client went away
        }
      };

      scout(name, {
        mode: modeParam as Mode | 'auto',
        only: onlyParam === 'all' ? undefined : (onlyParam as 'domains' | 'socials'),
        domainProvider,
        onEvent: send,
        signal: abort.signal,
      })
        .then((report) => send({ type: 'export', markdown: toMarkdown(report) }))
        .catch((err: unknown) =>
          send({ type: 'error', message: err instanceof Error ? err.message : 'The check failed unexpectedly.' }),
        )
        .finally(() => {
          if (!open) return;
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

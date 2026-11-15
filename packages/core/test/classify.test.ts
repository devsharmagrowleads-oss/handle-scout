import { describe, expect, it } from 'vitest';
import {
  checkDomain,
  checkPlatform,
  classifyResponse,
  DEFAULT_USER_AGENT,
  getPlatform,
  matches,
  MemoryCache,
  parseBootstrap,
  rankSuggestions,
  request,
  scout,
  toMarkdown,
  type CheckResult,
  type FetchLike,
  type HttpDetect,
  type PlatformDefinition,
} from '../src/index.js';

/** Build a fake fetch from a function of the URL. Records every call. */
function mockFetch(handler: (url: string) => { status: number; body?: string } | Error) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const out = handler(url);
    if (out instanceof Error) throw out;
    // Statuses outside 200-599 (LinkedIn's 999) cannot be built with `new Response`.
    const res = new Response(out.body ?? '', { status: out.status > 599 ? 500 : out.status });
    if (out.status > 599) Object.defineProperty(res, 'status', { value: out.status });
    return res;
  };
  return { fetch, calls };
}

const fast = { retries: 0, backoffMs: 0, timeoutMs: 500 };

describe('matches / classifyResponse', () => {
  const detect: HttpDetect = {
    type: 'http',
    url: 'https://example.test/{handle}',
    taken: { status: 200, bodyIncludes: 'profile-card' },
    available: { status: [200, 404], bodyIncludes: 'not found', bodyExcludes: 'profile-card' },
  };

  it('requires every condition in a matcher', () => {
    expect(matches({ status: 200, bodyIncludes: ['a', 'b'] }, 200, 'a b')).toBe(true);
    expect(matches({ status: 200, bodyIncludes: ['a', 'b'] }, 200, 'a')).toBe(false);
    expect(matches({ status: 200, bodyExcludes: 'x' }, 200, 'x')).toBe(false);
    expect(matches({ status: [200, 204] }, 204, '')).toBe(true);
    expect(matches({}, 200, '')).toBe(false);
    expect(matches(undefined, 200, '')).toBe(false);
  });

  it('classifies taken and available', () => {
    expect(classifyResponse(detect, 200, '<div class="profile-card">').state).toBe('taken');
    expect(classifyResponse(detect, 404, 'user not found').state).toBe('available');
    expect(classifyResponse(detect, 200, 'user not found').state).toBe('available');
  });

  it('returns unknown, with a reason, for anything it does not recognise', () => {
    const blocked = classifyResponse(detect, 403, 'Just a moment...');
    expect(blocked.state).toBe('unknown');
    expect(blocked.reason).toMatch(/blocked.*403/);

    expect(classifyResponse(detect, 429, '').reason).toMatch(/Rate limited/);
    expect(classifyResponse(detect, 503, '').reason).toMatch(/server error/);
    expect(classifyResponse(detect, 999, '').reason).toMatch(/blocked.*999/);

    // A 200 that carries neither marker (a login wall, a redesign) must not be guessed.
    const wall = classifyResponse(detect, 200, '<title>Log in</title>');
    expect(wall.state).toBe('unknown');
    expect(wall.reason).toMatch(/Unrecognised/);
  });

  it('returns unknown when both signals match', () => {
    const sloppy: HttpDetect = { type: 'http', url: 'https://e.test/{handle}', taken: { status: 200 }, available: { status: 200 } };
    expect(classifyResponse(sloppy, 200, '').state).toBe('unknown');
  });

  it('never reports available for a taken-only detector', () => {
    const takenOnly: HttpDetect = { type: 'http', url: 'https://e.test/{handle}', taken: { status: 200 } };
    expect(classifyResponse(takenOnly, 200, '').state).toBe('taken');
    const other = classifyResponse(takenOnly, 404, '');
    expect(other.state).toBe('unknown');
    expect(other.reason).toMatch(/only lets us confirm "taken"/);
  });
});

describe('checkPlatform with mocked HTTP', () => {
  const github = getPlatform('github')!;

  it('reports taken / available from status codes with the platform confidence', async () => {
    const { fetch, calls } = mockFetch((url) => ({ status: url.endsWith('/google') ? 200 : 404 }));
    const taken = await checkPlatform(github, 'Google', { fetch, ...fast });
    expect(taken).toMatchObject({ state: 'taken', confidence: 'high', handle: 'google', url: 'https://github.com/google' });
    const free = await checkPlatform(github, 'zzfreehandle', { fetch, ...fast });
    expect(free).toMatchObject({ state: 'available', confidence: 'high', method: 'http' });
    expect(calls).toHaveLength(2);
  });

  it('sends a generic browser User-Agent with nothing personal in it', async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 404 }));
    await checkPlatform(github, 'someone', { fetch, ...fast });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(DEFAULT_USER_AGENT);
    expect(headers['User-Agent']).toMatch(/^Mozilla\/5\.0 .*Chrome\//);
    expect(headers['User-Agent']).not.toMatch(/@|handle-scout|https?:/i);
  });

  it('reports invalid without making a request', async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 200 }));
    const result = await checkPlatform(github, 'ram_sharma', { fetch, ...fast });
    expect(result.state).toBe('invalid');
    expect(result.confidence).toBeNull();
    expect(result.reason).toMatch(/hyphens/);
    expect(calls).toHaveLength(0);
  });

  it('reports unknown with a reason and link for manual-only platforms, without a request', async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 200 }));
    const result = await checkPlatform(getPlatform('instagram')!, 'ramsharma', { fetch, ...fast });
    expect(result).toMatchObject({
      state: 'unknown',
      confidence: null,
      method: 'manual',
      url: 'https://www.instagram.com/ramsharma/',
    });
    expect(result.reason).toMatch(/check by hand/);
    expect(calls).toHaveLength(0);
  });

  it('reports unknown when the site blocks the request', async () => {
    const { fetch } = mockFetch(() => ({ status: 403, body: 'Just a moment...' }));
    const result = await checkPlatform(github, 'someone', { fetch, ...fast });
    expect(result.state).toBe('unknown');
    expect(result.reason).toMatch(/HTTP 403/);
  });

  it('reports unknown on network failure instead of throwing', async () => {
    const { fetch } = mockFetch(() => new TypeError('fetch failed'));
    const result = await checkPlatform(github, 'someone', { fetch, ...fast });
    expect(result.state).toBe('unknown');
    expect(result.reason).toMatch(/Network error/);
  });

  it('uses body markers (Telegram) and the lower confidence for "available"', async () => {
    const telegram = getPlatform('telegram')!;
    const { fetch } = mockFetch((url) =>
      url.endsWith('/durov')
        ? { status: 200, body: '<div class="tgme_page_title">Pavel</div><a class="tgme_action_button_new">' }
        : { status: 200, body: '<a class="tgme_action_button_new">Send Message</a>' },
    );
    expect(await checkPlatform(telegram, 'durov', { fetch, ...fast })).toMatchObject({ state: 'taken', confidence: 'high' });
    expect(await checkPlatform(telegram, 'freename', { fetch, ...fast })).toMatchObject({
      state: 'available',
      confidence: 'low',
    });
  });

  it('LinkedIn: confirms taken, but a 999 wall is unknown, never available', async () => {
    const linkedin = getPlatform('linkedin')!;
    const { fetch } = mockFetch((url) =>
      url.endsWith('/taken-person') ? { status: 200, body: '{"@type":"Person"}' } : { status: 999, body: 'authwall' },
    );
    expect((await checkPlatform(linkedin, 'taken-person', { fetch, ...fast })).state).toBe('taken');
    const walled = await checkPlatform(linkedin, 'whoever', { fetch, ...fast });
    expect(walled.state).toBe('unknown');
    expect(walled.reason).toMatch(/999/);
  });
});

describe('request: retries, backoff and timeout', () => {
  it('retries 429 and succeeds', async () => {
    let n = 0;
    const { fetch, calls } = mockFetch(() => (++n < 3 ? { status: 429 } : { status: 200, body: 'ok' }));
    const res = await request('https://e.test/', { fetch, retries: 2, backoffMs: 1 });
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it('gives back the last response when retries run out', async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 503 }));
    const res = await request('https://e.test/', { fetch, retries: 1, backoffMs: 1 });
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a definitive answer', async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 404 }));
    await request('https://e.test/', { fetch, retries: 3, backoffMs: 1 });
    expect(calls).toHaveLength(1);
  });

  it('times out a hanging request', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    await expect(request('https://e.test/', { fetch, retries: 0, timeoutMs: 20 })).rejects.toThrow(/Timed out/);
  });
});

describe('domains', () => {
  const bootstrap = parseBootstrap({
    services: [
      [['com', 'net'], ['https://rdap.example.test/v1/']],
      [['dev'], ['http://insecure.test/', 'https://rdap.dev.test']],
    ],
  });

  it('parses the IANA bootstrap format', () => {
    expect(bootstrap.get('com')).toBe('https://rdap.example.test/v1/');
    expect(bootstrap.get('dev')).toBe('https://rdap.dev.test/');
    expect(bootstrap.get('io')).toBeUndefined();
    expect(parseBootstrap({ nope: true }).size).toBe(0);
  });

  it('RDAP 404 = available, 200 = taken, both high confidence', async () => {
    const { fetch, calls } = mockFetch((url) => ({ status: url.includes('google.com') ? 200 : 404 }));
    const taken = await checkDomain('google', 'com', { fetch, ...fast }, bootstrap);
    expect(taken).toMatchObject({ state: 'taken', confidence: 'high', method: 'rdap', handle: 'google.com' });
    const free = await checkDomain('zzfree', 'com', { fetch, ...fast }, bootstrap);
    expect(free).toMatchObject({ state: 'available', confidence: 'high', method: 'rdap' });
    expect(calls[0]!.url).toBe('https://rdap.example.test/v1/domain/google.com');
  });

  it('falls back to DNS with lower confidence when the TLD has no RDAP server', async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 200 }));
    const nx = Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    const free = await checkDomain('zzfree', 'io', { fetch, resolveNs: async () => Promise.reject(nx) }, bootstrap);
    expect(free).toMatchObject({ state: 'available', confidence: 'low', method: 'dns' });
    expect(free.reason).toMatch(/no public RDAP server/);

    const taken = await checkDomain('google', 'io', { fetch, resolveNs: async () => ['ns1.google.com'] }, bootstrap);
    expect(taken).toMatchObject({ state: 'taken', confidence: 'medium', method: 'dns' });

    const servfail = Object.assign(new Error('x'), { code: 'ESERVFAIL' });
    const unknown = await checkDomain('odd', 'io', { fetch, resolveNs: async () => Promise.reject(servfail) }, bootstrap);
    expect(unknown).toMatchObject({ state: 'unknown', confidence: null });
    expect(calls).toHaveLength(0);
  });

  it('falls back to DNS when RDAP itself misbehaves', async () => {
    const { fetch } = mockFetch(() => ({ status: 403 }));
    const result = await checkDomain('google', 'com', { fetch, resolveNs: async () => ['ns1.google.com'], ...fast }, bootstrap);
    expect(result).toMatchObject({ state: 'taken', confidence: 'medium', method: 'dns' });
    expect(result.reason).toMatch(/HTTP 403/);
  });

  it('rejects labels that cannot be a domain', async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 404 }));
    const result = await checkDomain('ram_sharma', 'com', { fetch }, bootstrap);
    expect(result.state).toBe('invalid');
    expect(calls).toHaveLength(0);
  });
});

describe('scout (end to end, mocked)', () => {
  const platforms: PlatformDefinition[] = [getPlatform('github')!, getPlatform('x')!, getPlatform('instagram')!];
  const bootstrap = parseBootstrap({ services: [[['com'], ['https://rdap.example.test/']]] });
  const takenHandles = new Set(['abcd', 'getabcd']);

  const world = () =>
    mockFetch((url) => {
      const handle = decodeURIComponent(url.split('/').pop()!).replace(/\.com$/, '');
      const taken = takenHandles.has(handle);
      if (url.startsWith('https://x.com/')) {
        return taken ? { status: 200, body: '<title>A (@a) / X</title>' } : { status: 404, body: 'Profile Not Found' };
      }
      return { status: taken ? 200 : 404 };
    });

  const options = (fetch: FetchLike) => ({
    fetch,
    platforms,
    bootstrap,
    tlds: ['com'],
    // Keep the suite offline: TLDs without RDAP in the fake bootstrap would hit real DNS.
    resolveNs: async () => Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })),
    cache: false as const,
    suggestionLimit: 3,
    ...fast,
  });

  it('produces the report, ranks suggestions by how many places are free, and streams events', async () => {
    const { fetch } = world();
    const events: string[] = [];
    const report = await scout('abcd', { ...options(fetch), onEvent: (e) => events.push(e.type) });

    expect(report.mode).toBe('brand');
    expect(report.domains.map((d) => [d.handle, d.state])).toEqual([['abcd.com', 'taken']]);
    expect(Object.fromEntries(report.platforms.map((p) => [p.id, p.state]))).toEqual({
      github: 'taken',
      x: 'taken',
      instagram: 'unknown',
    });
    expect(report.summary.platforms).toEqual({ available: 0, taken: 2, unknown: 1, invalid: 0 });

    // getabcd is taken everywhere, so it must sink below the free ones.
    expect(report.suggestions.map((s) => s.handle)).toEqual(['tryabcd', 'useabcd', 'getabcd']);
    expect(report.suggestions[0]).toMatchObject({ freeCount: 3, takenCount: 0, total: 3 });
    expect(report.suggestions[2]).toMatchObject({ freeCount: 0, takenCount: 3 });
    // Manual-only platforms are left out of the ranking instead of padding it with unknowns.
    expect(report.suggestions[0]!.results.map((r) => r.id)).toEqual(['com', 'github', 'x']);

    expect(events[0]).toBe('plan');
    expect(events.at(-1)).toBe('done');
    expect(events.filter((e) => e === 'result')).toHaveLength(4);
    expect(events).toContain('suggestions-plan');
    expect(events.filter((e) => e === 'suggestion-result')).toHaveLength(9);
  });

  it('skips suggestions when nothing is taken, and honours `only`', async () => {
    const { fetch } = world();
    const free = await scout('zzfreebrand', options(fetch));
    expect(free.suggestions).toEqual([]);

    const domainsOnly = await scout('abcd', { ...options(fetch), only: 'domains' });
    expect(domainsOnly.platforms).toEqual([]);
    expect(domainsOnly.domains).toHaveLength(1);

    const socialsOnly = await scout('abcd', { ...options(fetch), only: 'socials' });
    expect(socialsOnly.domains).toEqual([]);
    expect(socialsOnly.platforms).toHaveLength(3);
  });

  it('caches definitive answers but not unknown ones', async () => {
    const cache = new MemoryCache<CheckResult>();
    const { fetch, calls } = world();
    const run = () => scout('abcd', { ...options(fetch), cache, suggestions: 'never' });
    await run();
    const first = calls.length;
    const again = await run();
    expect(calls.length).toBe(first);
    expect(again.platforms.find((p) => p.id === 'github')!.cached).toBe(true);

    const blocked = mockFetch(() => ({ status: 403 }));
    const cache2 = new MemoryCache<CheckResult>();
    const opts = { ...options(blocked.fetch), cache: cache2, suggestions: 'never' as const, only: 'socials' as const };
    await scout('abcd', opts);
    await scout('abcd', opts);
    expect(blocked.calls.length).toBe(4);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const fetch: FetchLike = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response('', { status: 404 });
    };
    await scout('abcd', { ...options(fetch), suggestions: 'always', suggestionLimit: 6, concurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  it('renders Markdown with every section and the state labels', async () => {
    const { fetch } = world();
    const md = toMarkdown(await scout('abcd', options(fetch)));
    expect(md).toContain('# handle-scout report: abcd');
    expect(md).toContain('## Domains');
    expect(md).toContain('## Platforms');
    expect(md).toContain('## Suggestions');
    expect(md).toContain('Unknown - check by hand');
    expect(md).toContain('`tryabcd`');
    expect(md).toContain('https://www.instagram.com/abcd/');
  });
});

describe('rankSuggestions', () => {
  const r = (state: CheckResult['state']): CheckResult => ({
    kind: 'platform', id: 'p', name: 'P', handle: 'h', state, confidence: null, url: 'https://e.test', method: 'http', ms: 1,
  });

  it('orders by free count, then fewer taken, then original order', () => {
    const ranked = rankSuggestions([
      { suggestion: { handle: 'a', pattern: 'x' }, results: [r('available'), r('taken'), r('taken')] },
      { suggestion: { handle: 'b', pattern: 'x' }, results: [r('available'), r('available'), r('unknown')] },
      { suggestion: { handle: 'c', pattern: 'x' }, results: [r('available'), r('unknown'), r('unknown')] },
      { suggestion: { handle: 'd', pattern: 'x' }, results: [r('available'), r('unknown'), r('invalid')] },
    ]);
    expect(ranked.map((s) => s.handle)).toEqual(['b', 'c', 'd', 'a']);
    expect(ranked[0]).toMatchObject({ freeCount: 2, unknownCount: 1, total: 3 });
  });
});

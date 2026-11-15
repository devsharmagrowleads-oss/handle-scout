import { describe, expect, it } from 'vitest';
import {
  checkDomain,
  createPorkbunProvider,
  formatPrice,
  parseBootstrap,
  porkbunFromEnv,
  scout,
  toMarkdown,
  verifyPorkbunKeys,
  type DomainProvider,
  type FetchLike,
  type ProviderAnswer,
} from '../src/index.js';

const fast = { retries: 0, backoffMs: 0, timeoutMs: 500 };
const keys = { apiKey: 'pk1_test', secretKey: 'sk1_test' };
const bootstrap = parseBootstrap({ services: [[['com', 'dev'], ['https://rdap.test/']]] });

interface Call {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fake fetch that records calls and answers from a handler. */
function mockFetch(handler: (call: Call) => { status?: number; json?: unknown; text?: string } | Error) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const out = handler(call);
    if (out instanceof Error) throw out;
    return new Response(out.text ?? JSON.stringify(out.json ?? {}), { status: out.status ?? 200 });
  };
  return { fetch, calls };
}

const available = (price = '9.73', extra: Record<string, unknown> = {}) => ({
  avail: 'yes',
  type: 'registration',
  price,
  firstYearPromo: 'no',
  regularPrice: price,
  premium: 'no',
  additional: { renewal: { type: 'renewal', price, regularPrice: price } },
  ...extra,
});

describe('Porkbun provider', () => {
  it('sends one bulk call with header auth and reads every result list', async () => {
    const { fetch, calls } = mockFetch(() => ({
      json: {
        status: 'SUCCESS',
        checked: 2,
        domains: {
          'abcd.io': available('28.12'),
          'abcd.co': { avail: 'no', aftermarketSearch: '/aftermarket/search?query=abcd.co' },
        },
        unresolved: ['abcd.sh'],
        invalid: [{ domain: 'abcd.zzz', reason: 'unsupported TLD' }],
      },
    }));
    const provider = createPorkbunProvider({ ...keys, fetch, batchWindowMs: 1, retries: 0 });
    const [io, co, sh, zzz, missing] = await Promise.all(
      ['abcd.io', 'ABCD.co', 'abcd.sh', 'abcd.zzz', 'abcd.me'].map((d) => provider.check(d)),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.porkbun.com/api/json/v3/domain/checkDomain');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['X-API-Key']).toBe('pk1_test');
    expect(calls[0]!.headers['X-Secret-API-Key']).toBe('sk1_test');
    // Keys travel in headers only, never in the body.
    expect(calls[0]!.body).not.toContain('sk1_test');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ domains: ['abcd.io', 'abcd.co', 'abcd.sh', 'abcd.zzz', 'abcd.me'] });

    expect(io).toMatchObject({ status: 'available', price: { registration: '28.12', premium: false } });
    expect(co.status).toBe('taken');
    // "unresolved" is neither available nor taken.
    expect(sh.status).toBe('error');
    expect(zzz).toMatchObject({ status: 'unsupported' });
    expect(missing.status).toBe('unsupported');
  });

  it('splits more than 25 domains into several calls', async () => {
    const { fetch, calls } = mockFetch((call) => {
      const { domains } = JSON.parse(call.body!) as { domains: string[] };
      return { json: { status: 'SUCCESS', domains: Object.fromEntries(domains.map((d) => [d, available()])) } };
    });
    const provider = createPorkbunProvider({ ...keys, fetch, batchWindowMs: 1, retries: 0 });
    const names = Array.from({ length: 30 }, (_, i) => `name${i}.com`);
    const answers = await Promise.all(names.map((d) => provider.check(d)));
    expect(answers.every((a) => a.status === 'available')).toBe(true);
    expect(calls.map((c) => (JSON.parse(c.body!) as { domains: string[] }).domains.length)).toEqual([25, 5]);
  });

  it('reads promo, renewal and premium prices', async () => {
    const { fetch } = mockFetch(() => ({
      json: {
        status: 'SUCCESS',
        domains: {
          'abcd.xyz': available('1.50', {
            firstYearPromo: 'yes',
            regularPrice: '12.00',
            additional: { renewal: { price: '13.40' } },
          }),
          'gold.com': available('4200.00', { premium: 'yes' }),
        },
      },
    }));
    const provider = createPorkbunProvider({ ...keys, fetch, batchWindowMs: 1 });
    const [promo, premium] = await Promise.all([provider.check('abcd.xyz'), provider.check('gold.com')]);
    if (promo.status !== 'available' || premium.status !== 'available') throw new Error('expected available');
    expect(promo.price).toMatchObject({ registration: '1.50', regular: '12.00', renewal: '13.40', firstYearPromo: true });
    expect(formatPrice(promo.price)).toBe('$1.50 first year, then $13.40/yr');
    expect(formatPrice(premium.price)).toBe('premium, $4200.00/yr');
    expect(formatPrice(undefined)).toBe('');
  });

  it('explains a rejected key, a rate limit and a network failure without throwing', async () => {
    const check = async (handler: Parameters<typeof mockFetch>[0]) => {
      const { fetch } = mockFetch(handler);
      return createPorkbunProvider({ ...keys, fetch, batchWindowMs: 1, retries: 0 }).check('abcd.com');
    };
    const badKey = await check(() => ({ status: 400, json: { status: 'ERROR', code: 'INVALID_API_KEYS_001', message: 'Invalid API key.' } }));
    expect(badKey).toMatchObject({ status: 'error' });
    expect((badKey as { reason: string }).reason).toMatch(/rejected the API key.*PORKBUN_API_KEY/);

    const limited = await check(() => ({ status: 429, json: { status: 'ERROR', code: 'RATE_LIMIT_EXCEEDED', retryAfter: 42 } }));
    expect((limited as { reason: string }).reason).toMatch(/rate limit.*42 seconds/);

    const down = await check(() => new Error('connect ECONNREFUSED'));
    expect((down as { reason: string }).reason).toMatch(/could not be reached/);

    const garbage = await check(() => ({ status: 502, text: '<html>Bad gateway</html>' }));
    expect((garbage as { reason: string }).reason).toMatch(/unreadable response \(HTTP 502\)/);
  });

  it('is off unless both environment variables are set', () => {
    expect(porkbunFromEnv({})).toBeUndefined();
    expect(porkbunFromEnv({ PORKBUN_API_KEY: 'pk1_x' })).toBeUndefined();
    expect(porkbunFromEnv({ PORKBUN_API_KEY: '  ', PORKBUN_SECRET_API_KEY: 'sk1_x' })).toBeUndefined();
    expect(porkbunFromEnv({ PORKBUN_API_KEY: 'pk1_x', PORKBUN_SECRET_API_KEY: 'sk1_x' })?.id).toBe('porkbun');
  });

  it('verifies keys through /ping', async () => {
    const ok = mockFetch(() => ({ json: { status: 'SUCCESS', yourIp: '203.0.113.1', credentialsValid: true, scopes: ['read'] } }));
    expect(await verifyPorkbunKeys({ ...keys, fetch: ok.fetch })).toEqual({ ok: true, scopes: ['read'] });
    expect(ok.calls[0]!.url).toBe('https://api.porkbun.com/api/json/v3/ping');
    expect(ok.calls[0]!.headers['X-API-Key']).toBe('pk1_test');

    const bad = mockFetch(() => ({ status: 400, json: { status: 'ERROR', code: 'INVALID_API_KEYS_001' } }));
    expect(await verifyPorkbunKeys({ ...keys, fetch: bad.fetch })).toMatchObject({ ok: false });
  });
});

/** A provider that answers from a table and records what it was asked. */
function fakeProvider(table: Record<string, ProviderAnswer>) {
  const asked: string[] = [];
  const provider: DomainProvider = {
    id: 'fake',
    name: 'FakeRegistrar',
    async check(domain) {
      asked.push(domain);
      return table[domain] ?? { status: 'unsupported', reason: 'not sold here' };
    },
  };
  return { provider, asked };
}

describe('registrar confirmation of domain results', () => {
  const rdap = (status: number) => mockFetch(() => ({ status, text: '' })).fetch;
  const price = { currency: 'USD' as const, registration: '9.73', premium: false, firstYearPromo: false };

  it('does not spend quota on a domain the registry already shows as registered', async () => {
    const { provider, asked } = fakeProvider({});
    const result = await checkDomain('abcd', 'com', { ...fast, fetch: rdap(200), provider }, bootstrap);
    expect(result).toMatchObject({ state: 'taken', method: 'rdap', confidence: 'high' });
    expect(asked).toEqual([]);
  });

  it('adds the price when the registrar confirms an available domain', async () => {
    const { provider, asked } = fakeProvider({ 'abcd.com': { status: 'available', price } });
    const result = await checkDomain('abcd', 'com', { ...fast, fetch: rdap(404), provider }, bootstrap);
    expect(asked).toEqual(['abcd.com']);
    expect(result).toMatchObject({ state: 'available', confidence: 'high', method: 'registrar', provider: 'FakeRegistrar', price });
  });

  it('turns a low-confidence DNS "available" into a definite answer', async () => {
    const nxdomain = async () => {
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    };
    const free = fakeProvider({ 'abcd.io': { status: 'available', price } });
    const a = await checkDomain('abcd', 'io', { ...fast, resolveNs: nxdomain, provider: free.provider }, bootstrap);
    expect(a).toMatchObject({ state: 'available', confidence: 'high', method: 'registrar' });
    expect(a.reason).toBeUndefined();

    const held = fakeProvider({ 'abcd.io': { status: 'taken' } });
    const b = await checkDomain('abcd', 'io', { ...fast, resolveNs: nxdomain, provider: held.provider }, bootstrap);
    expect(b).toMatchObject({ state: 'taken', confidence: 'high', method: 'registrar' });
    expect(b.reason).toMatch(/reserved or blocked/);
  });

  it('keeps the free result and records why when the registrar cannot answer', async () => {
    const { provider } = fakeProvider({ 'abcd.com': { status: 'error', reason: 'Porkbun rejected the API key.' } });
    const result = await checkDomain('abcd', 'com', { ...fast, fetch: rdap(404), provider }, bootstrap);
    expect(result).toMatchObject({ state: 'available', method: 'rdap', providerError: 'Porkbun rejected the API key.' });
    expect(result.price).toBeUndefined();
  });

  it('summarises registrar use in the report and the Markdown export', async () => {
    const { provider } = fakeProvider({
      'abcd.com': { status: 'available', price },
      'abcd.dev': { status: 'error', reason: 'The registry did not answer.' },
    });
    const report = await scout('abcd', {
      ...fast,
      only: 'domains',
      tlds: ['com', 'dev'],
      suggestions: 'never',
      cache: false,
      bootstrap,
      fetch: rdap(404),
      domainProvider: provider,
    });
    expect(report.domainProvider).toEqual({
      id: 'fake',
      name: 'FakeRegistrar',
      confirmed: 1,
      failed: 1,
      error: 'The registry did not answer.',
    });
    const md = toMarkdown(report);
    expect(md).toContain('1 confirmed and priced by FakeRegistrar');
    expect(md).toContain('| Price |');
    expect(md).toContain('$9.73/yr');
  });

  it('leaves the report untouched when no registrar is configured', async () => {
    const report = await scout('abcd', {
      ...fast,
      only: 'domains',
      tlds: ['com'],
      suggestions: 'never',
      cache: false,
      bootstrap,
      fetch: rdap(404),
    });
    expect(report.domainProvider).toBeUndefined();
    expect(report.domains[0]).toMatchObject({ state: 'available', method: 'rdap' });
    expect(toMarkdown(report)).not.toContain('| Price |');
  });
});

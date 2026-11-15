import { Resolver } from 'node:dns/promises';
import { HttpError, request, type RequestOptions } from './http.js';
import type { CheckResult, DomainProvider, FetchLike, ProviderAnswer, ResolveNsLike } from './types.js';
import { validateDomainLabel } from './validate.js';

export const IANA_RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

export const DEFAULT_TLDS = [
  'com', 'net', 'org', 'io', 'co', 'ai', 'app', 'dev', 'in', 'xyz', 'me', 'so', 'sh', 'tech',
];

export type RdapBootstrap = Map<string, string>;

/** Parse the IANA bootstrap file into `tld -> RDAP base URL` (https preferred). */
export function parseBootstrap(json: unknown): RdapBootstrap {
  const map: RdapBootstrap = new Map();
  const services = (json as { services?: unknown })?.services;
  if (!Array.isArray(services)) return map;
  for (const service of services) {
    if (!Array.isArray(service) || service.length < 2) continue;
    const [tlds, urls] = service as [unknown, unknown];
    if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;
    const base = (urls as string[]).find((u) => u.startsWith('https://')) ?? (urls as string[])[0];
    if (!base) continue;
    for (const tld of tlds as string[]) {
      map.set(String(tld).toLowerCase(), base.endsWith('/') ? base : `${base}/`);
    }
  }
  return map;
}

export interface DomainCheckContext {
  fetch?: FetchLike;
  resolveNs?: ResolveNsLike;
  /** Optional registrar that confirms and prices the result. */
  provider?: DomainProvider;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  signal?: AbortSignal;
}

let bootstrapPromise: Promise<RdapBootstrap> | undefined;
let bootstrapLoadedAt = 0;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60_000;

/** Load (and memoise for a day) the IANA RDAP bootstrap. Resolves to an empty map on failure. */
export function loadBootstrap(ctx: DomainCheckContext = {}, force = false): Promise<RdapBootstrap> {
  const fresh = Date.now() - bootstrapLoadedAt < BOOTSTRAP_TTL_MS;
  if (bootstrapPromise && fresh && !force) return bootstrapPromise;
  bootstrapLoadedAt = Date.now();
  const promise = request(IANA_RDAP_BOOTSTRAP_URL, httpOptions(ctx))
    .then((res) => (res.status === 200 ? parseBootstrap(JSON.parse(res.body)) : new Map<string, string>()))
    .catch(() => new Map<string, string>())
    .then((map) => {
      // Do not keep an empty result around: try again on the next run.
      if (map.size === 0 && bootstrapPromise === promise) bootstrapPromise = undefined;
      return map;
    });
  bootstrapPromise = promise;
  return promise;
}

export function resetBootstrapCache(): void {
  bootstrapPromise = undefined;
  bootstrapLoadedAt = 0;
}

function httpOptions(ctx: DomainCheckContext): RequestOptions {
  return {
    fetch: ctx.fetch,
    timeoutMs: ctx.timeoutMs,
    retries: ctx.retries,
    backoffMs: ctx.backoffMs,
    signal: ctx.signal,
  };
}

let sharedResolver: Resolver | undefined;
const defaultResolveNs: ResolveNsLike = (hostname) => {
  sharedResolver ??= new Resolver({ timeout: 4000, tries: 2 });
  return sharedResolver.resolveNs(hostname);
};

const DNS_RETRIES = 2;

type Partial3 = Pick<CheckResult, 'state' | 'confidence' | 'reason' | 'method'>;

/**
 * DNS fallback, used when a TLD has no RDAP server (or RDAP failed).
 * NS records prove a delegation exists, so the name is registered. NXDOMAIN only
 * means "not in the zone": most likely free, but a registered-yet-undelegated or
 * reserved name looks identical, so that verdict is low confidence.
 */
export async function checkDomainViaDns(
  domain: string,
  resolveNs: ResolveNsLike = defaultResolveNs,
  why = 'This TLD has no public RDAP server',
): Promise<Partial3> {
  try {
    let records: string[] = [];
    // Resolvers occasionally answer SERVFAIL or time out for a name they resolve fine a
    // moment later, so retry anything that is not a definite answer.
    for (let attempt = 0; ; attempt++) {
      try {
        records = await resolveNs(domain);
        break;
      } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        if (code === 'ENOTFOUND' || code === 'ENODATA' || attempt >= DNS_RETRIES) throw err;
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    if (records.length > 0) {
      return {
        state: 'taken',
        confidence: 'medium',
        method: 'dns',
        reason: `${why}; DNS shows name servers for this domain, so it is registered.`,
      };
    }
    return {
      state: 'unknown',
      confidence: null,
      method: 'dns',
      reason: `${why}, and DNS gave an empty answer. Check with a registrar.`,
    };
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (code === 'ENOTFOUND') {
      return {
        state: 'available',
        confidence: 'low',
        method: 'dns',
        reason: `${why}; DNS has no record of this domain (NXDOMAIN). Probably free, but confirm with a registrar.`,
      };
    }
    return {
      state: 'unknown',
      confidence: null,
      method: 'dns',
      reason: `${why}, and the DNS lookup was inconclusive (${code || 'error'}). Check with a registrar.`,
    };
  }
}

export function registrarLookupUrl(domain: string): string {
  return `https://lookup.icann.org/en/lookup?name=${encodeURIComponent(domain)}`;
}

/**
 * Ask the registrar about a domain the free checks did not prove taken.
 *
 * A registry record (RDAP 200) or name servers already prove a registration, so
 * those are left alone and cost no API quota. Everything else is where a registrar
 * adds something: a definite answer for TLDs without RDAP, names the registry holds
 * back, and the price.
 */
export async function confirmWithProvider(
  base: CheckResult,
  provider: DomainProvider | undefined,
): Promise<CheckResult> {
  if (!provider || base.state === 'taken' || base.state === 'invalid') return base;
  let answer: ProviderAnswer;
  try {
    answer = await provider.check(base.handle);
  } catch (err) {
    answer = { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
  if (answer.status === 'available') {
    return {
      ...base,
      state: 'available',
      confidence: 'high',
      method: 'registrar',
      provider: provider.name,
      price: answer.price,
      reason: answer.price?.premium
        ? `${provider.name} lists this as a premium domain, priced well above the normal rate.`
        : undefined,
    };
  }
  if (answer.status === 'taken') {
    return {
      ...base,
      state: 'taken',
      confidence: 'high',
      method: 'registrar',
      provider: provider.name,
      reason:
        base.state === 'available'
          ? `The registry has no record of this name, but ${provider.name} reports it cannot be registered: it is reserved or blocked.`
          : answer.note,
    };
  }
  return { ...base, providerError: answer.reason };
}

/**
 * Check one domain: RDAP when the TLD has a server (404 = available), otherwise DNS.
 * With `ctx.provider` set, results that are not proven taken are confirmed by the registrar.
 */
export async function checkDomain(
  label: string,
  tld: string,
  ctx: DomainCheckContext = {},
  bootstrap?: RdapBootstrap,
): Promise<CheckResult> {
  const started = Date.now();
  const base = await checkDomainFree(label, tld, ctx, bootstrap);
  const result = await confirmWithProvider(base, ctx.provider);
  return result === base ? base : { ...result, ms: Date.now() - started };
}

/** The free check on its own: RDAP, then DNS. No API key involved. */
export async function checkDomainFree(
  label: string,
  tld: string,
  ctx: DomainCheckContext = {},
  bootstrap?: RdapBootstrap,
): Promise<CheckResult> {
  const started = Date.now();
  const cleanTld = tld.toLowerCase().replace(/^\./, '');
  const domain = `${label.toLowerCase()}.${cleanTld}`;
  const base = {
    kind: 'domain' as const,
    id: cleanTld,
    name: `.${cleanTld}`,
    handle: domain,
    url: registrarLookupUrl(domain),
  };
  const finish = (part: Partial3): CheckResult => ({ ...base, ...part, ms: Date.now() - started });

  const validity = validateDomainLabel(label);
  if (!validity.valid) {
    return finish({ state: 'invalid', confidence: null, method: 'rules', reason: validity.reason });
  }

  const map = bootstrap ?? (await loadBootstrap(ctx));
  const rdapBase = map.get(cleanTld);
  if (!rdapBase) {
    const why = map.size === 0 ? 'The RDAP server list could not be loaded' : 'This TLD has no public RDAP server';
    return finish(await checkDomainViaDns(domain, ctx.resolveNs, why));
  }

  try {
    const res = await request(`${rdapBase}domain/${domain}`, {
      ...httpOptions(ctx),
      headers: { Accept: 'application/rdap+json, application/json;q=0.9' },
      readBody: false,
    });
    if (res.status === 200) return finish({ state: 'taken', confidence: 'high', method: 'rdap' });
    if (res.status === 404) return finish({ state: 'available', confidence: 'high', method: 'rdap' });
    return finish(
      await checkDomainViaDns(domain, ctx.resolveNs, `The registry's RDAP server answered HTTP ${res.status}`),
    );
  } catch (err) {
    if (err instanceof HttpError && err.code === 'aborted') {
      return finish({ state: 'unknown', confidence: null, method: 'rdap', reason: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return finish(await checkDomainViaDns(domain, ctx.resolveNs, `The registry's RDAP lookup failed (${message})`));
  }
}

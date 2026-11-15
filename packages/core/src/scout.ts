import { MemoryCache } from './cache.js';
import { classifyResponse, detectNeedsBody } from './classify.js';
import { checkDomain, DEFAULT_TLDS, loadBootstrap, type RdapBootstrap } from './domains.js';
import { HttpError, request } from './http.js';
import { createHostLimiter } from './limiter.js';
import { parseName } from './names.js';
import { fillTemplate, PLATFORMS } from './platforms.js';
import { generateSuggestions } from './suggest.js';
import type {
  CheckResult,
  DomainProvider,
  FetchLike,
  Mode,
  PlatformDefinition,
  RankedSuggestion,
  Report,
  ResolveNsLike,
  ScoutEvent,
  Suggestion,
  Summary,
} from './types.js';
import { validateHandle } from './validate.js';

export interface ScoutOptions {
  /** `auto` (default) picks `personal` when the input has spaces, otherwise `brand`. */
  mode?: Mode | 'auto';
  /** Restrict the run to domains or to platforms. */
  only?: 'domains' | 'socials';
  tlds?: string[];
  /** Platform definitions to use (defaults to the built-in list). */
  platforms?: PlatformDefinition[];
  /** Generate and rank alternatives. Default: only when something is taken. */
  suggestions?: 'auto' | 'always' | 'never';
  /** How many suggestions are re-checked across platforms and ranked. */
  suggestionLimit?: number;
  /** TLDs each ranked suggestion is checked against. */
  suggestionTlds?: string[];
  /** Rank suggestions across `core` platforms (default) or every automated one. */
  rankAcross?: 'core' | 'all';
  /** Max simultaneous requests overall. */
  concurrency?: number;
  /** Max simultaneous requests to one host. */
  perHostConcurrency?: number;
  /** Per-attempt timeout for each check. */
  timeoutMs?: number;
  /** Extra attempts after a network error, timeout, HTTP 429 or 5xx. */
  retries?: number;
  backoffMs?: number;
  userAgent?: string;
  /** Pass `false` to disable caching, or your own cache to share between runs. */
  cache?: MemoryCache<CheckResult> | false;
  fetch?: FetchLike;
  resolveNs?: ResolveNsLike;
  /**
   * Optional registrar (see `porkbunFromEnv`) that confirms domain results and adds
   * prices. Needs the user's own API key. Without it, RDAP and DNS are used alone.
   */
  domainProvider?: DomainProvider;
  /** Pre-loaded RDAP bootstrap (mainly for tests). */
  bootstrap?: RdapBootstrap;
  /** Called as each check finishes, so UIs can stream results. */
  onEvent?: (event: ScoutEvent) => void;
  signal?: AbortSignal;
}

/** Process-wide cache used when the caller does not supply one. */
export const defaultCache = new MemoryCache<CheckResult>();

interface Runtime {
  options: ScoutOptions;
  limit: ReturnType<typeof createHostLimiter>;
  cache: MemoryCache<CheckResult> | null;
  bootstrap: Promise<RdapBootstrap>;
}

const isDefinitive = (result: CheckResult) => result.state === 'available' || result.state === 'taken';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Check one handle on one platform. Never throws: failures become `unknown` with a reason. */
export async function checkPlatform(
  platform: PlatformDefinition,
  handle: string,
  options: Pick<ScoutOptions, 'fetch' | 'timeoutMs' | 'retries' | 'backoffMs' | 'userAgent' | 'signal'> = {},
): Promise<CheckResult> {
  const started = Date.now();
  const lower = handle.toLowerCase();
  const base = {
    kind: 'platform' as const,
    id: platform.id,
    name: platform.name,
    handle: lower,
    url: fillTemplate(platform.profileUrl, lower),
    category: platform.category,
  };
  const done = (part: Pick<CheckResult, 'state' | 'confidence' | 'method' | 'reason'>): CheckResult => ({
    ...base,
    ...part,
    ms: Date.now() - started,
  });

  const validity = validateHandle(platform.rules, lower);
  if (!validity.valid) {
    return done({ state: 'invalid', confidence: null, method: 'rules', reason: validity.reason });
  }

  const detect = platform.detect;
  if (detect.type === 'manual') {
    return done({
      state: 'unknown',
      confidence: null,
      method: 'manual',
      reason: `${detect.reason} Open the link to check by hand.`,
    });
  }

  try {
    const res = await request(fillTemplate(detect.url, lower), {
      fetch: options.fetch,
      method: detect.method,
      headers: detect.headers,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      backoffMs: options.backoffMs,
      userAgent: options.userAgent,
      signal: options.signal,
      readBody: detectNeedsBody(detect),
    });
    const verdict = classifyResponse(detect, res.status, res.body);
    if (verdict.state === 'unknown') {
      return done({
        state: 'unknown',
        confidence: null,
        method: 'http',
        reason: `${verdict.reason} Open the link to check by hand.`,
      });
    }
    const confidence =
      verdict.state === 'available' ? (platform.availableConfidence ?? platform.confidence) : platform.confidence;
    return done({ state: verdict.state, confidence, method: 'http', reason: platform.note });
  } catch (err) {
    const message = err instanceof HttpError ? err.message : `Check failed: ${String(err)}`;
    return done({
      state: 'unknown',
      confidence: null,
      method: 'http',
      reason: `${message}. Open the link to check by hand.`,
    });
  }
}

function runPlatform(rt: Runtime, platform: PlatformDefinition, handle: string): Promise<CheckResult> {
  const { options, cache } = rt;
  const lower = handle.toLowerCase();
  const detect = platform.detect;
  // Rule violations and manual-only platforms need no network, so skip the queue and cache.
  if (detect.type === 'manual' || !validateHandle(platform.rules, lower).valid) {
    return checkPlatform(platform, lower, options);
  }
  const load = () => rt.limit(hostOf(fillTemplate(detect.url, lower)), () => checkPlatform(platform, lower, options));
  if (!cache) return load();
  return cache
    .resolve(`platform:${platform.id}:${lower}`, load, isDefinitive)
    .then(({ value, cached }) => (cached ? { ...value, cached: true } : value));
}

function runDomain(rt: Runtime, label: string, tld: string): Promise<CheckResult> {
  const { options, cache } = rt;
  const load = async () => {
    const bootstrap = await rt.bootstrap;
    const host = bootstrap.get(tld) ? hostOf(bootstrap.get(tld)!) : `dns:${tld}`;
    return rt.limit(host, () =>
      checkDomain(
        label,
        tld,
        {
          fetch: options.fetch,
          resolveNs: options.resolveNs,
          provider: options.domainProvider,
          timeoutMs: options.timeoutMs,
          retries: options.retries,
          backoffMs: options.backoffMs,
          signal: options.signal,
        },
        bootstrap,
      ),
    );
  };
  if (!cache) return load();
  return cache
    .resolve(`domain:${label}.${tld}`, load, isDefinitive)
    .then(({ value, cached }) => (cached ? { ...value, cached: true } : value));
}

export function summarize(results: CheckResult[]): Summary {
  const summary: Summary = { available: 0, taken: 0, unknown: 0, invalid: 0 };
  for (const result of results) summary[result.state]++;
  return summary;
}

/** Most places free first; ties broken by fewer confirmed-taken, then by original order. */
export function rankSuggestions(entries: { suggestion: Suggestion; results: CheckResult[] }[]): RankedSuggestion[] {
  return entries
    .map(({ suggestion, results }, index) => {
      const s = summarize(results);
      return {
        index,
        ranked: {
          ...suggestion,
          freeCount: s.available,
          takenCount: s.taken,
          unknownCount: s.unknown,
          invalidCount: s.invalid,
          total: results.length,
          results,
        } satisfies RankedSuggestion,
      };
    })
    .sort(
      (a, b) =>
        b.ranked.freeCount - a.ranked.freeCount ||
        a.ranked.takenCount - b.ranked.takenCount ||
        a.ranked.invalidCount - b.ranked.invalidCount ||
        a.index - b.index,
    )
    .map((entry) => entry.ranked);
}

/**
 * Run a full check for one name: domains, platforms, then (when something is taken)
 * generate alternatives, re-check the top ones everywhere and rank them by how many
 * places each is free.
 */
export async function scout(input: string, options: ScoutOptions = {}): Promise<Report> {
  const started = Date.now();
  const parsed = parseName(input);
  const mode: Mode = !options.mode || options.mode === 'auto' ? parsed.detectedMode : options.mode;
  const emit = (event: ScoutEvent) => options.onEvent?.(event);

  const tlds = (options.tlds ?? DEFAULT_TLDS).map((t) => t.toLowerCase().replace(/^\./, ''));
  const platforms = options.platforms ?? PLATFORMS;
  const wantDomains = options.only !== 'socials';
  const wantPlatforms = options.only !== 'domains';

  const rt: Runtime = {
    options,
    limit: createHostLimiter(options.concurrency ?? 12, options.perHostConcurrency ?? 3),
    cache: options.cache === false ? null : (options.cache ?? defaultCache),
    bootstrap: options.bootstrap
      ? Promise.resolve(options.bootstrap)
      : wantDomains
        ? loadBootstrap({
            fetch: options.fetch,
            timeoutMs: options.timeoutMs,
            retries: options.retries,
            backoffMs: options.backoffMs,
            signal: options.signal,
          })
        : Promise.resolve(new Map()),
  };

  const domainTargets = wantDomains ? tlds : [];
  const platformTargets = wantPlatforms ? platforms : [];

  emit({
    type: 'plan',
    input: parsed.input,
    mode,
    handle: parsed.handle,
    domainLabel: parsed.domainLabel,
    domains: domainTargets.map((tld) => ({ id: tld, name: `.${tld}`, handle: `${parsed.domainLabel}.${tld}` })),
    platforms: platformTargets.map((p) => ({ id: p.id, name: p.name, handle: parsed.handle })),
  });

  const report = (promise: Promise<CheckResult>) =>
    promise.then((result) => {
      emit({ type: 'result', result });
      return result;
    });

  const [domains, platformResults] = await Promise.all([
    Promise.all(domainTargets.map((tld) => report(runDomain(rt, parsed.domainLabel, tld)))),
    Promise.all(platformTargets.map((p) => report(runPlatform(rt, p, parsed.handle)))),
  ]);

  // ---- Suggestions -------------------------------------------------------------
  const anyTaken = [...domains, ...platformResults].some((r) => r.state === 'taken' || r.state === 'invalid');
  const policy = options.suggestions ?? 'auto';
  let suggestions: RankedSuggestion[] = [];

  if (policy === 'always' || (policy === 'auto' && anyTaken)) {
    const candidates = generateSuggestions(parsed, { mode, limit: options.suggestionLimit ?? 10 });
    const rankPlatforms = platformTargets.filter(
      (p) => p.detect.type === 'http' && p.detect.available && (options.rankAcross === 'all' || p.tier === 'core'),
    );
    const rankTlds = wantDomains ? (options.suggestionTlds ?? (wantPlatforms ? ['com'] : ['com', 'io', 'co'])) : [];

    emit({
      type: 'suggestions-plan',
      handles: candidates,
      targets: [
        ...rankTlds.map((tld) => ({ id: tld, name: `.${tld}` })),
        ...rankPlatforms.map((p) => ({ id: p.id, name: p.name })),
      ],
    });

    const entries = await Promise.all(
      candidates.map(async (suggestion) => {
        const label = suggestion.handle.replace(/[._]+/g, '');
        const track = (promise: Promise<CheckResult>) =>
          promise.then((result) => {
            emit({ type: 'suggestion-result', handle: suggestion.handle, result });
            return result;
          });
        const results = await Promise.all([
          ...rankTlds.map((tld) => track(runDomain(rt, label, tld))),
          ...rankPlatforms.map((p) => track(runPlatform(rt, p, suggestion.handle))),
        ]);
        return { suggestion, results };
      }),
    );
    suggestions = rankSuggestions(entries);
  }

  const result: Report = {
    input: parsed.input,
    mode,
    handle: parsed.handle,
    domainLabel: parsed.domainLabel,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    domains,
    platforms: platformResults,
    suggestions,
    summary: { domains: summarize(domains), platforms: summarize(platformResults) },
  };
  if (options.domainProvider && wantDomains) {
    const failures = domains.filter((d) => d.providerError);
    result.domainProvider = {
      id: options.domainProvider.id,
      name: options.domainProvider.name,
      confirmed: domains.filter((d) => d.method === 'registrar').length,
      failed: failures.length,
      error: failures[0]?.providerError,
    };
  }
  emit({ type: 'done', report: result });
  return result;
}

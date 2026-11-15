import { HttpError, request } from '../http.js';
import type { DomainPrice, DomainProvider, FetchLike, ProviderAnswer } from '../types.js';

/**
 * Porkbun as an optional domain provider.
 *
 * RDAP and DNS answer "is there a registration record?". Porkbun, a registrar,
 * answers "can this be bought, and for how much?", which also covers TLDs that have
 * no RDAP server (.io .co .me .so .sh), names a registry holds back, and premium
 * pricing. It needs the user's own free API key; see the README.
 *
 * API reference: https://porkbun.com/api/json/v3/documentation
 * Endpoint used: POST /domain/checkDomain with a `domains` array (up to 25 per call,
 * budget 200 domains per 60 seconds per account). Read-only; it never buys anything.
 */
export const PORKBUN_API_BASE = 'https://api.porkbun.com/api/json/v3';

/** Environment variables read by `porkbunFromEnv`. */
export const PORKBUN_ENV = { apiKey: 'PORKBUN_API_KEY', secretKey: 'PORKBUN_SECRET_API_KEY' } as const;

/** Porkbun's limit on one bulk call. */
const MAX_BATCH = 25;

export interface PorkbunOptions {
  /** The public key, starting `pk1_`. */
  apiKey: string;
  /** The secret key, starting `sk1_`. */
  secretKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  /** How long to collect domains before sending them as one bulk call. */
  batchWindowMs?: number;
}

interface PorkbunPriceBlock {
  price?: string;
  regularPrice?: string;
}

interface PorkbunDomainEntry {
  avail?: string;
  price?: string;
  regularPrice?: string;
  firstYearPromo?: string;
  premium?: string;
  aftermarketSearch?: string;
  inYourAccount?: boolean;
  additional?: { renewal?: PorkbunPriceBlock; transfer?: PorkbunPriceBlock };
}

interface PorkbunBody {
  status?: string;
  code?: string;
  message?: string;
  reason?: string;
  retryAfter?: number;
  ttlRemaining?: number;
  domains?: Record<string, PorkbunDomainEntry>;
  unresolved?: string[];
  invalid?: unknown[];
  // /ping
  credentialsValid?: boolean;
  scopes?: string[];
}

const KEY_HELP = 'Check PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY (see "Porkbun API key" in the README).';

/** Turn a Porkbun error body into one sentence a user can act on. */
function explainError(body: PorkbunBody, httpStatus: number): string {
  const code = body.code ?? '';
  if (code.startsWith('INVALID_API_KEYS') || code === 'API_KEY_REQUIRED' || code === 'MISSING_SECRETAPIKEY' || code === 'INVALID_USER') {
    return `Porkbun rejected the API key. ${KEY_HELP}`;
  }
  if (code === 'IP_NOT_ALLOWED') {
    return 'This Porkbun API key is restricted to other IP addresses. Edit the key at porkbun.com/account/api.';
  }
  if (code === 'INSUFFICIENT_SCOPE') {
    return 'This Porkbun API key lacks the "read" permission. Edit the key at porkbun.com/account/api.';
  }
  if (code === 'RATE_LIMIT_EXCEEDED' || httpStatus === 429) {
    const wait = body.retryAfter ?? body.ttlRemaining;
    return `Porkbun's rate limit was reached${wait ? `; try again in ${wait} seconds` : ''}.`;
  }
  if (code === 'BULK_CHECK_TOO_SLOW') return 'Porkbun could not check this batch of domains in time. Try again.';
  const detail = body.message ?? (code || `HTTP ${httpStatus}`);
  return `Porkbun returned an error: ${detail}`;
}

function toPrice(entry: PorkbunDomainEntry): DomainPrice | undefined {
  if (!entry.price) return undefined;
  const firstYearPromo = entry.firstYearPromo === 'yes';
  return {
    currency: 'USD',
    registration: entry.price,
    regular: firstYearPromo && entry.regularPrice && entry.regularPrice !== entry.price ? entry.regularPrice : undefined,
    renewal: entry.additional?.renewal?.price,
    premium: entry.premium === 'yes',
    firstYearPromo,
  };
}

function toAnswer(entry: PorkbunDomainEntry): ProviderAnswer {
  if (entry.avail === 'yes') return { status: 'available', price: toPrice(entry) };
  if (entry.avail === 'no') {
    if (entry.inYourAccount) return { status: 'taken', note: 'This domain is already in your Porkbun account.' };
    return {
      status: 'taken',
      note: entry.aftermarketSearch ? 'Registered to someone else; it may be listed for sale on the aftermarket.' : undefined,
    };
  }
  return { status: 'error', reason: 'Porkbun gave an answer for this domain that could not be read.' };
}

/** `invalid` entries are loosely documented, so read the likely field names defensively. */
function readInvalid(entry: unknown): { domain?: string; reason: string } {
  if (typeof entry === 'string') return { domain: entry.toLowerCase(), reason: 'Porkbun cannot check this name.' };
  const obj = (entry ?? {}) as Record<string, unknown>;
  const domain = [obj.domain, obj.name, obj.input].find((v): v is string => typeof v === 'string');
  const reason = [obj.reason, obj.message, obj.code].find((v): v is string => typeof v === 'string');
  return {
    domain: domain?.toLowerCase(),
    reason: reason ? `Porkbun cannot check this name: ${reason}` : 'Porkbun cannot check this name.',
  };
}

function parseJson(text: string): PorkbunBody | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as PorkbunBody) : undefined;
  } catch {
    return undefined;
  }
}

function authHeaders(options: Pick<PorkbunOptions, 'apiKey' | 'secretKey'>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-API-Key': options.apiKey,
    'X-Secret-API-Key': options.secretKey,
  };
}

/**
 * Build a Porkbun provider. Domains requested within a few milliseconds of each
 * other are sent together, so a whole run is one or two API calls.
 */
export function createPorkbunProvider(options: PorkbunOptions): DomainProvider {
  const baseUrl = (options.baseUrl ?? PORKBUN_API_BASE).replace(/\/$/, '');
  const windowMs = options.batchWindowMs ?? 25;
  let queue: { domain: string; resolve: (answer: ProviderAnswer) => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function send(domains: string[]): Promise<Map<string, ProviderAnswer>> {
    const answers = new Map<string, ProviderAnswer>();
    const failAll = (reason: string) => {
      for (const domain of domains) answers.set(domain, { status: 'error', reason });
      return answers;
    };

    let status: number;
    let text: string;
    try {
      const res = await request(`${baseUrl}/domain/checkDomain`, {
        fetch: options.fetch,
        method: 'POST',
        body: JSON.stringify({ domains }),
        headers: authHeaders(options),
        timeoutMs: options.timeoutMs ?? 20_000,
        retries: options.retries ?? 1,
        maxBodyBytes: 1_000_000,
      });
      status = res.status;
      text = res.body;
    } catch (err) {
      return failAll(`Porkbun could not be reached: ${err instanceof HttpError ? err.message : String(err)}.`);
    }

    const body = parseJson(text);
    if (!body) return failAll(`Porkbun returned an unreadable response (HTTP ${status}).`);
    if (body.status !== 'SUCCESS') return failAll(explainError(body, status));

    for (const [name, entry] of Object.entries(body.domains ?? {})) {
      answers.set(name.toLowerCase(), toAnswer(entry ?? {}));
    }
    for (const name of body.unresolved ?? []) {
      // Porkbun is explicit that "unresolved" is neither available nor taken.
      answers.set(String(name).toLowerCase(), {
        status: 'error',
        reason: 'The registry did not answer Porkbun in time. Try again.',
      });
    }
    for (const raw of body.invalid ?? []) {
      const { domain, reason } = readInvalid(raw);
      if (domain) answers.set(domain, { status: 'unsupported', reason });
    }
    return answers;
  }

  function flush() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    const domains = [...new Set(batch.map((entry) => entry.domain))];
    void send(domains).then((answers) => {
      for (const entry of batch) {
        entry.resolve(
          answers.get(entry.domain) ?? {
            status: 'unsupported',
            reason: 'Porkbun gave no answer for this domain; it may not sell this ending.',
          },
        );
      }
    });
  }

  return {
    id: 'porkbun',
    name: 'Porkbun',
    check(domain) {
      return new Promise<ProviderAnswer>((resolve) => {
        queue.push({ domain: domain.toLowerCase(), resolve });
        if (new Set(queue.map((entry) => entry.domain)).size >= MAX_BATCH) flush();
        else timer ??= setTimeout(flush, windowMs);
      });
    },
  };
}

/**
 * Build the provider from `PORKBUN_API_KEY` and `PORKBUN_SECRET_API_KEY`.
 * Returns `undefined` when either is missing, which simply leaves the feature off.
 */
export function porkbunFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Omit<PorkbunOptions, 'apiKey' | 'secretKey'> = {},
): DomainProvider | undefined {
  const apiKey = env[PORKBUN_ENV.apiKey]?.trim();
  const secretKey = env[PORKBUN_ENV.secretKey]?.trim();
  if (!apiKey || !secretKey) return undefined;
  return createPorkbunProvider({ ...options, apiKey, secretKey });
}

/** Ask Porkbun whether a key pair works, without checking any domain. */
export async function verifyPorkbunKeys(
  options: Pick<PorkbunOptions, 'apiKey' | 'secretKey' | 'baseUrl' | 'fetch' | 'timeoutMs'>,
): Promise<{ ok: true; scopes: string[] } | { ok: false; reason: string }> {
  const baseUrl = (options.baseUrl ?? PORKBUN_API_BASE).replace(/\/$/, '');
  try {
    const res = await request(`${baseUrl}/ping`, {
      fetch: options.fetch,
      headers: authHeaders(options),
      timeoutMs: options.timeoutMs ?? 15_000,
      retries: 1,
    });
    const body = parseJson(res.body);
    if (!body) return { ok: false, reason: `Porkbun returned an unreadable response (HTTP ${res.status}).` };
    if (body.status === 'SUCCESS' && body.credentialsValid) return { ok: true, scopes: body.scopes ?? [] };
    if (body.status === 'SUCCESS') return { ok: false, reason: `Porkbun did not recognise the API key. ${KEY_HELP}` };
    return { ok: false, reason: explainError(body, res.status) };
  } catch (err) {
    return { ok: false, reason: `Porkbun could not be reached: ${err instanceof HttpError ? err.message : String(err)}.` };
  }
}

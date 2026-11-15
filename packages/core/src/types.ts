/** The four states a check can end in. `unknown` is a first-class answer, not an error. */
export type State = 'available' | 'taken' | 'unknown' | 'invalid';

/** How much to trust an `available` / `taken` verdict. */
export type Confidence = 'high' | 'medium' | 'low';

export type Mode = 'personal' | 'brand';

export type CheckMethod = 'rdap' | 'dns' | 'http' | 'manual' | 'rules' | 'registrar';

export interface CheckResult {
  kind: 'domain' | 'platform';
  /** Platform id (`github`) or the TLD (`com`). */
  id: string;
  /** Human label: `GitHub`, `.com`. */
  name: string;
  /** What was checked: a username, or a full domain name. */
  handle: string;
  state: State;
  /** `null` when the state is `unknown` or `invalid`. */
  confidence: Confidence | null;
  /** Direct link so the result can be verified by hand. */
  url: string;
  /** Why the state is what it is. Always set for `unknown` and `invalid`. */
  reason?: string;
  method: CheckMethod;
  /** Wall-clock time of the check in milliseconds. */
  ms: number;
  cached?: boolean;
  category?: PlatformCategory;
  /** Name of the registrar that confirmed a domain result (`Porkbun`). */
  provider?: string;
  /** Registration price, when a registrar confirmed the domain can be bought. */
  price?: DomainPrice;
  /** Set when a registrar was configured but could not confirm this domain. */
  providerError?: string;
}

/** Prices as the registrar quotes them, in US dollars (`"9.73"`). */
export interface DomainPrice {
  currency: 'USD';
  /** What the first year costs. */
  registration: string;
  /** The standard price, when `registration` is a first-year promotion. */
  regular?: string;
  /** What each later year costs. */
  renewal?: string;
  /** Registry premium name: priced far above the TLD's normal rate. */
  premium: boolean;
  firstYearPromo: boolean;
}

/** What a registrar said about one domain. */
export type ProviderAnswer =
  | { status: 'available'; price?: DomainPrice }
  | { status: 'taken'; note?: string }
  /** The registrar does not sell this TLD or rejected the name. */
  | { status: 'unsupported'; reason: string }
  /** Bad key, rate limit, network failure, or the registry did not answer. */
  | { status: 'error'; reason: string };

/**
 * An optional registrar API that confirms domain results and adds prices.
 * It needs the user's own API key; without one, RDAP and DNS are used alone.
 */
export interface DomainProvider {
  id: string;
  name: string;
  /** Check one full domain name (`abcd.io`). Must not throw. */
  check(domain: string): Promise<ProviderAnswer>;
}

/** How the registrar was used in one run. */
export interface ProviderSummary {
  id: string;
  name: string;
  /** Domains the registrar gave a definite answer for. */
  confirmed: number;
  /** Domains it was asked about but could not answer. */
  failed: number;
  /** The first failure message, when there was one. */
  error?: string;
}

/**
 * A response matcher. Every field that is present must match.
 * `bodyIncludes` / `bodyExcludes` accept one string or several (all must hold).
 */
export interface Matcher {
  status?: number | number[];
  bodyIncludes?: string | string[];
  bodyExcludes?: string | string[];
}

export interface HttpDetect {
  type: 'http';
  /** URL template; `{handle}` is replaced with the URL-encoded handle. */
  url: string;
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  /** Response that proves the handle is taken. */
  taken: Matcher;
  /**
   * Response that proves the handle is free. Leave it out for platforms where only
   * "taken" can be confirmed; everything else is then reported as `unknown`.
   */
  available?: Matcher;
}

export interface ManualDetect {
  type: 'manual';
  /** Shown to the user: why this platform cannot be checked automatically. */
  reason: string;
}

export type Detect = HttpDetect | ManualDetect;

export interface UsernameRules {
  minLength: number;
  maxLength: number;
  /** Must match the whole (lower-cased) handle. */
  pattern: RegExp;
  /** Plain-language version of the rules, shown when a handle is invalid. */
  description: string;
}

export type PlatformCategory = 'social' | 'professional' | 'video' | 'developer' | 'writing' | 'creator';

export interface PlatformDefinition {
  id: string;
  name: string;
  category: PlatformCategory;
  /**
   * `core` platforms take part in the cross-platform suggestion ranking.
   * `extra` platforms are checked for the main name only.
   */
  tier: 'core' | 'extra';
  /** Public profile URL template; `{handle}` is replaced with the handle. */
  profileUrl: string;
  rules: UsernameRules;
  detect: Detect;
  /** Confidence of a verdict from this detector. */
  confidence: Confidence;
  /** Optional lower confidence for `available` verdicts specifically. */
  availableConfidence?: Confidence;
  /** Caveat shown next to results. */
  note?: string;
  /** A handle known to be taken, used by the live verification script. */
  probe?: { taken: string };
}

export interface Suggestion {
  handle: string;
  /** How it was derived, e.g. `prefix:get`, `suffix:hq`, `separator:_`, `initials`. */
  pattern: string;
}

export interface RankedSuggestion extends Suggestion {
  /** Places where the handle is confirmed free. */
  freeCount: number;
  takenCount: number;
  unknownCount: number;
  invalidCount: number;
  /** Number of places checked. */
  total: number;
  results: CheckResult[];
}

export interface Summary {
  available: number;
  taken: number;
  unknown: number;
  invalid: number;
}

export interface Report {
  input: string;
  mode: Mode;
  /** The username that was checked on platforms. */
  handle: string;
  /** The label that was checked as a domain (`<label>.<tld>`). */
  domainLabel: string;
  generatedAt: string;
  durationMs: number;
  domains: CheckResult[];
  platforms: CheckResult[];
  suggestions: RankedSuggestion[];
  summary: { domains: Summary; platforms: Summary };
  /** Present when a registrar API key was configured for this run. */
  domainProvider?: ProviderSummary;
}

export type ScoutEvent =
  | {
      type: 'plan';
      input: string;
      mode: Mode;
      handle: string;
      domainLabel: string;
      domains: { id: string; name: string; handle: string }[];
      platforms: { id: string; name: string; handle: string }[];
    }
  | { type: 'result'; result: CheckResult }
  | { type: 'suggestions-plan'; handles: Suggestion[]; targets: { id: string; name: string }[] }
  | { type: 'suggestion-result'; handle: string; result: CheckResult }
  | { type: 'done'; report: Report };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type ResolveNsLike = (hostname: string) => Promise<string[]>;

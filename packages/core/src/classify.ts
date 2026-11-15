import type { HttpDetect, Matcher } from './types.js';

export interface Classification {
  state: 'available' | 'taken' | 'unknown';
  reason?: string;
}

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export function matcherNeedsBody(matcher: Matcher | undefined): boolean {
  return !!matcher && (matcher.bodyIncludes !== undefined || matcher.bodyExcludes !== undefined);
}

export function detectNeedsBody(detect: HttpDetect): boolean {
  return matcherNeedsBody(detect.taken) || matcherNeedsBody(detect.available);
}

/** True when every condition present in the matcher holds. An empty matcher never matches. */
export function matches(matcher: Matcher | undefined, status: number, body: string): boolean {
  if (!matcher) return false;
  const statuses = asArray(matcher.status);
  const includes = asArray(matcher.bodyIncludes);
  const excludes = asArray(matcher.bodyExcludes);
  if (statuses.length === 0 && includes.length === 0 && excludes.length === 0) return false;
  if (statuses.length > 0 && !statuses.includes(status)) return false;
  if (!includes.every((needle) => body.includes(needle))) return false;
  if (excludes.some((needle) => body.includes(needle))) return false;
  return true;
}

const BLOCKED = new Set([401, 403, 406, 451, 999]);

/**
 * Decide what a response means. The rule is: never guess.
 * A response is `taken` or `available` only if it matches that matcher and not the
 * other one. Anything else (bot walls, rate limits, redesigned pages, server errors)
 * is `unknown` with a reason.
 */
export function classifyResponse(detect: HttpDetect, status: number, body: string): Classification {
  const taken = matches(detect.taken, status, body);
  const available = matches(detect.available, status, body);

  if (taken && available) {
    return { state: 'unknown', reason: 'The response matched both "taken" and "available" signals.' };
  }
  if (taken) return { state: 'taken' };
  if (available) return { state: 'available' };

  if (status === 429) {
    return { state: 'unknown', reason: 'Rate limited by the site (HTTP 429). Try again later or check by hand.' };
  }
  if (BLOCKED.has(status)) {
    return { state: 'unknown', reason: `The site blocked the automated check (HTTP ${status}).` };
  }
  if (status >= 500) {
    return { state: 'unknown', reason: `The site returned a server error (HTTP ${status}).` };
  }
  if (!detect.available) {
    return {
      state: 'unknown',
      reason: `Not confirmed as taken (HTTP ${status}). This site only lets us confirm "taken", never "available".`,
    };
  }
  return { state: 'unknown', reason: `Unrecognised response (HTTP ${status}); the site may have changed.` };
}

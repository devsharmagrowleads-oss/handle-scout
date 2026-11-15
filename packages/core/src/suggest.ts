import { parseName, type ParsedName } from './names.js';
import type { Mode, PlatformDefinition, Suggestion } from './types.js';
import { isValidFor } from './validate.js';

/**
 * Affixes, in the order they are tried. Earlier entries are preferred when the
 * list is cut down for cross-platform ranking, so keep the most natural first.
 */
export const PERSONAL_PREFIXES = ['iam', 'the', 'real', 'hey', 'connect', 'its', 'im', 'hello', 'meet', 'by'];
export const PERSONAL_SUFFIXES = ['hq', 'official', 'writes', 'online'];
export const BRAND_PREFIXES = ['get', 'try', 'use', 'join', 'with', 'go', 'hello', 'the', 'meet'];
export const BRAND_SUFFIXES = ['hq', 'app', 'io', 'labs', 'co', 'team', 'official', 'dev', 'ai'];

const SEPARATORS = ['_', '.', '-'] as const;

function build(parsed: ParsedName, mode: Mode): Suggestion[] {
  const { tokens } = parsed;
  const joined = tokens.join('');
  const out: Suggestion[] = [];
  const add = (handle: string, pattern: string) => out.push({ handle, pattern });

  const separated = () => {
    if (tokens.length < 2) return;
    for (const sep of SEPARATORS) add(tokens.join(sep), `separator:${sep}`);
  };

  if (mode === 'personal') {
    const [a, b, c, d] = PERSONAL_PREFIXES;
    // Lead with the affixes people actually use, then the separator forms, then the rest.
    for (const prefix of [a, b, c, d]) if (prefix) add(prefix + joined, `prefix:${prefix}`);
    add(`${joined}hq`, 'suffix:hq');
    add(`connect${joined}`, 'prefix:connect');
    separated();
    for (const prefix of PERSONAL_PREFIXES.slice(5)) add(prefix + joined, `prefix:${prefix}`);
    for (const suffix of PERSONAL_SUFFIXES.slice(1)) add(joined + suffix, `suffix:${suffix}`);

    if (tokens.length >= 2) {
      const first = tokens[0]!;
      const last = tokens[tokens.length - 1]!;
      const middle = tokens.slice(1, -1);
      const firstInitial = first[0]!;
      const lastInitial = last[0]!;
      add(firstInitial + middle.join('') + last, 'initials'); // rsharma
      add(first + middle.map((t) => t[0]).join('') + lastInitial, 'initials'); // rams
      add(`${firstInitial}_${last}`, 'initials'); // r_sharma
      add(`${firstInitial}.${last}`, 'initials'); // r.sharma
      add(`${first}_${lastInitial}`, 'initials'); // ram_s
      add([...tokens].reverse().join(''), 'reversed'); // sharmaram
      add(`the${firstInitial}${last}`, 'initials'); // thersharma
    }
  } else {
    const lead = BRAND_PREFIXES.slice(0, 3);
    for (const prefix of lead) add(prefix + joined, `prefix:${prefix}`);
    for (const suffix of BRAND_SUFFIXES.slice(0, 3)) add(joined + suffix, `suffix:${suffix}`);
    for (const prefix of BRAND_PREFIXES.slice(3, 5)) add(prefix + joined, `prefix:${prefix}`);
    add(`${joined}labs`, 'suffix:labs');
    separated();
    for (const prefix of BRAND_PREFIXES.slice(5)) add(prefix + joined, `prefix:${prefix}`);
    for (const suffix of BRAND_SUFFIXES.slice(4)) add(joined + suffix, `suffix:${suffix}`);
  }

  return out;
}

export interface SuggestOptions {
  mode?: Mode;
  /** Maximum number of suggestions returned. */
  limit?: number;
  /** Handles to leave out (the original name is always excluded). */
  exclude?: string[];
}

/**
 * Generate alternative handles for a name, most natural first.
 *
 * personal: `iamramsharma`, `theramsharma`, `ramsharmahq`, `ram_sharma`, `ram.sharma`, `rsharma`, ...
 * brand:    `getabcd`, `tryabcd`, `useabcd`, `abcdhq`, `abcdapp`, `abcdio`, `joinabcd`, `abcdlabs`, ...
 */
export function generateSuggestions(name: string | ParsedName, options: SuggestOptions = {}): Suggestion[] {
  const parsed = typeof name === 'string' ? parseName(name) : name;
  const mode = options.mode ?? parsed.detectedMode;
  const seen = new Set<string>([parsed.handle, ...(options.exclude ?? [])].map((h) => h.toLowerCase()));
  const unique: Suggestion[] = [];
  for (const suggestion of build(parsed, mode)) {
    if (suggestion.handle.length < 2 || seen.has(suggestion.handle)) continue;
    seen.add(suggestion.handle);
    unique.push(suggestion);
  }
  return options.limit !== undefined ? unique.slice(0, options.limit) : unique;
}

/** Only the suggestions a platform's username rules allow (no dots where dots are banned, etc.). */
export function suggestionsForPlatform(suggestions: Suggestion[], platform: PlatformDefinition): Suggestion[] {
  return suggestions.filter((s) => isValidFor(platform, s.handle));
}

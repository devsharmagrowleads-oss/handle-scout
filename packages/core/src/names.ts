import type { Mode } from './types.js';

export interface ParsedName {
  /** The input, trimmed. */
  input: string;
  /** Lower-cased words, letters and digits only: `Ram Sharma` -> [`ram`, `sharma`]. */
  tokens: string[];
  /** The username to check on platforms. */
  handle: string;
  /** The label to check as a domain name. */
  domainLabel: string;
  /** Mode guessed from the shape of the input. */
  detectedMode: Mode;
}

export const MAX_INPUT_LENGTH = 64;

function fold(text: string): string {
  // Strip diacritics so "José" becomes "jose" instead of being dropped.
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Turn whatever the user typed into the handle and domain label to check.
 *
 * - `Ram Sharma`  -> handle `ramsharma`  (words are joined)
 * - `@Ram_Sharma` -> handle `ram_sharma` (a typed handle is kept as typed)
 * - `abcd`        -> handle `abcd`
 */
export function parseName(raw: string): ParsedName {
  const input = raw.trim().replace(/\s+/g, ' ');
  if (!input) throw new Error('Enter a name to check.');
  if (input.length > MAX_INPUT_LENGTH) {
    throw new Error(`Name is too long (max ${MAX_INPUT_LENGTH} characters).`);
  }

  const folded = fold(input).replace(/^@+/, '');
  const hasSpaces = /\s/.test(folded);
  const tokens = folded.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) throw new Error('Name must contain at least one letter or digit.');

  let handle: string;
  if (hasSpaces) {
    handle = tokens.join('');
  } else {
    // Keep separators the user typed on purpose, drop everything else.
    handle = folded
      .replace(/[^a-z0-9._-]+/g, '')
      .replace(/^[._-]+|[._-]+$/g, '');
    if (!handle) handle = tokens.join('');
  }

  const domainLabel = handle.replace(/[._]+/g, '').replace(/^-+|-+$/g, '') || tokens.join('');

  return {
    input,
    tokens,
    handle,
    domainLabel,
    detectedMode: hasSpaces ? 'personal' : 'brand',
  };
}

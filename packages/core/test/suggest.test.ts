import { describe, expect, it } from 'vitest';
import { generateSuggestions, getPlatform, parseName, suggestionsForPlatform, validateHandle } from '../src/index.js';

const handles = (name: string, mode?: 'personal' | 'brand', limit?: number) =>
  generateSuggestions(name, { mode, limit }).map((s) => s.handle);

describe('parseName', () => {
  it('joins words and detects personal mode', () => {
    const parsed = parseName('  Ram   Sharma ');
    expect(parsed.tokens).toEqual(['ram', 'sharma']);
    expect(parsed.handle).toBe('ramsharma');
    expect(parsed.domainLabel).toBe('ramsharma');
    expect(parsed.detectedMode).toBe('personal');
  });

  it('keeps a typed handle as typed and treats a single word as a brand', () => {
    const parsed = parseName('@Ram_Sharma');
    expect(parsed.handle).toBe('ram_sharma');
    expect(parsed.domainLabel).toBe('ramsharma');
    expect(parsed.detectedMode).toBe('brand');
  });

  it('folds accents instead of dropping letters', () => {
    expect(parseName('José Núñez').handle).toBe('josenunez');
  });

  it('rejects empty and oversized input', () => {
    expect(() => parseName('   ')).toThrow();
    expect(() => parseName('!!!')).toThrow();
    expect(() => parseName('a'.repeat(65))).toThrow();
  });
});

describe('generateSuggestions (personal)', () => {
  const list = handles('Ram Sharma');

  it('includes the documented variants', () => {
    for (const expected of [
      'connectramsharma',
      'iamramsharma',
      'theramsharma',
      'ramsharmahq',
      'ram.sharma',
      'ram_sharma',
      'realramsharma',
      'heyramsharma',
      'rsharma',
      'rams',
      'r_sharma',
    ]) {
      expect(list).toContain(expected);
    }
  });

  it('never suggests the original handle and has no duplicates', () => {
    expect(list).not.toContain('ramsharma');
    expect(new Set(list).size).toBe(list.length);
  });

  it('puts separator variants inside the default top 10 so they get ranked', () => {
    const top = handles('Ram Sharma', 'personal', 10);
    expect(top).toHaveLength(10);
    expect(top).toContain('ram_sharma');
    expect(top).toContain('ram.sharma');
    expect(top[0]).toBe('iamramsharma');
  });

  it('skips separator and initials variants for a single word', () => {
    const single = handles('Ram', 'personal');
    expect(single).toContain('iamram');
    expect(single.some((h) => /[._-]/.test(h))).toBe(false);
  });
});

describe('generateSuggestions (brand)', () => {
  const list = handles('abcd');

  it('includes the documented variants', () => {
    for (const expected of [
      'getabcd',
      'tryabcd',
      'useabcd',
      'abcdhq',
      'abcdapp',
      'abcdio',
      'joinabcd',
      'abcdlabs',
      'withabcd',
    ]) {
      expect(list).toContain(expected);
    }
  });

  it('uses brand mode by default for a single word and honours an explicit mode', () => {
    expect(list).not.toContain('iamabcd');
    expect(handles('abcd', 'personal')).toContain('iamabcd');
    expect(handles('Acme Rocket', 'brand')).toContain('getacmerocket');
  });

  it('excludes handles on request', () => {
    const out = generateSuggestions('abcd', { exclude: ['getabcd'] }).map((s) => s.handle);
    expect(out).not.toContain('getabcd');
  });
});

describe('suggestionsForPlatform', () => {
  const all = generateSuggestions('Ram Sharma');

  it('drops dotted handles where dots are not allowed', () => {
    const github = suggestionsForPlatform(all, getPlatform('github')!).map((s) => s.handle);
    expect(github).not.toContain('ram.sharma');
    expect(github).not.toContain('ram_sharma');
    expect(github).toContain('ram-sharma');
    expect(github).toContain('iamramsharma');
  });

  it('keeps dots and underscores on Instagram but not hyphens', () => {
    const instagram = suggestionsForPlatform(all, getPlatform('instagram')!).map((s) => s.handle);
    expect(instagram).toContain('ram.sharma');
    expect(instagram).toContain('ram_sharma');
    expect(instagram).not.toContain('ram-sharma');
  });

  it('respects length limits (X allows at most 15 characters)', () => {
    const x = suggestionsForPlatform(all, getPlatform('x')!);
    expect(x.length).toBeGreaterThan(0);
    for (const s of x) {
      expect(s.handle.length).toBeLessThanOrEqual(15);
      expect(validateHandle(getPlatform('x')!.rules, s.handle).valid).toBe(true);
    }
    expect(x.map((s) => s.handle)).not.toContain('connectramsharma');
  });
});

import { describe, expect, it } from 'vitest';
import { getPlatform, PLATFORMS, validateDomainLabel, validateHandle } from '../src/index.js';

const check = (id: string, handle: string) => validateHandle(getPlatform(id)!.rules, handle);

describe('validateHandle', () => {
  it.each([
    ['github', 'ram-sharma', true],
    ['github', 'ram--sharma', false],
    ['github', '-ram', false],
    ['github', 'ram_sharma', false],
    ['github', 'a'.repeat(40), false],
    ['instagram', 'ram.sharma_1', true],
    ['instagram', 'ram..sharma', false],
    ['instagram', 'ramsharma.', false],
    ['instagram', 'ram-sharma', false],
    ['x', 'abc', false],
    ['x', 'ram_sharma', true],
    ['x', 'ram.sharma', false],
    ['x', 'a'.repeat(16), false],
    ['telegram', 'abcd', false],
    ['telegram', '1abcde', false],
    ['telegram', 'ram__sharma', false],
    ['telegram', 'ram_sharma', true],
    ['dockerhub', 'ram-sharma', false],
    ['dockerhub', 'abc', false],
    ['dockerhub', 'ramsharma', true],
    ['bluesky', 'ab', false],
    ['bluesky', 'ram-sharma', true],
    ['bluesky', 'ram.sharma', false],
    ['npm', '_private', false],
    ['npm', 'my.pkg-name', true],
    ['facebook', 'abcd', false],
    ['facebook', 'ram.sharma', true],
    ['youtube', 'ram.sharma', true],
    ['youtube', '.ramsharma', false],
    ['reddit', 'ab', false],
  ])('%s: %s -> valid=%s', (id, handle, expected) => {
    const result = check(id, handle);
    expect(result.valid).toBe(expected);
    if (!expected) expect(result.reason).toBeTruthy();
  });

  it('explains length problems with the actual limits', () => {
    expect(check('x', 'abc').reason).toMatch(/Too short.*minimum is 4/);
    expect(check('x', 'a'.repeat(16)).reason).toMatch(/Too long.*maximum is 15/);
  });

  it('is case-insensitive', () => {
    expect(check('github', 'RamSharma').valid).toBe(true);
  });
});

describe('platform definitions', () => {
  it('have unique ids and complete, consistent fields', () => {
    const ids = PLATFORMS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PLATFORMS) {
      expect(p.profileUrl).toContain('{handle}');
      expect(p.rules.minLength).toBeLessThanOrEqual(p.rules.maxLength);
      expect(p.rules.description.length).toBeGreaterThan(5);
      if (p.detect.type === 'http') {
        expect(p.detect.url).toContain('{handle}');
        expect(p.detect.url.startsWith('https://')).toBe(true);
      } else {
        expect(p.detect.reason.length).toBeGreaterThan(10);
      }
    }
  });

  it('use a probe handle that passes their own rules', () => {
    for (const p of PLATFORMS) {
      if (p.probe) expect(validateHandle(p.rules, p.probe.taken).valid, p.id).toBe(true);
    }
  });

  it('cover every platform the project promises', () => {
    const ids = new Set(PLATFORMS.map((p) => p.id));
    for (const id of [
      'github', 'instagram', 'x', 'linkedin', 'linkedin-company', 'youtube', 'tiktok', 'telegram', 'reddit',
      'facebook', 'threads', 'pinterest', 'twitch', 'producthunt', 'npm', 'pypi', 'medium', 'devto', 'bluesky',
      'mastodon', 'dockerhub',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});

describe('validateDomainLabel', () => {
  it.each([
    ['ramsharma', true],
    ['ram-sharma', true],
    ['-ram', false],
    ['ram-', false],
    ['ram_sharma', false],
    ['ram.sharma', false],
    ['', false],
    ['a'.repeat(64), false],
    ['xn--abc', false],
  ])('%s -> valid=%s', (label, expected) => {
    expect(validateDomainLabel(label).valid).toBe(expected);
  });
});

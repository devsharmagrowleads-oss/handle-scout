import type { PlatformDefinition, UsernameRules } from './types.js';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/** Check a handle against a platform's username rules. Handles are compared lower-cased. */
export function validateHandle(rules: UsernameRules, handle: string): ValidationResult {
  const value = handle.toLowerCase();
  if (value.length < rules.minLength) {
    return {
      valid: false,
      reason: `Too short: ${value.length} characters, minimum is ${rules.minLength}. Rules: ${rules.description}`,
    };
  }
  if (value.length > rules.maxLength) {
    return {
      valid: false,
      reason: `Too long: ${value.length} characters, maximum is ${rules.maxLength}. Rules: ${rules.description}`,
    };
  }
  if (!rules.pattern.test(value)) {
    return { valid: false, reason: `Not allowed here. Rules: ${rules.description}` };
  }
  return { valid: true };
}

export function isValidFor(platform: PlatformDefinition, handle: string): boolean {
  return validateHandle(platform.rules, handle).valid;
}

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Validate a single domain label (the part before the TLD). */
export function validateDomainLabel(label: string): ValidationResult {
  const value = label.toLowerCase();
  if (value.length === 0 || value.length > 63) {
    return { valid: false, reason: 'A domain label must be 1 to 63 characters long.' };
  }
  if (!DOMAIN_LABEL.test(value)) {
    return {
      valid: false,
      reason: 'Domain names may only use letters, digits and hyphens, and cannot start or end with a hyphen.',
    };
  }
  if (value.slice(2, 4) === '--') {
    return { valid: false, reason: 'Labels with "--" in positions 3 and 4 are reserved (punycode).' };
  }
  return { valid: true };
}

import { describe, it, expect } from 'vitest';
import { normalizeCountryCode } from '../../tools/form.js';

describe('Form - Country Code', () => {
  it('should normalize +91 to dial code search', () => {
    expect(normalizeCountryCode('+91')).toBe('91');
  });

  it('should normalize +1 to dial code search', () => {
    expect(normalizeCountryCode('+1')).toBe('1');
  });

  it('should normalize IN to India', () => {
    expect(normalizeCountryCode('IN')).toBe('India');
  });

  it('should normalize US to United States', () => {
    expect(normalizeCountryCode('US')).toBe('United States');
  });

  it('should normalize GB to United Kingdom', () => {
    expect(normalizeCountryCode('GB')).toBe('United Kingdom');
  });

  it('should be case-insensitive for ISO codes', () => {
    expect(normalizeCountryCode('in')).toBe('India');
    expect(normalizeCountryCode('us')).toBe('United States');
  });

  it('should pass through full country name unchanged', () => {
    expect(normalizeCountryCode('India')).toBe('India');
    expect(normalizeCountryCode('United States')).toBe('United States');
    expect(normalizeCountryCode('Germany')).toBe('Germany');
  });

  it('should trim whitespace', () => {
    expect(normalizeCountryCode('  +91  ')).toBe('91');
    expect(normalizeCountryCode('  IN  ')).toBe('India');
  });

  it('should pass through unknown 2-letter codes', () => {
    expect(normalizeCountryCode('XX')).toBe('XX');
    expect(normalizeCountryCode('ZZ')).toBe('ZZ');
  });

  it('should handle numeric dial codes without +', () => {
    expect(normalizeCountryCode('91')).toBe('91');
    expect(normalizeCountryCode('44')).toBe('44');
  });
});

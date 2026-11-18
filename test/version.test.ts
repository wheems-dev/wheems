import { describe, expect, it } from 'bun:test';
import { compareVersions, extractVersion, isAtLeast } from '../src/util/version.js';

describe('versions', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('0.1.20', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.19', '0.1.20')).toBe(-1);
    expect(compareVersions('v22.12.0', '22.12.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(0);
  });

  it('checks a minimum', () => {
    expect(isAtLeast('0.1.20', '0.1.20')).toBe(true);
    expect(isAtLeast('0.1.21', '0.1.20')).toBe(true);
    expect(isAtLeast('0.1.19', '0.1.20')).toBe(false);
  });

  it('finds a version in text', () => {
    expect(extractVersion('hc 0.1.20\n')).toBe('0.1.20');
    expect(extractVersion('no version here')).toBeUndefined();
  });

  it('refuses text that is not a version', () => {
    expect(() => compareVersions('abc', '1.0.0')).toThrow(/Not a version/);
  });
});

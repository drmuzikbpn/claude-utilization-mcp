import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  isNewerVersion,
  isValidVersion,
  parseVersion,
  releaseTag,
  sortVersionsDesc,
  tarballName,
} from '../../src/update/version.js';

describe('version parsing (§20)', () => {
  it('parses MAJOR.MINOR.PATCH+build and keeps the build metadata', () => {
    expect(parseVersion('0.1.417+3f9c2ab')).toEqual({
      major: 0,
      minor: 1,
      patch: 417,
      build: '3f9c2ab',
      raw: '0.1.417+3f9c2ab',
    });
  });

  it('tolerates a leading v and surrounding whitespace, stripping the v from raw', () => {
    expect(parseVersion(' v1.2.3 ')?.raw).toBe('1.2.3');
    expect(parseVersion('v1.2.3')?.patch).toBe(3);
  });

  it('parses a version with no build metadata', () => {
    expect(parseVersion('2.10.0')).toMatchObject({ major: 2, minor: 10, patch: 0, build: null });
  });

  it.each(['', 'x', '1.2', '1.2.3.4', '1.2.-3', 'latest', '1.2.3+', '01.2.3-rc1'])(
    'rejects %j',
    (input) => {
      expect(parseVersion(input)).toBeNull();
      expect(isValidVersion(input)).toBe(false);
    },
  );

  it('rejects non-strings', () => {
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe('version comparison', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('0.1.9', '0.1.417')).toBe(-1);
    expect(compareVersions('0.1.417', '0.1.9')).toBe(1);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
  });

  it('ignores build metadata for ordering — two builds of one commit count are equal', () => {
    expect(compareVersions('0.1.417+aaaaaaa', '0.1.417+bbbbbbb')).toBe(0);
    expect(compareVersions('0.1.417', '0.1.417+bbbbbbb')).toBe(0);
    expect(isNewerVersion('0.1.417+bbbbbbb', '0.1.417+aaaaaaa')).toBe(false);
  });

  it('sorts unparseable versions below parseable ones', () => {
    expect(compareVersions('nope', '0.0.1')).toBe(-1);
    expect(compareVersions('0.0.1', 'nope')).toBe(1);
    expect(compareVersions('nope', 'also-nope')).toBe(0);
  });

  it('isNewerVersion is strict and never true for garbage', () => {
    expect(isNewerVersion('0.1.418+x', '0.1.417+y')).toBe(true);
    expect(isNewerVersion('0.1.417+x', '0.1.417+y')).toBe(false);
    expect(isNewerVersion('0.1.416+x', '0.1.417+y')).toBe(false);
    expect(isNewerVersion('garbage', '0.1.417')).toBe(false);
    // An unknown *current* version must still accept a real release.
    expect(isNewerVersion('0.1.417', '0.0.0')).toBe(true);
  });

  it('sortVersionsDesc puts the newest first and sinks garbage', () => {
    expect(sortVersionsDesc(['0.1.9+a', '0.1.417+b', '0.2.0+c', 'junk'])).toEqual([
      '0.2.0+c',
      '0.1.417+b',
      '0.1.9+a',
      'junk',
    ]);
  });
});

describe('release asset names (§20, §23.1)', () => {
  it('tags v<version> and names the tarball after the CLI, not the scope', () => {
    expect(releaseTag('0.1.417+3f9c2ab')).toBe('v0.1.417+3f9c2ab');
    expect(releaseTag('v0.1.417+3f9c2ab')).toBe('v0.1.417+3f9c2ab');
    expect(tarballName('0.1.417+3f9c2ab')).toBe('claude-usage-0.1.417+3f9c2ab.tgz');
    expect(tarballName('v0.1.417+3f9c2ab')).toBe('claude-usage-0.1.417+3f9c2ab.tgz');
  });
});

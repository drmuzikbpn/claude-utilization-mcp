/**
 * Release version strings (§20).
 *
 * CI stamps every release `MAJOR.MINOR.<git rev-list --count HEAD>+<short sha>`:
 * monotonic, commit-stamped and valid semver. The build metadata after `+` is shown
 * everywhere (it is what makes a version traceable to a commit) but, per semver, it
 * never participates in ordering — two builds of the same commit count are equal.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Everything after `+`, or `null`. Never affects ordering. */
  build: string | null;
  /** The string as parsed, with any leading `v` stripped. */
  raw: string;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:\+([0-9A-Za-z.-]+))?$/;

/** Parse `MAJOR.MINOR.PATCH[+build]`, tolerating a leading `v`. Invalid → `null`. */
export function parseVersion(input: string | null | undefined): ParsedVersion | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  const m = VERSION_RE.exec(trimmed);
  if (m === null) return null;
  const [, major, minor, patch, build] = m;
  const nums = [major, minor, patch].map((p) => Number(p));
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  const [maj, min, pat] = nums as [number, number, number];
  return {
    major: maj,
    minor: min,
    patch: pat,
    build: build === undefined ? null : build,
    raw: trimmed.replace(/^v/, ''),
  };
}

/** `true` when the string is a version we can order. */
export function isValidVersion(input: string | null | undefined): boolean {
  return parseVersion(input) !== null;
}

/**
 * Numeric compare on the three parts; build metadata is ignored (semver §10).
 * Unparseable inputs sort below parseable ones, and equal to each other.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return -1;
  if (pb === null) return 1;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  return 0;
}

/** `true` when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string | null | undefined, current: string | null | undefined): boolean {
  if (parseVersion(candidate) === null) return false;
  return compareVersions(candidate, current) > 0;
}

/** Newest first. Unparseable entries sink to the end, ordered by name. */
export function sortVersionsDesc(versions: readonly string[]): string[] {
  return [...versions].sort((a, b) => {
    const cmp = compareVersions(b, a);
    if (cmp !== 0) return cmp;
    return a.localeCompare(b);
  });
}

/** The release tag for a version: `v<version>` (§20). */
export function releaseTag(version: string): string {
  return `v${version.replace(/^v/, '')}`;
}

/** The tarball asset name for a version — the `npm pack` output, renamed unscoped (§20, §23.1). */
export function tarballName(version: string): string {
  return `claude-usage-${version.replace(/^v/, '')}.tgz`;
}

/** The checksum asset name on every release. */
export const SHASUMS_NAME = 'SHA256SUMS';

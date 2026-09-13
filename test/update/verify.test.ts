import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { digestsEqual, parseShasums, sha256File, verify } from '../../src/update/verify.js';
import { TempDirs } from './helpers.js';

const dirs = new TempDirs();
afterAll(() => {
  dirs.cleanup();
});

const TARBALL = 'claude-usage-0.1.418+abc.tgz';

function fixture(body = 'tarball-bytes', sums?: string): { tarballPath: string; shasumsPath: string; digest: string } {
  const dir = dirs.make();
  const tarballPath = join(dir, TARBALL);
  const shasumsPath = join(dir, 'SHA256SUMS');
  writeFileSync(tarballPath, body);
  const digest = createHash('sha256').update(body).digest('hex');
  writeFileSync(shasumsPath, sums ?? `${digest}  ${TARBALL}\n`);
  return { tarballPath, shasumsPath, digest };
}

describe('parseShasums', () => {
  it('reads the GNU coreutils format, the one-space and the binary-marker variants', () => {
    const sums = parseShasums(
      [
        `${'a'.repeat(64)}  claude-usage-1.0.0+a.tgz`,
        `${'b'.repeat(64)} SHA256SUMS`,
        `${'C'.repeat(64)}  *binary.tgz`,
        '',
        'garbage line',
        '# a comment',
      ].join('\n'),
    );
    expect(sums.get('claude-usage-1.0.0+a.tgz')).toBe('a'.repeat(64));
    expect(sums.get('SHA256SUMS')).toBe('b'.repeat(64));
    // Upper case is normalised, and a `*` binary marker is not part of the name.
    expect(sums.get('binary.tgz')).toBe('c'.repeat(64));
    expect(sums.size).toBe(3);
  });

  it('ignores any directory prefix on the filename', () => {
    expect(parseShasums(`${'a'.repeat(64)}  release/claude-usage-1.0.0+a.tgz`).get('claude-usage-1.0.0+a.tgz')).toBe('a'.repeat(64));
  });
});

describe('digestsEqual', () => {
  it('is case-insensitive, length-safe and correct', () => {
    expect(digestsEqual('a'.repeat(64), 'A'.repeat(64))).toBe(true);
    expect(digestsEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false);
    expect(digestsEqual('a'.repeat(64), 'a'.repeat(63))).toBe(false);
    expect(digestsEqual('', '')).toBe(true);
  });
});

describe('verify() (§20 "Integrity")', () => {
  it('accepts a matching digest and leaves the tarball in place', async () => {
    const f = fixture();
    await expect(verify({ tarballPath: f.tarballPath, shasumsPath: f.shasumsPath, tarballFile: TARBALL })).resolves.toBe(f.digest);
    expect(existsSync(f.tarballPath)).toBe(true);
    expect(await sha256File(f.tarballPath)).toBe(f.digest);
  });

  it('deletes the download on a mismatch', async () => {
    const f = fixture('tarball-bytes', `${'0'.repeat(64)}  ${TARBALL}\n`);
    await expect(verify({ tarballPath: f.tarballPath, shasumsPath: f.shasumsPath })).rejects.toMatchObject({
      code: 'checksum_mismatch',
    });
    expect(existsSync(f.tarballPath)).toBe(false);
  });

  it('deletes the download when SHA256SUMS has no line for it', async () => {
    const f = fixture('tarball-bytes', `${'0'.repeat(64)}  some-other-file.tgz\n`);
    await expect(verify({ tarballPath: f.tarballPath, shasumsPath: f.shasumsPath })).rejects.toMatchObject({
      code: 'checksum_missing',
    });
    expect(existsSync(f.tarballPath)).toBe(false);
  });

  it('deletes the download when SHA256SUMS is missing entirely', async () => {
    const f = fixture();
    await expect(verify({ tarballPath: f.tarballPath, shasumsPath: join(dirs.make(), 'nope') })).rejects.toMatchObject({
      code: 'checksum_missing',
    });
    expect(existsSync(f.tarballPath)).toBe(false);
  });

  it('can be told to keep the file (diagnostics)', async () => {
    const f = fixture('tarball-bytes', `${'0'.repeat(64)}  ${TARBALL}\n`);
    await expect(verify({ tarballPath: f.tarballPath, shasumsPath: f.shasumsPath, deleteOnMismatch: false })).rejects.toMatchObject({
      code: 'checksum_mismatch',
    });
    expect(existsSync(f.tarballPath)).toBe(true);
  });
});

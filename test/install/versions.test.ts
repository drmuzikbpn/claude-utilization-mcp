import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installVersion, repointSymlink, resolvePackageRoot } from '../../src/install/versions.js';
import { currentBin, currentLink, versionDir } from '../../src/paths.js';
import { cleanupAllTempHomes, fakePackage, tempHome } from './helpers.js';

afterAll(cleanupAllTempHomes);

describe('resolvePackageRoot', () => {
  it('finds the package that declares the claude-usage bin', () => {
    const pkg = fakePackage();
    expect(resolvePackageRoot(join(pkg, 'dist'))).toBe(pkg);
  });

  it('throws when there is no such package above the start directory', () => {
    const h = tempHome();
    const deep = join(h.home, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(() => resolvePackageRoot(deep)).toThrow(/package root/);
  });
});

describe('installVersion (§20 layout)', () => {
  it('copies the package to versions/<v>/ and points current at it', () => {
    const h = tempHome();
    const pkg = fakePackage('1.2.3');
    const result = installVersion({ version: '1.2.3', sourceDir: pkg, env: h.env });

    expect(result.copied).toBe(true);
    expect(result.versionDir).toBe(versionDir('1.2.3', h.env));
    expect(result.versionDir).toBe(join(h.dataHome, 'claude-usage', 'versions', '1.2.3'));
    expect(readFileSync(join(result.versionDir, 'bin', 'claude-usage'), 'utf8')).toContain('#!/usr/bin/env node');
    expect(readFileSync(join(result.versionDir, 'dist', 'cli.js'), 'utf8')).toContain('main');

    expect(lstatSync(result.currentLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(result.currentLink)).toBe(result.versionDir);
    expect(result.currentLink).toBe(currentLink(h.env));
    // the unit runs <data>/claude-usage/current/bin/claude-usage serve
    expect(existsSync(currentBin(h.env))).toBe(true);
  });

  it('never copies node_modules or .git', () => {
    const h = tempHome();
    const result = installVersion({ version: '1.2.3', sourceDir: fakePackage('1.2.3'), env: h.env });
    expect(existsSync(join(result.versionDir, 'node_modules'))).toBe(false);
    expect(existsSync(join(result.versionDir, '.git'))).toBe(false);
  });

  it('skips the copy when that version is already installed', () => {
    const h = tempHome();
    const pkg = fakePackage('1.2.3');
    installVersion({ version: '1.2.3', sourceDir: pkg, env: h.env });
    const second = installVersion({ version: '1.2.3', sourceDir: pkg, env: h.env });
    expect(second.copied).toBe(false);
    expect(readlinkSync(second.currentLink)).toBe(second.versionDir);
  });

  it('skips the copy when we are already running from the versions layout', () => {
    const h = tempHome();
    const dest = versionDir('4.0.0', h.env);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'package.json'), '{"version":"4.0.0","bin":{"claude-usage":"bin/claude-usage"}}\n');
    const result = installVersion({ version: '4.0.0', sourceDir: dest, env: h.env });
    expect(result.copied).toBe(false);
  });

  it('swaps current from one version to the next', () => {
    const h = tempHome();
    installVersion({ version: '1.0.0', sourceDir: fakePackage('1.0.0'), env: h.env });
    const next = installVersion({ version: '2.0.0', sourceDir: fakePackage('2.0.0'), env: h.env });
    expect(readlinkSync(currentLink(h.env))).toBe(next.versionDir);
    // the old version stays on disk for rollback (W8)
    expect(existsSync(versionDir('1.0.0', h.env))).toBe(true);
  });
});

describe('repointSymlink', () => {
  it('replaces an existing symlink atomically and leaves no temp link behind', () => {
    const h = tempHome();
    const a = join(h.home, 'a');
    const b = join(h.home, 'b');
    mkdirSync(a);
    mkdirSync(b);
    const link = join(h.home, 'current');
    repointSymlink(link, a);
    repointSymlink(link, b);
    expect(readlinkSync(link)).toBe(b);
    expect(existsSync(`${link}.tmp.${String(process.pid)}`)).toBe(false);
  });

  it('replaces a real directory sitting where the symlink belongs', () => {
    const h = tempHome();
    const target = join(h.home, 'target');
    mkdirSync(target);
    const link = join(h.home, 'current');
    mkdirSync(link);
    writeFileSync(join(link, 'stale'), 'x');
    repointSymlink(link, target);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
  });
});

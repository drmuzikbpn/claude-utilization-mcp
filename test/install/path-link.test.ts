import { afterAll, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describePathLink, isOnPath, linkOnPath, pathLinkFile, unlinkFromPath, userBinDir } from '../../src/install/path-link.js';
import { currentBin } from '../../src/paths.js';
import { cleanupAllTempHomes, tempHome } from './helpers.js';

afterAll(cleanupAllTempHomes);

describe('claude-usage on the PATH (§23.51)', () => {
  it('links ~/.local/bin/claude-usage to the current binary', () => {
    const h = tempHome();
    const r = linkOnPath(h.env);
    expect(r).toEqual({ outcome: 'linked', link: join(h.home, '.local', 'bin', 'claude-usage'), onPath: false });
    expect(lstatSync(r.link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(r.link)).toBe(currentBin(h.env));
  });

  it('honours XDG_BIN_HOME', () => {
    const h = tempHome();
    const bin = join(h.home, 'bin');
    const env = { ...h.env, XDG_BIN_HOME: bin, PATH: `/usr/bin:${bin}` };
    expect(userBinDir(env)).toBe(bin);
    expect(linkOnPath(env)).toEqual({ outcome: 'linked', link: join(bin, 'claude-usage'), onPath: true });
  });

  it('is idempotent', () => {
    const h = tempHome();
    linkOnPath(h.env);
    expect(linkOnPath(h.env).outcome).toBe('already');
  });

  it('never clobbers a file or a foreign link that is already there', () => {
    const h = tempHome();
    const link = pathLinkFile(h.env);
    mkdirSync(join(h.home, '.local', 'bin'), { recursive: true });
    writeFileSync(link, '#!/bin/sh\necho mine\n');
    expect(linkOnPath(h.env).outcome).toBe('other');
    expect(readFileSync(link, 'utf8')).toContain('echo mine');
    expect(unlinkFromPath(h.env)).toBe(false);
    expect(readFileSync(link, 'utf8')).toContain('echo mine');
  });

  it('unlink removes only our link', () => {
    const h = tempHome();
    linkOnPath(h.env);
    expect(unlinkFromPath(h.env)).toBe(true);
    expect(() => lstatSync(pathLinkFile(h.env))).toThrow();
    expect(unlinkFromPath(h.env)).toBe(false);
  });

  it('matches PATH entries regardless of trailing slashes', () => {
    expect(isOnPath('/a/b', { PATH: '/x:/a/b/' })).toBe(true);
    expect(isOnPath('/a/b', { PATH: '/x::/a' })).toBe(false);
  });

  it('tells the user how to fix a PATH without the directory, and why it left a foreign file', () => {
    const h = tempHome();
    const linked = describePathLink({ outcome: 'linked', link: '/h/.local/bin/claude-usage', onPath: false }, h.env);
    expect(linked.line).toBe('path:    linked /h/.local/bin/claude-usage\n');
    expect(linked.note).toContain('export PATH=');
    expect(describePathLink({ outcome: 'already', link: '/l', onPath: true }, h.env).note).toBeNull();
    const other = describePathLink({ outcome: 'other', link: '/l', onPath: true }, h.env);
    expect(other.note).toContain('not a link to this install');
  });
});

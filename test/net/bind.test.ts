// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config.js';
import { addressScope, isBindAllowed, LAN_KEYWORD, resolveBindAddresses, TAILSCALE_KEYWORD } from '../../src/net/bind.js';

const noTailnet = async (): Promise<string | null> => null;
const tailnet = async (): Promise<string | null> => '100.101.102.103';

function collect(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}

describe('resolveBindAddresses', () => {
  it('passes IP literals through in order', async () => {
    await expect(resolveBindAddresses(['127.0.0.1', '::1'], { resolveTailscale: noTailnet })).resolves.toEqual([
      '127.0.0.1',
      '::1',
    ]);
  });

  it('defaults to 127.0.0.1 for an empty list', async () => {
    await expect(resolveBindAddresses([], { resolveTailscale: noTailnet })).resolves.toEqual(['127.0.0.1']);
  });

  it('resolves the tailscale keyword', async () => {
    await expect(resolveBindAddresses(['127.0.0.1', TAILSCALE_KEYWORD], { resolveTailscale: tailnet })).resolves.toEqual([
      '127.0.0.1',
      '100.101.102.103',
    ]);
  });

  it('resolves the keyword once however often it is listed', async () => {
    let calls = 0;
    const resolveTailscale = async (): Promise<string | null> => {
      calls += 1;
      return '100.101.102.103';
    };
    await expect(resolveBindAddresses(['tailscale', 'Tailscale', ' tailscale '], { resolveTailscale })).resolves.toEqual([
      '100.101.102.103',
    ]);
    expect(calls).toBe(1);
  });

  it('skips the keyword with a warning when there is no tailnet address', async () => {
    const { lines, log } = collect();
    await expect(resolveBindAddresses(['127.0.0.1', 'tailscale'], { resolveTailscale: noTailnet, log })).resolves.toEqual([
      '127.0.0.1',
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/tailscale/i);
  });

  it('falls back to 127.0.0.1 when the only entry could not be resolved', async () => {
    const { lines, log } = collect();
    await expect(resolveBindAddresses(['tailscale'], { resolveTailscale: noTailnet, log })).resolves.toEqual(['127.0.0.1']);
    expect(lines).toHaveLength(1);
  });

  it('de-dupes repeated and re-resolved addresses', async () => {
    await expect(
      resolveBindAddresses(['127.0.0.1', '127.0.0.1', '100.101.102.103', 'tailscale'], { resolveTailscale: tailnet }),
    ).resolves.toEqual(['127.0.0.1', '100.101.102.103']);
  });

  it('rejects anything that is neither an IP literal nor the keyword, naming the key', async () => {
    for (const [index, entry] of [['0', 'example.com'], ['1', '127.0.0.1.5'], ['2', 'tail scale']].entries()) {
      const bind = ['127.0.0.1', '::1', 'x'];
      bind[index] = entry[1] as string;
      const err = await resolveBindAddresses(bind.slice(0, index + 1), { resolveTailscale: noTailnet }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).key).toBe(`bind[${index}]`);
      expect((err as ConfigError).message).toContain(`bind[${index}]`);
    }
  });

  it('reports the offending index, not the first one', async () => {
    const err = await resolveBindAddresses(['127.0.0.1', 'tailscale', 'nope'], { resolveTailscale: tailnet }).catch(
      (e: unknown) => e,
    );
    expect((err as ConfigError).key).toBe('bind[2]');
  });

  it('uses the real resolver only when asked to', async () => {
    // No `resolveTailscale` and no keyword ⇒ nothing is ever executed.
    await expect(resolveBindAddresses(['127.0.0.1'])).resolves.toEqual(['127.0.0.1']);
  });

  it('resolves the lan keyword (§23.44)', async () => {
    await expect(
      resolveBindAddresses(['127.0.0.1', LAN_KEYWORD], { resolveTailscale: noTailnet, resolveLan: async () => '192.168.1.20' }),
    ).resolves.toEqual(['127.0.0.1', '192.168.1.20']);
  });

  it('skips lan with a warning when there is no LAN address, never an error', async () => {
    const { lines, log } = collect();
    await expect(
      resolveBindAddresses(['127.0.0.1', 'LAN'], { resolveTailscale: noTailnet, resolveLan: async () => null, log }),
    ).resolves.toEqual(['127.0.0.1']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/lan/i);
  });

  it('names both keywords in the error for a bad entry', async () => {
    const err = await resolveBindAddresses(['wifi'], { resolveTailscale: noTailnet }).catch((e: unknown) => e);
    expect((err as ConfigError).message).toContain('"lan"');
    expect((err as ConfigError).message).toContain('"tailscale"');
  });
});

describe('addressScope (§23.57)', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.8.9.10', 'loopback'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'], // public-check:allow
    ['192.168.0.1', 'private'],
    ['fd00::1', 'private'],
    ['fc00::1', 'private'],
    ['::ffff:192.168.0.1', 'private'],
    ['100.64.0.0', 'cgnat'],
    ['169.254.0.0', 'link-local'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local'],
    ['0.0.0.0', 'wildcard'],
    ['::', 'wildcard'],
    ['0:0:0:0:0:0:0:0', 'wildcard'],
    ['::ffff:0.0.0.0', 'wildcard'],
    ['192.0.2.1', 'public'],
    ['198.51.100.7', 'public'],
    ['203.0.113.9', 'public'],
    ['172.15.0.0', 'public'], // public-check:allow
    ['172.32.0.0', 'public'], // public-check:allow
    ['192.169.0.0', 'public'], // public-check:allow
    ['100.63.255.255', 'public'], // public-check:allow
    ['100.128.0.0', 'public'], // public-check:allow
    ['2001:db8::1', 'public'],
    ['::ffff:203.0.113.9', 'public'],
    ['not-an-address', 'public'],
    ['', 'public'],
  ] as const)('%s is %s', (address, scope) => {
    expect(addressScope(address)).toBe(scope);
  });

  it('isBindAllowed refuses wildcard and public unless told otherwise', () => {
    for (const a of ['0.0.0.0', '::', '203.0.113.9', '2001:db8::1']) {
      expect(isBindAllowed(a, false), a).toBe(false);
      expect(isBindAllowed(a, true), a).toBe(true);
    }
    for (const a of ['127.0.0.1', '::1', '192.168.0.1', '10.0.0.1', 'fd00::1', '100.64.0.0']) expect(isBindAllowed(a, false), a).toBe(true);
  });
});

describe('resolveBindAddresses refuses to listen where it should not (§23.57)', () => {
  it.each(['0.0.0.0', '::', '203.0.113.9', '2001:db8::1', '::ffff:203.0.113.9'])('refuses %s with a ConfigError naming the entry', async (entry) => {
    const attempt = resolveBindAddresses(['127.0.0.1', entry], { resolveTailscale: noTailnet });
    await expect(attempt).rejects.toBeInstanceOf(ConfigError);
    await expect(attempt).rejects.toMatchObject({ key: 'bind[1]' });
    await expect(attempt).rejects.toThrow(/allowPublicBind/);
  });

  it('says which of the two it is', async () => {
    await expect(resolveBindAddresses(['0.0.0.0'], {})).rejects.toThrow(/every interface/);
    await expect(resolveBindAddresses(['203.0.113.9'], {})).rejects.toThrow(/publicly routable/);
  });

  it('allows them only with allowPublicBind', async () => {
    await expect(resolveBindAddresses(['127.0.0.1', '0.0.0.0', '203.0.113.9'], { allowPublicBind: true })).resolves.toEqual(['127.0.0.1', '0.0.0.0', '203.0.113.9']);
  });

  it.each([
    [TAILSCALE_KEYWORD, '203.0.113.9'],
    [TAILSCALE_KEYWORD, '0.0.0.0'],
    [LAN_KEYWORD, '198.51.100.7'],
    [LAN_KEYWORD, 'garbage'],
  ])('skips the %s keyword, with a warning, when it resolves to %s', async (keyword, address) => {
    const { lines, log } = collect();
    const resolver = async (): Promise<string | null> => address;
    await expect(resolveBindAddresses(['127.0.0.1', keyword], { resolveTailscale: resolver, resolveLan: resolver, log })).resolves.toEqual(['127.0.0.1']);
    expect(lines.join('\n')).toContain('not a private address');
  });

  it('still accepts private, link-local and loopback literals', async () => {
    const bind = ['127.0.0.1', '::1', '192.168.0.1', '10.0.0.1', 'fd00::1'];
    await expect(resolveBindAddresses(bind, {})).resolves.toEqual(bind);
  });
});


// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions
import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  findTailscaleBin,
  findTailscaleIPv4,
  isTailscaleIPv4,
  TAILSCALE_PATHS,
  resolveMagicDnsName,
  resolveTailscaleIPv4,
  type ExecFn,
  type InterfaceTable,
} from '../../src/net/tailscale.js';

function v4(address: string, name = 'utun4'): [string, NetworkInterfaceInfo[]] {
  return [
    name,
    [
      {
        address,
        netmask: '255.192.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: false,
        cidr: `${address}/10`,
      } as NetworkInterfaceInfo,
    ],
  ];
}

function v6(address: string, name = 'utun5'): [string, NetworkInterfaceInfo[]] {
  return [
    name,
    [
      {
        address,
        netmask: 'ffff:ffff:ffff:ffff::',
        family: 'IPv6',
        mac: '00:00:00:00:00:00',
        internal: false,
        cidr: `${address}/64`,
        scopeid: 0,
      } as NetworkInterfaceInfo,
    ],
  ];
}

const LAN: InterfaceTable = Object.fromEntries([v4('192.168.1.20', 'en0')]);
/** The sample tailnet addresses this file has always used. */
const TAILNET_IP = '100.101.102.103'; // public-check:allow
const OTHER_TAILNET_IP = '100.68.121.24'; // public-check:allow
/** A stand-in CLI path: `exec` is always injected, so nothing here ever runs it. */
const BIN = '/usr/local/bin/tailscale';

/** Fails the test if the CLI is reached when it should not be. */
const forbiddenExec: ExecFn = () => {
  throw new Error('exec must not be called');
};

function execReturning(stdout: string): ExecFn {
  return async () => stdout;
}

const missingBinary: ExecFn = () => {
  const err = new Error('spawn tailscale ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return Promise.reject(err);
};

describe('isTailscaleIPv4', () => {
  it.each(['100.64.0.0', '100.101.102.103', '100.127.255.255'])('accepts %s', (addr) => {
    expect(isTailscaleIPv4(addr)).toBe(true);
  });

  it.each(['100.63.255.255', '100.128.0.1', '101.64.0.1', '192.168.1.4', '::1', 'not-an-ip', ''])('rejects %s', (addr) => {
    expect(isTailscaleIPv4(addr)).toBe(false);
  });
});

describe('findTailscaleIPv4', () => {
  it('returns null for an empty table', () => {
    expect(findTailscaleIPv4({})).toBeNull();
  });

  it('returns null when no interface is in the CGNAT range', () => {
    expect(findTailscaleIPv4(LAN)).toBeNull();
  });

  it('finds the address regardless of interface name', () => {
    const table: InterfaceTable = Object.fromEntries([v4('192.168.1.20', 'en0'), v4('100.101.102.103', 'utun4')]);
    expect(findTailscaleIPv4(table)).toBe('100.101.102.103');
  });

  it('takes the first match when several interfaces qualify', () => {
    const table: InterfaceTable = Object.fromEntries([v4('100.70.0.1', 'utun4'), v4('100.71.0.2', 'utun7')]);
    expect(findTailscaleIPv4(table)).toBe('100.70.0.1');
  });

  it('ignores an IPv6-only tailnet interface', () => {
    const table: InterfaceTable = Object.fromEntries([v6('fd7a:115c:a1e0::1', 'utun4')]);
    expect(findTailscaleIPv4(table)).toBeNull();
  });

  it('tolerates undefined entries and the numeric family node sometimes reports', () => {
    const table = { utun4: undefined, utun5: [{ address: '100.75.1.1', family: 4 }] } as unknown as InterfaceTable;
    expect(findTailscaleIPv4(table)).toBe('100.75.1.1');
  });
});

describe('resolveTailscaleIPv4 (§23.57)', () => {
  it('trusts an in-range address on an interface Tailscale names after itself, without shelling out', async () => {
    const table: InterfaceTable = Object.fromEntries([v4('192.168.1.20', 'en0'), v4(TAILNET_IP, 'tailscale0')]); // public-check:allow
    await expect(resolveTailscaleIPv4({ interfaces: () => table, exec: forbiddenExec, bin: BIN })).resolves.toBe(TAILNET_IP);
  });

  it('does NOT trust an in-range address on any other interface: CGNAT space is not Tailscale’s alone', async () => {
    // An ISP, or another VPN, put this address on en0/utun4. No CLI vouches for it.
    for (const name of ['en0', 'utun4', 'wg0', 'tailscalex', 'mytailscale0']) {
      const table: InterfaceTable = Object.fromEntries([v4(TAILNET_IP, name)]);
      await expect(resolveTailscaleIPv4({ interfaces: () => table, exec: missingBinary, bin: BIN }), name).resolves.toBeNull();
      await expect(resolveTailscaleIPv4({ interfaces: () => table, exec: forbiddenExec, bin: null }), name).resolves.toBeNull();
    }
  });

  it('on macOS the interface is an anonymous utun, so the CLI is what confirms the address', async () => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    const exec: ExecFn = async (file, args, opts) => {
      calls.push({ file, args, timeoutMs: opts.timeoutMs });
      return `${TAILNET_IP}\n`;
    };
    const table: InterfaceTable = Object.fromEntries([v4(TAILNET_IP, 'utun4')]);
    await expect(resolveTailscaleIPv4({ interfaces: () => table, exec, bin: BIN })).resolves.toBe(TAILNET_IP);
    expect(calls).toEqual([{ file: BIN, args: ['ip', '-4'], timeoutMs: 2_000 }]);
  });

  it('takes the first line when the CLI prints several', async () => {
    await expect(resolveTailscaleIPv4({ interfaces: () => LAN, exec: execReturning(`${TAILNET_IP}\n${OTHER_TAILNET_IP}\n`), bin: BIN })).resolves.toBe(TAILNET_IP);
  });

  it.each(['192.168.1.20', '10.0.0.5', '203.0.113.9', '0.0.0.0', '127.0.0.1', '100.63.255.255', '100.128.0.1', '8.8.8.8.8', 'no ip', '', '::1'])( // public-check:allow
    'range-checks the CLI: "%s" is not a tailnet address and is refused',
    async (printed) => {
      await expect(resolveTailscaleIPv4({ interfaces: () => LAN, exec: execReturning(`${printed}\n`), bin: BIN })).resolves.toBeNull();
    },
  );

  it('returns null when no CLI is installed, without trying a bare PATH lookup', async () => {
    await expect(resolveTailscaleIPv4({ interfaces: () => LAN, exec: forbiddenExec, bin: null })).resolves.toBeNull();
  });

  it('returns null when the CLI times out or fails', async () => {
    const exec: ExecFn = () => Promise.reject(new Error('killed after 2000ms'));
    await expect(resolveTailscaleIPv4({ interfaces: () => ({}), exec, bin: BIN })).resolves.toBeNull();
    await expect(resolveTailscaleIPv4({ interfaces: () => LAN, exec: missingBinary, bin: BIN })).resolves.toBeNull();
  });

  it('survives an interface lookup that throws', async () => {
    const interfaces = (): InterfaceTable => {
      throw new Error('no interfaces');
    };
    await expect(resolveTailscaleIPv4({ interfaces, exec: execReturning(TAILNET_IP), bin: BIN })).resolves.toBe(TAILNET_IP);
  });
});

describe('findTailscaleBin (§23.57)', () => {
  it('only ever returns an absolute path from the known list', () => {
    for (const path of TAILSCALE_PATHS) expect(path.startsWith('/')).toBe(true);
    expect(findTailscaleBin(() => false)).toBeNull();
    expect(findTailscaleBin((p) => p === '/usr/bin/tailscale')).toBe('/usr/bin/tailscale');
  });

  it('prefers the earlier entry and survives a probe that throws', () => {
    const first = TAILSCALE_PATHS[0] as string;
    const second = TAILSCALE_PATHS[1] as string;
    expect(findTailscaleBin(() => true)).toBe(first);
    expect(
      findTailscaleBin((p) => {
        if (p === first) throw new Error('EACCES');
        return p === second;
      }),
    ).toBe(second);
  });
});

describe('resolveMagicDnsName', () => {
  const status = (dnsName: unknown): string => JSON.stringify({ Self: { DNSName: dnsName } });

  it('reads Self.DNSName and strips the trailing dot', async () => {
    const calls: Array<readonly string[]> = [];
    const exec: ExecFn = async (_file, args) => {
      calls.push(args);
      return status('adams-mbp.tail1234.ts.net.');
    };
    await expect(resolveMagicDnsName({ exec })).resolves.toBe('adams-mbp.tail1234.ts.net');
    expect(calls).toEqual([['status', '--json']]);
  });

  it('accepts a name without a trailing dot', async () => {
    await expect(resolveMagicDnsName({ exec: execReturning(status('box.tail1234.ts.net')) })).resolves.toBe('box.tail1234.ts.net');
  });

  it.each([status(''), status('.'), status(42), JSON.stringify({ Self: {} }), JSON.stringify({}), 'not json', ''])(
    'returns null for unusable output %#',
    async (out) => {
      await expect(resolveMagicDnsName({ exec: execReturning(out) })).resolves.toBeNull();
    },
  );

  it('returns null when the binary is missing, without throwing', async () => {
    await expect(resolveMagicDnsName({ exec: missingBinary })).resolves.toBeNull();
  });

  it.each(['evil host.example.ts.net', 'a..b', 'box.example.ts.net/x', '-bad.example.ts.net', 'nodots', 'x'.repeat(300) + '.example.ts.net'])(
    'refuses a name that is not a plain DNS name: %s (§23.57)',
    async (name) => {
      await expect(resolveMagicDnsName({ exec: execReturning(status(name)) })).resolves.toBeNull();
    },
  );

  it('lower-cases the name, since it is compared against Host case-insensitively', async () => {
    await expect(resolveMagicDnsName({ exec: execReturning(status('Box.Example.TS.net.')) })).resolves.toBe('box.example.ts.net');
  });

  it('asks nothing when no CLI is installed', async () => {
    await expect(resolveMagicDnsName({ exec: forbiddenExec, bin: null })).resolves.toBeNull();
  });
});

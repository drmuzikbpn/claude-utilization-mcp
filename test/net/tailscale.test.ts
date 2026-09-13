import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  findTailscaleIPv4,
  isTailscaleIPv4,
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

describe('resolveTailscaleIPv4', () => {
  it('prefers the interface table and never shells out', async () => {
    const table: InterfaceTable = Object.fromEntries([v4('100.101.102.103')]);
    await expect(resolveTailscaleIPv4({ interfaces: () => table, exec: forbiddenExec })).resolves.toBe('100.101.102.103');
  });

  it('falls back to `tailscale ip -4` when no interface matches', async () => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    const exec: ExecFn = async (file, args, opts) => {
      calls.push({ file, args, timeoutMs: opts.timeoutMs });
      return '100.101.102.103\n';
    };
    await expect(resolveTailscaleIPv4({ interfaces: () => LAN, exec })).resolves.toBe('100.101.102.103');
    expect(calls).toEqual([{ file: 'tailscale', args: ['ip', '-4'], timeoutMs: 2_000 }]);
  });

  it('takes the first line when the CLI prints several', async () => {
    await expect(resolveTailscaleIPv4({ interfaces: () => LAN, exec: execReturning('100.101.102.103\n100.68.121.24\n') })).resolves.toBe(
      '100.101.102.103',
    );
  });

  it('returns null when the CLI prints something that is not an IPv4 address', async () => {
    await expect(resolveTailscaleIPv4({ interfaces: () => LAN, exec: execReturning('no ip\n') })).resolves.toBeNull();
    await expect(resolveTailscaleIPv4({ interfaces: () => LAN, exec: execReturning('') })).resolves.toBeNull();
  });

  it('returns null when the binary is missing, without throwing', async () => {
    await expect(resolveTailscaleIPv4({ interfaces: () => LAN, exec: missingBinary })).resolves.toBeNull();
  });

  it('returns null when the CLI times out or fails', async () => {
    const exec: ExecFn = () => Promise.reject(new Error('killed after 2000ms'));
    await expect(resolveTailscaleIPv4({ interfaces: () => ({}), exec })).resolves.toBeNull();
  });

  it('survives an interface lookup that throws', async () => {
    const interfaces = (): InterfaceTable => {
      throw new Error('no interfaces');
    };
    await expect(resolveTailscaleIPv4({ interfaces, exec: execReturning('100.90.0.1') })).resolves.toBe('100.90.0.1');
  });
});

describe('resolveMagicDnsName', () => {
  const status = (dnsName: unknown): string => JSON.stringify({ Self: { DNSName: dnsName } });

  it('reads Self.DNSName and strips the trailing dot', async () => {
    const calls: Array<readonly string[]> = [];
    const exec: ExecFn = async (_file, args) => {
      calls.push(args);
      return status('alans-mbp.tail1234.ts.net.');
    };
    await expect(resolveMagicDnsName({ exec })).resolves.toBe('alans-mbp.tail1234.ts.net');
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
});

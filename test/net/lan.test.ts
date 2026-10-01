import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  findLanIPv4,
  isExcludedInterface,
  isPrivateIPv4,
  resolveLanIPv4,
  resolveLocalHostName,
  type InterfaceTable,
} from '../../src/net/lan.js';

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` };
}

function v6(address: string): NetworkInterfaceInfo {
  return { address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/64`, scopeid: 0 };
}

describe('isPrivateIPv4 (§23.44)', () => {
  it('accepts the three RFC 1918 ranges', () => {
    for (const a of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.1', '192.168.1.20']) {
      expect(isPrivateIPv4(a)).toBe(true);
    }
  });

  it('rejects public, CGNAT/tailnet, link-local, loopback and non-IPv4', () => {
    for (const a of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '100.101.102.103', '169.254.1.1', '127.0.0.1', '192.169.0.1', 'fe80::1', 'nope']) {
      expect(isPrivateIPv4(a)).toBe(false);
    }
  });
});

describe('isExcludedInterface (§23.44)', () => {
  it('skips VM bridges, VPN tunnels, AWDL and loopback', () => {
    for (const n of ['bridge100', 'vmnet8', 'docker0', 'utun3', 'awdl0', 'llw0', 'lo0', 'lo']) {
      expect(isExcludedInterface(n)).toBe(true);
    }
  });

  it('keeps ordinary Wi-Fi and Ethernet interfaces', () => {
    for (const n of ['en0', 'en1', 'eth0', 'wlan0', 'wlp2s0', 'enp3s0']) {
      expect(isExcludedInterface(n)).toBe(false);
    }
  });
});

describe('findLanIPv4 (§23.44)', () => {
  it('returns the first private IPv4 on a real interface', () => {
    const table: InterfaceTable = {
      lo0: [v4('127.0.0.1', true)],
      en0: [v6('fe80::1'), v4('192.168.1.20')],
      en1: [v4('10.0.0.5')],
    };
    expect(findLanIPv4(table)).toBe('192.168.1.20');
  });

  it('ignores bridges and tunnels even when they come first', () => {
    const table: InterfaceTable = {
      bridge100: [v4('192.168.64.1')],
      utun4: [v4('10.8.0.2')],
      en0: [v4('172.20.10.3')],
    };
    expect(findLanIPv4(table)).toBe('172.20.10.3');
  });

  it('ignores internal addresses and the tailnet range', () => {
    const table: InterfaceTable = {
      en5: [v4('10.0.0.9', true)],
      tailscale0: [v4('100.101.102.103')],
    };
    expect(findLanIPv4(table)).toBeNull();
  });

  it('accepts Node’s numeric family', () => {
    const entry = { ...v4('192.168.0.7'), family: 4 } as unknown as NetworkInterfaceInfo;
    expect(findLanIPv4({ en0: [entry] })).toBe('192.168.0.7');
  });

  it('is null for an empty table', () => {
    expect(findLanIPv4({})).toBeNull();
  });
});

describe('resolveLanIPv4', () => {
  it('reads the injected interface table', () => {
    expect(resolveLanIPv4({ interfaces: () => ({ en0: [v4('192.168.1.2')] }) })).toBe('192.168.1.2');
  });

  it('never throws when the table cannot be read', () => {
    expect(
      resolveLanIPv4({
        interfaces: () => {
          throw new Error('boom');
        },
      }),
    ).toBeNull();
  });
});

describe('resolveLocalHostName (§23.46)', () => {
  it('uses scutil LocalHostName on darwin', async () => {
    const calls: string[] = [];
    const name = await resolveLocalHostName({
      platform: 'darwin',
      exec: async (file, args) => {
        calls.push([file, ...args].join(' '));
        return 'Alans-MacBook-Pro\n';
      },
      hostname: () => 'ignored.example',
    });
    expect(name).toBe('alans-macbook-pro.local');
    expect(calls).toEqual(['scutil --get LocalHostName']);
  });

  it('falls back to the first label of os.hostname() when scutil fails', async () => {
    const name = await resolveLocalHostName({
      platform: 'darwin',
      exec: async () => {
        throw new Error('ENOENT');
      },
      hostname: () => 'Studio.lan',
    });
    expect(name).toBe('studio.local');
  });

  it('uses os.hostname() off darwin without running anything', async () => {
    let ran = false;
    const name = await resolveLocalHostName({
      platform: 'linux',
      exec: async () => {
        ran = true;
        return 'x';
      },
      hostname: () => 'devbox',
    });
    expect(name).toBe('devbox.local');
    expect(ran).toBe(false);
  });

  it('is null for a hostname that is not a DNS label', async () => {
    const name = await resolveLocalHostName({ platform: 'linux', hostname: () => 'bad name!' });
    expect(name).toBeNull();
  });
});

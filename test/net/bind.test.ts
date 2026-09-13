import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config.js';
import { resolveBindAddresses, TAILSCALE_KEYWORD } from '../../src/net/bind.js';

const noTailnet = async (): Promise<string | null> => null;
const tailnet = async (): Promise<string | null> => '100.68.121.23';

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
      '100.68.121.23',
    ]);
  });

  it('resolves the keyword once however often it is listed', async () => {
    let calls = 0;
    const resolveTailscale = async (): Promise<string | null> => {
      calls += 1;
      return '100.68.121.23';
    };
    await expect(resolveBindAddresses(['tailscale', 'Tailscale', ' tailscale '], { resolveTailscale })).resolves.toEqual([
      '100.68.121.23',
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
      resolveBindAddresses(['127.0.0.1', '127.0.0.1', '100.68.121.23', 'tailscale'], { resolveTailscale: tailnet }),
    ).resolves.toEqual(['127.0.0.1', '100.68.121.23']);
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
});

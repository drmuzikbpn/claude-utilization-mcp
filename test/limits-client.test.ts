import { describe, expect, it } from 'vitest';
import { OAUTH_BETA_HEADER, USAGE_ENDPOINT, USER_AGENT, fetchLimits, type FetchLike } from '../src/limits/client.js';
import { getVersion } from '../src/version.js';
import { LimitsError } from '../src/limits/types.js';
import { liveLimitsFixture } from './helpers/fixtures.js';

const TOKEN = 'sk-ant-oat01-FAKE-TEST-TOKEN';

function respond(status: number, body: string): FetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}

describe('fetchLimits', () => {
  it('GETs the usage endpoint with the bearer and beta headers', async () => {
    const seen: Array<{ url: string; init: unknown }> = [];
    const impl: FetchLike = async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify(liveLimitsFixture()) };
    };
    const payload = await fetchLimits(TOKEN, impl);
    expect(seen[0]?.url).toBe(USAGE_ENDPOINT);
    const init = seen[0]?.init as { method?: string; headers?: Record<string, string> };
    expect(init.method).toBe('GET');
    expect(init.headers?.['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(init.headers?.['anthropic-beta']).toBe(OAUTH_BETA_HEADER);
    expect((payload as { limits: unknown[] }).limits).toHaveLength(3);
  });

  // Upstream should see an honest client identity — this daemon's own name and version,
  // never Node's default and never a borrowed Claude Code identity.
  it('identifies itself as claude-usage/<version> in User-Agent', async () => {
    let headers: Record<string, string> | undefined;
    const impl: FetchLike = async (_url, init) => {
      headers = init?.headers;
      return { ok: true, status: 200, text: async () => JSON.stringify(liveLimitsFixture()) };
    };
    await fetchLimits(TOKEN, impl);
    const ua = headers?.['user-agent'];
    expect(ua).toBe(`claude-usage/${getVersion()}`);
    expect(ua).toBe(USER_AGENT);
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(ua).not.toMatch(/claude-cli|claude-code|anthropic-sdk|node/i);
  });

  it('returns the payload verbatim', async () => {
    const fixture = liveLimitsFixture();
    const payload = await fetchLimits(TOKEN, respond(200, JSON.stringify(fixture)));
    expect(payload).toEqual(fixture);
  });

  it.each([401, 403])('maps HTTP %i to unauthorized with a re-login hint', async (status) => {
    const err = await fetchLimits(TOKEN, respond(status, '')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LimitsError);
    expect((err as LimitsError).code).toBe('unauthorized');
    expect((err as LimitsError).hint).toMatch(/claude/);
    expect((err as LimitsError).message).not.toContain(TOKEN);
  });

  it('maps other non-2xx statuses to network', async () => {
    const err = await fetchLimits(TOKEN, respond(503, 'down')).catch((e: unknown) => e);
    expect((err as LimitsError).code).toBe('network');
    expect((err as LimitsError).status).toBe(503);
  });

  it('maps a thrown fetch to network', async () => {
    const boom: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const err = await fetchLimits(TOKEN, boom).catch((e: unknown) => e);
    expect((err as LimitsError).code).toBe('network');
  });

  it.each([
    ['non-JSON body', 'not json'],
    ['a JSON array', '[1,2]'],
    ['a payload with no limits array', '{"five_hour":{}}'],
    ['a payload where limits is not an array', '{"limits":{}}'],
  ])('maps %s to schema_drift', async (_label, body) => {
    const err = await fetchLimits(TOKEN, respond(200, body)).catch((e: unknown) => e);
    expect((err as LimitsError).code).toBe('schema_drift');
  });

  it('never puts the token in an error message', async () => {
    for (const impl of [respond(401, TOKEN), respond(500, TOKEN), respond(200, 'junk')]) {
      const err = await fetchLimits(TOKEN, impl).catch((e: unknown) => e);
      expect(String((err as Error).message)).not.toContain(TOKEN);
    }
  });
});

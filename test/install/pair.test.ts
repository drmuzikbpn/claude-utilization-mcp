import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import { saveConfig, defaultConfig } from '../../src/config.js';
import { DaemonUnreachable } from '../../src/clients/http.js';
import {
  createPairPageHandler,
  PAIR_PAGE_CSP,
  PAIR_PAGE_SCRIPT,
  renderPairPage,
  runPair,
  startPairPage,
  type PairPage,
} from '../../src/install/pair.js';
import { qrMatrix, qrSvg } from '../../src/install/qr.js';

const require = createRequire(import.meta.url);

/** The upstream generator, straight from node_modules — the vendored copy must match it. */
function upstreamMatrix(text: string): boolean[][] {
  const QRCode = require('qrcode-terminal/vendor/QRCode') as new (t: number, l: number) => {
    addData(d: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(r: number, c: number): boolean;
  };
  const level = (require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel') as { M: number }).M;
  const qr = new QRCode(-1, level);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** The page URL inside a redirect file written by `runPair`. */
function redirectTarget(file: string): string {
  const m = /url=(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32})/.exec(readFileSync(file, 'utf8'));
  if (m === null) throw new Error('no redirect URL in the file');
  return m[1] as string;
}

const LINK = `usagedeck://pair?v=2&name=studio&addrs=192.168.1.20%2Cstudio.local&port=47292&fp=${'ab'.repeat(32)}&code=abcDEF0123456789_-xyzQ`;

describe('vendored QR (§23.48)', () => {
  it('produces exactly the upstream matrix', () => {
    for (const text of ['hello', LINK, 'x'.repeat(300)]) {
      expect(qrMatrix(text)).toEqual(upstreamMatrix(text));
    }
  });

  it('renders a square SVG with a quiet zone, one path, deterministically', () => {
    const svg = qrSvg(LINK);
    const n = qrMatrix(LINK).length;
    expect(svg).toContain(`viewBox="0 0 ${n + 8} ${n + 8}"`);
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).toBe(qrSvg(LINK));
    expect(svg).not.toContain('abcDEF0123456789'); // the code is only in the modules
  });
});

describe('the pair page', () => {
  it('shows the QR, steps, GitHub link and the password warning — the code only behind the copy button', () => {
    const html = renderPairPage({ link: LINK, name: 'studio', expiresAt: '2026-10-01T12:05:00Z', testflightUrl: '' });
    expect(html).toContain('<svg');
    expect(html).toContain('https://github.com/drmuzikbpn/claude-utilization-mcp');
    expect(html).toContain('Treat this like a password; if it was shown on a call, run <code>claude-usage pair</code> again');
    expect(html).not.toContain('TestFlight</a>');
    // §23.52: the link is in the page exactly once — the copy button's attribute — never as text.
    expect(html.split('abcDEF0123456789')).toHaveLength(2);
    expect(html).toContain(`data-link="${LINK.replace(/&/g, '&amp;')}"`);
    const text = html.replace(/<script>[\s\S]*?<\/script>/, '').replace(/<[^>]*>/g, '');
    expect(text).not.toContain('abcDEF0123456789');
  });

  it('offers "or copy the pairing link" with a copy icon, and counts down to the expiry', () => {
    const html = renderPairPage({ link: LINK, name: 'studio', expiresAt: '2026-10-01T12:05:00Z', testflightUrl: '' });
    expect(html).toContain('or copy the pairing link');
    expect(html).toMatch(/<button type="button" class="copy" id="copy"[^>]*aria-label="Copy the pairing link"><svg class="i-copy"/);
    expect(html).toContain('data-expires="2026-10-01T12:05:00.000Z"');
    expect(html).toContain(`<script>${PAIR_PAGE_SCRIPT}</script>`);
  });

  it('is on the deck theme: dark ground, deck colours, no external loads', () => {
    const html = renderPairPage({ link: LINK, name: 'studio', expiresAt: '2026-10-01T12:05:00Z', testflightUrl: '' });
    for (const colour of ['#0e1013', '#3dbe8b', '#8c9bff', '#f0b429']) expect(html).toContain(colour);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\/(?!github\.com)/);
    expect(html).not.toMatch(/@import|url\(/);
  });

  it('allows exactly its own script through the CSP, by hash', () => {
    const hash = createHash('sha256').update(PAIR_PAGE_SCRIPT).digest('base64');
    expect(PAIR_PAGE_CSP).toContain(`script-src 'sha256-${hash}'`);
    expect(PAIR_PAGE_CSP).toContain("default-src 'none'");
    expect(PAIR_PAGE_CSP).not.toContain('unsafe-eval');
  });

  it('links TestFlight only when the URL is set, and escapes the name', () => {
    const html = renderPairPage({ link: LINK, name: '<b>x</b>', expiresAt: '2026-10-01T12:05:00Z', testflightUrl: 'https://testflight.apple.com/join/abc' });
    expect(html).toContain('href="https://testflight.apple.com/join/abc"');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });
});

interface FakeRes {
  status: number;
  headers: Record<string, string>;
  body: string;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
}

function fakeRes(): FakeRes {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

function hit(handler: ReturnType<typeof createPairPageHandler>, method: string, url: string, remoteAddress = '127.0.0.1'): FakeRes {
  const res = fakeRes();
  handler({ method, url, socket: { remoteAddress } } as never, res as never);
  return res;
}

describe('createPairPageHandler', () => {
  it('serves the page once, at its path, to loopback only; 404 for everything else; never cached', () => {
    const handler = createPairPageHandler('/secret', '<html>page</html>');
    expect(hit(handler, 'GET', '/secret', '192.168.1.9').status).toBe(404);
    expect(hit(handler, 'GET', '/other').status).toBe(404);
    expect(hit(handler, 'POST', '/secret').status).toBe(404);
    const first = hit(handler, 'GET', '/secret');
    expect(first.status).toBe(200);
    expect(first.body).toBe('<html>page</html>');
    expect(first.headers['cache-control']).toBe('no-store');
    const second = hit(handler, 'GET', '/secret');
    expect(second.status).toBe(404);
    expect(second.headers['cache-control']).toBe('no-store');
  });
});

const pages: PairPage[] = [];
afterEach(async () => {
  while (pages.length > 0) await pages.pop()?.close();
});

function get(url: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    request(url, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    })
      .on('error', reject)
      .end();
  });
}

describe('the page status route (§23.52)', () => {
  it('answers the state at path/status to loopback, any number of times, without spending the page', () => {
    let state: 'pending' | 'paired' | 'expired' = 'pending';
    const handler = createPairPageHandler('/secret', '<html>page</html>', () => state);
    const first = hit(handler, 'GET', '/secret/status');
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ state: 'pending' });
    expect(first.headers['cache-control']).toBe('no-store');
    state = 'paired';
    expect(JSON.parse(hit(handler, 'GET', '/secret/status').body)).toEqual({ state: 'paired' });
    expect(hit(handler, 'GET', '/secret/status', '192.168.1.9').status).toBe(404);
    expect(hit(handler, 'GET', '/other/status').status).toBe(404);
    expect(hit(handler, 'GET', '/secret').status).toBe(200);
  });

  it('the page polls only its own origin', () => {
    expect(PAIR_PAGE_CSP).toContain("connect-src 'self'");
    expect(PAIR_PAGE_SCRIPT).toContain("location.pathname + '/status'");
  });

  it('carries the success, expired and closed panels, hidden until the state arrives', () => {
    const html = renderPairPage({ link: LINK, name: 'studio', expiresAt: '2026-10-01T12:05:00Z', testflightUrl: '' });
    expect(html).toContain('<h2>Pairing successful</h2>');
    expect(html).toContain('It is now safe to close this tab.');
    expect(html).toContain('id="expired"');
    expect(html).toContain('id="closed"');
    expect(html).toContain('body.paired #paired');
  });
});

describe('startPairPage', () => {
  it('listens on 127.0.0.1 at a random 128-bit path', async () => {
    const page = await startPairPage('<html>hi</html>');
    pages.push(page);
    expect(page.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    expect((await get(page.url)).status).toBe(200);
    expect((await get(page.url)).status).toBe(404);
  });
});

describe('runPair', () => {
  function setup(token = 'test-bearer-token'): string {
    const dir = mkdtempSync(join(tmpdir(), 'cu-pair-cli-'));
    saveConfig({ ...defaultConfig(), auth: { token } }, dir);
    return dir;
  }

  it('mints a code, opens the page, and never prints the code or the token', async () => {
    const configDir = setup();
    let out = '';
    let opened = '';
    let pageUrl = '';
    let page = '';
    const posted: string[] = [];
    const code = await runPair({
      configDir,
      stdout: (t) => (out += t),
      stderr: (t) => (out += t),
      client: {
        get: async () => ({ state: 'pending' }),
        post: async (path: string) => {
          posted.push(path);
          return { code: 'abcDEF0123456789_-xyzQ', expiresAt: '2026-10-01T12:05:00Z', link: LINK, name: 'studio', addrs: ['192.168.1.20'], port: 47_292, fp: 'ab'.repeat(32) };
        },
      },
      open: async (target) => {
        opened = target;
      },
      waitUntilDone: async () => {
        // What reaches `open` (and so argv) is a private file, not the capability URL.
        expect(opened).not.toMatch(/^https?:/);
        expect(statSync(opened).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(opened)).mode & 0o777).toBe(0o700);
        pageUrl = redirectTarget(opened);
        page = (await get(pageUrl)).body;
      },
    });
    expect(code).toBe(0);
    expect(posted).toEqual(['/v1/pair/code']);
    expect(page).toContain('<svg');
    expect(out).not.toContain('abcDEF0123456789');
    expect(out).not.toContain('test-bearer-token');
    expect(out).toContain('studio');
    // The page server is closed afterwards.
    await expect(get(pageUrl)).rejects.toThrow();
    expect(out).not.toContain(pageUrl);
    // The redirect file goes with it.
    expect(existsSync(opened)).toBe(false);
    expect(existsSync(dirname(opened))).toBe(false);
  });

  it('when no browser opens, prints the redirect file’s path — never the URL', async () => {
    const configDir = setup();
    let out = '';
    let file = '';
    await runPair({
      configDir,
      stdout: (t) => (out += t),
      stderr: (t) => (out += t),
      client: {
        get: async () => ({ state: 'pending' }),
        post: async () => ({ code: 'abcDEF0123456789_-xyzQ', expiresAt: '2026-10-01T12:05:00Z', link: LINK, name: 'studio', addrs: ['192.168.1.20'], port: 47_292, fp: 'ab'.repeat(32) }),
      },
      open: async (target) => {
        file = target;
        throw new Error('no browser');
      },
      waitUntilDone: async () => undefined,
    });
    expect(out).toContain(file);
    expect(out).not.toMatch(/http:\/\/127\.0\.0\.1/);
  });

  it('explains how to enable LAN when the daemon has no HTTPS listener', async () => {
    const configDir = setup();
    let err = '';
    const code = await runPair({
      configDir,
      stdout: () => undefined,
      stderr: (t) => (err += t),
      client: {
        get: async () => ({ state: 'pending' }),
        post: async () => {
          throw new DaemonUnreachable('POST /v1/pair/code: no HTTPS listener to pair with', { error: { hint: 'enable LAN access with `claude-usage configure lan on`' } }, 409);
        },
      },
      open: async () => undefined,
      waitUntilDone: async () => undefined,
    });
    expect(code).toBe(1);
    expect(err).toContain('configure lan on');
  });

  const MINTED = { code: 'abcDEF0123456789_-xyzQ', expiresAt: '2026-10-01T12:05:00Z', link: LINK, name: 'studio', addrs: ['192.168.1.20'], port: 47_292, fp: 'ab'.repeat(32) };

  /** Run `runPair` with `states` answered in turn by `GET /v1/pair/code`; record what the page saw. */
  async function pairWith(states: Array<string | Error>, opts: { userStops?: boolean } = {}) {
    const configDir = setup();
    let out = '';
    const seen: string[] = [];
    let polls = 0;
    let file = '';
    const code = await runPair({
      configDir,
      stdout: (t) => (out += t),
      stderr: (t) => (out += t),
      pollMs: 1,
      lingerMs: 150,
      client: {
        post: async () => MINTED,
        get: async () => {
          // Hold the first state until the page has been seen in it, so slow runs stay ordered.
          const next = seen.length === 0 ? states[0] : states[Math.min(polls, states.length - 1)];
          polls += 1;
          if (next instanceof Error) throw next;
          return { state: next };
        },
      },
      open: async (target) => {
        file = target;
      },
      waitUntilDone: async (signal) => {
        const url = `${redirectTarget(file)}/status`;
        // Watch the page's status route the way the open page does, until the server goes away.
        void (async () => {
          for (;;) {
            try {
              seen.push(String(JSON.parse((await get(url)).body).state));
            } catch {
              return;
            }
            await new Promise((r) => setTimeout(r, 10));
          }
        })();
        if (opts.userStops === true) {
          await new Promise((r) => setTimeout(r, 60));
          return;
        }
        await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
      },
    });
    return { code, out, seen, polls };
  }

  it('turns the page to "paired" as soon as the phone uses the code, then finishes by itself', async () => {
    const r = await pairWith(['pending', 'pending', 'redeemed']);
    expect(r.code).toBe(0);
    expect(r.seen).toContain('pending');
    expect(r.seen.at(-1)).toBe('paired');
    expect(r.out).toContain('paired ✓');
    expect(r.out).not.toContain('abcDEF0123456789');
  });

  it('turns the page to "expired" and exits 1 when the code runs out unused', async () => {
    const r = await pairWith(['pending', 'expired']);
    expect(r.code).toBe(1);
    expect(r.seen.at(-1)).toBe('expired');
    expect(r.out).toContain('run `claude-usage pair` again');
  });

  it('keeps waiting through status errors (an older daemon) until the user stops it', async () => {
    const r = await pairWith([new Error('405')], { userStops: true });
    expect(r.code).toBe(0);
    expect(r.polls).toBeGreaterThan(1);
    expect(r.seen.every((s) => s === 'pending')).toBe(true);
    expect(r.out).not.toContain('paired ✓');
  });

  it('refuses before a token exists', async () => {
    const configDir = setup('');
    let err = '';
    const code = await runPair({ configDir, stdout: () => undefined, stderr: (t) => (err += t) });
    expect(code).toBe(1);
    expect(err).toContain('claude-usage install');
  });
});

describe('import graph (§23.48, CLAUDE.md)', () => {
  it('the daemon never statically imports the QR code or the pair page', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const seen = new Set<string>();
    const queue = [resolve(root, 'src', 'daemon.ts')];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      // Static `import … from '…'` and `export … from '…'` only — `await import()` is lazy by design.
      for (const m of text.matchAll(/^(?:import|export)\s[^;]*?from\s+'(\.[^']+)'/gms)) {
        const spec = m[1] as string;
        queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      }
    }
    const rel = [...seen].map((f) => f.slice(root.length + 1));
    expect(rel).toContain('src/server/index.ts');
    expect(rel.filter((f) => /vendor\/|install\/(qr|pair)\.ts/.test(f))).toEqual([]);
  });
});

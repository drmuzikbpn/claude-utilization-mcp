/**
 * `claude-usage pair` (§23.48): mint a one-time pairing code from the local daemon and show it
 * as a QR code on a page served from this machine only.
 *
 * The page is the only place the code exists outside daemon memory: it is never printed,
 * never written to disk, and sits inside the SVG's modules rather than as text. The page
 * server listens on 127.0.0.1 at a random 128-bit path, answers that path exactly once, and
 * 404s everything else — so neither a second tab, a history replay, nor another process
 * guessing ports gets it.
 *
 * The URL itself is a capability, so it never goes on a command line (argv is visible to
 * every local user through `ps`) or to the terminal: the browser is pointed at a 0600
 * redirect file in a fresh 0700 directory, which is deleted when the page closes.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient, DaemonUnreachable } from '../clients/http.js';
import { loadConfig, resolveConfigDir } from '../config.js';
import { isLoopbackAddress } from '../server/middleware.js';
import { qrSvg } from './qr.js';

/** Public TestFlight invite; empty until there is one, which hides the link. */
export const TESTFLIGHT_URL = '';
export const GITHUB_URL = 'https://github.com/drmuzikbpn/claude-utilization-mcp';
/** The page closes after this long even if nobody presses Enter; the code expires with it. */
export const PAIR_PAGE_TIMEOUT_MS = 300_000;

export interface PairCodeBody {
  code: string;
  expiresAt: string;
  link: string;
  name: string;
  addrs: string[];
  port: number;
  fp: string;
}

export interface PairIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  configDir?: string;
  /** Injected in tests; defaults to an authenticated loopback `DaemonClient`. */
  client?: { post(path: string, body?: unknown): Promise<unknown> };
  /** Opens the redirect file (a path, never the URL); defaults to `open` / `xdg-open`. */
  open?: (file: string) => Promise<void>;
  /** Resolves when the user is done: Enter, Ctrl-C or the timeout by default. */
  waitUntilDone?: () => Promise<void>;
  testflightUrl?: string;
  platform?: NodeJS.Platform | string;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export function renderPairPage(p: { link: string; name: string; expiresAt: string; testflightUrl: string }): string {
  const name = escapeHtml(p.name);
  const expires = new Date(p.expiresAt);
  const until = Number.isNaN(expires.getTime())
    ? 'in 5 minutes'
    : `at ${expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const install =
    p.testflightUrl.length > 0
      ? `<li>Install <b>Usage Deck</b> on your iPhone from <a href="${escapeHtml(p.testflightUrl)}">TestFlight</a>.</li>`
      : '<li>Install <b>Usage Deck</b> on your iPhone.</li>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Pair ${name}</title>
<style>
:root { color-scheme: light dark; --bg: #f6f5f2; --fg: #1b1b1b; --muted: #5d5d5d; --card: #fff; --warn: #8a4b00; }
@media (prefers-color-scheme: dark) { :root { --bg: #141414; --fg: #ececec; --muted: #a3a3a3; --card: #1f1f1f; --warn: #f0b35a; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 34rem; margin: 0 auto; padding: 2rem 1rem; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
p.sub { color: var(--muted); margin: 0 0 1.5rem; }
.qr { background: #fff; border-radius: 12px; padding: 12px; width: min(100%, 22rem); margin: 0 auto 1.5rem; box-sizing: border-box; }
.qr svg { display: block; width: 100%; height: auto; }
ol { padding-left: 1.25rem; }
li { margin: .4rem 0; }
.warn { background: var(--card); border-left: 4px solid var(--warn); padding: .75rem 1rem; border-radius: 6px; }
a { color: inherit; }
footer { margin-top: 2rem; color: var(--muted); font-size: .9rem; }
</style>
</head>
<body>
<main>
<h1>Pair ${name}</h1>
<p class="sub">This code works once and expires ${until}.</p>
<div class="qr">${qrSvg(p.link)}</div>
<ol>
${install}
<li>Make sure the iPhone is on the same Wi-Fi as this device (or on your Tailscale network).</li>
<li>Point the iPhone Camera at the code and tap <b>Open in Usage Deck</b>, or scan it from inside the app.</li>
</ol>
<p class="warn">Please treat this like a password; if it was shown on a call, run <code>claude-usage pair</code> again.</p>
<footer>claude-usage · <a href="${GITHUB_URL}">${GITHUB_URL.replace('https://', '')}</a> · close this tab when you are done.</footer>
</main>
</body>
</html>
`;
}

const NO_STORE = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** Answer `path` once, to a loopback peer, with `html`; 404 everything else. */
export function createPairPageHandler(path: string, html: string): (req: IncomingMessage, res: ServerResponse) => void {
  let served = false;
  return (req, res) => {
    const ok = !served && req.method === 'GET' && req.url === path && isLoopbackAddress(req.socket.remoteAddress);
    if (!ok) {
      res.writeHead(404, { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    served = true;
    res.writeHead(200, {
      ...NO_STORE,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    });
    res.end(html);
  };
}

export interface PairPage {
  url: string;
  close(): Promise<void>;
}

/** Serve `html` once from 127.0.0.1 at a random 128-bit path. */
export async function startPairPage(html: string): Promise<PairPage> {
  const path = `/${randomBytes(16).toString('hex')}`;
  const server: Server = createServer(createPairPageHandler(path, html));
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  return {
    url: `http://127.0.0.1:${String(port)}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface RedirectFile {
  file: string;
  remove(): void;
}

/** A private (0600 in a fresh 0700 directory) HTML file that forwards the browser to `url`. */
export function writeRedirectFile(url: string): RedirectFile {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-pair-'));
  chmodSync(dir, 0o700);
  const file = join(dir, 'pair.html');
  const html =
    '<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
    `<meta http-equiv="refresh" content="0;url=${url}"><title>claude-usage pair</title>` +
    `<p><a href="${url}">Open the pairing page</a></p>\n`;
  writeFileSync(file, html, { mode: 0o600, flag: 'wx' });
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

function defaultOpen(platform: string): (file: string) => Promise<void> {
  return (file) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(platform === 'darwin' ? 'open' : 'xdg-open', [file], { stdio: 'ignore', detached: true });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
}

/** Enter, Ctrl-C, or the timeout — whichever comes first. */
function defaultWaitUntilDone(timeoutMs = PAIR_PAGE_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    const stdin = process.stdin;
    const done = (): void => {
      clearTimeout(timer);
      process.removeListener('SIGINT', done);
      stdin.removeListener('data', done);
      stdin.pause();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    process.once('SIGINT', done);
    if (stdin.isTTY === true) {
      stdin.resume();
      stdin.once('data', done);
    }
  });
}

export async function runPair(io: PairIO): Promise<number> {
  const configDir = io.configDir ?? resolveConfigDir();
  const token = loadConfig(configDir).auth.token;
  if (token.length === 0) {
    io.stderr('claude-usage: no bearer token yet — run `claude-usage install` first\n');
    return 1;
  }

  const client = io.client ?? new DaemonClient({ configDir, token });
  let minted: PairCodeBody;
  try {
    minted = (await client.post('/v1/pair/code')) as PairCodeBody;
  } catch (err) {
    const hint = err instanceof DaemonUnreachable ? (err.cause as { error?: { hint?: string } } | null | undefined)?.error?.hint : undefined;
    io.stderr(`claude-usage: could not mint a pairing code — ${(err as Error).message}\n`);
    if (hint !== undefined) io.stderr(`  ${hint}\n`);
    else if (err instanceof DaemonUnreachable && err.status === undefined) io.stderr('  is the daemon running? `claude-usage status`\n');
    return 1;
  }

  const html = renderPairPage({
    link: minted.link,
    name: minted.name,
    expiresAt: minted.expiresAt,
    testflightUrl: io.testflightUrl ?? TESTFLIGHT_URL,
  });
  const page = await startPairPage(html);
  let redirect: RedirectFile | null = null;
  try {
    redirect = writeRedirectFile(page.url);
    io.stdout(`pairing ${minted.name} — reachable at ${minted.addrs.join(', ')} (HTTPS port ${String(minted.port)})\n`);
    try {
      await (io.open ?? defaultOpen(String(io.platform ?? process.platform)))(redirect.file);
      io.stdout('opened the pairing page in your browser — it can be viewed once.\n');
    } catch {
      io.stdout(`open this file in a browser on this machine (the page can be viewed once):\n  ${redirect.file}\n`);
    }
    io.stdout('press Enter when the phone is paired (the page closes by itself in 5 minutes)\n');
    await (io.waitUntilDone ?? (() => defaultWaitUntilDone()))();
  } finally {
    redirect?.remove();
    await page.close();
  }
  return 0;
}

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
import { createHash, randomBytes } from 'node:crypto';
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
  client?: { post(path: string, body?: unknown): Promise<unknown>; get(path: string): Promise<unknown> };
  /** Opens the redirect file (a path, never the URL); defaults to `open` / `xdg-open`. */
  open?: (file: string) => Promise<void>;
  /** Resolves when the user is done (Enter, Ctrl-C or the timeout by default) or `signal` aborts. */
  waitUntilDone?: (signal: AbortSignal) => Promise<void>;
  /** Injected in tests; default {@link PAIR_POLL_MS} / {@link PAIR_LINGER_MS}. */
  pollMs?: number;
  lingerMs?: number;
  testflightUrl?: string;
  platform?: NodeJS.Platform | string;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * The page's only script: copy the link, and count down to the code's expiry. Static, so the
 * CSP allows it by hash rather than opening `script-src` up (§23.52).
 */
export const PAIR_PAGE_SCRIPT = `(() => {
  const body = document.body;
  const copy = document.getElementById('copy');
  const label = document.getElementById('copy-label');
  copy.addEventListener('click', async () => {
    const link = copy.dataset.link;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const t = document.createElement('textarea');
      t.value = link;
      t.setAttribute('readonly', '');
      t.style.position = 'fixed';
      t.style.opacity = '0';
      body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    copy.classList.add('done');
    label.textContent = 'Copied';
    setTimeout(() => {
      copy.classList.remove('done');
      label.textContent = 'Copy link';
    }, 2000);
  });

  // Once the code is used, expired or the page server is gone, the QR and the link leave the
  // page entirely — not just hidden — so nothing on screen is worth photographing.
  let ended = false;
  const end = (state, title) => {
    if (ended) return;
    ended = true;
    clearInterval(poll);
    clearInterval(timer);
    document.querySelector('.qr')?.remove();
    copy.remove();
    body.classList.add(state);
    document.title = title;
  };

  const left = document.getElementById('left');
  const expires = Date.parse(body.dataset.expires);
  const tick = () => {
    if (Number.isNaN(expires)) return;
    const s = Math.max(0, Math.round((expires - Date.now()) / 1000));
    left.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    if (s === 0) end('expired', 'Code expired · Usage Deck');
  };
  const timer = setInterval(tick, 1000);
  tick();

  let misses = 0;
  const check = async () => {
    try {
      const res = await fetch(location.pathname + '/status', { cache: 'no-store' });
      const { state } = await res.json();
      misses = 0;
      if (state === 'paired') end('paired', 'Paired \\u2713 · Usage Deck');
      else if (state === 'expired') end('expired', 'Code expired · Usage Deck');
    } catch {
      misses += 1;
      if (misses >= 3) end('closed', 'Pairing closed · Usage Deck');
    }
  };
  const poll = setInterval(check, 1000);
})();`;

export const PAIR_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; " +
  `script-src 'sha256-${createHash('sha256').update(PAIR_PAGE_SCRIPT).digest('base64')}'; ` +
  "connect-src 'self'; base-uri 'none'; form-action 'none'";

const COPY_ICON =
  '<svg class="i-copy" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"/></svg>' +
  '<svg class="i-done" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** The deck's gauge mark: a 5 h ring two-thirds full. */
const MARK =
  '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12" class="track"/>' +
  '<circle cx="16" cy="16" r="12" class="arc" pathLength="100" stroke-dasharray="67 100" transform="rotate(-90 16 16)"/></svg>';

/**
 * Styled on the app's own theme (`SharedUI/Theme.swift` on `usage-ios`): the deck's near-black
 * ground with its green-and-indigo aurora, translucent surface cards, Barlow Condensed headings
 * and IBM Plex text where installed. Everything is inline — the page loads nothing from anywhere.
 */
export function renderPairPage(p: { link: string; name: string; expiresAt: string; testflightUrl: string }): string {
  const name = escapeHtml(p.name);
  const expires = new Date(p.expiresAt);
  const valid = !Number.isNaN(expires.getTime());
  const until = valid ? `at ${expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'in 5 minutes';
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
<meta name="color-scheme" content="dark">
<title>Pair ${name} · Usage Deck</title>
<style>
:root {
  --ground: #0e1013; --surface: rgba(22, 26, 32, .72); --line: #262d37; --text: #e8ebef; --muted: #8b95a3;
  --ok: #3dbe8b; --warn: #f0b429; --crit: #e5484d; --accent: #8c9bff;
  --head: "Barlow Condensed", "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif;
  --body: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { background: var(--ground); }
body {
  margin: 0; min-height: 100vh; color: var(--text); font: 16px/1.55 var(--body);
  background:
    radial-gradient(48rem 34rem at -8% -12%, rgba(61, 190, 139, .30), transparent 62%),
    radial-gradient(40rem 30rem at 108% 4%, rgba(140, 155, 255, .16), transparent 60%),
    radial-gradient(44rem 34rem at 104% 110%, rgba(61, 190, 139, .16), transparent 60%),
    var(--ground);
  background-attachment: fixed;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 32rem; margin: 0 auto; padding: 2.5rem 1rem 3rem; }
.brand { display: flex; align-items: center; gap: .5rem; color: var(--muted); font: 600 .8rem/1 var(--head); letter-spacing: .16em; text-transform: uppercase; }
.mark { width: 1.35rem; height: 1.35rem; }
.mark circle { fill: none; stroke-width: 4; }
.mark .track { stroke: var(--line); }
.mark .arc { stroke: var(--ok); stroke-linecap: round; filter: drop-shadow(0 0 3px rgba(61, 190, 139, .7)); }
h1 { font: 600 2.6rem/1.05 var(--head); letter-spacing: .01em; margin: 1rem 0 .35rem; overflow-wrap: anywhere; }
.sub { color: var(--muted); margin: 0 0 1.5rem; }
.sub b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
.card {
  background: var(--surface); border: 1px solid rgba(255, 255, 255, .06); border-radius: 24px;
  -webkit-backdrop-filter: blur(24px) saturate(1.4); backdrop-filter: blur(24px) saturate(1.4);
}
.pair { padding: 1.25rem; text-align: center; }
.qr {
  background: #fff; border-radius: 18px; padding: 14px; width: min(100%, 20rem); margin: 0 auto;
  box-shadow: 0 0 0 1px rgba(61, 190, 139, .35), 0 0 32px rgba(61, 190, 139, .22);
  transition: opacity .4s, filter .4s;
}
.qr svg { display: block; width: 100%; height: auto; }
.or { color: var(--muted); font-size: .9rem; margin: 1.1rem 0 .6rem; }
button.copy {
  display: inline-flex; align-items: center; gap: .5rem; cursor: pointer;
  font: 600 .95rem/1 var(--body); color: var(--text);
  padding: .7rem 1.15rem; border-radius: 999px; border: 1px solid rgba(255, 255, 255, .12);
  background: linear-gradient(180deg, rgba(255, 255, 255, .10), rgba(255, 255, 255, .04));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .12);
  transition: background .2s, border-color .2s, color .2s, transform .1s;
}
button.copy:hover { border-color: rgba(140, 155, 255, .5); background: rgba(140, 155, 255, .14); }
button.copy:active { transform: scale(.97); }
button.copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
button.copy svg { width: 1.1rem; height: 1.1rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
button.copy .i-done { display: none; }
button.copy.done { color: var(--ok); border-color: rgba(61, 190, 139, .55); background: rgba(61, 190, 139, .12); }
button.copy.done .i-copy { display: none; }
button.copy.done .i-done { display: inline; }
ol.steps { list-style: none; counter-reset: step; padding: 0; margin: 1.5rem 0; }
ol.steps li { counter-increment: step; position: relative; padding: .1rem 0 .1rem 2.4rem; margin: .85rem 0; }
ol.steps li::before {
  content: counter(step); position: absolute; left: 0; top: 0; width: 1.65rem; height: 1.65rem; border-radius: 50%;
  display: grid; place-items: center; font: 600 .95rem/1 var(--head); color: var(--accent);
  background: rgba(140, 155, 255, .12); border: 1px solid rgba(140, 155, 255, .35);
}
b { font-weight: 600; }
code { font: .9em var(--mono); background: rgba(255, 255, 255, .06); border: 1px solid var(--line); border-radius: 6px; padding: .05em .35em; }
.warn { padding: .85rem 1rem; border-radius: 16px; background: rgba(240, 180, 41, .08); border: 1px solid rgba(240, 180, 41, .28); color: var(--text); margin: 0; }
.warn::before { content: "\\26A0\\FE0E"; color: var(--warn); margin-right: .45rem; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
footer { margin-top: 2rem; color: var(--muted); font-size: .85rem; }
.ended { display: none; padding: 2.25rem 1.25rem; margin-top: 1.25rem; text-align: center; }
.ended h2 { font: 600 2rem/1.1 var(--head); margin: 1rem 0 .4rem; }
.ended p { color: var(--muted); margin: 0; }
.tick { width: 4.5rem; height: 4.5rem; margin: 0 auto; border-radius: 50%; display: grid; place-items: center;
  background: rgba(61, 190, 139, .14); border: 1px solid rgba(61, 190, 139, .5); box-shadow: 0 0 36px rgba(61, 190, 139, .35);
  animation: pop .5s cubic-bezier(.2, 1.4, .4, 1) both; }
.tick svg { width: 2.4rem; height: 2.4rem; fill: none; stroke: var(--ok); stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round;
  stroke-dasharray: 24; stroke-dashoffset: 24; animation: draw .45s .2s ease-out forwards; }
@keyframes pop { from { transform: scale(.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes draw { to { stroke-dashoffset: 0; } }
body.paired .pair, body.paired .steps, body.paired .warn, body.paired .sub,
body.expired .pair, body.expired .steps, body.expired .warn, body.expired .sub,
body.closed .pair, body.closed .steps, body.closed .warn, body.closed .sub { display: none; }
body.paired #paired, body.expired #expired, body.closed #closed { display: block; }
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
  .tick, .tick svg { animation: none; stroke-dashoffset: 0; }
}
</style>
</head>
<body data-expires="${valid ? expires.toISOString() : ''}">
<main>
<div class="brand">${MARK}<span>Usage Deck</span></div>
<h1>Pair ${name}</h1>
<p class="sub">This code works once and expires ${until}${valid ? ' · <b id="left"></b> left' : '<b id="left" hidden></b>'}.</p>
<section class="card pair">
<div class="qr">${qrSvg(p.link)}</div>
<p class="or">or copy the pairing link</p>
<button type="button" class="copy" id="copy" data-link="${escapeHtml(p.link)}" aria-label="Copy the pairing link">${COPY_ICON}<span id="copy-label">Copy link</span></button>
</section>
<section class="card ended" id="paired" role="status">
<div class="tick"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
<h2>Pairing successful</h2>
<p>It is now safe to close this tab.</p>
</section>
<section class="card ended" id="expired" role="status">
<h2>This code has expired</h2>
<p>Run <code>claude-usage pair</code> again for a new one.</p>
</section>
<section class="card ended" id="closed" role="status">
<h2>Pairing closed</h2>
<p>Run <code>claude-usage pair</code> again if you still need a code.</p>
</section>
<ol class="steps">
${install}
<li>Make sure the iPhone is on the same Wi-Fi as this device (or on your Tailscale network).</li>
<li>Point the iPhone Camera at the code and tap <b>Open in Usage Deck</b>, or scan it from inside the app. Copied the link instead? Paste it on the app's <b>Pair a device</b> screen.</li>
</ol>
<p class="warn">Treat this like a password; if it was shown on a call, run <code>claude-usage pair</code> again.</p>
<footer>claude-usage · <a href="${GITHUB_URL}">${GITHUB_URL.replace('https://', '')}</a> · close this tab when you are done.</footer>
</main>
<script>${PAIR_PAGE_SCRIPT}</script>
</body>
</html>
`;
}

const NO_STORE = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** What the open page shows (§23.52): the QR, or the end of pairing. */
export type PairPageState = 'pending' | 'paired' | 'expired';

/**
 * Answer `path` once, to a loopback peer, with `html`; answer `path/status` (loopback, any number
 * of times) with the page's state, so it can swap the QR for "Pairing successful"; 404
 * everything else.
 */
export function createPairPageHandler(
  path: string,
  html: string,
  state: () => PairPageState = () => 'pending',
): (req: IncomingMessage, res: ServerResponse) => void {
  let served = false;
  return (req, res) => {
    const loopback = isLoopbackAddress(req.socket.remoteAddress);
    if (loopback && req.method === 'GET' && req.url === `${path}/status`) {
      res.writeHead(200, { ...NO_STORE, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ state: state() }));
      return;
    }
    const ok = !served && loopback && req.method === 'GET' && req.url === path;
    if (!ok) {
      res.writeHead(404, { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    served = true;
    res.writeHead(200, {
      ...NO_STORE,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': PAIR_PAGE_CSP,
    });
    res.end(html);
  };
}

export interface PairPage {
  url: string;
  setState(state: PairPageState): void;
  close(): Promise<void>;
}

/** Serve `html` once from 127.0.0.1 at a random 128-bit path. */
export async function startPairPage(html: string): Promise<PairPage> {
  const path = `/${randomBytes(16).toString('hex')}`;
  let state: PairPageState = 'pending';
  const server: Server = createServer(createPairPageHandler(path, html, () => state));
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  return {
    url: `http://127.0.0.1:${String(port)}${path}`,
    setState: (next) => {
      state = next;
    },
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

/** Enter, Ctrl-C, the timeout, or `signal` — whichever comes first. */
function defaultWaitUntilDone(signal: AbortSignal, timeoutMs = PAIR_PAGE_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    const stdin = process.stdin;
    const done = (): void => {
      clearTimeout(timer);
      process.removeListener('SIGINT', done);
      signal.removeEventListener('abort', done);
      stdin.removeListener('data', done);
      stdin.pause();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    process.once('SIGINT', done);
    signal.addEventListener('abort', done);
    if (stdin.isTTY === true) {
      stdin.resume();
      stdin.once('data', done);
    }
  });
}

/** How often `claude-usage pair` asks the daemon whether the phone has used the code. */
export const PAIR_POLL_MS = 1_000;
/** How long the page server stays up after pairing, so the open page sees it (it polls each second). */
export const PAIR_LINGER_MS = 3_000;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Poll `GET /v1/pair/code` until the code is used or expires (§23.52). Errors are ignored — an
 * older daemon without the route, or one mid-restart — and the user can still press Enter.
 */
async function watchCode(
  client: { get(path: string): Promise<unknown> },
  signal: AbortSignal,
  pollMs: number,
): Promise<'redeemed' | 'expired' | null> {
  while (!signal.aborted) {
    try {
      const { state } = (await client.get('/v1/pair/code')) as { state?: string };
      if (state === 'redeemed' || state === 'expired') return state;
    } catch {
      // keep waiting
    }
    await sleep(pollMs, signal);
  }
  return null;
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
  const stop = new AbortController();
  let outcome: 'redeemed' | 'expired' | null = null;
  try {
    redirect = writeRedirectFile(page.url);
    io.stdout(`pairing ${minted.name} — reachable at ${minted.addrs.join(', ')} (HTTPS port ${String(minted.port)})\n`);
    try {
      await (io.open ?? defaultOpen(String(io.platform ?? process.platform)))(redirect.file);
      io.stdout('opened the pairing page in your browser — it can be viewed once.\n');
    } catch {
      io.stdout(`open this file in a browser on this machine (the page can be viewed once):\n  ${redirect.file}\n`);
    }
    io.stdout('waiting for the phone… (Enter to stop; the code expires in 5 minutes)\n');
    const watched = watchCode(client, stop.signal, io.pollMs ?? PAIR_POLL_MS).then((state) => {
      outcome = state;
      stop.abort();
    });
    await (io.waitUntilDone ?? defaultWaitUntilDone)(stop.signal);
    stop.abort();
    await watched;
    if (outcome === 'redeemed') {
      page.setState('paired');
      io.stdout(`paired ✓ — the phone is connected to ${minted.name}. You can close the browser tab.\n`);
      await sleep(io.lingerMs ?? PAIR_LINGER_MS);
    } else if (outcome === 'expired') {
      page.setState('expired');
      io.stdout('the code expired before a phone used it — run `claude-usage pair` again\n');
      await sleep(io.lingerMs ?? PAIR_LINGER_MS);
    }
  } finally {
    stop.abort();
    redirect?.remove();
    await page.close();
  }
  return outcome === 'expired' ? 1 : 0;
}

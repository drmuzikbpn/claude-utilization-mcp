import { connect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RawRequestOptions {
  port: number;
  host?: string;
  method?: string;
  path?: string;
  /** Headers written verbatim — including `Host`, which `fetch` refuses to override. */
  headers?: Record<string, string>;
  /** Request body; `content-length` is added automatically. */
  body?: string;
  /** Speak HTTPS. The daemon's cert is self-signed and pinned, so it is not CA-verified here. */
  tls?: boolean;
}

/** Minimal HTTP/1.1 client so tests can set forbidden headers such as `Host`. */
export function rawRequest(opts: RawRequestOptions): Promise<RawResponse> {
  const method = opts.method ?? 'GET';
  const path = opts.path ?? '/';
  const headers: Record<string, string> = { host: `127.0.0.1:${opts.port}`, connection: 'close', ...opts.headers };
  if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
  const lines = [`${method} ${path} HTTP/1.1`];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  const payload = `${lines.join('\r\n')}\r\n\r\n${opts.body ?? ''}`;

  return new Promise<RawResponse>((resolve, reject) => {
    const host = opts.host ?? '127.0.0.1';
    const send = (): void => {
      socket.write(payload);
    };
    const socket: Socket =
      opts.tls === true
        ? tlsConnect({ port: opts.port, host, rejectUnauthorized: false }, send)
        : connect(opts.port, host, send);
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const head = split === -1 ? text : text.slice(0, split);
      const body = split === -1 ? '' : text.slice(split + 4);
      const [statusLine, ...headerLines] = head.split('\r\n');
      const status = Number((statusLine ?? '').split(' ')[1] ?? 0);
      const parsed: Record<string, string> = {};
      for (const line of headerLines) {
        const i = line.indexOf(':');
        if (i > 0) parsed[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status, headers: parsed, body });
    });
  });
}

export async function rawJson(opts: RawRequestOptions): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await rawRequest(opts);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

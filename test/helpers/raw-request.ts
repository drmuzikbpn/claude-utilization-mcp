import { connect } from 'node:net';

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
}

/** Minimal HTTP/1.1 client so tests can set forbidden headers such as `Host`. */
export function rawRequest(opts: RawRequestOptions): Promise<RawResponse> {
  const method = opts.method ?? 'GET';
  const path = opts.path ?? '/';
  const headers = { host: `127.0.0.1:${opts.port}`, connection: 'close', ...opts.headers };
  const lines = [`${method} ${path} HTTP/1.1`];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  const payload = `${lines.join('\r\n')}\r\n\r\n`;

  return new Promise<RawResponse>((resolve, reject) => {
    const socket = connect(opts.port, opts.host ?? '127.0.0.1', () => {
      socket.write(payload);
    });
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

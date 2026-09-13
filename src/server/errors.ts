import type { ServerResponse } from 'node:http';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'misdirected_request'
  | 'rate_limited'
  | 'internal_error';

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; hint?: string };
}

/** The one error envelope used by every non-2xx response (§4, plan "Shared contracts"). */
export function errorEnvelope(code: ErrorCode, message: string, hint?: string): ErrorEnvelope {
  return { error: hint === undefined ? { code, message } : { code, message, hint } };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // Never let a browser or proxy hold on to usage data.
    'cache-control': 'no-store',
    // No CORS headers are ever sent (§16).
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, code: ErrorCode, message: string, hint?: string): void {
  sendJson(res, status, errorEnvelope(code, message, hint));
}

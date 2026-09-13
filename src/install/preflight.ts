import { getAccessToken } from '../credentials/index.js';

/**
 * Install preflight (§8 step 1).
 *
 * Node < 20 is a **warning**, not a failure: the 2026-09-13 audit found the daemon
 * runs on older majors and a hard stop only pushes people to install by hand. An
 * unsupported platform is a real failure — there is no credential source and no
 * service manager. Unreadable credentials are a warning: the daemon still runs and
 * `/v1/limits` reports `no_credentials` (§10).
 */

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface PreflightCheck {
  name: string;
  level: CheckLevel;
  message: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  /** False when any check failed — install stops. */
  ok: boolean;
}

export const MIN_NODE_MAJOR = 20;
export const SUPPORTED_PLATFORMS = ['darwin', 'linux'] as const;

export const KEYCHAIN_NOTICE =
  'macOS will now ask for permission to read the "Claude Code-credentials" Keychain item — claude-usage reads the OAuth token to call GET /api/oauth/usage, and never stores or prints it.';

export interface PreflightOptions {
  /** Defaults to `process.version`. */
  nodeVersion?: string;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform | string;
  /** Printed before the first credential read, so the Keychain prompt is never a surprise. */
  notify?: (line: string) => void;
  /** Injected in tests; defaults to the real credential lookup. */
  readCredentials?: () => Promise<string>;
}

export function parseNodeMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim());
  const raw = m?.[1];
  return raw === undefined ? null : Number.parseInt(raw, 10);
}

export async function preflight(opts: PreflightOptions = {}): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const nodeVersion = opts.nodeVersion ?? process.version;
  const platform = String(opts.platform ?? process.platform);
  const notify = opts.notify ?? ((): void => undefined);

  const major = parseNodeMajor(nodeVersion);
  if (major === null) {
    checks.push({ name: 'node', level: 'warn', message: `could not parse the Node version "${nodeVersion}"` });
  } else if (major < MIN_NODE_MAJOR) {
    checks.push({
      name: 'node',
      level: 'warn',
      message: `Node ${nodeVersion} is below the supported v${String(MIN_NODE_MAJOR)} — install will continue, but upgrade when you can`,
    });
  } else {
    checks.push({ name: 'node', level: 'ok', message: `Node ${nodeVersion}` });
  }

  if ((SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
    checks.push({ name: 'platform', level: 'ok', message: platform });
  } else {
    checks.push({
      name: 'platform',
      level: 'fail',
      message: `platform "${platform}" is not supported — claude-usage runs on macOS and Linux`,
    });
    // No point prompting for credentials we cannot read.
    return { checks, ok: false };
  }

  if (platform === 'darwin') notify(KEYCHAIN_NOTICE);
  const read = opts.readCredentials ?? ((): Promise<string> => getAccessToken({ platform }));
  try {
    await read();
    checks.push({ name: 'credentials', level: 'ok', message: 'Claude Code OAuth token is readable' });
  } catch (err) {
    const e = err as Error & { hint?: string };
    const hint = typeof e.hint === 'string' && e.hint.length > 0 ? ` (${e.hint})` : '';
    checks.push({
      name: 'credentials',
      level: 'warn',
      message: `${e.message}${hint} — the daemon still runs; /v1/limits will report no_credentials`,
    });
  }

  return { checks, ok: !checks.some((c) => c.level === 'fail') };
}

/** One line per check, prefixed with a status glyph. */
export function renderPreflight(result: PreflightResult): string {
  const glyph: Record<CheckLevel, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  return result.checks.map((c) => `  [${glyph[c.level]}] ${c.name}: ${c.message}`).join('\n') + '\n';
}

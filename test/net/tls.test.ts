import { describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CERT_VALIDITY_DAYS,
  loadOrCreateTlsIdentity,
  readTlsFingerprint,
  REISSUE_WITHIN_DAYS,
  TLS_CERT_FILE,
  TLS_KEY_FILE,
} from '../../src/net/tls.js';

const DAY = 86_400_000;

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'cu-tls-'));
}

describe('loadOrCreateTlsIdentity (§23.45)', () => {
  it('creates a 0600 key and certificate on first use', () => {
    const d = dir();
    const id = loadOrCreateTlsIdentity({ configDir: d, name: 'studio', localHostName: 'studio.local' });
    expect(id.created).toBe(true);
    expect(statSync(join(d, TLS_KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, TLS_CERT_FILE)).mode & 0o777).toBe(0o600);
    const x = new X509Certificate(id.cert);
    expect(x.subject).toContain('CN=claude-usage studio');
    expect(x.checkHost('studio.local')).toBe('studio.local');
    expect(id.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(readTlsFingerprint(d)).toBe(id.fingerprint);
  });

  it('keeps the key — and so the pin — across loads', () => {
    const d = dir();
    const first = loadOrCreateTlsIdentity({ configDir: d, name: 'studio' });
    const second = loadOrCreateTlsIdentity({ configDir: d, name: 'studio' });
    expect(second.created).toBe(false);
    expect(second.reissued).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.cert).toBe(first.cert);
  });

  it('re-issues a certificate near expiry with the same key, so the pin survives', () => {
    const d = dir();
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    const first = loadOrCreateTlsIdentity({ configDir: d, name: 'studio', now: () => t0 });
    const later = t0 + (CERT_VALIDITY_DAYS - REISSUE_WITHIN_DAYS + 1) * DAY;
    const second = loadOrCreateTlsIdentity({ configDir: d, name: 'studio', now: () => later });
    expect(second.reissued).toBe(true);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(new Date(new X509Certificate(second.cert).validTo).getTime()).toBeGreaterThan(later + 700 * DAY);
  });

  it('re-issues an unreadable certificate with the same key', () => {
    const d = dir();
    const first = loadOrCreateTlsIdentity({ configDir: d, name: 'studio' });
    writeFileSync(join(d, TLS_CERT_FILE), 'garbage', { mode: 0o600 });
    const second = loadOrCreateTlsIdentity({ configDir: d, name: 'studio' });
    expect(second.reissued).toBe(true);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(readFileSync(join(d, TLS_CERT_FILE), 'utf8')).toContain('BEGIN CERTIFICATE');
  });

  it('re-issues a certificate that does not match the key', () => {
    const a = dir();
    const b = dir();
    loadOrCreateTlsIdentity({ configDir: a, name: 'a' });
    const bId = loadOrCreateTlsIdentity({ configDir: b, name: 'b' });
    writeFileSync(join(b, TLS_CERT_FILE), readFileSync(join(a, TLS_CERT_FILE)), { mode: 0o600 });
    const again = loadOrCreateTlsIdentity({ configDir: b, name: 'b' });
    expect(again.reissued).toBe(true);
    expect(again.fingerprint).toBe(bId.fingerprint);
  });

  it('readTlsFingerprint is null before any identity exists', () => {
    expect(readTlsFingerprint(dir())).toBeNull();
  });
});

/**
 * A minimal DER writer for one thing: a self-signed ECDSA P-256 X.509 v3 server
 * certificate (§23.45). Stdlib only — the daemon has no runtime dependencies.
 *
 * Clients pin the SubjectPublicKeyInfo, not the certificate, so everything here except the
 * key is cosmetic to them. It still follows Apple's TLS server-certificate rules (SAN,
 * `serverAuth` EKU, ≤ 825 days) so code that evaluates it normally gets a sane answer.
 */
import { createHash, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { isIPv4 } from 'node:net';

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

/** DER definite length. */
export function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

const seq = (...items: Buffer[]): Buffer => tlv(0x30, ...items);
const set = (...items: Buffer[]): Buffer => tlv(0x31, ...items);
const octets = (b: Buffer): Buffer => tlv(0x04, b);
/** BIT STRING with no unused bits. */
const bits = (b: Buffer): Buffer => tlv(0x03, Buffer.from([0]), b);

/** Non-negative INTEGER from big-endian bytes. */
function integer(bytes: Buffer): Buffer {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i += 1;
  let body = bytes.subarray(i);
  if (body.length === 0) body = Buffer.from([0]);
  if ((body[0] ?? 0) & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

export function encodeOid(oid: string): Buffer {
  const arcs = oid.split('.').map(Number);
  const [a = 0, b = 0, ...rest] = arcs;
  const out: number[] = [a * 40 + b];
  for (const arc of rest) {
    const chunk: number[] = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime through 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5). */
function time(d: Date): Buffer {
  const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const digits = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(digits.slice(2), 'ascii')) : tlv(0x18, Buffer.from(digits, 'ascii'));
}

function name(commonName: string): Buffer {
  return seq(set(seq(encodeOid(OID_COMMON_NAME), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return critical ? seq(encodeOid(oid), tlv(0x01, Buffer.from([0xff])), octets(value)) : seq(encodeOid(oid), octets(value));
}

function subjectAltName(dnsNames: readonly string[], ipAddresses: readonly string[]): Buffer {
  const entries = [
    ...dnsNames.map((n) => tlv(0x82, Buffer.from(n, 'ascii'))),
    ...ipAddresses.filter((ip) => isIPv4(ip)).map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))),
  ];
  return seq(...entries);
}

export interface CertOptions {
  privateKey: KeyObject;
  publicKey: KeyObject;
  commonName: string;
  dnsNames: readonly string[];
  ipAddresses: readonly string[];
  notBefore: Date;
  notAfter: Date;
  /** 16 random bytes when omitted. */
  serial?: Buffer;
}

/** A DER-encoded, self-signed X.509 v3 certificate for `publicKey`, signed by `privateKey`. */
export function buildSelfSignedCert(opts: CertOptions): Buffer {
  const algorithm = seq(encodeOid(OID_ECDSA_SHA256));
  const serial = Buffer.from(opts.serial ?? randomBytes(16));
  serial[0] = (serial[0] ?? 0) & 0x7f; // positive, and no leading-zero byte needed
  const subject = name(opts.commonName);
  const extensions = seq(
    extension(OID_BASIC_CONSTRAINTS, true, seq()), // cA defaults to FALSE
    extension(OID_KEY_USAGE, true, tlv(0x03, Buffer.from([7, 0x80]))), // digitalSignature
    extension(OID_EXT_KEY_USAGE, false, seq(encodeOid(OID_SERVER_AUTH))),
    extension(OID_SUBJECT_ALT_NAME, false, subjectAltName(opts.dnsNames, opts.ipAddresses)),
  );
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    algorithm,
    subject,
    seq(time(opts.notBefore), time(opts.notAfter)),
    subject,
    opts.publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, extensions),
  );
  // ECDSA signatures come back DER-encoded (`dsaEncoding: 'der'` is the default).
  const signature = sign('sha256', tbs, opts.privateKey);
  return seq(tbs, algorithm, bits(signature));
}

export function derToPem(der: Buffer, label: string): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** The pin (§23.45): lowercase hex SHA-256 of the SubjectPublicKeyInfo DER. */
export function spkiFingerprint(key: KeyObject | X509Certificate): string {
  const publicKey = key instanceof X509Certificate ? key.publicKey : key;
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

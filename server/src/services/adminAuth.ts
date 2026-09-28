import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Admin authentication primitives.
 *
 * Passwords: scrypt (N=2^15, r=8, p=1, 64-byte key, 16-byte salt), stored as
 *   scrypt:<N>:<r>:<p>:<salt b64url>:<hash b64url>
 * Colons, not `$`, so the value survives shells, .env files and systemd
 * unexpanded. Only this hash is configured (ADMIN_PASSWORD_HASH); the
 * password itself is never stored anywhere.
 *
 * Sessions: stateless HMAC-SHA256 tokens `v1.<expiry>.<mac>` carried in an
 * HttpOnly, SameSite=Strict cookie. Rotating ADMIN_SESSION_SECRET signs
 * everyone out.
 */

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAXMEM = 64 * 1024 * 1024;
export const PASSWORD_MIN_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAXMEM });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  // Bound attacker-irrelevant but config-controlled parameters to sane ranges.
  const N = Number(n);
  if (!Number.isInteger(N) || N < 2 ** 14 || N > 2 ** 20 || expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password.slice(0, 1024), Buffer.from(saltB64, 'base64url'), KEY_LENGTH, {
    N,
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

const mac = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

export function createSessionToken(secret: string, ttlMs: number, now = Date.now()): string {
  const payload = `v1.${(now + ttlMs).toString(36)}`;
  return `${payload}.${mac(secret, payload)}`;
}

export function verifySessionToken(token: string | undefined, secret: string, now = Date.now()): boolean {
  if (!token || token.length > 200) return false;
  const lastDot = token.lastIndexOf('.');
  if (lastDot < 0) return false;
  const payload = token.slice(0, lastDot);
  const provided = Buffer.from(token.slice(lastDot + 1));
  const expected = Buffer.from(mac(secret, payload));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false;
  const [version, expiry] = payload.split('.');
  if (version !== 'v1' || !expiry) return false;
  const expiresAt = parseInt(expiry, 36);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/** Minimal Cookie header parser (no dependency): returns the named cookie's value. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

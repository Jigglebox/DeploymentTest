// Small, dependency-free primitives: secret sealing (AES-256-GCM), password hashing (scrypt), signed tokens (HMAC).
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const keyFromHex = (hex) => { const k = Buffer.from(String(hex ?? ''), 'hex'); if (k.length !== 32) throw new Error('master key must be 32 bytes hex (64 chars)'); return k; };

/** Encrypt a secret for storage. Output: base64(iv | tag | ciphertext). */
export function seal(plaintext, masterKeyHex) {
  const key = keyFromHex(masterKeyHex), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function unseal(sealed, masterKeyHex) {
  const key = keyFromHex(masterKeyHex), buf = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(String(password), salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored ?? '').split('$');
  if (!saltHex || !hashHex) return false;
  const a = scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64), b = Buffer.from(hashHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Compact signed token: base64url(json).base64url(hmac). Carries its own expiry. */
export function signToken(payload, secret, ttlSec = 7 * 86400) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verifyToken(token, secret) {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.exp > Date.now() / 1000 ? p : null; } catch { return null; }
}

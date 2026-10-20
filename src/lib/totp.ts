/**
 * Two-step sign-in codes (RFC 6238 TOTP: 6 digits, 30 seconds, SHA-1), the kind every authenticator app
 * (Google Authenticator, 1Password, Authy, Microsoft Authenticator) understands. Web Crypto only.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;

export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export const newTotpSecret = (): string => base32(crypto.getRandomValues(new Uint8Array(20)));

export async function totpCode(secret: string, step: number): Promise<string> {
  const counter = new Uint8Array(8);
  let n = step;
  for (let i = 7; i >= 0; i--) {
    counter[i] = n & 255;
    n = Math.floor(n / 256);
  }
  const key = await crypto.subtle.importKey('raw', fromBase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

/**
 * The time step a code belongs to (allowing one step of clock drift either way), or null.
 * Callers store the step and refuse it again, so a code can't be replayed.
 */
export async function verifyTotp(secret: string, code: string, atMs: number, lastUsedStep = -1): Promise<number | null> {
  const digits = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const now = stepAt(atMs);
  for (const step of [now, now - 1, now + 1]) {
    if (step <= lastUsedStep) continue;
    if ((await totpCode(secret, step)) === digits) return step;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer: string): string {
  // %20 for spaces everywhere: some authenticator apps show a "+" from form-style encoding literally.
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(account)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

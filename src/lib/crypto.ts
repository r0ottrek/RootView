/**
 * Optional encryption at rest for stored secrets (the Google refresh token, admins' two-step sign-in keys).
 *
 * Set ENCRYPTION_KEY to 32 random bytes, base64 (`openssl rand -base64 32`). Values are then sealed with
 * AES-256-GCM as "enc:v1:<iv>:<ciphertext>". Without the key, values are stored as-is (D1 itself is
 * encrypted at rest by Cloudflare; this adds protection if a database export leaks).
 * Values written before the key was set keep working and are re-sealed the next time they are saved.
 */
import type { Env } from '../env';
import { b64url } from './util';

const PREFIX = 'enc:v1:';
const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    let raw: Uint8Array;
    try {
      raw = Uint8Array.from(atob(secret.trim()), (c) => c.charCodeAt(0));
    } catch {
      raw = new Uint8Array(0);
    }
    if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).');
    k = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keys.set(secret, k);
  }
  return k;
}

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function seal(env: Pick<Env, 'ENCRYPTION_KEY'>, plain: string): Promise<string> {
  if (!env.ENCRYPTION_KEY) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(env.ENCRYPTION_KEY), new TextEncoder().encode(plain));
  return `${PREFIX}${b64url(iv)}:${b64url(new Uint8Array(ct))}`;
}

export async function open(env: Pick<Env, 'ENCRYPTION_KEY'>, stored: string): Promise<string> {
  if (!stored.startsWith(PREFIX)) return stored;
  if (!env.ENCRYPTION_KEY) throw new Error('This value is encrypted, but ENCRYPTION_KEY is not set on the server.');
  const [iv, ct] = stored.slice(PREFIX.length).split(':');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) }, await keyFor(env.ENCRYPTION_KEY), fromB64url(ct));
  return new TextDecoder().decode(plain);
}

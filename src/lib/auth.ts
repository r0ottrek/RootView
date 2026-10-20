/**
 * Passwords, sessions, CSRF protection and throttling.
 *
 * Three kinds of session, each with its own cookie, so an office login and a tech login never mix:
 *   admin  office dashboard (/admin), 14 days
 *   tech   tech app (/me), 90 days
 *   mfa    password checked, waiting for the two-step code, 5 minutes
 * Cookies are __Host- prefixed (Secure, Path=/, no Domain): a sibling subdomain can't set or read them.
 * The cookie holds a random 256-bit token; only its SHA-256 is stored, so a database leak doesn't hand out sessions.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AdminUser, AppEnv, Env, Tech } from '../env';
import { one, run } from './db';
import { DAY, MINUTE, b64url, now, randomToken, sha256hex } from './util';

// ---------- passwords ----------

/**
 * PBKDF2-SHA256 rounds for new hashes. 20,000 takes about 6 ms, inside the Workers free plan's 10 ms CPU budget.
 * On Workers Paid, set PASSWORD_ITERATIONS=100000 (the most Cloudflare's Web Crypto allows); each hash stores its
 * own count and older ones are upgraded at the next successful sign-in.
 */
export const DEFAULT_ITERATIONS = 20_000;
const MAX_ITERATIONS = 100_000;

export function iterationsFor(env: Pick<Env, 'PASSWORD_ITERATIONS'>): number {
  const n = parseInt(env.PASSWORD_ITERATIONS ?? '', 10);
  return Number.isFinite(n) && n >= 10_000 ? Math.min(n, MAX_ITERATIONS) : DEFAULT_ITERATIONS;
}

export function needsRehash(stored: string, env: Pick<Env, 'PASSWORD_ITERATIONS'>): boolean {
  return (parseInt(stored.split('$')[1] ?? '0', 10) || 0) < iterationsFor(env);
}

export async function hashPassword(password: string, env: Pick<Env, 'PASSWORD_ITERATIONS'>): Promise<string> {
  const rounds = iterationsFor(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, rounds);
  return `pbkdf2$${rounds}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, saltB64, hashB64] = stored.split('$');
  const rounds = parseInt(iter, 10);
  if (scheme !== 'pbkdf2' || !saltB64 || !hashB64 || !(rounds > 0) || rounds > MAX_ITERATIONS) return false;
  const actual = await pbkdf2(password, fromB64url(saltB64), rounds);
  return equalBytes(actual, fromB64url(hashB64));
}

let dummy: Promise<string> | null = null;
/**
 * For an unknown email or username, still spend the time of a real check, so response timing doesn't
 * reveal which accounts exist.
 */
export async function verifyAgainstNobody(password: string, env: Pick<Env, 'PASSWORD_ITERATIONS'>): Promise<false> {
  dummy ??= hashPassword(randomToken(12), env);
  await verifyPassword(password, await dummy);
  return false;
}

export const PASSWORD_MIN = 10;
/** Plain-English problem with a new password, or null. */
export function passwordProblem(pw: string, min = PASSWORD_MIN): string | null {
  if (pw.length < min) return `Use at least ${min} characters.`;
  if (pw.length > 200) return 'Use 200 characters or fewer.';
  if (/^(.)\1+$/.test(pw) || /^(?:0123456789|1234567890|password|qwerty)/i.test(pw)) return 'That password is too easy to guess.';
  return null;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Compares two secrets without leaking how much of them matched through timing. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return equalBytes(new Uint8Array(ha), new Uint8Array(hb));
}

// ---------- sessions ----------

export type SessionKind = 'admin' | 'tech' | 'mfa';
export const COOKIE: Record<SessionKind, string> = { admin: '__Host-rv_admin', tech: '__Host-rv_tech', mfa: '__Host-rv_mfa' };
const LIFETIME: Record<SessionKind, number> = { admin: 14 * DAY, tech: 90 * DAY, mfa: 5 * MINUTE };
const SEEN_EVERY = 10 * MINUTE; // last_seen_at is refreshed at most this often (one write, not one per request)

/** "iPhone · Safari", for the signed-in devices list. */
export function deviceLabel(ua: string | undefined): string {
  const u = ua ?? '';
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS X|Macintosh/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'Unknown device';
  const browser = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

export async function startSession(c: Context<AppEnv>, kind: SessionKind, subjectId: string): Promise<void> {
  const token = randomToken(32);
  const t = now();
  await run(c.env.DB, `INSERT INTO sessions (id, kind, subject_id, label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    await sha256hex(token), kind, subjectId, deviceLabel(c.req.header('user-agent')), t, t, t + LIFETIME[kind]);
  setCookie(c, COOKIE[kind], token, {
    path: '/', httpOnly: true, secure: true, sameSite: kind === 'mfa' ? 'Strict' : 'Lax', maxAge: Math.floor(LIFETIME[kind] / 1000),
  });
}

export async function endSession(c: Context<AppEnv>, kind: SessionKind): Promise<void> {
  const token = getCookie(c, COOKIE[kind]);
  if (token) await run(c.env.DB, `DELETE FROM sessions WHERE id = ?`, await sha256hex(token));
  deleteCookie(c, COOKIE[kind], { path: '/', secure: true });
}

/** Signs every device out of one account, optionally keeping the current one. */
export async function revokeSessions(db: D1Database, kind: SessionKind, subjectId: string, exceptId?: string): Promise<void> {
  await run(db, `DELETE FROM sessions WHERE kind = ? AND subject_id = ? AND id <> ?`, kind, subjectId, exceptId ?? '');
}

export async function sessionFor(c: Context<AppEnv>, kind: SessionKind): Promise<{ id: string; subject_id: string } | null> {
  const token = getCookie(c, COOKIE[kind]);
  if (!token || token.length > 128) return null;
  const id = await sha256hex(token);
  const row = await one<{ subject_id: string; expires_at: number; last_seen_at: number | null }>(c.env.DB,
    `SELECT subject_id, expires_at, last_seen_at FROM sessions WHERE id = ? AND kind = ?`, id, kind);
  const t = now();
  if (!row || row.expires_at < t) return null;
  if (!row.last_seen_at || t - row.last_seen_at > SEEN_EVERY) await run(c.env.DB, `UPDATE sessions SET last_seen_at = ? WHERE id = ?`, t, id);
  return { id, subject_id: row.subject_id };
}

export async function currentAdmin(c: Context<AppEnv>): Promise<AdminUser | null> {
  const s = await sessionFor(c, 'admin');
  if (!s) return null;
  const admin = await one<AdminUser>(c.env.DB, `SELECT id, name, email, role, totp_enabled FROM admins WHERE id = ?`, s.subject_id);
  if (admin) c.set('sessionId', s.id);
  return admin;
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const admin = await currentAdmin(c);
  if (!admin) {
    const back = new URL(c.req.url);
    return c.redirect(`/admin/login?next=${encodeURIComponent(back.pathname + back.search)}`, 303);
  }
  c.set('admin', admin);
  await next();
};

export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('admin')?.role !== 'owner') return c.text('Only the owner can do that.', 403);
  await next();
};

export async function currentTech(c: Context<AppEnv>): Promise<Tech | null> {
  const s = await sessionFor(c, 'tech');
  if (!s) return null;
  const tech = await one<Tech>(c.env.DB, `SELECT * FROM techs WHERE id = ? AND active = 1`, s.subject_id);
  if (tech) c.set('sessionId', s.id);
  return tech;
}

export const requireTech: MiddlewareHandler<AppEnv> = async (c, next) => {
  const tech = await currentTech(c);
  if (!tech) return c.redirect('/me/login', 303);
  c.set('tech', tech);
  await next();
};

/** True when a state-changing request came from a page on this exact origin (or the browser didn't say). */
export function fromThisSite(c: Context<AppEnv>): boolean {
  const site = c.req.header('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = c.req.header('origin');
  // Browsers too old to send either header still send SameSite=Lax cookies only on same-site requests.
  return !origin || origin === new URL(c.req.url).origin;
}

/**
 * Blocks cross-site and sibling-subdomain form posts (CSRF). Mounted app-wide, so public forms are covered too.
 * The scheduler endpoint (/api/cron) is exempt: it is authenticated by its bearer secret instead.
 */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.path !== '/api/cron' && !fromThisSite(c)) return c.text('Forbidden', 403);
  await next();
};

// ---------- throttling ----------

const hmacKeys = new Map<string, Promise<CryptoKey>>();
/**
 * A short key for the visitor's IP address, for rate limiting only (rows are cleared daily). Keyed with a
 * server secret, so the stored value can't be reversed by hashing every IPv4 address.
 */
export async function clientKey(c: Context<AppEnv>): Promise<string> {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const secret = c.env.CRON_SECRET || c.env.SETUP_KEY || 'rootview-local';
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeys.set(secret, key);
  }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(`ip:${ip}`)));
  return b64url(mac).slice(0, 22);
}

/**
 * Counts one hit against `key` and says whether it is over `max` for the current window. One query; once a key is
 * over its limit, further hits write nothing (the conditional upsert returns no row), so a flood can't burn the
 * database's daily write allowance.
 */
export async function overLimit(db: D1Database, key: string, max: number, windowMs: number): Promise<boolean> {
  const t = now();
  const row = await one<{ count: number }>(db,
    `INSERT INTO throttle (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN window_start < ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
     WHERE window_start < ?3 OR count < ?4
     RETURNING count`,
    key, t, t - windowMs, max);
  return !row;
}

/** Sign-in throttling: check before trying a password, then record failures (a success clears the counter). */
export async function tooManyAttempts(db: D1Database, key: string, max = 8, windowMs = 15 * MINUTE): Promise<boolean> {
  const row = await one<{ count: number; window_start: number }>(db, `SELECT count, window_start FROM throttle WHERE key = ?`, key);
  return !!row && row.window_start > now() - windowMs && row.count >= max;
}

export async function recordAttempt(db: D1Database, key: string, success: boolean, windowMs = 15 * MINUTE): Promise<void> {
  if (success) {
    await run(db, `DELETE FROM throttle WHERE key = ?`, key);
    return;
  }
  const t = now();
  await run(db,
    `INSERT INTO throttle (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN window_start < ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END`,
    key, t, t - windowMs);
}

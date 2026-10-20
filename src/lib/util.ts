export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const now = () => Date.now();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function newId(prefix: string): string {
  return `${prefix}_${randomToken(10)}`;
}

export async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercase, strip accents and punctuation: "José O'Brien-Smith" → "jose obriensmith". */
export function normName(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`-]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface NameMatch {
  /** Higher sorts first: typing the start of the first name beats the start of a last name, which beats a match mid-word. */
  score: number;
  /** [start, end) character ranges in the original name to highlight. */
  ranges: [number, number][];
}

/**
 * Customer search for a tech. Every typed word must start a word of the name ("s" → Sebastian, Santo;
 * "seb gr" → Sebastian Grimes). Failing that, 3+ letters found anywhere in the name still match ("bast").
 * Accents and case don't matter. Mirrored in public/app.js for instant filtering; keep them in step.
 */
export function matchName(name: string, query: string): NameMatch | null {
  // Normalize character by character so highlight ranges map back onto the original text.
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < name.length; i++) {
    const c = name[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const ch of c) { norm += ch; map.push(i); }
  }
  const tokens = normName(query).split(' ').filter(Boolean);
  if (!tokens.length) return { score: 0, ranges: [] };
  const words = [...norm.matchAll(/[a-z0-9]+/g)].map((m) => ({ start: m.index!, text: m[0] }));
  const toOriginal = (s: number, e: number): [number, number] => [map[s], map[e - 1] + 1];

  const used = new Set<number>();
  const ranges: [number, number][] = [];
  let score = 0;
  for (const tok of tokens) {
    const wi = words.findIndex((w, i) => !used.has(i) && w.text.startsWith(tok));
    if (wi < 0) { score = -1; break; }
    used.add(wi);
    ranges.push(toOriginal(words[wi].start, words[wi].start + tok.length));
    score += wi === 0 ? 3 : 2;
  }
  if (score > 0) return { score, ranges: ranges.sort((a, b) => a[0] - b[0]) };

  // Mid-word matches only from 3 letters on; one or two letters in the middle of names is just noise.
  const flat = tokens.join(' ');
  const at = flat.length >= 3 ? norm.indexOf(flat) : -1;
  return at >= 0 ? { score: 1, ranges: [toOriginal(at, at + flat.length)] } : null;
}

export function slugify(s: string): string {
  return normName(s).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

export const RESERVED_SLUGS = new Set([
  'admin', 'me', 'login', 'logout', 'setup', 'go', 'photo', 'api', 'fonts', 'brand', 'styles', 'app', 'sw',
  'favicon', 'robots', 'manifest', 'apple-touch-icon', 'team', 'review', 'reviews', 'static', 'assets',
  'asset', 'invite', 'switch', 'theme', 'privacy', 'help', 'support', 'signin', 'signout', 'account', 'null', 'undefined',
]);

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function str(v: unknown, max = 500): string {
  if (typeof v !== 'string') return '';
  return v.replace(/\u0000/g, '').trim().slice(0, max);
}

/** One line of text from a visitor (a name, a subject): no line breaks or control characters. */
export function line(v: unknown, max = 120): string {
  // eslint-disable-next-line no-control-regex
  return str(v, max * 2).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------- time zones ----------

interface ZonedParts { y: number; m: number; d: number; h: number; min: number; wd: number }

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
      weekday: 'short', hourCycle: 'h23',
    });
    partsFmt.set(tz, f);
  }
  return f;
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(ms: number, tz: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of fmtFor(tz).formatToParts(ms)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, wd: WD[p.weekday] ?? 0 };
}

/** Epoch ms of local midnight on y-m-d in the given zone (m is 1-12; overflow is fine). */
export function zonedMidnight(y: number, m: number, d: number, tz: string): number {
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    const target = Date.UTC(y, m - 1, d);
    const diff = asUtc - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

export type Period = 'week' | 'month' | 'last' | 'quarter' | 'year' | 'all';

export interface Range { start: number; end: number; prevStart: number; prevEnd: number; label: string; prevLabel: string }

export function periodRange(period: Period, tz: string, at = now()): Range {
  const p = zonedParts(at, tz);
  const end = at + 1;
  switch (period) {
    case 'week': {
      const offset = (p.wd + 6) % 7; // Monday start
      const start = zonedMidnight(p.y, p.m, p.d - offset, tz);
      const prevStart = zonedMidnight(p.y, p.m, p.d - offset - 7, tz);
      return { start, end, prevStart, prevEnd: Math.min(start, prevStart + (at - start)), label: 'This week', prevLabel: 'this point last week' };
    }
    case 'last': {
      const start = zonedMidnight(p.y, p.m - 1, 1, tz);
      const stop = zonedMidnight(p.y, p.m, 1, tz);
      return { start, end: stop, prevStart: zonedMidnight(p.y, p.m - 2, 1, tz), prevEnd: start, label: 'Last month', prevLabel: 'the month before' };
    }
    case 'quarter': {
      const start = zonedMidnight(p.y, p.m, p.d - 89, tz);
      return { start, end, prevStart: zonedMidnight(p.y, p.m, p.d - 179, tz), prevEnd: start, label: 'Last 90 days', prevLabel: 'the 90 days before' };
    }
    case 'year': {
      const start = zonedMidnight(p.y, 1, 1, tz);
      const prevStart = zonedMidnight(p.y - 1, 1, 1, tz);
      return { start, end, prevStart, prevEnd: Math.min(start, prevStart + (at - start)), label: `${p.y} so far`, prevLabel: `this point in ${p.y - 1}` };
    }
    case 'all':
      return { start: 0, end, prevStart: 0, prevEnd: 0, label: 'All time', prevLabel: '' };
    case 'month':
    default: {
      const start = zonedMidnight(p.y, p.m, 1, tz);
      const prevStart = zonedMidnight(p.y, p.m - 1, 1, tz);
      return { start, end, prevStart, prevEnd: Math.min(start, prevStart + (at - start)), label: 'This month', prevLabel: 'this point last month' };
    }
  }
}

export function parsePeriod(v: string | undefined, fallback: Period = 'month'): Period {
  return (['week', 'month', 'last', 'quarter', 'year', 'all'] as const).includes(v as Period) ? (v as Period) : fallback;
}

export function fmtDate(ms: number, tz: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(ms);
}

export function fmtDateTime(ms: number, tz: string): string {
  return fmtDate(ms, tz, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function relTime(ms: number, tz: string, at = now()): string {
  const diff = at - ms;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  const sameYear = zonedParts(ms, tz).y === zonedParts(at, tz).y;
  return fmtDate(ms, tz, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function describeGap(ms: number): string {
  const a = Math.abs(ms);
  if (a < 2 * MINUTE) return 'a minute';
  if (a < HOUR) return `${Math.round(a / MINUTE)} min`;
  if (a < 2 * DAY) return `${Math.round(a / HOUR)} h`;
  return `${Math.round(a / DAY)} days`;
}

/** A phone number a customer typed, tidied to "(312) 555-0141", or null if it can't be a real number. */
export function formatPhone(input: string): string | null {
  let d = input.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length >= 11 && d.length <= 15 && input.trim().startsWith('+')) return `+${d}`;
  return null;
}

export const CALL_TIMES: Record<string, string> = {
  asap: 'as soon as possible',
  morning: 'in the morning',
  afternoon: 'in the afternoon',
  evening: 'in the evening',
};

/** tel: link in international form: "(312) 555-0141" → "tel:+13125550141". */
export function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `tel:${phone.trim().startsWith('+') ? `+${digits}` : digits.length === 10 ? `+1${digits}` : digits}`;
}

export function pct(n: number, d: number): string {
  if (!d) return '—';
  return `${Math.round((n / d) * 100)}%`;
}

export function avg1(v: number | null | undefined): string {
  return v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1);
}

export function isBot(ua: string | undefined): boolean {
  return /bot|crawler|spider|facebookexternalhit|slack|whatsapp|telegram|discord|preview|embedly|linkexpanding|skype|curl|wget|python-requests/i.test(ua ?? '');
}

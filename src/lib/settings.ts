import type { Env } from '../env';
import { open, seal } from './crypto';
import { all, one, run, stmt } from './db';
import { DEFAULT_THEME, cleanTheme, type Theme } from './theme';

export type SiteId = 'google' | 'yelp' | 'bbb' | 'facebook';

export interface ReviewSite {
  id: SiteId;
  label: string;
  url: string;
  enabled: boolean;
}

export interface GoogleLocation {
  account: string; // accounts/123
  name: string; // locations/456
  title: string;
}

/** A Google profile customers can be sent to. The first one is the main location (the fallback). */
export interface ReviewLocation {
  id: string; // a tracked Google profile's name ('locations/456'), or 'loc_…' for one added by hand
  label: string; // short name staff see: "Downtown"
  review_url: string; // that profile's "write a review" link
  areas: string[]; // cities and ZIP codes it covers, as typed
  bonus: number; // extra points for a review credited on this profile
}

export interface Settings {
  company_name: string;
  public_base_url: string;
  timezone: string;
  office_phone: string;
  website_url: string;
  privacy_url: string;
  sites: ReviewSite[];
  points: { review: number; five_star: number; mention: number; rating: number; min_rating: number };
  match_window_hours: number;
  alert_emails: string[];
  alert_threshold: number;
  alert_from: string;
  reply_signature: string;
  reply_context: string; // a sentence about the business for AI reply drafts
  ai_auto_draft: boolean;
  /** Reviews posted before this are imported as history and never auto-credited. */
  tracking_start: number;
  google_locations: GoogleLocation[];
  /** The Google login the site is connected with (only profiles it manages can be tracked). */
  google_account: string | null;
  /** Where Google buttons can send customers. Empty: every customer gets the Google link under Review sites. */
  locations: ReviewLocation[];
  google_last_sync_at: number | null;
  google_last_sync_error: string | null;
  google_last_sync_note: string | null;
  /** Rating and total count per Google profile, as Google reports them. */
  google_totals: Record<string, { title: string; rating: number | null; count: number | null }>;
  /** First import runs over several 15-minute cycles; this is where each profile left off. */
  google_backfill: Record<string, string>;
  /** Colors, mode, corners and fonts (Admin → Branding). */
  theme: Theme;
  /** Uploaded logo / app icon present, and a version that changes on every upload (cache-busting). */
  brand: { logo: boolean; icon: boolean; version: number };
  demo: boolean;
}

export const DEFAULTS: Settings = {
  company_name: '',
  public_base_url: '',
  timezone: 'America/New_York',
  office_phone: '',
  website_url: '',
  privacy_url: '',
  sites: [
    { id: 'google', label: 'Google', url: '', enabled: true },
    // Yelp's guidelines ask businesses not to solicit reviews, and its filter may hide solicited ones. Off by default.
    { id: 'yelp', label: 'Yelp', url: '', enabled: false },
    { id: 'bbb', label: 'Better Business Bureau', url: '', enabled: false },
    { id: 'facebook', label: 'Facebook', url: '', enabled: false },
  ],
  points: { review: 10, five_star: 5, mention: 5, rating: 0, min_rating: 4 },
  match_window_hours: 72,
  alert_emails: [],
  alert_threshold: 3,
  alert_from: '',
  reply_signature: '',
  reply_context: '',
  ai_auto_draft: true,
  tracking_start: 0,
  google_locations: [],
  google_account: null,
  locations: [],
  google_last_sync_at: null,
  google_last_sync_error: null,
  google_last_sync_note: null,
  google_totals: {},
  google_backfill: {},
  theme: DEFAULT_THEME,
  brand: { logo: false, icon: false, version: 0 },
  demo: false,
};

export async function getSettings(db: D1Database): Promise<Settings> {
  const rows = await all<{ key: string; value: string }>(db, `SELECT key, value FROM settings WHERE key NOT LIKE '\\_%' ESCAPE '\\'`);
  const out = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
  for (const r of rows) {
    if (!Object.hasOwn(DEFAULTS, r.key)) continue;
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      /* keep default */
    }
  }
  const s = out as unknown as Settings;
  // Keep every known site present even if an older save dropped one.
  for (const d of DEFAULTS.sites) if (!s.sites.some((x) => x.id === d.id)) s.sites.push({ ...d, enabled: false });
  s.points = { ...DEFAULTS.points, ...s.points };
  s.theme = cleanTheme(s.theme);
  s.brand = { ...DEFAULTS.brand, ...s.brand };
  return s;
}

export async function saveSettings(db: D1Database, patch: Partial<Settings>): Promise<void> {
  const stmts = Object.entries(patch)
    .filter(([k]) => Object.hasOwn(DEFAULTS, k))
    .map(([k, v]) => stmt(db, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, k, JSON.stringify(v)));
  if (stmts.length) await db.batch(stmts);
}

/**
 * Values never shown on a page (OAuth refresh tokens). Keys are stored with a "_" prefix, and encrypted
 * with AES-GCM when ENCRYPTION_KEY is set (see src/lib/crypto.ts).
 */
export async function getSecret(env: Env, key: string): Promise<string | null> {
  const row = await one<{ value: string }>(env.DB, `SELECT value FROM settings WHERE key = ?`, `_${key}`);
  return row ? open(env, row.value) : null;
}

export async function setSecret(env: Env, key: string, value: string | null): Promise<void> {
  if (value == null) await run(env.DB, `DELETE FROM settings WHERE key = ?`, `_${key}`);
  else await run(env.DB, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, `_${key}`, await seal(env, value));
}

/** The business name, or a neutral fallback before setup. */
export const companyName = (s: Settings): string => s.company_name.trim() || 'Reviews';

export const replySignature = (s: Settings): string => s.reply_signature.trim() || `— The ${companyName(s)} team`;

export function enabledSites(s: Settings): ReviewSite[] {
  return s.sites.filter((x) => x.enabled && x.url);
}

export function tagUrl(s: Settings, slug: string, source: 'nfc' | 'qr' | 'text' | 'link' = 'nfc'): string {
  const base = s.public_base_url.replace(/\/+$/, '');
  return `${base}/${slug}${source === 'link' ? '' : `?s=${source}`}`;
}

/** The Google review link for a location, falling back to the main one, then to the Review sites link. */
export function googleUrlFor(s: Settings, locationId: string | null | undefined): string {
  const loc = s.locations.find((l) => l.id === locationId) ?? s.locations[0];
  return loc?.review_url || (s.sites.find((x) => x.id === 'google')?.url ?? '');
}

export const locationLabel = (s: Settings, id: string | null | undefined): string | null =>
  s.locations.find((l) => l.id === id)?.label ?? null;

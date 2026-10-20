/**
 * Uploaded brand images: the logo and the app icon (in the sizes browsers and phones ask for).
 *
 * The browser draws the chosen file onto a canvas and sends a PNG/WebP/JPEG data URL, so the server never
 * accepts SVG or anything that could carry script. Each upload is checked again here: allowed type, real image
 * header bytes (not just the label), and a size cap. Served with nosniff and a locked-down CSP.
 */
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { one, run, stmt } from './db';
import { now } from './util';

export const ASSET_NAMES = ['logo', 'icon-512', 'icon-192', 'icon-180', 'icon-32'] as const;
export type AssetName = (typeof ASSET_NAMES)[number];

/** Largest accepted file, in bytes after base64 decoding. */
export const MAX_BYTES: Record<AssetName, number> = { logo: 400_000, 'icon-512': 400_000, 'icon-192': 150_000, 'icon-180': 150_000, 'icon-32': 30_000 };

/** Where the built-in neutral defaults live in public/. */
export const DEFAULT_FILE: Record<AssetName, string> = {
  logo: '/static/icon-192.png',
  'icon-512': '/static/icon-512.png',
  'icon-192': '/static/icon-192.png',
  'icon-180': '/static/icon-180.png',
  'icon-32': '/static/icon-32.png',
};

const DATA_URL = /^data:(image\/(?:png|webp|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/;

function magicMatches(mime: string, head: Uint8Array): boolean {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, k) => head[i + k] === b);
  if (mime === 'image/png') return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mime === 'image/jpeg') return at(0, 0xff, 0xd8, 0xff);
  if (mime === 'image/webp') return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50); // RIFF....WEBP
  return false;
}

/** A checked image ready to store, or a plain-English reason it was refused. */
export function parseImage(dataUrl: string, maxBytes: number): { mime: string; data: string } | { error: string } {
  const m = DATA_URL.exec(dataUrl);
  if (!m) return { error: 'Use a PNG, JPEG or WebP image.' };
  const [, mime, data] = m;
  if (data.length % 4 !== 0) return { error: 'That image could not be read.' };
  const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes > maxBytes) return { error: `That image is too large (${Math.round(bytes / 1024)} KB; the limit is ${Math.round(maxBytes / 1024)} KB).` };
  let head: Uint8Array;
  try {
    head = Uint8Array.from(atob(data.slice(0, 24)), (c) => c.charCodeAt(0));
  } catch {
    return { error: 'That image could not be read.' };
  }
  if (!magicMatches(mime, head)) return { error: "That file isn't the image type it claims to be." };
  return { mime, data };
}

export function saveAssets(db: D1Database, items: { name: AssetName; mime: string; data: string }[]): D1PreparedStatement[] {
  const t = now();
  return items.map((i) => stmt(db,
    `INSERT INTO assets (name, mime, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
    i.name, i.mime, i.data, t));
}

export async function deleteAssets(db: D1Database, names: AssetName[]): Promise<void> {
  await run(db, `DELETE FROM assets WHERE name IN (SELECT value FROM json_each(?))`, JSON.stringify(names));
}

const ASSET_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'same-origin',
};

/** The uploaded image, or the built-in default from public/static/. Versioned URLs (?v=) cache for a year. */
export async function serveAsset(c: Context<AppEnv>, name: AssetName): Promise<Response> {
  const row = await one<{ mime: string; data: string }>(c.env.DB, `SELECT mime, data FROM assets WHERE name = ?`, name);
  const cache = c.req.query('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
  if (!row) {
    const res = await c.env.ASSETS.fetch(new Request(new URL(DEFAULT_FILE[name], c.req.url)));
    return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'image/png', 'cache-control': cache, ...ASSET_HEADERS } });
  }
  // A plain loop: much cheaper than a per-byte callback on a 400 KB logo, inside the 10 ms CPU budget.
  const bin = atob(row.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { 'content-type': row.mime, 'cache-control': cache, ...ASSET_HEADERS } });
}

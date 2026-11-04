/**
 * Tracking links (Links in the office menu): /r/<code> leads to the rating page or straight to Google, and the visit
 * it starts remembers the link, so its rating, review-site click and matched review count toward it.
 */
import { one } from './db';
import type { Settings } from './settings';

export interface LinkRow {
  id: string; code: string; name: string; tech_id: string | null; dest: 'rate' | 'google';
  created_by: string | null; created_at: number; archived_at: number | null;
}

/** Lowercase letters, numbers and dashes, 2 to 40 characters: /r/invoice-emails. */
export const LINK_CODE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** Hidden links still resolve: a printed QR code must keep working. */
export async function linkByCode(db: D1Database, code: string | null | undefined): Promise<LinkRow | null> {
  return code && LINK_CODE.test(code) ? one<LinkRow>(db, `SELECT * FROM links WHERE code = ?`, code) : null;
}

/** A link's full address. `origin` (this request's own address) stands in if "Address written on tags" is empty. */
export const linkUrl = (s: Settings, code: string, origin = ''): string => `${(s.public_base_url || origin).replace(/\/+$/, '')}/r/${code}`;

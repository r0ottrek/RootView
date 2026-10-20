/**
 * Review pipeline: import → match to techs → credit + points → alerts → reply drafts.
 *
 * Written for the Workers free plan: 50 database queries and 50 outside requests per run.
 * Bulk writes go through json_each(?) so 50 reviews cost one query, not fifty.
 */
import type { Env } from '../env';
import { draftReply } from './ai';
import { all, one, run, scalar, stmt } from './db';
import { defang, quoted, sendAlert } from './email';
import { STAR, accessToken, listReviews, putReply, type GoogleReview } from './google';
import { LATE_GRACE, matchReview, mentionedTechs, type Candidate, type TapLite, type TechLite } from './match';
import { getSecret, getSettings, saveSettings, type GoogleLocation, type Settings } from './settings';
import { CALL_TIMES, DAY, HOUR, line, newId, now } from './util';

export interface ReviewRow {
  id: string;
  platform: string;
  external_id: string | null;
  resource_name: string | null;
  location: string | null; // Google profile title, for display
  location_id: string | null; // Google profile id ('locations/123'), for routing and bonuses
  reviewer_name: string;
  reviewer_photo: string | null;
  rating: number | null;
  body: string;
  posted_at: number;
  updated_at: number | null;
  imported_at: number;
  reply: string | null;
  reply_at: number | null;
  reply_draft: string | null;
  reply_error: string | null;
  status: 'pending' | 'credited' | 'unassigned' | 'not_tech' | 'history';
  suggestions: string | null;
  alerted_at: number | null;
}

export interface Suggestion { tech_id: string; score: number; evidence: string[] }

const LABELS: Record<string, string> = { google: 'Google', yelp: 'Yelp', bbb: 'BBB', facebook: 'Facebook', other: 'Other' };
export const platformLabel = (p: string) => LABELS[p] ?? p;

export function parseSuggestions(r: Pick<ReviewRow, 'suggestions'>): Suggestion[] {
  if (!r.suggestions) return [];
  try {
    return JSON.parse(r.suggestions) as Suggestion[];
  } catch {
    return [];
  }
}

// ---------- points ----------

interface PointRow { id: string; tech_id: string; amount: number; reason: string; review_id: string; created_by: string | null; created_at: number }

function pointsForCredit(s: Settings, r: Pick<ReviewRow, 'id' | 'rating' | 'posted_at' | 'location_id'>, techId: string, mentioned: boolean, by: string | null): PointRow[] {
  const p = s.points;
  if (r.rating != null && r.rating < p.min_rating) return [];
  const rows: PointRow[] = [];
  const add = (amount: number, reason: string) => {
    if (amount) rows.push({ id: newId('pt'), tech_id: techId, amount, reason, review_id: r.id, created_by: by, created_at: r.posted_at });
  };
  add(p.review, 'Review credited');
  if (r.rating === 5) add(p.five_star, '5-star bonus');
  if (mentioned) add(p.mention, 'Named in the review');
  const loc = s.locations.find((l) => l.id === r.location_id);
  if (loc?.bonus) add(loc.bonus, `Review on the ${loc.label} profile`);
  return rows;
}

const insertPoints = (db: D1Database, rows: PointRow[]) =>
  stmt(db, `INSERT OR IGNORE INTO points (id, tech_id, amount, reason, review_id, created_by, created_at)
    SELECT json_extract(value, '$.id'), json_extract(value, '$.tech_id'), json_extract(value, '$.amount'), json_extract(value, '$.reason'),
           json_extract(value, '$.review_id'), json_extract(value, '$.created_by'), json_extract(value, '$.created_at')
    FROM json_each(?)`, JSON.stringify(rows));

// ---------- automatic matching ----------

/**
 * Matches up to `limit` pending reviews to techs. About 6 queries however many reviews. Kept small: matching is
 * the CPU-heavy part, and the free plan allows about 10 ms of CPU per request. The rest wait for the next run.
 */
export async function processPending(env: Env, s: Settings, limit = 20, onlyIds?: string[]): Promise<{ processed: number; remaining: number }> {
  const db = env.DB;
  const reviews = onlyIds
    ? await all<ReviewRow>(db, `SELECT * FROM reviews WHERE status = 'pending' AND id IN (SELECT value FROM json_each(?)) ORDER BY posted_at`, JSON.stringify(onlyIds))
    : await all<ReviewRow>(db, `SELECT * FROM reviews WHERE status = 'pending' ORDER BY posted_at LIMIT ?`, limit);
  if (!reviews.length) return { processed: 0, remaining: 0 };

  const techs = await all<TechLite>(db, `SELECT id, name, first_name, aliases, active FROM techs`);
  const windowMs = s.match_window_hours * HOUR;
  const taps = await all<TapLite>(db,
    `SELECT id, tech_id, customer_name, site, created_at, rated_at, clicked_at, location_id FROM taps
     WHERE tech_id IS NOT NULL AND review_id IS NULL AND created_at BETWEEN ? AND ? ORDER BY created_at`,
    reviews[0].posted_at - windowMs - HOUR, reviews[reviews.length - 1].posted_at + LATE_GRACE);

  const claimed = new Set<string>();
  const credits: Record<string, unknown>[] = [];
  const points: PointRow[] = [];
  const tapLinks: { t: string; r: string }[] = [];
  const updates: { id: string; status: string; sugg: string | null }[] = [];
  const t0 = now();

  for (const r of reviews) {
    const lo = r.posted_at - windowMs - HOUR;
    const hi = r.posted_at + LATE_GRACE;
    const pool = taps.filter((t) => !claimed.has(t.id) && t.created_at >= lo && t.created_at <= hi);
    const res = matchReview(r, techs, pool, s.match_window_hours);
    for (const c of res.credit) {
      credits.push({ review_id: r.id, tech_id: c.tech_id, method: c.method, score: c.score, evidence: c.evidence.join(' · '), tap_id: c.tap_id, created_at: t0 });
      if (c.tap_id && !claimed.has(c.tap_id)) {
        claimed.add(c.tap_id);
        tapLinks.push({ t: c.tap_id, r: r.id });
      }
      points.push(...pointsForCredit(s, r, c.tech_id, c.mentioned, null));
    }
    updates.push({
      id: r.id,
      status: res.credit.length ? 'credited' : 'unassigned',
      sugg: res.suggestions.length ? JSON.stringify(res.suggestions.map((c: Candidate) => ({ tech_id: c.tech_id, score: c.score, evidence: c.evidence }))) : null,
    });
  }

  const batch: D1PreparedStatement[] = [];
  if (credits.length) {
    batch.push(stmt(db, `INSERT OR IGNORE INTO credits (review_id, tech_id, method, score, evidence, tap_id, created_at)
      SELECT json_extract(value, '$.review_id'), json_extract(value, '$.tech_id'), json_extract(value, '$.method'), json_extract(value, '$.score'),
             json_extract(value, '$.evidence'), json_extract(value, '$.tap_id'), json_extract(value, '$.created_at')
      FROM json_each(?)`, JSON.stringify(credits)));
  }
  if (points.length) batch.push(insertPoints(db, points));
  if (tapLinks.length) {
    batch.push(stmt(db, `UPDATE taps SET review_id = j.r
      FROM (SELECT json_extract(value, '$.t') AS t, json_extract(value, '$.r') AS r FROM json_each(?)) AS j
      WHERE taps.id = j.t`, JSON.stringify(tapLinks)));
  }
  batch.push(stmt(db, `UPDATE reviews SET status = j.status, suggestions = j.sugg
    FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.status') AS status, json_extract(value, '$.sugg') AS sugg FROM json_each(?)) AS j
    WHERE reviews.id = j.id`, JSON.stringify(updates)));
  await db.batch(batch);

  await alertLowReviews(env, s, reviews, credits, techs);
  const remaining = await scalar(db, `SELECT COUNT(*) FROM reviews WHERE status = 'pending'`);
  return { processed: reviews.length, remaining };
}

async function alertLowReviews(env: Env, s: Settings, reviews: ReviewRow[], credits: Record<string, unknown>[], techs: TechLite[]) {
  const low = reviews.filter((r) => r.rating != null && r.rating <= s.alert_threshold && !r.alerted_at).slice(0, 5);
  if (!low.length) return;
  const names = new Map(techs.map((t) => [t.id, t.name]));
  const base = s.public_base_url.replace(/\/+$/, '');
  const sent: string[] = [];
  for (const r of low) {
    const who = credits.filter((c) => c.review_id === r.id).map((c) => names.get(String(c.tech_id))).filter(Boolean).join(', ') || 'not matched yet';
    const ok = await sendAlert(env, s, `${r.rating}★ ${platformLabel(r.platform)} review from ${defang(line(r.reviewer_name, 60)) || 'a customer'}`,
      `${r.rating} of 5 stars on ${platformLabel(r.platform)}${r.location ? ` (${r.location})` : ''}\nReviewer: ${defang(line(r.reviewer_name, 80)) || '(anonymous)'}\nTechnician: ${who}\n\nThe review:\n${quoted(r.body)}\n\nReply or reassign: ${base}/admin/reviews/${r.id}`);
    if (ok) sent.push(r.id);
  }
  if (sent.length) await run(env.DB, `UPDATE reviews SET alerted_at = ? WHERE id IN (SELECT value FROM json_each(?))`, now(), JSON.stringify(sent));
}

/** Puts unassigned reviews (since tracking began) back through matching, e.g. after adding a tech's nickname. */
export async function rematchUnassigned(env: Env, s: Settings) {
  await run(env.DB, `UPDATE reviews SET status = 'pending', suggestions = NULL WHERE status = 'unassigned' AND posted_at >= ?`, s.tracking_start);
  return processPending(env, s);
}

// ---------- manual crediting ----------

/**
 * Credits one or more techs: a whole crew can share a review, and each gets full credit and points. Techs already
 * credited are re-stamped as manual. Four statements however many techs, inside the per-request query limit.
 */
export async function creditReview(env: Env, s: Settings, reviewId: string, techIds: string | string[], by: string): Promise<void> {
  const db = env.DB;
  const ids = [...new Set(Array.isArray(techIds) ? techIds : [techIds])].filter(Boolean);
  const r = await one<ReviewRow>(db, `SELECT * FROM reviews WHERE id = ?`, reviewId);
  const techs = ids.length ? await all<TechLite>(db, `SELECT id, name, first_name, aliases FROM techs WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)) : [];
  if (!r || !techs.length) throw new Error('Review or tech not found');
  const list = JSON.stringify(techs.map((t) => t.id));
  const pts = techs.flatMap((t) => pointsForCredit(s, r, t.id, mentionedTechs(r.body, [t]).has(t.id), by));
  const batch: D1PreparedStatement[] = [
    stmt(db, `INSERT INTO credits (review_id, tech_id, method, score, evidence, created_by, created_at)
      SELECT ?1, value, 'manual', 100, ?2, ?3, ?4 FROM json_each(?5) WHERE true
      ON CONFLICT (review_id, tech_id) DO UPDATE SET method = 'manual', evidence = excluded.evidence, created_by = excluded.created_by`,
      r.id, `Credited by ${by}`, by, now(), list),
    stmt(db, `DELETE FROM points WHERE review_id = ? AND tech_id IN (SELECT value FROM json_each(?))`, r.id, list),
  ];
  if (pts.length) batch.push(insertPoints(db, pts));
  batch.push(stmt(db, `UPDATE reviews SET status = 'credited' WHERE id = ?`, r.id));
  await db.batch(batch);
}

export async function uncreditReview(env: Env, reviewId: string, techId: string): Promise<void> {
  const db = env.DB;
  await db.batch([
    stmt(db, `DELETE FROM credits WHERE review_id = ? AND tech_id = ?`, reviewId, techId),
    stmt(db, `DELETE FROM points WHERE review_id = ? AND tech_id = ?`, reviewId, techId),
    stmt(db, `UPDATE taps SET review_id = NULL WHERE review_id = ? AND tech_id = ?`, reviewId, techId),
    stmt(db, `UPDATE reviews SET status = CASE WHEN EXISTS (SELECT 1 FROM credits WHERE review_id = ?1) THEN 'credited' ELSE 'unassigned' END WHERE id = ?1`, reviewId),
  ]);
}

export async function markNotTech(env: Env, reviewId: string): Promise<void> {
  const db = env.DB;
  await db.batch([
    stmt(db, `DELETE FROM points WHERE review_id = ?`, reviewId),
    stmt(db, `DELETE FROM credits WHERE review_id = ?`, reviewId),
    stmt(db, `UPDATE taps SET review_id = NULL WHERE review_id = ?`, reviewId),
    stmt(db, `UPDATE reviews SET status = 'not_tech', suggestions = NULL WHERE id = ?`, reviewId),
  ]);
}

export async function reopenReview(env: Env, reviewId: string): Promise<void> {
  await run(env.DB, `UPDATE reviews SET status = CASE WHEN EXISTS (SELECT 1 FROM credits WHERE review_id = ?1) THEN 'credited' ELSE 'unassigned' END WHERE id = ?1`, reviewId);
}

// ---------- deleting test entries ----------

/** Removes one tag visit; see deleteTaps. */
export async function deleteTap(env: Env, tapId: string): Promise<void> {
  await deleteTaps(env, [tapId]);
}

/**
 * Removes tag visits for good: the visits, any points they earned, any credit a review got from them, and the
 * customer's name from "likely match" hints (those reviews are matched again without them). Two queries however
 * many visits, so a privacy request stays inside the free plan's per-request limit.
 */
export async function deleteTaps(env: Env, tapIds: string[]): Promise<number> {
  const db = env.DB;
  const ids = JSON.stringify(tapIds);
  const taps = await all<{ review_id: string | null; customer_name: string | null }>(db,
    `SELECT review_id, customer_name FROM taps WHERE id IN (SELECT value FROM json_each(?))`, ids);
  if (!taps.length) return 0;
  const reviewIds = JSON.stringify([...new Set(taps.flatMap((t) => (t.review_id ? [t.review_id] : [])))]);
  // Hints quote the name as “Name” inside JSON, so look for exactly that.
  const names = JSON.stringify([...new Set(taps.flatMap((t) => (t.customer_name ? [`“${JSON.stringify(t.customer_name).slice(1, -1)}”`] : [])))]);
  await db.batch([
    stmt(db, `DELETE FROM points WHERE tap_id IN (SELECT value FROM json_each(?))`, ids),
    stmt(db, `DELETE FROM points WHERE EXISTS (SELECT 1 FROM credits c WHERE c.tap_id IN (SELECT value FROM json_each(?)) AND c.review_id = points.review_id AND c.tech_id = points.tech_id)`, ids),
    stmt(db, `DELETE FROM credits WHERE tap_id IN (SELECT value FROM json_each(?))`, ids),
    stmt(db, `UPDATE reviews SET status = CASE WHEN EXISTS (SELECT 1 FROM credits WHERE review_id = reviews.id) THEN 'credited' ELSE 'unassigned' END
      WHERE id IN (SELECT value FROM json_each(?)) AND status = 'credited'`, reviewIds),
    stmt(db, `UPDATE reviews SET suggestions = NULL, status = CASE WHEN status = 'unassigned' THEN 'pending' ELSE status END
      WHERE suggestions IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(?) n WHERE instr(reviews.suggestions, n.value) > 0)`, names),
    stmt(db, `DELETE FROM taps WHERE id IN (SELECT value FROM json_each(?))`, ids),
  ]);
  return taps.length;
}

/** Removes a review entered by hand (Google reviews come back on the next import, so they aren't deletable). */
export async function deleteManualReview(env: Env, reviewId: string): Promise<boolean> {
  const db = env.DB;
  const r = await one<{ platform: string; external_id: string | null }>(db, `SELECT platform, external_id FROM reviews WHERE id = ?`, reviewId);
  if (!r || (r.platform === 'google' && r.external_id)) return false;
  await db.batch([
    stmt(db, `DELETE FROM points WHERE review_id = ?`, reviewId),
    stmt(db, `DELETE FROM credits WHERE review_id = ?`, reviewId),
    stmt(db, `UPDATE taps SET review_id = NULL WHERE review_id = ?`, reviewId),
    stmt(db, `DELETE FROM reviews WHERE id = ?`, reviewId),
  ]);
  return true;
}

/**
 * "Start fresh": deletes every tag visit, review, credit, point and reward request, and restarts tracking now.
 * Team, rewards catalog, settings, logins and the Google connection stay. Google history re-imports on the next check.
 */
export async function startFresh(env: Env): Promise<void> {
  const db = env.DB;
  await db.batch([
    stmt(db, `DELETE FROM points`), stmt(db, `DELETE FROM credits`), stmt(db, `DELETE FROM redemptions`),
    stmt(db, `DELETE FROM reviews`), stmt(db, `DELETE FROM taps`),
  ]);
  await saveSettings(db, { demo: false, tracking_start: now(), google_last_sync_at: null, google_backfill: {} });
}

// ---------- manual entry (Yelp, BBB, Facebook: anything Google doesn't send us) ----------

export async function addManualReview(env: Env, s: Settings, input: { platform: string; reviewer: string; rating: number | null; body: string; posted_at: number; techIds: string[]; by: string }): Promise<string> {
  const id = newId('r');
  await run(env.DB, `INSERT INTO reviews (id, platform, reviewer_name, rating, body, posted_at, updated_at, imported_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    id, input.platform, input.reviewer, input.rating, input.body, input.posted_at, input.posted_at, now());
  if (input.techIds.length) await creditReview(env, s, id, input.techIds, input.by);
  else await processPending(env, s, 1, [id]);
  return id;
}

// ---------- Google sync ----------

// 50 reviews a page. Kept small so each run stays inside the free plan's 10 ms CPU budget;
// the first import of ~1,600 reviews across both profiles spreads over a few 15-minute runs.
const MAX_PAGES_PER_RUN = 6;

async function importGoogleBatch(db: D1Database, s: Settings, loc: GoogleLocation, list: GoogleReview[]): Promise<void> {
  if (!list.length) return;
  const t = now();
  const rows = list.map((g) => {
    const posted = Date.parse(g.createTime);
    return {
      id: newId('r'),
      external_id: g.reviewId,
      resource_name: g.name,
      location: loc.title,
      location_id: loc.name,
      reviewer_name: g.reviewer?.isAnonymous ? '' : (g.reviewer?.displayName ?? ''),
      reviewer_photo: g.reviewer?.profilePhotoUrl ?? null,
      rating: STAR[g.starRating ?? ''] ?? null,
      body: g.comment ?? '',
      posted_at: posted,
      updated_at: Date.parse(g.updateTime ?? g.createTime),
      reply: g.reviewReply?.comment ?? null,
      reply_at: g.reviewReply?.updateTime ? Date.parse(g.reviewReply.updateTime) : null,
      status: posted >= s.tracking_start ? 'pending' : 'history',
    };
  });
  await run(db, `INSERT INTO reviews (id, platform, external_id, resource_name, location, location_id, reviewer_name, reviewer_photo, rating, body, posted_at, updated_at, imported_at, reply, reply_at, status)
    SELECT json_extract(value, '$.id'), 'google', json_extract(value, '$.external_id'), json_extract(value, '$.resource_name'), json_extract(value, '$.location'),
           json_extract(value, '$.location_id'),
           json_extract(value, '$.reviewer_name'), json_extract(value, '$.reviewer_photo'), json_extract(value, '$.rating'), json_extract(value, '$.body'),
           json_extract(value, '$.posted_at'), json_extract(value, '$.updated_at'), ?2, json_extract(value, '$.reply'), json_extract(value, '$.reply_at'),
           json_extract(value, '$.status')
    FROM json_each(?1) WHERE true
    ON CONFLICT (platform, external_id) DO UPDATE SET
      resource_name = excluded.resource_name, location_id = excluded.location_id, reviewer_name = excluded.reviewer_name, reviewer_photo = excluded.reviewer_photo,
      rating = excluded.rating, body = excluded.body, updated_at = excluded.updated_at,
      reply = COALESCE(excluded.reply, reviews.reply), reply_at = COALESCE(excluded.reply_at, reviews.reply_at)`,
    JSON.stringify(rows), t);
}

export async function syncGoogle(env: Env, opts: { full?: boolean; defer?: (p: Promise<unknown>) => void } = {}): Promise<{ ok: boolean; note: string }> {
  const db = env.DB;
  const s = await getSettings(db);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return { ok: false, note: 'Google keys are not set on the server yet.' };
  let refresh: string | null;
  try {
    refresh = await getSecret(env, 'google_refresh');
  } catch {
    return { ok: false, note: "The saved Google connection can't be read (was ENCRYPTION_KEY changed?). Connect Google again in Settings." };
  }
  if (!refresh) return { ok: false, note: 'Google is not connected.' };
  if (!s.google_locations.length) return { ok: false, note: 'Choose which Google profiles to track.' };

  const started = now();
  const before = await scalar(db, `SELECT COUNT(*) FROM reviews WHERE platform = 'google'`);
  const backfill = opts.full ? {} : { ...s.google_backfill };
  const totals = { ...s.google_totals };
  const since = opts.full || !s.google_last_sync_at ? 0 : s.google_last_sync_at - 2 * DAY;
  let pages = 0;

  try {
    const token = await accessToken(env, refresh);
    // Pass 1: newest reviews, until we reach ones we already have.
    for (const loc of s.google_locations) {
      let pageToken: string | undefined;
      for (;;) {
        const data = await listReviews(token, loc.account, loc.name, pageToken);
        pages++;
        if (!pageToken) totals[loc.name] = { title: loc.title, rating: data.averageRating ?? null, count: data.totalReviewCount ?? null };
        const list = data.reviews ?? [];
        const fresh = since ? list.filter((g) => Date.parse(g.updateTime ?? g.createTime) >= since) : list;
        await importGoogleBatch(db, s, loc, fresh);
        if (!data.nextPageToken) break;
        if (!since) { backfill[loc.name] = data.nextPageToken; break; } // first run: history continues in pass 2
        if (fresh.length < list.length || pages >= MAX_PAGES_PER_RUN) break;
        pageToken = data.nextPageToken;
      }
    }
    // Pass 2: older history, a slice per run.
    for (const loc of s.google_locations) {
      while (backfill[loc.name] && pages < MAX_PAGES_PER_RUN) {
        const data = await listReviews(token, loc.account, loc.name, backfill[loc.name]);
        pages++;
        await importGoogleBatch(db, s, loc, data.reviews ?? []);
        if (data.nextPageToken) backfill[loc.name] = data.nextPageToken;
        else delete backfill[loc.name];
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A hiccup (rate limit, outage) keeps the history import's place; only a rejected page token starts it over.
    const badToken = /\b400\b|INVALID_ARGUMENT|page ?token/i.test(msg);
    await saveSettings(db, { google_last_sync_error: msg, google_backfill: badToken ? {} : backfill });
    return { ok: false, note: msg };
  }

  const added = (await scalar(db, `SELECT COUNT(*) FROM reviews WHERE platform = 'google'`)) - before;
  const pendingHistory = Object.keys(backfill).length ? ' Still importing older reviews.' : '';
  const note = `${added} new review${added === 1 ? '' : 's'}.${pendingHistory}`;
  await saveSettings(db, { google_last_sync_at: started, google_last_sync_error: null, google_last_sync_note: note, google_totals: totals, google_backfill: backfill });
  await processPending(env, { ...s, google_totals: totals });
  // AI drafts can take a while: a person waiting on the page gets the answer first (`defer`), the scheduler waits.
  if (opts.defer) opts.defer(autoDraft(env, s));
  else await autoDraft(env, s);
  return { ok: true, note };
}

// ---------- replies ----------

async function techFirstNames(db: D1Database, reviewId: string): Promise<string[]> {
  const rows = await all<{ first_name: string }>(db, `SELECT t.first_name FROM credits c JOIN techs t ON t.id = c.tech_id WHERE c.review_id = ?`, reviewId);
  return rows.map((r) => r.first_name);
}

export async function draftFor(env: Env, s: Settings, reviewId: string): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('Add ANTHROPIC_API_KEY on the server to use AI drafts.');
  const r = await one<ReviewRow>(env.DB, `SELECT * FROM reviews WHERE id = ?`, reviewId);
  if (!r) throw new Error('Review not found');
  const text = await draftReply(env.ANTHROPIC_API_KEY, s, {
    reviewer: r.reviewer_name, rating: r.rating, body: r.body, platform: r.platform, techFirstNames: await techFirstNames(env.DB, r.id),
  }, env.AI_MODEL || undefined);
  await run(env.DB, `UPDATE reviews SET reply_draft = ?, reply_error = NULL WHERE id = ?`, text, r.id);
  return text;
}

/** Drafts replies for a couple of new Google reviews each run so they're waiting when the office opens them. */
async function autoDraft(env: Env, s: Settings): Promise<void> {
  if (!s.ai_auto_draft || !env.ANTHROPIC_API_KEY) return;
  const todo = await all<{ id: string }>(env.DB,
    `SELECT id FROM reviews WHERE platform = 'google' AND reply IS NULL AND reply_draft IS NULL AND status IN ('credited', 'unassigned')
     AND reply_error IS NULL AND posted_at > ? ORDER BY posted_at DESC LIMIT 2`, now() - 30 * DAY);
  for (const r of todo) {
    try {
      await draftFor(env, s, r.id);
    } catch (err) {
      console.error('[draft]', err);
      // Marked, so one review that always fails doesn't block drafts for the others. "Draft a reply" still works.
      await run(env.DB, `UPDATE reviews SET reply_error = ? WHERE id = ?`, `Automatic draft failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), r.id);
    }
  }
}

export async function saveReply(env: Env, reviewId: string, text: string, post: boolean): Promise<{ posted: boolean }> {
  const db = env.DB;
  const r = await one<ReviewRow>(db, `SELECT * FROM reviews WHERE id = ?`, reviewId);
  if (!r) throw new Error('Review not found');
  let posted = false;
  if (post && r.platform === 'google' && r.resource_name) {
    const refresh = await getSecret(env, 'google_refresh');
    if (!refresh) throw new Error('Connect Google in Settings to post replies from here.');
    try {
      await putReply(await accessToken(env, refresh), r.resource_name, text);
      posted = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await run(db, `UPDATE reviews SET reply_draft = ?, reply_error = ? WHERE id = ?`, text, msg, r.id);
      throw err;
    }
  }
  await run(db, `UPDATE reviews SET reply = ?, reply_at = ?, reply_draft = NULL, reply_error = NULL WHERE id = ?`, text, now(), r.id);
  return { posted };
}

// ---------- tag visits ----------

export async function alertLowTap(env: Env, s: Settings, tech: { name: string; first_name: string }, tap: { customer_name: string; rating: number; comment: string | null }): Promise<void> {
  const base = s.public_base_url.replace(/\/+$/, '');
  const who = defang(line(tap.customer_name, 60));
  await sendAlert(env, s, `${tap.rating}★ from ${who} on ${tech.first_name}'s tag`,
    `${who} rated their visit with ${tech.name} ${tap.rating} of 5 on the review page.\n\nTheir comment:\n${quoted(tap.comment)}\n\nThey were offered a call-back (you'll get a second email if they ask for one), with the review site links below it.\n\nFollow up: ${base}/admin/activity?f=low`);
}

export async function alertCallback(env: Env, s: Settings, tech: { name: string; first_name: string }, cb: { customer_name: string; rating: number; comment: string | null; phone: string; time: string }): Promise<void> {
  const base = s.public_base_url.replace(/\/+$/, '');
  const who = defang(line(cb.customer_name, 60));
  await sendAlert(env, s, `Call back ${who}: ${cb.phone} (${cb.rating}★ for ${tech.first_name})`,
    `${who} asked for a call ${CALL_TIMES[cb.time] ?? 'soon'}.\n\nPhone: ${cb.phone}${cb.phone.startsWith('+') ? ' (international number: check it before calling)' : ''}\nRating: ${cb.rating} of 5 for ${tech.name}\n\nWhat went wrong:\n${quoted(cb.comment)}\n\nLog the call when it's done: ${base}/admin/activity?f=low`, 'callback');
}

/**
 * Scheduled run (every 15 minutes via cron/index.js → POST /api/cron): Google import and matching, plus housekeeping.
 * Personal data is kept only as long as it's useful: rough locations 30 days, call-back numbers 90 days after the
 * follow-up is closed (180 days at most, closed or not), visits nobody finished 30 days.
 */
export async function runScheduled(env: Env): Promise<{ ok: boolean; note: string }> {
  const t = now();
  // Clean-up once a day (the run that starts between 08:00 and 08:15 UTC): it reads a lot of rows, and D1's free
  // plan counts rows read.
  const daily = new Date(t).getUTCHours() === 8 && new Date(t).getUTCMinutes() < 15;
  if (daily) await env.DB.batch([
    stmt(env.DB, `DELETE FROM sessions WHERE expires_at < ?`, t),
    stmt(env.DB, `DELETE FROM throttle WHERE window_start < ? AND key NOT LIKE 'ok:%'`, t - 2 * DAY),
    stmt(env.DB, `DELETE FROM throttle WHERE window_start < ?`, t - 60 * DAY),
    stmt(env.DB, `UPDATE techs SET invite_hash = NULL, invite_expires_at = NULL WHERE invite_expires_at < ?`, t),
    stmt(env.DB, `UPDATE admins SET invite_hash = NULL, invite_expires_at = NULL WHERE invite_expires_at < ?`, t),
    stmt(env.DB, `UPDATE taps SET geo = NULL WHERE geo IS NOT NULL AND created_at < ?`, t - 30 * DAY),
    stmt(env.DB, `UPDATE taps SET callback_phone = NULL WHERE callback_phone IS NOT NULL AND ((resolved_at IS NOT NULL AND resolved_at < ?) OR callback_at < ?)`, t - 90 * DAY, t - 180 * DAY),
    stmt(env.DB, `DELETE FROM taps WHERE rating IS NULL AND review_id IS NULL AND created_at < ?`, t - 30 * DAY),
  ]);
  // Low Google reviews whose alert email didn't go out (email cap, outage): try again for 3 days.
  const s = await getSettings(env.DB);
  const missed = await all<ReviewRow>(env.DB,
    `SELECT * FROM reviews WHERE alerted_at IS NULL AND status NOT IN ('pending', 'history') AND rating IS NOT NULL AND rating <= ? AND posted_at > ? LIMIT 5`,
    s.alert_threshold, t - 3 * DAY);
  if (missed.length) {
    const credited = await all<Record<string, unknown>>(env.DB, `SELECT review_id, tech_id FROM credits WHERE review_id IN (SELECT value FROM json_each(?))`, JSON.stringify(missed.map((r) => r.id)));
    await alertLowReviews(env, s, missed, credited, await all<TechLite>(env.DB, `SELECT id, name, first_name, aliases, active FROM techs`));
  }
  const res = await syncGoogle(env);
  if (!res.ok) {
    // Still match manual entries and anything left over.
    await processPending(env, await getSettings(env.DB));
  }
  return res;
}

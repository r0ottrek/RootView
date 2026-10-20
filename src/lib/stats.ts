/** Dashboard and leaderboard numbers. Each function is a single query. */
import { all, one } from './db';
import { DAY, zonedMidnight, zonedParts } from './util';

export interface LeaderRow {
  id: string;
  slug: string;
  name: string;
  first_name: string;
  role: string;
  photo: number; // 1 if a photo is on file
  updated_at: number;
  reviews: number;
  avg_rating: number | null;
  five_star: number;
  taps: number;
  ratings: number;
  tap_avg: number | null;
  clicks: number;
  converted: number;
  points: number;
}

export async function leaderboard(db: D1Database, start: number, end: number, onlyActive = true): Promise<LeaderRow[]> {
  return all<LeaderRow>(db, `
    SELECT t.id, t.slug, t.name, t.first_name, t.role, t.photo IS NOT NULL AS photo, t.updated_at,
      COALESCE(cr.reviews, 0) AS reviews, cr.avg_rating, COALESCE(cr.five_star, 0) AS five_star,
      COALESCE(tp.taps, 0) AS taps, COALESCE(tp.ratings, 0) AS ratings, tp.tap_avg, COALESCE(tp.clicks, 0) AS clicks,
      COALESCE(tp.converted, 0) AS converted, COALESCE(pt.points, 0) AS points
    FROM techs t
    LEFT JOIN (
      SELECT c.tech_id, COUNT(*) AS reviews, AVG(r.rating) AS avg_rating, SUM(r.rating = 5) AS five_star
      FROM credits c JOIN reviews r ON r.id = c.review_id
      WHERE r.posted_at >= ?1 AND r.posted_at < ?2 GROUP BY c.tech_id
    ) cr ON cr.tech_id = t.id
    LEFT JOIN (
      SELECT tech_id, COUNT(*) AS taps, COUNT(rating) AS ratings, AVG(rating) AS tap_avg, COUNT(clicked_at) AS clicks,
             COUNT(review_id) AS converted
      FROM taps WHERE created_at >= ?1 AND created_at < ?2 GROUP BY tech_id
    ) tp ON tp.tech_id = t.id
    LEFT JOIN (
      SELECT tech_id, SUM(amount) AS points FROM points WHERE amount > 0 AND created_at >= ?1 AND created_at < ?2 GROUP BY tech_id
    ) pt ON pt.tech_id = t.id
    WHERE (?3 = 0 OR t.active = 1)
    ORDER BY reviews DESC, COALESCE(cr.avg_rating, 0) DESC, taps DESC, t.sort, t.name`, start, end, onlyActive ? 1 : 0);
}

export interface Kpis {
  reviews: number;
  prev_reviews: number;
  avg_rating: number | null;
  prev_avg: number | null;
  credited: number;
  taps: number;
  prev_taps: number;
  ratings: number;
  clicks: number;
  converted: number;
  unassigned: number;
  low_open: number;
  no_reply: number;
  pending: number;
  redemptions: number;
}

export async function kpis(db: D1Database, start: number, end: number, prevStart: number, prevEnd: number, trackingStart: number, lowThreshold: number): Promise<Kpis> {
  const row = await one<Kpis>(db, `
    SELECT
      (SELECT COUNT(*) FROM reviews WHERE posted_at >= ?1 AND posted_at < ?2) AS reviews,
      (SELECT COUNT(*) FROM reviews WHERE posted_at >= ?3 AND posted_at < ?4) AS prev_reviews,
      (SELECT AVG(rating) FROM reviews WHERE posted_at >= ?1 AND posted_at < ?2) AS avg_rating,
      (SELECT AVG(rating) FROM reviews WHERE posted_at >= ?3 AND posted_at < ?4) AS prev_avg,
      (SELECT COUNT(*) FROM reviews WHERE status = 'credited' AND posted_at >= ?1 AND posted_at < ?2) AS credited,
      (SELECT COUNT(*) FROM taps WHERE created_at >= ?1 AND created_at < ?2) AS taps,
      (SELECT COUNT(*) FROM taps WHERE created_at >= ?3 AND created_at < ?4) AS prev_taps,
      (SELECT COUNT(rating) FROM taps WHERE created_at >= ?1 AND created_at < ?2) AS ratings,
      (SELECT COUNT(clicked_at) FROM taps WHERE created_at >= ?1 AND created_at < ?2) AS clicks,
      (SELECT COUNT(review_id) FROM taps WHERE created_at >= ?1 AND created_at < ?2) AS converted,
      (SELECT COUNT(*) FROM reviews WHERE status = 'unassigned' AND posted_at >= ?5) AS unassigned,
      (SELECT COUNT(*) FROM taps WHERE rating <= ?6 AND resolved_at IS NULL) AS low_open,
      (SELECT COUNT(*) FROM reviews WHERE platform = 'google' AND reply IS NULL AND status <> 'history' AND posted_at >= ?5) AS no_reply,
      (SELECT COUNT(*) FROM reviews WHERE status = 'pending') AS pending,
      (SELECT COUNT(*) FROM redemptions WHERE status = 'requested') AS redemptions`,
    start, end, prevStart, prevEnd, trackingStart, lowThreshold);
  return row!;
}

/** Monday-start weeks, oldest first. */
export async function weeklyReviews(db: D1Database, tz: string, weeks: number, at: number): Promise<{ start: number; count: number; credited: number }[]> {
  const p = zonedParts(at, tz);
  const monday = zonedMidnight(p.y, p.m, p.d - ((p.wd + 6) % 7), tz);
  const starts: number[] = [];
  for (let i = weeks - 1; i >= 0; i--) starts.push(i === 0 ? monday : zonedMidnight(p.y, p.m, p.d - ((p.wd + 6) % 7) - 7 * i, tz));
  const rows = await all<{ posted_at: number; status: string }>(db, `SELECT posted_at, status FROM reviews WHERE posted_at >= ?`, starts[0]);
  const buckets = starts.map((start) => ({ start, count: 0, credited: 0 }));
  for (const r of rows) {
    let i = buckets.length - 1;
    while (i > 0 && r.posted_at < buckets[i].start) i--;
    buckets[i].count++;
    if (r.status === 'credited') buckets[i].credited++;
  }
  return buckets;
}

export async function pointsBalance(db: D1Database, techId: string): Promise<number> {
  const row = await one<{ n: number | null }>(db, `SELECT SUM(amount) AS n FROM points WHERE tech_id = ?`, techId);
  return row?.n ?? 0;
}

export const WEEK = 7 * DAY;

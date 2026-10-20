/**
 * Decides which tech a public review belongs to. Google never says which link a reviewer came from,
 * so this lines up three clues, the same way the paid tools do:
 *
 *   1. Name: the customer typed their name on a tech's page; Google shows the reviewer's name.
 *   2. Timing: how long after that visit the review was posted.
 *   3. Mention: the review names the tech ("Maya was great").
 *
 * Score ≥ 80 credits the tech automatically. 40–79 becomes a suggestion the office confirms in one click.
 * Pure functions only, so the rules are easy to test and tune.
 */
import { HOUR, MINUTE, describeGap, normName } from './util';

export const AUTO_CREDIT = 80;
export const SUGGEST = 40;

export interface TechLite { id: string; name: string; first_name: string; aliases: string; active?: number }
export interface TapLite {
  id: string;
  tech_id: string | null;
  customer_name: string | null;
  site: string | null;
  created_at: number;
  rated_at: number | null;
  clicked_at: number | null;
  location_id?: string | null; // the Google profile their button pointed at
}
export interface ReviewLite { platform: string; reviewer_name: string; body: string; posted_at: number; location_id?: string | null }

export interface Candidate {
  tech_id: string;
  score: number;
  method: 'tap' | 'mention' | 'tap+mention' | 'timing';
  tap_id: string | null;
  mentioned: boolean;
  evidence: string[];
}

export interface MatchResult { credit: Candidate[]; suggestions: Candidate[] }

// The same names are compared many times in one run, and normalizing them is the slow part.
const normCache = new Map<string, string>();
function normC(s: string | null | undefined): string {
  const k = s ?? '';
  let v = normCache.get(k);
  if (v === undefined) {
    if (normCache.size > 5000) normCache.clear();
    v = normName(k);
    normCache.set(k, v);
  }
  return v;
}

/** How alike two people's names are, 0–100. Handles "John S.", "J. Smith", "johnsmith". */
export function nameScore(a: string, b: string): number {
  const ta = normC(a).split(' ').filter(Boolean);
  const tb = normC(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  if (ta.join(' ') === tb.join(' ')) return ta.length > 1 ? 100 : 65;
  if (ta.join('') === tb.join('')) return 85; // "johnsmith" vs "john smith"

  const [fa, fb] = [ta[0], tb[0]];
  const la = ta.length > 1 ? ta[ta.length - 1] : null;
  const lb = tb.length > 1 ? tb[tb.length - 1] : null;
  const firstFull = fa === fb && fa.length > 1;
  const firstInitial = !firstFull && (fa.length === 1 || fb.length === 1) && fa[0] === fb[0];

  if (firstFull) {
    if (la && lb) {
      if (la === lb) return 95;
      if ((la.length === 1 || lb.length === 1) && la[0] === lb[0]) return 85; // John Smith vs John S
      return 0; // same first name, different surname: different person
    }
    return 65; // one side gave only a first name
  }
  if (firstInitial && la && lb && la === lb && la.length > 1) return 75; // J Smith vs John Smith
  return 0;
}

const tapTime = (t: TapLite) => t.clicked_at ?? t.rated_at ?? t.created_at;
const otherProfile = (t: TapLite, r: ReviewLite) => !!(t.location_id && r.location_id && t.location_id !== r.location_id);
const SITE_NAME: Record<string, string> = { google: 'Google', yelp: 'Yelp', bbb: 'BBB', facebook: 'Facebook' };

/**
 * How long after a review a visit may still count. The visit should come first; 2 minutes covers clock differences.
 * Any longer would let someone log a visit under a reviewer's name after seeing the review, and take the credit.
 */
export const LATE_GRACE = 2 * MINUTE;

/** Points for how soon after the visit the review appeared. -1 = outside the window. */
function timeScore(gap: number, windowMs: number): number {
  if (gap < -LATE_GRACE) return -1;
  if (gap <= 30 * MINUTE) return 30;
  if (gap <= 3 * HOUR) return 20;
  if (gap <= 24 * HOUR) return 10;
  if (gap <= windowMs) return 5;
  return -1;
}

// First names that are also everyday words only count when capitalised ("Will", not "will").
const WORD_NAMES = new Set([
  'will', 'bill', 'mark', 'rich', 'chase', 'hunter', 'rob', 'pat', 'jack', 'frank', 'joy', 'hope', 'art', 'gene', 'drew',
  'ray', 'dean', 'guy', 'lance', 'miles', 'cliff', 'dale', 'glen', 'rusty', 'sandy', 'jay', 'herb', 'sonny', 'grace', 'faith',
  'dawn', 'amber', 'ruby', 'jade', 'crystal', 'brook', 'river', 'rose', 'daisy', 'holly', 'ivy', 'bob', 'major', 'king', 'max',
]);

/** Which techs the review text names. Names shared by two techs come back as ambiguous. */
export function mentionedTechs(body: string, techs: TechLite[]): Map<string, { word: string; ambiguous: boolean }> {
  const byName = new Map<string, Set<string>>();
  // Someone who has left can still be credited through their tag visits, but a name in a new review means a current tech.
  for (const t of techs.filter((x) => x.active !== 0)) {
    const names = [t.first_name, ...t.aliases.split(',')].map((n) => normC(n)).filter((n) => n.length >= 3);
    for (const n of names) {
      if (!byName.has(n)) byName.set(n, new Set());
      byName.get(n)!.add(t.id);
    }
  }
  // "Maya's work" names Maya too.
  const text = ` ${normName(body.replace(/(\p{L})['’]s\b/gu, '$1'))} `;
  const out = new Map<string, { word: string; ambiguous: boolean }>();
  for (const [n, ids] of byName) {
    if (!text.includes(` ${n} `)) continue;
    if (WORD_NAMES.has(n)) {
      const cap = n[0].toUpperCase() + n.slice(1);
      if (!new RegExp(`\\b${cap}\\b`).test(body)) continue;
    }
    for (const id of ids) out.set(id, { word: n[0].toUpperCase() + n.slice(1), ambiguous: ids.size > 1 });
  }
  return out;
}

export function matchReview(review: ReviewLite, techs: TechLite[], taps: TapLite[], windowHours: number): MatchResult {
  const windowMs = windowHours * HOUR;
  const techName = new Map(techs.map((t) => [t.id, t.first_name]));
  const best = new Map<string, Candidate>();
  const keep = (c: Candidate) => {
    const cur = best.get(c.tech_id);
    if (!cur || c.score > cur.score) best.set(c.tech_id, c);
  };

  // 1 + 2: a named visit on a tech's page shortly before the review.
  for (const t of taps) {
    if (!t.tech_id || !t.customer_name) continue;
    const gap = review.posted_at - tapTime(t);
    const ts = timeScore(gap, windowMs);
    if (ts < 0) continue;
    const ns = nameScore(review.reviewer_name, t.customer_name);
    if (!ns) continue;
    const sameSite = t.site === review.platform ? 5 : 0;
    // Their button pointed at one Google profile and this review is on another: likely someone else with a similar name.
    const elsewhere = otherProfile(t, review);
    const who = techName.get(t.tech_id) ?? 'this tech';
    const clicked = t.site ? ` and chose ${SITE_NAME[t.site] ?? t.site}` : '';
    keep({
      tech_id: t.tech_id,
      score: ns + ts + sameSite - (elsewhere ? 25 : 0),
      method: 'tap',
      tap_id: t.id,
      mentioned: false,
      evidence: [`“${t.customer_name}” rated ${who} on their tag${clicked}, ${describeGap(gap)} ${gap >= 0 ? 'before' : 'after'} this review${elsewhere ? ', but they were sent to the other Google profile' : ''}`],
    });
  }

  // Fallback: exactly one tech's customer clicked through to this site in the 3 hours before.
  if (!best.size) {
    const clicks = taps.filter((t) => t.tech_id && t.clicked_at && t.site === review.platform && !otherProfile(t, review)
      && review.posted_at - t.clicked_at >= -LATE_GRACE && review.posted_at - t.clicked_at <= 3 * HOUR);
    const techIds = new Set(clicks.map((t) => t.tech_id));
    if (clicks.length && techIds.size === 1) {
      const t = clicks[clicks.length - 1];
      keep({
        tech_id: t.tech_id!,
        score: 55,
        method: 'timing',
        tap_id: t.id,
        mentioned: false,
        evidence: [`Only ${techName.get(t.tech_id!)}'s customer${t.customer_name ? ` (“${t.customer_name}”)` : ''} clicked through to ${SITE_NAME[review.platform] ?? review.platform} in the 3 hours before this review, but the names don't match`],
      });
    }
  }

  // 3: the review names the tech.
  for (const [techId, m] of mentionedTechs(review.body, techs)) {
    const note = m.ambiguous ? `Mentions “${m.word}” (more than one tech has that name)` : `Mentions “${m.word}” by name`;
    const cur = best.get(techId);
    if (cur) {
      cur.score = Math.max(cur.score, m.ambiguous ? 50 : AUTO_CREDIT) + 20;
      cur.method = cur.method === 'timing' ? 'mention' : 'tap+mention';
      cur.mentioned = true;
      cur.evidence.push(note);
    } else {
      best.set(techId, { tech_id: techId, score: m.ambiguous ? 50 : AUTO_CREDIT, method: 'mention', tap_id: null, mentioned: true, evidence: [note] });
    }
  }

  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  const auto = ranked.filter((c) => c.score >= AUTO_CREDIT);
  // Two techs' customers have similar names and the review names neither: the name can't say whose visit it was,
  // so the office decides (unless one is far more likely). One customer who rated two techs (a crew) credits both.
  const tapName = new Map(taps.map((t) => [t.id, normC(t.customer_name)]));
  const byName = auto.filter((c) => !c.mentioned && c.tap_id);
  const customers = new Set(byName.map((c) => tapName.get(c.tap_id!)));
  const unsure = customers.size < 2 ? [] : byName[0].score - byName[1].score >= 25 ? byName.slice(1) : byName;
  return {
    credit: auto.filter((c) => !unsure.includes(c)),
    suggestions: [...unsure, ...ranked.filter((c) => c.score >= SUGGEST && c.score < AUTO_CREDIT)],
  };
}

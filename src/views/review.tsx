import type { Child, FC } from 'hono/jsx';
import { platformLabel, type ReviewRow } from '../lib/reviews';
import { fmtDate } from '../lib/util';
import { Chip, Stars } from './ui';

export interface CreditView { review_id: string; tech_id: string; first_name: string; name: string; method: string; evidence: string | null }

const METHOD: Record<string, string> = {
  tap: 'Matched to their tag',
  mention: 'Named in the review',
  'tap+mention': 'Tag match and named',
  timing: 'Timing only',
  manual: 'Credited by the office',
};
export const methodLabel = (m: string) => METHOD[m] ?? m;

/** One line explaining a credit: "Matched to their tag: “Raj P” rated…" or "Credited by Myra". */
export const creditReason = (cr: Pick<CreditView, 'method' | 'evidence'>) =>
  cr.method === 'manual' ? (cr.evidence ?? methodLabel('manual')) : `${methodLabel(cr.method)}${cr.evidence ? `: ${cr.evidence}` : ''}`;

/** `reasons={false}` leaves out why each tech was credited (the tech app: it can quote another tech's customer). */
export const ReviewCard: FC<{ r: ReviewRow; credits?: CreditView[]; tz: string; href?: string; children?: Child; clamp?: boolean; reasons?: boolean }> = ({ r, credits, tz, href, children, clamp, reasons = true }) => (
  <article class="rev">
    <header class="rev__head">
      <Stars rating={r.rating} />
      <span class="rev__who">
        {href ? <a href={href}><strong>{r.reviewer_name || 'Anonymous'}</strong></a> : <strong>{r.reviewer_name || 'Anonymous'}</strong>}
        <span class="dim small">{platformLabel(r.platform)}{r.location ? ` · ${r.location}` : ''} · {fmtDate(r.posted_at, tz)}</span>
      </span>
    </header>
    {r.body ? <p class={`rev__body ${clamp ? 'line-clamp' : ''}`}>{r.body}</p> : <p class="dim small">Star rating only, no written review.</p>}
    {credits && credits.length > 0 && (
      <div class="rev__credits">
        {credits.map((cr) => <Chip tone="green" title={reasons ? creditReason(cr) : undefined}>{cr.first_name}</Chip>)}
      </div>
    )}
    {r.reply && (
      <div class="rev__reply">
        <span class="small dim">Our reply</span>
        <p>{r.reply}</p>
      </div>
    )}
    {children}
  </article>
);

export async function creditsFor(db: D1Database, reviewIds: string[]): Promise<Map<string, CreditView[]>> {
  const map = new Map<string, CreditView[]>();
  if (!reviewIds.length) return map;
  const res = await db.prepare(
    `SELECT c.review_id, c.tech_id, c.method, c.evidence, t.first_name, t.name FROM credits c JOIN techs t ON t.id = c.tech_id
     WHERE c.review_id IN (SELECT value FROM json_each(?)) ORDER BY c.created_at`,
  ).bind(JSON.stringify(reviewIds)).all<CreditView>();
  for (const row of res.results ?? []) {
    if (!map.has(row.review_id)) map.set(row.review_id, []);
    map.get(row.review_id)!.push(row);
  }
  return map;
}

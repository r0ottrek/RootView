import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppEnv } from '../../env';
import { one, run } from '../../lib/db';
import { DAY, newId, now } from '../../lib/util';
import { AdminShell, flashFrom, render, type AdminCounts } from '../../views/layout';

export type Ctx = Context<AppEnv>;

export async function counts(c: Ctx): Promise<AdminCounts> {
  const s = c.get('settings');
  return (await one<AdminCounts>(c.env.DB, `
    SELECT (SELECT COUNT(*) FROM reviews WHERE status = 'unassigned' AND posted_at >= ?1) AS unassigned,
           (SELECT COUNT(*) FROM taps WHERE rating <= ?2 AND resolved_at IS NULL) AS low,
           (SELECT COUNT(*) FROM redemptions WHERE status = 'requested') AS redemptions`, s.tracking_start, s.alert_threshold))!;
}

export async function page(c: Ctx, opts: { title: string; active: string; actions?: Child; lede?: Child }, body: Child, status: 200 | 404 | 422 = 200) {
  return render(c, (
    <AdminShell {...opts} admin={c.get('admin')} s={c.get('settings')} counts={await counts(c)} flash={flashFrom(c)}>
      {body}
    </AdminShell>
  ), status);
}

export const Seg = ({ items, current, label = 'Filter' }: { items: { key: string; label: string; href: string; count?: number }[]; current: string; label?: string }) => (
  <nav class="seg" aria-label={label}>
    {items.map((i) => (
      <a href={i.href} class={i.key === current ? 'is-active' : ''} aria-current={i.key === current ? 'true' : undefined}>
        {i.label}{i.count ? <span class="seg__n">{i.count}</span> : null}
      </a>
    ))}
  </nav>
);

/** Owners can move up to 10,000 points at a time. Managers hand out small bonuses: 100 at a time, 300 in any 24 hours. */
export const POINTS_CAP = { owner: 10_000, manager: 100, managerDay: 300 };

/** Adds a manual points change for a tech, inside the signed-in person's limits. */
export async function adjustPoints(c: Ctx, techId: string, amount: number, reason: string): Promise<'ok' | 'no-tech' | 'over-day'> {
  const a = c.get('admin');
  const t = now();
  const res = await run(c.env.DB,
    `INSERT INTO points (id, tech_id, amount, reason, created_by, created_at)
     SELECT ?1, id, ?2, ?3, ?4, ?5 FROM techs WHERE id = ?6
       AND (?7 = 'owner' OR ABS(?2) + (SELECT COALESCE(SUM(ABS(amount)), 0) FROM points
         WHERE created_by = ?4 AND created_at > ?8 AND review_id IS NULL AND tap_id IS NULL AND redemption_id IS NULL) <= ?9)`,
    newId('pt'), amount, reason, a.name, t, techId, a.role, t - DAY, POINTS_CAP.managerDay);
  if (res.meta.changes) return 'ok';
  return (await one(c.env.DB, `SELECT 1 FROM techs WHERE id = ?`, techId)) ? 'over-day' : 'no-tech';
}

const OVER_DAY = `Managers can give up to ${POINTS_CAP.managerDay} points in 24 hours. Ask an owner for bigger changes.`;
export const pointsProblem = (r: 'no-tech' | 'over-day') => (r === 'over-day' ? OVER_DAY : "That tech doesn't exist.");

export const SOURCE_LABEL: Record<string, string> = { nfc: 'NFC tap', qr: 'QR scan', text: 'Texted link', picker: 'Company QR', link: 'Link' };

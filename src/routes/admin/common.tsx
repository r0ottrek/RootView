import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppEnv } from '../../env';
import { one } from '../../lib/db';
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

export const Seg = ({ items, current }: { items: { key: string; label: string; href: string; count?: number }[]; current: string }) => (
  <nav class="seg" aria-label="Filter">
    {items.map((i) => (
      <a href={i.href} class={i.key === current ? 'is-active' : ''} aria-current={i.key === current ? 'true' : undefined}>
        {i.label}{i.count ? <span class="seg__n">{i.count}</span> : null}
      </a>
    ))}
  </nav>
);

export const SOURCE_LABEL: Record<string, string> = { nfc: 'NFC tap', qr: 'QR scan', text: 'Texted link', picker: 'Company QR', link: 'Link' };

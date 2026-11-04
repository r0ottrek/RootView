/**
 * Links: tracking links (/r/<code>) for anywhere the office asks for reviews (a CRM's automated texts, invoices,
 * emails, yard signs, the website), and how many opens, ratings and reviews each one brought in.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { audit } from '../../lib/audit';
import { all, one, run } from '../../lib/db';
import { LINK_CODE, linkUrl, type LinkRow } from '../../lib/links';
import { qrSvg } from '../../lib/qr';
import { avg1, fmtDate, newId, now, parsePeriod, periodRange, slugify, str } from '../../lib/util';
import { back } from '../../views/layout';
import { Chip, Empty, Icon } from '../../views/ui';
import { DateRange, Seg, page, pickedDates, type Ctx } from './common';

const links = new Hono<AppEnv>();

const PERIODS = [
  { key: 'all', label: 'All time' }, { key: 'month', label: 'This month' }, { key: 'last', label: 'Last month' },
  { key: 'quarter', label: '90 days' }, { key: 'year', label: 'This year' },
];

interface LinkStats extends LinkRow { tech_name: string | null; opens: number; rated: number; avg_rating: number | null; clicks: number; reviews: number }

const activeTechs = (c: Ctx) => all<{ id: string; name: string }>(c.env.DB, `SELECT id, name FROM techs WHERE active = 1 ORDER BY sort, name`);

/** The tech and destination choices, for making a link and for changing one. */
function LinkChoices({ techs, l, idp }: { techs: { id: string; name: string }[]; l?: Pick<LinkRow, 'tech_id' | 'dest'>; idp: string }) {
  return (
    <>
      <div class="field">
        <label for={`${idp}-tech`}>Who it's for</label>
        <select id={`${idp}-tech`} name="tech">
          <option value="">Anyone (they pick their tech)</option>
          {techs.map((t) => <option value={t.id} selected={l?.tech_id === t.id}>{t.name} only</option>)}
        </select>
      </div>
      <fieldset class="field link-dest">
        <legend>Where it sends them</legend>
        <label class="check"><input type="radio" name="dest" value="rate" checked={l?.dest !== 'google'} /> <span>Your rating page first <span class="dim">(recommended: the review can be traced and credited)</span></span></label>
        <label class="check"><input type="radio" name="dest" value="google" checked={l?.dest === 'google'} /> <span>Straight to Google <span class="dim">(counts opens only)</span></span></label>
      </fieldset>
    </>
  );
}

links.get('/', async (c) => {
  const s = c.get('settings');
  const period = pickedDates(c) ?? parsePeriod(c.req.query('p'), 'all');
  const range = periodRange(period, s.timezone);
  const origin = new URL(c.req.url).origin;
  const [rows, archived, techs] = await Promise.all([
    all<LinkStats>(c.env.DB, `
      SELECT l.*, t.name AS tech_name,
        (SELECT COUNT(*) FROM link_opens o WHERE o.link_id = l.id AND o.created_at >= ?1 AND o.created_at < ?2) AS opens,
        (SELECT COUNT(*) FROM taps p WHERE p.link_id = l.id AND p.rated_at >= ?1 AND p.rated_at < ?2) AS rated,
        (SELECT AVG(p.rating) FROM taps p WHERE p.link_id = l.id AND p.rated_at >= ?1 AND p.rated_at < ?2) AS avg_rating,
        (SELECT COUNT(*) FROM taps p WHERE p.link_id = l.id AND p.clicked_at >= ?1 AND p.clicked_at < ?2) AS clicks,
        (SELECT COUNT(*) FROM taps p JOIN reviews r ON r.id = p.review_id WHERE p.link_id = l.id AND r.posted_at >= ?1 AND r.posted_at < ?2) AS reviews
      FROM links l LEFT JOIN techs t ON t.id = l.tech_id WHERE l.archived_at IS NULL ORDER BY l.created_at DESC`, range.start, range.end),
    all<LinkRow>(c.env.DB, `SELECT * FROM links WHERE archived_at IS NOT NULL ORDER BY archived_at DESC`),
    activeTechs(c),
  ]);
  const host = (s.public_base_url || origin).replace(/^https?:\/\//, '').replace(/\/+$/, '');

  return page(c, {
    title: 'Links',
    active: 'links',
    lede: 'A link or QR code for anywhere you ask for reviews: your CRM\'s texts, invoices, emails, yard signs, your website. Each one counts the reviews it brings in.',
  }, (
    <div class="stack-lg">
      <section class="card">
        <h2 class="h-sm">Make a link</h2>
        <form method="post" action="/admin/links" class="form-grid">
          <div class="field"><label for="ln-name">Name</label><input id="ln-name" name="name" required maxlength={60} placeholder="Invoice emails" /><p class="hint">What you'll see in reports.</p></div>
          <div class="field">
            <label for="ln-code">Address</label>
            <div class="link-code"><span class="dim small">{host}/r/</span><input id="ln-code" name="code" maxlength={40} pattern="[A-Za-z0-9\-]{2,40}" placeholder="invoice" title="2 to 40 letters, numbers or dashes" /></div>
            <p class="hint">Short and easy to type. Leave it empty to use the name. It can't change later, so printed QR codes keep working.</p>
          </div>
          <LinkChoices techs={techs} idp="ln" />
          <div class="form-actions field--wide"><button class="btn btn--red btn--sm" type="submit"><Icon name="plus" size={16} /> Make the link</button></div>
        </form>
      </section>

      <section class="card">
        <div class="row-between">
          <h2 class="h-sm">Your links · {period.includes('_') ? range.label : range.label.toLowerCase()}</h2>
          <Seg label="Period" current={period} items={PERIODS.map((p) => ({ ...p, href: `/admin/links?p=${p.key}` }))} />
        </div>
        <DateRange range={range} tz={s.timezone} required />
        {rows.length ? (
          <div class="tbl-wrap">
            <table class="tbl">
              <caption class="sr-only">Tracking links and what each brought in</caption>
              <thead><tr>
                <th scope="col">Link</th><th scope="col" class="num">Opened</th><th scope="col" class="num">Rated</th><th scope="col" class="num">Avg</th>
                <th scope="col" class="num" title="Went on to a review site">Clicked</th><th scope="col" class="num">Reviews</th><th scope="col"><span class="sr-only">Actions</span></th>
              </tr></thead>
              <tbody>
                {rows.map((l) => {
                  const url = linkUrl(s, l.code, origin);
                  const google = l.dest === 'google';
                  return (
                    <tr id={`l-${l.id}`}>
                      <th scope="row">
                        <strong>{l.name}</strong>
                        <span class="small block"><code>{url.replace(/^https?:\/\//, '')}</code></span>
                        <span class="cluster small link-tags">
                          <Chip tone="muted">{l.tech_name ? `${l.tech_name} only` : 'Anyone'}</Chip>
                          {google && <Chip tone="muted">Straight to Google</Chip>}
                        </span>
                      </th>
                      <td class="num tnum strong">{l.opens}</td>
                      <td class="num tnum">{google ? '—' : l.rated}</td>
                      <td class="num tnum">{google ? '—' : avg1(l.avg_rating)}</td>
                      <td class="num tnum">{google ? l.opens : l.clicks}</td>
                      <td class="num tnum strong">{google ? '—' : l.reviews}</td>
                      <td>
                        <div class="link-actions">
                          <button type="button" class="btn btn--ghost btn--sm" data-copy={url} aria-label={`Copy the ${l.name} link`}><Icon name="copy" size={16} /> Copy</button>
                          <a class="btn btn--ghost btn--sm" href={`/admin/links/${l.id}/qr.svg`} aria-label={`Download the ${l.name} QR code`}><Icon name="qr" size={16} /> QR code</a>
                        </div>
                        <details class="link-edit">
                          <summary class="small">Change</summary>
                          <form method="post" action={`/admin/links/${l.id}`} class="stack-sm">
                            <div class="field"><label for={`n-${l.id}`}>Name</label><input id={`n-${l.id}`} name="name" required maxlength={60} value={l.name} /></div>
                            <LinkChoices techs={techs} l={l} idp={`e-${l.id}`} />
                            <button class="btn btn--ghost btn--sm" type="submit">Save</button>
                          </form>
                          <form method="post" action={`/admin/links/${l.id}/archive`} class="mt-sm">
                            <button class="linkbtn" type="submit">Hide from this list</button>
                            <p class="hint">The link and its QR code keep working; hidden links are listed below.</p>
                          </form>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No links yet">Make one above, for example "Invoice emails" at /r/invoice, and paste it into your invoice template.</Empty>
        )}
        <p class="hint mt-sm">Opened counts people who actually saw the page (not link previews or scanners). Reviews are the public reviews matched to a visit that came through the link.</p>
      </section>

      {archived.length > 0 && (
        <details class="card">
          <summary class="small">Hidden links ({archived.length})</summary>
          <ul class="plain req-list" role="list">
            {archived.map((l) => (
              <li>
                <span><strong>{l.name}</strong> <span class="dim small">· /r/{l.code} · hidden {fmtDate(l.archived_at ?? 0, s.timezone)}</span></span>
                <form method="post" action={`/admin/links/${l.id}/restore`}><button class="btn btn--ghost btn--sm" type="submit">Show again</button></form>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  ));
});

/** The tech and destination from a form: a tech who isn't active can't be picked. */
async function choices(c: Ctx, b: Record<string, unknown>): Promise<{ tech: string | null; dest: 'rate' | 'google' }> {
  const id = str(b.tech, 40);
  const tech = id ? (await one<{ id: string }>(c.env.DB, `SELECT id FROM techs WHERE id = ? AND active = 1`, id))?.id ?? null : null;
  return { tech, dest: str(b.dest, 10) === 'google' ? 'google' : 'rate' };
}

links.post('/', async (c) => {
  const b = await c.req.parseBody();
  const name = str(b.name, 60).trim();
  // A typed address keeps its dashes ("crm-texts"); without one, the name becomes the address ("CRM texts" → crm-texts).
  const code = slugify(str(b.code, 40).trim() || name);
  if (!name) return c.redirect(back('/admin/links', { err: 'Give the link a name, like "Invoice emails".' }), 303);
  if (!LINK_CODE.test(code)) return c.redirect(back('/admin/links', { err: 'Use 2 to 40 letters, numbers or dashes for the address.' }), 303);
  if (await one(c.env.DB, `SELECT 1 FROM links WHERE code = ?`, code)) return c.redirect(back('/admin/links', { err: `/r/${code} is already taken. Pick another address.` }), 303);
  const { tech, dest } = await choices(c, b);
  const id = newId('lnk');
  await run(c.env.DB, `INSERT INTO links (id, code, name, tech_id, dest, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, code, name, tech, dest, c.get('admin').name, now());
  await audit(c, 'link.add', `${name} (/r/${code})`);
  return c.redirect(back('/admin/links', { ok: `Made /r/${code}. Copy it into your texts or emails, or print its QR code.` }) + `#l-${id}`, 303);
});

links.post('/:id', async (c) => {
  const b = await c.req.parseBody();
  const id = c.req.param('id');
  const name = str(b.name, 60).trim();
  if (!name) return c.redirect(back('/admin/links', { err: 'A link needs a name.' }) + `#l-${id}`, 303);
  const { tech, dest } = await choices(c, b);
  const res = await run(c.env.DB, `UPDATE links SET name = ?, tech_id = ?, dest = ? WHERE id = ?`, name, tech, dest, id);
  if (!res.meta.changes) return c.redirect('/admin/links', 303);
  await audit(c, 'link.edit', name);
  return c.redirect(back('/admin/links', { ok: 'Saved.' }) + `#l-${id}`, 303);
});

// Hiding only tidies the list: the link and its printed QR code keep working.
links.post('/:id/archive', async (c) => {
  const l = await one<LinkRow>(c.env.DB, `SELECT * FROM links WHERE id = ?`, c.req.param('id'));
  if (!l) return c.redirect('/admin/links', 303);
  await run(c.env.DB, `UPDATE links SET archived_at = ? WHERE id = ? AND archived_at IS NULL`, now(), l.id);
  await audit(c, 'link.archive', `${l.name} (/r/${l.code})`);
  return c.redirect(back('/admin/links', { ok: `${l.name} is hidden. The link and its QR code still work.` }), 303);
});

links.post('/:id/restore', async (c) => {
  const l = await one<LinkRow>(c.env.DB, `SELECT * FROM links WHERE id = ?`, c.req.param('id'));
  if (!l) return c.redirect('/admin/links', 303);
  await run(c.env.DB, `UPDATE links SET archived_at = NULL WHERE id = ?`, l.id);
  await audit(c, 'link.restore', `${l.name} (/r/${l.code})`);
  return c.redirect(back('/admin/links', { ok: `${l.name} is back in the list.` }) + `#l-${l.id}`, 303);
});

links.get('/:id/qr.svg', async (c) => {
  const l = await one<LinkRow>(c.env.DB, `SELECT code FROM links WHERE id = ?`, c.req.param('id'));
  if (!l) return c.notFound();
  return c.body(qrSvg(linkUrl(c.get('settings'), l.code, new URL(c.req.url).origin), { size: 1024, border: 4 }), 200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'content-disposition': `attachment; filename="review-link-${l.code}.svg"`,
  });
});

export default links;

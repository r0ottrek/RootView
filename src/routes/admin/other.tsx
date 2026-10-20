import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../../env';
import { audit } from '../../lib/audit';
import { requireOwner, sameSecret } from '../../lib/auth';
import { all, one, run, stmt } from '../../lib/db';
import { HOW_LABEL, parseAreas, type RouteHow } from '../../lib/geo';
import { accessToken, authUrl, exchangeCode, listAccounts, listLocations, pkcePair, revokeToken } from '../../lib/google';
import { qrSvg } from '../../lib/qr';
import { deleteTap, deleteTaps, platformLabel, startFresh, syncGoogle } from '../../lib/reviews';
import {
  companyName, getSecret, hasSecret, locationLabel, saveSettings, setSecret, tagUrl, type GoogleLocation, type ReviewLocation, type ReviewSite, type Settings,
} from '../../lib/settings';
import { CALL_TIMES, HOUR, clampInt, fmtDate, fmtDateTime, line, newId, now, randomToken, relTime, sha256hex, str, telHref } from '../../lib/util';
import { back } from '../../views/layout';
import { Avatar, Chip, Empty, Icon, Pager, Stars } from '../../views/ui';
import { POINTS_CAP, SOURCE_LABEL, Seg, adjustPoints, page, pointsProblem, type Ctx } from './common';

const other = new Hono<AppEnv>();

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const INVITE_HOURS = 72;
const safeBack = (v: unknown, fallback: string) => {
  const r = str(v, 300);
  return r.startsWith('/admin/') && !r.startsWith('//') ? r : fallback;
};

// =====================================================================
// Tag activity
// =====================================================================

interface ActRow {
  id: string; tech_id: string; slug: string; first_name: string; name: string; photo: number; updated_at: number; source: string; customer_name: string | null;
  rating: number | null; comment: string | null; site: string | null; created_at: number; clicked_at: number | null; review_id: string | null;
  resolved_at: number | null; resolved_by: string | null;
  callback_phone: string | null; callback_time: string | null; callback_at: number | null;
  followup_status: 'called' | 'resolved' | 'unresolved' | null; followup_note: string | null; followup_at: number | null; followup_by: string | null;
  location_id: string | null; location_how: RouteHow | null; geo: string | null;
}

/** "Google" or, with two or more locations, "Google · Downtown" plus why that profile was picked. */
function WentTo({ p, s }: { p: ActRow; s: Settings }) {
  if (!p.site) return <span class="dim">—</span>;
  const loc = p.site === 'google' && s.locations.length > 1 ? locationLabel(s, p.location_id) : null;
  if (!loc) return <>{platformLabel(p.site)}</>;
  const why = [p.location_how ? HOW_LABEL[p.location_how] : null, p.geo ? `customer's connection: ${p.geo}` : null].filter(Boolean).join(' · ');
  return <>{platformLabel(p.site)} · {loc}{why && <span class="small dim block">{why}</span>}</>;
}

const FOLLOWUP: Record<string, { label: string; tone?: 'green' | 'red' | 'muted' }> = {
  new: { label: 'Not contacted yet', tone: 'red' },
  called: { label: 'Called, waiting' },
  resolved: { label: 'Resolved', tone: 'green' },
  unresolved: { label: "Couldn't resolve", tone: 'muted' },
};

const FILTERS = ['all', 'low', 'lowall', 'yelp', 'bbb', 'rated', 'matched', 'unfinished'] as const;

other.get('/activity', async (c) => {
  const s = c.get('settings');
  const q = c.req.query('f') ?? '';
  const f = (FILTERS as readonly string[]).includes(q) ? q : 'all';
  const googleConnected = (await hasSecret(c.env, 'google_refresh')) && s.google_locations.length > 0;
  const tech = /^[\w-]{1,40}$/.test(c.req.query('tech') ?? '') ? c.req.query('tech')! : '';
  const pageNo = clampInt(c.req.query('page'), 1, 1000, 1);
  const followups = f === 'low' || f === 'lowall';
  const where: string[] = [];
  const params: unknown[] = [];
  if (f === 'low') { where.push('p.rating <= ? AND p.resolved_at IS NULL'); params.push(s.alert_threshold); }
  if (f === 'lowall') { where.push('p.rating <= ?'); params.push(s.alert_threshold); }
  if (f === 'yelp' || f === 'bbb') { where.push('p.site = ? AND p.review_id IS NULL'); params.push(f); }
  if (f === 'rated') where.push('p.rating IS NOT NULL AND p.review_id IS NULL');
  if (f === 'matched') where.push('p.review_id IS NOT NULL');
  if (f === 'unfinished') where.push('p.rating IS NULL');
  if (tech) { where.push('p.tech_id = ?'); params.push(tech); }
  // Open follow-ups: people waiting for a call first, then newest.
  const order = f === 'low' ? 'p.callback_at IS NULL, COALESCE(p.callback_at, p.created_at) DESC' : 'p.created_at DESC';
  const rows = await all<ActRow>(c.env.DB, `
    SELECT p.*, t.slug, t.first_name, t.name, t.photo IS NOT NULL AS photo, t.updated_at FROM taps p JOIN techs t ON t.id = p.tech_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT 51 OFFSET ?`, ...params, (pageNo - 1) * 50);
  const techs = await all<{ id: string; name: string }>(c.env.DB, `SELECT id, name FROM techs ORDER BY active DESC, sort, name`);
  const shown = rows.slice(0, 50);
  const here = c.req.url.replace(new URL(c.req.url).origin, '');
  const siteOn = (id: string) => s.sites.some((x) => x.id === id && x.enabled);
  const labels: Record<string, string> = {
    all: 'All visits', low: 'Low ratings to follow up', lowall: 'All low ratings',
    ...(siteOn('yelp') ? { yelp: 'Went to Yelp' } : {}), ...(siteOn('bbb') ? { bbb: 'Went to BBB' } : {}),
    rated: 'Rated, no review yet', matched: 'Became reviews', unfinished: "Didn't finish",
  };
  // Sites whose reviews are typed in by hand get an "Add their review" shortcut (Google too, until it's connected).
  const manualSite = (site: string | null) => !!site && (site !== 'google' || !googleConnected);
  return page(c, {
    title: 'Tag activity',
    active: 'activity',
    lede: followups
      ? `Customers who rated ${s.alert_threshold} stars or fewer. They were offered a call-back, with the review links still below it. Call, then record how it went.`
      : f === 'yelp' || f === 'bbb'
        ? `Customers who tapped the ${f === 'yelp' ? 'Yelp' : 'BBB'} button and haven't been linked to a review yet. When their review shows up on ${f === 'yelp' ? 'Yelp' : 'BBB'}, click "Add their review" and copy it in; it's credited to that tech.`
        : 'Every tap, scan and texted link: who rated which tech, and where they went next. Ratings here are private to your team.',
  }, (
    <>
      <Seg current={f} items={Object.entries(labels).map(([key, label]) => ({ key, label, href: `/admin/activity?f=${key}${tech ? `&tech=${tech}` : ''}` }))} />
      <form class="filters" method="get">
        <input type="hidden" name="f" value={f} />
        <label class="sr-only" for="at">Tech</label>
        <select id="at" name="tech"><option value="">All techs</option>{techs.map((t) => <option value={t.id} selected={t.id === tech}>{t.name}</option>)}</select>
        <button class="btn btn--ghost btn--sm" type="submit">Show</button>
      </form>
      {followups && shown.length ? (
        <div class="stack-md">{shown.map((p) => <FollowUpCard p={p} s={s} back={here} />)}</div>
      ) : shown.length ? (
        <section class="card">
          <div class="tbl-wrap">
            <table class="tbl">
              <thead><tr><th scope="col">When</th><th scope="col">Tech</th><th scope="col">How</th><th scope="col">Customer</th><th scope="col">Rating</th><th scope="col">Went to</th><th scope="col">Public review</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {shown.map((p) => (
                  <tr class={p.rating != null && p.rating <= s.alert_threshold && !p.resolved_at ? 'is-alert' : ''}>
                    <td class="nowrap" title={fmtDateTime(p.created_at, s.timezone)}>{relTime(p.created_at, s.timezone)}</td>
                    <td><a class="person" href={`/admin/team/${p.tech_id}`}><Avatar tech={{ id: p.tech_id, name: p.name, photo: p.photo, updated_at: p.updated_at }} size={24} /><span>{p.first_name}</span></a></td>
                    <td class="nowrap">{SOURCE_LABEL[p.source] ?? p.source}</td>
                    <td>{p.customer_name ?? <span class="dim">Didn't finish</span>}{p.comment && <p class="small muted">{p.comment}</p>}</td>
                    <td>{p.rating ? <Stars rating={p.rating} size={12} /> : <span class="dim">—</span>}</td>
                    <td><WentTo p={p} s={s} /></td>
                    <td>{p.review_id
                      ? <a href={`/admin/reviews/${p.review_id}`}>Matched</a>
                      : manualSite(p.site) ? <a class="btn btn--ghost btn--sm" href={`/admin/reviews/new?tap=${p.id}`}>Add their review</a> : <span class="dim">—</span>}</td>
                    <td class="nowrap">
                      <div class="cluster">
                        {p.rating != null && p.rating <= s.alert_threshold && (
                          <a href={`/admin/activity?f=lowall#f-${p.id}`}><Chip tone={FOLLOWUP[p.followup_status ?? 'new'].tone}>{p.callback_at && !p.followup_status ? 'Wants a call' : FOLLOWUP[p.followup_status ?? 'new'].label}</Chip></a>
                        )}
                        <DeleteVisit id={p.id} back={here} who={p.customer_name} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : <Empty title="Nothing here">{f === 'low' ? 'No low ratings waiting for follow-up.' : 'No tag visits match this filter yet.'}</Empty>}
      <Pager page={pageNo} hasMore={rows.length > 50} base={`/admin/activity?f=${f}${tech ? `&tech=${tech}` : ''}`} />
    </>
  ));
});

/** Numbers outside North America are worth a second look before calling (cost, or a made-up number). */
const international = (phone: string) => /^\s*\+(?!1\D|1$)/.test(phone) || phone.replace(/\D/g, '').length > 11;

function FollowUpCard({ p, s, back: ret }: { p: ActRow; s: Settings; back: string }) {
  const status = FOLLOWUP[p.followup_status ?? 'new'];
  const first = (p.customer_name ?? '').split(/\s+/)[0] || 'there';
  const sms = p.callback_phone
    ? `sms:${telHref(p.callback_phone).slice(4)}?&body=${encodeURIComponent(`Hi ${first}, it's ${companyName(s)}. Thanks for talking with us. If you'd like to share how it went, you can leave a review here: ${tagUrl(s, p.slug, 'text')}`)}`
    : null;
  return (
    <article class="rev followup" id={`f-${p.id}`}>
      <header class="rev__head">
        <Stars rating={p.rating} />
        <span class="rev__who">
          <strong>{p.customer_name ?? 'Customer'}</strong>
          <span class="dim small">rated <a href={`/admin/team/${p.tech_id}`}>{p.first_name}</a> · {relTime(p.created_at, s.timezone)} · {SOURCE_LABEL[p.source] ?? p.source}</span>
        </span>
        <span class="followup__status"><Chip tone={p.callback_at && !p.followup_status ? 'red' : status.tone}>{p.callback_at && !p.followup_status ? 'Wants a call' : status.label}</Chip></span>
      </header>
      {p.comment && <p class="rev__body">{p.comment}</p>}
      {p.callback_phone ? (
        <p class="callback-line">
          <Icon name="phone" size={18} />
          <span>Call <a href={telHref(p.callback_phone)}><strong>{p.callback_phone}</strong></a> {CALL_TIMES[p.callback_time ?? 'asap'] ?? ''} <span class="dim small">· asked {relTime(p.callback_at ?? p.created_at, s.timezone)}</span>
            {international(p.callback_phone) && <> <Chip tone="muted" title="Outside North America: check it looks right before calling">International number</Chip></>}</span>
        </p>
      ) : (
        <p class="small dim">No call-back requested. They saw the form and the office number{p.site ? `, and went to ${platformLabel(p.site)}` : ''}.</p>
      )}
      {p.followup_note && <p class="small muted followup__note">“{p.followup_note}” <span class="dim">· {p.followup_by}, {relTime(p.followup_at ?? 0, s.timezone)}</span></p>}
      {p.review_id && <p class="small"><a href={`/admin/reviews/${p.review_id}`}>They posted a public review</a></p>}
      <form method="post" action={`/admin/activity/${p.id}/followup`} class="followup__form">
        <input type="hidden" name="back" value={ret} />
        <label class="sr-only" for={`note-${p.id}`}>Note</label>
        <input id={`note-${p.id}`} name="note" maxlength={500} placeholder="Note: what happened on the call (optional)" />
        <div class="cluster">
          <button class="btn btn--ghost btn--sm" type="submit" name="status" value="called">Called, waiting</button>
          <button class="btn btn--green btn--sm" type="submit" name="status" value="resolved">Resolved</button>
          <button class="btn btn--ghost btn--sm" type="submit" name="status" value="unresolved">Couldn't resolve</button>
          {sms && <a class="btn btn--ghost btn--sm" href={sms}><Icon name="message" size={16} /> Text the review link</a>}
        </div>
      </form>
      <div class="followup__foot"><DeleteVisit id={p.id} back={ret} who={p.customer_name} /></div>
    </article>
  );
}

function DeleteVisit({ id, back: ret, who }: { id: string; back: string; who: string | null }) {
  return (
    <form method="post" action={`/admin/activity/${id}/delete`} data-confirm={`Delete this visit${who ? ` from ${who}` : ''}? Use this for tests. It can't be undone.`}>
      <input type="hidden" name="back" value={ret} />
      <button class="linkbtn small" type="submit" aria-label={`Delete visit${who ? ` from ${who}` : ''}`}>Delete</button>
    </form>
  );
}

other.post('/activity/:id/delete', async (c) => {
  const b = await c.req.parseBody();
  const id = c.req.param('id');
  const tap = await one<{ id: string }>(c.env.DB, `SELECT id FROM taps WHERE id = ?`, id);
  if (tap) {
    await deleteTap(c.env, id);
    // The id only: the activity log is kept, and the customer's name shouldn't outlive their visit.
    await audit(c, 'visit.delete', id);
  }
  return c.redirect(back(safeBack(b.back, '/admin/activity'), { ok: 'Visit deleted.' }), 303);
});

other.post('/activity/:id/followup', async (c) => {
  const b = await c.req.parseBody();
  const status = str(b.status, 12);
  if (!['called', 'resolved', 'unresolved'].includes(status)) return c.redirect('/admin/activity?f=low', 303);
  const who = c.get('admin').name;
  const t = now();
  const closed = status !== 'called';
  await run(c.env.DB,
    `UPDATE taps SET followup_status = ?1, followup_note = COALESCE(NULLIF(?2, ''), followup_note), followup_at = ?3, followup_by = ?4,
       resolved_at = CASE WHEN ?5 THEN ?3 ELSE NULL END, resolved_by = CASE WHEN ?5 THEN ?4 ELSE NULL END
     WHERE id = ?6`,
    status, str(b.note, 500), t, who, closed ? 1 : 0, c.req.param('id'));
  const msg = status === 'called' ? "Logged the call. It stays in the list until it's resolved." : status === 'resolved' ? 'Marked resolved. Nice work.' : 'Closed as not resolved.';
  return c.redirect(back(safeBack(b.back, '/admin/activity?f=low'), { ok: msg }), 303);
});

// =====================================================================
// Rewards
// =====================================================================

interface Reward { id: string; name: string; description: string; cost: number; active: number }
interface Redemption { id: string; tech_id: string; first_name: string; name: string; reward_name: string; cost: number; status: string; created_at: number; decided_by: string | null }

other.get('/rewards', async (c) => {
  const s = c.get('settings');
  const owner = c.get('admin').role === 'owner';
  const [rewards, open, recent, techs] = await Promise.all([
    all<Reward>(c.env.DB, `SELECT * FROM rewards ORDER BY active DESC, cost`),
    all<Redemption>(c.env.DB, `SELECT d.*, t.first_name, t.name FROM redemptions d JOIN techs t ON t.id = d.tech_id WHERE d.status IN ('requested', 'approved') ORDER BY d.created_at`),
    all<Redemption>(c.env.DB, `SELECT d.*, t.first_name, t.name FROM redemptions d JOIN techs t ON t.id = d.tech_id WHERE d.status IN ('fulfilled', 'denied') ORDER BY d.decided_at DESC LIMIT 10`),
    all<{ id: string; name: string }>(c.env.DB, `SELECT id, name FROM techs WHERE active = 1 ORDER BY sort, name`),
  ]);
  const p = s.points;
  const cap = owner ? 10_000 : 100;
  return page(c, { title: 'Rewards', active: 'rewards', lede: 'Points turn reviews into something techs can spend. Keep the prizes small and frequent.' }, (
    <div class="stack-lg">
      <section class="card">
        <h2 class="h-sm">Requests</h2>
        {open.length ? (
          <ul class="plain req-list" role="list">
            {open.map((r) => (
              <li>
                <div><strong>{r.name}</strong> wants <strong>{r.reward_name}</strong> <span class="dim small">· {r.cost} pts · {fmtDate(r.created_at, s.timezone)}</span>
                  {r.status === 'approved' && <Chip tone="green">Approved{r.decided_by ? ` by ${r.decided_by}` : ''}</Chip>}</div>
                <div class="cluster">
                  {r.status === 'requested' && <form method="post" action={`/admin/redemptions/${r.id}`}><input type="hidden" name="do" value="approve" /><button class="btn btn--green btn--sm" type="submit">Approve</button></form>}
                  <form method="post" action={`/admin/redemptions/${r.id}`}><input type="hidden" name="do" value="fulfill" /><button class="btn btn--ghost btn--sm" type="submit">Mark given</button></form>
                  <form method="post" action={`/admin/redemptions/${r.id}`} data-confirm={`Deny and refund ${r.cost} points to ${r.first_name}?`}><input type="hidden" name="do" value="deny" /><button class="linkbtn small" type="submit">Deny + refund</button></form>
                </div>
              </li>
            ))}
          </ul>
        ) : <p class="muted small">No open requests.</p>}
        {recent.length > 0 && (
          <details class="mt-sm"><summary class="small">Recently handled</summary>
            <ul class="plain small" role="list">{recent.map((r) => <li>{r.name} · {r.reward_name} · {r.status}{r.decided_by ? ` by ${r.decided_by}` : ''}</li>)}</ul>
          </details>
        )}
      </section>

      <div class="detail-grid">
        <section class="card">
          <h2 class="h-sm">Catalog</h2>
          {!owner && <p class="small dim">Only an owner can change rewards and costs.</p>}
          {rewards.length ? (
            <ul class="plain catalog" role="list">
              {rewards.map((r) => (
                <li class={r.active ? '' : 'is-off'}>
                  <form method="post" action={`/admin/rewards/${r.id}`}>
                    <fieldset class="catalog__row bare" disabled={!owner}>
                      <label class="sr-only" for={`n-${r.id}`}>Name</label><input id={`n-${r.id}`} name="name" value={r.name} maxlength={80} required />
                      <label class="sr-only" for={`c-${r.id}`}>Cost</label><input id={`c-${r.id}`} name="cost" type="number" min={1} max={100000} value={String(r.cost)} class="w-sm" required />
                      <label class="check small"><input type="checkbox" name="active" value="1" checked={!!r.active} /> On</label>
                      <button class="btn btn--ghost btn--sm" type="submit">Save</button>
                    </fieldset>
                  </form>
                </li>
              ))}
            </ul>
          ) : <p class="muted small">No rewards yet. Ideas: gift cards, lunch for the crew, a paid half-day, first pick of the schedule.</p>}
          {owner && (
            <form method="post" action="/admin/rewards" class="catalog__row mt-sm">
              <label class="sr-only" for="rn">New reward</label><input id="rn" name="name" placeholder="New reward, e.g. $50 gift card" maxlength={80} required />
              <label class="sr-only" for="rc">Cost</label><input id="rc" name="cost" type="number" min={1} max={100000} placeholder="pts" class="w-sm" required />
              <button class="btn btn--red btn--sm" type="submit">Add</button>
            </form>
          )}
        </section>

        <section class="card">
          <h2 class="h-sm">How points are earned</h2>
          <form method="post" action="/admin/rewards/rules">
            <fieldset class="form-grid form-grid--tight bare" disabled={!owner}>
              <div class="field"><label for="pr">Per credited review</label><input id="pr" name="review" type="number" min={0} max={1000} value={String(p.review)} /></div>
              <div class="field"><label for="p5">Bonus for 5 stars</label><input id="p5" name="five_star" type="number" min={0} max={1000} value={String(p.five_star)} /></div>
              <div class="field"><label for="pm">Bonus when named</label><input id="pm" name="mention" type="number" min={0} max={1000} value={String(p.mention)} /></div>
              <div class="field"><label for="pt">Per rating on their tag</label><input id="pt" name="rating" type="number" min={0} max={100} value={String(p.rating)} /><p class="hint">Keep at 0 unless you trust it: a tech could tap their own tag.</p></div>
              <div class="field"><label for="pmin">No points below</label>
                <select id="pmin" name="min_rating">{[1, 2, 3, 4, 5].map((n) => <option value={String(n)} selected={p.min_rating === n}>{n} stars</option>)}</select></div>
              <div class="form-actions field--wide"><button class="btn btn--ghost btn--sm" type="submit">Save rules</button><span class="small dim">Applies to reviews credited from now on.</span></div>
            </fieldset>
          </form>
          <h3 class="h-xs mt-md">Give or take points</h3>
          <form method="post" action="/admin/rewards/adjust" class="inline-form">
            <label class="sr-only" for="at2">Tech</label>
            <select id="at2" name="tech" required><option value="">Tech…</option>{techs.map((t) => <option value={t.id}>{t.name}</option>)}</select>
            <label class="sr-only" for="aa">Points</label><input id="aa" name="amount" type="number" min={-cap} max={cap} class="w-sm" placeholder="+25" required />
            <label class="sr-only" for="ar">Reason</label><input id="ar" name="reason" maxlength={120} placeholder="Reason" />
            <button class="btn btn--ghost btn--sm" type="submit">Record</button>
          </form>
          {!owner && <p class="hint">Up to {cap} points at a time. Bigger changes need an owner.</p>}
        </section>
      </div>
    </div>
  ));
});

other.post('/rewards', requireOwner, async (c) => {
  const b = await c.req.parseBody();
  const name = line(b.name, 80);
  const cost = clampInt(b.cost, 1, 100000, 0);
  if (!name || !cost) return c.redirect(back('/admin/rewards', { err: 'Give the reward a name and a cost.' }), 303);
  await run(c.env.DB, `INSERT INTO rewards (id, name, cost, created_at) VALUES (?, ?, ?, ?)`, newId('rw'), name, cost, now());
  await audit(c, 'reward.add', `${name} (${cost} pts)`);
  return c.redirect(back('/admin/rewards', { ok: `Added ${name}.` }), 303);
});

other.post('/rewards/rules', requireOwner, async (c) => {
  const b = await c.req.parseBody();
  const points = {
    review: clampInt(b.review, 0, 1000, 10), five_star: clampInt(b.five_star, 0, 1000, 5), mention: clampInt(b.mention, 0, 1000, 5),
    rating: clampInt(b.rating, 0, 100, 0), min_rating: clampInt(b.min_rating, 1, 5, 4),
  };
  await saveSettings(c.env.DB, { points });
  await audit(c, 'reward.rules', JSON.stringify(points));
  return c.redirect(back('/admin/rewards', { ok: 'Point rules saved.' }), 303);
});

other.post('/rewards/adjust', async (c) => {
  const b = await c.req.parseBody();
  const cap = c.get('admin').role === 'owner' ? POINTS_CAP.owner : POINTS_CAP.manager;
  const amount = clampInt(b.amount, -cap, cap, 0);
  const tech = str(b.tech, 40);
  if (!amount || !tech) return c.redirect(back('/admin/rewards', { err: `Pick a tech and a number of points between -${cap} and ${cap}.` }), 303);
  const reason = line(b.reason, 120) || (amount > 0 ? 'Bonus from the office' : 'Adjustment');
  const res = await adjustPoints(c, tech, amount, reason);
  if (res !== 'ok') return c.redirect(back('/admin/rewards', { err: pointsProblem(res) }), 303);
  await audit(c, 'points.adjust', `${amount > 0 ? '+' : ''}${amount} for ${tech}: ${reason}`);
  return c.redirect(back('/admin/rewards', { ok: 'Points recorded.' }), 303);
});

other.post('/rewards/:id', requireOwner, async (c) => {
  const b = await c.req.parseBody();
  const name = line(b.name, 80);
  if (!name) return c.redirect(back('/admin/rewards', { err: 'Rewards need a name.' }), 303);
  await run(c.env.DB, `UPDATE rewards SET name = ?, cost = ?, active = ? WHERE id = ?`, name, clampInt(b.cost, 1, 100000, 1), b.active ? 1 : 0, c.req.param('id'));
  await audit(c, 'reward.edit', name);
  return c.redirect(back('/admin/rewards', { ok: 'Saved.' }), 303);
});

/**
 * Each step only moves forward from the state it expects, so a double-click or two people at once can't
 * refund twice or "give" a denied reward.
 */
other.post('/redemptions/:id', async (c) => {
  const b = await c.req.parseBody();
  const id = c.req.param('id');
  const r = await one<{ id: string; tech_id: string; cost: number; reward_name: string; status: string }>(c.env.DB, `SELECT * FROM redemptions WHERE id = ?`, id);
  if (!r) return c.redirect('/admin/rewards', 303);
  const who = c.get('admin').name;
  const act = str(b.do, 10);
  const t = now();
  let changed = 0;
  if (act === 'deny') {
    // One transaction: the refund goes in only if this request is the one that denied it.
    const [denied] = await c.env.DB.batch([
      stmt(c.env.DB, `UPDATE redemptions SET status = 'denied', decided_at = ?, decided_by = ? WHERE id = ? AND status IN ('requested', 'approved')`, t, who, id),
      stmt(c.env.DB,
        `INSERT INTO points (id, tech_id, amount, reason, redemption_id, created_by, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM redemptions WHERE id = ? AND status = 'denied' AND decided_at = ?)
           AND NOT EXISTS (SELECT 1 FROM points WHERE redemption_id = ? AND amount > 0)`,
        newId('pt'), r.tech_id, r.cost, `Refund: ${r.reward_name}`, id, who, t, id, t, id),
    ]);
    changed = denied.meta.changes;
  } else if (act === 'approve') {
    changed = (await run(c.env.DB, `UPDATE redemptions SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'requested'`, t, who, id)).meta.changes;
  } else if (act === 'fulfill') {
    changed = (await run(c.env.DB, `UPDATE redemptions SET status = 'fulfilled', decided_at = ?, decided_by = ? WHERE id = ? AND status IN ('requested', 'approved')`, t, who, id)).meta.changes;
  }
  if (!changed) return c.redirect(back('/admin/rewards', { err: 'That request was already handled.' }), 303);
  await audit(c, `redemption.${act}`, `${r.reward_name} (${r.cost} pts)`);
  return c.redirect(back('/admin/rewards', { ok: act === 'deny' ? 'Denied and refunded.' : act === 'approve' ? 'Approved.' : 'Marked as given.' }), 303);
});

// =====================================================================
// Settings (owners)
// =====================================================================

/**
 * Review links may only point at the site they're for, so a careless or malicious edit can't send customers
 * elsewhere: known hosts only (not, say, sites.google.com), and no link that carries another address to forward to.
 */
const SITE_HOSTS: Record<string, RegExp> = {
  google: /^(?:(?:www|search|maps)\.)?google\.(?:com|ca|ie|co\.uk|co\.nz|com\.au|[a-z]{2})$|^(?:g\.page|goo\.gl|maps\.app\.goo\.gl)$/,
  yelp: /^(?:(?:www|m)\.)?yelp\.(?:com|ca|ie|co\.uk|co\.nz|com\.au)$/,
  bbb: /^(?:www\.)?bbb\.org$/,
  facebook: /^(?:(?:www|m)\.)?(?:facebook\.com|fb\.com)$|^fb\.me$/,
};

function reviewLink(site: string, raw: unknown): string | null {
  const v = str(raw, 500);
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password || !SITE_HOSTS[site]?.test(u.hostname.toLowerCase())) return null;
    if (/^\/url\b/i.test(u.pathname) || [...u.searchParams.values()].some((p) => /^(?:https?:)?\/\//i.test(p.trim()))) return null;
    return u.href;
  } catch {
    return null;
  }
}

interface AdminRow { id: string; name: string; email: string; role: string; last_login_at: number | null; totp_enabled: number; has_password: number; invite_expires_at: number | null }

async function settingsPage(c: Ctx, extra: { invite?: { name: string; email: string; link: string } } = {}) {
  const s = c.get('settings');
  const env = c.env;
  const me = c.get('admin');
  if (me.role !== 'owner') {
    return page(c, { title: 'Settings', active: 'settings' }, (
      <section class="card stack-sm">
        <p>Review links, Google, alerts and office logins are managed by an owner.</p>
        <p class="small muted">Your own password, two-step sign-in and devices are under <a href="/admin/account">Your account</a>.</p>
      </section>
    ));
  }
  const [admins, googleRefresh] = await Promise.all([
    all<AdminRow>(c.env.DB, `SELECT id, name, email, role, last_login_at, totp_enabled, password_hash IS NOT NULL AS has_password, invite_expires_at FROM admins ORDER BY created_at`),
    hasSecret(env, 'google_refresh'),
  ]);
  const googleConnected = googleRefresh;
  const site = (id: string) => s.sites.find((x) => x.id === id)!;
  const origin = new URL(c.req.url).origin;
  const tzs = Intl.supportedValuesOf('timeZone');
  const since = now() - 30 * 86_400_000;
  const [sent, posted] = s.locations.length ? await Promise.all([
    all<{ location_id: string; n: number }>(c.env.DB, `SELECT location_id, COUNT(*) AS n FROM taps WHERE location_id IS NOT NULL AND site = 'google' AND created_at > ? GROUP BY location_id`, since),
    all<{ location_id: string; n: number }>(c.env.DB, `SELECT location_id, COUNT(*) AS n FROM reviews WHERE location_id IS NOT NULL AND posted_at > ? GROUP BY location_id`, since),
  ]) : [[], []];
  const count = (rows: { location_id: string; n: number }[], id: string) => rows.find((r) => r.location_id === id)?.n ?? 0;

  return page(c, { title: 'Settings', active: 'settings', lede: <>Business name, logo and colors are under <a href="/admin/branding">Branding</a>.</> }, (
    <div class="stack-lg settings">
      {extra.invite && (
        <section class="card card--highlight" aria-live="polite">
          <h2 class="h-sm">Invite link for {extra.invite.name}</h2>
          <p class="small muted">Shown once. It works one time and expires in {INVITE_HOURS / 24} days. {extra.invite.name.split(' ')[0]} opens it, chooses a password, and signs in with {extra.invite.email}.</p>
          <div class="linkshare">
            <div class="qr-inline" dangerouslySetInnerHTML={{ __html: qrSvg(extra.invite.link, { size: 148, border: 2 }) }} />
            <div class="stack-sm">
              <code class="breakall">{extra.invite.link}</code>
              <div class="cluster">
                <button type="button" class="btn btn--ghost btn--sm" data-copy={extra.invite.link}><Icon name="copy" size={16} /> Copy</button>
                <a class="btn btn--ghost btn--sm" href={`mailto:${encodeURIComponent(extra.invite.email)}?subject=${encodeURIComponent(`Your ${companyName(s)} dashboard login`)}&body=${encodeURIComponent(`Choose your password here (works once, for ${INVITE_HOURS / 24} days): ${extra.invite.link}`)}`}><Icon name="mail" size={16} /> Email it</a>
              </div>
            </div>
          </div>
        </section>
      )}

      <section class="card" id="sites">
        <h2 class="h-sm">Review sites</h2>
        <p class="small muted">The buttons customers see after rating, in this order. Every customer sees every enabled site, whatever rating they gave.</p>
        <form method="post" action="/admin/settings/sites" class="stack-md">
          {(['google', 'yelp', 'bbb', 'facebook'] as const).map((id) => (
            <div class="site-row">
              <label class="check"><input type="checkbox" name={`${id}_on`} value="1" checked={site(id).enabled} /> <strong>{site(id).label}</strong></label>
              <div class="field"><label for={`${id}_url`} class="sr-only">{site(id).label} review link</label><input id={`${id}_url`} name={`${id}_url`} type="url" value={site(id).url} maxlength={500} placeholder="https://" /></div>
              {id === 'google' && <p class="hint">{s.locations.length
                ? 'Each location under Locations uses its own Google link; this one is only a backup.'
                : 'In Google Business Profile, "Ask for reviews" (or "Get more reviews") gives you this link.'}</p>}
              {id === 'yelp' && <p class="hint">Opens your Yelp page, which has a Write a Review button. Yelp's guidelines ask businesses not to request reviews, and its filter may hide some reviews it thinks were requested. Yelp reviews don't come in automatically: add them under Reviews → Add a review.</p>}
              {id === 'bbb' && <p class="hint">Paste BBB's "Leave a review" link if you have it. The profile page also has a Write a Review button.</p>}
            </div>
          ))}
          <button class="btn btn--ghost btn--sm" type="submit">Save review sites</button>
        </form>
      </section>

      <section class="card" id="locations">
        <h2 class="h-sm">Locations</h2>
        <p class="small muted">With two or more Google profiles, each customer's Google button opens the profile for where the job was. In order: where the tech said they're working today (in their app), the customer's city or ZIP code (from their internet connection; skipped on cell data, which is often wrong), the tech's home location (Team → tech), then the main location.</p>
        {s.locations.length ? (
          <form method="post" action="/admin/settings/locations" class="stack-md">
            {s.locations.map((l, i) => {
              const g = s.google_totals[l.id];
              return (
                <fieldset class="loc">
                  <legend><strong>{l.label}</strong>{i === 0 && <> <Chip tone="green">Main</Chip></>}</legend>
                  <p class="small dim">
                    {g ? `Google: ${g.rating?.toFixed(1) ?? '—'}★ · ${g.count?.toLocaleString('en-US') ?? '—'} reviews. ` : l.id.startsWith('loc_') ? "Added by hand: its reviews aren't imported. " : ''}
                    Last 30 days: {count(sent, l.id)} customer{count(sent, l.id) === 1 ? '' : 's'} sent, {count(posted, l.id)} new review{count(posted, l.id) === 1 ? '' : 's'}.
                  </p>
                  <input type="hidden" name={`id_${i}`} value={l.id} />
                  <div class="form-grid">
                    <div class="field"><label for={`label_${i}`}>Name</label><input id={`label_${i}`} name={`label_${i}`} required maxlength={40} value={l.label} /></div>
                    <div class="field"><label for={`bonus_${i}`}>Bonus points per review</label><input id={`bonus_${i}`} name={`bonus_${i}`} type="number" min={0} max={100} value={String(l.bonus)} /><p class="hint">On top of the usual points. Use it to grow a newer profile.</p></div>
                    <div class="field field--wide"><label for={`url_${i}`}>Google review link</label><input id={`url_${i}`} name={`url_${i}`} type="url" required maxlength={500} value={l.review_url} placeholder="https://" /></div>
                    <div class="field field--wide"><label for={`areas_${i}`}>Cities and ZIP codes it covers</label>
                      <textarea id={`areas_${i}`} name={`areas_${i}`} rows={3} maxlength={4000} placeholder="Springfield, Shelbyville, 12345">{l.areas.join(', ')}</textarea>
                      <p class="hint">Comma separated or one per line. Customers whose connection is in one of these go to this profile. {i === 0 ? 'The main location also gets everyone not covered anywhere.' : ''}</p></div>
                    <label class="check field--wide"><input type="radio" name="main" value={l.id} checked={i === 0} /> Main location</label>
                  </div>
                </fieldset>
              );
            })}
            <div><button class="btn btn--red btn--sm" type="submit">Save locations</button></div>
          </form>
        ) : (
          <p class="small">One location: every customer gets the Google link under Review sites. {googleConnected
            ? <>For more than one, open <a href="/admin/google/locations">Choose profiles</a> and tick every Google profile customers should be sent to.</>
            : 'Connect Google below to import each profile, or add one by hand.'}</p>
        )}
        {s.locations.filter((l) => l.id.startsWith('loc_')).map((l) => (
          <form method="post" action="/admin/settings/locations/delete" class="mt-sm" data-confirm={`Stop sending customers to ${l.label}?`}>
            <input type="hidden" name="id" value={l.id} />
            <button class="linkbtn small" type="submit">Remove {l.label}</button>
          </form>
        ))}
        <details class="mt-md">
          <summary class="small">Add a location by hand</summary>
          <form method="post" action="/admin/settings/locations/add" class="form-grid mt-sm">
            <p class="hint field--wide">For a Google profile the connected login can't import. Customers can still be sent there, but its reviews won't come in on their own. Better: in Google Business Profile, add the connected login as a Manager, then tick it under Choose profiles.</p>
            <div class="field"><label for="nl">Name</label><input id="nl" name="label" required maxlength={40} placeholder="Downtown" /></div>
            <div class="field"><label for="nu">Google review link</label><input id="nu" name="review_url" type="url" required maxlength={500} placeholder="https://g.page/r/…/review" /></div>
            <div class="field field--wide"><label for="na">Cities and ZIP codes it covers</label><textarea id="na" name="areas" rows={2} maxlength={4000}></textarea></div>
            <div class="form-actions field--wide"><button class="btn btn--ghost btn--sm" type="submit">Add location</button></div>
          </form>
        </details>
      </section>

      <section class="card" id="google">
        <h2 class="h-sm">Google Business Profile</h2>
        {!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET ? (
          <div class="stack-sm small">
            <p class="muted">Not set up on the server yet. Until it is, add Google reviews by hand. Steps (more detail in the README):</p>
            <ol class="steps">
              <li>Request Business Profile API access (free) for a Google Cloud project: developers.google.com/my-business/content/prereqs.</li>
              <li>Enable "My Business Account Management API", "My Business Business Information API" and "Google My Business API".</li>
              <li>OAuth consent screen: <strong>Internal</strong> if you use Google Workspace; otherwise External, then publish it (apps left in "Testing" lose access after 7 days).</li>
              <li>Credentials → OAuth client → Web application. Authorized redirect URI: <code>{origin}/admin/google/callback</code></li>
              <li>Save the client ID and secret as the <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> secrets, then come back here.</li>
            </ol>
          </div>
        ) : !googleConnected ? (
          <div class="stack-sm">
            <p class="small muted">Sign in with the Google account that manages your Business Profiles.</p>
            <a class="btn btn--red btn--sm" href="/admin/google/connect">Connect Google</a>
          </div>
        ) : (
          <div class="stack-sm">
            <p class="small"><Chip tone="green">Connected</Chip> {s.google_account ? <>as <strong>{s.google_account}</strong>. </> : ''}{s.google_locations.length ? `Tracking ${s.google_locations.map((l) => l.title).join(' and ')}.` : 'Choose which profiles to track.'}</p>
            <p class="small dim">Only profiles this Google login manages can be tracked. To add one, make this login a Manager on it (Business Profile → People and access), or reconnect with the login that manages them all.</p>
            <p class="small dim">{s.google_last_sync_at ? `Last checked ${relTime(s.google_last_sync_at, s.timezone)}. ${s.google_last_sync_note ?? ''}` : 'Not checked yet.'}{s.google_last_sync_error && <span class="err-text"> Error: {s.google_last_sync_error}</span>}</p>
            <div class="cluster">
              <a class="btn btn--ghost btn--sm" href="/admin/google/locations">Choose profiles</a>
              <form method="post" action="/admin/google/sync"><button class="btn btn--ghost btn--sm" type="submit"><Icon name="refresh" size={16} /> Check now</button></form>
              <form method="post" action="/admin/google/sync" data-confirm="Re-import every Google review? This runs over several 15-minute cycles."><input type="hidden" name="full" value="1" /><button class="btn btn--ghost btn--sm" type="submit">Re-import history</button></form>
              <form method="post" action="/admin/google/disconnect" data-confirm="Disconnect Google? Reviews already imported stay."><button class="linkbtn small" type="submit">Disconnect</button></form>
            </div>
          </div>
        )}
        {!env.ENCRYPTION_KEY && (env.GOOGLE_CLIENT_ID || googleConnected) && (
          <p class="small flash mt-sm"><Icon name="lock" size={14} /> Set the <code>ENCRYPTION_KEY</code> secret so the Google token is stored encrypted (see the README), then disconnect and reconnect Google once.</p>
        )}
        <p class="small dim mt-sm">Reviews posted before {fmtDate(s.tracking_start || Date.now(), s.timezone)} (when tracking started) are imported as history and not matched automatically.</p>
      </section>

      <form method="post" action="/admin/settings/general" class="stack-lg">
        <section class="card" id="alerts">
          <h2 class="h-sm">Alerts</h2>
          <div class="form-grid">
            <div class="field field--wide"><label for="alert_emails">Email these people about low ratings and reward requests</label><input id="alert_emails" name="alert_emails" value={s.alert_emails.join(', ')} placeholder="office@example.com, owner@example.com" maxlength={500} /><p class="hint">Comma separated, up to 10. {env.RESEND_API_KEY ? 'Email is set up.' : <strong>Email isn't set up on the server yet (RESEND_API_KEY), so alerts only show in the dashboard.</strong>}</p></div>
            <div class="field"><label for="alert_threshold">Low rating means</label><select id="alert_threshold" name="alert_threshold">{[1, 2, 3, 4].map((n) => <option value={String(n)} selected={s.alert_threshold === n}>{n} star{n > 1 ? 's' : ''} or fewer</option>)}</select><p class="hint">These customers see a call-back request first, with the review links still below it, and the office is alerted.</p></div>
            <div class="field"><label for="alert_from">Send from</label><input id="alert_from" name="alert_from" value={s.alert_from} maxlength={120} placeholder="Reviews <reviews@example.com>" /><p class="hint">An address on a domain you've verified with Resend.</p></div>
          </div>
        </section>
        <section class="card" id="replies">
          <h2 class="h-sm">Replies</h2>
          <div class="form-grid">
            <div class="field"><label for="reply_signature">Sign replies as</label><input id="reply_signature" name="reply_signature" value={s.reply_signature} maxlength={80} placeholder={`The ${companyName(s)} team`} /></div>
            <label class="check field"><input type="checkbox" name="ai_auto_draft" value="1" checked={s.ai_auto_draft} /> Draft replies to new Google reviews automatically</label>
            <div class="field field--wide"><label for="reply_context">About the business (for AI drafts)</label><textarea id="reply_context" name="reply_context" rows={2} maxlength={400} placeholder="Family-owned plumbing and heating company serving the north county since 1998.">{s.reply_context}</textarea><p class="hint">One or two sentences the drafts can draw on. Nothing private.</p></div>
            <p class="hint field--wide">{env.ANTHROPIC_API_KEY ? 'AI drafting is on. Someone always reads a draft before it posts.' : 'AI drafting needs ANTHROPIC_API_KEY on the server. You can still write replies by hand.'}</p>
          </div>
        </section>
        <section class="card" id="general">
          <h2 class="h-sm">Matching and general</h2>
          <div class="form-grid">
            <div class="field"><label for="match_window_hours">Match reviews posted up to</label><select id="match_window_hours" name="match_window_hours">{[24, 48, 72, 120, 168].map((h) => <option value={String(h)} selected={s.match_window_hours === h}>{h / 24} day{h > 24 ? 's' : ''} after a tag visit</option>)}</select></div>
            <div class="field"><label for="timezone">Time zone</label><select id="timezone" name="timezone">{tzs.map((z) => <option value={z} selected={z === s.timezone}>{z.replace(/_/g, ' ')}</option>)}</select></div>
            <div class="field field--wide"><label for="public_base_url">Address written on tags</label><input id="public_base_url" name="public_base_url" type="url" value={s.public_base_url} maxlength={200} placeholder={origin} /><p class="hint">Use your own domain if you have one. Changing this after tags are written means rewriting every tag.</p></div>
          </div>
        </section>
        <div><button class="btn btn--red" type="submit">Save settings</button></div>
      </form>

      <section class="card" id="users">
        <h2 class="h-sm">Office logins</h2>
        <ul class="plain user-list" role="list">
          {admins.map((a) => {
            const invited = !a.has_password && !!a.invite_expires_at && a.invite_expires_at > now();
            return (
              <li class="row-between">
                <span>
                  <strong>{a.name}</strong>{a.id === me.id && <span class="dim small"> (you)</span>}
                  <span class="dim small block">{a.email} · {a.role}
                    {a.has_password ? (a.last_login_at ? ` · last in ${relTime(a.last_login_at, s.timezone)}` : ' · never signed in') : invited ? ' · invite sent' : ' · invite expired'}</span>
                </span>
                <span class="cluster">
                  {a.totp_enabled ? <Chip tone="green" title="Two-step sign-in is on">2-step</Chip> : <Chip tone="muted" title="Two-step sign-in is off">Password only</Chip>}
                  {a.id !== me.id && !a.has_password && (
                    <form method="post" action={`/admin/users/${a.id}/invite`}><button class="linkbtn small" type="submit">New invite link</button></form>
                  )}
                  {a.id !== me.id && !!a.totp_enabled && (
                    <form method="post" action={`/admin/users/${a.id}/2fa-off`} data-confirm={`Turn off two-step sign-in for ${a.name}? Do this only if they lost their phone, and ask them to set it up again.`}><button class="linkbtn small" type="submit">Turn off 2-step</button></form>
                  )}
                  {a.id !== me.id && a.role !== 'owner' && (
                    <form method="post" action={`/admin/users/${a.id}/delete`} data-confirm={`Remove ${a.name}'s access? They're signed out everywhere at once.`}><button class="linkbtn small" type="submit">Remove</button></form>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <form method="post" action="/admin/users" class="form-grid mt-md">
          <h3 class="h-xs field--wide">Invite someone</h3>
          <div class="field"><label for="un">Name</label><input id="un" name="name" required maxlength={80} /></div>
          <div class="field"><label for="ue">Email</label><input id="ue" name="email" type="email" required maxlength={120} /></div>
          <div class="field"><label for="ur">Role</label>
            <select id="ur" name="role"><option value="manager">Office manager</option><option value="owner">Owner (full control)</option></select>
            <p class="hint">Managers handle reviews, follow-ups, the team and reward requests. Owners also control settings, branding, Google and logins.</p></div>
          <div class="form-actions field--wide"><button class="btn btn--ghost btn--sm" type="submit">Make an invite link</button></div>
        </form>
        <p class="small dim mt-sm">Your own password, two-step sign-in and devices: <a href="/admin/account">Your account</a>.</p>
      </section>

      <section class="card" id="privacy">
        <h2 class="h-sm">Privacy</h2>
        <p class="small muted">If a customer asks you to delete what they typed (name, comment, phone number), find their visits here. Reviews they posted publicly live on Google, Yelp or BBB and are removed there.</p>
        <form method="get" action="/admin/privacy" class="inline-form">
          <label class="sr-only" for="pq">Name or phone</label><input id="pq" name="q" minlength={3} maxlength={80} required placeholder="Customer name or phone number" />
          <button class="btn btn--ghost btn--sm" type="submit">Find</button>
        </form>
        <p class="small dim mt-sm">Removed automatically: rough location after 30 days, call-back numbers 90 days after the follow-up closes, unfinished visits after 30 days.</p>
      </section>

      <section class="card" id="log">
        <div class="row-between"><h2 class="h-sm">Activity log</h2><a class="small" href="/admin/log">Open</a></div>
        <p class="small muted">Who changed settings, logins, points, rewards and Google, and when.</p>
      </section>

      <section class="card danger" id="start-fresh">
        <h2 class="h-sm">Start fresh</h2>
        <p class="small muted">Done testing? This deletes every tag visit, rating, call-back, review, credit, point and reward request, and starts tracking from now. Your team, reward list, settings, logins and Google connection stay.</p>
        <form method="post" action="/admin/start-fresh" data-confirm="Delete ALL tag visits, reviews, points and reward requests and start tracking from now? This can't be undone.">
          <button class="btn btn--ghost btn--sm" type="submit">Delete all test activity</button>
        </form>
      </section>
    </div>
  ));
}

other.get('/settings', (c) => settingsPage(c));

other.post('/start-fresh', requireOwner, async (c) => {
  await startFresh(c.env);
  await audit(c, 'data.start_fresh');
  return c.redirect(back('/admin', { ok: 'All test activity deleted. Tracking starts now.' }), 303);
});

other.post('/settings/sites', requireOwner, async (c) => {
  const b = await c.req.parseBody();
  const s = c.get('settings');
  const bad: string[] = [];
  const sites: ReviewSite[] = s.sites.map((x) => {
    const raw = str(b[`${x.id}_url`], 500);
    const url = raw ? reviewLink(x.id, raw) : '';
    if (url === null) bad.push(x.label);
    return { ...x, url: url ?? x.url, enabled: !!b[`${x.id}_on`] };
  });
  if (bad.length) return c.redirect(back('/admin/settings', { err: `${bad.join(' and ')}: use the https:// link from that site itself.` }) + '#sites', 303);
  if (!sites.some((x) => x.enabled && x.url) && !s.locations.length) return c.redirect(back('/admin/settings', { err: 'Keep at least one review site turned on, with its link.' }) + '#sites', 303);
  await saveSettings(c.env.DB, { sites });
  await audit(c, 'settings.sites', sites.filter((x) => x.enabled).map((x) => x.id).join(', '));
  return c.redirect(back('/admin/settings', { ok: 'Review sites saved.' }) + '#sites', 303);
});

// ---------- locations ----------

const mainFirst = (list: ReviewLocation[], mainId: string | undefined) =>
  [...list.filter((l) => l.id === mainId), ...list.filter((l) => l.id !== mainId)];

other.post('/settings/locations', requireOwner, async (c) => {
  const b = await c.req.parseBody();
  const s = c.get('settings');
  const next = s.locations.map((l, i): ReviewLocation => {
    if (str(b[`id_${i}`], 120) !== l.id) return l; // the page was out of date; leave this one alone
    return {
      ...l,
      label: line(b[`label_${i}`], 40) || l.label,
      review_url: reviewLink('google', b[`url_${i}`]) ?? l.review_url,
      areas: parseAreas(str(b[`areas_${i}`], 4000)),
      bonus: clampInt(b[`bonus_${i}`], 0, 100, 0),
    };
  });
  await saveSettings(c.env.DB, { locations: mainFirst(next, str(b.main, 120) || next[0]?.id) });
  await audit(c, 'settings.locations', next.map((l) => l.label).join(', '));
  return c.redirect(`${back('/admin/settings', { ok: 'Locations saved.' })}#locations`, 303);
});

other.post('/settings/locations/add', requireOwner, async (c) => {
  const b = await c.req.parseBody();
  const s = c.get('settings');
  const label = line(b.label, 40);
  const url = reviewLink('google', b.review_url);
  if (!label || !url) return c.redirect(`${back('/admin/settings', { err: "Add a name and the profile's https:// Google review link." })}#locations`, 303);
  const list = [...s.locations];
  // The first location: keep today's Google link as the main one, so nothing changes for everyone else.
  // With one Google profile connected, that's the profile behind it, so imported reviews line up with it.
  const current = s.sites.find((x) => x.id === 'google')?.url;
  const only = s.google_locations.length === 1 ? s.google_locations[0] : null;
  if (!list.length && current) list.push({ id: only?.name ?? newId('loc'), label: 'Main', review_url: current, areas: [], bonus: 0 });
  list.push({ id: newId('loc'), label, review_url: url, areas: parseAreas(str(b.areas, 4000)), bonus: 0 });
  await saveSettings(c.env.DB, { locations: list });
  await audit(c, 'settings.location_add', label);
  return c.redirect(`${back('/admin/settings', { ok: `${label} added. Add the cities it covers, then save.` })}#locations`, 303);
});

other.post('/settings/locations/delete', requireOwner, async (c) => {
  const id = str((await c.req.parseBody()).id, 120);
  const s = c.get('settings');
  if (!id.startsWith('loc_')) return c.redirect(`${back('/admin/settings', { err: 'Untick that profile under Google Business Profile → Choose profiles instead.' })}#locations`, 303);
  // Techs whose home or today location was this one fall back to the main location by themselves.
  await saveSettings(c.env.DB, { locations: s.locations.filter((l) => l.id !== id) });
  await audit(c, 'settings.location_remove', locationLabel(s, id) ?? id);
  return c.redirect(`${back('/admin/settings', { ok: 'Location removed.' })}#locations`, 303);
});

other.post('/settings/general', requireOwner, async (c) => {
  const b = await c.req.parseBody();
  const s = c.get('settings');
  const emails = str(b.alert_emails, 500).split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => EMAIL.test(x));
  const tz = str(b.timezone, 60);
  const from = line(b.alert_from, 120);
  const patch: Partial<Settings> = {
    alert_emails: [...new Set(emails)].slice(0, 10),
    alert_threshold: clampInt(b.alert_threshold, 1, 4, 3),
    alert_from: !from || /^([^<>@]{1,60}\s)?<?[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>?$/.test(from) ? from : s.alert_from,
    reply_signature: line(b.reply_signature, 80),
    reply_context: line(b.reply_context, 400),
    ai_auto_draft: !!b.ai_auto_draft,
    match_window_hours: clampInt(b.match_window_hours, 24, 168, 72),
  };
  // Empty means "this address"; anything else must be a plain https address (or the local preview).
  const base = str(b.public_base_url, 200).trim().replace(/\/+$/, '').toLowerCase();
  if (!base) patch.public_base_url = new URL(c.req.url).origin;
  else if (/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?$/.test(base) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) patch.public_base_url = base;
  else return c.redirect(back('/admin/settings', { err: 'The address written on tags must be a web address starting with https://, like https://reviews.example.com.' }) + '#general', 303);
  if (Intl.supportedValuesOf('timeZone').includes(tz)) patch.timezone = tz;
  await saveSettings(c.env.DB, patch);
  await audit(c, 'settings.general', `alerts to ${patch.alert_emails?.length ?? 0}, tags at ${patch.public_base_url ?? s.public_base_url}`);
  return c.redirect(back('/admin/settings', { ok: 'Settings saved.' }), 303);
});

// ---------- office logins ----------

async function newAdminInvite(c: Ctx, id: string): Promise<string> {
  const token = randomToken(24);
  await run(c.env.DB, `UPDATE admins SET invite_hash = ?, invite_expires_at = ? WHERE id = ?`, await sha256hex(token), now() + INVITE_HOURS * HOUR, id);
  return `${new URL(c.req.url).origin}/admin/invite/${token}`;
}

other.post('/users', requireOwner, async (c) => {
  const b = await c.req.parseBody();
  const email = str(b.email, 120).toLowerCase();
  const name = line(b.name, 80);
  const role = b.role === 'owner' ? 'owner' : 'manager';
  if (!EMAIL.test(email) || name.length < 2) return c.redirect(back('/admin/settings', { err: 'Add their name and a valid email.' }) + '#users', 303);
  if (await one(c.env.DB, `SELECT 1 FROM admins WHERE email = ?`, email)) return c.redirect(back('/admin/settings', { err: 'That email already has a login.' }) + '#users', 303);
  const id = newId('adm');
  await run(c.env.DB, `INSERT INTO admins (id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, NULL, ?, ?)`, id, name, email, role, now());
  const link = await newAdminInvite(c, id);
  await audit(c, 'login.invite', `${email} as ${role}`);
  return settingsPage(c, { invite: { name, email, link } });
});

other.post('/users/:id/invite', requireOwner, async (c) => {
  const a = await one<{ id: string; name: string; email: string }>(c.env.DB, `SELECT id, name, email FROM admins WHERE id = ? AND password_hash IS NULL`, c.req.param('id'));
  if (!a) return c.redirect(back('/admin/settings', { err: 'They already chose a password.' }) + '#users', 303);
  const link = await newAdminInvite(c, a.id);
  await audit(c, 'login.invite', `new link for ${a.email}`);
  return settingsPage(c, { invite: { name: a.name, email: a.email, link } });
});

other.post('/users/:id/2fa-off', requireOwner, async (c) => {
  const id = c.req.param('id');
  if (id === c.get('admin').id) return c.redirect(back('/admin/account', { err: 'Turn yours off from Your account.' }), 303);
  const a = await one<{ email: string }>(c.env.DB, `SELECT email FROM admins WHERE id = ?`, id);
  if (!a) return c.redirect('/admin/settings#users', 303);
  await run(c.env.DB, `UPDATE admins SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?`, id);
  await audit(c, 'login.2fa_off', a.email);
  return c.redirect(back('/admin/settings', { ok: `Two-step sign-in is off for ${a.email}.` }) + '#users', 303);
});

other.post('/users/:id/delete', requireOwner, async (c) => {
  const me = c.get('admin');
  const id = c.req.param('id');
  if (id === me.id) return c.redirect(back('/admin/settings', { err: "You can't remove yourself." }) + '#users', 303);
  const a = await one<{ email: string; role: string }>(c.env.DB, `SELECT email, role FROM admins WHERE id = ?`, id);
  if (!a || a.role === 'owner') return c.redirect(back('/admin/settings', { err: "Owners can't be removed here (see the README)." }) + '#users', 303);
  await c.env.DB.batch([
    stmt(c.env.DB, `DELETE FROM sessions WHERE kind IN ('admin', 'mfa') AND subject_id = ?`, id),
    stmt(c.env.DB, `DELETE FROM admins WHERE id = ? AND role <> 'owner'`, id),
  ]);
  await audit(c, 'login.remove', a.email);
  return c.redirect(back('/admin/settings', { ok: 'Login removed.' }) + '#users', 303);
});

// ---------- activity log ----------

other.get('/log', requireOwner, async (c) => {
  const s = c.get('settings');
  const pageNo = clampInt(c.req.query('page'), 1, 1000, 1);
  const rows = await all<{ admin_name: string; action: string; detail: string | null; created_at: number }>(c.env.DB,
    `SELECT admin_name, action, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT 101 OFFSET ?`, (pageNo - 1) * 100);
  return page(c, { title: 'Activity log', active: 'settings', lede: 'Changes made in the office dashboard, newest first.' }, (
    <>
      {rows.length ? (
        <section class="card">
          <div class="tbl-wrap">
            <table class="tbl">
              <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Detail</th></tr></thead>
              <tbody>{rows.slice(0, 100).map((r) => (
                <tr>
                  <td class="nowrap" title={fmtDateTime(r.created_at, s.timezone)}>{relTime(r.created_at, s.timezone)}</td>
                  <td>{r.admin_name}</td>
                  <td><code class="small">{r.action}</code></td>
                  <td class="small muted">{r.detail ?? ''}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      ) : <Empty title="Nothing logged yet" />}
      <Pager page={pageNo} hasMore={rows.length > 100} base="/admin/log" />
    </>
  ));
});

// ---------- privacy requests ----------

interface PrivacyRow { id: string; customer_name: string | null; comment: string | null; callback_phone: string | null; rating: number | null; created_at: number; first_name: string }

other.get('/privacy', requireOwner, async (c) => {
  const s = c.get('settings');
  const q = line(c.req.query('q'), 80);
  const digits = q.replace(/\D/g, '');
  const rows = q.length >= 3 ? await all<PrivacyRow>(c.env.DB, `
    SELECT p.id, p.customer_name, p.comment, p.callback_phone, p.rating, p.created_at, t.first_name
    FROM taps p JOIN techs t ON t.id = p.tech_id
    WHERE p.customer_name LIKE ?1 ESCAPE '\\'
       OR (length(?2) >= 7 AND replace(replace(replace(replace(replace(COALESCE(p.callback_phone, ''), '(', ''), ')', ''), '-', ''), ' ', ''), '+', '') LIKE '%' || ?2)
    ORDER BY p.created_at DESC LIMIT 100`, `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`, digits) : [];
  return page(c, { title: "Delete a customer's data", active: 'settings', lede: 'Find the visits a customer made, then delete them. Their name, comment, phone number and rough location go with them.' }, (
    <div class="stack-md">
      <form method="get" class="inline-form">
        <label class="sr-only" for="pq2">Name or phone</label><input id="pq2" name="q" value={q} minlength={3} maxlength={80} required placeholder="Customer name or phone number" />
        <button class="btn btn--ghost btn--sm" type="submit">Find</button>
      </form>
      {q.length >= 3 && (rows.length ? (
        <form method="post" action="/admin/privacy/delete" class="card stack-md" data-confirm="Delete the ticked visits for good?">
          <div class="tbl-wrap">
            <table class="tbl">
              <thead><tr><th scope="col"><span class="sr-only">Delete</span></th><th scope="col">When</th><th scope="col">Customer</th><th scope="col">Tech</th><th scope="col">Rating</th><th scope="col">Phone</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr>
                  <td><input type="checkbox" name="id" value={r.id} aria-label={`Delete visit from ${fmtDate(r.created_at, s.timezone)}`} /></td>
                  <td class="nowrap">{fmtDate(r.created_at, s.timezone)}</td>
                  <td>{r.customer_name ?? <span class="dim">—</span>}{r.comment && <p class="small muted line-clamp">{r.comment}</p>}</td>
                  <td>{r.first_name}</td>
                  <td>{r.rating ? <Stars rating={r.rating} size={12} /> : <span class="dim">—</span>}</td>
                  <td>{r.callback_phone ?? <span class="dim">—</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div><button class="btn btn--red btn--sm" type="submit">Delete ticked visits</button></div>
        </form>
      ) : <Empty title="No visits found">Try their first name only, or the last digits of their phone number.</Empty>)}
    </div>
  ));
});

other.post('/privacy/delete', requireOwner, async (c) => {
  const b = await c.req.parseBody({ all: true });
  const ids = (Array.isArray(b.id) ? b.id : b.id ? [b.id] : []).map((v) => str(v, 40)).filter((v) => /^[\w-]+$/.test(v)).slice(0, 100);
  const n = ids.length ? await deleteTaps(c.env, ids) : 0;
  if (n) await audit(c, 'privacy.delete', `${n} visit${n === 1 ? '' : 's'}`);
  return c.redirect(back('/admin/settings', { ok: `Deleted ${n} visit${n === 1 ? '' : 's'}.` }) + '#privacy', 303);
});

// =====================================================================
// Google connection (owners)
// =====================================================================

const redirectUri = (c: Ctx) => `${new URL(c.req.url).origin}/admin/google/callback`;
const GSTATE = '__Host-rv_gstate';

other.get('/google/connect', requireOwner, async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.redirect(back('/admin/settings', { err: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.' }) + '#google', 303);
  const state = randomToken(16);
  const { verifier, challenge } = await pkcePair();
  setCookie(c, GSTATE, `${state}.${verifier}`, { path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600 });
  return c.redirect(authUrl(c.env, redirectUri(c), state, challenge), 302);
});

other.get('/google/callback', requireOwner, async (c) => {
  const [state, verifier] = (getCookie(c, GSTATE) ?? '').split('.');
  deleteCookie(c, GSTATE, { path: '/', secure: true });
  const err = c.req.query('error');
  if (err) return c.redirect(back('/admin/settings', { err: `Google said: ${line(err, 60)}` }) + '#google', 303);
  const code = c.req.query('code');
  if (!state || !verifier || !code || !(await sameSecret(c.req.query('state') ?? '', state))) {
    return c.redirect(back('/admin/settings', { err: 'That Google sign-in expired. Try again.' }) + '#google', 303);
  }
  try {
    const tok = await exchangeCode(c.env, code, redirectUri(c), verifier);
    if (!tok.refresh_token) {
      return c.redirect(back('/admin/settings', { err: "Google didn't grant ongoing access. Remove the app at myaccount.google.com/permissions and connect again." }) + '#google', 303);
    }
    await setSecret(c.env, 'google_refresh', tok.refresh_token);
    await saveSettings(c.env.DB, { google_account: tok.email ?? null });
    await audit(c, 'google.connect', tok.email ?? '');
  } catch (e) {
    return c.redirect(back('/admin/settings', { err: e instanceof Error ? e.message : 'Google sign-in failed.' }) + '#google', 303);
  }
  return c.redirect('/admin/google/locations', 303);
});

/** A Business Profile as listed on Choose profiles, with what's needed to send customers to it. */
interface FoundProfile extends GoogleLocation { city: string; areas: string[]; review_url: string; place_id: string }

other.get('/google/locations', requireOwner, async (c) => {
  const s = c.get('settings');
  const refresh = await getSecret(c.env, 'google_refresh');
  if (!refresh) return c.redirect('/admin/settings#google', 303);
  let found: FoundProfile[] = [];
  let error = '';
  const skipped: string[] = [];
  try {
    const token = await accessToken(c.env, refresh);
    // One account Google won't list (e.g. a group this login can only view) shouldn't hide the others.
    for (const acct of await listAccounts(token)) {
      try {
        for (const loc of await listLocations(token, acct.name)) {
          found.push({
            account: acct.name,
            name: loc.name,
            title: loc.title ?? loc.name,
            city: loc.storefrontAddress?.locality ?? '',
            areas: (loc.serviceArea?.places?.placeInfos ?? []).map((p) => (p.placeName ?? '').replace(/,\s*(USA|United States)$/i, '')).filter(Boolean),
            review_url: loc.metadata?.newReviewUri ?? '',
            place_id: loc.metadata?.placeId ?? '',
          });
        }
      } catch (e) {
        skipped.push(`${acct.accountName ?? acct.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  found = found.filter((l, i) => found.findIndex((x) => x.name === l.name) === i);
  if (!found.length && !error && skipped.length) error = skipped[0];
  const chosen = new Set(s.google_locations.map((l) => l.name));
  const who = s.google_account ?? 'the connected Google login';
  return page(c, { title: 'Choose Google profiles', active: 'settings', lede: `Every Business Profile that ${who} manages. Reviews from each one you tick are imported and matched to techs; with two or more, each customer is sent to the one for their area.` }, (
    <section class="card">
      {error && <p class="flash flash--err">{/SERVICE_DISABLED|has not been used|is disabled/.test(error)
        ? `One of the Google APIs isn't turned on for the project yet. Google Cloud → APIs & Services → Library: enable "My Business Account Management API", "My Business Business Information API" and "Google My Business API", wait a few minutes, then reload this page. ${error}`
        : error.includes('403') ? `Google refused (403). Business Profile API access may not be approved yet. ${error}` : error}</p>}
      {found.length > 0 && skipped.length > 0 && (
        <p class="flash flash--err">Google wouldn't list the profiles in {skipped.length === 1 ? 'one other account' : `${skipped.length} other accounts`} this login can see, so some may be missing. {skipped.join(' · ')}</p>
      )}
      {found.length ? (
        <form method="post" action="/admin/google/locations" class="stack-md">
          {found.map((l) => {
            const where = [l.city, l.areas.length ? `serves ${l.areas.slice(0, 4).join(', ')}${l.areas.length > 4 ? ` and ${l.areas.length - 4} more` : ''}` : ''].filter(Boolean).join(' · ');
            return (
              <label class="check"><input type="checkbox" name="loc" value={JSON.stringify(l)} checked={chosen.size ? chosen.has(l.name) : true} /> <span><strong>{l.title}</strong> <span class="dim small block">{where || l.name}</span></span></label>
            );
          })}
          <button class="btn btn--red" type="submit">Track these and import reviews</button>
        </form>
      ) : !error && <p class="muted">No Business Profiles found for that Google account. Sign in with the account that manages your listings.</p>}
      <p class="small dim mt-md">Missing a profile? Sign into Google with the email that manages it, open that profile → ⋮ → Business Profile settings → People and access → Add, and add {s.google_account ?? 'the login you connected with'} as a Manager. Accept the invite, then reload this page. Or use Settings → Disconnect, then Connect Google with a login that manages every profile.</p>
    </section>
  ));
});

other.post('/google/locations', requireOwner, async (c) => {
  const s = c.get('settings');
  const b = await c.req.parseBody({ all: true });
  const raw = (Array.isArray(b.loc) ? b.loc : b.loc ? [b.loc] : []).slice(0, 50);
  const picked: FoundProfile[] = [];
  for (const v of raw) {
    try {
      const l = JSON.parse(String(v)) as Partial<FoundProfile>;
      if (typeof l.account !== 'string' || typeof l.name !== 'string' || !/^accounts\/\d+$/.test(l.account) || !/^locations\/\d+$/.test(l.name)) continue;
      const place = str(l.place_id, 200);
      picked.push({
        account: l.account,
        name: l.name,
        title: line(l.title, 120),
        city: line(l.city, 60),
        areas: Array.isArray(l.areas) ? parseAreas(l.areas.filter((a): a is string => typeof a === 'string').join('\n')) : [],
        review_url: reviewLink('google', l.review_url) ?? '',
        place_id: /^[\w-]{10,200}$/.test(place) ? place : '',
      });
    } catch { /* ignore */ }
  }
  const locs: GoogleLocation[] = picked.map(({ account, name, title }) => ({ account, name, title }));

  // Every ticked profile is somewhere customers can be sent. The office's own edits (name, link, areas, bonus) are kept.
  const siteUrl = s.sites.find((x) => x.id === 'google')?.url ?? '';
  const sitePlace = siteUrl.match(/placeid=([\w-]+)/i)?.[1];
  const fromGoogle = picked.map((l): ReviewLocation => {
    const old = s.locations.find((x) => x.id === l.name);
    return {
      id: l.name,
      label: old?.label || l.city || l.areas[0] || l.title,
      // The profile behind today's Google link keeps that exact link.
      review_url: old?.review_url || (l.place_id && l.place_id === sitePlace ? siteUrl : '') || l.review_url
        || (l.place_id ? `https://search.google.com/local/writereview?placeid=${l.place_id}` : ''),
      areas: old?.areas.length ? old.areas : l.areas,
      bonus: old?.bonus ?? 0,
    };
  }).filter((l) => l.review_url);
  for (const l of fromGoogle) if (fromGoogle.filter((x) => x.label === l.label).length > 1) l.label = `${l.label} (${l.id.slice(-4)})`;
  const list = [...fromGoogle, ...s.locations.filter((x) => x.id.startsWith('loc_'))];
  const mainId = list.some((x) => x.id === s.locations[0]?.id) ? s.locations[0].id
    : picked.find((l) => l.place_id && l.place_id === sitePlace)?.name ?? list[0]?.id;
  // A fresh install with no Google link yet: use the first profile's link for the Google button.
  const sites = s.sites.map((x) => (x.id === 'google' && !x.url && fromGoogle[0] ? { ...x, url: fromGoogle[0].review_url } : x));

  await saveSettings(c.env.DB, { google_locations: locs, locations: mainFirst(list, mainId), sites, google_backfill: {}, google_last_sync_at: null });
  await audit(c, 'google.profiles', locs.map((l) => l.title).join(', '));
  if (!locs.length) return c.redirect(back('/admin/settings', { err: 'No profiles selected.' }) + '#google', 303);
  const res = await syncGoogle(c.env, { defer: (p) => c.executionCtx.waitUntil(p) });
  if (!res.ok) return c.redirect(back('/admin/settings', { err: res.note }) + '#google', 303);
  return list.length > 1
    ? c.redirect(`${back('/admin/settings', { ok: `Connected. ${res.note} Next: check the cities each location covers, then save.` })}#locations`, 303)
    : c.redirect(`${back('/admin/settings', { ok: `Connected. ${res.note}` })}#google`, 303);
});

other.post('/google/sync', async (c) => {
  const b = await c.req.parseBody();
  // Anyone in the office can check for new reviews; re-importing all history is an owner's call.
  const full = str(b.full) === '1' && c.get('admin').role === 'owner';
  if (full) await saveSettings(c.env.DB, { google_backfill: {}, google_last_sync_at: null });
  const res = await syncGoogle(c.env, { full, defer: (p) => c.executionCtx.waitUntil(p) });
  const ref = c.req.header('referer') ?? '';
  const ret = ref.includes('/admin/settings') ? '/admin/settings' : '/admin';
  return c.redirect(back(ret, res.ok ? { ok: `Checked Google. ${res.note}` } : { err: res.note }) + (ret === '/admin/settings' ? '#google' : ''), 303);
});

other.post('/google/disconnect', requireOwner, async (c) => {
  const refresh = await getSecret(c.env, 'google_refresh').catch(() => null);
  if (refresh) await revokeToken(refresh);
  await setSecret(c.env, 'google_refresh', null);
  await saveSettings(c.env.DB, { google_locations: [], google_account: null, google_backfill: {}, google_totals: {}, google_last_sync_error: null, google_last_sync_note: null });
  await audit(c, 'google.disconnect');
  return c.redirect(back('/admin/settings', { ok: 'Google disconnected, and its access revoked.' }) + '#google', 303);
});

// =====================================================================
// Demo data (only while the sample data from scripts/seed-demo.mjs is loaded)
// =====================================================================

other.post('/demo/clear', requireOwner, async (c) => {
  if (!c.get('settings').demo) return c.redirect(back('/admin', { err: 'There is no demo data to clear.' }), 303);
  const db = c.env.DB;
  await db.batch([
    stmt(db, `DELETE FROM points`), stmt(db, `DELETE FROM credits`), stmt(db, `DELETE FROM redemptions`),
    stmt(db, `DELETE FROM reviews`), stmt(db, `DELETE FROM taps`), stmt(db, `DELETE FROM rewards`),
  ]);
  await saveSettings(db, { demo: false, tracking_start: now(), google_totals: {} });
  await audit(c, 'data.demo_clear');
  return c.redirect(back('/admin', { ok: 'Demo data cleared. Tracking starts now.' }), 303);
});

export default other;

import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { all, one, run } from '../../lib/db';
import {
  addManualReview, creditReview, deleteManualReview, draftFor, markNotTech, parseSuggestions, platformLabel, rematchUnassigned, reopenReview, saveReply, uncreditReview,
  type ReviewRow,
} from '../../lib/reviews';
import { audit } from '../../lib/audit';
import { overLimit } from '../../lib/auth';
import { hasSecret } from '../../lib/settings';
import { HOUR, MINUTE, clampInt, describeGap, fmtDateTime, str, zonedMidnight } from '../../lib/util';
import { back } from '../../views/layout';
import { ReviewCard, creditReason, creditsFor, type CreditView } from '../../views/review';
import { Empty, Icon, Pager, Stars } from '../../views/ui';
import { SOURCE_LABEL, Seg, page, type Ctx } from './common';

const rev = new Hono<AppEnv>();

interface TechOpt { id: string; name: string; first_name: string; active: number }
const techOptions = (c: Ctx) => all<TechOpt>(c.env.DB, `SELECT id, name, first_name, active FROM techs ORDER BY active DESC, sort, name`);

/** Every tech ticked in a form: credit forms carry one `tech` field per tech (a whole crew can share a review). */
const pickedTechs = (b: Record<string, unknown>): string[] =>
  [...new Set((Array.isArray(b.tech) ? b.tech : [b.tech]).map((v) => str(v, 40)).filter(Boolean))].slice(0, 25);

/** "Maya", "Maya and Diego", "Maya, Diego and Sam". */
const listNames = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '');

/** Tick any number of techs. Works without JavaScript: each ticked box sends one `tech` field. */
const TechChecklist = ({ techs, checked, legend, showLegend }: { techs: TechOpt[]; checked?: Set<string>; legend: string; showLegend?: boolean }) => (
  <fieldset class="techpick">
    <legend class={showLegend ? 'techpick__legend' : 'sr-only'}>{legend}</legend>
    <ul class="techpick__list" role="list">
      {techs.map((t) => (
        <li><label class="check"><input type="checkbox" name="tech" value={t.id} checked={checked?.has(t.id)} /> {t.name}</label></li>
      ))}
    </ul>
  </fieldset>
);

const FILTERS: Record<string, { label: string; where: string }> = {
  unassigned: { label: 'Needs a tech', where: `r.status = 'unassigned'` },
  credited: { label: 'Credited', where: `r.status = 'credited'` },
  low: { label: 'Low ratings', where: `r.rating <= ?LOW` },
  noreply: { label: 'No reply yet', where: `r.platform = 'google' AND r.reply IS NULL AND r.status <> 'history'` },
  not_tech: { label: 'Not a tech review', where: `r.status = 'not_tech'` },
  history: { label: 'Before tracking', where: `r.status = 'history'` },
  all: { label: 'All', where: `1 = 1` },
};

rev.get('/', async (c) => {
  const s = c.get('settings');
  const fq = c.req.query('f') ?? '';
  const f = Object.hasOwn(FILTERS, fq) ? fq : 'unassigned';
  const tech = str(c.req.query('tech'), 40);
  const platform = str(c.req.query('platform'), 20);
  const q = str(c.req.query('q'), 80);
  const pageNo = clampInt(c.req.query('page'), 1, 1000, 1);

  const where = [FILTERS[f].where.replace('?LOW', String(s.alert_threshold))];
  const params: unknown[] = [];
  if (f === 'unassigned') { where.push('r.posted_at >= ?'); params.push(s.tracking_start); }
  if (tech) { where.push('EXISTS (SELECT 1 FROM credits c WHERE c.review_id = r.id AND c.tech_id = ?)'); params.push(tech); }
  if (platform) { where.push('r.platform = ?'); params.push(platform); }
  if (q) { where.push('(r.reviewer_name LIKE ? OR r.body LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const rows = await all<ReviewRow>(c.env.DB, `SELECT r.* FROM reviews r WHERE ${where.join(' AND ')} ORDER BY r.posted_at DESC LIMIT 26 OFFSET ?`, ...params, (pageNo - 1) * 25);
  const shown = rows.slice(0, 25);
  const [credits, techs] = await Promise.all([creditsFor(c.env.DB, shown.map((r) => r.id)), techOptions(c)]);
  const techName = new Map(techs.map((t) => [t.id, t.first_name]));
  const qs = (extra: Record<string, string>) => {
    const u = new URLSearchParams({ f, ...(tech ? { tech } : {}), ...(platform ? { platform } : {}), ...(q ? { q } : {}), ...extra });
    return `/admin/reviews?${u}`;
  };

  return page(c, {
    title: 'Reviews',
    active: 'reviews',
    lede: 'Every public review, which tech it was credited to, and why.',
    actions: (
      <>
        <form method="post" action="/admin/reviews/rematch"><button class="btn btn--ghost btn--sm" type="submit"><Icon name="refresh" size={16} /> Re-run matching</button></form>
        <a class="btn btn--red btn--sm" href="/admin/reviews/new"><Icon name="plus" size={16} /> Add a review</a>
      </>
    ),
  }, (
    <>
      <Seg current={f} items={Object.entries(FILTERS).map(([key, v]) => ({ key, label: v.label, href: `/admin/reviews?f=${key}` }))} />
      <form class="filters" method="get" action="/admin/reviews">
        <input type="hidden" name="f" value={f} />
        <label class="sr-only" for="ftech">Tech</label>
        <select id="ftech" name="tech"><option value="">All techs</option>{techs.map((t) => <option value={t.id} selected={t.id === tech}>{t.name}{t.active ? '' : ' (inactive)'}</option>)}</select>
        <label class="sr-only" for="fplat">Site</label>
        <select id="fplat" name="platform"><option value="">All sites</option>{['google', 'yelp', 'bbb', 'facebook', 'other'].map((p) => <option value={p} selected={p === platform}>{platformLabel(p)}</option>)}</select>
        <label class="sr-only" for="fq">Search</label>
        <input id="fq" name="q" type="search" placeholder="Search name or text" value={q} />
        <button class="btn btn--ghost btn--sm" type="submit">Filter</button>
      </form>

      {shown.length ? (
        <div class="stack-md">
          {shown.map((r) => (
            <ReviewCard r={r} tz={s.timezone} credits={credits.get(r.id)} href={`/admin/reviews/${r.id}`}>
              <QuickActions r={r} credits={credits.get(r.id) ?? []} techs={techs} techName={techName} ret={qs(pageNo > 1 ? { page: String(pageNo) } : {})} />
            </ReviewCard>
          ))}
        </div>
      ) : (
        <Empty title={f === 'unassigned' ? 'Nothing waiting' : 'No reviews here'}>
          {f === 'unassigned' ? 'Every review since tracking started has a tech, or was marked as not a tech review.' : 'Try another filter.'}
        </Empty>
      )}
      <Pager page={pageNo} hasMore={rows.length > 25} base={qs({})} />
    </>
  ));
});

function QuickActions({ r, credits, techs, techName, ret }: { r: ReviewRow; credits: CreditView[]; techs: TechOpt[]; techName: Map<string, string>; ret: string }) {
  const credited = new Set(credits.map((x) => x.tech_id));
  const sugg = r.status === 'not_tech' ? [] : parseSuggestions(r).filter((sg) => !credited.has(sg.tech_id));
  const open = techs.filter((t) => t.active && !credited.has(t.id));
  const first = !credits.length;
  return (
    <div class="rev__actions">
      {sugg.map((sg) => (
        <form method="post" action={`/admin/reviews/${r.id}/credit`}>
          <input type="hidden" name="tech" value={sg.tech_id} /><input type="hidden" name="back" value={ret} />
          <button class="btn btn--green btn--sm" type="submit" title={sg.evidence.join(' · ')}>{first ? 'Credit' : 'Also credit'} {techName.get(sg.tech_id) ?? 'tech'} <span class="dim">· likely</span></button>
        </form>
      ))}
      {r.status !== 'not_tech' && open.length > 0 && (
        <details class="credit-pick">
          <summary class="btn btn--ghost btn--sm">{first ? 'Credit to…' : 'Also credit…'}<Icon name="chevron" size={14} /></summary>
          <form method="post" action={`/admin/reviews/${r.id}/credit`} class="credit-pick__menu">
            <input type="hidden" name="back" value={ret} />
            <TechChecklist techs={open} legend={`Techs to credit for ${r.reviewer_name || 'this review'}`} />
            <p class="fine">Tick everyone who worked the job. Each gets full credit and points.</p>
            <button class="btn btn--red btn--sm" type="submit">Credit selected</button>
          </form>
        </details>
      )}
      <span class="rev__links">
        {r.status === 'unassigned' && (
          <form method="post" action={`/admin/reviews/${r.id}/status`}><input type="hidden" name="status" value="not_tech" /><input type="hidden" name="back" value={ret} /><button class="linkbtn small" type="submit">Not a tech review</button></form>
        )}
        {credits.length > 0 && <a class="small" href={`/admin/reviews/${r.id}`}>Why {credits.map((x) => x.first_name).join(' & ')}?</a>}
        {r.platform === 'google' && !r.reply && r.status !== 'history' && <a class="small" href={`/admin/reviews/${r.id}#reply`}>{r.reply_draft ? 'Reply (draft ready)' : 'Reply'}</a>}
      </span>
    </div>
  );
}

// ---------- detail ----------

const MANUAL_SITES = ['yelp', 'bbb', 'facebook', 'google', 'other'];

// Can be opened pre-filled from a tag visit (Tag activity → "Add their review"): ?tap=…
rev.get('/new', async (c) => {
  const techs = await techOptions(c);
  const s = c.get('settings');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: s.timezone }).format(Date.now());
  const tap = await one<{ id: string; tech_id: string; customer_name: string | null; site: string | null; clicked_at: number | null; created_at: number; first_name: string }>(c.env.DB,
    `SELECT p.id, p.tech_id, p.customer_name, p.site, p.clicked_at, p.created_at, t.first_name FROM taps p JOIN techs t ON t.id = p.tech_id WHERE p.id = ? AND p.review_id IS NULL`,
    str(c.req.query('tap'), 40));
  const platform = tap?.site && MANUAL_SITES.includes(tap.site) ? tap.site : str(c.req.query('platform'), 12);
  const visitDay = tap ? new Intl.DateTimeFormat('en-CA', { timeZone: s.timezone }).format(tap.clicked_at ?? tap.created_at) : today;
  return page(c, {
    title: tap ? `Add ${tap.customer_name ?? 'their'}'s review` : 'Add a review',
    active: 'reviews',
    lede: tap
      ? <>{tap.customer_name} rated {tap.first_name} and went to {platformLabel(tap.site ?? 'other')} on {fmtDateTime(tap.clicked_at ?? tap.created_at, s.timezone)}. Find their review there and copy it in. It will be credited to {tap.first_name}.</>
      : 'For Yelp, BBB, Facebook or anywhere Google doesn\'t send us automatically.',
  }, (
    <form method="post" action="/admin/reviews/new" class="card form-grid">
      {tap && <input type="hidden" name="tap" value={tap.id} />}
      <div class="field"><label for="platform">Site</label>
        <select id="platform" name="platform">{MANUAL_SITES.map((x) => <option value={x} selected={x === platform}>{platformLabel(x)}</option>)}</select></div>
      <div class="field"><label for="date">Date posted</label><input id="date" name="date" type="date" required value={tap ? visitDay : today} max={today} /></div>
      <div class="field"><label for="reviewer">Reviewer name, as the site shows it</label><input id="reviewer" name="reviewer" required maxlength={120} value={tap?.customer_name ?? ''} /></div>
      <div class="field"><label for="rating">Stars</label>
        <select id="rating" name="rating"><option value="">No stars on this site</option>{[5, 4, 3, 2, 1].map((n) => <option value={String(n)}>{n}</option>)}</select></div>
      <div class="field field--wide"><label for="body">Review text</label><textarea id="body" name="body" rows={5} maxlength={5000}></textarea></div>
      <div class="field field--wide">
        <TechChecklist techs={techs.filter((t) => t.active || t.id === tap?.tech_id)} checked={new Set(tap ? [tap.tech_id] : [])} legend="Technicians" showLegend />
        <p class="hint">{tap
          ? `${tap.first_name} is ticked from their tag visit. Tick anyone else who worked the job; each gets full credit and points.`
          : 'Tick everyone who worked the job (each gets full credit and points), or leave them all unticked to match automatically by name and tag visits, like Google reviews.'}</p></div>
      <div class="form-actions field--wide"><button class="btn btn--red" type="submit">Save review</button><a class="btn btn--ghost" href={tap ? '/admin/activity' : '/admin/reviews'}>Cancel</a></div>
    </form>
  ));
});

rev.post('/new', async (c) => {
  const s = c.get('settings');
  const b = await c.req.parseBody({ all: true });
  const [y, m, d] = str(b.date, 10).split('-').map(Number);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: s.timezone }).format(Date.now());
  // Only a date is known: count it as the end of that day, so a visit earlier that day still comes first.
  const posted = str(b.date, 10) === today || !(y && m && d) ? Date.now() : zonedMidnight(y, m, d + 1, s.timezone) - MINUTE;
  const platform = MANUAL_SITES.includes(str(b.platform)) ? str(b.platform) : 'other';
  const reviewer = str(b.reviewer, 120);
  if (!reviewer) return c.redirect(back('/admin/reviews/new', { err: 'Add the reviewer name.' }), 303);
  const rating = b.rating ? clampInt(b.rating, 1, 5, 5) : null;
  const techIds = pickedTechs(b);
  const id = await addManualReview(c.env, s, { platform, reviewer, rating, body: str(b.body, 5000), posted_at: Math.min(posted, Date.now()), techIds, by: c.get('admin').name });
  // Added from a tag visit: tie the two together so the visit shows as "Matched" and isn't offered again.
  const tapId = str(b.tap, 40);
  if (tapId && techIds.length) {
    await run(c.env.DB, `UPDATE taps SET review_id = ? WHERE id = ? AND tech_id IN (SELECT value FROM json_each(?)) AND review_id IS NULL`, id, tapId, JSON.stringify(techIds));
  }
  return c.redirect(back(`/admin/reviews/${id}`, { ok: 'Review added.' }), 303);
});

interface NearbyTap { id: string; tech_id: string; first_name: string; customer_name: string | null; rating: number | null; site: string | null; source: string; created_at: number; clicked_at: number | null; review_id: string | null }

rev.get('/:id', async (c) => {
  const s = c.get('settings');
  const r = await one<ReviewRow>(c.env.DB, `SELECT * FROM reviews WHERE id = ?`, c.req.param('id'));
  if (!r) return page(c, { title: 'Review not found', active: 'reviews' }, <Empty title="That review doesn't exist" action={<a class="btn btn--ghost" href="/admin/reviews">Back to reviews</a>} />, 404);
  const [credits, techs, nearby, connected] = await Promise.all([
    creditsFor(c.env.DB, [r.id]).then((m) => m.get(r.id) ?? []),
    techOptions(c),
    all<NearbyTap>(c.env.DB, `SELECT p.id, p.tech_id, t.first_name, p.customer_name, p.rating, p.site, p.source, p.created_at, p.clicked_at, p.review_id
      FROM taps p JOIN techs t ON t.id = p.tech_id WHERE p.created_at BETWEEN ? AND ? AND p.rating IS NOT NULL ORDER BY p.created_at DESC LIMIT 30`,
      r.posted_at - s.match_window_hours * HOUR, r.posted_at + 15 * MINUTE),
    hasSecret(c.env, 'google_refresh'),
  ]);
  const sugg = parseSuggestions(r).filter((sg) => !credits.some((x) => x.tech_id === sg.tech_id));
  const open = techs.filter((t) => t.active && !credits.some((x) => x.tech_id === t.id));
  const techName = new Map(techs.map((t) => [t.id, t.name]));
  const canPost = r.platform === 'google' && !!r.resource_name && !!connected;
  const draft = r.reply_draft ?? (r.reply ? r.reply : '');

  return page(c, {
    title: `${r.reviewer_name || 'Anonymous'}`,
    active: 'reviews',
    lede: <>{platformLabel(r.platform)}{r.location ? ` · ${r.location}` : ''} · {fmtDateTime(r.posted_at, s.timezone)}</>,
    actions: <a class="btn btn--ghost btn--sm" href="/admin/reviews"><Icon name="back" size={16} /> Reviews</a>,
  }, (
    <div class="detail-grid">
      <div class="stack-lg">
        <ReviewCard r={{ ...r, reply: null }} tz={s.timezone} />

        <section class="card" id="reply">
          <h2 class="h-sm">Reply</h2>
          {r.reply && <div class="rev__reply"><span class="small dim">Posted reply{r.reply_at ? ` · ${fmtDateTime(r.reply_at, s.timezone)}` : ''}</span><p>{r.reply}</p></div>}
          {r.reply_error && <p class="flash flash--err">{r.reply_error}</p>}
          <form method="post" action={`/admin/reviews/${r.id}/reply`} class="stack-md">
            <div class="field">
              <label for="reply-text">{r.reply ? 'Edit reply' : r.reply_draft ? 'Draft (check it before posting)' : 'Write a reply'}</label>
              <textarea id="reply-text" name="text" rows={5} maxlength={4000} required>{draft}</textarea>
            </div>
            <div class="cluster">
              {canPost && <button class="btn btn--red" type="submit" name="post" value="1">Post to Google</button>}
              <button class={`btn ${canPost ? 'btn--ghost' : 'btn--red'}`} type="submit" name="post" value="0">{canPost ? 'Save without posting' : `Mark as replied${r.platform === 'google' ? '' : ` on ${platformLabel(r.platform)}`}`}</button>
            </div>
          </form>
          {c.env.ANTHROPIC_API_KEY && (
            <form method="post" action={`/admin/reviews/${r.id}/draft`} class="mt-sm">
              <button class="btn btn--ghost btn--sm" type="submit" data-busy="Drafting…"><Icon name="sparkle" size={16} /> {r.reply_draft ? 'Draft again with AI' : 'Draft with AI'}</button>
            </form>
          )}
          {!canPost && r.platform === 'google' && <p class="fine">{r.resource_name ? 'Connect Google in Settings to post replies from here.' : 'Reply on Google, then save it here so the team sees it.'}</p>}
        </section>
      </div>

      <div class="stack-lg">
        <section class="card">
          <h2 class="h-sm">Credit</h2>
          {credits.length ? (
            <ul class="plain credit-list" role="list">
              {credits.map((cr) => (
                <li>
                  <div><strong>{cr.name}</strong><p class="small muted">{creditReason(cr)}</p></div>
                  <form method="post" action={`/admin/reviews/${r.id}/uncredit`} data-confirm={`Remove ${cr.first_name}'s credit and points for this review?`}>
                    <input type="hidden" name="tech" value={cr.tech_id} />
                    <button class="linkbtn small" type="submit">Remove</button>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted small">{r.status === 'not_tech' ? 'Marked as not about a tech visit.' : r.status === 'history' ? 'Posted before tracking started, so it was not matched automatically.' : 'Not credited to anyone yet.'}</p>
          )}
          {sugg.length > 0 && r.status !== 'not_tech' && (
            <div class="stack-sm mt-sm">
              <p class="small dim">{credits.length ? 'Also likely' : 'Likely matches'}</p>
              {sugg.map((sg) => (
                <form method="post" action={`/admin/reviews/${r.id}/credit`} class="sugg">
                  <input type="hidden" name="tech" value={sg.tech_id} />
                  <div><strong>{techName.get(sg.tech_id) ?? 'Unknown'}</strong><p class="small muted">{sg.evidence.join(' · ')}</p></div>
                  <button class="btn btn--green btn--sm" type="submit">Credit</button>
                </form>
              ))}
            </div>
          )}
          {open.length > 0 && (
            <form method="post" action={`/admin/reviews/${r.id}/credit`} class="stack-sm mt-sm">
              <TechChecklist techs={open} legend={credits.length ? 'Also credit' : 'Credit to'} showLegend />
              <div><button class="btn btn--ghost btn--sm" type="submit">Credit selected</button></div>
            </form>
          )}
          <p class="fine mt-sm">A job several techs worked together can credit them all. Each gets full credit and points.</p>
          <div class="mt-sm">
            {r.status === 'not_tech'
              ? <form method="post" action={`/admin/reviews/${r.id}/status`}><input type="hidden" name="status" value="reopen" /><button class="linkbtn small" type="submit">Put back in the queue</button></form>
              : !credits.length && <form method="post" action={`/admin/reviews/${r.id}/status`}><input type="hidden" name="status" value="not_tech" /><button class="linkbtn small" type="submit">Not about a tech visit</button></form>}
          </div>
          <div class="mt-sm">
            {r.platform === 'google' && r.external_id
              ? <p class="fine">Google reviews come from Google, so they can't be deleted here. To take one out of the queue, use "Not about a tech visit".</p>
              : <form method="post" action={`/admin/reviews/${r.id}/delete`} data-confirm="Delete this review and any credit or points it gave? Use this for test entries. It can't be undone."><button class="linkbtn small" type="submit">Delete this review</button></form>}
          </div>
        </section>

        <section class="card">
          <h2 class="h-sm">Tag ratings before this review</h2>
          <p class="small dim">Customers who rated a tech in the {s.match_window_hours} hours before it was posted.</p>
          {nearby.length ? (
            <ul class="plain nearby" role="list">
              {nearby.map((t) => (
                <li class={t.review_id === r.id ? 'is-match' : ''}>
                  <span><strong>{t.customer_name}</strong> <span class="dim">rated</span> {t.first_name} <Stars rating={t.rating} size={12} /></span>
                  <span class="small dim">{describeGap(r.posted_at - t.created_at)} before · {SOURCE_LABEL[t.source] ?? t.source}{t.site ? ` · went to ${platformLabel(t.site)}` : ''}{t.review_id === r.id ? ' · matched' : t.review_id ? ' · used by another review' : ''}</span>
                </li>
              ))}
            </ul>
          ) : <p class="small muted">None in that window.</p>}
        </section>
      </div>
    </div>
  ));
});

// ---------- actions ----------

const retTo = (b: Record<string, unknown>, fallback: string) => {
  const v = str(b.back, 300);
  return v.startsWith('/admin/') ? v : fallback;
};

rev.post('/rematch', async (c) => {
  const res = await rematchUnassigned(c.env, c.get('settings'));
  const msg = res.processed ? `Checked ${res.processed} review${res.processed === 1 ? '' : 's'} again.${res.remaining ? ` ${res.remaining} more on the next run.` : ''}` : 'Nothing to re-check.';
  return c.redirect(back('/admin/reviews?f=unassigned', { ok: msg }), 303);
});

rev.post('/:id/credit', async (c) => {
  const b = await c.req.parseBody({ all: true });
  const id = c.req.param('id');
  const techIds = pickedTechs(b);
  if (!techIds.length) return c.redirect(back(`/admin/reviews/${id}`, { err: 'Pick a tech.' }), 303);
  await creditReview(c.env, c.get('settings'), id, techIds, c.get('admin').name);
  await audit(c, 'review.credit', `${id} → ${techIds.join(', ')}`);
  const names = await all<{ first_name: string }>(c.env.DB, `SELECT first_name FROM techs WHERE id IN (SELECT value FROM json_each(?)) ORDER BY sort, name`, JSON.stringify(techIds));
  return c.redirect(back(retTo(b, `/admin/reviews/${id}`), { ok: `Credited to ${listNames(names.map((t) => t.first_name)) || 'tech'}.` }), 303);
});

rev.post('/:id/uncredit', async (c) => {
  const b = await c.req.parseBody();
  await uncreditReview(c.env, c.req.param('id'), str(b.tech, 40));
  await audit(c, 'review.uncredit', `${c.req.param('id')} ✕ ${str(b.tech, 40)}`);
  return c.redirect(back(`/admin/reviews/${c.req.param('id')}`, { ok: 'Credit removed.' }), 303);
});

rev.post('/:id/delete', async (c) => {
  const ok = await deleteManualReview(c.env, c.req.param('id'));
  if (ok) await audit(c, 'review.delete', c.req.param('id'));
  return c.redirect(back('/admin/reviews?f=all', ok ? { ok: 'Review deleted.' } : { err: "Google reviews can't be deleted here." }), 303);
});

rev.post('/:id/status', async (c) => {
  const b = await c.req.parseBody();
  const id = c.req.param('id');
  if (str(b.status) === 'not_tech') await markNotTech(c.env, id);
  else await reopenReview(c.env, id);
  return c.redirect(back(retTo(b, `/admin/reviews/${id}`), { ok: str(b.status) === 'not_tech' ? 'Marked as not a tech review.' : 'Back in the queue.' }), 303);
});

rev.post('/:id/draft', async (c) => {
  const id = c.req.param('id');
  // Each draft is a paid API call: plenty for real use, not enough to run up a bill.
  if (await overLimit(c.env.DB, `ai:${c.get('admin').id}`, 30, HOUR)) return c.redirect(back(`/admin/reviews/${id}`, { err: 'That is a lot of drafts for one hour. Try again later.' }) + '#reply', 303);
  try {
    await draftFor(c.env, c.get('settings'), id);
    return c.redirect(back(`/admin/reviews/${id}`, { ok: 'Draft ready. Read it over before posting.' }) + '#reply', 303);
  } catch (err) {
    return c.redirect(back(`/admin/reviews/${id}`, { err: err instanceof Error ? err.message : 'Drafting failed.' }) + '#reply', 303);
  }
});

rev.post('/:id/reply', async (c) => {
  const b = await c.req.parseBody();
  const id = c.req.param('id');
  const text = str(b.text, 4000);
  if (!text) return c.redirect(back(`/admin/reviews/${id}`, { err: 'The reply is empty.' }) + '#reply', 303);
  try {
    const res = await saveReply(c.env, id, text, str(b.post) === '1');
    return c.redirect(back(`/admin/reviews/${id}`, { ok: res.posted ? 'Reply posted to Google.' : 'Reply saved.' }) + '#reply', 303);
  } catch (err) {
    return c.redirect(back(`/admin/reviews/${id}`, { err: err instanceof Error ? err.message : 'Could not post the reply.' }) + '#reply', 303);
  }
});

export default rev;

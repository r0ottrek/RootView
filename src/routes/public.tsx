/**
 * What customers see after tapping a tech's tag or scanning the QR:
 *   /<slug>          rate the visit + "who is reviewing?"
 *   /<slug>/share    thank you + review site buttons (always shown, whatever the rating)
 *   /go/<tap>/<site> logs the click, then sends them to the review site
 *
 * Every write here is rate-limited per visitor (and some site-wide), so a script can't flood the database,
 * the office inbox or a tech's numbers. Over the limit, pages still work; nothing is saved.
 */
import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Tech } from '../env';
import { clientKey, overLimit } from '../lib/auth';
import { TECH_COLS, all, one, run, scalar } from '../lib/db';
import { dayKey, describeGeo, geoFrom, pickLocation } from '../lib/geo';
import { alertCallback, alertLowTap } from '../lib/reviews';
import { companyName, enabledSites, googleUrlFor, type Settings } from '../lib/settings';
import { CALL_TIMES, HOUR, clampInt, formatPhone, isBot, line, matchName, newId, now, str, telHref } from '../lib/util';
import { PublicPage, render } from '../views/layout';
import { Avatar, GoogleG, Icon } from '../views/ui';

const pub = new Hono<AppEnv>();

const SOURCES = new Set(['nfc', 'qr', 'text', 'picker', 'link']);
const SLUG = '[a-z0-9][a-z0-9-]*';
const TAP_COOKIE = '__Host-rv_tap';
const TAP_ID = /^tap_[A-Za-z0-9_-]{8,24}$/;

interface TapRow {
  id: string; tech_id: string; customer_name: string | null; rating: number | null; comment: string | null; created_at: number; rated_at: number | null;
  callback_phone?: string | null; callback_time?: string | null; callback_at?: number | null; resolved_at?: number | null;
}

/** Browser link preloading (Chrome, Edge, Safari, Firefox) announces itself with one of these headers. */
const isPrefetch = (c: Context<AppEnv>) =>
  /prefetch|prerender|preview/i.test([c.req.header('sec-purpose'), c.req.header('purpose'), c.req.header('x-purpose'), c.req.header('x-moz')].filter(Boolean).join(' '));

/** Staff previewing their own page (signed in on this phone) are not counted. */
const isStaff = (c: Context<AppEnv>) => /(?:^|;\s*)__Host-rv_(tech|admin)=/.test(c.req.header('cookie') ?? '');

const firstWord = (name: string | null) => (name ?? '').trim().split(/\s+/)[0] || 'friend';

/** "(555) ***-**23": enough for the customer to recognise their own number, no more. */
const maskPhone = (p: string | null | undefined) => (p ? p.replace(/\d(?=(?:\D*\d){2})/g, '*') : '');

async function activeTech(db: D1Database, slug: string): Promise<Tech | null> {
  return one<Tech>(db, `SELECT ${TECH_COLS} FROM techs WHERE slug = ? AND active = 1`, slug.toLowerCase());
}

/** The tap this browser created (cookie "<techId>.<tapId>.<time>"), so a shared or old link can't open someone else's page. */
function ownTap(c: Context<AppEnv>, tapId: string): boolean {
  return (getCookie(c, TAP_COOKIE) ?? '').split('.')[1] === tapId;
}

/** Which Google profile this customer's button opens (rules in lib/geo.ts). */
function routeFor(c: Context<AppEnv>, s: Settings, tech: Pick<Tech, 'home_location' | 'today_location' | 'today_on'> | null) {
  const geo = geoFrom((c.req.raw as Request & { cf?: unknown }).cf);
  const today = tech && tech.today_on === dayKey(now(), s.timezone) ? tech.today_location : null;
  return { pick: pickLocation(s.locations, { today, home: tech?.home_location, geo }), geo };
}

// ---------- "Who helped you today?" (company QR on invoices, office counter, trucks) ----------

// A search box with a dropdown of names, not a long list. Every active tech is in the page so public/app.js can
// filter instantly as the customer types; ?q= does the same filtering on the server for phones with scripts off.
pub.get('/', async (c) => {
  const s = c.get('settings');
  const q = str(c.req.query('q'), 60);
  const switched = c.req.query('switched') === '1';
  const techs = await all<Tech>(c.env.DB, `SELECT id, slug, name, first_name, role, photo IS NOT NULL AS photo, updated_at FROM techs WHERE active = 1 ORDER BY sort, name`);
  // A brand-new site: send whoever opened it to create the owner login.
  if (!techs.length && !(await scalar(c.env.DB, `SELECT COUNT(*) FROM admins`))) return c.redirect('/setup', 303);
  const matches = new Map(techs.flatMap((t) => { const m = matchName(t.name, q); return m ? [[t.id, m] as const] : []; }));
  const order = q ? [...techs].sort((a, b) => (matches.get(b.id)?.score ?? -1) - (matches.get(a.id)?.score ?? -1)) : techs;
  const shown = q ? matches.size : 0;
  const google = enabledSites(s).some((x) => x.id === 'google') ? googleUrlFor(s, routeFor(c, s, null).pick?.id) : null;
  return render(c, (
    <PublicPage title={`Rate your visit · ${companyName(s)}`} s={s}>
      <section class="pub__card">
        <div class="pub__intro">
          <h1>Who helped you today?</h1>
          <p class="muted">Thanks for choosing {companyName(s)}. Find your technician to rate the visit.</p>
        </div>
        <form method="get" action="/" class="combo" role="search" data-combo>
          <label for="tech-q" class="combo__label">Your technician's name</label>
          <div class="combo__field">
            <Icon name="search" />
            <input id="tech-q" name="q" type="search" value={q} placeholder="Start typing a name" maxlength={60} autofocus={switched}
              autocomplete="off" autocapitalize="words" spellcheck={false} enterkeyhint="search"
              aria-describedby="tech-hint" data-combo-input />
            <button type="submit" class="btn btn--ghost btn--sm no-js-only">Find</button>
          </div>
          <p class="hint" id="tech-hint">Tap the box to see everyone, or type a few letters.</p>
          <ul id="tech-options" class="combo__list" role="list" aria-label="Technicians" hidden={!q} data-combo-list>
            {order.map((t) => {
              const m = matches.get(t.id);
              return (
                <li id={`opt-${t.slug}`} data-combo-option data-name={t.name} hidden={!!q && !m}>
                  <a href={`/${t.slug}?s=picker`}>
                    <Avatar tech={t} size={40} />
                    <span class="combo__text">
                      <strong class="combo__name">{q && m ? <Highlight text={t.name} ranges={m.ranges} /> : t.name}</strong>
                      <span class="small muted">{t.role}</span>
                    </span>
                    <Icon name="arrow" class="picker__go" />
                  </a>
                </li>
              );
            })}
            <li class="combo__empty" hidden={!q || shown > 0}>
              No one by that name. Check the spelling, or clear the box to see everyone.
            </li>
          </ul>
          <p class="sr-only" role="status" data-combo-status>{q ? `${shown} technician${shown === 1 ? '' : 's'} found` : ''}</p>
        </form>
        {google && <p class="fine">Not sure who it was? <a href={google} rel="noopener">Review us on Google</a></p>}
      </section>
    </PublicPage>
  ));
});

// "Not Sam? Choose your technician": cancel the unrated visit this browser just logged for the wrong tech.
pub.post('/switch', async (c) => {
  const tapId = str((await c.req.parseBody()).t, 40);
  if (TAP_ID.test(tapId) && ownTap(c, tapId)) {
    await run(c.env.DB, `DELETE FROM taps WHERE id = ? AND rating IS NULL AND review_id IS NULL AND created_at > ?`, tapId, now() - 2 * HOUR);
  }
  deleteCookie(c, TAP_COOKIE, { path: '/', secure: true });
  return c.redirect('/?switched=1', 303);
});

function Highlight({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: Child[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) parts.push(text.slice(at, s));
    parts.push(<mark>{text.slice(s, e)}</mark>);
    at = e;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

// ---------- step 1: rate ----------

pub.get(`/:slug{${SLUG}}`, async (c) => {
  const s = c.get('settings');
  const tech = await activeTech(c.env.DB, c.req.param('slug'));
  if (!tech) return notFound(c, s);
  const preview = isStaff(c);
  const source = SOURCES.has(c.req.query('s') ?? '') ? c.req.query('s')! : 'link';

  // The visit is not saved here. Browsers preloading links, link scanners and message previews all fetch
  // this page without a person looking at it, so the page reports the visit itself once it is actually
  // shown (POST /<slug>/visit from public/app.js). A rating saves the visit too, for phones with scripts off.
  let tapId = 'preview';
  if (!preview && !isBot(c.req.header('user-agent'))) {
    const [cookieTech, cookieTap, cookieAt] = (getCookie(c, TAP_COOKIE) ?? '').split('.');
    const recent = !isPrefetch(c) && cookieTech === tech.id && TAP_ID.test(cookieTap ?? '') && now() - Number(cookieAt) < 2 * HOUR
      ? await one<TapRow>(c.env.DB, `SELECT id, rating FROM taps WHERE id = ? AND tech_id = ?`, cookieTap, tech.id)
      : null;
    if (recent?.rating) return c.redirect(`/${tech.slug}/share?t=${recent.id}`, 303); // already rated: straight to the buttons
    tapId = recent ? recent.id : newId('tap');
  }
  return render(c, <RatePage s={s} tech={tech} tapId={tapId} source={source} preview={preview} />);
});

// The page is on someone's screen: count the visit.
pub.post(`/:slug{${SLUG}}/visit`, async (c) => {
  const b = await c.req.parseBody();
  const tapId = str(b.t, 40);
  if (!TAP_ID.test(tapId) || isStaff(c) || isBot(c.req.header('user-agent'))) return c.body(null, 204);
  const tech = await activeTech(c.env.DB, c.req.param('slug'));
  if (!tech) return c.body(null, 204);
  const ip = await clientKey(c);
  if ((await overLimit(c.env.DB, `visit:${ip}`, 30, HOUR)) || (await overLimit(c.env.DB, `visit:${ip}:${tech.id}`, 6, HOUR))
    || (await overLimit(c.env.DB, 'visit:all', 300, HOUR))) return c.body(null, 204);
  const source = SOURCES.has(str(b.s, 10)) ? str(b.s, 10) : 'link';
  const t = now();
  await run(c.env.DB, `INSERT OR IGNORE INTO taps (id, tech_id, source, created_at) VALUES (?, ?, ?, ?)`, tapId, tech.id, source, t);
  setCookie(c, TAP_COOKIE, `${tech.id}.${tapId}.${t}`, { path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 2 * 3600 });
  return c.body(null, 204);
});

pub.post(`/:slug{${SLUG}}`, async (c) => {
  const s = c.get('settings');
  const tech = await activeTech(c.env.DB, c.req.param('slug'));
  if (!tech) return notFound(c, s);
  const body = await c.req.parseBody();
  const rating = clampInt(body.rating, 0, 5, 0);
  const name = line(body.name, 80);
  const comment = str(body.comment, 1000) || null;
  const errors: Record<string, string> = {};
  if (!rating) errors.rating = 'Tap a star to rate the visit.';
  if (name.length < 2) errors.name = `Add your name so ${tech.first_name} gets credit for your review.`;
  if (Object.keys(errors).length) {
    return render(c, <RatePage s={s} tech={tech} tapId={str(body.t, 40)} source={str(body.s, 10)} preview={isStaff(c)} values={{ rating, name, comment: comment ?? '' }} errors={errors} />, 422);
  }
  const unsaved = { id: 'preview', tech_id: tech.id, customer_name: name, rating, comment, created_at: now(), rated_at: now() };
  // Honeypot or staff preview: show the next step without saving anything.
  if (str(body.website) || isStaff(c)) return render(c, <SharePage s={s} tech={tech} tap={unsaved} preview={isStaff(c)} />);
  // Too many ratings from this connection: the customer still sees the review links; nothing is saved.
  const ip = await clientKey(c);
  if ((await overLimit(c.env.DB, `rate:${ip}`, 12, HOUR)) || (await overLimit(c.env.DB, `rate:${ip}:${tech.id}`, 4, HOUR))) {
    return render(c, <SharePage s={s} tech={tech} tap={unsaved} />);
  }

  const t = now();
  const given = str(body.t, 40);
  let tap = await one<TapRow>(c.env.DB, `SELECT * FROM taps WHERE id = ? AND tech_id = ?`, given, tech.id);
  if (tap && !ownTap(c, tap.id) && tap.rated_at) tap = null; // someone else's rated visit: start a new one
  if (!tap || (tap.rated_at && t - tap.rated_at > 2 * HOUR)) {
    // Keep the page's visit id if it was never saved (scripts off, or the visit report didn't arrive).
    const reuse = !tap && TAP_ID.test(given) && !(await one(c.env.DB, `SELECT 1 FROM taps WHERE id = ?`, given));
    const id = reuse ? given : newId('tap');
    const source = SOURCES.has(str(body.s, 10)) ? str(body.s, 10) : 'link';
    await run(c.env.DB, `INSERT INTO taps (id, tech_id, source, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`, id, tech.id, source, t);
    tap = { id, tech_id: tech.id, customer_name: null, rating: null, comment: null, created_at: t, rated_at: null };
  }
  const firstRating = !tap.rating;
  const newlyLow = rating <= s.alert_threshold && (firstRating || (tap.rating ?? 0) > s.alert_threshold);
  const { pick, geo } = routeFor(c, s, tech);
  // A first rating only lands once (two quick taps on Continue: one wins), and a follow-up the office closed stays
  // closed unless the new rating is newly low.
  const saved = await run(c.env.DB, `UPDATE taps SET customer_name = ?, rating = ?, comment = ?, rated_at = ?, resolved_at = CASE WHEN ? THEN NULL ELSE resolved_at END,
    location_id = ?, location_how = ?, geo = ? WHERE id = ? AND (? = 0 OR rating IS NULL)`,
    name, rating, comment, t, newlyLow ? 1 : 0, pick?.id ?? null, pick?.how ?? null, describeGeo(geo), tap.id, firstRating ? 1 : 0);
  if (!saved.meta.changes) return c.redirect(`/${tech.slug}/share?t=${tap.id}`, 303);
  if (firstRating && s.points.rating > 0) {
    await run(c.env.DB, `INSERT INTO points (id, tech_id, amount, reason, tap_id, created_at) VALUES (?, ?, ?, 'Customer rated the visit', ?, ?)`,
      newId('pt'), tech.id, s.points.rating, tap.id, t);
  }
  // One alert per visit, not one per resubmit.
  if (newlyLow) c.executionCtx.waitUntil(alertLowTap(c.env, s, tech, { customer_name: name, rating, comment }));
  setCookie(c, TAP_COOKIE, `${tech.id}.${tap.id}.${t}`, { path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 2 * 3600 });
  return c.redirect(`/${tech.slug}/share?t=${tap.id}`, 303);
});

// ---------- step 2: pick a review site ----------

pub.get(`/:slug{${SLUG}}/share`, async (c) => {
  const s = c.get('settings');
  const tech = await activeTech(c.env.DB, c.req.param('slug'));
  if (!tech) return notFound(c, s);
  const tap = await one<TapRow>(c.env.DB, `SELECT * FROM taps WHERE id = ? AND tech_id = ?`, c.req.query('t') ?? '', tech.id);
  // Only the customer who rated (their browser), and only for a while: the page shows their name and call-back number.
  if (!tap || !tap.rating || !ownTap(c, tap.id) || now() - (tap.rated_at ?? 0) > 6 * HOUR) return c.redirect(`/${tech.slug}`, 303);
  return render(c, <SharePage s={s} tech={tech} tap={tap} />);
});

// Low ratings: the customer asks for a call-back. Goes to the office only; the review links stay on the page.
pub.post(`/:slug{${SLUG}}/callback`, async (c) => {
  const s = c.get('settings');
  const tech = await activeTech(c.env.DB, c.req.param('slug'));
  if (!tech) return notFound(c, s);
  const b = await c.req.parseBody();
  const tapId = str(b.t, 40);
  const phoneRaw = str(b.phone, 30);
  const phone = formatPhone(phoneRaw);
  const time = Object.hasOwn(CALL_TIMES, str(b.time, 12)) ? str(b.time, 12) : 'asap';
  const details = str(b.details, 1000) || null;
  const preview = tapId === 'preview' || isStaff(c);
  const tap = preview ? null : await one<TapRow>(c.env.DB, `SELECT * FROM taps WHERE id = ? AND tech_id = ?`, tapId, tech.id);
  if (!preview && (!tap || !ownTap(c, tap.id))) return c.redirect(`/${tech.slug}`, 303);
  const view: TapRow = tap ?? {
    id: 'preview', tech_id: tech.id, customer_name: line(b.name, 80) || null, rating: clampInt(b.rating, 1, 5, 1),
    comment: details, created_at: now(), rated_at: now(),
  };
  if (!phone) {
    return render(c, <SharePage s={s} tech={tech} tap={{ ...view, comment: details ?? view.comment }} preview={preview}
      callback={{ error: 'Add your phone number with the area code so we can reach you.', phone: phoneRaw, time }} />, 422);
  }
  if (str(b.website)) return c.redirect(`/${tech.slug}/share?t=${view.id}`, 303); // honeypot
  if (preview || !tap) {
    return render(c, <SharePage s={s} tech={tech} tap={{ ...view, comment: details, callback_phone: phone, callback_time: time, callback_at: now() }} preview />);
  }
  // Already followed up, or this connection is sending too many: leave it as it is.
  if (tap.resolved_at || (await overLimit(c.env.DB, `callback:${await clientKey(c)}`, 3, HOUR))) return c.redirect(`/${tech.slug}/share?t=${tap.id}`, 303);
  const first = !tap.callback_at;
  await run(c.env.DB,
    `UPDATE taps SET callback_phone = ?, callback_time = ?, callback_at = ?, comment = COALESCE(?, comment), followup_status = NULL WHERE id = ?`,
    phone, time, now(), details, tap.id);
  if (first) c.executionCtx.waitUntil(alertCallback(c.env, s, tech, { customer_name: tap.customer_name ?? 'A customer', rating: tap.rating ?? 0, comment: details ?? tap.comment, phone, time }));
  return c.redirect(`/${tech.slug}/share?t=${tap.id}`, 303);
});

pub.get('/go/:tap/:site', async (c) => {
  const s = c.get('settings');
  const site = enabledSites(s).find((x) => x.id === c.req.param('site'));
  if (!site) return c.redirect('/', 302);
  const tapId = c.req.param('tap');
  const counted = TAP_ID.test(tapId) && !isStaff(c) && !isPrefetch(c) && !(await overLimit(c.env.DB, `go:${await clientKey(c)}`, 60, HOUR));
  let url = site.url;
  if (site.id === 'google' && s.locations.length) {
    const tap = counted ? await one<{ tech_id: string; location_id: string | null }>(c.env.DB, `SELECT tech_id, location_id FROM taps WHERE id = ?`, tapId) : null;
    let locationId = tap?.location_id ?? null;
    if (!locationId) {
      // Staff previews (?as=<their slug>) and visits rated before locations were set up are routed now.
      const tech = tap
        ? await one<Tech>(c.env.DB, `SELECT ${TECH_COLS} FROM techs WHERE id = ?`, tap.tech_id)
        : await one<Tech>(c.env.DB, `SELECT ${TECH_COLS} FROM techs WHERE slug = ? AND active = 1`, str(c.req.query('as'), 40));
      const { pick, geo } = routeFor(c, s, tech);
      locationId = pick?.id ?? null;
      if (tap && pick) await run(c.env.DB, `UPDATE taps SET location_id = ?, location_how = ?, geo = COALESCE(geo, ?) WHERE id = ?`, pick.id, pick.how, describeGeo(geo), tapId);
    }
    url = googleUrlFor(s, locationId);
  }
  // The last button pressed is where they most likely posted (someone who opens Yelp, then comes back for Google).
  if (counted) await run(c.env.DB, `UPDATE taps SET site = ?, clicked_at = ? WHERE id = ?`, site.id, now(), tapId);
  return c.redirect(url, 302);
});

// ---------- photos ----------

pub.get('/photo/:id', async (c) => {
  const row = await one<{ photo: string | null }>(c.env.DB, `SELECT photo FROM techs WHERE id = ? AND active = 1`, c.req.param('id'));
  const m = row?.photo?.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) return c.notFound();
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const cache = c.req.query('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  return c.body(bytes, 200, { 'content-type': m[1], 'cache-control': cache, 'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff' });
});

// ---------- views ----------

function notFound(c: Context<AppEnv>, s: Settings) {
  return render(c, (
    <PublicPage title={`Page not found · ${companyName(s)}`} s={s}>
      <section class="pub__card">
        <h1>We couldn't find that page</h1>
        <p class="muted">The link may be mistyped, or that technician's page has moved.</p>
        <a class="btn btn--red btn--lg btn--block" href="/">Choose your technician</a>
      </section>
    </PublicPage>
  ), 404);
}

const WORDS = ['', 'Poor', 'Fair', 'Good', 'Great', 'Excellent'];

function RatePage(p: { s: Settings; tech: Tech; tapId: string; source?: string; preview: boolean; values?: { rating: number; name: string; comment: string }; errors?: Record<string, string> }) {
  const { s, tech, tapId, source = 'link', preview, values, errors = {} } = p;
  return (
    <PublicPage title={`Rate your visit with ${tech.first_name} · ${companyName(s)}`} s={s}>
      {preview && <p class="preview-note"><Icon name="lock" size={16} /> Preview. Visits from staff phones aren't counted.</p>}
      <section class="pub__card">
        <div class="tech-hero">
          <span class="ring"><Avatar tech={tech} size={120} /></span>
          <h1>How did {tech.first_name} do today?</h1>
          <p class="muted small">{tech.name} · {tech.role}</p>
        </div>
        <form method="post" action={`/${tech.slug}`} class="rate-form" data-rate-form
          data-visit={tapId !== 'preview' && !values ? `/${tech.slug}/visit` : undefined}>
          <input type="hidden" name="t" value={tapId} />
          <input type="hidden" name="s" value={source} />
          <fieldset class={`rate ${errors.rating ? 'is-invalid' : ''}`} aria-describedby={errors.rating ? 'err-rating' : undefined}>
            <legend>Your rating</legend>
            <div class="rate__stars">
              {[1, 2, 3, 4, 5].map((n) => (
                <>
                  <input type="radio" id={`r${n}`} name="rating" value={String(n)} required checked={values?.rating === n} />
                  <label for={`r${n}`} data-word={WORDS[n]}>
                    <span class="sr-only">{n} star{n > 1 ? 's' : ''}, {WORDS[n]}</span>
                    <svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z" /></svg>
                  </label>
                </>
              ))}
            </div>
            <p class="rate__word" data-rate-word aria-hidden="true">{values?.rating ? WORDS[values.rating] : ' '}</p>
            {errors.rating && <p class="error" id="err-rating">{errors.rating}</p>}
          </fieldset>

          <div class={`field ${errors.name ? 'field--invalid' : ''}`}>
            <label for="name">Who is reviewing?</label>
            <input id="name" name="name" autocomplete="name" required minlength={2} maxlength={80} value={values?.name ?? ''}
              placeholder="Your first name and last initial" aria-describedby={`name-hint${errors.name ? ' err-name' : ''}`}
              aria-invalid={errors.name ? 'true' : undefined} autofocus={!!errors.name && !errors.rating} />
            <p class="hint" id="name-hint">Use the name on your Google account so {tech.first_name} gets the credit.</p>
            {errors.name && <p class="error" id="err-name">{errors.name}</p>}
          </div>

          <details class="more" open={!!values?.comment}>
            <summary>Add a comment <span class="dim">(optional)</span></summary>
            <div class="field">
              <label for="comment" class="sr-only">Comment</label>
              <textarea id="comment" name="comment" maxlength={1000} rows={4} placeholder="What stood out about the visit?">{values?.comment ?? ''}</textarea>
            </div>
          </details>

          <div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex={-1} autocomplete="off" /></label></div>
          <button class="btn btn--red btn--lg btn--block" type="submit">Continue <Icon name="arrow" /></button>
        </form>
        <p class="fine">
          {companyName(s)} sees your name, rating and comment, to thank {tech.first_name} and follow up. Your rating here isn't posted anywhere.
          {s.locations.length > 1
            ? ' Your rough area (from your internet connection) picks the right Google page, and is deleted after 30 days.'
            : ' Your rough area (from your internet connection) is kept for 30 days.'}
          {s.privacy_url && <> <a href={s.privacy_url} rel="noopener">Privacy policy</a></>}
        </p>
        {tapId !== 'preview' && (
          <form method="post" action="/switch" class="switch-tech">
            <input type="hidden" name="t" value={tapId} />
            <button class="linkbtn" type="submit">Not {tech.first_name}? Choose your technician</button>
          </form>
        )}
      </section>
    </PublicPage>
  );
}

const SHORT_LABEL: Record<string, string> = { bbb: 'BBB' };

/**
 * After rating. Happy customers get the big review buttons. Low ratings get a call-back request first,
 * with the same review links still on the page underneath (every customer can always post publicly:
 * hiding them would be "review gating", which Google's review policy prohibits).
 */
function SharePage(p: {
  s: Settings;
  tech: Tech;
  tap: TapRow;
  preview?: boolean;
  callback?: { error?: string; phone?: string; time?: string };
}) {
  const { s, tech, tap, preview, callback } = p;
  const sites = enabledSites(s);
  const happy = (tap.rating ?? 0) > s.alert_threshold;
  const first = firstWord(tap.customer_name);
  // A staff preview isn't saved, so the link says whose page it was (their today/home location still applies).
  const go = (site: string) => `/go/${tap.id}/${site}${tap.id === 'preview' ? `?as=${tech.slug}` : ''}`;
  return (
    <PublicPage title={`Thank you · ${companyName(s)}`} s={s}>
      {preview && <p class="preview-note"><Icon name="lock" size={16} /> Preview. Nothing was saved.</p>}
      <section class="pub__card">
        <div class="tech-hero tech-hero--sm">
          <span class="ring"><Avatar tech={tech} size={72} /></span>
          <h1>Thank you, {first}.</h1>
        </div>

        {happy ? (
          sites.length ? (
            <>
              <p class="lede">Would you share that on {sites[0].label}? It takes a minute and helps your neighbors find someone they can trust.</p>
              <p class="tip"><Icon name="star" size={18} /> <span>Mention <strong>{tech.first_name}</strong> by name so they get the credit.</span></p>
              {tap.comment && (
                <div class="copybox">
                  <p class="small muted">Your comment, ready to paste:</p>
                  <blockquote>{tap.comment}</blockquote>
                  <button type="button" class="btn btn--ghost btn--sm" data-copy={tap.comment}><Icon name="copy" size={16} /> Copy</button>
                </div>
              )}
              <div class="sites">
                {sites.map((site, i) => (
                  <>
                    {i === 1 && <p class="sites__or">Or review us on</p>}
                    <a class={`btn btn--lg btn--block ${i === 0 ? 'btn--red' : 'btn--ghost'}`} href={go(site.id)} rel="noopener">
                      {i === 0 && site.id === 'google' && <span class="gchip"><GoogleG size={18} /></span>}
                      {i === 0 ? `Review us on ${site.label}` : site.label}
                    </a>
                  </>
                ))}
              </div>
              <p class="fine">Your star rating on this page stays with {companyName(s)}. It isn't posted anywhere.</p>
            </>
          ) : <p class="lede">Your rating is with the team. Thanks for taking a moment.</p>
        ) : tap.callback_at ? (
          <div class="notice notice--ok" role="status">
            <strong><Icon name="check" size={18} /> Thanks, {first}. A manager will call you {CALL_TIMES[tap.callback_time ?? 'asap'] ?? 'soon'}.</strong>
            <p>We'll call the number ending in <strong>{maskPhone(tap.callback_phone).slice(-2)}</strong>.{s.office_phone && <> If you'd rather talk now, call <a href={telHref(s.office_phone)}>{s.office_phone}</a>.</>}</p>
          </div>
        ) : (
          <>
            <form method="post" action={`/${tech.slug}/callback`} class="callback">
              <div>
                <h2 class="h-sm">We're sorry the visit fell short.</h2>
                <p class="muted small">Tell us what happened and a manager will call you to make it right.</p>
              </div>
              <input type="hidden" name="t" value={tap.id} />
              <input type="hidden" name="name" value={tap.customer_name ?? ''} />
              <input type="hidden" name="rating" value={String(tap.rating ?? '')} />
              <div class={`field ${callback?.error ? 'field--invalid' : ''}`}>
                <label for="cb-phone">Your phone number</label>
                <input id="cb-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength={30} value={callback?.phone ?? ''} placeholder="(555) 555-0123"
                  aria-invalid={callback?.error ? 'true' : undefined} aria-describedby={callback?.error ? 'err-phone' : undefined} autofocus={!!callback?.error} />
                {callback?.error && <p class="error" id="err-phone">{callback.error}</p>}
              </div>
              <div class="field">
                <label for="cb-time">Best time to call</label>
                <select id="cb-time" name="time">
                  {[['asap', 'As soon as possible'], ['morning', 'Morning'], ['afternoon', 'Afternoon'], ['evening', 'Evening']].map(([v, label]) => (
                    <option value={v} selected={(callback?.time ?? 'asap') === v}>{label}</option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label for="cb-details">What went wrong? <span class="dim">(optional)</span></label>
                <textarea id="cb-details" name="details" rows={3} maxlength={1000}>{tap.comment ?? ''}</textarea>
              </div>
              <div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex={-1} autocomplete="off" /></label></div>
              <button class="btn btn--red btn--lg btn--block" type="submit"><Icon name="phone" /> Request a call</button>
              <p class="fine">This goes straight to our office and isn't posted anywhere. We'll only use your number to call about this visit.</p>
            </form>
            {s.office_phone && <p class="small muted center">Or call us now: <a href={telHref(s.office_phone)}><strong>{s.office_phone}</strong></a></p>}
          </>
        )}

        {!happy && sites.length > 0 && (
          <p class="alt-review small">
            Prefer to post a public review?{' '}
            {sites.map((site, i) => (
              <>{i > 0 && ' · '}<a href={go(site.id)} rel="noopener">{SHORT_LABEL[site.id] ?? site.label}</a></>
            ))}
          </p>
        )}
      </section>
    </PublicPage>
  );
}

export default pub;

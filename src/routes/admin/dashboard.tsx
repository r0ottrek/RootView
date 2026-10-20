import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { all, one } from '../../lib/db';
import { processPending, type ReviewRow } from '../../lib/reviews';
import { kpis, leaderboard, weeklyReviews } from '../../lib/stats';
import { avg1, fmtDate, parsePeriod, pct, periodRange, relTime } from '../../lib/util';
import { ReviewCard, creditsFor } from '../../views/review';
import { Avatar, ColumnChart, Empty, Icon, Stat, trend } from '../../views/ui';
import { Seg, page } from './common';

const dash = new Hono<AppEnv>();

const PERIODS = [
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'last', label: 'Last month' },
  { key: 'quarter', label: '90 days' },
  { key: 'year', label: 'This year' },
  { key: 'all', label: 'All time' },
];

dash.get('/', async (c) => {
  const s = c.get('settings');
  // Keep matching current even between 15-minute runs (cheap: one batch, a handful of queries).
  // Demo mode drains the whole backlog at once; locally there is no per-request query limit.
  let pending = await processPending(c.env, s, 50);
  for (let i = 0; s.demo && pending.remaining > 0 && i < 30; i++) pending = await processPending(c.env, s, 50);
  const period = parsePeriod(c.req.query('p'));
  const range = periodRange(period, s.timezone);
  const [k, board, weeks, recent] = await Promise.all([
    kpis(c.env.DB, range.start, range.end, range.prevStart, range.prevEnd, s.tracking_start, s.alert_threshold),
    leaderboard(c.env.DB, range.start, range.end),
    weeklyReviews(c.env.DB, s.timezone, 12, Date.now()),
    all<ReviewRow>(c.env.DB, `SELECT * FROM reviews WHERE status <> 'history' ORDER BY posted_at DESC LIMIT 5`),
  ]);
  const credits = await creditsFor(c.env.DB, recent.map((r) => r.id));
  const admin = c.get('admin');
  const team = admin.role === 'owner'
    ? await one<{ n: number; invited: number }>(c.env.DB, `SELECT COUNT(*) AS n, COALESCE(SUM(password_hash IS NOT NULL OR invite_expires_at > ?), 0) AS invited FROM techs WHERE active = 1`, Date.now())
    : null;
  const steps = team ? [
    { done: !!s.company_name && (s.brand.logo || s.brand.icon), label: 'Add your name, logo and colors', href: '/admin/branding' },
    { done: s.sites.some((x) => x.enabled && x.url) || s.locations.length > 0, label: 'Add your Google review link', href: '/admin/settings#sites' },
    { done: team.n > 0, label: 'Add your techs', href: '/admin/team/new' },
    { done: team.n > 0 && team.invited > 0, label: 'Send each tech their app invite', href: '/admin/team' },
    { done: s.alert_emails.length > 0, label: 'Choose who gets low-rating alerts', href: '/admin/settings#alerts' },
    { done: !!admin.totp_enabled, label: 'Turn on two-step sign-in for yourself', href: '/admin/account#2fa' },
    { done: s.google_locations.length > 0, label: 'Connect Google so reviews come in by themselves (optional)', href: '/admin/settings#google' },
  ] : [];
  const todo = steps.filter((x) => !x.done).length;
  const tReviews = trend(k.reviews, k.prev_reviews, range.prevLabel);
  const tTaps = trend(k.taps, k.prev_taps, range.prevLabel);
  const active = board.filter((r) => r.reviews || r.taps);
  const googleTotals = Object.values(s.google_totals);

  return page(c, {
    title: 'Dashboard',
    active: 'dashboard',
    lede: `${range.label}. Reviews from Google, Yelp and BBB, matched to the tech who earned them.`,
    actions: <Seg current={period} items={PERIODS.map((p) => ({ ...p, href: `/admin?p=${p.key}` }))} />,
  }, (
    <>
      {todo > 0 && (
        <section class="card setup-list" aria-label="Getting started">
          <div class="row-between"><h2 class="h-sm">Getting started</h2><span class="small dim">{steps.length - todo} of {steps.length} done</span></div>
          <ol class="plain stack-xs" role="list">
            {steps.map((x) => (
              <li class={x.done ? 'is-done' : ''}>
                <Icon name={x.done ? 'check' : 'arrow'} size={16} /> {x.done ? <span>{x.label}</span> : <a href={x.href}>{x.label}</a>}
              </li>
            ))}
          </ol>
        </section>
      )}
      <section class="kpis">
        <Stat label="New reviews" value={k.reviews} sub={tReviews?.sub} tone={tReviews?.tone} href="/admin/reviews?f=all" />
        <Stat label="Average rating" value={<>{avg1(k.avg_rating)}<span class="stat__unit">★</span></>}
          sub={k.prev_avg != null && range.prevLabel ? `${avg1(k.prev_avg)} ${range.prevLabel}` : undefined} />
        <Stat label="Customers who tapped" value={k.taps} sub={tTaps?.sub} tone={tTaps?.tone} href="/admin/activity" />
        <Stat label="Clicks that became reviews" value={pct(k.converted, k.clicks)} sub={`${k.converted} of ${k.clicks} who clicked through`} />
      </section>

      {(k.unassigned > 0 || k.low_open > 0 || k.no_reply > 0 || k.redemptions > 0 || pending.remaining > 0) && (
        <section class="attention" aria-label="Needs attention">
          {k.unassigned > 0 && <a href="/admin/reviews?f=unassigned"><Icon name="users" /> <strong>{k.unassigned}</strong> review{k.unassigned === 1 ? '' : 's'} need a tech</a>}
          {k.low_open > 0 && <a href="/admin/activity?f=low"><Icon name="alert" /> <strong>{k.low_open}</strong> low rating{k.low_open === 1 ? '' : 's'} to follow up</a>}
          {k.no_reply > 0 && <a href="/admin/reviews?f=noreply"><Icon name="message" /> <strong>{k.no_reply}</strong> Google review{k.no_reply === 1 ? '' : 's'} without a reply</a>}
          {k.redemptions > 0 && <a href="/admin/rewards"><Icon name="gift" /> <strong>{k.redemptions}</strong> reward request{k.redemptions === 1 ? '' : 's'}</a>}
          {pending.remaining > 0 && <span><Icon name="refresh" /> Matching {pending.remaining} more reviews in the background</span>}
        </section>
      )}

      <div class="dash-grid">
        <section class="card">
          <ColumnChart id="weekly" title="Reviews per week, last 12 weeks"
            data={weeks.map((w) => ({
              label: fmtDate(w.start, s.timezone, { month: 'short', day: 'numeric' }),
              value: w.count,
              detail: `Week of ${fmtDate(w.start, s.timezone, { month: 'short', day: 'numeric' })}: ${w.count} review${w.count === 1 ? '' : 's'}, ${w.credited} credited to a tech`,
            }))} />
        </section>
        <section class="card google-card">
          <h2 class="h-sm">Google</h2>
          {googleTotals.length ? (
            <ul class="plain" role="list">
              {googleTotals.map((g) => (
                <li class="gtotal"><span class="gtotal__n tnum">{g.rating?.toFixed(1) ?? '—'}<span class="stat__unit">★</span></span><span><strong>{g.count?.toLocaleString('en-US') ?? '—'} reviews</strong><span class="dim small">{g.title}</span></span></li>
              ))}
            </ul>
          ) : (
            <p class="muted small">Not connected yet. Once Google approves Business Profile API access, connect it in Settings and new reviews flow in every 15 minutes. Until then, add reviews by hand.</p>
          )}
          <p class="small dim">
            {s.google_last_sync_at ? <>Checked {relTime(s.google_last_sync_at, s.timezone)}. {s.google_last_sync_note}</> : 'Never checked.'}
            {s.google_last_sync_error && <span class="err-text"> Last error: {s.google_last_sync_error}</span>}
          </p>
          {s.google_locations.length > 0
            ? <form method="post" action="/admin/google/sync"><button class="btn btn--ghost btn--sm" type="submit"><Icon name="refresh" size={16} /> Check now</button></form>
            : <a class="btn btn--ghost btn--sm" href="/admin/settings#google">Connect Google</a>}
        </section>
      </div>

      <section class="card">
        <div class="row-between"><h2 class="h-sm">Leaderboard · {range.label.toLowerCase()}</h2><a class="small" href="/admin/team">Team</a></div>
        {active.length ? (
          <div class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th scope="col" class="num">#</th><th scope="col">Tech</th><th scope="col" class="num">Reviews</th><th scope="col" class="num">Avg</th>
                  <th scope="col" class="num">5★</th><th scope="col" class="num">Taps</th><th scope="col" class="num">Tag rating</th>
                  <th scope="col" class="num">Clicked</th><th scope="col" class="num">Became reviews</th><th scope="col" class="num">Points</th>
                </tr>
              </thead>
              <tbody>
                {active.map((r, i) => (
                  <tr>
                    <td class="num tnum dim">{i + 1}</td>
                    <td><a class="person" href={`/admin/team/${r.id}`}><Avatar tech={r} size={28} /><span>{r.name}</span></a></td>
                    <td class="num tnum strong">{r.reviews}</td>
                    <td class="num tnum">{avg1(r.avg_rating)}</td>
                    <td class="num tnum">{r.five_star}</td>
                    <td class="num tnum">{r.taps}</td>
                    <td class="num tnum">{r.ratings ? `${avg1(r.tap_avg)} (${r.ratings})` : '—'}</td>
                    <td class="num tnum">{r.clicks}</td>
                    <td class="num tnum">{pct(r.converted, r.clicks)}</td>
                    <td class="num tnum">{r.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={`No activity ${range.label.toLowerCase()}`}>Once techs hand out their tags, taps and matched reviews show up here.</Empty>
        )}
      </section>

      <section class="card">
        <div class="row-between"><h2 class="h-sm">Latest reviews</h2><a class="small" href="/admin/reviews?f=all">All reviews</a></div>
        {recent.length ? (
          <div class="stack-md">{recent.map((r) => <ReviewCard r={r} tz={s.timezone} credits={credits.get(r.id)} href={`/admin/reviews/${r.id}`} clamp />)}</div>
        ) : <Empty title="No reviews yet">Connect Google in Settings, or add a Yelp or BBB review by hand.</Empty>}
      </section>
    </>
  ));
});

export default dash;

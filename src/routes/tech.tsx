/**
 * The tech's own app: their numbers, their QR code, their reviews, their points.
 *
 * Each tech has a separate login (username, email or phone + password) that only ever reaches /me. The office sends a
 * one-time invite link (Team → tech → Send invite); opening it shows a "choose your password" form and changes nothing,
 * so message-preview bots can't use it up. The invite works once and expires after 72 hours.
 */
import { Hono, type Context } from 'hono';
import type { AppEnv, Tech } from '../env';
import {
  clientKey, endSession, hashPassword, needsRehash, overLimit, passwordProblem, requireTech, revokeSessions, startSession,
  familiar, signedIn, verifyAgainstNobody, verifyPassword, whoKey,
} from '../lib/auth';
import { TECH_COLS, all, one, run, stmt } from '../lib/db';
import { sendAlert } from '../lib/email';
import { dayKey } from '../lib/geo';
import { qrSvg } from '../lib/qr';
import type { ReviewRow } from '../lib/reviews';
import { companyName, tagUrl } from '../lib/settings';
import { leaderboard, pointsBalance } from '../lib/stats';
import { HOUR, MINUTE, avg1, clampInt, fmtDate, line, newId, now, periodRange, relTime, sha256hex, str } from '../lib/util';
import { Brand, Doc, TechShell, back, flashFrom, render } from '../views/layout';
import { ReviewCard, creditsFor } from '../views/review';
import { Avatar, Empty, Icon, Pager, Stat } from '../views/ui';

const me = new Hono<AppEnv>();

// ---------- sign in ----------

function AuthCard({ title, children }: { title: string; children?: unknown }) {
  return (
    <Doc title={title} bodyClass="pub pub--auth" app="tech">
      <main id="main" class="pub__main">
        <header class="pub__head"><Brand /></header>
        <section class="pub__card pub__card--box">
          <h1 class="h-md">{title}</h1>
          {children}
        </section>
      </main>
    </Doc>
  );
}

function LoginForm({ error, ident }: { error?: string; ident?: string }) {
  return (
    <AuthCard title="Technician sign in">
      {error && <p class="flash flash--err" role="alert">{error}</p>}
      <form method="post" action="/me/login" class="stack-md">
        <div class="field"><label for="ident">Username, email or phone</label>
          <input id="ident" name="ident" required maxlength={120} autocomplete="username" autocapitalize="none" spellcheck={false} value={ident ?? ''} />
          <p class="hint">Your username is the end of your tag link, e.g. <code>sam</code>.</p></div>
        <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password" /></div>
        <button class="btn btn--red btn--lg btn--block" type="submit">Sign in</button>
      </form>
      <p class="fine">Forgot your password, or new here? Ask the office to send you a sign-in invite.</p>
    </AuthCard>
  );
}

me.get('/me/login', async (c) => render(c, <LoginForm />));
me.get('/me/signed-out', (c) => c.redirect('/me/login', 303));

me.post('/me/login', async (c) => {
  const b = await c.req.parseBody();
  const ident = line(b.ident, 120).toLowerCase();
  const password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  const ip = await clientKey(c);
  const digits = ident.replace(/\D/g, '');
  // A phone number counts as one account however it's typed.
  const who = await whoKey(digits.length >= 10 ? `tel:${digits.slice(-10)}` : ident);
  // Counted before checking, so parallel guesses can't slip past the limit. A success clears the per-account counts.
  // Tech links are public, so the cap across every connection skips phones this tech signed in from recently.
  if ((await overLimit(c.env.DB, `tech-login:ip:${ip}`, 30, 15 * MINUTE)) || (await overLimit(c.env.DB, `tech-login:${who}:${ip}`, 8, 15 * MINUTE))) {
    return render(c, <LoginForm ident={ident} error="Too many tries. Wait 15 minutes and try again." />, 429);
  }
  if (!(await familiar(c.env.DB, `tech-login:${who}:${ip}`)) && (await overLimit(c.env.DB, `tech-login:acct:${who}`, 40, HOUR))) {
    return render(c, <LoginForm ident={ident} error="Too many tries on this account. Wait an hour, or ask the office for a sign-in link." />, 429);
  }
  const tech = await one<Tech>(c.env.DB,
    `SELECT ${TECH_COLS} FROM techs WHERE active = 1 AND password_hash IS NOT NULL
       AND (slug = ?1 OR lower(email) = ?1 OR (length(?2) >= 10 AND replace(replace(replace(replace(replace(phone, '(', ''), ')', ''), '-', ''), ' ', ''), '+', '') LIKE '%' || ?2))
     LIMIT 1`, ident, digits);
  const ok = tech?.password_hash ? await verifyPassword(password, tech.password_hash) : await verifyAgainstNobody(password, c.env);
  if (!ok || !tech) return render(c, <LoginForm ident={ident} error="That username or password is wrong." />, 422);
  await signedIn(c.env.DB, [`tech-login:${who}:${ip}`, `tech-login:acct:${who}`], `tech-login:${who}:${ip}`);
  if (needsRehash(tech.password_hash!, c.env)) await run(c.env.DB, `UPDATE techs SET password_hash = ? WHERE id = ?`, await hashPassword(password, c.env), tech.id);
  await startSession(c, 'tech', tech.id);
  return c.redirect('/me', 303);
});

// ---------- invite: choose a password ----------

async function inviteTech(c: Context<AppEnv>): Promise<Tech | null> {
  const token = c.req.param('token') ?? '';
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  return one<Tech>(c.env.DB, `SELECT ${TECH_COLS} FROM techs WHERE invite_hash = ? AND invite_expires_at > ? AND active = 1`, await sha256hex(token), now());
}

function InviteForm({ tech, error }: { tech: Tech; error?: string }) {
  return (
    <AuthCard title={`Welcome, ${tech.first_name}`}>
      <p class="muted">Choose a password for your {tech.first_name ? 'tech app' : 'account'}. You'll sign in with your username <code>{tech.slug}</code> and this password.</p>
      {error && <p class="flash flash--err" role="alert">{error}</p>}
      <form method="post" class="stack-md">
        <div class="field"><label for="password">New password</label><input id="password" name="password" type="password" required minlength={10} maxlength={200} autocomplete="new-password" /><p class="hint">At least 10 characters. A short sentence works well.</p></div>
        <div class="field"><label for="confirm">Type it again</label><input id="confirm" name="confirm" type="password" required minlength={10} maxlength={200} autocomplete="new-password" /></div>
        <input type="hidden" name="username" value={tech.slug} autocomplete="username" />
        <button class="btn btn--red btn--lg btn--block" type="submit">Save and open my app</button>
      </form>
    </AuthCard>
  );
}

const InviteGone = () => (
  <AuthCard title="That invite has expired">
    <p class="muted">Invite links work once and expire after 72 hours. Ask the office to send you a new one.</p>
    <a class="btn btn--ghost btn--block" href="/me/login">Go to sign in</a>
  </AuthCard>
);

me.get('/invite/:token', async (c) => {
  const tech = await inviteTech(c);
  return tech ? render(c, <InviteForm tech={tech} />) : render(c, <InviteGone />, 404);
});

me.post('/invite/:token', async (c) => {
  if (await overLimit(c.env.DB, `invite:${await clientKey(c)}`, 20, 15 * MINUTE)) return render(c, <InviteGone />, 429);
  const tech = await inviteTech(c);
  if (!tech) return render(c, <InviteGone />, 404);
  const b = await c.req.parseBody();
  const pw = typeof b.password === 'string' ? b.password : '';
  const problem = passwordProblem(pw) ?? (pw !== b.confirm ? "The two passwords don't match." : null);
  if (problem) return render(c, <InviteForm tech={tech} error={problem} />, 422);
  // Only the request that actually uses up the invite gets in (two at once with the same link: one wins).
  const used = await run(c.env.DB,
    `UPDATE techs SET password_hash = ?, invite_hash = NULL, invite_expires_at = NULL, updated_at = ? WHERE id = ? AND invite_hash = ?`,
    await hashPassword(pw, c.env), now(), tech.id, await sha256hex(c.req.param('token') ?? ''));
  if (!used.meta.changes) return render(c, <InviteGone />, 404);
  await run(c.env.DB, `DELETE FROM sessions WHERE kind = 'tech' AND subject_id = ?`, tech.id);
  await startSession(c, 'tech', tech.id);
  return c.redirect(`/me?ok=${encodeURIComponent(`You're in, ${tech.first_name}. Add this page to your home screen.`)}`, 303);
});

// ---------- the app (signed in) ----------

me.use('/me', requireTech);
me.use('/me/*', async (c, next) => (c.req.path === '/me/login' || c.req.path === '/me/signed-out' ? next() : requireTech(c, next)));

me.get('/me', async (c) => {
  const s = c.get('settings');
  const tech = c.get('tech');
  const range = periodRange('month', s.timezone);
  const board = await leaderboard(c.env.DB, range.start, range.end);
  const rankIdx = board.findIndex((r) => r.id === tech.id);
  const mine = board[rankIdx];
  const balance = await pointsBalance(c.env.DB, tech.id);
  const reviews = await all<ReviewRow>(c.env.DB,
    `SELECT r.* FROM reviews r JOIN credits c ON c.review_id = r.id WHERE c.tech_id = ? ORDER BY r.posted_at DESC LIMIT 3`, tech.id);
  const link = tagUrl(s, tech.slug, 'text', new URL(c.req.url).origin);
  const smsBody = `Thanks for choosing ${companyName(s)}! It would mean a lot if you'd rate today's visit: ${link}`;
  const ranked = board.filter((r) => r.reviews > 0);
  const top = board.slice(0, 5);
  const todayLoc = tech.today_on === dayKey(now(), s.timezone) ? s.locations.find((l) => l.id === tech.today_location) : undefined;
  const homeLoc = s.locations.find((l) => l.id === tech.home_location) ?? s.locations[0];
  return render(c, (
    <TechShell title="Home" tech={tech} active="home" flash={flashFrom(c)}>
      <h1 class="sr-only">Home</h1>
      <section class="me-hero">
        <p class="eyebrow">{range.label}</p>
        <div class="me-stats">
          <Stat label="Reviews" value={mine?.reviews ?? 0} sub={mine?.five_star ? `${mine.five_star} five-star` : undefined} />
          <Stat label="Rank" value={mine && mine.reviews > 0 ? `#${rankIdx + 1}` : '—'} sub={`of ${board.length}`} />
          <Stat label="Taps" value={mine?.taps ?? 0} sub={mine?.ratings ? `avg ${avg1(mine.tap_avg)}★` : undefined} />
          <Stat label="Points" value={balance} sub={<a href="/me/rewards">Rewards</a>} />
        </div>
      </section>

      <section class="me-actions">
        <a class="btn btn--red btn--lg btn--block" href="/me/qr"><Icon name="qr" /> Show my QR code</a>
        <a class="btn btn--green btn--lg btn--block" href={`sms:?&body=${encodeURIComponent(smsBody)}`}><Icon name="message" /> Text my review link</a>
        <button type="button" class="btn btn--ghost btn--block" data-copy={link}><Icon name="copy" /> Copy my link</button>
        <p class="fine">Or just hand them your tag. Tapping it opens the same page.</p>
      </section>

      {s.locations.length > 1 && (
        <section class="me-section" id="today">
          <h2 class="h-sm">Where are you working today?</h2>
          <p class="small muted">Your customers' Google button opens that location's profile. Resets tonight.</p>
          <form method="post" action="/me/today" class="loc-pick">
            {s.locations.map((l) => (
              <button type="submit" name="loc" value={l.id} class={`btn btn--sm ${todayLoc?.id === l.id ? 'btn--green' : 'btn--ghost'}`} aria-pressed={todayLoc?.id === l.id ? 'true' : 'false'}>{l.label}</button>
            ))}
            <button type="submit" name="loc" value="" class={`btn btn--sm ${todayLoc ? 'btn--ghost' : 'btn--green'}`} aria-pressed={todayLoc ? 'false' : 'true'}>Automatic</button>
          </form>
          <p class="fine">{todayLoc
            ? <>Today: <strong>{todayLoc.label}</strong>, for every customer you help.</>
            : <>Automatic: the location for the customer's area, otherwise <strong>{homeLoc?.label}</strong>.</>}</p>
        </section>
      )}

      <section class="me-section">
        <h2 class="h-sm">Leaderboard · {range.label.toLowerCase()}</h2>
        <ol class="board" role="list">
          {top.map((r, i) => <BoardRow r={r} rank={i + 1} me={r.id === tech.id} />)}
          {rankIdx >= 5 && mine && <BoardRow r={mine} rank={rankIdx + 1} me />}
        </ol>
        {!ranked.length && <p class="dim small">No reviews credited yet this month. The first one takes the lead.</p>}
      </section>

      <section class="me-section">
        <div class="row-between"><h2 class="h-sm">Your latest reviews</h2><a class="small" href="/me/reviews" aria-label="See all my reviews">See all</a></div>
        {reviews.length ? (
          <div class="stack-md">{reviews.map((r) => <ReviewCard r={r} tz={s.timezone} clamp />)}</div>
        ) : (
          <Empty title="No reviews yet">When a customer you helped posts a review, it shows up here and on the leaderboard.</Empty>
        )}
      </section>
    </TechShell>
  ));
});

me.post('/me/today', async (c) => {
  const s = c.get('settings');
  const tech = c.get('tech');
  const picked = str((await c.req.parseBody()).loc, 120);
  const loc = s.locations.find((l) => l.id === picked);
  await run(c.env.DB, `UPDATE techs SET today_location = ?, today_on = ? WHERE id = ?`, loc?.id ?? null, loc ? dayKey(now(), s.timezone) : null, tech.id);
  const ok = loc ? `Today: ${loc.label}. Your customers go to that Google profile until tonight.` : "Automatic. The site picks from the customer's area.";
  return c.redirect(`${back('/me', { ok })}#today`, 303);
});

function BoardRow({ r, rank, me: isMe }: { r: Awaited<ReturnType<typeof leaderboard>>[number]; rank: number; me?: boolean }) {
  return (
    <li class={`board__row ${isMe ? 'is-me' : ''}`}>
      <span class="board__rank tnum">{rank}</span>
      <Avatar tech={r} size={32} />
      <span class="board__name">{r.first_name}{isMe ? ' (you)' : ''}</span>
      <span class="board__n tnum">{r.reviews} <span class="dim small">review{r.reviews === 1 ? '' : 's'}</span></span>
    </li>
  );
}

me.get('/me/qr', (c) => {
  const s = c.get('settings');
  const tech = c.get('tech');
  const url = tagUrl(s, tech.slug, 'qr', new URL(c.req.url).origin);
  return render(c, (
    <Doc title={`My QR code · ${companyName(s)}`} bodyClass="qr-screen" app="tech">
      <main id="main" class="qr-screen__main">
        <p class="eyebrow">Scan to rate your visit</p>
        <div class="qr-screen__code" dangerouslySetInnerHTML={{ __html: qrSvg(url, { size: 300, border: 3 }) }} />
        <h1 class="qr-screen__name">{tech.first_name}</h1>
        <p class="muted small">{url.replace(/^https?:\/\//, '').replace(/\?.*$/, '')}</p>
        <a class="btn btn--ghost" href="/me"><Icon name="back" /> Done</a>
      </main>
    </Doc>
  ));
});

me.get('/me/reviews', async (c) => {
  const s = c.get('settings');
  const tech = c.get('tech');
  const page = clampInt(c.req.query('page'), 1, 500, 1);
  const rows = await all<ReviewRow>(c.env.DB,
    `SELECT r.* FROM reviews r JOIN credits c ON c.review_id = r.id WHERE c.tech_id = ? ORDER BY r.posted_at DESC LIMIT 21 OFFSET ?`, tech.id, (page - 1) * 20);
  const credits = await creditsFor(c.env.DB, rows.slice(0, 20).map((r) => r.id));
  return render(c, (
    <TechShell title="My reviews" tech={tech} active="reviews">
      <h1 class="h-page">My reviews</h1>
      {rows.length ? (
        <div class="stack-md">{rows.slice(0, 20).map((r) => <ReviewCard r={r} tz={s.timezone} credits={(credits.get(r.id) ?? []).filter((x) => x.tech_id !== tech.id)} reasons={false} />)}</div>
      ) : (
        <Empty title="No reviews yet">Hand customers your tag at the end of each job. Reviews that mention you, or come from customers who used your tag, land here.</Empty>
      )}
      <Pager page={page} hasMore={rows.length > 20} base="/me/reviews" />
    </TechShell>
  ));
});

interface RewardRow { id: string; name: string; description: string; cost: number }
interface RedemptionRow { id: string; reward_name: string; cost: number; status: string; created_at: number }

me.get('/me/rewards', async (c) => {
  const s = c.get('settings');
  const tech = c.get('tech');
  const balance = await pointsBalance(c.env.DB, tech.id);
  const rewards = await all<RewardRow>(c.env.DB, `SELECT id, name, description, cost FROM rewards WHERE active = 1 ORDER BY cost`);
  const mine = await all<RedemptionRow>(c.env.DB, `SELECT id, reward_name, cost, status, created_at FROM redemptions WHERE tech_id = ? ORDER BY created_at DESC LIMIT 10`, tech.id);
  const ledger = await all<{ amount: number; reason: string; created_at: number }>(c.env.DB,
    `SELECT amount, reason, created_at FROM points WHERE tech_id = ? ORDER BY created_at DESC LIMIT 12`, tech.id);
  const p = s.points;
  return render(c, (
    <TechShell title="Rewards" tech={tech} active="rewards" flash={flashFrom(c)}>
      <h1 class="sr-only">Rewards</h1>
      <section class="me-hero">
        <p class="eyebrow">Your points</p>
        <p class="bignum tnum">{balance}</p>
        <p class="muted small">{p.review} per review{p.five_star ? `, +${p.five_star} for 5 stars` : ''}{p.mention ? `, +${p.mention} when they name you` : ''}{p.rating ? `, ${p.rating} when a customer rates you on your tag` : ''}. Reviews under {p.min_rating} stars don't earn points.</p>
      </section>
      <section class="me-section">
        <h2 class="h-sm">Rewards</h2>
        {rewards.length ? (
          <ul class="rewards" role="list">
            {rewards.map((r) => (
              <li class="reward">
                <div><strong>{r.name}</strong>{r.description && <p class="small muted">{r.description}</p>}</div>
                <form method="post" action={`/me/rewards/${r.id}`} data-confirm={`Spend ${r.cost} points on ${r.name}?`}>
                  <button class={`btn btn--sm ${balance >= r.cost ? 'btn--green' : 'btn--ghost'}`} type="submit" disabled={balance < r.cost} aria-label={`${r.cost} pts: get ${r.name}`}>{r.cost} pts</button>
                </form>
              </li>
            ))}
          </ul>
        ) : <p class="dim small">The office hasn't set up rewards yet.</p>}
      </section>
      {mine.length > 0 && (
        <section class="me-section">
          <h2 class="h-sm">Your requests</h2>
          <ul class="plain" role="list">
            {mine.map((r) => <li class="row-between"><span>{r.reward_name} <span class="dim small">· {fmtDate(r.created_at, s.timezone)}</span></span><span class={`chip ${r.status === 'denied' ? 'chip--muted' : 'chip--green'}`}>{r.status}</span></li>)}
          </ul>
        </section>
      )}
      <section class="me-section">
        <h2 class="h-sm">Recent points</h2>
        {ledger.length ? (
          <ul class="plain" role="list">
            {ledger.map((l) => <li class="row-between"><span>{l.reason} <span class="dim small">· {fmtDate(l.created_at, s.timezone, { month: 'short', day: 'numeric' })}</span></span><span class={`tnum ${l.amount > 0 ? 'pos' : 'dim'}`}>{l.amount > 0 ? `+${l.amount}` : l.amount}</span></li>)}
          </ul>
        ) : <p class="dim small">No points yet.</p>}
      </section>
    </TechShell>
  ));
});

me.post('/me/rewards/:id', async (c) => {
  const s = c.get('settings');
  const tech = c.get('tech');
  const reward = await one<RewardRow>(c.env.DB, `SELECT id, name, description, cost FROM rewards WHERE id = ? AND active = 1`, c.req.param('id'));
  if (!reward) return c.redirect(back('/me/rewards', { err: 'That reward is no longer available.' }), 303);
  const rid = newId('rd');
  const t = now();
  // The balance check is part of the insert, so two quick taps can't spend the same points twice.
  const [ins] = await c.env.DB.batch([
    stmt(c.env.DB, `INSERT INTO redemptions (id, tech_id, reward_id, reward_name, cost, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE (SELECT COALESCE(SUM(amount), 0) FROM points WHERE tech_id = ?2) >= ?5
        AND (SELECT COUNT(*) FROM redemptions WHERE tech_id = ?2 AND status = 'requested') < 5`,
      rid, tech.id, reward.id, reward.name, reward.cost, t),
    stmt(c.env.DB, `INSERT INTO points (id, tech_id, amount, reason, redemption_id, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM redemptions WHERE id = ?)`,
      newId('pt'), tech.id, -reward.cost, `Redeemed: ${reward.name}`, rid, t, rid),
  ]);
  if (!ins.meta.changes) {
    const balance = await pointsBalance(c.env.DB, tech.id);
    return c.redirect(back('/me/rewards', { err: balance < reward.cost ? `You need ${reward.cost - balance} more points.` : 'You already have 5 requests waiting for the office.' }), 303);
  }
  c.executionCtx.waitUntil(sendAlert(c.env, s, `${tech.first_name} redeemed ${line(reward.name, 60)}`,
    `${tech.name} spent ${reward.cost} points on "${reward.name}".\n\nApprove it: ${s.public_base_url.replace(/\/+$/, '')}/admin/rewards`));
  return c.redirect(back('/me/rewards', { ok: `Requested ${reward.name}. The office will confirm.` }), 303);
});

// ---------- account ----------

me.get('/me/account', async (c) => {
  const s = c.get('settings');
  const tech = c.get('tech');
  const devices = await all<{ id: string; label: string | null; created_at: number; last_seen_at: number | null }>(c.env.DB,
    `SELECT id, label, created_at, last_seen_at FROM sessions WHERE kind = 'tech' AND subject_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`, tech.id, now());
  const here = c.get('sessionId');
  return render(c, (
    <TechShell title="Account" tech={tech} active="account" flash={flashFrom(c)}>
      <h1 class="h-page">Account</h1>
      <section class="me-section">
        <p class="small muted">Signed in as <strong>{tech.name}</strong> · username <code>{tech.slug}</code></p>
      </section>
      <section class="me-section">
        <h2 class="h-sm">Change password</h2>
        <form method="post" action="/me/account/password" class="stack-md">
          <div class="field"><label for="cur">Current password</label><input id="cur" name="current" type="password" required autocomplete="current-password" /></div>
          <div class="field"><label for="npw">New password</label><input id="npw" name="password" type="password" required minlength={10} maxlength={200} autocomplete="new-password" /><p class="hint">At least 10 characters. Other phones are signed out.</p></div>
          <button class="btn btn--ghost btn--block" type="submit">Change password</button>
        </form>
      </section>
      <section class="me-section">
        <h2 class="h-sm">Signed-in devices</h2>
        <ul class="plain user-list" role="list">
          {devices.map((d) => (
            <li class="row-between"><span>{d.label ?? 'Device'}{d.id === here && <span class="chip chip--green">This phone</span>}</span>
              <span class="dim small">active {relTime(d.last_seen_at ?? d.created_at, s.timezone)}</span></li>
          ))}
        </ul>
        {devices.length > 1 && (
          <form method="post" action="/me/account/signout-others" data-confirm="Sign out every other device?">
            <button class="btn btn--ghost btn--block" type="submit">Sign out other devices</button>
          </form>
        )}
      </section>
      <form method="post" action="/me/logout" class="me-signout"><button class="linkbtn small" type="submit">Sign out of this phone</button></form>
    </TechShell>
  ));
});

me.post('/me/account/password', async (c) => {
  const tech = c.get('tech');
  const b = await c.req.parseBody();
  if (await overLimit(c.env.DB, `tech-pw:${tech.id}`, 8, 15 * MINUTE)) return c.redirect(back('/me/account', { err: 'Too many tries. Wait 15 minutes.' }), 303);
  const current = typeof b.current === 'string' ? b.current : '';
  const next = typeof b.password === 'string' ? b.password : '';
  if (!tech.password_hash || !(await verifyPassword(current, tech.password_hash))) return c.redirect(back('/me/account', { err: 'Current password is wrong.' }), 303);
  const problem = passwordProblem(next);
  if (problem) return c.redirect(back('/me/account', { err: problem }), 303);
  await run(c.env.DB, `UPDATE techs SET password_hash = ? WHERE id = ?`, await hashPassword(next, c.env), tech.id);
  await revokeSessions(c.env.DB, 'tech', tech.id, c.get('sessionId'));
  return c.redirect(back('/me/account', { ok: 'Password changed. Other devices were signed out.' }), 303);
});

me.post('/me/account/signout-others', async (c) => {
  await revokeSessions(c.env.DB, 'tech', c.get('tech').id, c.get('sessionId'));
  return c.redirect(back('/me/account', { ok: 'Other devices signed out.' }), 303);
});

me.post('/me/logout', async (c) => {
  await endSession(c, 'tech');
  return c.redirect('/me/login', 303);
});

export default me;

import { Hono } from 'hono';
import type { AppEnv, Tech } from '../../env';
import { parseImage } from '../../lib/assets';
import { audit } from '../../lib/audit';
import { revokeSessions } from '../../lib/auth';
import { all, one, run, scalar } from '../../lib/db';
import { qrSvg } from '../../lib/qr';
import { platformLabel, type ReviewRow } from '../../lib/reviews';
import { companyName, tagUrl, type ReviewLocation } from '../../lib/settings';
import { leaderboard, pointsBalance } from '../../lib/stats';
import {
  HOUR, RESERVED_SLUGS, avg1, clampInt, fmtDate, fmtDateTime, line, newId, now, pct, periodRange, randomToken, relTime, sha256hex, slugify, str,
} from '../../lib/util';
import { Doc, back, render } from '../../views/layout';
import { ReviewCard, creditsFor } from '../../views/review';
import { Avatar, Chip, Empty, Icon, Stars, Stat } from '../../views/ui';
import { SOURCE_LABEL, page, type Ctx } from './common';

const team = new Hono<AppEnv>();

const INVITE_HOURS = 72;
const PHOTO_MAX = 150_000;

/** Where a tech's own login stands: set up, invite waiting, or nothing yet. */
function LoginChip({ t }: { t: { has_login: number | boolean; invite_expires_at: number | null } }) {
  if (t.has_login) return <Chip tone="green">Signed up</Chip>;
  if (t.invite_expires_at && t.invite_expires_at > now()) return <Chip>Invited</Chip>;
  return <Chip tone="muted">No login</Chip>;
}

// ---------- list ----------

type TechListRow = Pick<Tech, 'id' | 'slug' | 'name' | 'first_name' | 'role' | 'active' | 'sort' | 'updated_at' | 'invite_expires_at'> & { photo: number; has_login: number };

team.get('/', async (c) => {
  const s = c.get('settings');
  const month = periodRange('month', s.timezone);
  const [monthRows, allRows, techs, balances] = await Promise.all([
    leaderboard(c.env.DB, month.start, month.end, false),
    leaderboard(c.env.DB, 0, Date.now() + 1, false),
    all<TechListRow>(c.env.DB, `SELECT id, slug, name, first_name, role, active, sort, photo IS NOT NULL AS photo, updated_at, invite_expires_at,
      password_hash IS NOT NULL AS has_login FROM techs ORDER BY active DESC, sort, name`),
    all<{ tech_id: string; n: number }>(c.env.DB, `SELECT tech_id, SUM(amount) AS n FROM points GROUP BY tech_id`),
  ]);
  const m = new Map(monthRows.map((r) => [r.id, r]));
  const a = new Map(allRows.map((r) => [r.id, r]));
  const bal = new Map(balances.map((r) => [r.tech_id, r.n]));
  return page(c, {
    title: 'Team',
    active: 'team',
    lede: 'Everyone who carries a review tag. Click a name for their tag link, QR code, printable card and app invite.',
    actions: <a class="btn btn--red btn--sm" href="/admin/team/new"><Icon name="plus" size={16} /> Add a tech</a>,
  }, techs.length ? (
    <section class="card">
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr>
            <th scope="col">Tech</th><th scope="col">Tag link</th><th scope="col" class="num">Reviews this month</th><th scope="col" class="num">All time</th>
            <th scope="col" class="num">Avg</th><th scope="col" class="num">Points</th><th scope="col">App login</th>
          </tr></thead>
          <tbody>
            {techs.map((t) => (
              <tr class={t.active ? '' : 'is-off'}>
                <td><a class="person" href={`/admin/team/${t.id}`}><Avatar tech={t} size={32} /><span><strong>{t.name}</strong><span class="dim small">{t.role}{t.active ? '' : ' · inactive'}</span></span></a></td>
                <td><code class="small">/{t.slug}</code></td>
                <td class="num tnum strong">{m.get(t.id)?.reviews ?? 0}</td>
                <td class="num tnum">{a.get(t.id)?.reviews ?? 0}</td>
                <td class="num tnum">{avg1(a.get(t.id)?.avg_rating)}</td>
                <td class="num tnum">{bal.get(t.id) ?? 0}</td>
                <td><LoginChip t={t} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  ) : (
    <section class="card">
      <Empty title="No techs yet" action={<a class="btn btn--red btn--sm" href="/admin/team/new"><Icon name="plus" size={16} /> Add your first tech</a>}>
        Each tech gets their own review link for an NFC tag or QR code, and their own login to see how they're doing.
      </Empty>
    </section>
  ));
});

// ---------- add / edit ----------

function TechForm({ t, error, action, locations }: { t: Partial<Tech>; error?: string; action: string; locations: ReviewLocation[] }) {
  return (
    <form method="post" action={action} class="card form-grid" data-photo-form>
      {error && <p class="flash flash--err field--wide" role="alert">{error}</p>}
      <div class="field"><label for="name">Full name</label><input id="name" name="name" required maxlength={80} value={t.name ?? ''} data-slug-source /></div>
      <div class="field"><label for="first_name">Name customers use</label><input id="first_name" name="first_name" required maxlength={40} value={t.first_name ?? ''} /><p class="hint">Shown on their page and matched in review text.</p></div>
      <div class="field"><label for="slug">Tag link and username</label>
        <div class="prefix"><span>/</span><input id="slug" name="slug" required maxlength={40} pattern="[a-z0-9][a-z0-9\-]*" value={t.slug ?? ''} data-slug /></div>
        <p class="hint">Lowercase letters, numbers and dashes. It's also their app username. Changing it breaks tags already written with the old link.</p></div>
      <div class="field"><label for="role">Role</label><input id="role" name="role" maxlength={60} value={t.role ?? 'Technician'} /></div>
      {locations.length > 1 && (
        <div class="field"><label for="home_location">Home location</label>
          <select id="home_location" name="home_location">
            <option value="">Main location ({locations[0].label})</option>
            {locations.slice(1).map((l) => <option value={l.id} selected={t.home_location === l.id}>{l.label}</option>)}
          </select>
          <p class="hint">Their customers' Google button opens this profile when the customer's area isn't known. Techs can switch it for a day in their app.</p></div>
      )}
      <div class="field field--wide"><label for="aliases">Other names customers use</label><input id="aliases" name="aliases" maxlength={200} value={t.aliases ?? ''} placeholder="e.g. Alex, Alejandro" /><p class="hint">Comma separated. Reviews mentioning any of these count as naming this tech.</p></div>
      <div class="field"><label for="phone">Mobile</label><input id="phone" name="phone" type="tel" maxlength={30} value={t.phone ?? ''} autocomplete="off" /><p class="hint">For texting their invite. They can also sign in with it.</p></div>
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" maxlength={120} value={t.email ?? ''} autocomplete="off" /><p class="hint">Optional. They can sign in with it too.</p></div>
      <div class="field"><label for="photo-file">Photo</label>
        <div class="photo-pick">
          <Avatar tech={{ id: t.id ?? 'new', name: t.name ?? '?', photo: t.photo, updated_at: t.updated_at }} size={64} />
          <input id="photo-file" type="file" accept="image/*" data-photo-input />
        </div>
        <input type="hidden" name="photo" value="" data-photo-value />
        {t.photo && <label class="check"><input type="checkbox" name="remove_photo" value="1" /> Remove photo</label>}
        <p class="hint">Square, face centered. Resized on this device before upload.</p></div>
      <div class="field"><label for="sort">List order</label><input id="sort" name="sort" type="number" min={0} max={999} value={String(t.sort ?? 100)} /></div>
      <label class="check field--wide"><input type="checkbox" name="active" value="1" checked={t.active !== 0} /> Active. Inactive techs can't sign in, and their tags show the "who helped you" list instead.</label>
      <div class="form-actions field--wide"><button class="btn btn--red" type="submit">Save</button><a class="btn btn--ghost" href={t.id ? `/admin/team/${t.id}` : '/admin/team'}>Cancel</a></div>
    </form>
  );
}

const phoneDigits = (p: string | null | undefined) => (p ?? '').replace(/\D/g, '').slice(-10);

async function readTechForm(c: Ctx, existingId: string | null): Promise<{ values: Partial<Tech>; error?: string; photo?: string | null }> {
  const b = await c.req.parseBody();
  const values: Partial<Tech> = {
    name: line(b.name, 80),
    first_name: line(b.first_name, 40),
    slug: slugify(str(b.slug, 40)),
    role: line(b.role, 60) || 'Technician',
    aliases: line(b.aliases, 200).split(',').map((x) => x.trim()).filter(Boolean).join(', '),
    phone: line(b.phone, 30) || null,
    email: str(b.email, 120).toLowerCase() || null,
    sort: clampInt(b.sort, 0, 999, 100),
    active: b.active ? 1 : 0,
  };
  // Only on the form when there are two or more locations; otherwise keep whatever is saved.
  if (b.home_location !== undefined) {
    const home = str(b.home_location, 120);
    values.home_location = c.get('settings').locations.some((l) => l.id === home) ? home : null;
  }
  if (!values.first_name && values.name) values.first_name = values.name.split(/\s+/)[0];
  if (!values.slug && values.first_name) values.slug = slugify(values.first_name);

  const photoRaw = str(b.photo, 400_000);
  let photo: string | null | undefined;
  if (photoRaw) {
    const img = parseImage(photoRaw, PHOTO_MAX);
    if ('error' in img) return { values, error: `Photo: ${img.error}` };
    photo = `data:${img.mime};base64,${img.data}`;
  } else if (b.remove_photo) photo = null;

  let error: string | undefined;
  if (!values.name) error = 'Add their name.';
  else if (!values.slug) error = 'Add a tag link.';
  else if (RESERVED_SLUGS.has(values.slug)) error = `"${values.slug}" is reserved. Pick another tag link.`;
  else if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) error = "That email doesn't look right.";
  else if (values.phone && phoneDigits(values.phone).length < 7) error = "That mobile number doesn't look right.";
  else {
    // Slug, email and mobile all sign a tech in, so none can be shared with another tech.
    const others = await all<{ name: string; slug: string; email: string | null; phone: string | null }>(c.env.DB,
      `SELECT name, slug, email, phone FROM techs WHERE id <> ?`, existingId ?? '');
    const bySlug = others.find((o) => o.slug === values.slug);
    const byEmail = values.email ? others.find((o) => o.email?.toLowerCase() === values.email) : undefined;
    const byPhone = values.phone ? others.find((o) => phoneDigits(o.phone) === phoneDigits(values.phone)) : undefined;
    if (bySlug) error = `/${values.slug} already belongs to ${bySlug.name}.`;
    else if (byEmail) error = `${byEmail.name} already uses that email.`;
    else if (byPhone) error = `${byPhone.name} already uses that mobile number.`;
  }
  return { values, error, photo };
}

team.get('/new', (c) => page(c, { title: 'Add a tech', active: 'team' }, <TechForm t={{ active: 1, sort: 100, role: 'Technician' }} action="/admin/team/new" locations={c.get('settings').locations} />));

team.post('/new', async (c) => {
  const { values: v, error, photo } = await readTechForm(c, null);
  if (error) return page(c, { title: 'Add a tech', active: 'team' }, <TechForm t={v} error={error} action="/admin/team/new" locations={c.get('settings').locations} />, 422);
  const id = newId('t');
  const t = now();
  await run(c.env.DB, `INSERT INTO techs (id, slug, name, first_name, role, aliases, phone, email, photo, active, sort, home_location, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, v.slug, v.name, v.first_name, v.role, v.aliases, v.phone, v.email, photo ?? null, v.active, v.sort, v.home_location ?? null, t, t);
  await audit(c, 'tech.add', `${v.name} (/${v.slug})`);
  return c.redirect(back(`/admin/team/${id}`, { ok: `${v.first_name} added. Next: write their tag and send their app invite.` }), 303);
});

team.post('/:id', async (c) => {
  const id = c.req.param('id');
  const cur = await one<Tech>(c.env.DB, `SELECT * FROM techs WHERE id = ?`, id);
  if (!cur) return c.redirect('/admin/team', 303);
  const { values: v, error, photo } = await readTechForm(c, id);
  if (error) return detail(c, cur, { editError: error, editValues: { ...cur, ...v } });
  await run(c.env.DB, `UPDATE techs SET slug = ?, name = ?, first_name = ?, role = ?, aliases = ?, phone = ?, email = ?, active = ?, sort = ?, photo = ?, home_location = ?, updated_at = ? WHERE id = ?`,
    v.slug, v.name, v.first_name, v.role, v.aliases, v.phone, v.email, v.active, v.sort, photo === undefined ? cur.photo : photo,
    v.home_location === undefined ? cur.home_location : v.home_location, now(), id);
  // Someone who has left loses the app at once, including any invite link still waiting.
  if (!v.active) {
    await revokeSessions(c.env.DB, 'tech', id);
    await run(c.env.DB, `UPDATE techs SET invite_hash = NULL, invite_expires_at = NULL WHERE id = ?`, id);
  }
  const changes = [cur.slug !== v.slug && `link /${cur.slug} → /${v.slug}`, cur.active !== v.active && (v.active ? 'reactivated' : 'deactivated')]
    .filter(Boolean).join(', ');
  await audit(c, 'tech.edit', `${v.name}${changes ? `: ${changes}` : ''}`);
  return c.redirect(back(`/admin/team/${id}`, { ok: 'Saved.' }), 303);
});

// ---------- detail ----------

team.get('/:id', async (c) => {
  const t = await one<Tech>(c.env.DB, `SELECT * FROM techs WHERE id = ?`, c.req.param('id'));
  if (!t) return page(c, { title: 'Not found', active: 'team' }, <Empty title="That tech doesn't exist" />, 404);
  return detail(c, t, {});
});

/** A one-time "choose your password" link. A new one cancels the old one; current sign-ins keep working until it's used. */
team.post('/:id/invite', async (c) => {
  const t = await one<Tech>(c.env.DB, `SELECT * FROM techs WHERE id = ?`, c.req.param('id'));
  if (!t) return c.redirect('/admin/team', 303);
  if (!t.active) return c.redirect(back(`/admin/team/${t.id}`, { err: `${t.first_name} is inactive. Make them active first.` }), 303);
  const token = randomToken(24);
  const expires = now() + INVITE_HOURS * HOUR;
  await run(c.env.DB, `UPDATE techs SET invite_hash = ?, invite_expires_at = ? WHERE id = ?`, await sha256hex(token), expires, t.id);
  await audit(c, t.password_hash ? 'tech.reset_link' : 'tech.invite', t.name);
  return detail(c, { ...t, invite_expires_at: expires }, { newLink: `${new URL(c.req.url).origin}/invite/${token}` });
});

team.post('/:id/signout', async (c) => {
  const t = await one<Pick<Tech, 'id' | 'name' | 'first_name'>>(c.env.DB, `SELECT id, name, first_name FROM techs WHERE id = ?`, c.req.param('id'));
  if (!t) return c.redirect('/admin/team', 303);
  await revokeSessions(c.env.DB, 'tech', t.id);
  await audit(c, 'tech.signout', t.name);
  return c.redirect(back(`/admin/team/${t.id}`, { ok: `${t.first_name} is signed out on every phone.` }), 303);
});

team.post('/:id/points', async (c) => {
  const b = await c.req.parseBody();
  const id = c.req.param('id');
  // Managers can hand out small bonuses; bigger changes to someone's balance are an owner's call.
  const cap = c.get('admin').role === 'owner' ? 10_000 : 100;
  const amount = clampInt(b.amount, -cap, cap, 0);
  const reason = line(b.reason, 120) || (amount > 0 ? 'Bonus from the office' : 'Adjustment');
  if (!amount) return c.redirect(back(`/admin/team/${id}`, { err: `Enter a number of points between -${cap} and ${cap}.` }) + '#points', 303);
  const res = await run(c.env.DB,
    `INSERT INTO points (id, tech_id, amount, reason, created_by, created_at) SELECT ?, id, ?, ?, ?, ? FROM techs WHERE id = ?`,
    newId('pt'), amount, reason, c.get('admin').name, now(), id);
  if (!res.meta.changes) return c.redirect('/admin/team', 303);
  await audit(c, 'points.adjust', `${amount > 0 ? '+' : ''}${amount} for ${id}: ${reason}`);
  return c.redirect(back(`/admin/team/${id}`, { ok: `${amount > 0 ? '+' : ''}${amount} points recorded.` }) + '#points', 303);
});

interface TapRow { id: string; source: string; customer_name: string | null; rating: number | null; comment: string | null; site: string | null; created_at: number; review_id: string | null }

async function detail(c: Ctx, t: Tech, extra: { newLink?: string; editError?: string; editValues?: Partial<Tech> }) {
  const s = c.get('settings');
  const month = periodRange('month', s.timezone);
  const [mRow, aRow, balance, reviews, taps, ledger, devices, lastSeen] = await Promise.all([
    leaderboard(c.env.DB, month.start, month.end, false).then((r) => r.find((x) => x.id === t.id)),
    leaderboard(c.env.DB, 0, Date.now() + 1, false).then((r) => r.find((x) => x.id === t.id)),
    pointsBalance(c.env.DB, t.id),
    all<ReviewRow>(c.env.DB, `SELECT r.* FROM reviews r JOIN credits c ON c.review_id = r.id WHERE c.tech_id = ? ORDER BY r.posted_at DESC LIMIT 6`, t.id),
    all<TapRow>(c.env.DB, `SELECT id, source, customer_name, rating, comment, site, created_at, review_id FROM taps WHERE tech_id = ? ORDER BY created_at DESC LIMIT 12`, t.id),
    all<{ amount: number; reason: string; created_at: number; created_by: string | null }>(c.env.DB, `SELECT amount, reason, created_at, created_by FROM points WHERE tech_id = ? ORDER BY created_at DESC LIMIT 10`, t.id),
    scalar(c.env.DB, `SELECT COUNT(*) FROM sessions WHERE kind = 'tech' AND subject_id = ? AND expires_at > ?`, t.id, now()),
    scalar(c.env.DB, `SELECT COALESCE(MAX(last_seen_at), 0) FROM sessions WHERE kind = 'tech' AND subject_id = ?`, t.id),
  ]);
  const credits = await creditsFor(c.env.DB, reviews.map((r) => r.id));
  const nfc = tagUrl(s, t.slug, 'nfc');
  const qr = tagUrl(s, t.slug, 'qr');
  const local = `${new URL(c.req.url).origin}/${t.slug}`;
  const company = companyName(s);
  const message = extra.newLink
    ? `${company} review app: choose your password here (works once, for ${INVITE_HOURS / 24} days): ${extra.newLink} . Your username is ${t.slug}.`
    : '';
  const sms = extra.newLink && t.phone ? `sms:${t.phone.replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(message)}` : null;
  const mail = extra.newLink && t.email
    ? `mailto:${encodeURIComponent(t.email)}?subject=${encodeURIComponent(`Your ${company} review app`)}&body=${encodeURIComponent(message)}`
    : null;
  const waiting = !!t.invite_expires_at && t.invite_expires_at > now();

  return page(c, {
    title: t.name,
    active: 'team',
    lede: <>{t.role}{t.active ? '' : ' · inactive'}</>,
    actions: (
      <>
        <a class="btn btn--ghost btn--sm" href={local} target="_blank" rel="noopener"><Icon name="external" size={16} /> Open their page</a>
        <a class="btn btn--ghost btn--sm" href={`/admin/team/${t.id}/card`} target="_blank" rel="noopener"><Icon name="print" size={16} /> Print card</a>
      </>
    ),
  }, (
    <div class="stack-lg">
      <section class="kpis">
        <Stat label="Reviews this month" value={mRow?.reviews ?? 0} sub={mRow?.five_star ? `${mRow.five_star} five-star` : undefined} />
        <Stat label="All-time reviews" value={aRow?.reviews ?? 0} sub={aRow?.avg_rating ? `${avg1(aRow.avg_rating)}★ average` : undefined} />
        <Stat label="Taps this month" value={mRow?.taps ?? 0} sub={mRow?.clicks ? `${pct(mRow.converted, mRow.clicks)} of clicks became reviews` : undefined} />
        <Stat label="Points balance" value={balance} />
      </section>

      {extra.newLink && (
        <section class="card card--highlight" aria-live="polite">
          <h2 class="h-sm">{t.password_hash ? `Password reset link for ${t.first_name}` : `App invite for ${t.first_name}`}</h2>
          <p class="small muted">
            Shown once. It works one time and expires in {INVITE_HOURS / 24} days; any older link stopped working just now.
            {' '}{t.first_name} opens it on their phone, chooses a password, and signs in with the username <strong>{t.slug}</strong>.
          </p>
          <div class="linkshare">
            <div class="qr-inline" dangerouslySetInnerHTML={{ __html: qrSvg(extra.newLink, { size: 168, border: 2 }) }} />
            <div class="stack-sm">
              <code class="breakall">{extra.newLink}</code>
              <div class="cluster">
                <button type="button" class="btn btn--ghost btn--sm" data-copy={extra.newLink}><Icon name="copy" size={16} /> Copy</button>
                {sms && <a class="btn btn--green btn--sm" href={sms}><Icon name="message" size={16} /> Text to {t.phone}</a>}
                {mail && <a class="btn btn--ghost btn--sm" href={mail}><Icon name="mail" size={16} /> Email</a>}
              </div>
            </div>
          </div>
        </section>
      )}

      <div class="detail-grid">
        <section class="card">
          <h2 class="h-sm">Tag setup</h2>
          <div class="linkshare">
            <div class="qr-inline" dangerouslySetInnerHTML={{ __html: qrSvg(qr, { size: 148, border: 2 }) }} />
            <div class="stack-sm">
              <div><span class="small dim">Write this to the NFC tag</span><div class="copyline"><code>{nfc}</code><button type="button" class="linkbtn small" data-copy={nfc}>Copy</button></div></div>
              <div><span class="small dim">QR code link</span><div class="copyline"><code>{qr}</code><button type="button" class="linkbtn small" data-copy={qr}>Copy</button></div></div>
              <div class="cluster">
                <a class="btn btn--ghost btn--sm" href={`/admin/team/${t.id}/qr.svg`}><Icon name="download" size={16} /> QR as SVG</a>
                <a class="btn btn--ghost btn--sm" href={`/admin/team/${t.id}/card`} target="_blank" rel="noopener"><Icon name="print" size={16} /> Printable card</a>
              </div>
            </div>
          </div>
          <details class="howto">
            <summary>How to write and lock an NFC tag</summary>
            <ol>
              <li>Install an NFC writing app such as <strong>NFC Tools</strong> (free, iPhone or Android).</li>
              <li>Write → Add a record → URL/URI → paste the NFC link above.</li>
              <li>Tap <strong>Write</strong> and hold the tag to the top of the phone.</li>
              <li>Test it: tap the tag with a phone that isn't signed in to this app.</li>
              <li>Lock the tag (in NFC Tools: Other → Lock tag). Locking is permanent and stops anyone rewriting it.</li>
            </ol>
            <p class="small dim">NTAG213 or NTAG215 stickers and cards work well.</p>
          </details>
        </section>

        <section class="card">
          <h2 class="h-sm">Their phone app</h2>
          <p class="small muted">
            {t.first_name} signs in at <code>/me/login</code> with their own password to see their reviews, rank, QR code and points.
            They can't see the office dashboard or anyone else's details.
          </p>
          <dl class="facts small">
            <div><dt>Username</dt><dd><code>{t.slug}</code>{(t.email || t.phone) && <span class="dim"> (or their {[t.email && 'email', t.phone && 'mobile'].filter(Boolean).join(' or ')})</span>}</dd></div>
            <div><dt>Login</dt><dd><LoginChip t={{ has_login: !!t.password_hash, invite_expires_at: t.invite_expires_at }} />{waiting && <span class="dim"> · invite expires {fmtDateTime(t.invite_expires_at!, s.timezone)}</span>}</dd></div>
            <div><dt>Signed in on</dt><dd>{devices ? `${devices} device${devices === 1 ? '' : 's'}` : 'No devices'}{lastSeen ? <span class="dim"> · last used {relTime(lastSeen, s.timezone)}</span> : null}</dd></div>
          </dl>
          <div class="cluster">
            <form method="post" action={`/admin/team/${t.id}/invite`} data-confirm={waiting ? `Make a new link? The invite you sent ${t.first_name} earlier will stop working.` : undefined}>
              <button class="btn btn--red btn--sm" type="submit" disabled={!t.active}>
                {t.password_hash ? 'Make a password reset link' : waiting ? 'Make a new invite link' : 'Make an invite link'}
              </button>
            </form>
            {devices > 0 && (
              <form method="post" action={`/admin/team/${t.id}/signout`} data-confirm={`Sign ${t.first_name} out on every phone? They'll need their password to get back in.`}>
                <button class="btn btn--ghost btn--sm" type="submit">Sign out all devices</button>
              </form>
            )}
          </div>
        </section>
      </div>

      <section class="card">
        <div class="row-between"><h2 class="h-sm">Reviews credited to {t.first_name}</h2><a class="small" href={`/admin/reviews?f=all&tech=${t.id}`}>All</a></div>
        {reviews.length
          ? <div class="stack-md">{reviews.map((r) => <ReviewCard r={r} tz={s.timezone} credits={credits.get(r.id)} href={`/admin/reviews/${r.id}`} clamp />)}</div>
          : <Empty title="No reviews credited yet" />}
      </section>

      <section class="card">
        <h2 class="h-sm">Recent tag visits</h2>
        {taps.length ? (
          <div class="tbl-wrap">
            <table class="tbl">
              <thead><tr><th scope="col">When</th><th scope="col">How</th><th scope="col">Customer</th><th scope="col">Rating</th><th scope="col">Went to</th><th scope="col">Review</th></tr></thead>
              <tbody>{taps.map((p) => (
                <tr>
                  <td class="nowrap">{fmtDateTime(p.created_at, s.timezone)}</td>
                  <td>{SOURCE_LABEL[p.source] ?? p.source}</td>
                  <td>{p.customer_name ?? <span class="dim">Didn't finish</span>}{p.comment && <p class="small muted line-clamp">{p.comment}</p>}</td>
                  <td>{p.rating ? <Stars rating={p.rating} size={12} /> : <span class="dim">—</span>}</td>
                  <td>{p.site ? platformLabel(p.site) : <span class="dim">—</span>}</td>
                  <td>{p.review_id ? <a href={`/admin/reviews/${p.review_id}`}>Matched</a> : <span class="dim">—</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p class="muted small">No taps yet.</p>}
      </section>

      <section class="card" id="points">
        <h2 class="h-sm">Points</h2>
        <form method="post" action={`/admin/team/${t.id}/points`} class="inline-form">
          <label class="sr-only" for="pts">Points</label><input id="pts" name="amount" type="number" min={-10000} max={10000} step={1} placeholder="+25 or -10" required class="w-sm" />
          <label class="sr-only" for="reason">Reason</label><input id="reason" name="reason" maxlength={120} placeholder="Reason (shown to the tech)" />
          <button class="btn btn--ghost btn--sm" type="submit">Add</button>
        </form>
        {ledger.length > 0 && (
          <ul class="plain ledger" role="list">
            {ledger.map((l) => <li class="row-between"><span>{l.reason} <span class="dim small">· {fmtDate(l.created_at, s.timezone)}{l.created_by ? ` · ${l.created_by}` : ''}</span></span><span class={`tnum ${l.amount > 0 ? 'pos' : 'dim'}`}>{l.amount > 0 ? `+${l.amount}` : l.amount}</span></li>)}
          </ul>
        )}
      </section>

      <section id="edit">
        <h2 class="h-sm">Edit {t.first_name}</h2>
        <TechForm t={extra.editValues ?? t} error={extra.editError} action={`/admin/team/${t.id}`} locations={c.get('settings').locations} />
      </section>
    </div>
  ), extra.editError ? 422 : 200);
}

// ---------- printables ----------

team.get('/:id/qr.svg', async (c) => {
  const t = await one<Tech>(c.env.DB, `SELECT slug FROM techs WHERE id = ?`, c.req.param('id'));
  if (!t) return c.notFound();
  return c.body(qrSvg(tagUrl(c.get('settings'), t.slug, 'qr'), { size: 1024, border: 4 }), 200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'content-disposition': `attachment; filename="review-${t.slug}.svg"`,
  });
});

team.get('/:id/card', async (c) => {
  const t = await one<Tech>(c.env.DB, `SELECT * FROM techs WHERE id = ?`, c.req.param('id'));
  if (!t) return c.notFound();
  const s = c.get('settings');
  const qr = tagUrl(s, t.slug, 'qr');
  const short = tagUrl(s, t.slug, 'link').replace(/^https?:\/\//, '');
  return render(c, (
    <Doc title={`Review card · ${t.name}`} bodyClass="print">
      <main id="main" class="print__sheet">
        <div class="print__help no-print">
          <p><strong>Print at 100% (not "fit to page").</strong> Top: business-card size (3.5 × 2 in) for NFC cards. Bottom: 2 in square sticker for the back of a phone or a tablet.</p>
          <button class="btn btn--red btn--sm" type="button" data-print><Icon name="print" size={16} /> Print</button>
        </div>
        <div class="bizcard">
          <div class="bizcard__left">
            {s.brand.logo
              ? <img class="bizcard__logo" src={`/asset/logo?v=${s.brand.version}`} alt={companyName(s)} />
              : <p class="bizcard__name">{companyName(s)}</p>}
            <p class="bizcard__ask">How did {t.first_name} do?</p>
            <p class="bizcard__how">Tap your phone here or scan the code</p>
            <p class="bizcard__url">{short}</p>
          </div>
          <div class="bizcard__qr" dangerouslySetInnerHTML={{ __html: qrSvg(qr, { size: 150, border: 2 }) }} />
        </div>
        <div class="sticker">
          <div class="sticker__qr" dangerouslySetInnerHTML={{ __html: qrSvg(qr, { size: 110, border: 2 }) }} />
          <p class="sticker__ask">Rate {t.first_name}</p>
          <p class="sticker__how">Tap or scan</p>
        </div>
      </main>
    </Doc>
  ));
});

export default team;

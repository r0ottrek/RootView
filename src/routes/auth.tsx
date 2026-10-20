/** First-run setup, office sign-in (with optional two-step codes), and office manager invites. */
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import {
  clientKey, currentAdmin, endSession, hashPassword, needsRehash, overLimit, passwordProblem, sameSecret, sessionFor, startSession,
  familiar, signedIn, verifyAgainstNobody, verifyPassword, whoKey,
} from '../lib/auth';
import { open } from '../lib/crypto';
import { one, run, scalar } from '../lib/db';
import { companyName, saveSettings } from '../lib/settings';
import { verifyTotp } from '../lib/totp';
import { HOUR, MINUTE, line, newId, now, sha256hex, str } from '../lib/util';
import { Brand, Doc, render, useSettings } from '../views/layout';

const auth = new Hono<AppEnv>();

const safeNext = (n: string | undefined) => (n && /^\/admin(\/|$|\?)/.test(n) ? n : '/admin');
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function Card({ title, children }: { title: string; children?: unknown }) {
  const s = useSettings();
  return (
    <Doc title={`${title} · ${companyName(s)}`} bodyClass="pub pub--auth">
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

// ---------- first owner ----------

/** A setup key someone could guess (or the placeholder from the example file) is refused. */
const weakSetupKey = (k: string) => k.length < 16 || new Set(k).size < 8 || /change[-_ ]?me/i.test(k);

function setupProblem(c: Context<AppEnv>): string | null {
  if (!c.env.SETUP_KEY) return 'Set SETUP_KEY on the server first (see the README).';
  if (weakSetupKey(c.env.SETUP_KEY)) return 'SETUP_KEY is too short or still the example value. Use at least 16 random characters, then redeploy.';
  return null;
}

auth.get('/setup', async (c) => {
  if (await scalar(c.env.DB, `SELECT COUNT(*) FROM admins`)) return c.redirect('/admin/login', 303);
  return render(c, <SetupForm problem={setupProblem(c)} />);
});

auth.post('/setup', async (c) => {
  if (await scalar(c.env.DB, `SELECT COUNT(*) FROM admins`)) return c.redirect('/admin/login', 303);
  if (await overLimit(c.env.DB, `setup:${await clientKey(c)}`, 10, 15 * MINUTE)) {
    return render(c, <SetupForm problem={setupProblem(c)} error="Too many tries. Wait 15 minutes." />, 429);
  }
  const b = await c.req.parseBody();
  const key = str(b.key, 200);
  const company = line(b.company, 80);
  const name = line(b.name, 80);
  const email = str(b.email, 120).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const tz = str(b.tz, 60);
  const err = setupProblem(c)
    ?? (!(await sameSecret(key, c.env.SETUP_KEY!)) ? 'That setup key is wrong.'
      : company.length < 2 ? 'Add your business name.'
      : name.length < 2 ? 'Add your name.'
      : !EMAIL.test(email) ? 'Add a valid email.'
      : passwordProblem(password));
  if (err) return render(c, <SetupForm problem={setupProblem(c)} error={err} company={company} name={name} email={email} />, 422);
  const id = newId('adm');
  // Only ever creates the first owner, even if two people submit at the same moment.
  const res = await run(c.env.DB,
    `INSERT INTO admins (id, name, email, password_hash, role, created_at) SELECT ?, ?, ?, ?, 'owner', ? WHERE NOT EXISTS (SELECT 1 FROM admins)`,
    id, name, email, await hashPassword(password, c.env), now());
  if (!res.meta.changes) return c.redirect('/admin/login', 303);
  const patch: Record<string, unknown> = { tracking_start: now(), company_name: company, public_base_url: new URL(c.req.url).origin };
  if (tz && Intl.supportedValuesOf('timeZone').includes(tz)) patch.timezone = tz;
  await saveSettings(c.env.DB, patch);
  await startSession(c, 'admin', id);
  return c.redirect(`/admin/branding?ok=${encodeURIComponent('Account created. Next: add your logo and colors, then your review links under Settings.')}`, 303);
});

function SetupForm(p: { problem: string | null; error?: string; company?: string; name?: string; email?: string }) {
  return (
    <Card title="Set up review tracking">
      <p class="muted">Create the owner account. You can add office managers and technicians afterwards.</p>
      {p.problem && <p class="flash flash--err">{p.problem}</p>}
      {p.error && <p class="flash flash--err" role="alert">{p.error}</p>}
      <form method="post" class="stack-md" data-tz-form>
        <input type="hidden" name="tz" value="" data-tz />
        <div class="field"><label for="key">Setup key</label><input id="key" name="key" type="password" required autocomplete="off" /><p class="hint">The SETUP_KEY value you set when deploying.</p></div>
        <div class="field"><label for="company">Business name</label><input id="company" name="company" required maxlength={80} autocomplete="organization" value={p.company ?? ''} /></div>
        <div class="field"><label for="name">Your name</label><input id="name" name="name" required maxlength={80} autocomplete="name" value={p.name ?? ''} /></div>
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required maxlength={120} autocomplete="email" value={p.email ?? ''} /></div>
        <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required minlength={10} maxlength={200} autocomplete="new-password" /><p class="hint">At least 10 characters.</p></div>
        <button class="btn btn--red btn--lg btn--block" type="submit">Create account</button>
      </form>
    </Card>
  );
}

// ---------- sign in ----------

auth.get('/admin/login', async (c) => {
  if (!(await scalar(c.env.DB, `SELECT COUNT(*) FROM admins`))) return c.redirect('/setup', 303);
  if (await currentAdmin(c)) return c.redirect(safeNext(c.req.query('next')), 303);
  return render(c, <LoginForm next={safeNext(c.req.query('next'))} />);
});

auth.post('/admin/login', async (c) => {
  const b = await c.req.parseBody();
  const email = str(b.email, 120).toLowerCase();
  const password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  const next = safeNext(str(b.next, 300));
  const ip = await clientKey(c);
  const who = await whoKey(email);
  // Counted before checking, so parallel guesses can't slip past. Per connection first (so a flood stops writing
  // rows once it's blocked), then per email + connection, so a stranger guessing elsewhere can't lock the owner out.
  if ((await overLimit(c.env.DB, `login:ip:${ip}`, 30, 15 * MINUTE)) || (await overLimit(c.env.DB, `login:${who}:${ip}`, 8, 15 * MINUTE))) {
    return render(c, <LoginForm next={next} email={email} error="Too many attempts. Wait 15 minutes and try again." />, 429);
  }
  // A looser cap per email across every other connection, so guessing from many addresses at once still runs out.
  // Connections this account signed in from recently aren't counted, so nobody can lock the owner out of their own.
  if (!(await familiar(c.env.DB, `login:${who}:${ip}`)) && (await overLimit(c.env.DB, `login:acct:${who}`, 40, HOUR))) {
    return render(c, <LoginForm next={next} email={email} error="Too many attempts on this account. Wait an hour and try again." />, 429);
  }
  const admin = await one<{ id: string; password_hash: string | null; totp_enabled: number }>(c.env.DB,
    `SELECT id, password_hash, totp_enabled FROM admins WHERE email = ?`, email);
  // Same amount of work whether or not the email exists, so response times don't reveal who has an account.
  const ok = admin?.password_hash ? await verifyPassword(password, admin.password_hash) : await verifyAgainstNobody(password, c.env);
  if (!ok || !admin?.password_hash) return render(c, <LoginForm next={next} email={email} error="Email or password is wrong." />, 422);
  await signedIn(c.env.DB, [`login:${who}:${ip}`, `login:acct:${who}`], `login:${who}:${ip}`);
  if (needsRehash(admin.password_hash, c.env)) {
    await run(c.env.DB, `UPDATE admins SET password_hash = ? WHERE id = ?`, await hashPassword(password, c.env), admin.id);
  }
  if (admin.totp_enabled) {
    await startSession(c, 'mfa', admin.id);
    return c.redirect(`/admin/login/code?next=${encodeURIComponent(next)}`, 303);
  }
  await run(c.env.DB, `UPDATE admins SET last_login_at = ? WHERE id = ?`, now(), admin.id);
  await startSession(c, 'admin', admin.id);
  return c.redirect(next, 303);
});

function LoginForm(p: { next: string; email?: string; error?: string }) {
  return (
    <Card title="Office sign in">
      {p.error && <p class="flash flash--err" role="alert">{p.error}</p>}
      <form method="post" action="/admin/login" class="stack-md">
        <input type="hidden" name="next" value={p.next} />
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="username" value={p.email ?? ''} /></div>
        <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password" /></div>
        <button class="btn btn--red btn--lg btn--block" type="submit">Sign in</button>
      </form>
      <p class="fine">Technician? Sign in at <a href="/me/login">the tech app</a> instead.</p>
    </Card>
  );
}

// ---------- two-step code ----------

function CodeForm(p: { next: string; error?: string }) {
  return (
    <Card title="Enter your code">
      <p class="muted">Open your authenticator app and enter the 6-digit code for this site.</p>
      {p.error && <p class="flash flash--err" role="alert">{p.error}</p>}
      <form method="post" action="/admin/login/code" class="stack-md">
        <input type="hidden" name="next" value={p.next} />
        <div class="field"><label for="code">6-digit code</label><input id="code" name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength={7} required autocomplete="one-time-code" autofocus /></div>
        <button class="btn btn--red btn--lg btn--block" type="submit">Verify</button>
      </form>
      <p class="fine">Lost your phone? An owner can turn two-step sign-in off for you under Settings → Office logins. The README explains how to recover the last owner account.</p>
    </Card>
  );
}

auth.get('/admin/login/code', async (c) => {
  if (!(await sessionFor(c, 'mfa'))) return c.redirect('/admin/login', 303);
  return render(c, <CodeForm next={safeNext(c.req.query('next'))} />);
});

auth.post('/admin/login/code', async (c) => {
  const pending = await sessionFor(c, 'mfa');
  if (!pending) return c.redirect('/admin/login', 303);
  const b = await c.req.parseBody();
  const next = safeNext(str(b.next, 300));
  // Five tries per sign-in and ten per account every 15 minutes, so a 6-digit code can't be guessed.
  if ((await overLimit(c.env.DB, `mfa:${pending.id}`, 5, 15 * MINUTE)) || (await overLimit(c.env.DB, `mfa:acct:${pending.subject_id}`, 10, 15 * MINUTE))) {
    await endSession(c, 'mfa');
    return c.redirect(`/admin/login?next=${encodeURIComponent(next)}`, 303);
  }
  const admin = await one<{ id: string; totp_secret: string | null; totp_last_step: number | null }>(c.env.DB,
    `SELECT id, totp_secret, totp_last_step FROM admins WHERE id = ? AND totp_enabled = 1`, pending.subject_id);
  const step = admin?.totp_secret ? await verifyTotp(await open(c.env, admin.totp_secret), str(b.code, 10), now(), admin.totp_last_step ?? -1) : null;
  if (!admin || step == null) return render(c, <CodeForm next={next} error="That code didn't work. Codes change every 30 seconds." />, 422);
  // Record the step so the same code can't be replayed, even within its 30 seconds.
  const used = await run(c.env.DB,
    `UPDATE admins SET totp_last_step = ?, last_login_at = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`,
    step, now(), admin.id, step);
  if (!used.meta.changes) return render(c, <CodeForm next={next} error="That code was already used. Wait for the next one." />, 422);
  await endSession(c, 'mfa');
  await startSession(c, 'admin', admin.id);
  return c.redirect(next, 303);
});

// ---------- office manager invites ----------

async function invitedAdmin(c: Context<AppEnv>) {
  const token = c.req.param('token') ?? '';
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  return one<{ id: string; name: string; email: string }>(c.env.DB,
    `SELECT id, name, email FROM admins WHERE invite_hash = ? AND invite_expires_at > ?`, await sha256hex(token), now());
}

function AdminInviteForm({ who, error }: { who: { name: string; email: string }; error?: string }) {
  return (
    <Card title={`Welcome, ${who.name.split(' ')[0]}`}>
      <p class="muted">Choose a password for the office dashboard. You'll sign in with <strong>{who.email}</strong>.</p>
      {error && <p class="flash flash--err" role="alert">{error}</p>}
      <form method="post" class="stack-md">
        <input type="hidden" name="username" value={who.email} autocomplete="username" />
        <div class="field"><label for="password">New password</label><input id="password" name="password" type="password" required minlength={10} maxlength={200} autocomplete="new-password" /></div>
        <div class="field"><label for="confirm">Type it again</label><input id="confirm" name="confirm" type="password" required minlength={10} maxlength={200} autocomplete="new-password" /></div>
        <button class="btn btn--red btn--lg btn--block" type="submit">Save and sign in</button>
      </form>
    </Card>
  );
}

const AdminInviteGone = () => (
  <Card title="That invite has expired">
    <p class="muted">Invite links work once and expire after 72 hours. Ask an owner for a new one.</p>
    <a class="btn btn--ghost btn--block" href="/admin/login">Go to sign in</a>
  </Card>
);

auth.get('/admin/invite/:token', async (c) => {
  const who = await invitedAdmin(c);
  return who ? render(c, <AdminInviteForm who={who} />) : render(c, <AdminInviteGone />, 404);
});

auth.post('/admin/invite/:token', async (c) => {
  if (await overLimit(c.env.DB, `invite:${await clientKey(c)}`, 20, 15 * MINUTE)) return render(c, <AdminInviteGone />, 429);
  const who = await invitedAdmin(c);
  if (!who) return render(c, <AdminInviteGone />, 404);
  const b = await c.req.parseBody();
  const pw = typeof b.password === 'string' ? b.password : '';
  const problem = passwordProblem(pw) ?? (pw !== b.confirm ? "The two passwords don't match." : null);
  if (problem) return render(c, <AdminInviteForm who={who} error={problem} />, 422);
  // Only the request that actually uses up the invite gets in (two at once with the same link: one wins).
  const used = await run(c.env.DB,
    `UPDATE admins SET password_hash = ?, invite_hash = NULL, invite_expires_at = NULL, last_login_at = ? WHERE id = ? AND invite_hash = ?`,
    await hashPassword(pw, c.env), now(), who.id, await sha256hex(c.req.param('token') ?? ''));
  if (!used.meta.changes) return render(c, <AdminInviteGone />, 404);
  await run(c.env.DB, `DELETE FROM sessions WHERE kind IN ('admin', 'mfa') AND subject_id = ?`, who.id);
  await startSession(c, 'admin', who.id);
  return c.redirect('/admin', 303);
});

auth.post('/admin/logout', async (c) => {
  await endSession(c, 'admin');
  return c.redirect('/admin/login', 303);
});

export default auth;

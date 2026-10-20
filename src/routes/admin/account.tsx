/** Admin → Your account: password, two-step sign-in (authenticator app) and signed-in devices. Every office login has one. */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { audit } from '../../lib/audit';
import { hashPassword, overLimit, passwordProblem, revokeSessions, verifyPassword } from '../../lib/auth';
import { open, seal } from '../../lib/crypto';
import { all, one, run } from '../../lib/db';
import { qrSvg } from '../../lib/qr';
import { companyName } from '../../lib/settings';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../../lib/totp';
import { MINUTE, fmtDateTime, now, relTime, str } from '../../lib/util';
import { back } from '../../views/layout';
import { Chip, Icon } from '../../views/ui';
import { page, type Ctx } from './common';

const account = new Hono<AppEnv>();

interface Me { password_hash: string | null; totp_enabled: number; totp_secret: string | null }
const loadMe = (c: Ctx) => one<Me>(c.env.DB, `SELECT password_hash, totp_enabled, totp_secret FROM admins WHERE id = ?`, c.get('admin').id);

/** Groups of four so the key is easy to type into an authenticator app by hand. */
const spaced = (k: string) => k.match(/.{1,4}/g)?.join(' ') ?? k;

async function accountPage(c: Ctx, setup?: { secret: string; error?: string }) {
  const a = c.get('admin');
  const s = c.get('settings');
  const [me, devices] = await Promise.all([
    loadMe(c),
    all<{ id: string; label: string | null; created_at: number; last_seen_at: number | null }>(c.env.DB,
      `SELECT id, label, created_at, last_seen_at FROM sessions WHERE kind = 'admin' AND subject_id = ? AND expires_at > ? ORDER BY COALESCE(last_seen_at, created_at) DESC`, a.id, now()),
  ]);
  const thisOne = c.get('sessionId');
  const uri = setup ? otpauthUrl(setup.secret, a.email, companyName(s) || 'RootView') : '';
  return page(c, { title: 'Your account', active: 'account', lede: <>{a.name} · {a.email} · {a.role === 'owner' ? 'Owner' : 'Office manager'}</> }, (
    <div class="stack-lg">
      <section class="card" id="2fa">
        <div class="row-between">
          <h2 class="h-sm">Two-step sign-in</h2>
          {me?.totp_enabled ? <Chip tone="green">On</Chip> : <Chip tone="muted">Off</Chip>}
        </div>
        {me?.totp_enabled ? (
          <>
            <p class="small muted">Signing in asks for a 6-digit code from your authenticator app as well as your password.</p>
            <form method="post" action="/admin/account/2fa/disable" class="inline-form mt-sm" data-confirm="Turn off two-step sign-in? Your account will be protected by your password only.">
              <label class="sr-only" for="dpw">Your password</label><input id="dpw" name="password" type="password" required autocomplete="current-password" placeholder="Your password" />
              <button class="btn btn--ghost btn--sm" type="submit">Turn off</button>
            </form>
          </>
        ) : setup ? (
          <div class="stack-md">
            <p class="small muted">1. Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) and scan this code, or type the key.</p>
            <div class="linkshare">
              <div class="qr-inline" dangerouslySetInnerHTML={{ __html: qrSvg(uri, { size: 176, border: 2 }) }} />
              <div class="stack-sm">
                <span class="small dim">Key</span>
                <code class="breakall mono">{spaced(setup.secret)}</code>
                <button type="button" class="linkbtn small" data-copy={setup.secret}>Copy key</button>
              </div>
            </div>
            <p class="small muted">2. Enter the 6-digit code it shows to finish.</p>
            {setup.error && <p class="flash flash--err" role="alert">{setup.error}</p>}
            <form method="post" action="/admin/account/2fa/confirm" class="inline-form">
              <label class="sr-only" for="tc">6-digit code</label>
              <input id="tc" name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength={7} required autocomplete="one-time-code" class="w-sm" placeholder="123456" />
              <button class="btn btn--red btn--sm" type="submit">Turn on</button>
            </form>
            {!c.env.ENCRYPTION_KEY && <p class="small dim"><Icon name="lock" size={14} /> For whoever runs this site: set ENCRYPTION_KEY so these keys are stored encrypted.</p>}
          </div>
        ) : (
          <>
            <p class="small muted">Add a code from your phone to every sign-in, so a leaked or guessed password isn't enough to get in. Recommended for every owner.</p>
            <form method="post" action="/admin/account/2fa/start" class="mt-sm"><button class="btn btn--red btn--sm" type="submit"><Icon name="shield" size={16} /> Set up two-step sign-in</button></form>
          </>
        )}
      </section>

      <section class="card" id="password">
        <h2 class="h-sm">Password</h2>
        <form method="post" action="/admin/account/password" class="form-grid">
          <input type="hidden" name="username" value={a.email} autocomplete="username" />
          <div class="field"><label for="cur">Current password</label><input id="cur" name="current" type="password" required autocomplete="current-password" /></div>
          <div class="field"><label for="npw">New password</label><input id="npw" name="password" type="password" required minlength={10} maxlength={200} autocomplete="new-password" /><p class="hint">At least 10 characters. Other devices are signed out when you change it.</p></div>
          <div class="field"><label for="cpw">Type it again</label><input id="cpw" name="confirm" type="password" required minlength={10} maxlength={200} autocomplete="new-password" /></div>
          <div class="form-actions field--wide"><button class="btn btn--ghost btn--sm" type="submit">Change password</button></div>
        </form>
      </section>

      <section class="card" id="devices">
        <h2 class="h-sm">Signed-in devices</h2>
        <ul class="plain user-list" role="list">
          {devices.map((d) => (
            <li class="row-between">
              <span><strong>{d.label ?? 'Unknown device'}</strong>{d.id === thisOne && <> <Chip tone="green">This device</Chip></>}
                <span class="dim small block">Signed in {fmtDateTime(d.created_at, s.timezone)}{d.last_seen_at ? ` · last used ${relTime(d.last_seen_at, s.timezone)}` : ''}</span></span>
            </li>
          ))}
        </ul>
        {devices.length > 1 && (
          <form method="post" action="/admin/account/signout-others" class="mt-sm" data-confirm="Sign out every other device?">
            <button class="btn btn--ghost btn--sm" type="submit">Sign out other devices</button>
          </form>
        )}
      </section>
    </div>
  ), setup?.error ? 422 : 200);
}

account.get('/', (c) => accountPage(c));

account.post('/password', async (c) => {
  const a = c.get('admin');
  if (await overLimit(c.env.DB, `admin-pw:${a.id}`, 8, 15 * MINUTE)) return c.redirect(back('/admin/account', { err: 'Too many tries. Wait 15 minutes.' }) + '#password', 303);
  const b = await c.req.parseBody();
  const me = await loadMe(c);
  const current = typeof b.current === 'string' ? b.current.slice(0, 200) : '';
  const next = typeof b.password === 'string' ? b.password : '';
  if (!me?.password_hash || !(await verifyPassword(current, me.password_hash))) return c.redirect(back('/admin/account', { err: 'Current password is wrong.' }) + '#password', 303);
  const problem = passwordProblem(next) ?? (next !== b.confirm ? "The two new passwords don't match." : null);
  if (problem) return c.redirect(back('/admin/account', { err: problem }) + '#password', 303);
  await run(c.env.DB, `UPDATE admins SET password_hash = ? WHERE id = ?`, await hashPassword(next, c.env), a.id);
  await revokeSessions(c.env.DB, 'admin', a.id, c.get('sessionId'));
  await audit(c, 'account.password');
  return c.redirect(back('/admin/account', { ok: 'Password changed. Other devices were signed out.' }) + '#password', 303);
});

account.post('/signout-others', async (c) => {
  await revokeSessions(c.env.DB, 'admin', c.get('admin').id, c.get('sessionId'));
  await audit(c, 'account.signout_others');
  return c.redirect(back('/admin/account', { ok: 'Other devices signed out.' }) + '#devices', 303);
});

/** A fresh key, stored but not switched on until a code from it is entered, so a half-finished setup can't lock anyone out. */
account.post('/2fa/start', async (c) => {
  const me = await loadMe(c);
  if (me?.totp_enabled) return c.redirect('/admin/account#2fa', 303);
  const secret = newTotpSecret();
  await run(c.env.DB, `UPDATE admins SET totp_secret = ?, totp_last_step = NULL WHERE id = ? AND totp_enabled = 0`, await seal(c.env, secret), c.get('admin').id);
  return accountPage(c, { secret });
});

account.post('/2fa/confirm', async (c) => {
  const a = c.get('admin');
  const me = await loadMe(c);
  if (!me || me.totp_enabled || !me.totp_secret) return c.redirect('/admin/account#2fa', 303);
  const secret = await open(c.env, me.totp_secret);
  if (await overLimit(c.env.DB, `mfa-setup:${a.id}`, 10, 15 * MINUTE)) return accountPage(c, { secret, error: 'Too many tries. Wait 15 minutes.' });
  const step = await verifyTotp(secret, str((await c.req.parseBody()).code, 10), now());
  if (step == null) return accountPage(c, { secret, error: "That code didn't match. Check your phone's clock is set automatically, then try the newest code." });
  await run(c.env.DB, `UPDATE admins SET totp_enabled = 1, totp_last_step = ? WHERE id = ?`, step, a.id);
  // Anyone who had the password alone shouldn't stay signed in elsewhere.
  await revokeSessions(c.env.DB, 'admin', a.id, c.get('sessionId'));
  await audit(c, 'account.2fa_on');
  return c.redirect(back('/admin/account', { ok: 'Two-step sign-in is on. Other devices were signed out.' }) + '#2fa', 303);
});

account.post('/2fa/disable', async (c) => {
  const a = c.get('admin');
  if (await overLimit(c.env.DB, `admin-pw:${a.id}`, 8, 15 * MINUTE)) return c.redirect(back('/admin/account', { err: 'Too many tries. Wait 15 minutes.' }) + '#2fa', 303);
  const b = await c.req.parseBody();
  const me = await loadMe(c);
  const pw = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  if (!me?.password_hash || !(await verifyPassword(pw, me.password_hash))) return c.redirect(back('/admin/account', { err: 'That password is wrong.' }) + '#2fa', 303);
  await run(c.env.DB, `UPDATE admins SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?`, a.id);
  await audit(c, 'account.2fa_off');
  return c.redirect(back('/admin/account', { ok: 'Two-step sign-in is off.' }) + '#2fa', 303);
});

export default account;

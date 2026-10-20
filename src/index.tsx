/**
 * RootView: NFC/QR review tracking for field-service teams.
 *
 *   /<tech>        customer rates the visit (NFC tag / QR / texted link)
 *   /me            the tech's own app (separate login)
 *   /admin         the office dashboard
 *
 * Cloudflare Pages (advanced mode, see scripts/build-pages.mjs) + D1. Every 15 minutes cron/index.js calls
 * POST /api/cron, which pulls new Google reviews and matches them to techs.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, Env } from './env';
import { serveAsset } from './lib/assets';
import { requireAdmin, sameOrigin, sameSecret } from './lib/auth';
import { runScheduled } from './lib/reviews';
import { companyName, getSettings } from './lib/settings';
import { themeCss } from './lib/theme';
import account from './routes/admin/account';
import branding from './routes/admin/branding';
import dash from './routes/admin/dashboard';
import other from './routes/admin/other';
import rev from './routes/admin/reviews';
import team from './routes/admin/team';
import auth from './routes/auth';
import pub from './routes/public';
import me from './routes/tech';

const app = new Hono<AppEnv>();

/**
 * Only this site's own scripts and styles run. Inline style attributes are allowed (a few elements size
 * themselves with a CSS variable); inline <style>/<script> blocks are not. Reviewer avatars come from Google.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "style-src-elem 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "manifest-src 'self'",
  "worker-src 'self'",
].join('; ');

app.use('*', async (c, next) => {
  c.set('settings', await getSettings(c.env.DB));
  await next();
  if (!c.res.headers.has('content-security-policy')) c.header('Content-Security-Policy', CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (/^\/(admin|me|invite|setup)(\/|$)/.test(c.req.path) || /\/share$/.test(c.req.path)) c.header('Cache-Control', 'private, no-store');
});

// Request size caps: forms are small; only photo and brand uploads carry images.
app.use('*', (c, next) => {
  const max = c.req.path.startsWith('/admin/branding') ? 2_500_000 : c.req.path.startsWith('/admin/team') ? 600_000 : 32_000;
  return bodyLimit({ maxSize: max, onError: (cx) => cx.text('That upload is too large.', 413) })(c, next);
});

// CSRF: every POST must come from this site (the cron endpoint is exempt and checks its own secret).
app.use('*', sameOrigin);

// ---------- theme and brand files (generated from Admin → Branding) ----------

app.get('/theme.css', (c) => c.body(themeCss(c.get('settings').theme), 200, {
  'content-type': 'text/css; charset=utf-8',
  'cache-control': c.req.query('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
}));

app.get('/manifest.webmanifest', (c) => {
  const s = c.get('settings');
  const v = s.brand.version;
  return c.json({
    name: companyName(s),
    short_name: companyName(s).slice(0, 12),
    description: 'Your reviews, rank, QR code and points.',
    start_url: '/me',
    scope: '/',
    display: 'standalone',
    background_color: s.theme.bg,
    theme_color: s.theme.bg,
    icons: [
      { src: `/asset/icon-192.png?v=${v}`, sizes: '192x192', type: 'image/png' },
      { src: `/asset/icon-512.png?v=${v}`, sizes: '512x512', type: 'image/png' },
    ],
  }, 200, { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=300' });
});

app.get('/favicon.ico', (c) => serveAsset(c, 'icon-32'));
app.get('/apple-touch-icon.png', (c) => serveAsset(c, 'icon-180'));
app.get('/asset/logo', (c) => serveAsset(c, 'logo'));
app.get('/asset/icon-512.png', (c) => serveAsset(c, 'icon-512'));
app.get('/asset/icon-192.png', (c) => serveAsset(c, 'icon-192'));
app.get('/asset/icon-180.png', (c) => serveAsset(c, 'icon-180'));
app.get('/asset/icon-32.png', (c) => serveAsset(c, 'icon-32'));

// Sign-in and setup come first so the admin guard below doesn't catch /admin/login.
app.route('/', auth);

const admin = new Hono<AppEnv>();
admin.use('*', requireAdmin);
admin.route('/', dash);
admin.route('/reviews', rev);
admin.route('/team', team);
admin.route('/branding', branding);
admin.route('/account', account);
admin.route('/', other);
app.route('/admin', admin);

// The 15-minute scheduler (cron/index.js) calls this: POST /api/cron with "Authorization: Bearer CRON_SECRET".
app.post('/api/cron', async (c) => {
  const given = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!c.env.CRON_SECRET || !given || !(await sameSecret(given, c.env.CRON_SECRET))) return c.text('Forbidden', 403);
  return c.json(await runScheduled(c.env));
});

app.route('/', me);
app.route('/', pub); // last: /<tech-slug> catches single-segment paths

// Pages sends every request here; anything the app doesn't handle is a static file (or a plain 404).
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  // Invite paths carry a one-time token: keep it out of logs.
  console.error('[error]', c.req.method, c.req.path.replace(/\/invite\/.*/, '/invite/[redacted]'), err);
  return c.html(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Something went wrong</title>
     <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/theme.css"><body class="pub"><main id="main" class="pub__main"><section class="pub__card"><h1>Something went wrong</h1>
     <p class="muted">Please try again in a moment.</p><a class="btn btn--ghost" href="/">Start over</a></section></main></body></html>`,
    500,
  );
});

export default {
  fetch: app.fetch,
  scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;

// End to end on a fresh database, through the real app: first-run setup, adding techs, a customer tapping a tag
// → rating → choosing Google → the review arriving and being credited, plus the security features (separate tech
// logins, invites, owner-only settings, two-step sign-in, CSRF, rate limits, uploads). Starts the Node preview on
// port 8799. Every person and business here is made up.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { stepAt, totpCode } from '../.test-build/totp.js';

// A free port (or E2E_PORT), so the run never collides with a preview that's already open.
const PORT = Number(process.env.E2E_PORT) || await new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const BASE = `http://localhost:${PORT}`;
const VARS = readFileSync('.dev.vars', 'utf8');
const SETUP_KEY = VARS.match(/^SETUP_KEY=(.*)$/m)?.[1]?.trim();
const CRON_SECRET = VARS.match(/^CRON_SECRET=(.*)$/m)?.[1]?.trim();
const OWNER = { email: 'owner@e2e.test', password: 'e2e-owner-password-1' };
const TZ = 'America/Chicago';
let server;
let admin = ''; // cookie header for the owner

before(async () => {
  assert.ok(SETUP_KEY && SETUP_KEY.length >= 16, 'SETUP_KEY (16+ characters) missing from .dev.vars');
  assert.ok(CRON_SECRET, 'CRON_SECRET missing from .dev.vars');
  // E2E_FROM_DIST=1 runs the exact dist/_worker.js that `npm run deploy` uploads to Pages.
  const args = ['scripts/dev-node.mjs', '--reset', ...(process.env.E2E_FROM_DIST ? ['--from-dist'] : [])];
  server = spawn(process.execPath, args, { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 30_000);
    server.stdout.on('data', (d) => { if (String(d).includes(`localhost:${PORT}`)) { clearTimeout(timer); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});
after(() => server?.kill());

const cookiesFrom = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
const form = (o) => new URLSearchParams(o);
const req = (path, opts = {}) => fetch(`${BASE}${path}`, { redirect: 'manual', ...opts });
const get = async (path, cookie) => (await req(path, { headers: cookie ? { cookie } : {} })).text();
const post = (path, body, cookie, extra = {}) => req(path, { method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...extra }, body: body instanceof URLSearchParams ? body : form(body) });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(Date.now());
// Each customer comes from their own connection (Cloudflare sets cf-connecting-ip in production).
const customer = (n, more = {}) => ({ 'user-agent': 'Mozilla/5.0 (iPhone)', 'cf-connecting-ip': `203.0.113.${n}`, ...more });
/** The message a redirect carries in ?ok= / ?err= (spaces arrive as +). */
const flashIn = (res) => decodeURIComponent((res.headers.get('location') ?? '').replace(/\+/g, ' '));
const tapIdIn = (html) => html.match(/name="t" value="(tap_[^"]+)"/)?.[1];
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------- first run ----------

test('setup refuses a wrong key and a missing business name, then creates the owner once', async () => {
  assert.equal((await post('/setup', { key: 'nope', company: 'Acme', name: 'Owner', email: OWNER.email, password: OWNER.password })).status, 422);
  assert.equal((await post('/setup', { key: SETUP_KEY, company: '', name: 'Owner', email: OWNER.email, password: OWNER.password })).status, 422);
  const res = await post('/setup', { key: SETUP_KEY, company: 'Lakeside Plumbing Co.', name: 'Olivia Owner', email: OWNER.email, password: OWNER.password, tz: TZ });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/admin\/branding/);
  admin = cookiesFrom(res);
  assert.match(admin, /__Host-rv_admin=/);
  assert.equal((await req('/setup')).status, 303, 'setup closes once an owner exists');
  assert.equal((await post('/setup', { key: SETUP_KEY, company: 'Evil', name: 'Second', email: 'x@e2e.test', password: 'another-password-1' })).status, 303, 'and stays closed');
});

test('pages carry the security headers; private pages are never cached', async () => {
  const res = await req('/admin/login');
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('strict-transport-security') ?? '', /max-age=\d+/);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  const cookie = (await post('/admin/login', { email: OWNER.email, password: OWNER.password })).headers.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Lax/i);
});

test('signed-out visitors are sent to sign in', async () => {
  const res = await req('/admin/reviews');
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/admin\/login\?next=/);
});

test('a wrong password is refused, and guessing is cut off', async () => {
  const ip = { 'cf-connecting-ip': '198.51.100.7' };
  for (let i = 0; i < 8; i++) assert.equal((await post('/admin/login', { email: OWNER.email, password: `wrong-${i}-password` }, '', ip)).status, 422);
  assert.equal((await post('/admin/login', { email: OWNER.email, password: OWNER.password }, '', ip)).status, 429, 'the 9th try in 15 minutes is blocked, even with the right password');
  assert.equal((await post('/admin/login', { email: OWNER.email, password: OWNER.password }, '', { 'cf-connecting-ip': '198.51.100.8' })).status, 303, 'the owner can still sign in from elsewhere');
});

// ---------- team and review links ----------

const TECH = {};
async function addTech(name, slug, extra = {}) {
  const res = await post('/admin/team/new', { name, first_name: name.split(' ')[0], slug, role: 'Technician', active: '1', sort: '10', ...extra }, admin);
  assert.equal(res.status, 303, `adding ${name}`);
  TECH[slug] = res.headers.get('location').match(/\/admin\/team\/(t_[^?]+)/)[1];
}

test('the owner adds techs; links, emails and phones must be unique and not reserved', async () => {
  await addTech('Maya Okonkwo', 'maya', { phone: '(312) 555-0141', email: 'maya@example.com' });
  await addTech('Diego Alvarez', 'diego');
  await addTech('Priya Raman', 'priya');
  await addTech('Sam Whitfield', 'sam');
  assert.equal((await post('/admin/team/new', { name: 'Maya Two', slug: 'maya' }, admin)).status, 422, 'same link');
  assert.equal((await post('/admin/team/new', { name: 'Admin Person', slug: 'admin' }, admin)).status, 422, 'reserved link');
  assert.equal((await post('/admin/team/new', { name: 'Other Phone', slug: 'other', phone: '312.555.0141' }, admin)).status, 422, 'same mobile number');
  assert.equal((await post('/admin/team/new', { name: 'Fake Photo', slug: 'fake', photo: 'data:image/png;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+' }, admin)).status, 422, 'a photo that isn\'t really a PNG');
});

test('review links must point at the site they are for', async () => {
  const bad = await post('/admin/settings/sites', { google_on: '1', google_url: 'https://evil.example/review' }, admin);
  assert.match(flashIn(bad), /use the https:\/\/ link from that site/);
  const ok = await post('/admin/settings/sites', {
    google_on: '1', google_url: 'https://g.page/r/lakeside-test/review',
    yelp_on: '1', yelp_url: 'https://www.yelp.com/biz/lakeside-plumbing-test',
    bbb_on: '1', bbb_url: 'https://www.bbb.org/us/il/chicago/profile/plumber/lakeside-test',
  }, admin);
  assert.match(flashIn(ok), /Review sites saved/);
});

// ---------- the customer ----------

let tapId = '';
let mariaCookie = '';
test("customer taps Maya's tag, rates 5 stars, chooses Google", async () => {
  const page = await req('/maya?s=nfc', { headers: customer(1) });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /How did Maya do/);
  assert.match(html, /Not Maya\? Choose your technician/);
  tapId = tapIdIn(html);
  assert.ok(tapId, 'visit id on the page');

  assert.equal((await post('/maya', { t: tapId, rating: '5', name: '' }, '', customer(1))).status, 422, 'name is required');
  const sent = await post('/maya', { t: tapId, rating: '5', name: 'Maria Lopez', comment: 'Found the leak fast.' }, cookiesFrom(page), customer(1));
  assert.equal(sent.status, 303);
  assert.equal(sent.headers.get('location'), `/maya/share?t=${tapId}`);
  mariaCookie = cookiesFrom(sent);

  const share = await (await req(`/maya/share?t=${tapId}`, { headers: { ...customer(1), cookie: mariaCookie } })).text();
  assert.match(share, /Thank you, Maria\./);
  assert.match(share, /Review us on Google/);
  assert.match(share, /Or review us on/);
  const at = (s) => share.indexOf(s);
  assert.ok(at('>Yelp<') > 0 && at('Better Business Bureau') > 0, 'every enabled site is offered');
  assert.ok(at('Review us on Google') < at('>Yelp<') && at('>Yelp<') < at('Better Business Bureau'), 'Google first, then Yelp, then BBB');

  const yelp = await req(`/go/${tapId}/yelp`, { headers: customer(1) });
  assert.equal(yelp.status, 302);
  assert.match(yelp.headers.get('location'), /^https:\/\/www\.yelp\.com\/biz\/lakeside-plumbing-test/);
  const go = await req(`/go/${tapId}/google`, { headers: customer(1) });
  assert.equal(go.status, 302);
  assert.match(go.headers.get('location'), /^https:\/\/g\.page\/r\/lakeside-test\/review/);
});

test("someone else can't open a customer's thank-you page (it shows their name)", async () => {
  const res = await req(`/maya/share?t=${tapId}`, { headers: customer(99) });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/maya');
});

let lowTap = '';
let danCookie = '';
test('an unhappy customer is offered a call-back, with the review links still on the page', async () => {
  const page = await req('/diego?s=qr', { headers: customer(2) });
  lowTap = tapIdIn(await page.text());
  const sent = await post('/diego', { t: lowTap, rating: '2', name: 'Dan Brown', comment: 'Arrived late.' }, cookiesFrom(page), customer(2));
  danCookie = cookiesFrom(sent);
  const share = await (await req(sent.headers.get('location'), { headers: { ...customer(2), cookie: danCookie } })).text();
  assert.match(share, /sorry the visit fell short/);
  assert.match(share, /Request a call/);
  // Not gated: every enabled review site is still one tap away.
  assert.match(share, /Prefer to post a public review\?/);
  for (const site of ['google', 'yelp', 'bbb']) assert.ok(share.includes(`/go/${lowTap}/${site}`), `${site} link missing`);
});

test('the call-back request needs a real phone number, then confirms without showing the whole number', async () => {
  const bad = await post('/diego/callback', { t: lowTap, phone: '123', time: 'morning', details: 'Arrived late.' }, danCookie, customer(2));
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /phone number with the area code/);
  const ok = await post('/diego/callback', { t: lowTap, phone: '312 555 0199', time: 'morning', details: 'Arrived two hours late.' }, danCookie, customer(2));
  assert.equal(ok.status, 303);
  const done = await (await req(ok.headers.get('location'), { headers: { ...customer(2), cookie: danCookie } })).text();
  assert.match(done, /A manager will call you in the morning/);
  assert.match(done, /ending in <strong>99<\/strong>/);
  assert.ok(!done.includes('555-0199'), 'the full number is not on the page');
  assert.ok(done.includes(`/go/${lowTap}/google`), 'review links still offered after the request');
  const stranger = await post('/diego/callback', { t: lowTap, phone: '312 555 0100', time: 'asap' }, '', customer(3));
  assert.equal(stranger.status, 303, "someone else can't change the number");
});

// ---------- matching and credit ----------

let reviewId = '';
test('the Google review "Maria L." is credited to Maya automatically, with points', async () => {
  const res = await post('/admin/reviews/new', { platform: 'google', date: today(), reviewer: 'Maria L.', rating: '5', body: 'Quick and tidy work on our water heater.', tech: '' }, admin);
  assert.equal(res.status, 303);
  reviewId = res.headers.get('location').match(/\/admin\/reviews\/(r_[^?]+)/)[1];
  const detail = await get(`/admin/reviews/${reviewId}`, admin);
  assert.match(detail, /Maya Okonkwo/);
  assert.match(detail, /Matched to their tag/);
  assert.match(detail, /“Maria Lopez” rated Maya on their tag and chose Google/);
  const team = await get(`/admin/team/${TECH.maya}`, admin);
  assert.match(team, /Points balance<\/span><span class="stat__value tnum">15</, '10 for the review + 5 for five stars');
});

test('a review naming a tech is credited by mention', async () => {
  const res = await post('/admin/reviews/new', { platform: 'bbb', date: today(), reviewer: 'Anjali Shah', rating: '5', body: 'Priya explained everything and fixed our sprinkler line.', tech: '' }, admin);
  const detail = await get(res.headers.get('location').split('?')[0], admin);
  assert.match(detail, /Priya Raman/);
  assert.match(detail, /Named in the review/);
});

test('a review can be credited to two techs at once', async () => {
  const both = await post('/admin/reviews/new', new URLSearchParams([['platform', 'yelp'], ['date', today()], ['reviewer', 'Pat Quinn'], ['rating', '5'], ['body', 'Great crew.'], ['tech', TECH.diego], ['tech', TECH.sam]]), admin);
  const id = both.headers.get('location').match(/\/admin\/reviews\/(r_[^?]+)/)[1];
  const credits = (await get(`/admin/reviews/${id}`, admin)).match(/class="plain credit-list"[\s\S]*?<\/ul>/)?.[0] ?? '';
  assert.match(credits, /Diego Alvarez/);
  assert.match(credits, /Sam Whitfield/);
});

test('removing a credit also removes the points', async () => {
  await post(`/admin/reviews/${reviewId}/uncredit`, { tech: TECH.maya }, admin);
  assert.match(await get(`/admin/team/${TECH.maya}`, admin), /Points balance<\/span><span class="stat__value tnum">0</);
});

test('"Who helped you today?" search filters and highlights names without scripts', async () => {
  const html = await get('/?q=may');
  assert.match(html, /<mark>May<\/mark>a Okonkwo/);
  assert.match(html, /1 technician found/);
  assert.match(await get('/?q=zzz'), /No one by that name/);
});

test('the call-back waits in Tag activity, and logging the call closes it', async () => {
  const open = await get('/admin/activity?f=low', admin);
  assert.match(open, /Dan Brown/);
  assert.match(open, /href="tel:\+13125550199"/);
  assert.match(open, /Wants a call/);
  await post(`/admin/activity/${lowTap}/followup`, { status: 'resolved', note: 'Refunded the trip fee', back: '/admin/activity?f=low' }, admin);
  assert.ok(!(await get('/admin/activity?f=low', admin)).includes('Dan Brown'), 'resolved call-backs leave the open list');
  assert.match(await get('/admin/activity?f=lowall', admin), /Refunded the trip fee/);
});

// ---------- abuse ----------

test('staff previewing a tag are not counted', async () => {
  const page = await get('/maya?s=nfc', admin);
  assert.match(page, /Preview\. Visits from staff phones aren(&#39;|')t counted\./);
  assert.match(page, /name="t" value="preview"/);
});

test('cross-site form posts are refused, in the dashboard and on public pages', async () => {
  assert.equal((await post('/admin/rewards', { name: 'Free money', cost: '1' }, admin, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/admin/rewards', { name: 'Free money', cost: '1' }, admin, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post('/admin/rewards', { name: 'Free money', cost: '1' }, admin, { 'sec-fetch-site': 'same-site' })).status, 403, 'a sibling subdomain is not this site');
  assert.equal((await post('/maya', { t: 'tap_xxxxxxxxxxxx', rating: '1', name: 'Mallory' }, '', { ...customer(4), origin: 'https://evil.example' })).status, 403);
});

test('one connection rating the same tech over and over stops being saved (but still sees the links)', async () => {
  const spammers = async () => new Set((await get(`/admin/activity?tech=${TECH.sam}`, admin)).match(/Spammer \d/g)).size;
  const before = await spammers();
  let last;
  for (let i = 0; i < 6; i++) {
    const page = await req('/sam?s=nfc', { headers: customer(50) });
    last = await post('/sam', { t: tapIdIn(await page.text()), rating: '5', name: `Spammer ${i}` }, '', customer(50));
  }
  assert.equal(last.status, 200, 'over the limit: the thank-you page is shown directly, nothing saved');
  const after = await spammers();
  assert.equal(after - before, 4, 'four ratings an hour per tech per connection');
});

test('"Not Maya? Choose your technician" cancels the visit logged for the wrong tech', async () => {
  const page = await req('/maya?s=nfc', { headers: customer(5) });
  const t = tapIdIn(await page.text());
  const visit = await post('/maya/visit', { t, s: 'nfc' }, '', customer(5));
  assert.equal(visit.status, 204);
  const cookie = cookiesFrom(visit);
  const unfinished = async () => (await get(`/admin/activity?f=unfinished&tech=${TECH.maya}`, admin)).match(/Didn(&#39;|')t finish/g)?.length ?? 0;
  const before = await unfinished();
  assert.ok(before >= 1);
  const sw = await post('/switch', { t }, cookie, customer(5));
  assert.equal(sw.status, 303);
  assert.equal(await unfinished(), before - 1, 'the wrong tech no longer has the visit');
});

test('bots and link previews are not counted as visits', async () => {
  const unfinished = async () => (await get(`/admin/activity?f=unfinished&tech=${TECH.priya}`, admin)).match(/Didn(&#39;|')t finish/g)?.length ?? 0;
  const before = await unfinished();
  await req('/priya?s=nfc', { headers: customer(6, { 'sec-purpose': 'prefetch' }) });
  assert.equal((await post('/priya/visit', { t: 'tap_botbotbotbot', s: 'nfc' }, '', customer(6, { 'user-agent': 'facebookexternalhit/1.1' }))).status, 204);
  assert.equal(await unfinished(), before);
});

// ---------- techs have their own logins ----------

let techCookie = '';
let inviteLink = '';
test('a tech invite link lets the tech choose a password, once', async () => {
  const page = await (await post(`/admin/team/${TECH.maya}/invite`, {}, admin)).text();
  inviteLink = page.match(/http:\/\/localhost:\d+\/invite\/[A-Za-z0-9_-]+/)?.[0];
  assert.ok(inviteLink, 'invite link shown');
  const path = new URL(inviteLink).pathname;
  assert.match(await get(path), /Choose a password/);
  assert.equal((await post(path, { password: 'maya-password-123', confirm: 'something-else-1' })).status, 422);
  assert.equal((await post(path, { password: 'short', confirm: 'short' })).status, 422);
  const ok = await post(path, { password: 'maya-password-123', confirm: 'maya-password-123' });
  assert.equal(ok.status, 303);
  techCookie = cookiesFrom(ok);
  assert.match(techCookie, /__Host-rv_tech=/);
  assert.equal((await req(path)).status, 404, 'the link is single-use');
  assert.match(await get('/me', techCookie), /Show my QR code/);
});

test('techs sign in with their username, email or mobile; wrong passwords are refused', async () => {
  for (const ident of ['maya', 'MAYA@example.com', '312-555-0141']) {
    const res = await post('/me/login', { ident, password: 'maya-password-123' }, '', { 'cf-connecting-ip': '192.0.2.10' });
    assert.equal(res.status, 303, `sign in with ${ident}`);
  }
  assert.equal((await post('/me/login', { ident: 'maya', password: 'nope-nope-nope' }, '', { 'cf-connecting-ip': '192.0.2.11' })).status, 422);
  assert.equal((await post('/me/login', { ident: 'diego', password: 'maya-password-123' }, '', { 'cf-connecting-ip': '192.0.2.11' })).status, 422, 'no password set yet');
});

test("a tech sees only the tech side: not the office dashboard, not other techs' customers", async () => {
  const dash = await req('/admin', { headers: { cookie: techCookie } });
  assert.equal(dash.status, 303);
  assert.match(dash.headers.get('location'), /^\/admin\/login/);
  const reviews = await get('/me/reviews', techCookie);
  assert.ok(!reviews.includes('Dan Brown'), "Diego's unhappy customer isn't visible to Maya");
  assert.ok(!reviews.includes('Pat Quinn'), "reviews credited to others aren't listed");
});

test('the office can sign a tech out of every phone', async () => {
  assert.equal((await post(`/admin/team/${TECH.maya}/signout`, {}, admin)).status, 303);
  const res = await req('/me', { headers: { cookie: techCookie } });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\/me\/login/);
});

// ---------- office managers and owner-only settings ----------

let manager = '';
test('the owner invites an office manager, who can work but not change settings', async () => {
  const page = await (await post('/admin/users', { name: 'Morgan Manager', email: 'manager@e2e.test', role: 'manager' }, admin)).text();
  const link = page.match(/http:\/\/localhost:\d+\/admin\/invite\/[A-Za-z0-9_-]+/)?.[0];
  assert.ok(link, 'manager invite link shown');
  const ok = await post(new URL(link).pathname, { password: 'manager-password-1', confirm: 'manager-password-1' });
  assert.equal(ok.status, 303);
  manager = cookiesFrom(ok);
  assert.match(await get('/admin/reviews', manager), /Reviews/);
  assert.match(await get('/admin/settings', manager), /managed by an owner/);
  assert.equal((await post('/admin/settings/sites', { google_on: '1', google_url: 'https://g.page/r/x/review' }, manager)).status, 403);
  assert.equal((await post('/admin/branding/theme', { do: 'save', action: '#ff00ff' }, manager)).status, 403);
  assert.equal((await post('/admin/users', { name: 'Sneaky', email: 'sneaky@e2e.test', role: 'owner' }, manager)).status, 403);
  assert.equal((await req('/admin/google/connect', { headers: { cookie: manager } })).status, 403);
});

test("a manager's points adjustments are capped", async () => {
  await post('/admin/rewards/adjust', { tech: TECH.diego, amount: '5000', reason: 'Big bonus' }, manager);
  assert.match(await get(`/admin/team/${TECH.diego}`, admin), /Big bonus[\s\S]{0,400}\+100</);
});

// ---------- two-step sign-in ----------

test('two-step sign-in: set up, required at sign-in, and a code works only once', async () => {
  const setup = await (await post('/admin/account/2fa/start', {}, admin)).text();
  const secret = setup.match(/data-copy="([A-Z2-7]{16,})"/)?.[1];
  assert.ok(secret, 'setup shows the key');
  assert.equal((await post('/admin/account/2fa/confirm', { code: '000000' }, admin)).status, 422);
  const code = await totpCode(secret, stepAt(Date.now()));
  assert.equal((await post('/admin/account/2fa/confirm', { code }, admin)).status, 303);

  const ip = { 'cf-connecting-ip': '198.51.100.20' };
  const first = await post('/admin/login', { email: OWNER.email, password: OWNER.password }, '', ip);
  assert.equal(first.status, 303);
  assert.match(first.headers.get('location'), /^\/admin\/login\/code/);
  const pending = cookiesFrom(first);
  assert.ok(!/__Host-rv_admin=/.test(pending), 'no office session before the code');
  assert.equal((await req('/admin', { headers: { cookie: pending } })).status, 303, 'the password alone does not open the dashboard');
  assert.equal((await post('/admin/login/code', { code: '123456' }, pending)).status, 422);

  // The code just used to turn it on can't be used again.
  assert.match(await (await post('/admin/login/code', { code }, pending)).text(), /already used|didn(&#39;|')t work/);
  const next = await totpCode(secret, stepAt(Date.now()) + 1);
  const ok = await post('/admin/login/code', { code: next }, pending);
  assert.equal(ok.status, 303);
  admin = cookiesFrom(ok);
  assert.match(admin, /__Host-rv_admin=/);
  assert.match(await get('/admin/account', admin), /Two-step sign-in[\s\S]{0,200}>On</);
});

// ---------- branding ----------

test('branding: colors become /theme.css; only valid colors are accepted', async () => {
  const res = await post('/admin/branding/theme', { do: 'save', preset: 'midnight', mode: 'light', bg: '#fafafa', surface: '#ffffff', text: '#111111', action: '#0f766e', proof: '#16a34a', corners: 'round', heading_font: 'serif', body_font: 'system' }, admin);
  assert.equal(res.status, 303);
  const css = await (await req('/theme.css')).text();
  assert.match(css, /--action:#0f766e/);
  assert.match(css, /color-scheme:light/);
  await post('/admin/branding/theme', { do: 'save', action: 'red;}body{display:none', bg: 'url(javascript:alert(1))' }, admin);
  const css2 = await (await req('/theme.css')).text();
  assert.ok(!/display:none|javascript/.test(css2), 'only #rrggbb values make it into the stylesheet');
  const tokens = await (await req('/admin/branding/tokens?bg=%23000000&text=%23111111', { headers: { cookie: admin } })).json();
  assert.ok(tokens.warnings.length > 0, 'unreadable colors are flagged');
});

test('branding: a logo and app icon upload, are checked, and are served safely', async () => {
  const fake = await post('/admin/branding/images', { logo: 'data:image/png;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+' }, admin);
  assert.equal(fake.status, 422);
  assert.match(await fake.text(), /isn(&#39;|')t the image type it claims/);
  const ok = await post('/admin/branding/images', { logo: PNG_1PX, 'icon-512': PNG_1PX, 'icon-192': PNG_1PX, 'icon-180': PNG_1PX, 'icon-32': PNG_1PX }, admin);
  assert.equal(ok.status, 303);
  const logo = await req('/asset/logo');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.match(logo.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal((await req('/favicon.ico')).headers.get('content-type'), 'image/png');
  const manifest = await (await req('/manifest.webmanifest')).json();
  assert.equal(manifest.name, 'Lakeside Plumbing Co.');
  assert.match(await get('/admin/login'), /src="\/asset\/logo\?v=\d+"/);
});

test('business details: links must be web addresses', async () => {
  assert.equal((await post('/admin/branding/details', { company_name: 'Lakeside Plumbing Co.', website_url: 'javascript:alert(1)' }, admin)).status, 422);
  assert.equal((await post('/admin/branding/details', { company_name: 'Lakeside Plumbing Co.', website_url: 'lakeside.example.com', office_phone: '(312) 555-0100' }, admin)).status, 303);
});

// ---------- records ----------

test('the activity log records who changed what', async () => {
  const log = await get('/admin/log', admin);
  for (const action of ['tech.add', 'tech.invite', 'login.invite', 'brand.theme', 'brand.images', 'account.2fa_on', 'points.adjust']) assert.match(log, new RegExp(action.replace('.', '\\.')));
  assert.equal((await req('/admin/log', { headers: { cookie: manager } })).status, 403, 'owners only');
});

test("a customer's data can be found and deleted on request", async () => {
  const found = await get('/admin/privacy?q=Maria', admin);
  assert.match(found, /Maria Lopez/);
  const ids = [...found.matchAll(/name="id" value="(tap_[^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length);
  assert.equal((await post('/admin/privacy/delete', new URLSearchParams(ids.map((id) => ['id', id])), admin)).status, 303);
  assert.match(await get('/admin/privacy?q=Maria', admin), /No visits found/);
});

// ---------- the rest ----------

test('the 15-minute scheduler needs the secret', async () => {
  assert.equal((await req('/api/cron', { method: 'POST' })).status, 403);
  assert.equal((await req('/api/cron', { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 403);
  const ok = await req('/api/cron', { method: 'POST', headers: { authorization: `Bearer ${CRON_SECRET}` } });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).note, /Google keys are not set/);
});

test('static files and default icons load', async () => {
  const css = await req('/styles.css');
  assert.equal(css.status, 200);
  assert.match(await css.text(), /RootView/);
  assert.equal((await req('/static/icon-192.png')).status, 200);
});

test('unknown tech link shows the friendly 404; bad invite links too', async () => {
  const res = await req('/nobody-here');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Choose your technician/);
  assert.equal((await req('/invite/not-a-real-token-at-all-123')).status, 404);
  assert.equal((await req('/admin/invite/not-a-real-token-at-all-123')).status, 404);
});

test('flash messages only appear after this site redirected there', async () => {
  const forged = await (await req('/admin/team?err=Call%20555-0000%20now', { headers: { cookie: admin, 'sec-fetch-site': 'cross-site' } })).text();
  assert.ok(!forged.includes('Call 555-0000 now'));
  const real = await (await req('/admin/team?ok=Saved.', { headers: { cookie: admin, 'sec-fetch-site': 'same-origin' } })).text();
  assert.match(real, /Saved\./);
});

test('Start fresh wipes all test activity but keeps the team', async () => {
  assert.equal((await post('/admin/start-fresh', {}, admin)).status, 303);
  assert.match(await get('/admin?p=all', admin), /New reviews<\/span><span class="stat__value tnum">0</);
  assert.match(await get('/admin/activity', admin), /Nothing here/);
  assert.equal((await req('/maya')).status, 200, 'team still there');
});

// ---------- location-based reviews ----------

const HOME_WIFI = { city: 'Oak Park', postalCode: '60302', regionCode: 'IL', asn: 7922, asOrganization: 'Comcast Cable Communications, LLC' };
const CELL = { city: 'Oak Park', postalCode: '60302', regionCode: 'IL', asn: 21928, asOrganization: 'T-Mobile USA, Inc.' };
const ELSEWHERE = { city: 'Evanston', postalCode: '60201', regionCode: 'IL', asn: 7922, asOrganization: 'Comcast Cable Communications, LLC' };

/** A customer somewhere (Cloudflare's rough location, faked by the Node preview) rates a tech and taps Google. */
let ipN = 100;
async function rateAndGoogle(slug, name, cf) {
  const headers = customer(ipN++, { 'x-dev-cf': JSON.stringify(cf) });
  const page = await req(`/${slug}?s=nfc`, { headers });
  const t = tapIdIn(await page.text());
  await post(`/${slug}`, { t, rating: '5', name }, cookiesFrom(page), headers);
  return (await req(`/go/${t}/google`, { headers })).headers.get('location');
}

test("location-based reviews: the Google button opens the profile for the customer's area", async () => {
  const MAIN = /lakeside-test/;
  assert.match(await rateAndGoogle('maya', 'Ana Ruiz', HOME_WIFI), MAIN, 'one profile: unchanged');
  const add = await post('/admin/settings/locations/add', { label: 'Riverside', review_url: 'https://g.page/r/riverside-test/review', areas: 'Oak Park, IL\n60302, Berwyn' }, admin);
  assert.equal(add.status, 303);
  assert.match(await rateAndGoogle('maya', 'Ben Cho', HOME_WIFI), /riverside-test/, 'home internet in Oak Park');
  assert.match(await rateAndGoogle('maya', 'Cy Dunn', CELL), MAIN, 'cell data is too rough: main location');
  assert.match(await rateAndGoogle('maya', 'Di Eng', ELSEWHERE), MAIN, 'an area Riverside does not cover');
  assert.match(await get('/admin/activity', admin), /Google · Riverside/);
});

test('a tech working at another location today sends every customer there, until they switch back', async () => {
  const signin = await post('/me/login', { ident: 'maya', password: 'maya-password-123' }, '', { 'cf-connecting-ip': '192.0.2.30' });
  const tech = cookiesFrom(signin);
  const home = await get('/me', tech);
  assert.match(home, /Where are you working today\?/);
  const riverside = home.match(/name="loc" value="(loc_[^"]+)"[^>]*>Riverside</)[1];
  assert.equal((await post('/me/today', { loc: riverside }, tech)).status, 303);
  assert.match(await rateAndGoogle('maya', 'Eve Fox', ELSEWHERE), /riverside-test/, "the tech's choice beats the customer's area");
  assert.match(await rateAndGoogle('priya', 'Gus Hale', ELSEWHERE), /lakeside-test/, 'other techs are unaffected');
  await post('/me/today', { loc: '' }, tech);
  assert.match(await rateAndGoogle('maya', 'Ivy Jones', ELSEWHERE), /lakeside-test/, 'back to automatic');
});

#!/usr/bin/env node
/**
 * Local demo data for a made-up company, "RootView": a field team, customers tapping their
 * tags, and the Google reviews some of them leave. Every name, phone number and review here is invented.
 * Reviews go in as "pending" so the app's own matching engine credits them the first time the dashboard
 * loads, so the demo exercises the real logic.
 *
 *   npm run dev:demo        (runs this, then starts the local preview)
 *
 * Logins it creates (from .dev.vars):
 *   office:  DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD at /admin
 *   techs:   any demo tech's username (e.g. "maya") / DEMO_ADMIN_PASSWORD at /me/login
 * Local database only: it refuses --remote.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

if (process.argv.includes('--remote')) {
  console.error('Refusing: demo data is for the local database only.');
  process.exit(1);
}

// ---------- config ----------
const vars = Object.fromEntries(
  readFileSync('.dev.vars', 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const ADMIN_EMAIL = vars.DEMO_ADMIN_EMAIL || 'owner@demo.test';
const ADMIN_PASSWORD = vars.DEMO_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 10) {
  console.error('Set DEMO_ADMIN_PASSWORD (10+ characters) in .dev.vars first.');
  process.exit(1);
}
const COMPANY = 'RootView';

// ---------- helpers ----------
let seed = 20261020;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const chance = (p) => rand() < p;
const between = (a, b) => a + rand() * (b - a);
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(Math.round(v)) : `'${String(v).replace(/'/g, "''")}'`);
let n = 0;
const id = (p) => `${p}_demo${(++n).toString(36)}${Math.floor(rand() * 1e6).toString(36)}`;
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 20000 }, key, 256);
  return `pbkdf2$20000$${b64url(salt)}$${b64url(bits)}`;
}

// ---------- people (all invented) ----------
const TECHS = [
  // slug, full name, role, jobs per week, how often their customers are happy, home location
  ['maya', 'Maya Okonkwo', 'Lead Technician', 9, 0.95, 'loc_demo_north'],
  ['diego', 'Diego Alvarez', 'Technician', 8, 0.92, 'loc_demo_north'],
  ['priya', 'Priya Raman', 'Technician', 7, 0.93, 'loc_demo_river'],
  ['sam', 'Sam Whitfield', 'HVAC Technician', 6, 0.9, 'loc_demo_north'],
  ['lena', 'Lena Novak', 'Technician', 6, 0.94, 'loc_demo_river'],
  ['marcus', 'Marcus Bell', 'Drain Specialist', 5, 0.9, 'loc_demo_north'],
  ['tomas', 'Tomás Herrera', 'Technician', 4, 0.91, 'loc_demo_river'],
  ['grace', 'Grace Liu', 'Apprentice', 3, 0.92, 'loc_demo_north'],
];
const FIRST = ['James', 'Maria', 'David', 'Linda', 'Kevin', 'Anjali', 'Michael', 'Susan', 'Wei', 'Carlos', 'Jennifer', 'Tom', 'Aisha', 'Brian', 'Mei', 'Rachel', 'Omar', 'Karen',
  'Rafael', 'Sarah', 'Paul', 'Nora', 'Anthony', 'Nina', 'Steve', 'Laura', 'Raj', 'Emily', 'Patrick', 'Sofia', 'Greg', 'Hannah', 'Luis', 'Megan', 'Vikram', 'Olivia', 'Frank',
  'Jasmine', 'Eric', 'Claire', 'Tony', 'Yuki', 'Mark', 'Ana', 'Ben', 'Monica', 'Sean', 'Lily', 'Victor', 'Dana'];
const LAST = ['Nguyen', 'Garcia', 'Chen', 'Smith', 'Patel', "O'Brien", 'Kim', 'Lopez', 'Wong', 'Johnson', 'Rossi', 'Murphy', 'Singh', 'Tanaka', 'Hernandez', 'Walsh',
  'Lee', 'Brown', 'Shapiro', 'Castillo', 'Park', 'Fitzgerald', 'Davis', 'Moreno', 'Liu', 'Kowalski', 'Ramirez', 'Cohen', 'Yamamoto', 'Reyes', 'Okafor', 'Miller'];

const SERVICES = ['water heater', 'tankless water heater', 'kitchen drain', 'main sewer line', 'furnace', 'AC unit', 'slab leak', 'garbage disposal',
  'toilet', 'gas line', 'heat pump', 'sump pump', 'shower valve', 'hydro jetting', 'repipe'];

const GOOD_WITH = [
  '{tech} was fantastic. Explained exactly what was wrong with our {service} and had it fixed the same afternoon.',
  'Called about our {service} and {tech} showed up on time, laid down drop cloths, and left the place cleaner than they found it. Highly recommend.',
  `Second time using ${COMPANY}. {tech} is professional, honest and knows their stuff. Our {service} works better than ever.`,
  '{tech} took the time to show us camera footage of the {service} before recommending anything. No pressure, fair price.',
  'Great experience from booking to finish. {tech} was courteous and efficient with our {service}. Will call again.',
  'Our {service} failed on a Sunday and {tech} still made it out. Clear pricing, tidy work, very kind.',
  'Huge thanks to {tech}! Diagnosed the {service} problem other companies missed.',
  'Very happy with the {service} work. {tech} was polite, fast and cleaned up after.',
];
const GOOD_WITHOUT = [
  'Fast, professional service on our {service}. Fair price and great communication from the office.',
  'RootView replaced our {service}. Crew was respectful and the job was done right.',
  'Excellent work on the {service}. Scheduling was easy and they showed up when they said.',
  'Great company. Honest assessment of our {service} and no upselling.',
  'Five stars. The {service} repair was quick and the price matched the quote.',
  '',
];
const BAD = [
  'Showed up two hours late and the {service} fix took two visits.',
  'Work on the {service} was fine but the final bill was higher than the estimate.',
  'Had to call back twice about the {service}. Nobody returned my messages for a day.',
  'The {service} is still making noise after the repair.',
];
const TAP_COMMENTS_GOOD = ['Super helpful and friendly!', 'On time and very clean work.', 'Explained everything clearly.', 'Thank you for coming out so quickly.', null, null, null, null];
const TAP_COMMENTS_BAD = ['Arrived later than the window we were given.', 'Price ended up higher than quoted.', 'Left some mess under the sink.', 'Still hearing a drip after the visit.'];
const REPLIES = [
  'Thank you so much for the kind words! We will pass them along to the team. — The RootView team',
  'We really appreciate you taking the time to share this. Thanks for choosing us! — The RootView team',
];

const fill = (t, tech, service) => t.replace(/\{tech\}/g, tech).replace(/\{service\}/g, service);

function reviewerNameFor(first, last) {
  const r = rand();
  if (r < 0.42) return `${first} ${last}`;
  if (r < 0.78) return `${first} ${last[0]}.`;
  if (r < 0.88) return first;
  return `${pick(FIRST)} ${pick(LAST)}`; // family member or Google account in another name: won't match
}

// ---------- generate ----------
const HOUR = 3600e3, DAY = 24 * HOUR;
const now = Date.now();
const DAYS = 130;
const trackingStart = now - 100 * DAY;
const sql = [];
const taps = [];
const reviews = [];

for (let d = DAYS; d >= 0; d--) {
  const dayStart = now - d * DAY;
  const date = new Date(dayStart);
  const weekend = [0, 6].includes(date.getUTCDay());
  for (const [slug, name, , perWeek, happy] of TECHS) {
    const techId = `t_demo_${slug}`;
    const techFirst = name.split(' ')[0];
    const expected = (perWeek / 5) * (weekend ? 0.25 : 1) * between(0.6, 1.4);
    const jobs = Math.floor(expected) + (chance(expected % 1) ? 1 : 0);
    for (let j = 0; j < jobs; j++) {
      // Business hours in US Central time (~14:00–01:00 UTC)
      const utcMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
      const t = utcMidnight + 14 * HOUR + between(0, 10.5) * HOUR;
      if (t > now - 20 * 60e3) continue;
      if (!chance(0.72)) continue; // tag not offered on every job
      const first = pick(FIRST), last = pick(LAST);
      const service = pick(SERVICES);
      const source = chance(0.6) ? 'nfc' : chance(0.65) ? 'qr' : 'text';
      const tap = { id: id('tap'), tech_id: techId, source, created_at: t, customer_name: null, rating: null, comment: null, site: null, clicked_at: null, rated_at: null, resolved_at: null };
      taps.push(tap);
      if (!chance(0.86)) continue; // opened but didn't finish
      const good = chance(happy);
      tap.rating = good ? (chance(0.88) ? 5 : 4) : pick([1, 2, 2, 3, 3]);
      tap.customer_name = chance(0.55) ? `${first} ${last[0]}` : `${first} ${last}`;
      tap.comment = good ? pick(TAP_COMMENTS_GOOD) : pick(TAP_COMMENTS_BAD);
      tap.rated_at = t + between(20, 120) * 1000;
      if (!good && chance(0.55)) {
        // Asked for a call-back (555-01xx numbers are reserved for fiction)
        tap.callback_phone = `(312) 555-01${String(Math.floor(rand() * 90) + 10)}`;
        tap.callback_time = pick(['asap', 'asap', 'morning', 'afternoon', 'evening']);
        tap.callback_at = t + between(1, 4) * 60e3;
      }
      if (!good && chance(0.6) && t < now - 3 * DAY) {
        tap.resolved_at = t + between(2, 20) * HOUR;
        tap.followup_status = chance(0.75) ? 'resolved' : 'unresolved';
        tap.followup_note = tap.followup_status === 'resolved'
          ? pick(['Sent Marcus back out, fixed at no charge.', 'Waived the trip fee; customer happy.', 'Explained the pricing; they were fine after the call.'])
          : pick(['Two voicemails, no call back.', 'Customer still unhappy about the price.']);
      }
      const site = chance(good ? 0.8 : 0.35) ? (chance(0.9) ? 'google' : 'yelp') : null;
      if (!site) continue;
      tap.site = site;
      tap.clicked_at = tap.rated_at + between(5, 60) * 1000;
      if (!chance(good ? 0.68 : 0.5)) continue; // clicked but never posted
      const lag = chance(0.7) ? between(2, 45) * 60e3 : between(1, 30) * HOUR;
      const posted = tap.clicked_at + lag;
      if (posted > now - 5 * 60e3) continue;
      const mention = chance(0.5);
      const rating = good ? (tap.rating === 5 || chance(0.7) ? 5 : 4) : Math.max(1, tap.rating - (chance(0.5) ? 1 : 0));
      const body = good ? fill(pick(mention ? GOOD_WITH : GOOD_WITHOUT), techFirst, service) : fill(pick(BAD), techFirst, service);
      reviews.push({ platform: site, reviewer: reviewerNameFor(first, last), rating, body, posted, reply: good && posted < now - 2 * DAY && chance(0.55) ? pick(REPLIES) : null });
    }
  }
  // Reviews with no tag visit behind them (tag not offered, or a returning customer)
  const extra = weekend ? 0 : Math.floor(between(0, 2.2));
  for (let k = 0; k < extra; k++) {
    const t = dayStart - between(2, 10) * HOUR;
    if (t > now - HOUR) continue;
    const techFirst = pick(TECHS)[1].split(' ')[0];
    const mention = chance(0.45);
    const good = chance(0.92);
    const service = pick(SERVICES);
    const body = good ? fill(pick(mention ? GOOD_WITH : GOOD_WITHOUT), techFirst, service) : fill(pick(BAD), techFirst, service);
    reviews.push({ platform: 'google', reviewer: `${pick(FIRST)} ${pick(LAST)}`, rating: good ? (chance(0.9) ? 5 : 4) : pick([1, 2, 3]), body, posted: t, reply: good && chance(0.5) ? pick(REPLIES) : null });
  }
}

// ---------- SQL ----------
const pw = await hashPassword(ADMIN_PASSWORD);
sql.push('DELETE FROM points; DELETE FROM credits; DELETE FROM redemptions; DELETE FROM rewards; DELETE FROM reviews; DELETE FROM taps; DELETE FROM sessions;');
sql.push(`DELETE FROM techs WHERE id LIKE 't_demo_%';`);
sql.push(`DELETE FROM admins WHERE email = ${q(ADMIN_EMAIL)};`);
sql.push(`INSERT INTO admins (id, name, email, password_hash, role, created_at) VALUES (${q(id('adm'))}, 'Demo Owner', ${q(ADMIN_EMAIL)}, ${q(pw)}, 'owner', ${now});`);
TECHS.forEach(([slug, name, role, , , home], i) => {
  sql.push(`INSERT INTO techs (id, slug, name, first_name, role, aliases, email, active, sort, password_hash, home_location, created_at, updated_at) VALUES (${q(`t_demo_${slug}`)}, ${q(slug)}, ${q(name)}, ${q(name.split(' ')[0])}, ${q(role)}, '', ${q(`${slug}@example.com`)}, 1, ${(i + 1) * 10}, ${q(pw)}, ${q(home)}, ${now - 200 * DAY}, ${now - 200 * DAY});`);
});
const DEMO_LOCATIONS = [
  { id: 'loc_demo_north', label: 'Northside', review_url: 'https://g.page/r/demo-northside/review', areas: ['Evanston', 'Skokie', 'Wilmette', '60201'], bonus: 0 },
  { id: 'loc_demo_river', label: 'Riverside', review_url: 'https://g.page/r/demo-riverside/review', areas: ['Oak Park', 'Berwyn', 'Riverside', '60302'], bonus: 5 },
];
const SETTINGS = {
  demo: true,
  tracking_start: trackingStart,
  company_name: COMPANY,
  public_base_url: `http://localhost:${process.env.PORT || 8787}`,
  office_phone: '(312) 555-0100',
  website_url: 'https://example.com/',
  timezone: 'America/Chicago',
  alert_emails: ['office@example.com'],
  reply_signature: 'The RootView team',
  reply_context: 'Family-owned plumbing, heating and air conditioning company.',
  sites: [
    { id: 'google', label: 'Google', url: 'https://g.page/r/demo-northside/review', enabled: true },
    { id: 'yelp', label: 'Yelp', url: 'https://www.yelp.com/biz/rootview-demo', enabled: true },
    { id: 'bbb', label: 'BBB', url: '', enabled: false },
    { id: 'facebook', label: 'Facebook', url: '', enabled: false },
  ],
  locations: DEMO_LOCATIONS,
};
for (const [k, v] of Object.entries(SETTINGS)) {
  sql.push(`INSERT INTO settings (key, value) VALUES (${q(k)}, ${q(JSON.stringify(v))}) ON CONFLICT (key) DO UPDATE SET value = excluded.value;`);
}
for (let i = 0; i < taps.length; i += 200) {
  const rows = taps.slice(i, i + 200).map((t) =>
    `(${q(t.id)}, ${q(t.tech_id)}, ${q(t.source)}, ${q(t.customer_name)}, ${q(t.rating)}, ${q(t.comment)}, ${q(t.site)}, ${t.created_at}, ${q(t.rated_at)}, ${q(t.clicked_at)}, ${q(t.resolved_at)}, ${t.resolved_at ? "'Demo Owner'" : 'NULL'}, ${q(t.callback_phone)}, ${q(t.callback_time)}, ${q(t.callback_at)}, ${q(t.followup_status)}, ${q(t.followup_note)}, ${q(t.resolved_at)}, ${t.resolved_at ? "'Demo Owner'" : 'NULL'})`);
  sql.push(`INSERT INTO taps (id, tech_id, source, customer_name, rating, comment, site, created_at, rated_at, clicked_at, resolved_at, resolved_by, callback_phone, callback_time, callback_at, followup_status, followup_note, followup_at, followup_by) VALUES\n${rows.join(',\n')};`);
}
reviews.sort((a, b) => a.posted - b.posted);
for (let i = 0; i < reviews.length; i += 200) {
  const rows = reviews.slice(i, i + 200).map((r) => {
    const rid = id('r');
    return `(${q(rid)}, ${q(r.platform)}, ${q(r.platform === 'google' ? `demo-${rid}` : null)}, ${r.platform === 'google' ? q(COMPANY) : 'NULL'}, ${q(r.reviewer)}, ${q(r.rating)}, ${q(r.body)}, ${Math.round(r.posted)}, ${Math.round(r.posted)}, ${now}, ${q(r.reply)}, ${r.reply ? Math.round(r.posted + 20 * HOUR) : 'NULL'}, ${r.posted >= trackingStart ? "'pending'" : "'history'"})`;
  });
  sql.push(`INSERT INTO reviews (id, platform, external_id, location, reviewer_name, rating, body, posted_at, updated_at, imported_at, reply, reply_at, status) VALUES\n${rows.join(',\n')};`);
}
const rewards = [['rw_demo1', 'Lunch on the company', 40], ['rw_demo2', '$50 gift card', 100], ['rw_demo3', 'First pick of the Friday schedule', 150], ['rw_demo4', 'Paid half-day off', 400]];
for (const [rid, name, cost] of rewards) sql.push(`INSERT INTO rewards (id, name, cost, created_at) VALUES (${q(rid)}, ${q(name)}, ${cost}, ${now});`);
sql.push(`INSERT INTO redemptions (id, tech_id, reward_id, reward_name, cost, created_at) VALUES ('rd_demo1', 't_demo_maya', 'rw_demo2', '$50 gift card', 100, ${now - 5 * HOUR});`);
sql.push(`INSERT INTO points (id, tech_id, amount, reason, redemption_id, created_at) VALUES ('pt_demo_redeem', 't_demo_maya', -100, 'Redeemed: $50 gift card', 'rd_demo1', ${now - 5 * HOUR});`);

writeFileSync('.demo-seed.sql', sql.join('\n') + '\n');
console.log(`Demo: ${TECHS.length} techs, ${taps.length} tag visits, ${reviews.length} reviews (${reviews.filter((r) => r.posted >= trackingStart).length} since tracking started).`);
if (!process.argv.includes('--sql-only')) {
  console.log(`\nWrote .demo-seed.sql. Load it by starting the preview with demo data: npm run dev:demo (sign in at /admin with ${ADMIN_EMAIL}).`);
}

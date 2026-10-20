// Matching rules: who gets credit for a review. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_CREDIT, matchReview, mentionedTechs, nameScore } from '../.test-build/match.js';
import { ipBucket, matchName, periodRange, slugify, zonedMidnight } from '../.test-build/util.js';

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 15, 20, 0); // Sep 15 2026, 1pm in Los Angeles

const techs = [
  { id: 't_sebastian', name: 'Sebastian Grimes', first_name: 'Sebastian', aliases: '' },
  { id: 't_declan', name: 'Declan Price', first_name: 'Declan', aliases: '' },
  { id: 't_ronan', name: 'Ronan Byrne', first_name: 'Ronan', aliases: 'Ronnie' },
  { id: 't_daniel', name: 'Daniel Lorenzo', first_name: 'Daniel', aliases: '' },
  { id: 't_danny', name: 'Danny Moloney', first_name: 'Danny', aliases: '' },
];
const tap = (over) => ({ id: 'tap1', tech_id: 't_sebastian', customer_name: 'Maria Lopez', site: 'google', created_at: T0, rated_at: T0 + MIN, clicked_at: T0 + 2 * MIN, ...over });
const review = (over) => ({ platform: 'google', reviewer_name: 'Maria Lopez', body: 'Great service, fixed our water heater.', posted_at: T0 + 12 * MIN, ...over });

// ---------- names ----------

test('names: exact and near-exact matches', () => {
  assert.equal(nameScore('Maria Lopez', 'Maria Lopez'), 100);
  assert.equal(nameScore('maria lopez', 'Maria  Lopez'), 100);
  assert.equal(nameScore('José García', 'Jose Garcia'), 100);
  assert.equal(nameScore("Mary O'Brien", 'Mary OBrien'), 100);
  assert.equal(nameScore('Maria L.', 'Maria Lopez'), 85);
  assert.equal(nameScore('Maria Lopez', 'Maria L'), 85);
  assert.equal(nameScore('M. Lopez', 'Maria Lopez'), 75);
  assert.equal(nameScore('marialopez', 'Maria Lopez'), 85);
  assert.equal(nameScore('Maria', 'Maria Lopez'), 65);
});

test('names: different people score zero', () => {
  assert.equal(nameScore('Maria Lopez', 'Maria Chen'), 0);
  assert.equal(nameScore('Maria Lopez', 'David Lopez'), 0);
  assert.equal(nameScore('Sunshine Girl', 'Maria Lopez'), 0);
  assert.equal(nameScore('', 'Maria Lopez'), 0);
});

// ---------- mentions ----------

test('mentions: first names, aliases, whole words only', () => {
  assert.deepEqual([...mentionedTechs('Sebastian was amazing!', techs).keys()], ['t_sebastian']);
  assert.deepEqual([...mentionedTechs('Ronnie did a tidy job', techs).keys()], ['t_ronan']);
  assert.deepEqual([...mentionedTechs('Danny was great', techs).keys()], ['t_danny']); // not Daniel
  assert.equal(mentionedTechs('Declans hardware store', techs).size, 0);
});

test('mentions: a name two techs share is flagged ambiguous', () => {
  const two = [...techs, { id: 't_declan2', name: 'Declan Hale', first_name: 'Declan', aliases: '' }];
  const m = mentionedTechs('Declan fixed it', two);
  assert.equal(m.get('t_declan').ambiguous, true);
  assert.equal(m.get('t_declan2').ambiguous, true);
});

test('mentions: names that are everyday words need a capital letter', () => {
  const will = [{ id: 't_will', name: 'Will Park', first_name: 'Will', aliases: '' }];
  assert.equal(mentionedTechs('We will call again', will).size, 0);
  assert.equal(mentionedTechs('Will was great', will).size, 1);
});

// ---------- matching ----------

test('named tag visit minutes before the review: auto credit', () => {
  const r = matchReview(review(), techs, [tap()], 72);
  assert.equal(r.credit.length, 1);
  assert.equal(r.credit[0].tech_id, 't_sebastian');
  assert.equal(r.credit[0].method, 'tap');
  assert.equal(r.credit[0].tap_id, 'tap1');
  assert.ok(r.credit[0].score >= AUTO_CREDIT);
});

test('"Maria L." on Google matches "Maria Lopez" on the tag', () => {
  const r = matchReview(review({ reviewer_name: 'Maria L.' }), techs, [tap()], 72);
  assert.equal(r.credit[0]?.tech_id, 't_sebastian');
});

test('review posted before the visit does not match', () => {
  const r = matchReview(review({ posted_at: T0 - HOUR }), techs, [tap()], 72);
  assert.equal(r.credit.length, 0);
  assert.equal(r.suggestions.length, 0);
});

test('review outside the match window does not match', () => {
  const r = matchReview(review({ posted_at: T0 + 80 * HOUR }), techs, [tap()], 72);
  assert.equal(r.credit.length, 0);
});

test('first name only, two days later: suggestion, not auto credit', () => {
  const r = matchReview(review({ reviewer_name: 'Maria', posted_at: T0 + 50 * HOUR }), techs, [tap()], 72);
  assert.equal(r.credit.length, 0);
  assert.equal(r.suggestions[0]?.tech_id, 't_sebastian');
});

test('only one tech\'s customer clicked through: timing-only suggestion', () => {
  const r = matchReview(review({ reviewer_name: 'Sunshine Girl' }), techs, [tap()], 72);
  assert.equal(r.credit.length, 0);
  assert.equal(r.suggestions[0]?.method, 'timing');
  assert.equal(r.suggestions[0]?.tech_id, 't_sebastian');
});

test('two techs\' customers clicked through: no timing guess', () => {
  const taps = [tap(), tap({ id: 'tap2', tech_id: 't_declan', customer_name: 'Wei Chen' })];
  const r = matchReview(review({ reviewer_name: 'Sunshine Girl' }), techs, taps, 72);
  assert.equal(r.credit.length + r.suggestions.length, 0);
});

test('named in the review with no tag visit: auto credit by mention', () => {
  const r = matchReview(review({ body: 'Declan was on time and super clean.' }), techs, [], 72);
  assert.equal(r.credit[0]?.tech_id, 't_declan');
  assert.equal(r.credit[0]?.method, 'mention');
  assert.equal(r.credit[0]?.mentioned, true);
});

test('tag match plus mention of the same tech: one credit, both reasons', () => {
  const r = matchReview(review({ body: 'Sebastian found the leak fast.' }), techs, [tap()], 72);
  assert.equal(r.credit.length, 1);
  assert.equal(r.credit[0].method, 'tap+mention');
  assert.equal(r.credit[0].evidence.length, 2);
});

test('two-person job: tag tech and the helper named in the review both get credit', () => {
  const r = matchReview(review({ body: 'Sebastian and Ronan did a great job.' }), techs, [tap()], 72);
  assert.deepEqual(r.credit.map((c) => c.tech_id).sort(), ['t_ronan', 't_sebastian']);
});

test('a name match on the wrong tech\'s tag does not steal credit', () => {
  const taps = [tap({ customer_name: 'David Kim' }), tap({ id: 'tap2', tech_id: 't_declan', customer_name: 'Maria Lopez' })];
  const r = matchReview(review(), techs, taps, 72);
  assert.deepEqual(r.credit.map((c) => c.tech_id), ['t_declan']);
});

test('mentions: techs who have left are not credited from new reviews', () => {
  const gone = [{ id: 't_old', name: 'Gustavo Oliveira', first_name: 'Gustavo', aliases: '', active: 0 }];
  assert.equal(mentionedTechs('Gustavo fixed it', gone).size, 0);
});

// ---------- customer name search ----------

test('search: letters match the start of any part of a name', () => {
  assert.deepEqual(matchName('Sebastian Grimes', 's'), { score: 3, ranges: [[0, 1]] });
  assert.deepEqual(matchName('Joao Arriola Santo', 's'), { score: 2, ranges: [[13, 14]] });
  assert.deepEqual(matchName('Sebastian Grimes', 'seb gr'), { score: 5, ranges: [[0, 3], [10, 12]] });
  assert.deepEqual(matchName('Sebastian Grimes', 'GRIMES'), { score: 2, ranges: [[10, 16]] });
  assert.equal(matchName('Sebastian Grimes', 'x'), null);
  assert.equal(matchName('Lorenzo Moreno', 's'), null, 'a single letter mid-word is not a match');
  assert.equal(matchName('Lorenzo Moreno', 'st'), null);
});

test('search: accents, mid-word fallback, empty box', () => {
  assert.deepEqual(matchName('Rónán Byrne', 'ronan'), { score: 3, ranges: [[0, 5]] });
  assert.deepEqual(matchName('José García', 'jose'), { score: 3, ranges: [[0, 4]] });
  assert.deepEqual(matchName('Sebastian Grimes', 'bast'), { score: 1, ranges: [[2, 6]] });
  assert.deepEqual(matchName('Sebastian Grimes', '   '), { score: 0, ranges: [] });
});

test('search: first names rank above last names', () => {
  const a = matchName('Sebastian Grimes', 's'), b = matchName('Joao Arriola Santo', 's');
  assert.ok(a.score > b.score);
});

// ---------- locations ----------

test('a visit sent to the other Google profile is only a suggestion when the evidence is weaker', () => {
  const late = T0 + 20 * HOUR;
  const same = matchReview(review({ reviewer_name: 'Maria L.', posted_at: late, location_id: 'sj' }), techs, [tap({ location_id: 'sj' })], 72);
  assert.equal(same.credit[0]?.tech_id, 't_sebastian');
  const other = matchReview(review({ reviewer_name: 'Maria L.', posted_at: late, location_id: 'hq' }), techs, [tap({ location_id: 'sj' })], 72);
  assert.equal(other.credit.length, 0);
  assert.equal(other.suggestions[0]?.tech_id, 't_sebastian');
  assert.match(other.suggestions[0].evidence[0], /sent to the other Google profile/);
});

test('visits from before locations were set up are matched as before', () => {
  const r = matchReview(review({ reviewer_name: 'Maria L.', posted_at: T0 + 20 * HOUR, location_id: 'hq' }), techs, [tap({ location_id: null })], 72);
  assert.equal(r.credit[0]?.tech_id, 't_sebastian');
});

// ---------- time zones ----------

test('local midnight in Los Angeles across the November DST change', () => {
  assert.equal(new Date(zonedMidnight(2026, 11, 1, 'America/Los_Angeles')).toISOString(), '2026-11-01T07:00:00.000Z');
  assert.equal(new Date(zonedMidnight(2026, 11, 2, 'America/Los_Angeles')).toISOString(), '2026-11-02T08:00:00.000Z');
});

test('this month compares against the same stretch of last month', () => {
  const at = Date.UTC(2026, 8, 28, 22, 0); // Sep 28, 3pm PDT
  const r = periodRange('month', 'America/Los_Angeles', at);
  assert.equal(new Date(r.start).toISOString(), '2026-09-01T07:00:00.000Z');
  assert.equal(new Date(r.prevStart).toISOString(), '2026-08-01T07:00:00.000Z');
  assert.equal(r.prevEnd - r.prevStart, at - r.start);
});

// ---------- added in the 1.2 audit ----------

test("mentions: possessives count (\"Sebastian's work\")", () => {
  const found = mentionedTechs("Sebastian's work was spotless, and Declan’s too.", techs);
  assert.ok(found.has('t_sebastian'));
  assert.ok(found.has('t_declan'));
});

test('two different customers with similar names: nobody is credited automatically', () => {
  const earlier = T0 - 3 * HOUR;
  const taps = [tap(), tap({ id: 'tap2', tech_id: 't_declan', customer_name: 'Maria Lee', created_at: earlier, rated_at: earlier, clicked_at: earlier })];
  const r = matchReview(review({ reviewer_name: 'Maria L.' }), techs, taps, 72);
  assert.deepEqual(r.credit, []);
  assert.deepEqual(r.suggestions.map((c) => c.tech_id).sort(), ['t_declan', 't_sebastian']);
});

test('one customer who rated both techs of a crew: both are credited', () => {
  const taps = [tap(), tap({ id: 'tap2', tech_id: 't_declan', created_at: T0 + MIN })];
  const r = matchReview(review(), techs, taps, 72);
  assert.deepEqual(r.credit.map((c) => c.tech_id).sort(), ['t_declan', 't_sebastian']);
});

test('tech links keep digits and dashes', () => {
  assert.equal(slugify('mike2'), 'mike2');
  assert.equal(slugify('Mike-2'), 'mike-2');
  assert.equal(slugify('José O’Brien'), 'jose-obrien');
  assert.equal(slugify('  --Ann  Marie-- '), 'ann-marie');
});

test("rate limits count an IPv6 visitor's whole /64 as one", () => {
  assert.equal(ipBucket('2001:db8:1:2:aaaa::1'), ipBucket('2001:db8:1:2:ffff:1:2:3'));
  assert.notEqual(ipBucket('2001:db8:1:2::1'), ipBucket('2001:db8:1:3::1'));
  assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipBucket('203.0.113.9'), '203.0.113.9');
  assert.equal(ipBucket('::ffff:203.0.113.9'), '203.0.113.9');
});

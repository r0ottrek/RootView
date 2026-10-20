// Location-based reviews: which Google profile a customer's button opens. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, describeGeo, geoFrom, normArea, parseAreas, pickLocation } from '../.test-build/geo.js';

const LOCS = [
  { id: 'hq', areas: ['Oak Park', 'Berwyn', '60302'] },
  { id: 'sj', areas: ['Evanston, IL', 'Skokie', '60201'] },
];
const wifi = (over) => ({ city: '', postal: '', region: 'IL', mobile: false, ...over });

test('areas: city names and ZIP codes are compared loosely', () => {
  assert.equal(normArea('Oak Park, IL'), 'oak park');
  assert.equal(normArea('  EVANSTON '), 'evanston');
  assert.equal(normArea('60302-1234'), '60302');
  assert.equal(normArea('St. Helena'), 'st helena');
});

test('areas: typed lists split on commas and lines, keeping "City, CA" together and dropping repeats', () => {
  assert.deepEqual(parseAreas('Oak Park, IL, Berwyn\n60302; Forest Park'), ['Oak Park', 'Berwyn', '60302', 'Forest Park']);
  assert.deepEqual(parseAreas('Berwyn, berwyn\r\nBERWYN,,'), ['Berwyn']);
  assert.deepEqual(parseAreas('Austin, Texas, USA\nRound Rock, TX; Toronto, ON, Canada'), ['Austin', 'Round Rock', 'Toronto'], 'any state, province or country');
  assert.deepEqual(parseAreas('Brooklyn, New York'), ['Brooklyn', 'New York'], 'New York is a city too');
  assert.deepEqual(parseAreas(''), []);
});

test("the tech's choice for today wins over everything else", () => {
  assert.deepEqual(pickLocation(LOCS, { today: 'sj', home: 'hq', geo: wifi({ city: 'Oak Park', postal: '60302' }) }), { id: 'sj', how: 'tech_today' });
});

test("the customer's ZIP code, then city, picks the location", () => {
  assert.deepEqual(pickLocation(LOCS, { geo: wifi({ city: 'Oak Park', postal: '60201' }) }), { id: 'sj', how: 'customer_area' }, 'ZIP beats city');
  assert.deepEqual(pickLocation(LOCS, { geo: wifi({ city: 'skokie', postal: '60076' }) }), { id: 'sj', how: 'customer_area' });
  assert.deepEqual(pickLocation(LOCS, { geo: wifi({ city: 'Berwyn' }) }), { id: 'hq', how: 'customer_area' });
});

test('a location named for the customer\'s city wins, even if a neighbor\'s service area lists it too', () => {
  const bay = [
    { id: 'op', label: 'Oak Park', areas: ['Oak Park', 'Chicago', 'Berwyn'] },
    { id: 'chi', label: 'Chicago', areas: [] },
  ];
  assert.deepEqual(pickLocation(bay, { geo: wifi({ city: 'Chicago', postal: '60614' }) }), { id: 'chi', how: 'customer_area' });
  assert.deepEqual(pickLocation(bay, { geo: wifi({ city: 'Berwyn' }) }), { id: 'op', how: 'customer_area' });
});

test('cell data is too rough to trust, so it falls through to the home location', () => {
  assert.deepEqual(pickLocation(LOCS, { home: 'hq', geo: { city: 'Evanston', postal: '60201', region: 'IL', mobile: true } }), { id: 'hq', how: 'tech_home' });
});

test("an area no location covers goes to the tech's home location, else the main one", () => {
  assert.deepEqual(pickLocation(LOCS, { home: 'sj', geo: wifi({ city: 'Fresno', postal: '93701' }) }), { id: 'sj', how: 'tech_home' });
  assert.deepEqual(pickLocation(LOCS, { geo: wifi({ city: 'Fresno' }) }), { id: 'hq', how: 'main' });
});

test('a removed location or stale choice is ignored', () => {
  assert.deepEqual(pickLocation(LOCS, { today: 'gone', home: 'gone' }), { id: 'hq', how: 'main' });
});

test('one location sends everyone there; none means no routing', () => {
  assert.deepEqual(pickLocation([LOCS[1]], { geo: wifi({ city: 'Oak Park' }) }), { id: 'sj', how: 'main' });
  assert.equal(pickLocation([], { today: 'sj' }), null);
});

test("Cloudflare's request data becomes a rough location, flagging cell carriers", () => {
  const home = geoFrom({ city: 'Evanston', postalCode: '60201', regionCode: 'IL', asn: 7922, asOrganization: 'Comcast Cable Communications, LLC' });
  assert.deepEqual(home, { city: 'Evanston', postal: '60201', region: 'IL', mobile: false });
  assert.equal(geoFrom({ city: 'Evanston', asn: 21928, asOrganization: 'T-Mobile USA, Inc.' }).mobile, true);
  assert.equal(geoFrom({ city: 'Oakland', asn: 22394, asOrganization: 'Cellco Partnership DBA Verizon Wireless' }).mobile, true);
  assert.equal(geoFrom({ city: 'Oakland', asn: 20057, asOrganization: 'AT&T Mobility LLC' }).mobile, true);
  assert.equal(geoFrom(undefined), null);
  assert.equal(geoFrom({ country: 'US' }), null);
  assert.equal(describeGeo(home), 'Evanston 60201');
  assert.equal(describeGeo({ city: 'Evanston', postal: '', region: '', mobile: true }), 'Evanston (cell data)');
});

test("today's date is the company's date, not UTC's", () => {
  assert.equal(dayKey(Date.UTC(2026, 9, 20, 5, 30), 'America/Los_Angeles'), '2026-10-19'); // 10:30 pm Oct 19 in SF
  assert.equal(dayKey(Date.UTC(2026, 9, 20, 8, 0), 'America/Los_Angeles'), '2026-10-20');
});

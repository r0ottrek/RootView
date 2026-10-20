/**
 * Location-based reviews: which Google profile a customer's review button points at.
 *
 *   1. The tech said where they're working today (tech app, one tap, resets overnight).
 *   2. The customer's internet connection is in a city or ZIP code a location covers. Cloudflare reports
 *      this on every request, with no pop-up. It's close on home internet but often wrong on cell data
 *      (carriers route through regional hubs), so cell connections skip this step.
 *   3. The tech's home location (Team → tech).
 *   4. The main location.
 *
 * Pure functions only, so the rules are easy to test.
 */
import { zonedParts } from './util';

export interface Geo { city: string; postal: string; region: string; mobile: boolean }
export type RouteHow = 'tech_today' | 'customer_area' | 'tech_home' | 'main';
export interface LocationLite { id: string; areas: string[]; label?: string }

export const HOW_LABEL: Record<RouteHow, string> = {
  tech_today: "tech's location today",
  customer_area: "customer's area",
  tech_home: "tech's home location",
  main: 'main location',
};

// Cell carriers and satellite internet: the address usually maps to a hub, not to where the phone is.
const MOBILE_ASNS = new Set([21928, 6167, 22394, 20057, 14593]); // T-Mobile, Verizon Wireless (2), AT&T Mobility, Starlink
const MOBILE_ORG = /wireless|mobility|t-mobile|cellular|mobile|starlink/i;

/** The rough location Cloudflare attaches to each request (request.cf), or null when there isn't one. */
export function geoFrom(cf: unknown): Geo | null {
  if (!cf || typeof cf !== 'object') return null;
  const c = cf as Record<string, unknown>;
  const city = typeof c.city === 'string' ? c.city : '';
  const postal = typeof c.postalCode === 'string' ? c.postalCode : '';
  if (!city && !postal) return null;
  const org = typeof c.asOrganization === 'string' ? c.asOrganization : '';
  return {
    city,
    postal,
    region: typeof c.regionCode === 'string' ? c.regionCode : '',
    mobile: MOBILE_ASNS.has(Number(c.asn)) || MOBILE_ORG.test(org),
  };
}

/** "Oak Park, IL" → "oak park"; "60302-1234" → "60302". */
export function normArea(s: string): string {
  const t = s.trim().toLowerCase();
  const zip = t.match(/^(\d{5})(?:-\d{4})?$/);
  if (zip) return zip[1];
  return t.replace(/,.*$/, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The state, province or country after a city ("Oak Park, IL", "Austin, Texas, USA"): any two-letter code, or a full
// name. New York and Washington are left out: they're cities too.
const STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'north carolina', 'north dakota', 'ohio', 'oklahoma',
  'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'west virginia',
  'wisconsin', 'wyoming', 'district of columbia', 'puerto rico', 'ontario', 'quebec', 'british columbia', 'alberta', 'manitoba', 'saskatchewan',
  'nova scotia', 'new brunswick', 'newfoundland and labrador', 'prince edward island', 'usa', 'united states', 'canada',
];
const STATE_PART = new RegExp(`^([a-z]{2}|${STATE_NAMES.join('|')})$`, 'i');

/** Areas as typed in Settings: one per line or comma separated. "Oak Park, IL" stays one area. */
export function parseAreas(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/[\r\n;]+/)) {
    const parts = line.split(',').map((p) => p.trim()).filter(Boolean);
    parts.forEach((part, i) => {
      // The ", IL" or ", Texas, USA" after a city. A state name with another place after it is a city itself
      // ("Riverside, Ontario, Upland").
      const next = parts[i + 1];
      const region = i > 0 && STATE_PART.test(part) && (part.length === 2 || !next || STATE_PART.test(next));
      if (!region) out.push(part.slice(0, 60));
    });
  }
  const seen = new Set<string>();
  return out.filter((a) => {
    const k = normArea(a);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 200);
}

export function pickLocation(
  locs: LocationLite[],
  o: { today?: string | null; home?: string | null; geo?: Geo | null },
): { id: string; how: RouteHow } | null {
  if (!locs.length) return null;
  const has = (id: string | null | undefined): id is string => !!id && locs.some((l) => l.id === id);
  if (has(o.today)) return { id: o.today, how: 'tech_today' };
  if (o.geo && !o.geo.mobile && locs.length > 1) {
    const zip = /^\d{5}/.test(o.geo.postal) ? o.geo.postal.slice(0, 5) : '';
    const city = normArea(o.geo.city);
    const byZip = zip ? locs.find((l) => l.areas.some((a) => normArea(a) === zip)) : undefined;
    // A location named for the customer's city wins, even when a neighbor's service area lists that city too.
    const named = (l: LocationLite) => !!l.label && normArea(l.label) === city;
    const byCity = city ? (locs.find(named) ?? locs.find((l) => l.areas.some((a) => normArea(a) === city))) : undefined;
    const hit = byZip ?? byCity;
    if (hit) return { id: hit.id, how: 'customer_area' };
  }
  if (has(o.home)) return { id: o.home, how: 'tech_home' };
  return { id: locs[0].id, how: 'main' };
}

/** What the office sees for a visit: "Oak Park 60302", or "Evanston (cell data)". */
export function describeGeo(g: Geo | null): string | null {
  if (!g) return null;
  const place = [g.city, g.postal].filter(Boolean).join(' ');
  return g.mobile ? `${place} (cell data)` : place;
}

/** A date in the company time zone, "2026-10-19". */
export function dayKey(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

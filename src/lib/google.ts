/**
 * Google Business Profile API: sign-in, profile list, reviews, replies.
 * Access must be approved first (free): https://developers.google.com/my-business/content/prereqs
 * Scope: business.manage. Reviews still live on the v4 endpoint.
 */
import type { Env } from '../env';
import { b64url, randomToken } from './util';

// "openid email" only so Settings can say which login is connected (each profile belongs to specific logins).
export const SCOPE = 'openid email https://www.googleapis.com/auth/business.manage';
export const STAR: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export interface GoogleReview {
  name: string; // accounts/1/locations/2/reviews/abc
  reviewId: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean };
  starRating?: string;
  comment?: string;
  createTime: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
}

/** PKCE (RFC 7636): the code Google returns is useless without the verifier, which stays in this browser's cookie and on the server. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function authUrl(env: Env, redirectUri: string, state: string, codeChallenge: string): string {
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    // Always show the account picker: the profiles belong to one specific login, not whoever happens to be signed in.
    prompt: 'select_account consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** Tells Google to cancel the grant, so a copy of the token (from an old database backup, say) stops working too. */
export async function revokeToken(token: string): Promise<void> {
  await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}

async function tokenRequest(env: Env, body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; email?: string }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID ?? '', client_secret: env.GOOGLE_CLIENT_SECRET ?? '', ...body }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(`Google sign-in failed: ${data.error_description ?? data.error ?? res.status}`);
  return { access_token: data.access_token, refresh_token: data.refresh_token, email: emailFromIdToken(data.id_token) };
}

/** The signed-in address from Google's id_token. Straight from Google's token endpoint over TLS, so the payload is only read, not verified. */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  const part = idToken?.split('.')[1];
  if (!part) return undefined;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { email?: unknown };
    return typeof json.email === 'string' ? json.email : undefined;
  } catch {
    return undefined;
  }
}

export function exchangeCode(env: Env, code: string, redirectUri: string, codeVerifier: string) {
  return tokenRequest(env, { code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier });
}

export async function accessToken(env: Env, refreshToken: string): Promise<string> {
  return (await tokenRequest(env, { refresh_token: refreshToken, grant_type: 'refresh_token' })).access_token;
}

async function gget<T>(token: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google API ${res.status}: ${detail.slice(0, 240)}`);
  }
  return res.json() as Promise<T>;
}

export async function listAccounts(token: string): Promise<{ name: string; accountName?: string }[]> {
  const data = await gget<{ accounts?: { name: string; accountName?: string }[] }>(token, 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  return data.accounts ?? [];
}

export interface GbpLocation {
  name: string;
  title?: string;
  storefrontAddress?: { addressLines?: string[]; locality?: string };
  metadata?: { placeId?: string; newReviewUri?: string };
  serviceArea?: { places?: { placeInfos?: { placeName?: string; placeId?: string }[] } };
}

export async function listLocations(token: string, account: string): Promise<GbpLocation[]> {
  const out: GbpLocation[] = [];
  let pageToken = '';
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({ readMask: 'name,title,storefrontAddress,metadata,serviceArea', pageSize: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const data = await gget<{ locations?: GbpLocation[]; nextPageToken?: string }>(token,
      `https://mybusinessbusinessinformation.googleapis.com/v1/${account}/locations?${q}`);
    out.push(...(data.locations ?? []));
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

export async function listReviews(token: string, account: string, location: string, pageToken?: string) {
  const q = new URLSearchParams({ pageSize: '50', orderBy: 'updateTime desc' });
  if (pageToken) q.set('pageToken', pageToken);
  return gget<{ reviews?: GoogleReview[]; nextPageToken?: string; averageRating?: number; totalReviewCount?: number }>(token,
    `https://mybusiness.googleapis.com/v4/${account}/${location}/reviews?${q}`);
}

export async function putReply(token: string, reviewName: string, comment: string): Promise<void> {
  const res = await fetch(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, {
    method: 'PUT',
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
  if (!res.ok) throw new Error(`Google rejected the reply (${res.status}): ${(await res.text().catch(() => '')).slice(0, 240)}`);
}

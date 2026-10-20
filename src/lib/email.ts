/**
 * Alert emails through the Resend REST API (resend.com). Does nothing until RESEND_API_KEY, a sender address
 * (Settings → Alerts, on a domain verified in Resend) and at least one recipient are set.
 *
 * Capped at 20 an hour and 60 a day across the whole site, so a flood of fake low ratings can't bury the inbox or
 * use up the sending quota. Call-back requests have their own allowance of the same size, so a flood of low ratings
 * can't stop a real "please call me" from arriving. The dashboard always shows everything, emailed or not.
 */
import type { Env } from '../env';
import { overLimit } from './auth';
import type { Settings } from './settings';
import { DAY, HOUR, line } from './util';

export async function sendAlert(env: Env, s: Settings, subject: string, text: string, pool: 'general' | 'callback' = 'general'): Promise<boolean> {
  if (!env.RESEND_API_KEY || !s.alert_emails.length || !s.alert_from) return false;
  const key = pool === 'callback' ? 'alerts:callback' : 'alerts';
  if ((await overLimit(env.DB, `${key}:hour`, 20, HOUR)) || (await overLimit(env.DB, `${key}:day`, 60, DAY))) {
    console.warn('[alert] hourly/daily email cap reached; alert shown in the dashboard only');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: s.alert_from, to: s.alert_emails, subject: line(subject, 140), text, tags: [{ name: 'kind', value: 'review-alert' }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error('[alert] Resend', res.status, (await res.text()).slice(0, 300));
    return res.ok;
  } catch (err) {
    console.error('[alert] send failed', err);
    return false;
  }
}

/**
 * Text a customer or reviewer wrote, set apart as a quote with web addresses defused, so a fake
 * "verify your account at https://…" comment can't pass for a real link from the business.
 */
export function quoted(text: string | null | undefined): string {
  const body = (text ?? '').trim();
  if (!body) return '> (no comment)';
  return body.split(/\r?\n/).map((l) => `> ${defang(l)}`).join('\n');
}

/** Web and email addresses made unclickable, for anything a customer typed (names, comments) that goes in an email. */
export function defang(text: string): string {
  return text.replace(/:\/\//g, '[://]').replace(/\bwww\./gi, 'www[.]').replace(/@/g, '[at]');
}

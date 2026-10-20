/**
 * Alert emails through the Resend REST API (resend.com). Does nothing until RESEND_API_KEY, a sender address
 * (Settings → Alerts, on a domain verified in Resend) and at least one recipient are set.
 *
 * Capped at 20 an hour and 60 a day across the whole site, so a flood of fake low ratings can't bury the inbox or
 * use up the sending quota. The dashboard always shows everything, emailed or not.
 */
import type { Env } from '../env';
import { overLimit } from './auth';
import type { Settings } from './settings';
import { DAY, HOUR, line } from './util';

export async function sendAlert(env: Env, s: Settings, subject: string, text: string): Promise<boolean> {
  if (!env.RESEND_API_KEY || !s.alert_emails.length || !s.alert_from) return false;
  if ((await overLimit(env.DB, 'alerts:hour', 20, HOUR)) || (await overLimit(env.DB, 'alerts:day', 60, DAY))) {
    console.warn('[alert] hourly/daily email cap reached; alert shown in the dashboard only');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: s.alert_from, to: s.alert_emails, subject: line(subject, 140), text, tags: [{ name: 'kind', value: 'review-alert' }] }),
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
  return body.split(/\r?\n/).map((l) => `> ${l.replace(/:\/\//g, '[://]').replace(/\bwww\./gi, 'www[.]')}`).join('\n');
}

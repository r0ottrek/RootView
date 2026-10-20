#!/usr/bin/env node
/**
 * Locked out? (Forgot the owner password, or lost the phone with the two-step codes, and there's no other owner.)
 * This makes a one-time "choose a new password" link for an office login, valid for 1 hour, and prints the one
 * command that activates it. Nothing is changed until you run that command yourself, with your Cloudflare login.
 *
 *   node scripts/owner-reset-link.mjs you@example.com https://reviews.example.com
 *
 * Using the link sets a new password, turns two-step sign-in off for that login (set it up again afterwards),
 * and signs out every other device.
 */
import { createHash, randomBytes } from 'node:crypto';

const [email, site] = process.argv.slice(2);
if (!email || !/^[^@\s'"]+@[^@\s'"]+\.[^@\s'"]+$/.test(email) || !site || !/^https?:\/\/[^\s'"]+$/.test(site)) {
  console.error('Usage: node scripts/owner-reset-link.mjs <office login email> <site address, e.g. https://reviews.example.com>');
  process.exit(1);
}

const token = randomBytes(24).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const expires = Date.now() + 60 * 60 * 1000;
const sql = `UPDATE admins SET invite_hash = '${hash}', invite_expires_at = ${expires}, totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE email = '${email.toLowerCase()}'`;

console.log(`
1. Run this (it needs your Cloudflare login, so only someone who runs the site can do it):

   npx wrangler d1 execute DB --remote --command "${sql}"

   It should say 1 row was changed. If it says 0, the email isn't an office login.

2. Within the hour, open:

   ${site.replace(/\/+$/, '')}/admin/invite/${token}

   and choose a new password. Then set up two-step sign-in again under Your account.
`);

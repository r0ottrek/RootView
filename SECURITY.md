# Security

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: on this repository, go to **Security → Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within a week. Fixes are released as soon as they're ready, with credit to you unless you'd rather not be named.

Only the latest release is supported.

## What protects a RootView site

**Accounts and sign-in**

- Three kinds of login, kept apart:
  - **Owners:** everything.
  - **Office managers:** day-to-day work. They can't change settings, branding, Google or logins. Point adjustments are capped at ±100.
  - **Technicians:** only their own app at `/me`.

  Each kind has its own `__Host-` cookie (HttpOnly, Secure, SameSite=Lax), and the session ids are stored only as SHA-256 hashes.
- Passwords are hashed with PBKDF2-SHA256 and a random salt each. The default is 20,000 rounds, set by `PASSWORD_ITERATIONS` up to Cloudflare's maximum of 100,000. Older hashes are upgraded at the next sign-in. Passwords must be at least 10 characters.
- New people get **single-use invite links** (72 hours) and choose their own password. Nobody ever sends a password.
- **Two-step sign-in (TOTP)** for office logins, with replay protection: each 30-second code works once.
- **Rate limits on sign-in.**
  - Office: 8 tries per email per connection, and 30 per connection, every 15 minutes.
  - Two-step codes: 5 per sign-in and 10 per account.
  - Techs: 8 per username per connection.
  - Attempts are counted before checking, so parallel guessing doesn't slip through.
  - Unknown accounts take as long to check as real ones, so timing doesn't reveal who has an account.
- Changing a password, finishing an invite or turning on two-step sign-in signs out other devices. Owners can sign a tech out of every phone, and see signed-in devices.
- First-run setup needs `SETUP_KEY` (at least 16 characters, not the example value). It closes for good once an owner exists, even if two requests race.

**Requests**

- **CSRF:** every form post must come from the site itself. This is checked with `Sec-Fetch-Site` (same-origin only, so sibling subdomains are refused) or `Origin`. The only exception is the scheduler endpoint, which needs its own bearer secret.
- **Content Security Policy:** `script-src 'self'` with no inline scripts, `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'` and `form-action 'self'`. Pages also send HSTS, `nosniff`, `X-Frame-Options: DENY`, COOP and a restrictive `Permissions-Policy`. Private pages are `Cache-Control: private, no-store`.
- **Body size limits:** 32 KB for forms, and larger only for the image uploads.
- **Public endpoints are rate-limited** per connection: visits, ratings, call-back requests and link clicks. There's also a site-wide cap on new visits and on alert emails. Over the limit, a customer still sees the review links; nothing is saved.
- **All SQL is parameterised.** Text that goes into emails or AI prompts is stripped of line breaks and control characters, quoted, and marked as untrusted.
- **Review links** can only point at the site they're for (google.com/g.page, yelp.com, bbb.org, facebook.com), over https.
- **Uploads:** logos, icons and photos must be PNG, JPEG or WebP. The server checks each file's actual bytes (its "magic number") and size. Images are served with `Content-Security-Policy: sandbox`. SVG is converted in the browser and never stored.
- **Theme values:** only `#rrggbb` colors and values from fixed lists reach the generated stylesheet.

**Data**

- With `ENCRYPTION_KEY` set, the Google refresh token and two-step keys are encrypted at rest (AES-256-GCM, with a random IV each time).
- Google sign-in uses OAuth with `state` and PKCE (S256). Disconnecting revokes the token at Google.
- Rate-limit records store an HMAC of the visitor's IP address, never the address itself, and are cleared after two days.
- **Retention:** a customer's rough area is cleared after 30 days, call-back numbers 90 days after the follow-up closes, and unfinished visits after 30 days. Owners can delete a customer's data on request.
- Thank-you pages, which show the customer's name, open only in the browser that left the rating, and only for 6 hours. Phone numbers are masked there.
- An **activity log** records who changed settings, logins, points, rewards, branding and Google, and when.

## Running it safely: a checklist

- [ ] Long random values for `SETUP_KEY`, `CRON_SECRET` and `ENCRYPTION_KEY`, set as secrets (`wrangler pages secret put`), never in `wrangler.jsonc` or git.
- [ ] A copy of `ENCRYPTION_KEY` kept somewhere safe.
- [ ] Two-step sign-in turned on for every owner, and for managers too if possible.
- [ ] A second owner, so one lost phone doesn't lock the business out. (`scripts/owner-reset-link.mjs` is the last resort.)
- [ ] Each person's own invite link, never a shared login.
- [ ] Departed techs and managers deactivated or removed. Deactivating signs a tech out at once.
- [ ] NFC tags locked after writing.
- [ ] `npm audit` and `npm run deploy` after updates.
- [ ] Regular database backups: `npx wrangler d1 export DB --remote --output backup.sql`. The file holds customer data, so store it like any other customer record.

## Known limits

- Customers aren't verified. Anyone with a tag link can leave a rating, so ratings are a signal for the office, not proof. Points for ratings are 0 by default.
- Rate limits are counted per connection, which Cloudflare reports. People behind one shared connection (an office or a campus) share a limit.
- Sign-in has no hard per-account lockout (that would let a stranger lock the owner out). Limits are per account *and* per connection instead.
- Anyone with access to your Cloudflare account can read and change the database. Protect that account with two-step sign-in too.

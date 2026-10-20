# Security

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: on this repository, go to **Security → Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within a week. Fixes are released as soon as they're ready, with credit to you unless you'd rather not be named.

Only the latest release is supported.

## What protects a RootView site

**Accounts and sign-in**

- Three kinds of login, kept apart:
  - **Owners:** everything.
  - **Office managers:** day-to-day work. They can't change settings, branding, Google or logins. Point adjustments are capped at ±100 at a time and 300 in any 24 hours, and every change is in the activity log.
  - **Technicians:** only their own app at `/me`.

  Each kind has its own `__Host-` cookie (HttpOnly, Secure, SameSite=Lax; Strict for the two-step step), and the session ids are stored only as SHA-256 hashes.
- Passwords are hashed with PBKDF2-SHA256 and a random salt each. The default is 20,000 rounds, set by `PASSWORD_ITERATIONS` up to Cloudflare's maximum of 100,000. Older hashes are upgraded at the next sign-in. Passwords must be at least 10 characters.
- New people get **single-use invite links** (72 hours) and choose their own password. Nobody ever sends a password. Two people opening the same link at once can't both use it.
- **Two-step sign-in (TOTP)** for office logins, with replay protection: each 30-second code works once. Turning it on needs your password as well as a code.
- **Rate limits on sign-in**, counted before checking so parallel guessing doesn't slip through:
  - Per connection: 30 tries every 15 minutes. An IPv6 connection's whole /64 counts as one, since one household or server controls billions of those addresses.
  - Per account per connection: 8 tries every 15 minutes (office logins and techs alike).
  - Per account across every connection: 40 tries an hour, so guessing from many addresses at once still runs out. Connections the account signed in from in the last 60 days don't count toward this, so a stranger can't lock someone out of their usual phone or computer.
  - Two-step codes: 5 per sign-in and 10 per account every 15 minutes.
  - Unknown accounts take as long to check as real ones, so timing doesn't reveal who has an account.
  - Rate-limit records hold a hash of the typed email or username, never the text itself.
- Changing a password, finishing an invite or turning on two-step sign-in signs out other devices. Anyone in the office can sign a tech out of every phone and see their signed-in devices.
- First-run setup needs `SETUP_KEY` (at least 16 characters with some variety, not the example value). It closes for good once an owner exists, even if two requests race.

**Requests**

- **CSRF:** every form post must come from the site itself. This is checked with `Sec-Fetch-Site` (same-origin only, so sibling subdomains are refused) or `Origin`. The only exception is the scheduler endpoint, which needs its own bearer secret.
- **Content Security Policy:** `script-src 'self'` with no inline scripts, `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'` and `form-action 'self'`. Pages also send HSTS, `nosniff`, `X-Frame-Options: DENY`, COOP and a restrictive `Permissions-Policy`. Private pages are `Cache-Control: private, no-store`.
- **Body size limits:** 32 KB for forms, and larger only for the image uploads.
- **Public endpoints are rate-limited** per connection: visits, ratings, call-back requests and link clicks. There's also a site-wide cap on new visits and on alert emails (call-back requests have their own allowance, so a flood of low ratings can't crowd them out). Over the limit, a customer still sees the review links; nothing is saved.
- **All SQL is parameterised.** Names and comments customers type are quoted in alert emails with web and email addresses made unclickable. Review text sent for AI drafts has control characters removed and can't close the block it's quoted in; a person always reads a draft before it's posted.
- **Review links** can only point at the site they're for (Google, Yelp, BBB or Facebook's own addresses, not, say, sites.google.com), over https, and never at a link that forwards somewhere else.
- **Uploads:** logos, icons and photos must be PNG, JPEG or WebP. The server checks each file's actual bytes (its "magic number"), encoding and size. Images are served with `Content-Security-Policy: sandbox` and `nosniff`. SVG is converted in the browser and never stored.
- **Theme values:** only `#rrggbb` colors and values from fixed lists reach the generated stylesheet.
- **Outbound calls** (Google, Resend, Anthropic) have timeouts, so a slow service can't hang a page.

**Data**

- With `ENCRYPTION_KEY` set, the Google refresh token and two-step keys are encrypted at rest (AES-256-GCM, with a random IV each time). Pages that only need to know whether Google is connected never decrypt it.
- Google sign-in uses OAuth with `state` and PKCE (S256). Disconnecting revokes the token at Google.
- Rate-limit records store an HMAC of the visitor's IP address, never the address itself. They're cleared after two days, except the "signed in from here before" markers, which are kept 60 days.
- **Retention:** a customer's rough area is cleared after 30 days, call-back numbers 90 days after the follow-up closes (180 days at most), and unfinished visits after 30 days. The customer's name, rating and comment stay with the visit until an owner deletes it (Settings → Privacy), which also removes the points, credit and "likely match" hints it produced. The activity log records deletions by id, not by name.
- Thank-you pages, which show the customer's name, open only for the browser that left the rating (it holds the visit's cookie), and only for 6 hours. Phone numbers are masked there.
- An **activity log** records who changed settings, logins, points, rewards, branding and Google, and when.

## Running it safely: a checklist

- [ ] Long random values for `SETUP_KEY`, `CRON_SECRET` and `ENCRYPTION_KEY` (`node scripts/secrets.mjs` makes them), set as secrets (`wrangler pages secret put`), never in `wrangler.jsonc` or git.
- [ ] A copy of `ENCRYPTION_KEY` kept somewhere safe.
- [ ] Two-step sign-in turned on for every owner, and for managers too if possible.
- [ ] A second owner, so one lost phone doesn't lock the business out. (`scripts/owner-reset-link.mjs` is the last resort.)
- [ ] Each person's own invite link, never a shared login.
- [ ] Departed techs and managers deactivated or removed. Deactivating signs a tech out at once.
- [ ] NFC tags locked after writing.
- [ ] `npm audit` and `npm run deploy` after updates.
- [ ] Regular database backups, kept outside the project folder: `npx wrangler d1 export DB --remote --output ../rootview-backup.sql`. The file holds customer data, so store it like any other customer record.
- [ ] Optional, on top of the built-in limits: a Cloudflare rate-limiting rule for `/admin/login`, `/me/login` and `/setup`.

## Known limits

- Customers aren't verified. Anyone with a tag link can leave a rating, so ratings are a signal for the office, not proof. Points for ratings are 0 by default.
- Rate limits are counted per connection, which Cloudflare reports. People behind one shared connection (an office or a campus) share a limit.
- Office managers can make sign-in links for techs, and approve reward requests. That's their job, so give the role only to people you'd trust with it; the activity log shows what each person did.
- Anyone with access to your Cloudflare account can read and change the database. Protect that account with two-step sign-in too.

# Changelog

What changed in each release. Upgrading? Pull the new code, then run `npm install`, `npm run db:migrate:remote` and `npm run deploy` (see the README's "Updating later").

## 1.3.0 (2026-10-20)

### Changed

- **Credit a whole crew at once.** "Credit to…" is now a list of tick boxes, on the review list, the review page and "Add a review", so any number of techs can share a review in one go (each gets full credit and points). Before, you could pick two at a time.

## 1.2.0 (2026-10-20)

### Added

- **Two ways to set up.** `CLAUDE.md` is a step-by-step playbook that lets [Claude Code](https://claude.com/claude-code) install and deploy RootView for you, pausing for your OK before it changes your Cloudflare account. The README covers doing it yourself.
- `scripts/secrets.mjs` makes the three production secrets and sends them to Cloudflare without showing them on screen.
- Database migration `0002_indexes.sql`: indexes that keep D1's "rows read" low as your data grows.

### Changed

- **New look.** A quieter interface with a desert-sky blue and sage palette, IBM Plex Sans, and a new default app icon. Every preset passes the built-in readability check.
- The local preview and tests need Node.js 24 or newer (the current LTS).
- `cron/wrangler.jsonc` ships with an empty `APP_URL`: set it to your site's address before deploying the scheduler.
- Old data is cleaned up once a day instead of every 15 minutes.

### Security

- Sign-in limits count an IPv6 visitor's whole /64 as one, and add a per-account cap that skips the phones and computers the account signed in from recently, so nobody can be locked out of their own.
- Invite links can't be used twice at once. Turning on two-step sign-in asks for your password.
- Office managers can give at most 300 points in 24 hours.
- Review links must use the review site's own address and can't forward somewhere else.
- Deleting a customer's data also removes their name from matching hints and from the activity log. Call-back numbers are deleted after 180 days at most.
- Names in alert emails have links made unclickable; review text sent for AI drafts can't pose as instructions; every call to Google, Resend and Anthropic has a timeout.

### Fixed

- A review that says "Maya's work was great" now credits Maya.
- Tech links can contain digits and dashes, so a second "Mike" can be `mike-2`.
- Two different customers with similar names no longer both get credited automatically: the office picks.
- Review matching stays inside Cloudflare's free-plan CPU budget, and keeps the Google history import's place after a hiccup.
- "Clicks that became reviews" can't go over 100%.
- Tapping Continue twice no longer errors, and a closed follow-up stays closed.
- Tag and QR links use the site's own address when "Address written on tags" is empty, and a brand-new site's home page leads to setup.

### Accessibility

- Readable grey text and form borders in every theme, a visible focus ring everywhere, outlined rating stars, underlined links in text, and Windows high-contrast support.
- The "Who helped you today?" search works with a keyboard and without JavaScript; status messages and copy buttons are announced to screen readers.

## 1.0.0 (2026-10-20)

First public release: a page per technician behind an NFC tag or QR code, Google review matching, a leaderboard and rewards, a separate tech app, owner-controlled branding and themes, and Google Business Profile import, all on Cloudflare's free plan.

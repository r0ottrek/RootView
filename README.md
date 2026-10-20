# RootView

**Self-hosted review tracking for field-service teams.** Every technician gets their own NFC tag or QR code. A customer taps it, rates the visit, and picks where to leave a public review. When the review shows up on Google, RootView works out which tech earned it and credits them, with points they can trade for rewards.

It's built for plumbers, electricians, HVAC, cleaners, locksmiths, landscapers, or any business whose people go to the customer. It runs on Cloudflare's free plan, has no monthly fees, and keeps your customers' data in your own account.

[![CI](https://github.com/r0ottrek/RootView/actions/workflows/ci.yml/badge.svg)](https://github.com/r0ottrek/RootView/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

| | |
|---|---|
| ![Customer rating page](docs/screenshots/customer.jpg) | ![Office dashboard](docs/screenshots/dashboard.jpg) |
| ![Branding: colors, logo and icon](docs/screenshots/branding.jpg) | ![The technician app](docs/screenshots/tech-app.jpg) |

---

## What you get

- **A page per tech.** The tech's tag or QR code opens a page with their photo. The customer rates the visit and types their name, and Google, Yelp, BBB or Facebook is one tap away.
- **Reviews matched to the right person.** Google never says which link a reviewer came from, so RootView matches on the name the customer typed, how soon the review followed the visit, and whether the review names the tech. Sure matches are credited automatically; likely ones wait for one click. [How it works](#how-a-review-gets-credited).
- **A separate app for techs.** Each tech signs in with their own username and password to see their reviews, leaderboard rank, QR code and points, and to request rewards. They can't see the office dashboard or anyone else's customers.
- **An office dashboard.** Shows reviews per week, a leaderboard, conversion from tap to review, and low ratings to call back. You can reply to Google reviews (with optional AI drafts) and run a rewards catalog.
- **Your brand, set up in the browser.** Upload a logo and app icon, choose a preset or any colors you like, and pick corner style and fonts. A live preview and a built-in readability check show the result. No code needed.
- **Several locations.** With two or more Google profiles, each customer is sent to the profile for where the job was.
- **Honest by design.** Every customer sees the review links, whatever rating they give. Hiding them from unhappy customers ("review gating") breaks Google's rules. Unhappy customers are also offered a call-back, so the office can make it right.

## Who signs in where

| Address | Who | What they can do |
|---|---|---|
| `/<tech>` (e.g. `/maya?s=nfc`) | Customers | Rate the visit and choose a review site. No account needed. |
| `/` | Customers | "Who helped you today?" search, for a company-wide QR code |
| `/me` | **Technicians** | Their own reviews, rank, QR code, points and rewards. Separate login. |
| `/admin` | **Office managers** | Reviews, credit, follow-ups, team, tag activity, reward requests |
| `/admin` | **Owners** | All of the above, plus settings, branding, Google, office logins, activity log and privacy requests |

---

## Two ways to set it up

### Option A: let Claude Code do it

This repo includes a [`CLAUDE.md`](CLAUDE.md), a step-by-step setup playbook for [Claude Code](https://claude.com/claude-code), Anthropic's coding assistant for the terminal. Claude Code reads that file automatically when you open the folder.

```bash
git clone https://github.com/r0ottrek/RootView.git rootview
cd rootview
claude
```

Then say **"Set up RootView for me."** Claude asks whether you want a local demo or a live site, checks your computer, starts the preview, and, once you say yes, creates the Cloudflare database and project, sets the secrets and deploys.

A few things stay with you:

- You sign in to Cloudflare in your browser.
- You create your own owner login on `/setup`.
- You type any API keys from Google, Resend or Anthropic into your own terminal.

Secrets are generated on your computer and saved in a git-ignored `.prod-secrets` file; they're never shown in the chat.

### Option B: do it yourself

Follow the guide below. [Try it on your computer](#try-it-on-your-computer-5-minutes) takes about 5 minutes. [Deploy to Cloudflare](#deploy-to-cloudflare-free-plan) takes about 15, plus [first steps in the app](#first-steps-in-the-app). No step needs more than copy and paste.

---

## Try it on your computer (5 minutes)

You need [Node.js](https://nodejs.org) 22.13 or newer.

```bash
git clone https://github.com/r0ottrek/RootView.git rootview
cd rootview
npm install
cp .dev.vars.example .dev.vars
```

Open `.dev.vars` and fill in `SETUP_KEY`, `CRON_SECRET` and `DEMO_ADMIN_PASSWORD`. Any long random strings will do; this command makes one:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Then start the preview with made-up demo data (the demo company is also called "RootView"):

```bash
npm run dev:demo
```

Open http://localhost:8787:

- **Office:** http://localhost:8787/admin, signing in as `owner@demo.test` with your `DEMO_ADMIN_PASSWORD`.
- **Tech app:** http://localhost:8787/me/login, signing in as `maya` with the same password.
- **Customer page:** http://localhost:8787/maya

To start empty instead, run `npm run dev -- --reset` and open http://localhost:8787/setup.

> The local preview runs the real app on Node, with Node's built-in SQLite standing in for Cloudflare D1. It doesn't need Cloudflare's local runtime (which needs the Visual C++ Redistributable on Windows).

---

## Deploy to Cloudflare (free plan)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up). All of this runs from the project folder. If you skipped the local preview, run the `git clone`, `cd` and `npm install` lines from [Try it on your computer](#try-it-on-your-computer-5-minutes) first.

The steps use the name `rootview`. To use another name, change `"name"` and `"database_name"` in `wrangler.jsonc` now, and use your name wherever `rootview` appears below.

**1. Sign in and create the database**

```bash
npx wrangler login
npx wrangler d1 create rootview
```

If it asks whether to add the database to your config, answer **No**. Copy the `database_id` it prints into `wrangler.jsonc`, replacing `00000000-0000-0000-0000-000000000000`. Keep `"binding": "DB"` as it is.

**2. Create the tables**

```bash
npm run db:migrate:remote
```

**3. Create the Pages project and set its secrets**

```bash
npx wrangler pages project create rootview --production-branch main
```

It prints your site's address, normally `https://rootview.pages.dev` (Cloudflare adds a suffix if that name is taken). Note it down; `npx wrangler pages project list` shows it again.

The app needs three secrets. This makes them and saves them in `.prod-secrets` in the project folder. Git ignores that file, so it's never uploaded:

```bash
node scripts/secrets.mjs
```

Then send each one to Cloudflare. Nothing is shown on screen:

```bash
node scripts/secrets.mjs --get SETUP_KEY | npx wrangler pages secret put SETUP_KEY
node scripts/secrets.mjs --get CRON_SECRET | npx wrangler pages secret put CRON_SECRET
node scripts/secrets.mjs --get ENCRYPTION_KEY | npx wrangler pages secret put ENCRYPTION_KEY
```

Save a copy of `.prod-secrets` in your password manager. Without `ENCRYPTION_KEY`, the stored Google connection and two-step sign-in keys can't be read.

<details>
<summary>Prefer to make your own values?</summary>

Run `npx wrangler pages secret put SETUP_KEY` (and the same for `CRON_SECRET` and `ENCRYPTION_KEY`). Each one asks for a value:

- `SETUP_KEY` and `CRON_SECRET`: any random string of 16 or more characters.
- `ENCRYPTION_KEY`: exactly 32 bytes, base64. Make it with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
</details>

**4. Deploy**

```bash
npm run deploy
```

It also prints a one-off link like `https://1a2b3c4d.rootview.pages.dev`. That link stays on this exact version forever, so don't use it for the steps below: use the address from step 3.

**5. Create your owner account**

Open `https://<your address>/setup` and paste the `SETUP_KEY` from `.prod-secrets`. Then create the owner login. Setup closes for good once an owner exists.

**6. Turn on the 15-minute scheduler**

The scheduler imports Google reviews, retries missed alerts and clears out old data. Put your address in `cron/wrangler.jsonc` (`APP_URL`), then:

```bash
npm run deploy:cron
node scripts/secrets.mjs --get CRON_SECRET | npx wrangler secret put CRON_SECRET --config cron/wrangler.jsonc
```

The scheduler and the site must share the same `CRON_SECRET`, which this does.

**7. (Optional) Use your own domain**

Go to Cloudflare dashboard → Workers & Pages → your project → Custom domains → add, for example, `reviews.yourcompany.com`. If your DNS is somewhere else, add the one CNAME record Cloudflare shows you. Then set **Settings → Address written on tags** to that address **before** you write any NFC tags. If you use Google Business Profile, also add `https://reviews.yourcompany.com/admin/google/callback` as an authorized redirect URI in Google Cloud.

**Updating later:** first commit your own changes to `wrangler.jsonc` and `cron/wrangler.jsonc` (`git commit -am "my deploy settings"`) so `git pull` can merge. Then:

```bash
git pull
npm install
npm run db:migrate:remote
npm run deploy
```

Run `npm run deploy:cron` too if anything in `cron/` changed.

---

## First steps in the app

Owners see a "Finish setting up" checklist on the dashboard. Work through these:

1. **Branding:** your business name, logo, app icon and colors.
2. **Settings → Review sites:** your Google review link. In Google Business Profile, "Ask for reviews" gives you this link. Yelp, BBB and Facebook are optional.
3. **Team → Add a tech:** for each tech. Their link (e.g. `/maya`) is also their username.
4. **Each tech's page → Make an invite link:** text or email it. The tech opens it once, chooses a password, and adds the app to their home screen.
5. **Write the NFC tags.** See [NFC tags](#nfc-tags). Each tech's page also has a QR code and a printable card.
6. **Settings → Alerts:** who gets emailed about low ratings.
7. **Your account → Two-step sign-in:** strongly recommended for every owner.
8. **Settings → Google Business Profile** (optional): so reviews come in by themselves.

---

## Branding and themes

Everything is under **Admin → Branding** (anyone in the office can look; only owners can change it):

- **Business details:** name, office phone (customers can tap to call it), website and privacy policy link.
- **Logo:** any PNG, JPEG, WebP or SVG. It's resized in your browser and shown in page headers, on printed cards and in the tech app.
- **App icon:** a square image. It becomes the browser tab icon, the home-screen icon of the tech app, and the mark beside your name when there's no logo. You choose its background color and padding.
- **Colors:** start from a preset (Midnight, Graphite, Forest, Daylight, Sand, Harbor), or choose your own:
  - page background, panels and text;
  - an **action color** for buttons and links;
  - a **highlight color** for stars and "credited".
- **Mode, corners and fonts:**
  - dark or light;
  - sharp, soft or round corners;
  - a modern sans, a classic serif, engraved capitals or the device's own font.

The preview updates as you change things, and a readability check warns when text would be hard to read (it uses the WCAG contrast guidelines). Every page uses the new look straight away: customer pages, the tech app, the dashboard and printed cards.

<details>
<summary>For developers: how theming works</summary>

The owner's choices are stored as one validated object (`src/lib/theme.ts`). Only `#rrggbb` colors and values from fixed lists are accepted. The server turns it into about 40 CSS custom properties: hover tints, borders, readable text colors on buttons, and so on. It serves them as `/theme.css`, versioned by a hash so browsers fetch a new copy only when the theme changes. `public/styles.css` uses only those tokens, apart from white QR-code backgrounds, print styles and shadows.

To add a preset, add an entry to `PRESETS` in `src/lib/theme.ts`. The tests check that every preset passes the readability check.

Uploaded images are re-encoded in the browser, checked by the server (type, magic bytes and size), stored in D1, and served from `/asset/*` with `Content-Security-Policy: sandbox` and `nosniff`. SVG files are converted to PNG or WebP first, so no SVG is ever served back.
</details>

---

## How a review gets credited

Every review is scored on three clues:

1. **Name.** The customer typed their name on the tech's page, and Google shows the reviewer's name. "Maria L." matches "Maria Lopez".
2. **Timing.** How soon after the tag visit the review was posted, and whether the customer pressed that site's button.
3. **Mention.** The review names the tech ("Maya was great"). Nicknames can be added for each tech.

A score of 80 or more credits the tech automatically. From 40 to 79, the review waits under **Reviews → Needs a tech** with a one-click "Credit Maya · likely" button. Every credit shows its evidence. A crew of two can share a review, and both techs get full credit.

The rules are in `src/lib/match.ts`, covered by `test/match.test.mjs`.

### Several locations

With two or more Google profiles (Settings → Locations), each customer's Google button opens the profile for where the job was. The first rule that applies wins:

1. **The tech's choice for today:** tech app → "Where are you working today?" It resets overnight.
2. **The customer's area:** Cloudflare reports a rough city and ZIP code for each visitor, with no pop-up. Cell data skips this step, because carrier locations are often wrong.
3. **The tech's home location:** Team → tech.
4. **The main location.**

Each location can add bonus points per review, which helps grow a newer profile.

---

## Connecting Google Business Profile (optional)

Without this, Google reviews can be added by hand. With it, they come in every 15 minutes, and you can post replies from the dashboard.

1. [Request Business Profile API access](https://developers.google.com/my-business/content/prereqs) for a Google Cloud project. It's free, and approval takes a few days.
2. In that project, enable:
   - My Business Account Management API
   - My Business Business Information API
   - Google My Business API
3. **OAuth consent screen:** choose **Internal** if you use Google Workspace. Otherwise choose **External** and **publish** the app; apps left in "Testing" lose access after 7 days.
4. **Credentials → Create OAuth client → Web application.** Authorized redirect URI: `https://<your address>/admin/google/callback`
5. Save the client ID and client secret (each command asks for the value), then redeploy so the site picks them up:
   ```bash
   npx wrangler pages secret put GOOGLE_CLIENT_ID
   npx wrangler pages secret put GOOGLE_CLIENT_SECRET
   npm run deploy
   ```
6. In the app, go to **Settings → Google Business Profile → Connect Google**. Sign in with the Google account that manages your profiles, then tick the profiles to track.

Only profiles that the connected Google login manages can be imported. To add one, make that login a Manager on the profile (Business Profile → People and access).

## Email alerts (optional)

Low ratings, call-back requests and reward requests can be emailed to the office through [Resend](https://resend.com):

1. Verify your sending domain with Resend.
2. Set the secret, then redeploy:
   ```bash
   npx wrangler pages secret put RESEND_API_KEY
   npm run deploy
   ```
3. In the app, fill in **Settings → Alerts**.

Without this, alerts still show in the dashboard.

## AI reply drafts (optional)

Get an API key at [console.anthropic.com](https://console.anthropic.com), then:

```bash
npx wrangler pages secret put ANTHROPIC_API_KEY
npm run deploy
```

The dashboard can then draft replies to Google reviews. Someone always reads a draft before it posts. `AI_MODEL` overrides the default model. Drafting is limited to 30 per hour per office user.

## NFC tags

NTAG213 or NTAG215 stickers or cards work well, and are cheap in packs of 25 to 50. To write one:

1. Install an NFC writing app (NFC Tools is free on iPhone and Android).
2. Write a URL record with the tech's NFC link from their Team page.
3. Test it with a phone that isn't signed in.
4. **Lock** the tag. Locking is permanent and stops anyone rewriting it.

Each tech's page also has a QR code (download as SVG) and a printable business card and sticker in your colors.

---

## Security

Short version:

- separate logins for owners, office managers and technicians;
- passwords hashed with PBKDF2;
- optional two-step sign-in (authenticator app);
- invite links in place of shared passwords;
- every sign-in and public form rate-limited;
- CSRF protection on every form, and a strict Content Security Policy;
- secrets optionally encrypted at rest (AES-256-GCM);
- an activity log for owners;
- automatic clean-up of customer data.

Details, and how to report a vulnerability: [SECURITY.md](SECURITY.md).

**Locked out?** If you've lost the only owner's password or two-step device, run:

```bash
node scripts/owner-reset-link.mjs you@example.com https://reviews.example.com
```

It prints a one-time reset link, plus the single `wrangler` command that activates it with your Cloudflare login. Run that command from the project folder.

**Removing an owner:** owners can't be removed in the app, so nobody can lock the others out. Make them a manager first, from the project folder, then remove them under **Settings → Office logins**:

```bash
npx wrangler d1 execute DB --remote --command "UPDATE admins SET role='manager' WHERE email='old-owner@example.com'"
```

## Privacy

Customers see a short notice on the rating page saying what's collected and why. Some of it is cleared automatically:

- a customer's rough area after 30 days;
- a call-back number 90 days after the follow-up closes (180 days at most);
- unfinished visits after 30 days.

The name, rating and comment stay with the visit, because they're the record of who helped whom. Owners can find and delete a customer's data on request (Settings → Privacy). Set your own privacy policy link under Branding.

## Limits on the free plan

Cloudflare's free plan allows 100,000 requests a day and 5 GB of D1 storage. That's far more than a 50-tech company needs.

Each request may use at most 10 ms of CPU time, which is why password hashing defaults to 20,000 PBKDF2 rounds and reviews are matched a few at a time. On Workers Paid, run `npx wrangler pages secret put PASSWORD_ITERATIONS`, enter `100000` (the most Cloudflare's Web Crypto allows), then `npm run deploy`. Existing passwords are upgraded the next time each person signs in.

---

## Development

```bash
npm run dev           # local preview at http://localhost:8787 (keeps data between runs)
npm run dev:demo      # same, with fresh demo data
npm test              # unit tests + an end-to-end run through the real app
npm run check         # TypeScript
npm run preview:dist  # build exactly what's deployed and run it locally (replaces local data with demo data)
```

| Folder | What's in it |
|---|---|
| `src/index.tsx` | Routes, security headers, CSRF guard |
| `src/routes/` | `public.tsx` (customers), `tech.tsx` (tech app), `auth.tsx` (setup and sign-in), `admin/*` (office) |
| `src/lib/` | Matching, location routing, Google, sessions and passwords, TOTP, encryption, theme, settings |
| `src/views/` | Layout and shared components (server-rendered JSX, no client framework) |
| `public/` | `styles.css` (token-based), `app.js` (progressive enhancement only), fonts, default icons |
| `migrations/` | D1 schema |
| `cron/` | The 15-minute scheduler Worker |
| `scripts/` | Local preview, demo data, Pages build, production secrets, owner reset |

Stack: [Hono](https://hono.dev), server-rendered JSX, Cloudflare Pages and D1, and TypeScript. Every page works without JavaScript, except image uploads (images are resized in the browser first).

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## FAQ

**Is asking customers for reviews allowed?**
Google allows it, as long as you don't offer incentives to customers and don't filter who gets asked. RootView shows the review links to everyone. Yelp asks businesses not to solicit reviews at all, so Yelp is off by default; turn it on knowing that.

**Do techs get rewarded for reviews?**
Yes. Techs earn points from your own rewards catalog, which is an internal staff incentive. Customers are never offered anything.

**Can techs give themselves points by tapping their own tag?**
Ratings on a tag earn 0 points by default, and staff phones signed in to the app aren't counted as visits.

## License

[MIT](LICENSE). Bundled fonts: IBM Plex Sans and Cinzel, under the SIL Open Font License (`public/fonts/OFL-*.txt`).

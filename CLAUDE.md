# CLAUDE.md

Guide for Claude Code (and other coding agents) working in this repository. People: the README has everything here
in long form. If you use Claude Code, open this folder, run `claude`, and say **"Set up RootView for me."**

RootView is a self-hosted review tracker for field-service businesses: Hono server-rendered JSX on Cloudflare
Pages, with D1 (SQLite) for storage and a small Worker in `cron/` that runs every 15 minutes.

---

## Setting RootView up for someone

When the user asks you to set up, install, try, deploy or host RootView, follow this playbook. Work through it one
phase at a time, say what you're about to do before each phase, and stop at every **Checkpoint** for their answer.

### Ground rules (always)

- **Secrets never appear in the chat.** Generate them with `node scripts/secrets.mjs` (writes the git-ignored
  `.prod-secrets`) and pipe them into wrangler with `--get`. Don't `cat`, `echo` or print `.prod-secrets` or
  `.dev.vars`, and don't paste their values into messages. When the user needs a value (the setup key), tell them
  which file and line to open.
- **API keys from other services** (Google, Resend, Anthropic) are typed by the user. Give them the exact
  `npx wrangler pages secret put NAME` command to run in their own terminal (in Claude Code they can prefix it
  with `!`), which prompts for the value without echoing it. Never ask them to paste a key into the chat.
- **The user creates their own accounts and passwords.** You don't fill in `/setup`, sign-in forms or the
  Cloudflare/Google sign-up pages for them.
- **Ask before anything that changes their Cloudflare account**: creating the database, the Pages project, the
  scheduler, secrets, or deploying. One "yes" for the whole deploy phase is fine; get it before Phase 3.
- Never commit `.dev.vars`, `.prod-secrets` or any file with a real value in it. Never run `npm run dev -- --reset`
  or delete `.dev-node/` if the user has local data they care about.
- Don't weaken security to get past an error (turning off the CSRF guard, CSP, rate limits, cookie flags, or the
  setup key check). Find the real cause.
- No review gating: every customer must always be able to reach the public review sites, whatever rating they give.

### Phase 0: Ask what they want

**Checkpoint.** Ask, in one message:

1. Just try it on this computer with demo data, or put it online for real (Cloudflare, free plan)?
2. If online: do they have a Cloudflare account? (Free sign-up at https://dash.cloudflare.com/sign-up; they do it.)
   A project name (default `rootview`, lowercase letters, numbers and dashes)? Their own domain later, e.g.
   `reviews.theircompany.com` (optional)?
3. Optional extras, any time later: Google Business Profile import, email alerts (Resend), AI reply drafts (Anthropic).

### Phase 1: Check the computer

```bash
node --version   # needs 24 or newer (the current LTS; the local preview uses its built-in SQLite)
git --version
npm install
```

If Node is missing or too old, point them to https://nodejs.org (LTS) and wait. On Windows the local preview
doesn't need Visual C++ or WSL.

### Phase 2: Local preview (always do this first, even when deploying)

1. `cp .dev.vars.example .dev.vars` (PowerShell: `Copy-Item .dev.vars.example .dev.vars`).
2. Fill in `SETUP_KEY` and `CRON_SECRET` in `.dev.vars` with random values, writing the file with a script so the
   values never show, for example:
   ```bash
   node -e "const fs=require('fs'),r=()=>require('crypto').randomBytes(24).toString('base64url');let s=fs.readFileSync('.dev.vars','utf8');s=s.replace(/^SETUP_KEY=$/m,'SETUP_KEY='+r()).replace(/^CRON_SECRET=$/m,'CRON_SECRET='+r());fs.writeFileSync('.dev.vars',s)"
   ```
3. **Checkpoint.** Ask the user to choose a demo password (10+ characters; it's only for this local demo) and set
   `DEMO_ADMIN_PASSWORD` to it. Or generate one the same way and tell them it's on the `DEMO_ADMIN_PASSWORD` line.
4. Start it in the background: `npm run dev:demo` (port 8787; another port: `PORT=8790 npm run dev:demo` in bash,
   `$env:PORT=8790; npm run dev:demo` in PowerShell).
5. Tell them where to look:
   - Office: http://localhost:8787/admin, email `owner@demo.test`, their demo password.
   - Tech app: http://localhost:8787/me/login, username `maya`, same password.
   - Customer page: http://localhost:8787/maya

If they only wanted to try it, stop here. Everything is local, and nothing was sent anywhere.

### Phase 3: Deploy to Cloudflare

**Checkpoint.** Summarize the steps below and get a yes before running any of them. Use their project name
wherever `rootview` appears.

1. **Sign in.** `npx wrangler whoami`. If it isn't signed in, run `npx wrangler login`; it opens a browser where
   **the user** signs in and clicks Allow. Wait for them.
2. **Database.** `npx wrangler d1 create rootview`. If it offers to add the database to the config, decline. Put the
   printed `database_id` into the existing entry in `wrangler.jsonc` (in place of the zeros), keeping `"binding": "DB"`,
   and set `"database_name"` (and `"name"`, if they chose another project name) to match. There must be exactly one
   `d1_databases` entry.
3. **Tables.** `npm run db:migrate:remote` (answer yes if it asks to apply).
4. **Pages project.** `npx wrangler pages project create rootview --production-branch main`. It prints the site's
   address ("available at https://…"). That's the address from here on: usually `https://rootview.pages.dev`, with a
   suffix if the name was taken. `npx wrangler pages project list` shows it again.
5. **Secrets.** Generate once, then pipe each one in. Nothing is printed:
   ```bash
   node scripts/secrets.mjs
   node scripts/secrets.mjs --get SETUP_KEY | npx wrangler pages secret put SETUP_KEY
   node scripts/secrets.mjs --get CRON_SECRET | npx wrangler pages secret put CRON_SECRET
   node scripts/secrets.mjs --get ENCRYPTION_KEY | npx wrangler pages secret put ENCRYPTION_KEY
   ```
   If wrangler asks which project, add `--project-name rootview`.
6. **Deploy.** `npm run deploy`. The link it prints (`https://1a2b3c4d.rootview.pages.dev`) is frozen on this one
   version: never use it for `/setup`, `APP_URL` or tags. Use the address from step 4.
7. **Scheduler.** Set `"APP_URL"` in `cron/wrangler.jsonc` (it ships empty on purpose) to that address, then:
   ```bash
   npm run deploy:cron
   node scripts/secrets.mjs --get CRON_SECRET | npx wrangler secret put CRON_SECRET --config cron/wrangler.jsonc
   ```
8. **Check.** Fetch `https://<address>/setup` and confirm it returns 200 and asks for a setup key.

### Phase 4: Hand over

Tell the user, in plain words:

1. Open `https://<address>/setup`. The setup key is on the `SETUP_KEY` line of `.prod-secrets` in this folder.
   Paste it, then create the owner login with **their own** email and password. Setup closes once an owner exists.
2. **Save `.prod-secrets` in a password manager**, especially `ENCRYPTION_KEY`, then delete the file if they like.
   It's git-ignored and never leaves their computer.
3. The dashboard's "Finish setting up" checklist walks through the rest: branding, the Google review link, adding
   techs, invite links, alert emails and two-step sign-in.
4. Own domain (optional): Cloudflare dashboard → Workers & Pages → the project → Custom domains. Then set
   **Settings → Address written on tags** to that address **before** writing any NFC tags.

### Optional extras (when asked)

| Extra | What the user does | What you run after |
|---|---|---|
| Google reviews import | Google Cloud project + Business Profile API access (README → "Connecting Google Business Profile"); OAuth client with redirect `https://<address>/admin/google/callback`; then runs `npx wrangler pages secret put GOOGLE_CLIENT_ID` and `... GOOGLE_CLIENT_SECRET` themselves | `npm run deploy`, then they click **Settings → Google Business Profile → Connect Google** |
| Email alerts | Verifies a sending domain at resend.com, runs `npx wrangler pages secret put RESEND_API_KEY` | `npm run deploy`; they fill in **Settings → Alerts** |
| AI reply drafts | Gets a key at console.anthropic.com, runs `npx wrangler pages secret put ANTHROPIC_API_KEY` | `npm run deploy` |

### Updating a live site later

```bash
git commit -am "deploy settings"   # only if wrangler.jsonc / cron/wrangler.jsonc have local edits
git pull
npm install
npm run db:migrate:remote
npm run deploy
npm run deploy:cron                 # only if cron/ changed
```

### When something goes wrong

| Symptom | Likely cause |
|---|---|
| `/setup` says "Set SETUP_KEY on the server first" | Secret missing or set on the wrong project. Re-run step 5, then `npm run deploy`. |
| "That setup key is wrong" | They typed it by hand; have them copy it from `.prod-secrets`. |
| Every form post answers "Forbidden" (403) | The browser sent no same-site signal: an old browser, or the site is being reached through another domain or proxy. Use the Pages or custom-domain address directly. |
| `d1 migrations apply` can't find the database | `database_id` in `wrangler.jsonc` is still all zeros, or the binding isn't `DB`. |
| Scheduler logs "Review sync failed: 403" | `CRON_SECRET` differs between the Pages project and the cron Worker, or `APP_URL` is wrong. Re-pipe the secret into both. |
| Lost the only owner's password or 2FA device | `node scripts/owner-reset-link.mjs <owner email> <site address>` prints a one-time link and the one command that activates it. |

---

## Working on the code

```bash
npm run dev           # local preview at http://localhost:8787 (data kept in .dev-node/)
npm run dev:demo      # same, reseeded with demo data
npm run check         # TypeScript
npm test              # unit tests + an end-to-end run against the real app (its own port and empty database)
npm run preview:dist  # build exactly what's deployed (dist/_worker.js) and run it locally
```

- `src/index.tsx`: routes, security headers and CSP, body limits, the app-wide same-origin (CSRF) guard.
- `src/routes/`: `public.tsx` (customers), `tech.tsx` (tech app at `/me`), `auth.tsx` (setup, office sign-in,
  2FA), `admin/*.tsx` (office).
- `src/lib/`: logic with no HTML (matching, sessions, TOTP, encryption, theme, settings, Google), so it's testable.
- `src/views/`: layout and shared components. `public/styles.css` (tokens only), `public/app.js` (progressive
  enhancement; every page must work without it).
- `migrations/`: add a new numbered file for schema changes; never edit a released one.

Conventions:

- Parameterized SQL only. Never `dangerouslySetInnerHTML` with anything a person typed. New public endpoints need
  `overLimit`; new owner-only actions need `requireOwner` and an `audit()` call.
- Colors in CSS come from theme tokens (`var(--action)`, `var(--bg-1)`, …), never raw values. New tokens are
  added in `themeTokens()` in `src/lib/theme.ts`, and the `:root` defaults in `styles.css` are regenerated from it.
- When `styles.css` or `app.js` change, bump `ASSET_V` in `src/views/layout.tsx` together with `version` in
  `package.json`.
- Free plan budget: about 10 ms CPU and about 50 D1 queries per request. Batch writes; move slow work to the
  15-minute scheduler (`runScheduled` in `src/lib/reviews.ts`).
- Interface copy is plain language for an office manager, in sentence case.
- Run `npm run check` and `npm test` before calling a change done.

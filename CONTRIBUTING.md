# Contributing

Thanks for helping. Bug reports, fixes, translations and new review sites are all welcome.

## Getting set up

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in SETUP_KEY, CRON_SECRET and DEMO_ADMIN_PASSWORD
npm run dev:demo                 # http://localhost:8787 with made-up data
```

Before you open a pull request:

```bash
npm run check   # TypeScript
npm test        # unit tests + end-to-end run
```

`npm test` starts its own copy of the app on a free port with an empty database.

## How the code is laid out

- `src/routes/` holds the pages. Each is server-rendered JSX (Hono). Every page must work with JavaScript turned off; `public/app.js` only adds conveniences.
- `src/lib/` holds the logic, kept free of HTML so it's easy to test.
- `public/styles.css` uses theme tokens only (`var(--action)`, `var(--bg-1)`, …). Don't add raw colors; the owner's theme couldn't change them.
- Schema changes go in a new file in `migrations/` (`0002_….sql`, and so on). Never edit a migration that has been released.

## Guidelines

- **Security first.** Parameterised SQL only. Escape nothing by hand; JSX does it. Never use `dangerouslySetInnerHTML` with anything a person typed. Every new form post is covered by the CSRF guard automatically. New public endpoints need a rate limit (`overLimit`), and new owner-only actions need `requireOwner` and an `audit()` call.
- **Plain language** in the interface. Write for an office manager, not a developer. Sentence case for labels.
- **Free-plan friendly.** Requests have a 10 ms CPU budget and about 50 database queries. Batch writes, and avoid per-request work that could run in the 15-minute scheduler instead.
- **No review gating.** Every customer must be able to reach the public review sites, whatever rating they give.
- Add or update tests for what you change: `test/*.test.mjs`. The end-to-end test talks to the app over HTTP, like a browser would.

## Reporting a security problem

Please don't open a public issue. See [SECURITY.md](SECURITY.md).

#!/usr/bin/env node
/**
 * Local preview on plain Node, for machines where `wrangler dev` can't start
 * (the local Workers runtime needs the Microsoft Visual C++ Redistributable on Windows).
 *
 * Runs the same Worker code: bundles src/index.tsx with esbuild, stands in for D1 with Node's
 * built-in SQLite (.dev-node/db-<port>.sqlite), serves public/ like Workers static assets, reads .dev.vars.
 *
 *   node scripts/dev-node.mjs              start on http://localhost:8787
 *   node scripts/dev-node.mjs --demo       load demo data first (made-up customers and reviews)
 *   node scripts/dev-node.mjs --reset      start from an empty database
 *   node scripts/dev-node.mjs --from-dist  run dist/_worker.js, the exact file deployed to Pages
 *
 * Production deploys with `npm run deploy` (Cloudflare Pages); nothing here is used there.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const PORT = Number(process.env.PORT || 8787);
const ROOT = resolve('.');
const STATE = join(ROOT, '.dev-node');
const DB_FILE = join(STATE, `db-${PORT}.sqlite`);
const args = new Set(process.argv.slice(2));

if (args.has('--reset') || args.has('--demo')) rmSync(DB_FILE, { force: true });
mkdirSync(STATE, { recursive: true });

// ---------- D1 stand-in ----------
const sqlite = new DatabaseSync(DB_FILE);
sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

class Stmt {
  constructor(sql, params = []) { this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.sql, params.map((p) => (typeof p === 'boolean' ? Number(p) : p))); }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.params).map((r) => ({ ...r })), success: true, meta: {} }; }
  async first(col) { const row = sqlite.prepare(this.sql).get(...this.params); if (!row) return null; return col ? row[col] : { ...row }; }
  async run() { const r = sqlite.prepare(this.sql).run(...this.params); return { success: true, results: [], meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }
  async raw() { return sqlite.prepare(this.sql).all(...this.params).map((r) => Object.values(r)); }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  async batch(stmts) {
    sqlite.exec('BEGIN');
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  },
  async exec(sql) { sqlite.exec(sql); return { count: 0, duration: 0 }; },
};

// ---------- migrations (same files wrangler applies) ----------
sqlite.exec('CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY, applied_at INTEGER)');
const done = new Set(sqlite.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name));
for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) continue;
  sqlite.exec(readFileSync(join(ROOT, 'migrations', file), 'utf8'));
  sqlite.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
  console.log(`  migration ${file}`);
}

if (args.has('--demo')) {
  execSync('node scripts/seed-demo.mjs --sql-only', { stdio: 'inherit' });
  sqlite.exec(readFileSync(join(ROOT, '.demo-seed.sql'), 'utf8'));
  console.log('  demo data loaded');
}

// ---------- env (.dev.vars) ----------
const vars = existsSync('.dev.vars')
  ? Object.fromEntries(readFileSync('.dev.vars', 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
  : {};

// ---------- static assets ----------
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
const PUBLIC = join(ROOT, 'public');
function assetFor(pathname) {
  let p;
  try { p = normalize(join(PUBLIC, decodeURIComponent(pathname))); } catch { return null; }
  // Only files inside public/ (the separator stops "public-other/" from matching too).
  if (!p.startsWith(PUBLIC + sep)) return null;
  try { if (statSync(p).isFile()) return p; } catch { /* not a file */ }
  return null;
}
const ASSETS = {
  async fetch(req) {
    const file = assetFor(new URL(req.url).pathname);
    return file ? new Response(readFileSync(file), { headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } }) : new Response('Not found', { status: 404 });
  },
};

const env = { ...vars, DB, ASSETS };
for (const k of Object.keys(env)) if (env[k] === '') delete env[k];

// ---------- bundle the worker (or load the exact file `npm run build` made for Pages) ----------
let out = join(STATE, `worker-${PORT}.mjs`);
if (args.has('--from-dist')) {
  out = join(ROOT, 'dist', '_worker.js');
  if (!existsSync(out)) throw new Error('Run `npm run build` first.');
  console.log('  running dist/_worker.js (the Pages build)');
} else {
  await build({
    entryPoints: [join(ROOT, 'src/index.tsx')], bundle: true, format: 'esm', platform: 'node', target: 'node22', outfile: out,
    jsx: 'automatic', jsxImportSource: 'hono/jsx', logLevel: 'warning', sourcemap: 'inline',
  });
}
const worker = (await import(`${pathToFileURL(out).href}?t=${Date.now()}`)).default;

const ctx = { waitUntil: (p) => Promise.resolve(p).catch((e) => console.error('[waitUntil]', e)), passThroughOnException() {} };

// ---------- HTTP ----------
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${PORT}`}`);
    const file = req.method === 'GET' ? assetFor(url.pathname) : null;
    if (file) {
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(readFileSync(file));
      return;
    }
    if (url.pathname === '/__scheduled') {
      await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env, ctx);
      res.end('scheduled run finished');
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    // Cloudflare attaches the visitor's rough location as request.cf. Locally, tests and previews can
    // pretend to be somewhere with an x-dev-cf header, e.g. {"city":"Oak Park","postalCode":"60302","asn":7922}.
    try { if (req.headers['x-dev-cf']) Object.defineProperty(request, 'cf', { value: JSON.parse(req.headers['x-dev-cf']) }); } catch { /* ignore bad JSON */ }
    const response = await worker.fetch(request, env, ctx);
    const outHeaders = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') outHeaders[k] = v; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outHeaders['set-cookie'] = cookies;
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
    console.log(`${req.method} ${url.pathname}${url.search} → ${response.status}`);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Dev server error, see the terminal.');
  }
// This machine only: the preview has no rate limits worth the name and a /__scheduled trigger.
}).listen(PORT, '127.0.0.1', () => console.log(`\n  RootView on http://localhost:${PORT}\n  (Node preview; SQLite at .dev-node/db-${PORT}.sqlite)\n`));

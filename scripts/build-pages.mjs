#!/usr/bin/env node
/**
 * Builds dist/ for Cloudflare Pages ("advanced mode"):
 *   dist/_worker.js    the whole app, bundled by wrangler (so Node-only code paths inside the
 *                      Anthropic SDK get Cloudflare's compatibility shims)
 *   dist/_routes.json  static files skip the worker (served straight from Pages, no request quota used)
 *   dist/*             everything in public/
 *
 * Deploy with `npm run deploy` (wrangler pages deploy --no-bundle).
 */
import { execSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist';
const TMP = join('.build', 'worker');
rmSync(OUT, { recursive: true, force: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync('public', OUT, { recursive: true });

execSync(`npx wrangler deploy --dry-run --outdir ${TMP} --config wrangler.build.jsonc`, { stdio: ['ignore', 'ignore', 'inherit'] });
const files = readdirSync(TMP).filter((f) => f.endsWith('.js'));
if (files.length !== 1) throw new Error(`Expected one bundled file, got: ${files.join(', ')}`);
copyFileSync(join(TMP, files[0]), join(OUT, '_worker.js'));

// Static files at the top of public/ (and its folders) never need the worker.
// (_headers and other "_" files are Pages settings, not files anyone requests.)
const exclude = readdirSync('public').filter((f) => !f.startsWith('_'))
  .map((f) => (statSync(join('public', f)).isDirectory() ? `/${f}/*` : `/${f}`));
writeFileSync(join(OUT, '_routes.json'), JSON.stringify({ version: 1, include: ['/*'], exclude }, null, 2));

const code = readFileSync(join(OUT, '_worker.js'), 'utf8');
const nodeImports = [...new Set([...code.matchAll(/(?:from|import)\s*\(?\s*["'](node:[^"']+)["']/g)].map((m) => m[1]))];
console.log(`dist/_worker.js ${(code.length / 1024).toFixed(0)} KB${nodeImports.length ? ` (runtime modules: ${nodeImports.join(', ')})` : ''}`);
console.log(`dist/_routes.json skips the worker for: ${exclude.join(' ')}`);

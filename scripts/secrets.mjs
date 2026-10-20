#!/usr/bin/env node
/**
 * Makes the three production secrets and keeps them in .prod-secrets (git-ignored), so you never have to
 * invent, copy or paste them by hand.
 *
 *   node scripts/secrets.mjs                 create .prod-secrets, or add any value it's missing (never overwrites)
 *   node scripts/secrets.mjs --get NAME      print one value with no newline, for piping:
 *
 *   node scripts/secrets.mjs --get SETUP_KEY | npx wrangler pages secret put SETUP_KEY
 *
 * Keep a copy of ENCRYPTION_KEY in your password manager: without it the stored Google connection and
 * two-step sign-in keys can't be read.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../.prod-secrets', import.meta.url));
const MAKE = {
  SETUP_KEY: () => randomBytes(24).toString('base64url'),
  CRON_SECRET: () => randomBytes(32).toString('base64url'),
  ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
};

const read = () => {
  const out = {};
  if (!existsSync(FILE)) return out;
  for (const line of readFileSync(FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
};

const [flag, name] = process.argv.slice(2);

if (flag === '--get') {
  const value = read()[name];
  if (!value) {
    console.error(`${name || 'NAME'} isn't in .prod-secrets. Run "node scripts/secrets.mjs" first.`);
    process.exit(1);
  }
  process.stdout.write(value);
} else if (flag) {
  console.error('Usage: node scripts/secrets.mjs [--get NAME]');
  process.exit(1);
} else {
  const have = read();
  const added = Object.keys(MAKE).filter((k) => !have[k]);
  for (const k of added) have[k] = MAKE[k]();
  const body = [
    '# RootView production secrets. Never commit or share this file. Back up ENCRYPTION_KEY in a password manager.',
    ...Object.entries(have).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n');
  writeFileSync(FILE, body, { mode: 0o600 });
  try { chmodSync(FILE, 0o600); } catch { /* Windows: permissions come from the folder */ }
  console.log(added.length ? `Added ${added.join(', ')} to .prod-secrets.` : '.prod-secrets already has every value; nothing changed.');
}

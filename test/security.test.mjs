// Unit tests for the security-sensitive helpers: theme sanitising, two-step codes, encryption at rest, image checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, cleanHex, cleanTheme, contrast, contrastWarnings, presetTheme, themeCss, themeTokens } from '../.test-build/theme.js';
import { base32, fromBase32, newTotpSecret, otpauthUrl, stepAt, totpCode, verifyTotp } from '../.test-build/totp.js';
import { open, seal } from '../.test-build/crypto.js';
import { parseImage } from '../.test-build/assets.js';

// ---------- theme ----------

test('theme colors: only #rrggbb gets through, everything else falls back', () => {
  assert.equal(cleanHex('#AbCdEf', '#000000'), '#abcdef');
  assert.equal(cleanHex('#abc', '#000000'), '#aabbcc');
  for (const bad of ['red', 'url(javascript:alert(1))', '#12345', '#1234567', '#ff0000;}body{x:y', 'expression(1)', '', null, 42]) {
    assert.equal(cleanHex(bad, '#000000'), '#000000', String(bad));
  }
  const t = cleanTheme({ mode: 'neon', corners: '9px', heading_font: "x'; }", bg: '</style><script>', preset: '__proto__' });
  assert.equal(t.mode, 'dark');
  assert.equal(t.corners, 'soft');
  assert.equal(t.heading_font, 'sans');
  assert.match(t.bg, /^#[0-9a-f]{6}$/);
  assert.equal(t.preset, 'midnight');
});

test('theme css is only custom properties with safe values', () => {
  const css = themeCss(cleanTheme({ bg: '#ffffff', mode: 'light' }));
  assert.match(css, /^:root\{color-scheme:light;/);
  assert.ok(!/[<>]|javascript|expression|url\(/i.test(css));
});

test('every preset is readable and every token the stylesheet needs is produced', () => {
  for (const name of Object.keys(PRESETS)) {
    assert.deepEqual(contrastWarnings(presetTheme(name)), [], `${name} has readability warnings`);
  }
  const tokens = themeTokens(presetTheme('daylight'));
  for (const k of ['--bg', '--bg-1', '--text', '--text-2', '--text-3', '--ink', '--action', '--on-action', '--proof', '--on-proof', '--danger', '--on-danger', '--star-off', '--r-md', '--font-body', '--shadow-pop']) {
    assert.ok(tokens[k], `${k} missing`);
  }
  assert.ok(contrast(tokens['--on-action'], tokens['--action']) >= 4.5, 'button text is readable');
});

test('unreadable color choices are flagged', () => {
  const warnings = contrastWarnings(cleanTheme({ bg: '#000000', surface: '#050505', text: '#111111' }));
  assert.ok(warnings.some((w) => /Text on the page background/.test(w)));
});

// ---------- two-step codes (RFC 6238) ----------

test('codes match the RFC 6238 test vector', async () => {
  const secret = base32(new TextEncoder().encode('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(await totpCode(secret, stepAt(59_000)), '287082');
  assert.equal(await totpCode(secret, stepAt(1_111_111_109_000)), '081804');
  assert.deepEqual([...fromBase32(secret)], [...new TextEncoder().encode('12345678901234567890')]);
});

test('a code is accepted once, within a step either side, and never again', async () => {
  const secret = newTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  const at = Date.UTC(2026, 9, 20, 12, 0, 0);
  const now = await totpCode(secret, stepAt(at));
  const step = await verifyTotp(secret, now, at);
  assert.equal(step, stepAt(at));
  assert.equal(await verifyTotp(secret, now.slice(0, 3) + ' ' + now.slice(3), at), step, 'spaces are fine');
  assert.equal(await verifyTotp(secret, now, at, step), null, 'replay of the same code is refused');
  assert.equal(await verifyTotp(secret, await totpCode(secret, stepAt(at) - 1), at), stepAt(at) - 1, '30 seconds of clock drift is fine');
  assert.equal(await verifyTotp(secret, await totpCode(secret, stepAt(at) - 3), at), null, 'old codes expire');
  assert.equal(await verifyTotp(secret, 'abcdef', at), null);
  assert.equal(await verifyTotp(secret, '1234567', at), null);
  assert.match(otpauthUrl(secret, 'owner@example.com', 'Lakeside & Co'), /^otpauth:\/\/totp\/Lakeside%20%26%20Co:owner%40example\.com\?secret=[A-Z2-7]+&issuer=Lakeside%20%26%20Co/);
});

// ---------- encryption at rest ----------

test('sealed values round-trip, are different every time, and tampering is detected', async () => {
  const env = { ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  const a = await seal(env, 'refresh-token-value');
  const b = await seal(env, 'refresh-token-value');
  assert.match(a, /^enc:v1:/);
  assert.notEqual(a, b, 'a fresh IV each time');
  assert.equal(await open(env, a), 'refresh-token-value');
  const flipped = a.slice(0, -2) + (a.endsWith('A') ? 'B' : 'A') + a.slice(-1);
  await assert.rejects(() => open(env, flipped), 'a changed ciphertext fails authentication');
  await assert.rejects(() => open({ ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64') }, a), 'the wrong key fails');
  await assert.rejects(() => open({}, a), /ENCRYPTION_KEY is not set/);
  assert.equal(await seal({}, 'plain'), 'plain', 'without a key, values are stored as-is');
  assert.equal(await open(env, 'plain-old-value'), 'plain-old-value', 'values from before the key was set still read');
  await assert.rejects(() => seal({ ENCRYPTION_KEY: 'too-short' }, 'x'), /32 bytes/);
});

// ---------- uploaded images ----------

test('images must really be the type they claim, and small enough', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.deepEqual(Object.keys(parseImage(png, 10_000)), ['mime', 'data']);
  assert.match(parseImage(png, 10).error, /too large/);
  const svgAsPng = `data:image/png;base64,${Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')}`;
  assert.match(parseImage(svgAsPng, 10_000).error, /isn't the image type/);
  assert.match(parseImage(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`, 10_000).error, /PNG, JPEG or WebP/);
  assert.match(parseImage('data:text/html;base64,PGgxPmhpPC9oMT4=', 10_000).error, /PNG, JPEG or WebP/);
  assert.match(parseImage('data:image/png;base64,not base64!', 10_000).error, /PNG, JPEG or WebP/);
  const jpegHead = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  assert.equal(parseImage(`data:image/jpeg;base64,${jpegHead.toString('base64')}`, 10_000).mime, 'image/jpeg');
  assert.match(parseImage(`data:image/webp;base64,${jpegHead.toString('base64')}`, 10_000).error, /isn't the image type/);
});

/**
 * Admin → Branding: business name and links, logo and app icon, and the color theme. Everything a customer,
 * tech or office manager sees picks these up: pages read /theme.css, and images come from /asset/*.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { MAX_BYTES, deleteAssets, parseImage, saveAssets, type AssetName } from '../../lib/assets';
import { audit } from '../../lib/audit';
import { requireOwner } from '../../lib/auth';
import { companyName, saveSettings, type Settings } from '../../lib/settings';
import { PRESETS, cleanTheme, contrastWarnings, presetTheme, themeTokens, type Theme } from '../../lib/theme';
import { line, str } from '../../lib/util';
import { back } from '../../views/layout';
import { Icon } from '../../views/ui';
import { page } from './common';

const branding = new Hono<AppEnv>();

// Anyone in the office can look; only an owner can change how the business is presented.
branding.post('*', requireOwner);

/** A web address people can open: https only (http allowed for an old website), no other schemes. */
function cleanLink(v: unknown, allowHttp = false): { url: string } | { error: string } {
  const raw = str(v, 300);
  if (!raw) return { url: '' };
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return { error: 'links must start with https://' };
    if (!u.hostname.includes('.')) return { error: `"${raw}" isn't a full web address.` };
    return { url: u.href };
  } catch {
    return { error: `"${raw}" isn't a web address.` };
  }
}

const styleVars = (t: Theme) => `color-scheme:${t.mode};` + Object.entries(themeTokens(t)).map(([k, v]) => `${k}:${v}`).join(';');

const COLOR_FIELDS: { key: 'bg' | 'surface' | 'text' | 'action' | 'proof'; label: string; hint: string }[] = [
  { key: 'bg', label: 'Page background', hint: 'Behind everything.' },
  { key: 'surface', label: 'Panels', hint: 'Cards, boxes and menus.' },
  { key: 'text', label: 'Text', hint: 'Softer greys are mixed from this.' },
  { key: 'action', label: 'Action color', hint: 'Buttons, links and the selected tab.' },
  { key: 'proof', label: 'Highlight color', hint: 'Stars, success and "credited".' },
];

const HEADING_FONTS = [
  { v: 'sans', label: 'Modern sans (Manrope)' },
  { v: 'serif', label: 'Classic serif' },
  { v: 'display', label: 'Engraved capitals (Cinzel)' },
  { v: 'system', label: "The device's own font" },
] as const;

function Warnings({ list }: { list: string[] }) {
  return (
    <div class="theme-warnings" data-theme-warnings aria-live="polite">
      {list.length
        ? <ul class="plain stack-xs">{list.map((w) => <li class="small"><Icon name="alert" size={14} /> {w}</li>)}</ul>
        : <p class="small pos"><Icon name="check" size={14} /> These colors pass the readability check.</p>}
    </div>
  );
}

/** A small mock of the customer page and the dashboard, drawn with the theme being edited. */
function Preview({ t, s }: { t: Theme; s: Settings }) {
  const v = s.brand.version;
  return (
    <div class="theme-preview" data-theme-preview style={styleVars(t)} role="img" aria-label="Preview of the selected colors">
      <div class="tp__bar">
        {s.brand.logo
          ? <img src={`/asset/logo?v=${v}`} alt="" class="tp__logo" />
          : <><img src={`/asset/icon-192.png?v=${v}`} alt="" width="22" height="22" class="tp__icon" /><span class="tp__name">{companyName(s)}</span></>}
      </div>
      <div class="tp__card">
        <p class="tp__eyebrow">Your technician today</p>
        <p class="tp__title">How did Alex do?</p>
        <p class="tp__stars" aria-hidden="true">★★★★★</p>
        <span class="tp__btn">Leave a Google review</span>
        <p class="tp__muted">Takes about a minute. <span class="tp__link">Privacy</span></p>
      </div>
      <div class="tp__row">
        <span class="tp__chip tp__chip--proof">Credited</span>
        <span class="tp__chip">Needs a look</span>
        <span class="tp__chip tp__chip--danger">Low rating</span>
      </div>
    </div>
  );
}

function BrandingPage({ s, owner, errors }: { s: Settings; owner: boolean; errors?: { details?: string; images?: string } }) {
  const t = s.theme;
  const v = s.brand.version;
  return (
    <div class="stack-lg">
      {!owner && <p class="flash">Only an owner can change branding. You're seeing the current settings.</p>}

      <section class="card" id="details">
        <h2 class="h-sm">Business details</h2>
        <p class="small muted">Shown on customers' pages, the tech app, printed cards and alert emails.</p>
        {errors?.details && <p class="flash flash--err" role="alert">{errors.details}</p>}
        <form method="post" action="/admin/branding/details">
          <fieldset class="form-grid bare" disabled={!owner}>
            <div class="field"><label for="company_name">Business name</label><input id="company_name" name="company_name" required maxlength={80} value={s.company_name} autocomplete="organization" /></div>
            <div class="field"><label for="office_phone">Office phone</label><input id="office_phone" name="office_phone" type="tel" maxlength={30} value={s.office_phone} /><p class="hint">Customers can tap to call it from their rating page.</p></div>
            <div class="field"><label for="website_url">Website</label><input id="website_url" name="website_url" maxlength={300} value={s.website_url} placeholder="https://example.com" /></div>
            <div class="field"><label for="privacy_url">Privacy policy</label><input id="privacy_url" name="privacy_url" maxlength={300} value={s.privacy_url} placeholder="https://example.com/privacy" /><p class="hint">Linked from the rating page. Leave blank to show only the built-in notice.</p></div>
            <div class="form-actions field--wide"><button class="btn btn--red" type="submit">Save details</button></div>
          </fieldset>
        </form>
      </section>

      <section class="card" id="images">
        <h2 class="h-sm">Logo and app icon</h2>
        <p class="small muted">Pick a file and it's resized on this device before upload. PNG, JPEG, WebP or SVG all work; a transparent PNG or SVG looks best.</p>
        {errors?.images && <p class="flash flash--err" role="alert">{errors.images}</p>}
        <form method="post" action="/admin/branding/images" data-brand-form>
          <fieldset class="brand-upload bare" disabled={!owner}>
            <div class="brand-upload__item">
              <div class="brand-upload__preview brand-upload__preview--logo">
                <img src={s.brand.logo ? `/asset/logo?v=${v}` : ''} alt="" data-brand-preview="logo" hidden={!s.brand.logo} />
                {!s.brand.logo && <span class="dim small" data-brand-empty="logo">No logo yet: your business name is shown instead.</span>}
              </div>
              <div class="field">
                <label for="logo-file">Logo</label>
                <input id="logo-file" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-brand-file="logo" />
                <input type="hidden" name="logo" value="" data-brand-value="logo" />
                <p class="hint">Wide logos work best. Shown up to 40px tall in page headers.</p>
                {s.brand.logo && <label class="check"><input type="checkbox" name="remove_logo" value="1" /> Remove logo</label>}
              </div>
            </div>
            <div class="brand-upload__item">
              <div class="brand-upload__preview brand-upload__preview--icon">
                <img src={`/asset/icon-192.png?v=${v}`} alt="" width="96" height="96" data-brand-preview="icon" />
              </div>
              <div class="field">
                <label for="icon-file">App icon</label>
                <input id="icon-file" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-brand-file="icon" />
                {ICONS.map((n) => <input type="hidden" name={n} value="" data-brand-value={n} />)}
                <div class="cluster">
                  <label class="check small"><input type="color" value={t.surface} data-icon-bg /> Background</label>
                  <label class="check small"><input type="checkbox" checked data-icon-pad /> Add padding</label>
                </div>
                <p class="hint">Square. Used for the browser tab, the tech app's home-screen icon, and beside your name when there's no logo.</p>
                {s.brand.icon && <label class="check"><input type="checkbox" name="remove_icon" value="1" /> Go back to the default icon</label>}
              </div>
            </div>
            <div class="form-actions"><button class="btn btn--red" type="submit">Save images</button></div>
          </fieldset>
        </form>
      </section>

      <section class="card" id="theme">
        <div class="row-between"><h2 class="h-sm">Colors and style</h2></div>
        <div class="theme-grid">
          <form method="post" action="/admin/branding/theme" data-theme-form>
            <fieldset class="stack-md bare" disabled={!owner}>
              <fieldset class="presets bare">
                <legend class="small strong">Start from a preset</legend>
                <div class="presets__list">
                  {Object.entries(PRESETS).map(([key, p]) => (
                    <label class="preset">
                      <input type="radio" name="preset" value={key} checked={t.preset === key} data-preset={JSON.stringify(p)} />
                      <span class="preset__sw" style={`--a:${p.bg};--b:${p.surface};--c:${p.action};--d:${p.proof}`} aria-hidden="true"><i /><i /><i /></span>
                      <span class="preset__name">{p.label}<span class="dim small"> · {p.mode}</span></span>
                    </label>
                  ))}
                  <label class="preset">
                    <input type="radio" name="preset" value="custom" checked={t.preset === 'custom'} />
                    <span class="preset__sw preset__sw--custom" aria-hidden="true"><Icon name="palette" size={16} /></span>
                    <span class="preset__name">Custom</span>
                  </label>
                </div>
                <button class="btn btn--ghost btn--sm" type="submit" name="do" value="preset" data-nojs-only>Use the selected preset</button>
              </fieldset>

              <fieldset class="seg-radio bare">
                <legend class="small strong">Mode</legend>
                {(['dark', 'light'] as const).map((m) => <label><input type="radio" name="mode" value={m} checked={t.mode === m} data-theme-input /> {m === 'dark' ? 'Dark' : 'Light'}</label>)}
              </fieldset>

              <div class="colors">
                {COLOR_FIELDS.map((f) => (
                  <div class="field">
                    <label for={`c-${f.key}`}>{f.label}</label>
                    <div class="colorpick">
                      <input id={`c-${f.key}`} type="color" name={f.key} value={t[f.key]} data-theme-input />
                      <input type="text" value={t[f.key]} maxlength={7} pattern="#[0-9a-fA-F]{6}" spellcheck={false} class="mono" aria-label={`${f.label} hex code`} data-hex-for={f.key} />
                    </div>
                    <p class="hint">{f.hint}</p>
                  </div>
                ))}
              </div>

              <fieldset class="seg-radio bare">
                <legend class="small strong">Corners</legend>
                {(['sharp', 'soft', 'round'] as const).map((k) => <label><input type="radio" name="corners" value={k} checked={t.corners === k} data-theme-input /> {k[0].toUpperCase() + k.slice(1)}</label>)}
              </fieldset>

              <div class="form-grid">
                <div class="field"><label for="heading_font">Headings</label>
                  <select id="heading_font" name="heading_font" data-theme-input>
                    {HEADING_FONTS.map((f) => <option value={f.v} selected={t.heading_font === f.v}>{f.label}</option>)}
                  </select></div>
                <div class="field"><label for="body_font">Body text</label>
                  <select id="body_font" name="body_font" data-theme-input>
                    <option value="sans" selected={t.body_font === 'sans'}>Modern sans (Manrope)</option>
                    <option value="system" selected={t.body_font === 'system'}>The device's own font</option>
                  </select></div>
              </div>

              <div class="form-actions">
                <button class="btn btn--red" type="submit" name="do" value="save">Save colors</button>
                <button class="btn btn--ghost" type="submit" name="do" value="reset" data-confirm="Go back to the default Midnight theme?">Reset to default</button>
              </div>
            </fieldset>
          </form>

          <div class="stack-md theme-side">
            <Preview t={t} s={s} />
            <Warnings list={contrastWarnings(t)} />
          </div>
        </div>
      </section>
    </div>
  );
}

const ICONS = ['icon-512', 'icon-192', 'icon-180', 'icon-32'] as const satisfies readonly AssetName[];

const showPage = (c: Parameters<typeof page>[0], s: Settings, errors?: { details?: string; images?: string }) =>
  page(c, {
    title: 'Branding',
    active: 'branding',
    lede: 'Your name, logo and colors. Changes show everywhere at once: customer pages, the tech app and this dashboard.',
  }, <BrandingPage s={s} owner={c.get('admin').role === 'owner'} errors={errors} />, errors ? 422 : 200);

branding.get('/', (c) => showPage(c, c.get('settings')));

/** The live preview asks the server for the full set of colors a theme produces, so the browser doesn't repeat the math. */
branding.get('/tokens', (c) => {
  const t = cleanTheme(c.req.query(), c.get('settings').theme);
  return c.json({ style: styleVars(t), warnings: contrastWarnings(t) }, 200, { 'cache-control': 'no-store' });
});

branding.post('/details', async (c) => {
  const b = await c.req.parseBody();
  const s = c.get('settings');
  const company = line(b.company_name, 80);
  const website = cleanLink(b.website_url, true);
  const privacy = cleanLink(b.privacy_url);
  if (company.length < 2 || 'error' in website || 'error' in privacy) {
    const error = company.length < 2 ? 'Add your business name.' : 'error' in website ? `Website: ${website.error}` : `Privacy policy: ${'error' in privacy ? privacy.error : ''}`;
    return showPage(c, { ...s, company_name: company }, { details: error });
  }
  await saveSettings(c.env.DB, { company_name: company, office_phone: line(b.office_phone, 30), website_url: website.url, privacy_url: privacy.url });
  await audit(c, 'brand.details', company);
  return c.redirect(back('/admin/branding#details', { ok: 'Business details saved.' }), 303);
});

branding.post('/images', async (c) => {
  const b = await c.req.parseBody();
  const s = c.get('settings');
  const items: { name: AssetName; mime: string; data: string }[] = [];

  const logo = str(b.logo, 700_000);
  if (logo) {
    const img = parseImage(logo, MAX_BYTES.logo);
    if ('error' in img) return showPage(c, s, { images: `Logo: ${img.error}` });
    items.push({ name: 'logo', ...img });
  }
  const icons = ICONS.map((n) => str(b[n], 700_000));
  if (icons.some(Boolean)) {
    if (!icons.every(Boolean)) return showPage(c, s, { images: 'The app icon upload was incomplete. Pick the file again.' });
    for (const [i, n] of ICONS.entries()) {
      const img = parseImage(icons[i], MAX_BYTES[n]);
      if ('error' in img) return showPage(c, s, { images: `App icon: ${img.error}` });
      // Browsers and phones expect PNG for tab and home-screen icons.
      if (img.mime !== 'image/png') return showPage(c, s, { images: 'App icon: it must be a PNG. Pick the file again.' });
      items.push({ name: n, ...img });
    }
  }
  const removeLogo = !logo && !!b.remove_logo;
  const removeIcon = !icons[0] && !!b.remove_icon;
  if (!items.length && !removeLogo && !removeIcon) return c.redirect(back('/admin/branding#images', { err: 'Pick a logo or icon file first.' }), 303);

  if (items.length) await c.env.DB.batch(saveAssets(c.env.DB, items));
  const removed: AssetName[] = [...(removeLogo ? (['logo'] as const) : []), ...(removeIcon ? ICONS : [])];
  if (removed.length) await deleteAssets(c.env.DB, removed);
  await saveSettings(c.env.DB, {
    brand: {
      logo: logo ? true : removeLogo ? false : s.brand.logo,
      icon: icons[0] ? true : removeIcon ? false : s.brand.icon,
      version: s.brand.version + 1,
    },
  });
  await audit(c, 'brand.images', [logo && 'new logo', icons[0] && 'new icon', removeLogo && 'logo removed', removeIcon && 'icon reset'].filter(Boolean).join(', '));
  return c.redirect(back('/admin/branding#images', { ok: 'Images saved. Phones may take a minute to pick up a new home-screen icon.' }), 303);
});

const sameLook = (a: Theme, b: Theme) => (['mode', 'bg', 'surface', 'text', 'action', 'proof', 'corners', 'heading_font', 'body_font'] as const).every((k) => a[k] === b[k]);

branding.post('/theme', async (c) => {
  const b = await c.req.parseBody();
  const s = c.get('settings');
  const submitted = cleanTheme(b, s.theme);
  let theme: Theme;
  if (b.do === 'reset') theme = presetTheme('midnight')!;
  else if (b.do === 'preset') theme = presetTheme(submitted.preset) ?? submitted;
  else {
    // Edited away from the preset it started from: call it custom, so the picker doesn't claim otherwise.
    const p = presetTheme(submitted.preset);
    theme = p && !sameLook(p, submitted) ? { ...submitted, preset: 'custom' } : submitted;
  }
  await saveSettings(c.env.DB, { theme });
  await audit(c, 'brand.theme', `${theme.preset}, ${theme.mode}, action ${theme.action}`);
  return c.redirect(back('/admin/branding#theme', contrastWarnings(theme).length
    ? { err: 'Saved, but some colors are hard to read. See the notes beside the preview.' }
    : { ok: 'Colors saved.' }), 303);
});

export default branding;

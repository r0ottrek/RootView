import type { Context } from 'hono';
import { html } from 'hono/html';
import { createContext, useContext } from 'hono/jsx';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import type { AdminUser, AppEnv, Tech } from '../env';
import { DEFAULTS, companyName, type Settings } from '../lib/settings';
import { initials, telHref } from '../lib/util';
import { Avatar, Icon } from './ui';

/** Cache-buster for styles.css and app.js. Bump it (with package.json "version") in every release that changes them. */
export const ASSET_V = '1.2.0';

/** The request's settings, available to every component while a page renders (company name, theme, logo). */
const SettingsContext = createContext<Settings>(DEFAULTS);
export const useSettings = () => useContext(SettingsContext);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function render(c: Context<AppEnv>, node: any, status: 200 | 400 | 403 | 404 | 422 | 429 | 500 = 200) {
  return c.html(html`<!doctype html>${<SettingsContext.Provider value={c.get('settings')}>{node}</SettingsContext.Provider>}`, status);
}

export interface Flash { ok?: string; err?: string }
/**
 * Messages in ?ok= / ?err= only show after this site redirected here, so a link from elsewhere can't put
 * made-up text ("call this number…") on a real page. Browsers without Sec-Fetch-Site still see them.
 */
export const flashFrom = (c: Context<AppEnv>): Flash => {
  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin') return {};
  return { ok: c.req.query('ok')?.slice(0, 200), err: c.req.query('err')?.slice(0, 200) };
};

export function back(url: string, flash: Flash): string {
  const q = new URLSearchParams();
  if (flash.ok) q.set('ok', flash.ok);
  if (flash.err) q.set('err', flash.err);
  const clean = url.replace(/([?&])(ok|err)=[^&]*/g, '$1').replace(/[?&]+$/, '');
  return `${clean}${clean.includes('?') ? '&' : '?'}${q}`;
}

/** Changes whenever the theme does, so browsers fetch the new /theme.css at once. */
function themeVersion(s: Settings): string {
  const str = JSON.stringify(s.theme) + ASSET_V;
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export const Doc: FC<PropsWithChildren<{ title: string; bodyClass?: string; app?: 'tech' | 'admin' }>> = ({ title, bodyClass, app, children }) => {
  const s = useSettings();
  const v = s.brand.version;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{title}</title>
        <meta name="robots" content="noindex, nofollow" />
        <meta name="referrer" content="strict-origin-when-cross-origin" />
        <meta name="theme-color" content={s.theme.bg} />
        <meta name="color-scheme" content={s.theme.mode} />
        <link rel="icon" href={`/asset/icon-32.png?v=${v}`} type="image/png" sizes="32x32" />
        <link rel="icon" href={`/asset/icon-192.png?v=${v}`} type="image/png" sizes="192x192" />
        <link rel="apple-touch-icon" href={`/apple-touch-icon.png?v=${v}`} />
        {app === 'tech' && <link rel="manifest" href="/manifest.webmanifest" />}
        {app === 'tech' && <meta name="apple-mobile-web-app-capable" content="yes" />}
        {app === 'tech' && <meta name="apple-mobile-web-app-title" content={companyName(s)} />}
        <link rel="preload" href="/fonts/plex-sans.woff2" as="font" type="font/woff2" crossorigin="" />
        <link rel="stylesheet" href={`/styles.css?v=${ASSET_V}`} />
        <link rel="stylesheet" href={`/theme.css?v=${themeVersion(s)}`} />
      </head>
      <body class={bodyClass ?? ''}>
        <a class="skip-link" href="#main">Skip to content</a>
        {children}
        <p class="sr-only" id="live" role="status" aria-live="polite"></p>
        <script src={`/app.js?v=${ASSET_V}`} defer></script>
      </body>
    </html>
  );
};

/** The uploaded logo, or the app icon plus the company name. */
export const Brand: FC<{ small?: boolean; href?: string }> = ({ small, href }) => {
  const s = useSettings();
  const v = s.brand.version;
  const name = companyName(s);
  const inner = s.brand.logo
    ? (
      <>
        <img src={`/asset/logo?v=${v}`} alt={name} class="brand__logo" />
        <img src={`/asset/icon-192.png?v=${v}`} width="36" height="36" alt="" class="brand__mark" />
      </>
    )
    : (
      <>
        <img src={`/asset/icon-192.png?v=${v}`} width="40" height="40" alt="" class="brand__icon" />
        <span class="wordmark">{name}</span>
      </>
    );
  const cls = `brand ${small ? 'brand--sm' : ''} ${s.brand.logo ? 'brand--logo' : 'brand--text'}`;
  return href ? <a class={cls} href={href}>{inner}</a> : <div class={cls}>{inner}</div>;
};

export const FlashBar: FC<{ flash: Flash }> = ({ flash }) => (
  <>
    {flash.ok && <div class="flash flash--ok" role="status" tabindex={-1} data-flash><Icon name="check" /> {flash.ok}</div>}
    {flash.err && <div class="flash flash--err" role="alert" tabindex={-1} data-flash><Icon name="alert" /> {flash.err}</div>}
  </>
);

// ---------- customer pages ----------

export const PublicPage: FC<PropsWithChildren<{ title: string; s: Settings }>> = ({ title, s, children }) => {
  const site = s.website_url ? s.website_url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '') : '';
  return (
    <Doc title={title} bodyClass="pub">
      <header class="pub__head"><Brand /></header>
      <main id="main" class="pub__main" tabindex={-1}>{children}</main>
      <footer class="pub__foot">
        <p>{companyName(s)}{s.office_phone && <> · <a href={telHref(s.office_phone)}>{s.office_phone}</a></>}</p>
        {(site || s.privacy_url) && (
          <p>{site && <a href={s.website_url} rel="noopener">{site}</a>}{site && s.privacy_url && ' · '}{s.privacy_url && <a href={s.privacy_url} rel="noopener">Privacy</a>}</p>
        )}
      </footer>
    </Doc>
  );
};

// ---------- admin ----------

export interface AdminCounts { unassigned: number; low: number; redemptions: number }

const NAV: { href: string; key: string; label: string; icon: string; badge?: keyof AdminCounts }[] = [
  { href: '/admin', key: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { href: '/admin/reviews', key: 'reviews', label: 'Reviews', icon: 'star', badge: 'unassigned' },
  { href: '/admin/team', key: 'team', label: 'Team', icon: 'users' },
  { href: '/admin/activity', key: 'activity', label: 'Tag activity', icon: 'tap', badge: 'low' },
  { href: '/admin/rewards', key: 'rewards', label: 'Rewards', icon: 'gift', badge: 'redemptions' },
  { href: '/admin/branding', key: 'branding', label: 'Branding', icon: 'palette' },
  { href: '/admin/settings', key: 'settings', label: 'Settings', icon: 'gear' },
];

export const AdminShell: FC<PropsWithChildren<{
  title: string;
  active: string;
  admin: AdminUser;
  s: Settings;
  counts?: AdminCounts;
  flash?: Flash;
  actions?: Child;
  lede?: Child;
}>> = ({ title, active, admin, s, counts, flash, actions, lede, children }) => (
  <Doc title={`${title} · ${companyName(s)}`} bodyClass="adm" app="admin">
    <div class="adm__frame">
      <div class="adm__side">
        <div class="adm__brand"><Brand small href="/admin" /></div>
        <nav class="adm__nav" aria-label="Main">
          {NAV.map((n) => {
            const count = n.badge && counts ? counts[n.badge] : 0;
            return (
              <a href={n.href} class={`adm__link ${active === n.key ? 'is-active' : ''}`} aria-current={active === n.key ? 'page' : undefined}>
                <Icon name={n.icon} size={16} />
                <span class="adm__label">{n.label}</span>
                {count > 0 && <span class={`badge ${n.badge === 'low' || n.badge === 'redemptions' ? 'badge--urgent' : ''}`}><span aria-hidden="true">{count > 99 ? '99+' : count}</span><span class="sr-only">, {count} need attention</span></span>}
              </a>
            );
          })}
        </nav>
        <div class="adm__me">
          <a href="/admin/account" class={`adm__user ${active === 'account' ? 'is-active' : ''}`} title="Your account" aria-label={`Your account: ${admin.name}`} aria-current={active === 'account' ? 'page' : undefined}>
            <span class="adm__avatar" aria-hidden="true">{initials(admin.name)}</span>
            <span class="adm__who"><strong>{admin.name}</strong><span>{admin.role === 'owner' ? 'Owner' : 'Office manager'}</span></span>
          </a>
          <form method="post" action="/admin/logout">
            <button class="iconbtn" type="submit" title="Sign out" aria-label="Sign out"><Icon name="logout" size={16} /></button>
          </form>
        </div>
      </div>
      <main id="main" class="adm__main" tabindex={-1}>
        {s.demo && (
          <div class="demo-bar">
            <span><strong>Demo data</strong> · customers, taps and reviews here are made up so you can click around.</span>
            <form method="post" action="/admin/demo/clear" data-confirm="Delete all demo taps, reviews, points and rewards? Your team and settings stay."><button class="linkbtn" type="submit">Clear demo data</button></form>
          </div>
        )}
        <header class="adm__head">
          <div>
            <h1>{title}</h1>
            {lede && <p class="adm__lede">{lede}</p>}
          </div>
          {actions && <div class="adm__actions">{actions}</div>}
        </header>
        {flash && <FlashBar flash={flash} />}
        {children}
      </main>
    </div>
  </Doc>
);

// ---------- tech app ----------

export const TechShell: FC<PropsWithChildren<{ title: string; tech: Tech; active: string; flash?: Flash }>> = ({ title, tech, active, flash, children }) => {
  const s = useSettings();
  return (
    <Doc title={`${title} · ${companyName(s)}`} bodyClass="me" app="tech">
      <header class="me__head">
        <a href="/me" class="me__who">
          <Avatar tech={tech} size={40} />
          <span><strong>{tech.first_name}</strong><span class="dim small">{tech.role}</span></span>
        </a>
        <img src={`/asset/icon-192.png?v=${s.brand.version}`} width="36" height="36" alt={companyName(s)} class="me__mark" />
      </header>
      <main id="main" class="me__main" tabindex={-1}>
        {flash && <FlashBar flash={flash} />}
        {children}
      </main>
      <nav class="me__tabs" aria-label="Sections">
        {[
          { href: '/me', key: 'home', label: 'Home', icon: 'grid' },
          { href: '/me/qr', key: 'qr', label: 'My QR', icon: 'qr' },
          { href: '/me/reviews', key: 'reviews', label: 'Reviews', icon: 'star' },
          { href: '/me/rewards', key: 'rewards', label: 'Rewards', icon: 'gift' },
          { href: '/me/account', key: 'account', label: 'Account', icon: 'user' },
        ].map((t) => (
          <a href={t.href} class={active === t.key ? 'is-active' : ''} aria-current={active === t.key ? 'page' : undefined}>
            <Icon name={t.icon} />
            <span>{t.label}</span>
          </a>
        ))}
      </nav>
    </Doc>
  );
};

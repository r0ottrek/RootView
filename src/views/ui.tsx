import type { Child, FC } from 'hono/jsx';
import { initials } from '../lib/util';

// ---------- icons (24px stroke set) ----------

const PATHS: Record<string, string> = {
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z',
  users: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 19v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.15a3.5 3.5 0 0 1 0 6.7',
  tap: 'M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V12m0-1a1.5 1.5 0 0 1 3 0v4.5a5.5 5.5 0 0 1-5.5 5.5h-1.2a5 5 0 0 1-3.9-1.9L5 15.8a1.6 1.6 0 0 1 2.4-2.1L9 15.3M5.5 6.5a5 5 0 0 1 8.9-2.2',
  gift: 'M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7s-1.5-4-4-4a2 2 0 0 0 0 4h4zm0 0s1.5-4 4-4a2 2 0 0 1 0 4h-4z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 9v4m0 4h.01M10.3 3.9L2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM16 16h2v2h-2z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  message: 'M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.2A8 8 0 1 1 21 12z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  refresh: 'M20 11a8 8 0 0 0-14.8-4M4 5v4h4M4 13a8 8 0 0 0 14.8 4M20 19v-4h-4',
  plus: 'M12 5v14M5 12h14',
  print: 'M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z',
  download: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14',
  arrow: 'M5 12h14m-6-6l6 6-6 6',
  back: 'M19 12H5m6 6l-6-6 6-6',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  trophy: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.2-4.2',
  palette: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 12.5h.01M9.5 8h.01M14.5 8h.01M17 11.5h.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  shield: 'M12 3l7 3v5c0 4.4-3 8.4-7 9.5C8 19.4 5 15.4 5 11V6z M9 12l2 2 4-4',
  up: 'M12 19V5m-6 6l6-6 6 6',
  down: 'M12 5v14m6-6l-6 6-6-6',
  inbox: 'M4 13l2.5-7.5A2 2 0 0 1 8.4 4h7.2a2 2 0 0 1 1.9 1.5L20 13M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M4 13h4.5l1.5 2.5h4l1.5-2.5H20',
  mail: 'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM3.5 7l8.5 6 8.5-6',
};

export const Icon: FC<{ name: string; size?: number; class?: string }> = ({ name, size = 20, class: cls }) => (
  <svg class={`icon ${cls ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={PATHS[name] ?? PATHS.star} />
  </svg>
);

export const GoogleG: FC<{ size?: number }> = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);

// ---------- stars: green, never yellow (brand rule) ----------

export const Stars: FC<{ rating: number | null | undefined; size?: number }> = ({ rating, size = 16 }) => {
  if (rating == null) return <span class="dim small">No stars</span>;
  const full = Math.round(rating);
  return (
    <span class="stars" role="img" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill={i <= full ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.4">
          <path d={PATHS.star} />
        </svg>
      ))}
    </span>
  );
};

// ---------- people ----------

export interface AvatarTech { id: string; name: string; photo?: string | number | null; updated_at?: number }

export const Avatar: FC<{ tech: AvatarTech; size?: number }> = ({ tech, size = 40 }) => (
  <span class="avatar" style={`--sz:${size}px`}>
    {tech.photo ? (
      <img src={`/photo/${tech.id}?v=${tech.updated_at ?? 0}`} alt="" width={size} height={size} loading="lazy" />
    ) : (
      <span class="avatar__init" aria-hidden="true">{initials(tech.name)}</span>
    )}
  </span>
);

// ---------- data display ----------

export const Stat: FC<{ label: string; value: Child; sub?: Child; tone?: 'up' | 'down' | 'flat' | 'warn'; href?: string }> = ({ label, value, sub, tone, href }) => {
  const body = (
    <>
      <span class="stat__label">{label}</span>
      <span class="stat__value tnum">{value}</span>
      {sub && <span class={`stat__sub ${tone ? `is-${tone}` : ''}`}>{tone === 'up' || tone === 'down' ? <Icon name={tone} size={13} /> : null}{sub}</span>}
    </>
  );
  return href ? <a class="stat stat--link" href={href}>{body}</a> : <div class="stat">{body}</div>;
};

export function trend(cur: number, prev: number, label: string): { sub: string; tone: 'up' | 'down' | 'flat' } | null {
  if (!label) return null;
  if (!prev && !cur) return { sub: `none ${label} either`, tone: 'flat' };
  if (!prev) return { sub: `vs 0 ${label}`, tone: 'up' };
  const diff = cur - prev;
  const p = Math.round((diff / prev) * 100);
  if (diff === 0) return { sub: `same as ${label}`, tone: 'flat' };
  return { sub: `${Math.abs(p)}% vs ${label}`, tone: diff > 0 ? 'up' : 'down' };
}

export const Chip: FC<{ tone?: 'green' | 'red' | 'muted'; children?: Child; title?: string }> = ({ tone, children, title }) => (
  <span class={`chip ${tone ? `chip--${tone}` : ''}`} title={title}>{children}</span>
);

export const Empty: FC<{ title: string; children?: Child; action?: Child }> = ({ title, children, action }) => (
  <div class="empty">
    <span class="empty__mark"><Icon name="inbox" size={22} /></span>
    <h3>{title}</h3>
    {children && <p class="muted">{children}</p>}
    {action}
  </div>
);

/**
 * Weekly column chart, single series (brand green). Server-rendered SVG with a hover/focus tooltip
 * (public/app.js) and a data table fallback. Columns ≤ 24px, 4px rounded tops, square at the baseline.
 */
export const ColumnChart: FC<{ id: string; title: string; data: { label: string; value: number; detail: string }[] }> = ({ id, title, data }) => {
  const W = 720, H = 220, padL = 32, padR = 8, padT = 22, padB = 28;
  const max = Math.max(4, ...data.map((d) => d.value));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const band = plotW / data.length;
  const barW = Math.min(24, band * 0.56);
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const peak = data.reduce((m, d, i) => (d.value > data[m].value ? i : m), 0);
  const last = data.length - 1;
  return (
    <figure class="chart" id={id}>
      <figcaption class="chart__title">{title}</figcaption>
      <div class="chart__plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${data.map((d) => `${d.label}: ${d.value}`).join(', ')}`} class="chart__svg">
          {ticks.map((v) => (
            <g>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} class={v === 0 ? 'chart__base' : 'chart__grid'} />
              <text x={padL - 8} y={y(v) + 4} class="chart__tick" text-anchor="end">{v}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = padL + band * i + band / 2;
            const h = Math.max(0, y(0) - y(d.value));
            const x = cx - barW / 2;
            const r = Math.min(4, h, barW / 2);
            const path = h <= 0 ? '' : `M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + barW - r} Q${x + barW},${y(0) - h} ${x + barW},${y(0) - h + r} V${y(0)} Z`;
            const showLabel = (i === peak || i === last) && d.value > 0;
            return (
              <g class="chart__col" tabindex="0" data-tip={`${d.detail}`}>
                <rect x={padL + band * i} y={padT} width={band} height={plotH} class="chart__hit" />
                {path && <path d={path} class="chart__bar" />}
                {showLabel && <text x={cx} y={y(d.value) - 6} class="chart__val" text-anchor="middle">{d.value}</text>}
                {(i % 2 === last % 2) && <text x={cx} y={H - 8} class="chart__tick" text-anchor="middle">{d.label}</text>}
              </g>
            );
          })}
        </svg>
        <div class="chart__tip" role="status" aria-live="polite" hidden></div>
      </div>
      <details class="chart__table">
        <summary>Show as table</summary>
        <table class="tbl tbl--compact">
          <thead><tr><th scope="col">Week of</th><th scope="col" class="num">Reviews</th></tr></thead>
          <tbody>{data.map((d) => <tr><td>{d.label}</td><td class="num tnum">{d.value}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
};

function niceStep(max: number): number {
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

export const Pager: FC<{ page: number; hasMore: boolean; base: string }> = ({ page, hasMore, base }) => {
  if (page <= 1 && !hasMore) return null;
  const u = (p: number) => `${base}${base.includes('?') ? '&' : '?'}page=${p}`;
  return (
    <nav class="pager" aria-label="Pages">
      {page > 1 ? <a class="btn btn--ghost btn--sm" href={u(page - 1)}>Newer</a> : <span />}
      <span class="dim small">Page {page}</span>
      {hasMore ? <a class="btn btn--ghost btn--sm" href={u(page + 1)}>Older</a> : <span />}
    </nav>
  );
};

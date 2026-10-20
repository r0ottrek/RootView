/**
 * Themes: five colors, a light/dark mode, a corner style and two fonts, chosen in Admin → Branding.
 * Everything else (hover shades, borders, tints, readable text on buttons) is derived here, on the server,
 * so every browser gets plain hex/rgba values (no color-mix() needed on older phones).
 *
 * Colors are only ever accepted as #rrggbb, so nothing a user types can break out of the stylesheet.
 * Pure functions only, so the rules are easy to test.
 */

export type ThemeMode = 'dark' | 'light';
export type HeadingFont = 'sans' | 'serif' | 'display' | 'system';
export type BodyFont = 'sans' | 'system';
export type Corners = 'sharp' | 'soft' | 'round';

export interface Theme {
  preset: string;
  mode: ThemeMode;
  bg: string; // page background
  surface: string; // panels and cards
  text: string; // main text
  action: string; // buttons, links, the active tab
  proof: string; // stars, success, "credited"
  corners: Corners;
  heading_font: HeadingFont;
  body_font: BodyFont;
}

export const PRESETS: Record<string, Omit<Theme, 'preset'> & { label: string }> = {
  midnight: { label: 'Midnight', mode: 'dark', bg: '#0a0b0d', surface: '#121418', text: '#e6e8eb', action: '#7d9dbf', proof: '#6dbb8f', corners: 'soft', heading_font: 'sans', body_font: 'sans' },
  graphite: { label: 'Graphite', mode: 'dark', bg: '#000000', surface: '#0b0b0b', text: '#ededed', action: '#e11d48', proof: '#22c55e', corners: 'soft', heading_font: 'sans', body_font: 'sans' },
  forest: { label: 'Forest', mode: 'dark', bg: '#0b1410', surface: '#122019', text: '#e7f0ea', action: '#f59e0b', proof: '#34d399', corners: 'round', heading_font: 'serif', body_font: 'sans' },
  daylight: { label: 'Daylight', mode: 'light', bg: '#f6f7f8', surface: '#ffffff', text: '#1a1d21', action: '#46698c', proof: '#2e7a55', corners: 'soft', heading_font: 'sans', body_font: 'sans' },
  sand: { label: 'Sand', mode: 'light', bg: '#faf6ef', surface: '#ffffff', text: '#2a2119', action: '#c2410c', proof: '#15803d', corners: 'round', heading_font: 'serif', body_font: 'sans' },
  harbor: { label: 'Harbor', mode: 'light', bg: '#f1f6f9', surface: '#ffffff', text: '#0f2233', action: '#0e7490', proof: '#059669', corners: 'sharp', heading_font: 'display', body_font: 'sans' },
};

export const DEFAULT_THEME: Theme = { preset: 'midnight', ...stripLabel(PRESETS.midnight) };

function stripLabel(p: (typeof PRESETS)[string]): Omit<Theme, 'preset'> {
  const { label: _label, ...rest } = p;
  return rest;
}

// Own keys only: "__proto__" or "constructor" from a form must not count as a preset.
const isPreset = (name: unknown): name is string => typeof name === 'string' && Object.hasOwn(PRESETS, name);

export function presetTheme(name: string): Theme | null {
  return isPreset(name) ? { preset: name, ...stripLabel(PRESETS[name]) } : null;
}

// ---------- validation ----------

const HEX = /^#[0-9a-f]{6}$/;

export function cleanHex(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (HEX.test(s)) return s;
  const short = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : fallback;
}

const pickOne = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

/** Anything stored or submitted becomes a safe, complete theme. */
export function cleanTheme(input: unknown, base: Theme = DEFAULT_THEME): Theme {
  const t = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    preset: t.preset === 'custom' || isPreset(t.preset) ? t.preset : base.preset,
    mode: pickOne(t.mode, ['dark', 'light'] as const, base.mode),
    bg: cleanHex(t.bg, base.bg),
    surface: cleanHex(t.surface, base.surface),
    text: cleanHex(t.text, base.text),
    action: cleanHex(t.action, base.action),
    proof: cleanHex(t.proof, base.proof),
    corners: pickOne(t.corners, ['sharp', 'soft', 'round'] as const, base.corners),
    heading_font: pickOne(t.heading_font, ['sans', 'serif', 'display', 'system'] as const, base.heading_font),
    body_font: pickOne(t.body_font, ['sans', 'system'] as const, base.body_font),
  };
}

// ---------- color math ----------

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (c: RGB) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

/** Mix a toward b; amount 0 = a, 1 = b. */
export function mix(a: string, b: string, amount: number): string {
  const x = hexToRgb(a), y = hexToRgb(b);
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * amount) as RGB);
}

export function alpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on this color. */
export const readableOn = (hex: string): string => (contrast(hex, '#ffffff') >= contrast(hex, '#000000') ? '#ffffff' : '#0a0a0a');

/**
 * Shift a color toward the page's text color until it has `min` contrast on every one of `grounds`
 * (colored links on the page and on panels, grey hint text, form field borders).
 */
function legible(color: string, text: string, min: number, ...grounds: string[]): string {
  for (let i = 0; i <= 20; i++) {
    const c = mix(color, text, i * 0.05);
    if (grounds.every((g) => contrast(c, g) >= min)) return c;
  }
  return text;
}

// ---------- tokens ----------

const FONTS: Record<HeadingFont | BodyFont, string> = {
  sans: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  display: "'Cinzel', Georgia, 'Times New Roman', serif",
};

const RADIUS: Record<Corners, [number, number, number]> = { sharp: [3, 4, 6], soft: [7, 10, 12], round: [10, 14, 18] };

const DANGER = { dark: '#f87171', light: '#c42323' };

/** Every CSS custom property the stylesheet uses, from a theme. */
export function themeTokens(t: Theme): Record<string, string> {
  const dark = t.mode === 'dark';
  const [rs, rm, rl] = RADIUS[t.corners];
  const step = (n: number) => mix(t.surface, t.text, n);
  const danger = DANGER[t.mode];
  return {
    '--bg': t.bg,
    '--bg-1': t.surface,
    '--bg-2': step(dark ? 0.045 : 0.035),
    '--bg-3': step(dark ? 0.085 : 0.07),
    '--bg-4': step(dark ? 0.13 : 0.11),
    '--hover': alpha(t.text, dark ? 0.05 : 0.045),
    '--line': alpha(t.text, dark ? 0.08 : 0.1),
    '--line-2': alpha(t.text, dark ? 0.14 : 0.16),
    '--line-3': alpha(t.text, dark ? 0.25 : 0.3),
    '--ink': dark ? mix(t.text, '#ffffff', 0.6) : mix(t.text, '#000000', 0.4),
    '--text': t.text,
    '--text-2': mix(t.text, t.bg, dark ? 0.36 : 0.32),
    '--text-3': legible(mix(t.text, t.bg, dark ? 0.48 : 0.44), t.text, 4.5, t.bg, t.surface),
    '--line-ctl': legible(mix(t.text, t.bg, 0.62), t.text, 3, t.bg, t.surface),
    '--action': t.action,
    '--action-deep': mix(t.action, '#000000', 0.14),
    '--action-tint': alpha(t.action, dark ? 0.12 : 0.1),
    '--action-text': legible(t.action, t.text, 4.5, t.bg, t.surface),
    '--on-action': readableOn(t.action),
    '--proof': t.proof,
    '--proof-deep': mix(t.proof, '#000000', 0.18),
    '--proof-tint': alpha(t.proof, dark ? 0.13 : 0.12),
    '--proof-text': legible(t.proof, t.text, 4.5, t.bg, t.surface),
    '--on-proof': readableOn(t.proof),
    '--danger': danger,
    '--danger-tint': alpha(danger, dark ? 0.1 : 0.08),
    '--on-danger': readableOn(danger),
    '--shadow-sm': dark ? '0 1px 2px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.05)' : '0 1px 2px rgba(16, 24, 40, 0.12)',
    '--shadow-pop': dark ? '0 16px 40px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.5)' : '0 16px 40px rgba(16, 24, 40, 0.14), 0 2px 8px rgba(16, 24, 40, 0.08)',
    '--star-off': step(dark ? 0.14 : 0.16),
    '--r-sm': `${rs}px`,
    '--r-md': `${rm}px`,
    '--r-lg': `${rl}px`,
    '--font-display': FONTS[t.heading_font],
    '--font-body': FONTS[t.body_font],
  };
}

export function themeCss(t: Theme): string {
  const vars = Object.entries(themeTokens(t)).map(([k, v]) => `${k}:${v}`).join(';');
  return `:root{color-scheme:${t.mode};${vars}}\n`;
}

/** Plain-English problems with a theme's readability (WCAG AA: 4.5 for text, 3 for large text and controls). */
export function contrastWarnings(t: Theme): string[] {
  const tok = themeTokens(t);
  const out: string[] = [];
  const check = (a: string, b: string, min: number, what: string) => {
    const r = contrast(a, b);
    if (r < min) out.push(`${what} is hard to read (contrast ${r.toFixed(1)}:1, aim for ${min}:1).`);
  };
  check(t.text, t.bg, 4.5, 'Text on the page background');
  check(t.text, t.surface, 4.5, 'Text on panels');
  check(tok['--on-action'], t.action, 4.5, 'Button text on the button color');
  check(t.proof, t.bg, 3, 'Stars on the page background');
  check(tok['--text-3'], t.bg, 4.5, 'Small grey text');
  check(tok['--text-3'], t.surface, 4.5, 'Small grey text on panels');
  check(tok['--action-text'], t.surface, 4.5, 'Links on panels');
  check(tok['--line-ctl'], t.surface, 3, 'Form field borders');
  check(tok['--danger'], mix(t.surface, tok['--danger'], t.mode === 'dark' ? 0.1 : 0.08), 4.5, 'Error text');
  return out;
}

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Contrast regression guard for the color tokens in src/index.css.
 *
 * `--muted-foreground` is used for body copy (scan hints, KPI labels, table
 * headers, helper text) and `--ring` is the global focus indicator, so both
 * are WCAG 2.2 AA boundaries:
 *   - muted-foreground must stay >= 4.5:1 against every surface it sits on;
 *   - the focus ring must stay >= 3:1 against the surface it is drawn next to.
 *
 * The test reads the real token values out of index.css instead of hardcoding
 * them, so a future palette edit that silently drops below the threshold fails
 * here. Dependency-free: OKLCH -> sRGB -> WCAG relative luminance is computed
 * inline against the CSS Color 4 spec matrices.
 */

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

// WCAG 2.2 AA: 1.4.3 Contrast (Minimum) for text, 1.4.11 Non-text Contrast for
// the focus ring.
const TEXT_MIN = 4.5;
const NON_TEXT_MIN = 3;

type Oklch = { l: number; c: number; h: number; alpha: number };
type Rgb = readonly [number, number, number];

const OKLCH = /^oklch\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*(?:\/\s*(-?[\d.]+%?)\s*)?\)$/i;

function parseOklch(raw: string): Oklch {
  const match = OKLCH.exec(raw.trim());
  if (!match) throw new Error(`unsupported color token value: "${raw}"`);
  const [, l, c, h, alpha] = match;
  if (l === undefined || c === undefined || h === undefined) {
    throw new Error(`malformed oklch() value: "${raw}"`);
  }
  return {
    l: Number(l),
    c: Number(c),
    h: Number(h),
    alpha: alpha === undefined ? 1 : alpha.endsWith("%") ? Number(alpha.slice(0, -1)) / 100 : Number(alpha),
  };
}

/** Reads the first `selector { ... }` block's custom properties by name. */
function readTheme(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (block === undefined) throw new Error(`theme block "${selector}" not found in index.css`);
  const tokens = new Map<string, string>();
  for (const declaration of block.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    tokens.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
  }
  return tokens;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const encode = (linear: number) => (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);
const decode = (gamma: number) => (gamma <= 0.04045 ? gamma / 12.92 : ((gamma + 0.055) / 1.055) ** 2.4);

/** OKLCH -> gamma-encoded sRGB (CSS Color 4 / Bjorn Ottosson matrices). */
function toRgb(color: Oklch): Rgb {
  const rad = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(rad);
  const b = color.c * Math.sin(rad);
  const l = (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (color.l - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    encode(clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    encode(clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    encode(clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)),
  ];
}

/** Source-over composite of `color` on an opaque backdrop, both gamma-encoded. */
function composite(color: Oklch, backdrop: Rgb): Rgb {
  if (color.alpha >= 1) return toRgb(color);
  const [r, g, b] = toRgb(color);
  return [
    color.alpha * r + (1 - color.alpha) * backdrop[0],
    color.alpha * g + (1 - color.alpha) * backdrop[1],
    color.alpha * b + (1 - color.alpha) * backdrop[2],
  ];
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b);
}

function contrast(front: Rgb, back: Rgb): number {
  const a = luminance(front);
  const b = luminance(back);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = [
  { name: "light", selector: ":root" },
  { name: "dark", selector: ".dark" },
] as const;

// Opaque surfaces these tokens can render against (page, raised, tinted and
// sidebar fills). Border/input tokens are borders, not fills, so they are not
// text or ring backdrops.
const SURFACE_NAMES = ["background", "card", "popover", "muted", "secondary", "accent", "sidebar"] as const;

for (const theme of THEMES) {
  const tokens = readTheme(theme.selector);
  const value = (name: string): Oklch => {
    const raw = tokens.get(`--${name}`);
    if (raw === undefined) throw new Error(`token --${name} missing from ${theme.selector}`);
    return parseOklch(raw);
  };
  const background = toRgb(value("background"));
  const surface = (name: (typeof SURFACE_NAMES)[number]): Rgb => composite(value(name), background);

  const mutedForeground = toRgb(value("muted-foreground"));
  const ring = toRgb(value("ring"));
  const sidebarRing = toRgb(value("sidebar-ring"));

  describe(`accessibility contrast — ${theme.name} theme`, () => {
    for (const name of SURFACE_NAMES) {
      const fill = surface(name);
      it(`--muted-foreground stays >= ${TEXT_MIN}:1 on --${name}`, () => {
        expect(contrast(mutedForeground, fill)).toBeGreaterThanOrEqual(TEXT_MIN);
      });
      it(`--ring stays >= ${NON_TEXT_MIN}:1 against --${name}`, () => {
        expect(contrast(ring, fill)).toBeGreaterThanOrEqual(NON_TEXT_MIN);
      });
    }
    it(`--sidebar-ring stays >= ${NON_TEXT_MIN}:1 against --sidebar`, () => {
      expect(contrast(sidebarRing, surface("sidebar"))).toBeGreaterThanOrEqual(NON_TEXT_MIN);
    });

    // Semantic status tokens (issue #101): status text colours on the surfaces
    // they render on, plus the solid-fill foreground pairs.
    const tintOver = (name: string, alpha: number, backdrop: Rgb): Rgb =>
      composite({ ...value(name), alpha }, backdrop);
    for (const name of ["success", "warning"] as const) {
      const status = toRgb(value(name));
      it(`--${name} text stays >= ${TEXT_MIN}:1 on --card`, () => {
        expect(contrast(status, surface("card"))).toBeGreaterThanOrEqual(TEXT_MIN);
      });
      it(`--${name} text stays >= ${TEXT_MIN}:1 on its /10 tint over --card`, () => {
        expect(contrast(status, tintOver(name, 0.1, surface("card")))).toBeGreaterThanOrEqual(TEXT_MIN);
      });
    }
    it(`--warning text stays >= ${TEXT_MIN}:1 on its /20 tint over --card`, () => {
      expect(contrast(toRgb(value("warning")), tintOver("warning", 0.2, surface("card")))).toBeGreaterThanOrEqual(TEXT_MIN);
    });
    it(`--success-foreground on a solid --success fill stays >= ${TEXT_MIN}:1`, () => {
      expect(contrast(toRgb(value("success-foreground")), toRgb(value("success")))).toBeGreaterThanOrEqual(TEXT_MIN);
    });
    it(`--destructive-foreground on a solid --destructive fill stays >= ${TEXT_MIN}:1`, () => {
      expect(contrast(toRgb(value("destructive-foreground")), toRgb(value("destructive")))).toBeGreaterThanOrEqual(TEXT_MIN);
    });
  });
}

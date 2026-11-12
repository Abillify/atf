// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// @vitest-environment node

/**
 * Design-token contrast contract (UI-STYLE-GUIDE.md §3 + §9 checklist).
 *
 * The style guide promises "Contrast >= 4.5:1 (body) / 3:1 (large) — guaranteed
 * by the tokens", and status labels render at 10-12px, so they fall under body
 * text. That promise was silently false for several light-theme DEFAULT values
 * (`text-success` reached only 4.12:1 on `--success-soft`), which axe reports as
 * a serious WCAG violation wherever such a label sits on its tinted surface.
 *
 * Rather than trusting the palette by eye, this test recomputes the WCAG 2.1
 * ratios from `src/app/globals.css` itself: for every semantic family, the text
 * (DEFAULT) value must clear 4.5:1 against the theme's `card` surface *and*
 * against its own `*-soft` surface, in light and in dark. A translucent
 * `*-solid/NN` fill is not an approved surface for label text — use `*-soft`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS_PATH = fileURLToPath(new URL("../app/globals.css", import.meta.url));
const css = readFileSync(CSS_PATH, "utf8");

/** Declarations of a flat top-level block (`:root` / `.dark`). */
function block(selector: string): Map<string, string> {
  const match = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`${selector} block not found in globals.css`);
  const vars = new Map<string, string>();
  for (const decl of match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars.set(decl[1], decl[2].trim());
  }
  return vars;
}

const light = block(":root");
const dark = block(".dark");

/** `--name` from the theme block, falling back to the light value (cascade). */
function token(vars: Map<string, string>, name: string): string {
  const value = vars.get(name) ?? light.get(name);
  if (!value) throw new Error(`${name} is not defined`);
  return value;
}

type Rgb = [number, number, number];

/** HSL triplet token ("142 72% 30%") -> sRGB, matching `hsl(var(--token))`. */
function hslTriplet(value: string): Rgb {
  const parts = value.split(/[\s,]+/);
  if (parts.length !== 3) throw new Error(`not an HSL triplet: "${value}"`);
  const [h, s, l] = parts.map((p) => Number.parseFloat(p));
  if ([h, s, l].some((n) => Number.isNaN(n))) {
    throw new Error(`not an HSL triplet: "${value}"`);
  }
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const amp = sat * Math.min(lig, 1 - lig);
  const chan = (n: number) => lig - amp * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [255 * chan(0), 255 * chan(8), 255 * chan(4)];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.1 contrast ratio (1..21). */
function contrast(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Families documented as semantic status tokens in UI-STYLE-GUIDE.md §3. */
const FAMILIES = [
  "success",
  "warning",
  "danger",
  "info",
  "copilot",
  "subflow",
  "accent-2",
] as const;

const THEMES = [
  ["light", light],
  ["dark", dark],
] as const;

/** Body-text floor for the 10-12px status labels these tokens render. */
const AA = 4.5;

describe("status tokens keep AA contrast on their own surfaces", () => {
  for (const [themeName, vars] of THEMES) {
    const card = hslTriplet(token(vars, "--card"));

    for (const family of FAMILIES) {
      it(`${themeName}: text-${family} clears ${AA}:1 on card and ${family}-soft`, () => {
        const text = hslTriplet(token(vars, `--${family}`));
        const soft = hslTriplet(token(vars, `--${family}-soft`));
        const onCard = contrast(text, card);
        const onSoft = contrast(text, soft);
        // Both ratios land in the failure message, naming the surface that moved.
        expect(onCard, `text-${family} on card`).toBeGreaterThanOrEqual(AA);
        expect(onSoft, `text-${family} on --${family}-soft`).toBeGreaterThanOrEqual(AA);
      });
    }
  }

  it("every status token is an HSL triplet, never a raw color", () => {
    // Components must be able to wrap these in hsl(); a hex/rgb value would
    // break the Tailwind mapping and (historically) render as `none`.
    for (const [, vars] of THEMES) {
      for (const family of FAMILIES) {
        for (const suffix of ["", "-soft", "-border", "-solid", "-foreground"]) {
          const name = `--${family}${suffix}`;
          const raw = vars.get(name) ?? light.get(name);
          if (!raw) continue;
          expect(raw, `${name} must stay an "H S% L%" triplet`).not.toMatch(/#|rgb|oklch/);
          expect(() => hslTriplet(raw), `${name} must parse`).not.toThrow();
        }
      }
    }
  });
});

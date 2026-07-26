import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/*
 * Issue #700: the three roles that carry state text — `text-muted`
 * ("4 branches running"), `text-success` ("working…", "live tail") and
 * `text-warning` ("1 waiting", "waiting for a reply") — all sat below the
 * 4.5:1 small-text floor on their own surfaces. This pins the floor at the
 * token level so a future palette tweak cannot quietly drop back under it.
 */

const TOKENS = fs.readFileSync(path.join(import.meta.dir, "tokens.css"), "utf8");

/** Every declaration of `name`, in file order: light block first, dark after. */
function values(name: string): string[] {
  return [...TOKENS.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "gi"))].map((match) => match[1].toLowerCase());
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_SMALL_TEXT = 4.5;

test("state text roles clear the small-text contrast floor on every surface they render on", () => {
  /* Index 0 is the light block, index 1 the first dark override. */
  const canvas = values("surface-canvas");
  const card = values("surface-card");
  const sunken = values("surface-sunken");
  const muted = values("color-muted");
  const success = values("color-success");
  const successSoft = values("color-success-soft");
  const warning = values("color-warning");
  const warningSoft = values("color-warning-soft");

  for (const scheme of [0, 1]) {
    const surfaces = [canvas[scheme], card[scheme], sunken[scheme]].filter(Boolean);
    expect(surfaces.length).toBe(3);
    for (const surface of surfaces) {
      expect(contrast(muted[scheme], surface)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
      expect(contrast(success[scheme], surface)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
      expect(contrast(warning[scheme], surface)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
    /* Both roles are also used as text on their own -soft fill (chips, cards). */
    expect(contrast(success[scheme], successSoft[scheme])).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    expect(contrast(warning[scheme], warningSoft[scheme])).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
  }
});

/* `tokens.css` names design doc §1.5 as its authority, so the doc is the next
   place someone reads before "restoring" a palette value under the floor. It
   has to agree with what ships. */
test("the design system §1.5 table documents the shipped token values", () => {
  const doc = fs.readFileSync(
    path.join(import.meta.dir, "../../docs/design/viewer-design-system.md"),
    "utf8",
  );
  const section = doc.slice(doc.indexOf("## 1.5 Color roles"), doc.indexOf("Lifecycle states map to roles"));
  expect(section).toContain("#");

  /* §1.5 row label → the `--color-*` token it documents. */
  const documented = { "text-muted": "color-muted", success: "color-success", warning: "color-warning" } as const;

  for (const [label, token] of Object.entries(documented)) {
    const [light, dark] = values(token);
    const row = section.split("\n").find((line) => line.startsWith(`${label} `));
    expect(row, `no §1.5 row labelled "${label}"`).toBeDefined();
    expect(row!.toLowerCase(), `§1.5 "${label}" light value`).toContain(light);
    expect(row!.toLowerCase(), `§1.5 "${label}" dark value`).toContain(dark);
  }
});

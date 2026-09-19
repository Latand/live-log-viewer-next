import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { CONTENT_MAX, LAYER, Z, type Layer } from "./layers";

const COMPONENTS = path.resolve(import.meta.dir);
const SCALE_MODULE = path.join(COMPONENTS, "layers.ts");

/**
 * Raw z-indexes the guard tolerates for now, file by file, exactly: files
 * another open pull request owns keep their numbers until it merges, and the
 * follow-up moves them onto the scale and deletes their entry here. An entry
 * that no longer matches its file fails the guard too, so the list can only
 * shrink.
 */
const LEGACY_RAW_Z: Record<string, readonly string[]> = {
  "ProjectDashboard.tsx": ["z-30"],
  "SoundToggle.tsx": ["z-50"],
  "Viewer.tsx": ["z-50", "z-50", "z-40", "z-40"],
  "AccountBadge.tsx": ["z-[95]"],
  "RuntimePill.tsx": ["z-40", "z-[70]"],
  "mobile/MobileFocusView.tsx": ["z-[55]"],
  "kanban/kanbanBoard.css": [
    "z-index: 60",
    "z-index: 58",
    "z-index: 65",
    "z-index: 70",
    "z-index: 80",
    "z-index: 70",
    "z-index: 64",
    "z-index: 62",
  ],
};

export interface RawZ {
  /** The literal as written: `z-40`, `z-[60]`, `zIndex: 80`, `z-index: 64`. */
  text: string;
  value: number;
  line: number;
}

const PATTERNS: RegExp[] = [
  /* Tailwind: z-40, z-[60], -z-10, hover:z-30. */
  /(?<![\w[-])-?z-(\d+)(?![\w\]-])/g,
  /(?<![\w[-])-?z-\[(-?\d+)\]/g,
  /* A style object: zIndex: 80 (a literal, not a value taken from the scale). */
  /zIndex\s*:\s*["'`]?(-?\d+)/g,
  /* A stylesheet: z-index: 64. */
  /z-index\s*:\s*(-?\d+)/g,
];

/** Every raw z-index in a source text whose value lies above the content range. */
export function rawZIndexes(source: string): RawZ[] {
  const found: (RawZ & { at: number })[] = [];
  for (const pattern of PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const value = Math.abs(Number(match[1]));
      if (value <= CONTENT_MAX) continue;
      const line = source.slice(0, match.index).split("\n").length;
      found.push({ text: match[0].replace(/\s+/g, " "), value, line, at: match.index });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ at: _at, ...entry }) => entry);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".fixture.tsx")) out.push(full);
  }
  return out;
}

describe("the guard reads every spelling of a raw z-index", () => {
  test("Tailwind classes, style objects and stylesheets above the content range are found", () => {
    const source = [
      `<div className="fixed z-50" />`,
      `<div className="absolute z-[80] hover:z-30" />`,
      `<div style={{ zIndex: 95 }} />`,
      `.menu { z-index: 70; }`,
    ].join("\n");
    expect(rawZIndexes(source).map((entry) => entry.text)).toEqual(["z-50", "z-[80]", "z-30", "zIndex: 95", "z-index: 70"]);
  });

  test("content-range values, scale references and lookalikes pass", () => {
    const source = [
      `<div className="relative z-[1] z-10" />`,
      `<div style={{ zIndex: 10 - depth }} />`,
      `<div className={Z.popover} style={{ zIndex: LAYER.overlay }} />`,
      `<div className="size-40 lazy-40 fuzz-50" />`,
      `.card { z-index: 3; }`,
    ].join("\n");
    expect(rawZIndexes(source)).toEqual([]);
  });
});

describe("one layering scale", () => {
  test("the layers keep their documented order and sit above the content range", () => {
    const order: Layer[] = ["lifted", "sticky", "dock", "sheet", "modal", "popover", "overlay", "toast", "tooltip", "feedback"];
    expect(Object.keys(LAYER)).toEqual(order);
    const values = order.map((name) => LAYER[name]);
    expect(values[0]).toBeGreaterThan(CONTENT_MAX);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
  });

  test("every layer's class carries the layer's number", () => {
    for (const [name, value] of Object.entries(LAYER)) expect(Z[name as Layer]).toBe(`z-[${value}]`);
  });

  test("an overlay opened from a modal outranks it, and a menu outranks both sheets and modals", () => {
    expect(LAYER.popover).toBeGreaterThan(LAYER.modal);
    expect(LAYER.overlay).toBeGreaterThan(LAYER.popover);
    expect(LAYER.modal).toBeGreaterThan(LAYER.sheet);
  });

  test("no component under src/components uses a raw z-index outside the scale module", () => {
    const offenders: string[] = [];
    const stale: string[] = [];
    for (const file of sourceFiles(COMPONENTS)) {
      if (file === SCALE_MODULE) continue;
      const rel = path.relative(COMPONENTS, file).split(path.sep).join("/");
      const found = rawZIndexes(fs.readFileSync(file, "utf8"));
      const legacy = LEGACY_RAW_Z[rel];
      if (legacy) {
        const texts = found.map((entry) => entry.text);
        if (JSON.stringify(texts) !== JSON.stringify(legacy)) stale.push(`${rel}: expected exactly ${JSON.stringify(legacy)}, found ${JSON.stringify(texts)}`);
        continue;
      }
      for (const entry of found) offenders.push(`${rel}:${entry.line} ${entry.text} — take it from src/components/layers.ts`);
    }
    expect(offenders).toEqual([]);
    expect(stale).toEqual([]);
  });
});

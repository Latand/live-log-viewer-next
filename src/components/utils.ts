import { effortMeter as meterOf } from "@/lib/agent/efforts";
import { getLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import { cleanTitle } from "@/lib/title";

export { cleanTitle, shortTitle } from "@/lib/title";

export function escText(value: string): string {
  return value.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

export function fmtAge(mtime: number): string {
  const locale = getLocale();
  const s = Date.now() / 1000 - mtime;
  if (s < 90) return translate(locale, "time.agoSec", { n: Math.round(s) });
  if (s < 5400) return translate(locale, "time.agoMin", { n: Math.round(s / 60) });
  if (s < 129600) return translate(locale, "time.agoHour", { n: Math.round(s / 3600) });
  return translate(locale, "time.agoDay", { n: Math.round(s / 86400) });
}

export function hhmm(ts: unknown): string {
  if (typeof ts !== "string" && typeof ts !== "number") return "";
  const d = new Date(ts);
  const bcp47 = getLocale() === "uk" ? "uk-UA" : "en-US";
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(bcp47, { hour12: false });
}

/** Same activity encoding everywhere: green pulse, amber, red, gray. */
export function activityDot(activity: FileEntry["activity"]): string {
  if (activity === "live") return "animate-pulse bg-success";
  if (activity === "recent") return "bg-warning";
  if (activity === "stalled") return "bg-danger";
  return "bg-strong";
}

export type ModelTint = { color: string; soft: string };

/* Engine base identity: Codex blue, Claude orange. Model families shift the
   hue so sibling agents on different models are tellable apart at a glance.

   Only the identity `color` is stored — a saturated hue that reads on any
   surface, so it feeds inline styles, SVG, and canvas unchanged. The pale chip
   background (`soft`) is derived as a translucent tint of that color (below), so
   it composites over whatever surface is active: near-white on the light theme
   (matching the old opaque softs) and a subtle dark tint on the dark theme, with
   no second per-theme literal (design doc §1.5). */
const ENGINE_COLORS: Record<string, string> = {
  codex: "#2f6fd0",
  claude: "#d97757",
};
const NEUTRAL_COLOR = "#9a9aa4";
const CLAUDE_MODEL_COLORS: [RegExp, string][] = [
  [/fable|mythos/, "#c2410c"],
  [/opus/, "#8a5ad6"],
  [/sonnet/, "#e0913f"],
  [/haiku/, "#d9a58c"],
];
const CODEX_MODEL_COLORS: [RegExp, string][] = [
  [/terra/, "#2b7a62"],
  [/sol/, "#a55b18"],
  [/spark/, "#5ea3e4"],
  [/mini|nano/, "#7fb1e8"],
  [/codex/, "#1d55ab"],
];

/** Translucent tint of an identity color for chip/badge backgrounds. Alpha is
    tuned so the result over white matches the previous opaque soft hexes while
    staying dark-aware over the dark card surface. Accepts a `#rrggbb` hex. */
function softOf(hexColor: string): string {
  const [h, s, l] = hexToHsl(hexColor);
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}% / 0.14)`;
}

function tintOf(color: string): ModelTint {
  return { color, soft: softOf(color) };
}

/** Identity color tinted by model family (Terra green, Sol amber, Fable deep orange…). */
export function modelTint(file: FileEntry): ModelTint {
  const base = ENGINE_COLORS[file.engine];
  if (!base) return tintOf(NEUTRAL_COLOR);
  const model = (file.model ?? "").toLowerCase();
  for (const [re, color] of file.engine === "codex" ? CODEX_MODEL_COLORS : CLAUDE_MODEL_COLORS) {
    if (re.test(model)) return tintOf(color);
  }
  return tintOf(base);
}

/* Reasoning-effort ramp: lightness/saturation deltas applied on top of the
   model tint. Brightness carries the signal (hue never changes, so the scale
   stays color-blind safe): washed out for minimal/low, base for medium,
   deeper and more saturated toward xhigh/max. Covers both CLI scales. */
const EFFORT_RAMP: Record<string, { dl: number; ds: number }> = {
  minimal: { dl: 20, ds: -32 },
  low: { dl: 12, ds: -20 },
  medium: { dl: 0, ds: 0 },
  high: { dl: -8, ds: 12 },
  xhigh: { dl: -14, ds: 22 },
  max: { dl: -19, ds: 30 },
  ultra: { dl: -24, ds: 36 },
};

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function shiftTone(hex: string, dl: number, ds: number): string {
  const [h, s, l] = hexToHsl(hex);
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  return `hsl(${Math.round(h)} ${Math.round(clamp(s + ds))}% ${Math.round(clamp(l + dl))}%)`;
}

/** Append the standard soft alpha to an `hsl(h s% l%)` string from shiftTone. */
function softFromHsl(hsl: string): string {
  return hsl.replace(/\)$/, " / 0.14)");
}

/** Model tint dimmed or deepened by the entry's reasoning-effort tier.
    Unknown/absent effort returns the plain model tint — renders as today. */
export function effortTint(file: FileEntry): ModelTint {
  const base = modelTint(file);
  const ramp = EFFORT_RAMP[file.effort ?? ""];
  if (!ramp) return base;
  const color = shiftTone(base.color, ramp.dl, ramp.ds);
  // The chip background is a translucent tint of the shifted color, so it stays
  // dark-aware and tracks the effort ramp without a second per-theme literal.
  return { color, soft: softFromHsl(color) };
}

/** Chip tooltip carrying the raw effort value; empty keeps the chip as-is. */
export function effortTitle(file: FileEntry): string | undefined {
  return file.effort ? translate(getLocale(), "util.effortTitle", { effort: file.effort }) : undefined;
}

/** Meter reading of the entry's reasoning tier within its own engine+model
    scale: lowest tier = 1 bar, top tier fills all `slots`. Callers hide the
    indicator entirely on level 0. */
export function effortMeter(file: FileEntry): { level: number; slots: number } {
  return meterOf(file.engine, file.model, file.effort);
}

/** Engine base tint for UI that has no FileEntry yet (e.g. the spawn dialog). */
export function engineTintOf(engine: string): ModelTint {
  return tintOf(ENGINE_COLORS[engine] ?? NEUTRAL_COLOR);
}

/** Model-tinted identity color as a raw value for SVG connectors and dots. */
export function engineColor(file: FileEntry): string {
  return modelTint(file).color;
}

/** Model-tinted accent strip along a card's top edge; inline style so
    arbitrary tints work. Rendered as an inner element clipped by the card's
    overflow-hidden radius — a thick border-top would miter into the thin
    side borders at the rounded corners and leave unmerged ends. */
export function engineEdge(file: FileEntry): { backgroundColor: string } {
  return { backgroundColor: modelTint(file).color };
}

export function engineBadgeFor(engine: string) {
  const label = { codex: "Codex", claude: "Claude", shell: "Bash" }[engine] ?? engine;
  const tint = tintOf(ENGINE_COLORS[engine] ?? NEUTRAL_COLOR);
  return { label, style: { backgroundColor: tint.soft, color: tint.color } };
}

export function engineBadge(file: FileEntry) {
  return engineBadgeFor(file.engine);
}

export function syntheticFile(pathname: string): FileEntry {
  const root = pathname.includes("/.claude/projects/")
    ? "claude-projects"
    : /\/tmp\/claude-\d+\//.test(pathname)
      ? "claude-tasks"
      : "codex-sessions";
  const fmt = pathname.endsWith(".jsonl") ? (root === "claude-projects" ? "claude" : "codex") : "plain";
  const engine = root.startsWith("codex") ? "codex" : root === "claude-tasks" ? "shell" : "claude";
  return {
    path: pathname,
    root,
    fmt,
    engine,
    kind: "",
    title: cleanTitle(pathname.split("/").pop() || pathname, 120),
    project: "",
    worktree: undefined,
    mtime: Date.now() / 1000,
    size: 0,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    parent: null,
    name: pathname,
  };
}

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
  if (activity === "live") return "animate-pulse bg-ok";
  if (activity === "recent") return "bg-[#d29a2f]";
  if (activity === "stalled") return "bg-err";
  return "bg-[#c9c9d1]";
}

export type ModelTint = { color: string; soft: string };

/* Engine base identity: Codex blue, Claude orange. Model families shift the
   hue so sibling agents on different models are tellable apart at a glance. */
const ENGINE_TINTS: Record<string, ModelTint> = {
  codex: { color: "#2f6fd0", soft: "#e8f0fb" },
  claude: { color: "#d97757", soft: "#faeee9" },
};
const NEUTRAL_TINT: ModelTint = { color: "#9a9aa4", soft: "#ececf1" };
const CLAUDE_TINTS: [RegExp, ModelTint][] = [
  [/fable|mythos/, { color: "#c2410c", soft: "#fbeade" }],
  [/opus/, { color: "#8a5ad6", soft: "#f1ebfb" }],
  [/sonnet/, { color: "#e0913f", soft: "#fbf1e4" }],
  [/haiku/, { color: "#d9a58c", soft: "#f9f1ec" }],
];
const CODEX_TINTS: [RegExp, ModelTint][] = [
  [/spark/, { color: "#5ea3e4", soft: "#ecf4fd" }],
  [/mini|nano/, { color: "#7fb1e8", soft: "#eff6fd" }],
  [/codex/, { color: "#1d55ab", soft: "#e4edfa" }],
];

/** Identity color tinted by model family (fable deep orange, opus violet, spark light blue…). */
export function modelTint(file: FileEntry): ModelTint {
  const base = ENGINE_TINTS[file.engine];
  if (!base) return NEUTRAL_TINT;
  const model = (file.model ?? "").toLowerCase();
  for (const [re, tint] of file.engine === "codex" ? CODEX_TINTS : CLAUDE_TINTS) {
    if (re.test(model)) return tint;
  }
  return base;
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

/** Model tint dimmed or deepened by the entry's reasoning-effort tier.
    Unknown/absent effort returns the plain model tint — renders as today. */
export function effortTint(file: FileEntry): ModelTint {
  const base = modelTint(file);
  const ramp = EFFORT_RAMP[file.effort ?? ""];
  if (!ramp) return base;
  return {
    color: shiftTone(base.color, ramp.dl, ramp.ds),
    // The pale chip background moves a third as far so text stays readable.
    soft: shiftTone(base.soft, Math.round(ramp.dl / 3), Math.round(ramp.ds / 2)),
  };
}

/** Chip tooltip carrying the raw effort value; empty keeps the chip as-is. */
export function effortTitle(file: FileEntry): string | undefined {
  return file.effort ? translate(getLocale(), "util.effortTitle", { effort: file.effort }) : undefined;
}

/** Engine base tint for UI that has no FileEntry yet (e.g. the spawn dialog). */
export function engineTintOf(engine: string): ModelTint {
  return ENGINE_TINTS[engine] ?? NEUTRAL_TINT;
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

export function engineBadge(file: FileEntry) {
  const label = { codex: "Codex", claude: "Claude", shell: "Bash" }[file.engine] ?? file.engine;
  const tint = ENGINE_TINTS[file.engine] ?? NEUTRAL_TINT;
  return { label, style: { backgroundColor: tint.soft, color: tint.color } };
}

export function syntheticFile(pathname: string): FileEntry {
  const root = pathname.includes("/.codex/sessions/")
    ? "codex-sessions"
    : pathname.includes("/.claude/projects/")
      ? "claude-projects"
      : /\/tmp\/claude-\d+\//.test(pathname)
        ? "claude-tasks"
        : "codex-jobs";
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

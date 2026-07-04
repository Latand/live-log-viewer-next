import type { FileEntry } from "@/lib/types";
import { cleanTitle } from "@/lib/title";

export { cleanTitle, shortTitle } from "@/lib/title";

export function escText(value: string): string {
  return value.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

export function fmtAge(mtime: number): string {
  const s = Date.now() / 1000 - mtime;
  if (s < 90) return Math.round(s) + " с тому";
  if (s < 5400) return Math.round(s / 60) + " хв тому";
  if (s < 129600) return Math.round(s / 3600) + " год тому";
  return Math.round(s / 86400) + " д тому";
}

export function hhmm(ts: unknown): string {
  if (typeof ts !== "string" && typeof ts !== "number") return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("uk", { hour12: false });
}

/** Ukrainian plural form: ukPlural(n, "гілка", "гілки", "гілок"). */
export function ukPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
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

/** Engine base tint for UI that has no FileEntry yet (e.g. the spawn dialog). */
export function engineTintOf(engine: string): ModelTint {
  return ENGINE_TINTS[engine] ?? NEUTRAL_TINT;
}

/** Model-tinted identity color as a raw value for SVG connectors and dots. */
export function engineColor(file: FileEntry): string {
  return modelTint(file).color;
}

/** Model-tinted top border for columns; inline style so arbitrary tints work. */
export function engineEdge(file: FileEntry): { borderTopColor: string } {
  return { borderTopColor: modelTint(file).color };
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

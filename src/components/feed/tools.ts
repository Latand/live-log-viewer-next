import { getLocale, translate } from "@/lib/i18n";
import { redactSecrets } from "@/lib/review";
import { harnessKind } from "@/lib/wakeup";

import type { GlyphName } from "../icons";
import { formatStdinKeys } from "./ansi";
import { normalizeEdit, type DiffModel } from "./diff";

/* The source-agnostic tool taxonomy (issue #9 §3). One pure summarizer turns a
   raw (tool, args) pair from any engine into a canonical family, an icon, a
   language-neutral summary, and a small set of redacted argument chips. It is
   total: any `Record<string, unknown>` yields a valid result and never throws. */

export type ToolFamily = "shell" | "read" | "write" | "edit" | "search" | "web" | "spawn" | "plan" | "mcp" | "other";

export const TOOL_FAMILIES: readonly ToolFamily[] = ["shell", "read", "write", "edit", "search", "web", "spawn", "plan", "mcp", "other"];

export type ArgChip = { label?: string; value: string };

export interface ToolSummary {
  family: ToolFamily;
  icon: GlyphName;
  summary: string;
  chips: ArgChip[];
}

const SUMMARY_MAX = 160;
const CHIP_MAX = 120;

const tr = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(getLocale(), key, params);

export function familyLabelKey(family: ToolFamily): string {
  return `tools.family.${family}`;
}

const FAMILY_ICON: Record<ToolFamily, GlyphName> = {
  shell: "shell",
  read: "file",
  write: "file",
  edit: "edit",
  search: "search",
  web: "web",
  spawn: "spawn",
  plan: "plan",
  mcp: "tool",
  other: "tool",
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** A session/cell id that may arrive as a number (write_stdin's `session_id`) or
    a string (wait's `cell_id`), coerced to a display string. */
function idOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function basename(path: string): string {
  const clean = path.replace(/[/\\]+$/, "");
  const seg = clean.split(/[/\\]/).pop() ?? clean;
  return seg || clean;
}

/** First non-empty string value in an args record — the generic fallback arg. */
function firstStringArg(args: Record<string, unknown>): string {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function cap(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed;
}

function summaryOf(text: string): string {
  return cap(redactSecrets(text), SUMMARY_MAX);
}

function chip(value: string, label?: string): ArgChip {
  const redacted = cap(redactSecrets(value), CHIP_MAX);
  return label ? { label, value: redacted } : { value: redacted };
}

/* Strips launcher boilerplate (PATH exports, `cd … &&`, the zsh wrapper, an
   outer quote pair, heredoc bodies) from a shell command for the summary line.
   The full command is retained separately by the caller for the expanded view. */
export function cleanShellCommand(cmd: string): string {
  let body = cmd;
  let prev: string;
  do {
    prev = body;
    body = body.replace(/^export PATH=[^;]+;\s*/, "");
    body = body.replace(/^cd\s+\S+\s*&&\s*/, "");
    body = body.replace(/^\/usr\/bin\/zsh -lc\s+/, "");
    body = body.replace(/^(["'])([\s\S]*)\1$/, (whole: string, quote: string, inner: string) =>
      new RegExp(`(?<!\\\\)${quote}`).test(inner) ? whole : inner,
    );
  } while (body !== prev);
  const heredoc = body.match(/^([\w./-]+(?:\s+-)?)\s*<<\s*['"]?(\w+)['"]?/);
  if (heredoc) body = `${heredoc[1].trim()} «heredoc»`;
  return body.replace(/\s+/g, " ").trim();
}

const SHELL_TOOLS = new Set(["Bash", "exec_command", "shell", "local_shell", "run_command"]);
const READ_TOOLS = new Set(["Read"]);
const WRITE_TOOLS = new Set(["Write"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);
const SPAWN_TOOLS = new Set(["Task", "Agent", "Workflow", "Skill"]);
const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "EnterPlanMode", "ExitPlanMode"]);

export function familyOf(tool: string): ToolFamily {
  if (/^mcp__/.test(tool)) return "mcp";
  if (SHELL_TOOLS.has(tool)) return "shell";
  if (READ_TOOLS.has(tool)) return "read";
  if (WRITE_TOOLS.has(tool)) return "write";
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (SEARCH_TOOLS.has(tool)) return "search";
  if (WEB_TOOLS.has(tool)) return "web";
  if (SPAWN_TOOLS.has(tool)) return "spawn";
  if (PLAN_TOOLS.has(tool)) return "plan";
  return "other";
}

function diffCounts(diff: DiffModel): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of diff.files) {
    added += file.added;
    removed += file.removed;
  }
  return { added, removed };
}

function readSummary(args: Record<string, unknown>): { summary: string; chips: ArgChip[] } {
  const path = str(args.file_path ?? args.path);
  if (!path) return { summary: tr("tools.read"), chips: [] };
  const base = basename(path);
  const start = num(args.offset);
  const limit = num(args.limit);
  const range = start !== undefined ? (limit !== undefined ? `:${start}–${start + limit}` : `:${start}`) : "";
  return { summary: `${tr("tools.read")} ${base}${range ? ` · ${range}` : ""}`, chips: [chip(path)] };
}

function editSummary(diff: DiffModel): { summary: string; chips: ArgChip[] } {
  const { added, removed } = diffCounts(diff);
  const counts = `+${added} −${removed}`;
  const files = diff.files;
  if (files.length === 0) return { summary: tr("tools.edit"), chips: [] };
  const chips = files.slice(0, 4).map((file) => chip(file.path));
  if (files.length === 1) {
    return { summary: `${tr("tools.edit")} ${basename(files[0].path)} · ${counts}`, chips };
  }
  return { summary: `${tr("tools.edit")} · ${tr("tools.files", { count: files.length })} · ${counts}`, chips };
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = `${parsed.host}${parsed.pathname}`.replace(/\/$/, "");
    return tail.length > 80 ? tail.slice(0, 79) + "…" : tail;
  } catch {
    return url.length > 80 ? url.slice(0, 79) + "…" : url;
  }
}

/**
 * The one entry point: canonical family, icon, summary, chips for any tool.
 * `precomputedDiff` lets the caller share the diff it already built for the
 * body; when absent, edit/write recompute it locally for the count summary.
 */
export function summarizeTool(
  tool: string,
  args: Record<string, unknown>,
  engine: "claude" | "codex",
  precomputedDiff?: DiffModel,
): ToolSummary {
  const family = familyOf(tool);
  const icon = FAMILY_ICON[family];
  const build = (summary: string, chips: ArgChip[] = []): ToolSummary => ({ family, icon, summary: summaryOf(summary), chips: chips.slice(0, 4) });

  /* Codex interactive-shell control tools (issue #141): render as shell-family
     cards. write_stdin shows the actual keys sent; wait shows the session it is
     tailing — both instead of an opaque "session_id" blob. */
  if (tool === "write_stdin") {
    const session = idOf(args.session_id ?? args.cell_id);
    const chars = str(args.chars);
    /* A poll is exactly an empty payload (no bytes sent); any keystroke — even a
       lone space — is rendered, never mistaken for a poll (finding 2 / #141). */
    const detail = chars.length === 0 ? tr("tools.stdinPoll") : formatStdinKeys(chars);
    const summary = session ? `${tr("tools.stdin")} → ${session} · ${detail}` : `${tr("tools.stdin")} · ${detail}`;
    return { family: "shell", icon: FAMILY_ICON.shell, summary: summaryOf(summary), chips: session ? [chip(session, tr("tools.session"))] : [] };
  }
  if (tool === "wait") {
    const session = idOf(args.cell_id ?? args.session_id);
    const summary = session ? `${tr("tools.wait")} · ${session}` : tr("tools.wait");
    return { family: "shell", icon: FAMILY_ICON.shell, summary: summaryOf(summary), chips: session ? [chip(session, tr("tools.session"))] : [] };
  }

  /* Harness self-scheduling tools (issue #161): render a human summary so their
     arguments read as prose and never as a raw JSON blob. ScheduleWakeup gets a
     dedicated countdown card upstream (see WakeupCard); this summary is its
     collapsed/fallback line and the whole treatment for CronCreate/Monitor. */
  const harness = harnessKind(tool);
  if (harness) {
    if (harness === "wakeup") {
      const reason = str(args.reason);
      const summary = reason ? `${tr("tools.wakeup")} · ${reason}` : tr("tools.wakeup");
      return { family: "plan", icon: "clock", summary: summaryOf(summary), chips: [] };
    }
    if (harness === "cron") {
      const schedule = str(args.schedule ?? args.cron ?? args.interval ?? args.when);
      const label = str(args.name ?? args.prompt ?? args.task ?? args.description);
      const detail = [schedule, label].filter(Boolean).join(" · ");
      const summary = detail ? `${tr("tools.cron")} · ${detail}` : tr("tools.cron");
      const chips: ArgChip[] = [];
      if (schedule) chips.push(chip(schedule, tr("tools.schedule")));
      return { family: "plan", icon: "clock", summary: summaryOf(summary), chips };
    }
    // monitor
    const target = str(args.reason ?? args.until ?? args.description ?? args.target) || firstStringArg(args);
    const summary = target ? `${tr("tools.monitor")} · ${target}` : tr("tools.monitor");
    return { family: "plan", icon: "clock", summary: summaryOf(summary), chips: [] };
  }

  switch (family) {
    case "shell": {
      // Codex shells carry the command under `cmd`, Claude's Bash under `command`.
      const cmd = engine === "codex" ? str(args.cmd ?? args.command) : str(args.command ?? args.cmd);
      return build(cleanShellCommand(cmd) || tool, []);
    }
    case "read": {
      const { summary, chips } = readSummary(args);
      return build(summary, chips);
    }
    case "write": {
      const content = str(args.content ?? args.new_string);
      const path = str(args.file_path ?? args.path);
      const lines = content ? content.split("\n").length : 0;
      const base = path ? basename(path) : "";
      const summary = base ? `${tr("tools.write")} ${base} · ${tr("tools.lines", { count: lines })}` : tr("tools.write");
      return build(summary, path ? [chip(path)] : []);
    }
    case "edit": {
      const diff = precomputedDiff ?? normalizeEdit(tool, args);
      const { summary, chips } = editSummary(diff);
      return build(summary, chips);
    }
    case "search": {
      const pattern = str(args.pattern ?? args.query ?? args.regex);
      const path = str(args.path ?? args.glob ?? args.include);
      const summary = pattern ? `"${pattern}"${path ? ` · ${path}` : ""}` : tool;
      const chips: ArgChip[] = [];
      if (pattern) chips.push(chip(pattern));
      if (path) chips.push(chip(path));
      return build(summary, chips);
    }
    case "web": {
      const url = str(args.url);
      if (url) return build(shortUrl(url), [chip(url)]);
      const query = str(args.query);
      return build(query ? `"${query}"` : tool, query ? [chip(query)] : []);
    }
    case "spawn": {
      const label = str(args.subagent_type ?? args.agentType ?? args.skill ?? args.command ?? args.name ?? args.type);
      const desc = str(args.description ?? args.prompt ?? args.task);
      const summary = [label, desc].filter(Boolean).join(" · ") || tool;
      const chips: ArgChip[] = [];
      if (label) chips.push(chip(label));
      if (desc) chips.push(chip(desc));
      return build(summary, chips);
    }
    case "plan": {
      const todos = Array.isArray(args.todos) ? args.todos.length : undefined;
      const detail = todos !== undefined ? tr("tools.items", { count: todos }) : firstStringArg(args);
      const summary = detail ? `${tool} · ${detail}` : tool;
      return build(summary, detail ? [chip(detail)] : []);
    }
    case "mcp": {
      const parts = tool.replace(/^mcp__/, "").split("__");
      const server = parts[0] ?? tool;
      const name = parts.slice(1).join("__") || tool;
      const key = firstStringArg(args);
      const summary = `${server} · ${name}${key ? ` · ${key}` : ""}`;
      return build(summary, key ? [chip(key)] : []);
    }
    default: {
      const first = firstStringArg(args);
      return build(first ? `${tool}: ${first}` : tool, first ? [chip(first)] : []);
    }
  }
}

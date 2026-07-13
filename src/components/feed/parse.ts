import {
  debugRaw,
  parseReview,
  redactSecrets,
  splitTargetLine,
  VERDICT_LINE_RE,
  type ReviewCardItem,
} from "@/lib/review";
import { getLocale, translate } from "@/lib/i18n";
import { inboxImageExt, MAX_INBOX_IMAGE_BYTES } from "@/lib/imagePolicy";
import type { FileEntry } from "@/lib/types";

import type { GlyphName } from "../icons";
import { hhmm } from "../utils";
import { decodeTerminalText } from "./ansi";
import { diffFromApplyPatch, normalizeEdit, type DiffModel, type FileDiff } from "./diff";
import { familyOf, summarizeTool, type ArgChip, type ToolFamily } from "./tools";

/* Feed labels resolve against the active locale at build/render time; a locale
   flip rebuilds the feed (see LogFeed's memo), so cached items re-localize. */
export const tr = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(getLocale(), key, params);

export type ToolStatus = "run" | "ok" | "err";

/** Structured body attached to an expanded tool event (issue #9 §1). Only the
    diff body is built today; the code/text variants are added when a consumer
    (e.g. a highlighted Read body) actually needs them. */
export type ToolBody = { type: "diff"; files: FileDiff[]; filesTruncated: boolean };

/** One inner operation of a `functions.exec` orchestration record. Per-call
    status and output are not in the transcript — the combined output attaches
    to the outer event — so a nested call carries only what was parsed: its
    target and summary. */
export type NestedCall = {
  id: string;
  tool: string;
  family: ToolFamily;
  icon: GlyphName;
  summary: string;
};

/** The two-level orchestration detail of a `functions.exec` record. */
export type Orchestration = { source: string; sourceTruncated: boolean; calls: NestedCall[] };

/**
 * One normalized, bounded, source-agnostic tool event shared by Claude, Codex,
 * and future engines. Every string field is redacted and capped inside the
 * `newToolEvent`/`attachResult` funnel, so no renderer, copy, or speech
 * consumer can reach an unbounded or unredacted value.
 */
export type ToolEvent = {
  kind: "tool";
  id: string;
  ts: unknown;
  /** Absolute line index of the tool_use/function_call record (provenance). */
  srcCall: number;
  /** Absolute line index of the result record, once attached. */
  srcResult?: number;
  family: ToolFamily;
  tool: string;
  icon: GlyphName;
  summary: string;
  chips: ArgChip[];
  body?: ToolBody;
  /** Highlight hint for an output rendered as code (Read/Write bodies). */
  lang?: string | null;
  /** Full redacted command text for the shell `$` line in the expanded view. */
  command?: string;
  status: ToolStatus;
  statusLabel: string;
  outputPreview: string;
  outputTruncated: boolean;
  open: boolean;
  orchestration?: Orchestration;
};
export type CitationEntry = {
  target: string;
  line?: string;
  note?: string;
  raw: string;
};
export type MemCitationItem = {
  kind: "mem-citation";
  entries: CitationEntry[];
  rolloutIds: string[];
  raw: string;
  truncated: boolean;
};
export type Tmsg = {
  kind: "tmsg";
  ts: unknown;
  dir: "in" | "out";
  peer: string;
  summary: string;
  text: string;
  /** Outgoing only: delivery state recovered from the tool result. */
  delivery?: "ok" | "err";
  msgId?: string;
};
export type CmdGroupItem = {
  kind: "cmd-group";
  ids: string[];
  calls: ToolEvent[];
  t0: unknown;
  t1: unknown;
  byTool: Record<string, number>;
  okCount: number;
  errCount: number;
  hasErr: boolean;
};
export type Item =
  | { kind: "prose"; ts: unknown; text: string; engine: "codex" | "claude" }
  | { kind: "user"; ts: unknown; text: string }
  | { kind: "svc"; text: string }
  | { kind: "note"; text: string }
  | ToolEvent
  | CmdGroupItem
  | ReviewCardItem
  | MemCitationItem
  | Tmsg
  | { kind: "tnote"; text: string }
  | { kind: "think"; text: string }
  | { kind: "image"; media: string; data: string; w?: number; h?: number; bytes?: number }
  | { kind: "inbox-image"; name: string; path: string }
  | { kind: "blob"; bytes: number; text: string }
  | { kind: "sysmsg"; label: string; text: string }
  | { kind: "compact"; ts: unknown; trigger?: string; preTokens?: number; summary?: string }
  | { kind: "raw"; text: string; err: boolean };

/** One rendered feed row: `key` is stable across incremental re-feeds, so a
    row keeps its DOM node (and its memoized render) while the tail grows. */
export interface FeedEntry {
  /** Source-position identity for viewport restoration across parser resets. */
  anchorKey: string | null;
  key: string;
  item: Item;
}

export interface FeedSnapshot {
  items: FeedEntry[];
  hiddenServiceCount: number;
}

export interface FeedSessionConfig {
  engine: string;
  fmt: string;
  showSvc: boolean;
  /** Lowercased needle; empty string disables filtering. */
  lineFilter: string;
}

export interface FeedSession {
  /**
   * Consume the current line window and return the rendered feed. `start` is
   * the absolute index of `lines[0]` in the tail stream (see useLogTail's
   * `linesStart`): the session parses only lines it has not seen, drops items
   * whose source lines slid out of the window, and keeps every untouched
   * item's identity so memoized rows skip re-rendering. A window that moved
   * backwards (prepend, truncation) resets the session and re-parses.
   */
  feed(lines: string[], start: number, isLive: boolean): FeedSnapshot;
}

const BLOB_MIN = 20_000;
const BLOB_KEEP = 200_000;
const ATTACHMENT_TYPE_MAX = 80;
const MEM_CITATION_RE = /<oai-mem-citation>\s*<citation_entries>([\s\S]*?)<\/citation_entries>\s*<rollout_ids>([\s\S]*?)<\/rollout_ids>\s*<\/oai-mem-citation>/g;

/* A near-whitespace-free run this large is base64/binary:
   render it as a compact chip to keep the feed readable. */
function looksLikeBlob(text: string): boolean {
  if (text.length <= BLOB_MIN) return false;
  const ws = text.match(/\s/g)?.length ?? 0;
  return ws / text.length < 0.02;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/* Both inter-agent envelopes card-ify the same way: <teammate-message …> and
   <agent-message from="…"> carry the sender in different attribute names. */
const TMSG_RE = /<(teammate-message|agent-message)\b([^>]*)>([\s\S]*?)<\/\1>/g;

/* Inbox image paths the composer appends to a delivered message, one per line
   after the text (src/lib/tmux.ts buildImagePayload). The captured basename is
   what /api/inbox accepts. Both inbox homes match: the current
   agent-log-viewer/inbox and the legacy .claude/viewer-inbox that old
   transcripts still reference. */
const INBOX_PATH_RE = /\S*\/(?:agent-log-viewer\/inbox|\.claude\/viewer-inbox)\/([A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp))/gi;

interface InboxImageRef {
  name: string;
  path: string;
}

/* A line that is only inbox path(s) folds away entirely — its card replaces
   it; a path mentioned mid-sentence keeps its line verbatim and still gets a
   card, so prose around it never garbles. */
function extractInboxImages(text: string): { cleaned: string; images: InboxImageRef[] } {
  if (!text.includes("/.claude/viewer-inbox/") && !text.includes("/agent-log-viewer/inbox/")) return { cleaned: text, images: [] };
  const images: InboxImageRef[] = [];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const rest = line.replace(INBOX_PATH_RE, (whole, name: string) => {
      if (!seen.has(whole)) {
        seen.add(whole);
        images.push({ name, path: whole });
      }
      return "";
    });
    if (rest.trim()) kept.push(line);
  }
  return { cleaned: kept.join("\n").trim(), images };
}

function sysMsgLabel(text: string, fallback?: string): string {
  const tag = text.match(/^\s*<([a-zA-Z][\w:-]*)/)?.[1];
  if (tag) return tag;
  if (/^\s*# AGENTS\.md/.test(text)) return "AGENTS.md";
  if (/^\s*Caveat:/.test(text)) return "caveat";
  return fallback || tr("render.system");
}

function tmsgAttr(attrs: string, name: string): string {
  return attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
}

function textPart(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((x): x is Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x)) : [];
}

function hasNonEmptyValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasNonEmptyValue);
  return value !== null && typeof value === "object" && Object.values(value).some(hasNonEmptyValue);
}

function codexAttachmentLabel(type: string): string {
  const normalized = type.trim().replace(/[_-]/g, " ");
  if (!normalized) return "Attachment";
  return `Attachment: ${normalized.slice(0, ATTACHMENT_TYPE_MAX)}${normalized.length > ATTACHMENT_TYPE_MAX ? "…" : ""}`;
}

function base64DecodedLength(base64: string): number {
  if (!base64.length) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function codexImageFromDataUrl(value: string): Extract<Item, { kind: "image" }> | null {
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const media = match[1].toLowerCase();
  if (!inboxImageExt(media)) return null;
  if (base64DecodedLength(match[2]) > MAX_INBOX_IMAGE_BYTES) return null;
  return { kind: "image", media, data: match[2] };
}

function inboxImagesFromPath(path: string): Extract<Item, { kind: "inbox-image" }>[] {
  const { images } = extractInboxImages(path);
  return images.map((image) => ({ kind: "inbox-image", ...image }));
}

interface CodexUserContent {
  text: string;
  attachments: Item[];
}

/* Codex has added content-part variants over time. Keep the text path broad,
   render approved inline raster data as an image, and describe every other
   non-empty attachment without exposing its payload in the feed. */
function normalizeCodexUserContent(content: unknown): CodexUserContent {
  const text: string[] = [];
  const attachments: Item[] = [];
  for (const part of arr(content)) {
    const type = textPart(part.type);
    const partText = textPart(part.text) || textPart(part.input_text) || textPart(part.output_text);
    if (partText) text.push(partText);

    if (type === "input_image" || type === "image") {
      const imageUrl = textPart(part.image_url) || textPart(rec(part.image_url).url) || textPart(part.data);
      const image = codexImageFromDataUrl(imageUrl);
      if (image) attachments.push(image);
      else if (hasNonEmptyValue(part)) attachments.push({ kind: "note", text: codexAttachmentLabel(type) });
      continue;
    }

    if (type === "local-image" || type === "local_image" || type === "localImage") {
      const path = textPart(part.path) || textPart(part.local_path) || textPart(part.image_url) || textPart(part.url);
      const images = inboxImagesFromPath(path);
      if (images.length) attachments.push(...images);
      else if (hasNonEmptyValue(part)) attachments.push({ kind: "note", text: codexAttachmentLabel(type) });
      continue;
    }

    if ((type === "input_text" || type === "text" || type === "output_text") && partText) continue;
    if (!partText && hasNonEmptyValue(part)) {
      attachments.push({ kind: "note", text: codexAttachmentLabel(type) });
    }
  }
  return { text: text.join(" ").trim(), attachments };
}

/** Responses custom tools return either plain text or typed text blocks. */
function toolOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return arr(value)
      .map((part) => textPart(part.text) || textPart(part.input_text) || textPart(part.output_text))
      .filter(Boolean)
      .join("\n");
  }
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

function toolOutputFailed(text: string): boolean {
  return /^Script failed\b/im.test(text) || /\b(?:exit|exited with) code [1-9]\d*\b/i.test(text);
}

function parseMemCitation(matchText: string, entriesText: string, idsText: string): MemCitationItem {
  const entries = entriesText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((raw): CitationEntry => {
      const note = raw.match(/\|note=\[(.*)\]$/)?.[1];
      const locator = raw.replace(/\|note=\[.*\]$/, "");
      const target = splitTargetLine(locator);
      return { target: target.target, line: target.line, note, raw };
    });
  const rolloutIds = idsText
    .split(/\s+/)
    .map((id) => id.trim())
    .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  const raw = debugRaw(matchText);
  return { kind: "mem-citation", entries, rolloutIds, raw: raw.raw, truncated: raw.truncated };
}

const CMD_GROUP_MIN = 2;
/* Output preview caps (unchanged from the original cmd model): ok output keeps
   the last 12 KB, an error the last 60 KB. The full command line keeps a bound
   too, so a giant heredoc cannot balloon the DOM in the expanded view. */
const OUTPUT_OK_MAX = 12_000;
const OUTPUT_ERR_MAX = 60_000;
const COMMAND_MAX = 8_000;
/* A Codex result-preamble line (custom-tool + interactive-shell wrappers, all
   known variants). Used to strip the contiguous leading metadata block. */
const PREAMBLE_LINE = /^(?:Chunk ID:|Wall time\b|Original token count:|Output:[ \t]*$|Script completed\b|Script running with (?:cell|session) ID\b|Process running with (?:cell|session) ID\b|Process exited with code\b)/;
const CODE_EXT_RE = /\.([A-Za-z0-9]{1,10})$/;

function extLang(path: string): string | null {
  return path.match(CODE_EXT_RE)?.[1]?.toLowerCase() ?? null;
}

/* Grouping bucket key: the verbatim tool name, falling back to the family for
   engine calls that carry none (Codex shell, plain job-log commands). */
function toolBucket(event: ToolEvent): string {
  return event.tool || event.family;
}

/* Any tool event folds into a cmd-group (design doc §3.4: a run of ≥2
   consecutive tool events — Read/Bash/Edit/… alike — reads as one quiet
   ToolLine header). Diff-bodied edits and orchestration records fold too: the
   shared ToolLine reveals their diff / nested-call body when the group row is
   expanded, so nothing is lost by collapsing them into the quiet run. */
function foldableTool(item: Item): item is ToolEvent {
  return item.kind === "tool";
}

/* Maps a `tools.<method>` orchestration call to a canonical tool name so the
   nested row reuses the same summarizer/icon as a top-level call. */
const ORCH_METHOD_TOOL: Record<string, string> = {
  exec_command: "Bash",
  shell: "Bash",
  bash: "Bash",
  read_file: "Read",
  read: "Read",
  view_image: "Read",
  write_file: "Write",
  write: "Write",
  apply_patch: "apply_patch",
  edit_file: "Edit",
  search: "Grep",
  grep: "Grep",
  glob: "Glob",
  fetch: "WebFetch",
  web_search: "WebSearch",
};
/* Compose helpers shape display output. Render them as quiet semantic labels
   outside full tool rows (issue #9 fresh production evidence). */
const ORCH_HELPERS = new Set(["text", "image", "generatedImage", "store", "notify"]);
const ORCH_CALL_RE = /\btools\.([A-Za-z_]\w*)\s*\(/g;
const ORCH_HELPER_RE = /(?:^|[^.\w])(text|image|generatedImage|store|notify)\s*\(/g;
const ORCH_MAX_CALLS = 16;

/* Reads a JS string/template literal that opens at `start` (its quote char) and
   returns the index of the matching close quote. Backslash escapes are skipped;
   a template literal's ${…} body is scanned as plain text, which is enough for
   the machine-generated argument literals Codex emits (no nested backticks). */
function skipStringLiteral(src: string, start: number): number {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) return i;
  }
  return src.length - 1;
}

/* Slices the argument source of a `tools.method(` call — the text between the
   opening paren at `open` and its balanced close — skipping nested brackets and
   string/template literals so a `)` inside a command never ends it early. */
function sliceCallArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/* Value of a named field in an object-literal argument source
   (`{cmd: "…", workdir: "…"}`). Returns "" when the key is absent or its value
   is not a string/template literal (e.g. a bare variable or a number). */
function objFieldValue(argsSrc: string, keys: readonly string[]): string {
  for (const key of keys) {
    const re = new RegExp(`(?:^|[{,([\\s])${key}\\s*:\\s*`);
    const m = re.exec(argsSrc);
    if (!m) continue;
    const start = (m.index ?? 0) + m[0].length;
    const ch = argsSrc[start];
    if (ch === '"' || ch === "'" || ch === "`") return argsSrc.slice(start + 1, skipStringLiteral(argsSrc, start));
  }
  return "";
}

/* The first string/template literal in an argument source. */
function firstLiteral(argsSrc: string): string {
  for (let i = 0; i < argsSrc.length; i += 1) {
    const ch = argsSrc[i];
    if (ch === '"' || ch === "'" || ch === "`") return argsSrc.slice(i + 1, skipStringLiteral(argsSrc, i));
  }
  return "";
}

/* Only meaningful for a positional call (`tools.exec_command(cmd)`); an object
   literal is skipped so a non-target field (workdir, encoding) never
   masquerades as the value. */
function positionalLiteral(argsSrc: string): string {
  return /^\s*\{/.test(argsSrc) ? "" : firstLiteral(argsSrc);
}

/* Resolves the string a nested-call field points at, in order: an inline
   literal (`cmd: "git status"`), a shorthand (`{cmd}`), or an identifier
   (`cmd: c`) chased back to the `const c = <literal>` that defined it in the
   block. Returns "" when the value is built at runtime (a loop/destructured
   variable, a call expression), which is genuinely unrecoverable statically. */
function resolveField(argsSrc: string, fullInput: string, keys: readonly string[]): string {
  for (const key of keys) {
    const literal = objFieldValue(argsSrc, [key]);
    if (literal) return literal;
    const ref = new RegExp(`(?:^|[{,\\s])${key}\\s*(?::\\s*([A-Za-z_$][\\w$]*)\\s*[,}]|[,}])`).exec(argsSrc);
    if (!ref) continue;
    const ident = ref[1] ?? key;
    const def = new RegExp(`\\b(?:const|let|var)\\s+${ident}\\s*=\\s*`).exec(fullInput);
    if (!def) continue;
    const start = def.index + def[0].length;
    const ch = fullInput[start];
    if (ch === '"' || ch === "'" || ch === "`") return fullInput.slice(start + 1, skipStringLiteral(fullInput, start));
  }
  return "";
}

/* Decodes the escape sequences of a JavaScript string literal's body. The
   apply_patch payload usually lives inside a `const patch = "…"` double-quoted
   literal, so its newlines arrive as a two-char `\n` and its quotes as `\"`;
   left raw they would render as one escaped line rather than a diff. A template
   literal (backticks) carries real newlines and needs no decode — its body has
   no escapes to match, so this is a no-op there. */
function decodeJsString(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (whole, seq: string) => {
    switch (seq[0]) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
        return seq.length === 1 ? "\0" : whole;
      case "u":
      case "x":
        return String.fromCodePoint(parseInt(seq.slice(1), 16));
      case "\n":
        return ""; // escaped line continuation
      case '"':
      case "'":
      case "`":
      case "\\":
        return seq;
      default:
        return seq; // unknown escape: keep the char, drop the backslash
    }
  });
}

/* Pulls every apply_patch payload out of a Codex exec's JS source and decodes
   the surrounding literal, so a `const patch = "*** Begin Patch\n…"` assignment
   (or an inline string argument) becomes real multi-line patch text ready for
   {@link diffFromApplyPatch}. Empty when no `*** Begin Patch` block is present
   or the patch is built at runtime. */
function applyPatchBody(input: string): string {
  const blocks = input.match(/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/g);
  return blocks ? blocks.map(decodeJsString).join("\n") : "";
}

/* Builds canonical summarizer args for one nested `tools.method(argsSrc)` call,
   pulling the meaningful field (command, path, pattern, url) out of the argument
   source so the nested row summarizes like a first-class tool call rather than
   grabbing whatever substring happened to be quoted first. */
function orchCallArgs(tool: string, argsSrc: string, fullInput: string): Record<string, unknown> {
  switch (familyOf(tool)) {
    case "shell":
      return { command: resolveField(argsSrc, fullInput, ["cmd", "command"]) || positionalLiteral(argsSrc) };
    case "read":
    case "write":
      return { file_path: resolveField(argsSrc, fullInput, ["path", "file_path", "filePath"]) || positionalLiteral(argsSrc) };
    case "search":
      return {
        pattern: resolveField(argsSrc, fullInput, ["pattern", "query", "regex", "q"]) || positionalLiteral(argsSrc),
        path: objFieldValue(argsSrc, ["path", "glob", "include"]),
      };
    case "web":
      return { url: resolveField(argsSrc, fullInput, ["url"]) || positionalLiteral(argsSrc) };
    case "edit": {
      /* apply_patch's argument is usually a `patch` variable, so recover the
         patch body from the surrounding source (the literal's `\n`, `\"`, … are
         decoded) to keep the file names — and the real diff — in view. */
      return { input: applyPatchBody(fullInput) };
    }
    default:
      /* Codex helper methods (create_goal, update_plan, view_image, …) carry no
         canonical field, so name them by their first string argument. */
      return { value: objFieldValue(argsSrc, ["cmd", "path", "url", "query", "pattern", "goal", "step", "title", "name"]) || firstLiteral(argsSrc) };
  }
}

/* A `const cmds = [[label, command, …], …]` batch mapped into a single
   `tools.exec_command({cmd})` call: the runtime `cmd` is a destructured loop
   variable, but every command is a static string element of the array. Recovers
   those command heads so the batch reads as a real multi-command record instead
   of one blank shell row. Returns [] when no such array of tuples is present. */
function batchCommands(fullInput: string): string[] {
  const tuples = fullInput.match(/=\s*\[\s*\[[\s\S]*?\]\s*,?\s*\]/)?.[0];
  if (!tuples) return [];
  const commands: string[] = [];
  for (let i = 0; i < tuples.length && commands.length < ORCH_MAX_CALLS; i += 1) {
    const ch = tuples[i];
    if (ch !== '"' && ch !== "'" && ch !== "`") continue;
    const end = skipStringLiteral(tuples, i);
    const value = tuples.slice(i + 1, end);
    i = end;
    /* A command carries a space and a bareword head; the tuple's label and
       path/url elements (no space, or a leading `/`/`http`/`#`) are skipped. */
    if (/\s/.test(value.trim()) && !/^\s*(?:[/#]|https?:)/.test(value)) commands.push(value);
  }
  return commands;
}

/**
 * Recognizes a Codex `functions.exec` orchestration (a `custom_tool_call` whose
 * JS input drives `tools.*` operations) and turns it into a meaningful outer
 * summary plus structured nested children. The nested per-call status/output is
 * not separately recorded in the transcript — the combined output attaches to
 * the outer event — so children carry their statically-parsed target summary;
 * the full source and raw record expose the ground truth at level 2. Returns
 * null for a plain custom tool, which keeps rendering as one generic row.
 */
function parseOrchestration(input: string): { overlay: Partial<ToolEvent>; body?: Orchestration; diff?: DiffModel } | null {
  if (!input || !/\btools\.[A-Za-z_]\w*\s*\(/.test(input)) return null;
  const calls: NestedCall[] = [];
  ORCH_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ORCH_CALL_RE.exec(input)) && calls.length < ORCH_MAX_CALLS) {
    const method = match[1];
    const open = match.index + match[0].length - 1; // the '(' at the end of the match
    const argsSrc = sliceCallArgs(input, open);
    const tool = ORCH_METHOD_TOOL[method] ?? method;
    const s = summarizeTool(tool, orchCallArgs(tool, argsSrc, input), "codex");
    calls.push({ id: `${method}#${calls.length}`, tool: method, family: s.family, icon: s.icon, summary: s.summary });
  }
  ORCH_HELPER_RE.lastIndex = 0;
  while ((match = ORCH_HELPER_RE.exec(input)) && calls.length < ORCH_MAX_CALLS) {
    const helper = match[1];
    if (!ORCH_HELPERS.has(helper)) continue;
    calls.push({ id: `${helper}#${calls.length}`, tool: helper, family: "other", icon: "note", summary: helper });
  }
  const toolCalls = calls.filter((call) => call.icon !== "note");
  if (!toolCalls.length) return null;
  const source = redactSecrets(input).slice(0, COMMAND_MAX);
  const sourceTruncated = input.length > COMMAND_MAX;

  /* An apply_patch payload embedded in the JS source parses into the same diff
     model a first-class apply_patch gets, so the card renders the structured
     DiffCard instead of dumping the escaped `const patch = "…"` string. The edit
     op is represented by the diff itself, so it is dropped from the nested rows
     to avoid showing the same change twice (issue #90). */
  const patchText = applyPatchBody(input);
  const patchDiff = patchText ? diffFromApplyPatch(patchText) : undefined;
  if (patchDiff && patchDiff.files.length) {
    const editView = summarizeTool("apply_patch", { input: patchText }, "codex", patchDiff);
    const others = toolCalls.filter((call) => call.family !== "edit");
    if (others.length === 0) {
      /* Pure apply_patch: a clean diff card. The JS source stays reachable
         through the level-2 raw record, never dumped into the body. */
      return { overlay: { summary: editView.summary, icon: editView.icon, family: "edit", chips: editView.chips }, diff: patchDiff };
    }
    /* Mixed record: the diff plus the remaining (non-edit) nested operations. */
    const nested = calls.filter((call) => call.family !== "edit");
    return {
      overlay: {
        summary: `${editView.summary} · ${tr("tools.orchestration", { count: others.length })}`.slice(0, 160),
        icon: "cmd-group",
        family: "edit",
        chips: editView.chips,
      },
      body: { source, sourceTruncated, calls: nested },
      diff: patchDiff,
    };
  }

  /* A single shell op whose command didn't resolve (summary is the bare tool
     name, no space) but which maps over a static command-tuple array expands
     into one nested row per command — the batch it actually runs. */
  let nested = calls;
  let ops = toolCalls;
  if (toolCalls.length === 1 && toolCalls[0].family === "shell" && !/\s/.test(toolCalls[0].summary)) {
    const batch = batchCommands(input);
    if (batch.length >= 2) {
      nested = batch.map((cmd, i) => {
        const s = summarizeTool("Bash", { command: cmd }, "codex");
        return { id: `exec_command#${i}`, tool: "exec_command", family: s.family, icon: s.icon, summary: s.summary };
      });
      ops = nested;
    }
  }
  const lead = ops[0];
  /* A lone operation reads as its own card — same summary, icon, and family a
     first-class shell/read/edit call would get. A multi-op record leads with
     the first command's head and tags the remaining count. The raw JS source is
     carried by the orchestration body, so the card never needs an argument chip. */
  const overlay: Partial<ToolEvent> =
    ops.length === 1
      ? { summary: lead.summary, icon: lead.icon, family: lead.family, chips: [] }
      : { summary: `${lead.summary} · ${tr("tools.orchestration", { count: ops.length })}`.slice(0, 160), icon: "cmd-group", chips: [] };
  return { overlay, body: { source, sourceTruncated, calls: nested } };
}

interface StoredEntry {
  /** Monotonic push counter — the React key; consecutive within `entries`. */
  seq: number;
  /** Initial source line. A later echo can move `src`; crossing that seam
      requires a fresh window parse to preserve one-shot ordering. */
  bornSrc: number;
  /** Absolute index of the source line, for window-slide eviction. */
  src: number;
  item: Item;
}

interface CallRec {
  event: ToolEvent;
  seq: number;
}

interface PendingCodexUser {
  src: number;
  ts: unknown;
  text: string;
  entrySeqs: number[];
}

type CodexAssistantShape = "event-agent" | "response-assistant";

interface CodexAssistantRecord {
  shape: CodexAssistantShape;
  text: string;
  ts: unknown;
  src: number;
  firstSeq: number;
  lastSeq: number;
}

function sameCodexTextAtTime(leftTs: unknown, leftText: unknown, rightTs: unknown, rightText: unknown): boolean {
  const leftNormalizedText = textPart(leftText).trim();
  const rightNormalizedText = textPart(rightText).trim();
  if (!leftNormalizedText || leftNormalizedText !== rightNormalizedText) return false;

  const a = textPart(leftTs).trim();
  const b = textPart(rightTs).trim();
  if (!a || !b) return false;
  if (a === b) return true;

  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return Math.abs(aTime - bTime) <= 1_000;

  const synthetic = /^(.*?)(\d+)(?:\.(\d+))?$/;
  const aMatch = a.match(synthetic);
  const bMatch = b.match(synthetic);
  if (!aMatch || !bMatch || aMatch[1] !== bMatch[1]) return false;
  const aValue = Number(aMatch[2] + "." + (aMatch[3] ?? "0"));
  const bValue = Number(bMatch[2] + "." + (bMatch[3] ?? "0"));
  return Math.abs(aValue - bValue) <= 0.01;
}

function claudeContentText(content: unknown): string {
  return typeof content === "string" ? content : arr(content).map((part) => textPart(part.text)).filter(Boolean).join("\n");
}

function isClaudeProtocolUser(obj: Record<string, unknown>, content: unknown): boolean {
  const originKind = textPart(rec(obj.origin).kind);
  /* Claude records queued human input with the same envelope fields that its
     harness uses. Explicit human provenance and typed prompts keep their
     transcript role through any wrapper text. */
  if (originKind === "human" || textPart(obj.promptSource) === "typed") return false;
  if (obj.isMeta === true || "interruptedMessageId" in obj || "promptSource" in obj || "origin" in obj) return true;
  const text = claudeContentText(content).trim();
  return (
    /^\[Request interrupted by user\]$/.test(text) ||
    /^<local-command-caveat>\s*Caveat:[\s\S]*<\/local-command-caveat>$/.test(text) ||
    /^<task-notification\b[^>]*>[\s\S]*<\/task-notification>$/.test(text) ||
    /^This came from another Claude session\b[\s\S]*not typed by your user[\s\S]*$/.test(text)
  );
}

/**
 * The stateful line-window parser behind a feed pane. All cross-line effects
 * (tool_result attaching to its call, teammate delivery echoes, compaction
 * summaries, prose/echo dedup) mutate copy-on-write: the affected entry gets
 * a new item object while every other entry keeps its identity — that is what
 * lets memoized FeedItems skip markdown re-render on every tail tick.
 */
export function createFeedSession(cfg: FeedSessionConfig): FeedSession {
  const { showSvc, lineFilter } = cfg;
  const jsonl = cfg.fmt === "claude" || cfg.fmt === "codex";

  const entries: StoredEntry[] = [];
  const calls = new Map<string, CallRec>();
  /* Outgoing teammate messages awaiting their delivery echo, by tool_use id;
     the reverse map exists only so window-slide eviction can prune. */
  const tmsgSeqs = new Map<string, number>();
  const tmsgKeyBySeq = new Map<number, string>();
  /* Hidden service rows are counted, not stored; per-line counts let the
     total shrink when their source lines slide out of the window. */
  const hiddenSvcBySrc = new Map<number, number>();
  let hiddenServiceCount = 0;
  let pushSeq = 0;
  let curSrc = 0;
  /** Absolute index just past the last consumed line; null before first feed. */
  let consumedEnd: number | null = null;
  /** Window start of the previous feed — a start that moved backwards means
      prepended history, which a sequential parser cannot resume across. */
  let lastStart = -Infinity;
  /* Dedup/marker state remembers the source line it came from: when that line
     slides out of the window the state clears, matching what a re-parse of
     the shortened window would know. */
  let codexAssistantRecord: CodexAssistantRecord | null = null;
  /* A composer turn is recorded as a user response item immediately followed
     by its user_message event. The event owns the logical turn, while this
     provisional record keeps a live tail visible until its echo arrives. */
  let pendingCodexUsers: PendingCodexUser[] = [];
  let codexCompacted: { src: number } | null = null;
  let plainBlock: { lines: string[]; src: number } | null = null;
  let lastPlainCall: CallRec | null = null;
  /* Snapshot cache + fold-group identity reuse across re-feeds. */
  let prevGroups = new Map<number, CmdGroupItem>();
  let snapshot: FeedSnapshot | null = null;
  let snapshotLive: boolean | null = null;

  const entryIndex = (seq: number): number => (entries.length ? seq - entries[0].seq : -1);

  const push = (item: Item): number => {
    entries.push({ seq: pushSeq, bornSrc: curSrc, src: curSrc, item });
    snapshot = null;
    return pushSeq++;
  };

  const pushBlobIfHuge = (text: string): boolean => {
    if (!looksLikeBlob(text)) return false;
    push({ kind: "blob", bytes: text.length, text: redactSecrets(text).slice(0, BLOB_KEEP) });
    return true;
  };
  const pushImage = (block: Record<string, unknown>, fileWrap: Record<string, unknown>) => {
    const source = rec(block.source);
    const data = textPart(source.data) || textPart(fileWrap.base64);
    if (!data) return;
    const mt = textPart(source.media_type) || textPart(fileWrap.type);
    const media = mt.startsWith("image/") ? mt : "image/png";
    const dims = rec(fileWrap.dimensions);
    push({
      kind: "image",
      media,
      data,
      w: num(dims.originalWidth),
      h: num(dims.originalHeight),
      bytes: num(fileWrap.originalSize),
    });
  };
  /* Recognises a Codex review verdict/findings block and any <oai-mem-citation>
     block inside `text`, rendering them as structured cards. Runs for both the
     codex feed and quoted review text inside a claude transcript. Non-structured
     segments are handed back through `fallback` so callers keep their own bubble
     style (prose vs user). Returns true when at least one card was produced.
     `emit` defaults to the session store; the pending-plain-block preview passes
     a transient collector instead. */
  const pushStructured = (ts: unknown, text: string, fallback: (segment: string) => void, emit: (item: Item) => void = push): boolean => {
    MEM_CITATION_RE.lastIndex = 0;
    const hasCitation = MEM_CITATION_RE.test(text);
    MEM_CITATION_RE.lastIndex = 0;
    if (!hasCitation) {
      const review = parseReview(text.trim(), ts);
      if (!review) return false;
      emit(review);
      return true;
    }
    let handled = false;
    let last = 0;
    const pushTextPart = (part: string) => {
      const trimmed = part.trim();
      if (!trimmed) return;
      const review = parseReview(trimmed, ts);
      if (review) {
        emit(review);
        handled = true;
      } else {
        fallback(trimmed);
      }
    };
    for (const match of text.matchAll(MEM_CITATION_RE)) {
      const whole = match[0];
      const index = match.index ?? 0;
      pushTextPart(text.slice(last, index));
      emit(parseMemCitation(whole, match[1] ?? "", match[2] ?? ""));
      handled = true;
      last = index + whole.length;
    }
    pushTextPart(text.slice(last));
    return handled;
  };
  /* Teammate message bodies can quote <oai-mem-citation> XML; keep the card body
     clean and render the citations as their own chips right after it. */
  const splitCitations = (text: string): { cleaned: string; cites: MemCitationItem[] } => {
    const cites: MemCitationItem[] = [];
    MEM_CITATION_RE.lastIndex = 0;
    const cleaned = text
      .replace(MEM_CITATION_RE, (whole, entries: string, ids: string) => {
        cites.push(parseMemCitation(whole, entries, ids));
        return "";
      })
      .trim();
    return { cleaned, cites };
  };
  const addProse = (ts: unknown, text: string): { firstSeq: number; lastSeq: number } | null => {
    if (!text.trim()) return null;
    const firstSeq = pushSeq;
    if (pushBlobIfHuge(text)) return { firstSeq, lastSeq: pushSeq - 1 };
    const engine = cfg.engine === "codex" ? "codex" : "claude";
    if (pushStructured(ts, text, (segment) => push({ kind: "prose", ts, text: segment, engine }))) {
      return { firstSeq, lastSeq: pushSeq - 1 };
    }
    push({ kind: "prose", ts, text, engine });
    return { firstSeq, lastSeq: pushSeq - 1 };
  };
  const addCodexAssistant = (shape: CodexAssistantShape, ts: unknown, text: string) => {
    const normalizedText = text.trim();
    const candidate = codexAssistantRecord;
    if (
      candidate &&
      candidate.shape !== shape &&
      candidate.src === curSrc - 1 &&
      candidate.text === normalizedText &&
      sameCodexTextAtTime(candidate.ts, candidate.text, ts, normalizedText)
    ) {
      const eventTimestamp = shape === "event-agent" ? ts : candidate.shape === "event-agent" ? candidate.ts : ts;
      for (let seq = candidate.firstSeq; seq <= candidate.lastSeq; seq += 1) {
        const idx = entryIndex(seq);
        if (idx < 0 || idx >= entries.length) continue;
        const entry = entries[idx];
        const item = entry.item;
        entries[idx] = {
          ...entry,
          src: curSrc,
          item: item.kind === "prose" || item.kind === "review" ? { ...item, ts: eventTimestamp } : item,
        };
      }
      codexAssistantRecord = null;
      snapshot = null;
      return;
    }
    const emitted = addProse(ts, text);
    codexAssistantRecord = emitted
      ? { shape, text: normalizedText, ts, src: curSrc, firstSeq: emitted.firstSeq, lastSeq: emitted.lastSeq }
      : null;
  };
  /* One redaction/cap funnel for every tool event: the summary and chips are
     already redacted by summarizeTool, the diff by diff.ts; the full command is
     redacted and bounded here. No call site may build a ToolEvent by hand. */
  const newToolEvent = (opts: {
    ts: unknown;
    id: string;
    tool: string;
    args?: Record<string, unknown>;
    engine: "claude" | "codex";
    command?: string;
    diff?: DiffModel;
    lang?: string | null;
    summary?: string;
  }): ToolEvent => {
    const args = opts.args ?? {};
    const family = familyOf(opts.tool);
    const diff = opts.diff ?? (family === "edit" || family === "write" ? normalizeEdit(opts.tool, args) : undefined);
    const s = summarizeTool(opts.tool, args, opts.engine, diff);
    const body: ToolBody | undefined = diff && diff.files.length ? { type: "diff", files: diff.files, filesTruncated: diff.filesTruncated } : undefined;
    const command = opts.command !== undefined ? redactSecrets(opts.command).slice(0, COMMAND_MAX) : undefined;
    const summary = opts.summary !== undefined ? redactSecrets(opts.summary).replace(/\s+/g, " ").trim().slice(0, 160) : s.summary;
    return {
      kind: "tool",
      id: opts.id,
      ts: opts.ts,
      srcCall: curSrc,
      family: s.family,
      tool: opts.tool,
      icon: s.icon,
      summary,
      chips: s.chips,
      body,
      lang: opts.lang,
      command,
      status: "run",
      statusLabel: tr("render.executing"),
      outputPreview: "",
      outputTruncated: false,
      /* An edit/write card opens its structured diff inline by default — a
         compact preview of the first lines, with a toggle for the rest — so the
         change is visible without a click (issue #90). */
      open: Boolean(body),
    };
  };
  const registerCall = (event: ToolEvent): CallRec => {
    const seq = push(event);
    const rec: CallRec = { event, seq };
    calls.set(event.id, rec);
    return rec;
  };
  /* A shell command from any engine. `callId` is absent for plain job logs, so
     a synthetic id keeps the row addressable (and the last one attachable). */
  const addShell = (ts: unknown, command: string, callId?: string, tool = "Bash"): ToolEvent => {
    const id = callId || "plain-" + pushSeq + "-" + String(ts ?? "");
    const engine = cfg.engine === "codex" ? "codex" : "claude";
    const event = newToolEvent({ ts, id, tool, args: { command }, engine, command });
    const rec = registerCall(event);
    if (!callId) lastPlainCall = rec;
    return event;
  };
  /* apply_patch (either the function_call or the custom_tool_call shape) → a
     diff tool event. Registered so a later output record can attach. */
  const addPatch = (ts: unknown, patchText: string, callId?: string): ToolEvent => {
    const id = callId || "plain-" + pushSeq + "-" + String(ts ?? "");
    const event = newToolEvent({ ts, id, tool: "apply_patch", args: { input: patchText }, engine: "codex", diff: diffFromApplyPatch(patchText) });
    registerCall(event);
    return event;
  };
  /* A Codex custom tool call (both the custom_tool_call and the function_call
     "exec" shapes). Orchestration records (`functions.exec` driving tools.*)
     get their meaningful outer summary and structured nested children. */
  const emitCustomTool = (ts: unknown, name: string, input: string, callId?: string): ToolEvent => {
    const id = callId || "plain-" + pushSeq + "-" + String(ts ?? "");
    const orch = parseOrchestration(input);
    const base = newToolEvent({ ts, id, tool: name, args: { input }, engine: "codex", diff: orch?.diff });
    const event = orch ? { ...base, ...orch.overlay, ...(orch.body ? { orchestration: orch.body } : {}) } : base;
    registerCall(event);
    return event;
  };
  /* Attaches a result copy-on-write: the record gets a fresh ToolEvent and the
     owning entry a fresh item, so exactly one row changes identity. */
  const attach = (callRec: CallRec | undefined, output: string, errFlag?: boolean) => {
    if (!callRec) return null;
    const code = output.match(/exited with code (\d+)/)?.[1];
    /* Codex interactive-shell wall time, read before the preamble is stripped, so
       an empty `wait` can render a compact "waiting Ns" line (issue #141). Matches
       both `Wall time: 30 seconds` and the bare `Wall time 10.0 seconds` wrapper. */
    const wallSeconds = output.match(/Wall time:?\s*([\d.]+)\s*seconds?/i)?.[1];
    /* Codex wraps custom-tool AND interactive-shell (wait / write_stdin) results
       in a metadata preamble whose lines vary by tool and version:
         Chunk ID: …             Script completed
         Wall time[:] N seconds  Script running with cell ID N
         Original token count: … Process running with session ID N
         Output:                 Process exited with code N
       Strip the contiguous leading block of those lines, decode the payload (real
       newlines, ANSI removed — issue #141), and treat a bare `{}` (a script that
       returned nothing) as no output (issue #90). */
    const lines = decodeTerminalText(output).split("\n");
    let start = 0;
    while (start < lines.length && PREAMBLE_LINE.test(lines[start]!)) start += 1;
    const stripped = lines.slice(start).join("\n").trim();
    const body = stripped === "{}" ? "" : stripped;
    const isErr = errFlag === true || (code !== undefined && code !== "0");
    const prev = callRec.event;
    /* An empty codex wait/stdin chunk collapses to "waiting Ns" rather than an
       "ok" with a signal-free block (issue #141 §4). */
    const idleWait = !body && (prev.tool === "wait" || prev.tool === "write_stdin") && wallSeconds !== undefined;
    let outputPreview = prev.outputPreview;
    let outputTruncated = prev.outputTruncated;
    if (body) {
      const limit = isErr ? OUTPUT_ERR_MAX : OUTPUT_OK_MAX;
      const combined = (prev.outputPreview + "\n" + redactSecrets(body)).trim();
      outputTruncated = prev.outputTruncated || combined.length > limit;
      outputPreview = combined.slice(-limit);
    }
    const event: ToolEvent = {
      ...prev,
      status: isErr ? "err" : "ok",
      statusLabel: isErr
        ? (code && code !== "0" ? "exit " + code : tr("render.error"))
        : idleWait
          ? tr("tools.waitingSeconds", { n: Math.round(Number(wallSeconds)) })
          : "ok",
      open: prev.open || isErr,
      srcResult: curSrc,
      outputPreview,
      outputTruncated,
    };
    callRec.event = event;
    const idx = entryIndex(callRec.seq);
    if (idx >= 0 && idx < entries.length) {
      const old = entries[idx].item;
      if (old.kind === "tool") {
        entries[idx] = { ...entries[idx], item: event };
        snapshot = null;
      }
    }
    return event;
  };
  const addOutput = (callId: string | undefined, output: string, err?: boolean) => {
    if (!callId) return;
    const tseq = tmsgSeqs.get(callId);
    if (tseq !== undefined) {
      /* The routing echo repeats the whole message body; keep only the delivery state. */
      const idx = entryIndex(tseq);
      if (idx >= 0 && idx < entries.length) {
        const old = entries[idx].item;
        if (old.kind === "tmsg") {
          const delivery: "ok" | "err" = err || /"success"\s*:\s*false/.test(output) ? "err" : "ok";
          const msgId = output.match(/"msg_id"\s*:\s*"([^"]+)"/)?.[1];
          entries[idx] = { ...entries[idx], item: { ...old, delivery, msgId } };
          snapshot = null;
        }
      }
      return;
    }
    const event = attach(calls.get(callId), output, err);
    if (!event && output && showSvc) push({ kind: "svc", text: "output: " + redactSecrets(output).slice(0, 200) });
  };
  const addSvc = (text: string) => {
    if (showSvc) push({ kind: "svc", text: text.slice(0, 300) });
    else {
      hiddenServiceCount += 1;
      hiddenSvcBySrc.set(curSrc, (hiddenSvcBySrc.get(curSrc) ?? 0) + 1);
      snapshot = null;
    }
  };
  const addNote = (text: string) => {
    push({ kind: "note", text });
  };
  /* Inbound teammate traffic arrives as user text wrapped in <teammate-message>;
     idle_notification JSON bodies collapse to a thin service-style row. */
  const addUserText = (ts: unknown, text: string, isHarness = false) => {
    if (isHarness) return void addSysMsg(text, tr("render.system"));
    const rest = text.replace(TMSG_RE, (_whole, _tag: string, attrs: string, body: string) => {
      const peer = tmsgAttr(attrs, "teammate_id") || tmsgAttr(attrs, "from") || tr("render.teammate");
      const summary = tmsgAttr(attrs, "summary");
      const trimmed = body.trim();
      if (trimmed.startsWith("{")) {
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (obj.type === "idle_notification") {
            const at = hhmm(obj.timestamp);
            push({ kind: "tnote", text: tr("render.left", { peer, at: at ? " · " + at : "" }) });
            return "";
          }
        } catch {
          /* render as a regular teammate card */
        }
      }
      const { cleaned, cites } = splitCitations(trimmed);
      /* A body that opens with the verdict IS a review: keep the envelope and
         render the content as a review card. The strict start anchor keeps task
         briefs that merely mention APPROVE/REQUEST_CHANGES as plain text. */
      const review = VERDICT_LINE_RE.test(cleaned) ? parseReview(cleaned, ts) : null;
      push({ kind: "tmsg", ts, dir: "in", peer, summary, text: review ? "" : cleaned });
      if (review) push(review);
      for (const cite of cites) push(cite);
      return "";
    });
    const leftover = rest.replace(/Another Claude session sent a message:\s*/g, "").trim();
    if (!leftover || pushBlobIfHuge(leftover)) return;
    const { cleaned, images } = extractInboxImages(leftover);
    if (cleaned && !pushStructured(ts, cleaned, (segment) => push({ kind: "user", ts, text: segment }))) {
      push({ kind: "user", ts, text: cleaned });
    }
    for (const image of images) push({ kind: "inbox-image", name: image.name, path: image.path });
  };
  /* Harness classification is driven by the source record, never a textual
     prefix. A human can legitimately begin a composer message with XML or a
     phrase that looks like a harness reminder. */
  const addSysMsg = (text: string, fallbackLabel?: string) => {
    push({ kind: "sysmsg", label: sysMsgLabel(text, fallbackLabel), text });
  };
  const emitCodexUserContent = (ts: unknown, content: CodexUserContent): PendingCodexUser => {
    const entrySeqs: number[] = [];
    const emit = (item: Item) => entrySeqs.push(push(item));
    const { cleaned, images } = extractInboxImages(content.text);
    if (cleaned) emit({ kind: "user", ts, text: cleaned });
    for (const image of images) emit({ kind: "inbox-image", name: image.name, path: image.path });
    for (const attachment of content.attachments) emit(attachment);
    return { src: curSrc, ts, text: content.text, entrySeqs };
  };
  const updateCodexPendingSource = (pending: PendingCodexUser, src: number) => {
    for (const seq of pending.entrySeqs) {
      const idx = entryIndex(seq);
      if (idx >= 0 && idx < entries.length) entries[idx] = { ...entries[idx], src };
    }
    pending.src = src;
    snapshot = null;
  };
  const finalizePendingCodexUsers = () => {
    const pendingUsers = pendingCodexUsers;
    pendingCodexUsers = [];
    for (const pending of pendingUsers) {
      /* A user-role response without the immediately following event is a
         harness/service injection in the observed Codex schema. Its content may
         use any prefix, so record shape provides the classification. */
      let converted = false;
      for (const seq of pending.entrySeqs) {
        const idx = entryIndex(seq);
        if (idx < 0 || idx >= entries.length) continue;
        if (entries[idx].item.kind === "user") {
          entries[idx] = { ...entries[idx], item: { kind: "sysmsg", label: sysMsgLabel(pending.text), text: pending.text } };
          snapshot = null;
          converted = true;
          break;
        }
      }
      if (!converted && pending.text) {
        const source = curSrc;
        curSrc = pending.src;
        addSysMsg(pending.text);
        curSrc = source;
      }
    }
  };
  const addCodexResponseUser = (ts: unknown, content: unknown) => {
    const normalized = normalizeCodexUserContent(content);
    const pending = emitCodexUserContent(ts, normalized);
    if (!pending.entrySeqs.length && !pending.text) addSvc("message user");
    pendingCodexUsers.push(pending);
  };
  const addCodexEventUser = (ts: unknown, text: string) => {
    const pendingIndex = pendingCodexUsers.findIndex((pending) => sameCodexTextAtTime(pending.ts, pending.text, ts, text));
    if (pendingIndex < 0) {
      emitCodexUserContent(ts, { text, attachments: [] });
      return;
    }
    const [pending] = pendingCodexUsers.splice(pendingIndex, 1);
    if (!pending) return;
    const { cleaned, images } = extractInboxImages(text);
    if (cleaned) {
      const userSeq = pending.entrySeqs.find((seq) => {
        const idx = entryIndex(seq);
        return idx >= 0 && entries[idx]?.item.kind === "user";
      });
      if (userSeq !== undefined) {
        const idx = entryIndex(userSeq);
        entries[idx] = { ...entries[idx], item: { kind: "user", ts, text: cleaned } };
      } else {
        pending.entrySeqs.push(push({ kind: "user", ts, text: cleaned }));
      }
    }
    for (const image of images) pending.entrySeqs.push(push({ kind: "inbox-image", name: image.name, path: image.path }));
    updateCodexPendingSource(pending, curSrc);
  };
  const addCompact = (ts: unknown, meta?: { trigger?: string; preTokens?: number }) => {
    push({ kind: "compact", ts, trigger: meta?.trigger, preTokens: meta?.preTokens });
  };
  /* The Claude compact summary follows its boundary record; attach it there,
     skipping the service rows that may sit between them. */
  const attachCompactSummary = (ts: unknown, summary: string) => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const it = entries[i].item;
      if (it.kind === "compact") {
        entries[i] = { ...entries[i], item: { ...it, summary } };
        snapshot = null;
        return;
      }
      if (it.kind !== "svc" && it.kind !== "note") break;
    }
    push({ kind: "compact", ts, summary });
  };
  const renderCodex = (obj: Record<string, unknown>) => {
    const p = rec(obj.payload);
    const ts = obj.timestamp;
    if (obj.type === "event_msg") {
      if (p.type === "user_message" && p.message) return addCodexEventUser(ts, textPart(p.message));
      finalizePendingCodexUsers();
      if (p.type === "agent_message" && p.message) {
        return addCodexAssistant("event-agent", ts, textPart(p.message));
      }
      if (p.type === "task_started") return addNote(tr("render.taskStarted") + (ts ? " · " + hhmm(ts) : ""));
      if (p.type === "task_complete") return addNote(tr("render.taskComplete") + (ts ? " · " + hhmm(ts) : ""));
      if (p.type === "context_compacted") {
        if (codexCompacted) return void (codexCompacted = null);
        return addCompact(ts);
      }
      return addSvc(textPart(p.type) || "event");
    }
    if (obj.type === "response_item") {
      if (p.type === "message") {
        if (p.role === "user") return addCodexResponseUser(ts, p.content);
        finalizePendingCodexUsers();
        const text = normalizeCodexUserContent(p.content).text;
        if (!text) return addSvc("message " + textPart(p.role));
        if (p.role === "assistant") return addCodexAssistant("response-assistant", ts, text);
        /* developer/system turns (<permissions instructions>, collaboration
           mode, …) are harness-injected, never something the user typed. */
        return addSysMsg(text, textPart(p.role));
      }
      finalizePendingCodexUsers();
      if (p.type === "function_call") {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(textPart(p.arguments) || "{}");
        } catch {
          args = {};
        }
        const name = textPart(p.name);
        if (name === "exec_command" || name === "shell") {
          const cmd = String(args.cmd ?? args.command ?? "").replace(/^\/usr\/bin\/zsh -lc /, "");
          return void addShell(ts, cmd, textPart(p.call_id), name);
        }
        if (name === "apply_patch") {
          return void addPatch(ts, String(args.input ?? ""), textPart(p.call_id));
        }
        /* write_stdin / wait fall through to the generic tool path so they render
           as real cards — the keys sent and the decoded output — instead of an
           opaque "session_id" service line (issue #141). summarizeTool owns their
           summary; attach() decodes and collapses their output. */
        if (name === "exec" || name === "functions.exec") return void emitCustomTool(ts, name, textPart(args.input), textPart(p.call_id));
        return void registerCall(newToolEvent({ ts, id: textPart(p.call_id) || "plain-" + pushSeq + "-" + String(ts ?? ""), tool: name, args, engine: "codex" }));
      }
      if (p.type === "function_call_output") {
        const output = toolOutputText(p.output);
        return addOutput(textPart(p.call_id), output, toolOutputFailed(output));
      }
      /* Fresh rollouts wrap apply_patch as a "custom_tool_call": `input` is the
         raw patch text directly (unlike function_call, whose `arguments` is a
         JSON-encoded string), so no JSON.parse step is needed here. */
      if (p.type === "custom_tool_call" && textPart(p.name) === "apply_patch") {
        return void addPatch(ts, textPart(p.input), textPart(p.call_id) || textPart(p.id));
      }
      if (p.type === "custom_tool_call") {
        const name = textPart(p.name) || "tool";
        const input = textPart(p.input) || textPart(p.arguments);
        const id = textPart(p.call_id) || textPart(p.id);
        return void emitCustomTool(ts, name, input, id);
      }
      if (p.type === "custom_tool_call_output") {
        const output = toolOutputText(p.output);
        return addOutput(textPart(p.call_id), output, toolOutputFailed(output));
      }
      if (p.type === "reasoning") return addSvc("reasoning");
      return addSvc(textPart(p.type) || "item");
    }
    finalizePendingCodexUsers();
    if (obj.type === "session_meta") {
      return addNote(`${tr("render.codexSessionCreated")} · ${textPart(p.model)} · ${textPart(p.cwd)}`);
    }
    if (obj.type === "compacted") {
      codexCompacted = { src: curSrc };
      return addCompact(ts);
    }
    addSvc(textPart(obj.type) || tr("render.record"));
  };
  const renderClaude = (obj: Record<string, unknown>) => {
    const ts = obj.timestamp;
    if (obj.type === "user" && obj.message) {
      const content = rec(obj.message).content;
      const fileWrap = rec(rec(obj.toolUseResult).file);
      /* The post-compaction summary is injected as a user record, but it is
         the compactor talking — fold it into the boundary marker instead of
         rendering a giant bubble the user never wrote. */
      if (obj.isCompactSummary === true) {
        const text =
          typeof content === "string"
            ? content
            : arr(content).filter((part) => part.type === "text").map((part) => textPart(part.text)).join(" ");
        if (text.trim()) attachCompactSummary(ts, text.trim());
        return;
      }
      const isHarness = isClaudeProtocolUser(obj, content);
      if (typeof content === "string") addUserText(ts, content, isHarness);
      else {
        for (const part of arr(content)) {
          if (part.type === "text") addUserText(ts, textPart(part.text), isHarness);
          else if (part.type === "image") pushImage(part, fileWrap);
          else if (part.type === "tool_result") {
            const inner = arr(part.content);
            for (const block of inner) {
              if (block.type === "image") pushImage(block, fileWrap);
            }
            const contentText =
              typeof part.content === "string"
                ? part.content
                : inner.filter((x) => x.type !== "image").map((x) => textPart(x.text)).join(" ");
            addOutput(textPart(part.tool_use_id), contentText, part.is_error === true);
          }
        }
      }
      return;
    }
    if (obj.type === "assistant" && obj.message) {
      for (const part of arr(rec(obj.message).content)) {
        if (part.type === "text" && textPart(part.text).trim()) addProse(ts, textPart(part.text));
        else if (part.type === "thinking" && textPart(part.thinking).trim()) {
          push({ kind: "think", text: textPart(part.thinking).replace(/\s+/g, " ").trim() });
        } else if (part.type === "tool_use" && textPart(part.name) === "SendMessage") {
          const input = rec(part.input);
          const message = input.message;
          if (typeof message === "string") {
            const { cleaned, cites } = splitCitations(message);
            const review = VERDICT_LINE_RE.test(cleaned) ? parseReview(cleaned, ts) : null;
            const item: Tmsg = {
              kind: "tmsg",
              ts,
              dir: "out",
              peer: String(input.to ?? ""),
              summary: String(input.summary ?? ""),
              text: review ? "" : cleaned,
            };
            const seq = push(item);
            if (review) push(review);
            for (const cite of cites) push(cite);
            const key = textPart(part.id);
            if (key) {
              tmsgSeqs.set(key, seq);
              tmsgKeyBySeq.set(seq, key);
            }
          } else {
            addSvc(`SendMessage → ${String(input.to ?? "")} · ${textPart(rec(message).type) || tr("render.protocol")}`);
          }
        } else if (part.type === "tool_use") {
          const name = textPart(part.name) || "tool";
          const input = rec(part.input);
          const id = textPart(part.id) || "plain-" + pushSeq + "-" + String(ts ?? "");
          const command = familyOf(name) === "shell" ? textPart(input.command) : undefined;
          const lang = familyOf(name) === "read" ? extLang(textPart(input.file_path)) : undefined;
          registerCall(newToolEvent({ ts, id, tool: name, args: input, engine: "claude", command, lang }));
        }
      }
      return;
    }
    if (obj.type === "system" && obj.subtype === "compact_boundary") {
      const meta = rec(obj.compactMetadata);
      return addCompact(ts, { trigger: textPart(meta.trigger) || undefined, preTokens: num(meta.preTokens) });
    }
    addSvc(textPart(obj.type) || tr("render.record"));
  };
  /* Job .output logs echo the final review/citation block as bare lines after the
     [codex] stream ends; collect that run so it renders as one structured card
     instead of per-line raw rows. Falls back to the old raw rows when the block
     turns out not to be structured. A block still open at the window end is
     previewed transiently by the snapshot (pendingPlainItems) and committed
     only when its terminator arrives — an incremental feed must not consume
     state it may need for the block's continuation. */
  const rawLinesInto = (emit: (item: Item) => void) => (segment: string) => {
    for (const raw of segment.split("\n")) {
      if (raw.trim()) emit({ kind: "raw", text: redactSecrets(raw), err: /error|failed|traceback|exception/i.test(raw) });
    }
  };
  const flushPlainBlock = () => {
    if (!plainBlock) return;
    const text = plainBlock.lines.join("\n").trim();
    plainBlock = null;
    if (!text) return;
    const pushRawLines = rawLinesInto(push);
    if (!pushStructured(null, text, pushRawLines)) pushRawLines(text);
  };
  const pendingPlainItems = (): Item[] => {
    if (!plainBlock) return [];
    const text = plainBlock.lines.join("\n").trim();
    if (!text) return [];
    const out: Item[] = [];
    const emit = (item: Item) => out.push(item);
    const fallback = rawLinesInto(emit);
    if (!pushStructured(null, text, fallback, emit)) fallback(text);
    return out;
  };
  const renderPlain = (rawLine: string) => {
    // Shell .output files carry terminal ANSI/OSC escapes; strip them for display.
    const line = rawLine.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (plainBlock) {
      if (/^\[codex\]/.test(line)) flushPlainBlock();
      else {
        plainBlock.lines.push(line);
        snapshot = null;
        return;
      }
    }
    if (/Assistant message$/.test(line)) return;
    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    const ts = m?.[1] ?? null;
    const rest = m?.[2] ?? line;
    if (!rest || /^Assistant message captured/.test(rest)) return;
    if (!m && (VERDICT_LINE_RE.test(line) || line.startsWith("<oai-mem-citation>"))) {
      plainBlock = { lines: [line], src: curSrc };
      snapshot = null;
      return;
    }
    if (/^Running command: /.test(rest)) return void addShell(ts, rest.replace(/^Running command: /, "").replace(/^\/usr\/bin\/zsh -lc /, ""));
    if (/^Command (completed|failed)/.test(rest)) {
      /* A job log carries no stdout: attach only the status line. The absent
         output surfaces as the compact "no output captured" chip in the card,
         replacing the old apology paragraph (issue #9 §6). */
      if (lastPlainCall) attach(lastPlainCall, rest, /^Command failed/.test(rest));
      return;
    }
    if (/^Applying \d+ file/.test(rest)) {
      /* A job log only announces the patch — no output record ever carries this
         id. Emit it already-complete (like a statically-parsed nested call) and
         skip registerCall, so it never sits spinning "executing…" forever. */
      const event = newToolEvent({ ts, id: "plain-" + pushSeq + "-" + String(ts ?? ""), tool: "apply_patch", engine: "codex", summary: rest });
      return void push({ ...event, status: "ok", statusLabel: "ok" });
    }
    if (m && !/^(Running|Command|Applying)/.test(rest)) return addProse(ts, rest);
    if (pushBlobIfHuge(line)) return;
    push({ kind: "raw", text: redactSecrets(line), err: /error|failed|traceback|exception/i.test(line) });
  };
  const consume = (line: string) => {
    if (lineFilter && !line.toLowerCase().includes(lineFilter)) return;
    if (jsonl) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          if (cfg.fmt === "claude") renderClaude(obj);
          else renderCodex(obj);
        }
      } catch {
        renderPlain(line);
      }
    } else renderPlain(line);
  };

  const reset = () => {
    entries.length = 0;
    calls.clear();
    tmsgSeqs.clear();
    tmsgKeyBySeq.clear();
    hiddenSvcBySrc.clear();
    hiddenServiceCount = 0;
    codexAssistantRecord = null;
    pendingCodexUsers = [];
    codexCompacted = null;
    plainBlock = null;
    lastPlainCall = null;
    prevGroups = new Map();
    snapshot = null;
    /* pushSeq keeps counting across resets so React keys never collide. */
  };

  /** Evicts entries and state owned by lines that left the window. Returns
      true when a pending plain block lost its opening line — sequential state
      that cannot be resumed, so the caller re-parses the window whole. */
  const dropBefore = (start: number): boolean => {
    const crossedEchoSeam = entries.some((entry) => entry.bornSrc < start && entry.src >= start);
    while (entries.length && entries[0].src < start) {
      const gone = entries.shift()!;
      snapshot = null;
      if (gone.item.kind === "tool") {
        const callRec = calls.get(gone.item.id);
        /* A later tool_result for an evicted call now falls back to the svc
           row, exactly like a full re-parse of the shortened window would. */
        if (callRec && callRec.seq === gone.seq) calls.delete(gone.item.id);
      }
      const tkey = tmsgKeyBySeq.get(gone.seq);
      if (tkey !== undefined) {
        tmsgKeyBySeq.delete(gone.seq);
        if (tmsgSeqs.get(tkey) === gone.seq) tmsgSeqs.delete(tkey);
      }
    }
    for (const [src, count] of hiddenSvcBySrc) {
      if (src >= start) break;
      hiddenServiceCount -= count;
      hiddenSvcBySrc.delete(src);
      snapshot = null;
    }
    if (codexAssistantRecord && codexAssistantRecord.src < start) codexAssistantRecord = null;
    pendingCodexUsers = pendingCodexUsers.filter((pending) => pending.src >= start);
    if (codexCompacted && codexCompacted.src < start) codexCompacted = null;
    if (lastPlainCall && entryIndex(lastPlainCall.seq) < 0) lastPlainCall = null;
    return crossedEchoSeam || (plainBlock !== null && plainBlock.src < start);
  };

  /* Collapses a run of >=2 consecutive foldable tool entries into one cmd-group
     item so a long unbroken tool series reads as a single summary line. Every
     tool event folds (Read/Bash/Edit/diff-bodied/orchestration alike); a "think"
     item inside a run is absorbed without breaking it (it carries no signal once
     the run it annotates is folded), while prose/user/tmsg/review/image break it.
     In a live trailing run only the leading completed prefix folds; every
     in-flight (`run`) call stays a visible line (and if none is running, the
     most-recent call is held out), so a live 40-call run reads as one quiet
     group plus its running call(s), never 40 rows (§3.4). A group whose members'
     events are all identity-equal to the previous snapshot's is reused as-is,
     keeping its card memoized. */
  const buildSnapshot = (isLive: boolean): FeedSnapshot => {
    const out: FeedEntry[] = [];
    const nextGroups = new Map<number, CmdGroupItem>();
    const anchorOrdinals = new Map<string, number>();
    const anchorKey = (entry: StoredEntry, prefix: "row" | "group") => {
      const source = `${prefix}:${entry.src}`;
      const ordinal = anchorOrdinals.get(source) ?? 0;
      anchorOrdinals.set(source, ordinal + 1);
      return `${source}:${ordinal}`;
    };
    let i = 0;
    while (i < entries.length) {
      const head = entries[i];
      if (!foldableTool(head.item)) {
        out.push({ anchorKey: anchorKey(head, "row"), key: String(head.seq), item: head.item });
        i += 1;
        continue;
      }
      let j = i;
      const toolEntries: { idx: number; seq: number; item: ToolEvent }[] = [];
      while (j < entries.length) {
        const cur = entries[j];
        if (foldableTool(cur.item)) toolEntries.push({ idx: j, seq: cur.seq, item: cur.item });
        else if (cur.item.kind !== "think") break;
        j += 1;
      }
      /* A live trailing run folds only its leading completed prefix: every
         in-flight (`run`) call stays a visible line so concurrent running calls
         are never buried in a quiet closed group, and if none is running the
         most-recent call is still held out. A completed or interior run folds in
         full. */
      const isLiveTail = isLive && j === entries.length;
      let foldCount = toolEntries.length;
      if (isLiveTail) {
        const firstRun = toolEntries.findIndex((entry) => entry.item.status === "run");
        foldCount = firstRun >= 0 ? firstRun : toolEntries.length - 1;
      }
      if (foldCount >= CMD_GROUP_MIN) {
        const grouped = toolEntries.slice(0, foldCount);
        const groupEnd = grouped[grouped.length - 1].idx + 1;
        const gkey = grouped[0].seq;
        const prev = prevGroups.get(gkey);
        let group: CmdGroupItem;
        if (prev && prev.calls.length === grouped.length && grouped.every((entry, k) => prev.calls[k] === entry.item)) {
          group = prev;
        } else {
          const byTool: Record<string, number> = {};
          let okCount = 0;
          let errCount = 0;
          for (const entry of grouped) {
            const tool = toolBucket(entry.item);
            byTool[tool] = (byTool[tool] ?? 0) + 1;
            if (entry.item.status === "ok") okCount += 1;
            else if (entry.item.status === "err") errCount += 1;
          }
          group = {
            kind: "cmd-group",
            ids: grouped.map((entry) => entry.item.id),
            calls: grouped.map((entry) => entry.item),
            t0: grouped[0]?.item.ts,
            t1: grouped.at(-1)?.item.ts,
            byTool,
            okCount,
            errCount,
            hasErr: errCount > 0,
          };
        }
        nextGroups.set(gkey, group);
        out.push({ anchorKey: anchorKey(head, "group"), key: "g" + gkey, item: group });
        i = groupEnd;
      } else {
        out.push({ anchorKey: anchorKey(head, "row"), key: String(head.seq), item: head.item });
        i += 1;
      }
    }
    prevGroups = nextGroups;
    pendingPlainItems().forEach((item, idx) => out.push({ anchorKey: null, key: "pb" + idx, item }));
    return { items: out, hiddenServiceCount };
  };

  const feed = (lines: string[], start: number, isLive: boolean): FeedSnapshot => {
    const end = start + lines.length;
    /* A window that moved backwards (prepended history, truncation reset) or
       past unseen lines cannot be resumed — re-parse it whole. */
    if (consumedEnd === null || end < consumedEnd || start > consumedEnd || start < lastStart) {
      reset();
      consumedEnd = start;
    }
    lastStart = start;
    if (dropBefore(start)) {
      reset();
      consumedEnd = start;
    }
    for (let i = consumedEnd - start; i < lines.length; i += 1) {
      curSrc = start + i;
      consume(lines[i]);
    }
    consumedEnd = end;
    if (!snapshot || snapshotLive !== isLive) {
      snapshot = buildSnapshot(isLive);
      snapshotLive = isLive;
    }
    return snapshot;
  };

  return { feed };
}

/** One-shot parse of a whole window — a fresh session fed once. */
export function buildFeed(file: FileEntry, lines: string[], showSvc: boolean, lineFilter: string) {
  const session = createFeedSession({ engine: file.engine, fmt: file.fmt, showSvc, lineFilter });
  const snap = session.feed(lines, 0, file.activity === "live");
  return { items: snap.items.map((entry) => entry.item), hiddenServiceCount: snap.hiddenServiceCount };
}

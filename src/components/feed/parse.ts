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

/* Feed labels resolve against the active locale at build/render time; a locale
   flip rebuilds the feed (see LogFeed's memo), so cached items re-localize. */
export const tr = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(getLocale(), key, params);

export type Call = { cmd: string; display: string; output: string; status: "run" | "ok" | "err"; label: string; icon: GlyphName; open: boolean };
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
  calls: Call[];
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
  | { kind: "cmd"; id: string; call: Call; ts: unknown }
  | CmdGroupItem
  | { kind: "edit"; files: string }
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

/* Strips visual boilerplate from a cmd chip caption only; `call.cmd` (the raw
   text used in the expanded <pre>) is left untouched. A tool-name prefix like
   "Bash: " (added by renderClaude) is preserved across the cleanup passes. */
function displayCmd(cmd: string): string {
  const prefixMatch = cmd.match(/^([A-Za-z][\w.]*): /);
  const prefix = prefixMatch ? prefixMatch[0] : "";
  let body = prefix ? cmd.slice(prefix.length) : cmd;
  let prev: string;
  do {
    prev = body;
    body = body.replace(/^export PATH=[^;]+;\s*/, "");
    body = body.replace(/^cd\s+\S+\s*&&\s*/, "");
    body = body.replace(/^\/usr\/bin\/zsh -lc\s+/, "");
    // Only an outer quote pair that fully wraps the command is boilerplate;
    // an unescaped occurrence of the same quote inside (e.g. 'a' && 'b') means
    // the leading/trailing quotes belong to separate tokens, so leave it as is.
    body = body.replace(/^(["'])([\s\S]*)\1$/, (whole: string, quote: string, inner: string) =>
      new RegExp(`(?<!\\\\)${quote}`).test(inner) ? whole : inner,
    );
  } while (body !== prev);
  const heredoc = body.match(/^([\w./-]+(?:\s+-)?)\s*<<\s*['"]?(\w+)['"]?/);
  if (heredoc) body = `${heredoc[1].trim()} «heredoc»`;
  body = body.replace(/\s+/g, " ").trim();
  return (prefix + body).slice(0, 160);
}

function newCmd(cmd: string, icon: GlyphName = "shell"): Call {
  const redacted = redactSecrets(cmd);
  return { cmd: redacted, display: displayCmd(redacted), icon, output: "", status: "run", label: tr("render.executing"), open: false };
}

const CMD_GROUP_MIN = 4;

/* First word of the tool-name prefix ("Bash: ls" → "Bash"); Codex shell/exec
   calls carry no prefix and bucket under a generic label. */
function toolNameOf(cmd: string): string {
  return cmd.match(/^([A-Za-z][\w.]*): /)?.[1] ?? "cmd";
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
  call: Call;
  seq: number;
}

interface PendingCodexUser {
  src: number;
  ts: unknown;
  text: string;
  entrySeqs: number[];
}

function sameCodexUserTurn(leftTs: unknown, leftText: unknown, rightTs: unknown, rightText: unknown): boolean {
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
  let lastProse: { text: string; src: number; seq: number } | null = null;
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
  const addProse = (ts: unknown, text: string) => {
    if (!text.trim()) return;
    const src = curSrc;
    if (pushBlobIfHuge(text)) return;
    const engine = cfg.engine === "codex" ? "codex" : "claude";
    if (pushStructured(ts, text, (segment) => push({ kind: "prose", ts, text: segment, engine }))) return;
    const seq = push({ kind: "prose", ts, text, engine });
    lastProse = { text, src, seq };
  };
  const adoptCodexProseEcho = (ts: unknown, text: string): boolean => {
    if (!lastProse || lastProse.text !== text || lastProse.src !== curSrc - 1) return false;
    const idx = entryIndex(lastProse.seq);
    if (idx < 0 || idx >= entries.length || entries[idx]?.item.kind !== "prose") return false;
    entries[idx] = { ...entries[idx], src: curSrc, item: { ...entries[idx].item, ts } };
    lastProse = { ...lastProse, src: curSrc };
    snapshot = null;
    return true;
  };
  const addCmd = (ts: unknown, cmd: string, callId?: string, icon?: GlyphName) => {
    const id = callId || "plain-" + pushSeq + "-" + String(ts ?? "");
    const call = newCmd(cmd, icon);
    const seq = push({ kind: "cmd", id, call, ts });
    const callRec: CallRec = { call, seq };
    calls.set(id, callRec);
    lastPlainCall = callRec;
    return call;
  };
  /* Attaches a result to its call copy-on-write: the record gets a fresh Call
     and the owning entry a fresh item, so exactly one row changes identity. */
  const attach = (callRec: CallRec | undefined, output: string, errFlag?: boolean) => {
    if (!callRec) return null;
    const code = output.match(/exited with code (\d+)/)?.[1];
    const body = output
      .replace(/^Chunk ID:[^\n]*\n/, "")
      .replace(/Wall time:[^\n]*\n/, "")
      .replace(/Original token count:[^\n]*\n?/, "")
      .trim();
    const isErr = errFlag === true || (code !== undefined && code !== "0");
    const call: Call = { ...callRec.call };
    call.status = isErr ? "err" : "ok";
    call.label = isErr ? (code && code !== "0" ? "exit " + code : tr("render.error")) : "ok";
    call.open ||= isErr;
    if (body) {
      const limit = isErr ? 60_000 : 12_000;
      call.output = (call.output + "\n" + redactSecrets(body)).trim().slice(-limit);
    }
    callRec.call = call;
    const idx = entryIndex(callRec.seq);
    if (idx >= 0 && idx < entries.length) {
      const old = entries[idx].item;
      if (old.kind === "cmd") {
        entries[idx] = { ...entries[idx], item: { ...old, call } };
        snapshot = null;
      }
    }
    return call;
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
    const call = attach(calls.get(callId), output, err);
    if (!call && output && showSvc) push({ kind: "svc", text: "output: " + redactSecrets(output).slice(0, 200) });
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
    const pendingIndex = pendingCodexUsers.findIndex((pending) => sameCodexUserTurn(pending.ts, pending.text, ts, text));
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
        const text = textPart(p.message);
        if (!adoptCodexProseEcho(ts, text)) addProse(ts, text);
        return;
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
        if (p.role === "assistant") return addProse(ts, text);
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
          return addCmd(ts, cmd, textPart(p.call_id));
        }
        if (name === "apply_patch") {
          const files = String(args.input ?? "").match(/(Add|Update|Delete) File: [^\n]+/g);
          push({ kind: "edit", files: files ? files.join(", ").replace(/(Add|Update|Delete) File: /g, "") : tr("render.patch") });
          return;
        }
        if (name === "write_stdin") return addSvc(tr("render.stdinSession", { id: String(args.session_id ?? "") }));
        return addCmd(ts, name + " " + JSON.stringify(args).slice(0, 120), textPart(p.call_id), "tool");
      }
      if (p.type === "function_call_output") {
        const output = toolOutputText(p.output);
        return addOutput(textPart(p.call_id), output, toolOutputFailed(output));
      }
      /* Fresh rollouts wrap apply_patch as a "custom_tool_call": `input` is the
         raw patch text directly (unlike function_call, whose `arguments` is a
         JSON-encoded string), so no JSON.parse step is needed here. */
      if (p.type === "custom_tool_call" && textPart(p.name) === "apply_patch") {
        const files = textPart(p.input).match(/(Add|Update|Delete) File: [^\n]+/g);
        push({ kind: "edit", files: files ? files.join(", ").replace(/(Add|Update|Delete) File: /g, "") : tr("render.patch") });
        return;
      }
      if (p.type === "custom_tool_call") {
        const name = textPart(p.name) || "tool";
        const input = textPart(p.input) || textPart(p.arguments);
        return addCmd(ts, `${name}: ${input || "{}"}`, textPart(p.call_id) || textPart(p.id), "tool");
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
          const input = rec(part.input);
          const cmd = String(input.command ?? input.file_path ?? input.prompt ?? JSON.stringify(input));
          addCmd(ts, textPart(part.name) + ": " + cmd.slice(0, 160), textPart(part.id), "tool");
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
    if (/^Running command: /.test(rest)) return void addCmd(ts, rest.replace(/^Running command: /, "").replace(/^\/usr\/bin\/zsh -lc /, ""));
    if (/^Command (completed|failed)/.test(rest)) {
      if (lastPlainCall) {
        attach(lastPlainCall, /^Command failed/.test(rest) ? rest + "\n" + tr("render.jobLogNote") : rest, /^Command failed/.test(rest));
      }
      return;
    }
    if (/^Applying \d+ file/.test(rest)) return void push({ kind: "edit", files: rest });
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
    lastProse = null;
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
      if (gone.item.kind === "cmd") {
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
    if (lastProse && lastProse.src < start) lastProse = null;
    pendingCodexUsers = pendingCodexUsers.filter((pending) => pending.src >= start);
    if (codexCompacted && codexCompacted.src < start) codexCompacted = null;
    if (lastPlainCall && entryIndex(lastPlainCall.seq) < 0) lastPlainCall = null;
    return crossedEchoSeam || (plainBlock !== null && plainBlock.src < start);
  };

  /* Collapses runs of >=4 consecutive cmd entries into one cmd-group item so a
     long unbroken command series reads as a single summary line. "think" items
     inside a run don't break it (and are absorbed into the group, since they
     carry no signal once the run they annotate is folded); prose/user/tmsg/
     edit/review/image do break it. The last run of a live transcript is never
     folded, so the currently running call always stays visible. A group whose
     members' calls are all identity-equal to the previous snapshot's is reused
     as-is, keeping its card memoized. */
  const buildSnapshot = (isLive: boolean): FeedSnapshot => {
    const out: FeedEntry[] = [];
    const nextGroups = new Map<number, CmdGroupItem>();
    let i = 0;
    while (i < entries.length) {
      const head = entries[i];
      if (head.item.kind !== "cmd") {
        out.push({ key: String(head.seq), item: head.item });
        i += 1;
        continue;
      }
      let j = i;
      const cmdEntries: { seq: number; item: Extract<Item, { kind: "cmd" }> }[] = [];
      while (j < entries.length) {
        const cur = entries[j];
        if (cur.item.kind === "cmd") cmdEntries.push({ seq: cur.seq, item: cur.item });
        else if (cur.item.kind !== "think") break;
        j += 1;
      }
      const isLastRun = j === entries.length;
      if (cmdEntries.length >= CMD_GROUP_MIN && !(isLive && isLastRun)) {
        const gkey = cmdEntries[0].seq;
        const prev = prevGroups.get(gkey);
        let group: CmdGroupItem;
        if (prev && prev.calls.length === cmdEntries.length && cmdEntries.every((entry, k) => prev.calls[k] === entry.item.call)) {
          group = prev;
        } else {
          const byTool: Record<string, number> = {};
          let okCount = 0;
          let errCount = 0;
          for (const entry of cmdEntries) {
            const tool = toolNameOf(entry.item.call.cmd);
            byTool[tool] = (byTool[tool] ?? 0) + 1;
            if (entry.item.call.status === "ok") okCount += 1;
            else if (entry.item.call.status === "err") errCount += 1;
          }
          group = {
            kind: "cmd-group",
            ids: cmdEntries.map((entry) => entry.item.id),
            calls: cmdEntries.map((entry) => entry.item.call),
            t0: cmdEntries[0]?.item.ts,
            t1: cmdEntries.at(-1)?.item.ts,
            byTool,
            okCount,
            errCount,
            hasErr: errCount > 0,
          };
        }
        nextGroups.set(gkey, group);
        out.push({ key: "g" + gkey, item: group });
        i = j;
      } else {
        out.push({ key: String(head.seq), item: head.item });
        i += 1;
      }
    }
    prevGroups = nextGroups;
    pendingPlainItems().forEach((item, idx) => out.push({ key: "pb" + idx, item }));
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

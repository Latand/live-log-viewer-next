"use client";

import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import {
  debugRaw,
  parseReview,
  redactSecrets,
  splitTargetLine,
  VERDICT_LINE_RE,
  type ReviewCardItem,
  type ReviewSeverity,
} from "@/lib/review";
import type { FileEntry } from "@/lib/types";

import {
  Ban,
  Brain,
  Check,
  ChevronUp,
  CircleCheck,
  Command,
  type GlyphName,
  GlyphIcon,
  Loader2,
  Mail,
  MessageCircle,
  Sparkle,
  X,
} from "../icons";
import { hhmm, ukPlural } from "../utils";
import { InboxImageCard } from "./InboxImage";
import { Lightbox } from "./Lightbox";

type Call = { cmd: string; display: string; output: string; status: "run" | "ok" | "err"; label: string; icon: GlyphName; open: boolean };
type CitationEntry = {
  target: string;
  line?: string;
  note?: string;
  raw: string;
};
type MemCitationItem = {
  kind: "mem-citation";
  entries: CitationEntry[];
  rolloutIds: string[];
  raw: string;
  truncated: boolean;
};
type Tmsg = {
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
type CmdGroupItem = {
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
type Item =
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
  | { kind: "raw"; text: string; err: boolean };

const BLOB_MIN = 20_000;
const BLOB_KEEP = 200_000;
const MEM_CITATION_RE = /<oai-mem-citation>\s*<citation_entries>([\s\S]*?)<\/citation_entries>\s*<rollout_ids>([\s\S]*?)<\/rollout_ids>\s*<\/oai-mem-citation>/g;
/* Paths that live under a viewer transcript root can deep-link to that file;
   source-tree paths in a finding stay plain code chips. Mirrors ROOTS. */
const TRANSCRIPT_PATH_RE = /(?:\/\.codex\/sessions\/|\/\.claude\/projects\/|\/\.claude\/plugins\/data\/codex-openai-codex\/state\/|^\/tmp\/claude-\d+\/)/;

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
   what /api/inbox accepts. */
const INBOX_PATH_RE = /\S*\/\.claude\/viewer-inbox\/([A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp))/gi;

interface InboxImageRef {
  name: string;
  path: string;
}

/* A line that is only inbox path(s) folds away entirely — its card replaces
   it; a path mentioned mid-sentence keeps its line verbatim and still gets a
   card, so prose around it never garbles. */
function extractInboxImages(text: string): { cleaned: string; images: InboxImageRef[] } {
  if (!text.includes("/.claude/viewer-inbox/")) return { cleaned: text, images: [] };
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

/* Harness-injected turns (system prompts, reminders, command wrappers, hook
   output) arrive as "user" records but the user never typed them; they fold
   into a collapsed system row so real messages stand out. */
const SYS_MSG_RE = /^\s*(?:<[a-zA-Z][\w:-]*|Caveat: The messages below|\[Request interrupted|This came from another Claude session)/;

function sysMsgLabel(text: string): string {
  const tag = text.match(/^\s*<([a-zA-Z][\w:-]*)/)?.[1];
  if (tag) return tag;
  if (/^\s*Caveat:/.test(text)) return "caveat";
  return "системне";
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

const MD_INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>"')\]]+)/g;

function Anchor({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={href}
      className="break-all text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {label}
    </a>
  );
}

function md(text: string): ReactNode {
  const parts = text.split(MD_INLINE_RE);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith("`") && part.endsWith("`")) {
      return <span key={i} className="rounded-md bg-chip px-1.5 py-0.5 font-mono">{part.slice(1, -1)}</span>;
    }
    if (part.startsWith("**") && part.endsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    const linked = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (linked) {
      const href = linked[2].replace(/\\([()])/g, "$1");
      if (/^https?:\/\//.test(href)) return <Anchor key={i} href={href} label={linked[1]} />;
      return <span key={i} className="rounded-md bg-chip px-1.5 py-0.5 font-mono">{linked[1]}</span>;
    }
    if (/^https?:\/\//.test(part)) {
      /* Bare URLs in prose often carry sentence punctuation; keep it as text. */
      const href = part.replace(/[.,;:!?…»)]+$/, "");
      const tail = part.slice(href.length);
      const label = href.length > 72 ? href.slice(0, 69) + "…" : href;
      return (
        <span key={i}>
          <Anchor href={href} label={label} />
          {tail}
        </span>
      );
    }
    return part;
  });
}

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_CELL_RE = /^:?-{1,}:?$/;

function MdTable({ rows }: { rows: string[] }) {
  const parsed = rows.map((row) =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim()),
  );
  const hasHeader = parsed.length > 1 && parsed[1].every((cell) => TABLE_SEP_CELL_RE.test(cell));
  const head = hasHeader ? parsed[0] : null;
  const body = hasHeader ? parsed.slice(2) : parsed;
  return (
    <div className="my-1.5 max-w-full overflow-x-auto">
      <table className="border-collapse text-[12.5px]">
        {head ? (
          <thead>
            <tr>
              {head.map((cell, i) => (
                <th key={i} className="border border-line bg-chip px-2.5 py-1 text-left font-semibold">
                  {md(cell)}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {body.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="border border-line px-2.5 py-1 align-top">
                  {md(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* Block-level pass for whole prose messages rendered inside whitespace-pre-wrap:
   newlines survive as text; tables group into real <table>, headings and
   blockquotes are styled per line, everything else goes through the inline pass. */
function mdBlocks(text: string): ReactNode {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*```/.test(lines[i])) {
      const start = i;
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) i++;
      const code = lines.slice(start + 1, i).join("\n");
      if (i < lines.length) i++;
      if (out[out.length - 1] === "\n") out.pop();
      out.push(
        <pre key={`c${start}`} className="my-1.5 max-w-full overflow-x-auto rounded-[10px] border border-line bg-bg px-3 py-2 font-mono text-[11.5px]">
          {code}
        </pre>,
      );
      continue;
    }
    if (TABLE_ROW_RE.test(lines[i])) {
      const start = i;
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) i++;
      /* The table div is a block element: the pending newline would add an empty row. */
      if (out[out.length - 1] === "\n") out.pop();
      out.push(<MdTable key={`t${start}`} rows={lines.slice(start, i)} />);
      continue;
    }
    const line = lines[i];
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (heading) {
      out.push(
        <span key={i} className="text-[14px] font-bold">
          {md(heading[1])}
        </span>,
      );
    } else if (quote) {
      out.push(
        <span key={i} className="border-l-2 border-line pl-2 text-dim">
          {md(quote[1])}
        </span>,
      );
    } else {
      out.push(<Fragment key={i}>{md(line)}</Fragment>);
    }
    i++;
    if (i < lines.length) out.push("\n");
  }
  return out;
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
  return { cmd: redacted, display: displayCmd(redacted), icon, output: "", status: "run", label: "виконується…", open: false };
}

function attach(call: Call | undefined, output: string, errFlag?: boolean) {
  if (!call) return null;
  const code = output.match(/exited with code (\d+)/)?.[1];
  const body = output
    .replace(/^Chunk ID:[^\n]*\n/, "")
    .replace(/Wall time:[^\n]*\n/, "")
    .replace(/Original token count:[^\n]*\n?/, "")
    .trim();
  const isErr = errFlag === true || (code !== undefined && code !== "0");
  call.status = isErr ? "err" : "ok";
  call.label = isErr ? (code && code !== "0" ? "exit " + code : "помилка") : "ok";
  call.open ||= isErr;
  if (body) {
    const limit = isErr ? 60_000 : 12_000;
    call.output = (call.output + "\n" + redactSecrets(body)).trim().slice(-limit);
  }
  return call;
}

const CMD_GROUP_MIN = 4;

/* First word of the tool-name prefix ("Bash: ls" → "Bash"); Codex shell/exec
   calls carry no prefix and bucket under a generic label. */
function toolNameOf(cmd: string): string {
  return cmd.match(/^([A-Za-z][\w.]*): /)?.[1] ?? "cmd";
}

/* Collapses runs of >=4 consecutive cmd items into one cmd-group item so a
   long unbroken command series reads as a single summary line. "think" items
   inside a run don't break it (and are absorbed into the group, since they
   carry no signal once the run they annotate is folded); prose/user/tmsg/
   edit/review/image do break it. The last run of a live transcript is never
   folded, so the currently running call always stays visible. */
function groupCmdRuns(items: Item[], isLive: boolean): Item[] {
  const out: Item[] = [];
  let i = 0;
  while (i < items.length) {
    if (items[i].kind !== "cmd") {
      out.push(items[i]);
      i += 1;
      continue;
    }
    let j = i;
    const cmdItems: Extract<Item, { kind: "cmd" }>[] = [];
    while (j < items.length) {
      const cur = items[j];
      if (cur.kind === "cmd") cmdItems.push(cur);
      else if (cur.kind !== "think") break;
      j += 1;
    }
    const isLastRun = j === items.length;
    if (cmdItems.length >= CMD_GROUP_MIN && !(isLive && isLastRun)) {
      const byTool: Record<string, number> = {};
      let okCount = 0;
      let errCount = 0;
      for (const it of cmdItems) {
        const tool = toolNameOf(it.call.cmd);
        byTool[tool] = (byTool[tool] ?? 0) + 1;
        if (it.call.status === "ok") okCount += 1;
        else if (it.call.status === "err") errCount += 1;
      }
      out.push({
        kind: "cmd-group",
        ids: cmdItems.map((it) => it.id),
        calls: cmdItems.map((it) => it.call),
        t0: cmdItems[0]?.ts,
        t1: cmdItems.at(-1)?.ts,
        byTool,
        okCount,
        errCount,
        hasErr: errCount > 0,
      });
      i = j;
    } else {
      out.push(items[i]);
      i += 1;
    }
  }
  return out;
}

export function buildFeed(file: FileEntry, lines: string[], showSvc: boolean, lineFilter: string) {
  const calls = new Map<string, Call>();
  const tmsgs = new Map<string, Tmsg>();
  const items: Item[] = [];
  let hiddenServiceCount = 0;
  let lastProse = "";
  const pushBlobIfHuge = (text: string): boolean => {
    if (!looksLikeBlob(text)) return false;
    items.push({ kind: "blob", bytes: text.length, text: redactSecrets(text).slice(0, BLOB_KEEP) });
    return true;
  };
  const pushImage = (block: Record<string, unknown>, fileWrap: Record<string, unknown>) => {
    const source = rec(block.source);
    const data = textPart(source.data) || textPart(fileWrap.base64);
    if (!data) return;
    const mt = textPart(source.media_type) || textPart(fileWrap.type);
    const media = mt.startsWith("image/") ? mt : "image/png";
    const dims = rec(fileWrap.dimensions);
    items.push({
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
     style (prose vs user). Returns true when at least one card was produced. */
  const pushStructured = (ts: unknown, text: string, fallback: (segment: string) => void): boolean => {
    MEM_CITATION_RE.lastIndex = 0;
    const hasCitation = MEM_CITATION_RE.test(text);
    MEM_CITATION_RE.lastIndex = 0;
    if (!hasCitation) {
      const review = parseReview(text.trim(), ts);
      if (!review) return false;
      items.push(review);
      return true;
    }
    let handled = false;
    let last = 0;
    const pushTextPart = (part: string) => {
      const trimmed = part.trim();
      if (!trimmed) return;
      const review = parseReview(trimmed, ts);
      if (review) {
        items.push(review);
        handled = true;
      } else {
        fallback(trimmed);
      }
    };
    for (const match of text.matchAll(MEM_CITATION_RE)) {
      const whole = match[0];
      const index = match.index ?? 0;
      pushTextPart(text.slice(last, index));
      items.push(parseMemCitation(whole, match[1] ?? "", match[2] ?? ""));
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
    if (!text.trim() || text === lastProse) return;
    lastProse = text;
    if (pushBlobIfHuge(text)) return;
    const engine = file.engine === "codex" ? "codex" : "claude";
    if (pushStructured(ts, text, (segment) => items.push({ kind: "prose", ts, text: segment, engine }))) return;
    items.push({ kind: "prose", ts, text, engine });
  };
  const addCmd = (ts: unknown, cmd: string, callId?: string, icon?: GlyphName) => {
    const id = callId || "plain-" + items.length + "-" + String(ts ?? "");
    const call = newCmd(cmd, icon);
    calls.set(id, call);
    items.push({ kind: "cmd", id, call, ts });
    return call;
  };
  const addOutput = (callId: string | undefined, output: string, err?: boolean) => {
    if (!callId) return;
    const tmsg = tmsgs.get(callId);
    if (tmsg) {
      /* The routing echo repeats the whole message body; keep only the delivery state. */
      tmsg.delivery = err || /"success"\s*:\s*false/.test(output) ? "err" : "ok";
      tmsg.msgId = output.match(/"msg_id"\s*:\s*"([^"]+)"/)?.[1];
      return;
    }
    const call = attach(calls.get(callId), output, err);
    if (!call && output && showSvc) items.push({ kind: "svc", text: "output: " + redactSecrets(output).slice(0, 200) });
  };
  const addSvc = (text: string) => {
    if (showSvc) items.push({ kind: "svc", text: text.slice(0, 300) });
    else hiddenServiceCount += 1;
  };
  const addNote = (text: string) => {
    items.push({ kind: "note", text });
  };
  /* Inbound teammate traffic arrives as user text wrapped in <teammate-message>;
     idle_notification JSON bodies collapse to a thin service-style row. */
  const addUserText = (ts: unknown, text: string) => {
    const rest = text.replace(TMSG_RE, (_whole, _tag: string, attrs: string, body: string) => {
      const peer = tmsgAttr(attrs, "teammate_id") || tmsgAttr(attrs, "from") || "тімейт";
      const summary = tmsgAttr(attrs, "summary");
      const trimmed = body.trim();
      if (trimmed.startsWith("{")) {
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (obj.type === "idle_notification") {
            const at = hhmm(obj.timestamp);
            items.push({ kind: "tnote", text: `${peer}: звільнився${at ? " · " + at : ""}` });
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
      items.push({ kind: "tmsg", ts, dir: "in", peer, summary, text: review ? "" : cleaned });
      if (review) items.push(review);
      for (const cite of cites) items.push(cite);
      return "";
    });
    const leftover = rest.replace(/Another Claude session sent a message:\s*/g, "").trim();
    if (!leftover || pushBlobIfHuge(leftover)) return;
    if (SYS_MSG_RE.test(leftover)) return void items.push({ kind: "sysmsg", label: sysMsgLabel(leftover), text: leftover });
    const { cleaned, images } = extractInboxImages(leftover);
    if (cleaned && !pushStructured(ts, cleaned, (segment) => items.push({ kind: "user", ts, text: segment }))) {
      items.push({ kind: "user", ts, text: cleaned });
    }
    for (const image of images) items.push({ kind: "inbox-image", name: image.name, path: image.path });
  };
  /* Codex user turns carry no envelopes to unwrap: the bubble text plus a card
     per attached inbox image. */
  const addPlainUser = (ts: unknown, text: string) => {
    const { cleaned, images } = extractInboxImages(text);
    if (cleaned) items.push({ kind: "user", ts, text: cleaned });
    for (const image of images) items.push({ kind: "inbox-image", name: image.name, path: image.path });
  };
  const renderCodex = (obj: Record<string, unknown>) => {
    const p = rec(obj.payload);
    const ts = obj.timestamp;
    if (obj.type === "session_meta") {
      return addNote(`Сесія Codex створена · ${textPart(p.model)} · ${textPart(p.cwd)}`);
    }
    if (obj.type === "event_msg") {
      if (p.type === "agent_message" && p.message) return addProse(ts, textPart(p.message));
      if (p.type === "user_message" && p.message) {
        const text = textPart(p.message);
        if (SYS_MSG_RE.test(text)) return items.push({ kind: "sysmsg", label: sysMsgLabel(text), text });
        return addPlainUser(ts, text);
      }
      if (p.type === "task_started") return addNote("Задача стартувала" + (ts ? " · " + hhmm(ts) : ""));
      if (p.type === "task_complete") return addNote("Задачу завершено" + (ts ? " · " + hhmm(ts) : ""));
      return addSvc(textPart(p.type) || "event");
    }
    if (obj.type === "response_item") {
      if (p.type === "message") {
        const text = arr(p.content).map((c) => textPart(c.text) || textPart(c.input_text)).join(" ").trim();
        if (!text) return addSvc("message " + textPart(p.role));
        if (p.role !== "user") return addProse(ts, text);
        if (SYS_MSG_RE.test(text)) return items.push({ kind: "sysmsg", label: sysMsgLabel(text), text });
        return addPlainUser(ts, text);
      }
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
          items.push({ kind: "edit", files: files ? files.join(", ").replace(/(Add|Update|Delete) File: /g, "") : "патч" });
          return;
        }
        if (name === "write_stdin") return addSvc("stdin → сесія " + String(args.session_id ?? ""));
        return addCmd(ts, name + " " + JSON.stringify(args).slice(0, 120), textPart(p.call_id), "tool");
      }
      if (p.type === "function_call_output") return addOutput(textPart(p.call_id), typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? ""));
      /* Fresh rollouts wrap apply_patch as a "custom_tool_call": `input` is the
         raw patch text directly (unlike function_call, whose `arguments` is a
         JSON-encoded string), so no JSON.parse step is needed here. */
      if (p.type === "custom_tool_call" && textPart(p.name) === "apply_patch") {
        const files = textPart(p.input).match(/(Add|Update|Delete) File: [^\n]+/g);
        items.push({ kind: "edit", files: files ? files.join(", ").replace(/(Add|Update|Delete) File: /g, "") : "патч" });
        return;
      }
      if (p.type === "custom_tool_call_output") return addOutput(textPart(p.call_id), typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? ""));
      if (p.type === "reasoning") return addSvc("reasoning");
      return addSvc(textPart(p.type) || "item");
    }
    addSvc(textPart(obj.type) || "запис");
  };
  const renderClaude = (obj: Record<string, unknown>) => {
    const ts = obj.timestamp;
    if (obj.type === "user" && obj.message) {
      const content = rec(obj.message).content;
      const fileWrap = rec(rec(obj.toolUseResult).file);
      if (typeof content === "string") addUserText(ts, content);
      else {
        for (const part of arr(content)) {
          if (part.type === "text") addUserText(ts, textPart(part.text));
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
          items.push({ kind: "think", text: textPart(part.thinking).replace(/\s+/g, " ").trim() });
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
            items.push(item);
            if (review) items.push(review);
            for (const cite of cites) items.push(cite);
            if (textPart(part.id)) tmsgs.set(textPart(part.id), item);
          } else {
            addSvc(`SendMessage → ${String(input.to ?? "")} · ${textPart(rec(message).type) || "протокол"}`);
          }
        } else if (part.type === "tool_use") {
          const input = rec(part.input);
          const cmd = String(input.command ?? input.file_path ?? input.prompt ?? JSON.stringify(input));
          addCmd(ts, textPart(part.name) + ": " + cmd.slice(0, 160), textPart(part.id), "tool");
        }
      }
      return;
    }
    addSvc(textPart(obj.type) || "запис");
  };
  /* Job .output logs echo the final review/citation block as bare lines after the
     [codex] stream ends; collect that run so it renders as one structured card
     instead of per-line raw rows. Falls back to the old raw rows when the block
     turns out not to be structured. */
  let plainBlock: string[] | null = null;
  const flushPlainBlock = () => {
    if (!plainBlock) return;
    const text = plainBlock.join("\n").trim();
    plainBlock = null;
    if (!text) return;
    const pushRawLines = (segment: string) => {
      for (const raw of segment.split("\n")) {
        if (raw.trim()) items.push({ kind: "raw", text: redactSecrets(raw), err: /error|failed|traceback|exception/i.test(raw) });
      }
    };
    if (!pushStructured(null, text, pushRawLines)) pushRawLines(text);
  };
  const renderPlain = (rawLine: string) => {
    // Shell .output files carry terminal ANSI/OSC escapes; strip them for display.
    const line = rawLine.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (plainBlock) {
      if (/^\[codex\]/.test(line)) flushPlainBlock();
      else {
        plainBlock.push(line);
        return;
      }
    }
    if (/Assistant message$/.test(line)) return;
    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    const ts = m?.[1] ?? null;
    const rest = m?.[2] ?? line;
    if (!rest || /^Assistant message captured/.test(rest)) return;
    if (!m && (VERDICT_LINE_RE.test(line) || line.startsWith("<oai-mem-citation>"))) {
      plainBlock = [line];
      return;
    }
    if (/^Running command: /.test(rest)) return addCmd(ts, rest.replace(/^Running command: /, "").replace(/^\/usr\/bin\/zsh -lc /, ""));
    if (/^Command (completed|failed)/.test(rest)) {
      const last = [...calls.values()].at(-1);
      if (last) {
        attach(last, /^Command failed/.test(rest) ? rest + "\n(це джоб-лог: він не містить stdout команд; повний вивід — у rollout-сесії Codex у списку зліва)" : rest, /^Command failed/.test(rest));
      }
      return;
    }
    if (/^Applying \d+ file/.test(rest)) return items.push({ kind: "edit", files: rest });
    if (m && !/^(Running|Command|Applying)/.test(rest)) return addProse(ts, rest);
    if (pushBlobIfHuge(line)) return;
    items.push({ kind: "raw", text: redactSecrets(line), err: /error|failed|traceback|exception/i.test(line) });
  };
  for (const line of lines) {
    if (lineFilter && !line.toLowerCase().includes(lineFilter)) continue;
    if (file.fmt === "claude" || file.fmt === "codex") {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          if (file.fmt === "claude") renderClaude(obj);
          else renderCodex(obj);
        }
      } catch {
        renderPlain(line);
      }
    } else renderPlain(line);
  }
  flushPlainBlock();
  return { items: groupCmdRuns(items, file.activity === "live"), hiddenServiceCount };
}

type ImageView = "chip" | "thumb" | "full";

export function ImageCard({ media, data, w, h, bytes }: { media: string; data: string; w?: number; h?: number; bytes?: number }) {
  /* Screenshots carry the story of an agent run, so they open as thumbnails right away. */
  const [view, setView] = useState<ImageView>("thumb");
  const kb = Math.round((bytes ?? (data.length * 3) / 4) / 1024);
  const dims = w && h ? `${w}×${h}` : "зображення";
  if (view === "chip") {
    return (
      <button
        type="button"
        onClick={() => setView("thumb")}
        className="my-2 ml-9 flex items-center gap-2 rounded-[14px] border border-line bg-panel px-3.5 py-2 text-[13px] shadow-card"
      >
        <span className="flex h-6.5 w-6.5 items-center justify-center rounded-lg bg-chip">
          <GlyphIcon name="image" className="h-4 w-4" />
        </span>
        <span className="font-semibold">{dims}</span>
        <span className="text-dim">· {kb} КБ</span>
        <span className="ml-1 text-[12px] font-semibold text-accent">показати</span>
      </button>
    );
  }
  const src = `data:${media};base64,${data}`;
  return (
    <div className="my-2 ml-9">
      {/* Lazy insert: the data URI only enters the DOM once expanded. next/image cannot serve a base64 data URI here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={`зображення ${dims}`}
        onClick={() => setView("full")}
        className="max-h-[240px] cursor-zoom-in rounded-[14px] border border-line"
      />
      <button type="button" onClick={() => setView("chip")} className="mt-1 block text-[12px] text-dim">
        згорнути
      </button>
      {view === "full" ? (
        <Lightbox src={src} alt={`зображення ${dims}`} caption={`${dims} · ${kb} КБ`} onClose={() => setView("thumb")} />
      ) : null}
    </div>
  );
}

/** Harness/system turn folded into a thin expandable row: label + size, full text on demand. */
export function SysMsgCard({ label, text }: { label: string; text: string }) {
  const kb = text.length >= 2048 ? `${(text.length / 1024).toFixed(1)} кБ` : `${text.length} симв.`;
  return (
    <details className="group my-1.5 ml-9">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold text-dim hover:text-ink [&::-webkit-details-marker]:hidden">
        <span className="flex h-4.5 w-4.5 items-center justify-center rounded-md bg-chip">
          <GlyphIcon name="cmd-group" className="h-3 w-3" />
        </span>
        <span className="rounded-full bg-chip px-1.5 py-0.5 font-mono text-[9.5px]">{label}</span>
        <span>системне · {kb}</span>
        <span className="text-accent group-open:hidden">показати</span>
        <span className="hidden text-dim group-open:inline">згорнути</span>
      </summary>
      <pre className="mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-line bg-bg px-3 py-2 font-mono text-[11px] text-[#555]">
        {text}
      </pre>
    </details>
  );
}

export function BlobCard({ bytes, text }: { bytes: number; text: string }) {
  const [open, setOpen] = useState(false);
  const kb = Math.round(bytes / 1024);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="my-2 ml-9 flex items-center gap-2 rounded-[14px] border border-line bg-panel px-3.5 py-2 text-[13px] shadow-card"
      >
        <span className="flex h-6.5 w-6.5 items-center justify-center rounded-lg bg-chip">
          <GlyphIcon name="blob" className="h-4 w-4" />
        </span>
        <span className="font-semibold">даних {kb} КБ</span>
        <span className="ml-1 text-[12px] font-semibold text-accent">показати</span>
      </button>
    );
  }
  return (
    <div className="my-2 ml-9 overflow-hidden rounded-[14px] border border-line bg-panel shadow-card">
      <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap break-all bg-[#fafafc] px-3.5 py-2.5 font-mono text-[11.5px]">
        {text}
      </pre>
      <button type="button" onClick={() => setOpen(false)} className="block w-full border-t border-line px-3.5 py-1.5 text-[12px] text-dim">
        згорнути
      </button>
    </div>
  );
}

function severityClass(severity: ReviewSeverity): string {
  if (severity === "Critical" || severity === "High" || severity === "P0" || severity === "P1") return "border-err/30 bg-[#fff4f4] text-err";
  if (severity === "Medium" || severity === "P2") return "border-[#d89b21]/35 bg-[#fff9ea] text-[#9a6500]";
  if (severity === "Low" || severity === "P3") return "border-line bg-chip text-[#555]";
  return "border-line bg-panel text-dim";
}

function verdictClass(verdict: ReviewCardItem["verdict"]): string {
  if (verdict === "REQUEST_CHANGES") return "bg-[#fff0f0] text-err border-err/25";
  if (verdict === "APPROVE") return "bg-[#eefaf1] text-ok border-ok/25";
  return "bg-chip text-[#555] border-line";
}

function VerdictLabel({ verdict }: { verdict: ReviewCardItem["verdict"] }) {
  const Icon = verdict === "REQUEST_CHANGES" ? Ban : verdict === "APPROVE" ? CircleCheck : MessageCircle;
  const text = verdict === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : verdict === "APPROVE" ? "APPROVE" : "COMMENT";
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {text}
    </span>
  );
}

/** Run/ok/err status shown as an icon so the cmd rows read at a glance. */
function StatusIcon({ status, className }: { status: Call["status"]; className?: string }) {
  const cls = className ?? "h-3.5 w-3.5";
  if (status === "ok") return <Check className={cls} aria-hidden />;
  if (status === "err") return <X className={cls} aria-hidden />;
  return <Loader2 className={`${cls} animate-spin`} aria-hidden />;
}

function FileRef({ file, line }: { file: string; line?: number }) {
  const label = line ? `${file}:${line}` : file;
  const cls = "inline-block min-w-0 max-w-full truncate rounded-md bg-chip px-1.5 py-0.5 align-bottom font-mono text-[11.5px]";
  if (TRANSCRIPT_PATH_RE.test(file)) {
    return (
      <a href={`#f=${encodeURIComponent(file)}`} className={`${cls} text-accent underline decoration-dotted`} title={label}>
        {label}
      </a>
    );
  }
  return (
    <code className={cls} title={label}>
      {label}
    </code>
  );
}

function CmdGroupCard({ item }: { item: CmdGroupItem }) {
  const tools = Object.entries(item.byTool)
    .map(([tool, count]) => `${tool} ×${count}`)
    .join(" · ");
  const t0 = hhmm(item.t0);
  const t1 = hhmm(item.t1);
  const range = t0 && t1 && t0 !== t1 ? `${t0}–${t1}` : t0 || t1;
  return (
    <details
      className={`my-2.5 ml-9 overflow-hidden rounded-[14px] border shadow-card ${item.hasErr ? "border-err/35 bg-[#fff4f4]" : "border-line bg-panel"}`}
      open={item.hasErr}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2">
        <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-chip">
          <GlyphIcon name="cmd-group" className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-[12.5px]">
          {item.calls.length} {ukPlural(item.calls.length, "команда", "команди", "команд")}
          {tools ? " · " + tools : ""} ·
          <span className="inline-flex items-center gap-0.5 text-ok">
            <Check className="h-3.5 w-3.5" aria-hidden />
            {item.okCount}
          </span>
          {item.errCount ? (
            <span className="inline-flex items-center gap-0.5 text-err">
              <X className="h-3.5 w-3.5" aria-hidden />
              {item.errCount}
            </span>
          ) : null}
        </span>
        {range ? <span className="ml-auto shrink-0 text-[11px] text-dim">{range}</span> : null}
      </summary>
      <div className="space-y-1 border-t border-line bg-[#fafafc] px-2 py-1.5">
        {item.calls.map((call, idx) => {
          const statusCls = call.status === "ok" ? "text-ok" : call.status === "err" ? "text-err" : "text-dim";
          return (
            <details key={item.ids[idx]} className="overflow-hidden rounded-[10px] border border-line bg-panel" open={call.open}>
              <summary className="flex h-6 cursor-pointer list-none items-center gap-2 px-2.5 text-[11.5px]">
                <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md bg-chip">
                  <GlyphIcon name={call.icon} className="h-3 w-3" />
                </span>
                <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-chip px-1.5 py-0.5 font-mono text-[11px]">
                  {call.display}
                </code>
                <span className={`ml-auto inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold ${statusCls}`}>
                  <StatusIcon status={call.status} className="h-3 w-3" />
                  {call.label}
                </span>
              </summary>
              <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap border-t border-line bg-[#fafafc] px-3 py-2 font-mono text-[11.5px]">
                {"$ " + call.cmd + (call.output ? "\n" + call.output : "")}
              </pre>
            </details>
          );
        })}
      </div>
    </details>
  );
}

function ReviewCard({ item }: { item: ReviewCardItem }) {
  const findingCount = item.findings.length;
  const visibleFindings = item.findings.slice(0, 12);
  return (
    <div className="my-3.5 ml-9 overflow-hidden rounded-[14px] border border-codex/20 bg-panel shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
        <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-codex-soft text-codex">
          <Command className="h-4 w-4" aria-hidden />
        </span>
        <span className="text-[13.5px] font-bold">Codex review</span>
        {item.verdict ? (
          <span className={`rounded-full border px-2.5 py-0.5 text-[11.5px] font-extrabold ${verdictClass(item.verdict)}`}>
            <VerdictLabel verdict={item.verdict} />
          </span>
        ) : null}
        <span className="text-[11px] text-dim">
          {findingCount ? `${findingCount} finding${findingCount === 1 ? "" : "s"}` : "без findings"}
        </span>
        {hhmm(item.ts) ? <span className="ml-auto text-[11px] text-dim">{hhmm(item.ts)}</span> : null}
      </div>
      <div className="px-3.5 py-2.5">
        {item.summary.length ? (
          <div className="mb-2 whitespace-pre-wrap break-words text-[13px] text-[#444]">{mdBlocks(item.summary.join("\n"))}</div>
        ) : null}
        {visibleFindings.length ? (
          <div className="space-y-2">
            {visibleFindings.map((finding, idx) => (
              <div key={idx} className="rounded-[10px] border border-line bg-[#fbfbfd] px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-extrabold ${severityClass(finding.severity)}`}>
                    {finding.severity}
                  </span>
                  {finding.file ? <FileRef file={finding.file} line={finding.line} /> : null}
                </div>
                <div className="mt-1.5 whitespace-pre-wrap break-words text-[13px]">{md(finding.title)}</div>
                {finding.body && finding.body !== finding.title ? (
                  <details className="mt-1 text-[12px] text-dim">
                    <summary className="cursor-pointer list-none font-semibold text-accent">details</summary>
                    <div className="mt-1 whitespace-pre-wrap break-words">{mdBlocks(finding.body)}</div>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {item.findings.length > visibleFindings.length ? (
          <div className="mt-2 text-[12px] text-dim">ще {item.findings.length - visibleFindings.length} findings у raw</div>
        ) : null}
        <details className="mt-2 rounded-[10px] border border-line bg-[#fafafc] text-[12px]">
          <summary className="cursor-pointer list-none px-3 py-1.5 font-semibold text-dim">raw review text</summary>
          <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap border-t border-line px-3 py-2 font-mono text-[11.5px] text-[#555]">
            {item.raw}
          </pre>
        </details>
      </div>
    </div>
  );
}

function MemCitationCard({ item }: { item: MemCitationItem }) {
  const visibleEntries = item.entries.slice(0, 8);
  const visibleIds = item.rolloutIds.slice(0, 6);
  return (
    <details className="group my-2 ml-9 overflow-hidden rounded-[14px] border border-line bg-panel text-[12px] shadow-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2">
        <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-chip">
          <GlyphIcon name="citation" className="h-4 w-4" />
        </span>
        <span className="text-[13px] font-semibold">цитати пам&apos;яті ({item.entries.length})</span>
        <span className="ml-auto text-[11px] font-semibold text-accent group-open:hidden">показати</span>
        <span className="ml-auto hidden text-[11px] font-semibold text-accent group-open:inline">згорнути</span>
      </summary>
      <div className="border-t border-line px-3.5 py-2.5">
        {visibleEntries.length ? (
          <div className="space-y-1.5">
            {visibleEntries.map((entry, idx) => (
              <div key={idx} className="min-w-0 rounded-[9px] bg-[#fbfbfd] px-2.5 py-1.5">
                <FileRef file={entry.target} line={entry.line ? Number(entry.line.split("-", 1)[0]) : undefined} />
                {entry.note ? <div className="mt-1 whitespace-pre-wrap break-words text-[12px] text-[#555]">{entry.note}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[12px] text-dim">без citation entries</div>
        )}
        {item.entries.length > visibleEntries.length ? (
          <div className="mt-1.5 text-[12px] text-dim">ще {item.entries.length - visibleEntries.length} entries у raw</div>
        ) : null}
        {visibleIds.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-dim">rollout:</span>
            {visibleIds.map((id) => (
              <code key={id} className="rounded-full bg-chip px-2 py-0.5 font-mono text-[10.5px] text-dim" title={id}>
                {id.slice(0, 8)}
              </code>
            ))}
            {item.rolloutIds.length > visibleIds.length ? <span className="text-[11px] text-dim">+{item.rolloutIds.length - visibleIds.length}</span> : null}
          </div>
        ) : null}
        <details className="mt-2 rounded-[10px] border border-line bg-[#fafafc] text-[12px]">
          <summary className="cursor-pointer list-none px-3 py-1.5 font-semibold text-dim">
            raw citation block{item.truncated ? " · обрізано" : ""}
          </summary>
          <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap border-t border-line px-3 py-2 font-mono text-[11.5px] text-[#555]">
            {item.raw}
          </pre>
        </details>
      </div>
    </details>
  );
}

type ProtocolPayload = Record<string, unknown>;

const PROTOCOL_TYPE_META: Record<string, { icon: GlyphName; label: string; tone: "amber" | "accent" }> = {
  shutdown_request: { icon: "shutdown", label: "запит на завершення", tone: "amber" },
  shutdown_response: { icon: "shutdown", label: "відповідь на завершення", tone: "amber" },
  plan_approval_request: { icon: "plan", label: "запит на затвердження плану", tone: "accent" },
  plan_approval_response: { icon: "plan", label: "вердикт по плану", tone: "accent" },
};

function protocolToneClass(tone: "amber" | "accent"): string {
  return tone === "amber" ? "border-[#d89b21]/35 bg-[#fff9ea] text-[#9a6500]" : "border-accent/25 bg-accent/10 text-accent";
}

/** tmsg text is sometimes an inline protocol envelope (shutdown/plan-approval
    handshake) instead of prose; any non-JSON or non-object payload falls back
    to the plain tmsg render, so parsing stays defensive end to end. */
function parseProtocolPayload(text: string): ProtocolPayload | null {
  let trimmed = text.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ProtocolPayload;
  } catch {
    return null;
  }
  return null;
}

function asProtocolString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function ApproveChip({ approve }: { approve: boolean }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-extrabold ${approve ? "border-ok/25 bg-[#eefaf1] text-ok" : "border-err/25 bg-[#fff0f0] text-err"}`}>
      {approve ? "схвалено" : "відхилено"}
    </span>
  );
}

function ProtocolMeta({ payload }: { payload: ProtocolPayload }) {
  const from = asProtocolString(payload.from);
  const requestId = asProtocolString(payload.requestId);
  const ts = hhmm(payload.timestamp);
  if (!from && !requestId && !ts) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-dim">
      {from ? <span>від {from}</span> : null}
      {requestId ? (
        <span className="truncate font-mono" title={requestId}>
          {requestId.length > 40 ? requestId.slice(0, 40) + "…" : requestId}
        </span>
      ) : null}
      {ts ? <span>{ts}</span> : null}
    </div>
  );
}

function ProtocolMessageBody({ payload }: { payload: ProtocolPayload }) {
  const type = asProtocolString(payload.type);
  const meta = type ? PROTOCOL_TYPE_META[type] : undefined;
  if (!meta) {
    return (
      <div className="text-[13px]">
        <div className="text-dim">структуроване повідомлення</div>
        <details className="mt-1 text-[12px]">
          <summary className="cursor-pointer list-none font-semibold text-accent">показати JSON</summary>
          <pre className="mt-1 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-md bg-chip px-2.5 py-2 font-mono text-[11.5px]">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </details>
      </div>
    );
  }
  const approve = typeof payload.approve === "boolean" ? payload.approve : undefined;
  const prose = asProtocolString(payload.reason) ?? asProtocolString(payload.feedback);
  return (
    <div className="text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11.5px] font-bold ${protocolToneClass(meta.tone)}`}>
          <GlyphIcon name={meta.icon} className="h-3.5 w-3.5" />
          {meta.label}
        </span>
        {approve !== undefined ? <ApproveChip approve={approve} /> : null}
      </div>
      {prose ? <div className="mt-1.5 whitespace-pre-wrap break-words">{mdBlocks(prose)}</div> : null}
      <ProtocolMeta payload={payload} />
    </div>
  );
}

export function FeedItem({ item }: { item: Item }) {
  if (item.kind === "image") return <ImageCard media={item.media} data={item.data} w={item.w} h={item.h} bytes={item.bytes} />;
  if (item.kind === "inbox-image") return <InboxImageCard name={item.name} path={item.path} />;
  if (item.kind === "blob") return <BlobCard bytes={item.bytes} text={item.text} />;
  if (item.kind === "sysmsg") return <SysMsgCard label={item.label} text={item.text} />;
  if (item.kind === "review") return <ReviewCard item={item} />;
  if (item.kind === "mem-citation") return <MemCitationCard item={item} />;
  if (item.kind === "prose") {
    const cls = item.engine === "codex" ? "bg-codex" : "bg-claude";
    const AvatarIcon = item.engine === "codex" ? Command : Sparkle;
    return (
      <div className="my-3.5 flex gap-2.5">
        <div className={`mt-1 flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-full text-white ${cls}`}>
          <AvatarIcon className="h-3.5 w-3.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          {hhmm(item.ts) ? <div className="mb-0.5 text-[11px] text-dim">{hhmm(item.ts)}</div> : null}
          {mdBlocks(item.text)}
        </div>
      </div>
    );
  }
  if (item.kind === "user") {
    const long = item.text.length > 500;
    return (
      <div className="my-3.5 flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl bg-user px-4 py-2.5">
          {long ? (
            <details className="group/usr">
              <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                <span className="group-open/usr:hidden">
                  {item.text.slice(0, 180)}… <span className="font-semibold text-accent">({item.text.length} симв.)</span>
                </span>
                <span className="hidden items-center gap-1 text-[11px] font-semibold text-dim group-open/usr:inline-flex">
                  згорнути <ChevronUp className="h-3 w-3" aria-hidden />
                </span>
              </summary>
              {mdBlocks(item.text)}
            </details>
          ) : (
            mdBlocks(item.text)
          )}
        </div>
      </div>
    );
  }
  if (item.kind === "cmd") {
    const statusCls = item.call.status === "ok" ? "text-ok" : item.call.status === "err" ? "text-err" : "text-dim";
    return (
      <details className="my-2.5 ml-9 overflow-hidden rounded-[14px] border border-line bg-panel shadow-card" open={item.call.open}>
        <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2">
          <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-chip">
            <GlyphIcon name={item.call.icon} className="h-4 w-4" />
          </span>
          <code className="max-w-[70%] overflow-hidden text-ellipsis whitespace-nowrap rounded-md bg-chip px-2 py-0.5 font-mono text-[12.5px]">{item.call.display}</code>
          <span className={`ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-semibold ${statusCls}`}>
            <StatusIcon status={item.call.status} />
            {item.call.label}
          </span>
        </summary>
        <pre className="max-h-[340px] overflow-auto whitespace-pre-wrap border-t border-line bg-[#fafafc] px-3.5 py-2.5 font-mono text-[12.5px]">
          {"$ " + item.call.cmd + (item.call.output ? "\n" + item.call.output : "\n(вивід у цьому лог-файлі відсутній — повний є в rollout-сесії Codex)")}
        </pre>
      </details>
    );
  }
  if (item.kind === "cmd-group") return <CmdGroupCard item={item} />;
  if (item.kind === "edit") {
    return (
      <div className="my-2.5 ml-9 flex items-center gap-3 rounded-[14px] border border-line bg-panel px-3.5 py-2.5 shadow-card">
        <span className="flex h-7.5 w-7.5 items-center justify-center rounded-lg bg-chip">
          <GlyphIcon name="note" className="h-4 w-4" />
        </span>
        <div>
          <div className="text-[13.5px] font-semibold">{item.files}</div>
          <div className="text-xs text-dim">файли змінені</div>
        </div>
      </div>
    );
  }
  if (item.kind === "tmsg") {
    const protocol = parseProtocolPayload(item.text);
    const long = item.text.length > 420 || item.text.split("\n").length > 6;
    return (
      <div className="my-2.5 ml-9 overflow-hidden rounded-[14px] border border-accent/25 bg-[#f8f8fd] shadow-card">
        <div className="flex items-center gap-2 px-3.5 pt-2">
          <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-[#ecebfb] text-accent">
            <Mail className="h-3.5 w-3.5" aria-hidden />
          </span>
          <span className="text-[11px] font-semibold text-dim">{item.dir === "out" ? "до" : "від"}</span>
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-bold text-accent">{item.peer}</span>
          {item.delivery ? (
            <span
              className={`inline-flex shrink-0 items-center gap-1 text-[10.5px] font-semibold ${item.delivery === "ok" ? "text-ok" : "text-err"}`}
              title={item.msgId ? `msg_id: ${item.msgId}` : undefined}
            >
              {item.delivery === "ok" ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
              {item.delivery === "ok" ? "доставлено" : "не доставлено"}
            </span>
          ) : null}
          {hhmm(item.ts) ? <span className="ml-auto shrink-0 text-[11px] text-dim">{hhmm(item.ts)}</span> : null}
        </div>
        <div className="px-3.5 pb-2.5 pt-1">
          {protocol ? (
            <ProtocolMessageBody payload={protocol} />
          ) : (
            <>
              {item.summary ? <div className="text-[13px] font-bold">{md(item.summary)}</div> : null}
              {long ? (
                <details className="group/tmsg mt-0.5 whitespace-pre-wrap break-words text-[13px]">
                  <summary className="cursor-pointer list-none text-[12.5px] text-[#555] [&::-webkit-details-marker]:hidden">
                    <span className="group-open/tmsg:hidden">
                      {item.text.slice(0, 260).trimEnd()}… <span className="font-semibold text-accent">показати все</span>
                    </span>
                    <span className="hidden items-center gap-1 text-[11px] font-semibold text-dim group-open/tmsg:inline-flex">
                      згорнути <ChevronUp className="h-3 w-3" aria-hidden />
                    </span>
                  </summary>
                  {mdBlocks(item.text)}
                </details>
              ) : (
                <div className="mt-0.5 whitespace-pre-wrap break-words text-[13px]">{mdBlocks(item.text)}</div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }
  if (item.kind === "tnote") {
    return (
      <div className="my-1 ml-9 flex items-center gap-1.5 text-[11.5px] text-dim">
        <Mail className="h-3 w-3 shrink-0" aria-hidden />
        {item.text}
      </div>
    );
  }
  if (item.kind === "think") {
    const long = item.text.length > 150;
    return (
      <details className="my-1 ml-9 text-[11.5px] italic text-dim">
        <summary className={`flex list-none items-center gap-1.5 truncate ${long ? "cursor-pointer" : ""}`} title="міркування агента">
          <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {item.text.slice(0, 150)}
            {long ? "…" : ""}
          </span>
        </summary>
        {long ? <div className="whitespace-pre-wrap break-words pt-1 not-italic">{mdBlocks(item.text)}</div> : null}
      </details>
    );
  }
  if (item.kind === "svc") return <div className="my-1 break-words text-[11.5px] text-dim">{item.text}</div>;
  if (item.kind === "note") return <div className="my-2 break-words text-[12.5px] text-dim">{md(item.text)}</div>;
  return <div className={`my-0.5 break-words text-[12.5px] ${item.err ? "text-err" : "text-[#555]"}`}>{item.text}</div>;
}

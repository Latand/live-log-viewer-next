import {
  debugRaw,
  parseReview,
  redactSecrets,
  splitTargetLine,
  VERDICT_LINE_RE,
  type ReviewCardItem,
} from "@/lib/review";
import { getLocale, translate } from "@/lib/i18n";
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

const BLOB_MIN = 20_000;
const BLOB_KEEP = 200_000;
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
const SYS_MSG_RE = /^\s*(?:<[a-zA-Z][\w:-]*|Caveat: The messages below|\[Request interrupted|This came from another Claude session|# AGENTS\.md instructions)/;

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
  call.label = isErr ? (code && code !== "0" ? "exit " + code : tr("render.error")) : "ok";
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
      const peer = tmsgAttr(attrs, "teammate_id") || tmsgAttr(attrs, "from") || tr("render.teammate");
      const summary = tmsgAttr(attrs, "summary");
      const trimmed = body.trim();
      if (trimmed.startsWith("{")) {
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (obj.type === "idle_notification") {
            const at = hhmm(obj.timestamp);
            items.push({ kind: "tnote", text: tr("render.left", { peer, at: at ? " · " + at : "" }) });
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
     per attached inbox image. A rollout logs the same turn twice — as a
     response_item and as an event_msg echo right next to it — so an exact
     repeat with nothing rendered in between folds away; a message the user
     really sent twice has agent output between the copies and stays. */
  let lastUser: { text: string; at: number } | null = null;
  const addPlainUser = (ts: unknown, text: string) => {
    if (lastUser && lastUser.text === text && lastUser.at === items.length) return;
    const { cleaned, images } = extractInboxImages(text);
    if (cleaned) items.push({ kind: "user", ts, text: cleaned });
    for (const image of images) items.push({ kind: "inbox-image", name: image.name, path: image.path });
    lastUser = { text, at: items.length };
  };
  /* Harness turns fold into a sysmsg row; the same echo dedup applies since
     they arrive through the same doubled user-role records. */
  const addSysMsg = (text: string, fallbackLabel?: string) => {
    if (lastUser && lastUser.text === text && lastUser.at === items.length) return;
    items.push({ kind: "sysmsg", label: sysMsgLabel(text, fallbackLabel), text });
    lastUser = { text, at: items.length };
  };
  /* One Codex compaction leaves two markers (a `compacted` record, then an
     event_msg echo a few hidden records later); the flag folds the pair. */
  let codexCompacted = false;
  const addCompact = (ts: unknown, meta?: { trigger?: string; preTokens?: number }) => {
    items.push({ kind: "compact", ts, trigger: meta?.trigger, preTokens: meta?.preTokens });
  };
  /* The Claude compact summary follows its boundary record; attach it there,
     skipping the service rows that may sit between them. */
  const attachCompactSummary = (ts: unknown, summary: string) => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it.kind === "compact") {
        it.summary = summary;
        return;
      }
      if (it.kind !== "svc" && it.kind !== "note") break;
    }
    items.push({ kind: "compact", ts, summary });
  };
  const renderCodex = (obj: Record<string, unknown>) => {
    const p = rec(obj.payload);
    const ts = obj.timestamp;
    if (obj.type === "session_meta") {
      return addNote(`${tr("render.codexSessionCreated")} · ${textPart(p.model)} · ${textPart(p.cwd)}`);
    }
    if (obj.type === "event_msg") {
      if (p.type === "agent_message" && p.message) return addProse(ts, textPart(p.message));
      if (p.type === "user_message" && p.message) {
        const text = textPart(p.message);
        if (SYS_MSG_RE.test(text)) return addSysMsg(text);
        return addPlainUser(ts, text);
      }
      if (p.type === "task_started") return addNote(tr("render.taskStarted") + (ts ? " · " + hhmm(ts) : ""));
      if (p.type === "task_complete") return addNote(tr("render.taskComplete") + (ts ? " · " + hhmm(ts) : ""));
      if (p.type === "context_compacted") {
        if (codexCompacted) return void (codexCompacted = false);
        return addCompact(ts);
      }
      return addSvc(textPart(p.type) || "event");
    }
    if (obj.type === "response_item") {
      if (p.type === "message") {
        const text = arr(p.content).map((c) => textPart(c.text) || textPart(c.input_text)).join(" ").trim();
        if (!text) return addSvc("message " + textPart(p.role));
        if (p.role === "assistant") return addProse(ts, text);
        /* developer/system turns (<permissions instructions>, collaboration
           mode, …) are harness-injected, never something the user typed. */
        if (p.role !== "user" || SYS_MSG_RE.test(text)) return addSysMsg(text, textPart(p.role));
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
          items.push({ kind: "edit", files: files ? files.join(", ").replace(/(Add|Update|Delete) File: /g, "") : tr("render.patch") });
          return;
        }
        if (name === "write_stdin") return addSvc(tr("render.stdinSession", { id: String(args.session_id ?? "") }));
        return addCmd(ts, name + " " + JSON.stringify(args).slice(0, 120), textPart(p.call_id), "tool");
      }
      if (p.type === "function_call_output") return addOutput(textPart(p.call_id), typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? ""));
      /* Fresh rollouts wrap apply_patch as a "custom_tool_call": `input` is the
         raw patch text directly (unlike function_call, whose `arguments` is a
         JSON-encoded string), so no JSON.parse step is needed here. */
      if (p.type === "custom_tool_call" && textPart(p.name) === "apply_patch") {
        const files = textPart(p.input).match(/(Add|Update|Delete) File: [^\n]+/g);
        items.push({ kind: "edit", files: files ? files.join(", ").replace(/(Add|Update|Delete) File: /g, "") : tr("render.patch") });
        return;
      }
      if (p.type === "custom_tool_call_output") return addOutput(textPart(p.call_id), typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? ""));
      if (p.type === "reasoning") return addSvc("reasoning");
      return addSvc(textPart(p.type) || "item");
    }
    if (obj.type === "compacted") {
      codexCompacted = true;
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
        attach(last, /^Command failed/.test(rest) ? rest + "\n" + tr("render.jobLogNote") : rest, /^Command failed/.test(rest));
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
